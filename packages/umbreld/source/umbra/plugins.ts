import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync} from 'node:fs'
import {cpus, freemem, loadavg, totalmem, uptime} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type AuditLog from './audit.js'
import type ConfigStore from './config.js'
import type {PluginRecord} from './config.js'
import {ensureDir, readJsonOrNull, removeIfExists, resolveInside, writeFileAtomic, writeJsonAtomic} from './fs-util.js'
import {
	MAX_PLUGIN_BYTES,
	scaffoldPlugin,
	validateManifest,
	validatePluginFiles,
	validateSettings,
	type PluginFile,
	type PluginManifest,
	type PluginPermission,
} from './plugin-manifest.js'
import type {UmbrelLike} from './types.js'
import {HttpError, isRecord, randomId, sleep} from './util.js'

const RUNTIME_PATH = fileURLToPath(new URL('./plugin-runtime.mjs', import.meta.url))
// On Linux, a fresh network namespace is the only reliable way to stop a
// plugin from opening sockets (Node's permission model does not cover network
// I/O). IPC over the inherited fd still works through unshare.
const UNSHARE_PATH =
	process.platform === 'linux' ? ['/usr/bin/unshare', '/bin/unshare'].find((path) => existsSync(path)) : undefined
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)+$/
const STORAGE_LIMIT_BYTES = 256 * 1024
const MAX_RESTARTS = 3

type SandboxHost = {
	invokePlugin: (pluginId: string, method: string, params: Record<string, unknown>) => Promise<unknown>
	callHost: (plugin: PluginContext, method: string, params: Record<string, unknown>) => Promise<unknown>
	onFatal: (pluginId: string, message: string) => void
}

type PluginContext = {
	id: string
	manifest: PluginManifest
	record: PluginRecord
	directory: string
}

type RunningPlugin = {
	child: ChildProcess
	ready: Promise<void>
	startedAt: number
	restarts: number
	pending: Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>
	nextId: number
	stopping: boolean
}

function has(manifest: PluginManifest, permission: PluginPermission): boolean {
	return manifest.permissions.includes(permission)
}

/**
 * One sandboxed plugin backend.
 *
 * The child runs under Node's permission model with read access only to its own
 * directory. Privileged calls come back over IPC and are re-checked against the
 * manifest here; a plugin cannot grant itself permissions at runtime.
 */
class PluginSandbox {
	#context: PluginContext
	#host: SandboxHost
	#logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	#running?: RunningPlugin

