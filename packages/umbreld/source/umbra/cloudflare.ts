import {spawn} from 'node:child_process'
import http from 'node:http'
import path from 'node:path'

import type AuditLog from './audit.js'
import type ConfigStore from './config.js'
import {isValidHostname, type CloudflareAccessConfig, type CloudflareSecurityConfig} from './config.js'
import {ensureDir, writeFileAtomic} from './fs-util.js'
import type SecretStore from './secrets.js'
import {HttpError, isRecord, sleep} from './util.js'

const CONTAINER_NAME = 'umbra-cloudflared'
const METRICS_PORT = 20241
const STATUS_TTL_MS = 5_000
const MAX_LOG_LINES = 200

export type TunnelStatus = {
	configured: boolean
	enabled: boolean
	lockdown: boolean
	hostname: string
	mode: 'token' | 'credentials'
	dockerAvailable: boolean
	container: {
		exists: boolean
		state: string
		startedAt?: string
		image?: string
	}
	health: {
		ready: boolean
		checkedAt: number
		error?: string
	}
	lastStartedAt?: number
	lastError?: string
	publicUrl: string | null
}

type RunResult = {code: number | null; stdout: string; stderr: string; timedOut: boolean}

function run(command: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = ''
		let stderr = ''
		let timedOut = false
		const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']})
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, timeoutMs)
		timer.unref?.()
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length < 200_000) stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 200_000) stderr += chunk.toString('utf8')
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			resolve({code: null, stdout, stderr: `${stderr}${error.message}`, timedOut})
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve({code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut})
		})
	})
}

function metricsReady(): Promise<{ready: boolean; error?: string}> {
	return new Promise((resolve) => {
		const request = http.get(
			{host: '127.0.0.1', port: METRICS_PORT, path: '/ready', timeout: 2_000},
			(response) => {
				response.resume()
				resolve({ready: response.statusCode === 200})
			},
		)
		request.on('timeout', () => {
			request.destroy()
			resolve({ready: false, error: 'Metrics endpoint timed out'})
		})
		request.on('error', (error: NodeJS.ErrnoException) => {
			resolve({ready: false, error: error.code === 'ECONNREFUSED' ? 'Tunnel is not connected' : error.message})
		})
	})
}

function yamlString(value: string): string {
	return JSON.stringify(value)
}

/**
 * Native Cloudflare Tunnel lifecycle, driven through Docker.
 *
 * Running cloudflared as a managed container means the OS image stays stock
 * (no host package to lose on an A/B update) and the tunnel inherits Docker's
 * restart policy and bounded logs. The container joins host networking and
 * targets the loopback ingress; no app container port is ever published.
 */
export default class CloudflareManager {
	readonly directory: string
	readonly configPath: string
	readonly credentialsPath: string
	readonly tokenEnvPath: string
	#config: ConfigStore
	#secrets: SecretStore
	#audit: AuditLog
	#logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	#lastStatus?: TunnelStatus
	#lastStatusAt = 0
	#pollTimer?: NodeJS.Timeout
	#operation: Promise<unknown> = Promise.resolve()

	constructor(input: {
		dataDirectory: string
		config: ConfigStore
		secrets: SecretStore
		audit: AuditLog
		logger?: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	}) {
		this.directory = path.join(input.dataDirectory, 'cloudflare')
		this.configPath = path.join(this.directory, 'config.yml')
		this.credentialsPath = path.join(this.directory, 'credentials.json')
		this.tokenEnvPath = path.join(this.directory, 'tunnel.env')
		this.#config = input.config
		this.#secrets = input.secrets
		this.#audit = input.audit
		this.#logger = input.logger ?? {log: () => {}, error: () => {}}
	}

