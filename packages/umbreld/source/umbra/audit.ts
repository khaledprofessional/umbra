import {createHmac, randomBytes} from 'node:crypto'
import {appendFile, chmod, mkdir, open, readFile, readdir, stat, unlink} from 'node:fs/promises'
import path from 'node:path'

import {pathExists} from './fs-util.js'
import {isRecord, randomId, redact, sha256, stableJson} from './util.js'

export type AuditActorType = 'agent' | 'user' | 'system'
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending'

export type AuditActor = {
	type: AuditActorType
	id: string
	name?: string
	ip?: string
}

export type AuditEventType =
	| 'system.start'
	| 'system.stop'
	| 'mcp.connect'
	| 'mcp.request'
	| 'mcp.tool'
	| 'terminal.request'
	| 'terminal.approved'
	| 'terminal.denied'
	| 'terminal.executed'
	| 'agent.avatar'
	| 'agent.policy'
	| 'plugin.install'
	| 'plugin.enable'
	| 'plugin.disable'
	| 'plugin.uninstall'
	| 'plugin.invoke'
	| 'plugin.error'
	| 'access.policy'
	| 'access.request'
	| 'access.approve'
	| 'access.deny'
	| 'cloudflare.enable'
	| 'cloudflare.disable'
	| 'cloudflare.config'
	| 'cloudflare.lockdown'
	| 'snapshot.create'
	| 'snapshot.restore'
	| 'override.update'
	| 'update.preflight'
	| 'auth.denied'
	| 'security.block'

export type AuditInput = {
	type: AuditEventType
	action: string
	actor: AuditActor
	target?: string
	outcome?: AuditOutcome
	/** Real client IP, when the actor has no IP of its own. */
	ip?: string
	detail?: unknown
}

export type AuditEntry = {
	v: 1
	seq: number
	id: string
	ts: number
	type: AuditEventType
	action: string
	actor: AuditActor
	target?: string
	outcome: AuditOutcome
	/** The real client IP after Cloudflare `CF-Connecting-IP` restoration. */
	ip?: string
	detail?: unknown
	prev: string
	hash: string
}

const GENESIS = '0'.repeat(64)
const MAX_DETAIL_BYTES = 16 * 1024

function dateKey(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10)
}

function clipDetail(detail: unknown): unknown {
	if (detail === undefined) return undefined
	const redacted = redact(detail)
	const serialised = JSON.stringify(redacted)
	if (Buffer.byteLength(serialised) <= MAX_DETAIL_BYTES) return redacted
	return {truncated: true, preview: serialised.slice(0, MAX_DETAIL_BYTES)}
}

/**
 * Append-only, tamper-evident audit log.
 *
 * Each line is chained with an HMAC keyed by a device-local secret, so editing
 * or deleting a historical entry is detectable even though the log is plain
 * JSONL (grep-able, exportable, and safe to back up). Files rotate daily and
 * are written with 0600.
 */
export default class AuditLog {
	readonly directory: string
	readonly keyPath: string
	#key?: Buffer
	#seq = 0
	#lastHash = GENESIS
	#appendQueue: Promise<unknown> = Promise.resolve()
	#ready?: Promise<void>

	constructor(dataDirectory: string) {
		this.directory = path.join(dataDirectory, 'audit')
		this.keyPath = path.join(dataDirectory, 'secrets', 'audit.key')
	}

