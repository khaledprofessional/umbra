import path from 'node:path'

import AppAccessManager from './access.js'
import AgentRegistry from './agents.js'
import AppPathProxy from './app-proxy.js'
import AuditLog from './audit.js'
import CloudflareManager from './cloudflare.js'
import ConfigStore from './config.js'
import EdgeGuard from './edge.js'
import {
	AppOverrideManager,
	AutoUpdateManager,
	SnapshotManager,
} from './extras.js'
import {ensureDir} from './fs-util.js'
import {fetchAndSanitizeAvatar} from './image.js'
import createUmbraRouter from './http.js'
import PluginManager from './plugins.js'
import SecretStore from './secrets.js'
import TerminalExecutor, {ApprovalManager} from './terminal.js'
import type {HttpRequest, LoggerLike, Middleware, UmbrelLike} from './types.js'
import {HttpError, isRecord, redact} from './util.js'

export type UmbraOptions = {
	umbreld: UmbrelLike
	logger?: LoggerLike
}

type McpServerLike = {registerTool: (...args: never[]) => unknown}
type McpToolContextLike = {
	agent?: {tokenId: string; label: string; agentType?: string; clientName?: string}
}
type McpPermissionsLike = {manageSystem: boolean}

type TokenMetadata = {id: string; label: string; agentType?: string}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * Umbra: the isolated custom layer for this umbrelOS fork.
 *
 * It owns every custom subsystem and touches upstream only through the small
 * bridge in `source/index.ts` and three mounts in the server. All state lives
 * under `<umbreld data>/umbra`, which survives app updates and A/B OS updates.
 */
export default class Umbra {
	readonly umbreld: UmbrelLike
	readonly dataDirectory: string
	readonly config: ConfigStore
	readonly secrets: SecretStore
	readonly audit: AuditLog
	readonly agents: AgentRegistry
	readonly approvals: ApprovalManager
	readonly terminal: TerminalExecutor
	readonly cloudflare: CloudflareManager
	readonly edge: EdgeGuard
	readonly plugins: PluginManager
	readonly access: AppAccessManager
	readonly appProxy: AppPathProxy
	readonly overrides: AppOverrideManager
	readonly snapshots: SnapshotManager
	readonly autoUpdate: AutoUpdateManager
	logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	#tokenCache: {at: number; tokens: Map<string, TokenMetadata>} = {at: 0, tokens: new Map()}
	#started = false
	#eventUnsubscribers: (() => void)[] = []
	#router?: ReturnType<typeof createUmbraRouter>

	constructor({umbreld, logger}: UmbraOptions) {
		this.umbreld = umbreld
		this.dataDirectory = path.join(umbreld.dataDirectory, 'umbra')
		const base = logger ?? umbreld.logger
		const child = base.createChildLogger?.('umbra') ?? base
		this.logger = {
			log: (...args) => child.log('[umbra]', ...args),
			error: (...args) => child.error('[umbra]', ...args),
		}
		this.config = new ConfigStore(this.dataDirectory)
		this.secrets = new SecretStore(this.dataDirectory)
		this.audit = new AuditLog(this.dataDirectory)
		this.agents = new AgentRegistry(this.dataDirectory, this.audit, this.secrets)
		this.approvals = new ApprovalManager(this.audit)
		this.terminal = new TerminalExecutor(this.config, this.agents, this.audit, this.approvals, {
			defaultCwd: umbreld.dataDirectory,
		})
		this.cloudflare = new CloudflareManager({
			dataDirectory: this.dataDirectory,
			config: this.config,
			secrets: this.secrets,
			audit: this.audit,
			logger: this.logger,
		})
		this.edge = new EdgeGuard(this.config, this.cloudflare, this.audit)
		this.plugins = new PluginManager({
			dataDirectory: this.dataDirectory,
			config: this.config,
			audit: this.audit,
			umbreld,
			logger: this.logger,
		})
		this.access = new AppAccessManager({config: this.config, audit: this.audit, umbreld, logger: this.logger})
		this.appProxy = new AppPathProxy(umbreld, this)
		this.overrides = new AppOverrideManager({
			dataDirectory: this.dataDirectory,
			config: this.config,
			audit: this.audit,
			umbreld,
			logger: this.logger,
		})
		this.snapshots = new SnapshotManager({
			dataDirectory: this.dataDirectory,
			config: this.config,
			secrets: this.secrets,
			audit: this.audit,
			umbreld,
			logger: this.logger,
		})
		this.autoUpdate = new AutoUpdateManager({
			config: this.config,
			audit: this.audit,
			umbreld: umbreld as UmbrelLike & {appStore?: {publicRegistry: () => Promise<unknown[]>}},
			snapshots: this.snapshots,
			logger: this.logger,
		})
	}