	constructor(
		context: PluginContext,
		host: SandboxHost,
		logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void},
	) {
		this.#context = context
		this.#host = host
		this.#logger = logger
	}

	get running(): boolean {
		return Boolean(this.#running)
	}

	async start(): Promise<void> {
		if (this.#running) return
		const entry = this.#context.manifest.entry
		if (!entry) return
		const nodeArguments = [
			'--permission',
			`--allow-fs-read=${this.#context.directory}`,
			`--allow-fs-read=${RUNTIME_PATH}`,
			'--max-old-space-size=128',
			RUNTIME_PATH,
			this.#context.directory,
			entry,
			this.#context.id,
		]
		const child = spawn(
			UNSHARE_PATH ?? process.execPath,
			UNSHARE_PATH ? ['--net', process.execPath, ...nodeArguments] : nodeArguments,
			{
				cwd: this.#context.directory,
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				env: {
					PATH: process.env.PATH ?? '',
					HOME: this.#context.directory,
					NODE_ENV: 'production',
					UMBRA_PLUGIN_ID: this.#context.id,
				},
				serialization: 'json',
			},
		)
		let resolveReady!: () => void
		let rejectReady!: (error: Error) => void
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve
			rejectReady = reject
		})
		const running: RunningPlugin = {
			child,
			ready,
			startedAt: Date.now(),
			restarts: 0,
			pending: new Map(),
			nextId: 1,
			stopping: false,
		}
		this.#running = running

		const stderr: string[] = []
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8').trim()
			if (text) {
				stderr.push(text)
				if (stderr.length > 20) stderr.shift()
				this.#logger.error(`[plugin ${this.#context.id}] ${text.slice(0, 2000)}`)
			}
		})
		child.on('message', (message: unknown) => {
			void this.#onMessage(running, message).catch((error) =>
				this.#logger.error(`Plugin ${this.#context.id} message failed`, error),
			)
		})
		const readyTimer = setTimeout(() => rejectReady(new Error('Plugin did not start within 10 seconds')), 10_000)
		child.once('message', (message: unknown) => {
			if (isRecord(message) && message.type === 'ready') {
				clearTimeout(readyTimer)
				resolveReady()
			}
		})
		child.on('error', (error) => {
			clearTimeout(readyTimer)
			rejectReady(error)
		})
		child.on('exit', (code, signal) => {
			clearTimeout(readyTimer)
			const wasStopping = running.stopping
			this.#running = undefined
			for (const {reject, timer} of running.pending.values()) {
				clearTimeout(timer)
				reject(new Error('Plugin process exited'))
			}
			running.pending.clear()
			if (!wasStopping) {
				this.#host.onFatal(
					this.#context.id,
					`Plugin exited unexpectedly (${signal ?? `code ${code}`}) ${stderr.at(-1) ?? ''}`.slice(0, 300),
				)
			}
		})
		await ready
		child.send({type: 'settings', settings: this.#context.record.settings})
	}

	async stop(): Promise<void> {
		const running = this.#running
		if (!running) return
		running.stopping = true
		try {
			await this.#invoke('deactivate', {}, 2_000)
		} catch {
			// Already gone.
		}
		try {
			running.child.send({type: 'shutdown'})
		} catch {
			// IPC closed.
		}
		await sleep(200)
		if (running.child.exitCode === null) {
			running.child.kill('SIGKILL')
		}
		this.#running = undefined
	}

	async #onMessage(running: RunningPlugin, message: unknown) {
		if (!isRecord(message)) return
		if (message.type === 'result' && typeof message.id === 'number') {
			const pending = running.pending.get(message.id)
			if (!pending) return
			running.pending.delete(message.id)
			clearTimeout(pending.timer)
			if (message.error) pending.reject(new Error(String(message.error)))
			else pending.resolve(message.value)
			return
		}
		if (message.type === 'invoke-result' && typeof message.id === 'number') {
			const pending = running.pending.get(message.id)
			if (!pending) return
			running.pending.delete(message.id)
			clearTimeout(pending.timer)
			if (message.error) pending.reject(new Error(String(message.error)))
			else pending.resolve(message.value)
			return
		}
		if (message.type === 'call' && typeof message.id === 'number' && typeof message.method === 'string') {
			try {
				const value = await this.#host.callHost(
					this.#context,
					message.method,
					isRecord(message.params) ? message.params : {},
				)
				running.child.send({type: 'result', id: message.id, value: value ?? null})
			} catch (error) {
				running.child.send({
					type: 'result',
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
				})
			}
			return
		}
		if (message.type === 'fatal') {
			this.#host.onFatal(this.#context.id, String(message.error ?? 'Plugin failed').slice(0, 300))
		}
	}

	async #invoke(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const running = this.#running
		if (!running) throw new Error('Plugin is not running')
		return new Promise((resolve, reject) => {
			const id = running.nextId++
			const timer = setTimeout(() => {
				running.pending.delete(id)
				reject(new Error(`Plugin call '${method}' timed out`))
			}, timeoutMs)
			timer.unref?.()
			running.pending.set(id, {resolve, reject, timer})
			running.child.send({type: 'invoke', id, method, params})
		})
	}

	async activate(): Promise<void> {
		await this.#invoke('activate', {}, this.#context.manifest.backend?.timeoutMs ?? 5_000)
	}

	async event(event: string, payload: unknown): Promise<void> {
		await this.#invoke('event', {event, payload}, this.#context.manifest.backend?.timeoutMs ?? 5_000)
	}

	async updateSettings(settings: Record<string, unknown>): Promise<void> {
		if (!this.#running) return
		this.#running.child.send({type: 'settings', settings})
	}
}

/**
 * Plugin lifecycle, installation, settings, widgets, and sandbox supervision.
 * All state lives under `<data>/umbra/plugins` so app updates and OTA updates
 * cannot remove it.
 */