	async start(): Promise<void> {
		await mkdir(this.directory, {recursive: true, mode: 0o700})
		await mkdir(path.dirname(this.keyPath), {recursive: true, mode: 0o700})
		if (!(await pathExists(this.keyPath))) {
			await appendFile(this.keyPath, randomBytes(32).toString('base64'), {mode: 0o600})
			await chmod(this.keyPath, 0o600)
		}
		this.#key = Buffer.from((await readFile(this.keyPath, 'utf8')).trim(), 'base64')
		if (this.#key.length < 32) throw new Error('Audit key is invalid')
		await this.#restoreChainState()
	}

	async #restoreChainState() {
		const files = await this.#files()
		for (let index = files.length - 1; index >= 0; index--) {
			const lines = await this.#readLines(files[index])
			for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
				const entry = this.#parse(lines[lineIndex])
				if (!entry) continue
				this.#seq = entry.seq
				this.#lastHash = entry.hash
				return
			}
		}
	}

	async #files(): Promise<string[]> {
		try {
			const names = await readdir(this.directory)
			return names
				.filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
				.sort()
				.map((name) => path.join(this.directory, name))
		} catch {
			return []
		}
	}

	async #readLines(filePath: string): Promise<string[]> {
		try {
			const text = await readFile(filePath, 'utf8')
			return text.split('\n').filter(Boolean)
		} catch {
			return []
		}
	}

	#parse(line: string): AuditEntry | null {
		try {
			const parsed: unknown = JSON.parse(line)
			return isRecord(parsed) && typeof parsed.hash === 'string' && typeof parsed.seq === 'number'
				? (parsed as AuditEntry)
				: null
		} catch {
			return null
		}
	}

	#hash(entry: Omit<AuditEntry, 'hash'>): string {
		if (!this.#key) throw new Error('Audit log is not started')
		return createHmac('sha256', this.#key).update(stableJson(entry)).digest('hex')
	}

	record(input: AuditInput): AuditEntry {
		const ts = Date.now()
		const unsigned: Omit<AuditEntry, 'hash'> = {
			v: 1,
			seq: this.#seq + 1,
			id: randomId(8),
			ts,
			type: input.type,
			action: input.action.slice(0, 200),
			actor: {
				...input.actor,
				...(input.actor.name ? {name: input.actor.name.slice(0, 100)} : {}),
			},
			...(input.target ? {target: input.target.slice(0, 300)} : {}),
			outcome: input.outcome ?? 'success',
			...((input.ip ?? input.actor.ip) ? {ip: input.ip ?? input.actor.ip} : {}),
			...(input.detail === undefined ? {} : {detail: clipDetail(input.detail)}),
			prev: this.#lastHash,
		}
		const entry: AuditEntry = {...unsigned, hash: this.#hash(unsigned)}
		this.#seq = entry.seq
		this.#lastHash = entry.hash

		const line = `${JSON.stringify(entry)}\n`
		this.#appendQueue = this.#appendQueue.then(async () => {
			await mkdir(this.directory, {recursive: true, mode: 0o700})
			await appendFile(path.join(this.directory, `audit-${dateKey(ts)}.jsonl`), line, {mode: 0o600})
		})
		return entry
	}

	async flush(): Promise<void> {
		await this.#appendQueue
	}

	async query(options: {
		limit?: number
		before?: number
		type?: string
		actorId?: string
		outcome?: string
		search?: string
	} = {}): Promise<{events: AuditEntry[]; nextCursor: number | null; scanned: number}> {
		await this.flush()
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
		const files = (await this.#files()).reverse()
		const events: AuditEntry[] = []
		let scanned = 0

		for (const file of files) {
			const lines = await this.#readLines(file)
			for (let index = lines.length - 1; index >= 0; index--) {
				if (events.length >= limit + 1) break
				const entry = this.#parse(lines[index])
				if (!entry) continue
				scanned++
				if (options.before !== undefined && entry.seq >= options.before) continue
				if (options.type && entry.type !== options.type) continue
				if (options.actorId && entry.actor.id !== options.actorId) continue
				if (options.outcome && entry.outcome !== options.outcome) continue
				if (options.search) {
					const needle = options.search.toLowerCase()
					const haystack = `${entry.action} ${entry.target ?? ''} ${JSON.stringify(entry.detail ?? '')}`.toLowerCase()
					if (!haystack.includes(needle)) continue
				}
				events.push(entry)
			}
			if (events.length > limit) break
		}

		const page = events.slice(0, limit)
		return {
			events: page,
			nextCursor: events.length > limit ? (page.at(-1)?.seq ?? null) : null,
			scanned,
		}
	}

	async verify(): Promise<{ok: boolean; entries: number; brokenAt?: number; error?: string}> {
		await this.flush()
		const files = await this.#files()
		let previous = GENESIS
		let expectedSeq = 1
		let entries = 0
		for (const file of files) {
			const lines = await this.#readLines(file)
			for (const line of lines) {
				const entry = this.#parse(line)
				if (!entry) return {ok: false, entries, error: 'Unparseable audit entry'}
				if (entry.prev !== previous) return {ok: false, entries, brokenAt: entry.seq, error: 'Hash chain is broken'}
				if (entry.seq !== expectedSeq) return {ok: false, entries, brokenAt: entry.seq, error: 'Sequence gap'}
				const {hash: _hash, ...unsigned} = entry
				const computed = this.#hash(unsigned)
				if (computed !== entry.hash) return {ok: false, entries, brokenAt: entry.seq, error: 'Entry was modified'}
				previous = entry.hash
				expectedSeq++
				entries++
			}
		}
		return {ok: true, entries}
	}

	async exportRange(from: number, to: number): Promise<AuditEntry[]> {
		await this.flush()
		const output: AuditEntry[] = []
		for (const file of await this.#files()) {
			for (const line of await this.#readLines(file)) {
				const entry = this.#parse(line)
				if (entry && entry.seq >= from && entry.seq <= to) output.push(entry)
			}
		}
		return output
	}

	/** Drop audit files older than `retentionDays`. The active file is never removed. */
	async prune(retentionDays: number): Promise<number> {
		const cutoff = Date.now() - retentionDays * 86_400_000
		let removed = 0
		for (const file of await this.#files()) {
			try {
				const stats = await stat(file)
				if (stats.mtimeMs < cutoff) {
					await unlink(file)
					removed++
				}
			} catch {
				// Already gone or unreadable: nothing to do.
			}
		}
		return removed
	}

	/** Integrity fingerprint for the whole log, shown in the UI. */
	async fingerprint(): Promise<string> {
		await this.flush()
		const hashes: string[] = []
		for (const file of await this.#files()) {
			hashes.push(sha256(await readFile(file)))
		}
		return sha256(hashes.join(':'))
	}
}

/** Open a private audit file handle for streaming exports without buffering. */
export async function openAuditFile(filePath: string) {
	return open(filePath, 'r')
}
