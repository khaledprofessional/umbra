import path from 'node:path'

import {readJsonOrNull, writeJsonAtomic} from './fs-util.js'
import {asBoolean, asNumber, asString, isRecord} from './util.js'

export type AppAccessPolicy = 'none' | 'request' | 'manage'
export type TerminalMode = 'deny' | 'ask' | 'always'

export type AppQuota = {
	cpus?: number
	memoryMb?: number
	pids?: number
	vramMb?: number
}

export type AppOverride = {
	composeOverride: string
	quota: AppQuota
	updatedAt: number
	updatedBy?: string
}

export type AutoUpdateWindow = {
	days: number[]
	start: string
	end: string
}

export type AutoUpdateConfig = {
	enabled: boolean
	apps: 'all' | string[]
	window: AutoUpdateWindow
	onlyCompatible: boolean
}

export type SnapshotConfig = {
	enabled: boolean
	intervalHours: number
	retention: number
	passphraseSet: boolean
}

export type CloudflareAccessConfig = {
	enabled: boolean
	teamDomain: string
	audience: string
	allowedEmails: string[]
	allowedGroups: string[]
	protectedPrefixes: string[]
	publicProcedures: string[]
}

export type CloudflareSecurityConfig = {
	loginRateLimitPerMinute: number
	loginLockoutThreshold: number
	loginLockoutMinutes: number
	hsts: boolean
	strictCsp: boolean
	originLock: boolean
	blockDirectIp: boolean
}

export type CloudflareConfig = {
	enabled: boolean
	hostname: string
	mode: 'token' | 'credentials'
	tunnelId: string
	targetUrl: string
	tokenSet: boolean
	credentialsSet: boolean
	access: CloudflareAccessConfig
	security: CloudflareSecurityConfig
	image: string
	/** Emergency stop: the tunnel is forced down and public requests are refused. */
	lockdown: boolean
	lastStartedAt?: number
	lastError?: string
}

export type AppRequestStatus = 'pending' | 'approved' | 'denied' | 'installing' | 'installed' | 'failed'
export type AppRequest = {
	id: string
	appId: string
	appName: string
	userId: string
	userName: string
	message?: string
	status: AppRequestStatus
	createdAt: number
	decidedAt?: number
	decidedBy?: string
	reason?: string
	error?: string
}

export type MemberAccess = {
	appInstall: AppAccessPolicy
	createdAt: number
	updatedAt: number
}

export type PluginRecord = {
	id: string
	version: string
	enabled: boolean
	installedAt: number
	installedBy: string
	manifestHash: string
	settings: Record<string, unknown>
	lastError?: string
}

export type UmbraConfig = {
	version: 1
	installedAt: number
	terminal: {
		enabled: boolean
		allowedRoots: string[]
		defaultTimeoutMs: number
		maxOutputBytes: number
		approvalTimeoutMs: number
	}
	cloudflare: CloudflareConfig
	access: {
		defaultPolicy: AppAccessPolicy
		members: Record<string, MemberAccess>
		requests: AppRequest[]
	}
	plugins: {
		enabled: boolean
		records: Record<string, PluginRecord>
	}
	extras: {
		overrides: Record<string, AppOverride>
		autoUpdate: AutoUpdateConfig
		snapshots: SnapshotConfig
	}
	ui: {
		showAgentAvatarsOnLockScreen: boolean
	}
}

export const CONFIG_VERSION = 1