export default class PluginManager {
	readonly directory: string
	readonly pluginsDirectory: string
	readonly dataDirectory: string
	#config: ConfigStore
	#audit: AuditLog
	#umbreld: UmbrelLike
	#logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	#sandboxes = new Map<string, PluginSandbox>()
	#widgetData = new Map<string, unknown>()
	#restarts = new Map<string, number>()
	#storageQueues = new Map<string, Promise<unknown>>()
	#started = false

	constructor(input: {
		dataDirectory: string
		config: ConfigStore
		audit: AuditLog
		umbreld: UmbrelLike
		logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	}) {
		this.directory = path.join(input.dataDirectory, 'plugins')
		this.pluginsDirectory = path.join(this.directory, 'installed')
		this.dataDirectory = path.join(this.directory, 'data')
		this.#config = input.config
		this.#audit = input.audit
		this.#umbreld = input.umbreld
		this.#logger = input.logger
	}

	async start(): Promise<void> {
		if (this.#started) return
		await ensureDir(this.pluginsDirectory, 0o700)
		await ensureDir(this.dataDirectory, 0o700)
		this.#started = true
		const config = await this.#config.load()
		if (!config.plugins.enabled) return
		// Reconcile enabled plugins concurrently but tolerate individual failures.
		await Promise.all(
			Object.values(config.plugins.records)
				.filter((record) => record.enabled)
				.map((record) =>
					this.#startPlugin(record.id).catch((error) =>
						this.#logger.error(`Failed to start plugin '${record.id}'`, error),
					),
				),
		)
	}

	async stop(): Promise<void> {
		await Promise.all([...this.#sandboxes.values()].map((sandbox) => sandbox.stop().catch(() => {})))
		this.#sandboxes.clear()
		this.#started = false
	}

	#descriptor(id: string, record: PluginRecord): PluginContext {
		return {
			id,
			manifest: {} as PluginManifest,
			record,
			directory: path.join(this.pluginsDirectory, id, record.version),
		}
	}

	async #loadManifest(id: string, version: string): Promise<PluginManifest> {
		const filePath = path.join(this.pluginsDirectory, id, version, 'umbra-plugin.json')
		const raw = await readJsonOrNull(filePath)
		const validation = validateManifest(raw)
		if (!validation.ok || !validation.manifest) {
			throw new Error(`Invalid manifest for '${id}': ${validation.errors.join(', ')}`)
		}
		if (validation.manifest.id !== id || validation.manifest.version !== version) {
			throw new Error('Manifest id/version does not match its install directory')
		}
		return validation.manifest
	}

	async #startPlugin(id: string): Promise<void> {
		if (this.#sandboxes.has(id)) return
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record?.enabled) return
		const manifest = await this.#loadManifest(id, record.version)
		if (!manifest.entry) return
		const context = this.#descriptor(id, record)
		context.manifest = manifest
		const sandbox = new PluginSandbox(context, this.#hostBridge(), this.#logger)
		this.#sandboxes.set(id, sandbox)
		try {
			await sandbox.start()
			await sandbox.activate()
		} catch (error) {
			this.#sandboxes.delete(id)
			await sandbox.stop().catch(() => {})
			await this.#recordError(id, error instanceof Error ? error.message : String(error))
			throw error
		}
	}

