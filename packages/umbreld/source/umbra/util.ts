import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto'

/** Stable JSON: object keys sorted at every depth, used for hashes and idempotency. */
export function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value && typeof value === 'object') {
		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortValue((value as Record<string, unknown>)[key])
		}
		return sorted
	}
	return value
}

export function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

export function hmac(key: Buffer, value: string | Buffer): string {
	return createHmac('sha256', key).update(value).digest('hex')
}

export function randomId(bytes = 16): string {
	return randomBytes(bytes).toString('hex')
}

export function safeEqualHex(first: string, second: string): boolean {
	if (!/^[0-9a-f]+$/i.test(first) || !/^[0-9a-f]+$/i.test(second)) return false
	const a = Buffer.from(first, 'hex')
	const b = Buffer.from(second, 'hex')
	return a.length === b.length && timingSafeEqual(a, b)
}

export function clampString(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value
}

export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const SECRET_KEY_PATTERN =
	/token|secret|password|passphrase|authorization|credential|private[-_]?key|apikey|api[-_]key/i
const BEARER_PATTERN = /\b(Bearer|umbrelmcp_|umbreltoken_)[A-Za-z0-9._~+/=-]{8,}/gi

/**
 * Redact credentials before anything reaches an audit log, an error message, or
 * the UI. Deep and cycle-safe: audit detail is arbitrary agent input.
 */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return '[depth-limit]'
	if (typeof value === 'string') {
		return value.replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix} [redacted]`)
	}
	if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1))
	if (isRecord(value)) {
		const output: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value).slice(0, 200)) {
			output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(entry, depth + 1)
		}
		return output
	}
	return value
}

/** Parse a JSON body defensively: bounded size, no prototype keys. */
export function parseJsonObject(text: string, maxBytes = 1_000_000): Record<string, unknown> {
	if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'Request body is too large')
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new HttpError(400, 'Invalid JSON')
	}
	if (!isRecord(parsed)) throw new HttpError(400, 'Expected a JSON object')
	return parsed
}

export class HttpError extends Error {
	status: number
	code: string
	constructor(status: number, message: string, code = 'error') {
		super(message)
		this.status = status
		this.code = code
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(new Error('Aborted'))
			},
			{once: true},
		)
	})
}
