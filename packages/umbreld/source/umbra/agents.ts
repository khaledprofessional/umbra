import path from 'node:path'

import AuditLog from './audit.js'
import type ConfigStore from './config.js'
import {ensureDir, pathExists, readJsonOrNull, removeIfExists, writeJsonAtomic, writeFileAtomic} from './fs-util.js'
import type {SanitizedImage} from './image.js'
import type SecretStore from './secrets.js'

export type AgentTerminalMode = 'inherit' | 'deny' | 'ask' | 'always'

export type AgentAvatar = {
	file: string
	mime: string
	extension: string
	width: number
	height: number
	sha256: string
	updatedAt: number
}

export type AgentProfile = {
	tokenId: string
	label: string
	agentType?: string
	clientName?: string
	clientVersion?: string
	firstSeenAt: number
	lastSeenAt: number
	lastIp?: string
	terminal: {
		mode: AgentTerminalMode
		allowlist: string[]
	}
	avatar?: AgentAvatar
}

type AgentFile = {
	version: 1
	agents: Record<string, AgentProfile>
}

const EMPTY: AgentFile = {version: 1, agents: {}}
const TOKEN_ID = /^[0-9a-f]{32}$/

/**
 * Persistent identity for every MCP credential Umbra has seen.
 *
 * Tokens live in umbreld's MCP settings; Umbra keeps the profile (display
 * name, avatar, terminal policy, last seen) separately. Revoking a token does
 * not erase its audit history, so the profile remains for attribution.
 */
export default class AgentRegistry {
	readonly directory: string
	readonly avatarsDirectory: string
	readonly filePath: string
	#data: AgentFile = structuredClone(EMPTY)
	#loaded = false
	#queue: Promise<unknown> = Promise.resolve()
	#audit: AuditLog
	#secrets: SecretStore

	constructor(dataDirectory: string, audit: AuditLog, secrets: SecretStore) {
		this.directory = path.join(dataDirectory, 'agents')
		this.avatarsDirectory = path.join(this.directory, 'avatars')
		this.filePath = path.join(this.directory, 'agents.json')
		this.#audit = audit
		this.#secrets = secrets
	}

