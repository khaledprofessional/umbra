/**
 * Umbra plugin sandbox entrypoint.
 *
 * This file is spawned by the host with Node's permission model enabled:
 *   node --permission --allow-fs-read=<plugin dir> runtime.mjs <pluginDir> <entry>
 *
 * It has no filesystem, network, child-process, or worker permissions beyond
 * reading the plugin's own directory. Every privileged operation is an RPC back
 * to the host, which checks the plugin's declared permissions against a strict
 * allowlist. The plugin never sees host credentials or the IPC token.
 */
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const [, , pluginDirectory, entryFile, pluginIdArgument] = process.argv
let pluginModule
let shuttingDown = false
const pending = new Map()
let nextCallId = 1

// Defence in depth: the Linux sandbox runs this process in an empty network
// namespace, but also remove the browser-style network globals so a plugin
// fails loudly instead of hanging.
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
	try {
		Object.defineProperty(globalThis, name, {
			configurable: false,
			writable: false,
			value: () => {
				throw new Error('Plugin network access is disabled; use the host API')
			},
		})
	} catch {
		// Some globals are non-configurable in older runtimes.
	}
}

const PLUGIN_ROOT = path.resolve(pluginDirectory)

function send(message) {
	if (!process.connected) return
	process.send(message)
}

function callHost(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = nextCallId++
		pending.set(id, {resolve, reject})
		send({type: 'call', id, method, params})
	})
}

function makeContext() {
	const storage = {
		get: async (key) => {
			if (typeof key !== 'string' || key.length > 120) throw new Error('Invalid storage key')
			const all = (await callHost('storage.get', {key})) ?? null
			return all
		},
		set: async (key, value) => {
			if (typeof key !== 'string' || key.length > 120) throw new Error('Invalid storage key')
			const json = JSON.stringify(value)
			if (json.length > 64 * 1024) throw new Error('Storage value is too large')
			return callHost('storage.set', {key, value})
		},
		delete: async (key) => callHost('storage.delete', {key}),
	}
	return {
		plugin: {id: pluginIdArgument ?? path.basename(PLUGIN_ROOT)},
		log: (level, ...args) => {
			const text = args
				.map((value) => {
					if (typeof value === 'string') return value
					try {
						return JSON.stringify(value)
					} catch {
						return String(value)
					}
				})
				.join(' ')
				.slice(0, 4000)
			callHost('log', {
				level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
				message: text,
			}).catch(() => {})
		},
		storage,
		metrics: () => callHost('metrics.read'),
		docker: {
			list: () => callHost('docker.list'),
		},
		apps: {
			list: () => callHost('apps.list'),
		},
		notify: (title, message) => {
			if (typeof title !== 'string' || typeof message !== 'string') throw new Error('notify(title, message)')
			return callHost('notify', {title: title.slice(0, 120), message: message.slice(0, 1000)})
		},
		widgets: {
			setData: (widgetId, data) => {
				if (typeof widgetId !== 'string') throw new Error('Invalid widget id')
				return callHost('widget.setData', {widgetId, data})
			},
		},
	}
}

const context = makeContext()

process.on('message', (message) => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'result') {
		const entry = pending.get(message.id)
		if (!entry) return
		pending.delete(message.id)
		if (message.error) entry.reject(new Error(String(message.error)))
		else entry.resolve(message.value)
		return
	}
	if (message.type === 'invoke') {
		void (async () => {
			try {
				let result
				if (message.method === 'activate') {
					result = await pluginModule?.activate?.(context)
				} else if (message.method === 'deactivate') {
					result = await pluginModule?.deactivate?.()
				} else if (message.method === 'event') {
					result = await pluginModule?.onEvent?.(message.params?.event, message.params?.payload)
				} else {
					throw new Error('Unknown method')
				}
				send({type: 'invoke-result', id: message.id, value: result ?? null})
			} catch (error) {
				send({
					type: 'invoke-result',
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		})()
		return
	}
	if (message.type === 'settings') {
		context.settings = message.settings && typeof message.settings === 'object' ? message.settings : {}
		return
	}
	if (message.type === 'shutdown') {
		shuttingDown = true
		// The host has already invoked deactivate with its own timeout.
		process.exit(0)
	}
})

async function boot() {
	if (!entryFile) {
		send({type: 'ready'})
		return
	}
	const resolved = path.resolve(PLUGIN_ROOT, entryFile)
	if (!resolved.startsWith(`${PLUGIN_ROOT}${path.sep}`)) throw new Error('Entry escapes plugin directory')
	pluginModule = await import(pathToFileURL(resolved).href)
	// Activation is owned by the host so lifecycle and errors are audited in one
	// place; the child only reports that its module loaded.
	send({type: 'ready'})
}

process.on('uncaughtException', (error) => {
	send({type: 'fatal', error: error instanceof Error ? error.message : String(error)})
	process.exit(1)
})
process.on('unhandledRejection', (error) => {
	send({type: 'fatal', error: error instanceof Error ? error.message : String(error)})
	process.exit(1)
})

boot().catch((error) => {
	send({type: 'fatal', error: error instanceof Error ? error.message : String(error)})
	process.exit(1)
})
