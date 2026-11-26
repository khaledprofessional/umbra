import {createPublicKey, verify as verifySignature} from 'node:crypto'
import https from 'node:https'

export type AccessClaims = {
	aud: string | string[]
	iss: string
	exp: number
	iat?: number
	nbf?: number
	email?: string
	sub?: string
	groups?: string[]
	[key: string]: unknown
}

export type JwtVerifyResult = {
	email: string
	subject: string
	claims: AccessClaims
}

export class AccessJwtError extends Error {
	code: string
	constructor(code: string, message: string) {
		super(message)
		this.code = code
	}
}

type Jwk = {kid?: string; kty: string; alg?: string; use?: string; n?: string; e?: string}

const JWKS_TTL_MS = 10 * 60_000
const JWKS_MAX_BYTES = 256 * 1024
const CLOCK_SKEW_SECONDS = 60

function base64UrlDecode(value: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AccessJwtError('malformed', 'Malformed JWT segment')
	return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function decodeJson<T>(value: string): T {
	try {
		return JSON.parse(base64UrlDecode(value).toString('utf8')) as T
	} catch {
		throw new AccessJwtError('malformed', 'Malformed JWT payload')
	}
}

function fetchJson(url: string, timeoutMs = 5_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{
				headers: {'user-agent': 'umbrelOS-Umbra/1.0', accept: 'application/json'},
				timeout: timeoutMs,
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.resume()
					reject(new AccessJwtError('jwks-unavailable', `JWKS returned HTTP ${response.statusCode}`))
					return
				}
				const chunks: Buffer[] = []
				let total = 0
				response.on('data', (chunk: Buffer) => {
					total += chunk.length
					if (total > JWKS_MAX_BYTES) {
						request.destroy()
						reject(new AccessJwtError('jwks-unavailable', 'JWKS response is too large'))
						return
					}
					chunks.push(chunk)
				})
				response.on('end', () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
					} catch {
						reject(new AccessJwtError('jwks-unavailable', 'JWKS is not valid JSON'))
					}
				})
			},
		)
		request.on('timeout', () => request.destroy(new AccessJwtError('jwks-unavailable', 'JWKS request timed out')))
		request.on('error', (error) => reject(error))
	})
}

/**
 * Verifies Cloudflare Access application tokens.
 *
 * Cloudflare signs `Cf-Access-Jwt-Assertion` with RS256. We verify against the
 * team's JWKS, check audience/issuer/lifetime, then enforce the owner's email
 * or group policy. Keys are cached; an unknown kid forces one refresh so key
 * rotation does not require a restart.
 */
export default class AccessJwtVerifier {
	#keys = new Map<string, {key: ReturnType<typeof createPublicKey>; fetchedAt: number}>()
	#lastFetch = 0
	#fetching?: Promise<void>
	#fetchJwks: (teamDomain: string) => Promise<unknown>

	constructor(options: {fetchJwks?: (teamDomain: string) => Promise<unknown>} = {}) {
		this.#fetchJwks = options.fetchJwks ?? ((teamDomain) => fetchJson(`https://${teamDomain}/cdn-cgi/access/certs`))
	}

	async #refresh(teamDomain: string): Promise<void> {
		if (this.#fetching) return this.#fetching
		this.#fetching = (async () => {
			const payload = (await this.#fetchJwks(teamDomain)) as {
				keys?: Jwk[]
			}
			if (!Array.isArray(payload.keys)) throw new AccessJwtError('jwks-unavailable', 'JWKS has no keys')
			const next = new Map<string, {key: ReturnType<typeof createPublicKey>; fetchedAt: number}>()
			for (const jwk of payload.keys) {
				if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue
				try {
					next.set(jwk.kid, {
						key: createPublicKey({key: jwk as never, format: 'jwk'}),
						fetchedAt: Date.now(),
					})
				} catch {
					// Skip a key Node cannot parse rather than failing the whole set.
				}
			}
			if (!next.size) throw new AccessJwtError('jwks-unavailable', 'JWKS has no usable RSA keys')
			this.#keys = next
			this.#lastFetch = Date.now()
		})()
		try {
			await this.#fetching
		} finally {
			this.#fetching = undefined
		}
	}

	async #keyFor(teamDomain: string, kid: string) {
		const cached = this.#keys.get(kid)
		if (cached && Date.now() - this.#lastFetch < JWKS_TTL_MS) return cached.key
		await this.#refresh(teamDomain)
		const refreshed = this.#keys.get(kid)
		if (!refreshed) throw new AccessJwtError('unknown-key', 'Access token was signed by an unknown key')
		return refreshed.key
	}

	async verify(
		token: string,
		policy: {teamDomain: string; audience: string; allowedEmails: string[]; allowedGroups: string[]},
	): Promise<JwtVerifyResult> {
		if (!token || token.length > 16 * 1024) throw new AccessJwtError('malformed', 'Missing or oversized token')
		if (!policy.teamDomain || !policy.audience) {
			throw new AccessJwtError('misconfigured', 'Cloudflare Access is not fully configured')
		}
		const segments = token.split('.')
		if (segments.length !== 3) throw new AccessJwtError('malformed', 'Malformed Access token')
		const header = decodeJson<{alg?: string; kid?: string; typ?: string}>(segments[0])
		if (header.alg !== 'RS256') throw new AccessJwtError('algorithm', 'Unsupported token algorithm')
		if (!header.kid) throw new AccessJwtError('malformed', 'Token has no key id')

		const key = await this.#keyFor(policy.teamDomain, header.kid)
		const valid = verifySignature(
			'RSA-SHA256',
			Buffer.from(`${segments[0]}.${segments[1]}`),
			key,
			base64UrlDecode(segments[2]),
		)
		if (!valid) throw new AccessJwtError('signature', 'Invalid token signature')

		const claims = decodeJson<AccessClaims>(segments[1])
		const now = Math.floor(Date.now() / 1000)
		if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
			throw new AccessJwtError('expired', 'Access token has expired')
		}
		if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
			throw new AccessJwtError('not-yet-valid', 'Access token is not valid yet')
		}
		const expectedIssuer = `https://${policy.teamDomain}`
		if (claims.iss !== expectedIssuer) throw new AccessJwtError('issuer', 'Access token issuer mismatch')
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
		if (!audiences.includes(policy.audience)) throw new AccessJwtError('audience', 'Access token audience mismatch')

		const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
		if (policy.allowedEmails.length > 0 && !policy.allowedEmails.includes(email)) {
			throw new AccessJwtError('policy', 'Account is not allowed by the Access policy')
		}
		if (policy.allowedGroups.length > 0) {
			const groups = Array.isArray(claims.groups)
				? claims.groups
				: Array.isArray((claims.custom as {groups?: unknown})?.groups)
					? ((claims.custom as {groups: string[]}).groups ?? [])
					: []
			const allowed = groups.some((group) => policy.allowedGroups.includes(group))
			if (!allowed) throw new AccessJwtError('policy', 'Account is not in an allowed group')
		}
		if (!email && !claims.sub) throw new AccessJwtError('policy', 'Access token has no identity')
		return {email, subject: String(claims.sub ?? email), claims}
	}
}