	async start(): Promise<void> {
		await ensureDir(this.avatarsDirectory, 0o700)
		const raw = await readJsonOrNull(this.filePath)
		if (raw && raw.version === 1 && raw.agents && typeof raw.agents === 'object') {
			for (const [tokenId, value] of Object.entries(raw.agents as Record<string, unknown>)) {
				if (!TOKEN_ID.test(tokenId) || !value || typeof value !== 'object') continue
				const profile = value as Record<string, unknown>
				if (typeof profile.label !== 'string') continue
				const terminal = (profile.terminal ?? {}) as Record<string, unknown>
				const mode = ['inherit', 'deny', 'ask', 'always'].includes(String(terminal.mode))
					? (terminal.mode as AgentTerminalMode)
					: 'inherit'
				this.#data.agents[tokenId] = {
					tokenId,
					label: profile.label.slice(0, 80),
					agentType: typeof profile.agentType === 'string' ? profile.agentType.slice(0, 80) : undefined,
					clientName: typeof profile.clientName === 'string' ? profile.clientName.slice(0, 80) : undefined,
					clientVersion: typeof profile.clientVersion === 'string' ? profile.clientVersion.slice(0, 80) : undefined,
					firstSeenAt: typeof profile.firstSeenAt === 'number' ? profile.firstSeenAt : Date.now(),
					lastSeenAt: typeof profile.lastSeenAt === 'number' ? profile.lastSeenAt : 0,
					lastIp: typeof profile.lastIp === 'string' ? profile.lastIp : undefined,
					terminal: {
						mode,
						allowlist: Array.isArray(terminal.allowlist)
							? terminal.allowlist.filter((entry): entry is string => typeof entry === 'string').slice(0, 100)
							: [],
					},
					avatar: this.#parseAvatar(profile.avatar),
				}
			}
		}
		this.#loaded = true
	}

	#parseAvatar(value: unknown): AgentAvatar | undefined {
		if (!value || typeof value !== 'object') return undefined
		const avatar = value as Record<string, unknown>
		if (
			typeof avatar.file !== 'string' ||
			!/^[0-9a-f]{32}\.(png|jpg|webp)$/.test(avatar.file) ||
			typeof avatar.sha256 !== 'string'
		) {
			return undefined
		}
		return {
			file: avatar.file,
			mime: typeof avatar.mime === 'string' ? avatar.mime : 'image/png',
			extension: typeof avatar.extension === 'string' ? avatar.extension : 'png',
			width: typeof avatar.width === 'number' ? avatar.width : 0,
			height: typeof avatar.height === 'number' ? avatar.height : 0,
			sha256: avatar.sha256,
			updatedAt: typeof avatar.updatedAt === 'number' ? avatar.updatedAt : Date.now(),
		}
	}

	async #persist(draft: AgentFile): Promise<void> {
		await writeJsonAtomic(this.filePath, draft, 0o600)
		this.#data = draft
	}

	#mutate<T>(mutator: (draft: AgentFile) => T | Promise<T>): Promise<T> {
		const run = async () => {
			await this.#ensureLoaded()
			const draft = structuredClone(this.#data)
			const result = await mutator(draft)
			await this.#persist(draft)
			return result
		}
		const next = this.#queue.then(run, run)
		this.#queue = next.catch(() => {})
		return next
	}

	async #ensureLoaded() {
		if (!this.#loaded) await this.start()
	}

	getProfile(tokenId: string): AgentProfile | undefined {
		const profile = this.#data.agents[tokenId]
		return profile ? structuredClone(profile) : undefined
	}

	list(): AgentProfile[] {
		return Object.values(this.#data.agents)
			.map((profile) => structuredClone(profile))
			.sort((first, second) => second.lastSeenAt - first.lastSeenAt)
	}

	/**
	 * Upsert on every MCP request. The label comes from the token metadata,
	 * while clientName/version are self-declared by the agent and only ever
	 * used for display and audit attribution.
	 */
	async observe(input: {
		tokenId: string
		label: string
		agentType?: string
		clientName?: string
		clientVersion?: string
		ip?: string
	}): Promise<AgentProfile> {
		if (!TOKEN_ID.test(input.tokenId)) throw new Error('Invalid agent token id')
		return this.#mutate((draft) => {
			const now = Date.now()
			const existing = draft.agents[input.tokenId]
			const profile: AgentProfile = {
				tokenId: input.tokenId,
				label: (input.label || existing?.label || 'AI agent').slice(0, 80),
				agentType: input.agentType?.slice(0, 80) ?? existing?.agentType,
				clientName: input.clientName?.slice(0, 80) ?? existing?.clientName,
				clientVersion: input.clientVersion?.slice(0, 80) ?? existing?.clientVersion,
				firstSeenAt: existing?.firstSeenAt ?? now,
				lastSeenAt: now,
				lastIp: input.ip ?? existing?.lastIp,
				terminal: existing?.terminal ?? {mode: 'inherit', allowlist: []},
				avatar: existing?.avatar,
			}
			draft.agents[input.tokenId] = profile
			return structuredClone(profile)
		})
	}

	async ensureProfile(tokenId: string, label: string, agentType?: string): Promise<AgentProfile> {
		if (!TOKEN_ID.test(tokenId)) throw new Error('Invalid agent token id')
		await this.#ensureLoaded()
		if (this.#data.agents[tokenId]) return structuredClone(this.#data.agents[tokenId])
		return this.#mutate((draft) => {
			const profile: AgentProfile = {
				tokenId,
				label: label.slice(0, 80),
				...(agentType ? {agentType: agentType.slice(0, 80)} : {}),
				firstSeenAt: 0,
				lastSeenAt: 0,
				terminal: {mode: 'inherit', allowlist: []},
			}
			draft.agents[tokenId] = profile
			return structuredClone(profile)
		})
	}

	async setTerminalPolicy(
		tokenId: string,
		policy: {mode: AgentTerminalMode; allowlist?: string[]},
		actor: {id: string; name?: string; ip?: string},
	): Promise<AgentProfile> {
		if (!['inherit', 'deny', 'ask', 'always'].includes(policy.mode)) throw new Error('Invalid terminal mode')
		const allowlist = (policy.allowlist ?? [])
			.map((entry) => entry.trim())
			.filter(Boolean)
			.slice(0, 100)
		const profile = await this.#mutate((draft) => {
			const existing = draft.agents[tokenId]
			if (!existing) throw new Error('Agent not found')
			existing.terminal = {mode: policy.mode, allowlist}
			return structuredClone(existing)
		})
		this.#audit.record({
			type: 'agent.policy',
			action: `Set terminal policy to '${policy.mode}'`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: profile.label,
			detail: {tokenId, allowlist},
		})
		return profile
	}

	async setAvatar(
		tokenId: string,
		image: SanitizedImage,
		actor: {type: 'agent' | 'user'; id: string; name?: string; ip?: string},
	): Promise<AgentAvatar> {
		await this.#ensureLoaded()
		const profile = this.#data.agents[tokenId]
		if (!profile) throw new Error('Agent not found')
		const file = `${tokenId}.${image.extension}`
		await writeFileAtomic(path.join(this.avatarsDirectory, file), image.data, 0o600)
		if (profile.avatar && profile.avatar.file !== file) {
			await removeIfExists(path.join(this.avatarsDirectory, profile.avatar.file))
		}
		const avatar: AgentAvatar = {
			file,
			mime: image.mime,
			extension: image.extension,
			width: image.width,
			height: image.height,
			sha256: image.sha256,
			updatedAt: Date.now(),
		}
		await this.#mutate((draft) => {
			draft.agents[tokenId].avatar = avatar
		})
		this.#audit.record({
			type: 'agent.avatar',
			action: 'Updated agent avatar',
			actor: {...actor, ip: profile.lastIp},
			target: profile.label,
			detail: {tokenId, sha256: image.sha256, mime: image.mime, width: image.width, height: image.height},
		})
		return avatar
	}

	async removeAvatar(tokenId: string, actor: {id: string; name?: string}): Promise<void> {
		const profile = this.#data.agents[tokenId]
		if (!profile?.avatar) return
		await removeIfExists(path.join(this.avatarsDirectory, profile.avatar.file))
		await this.#mutate((draft) => {
			delete draft.agents[tokenId].avatar
		})
		this.#audit.record({
			type: 'agent.avatar',
			action: 'Removed agent avatar',
			actor: {type: 'user', id: actor.id, name: actor.name},
			target: profile.label,
		})
	}

	async avatarPath(tokenId: string): Promise<string | null> {
		const profile = this.#data.agents[tokenId]
		if (!profile?.avatar) return null
		const filePath = path.join(this.avatarsDirectory, profile.avatar.file)
		return (await pathExists(filePath)) ? filePath : null
	}

	/** Remove avatar files that no profile references (e.g. from a failed write). */
	async pruneOrphanAvatars(): Promise<void> {
		const fs = await import('node:fs/promises')
		const known = new Set(
			Object.values(this.#data.agents).flatMap((profile) => (profile.avatar ? [profile.avatar.file] : [])),
		)
		for (const name of await fs.readdir(this.avatarsDirectory).catch(() => [])) {
			if (!known.has(name)) await removeIfExists(path.join(this.avatarsDirectory, name))
		}
	}
}