	async start(): Promise<void> {
		if (this.#started) return
		await ensureDir(this.dataDirectory, 0o700)
		await this.secrets.start()
		await this.audit.start()
		await this.agents.start()
		await this.config.load()
		this.#started = true
		await this.agents.pruneOrphanAvatars().catch(() => {})
		this.audit.record({
			type: 'system.start',
			action: 'Umbra started',
			actor: {type: 'system', id: 'umbreld'},
			detail: {umbrelVersion: this.umbreld.version},
		})
		this.audit.prune(90).catch(() => {})
		await this.overrides.applyAll().catch((error) => this.logger.error('Failed to apply app overrides', error))
		await this.plugins.start().catch((error) => this.logger.error('Failed to start plugins', error))
		await this.snapshots.start()
		this.autoUpdate.start()
		await this.cloudflare.start().catch((error) => this.logger.error('Failed to start Cloudflare manager', error))
		this.#subscribe()
	}

	#subscribe() {
		const on = (event: string, listener: (payload: unknown) => void) => {
			try {
				const unsubscribe = this.umbreld.eventBus.on(event, listener)
				if (typeof unsubscribe === 'function') this.#eventUnsubscribers.push(unsubscribe)
			} catch (error) {
				this.logger.error(`Failed to subscribe to ${event}`, error)
			}
		}
		on('apps:state:change', (payload) => {
			if (!isRecord(payload) || typeof payload.appId !== 'string') return
			void this.overrides
				.apply(payload.appId)
				.catch((error) => this.logger.error(`Failed to apply overrides for '${payload.appId}'`, error))
		})
		on('apps:settings:change', (payload) => {
			if (!isRecord(payload) || typeof payload.appId !== 'string') return
			void this.overrides.apply(payload.appId).catch(() => {})
		})
		for (const event of ['apps:state:change', 'apps:settings:change', 'system:disk:change', 'notifications:change']) {
			on(event, (payload) => {
				void this.plugins.dispatchEvent(event, payload).catch(() => {})
			})
		}
	}

	async stop(): Promise<void> {
		for (const unsubscribe of this.#eventUnsubscribers.splice(0)) {
			try {
				unsubscribe()
			} catch {
				// Listener already removed.
			}
		}
		this.approvals.denyAll('umbreld is shutting down')
		await this.plugins.stop().catch(() => {})
		await this.snapshots.stop().catch(() => {})
		this.autoUpdate.stop()
		await this.cloudflare.stop().catch(() => {})
		this.audit.record({
			type: 'system.stop',
			action: 'Umbra stopped',
			actor: {type: 'system', id: 'umbreld'},
		})
		await this.audit.flush().catch(() => {})
		this.#started = false
	}

	/** Express middleware that protects every umbreld route. */
	edgeMiddleware(): any {
		return this.edge.middleware
	}

	/** `/apps/<id>/…` single-subdomain app routing (path-safe apps only). */
	appProxyMiddleware(): any {
		return this.appProxy.middleware()
	}

	/** The authenticated `/umbra` admin API and console, mounted by Server. */
	get router(): any {
		this.#router ??= createUmbraRouter(this.umbreld, this)
		return this.#router
	}