	#hostBridge(): SandboxHost {
		return {
			invokePlugin: async () => null,
			callHost: (context, method, params) => this.#handleHostCall(context, method, params),
			onFatal: (pluginId, message) => {
				void this.#handleFatal(pluginId, message)
			},
		}
	}

	async #handleFatal(pluginId: string, message: string) {
		const restarts = (this.#restarts.get(pluginId) ?? 0) + 1
		this.#restarts.set(pluginId, restarts)
		this.#sandboxes.delete(pluginId)
		this.#audit.record({
			type: 'plugin.error',
			action: 'Plugin backend crashed',
			actor: {type: 'system', id: 'plugin-host'},
			target: pluginId,
			outcome: 'failure',
			detail: {message, restarts},
		})
		await this.#recordError(pluginId, message)
		if (restarts > MAX_RESTARTS) {
			await this.disable(pluginId, {id: 'system', name: 'Plugin supervisor', reason: 'repeated crashes'}, true)
			return
		}
		await sleep(1_000 * restarts)
		await this.#startPlugin(pluginId).catch((error) =>
			this.#logger.error(`Failed to restart plugin '${pluginId}'`, error),
		)
	}

	async #recordError(id: string, message: string) {
		await this.#config
			.update((draft) => {
				const record = draft.plugins.records[id]
				if (record) record.lastError = message.slice(0, 500)
			})
			.catch(() => {})
	}

	async #handleHostCall(context: PluginContext, method: string, params: Record<string, unknown>): Promise<unknown> {
		const {manifest, id} = context
		switch (method) {
			case 'log': {
				const level = String(params.level ?? 'info')
				const message = String(params.message ?? '').slice(0, 4000)
				if (level === 'error') this.#logger.error(`[plugin ${id}] ${message}`)
				else this.#logger.log(`[plugin ${id}] ${message}`)
				return null
			}
			case 'storage.get': {
				if (!has(manifest, 'storage:plugin')) throw new Error('storage:plugin permission is not declared')
				const key = String(params.key ?? '')
				const all = await this.#readStorage(id)
				return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null
			}
			case 'storage.set': {
				if (!has(manifest, 'storage:plugin')) throw new Error('storage:plugin permission is not declared')
				const key = String(params.key ?? '')
				if (!/^[a-zA-Z0-9._-]{1,120}$/.test(key)) throw new Error('Invalid storage key')
				const value = params.value
				const serialised = JSON.stringify(value)
				if (Buffer.byteLength(serialised) > 64 * 1024) throw new Error('Storage value is too large')
				await this.#mutateStorage(id, (all) => {
					all[key] = value
					if (Buffer.byteLength(JSON.stringify(all)) > STORAGE_LIMIT_BYTES) throw new Error('Plugin storage is full')
				})
				return null
			}
			case 'storage.delete': {
				if (!has(manifest, 'storage:plugin')) throw new Error('storage:plugin permission is not declared')
				const key = String(params.key ?? '')
				await this.#mutateStorage(id, (all) => {
					delete all[key]
				})
				return null
			}
			case 'metrics.read': {
				if (!has(manifest, 'metrics:read')) throw new Error('metrics:read permission is not declared')
				const memoryTotal = totalmem()
				const memoryFree = freemem()
				return {
					cpus: cpus().length,
					loadavg: loadavg(),
					memory: {total: memoryTotal, free: memoryFree, used: memoryTotal - memoryFree},
					uptime: uptime(),
				}
			}
			case 'docker.list': {
				if (!has(manifest, 'docker:read')) throw new Error('docker:read permission is not declared')
				return this.#dockerList()
			}
			case 'apps.list': {
				if (!has(manifest, 'apps:read')) throw new Error('apps:read permission is not declared')
				return this.#umbreld.apps.instances.slice(0, 200).map((app) => ({id: app.id, state: app.state ?? 'unknown'}))
			}
			case 'notify': {
				if (!has(manifest, 'notifications:write')) throw new Error('notifications:write permission is not declared')
				const title = String(params.title ?? '').slice(0, 120)
				const message = String(params.message ?? '').slice(0, 1000)
				if (!title || !message) throw new Error('notify requires a title and message')
				// umbrelOS notifications are identifiers, not free-form text. Keep
				// plugin notifications in the plugin's own data so a plugin cannot
				// inject arbitrary strings into the owner's notification store.
				const filePath = path.join(this.dataDirectory, id, 'notifications.json')
				const existing = (await readJsonOrNull(filePath)) ?? {items: []}
				const items = Array.isArray(existing.items) ? existing.items : []
				items.unshift({title, message, at: Date.now()})
				await writeJsonAtomic(filePath, {items: items.slice(0, 50)}, 0o600)
				return null
			}
			case 'widget.setData': {
				if (!has(manifest, 'ui:widget')) throw new Error('ui:widget permission is not declared')
				const widgetId = String(params.widgetId ?? '')
				if (!manifest.ui?.widgets?.some((widget) => widget.id === widgetId)) {
					throw new Error('Unknown widget')
				}
				const data = params.data
				if (JSON.stringify(data).length > 16 * 1024) throw new Error('Widget data is too large')
				this.#widgetData.set(`${id}/${widgetId}`, data)
				return null
			}
			default:
				throw new Error(`Unknown host method: ${method}`)
		}
	}

	async #dockerList(): Promise<unknown[]> {
		return new Promise((resolve) => {
			const child = spawn('docker', ['ps', '--format', '{{json .}}'], {stdio: ['ignore', 'pipe', 'ignore']})
			let output = ''
			const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
			timer.unref?.()
			child.stdout.on('data', (chunk: Buffer) => {
				if (output.length < 512 * 1024) output += chunk.toString('utf8')
			})
			child.on('error', () => {
				clearTimeout(timer)
				resolve([])
			})
			child.on('close', () => {
				clearTimeout(timer)
				const containers = output
					.split('\n')
					.filter(Boolean)
					.slice(0, 200)
					.flatMap((line) => {
						try {
							const parsed = JSON.parse(line) as Record<string, unknown>
							return [
								{
									id: String(parsed.ID ?? '').slice(0, 12),
									name: String(parsed.Names ?? ''),
									image: String(parsed.Image ?? ''),
									state: String(parsed.State ?? ''),
									status: String(parsed.Status ?? ''),
								},
							]
						} catch {
							return []
						}
					})
				resolve(containers)
			})
		})
	}

	#storagePath(id: string): string {
		return path.join(this.dataDirectory, id, 'storage.json')
	}

	async #readStorage(id: string): Promise<Record<string, unknown>> {
		return (await readJsonOrNull(this.#storagePath(id))) ?? {}
	}

	async #mutateStorage(id: string, mutator: (all: Record<string, unknown>) => void): Promise<void> {
		const run = async () => {
			const all = await this.#readStorage(id)
			mutator(all)
			await writeJsonAtomic(this.#storagePath(id), all, 0o600)
		}
		const next = (this.#storageQueues.get(id) ?? Promise.resolve()).then(run, run)
		this.#storageQueues.set(
			id,
			next.catch(() => {}),
		)
		await next
	}

	async list() {
		const config = await this.#config.load()
		const records = Object.values(config.plugins.records)
		return Promise.all(
			records.map(async (record) => {
				const manifest = await this.#loadManifest(record.id, record.version).catch(() => null)
				return {
					...record,
					running: this.#sandboxes.has(record.id),
					manifest,
				}
			}),
		)
	}

	async get(id: string) {
		if (!PLUGIN_ID_PATTERN.test(id)) throw new HttpError(400, 'Invalid plugin id')
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record) throw new HttpError(404, 'Plugin not found')
		const manifest = await this.#loadManifest(id, record.version)
		return {...record, running: this.#sandboxes.has(id), manifest}
	}

	async install(
		input: {manifest: unknown; files: PluginFile[]; enable?: boolean; source?: 'inline' | 'path'},
		actor: {id: string; name?: string; ip?: string},
	) {
		const config = await this.#config.load()
		if (!config.plugins.enabled) throw new HttpError(403, 'Plugins are disabled')
		const validation = validateManifest(input.manifest)
		if (!validation.ok || !validation.manifest) {
			throw new HttpError(400, `Invalid manifest: ${validation.errors.join('; ')}`)
		}
		const manifest = validation.manifest
		const files = Array.isArray(input.files) ? input.files : []
		const fileErrors = validatePluginFiles(files, manifest)
		if (fileErrors.length) throw new HttpError(400, `Invalid plugin files: ${fileErrors.join('; ')}`)
		const total = files.reduce(
			(sum, file) =>
				sum + (file.encoding === 'base64' ? Math.ceil((file.content.length * 3) / 4) : Buffer.byteLength(file.content)),
			0,
		)
		if (total > MAX_PLUGIN_BYTES) throw new HttpError(413, 'Plugin is too large')

		// Stop an existing backend before swapping its directory.
		await this.#sandboxes.get(manifest.id)?.stop()
		this.#sandboxes.delete(manifest.id)

		const versionDirectory = path.join(this.pluginsDirectory, manifest.id, manifest.version)
		const staging = path.join(this.pluginsDirectory, manifest.id, `.staging-${randomId(4)}`)
		await removeIfExists(staging)
		await ensureDir(staging, 0o700)
		try {
			for (const file of files) {
				const destination = await resolveInside(staging, file.path)
				const contents = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content
				await writeFileAtomic(destination, contents, 0o600)
			}
			await writeJsonAtomic(path.join(staging, 'umbra-plugin.json'), manifest, 0o600)
			await removeIfExists(versionDirectory)
			await ensureDir(path.dirname(versionDirectory), 0o700)
			await import('node:fs/promises').then((fs) => fs.rename(staging, versionDirectory))
		} catch (error) {
			await removeIfExists(staging)
			throw error
		}

		const record: PluginRecord = {
			id: manifest.id,
			version: manifest.version,
			enabled: false,
			installedAt: Date.now(),
			installedBy: actor.name ?? actor.id,
			manifestHash: validation.manifestHash!,
			settings: validateSettings(manifest, {}).values,
		}
		await this.#config.update((draft) => {
			draft.plugins.records[manifest.id] = record
		})
		this.#audit.record({
			type: 'plugin.install',
			action: `Installed plugin ${manifest.name} ${manifest.version}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: manifest.id,
			detail: {version: manifest.version, permissions: manifest.permissions, files: files.length},
		})
		if (input.enable) await this.enable(manifest.id, actor)
		return this.get(manifest.id)
	}

	async installFromPath(sourcePath: string, actor: {id: string; name?: string; ip?: string}, enable = false) {
		const fs = await import('node:fs/promises')
		const root = path.resolve(sourcePath)
		const stats = await fs.stat(root).catch(() => null)
		if (!stats?.isDirectory()) throw new HttpError(400, 'Plugin source must be a directory')
		const manifestRaw = JSON.parse(await fs.readFile(path.join(root, 'umbra-plugin.json'), 'utf8'))
		const files: PluginFile[] = []
		let total = 0
		const walk = async (current: string) => {
			for (const entry of await fs.readdir(current, {withFileTypes: true})) {
				if (entry.name === 'umbra-plugin.json' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
				const absolute = path.join(current, entry.name)
				const relative = path.relative(root, absolute).split(path.sep).join('/')
				if (entry.isSymbolicLink()) throw new HttpError(400, `Symlinks are not allowed: ${relative}`)
				if (entry.isDirectory()) {
					await walk(absolute)
					continue
				}
				if (!entry.isFile()) continue
				const buffer = await fs.readFile(absolute)
				total += buffer.length
				if (total > MAX_PLUGIN_BYTES) throw new HttpError(413, 'Plugin directory is too large')
				const isBinary = buffer.includes(0)
				files.push({
					path: relative,
					content: isBinary ? buffer.toString('base64') : buffer.toString('utf8'),
					encoding: isBinary ? 'base64' : 'utf8',
				})
			}
		}
		await walk(root)
		return this.install({manifest: manifestRaw, files, enable}, actor)
	}

	async enable(id: string, actor: {id: string; name?: string; ip?: string}) {
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record) throw new HttpError(404, 'Plugin not found')
		if (record.enabled && this.#sandboxes.has(id)) return this.get(id)
		const manifest = await this.#loadManifest(id, record.version)
		await this.#config.update((draft) => {
			draft.plugins.records[id].enabled = true
			draft.plugins.records[id].lastError = undefined
		})
		this.#restarts.delete(id)
		if (manifest.entry) {
			try {
				await this.#startPlugin(id)
			} catch (error) {
				await this.#config.update((draft) => {
					draft.plugins.records[id].enabled = false
				})
				throw new HttpError(500, error instanceof Error ? error.message : 'Plugin failed to start')
			}
		}
		this.#audit.record({
			type: 'plugin.enable',
			action: `Enabled plugin ${manifest.name}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: id,
		})
		return this.get(id)
	}

	async disable(id: string, actor: {id: string; name?: string; ip?: string; reason?: string}, silent = false) {
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record) throw new HttpError(404, 'Plugin not found')
		const sandbox = this.#sandboxes.get(id)
		this.#sandboxes.delete(id)
		await sandbox?.stop()
		await this.#config.update((draft) => {
			draft.plugins.records[id].enabled = false
		})
		this.#clearWidgetData(id)
		this.#audit.record({
			type: 'plugin.disable',
			action: `Disabled plugin ${id}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: id,
			detail: actor.reason ? {reason: actor.reason} : undefined,
		})
		if (silent) this.#logger.log(`Plugin '${id}' disabled by supervisor`)
		return this.get(id)
	}

	async uninstall(id: string, actor: {id: string; name?: string; ip?: string}, removeData = false) {
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record) throw new HttpError(404, 'Plugin not found')
		const sandbox = this.#sandboxes.get(id)
		this.#sandboxes.delete(id)
		await sandbox?.stop()
		await removeIfExists(path.join(this.pluginsDirectory, id))
		if (removeData) await removeIfExists(path.join(this.dataDirectory, id))
		await this.#config.update((draft) => {
			delete draft.plugins.records[id]
		})
		this.#clearWidgetData(id)
		this.#audit.record({
			type: 'plugin.uninstall',
			action: `Uninstalled plugin ${id}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: id,
			detail: {version: record.version, removeData},
		})
		return {ok: true}
	}

	async setSettings(id: string, values: Record<string, unknown>, actor: {id: string; name?: string; ip?: string}) {
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record) throw new HttpError(404, 'Plugin not found')
		const manifest = await this.#loadManifest(id, record.version)
		const validation = validateSettings(manifest, values)
		if (!validation.ok) throw new HttpError(400, validation.errors.join('; '))
		await this.#config.update((draft) => {
			draft.plugins.records[id].settings = validation.values
		})
		await this.#sandboxes.get(id)?.updateSettings(validation.values)
		this.#audit.record({
			type: 'plugin.invoke',
			action: `Updated plugin settings for ${manifest.name}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: id,
		})
		return this.get(id)
	}

	#clearWidgetData(id: string) {
		for (const key of this.#widgetData.keys()) {
			if (key.startsWith(`${id}/`)) this.#widgetData.delete(key)
		}
	}

	async widgets() {
		const config = await this.#config.load()
		const widgets: unknown[] = []
		for (const record of Object.values(config.plugins.records)) {
			if (!record.enabled) continue
			const manifest = await this.#loadManifest(record.id, record.version).catch(() => null)
			for (const widget of manifest?.ui?.widgets ?? []) {
				widgets.push({
					pluginId: record.id,
					pluginName: manifest?.name ?? record.id,
					...widget,
					data: this.#widgetData.get(`${record.id}/${widget.id}`) ?? null,
				})
			}
		}
		return widgets
	}

	async uiFile(id: string, relativePath: string): Promise<{path: string; contents: Buffer; contentType: string}> {
		const config = await this.#config.load()
		const record = config.plugins.records[id]
		if (!record?.enabled) throw new HttpError(404, 'Plugin not found')
		const manifest = await this.#loadManifest(id, record.version)
		const routes = new Set(manifest.ui?.routes?.map((route) => route.entry) ?? [])
		// A route document may load its own assets from the plugin's ui/ tree.
		// Nothing outside that tree or a declared route entry is served.
		if (!routes.has(relativePath) && !relativePath.startsWith('ui/')) throw new HttpError(404, 'Not found')
		const directory = path.join(this.pluginsDirectory, id, record.version)
		const filePath = await resolveInside(directory, relativePath)
		const fs = await import('node:fs/promises')
		const contents = await fs.readFile(filePath)
		const extension = path.extname(filePath).toLowerCase()
		const types: Record<string, string> = {
			'.html': 'text/html; charset=utf-8',
			'.js': 'text/javascript; charset=utf-8',
			'.css': 'text/css; charset=utf-8',
			'.json': 'application/json; charset=utf-8',
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.svg': 'image/svg+xml',
		}
		return {path: filePath, contents, contentType: types[extension] ?? 'application/octet-stream'}
	}

	async dispatchEvent(event: string, payload: unknown) {
		const config = await this.#config.load()
		await Promise.all(
			[...this.#sandboxes.entries()].map(async ([id, sandbox]) => {
				const record = config.plugins.records[id]
				if (!record) return
				const manifest = await this.#loadManifest(id, record.version).catch(() => null)
				if (!manifest) return
				if (!manifest.permissions.includes('events:subscribe')) return
				const subscribed = manifest.backend?.events ?? []
				if (!subscribed.includes(event) && !subscribed.includes('*')) return
				await sandbox.event(event, payload).catch((error) => {
					this.#logger.error(`Plugin '${id}' failed handling '${event}'`, error)
				})
			}),
		)
	}

	scaffold(spec: Parameters<typeof scaffoldPlugin>[0]) {
		const result = scaffoldPlugin(spec)
		const validation = validateManifest(result.manifest)
		if (!validation.ok) throw new HttpError(400, validation.errors.join('; '))
		return result
	}
}