	async start(): Promise<void> {
		await ensureDir(this.directory, 0o700)
		const config = await this.#config.load()
		if (!config.cloudflare.enabled || config.cloudflare.lockdown) return
		// Reconcile in the background: a slow or missing Docker daemon must not
		// delay umbreld's HTTP listener.
		void this.#serialise(async () => {
			try {
				await this.#ensureRunning(config.cloudflare.mode)
			} catch (error) {
				this.#logger.error('Failed to reconcile Cloudflare tunnel', error)
			}
		})
		this.#startPolling()
	}

	async stop(): Promise<void> {
		if (this.#pollTimer) clearInterval(this.#pollTimer)
		this.#pollTimer = undefined
		const config = await this.#config.load()
		// A clean umbreld stop should not tear down a tunnel that Docker will
		// keep running across an OTA reboot; only the kill switch and explicit
		// disable stop it.
		void config
	}

	#startPolling() {
		if (this.#pollTimer) return
		this.#pollTimer = setInterval(() => {
			void this.status({refresh: true}).catch(() => {})
		}, 20_000)
		this.#pollTimer.unref?.()
	}

	#serialise<T>(task: () => Promise<T>): Promise<T> {
		const next = this.#operation.then(task, task)
		this.#operation = next.catch(() => {})
		return next
	}

	async settings() {
		const config = await this.#config.load()
		return {
			cloudflare: {
				...config.cloudflare,
				// Secrets are write-only: the UI only learns whether one is set.
				access: {...config.cloudflare.access},
				security: {...config.cloudflare.security},
			},
		}
	}

	async updateSettings(
		patch: {
			hostname?: string
			mode?: 'token' | 'credentials'
			tunnelId?: string
			targetUrl?: string
			image?: string
			access?: Partial<CloudflareAccessConfig>
			security?: Partial<CloudflareSecurityConfig>
		},
		actor: {id: string; name?: string; ip?: string},
	) {
		if (patch.hostname !== undefined) {
			const hostname = patch.hostname.trim().toLowerCase()
			if (hostname && !isValidHostname(hostname)) throw new HttpError(400, 'Enter a valid public hostname')
			if (hostname.endsWith('.local')) throw new HttpError(400, 'A .local hostname is not public')
		}
		if (patch.mode && !['token', 'credentials'].includes(patch.mode)) throw new HttpError(400, 'Invalid mode')
		if (patch.targetUrl && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(patch.targetUrl)) {
			throw new HttpError(400, 'Tunnel target must be a loopback HTTP URL')
		}
		if (patch.access?.allowedEmails) {
			for (const email of patch.access.allowedEmails) {
				if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Invalid allowed email')
			}
		}
		if (patch.security) {
			const ranges: [keyof typeof patch.security, number, number][] = [
				['loginRateLimitPerMinute', 1, 120],
				['loginLockoutThreshold', 1, 100],
				['loginLockoutMinutes', 1, 1_440],
			]
			for (const [key, min, max] of ranges) {
				const value = patch.security[key]
				if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) {
					throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`)
				}
			}
		}
		const updated = await this.#config.update((draft) => {
			if (patch.hostname !== undefined) draft.cloudflare.hostname = patch.hostname.trim().toLowerCase()
			if (patch.mode !== undefined) draft.cloudflare.mode = patch.mode
			if (patch.tunnelId !== undefined) draft.cloudflare.tunnelId = patch.tunnelId.trim()
			if (patch.targetUrl !== undefined) draft.cloudflare.targetUrl = patch.targetUrl
			if (patch.image !== undefined) {
				if (!/^[a-z0-9][a-z0-9._/-]*(?::[\w.-]+)?$/i.test(patch.image)) throw new HttpError(400, 'Invalid image')
				draft.cloudflare.image = patch.image
			}
			if (patch.access) {
				const next = {...draft.cloudflare.access, ...patch.access}
				if (next.teamDomain) next.teamDomain = next.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')
				if (next.teamDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(next.teamDomain)) {
					throw new HttpError(400, 'Invalid Access team domain')
				}
				next.allowedEmails = [...new Set(next.allowedEmails.map((email) => email.toLowerCase()))]
				next.protectedPrefixes = [...new Set(next.protectedPrefixes)]
				draft.cloudflare.access = next
			}
			if (patch.security) draft.cloudflare.security = {...draft.cloudflare.security, ...patch.security}
			return structuredClone(draft.cloudflare)
		})
		this.#audit.record({
			type: 'cloudflare.config',
			action: 'Updated Cloudflare exposure settings',
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			detail: {
				hostname: updated.hostname,
				mode: updated.mode,
				accessEnabled: updated.access.enabled,
				security: updated.security,
			},
		})
		this.#invalidate()
		return updated
	}

	async setToken(token: string, actor: {id: string; name?: string; ip?: string}) {
		if (typeof token !== 'string' || token.trim().length < 20 || token.length > 4096) {
			throw new HttpError(400, 'Tunnel token looks invalid')
		}
		await this.#secrets.writeSecret('cloudflare-tunnel-token', token.trim())
		await this.#config.update((draft) => {
			draft.cloudflare.tokenSet = true
			draft.cloudflare.mode = 'token'
		})
		this.#audit.record({
			type: 'cloudflare.config',
			action: 'Stored Cloudflare tunnel token',
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
		})
		this.#invalidate()
	}

	async setCredentials(credentials: unknown, actor: {id: string; name?: string; ip?: string}) {
		if (!isRecord(credentials)) throw new HttpError(400, 'Credentials must be a JSON object')
		const {TunnelID, TunnelSecret, AccountTag} = credentials as Record<string, unknown>
		if (typeof TunnelID !== 'string' || !/^[0-9a-f-]{32,40}$/i.test(TunnelID)) {
			throw new HttpError(400, 'Credentials are missing a valid TunnelID')
		}
		if (typeof TunnelSecret !== 'string' || TunnelSecret.length < 20) {
			throw new HttpError(400, 'Credentials are missing a valid TunnelSecret')
		}
		if (typeof AccountTag !== 'string' || !/^[0-9a-f]{32}$/i.test(AccountTag)) {
			throw new HttpError(400, 'Credentials are missing a valid AccountTag')
		}
		await this.#secrets.writeSecret('cloudflare-credentials', JSON.stringify({TunnelID, TunnelSecret, AccountTag}))
		await this.#config.update((draft) => {
			draft.cloudflare.credentialsSet = true
			draft.cloudflare.tunnelId = TunnelID
			draft.cloudflare.mode = 'credentials'
		})
		this.#audit.record({
			type: 'cloudflare.config',
			action: 'Stored Cloudflare tunnel credentials',
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			detail: {tunnelId: TunnelID},
		})
		this.#invalidate()
	}

	async clearSecret(kind: 'token' | 'credentials', actor: {id: string; name?: string; ip?: string}) {
		await this.#secrets.writeSecret(kind === 'token' ? 'cloudflare-tunnel-token' : 'cloudflare-credentials', '')
		await this.#config.update((draft) => {
			if (kind === 'token') draft.cloudflare.tokenSet = false
			else draft.cloudflare.credentialsSet = false
		})
		this.#audit.record({
			type: 'cloudflare.config',
			action: `Cleared Cloudflare ${kind}`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
		})
		this.#invalidate()
	}

	async enable(actor: {id: string; name?: string; ip?: string}) {
		return this.#serialise(async () => {
			const config = await this.#config.load()
			const {hostname, mode, tokenSet, credentialsSet, tunnelId} = config.cloudflare
			if (!hostname) throw new HttpError(400, 'Set a public hostname first')
			if (config.cloudflare.lockdown) throw new HttpError(409, 'Disable emergency lockdown first')
			if (mode === 'token' && !tokenSet) throw new HttpError(400, 'Paste a tunnel token first')
			if (mode === 'credentials' && (!credentialsSet || !tunnelId)) {
				throw new HttpError(400, 'Upload tunnel credentials and a tunnel id first')
			}
			if (mode === 'credentials') await this.#writeRuntimeConfig()
			await this.#ensureRunning(mode)
			await this.#config.update((draft) => {
				draft.cloudflare.enabled = true
				draft.cloudflare.lastStartedAt = Date.now()
				draft.cloudflare.lastError = undefined
			})
			this.#audit.record({
				type: 'cloudflare.enable',
				action: 'Enabled Cloudflare tunnel',
				actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
				target: hostname,
			})
			this.#startPolling()
			this.#invalidate()
			return this.status({refresh: true})
		})
	}

	async disable(actor: {id: string; name?: string; ip?: string}) {
		return this.#serialise(async () => {
			await this.#stopContainer()
			await this.#config.update((draft) => {
				draft.cloudflare.enabled = false
			})
			this.#audit.record({
				type: 'cloudflare.disable',
				action: 'Disabled Cloudflare tunnel',
				actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			})
			this.#invalidate()
			return this.status({refresh: true})
		})
	}

	/** Emergency kill switch: stop the container now and refuse public traffic. */
	async setLockdown(locked: boolean, actor: {id: string; name?: string; ip?: string}) {
		return this.#serialise(async () => {
			if (locked) await this.#stopContainer()
			await this.#config.update((draft) => {
				draft.cloudflare.lockdown = locked
				if (locked) draft.cloudflare.enabled = false
			})
			this.#audit.record({
				type: 'cloudflare.lockdown',
				action: locked ? 'EMERGENCY LOCKDOWN enabled' : 'Emergency lockdown released',
				actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
				outcome: 'success',
			})
			this.#invalidate()
			return this.status({refresh: true})
		})
	}

	async #ensureRunning(mode: 'token' | 'credentials') {
		const config = await this.#config.load()
		const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], 8_000)
		if (docker.code !== 0) throw new HttpError(503, 'Docker is not available; the tunnel cannot start')
		await this.#stopContainer()
		await ensureDir(this.directory, 0o700)

		const common = [
			'run',
			'-d',
			'--name',
			CONTAINER_NAME,
			'--label',
			'io.umbra.managed=true',
			'--restart',
			'unless-stopped',
			'--network',
			'host',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges',
			'--log-driver',
			'json-file',
			'--log-opt',
			'max-size=10m',
			'--log-opt',
			'max-file=3',
		]

		if (mode === 'token') {
			const token = await this.#secrets.readSecret('cloudflare-tunnel-token')
			if (!token) throw new HttpError(400, 'Tunnel token is missing')
			await writeFileAtomic(this.tokenEnvPath, `TUNNEL_TOKEN=${token}\n`, 0o600)
			const result = await run(
				'docker',
				[
					...common,
					'--env-file',
					this.tokenEnvPath,
					config.cloudflare.image,
					'tunnel',
					'--no-autoupdate',
					'--metrics',
					`127.0.0.1:${METRICS_PORT}`,
					'run',
				],
				120_000,
			)
			// The container holds the variable; removing the file shrinks the
			// window in which a backup could capture it.
			await writeFileAtomic(this.tokenEnvPath, '', 0o600)
			if (result.code !== 0) {
				const message = result.stderr.split('\n').at(-1) || 'docker run failed'
				await this.#recordError(message)
				throw new HttpError(502, message)
			}
			return
		}

		await this.#writeRuntimeConfig()
		const result = await run(
			'docker',
			[
				...common,
				'-v',
				`${this.directory}:/etc/cloudflared:ro`,
				config.cloudflare.image,
				'tunnel',
				'--config',
				'/etc/cloudflared/config.yml',
				'--no-autoupdate',
				'--metrics',
				`127.0.0.1:${METRICS_PORT}`,
				'run',
			],
			120_000,
		)
		if (result.code !== 0) {
			const message = result.stderr.split('\n').at(-1) || 'docker run failed'
			await this.#recordError(message)
			throw new HttpError(502, message)
		}
	}

	async #writeRuntimeConfig() {
		const config = await this.#config.load()
		const {hostname, tunnelId, targetUrl} = config.cloudflare
		if (!hostname) throw new HttpError(400, 'Hostname is required')
		if (!tunnelId) throw new HttpError(400, 'Tunnel id is required')
		const credentials = await this.#secrets.readSecret('cloudflare-credentials')
		if (!credentials) throw new HttpError(400, 'Tunnel credentials are missing')
		await writeFileAtomic(this.credentialsPath, credentials, 0o600)
		const yaml = [
			`# Generated by Umbra. Manual changes are overwritten.`,
			`tunnel: ${yamlString(tunnelId)}`,
			`credentials-file: /etc/cloudflared/credentials.json`,
			`no-autoupdate: true`,
			`ingress:`,
			`  - hostname: ${yamlString(hostname)}`,
			`    service: ${yamlString(targetUrl)}`,
			`    originRequest:`,
			`      connectTimeout: 30s`,
			`      tcpKeepAlive: 30s`,
			`  - service: http_status:404`,
			``,
		].join('\n')
		await writeFileAtomic(this.configPath, yaml, 0o600)
	}

	async #stopContainer() {
		await run('docker', ['rm', '-f', CONTAINER_NAME], 30_000)
	}

	async #recordError(message: string) {
		this.#logger.error(`Cloudflare tunnel failed: ${message}`)
		await this.#config
			.update((draft) => {
				draft.cloudflare.lastError = message.slice(0, 500)
			})
			.catch(() => {})
		this.#invalidate()
	}

	#invalidate() {
		this.#lastStatus = undefined
		this.#lastStatusAt = 0
	}

	async status({refresh = false}: {refresh?: boolean} = {}): Promise<TunnelStatus> {
		if (!refresh && this.#lastStatus && Date.now() - this.#lastStatusAt < STATUS_TTL_MS) {
			return this.#lastStatus
		}
		const config = await this.#config.load()
		const dockerVersion = await run('docker', ['version', '--format', '{{.Server.Version}}'], 5_000)
		const dockerAvailable = dockerVersion.code === 0
		let exists = false
		let state = 'not-created'
		let startedAt: string | undefined
		let image: string | undefined
		if (dockerAvailable) {
			const inspect = await run(
				'docker',
				['inspect', '--format', '{{json .State}}|{{.Config.Image}}', CONTAINER_NAME],
				5_000,
			)
			if (inspect.code === 0 && inspect.stdout.includes('|')) {
				const [stateJson, imageValue] = inspect.stdout.split('|')
				try {
					const parsed = JSON.parse(stateJson) as {Status?: string; StartedAt?: string}
					exists = true
					state = parsed.Status ?? 'unknown'
					startedAt = parsed.StartedAt
					image = imageValue
				} catch {
					state = 'unknown'
				}
			}
		}
		const health =
			exists && state === 'running' ? await metricsReady() : {ready: false, error: dockerAvailable ? undefined : 'Docker unavailable'}
		const status: TunnelStatus = {
			configured: Boolean(
				config.cloudflare.hostname &&
					(config.cloudflare.mode === 'token' ? config.cloudflare.tokenSet : config.cloudflare.credentialsSet),
			),
			enabled: config.cloudflare.enabled,
			lockdown: config.cloudflare.lockdown,
			hostname: config.cloudflare.hostname,
			mode: config.cloudflare.mode,
			dockerAvailable,
			container: {exists, state, startedAt, image},
			health: {ready: health.ready, checkedAt: Date.now(), error: health.error},
			lastStartedAt: config.cloudflare.lastStartedAt,
			lastError: config.cloudflare.lastError,
			publicUrl: config.cloudflare.hostname ? `https://${config.cloudflare.hostname}` : null,
		}
		this.#lastStatus = status
		this.#lastStatusAt = Date.now()
		return status
	}

	async logs(lines = 100): Promise<string> {
		const result = await run('docker', ['logs', '--tail', String(Math.min(lines, MAX_LOG_LINES)), CONTAINER_NAME], 10_000)
		return `${result.stdout}\n${result.stderr}`.trim()
	}

	/** Wait until the tunnel reports ready, used by the UI after enabling. */
	async waitUntilReady(timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const health = await metricsReady()
			if (health.ready) return true
			await sleep(1_000)
		}
		return false
	}
}