	/**
	 * Called by the patched MCP endpoint for each JSON-RPC request. Captures the
	 * agent identity on initialize and audits every tool call with redacted
	 * arguments. This is the single place all MCP activity is observed.
	 */
	async observeMcpRequest(tokenId: string, body: unknown, ip?: string): Promise<void> {
		try {
			const messages = Array.isArray(body) ? body : [body]
			const tokens = await this.#tokenMap()
			const token = tokens.get(tokenId)
			if (!token) return
			for (const message of messages.slice(0, 50)) {
				if (!isRecord(message) || typeof message.method !== 'string') continue
				const params = isRecord(message.params) ? message.params : {}
				const meta = isRecord(params._meta) ? params._meta : undefined
				const clientInfo = isRecord(meta?.clientInfo)
					? meta.clientInfo
					: message.method === 'initialize' && isRecord(params.clientInfo)
						? params.clientInfo
						: undefined
				const clientName = clientInfo && typeof clientInfo.name === 'string' ? clientInfo.name : undefined
				const clientVersion = clientInfo && typeof clientInfo.version === 'string' ? clientInfo.version : undefined
				if (clientName) {
					await this.agents
						.observe({
							tokenId,
							label: token.label,
							agentType: token.agentType,
							clientName,
							clientVersion,
							ip,
						})
						.catch(() => {})
				}
				if (message.method === 'initialize') {
					this.audit.record({
						type: 'mcp.connect',
						action: 'MCP agent connected',
						actor: {type: 'agent', id: tokenId, name: token.label, ip},
						outcome: 'success',
						detail: {
							clientName: clientName ?? null,
							clientVersion: clientVersion ?? null,
							agentType: token.agentType ?? null,
						},
					})
					continue
				}
				if (message.method === 'tools/call' && typeof params.name === 'string') {
					const args = isRecord(params.arguments) ? params.arguments : {}
					this.audit.record({
						type: 'mcp.tool',
						action: `Called MCP tool '${params.name}'`,
						actor: {type: 'agent', id: tokenId, name: token.label, ip},
						target: params.name,
						outcome: 'success',
						detail: {arguments: redact(args)},
					})
				}
			}
		} catch (error) {
			this.logger.error('Failed to observe MCP request', error)
		}
	}

	async #tokenMap(): Promise<Map<string, TokenMetadata>> {
		if (Date.now() - this.#tokenCache.at < 5_000) return this.#tokenCache.tokens
		const map = new Map<string, TokenMetadata>()
		try {
			const tokens = (await this.umbreld.mcp?.listTokens?.()) ?? []
			for (const token of tokens as TokenMetadata[]) {
				if (token && typeof token.id === 'string') map.set(token.id, token)
			}
		} catch {
			// Keep the previous cache on a transient store failure.
			return this.#tokenCache.tokens
		}
		this.#tokenCache = {at: Date.now(), tokens: map}
		return map
	}

	async registerMcpTools(
		server: McpServerLike,
		context: McpToolContextLike,
		permissions: McpPermissionsLike,
	): Promise<void> {
		if (!context.agent) return
		const policy = await this.terminal.policyFor(context.agent.tokenId)
		// Non-literal so this module stays independently type-checkable without
		// umbreld's MCP dependencies installed.
		const modulePath: string = './mcp-tools.js'
		const register = (await import(modulePath)).default
		register(server as never, context as never, permissions as never, this, policy.mode)
	}

	async setAgentAvatarFromUrl(tokenId: string, url: string, actor: {type: 'agent' | 'user'; id: string; name?: string}) {
		const image = await fetchAndSanitizeAvatar(url)
		return this.agents.setAvatar(tokenId, image, actor)
	}

	/** Summary used by the settings bridge and the standalone console. */
	async summary() {
		const config = await this.config.load()
		const [cloudflare, plugins] = await Promise.all([this.cloudflare.status(), this.plugins.list()])
		return {
			version: this.umbreld.version,
			dataDirectory: this.dataDirectory,
			config: {
				terminal: config.terminal,
				cloudflare: {
					...config.cloudflare,
					access: config.cloudflare.access,
					security: config.cloudflare.security,
				},
				access: config.access,
				plugins: {enabled: config.plugins.enabled},
				extras: {
					overrides: config.extras.overrides,
					autoUpdate: config.extras.autoUpdate,
					snapshots: config.extras.snapshots,
				},
			},
			cloudflare,
			plugins: plugins.map((plugin) => ({id: plugin.id, version: plugin.version, enabled: plugin.enabled, running: plugin.running})),
			approvals: this.approvals.list(),
			agents: this.agents.list().map((agent) => ({
				...agent,
				avatarUrl: agent.avatar ? `/umbra/api/agents/${agent.tokenId}/avatar?v=${agent.avatar.sha256.slice(0, 12)}` : null,
			})),
			audit: {entries: (await this.audit.query({limit: 1})).events.length},
			snapshots: (await this.snapshots.list()).slice(0, 5),
			storage: formatBytes(0),
		}
	}

	requireOwner(principal: {accountId: string} | null | undefined) {
		if (!principal || principal.accountId !== '0') throw new HttpError(403, 'This action can only be performed by the owner')
	}
}

export type {HttpRequest}