export function defaultConfig(): UmbraConfig {
	return {
		version: CONFIG_VERSION,
		installedAt: Date.now(),
		terminal: {
			enabled: true,
			allowedRoots: [],
			defaultTimeoutMs: 30_000,
			maxOutputBytes: 256 * 1024,
			approvalTimeoutMs: 90_000,
		},
		cloudflare: {
			enabled: false,
			hostname: '',
			mode: 'token',
			tunnelId: '',
			targetUrl: 'http://127.0.0.1:80',
			tokenSet: false,
			credentialsSet: false,
			access: {
				enabled: false,
				teamDomain: '',
				audience: '',
				allowedEmails: [],
				allowedGroups: [],
				protectedPrefixes: ['/settings', '/umbra', '/mcp', '/terminal', '/api', '/trpc', '/app-auth'],
				publicProcedures: [
					'user.login',
					'user.loginNative',
					'user.refreshNativeAccess',
					'user.listAccounts',
					'user.exists',
					'user.register',
					'user.isLoggedIn',
					'user.wallpaper',
					'user.language',
					'user.is2faEnabled',
					'user.get',
				],
			},
			security: {
				loginRateLimitPerMinute: 10,
				loginLockoutThreshold: 8,
				loginLockoutMinutes: 15,
				hsts: true,
				strictCsp: true,
				originLock: true,
				blockDirectIp: false,
			},
			image: 'cloudflare/cloudflared:latest',
			lockdown: false,
		},
		access: {
			defaultPolicy: 'request',
			members: {},
			requests: [],
		},
		plugins: {
			enabled: true,
			records: {},
		},
		extras: {
			overrides: {},
			autoUpdate: {
				enabled: false,
				apps: 'all',
				window: {days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', end: '05:00'},
				onlyCompatible: true,
			},
			snapshots: {
				enabled: true,
				intervalHours: 24,
				retention: 14,
				passphraseSet: false,
			},
		},
		ui: {
			showAgentAvatarsOnLockScreen: true,
		},
	}
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidHostname(value: string): boolean {
	return HOSTNAME_PATTERN.test(value) && !value.endsWith('.local')
}

export function assertValidConfig(config: UmbraConfig): void {
	if (config.version !== CONFIG_VERSION) throw new Error(`Unsupported Umbra config version: ${config.version}`)
	if (!Number.isFinite(config.installedAt)) throw new Error('Invalid installedAt')
	if (config.cloudflare.hostname && !isValidHostname(config.cloudflare.hostname)) {
		throw new Error('Invalid Cloudflare hostname')
	}
	if (!['token', 'credentials'].includes(config.cloudflare.mode)) throw new Error('Invalid tunnel mode')
	if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(config.cloudflare.targetUrl)) {
		throw new Error('Invalid tunnel target URL')
	}
	if (!Number.isInteger(config.terminal.defaultTimeoutMs) || config.terminal.defaultTimeoutMs < 1_000) {
		throw new Error('Invalid terminal timeout')
	}
	for (const request of config.access.requests) {
		if (!['pending', 'approved', 'denied', 'installing', 'installed', 'failed'].includes(request.status)) {
			throw new Error('Invalid app request status')
		}
	}
	const window = config.extras.autoUpdate.window
	if (!TIME_PATTERN.test(window.start) || !TIME_PATTERN.test(window.end)) throw new Error('Invalid auto-update window')
	if (!window.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
		throw new Error('Invalid auto-update days')
	}
}

function stringArray(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : fallback
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	const number = asNumber(value, fallback)
	return Math.min(max, Math.max(min, number))
}

/**
 * Merge persisted data over defaults without trusting its shape. Unknown
 * top-level keys are discarded so a corrupted or hostile config cannot smuggle
 * fields into code that later spreads it.
 */
export function normalizeConfig(input: unknown): UmbraConfig {
	const defaults = defaultConfig()
	if (!isRecord(input)) return defaults
	const cloudflare = isRecord(input.cloudflare) ? input.cloudflare : {}
	const access = isRecord(cloudflare.access) ? cloudflare.access : {}
	const security = isRecord(cloudflare.security) ? cloudflare.security : {}
	const terminal = isRecord(input.terminal) ? input.terminal : {}
	const accessConfig = isRecord(input.access) ? input.access : {}
	const plugins = isRecord(input.plugins) ? input.plugins : {}
	const extras = isRecord(input.extras) ? input.extras : {}
	const autoUpdate = isRecord(extras.autoUpdate) ? extras.autoUpdate : {}
	const window = isRecord(autoUpdate.window) ? autoUpdate.window : {}
	const snapshots = isRecord(extras.snapshots) ? extras.snapshots : {}
	const ui = isRecord(input.ui) ? input.ui : {}

	const members: Record<string, MemberAccess> = {}
	if (isRecord(accessConfig.members)) {
		for (const [userId, value] of Object.entries(accessConfig.members)) {
			if (!isRecord(value)) continue
			const policy = asString(value.appInstall, defaults.access.defaultPolicy)
			if (!['none', 'request', 'manage'].includes(policy)) continue
			members[userId] = {
				appInstall: policy as AppAccessPolicy,
				createdAt: asNumber(value.createdAt, Date.now()),
				updatedAt: asNumber(value.updatedAt, Date.now()),
			}
		}
	}

	const requests = Array.isArray(accessConfig.requests)
		? accessConfig.requests.filter(isRecord).map((request) => ({
				id: asString(request.id),
				appId: asString(request.appId),
				appName: asString(request.appName),
				userId: asString(request.userId),
				userName: asString(request.userName),
				message: typeof request.message === 'string' ? request.message.slice(0, 500) : undefined,
				status: (['pending', 'approved', 'denied', 'installing', 'installed', 'failed'] as const).includes(
					request.status as AppRequestStatus,
				)
					? (request.status as AppRequestStatus)
					: 'pending',
				createdAt: asNumber(request.createdAt, Date.now()),
				decidedAt: typeof request.decidedAt === 'number' ? request.decidedAt : undefined,
				decidedBy: typeof request.decidedBy === 'string' ? request.decidedBy : undefined,
				reason: typeof request.reason === 'string' ? request.reason.slice(0, 500) : undefined,
				error: typeof request.error === 'string' ? request.error.slice(0, 500) : undefined,
			}))
		: []

	const records: Record<string, PluginRecord> = {}
	if (isRecord(plugins.records)) {
		for (const [id, value] of Object.entries(plugins.records)) {
			if (!isRecord(value)) continue
			records[id] = {
				id,
				version: asString(value.version, '0.0.0'),
				enabled: asBoolean(value.enabled, false),
				installedAt: asNumber(value.installedAt, Date.now()),
				installedBy: asString(value.installedBy, 'unknown'),
				manifestHash: asString(value.manifestHash, ''),
				settings: isRecord(value.settings) ? value.settings : {},
				lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
			}
		}
	}

	const overrides: Record<string, AppOverride> = {}
	if (isRecord(extras.overrides)) {
		for (const [appId, value] of Object.entries(extras.overrides)) {
			if (!isRecord(value)) continue
			overrides[appId] = {
				composeOverride: asString(value.composeOverride),
				quota: isRecord(value.quota)
					? {
							cpus: typeof value.quota.cpus === 'number' ? value.quota.cpus : undefined,
							memoryMb: typeof value.quota.memoryMb === 'number' ? value.quota.memoryMb : undefined,
							pids: typeof value.quota.pids === 'number' ? value.quota.pids : undefined,
							vramMb: typeof value.quota.vramMb === 'number' ? value.quota.vramMb : undefined,
						}
					: {},
				updatedAt: asNumber(value.updatedAt, Date.now()),
				updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : undefined,
			}
		}
	}

	const config: UmbraConfig = {
		version: CONFIG_VERSION,
		installedAt: asNumber(input.installedAt, defaults.installedAt),
		terminal: {
			enabled: asBoolean(terminal.enabled, defaults.terminal.enabled),
			allowedRoots: stringArray(terminal.allowedRoots, defaults.terminal.allowedRoots),
			defaultTimeoutMs: numberInRange(terminal.defaultTimeoutMs, defaults.terminal.defaultTimeoutMs, 1_000, 600_000),
			maxOutputBytes: numberInRange(terminal.maxOutputBytes, defaults.terminal.maxOutputBytes, 4_096, 1_000_000),
			approvalTimeoutMs: numberInRange(
				terminal.approvalTimeoutMs,
				defaults.terminal.approvalTimeoutMs,
				5_000,
				600_000,
			),
		},
		cloudflare: {
			enabled: asBoolean(cloudflare.enabled, false),
			hostname: isValidHostname(asString(cloudflare.hostname, '').toLowerCase())
				? asString(cloudflare.hostname, '').toLowerCase()
				: '',
			mode: cloudflare.mode === 'credentials' ? 'credentials' : 'token',
			tunnelId: asString(cloudflare.tunnelId, ''),
			targetUrl: /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(asString(cloudflare.targetUrl))
				? asString(cloudflare.targetUrl)
				: defaults.cloudflare.targetUrl,
			tokenSet: asBoolean(cloudflare.tokenSet, false),
			credentialsSet: asBoolean(cloudflare.credentialsSet, false),
			access: {
				enabled: asBoolean(access.enabled, false),
				teamDomain: asString(access.teamDomain, '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
				audience: asString(access.audience, ''),
				allowedEmails: stringArray(access.allowedEmails, []).map((email) => email.toLowerCase()),
				allowedGroups: stringArray(access.allowedGroups, []),
				protectedPrefixes: stringArray(access.protectedPrefixes, defaults.cloudflare.access.protectedPrefixes),
				publicProcedures: stringArray(access.publicProcedures, defaults.cloudflare.access.publicProcedures),
			},
			security: {
				loginRateLimitPerMinute: numberInRange(
					security.loginRateLimitPerMinute,
					defaults.cloudflare.security.loginRateLimitPerMinute,
					1,
					120,
				),
				loginLockoutThreshold: numberInRange(
					security.loginLockoutThreshold,
					defaults.cloudflare.security.loginLockoutThreshold,
					1,
					100,
				),
				loginLockoutMinutes: numberInRange(
					security.loginLockoutMinutes,
					defaults.cloudflare.security.loginLockoutMinutes,
					1,
					1_440,
				),
				hsts: asBoolean(security.hsts, true),
				strictCsp: asBoolean(security.strictCsp, true),
				originLock: asBoolean(security.originLock, true),
				blockDirectIp: asBoolean(security.blockDirectIp, false),
			},
			image: asString(cloudflare.image, defaults.cloudflare.image),
			lockdown: asBoolean(cloudflare.lockdown, false),
			lastStartedAt: typeof cloudflare.lastStartedAt === 'number' ? cloudflare.lastStartedAt : undefined,
			lastError: typeof cloudflare.lastError === 'string' ? cloudflare.lastError : undefined,
		},
		access: {
			defaultPolicy: (['none', 'request', 'manage'] as const).includes(
				accessConfig.defaultPolicy as AppAccessPolicy,
			)
				? (accessConfig.defaultPolicy as AppAccessPolicy)
				: 'request',
			members,
			requests: requests.slice(-500),
		},
		plugins: {
			enabled: asBoolean(plugins.enabled, true),
			records,
		},
		extras: {
			overrides,
			autoUpdate: {
				enabled: asBoolean(autoUpdate.enabled, false),
				apps: autoUpdate.apps === 'all' ? 'all' : stringArray(autoUpdate.apps, []),
				window: {
					days: Array.isArray(window.days)
						? [...new Set(window.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
						: defaults.extras.autoUpdate.window.days,
					start: TIME_PATTERN.test(asString(window.start)) ? asString(window.start) : '03:00',
					end: TIME_PATTERN.test(asString(window.end)) ? asString(window.end) : '05:00',
				},
				onlyCompatible: asBoolean(autoUpdate.onlyCompatible, true),
			},
			snapshots: {
				enabled: asBoolean(snapshots.enabled, true),
				intervalHours: numberInRange(snapshots.intervalHours, 24, 1, 24 * 30),
				retention: numberInRange(snapshots.retention, 14, 1, 365),
				passphraseSet: asBoolean(snapshots.passphraseSet, false),
			},
		},
		ui: {
			showAgentAvatarsOnLockScreen: asBoolean(ui.showAgentAvatarsOnLockScreen, true),
		},
	}
	assertValidConfig(config)
	return config
}

/**
 * Serialised, copy-on-write config store. Mutations run one at a time,
 * persist atomically, and only become visible after the write succeeds.
 */
export default class ConfigStore {
	readonly filePath: string
	#data: UmbraConfig = defaultConfig()
	#loaded = false
	#queue: Promise<unknown> = Promise.resolve()

	constructor(dataDirectory: string) {
		this.filePath = path.join(dataDirectory, 'config.json')
	}

	async load(): Promise<UmbraConfig> {
		if (this.#loaded) return this.snapshot()
		const raw = await readJsonOrNull(this.filePath)
		this.#data = normalizeConfig(raw)
		this.#loaded = true
		return this.snapshot()
	}

	snapshot(): UmbraConfig {
		return structuredClone(this.#data)
	}

	async update<T>(mutator: (draft: UmbraConfig) => T | Promise<T>): Promise<T> {
		const run = async () => {
			await this.load()
			const draft = structuredClone(this.#data)
			const result = await mutator(draft)
			assertValidConfig(draft)
			await writeJsonAtomic(this.filePath, draft, 0o600)
			this.#data = draft
			return result
		}
		const next = this.#queue.then(run, run)
		this.#queue = next.catch(() => {})
		return next
	}
}

