import type AuditLog from './audit.js'
import type CloudflareManager from './cloudflare.js'
import AccessJwtVerifier, {AccessJwtError} from './cloudflare-jwt.js'
import type ConfigStore from './config.js'
import type {HttpRequest, HttpResponse, Middleware, NextFunction, RequestContext} from './types.js'
import {randomId} from './util.js'

type FailureBucket = {failures: number; firstFailureAt: number; lockedUntil: number}
type RateBucket = {tokens: number; updatedAt: number}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
// Owner-only or security-sensitive tRPC procedures. Everything else remains
// reachable through the public portal because umbreld still enforces the
// account role; blocking all of /trpc would lock members out of their apps.
const SENSITIVE_TRPC = [
	'system.',
	'mcp.',
	'backup.',
	'backups.',
	'hardware.',
	'machines.',
	'apps.install',
	'apps.uninstall',
	'apps.update',
	'apps.start',
	'apps.stop',
	'apps.restart',
	'apps.addRepository',
	'apps.removeRepository',
	'apps.installReview',
	'user.createUser',
	'user.deleteUser',
	'user.resetUserPassword',
]

function normalizeIp(value: string | undefined): string | undefined {
	if (!value) return undefined
	const trimmed = value.split(',')[0].trim()
	if (IPV4.test(trimmed)) {
		const parts = trimmed.split('.').map(Number)
		if (parts.every((part) => part >= 0 && part <= 255)) return trimmed
	}
	if (trimmed.includes(':') && /^[0-9a-f:]+$/i.test(trimmed)) return trimmed
	return undefined
}

function header(request: HttpRequest, name: string): string | undefined {
	const value = request.headers[name] ?? request.headers[name.toLowerCase()]
	return Array.isArray(value) ? value[0] : value
}

function cookie(request: HttpRequest, name: string): string | undefined {
	const raw = header(request, 'cookie')
	if (!raw) return undefined
	for (const part of raw.split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key === name) return decodeURIComponent(rest.join('='))
	}
	return undefined
}

function isMutation(method: string | undefined): boolean {
	return ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method ?? 'GET').toUpperCase())
}

/**
 * Public-edge policy for the single configured Cloudflare hostname.
 *
 * This middleware runs before every umbreld route. It restores the real client
 * IP, refuses traffic during lockdown, verifies Cloudflare Access JWTs on
 * privileged paths, locks mutation origins to the configured hostname, applies
 * HSTS/CSP, and rate-limits credential endpoints.
 */
export default class EdgeGuard {
	#config: ConfigStore
	#cloudflare: CloudflareManager
	#audit: AuditLog
	#verifier = new AccessJwtVerifier()
	#failures = new Map<string, FailureBucket>()
	#buckets = new Map<string, RateBucket>()

	constructor(config: ConfigStore, cloudflare: CloudflareManager, audit: AuditLog) {
		this.#config = config
		this.#cloudflare = cloudflare
		this.#audit = audit
	}

	/** Public middleware. Kept bound so Express can mount it directly. */
	middleware = (request: HttpRequest, response: HttpResponse, next: NextFunction): void => {
		void this.handle(request, response, next).catch((error) => {
			try {
				response.statusCode = 500
				response.end('Internal edge error')
			} catch {
				// Response already gone.
			}
			this.#audit.record({
				type: 'security.block',
				action: 'Edge guard failed',
				actor: {type: 'system', id: 'edge'},
				outcome: 'failure',
				detail: {message: error instanceof Error ? error.message : String(error)},
			})
		})
	}

	async handle(request: HttpRequest, response: HttpResponse, next: NextFunction): Promise<void> {
		const config = await this.#config.load()
		const cloudflare = config.cloudflare
		const originalHost = (header(request, 'x-forwarded-host') ?? header(request, 'host') ?? '')
			.split(':')[0]
			.toLowerCase()
		const publicRequest = Boolean(cloudflare.hostname) && originalHost === cloudflare.hostname
		const realIp = this.#realIp(request, publicRequest && cloudflare.enabled)

		request.umbra = {
			realIp,
			viaCloudflare: this.#cameThroughCloudflare(request),
			publicRequest,
			startedAt: Date.now(),
		} satisfies RequestContext

		this.#applyHeaders(response, request, publicRequest, config.cloudflare.security)

		if (publicRequest && cloudflare.lockdown) {
			this.#audit.record({
				type: 'security.block',
				action: 'Request refused during emergency lockdown',
				actor: {type: 'system', id: 'edge'},
				...(request.url ? {target: request.url.slice(0, 300)} : {}),
				ip: realIp,
				outcome: 'denied',
			})
			this.#deny(response, 503, 'Exposure is disabled by emergency lockdown')
			return
		}

		if (publicRequest && cloudflare.security.blockDirectIp && !this.#cameThroughCloudflare(request)) {
			this.#deny(response, 403, 'Direct origin access is not permitted')
			return
		}

		const path = (request.path ?? request.url ?? '/').split('?')[0]
		if (publicRequest && this.#isCredentialEndpoint(path) && isMutation(request.method)) {
			const limit = this.#consumeRate(realIp, config.cloudflare.security.loginRateLimitPerMinute)
			if (!limit) {
				this.#audit.record({
					type: 'security.block',
					action: 'Login rate limit exceeded',
					actor: {type: 'system', id: 'edge'},
					ip: realIp,
					target: path,
					outcome: 'denied',
				})
				response.setHeader('Retry-After', '60')
				this.#deny(response, 429, 'Too many requests')
				return
			}
			const lock = this.#failureBucket(realIp)
			if (lock.lockedUntil > Date.now()) {
				response.setHeader('Retry-After', String(Math.ceil((lock.lockedUntil - Date.now()) / 1000)))
				this.#deny(response, 429, 'Too many failed sign-in attempts')
				return
			}
			// Count failures without blocking the response.
			response.on?.('finish', () => {
				const status = response.statusCode
				if (status === 401 || status === 403) this.#recordFailure(realIp, config.cloudflare.security)
			})
		}

		if (publicRequest && (path.startsWith('/umbra/api/') || path.startsWith('/trpc/'))) {
			if (!this.#consumeRate(`${realIp}:api`, 300)) {
				this.#audit.record({
					type: 'security.block',
					action: 'API rate limit exceeded',
					actor: {type: 'system', id: 'edge'},
					ip: realIp,
					target: path,
					outcome: 'denied',
				})
				response.setHeader('Retry-After', '60')
				this.#deny(response, 429, 'Too many requests')
				return
			}
		}

		if (
			publicRequest &&
			cloudflare.access.enabled &&
			this.#isProtected(path, config.cloudflare.access.publicProcedures)
		) {
			const token =
				header(request, 'cf-access-jwt-assertion') ??
				cookie(request, 'CF_Authorization') ??
				header(request, 'cf-authorization')
			if (!token) {
				this.#audit.record({
					type: 'auth.denied',
					action: 'Cloudflare Access token missing',
					actor: {type: 'system', id: 'edge'},
					ip: realIp,
					target: path,
					outcome: 'denied',
				})
				this.#deny(response, 403, 'Cloudflare Access authentication required')
				return
			}
			try {
				await this.#verifier.verify(token, cloudflare.access)
			} catch (error) {
				const code = error instanceof AccessJwtError ? error.code : 'invalid'
				this.#audit.record({
					type: 'auth.denied',
					action: 'Cloudflare Access token rejected',
					actor: {type: 'system', id: 'edge'},
					ip: realIp,
					target: path,
					outcome: 'denied',
					detail: {code, message: error instanceof Error ? error.message : String(error)},
				})
				this.#deny(response, 403, 'Cloudflare Access authentication required')
				return
			}
		}

		if (
			publicRequest &&
			cloudflare.security.originLock &&
			isMutation(request.method) &&
			!path.startsWith('/mcp') &&
			!path.startsWith('/app-auth')
		) {
			const origin = header(request, 'origin')
			const expected = `https://${cloudflare.hostname}`
			if (origin !== expected) {
				this.#audit.record({
					type: 'security.block',
					action: 'Cross-origin mutation blocked',
					actor: {type: 'system', id: 'edge'},
					ip: realIp,
					target: path,
					outcome: 'denied',
					detail: {origin: origin ?? null, expected},
				})
				this.#deny(response, 403, 'Request origin is not allowed')
				return
			}
		}

		next()
	}

	/** WebSocket upgrades bypass Express middleware, so callers use this too. */
	async authorizeUpgrade(request: HttpRequest): Promise<{ok: true} | {ok: false; status: number; message: string}> {
		const config = await this.#config.load()
		const cloudflare = config.cloudflare
		const host = (header(request, 'x-forwarded-host') ?? header(request, 'host') ?? '').split(':')[0].toLowerCase()
		const publicRequest = Boolean(cloudflare.hostname) && host === cloudflare.hostname
		if (!publicRequest) return {ok: true}
		if (cloudflare.lockdown) return {ok: false, status: 503, message: 'Emergency lockdown'}
		if (!cloudflare.access.enabled) return {ok: true}
		const path = (request.url ?? '/').split('?')[0]
		if (!this.#isProtected(path, cloudflare.access.publicProcedures)) return {ok: true}
		const token = header(request, 'cf-access-jwt-assertion') ?? cookie(request, 'CF_Authorization')
		if (!token) return {ok: false, status: 403, message: 'Cloudflare Access authentication required'}
		try {
			await this.#verifier.verify(token, cloudflare.access)
			return {ok: true}
		} catch {
			return {ok: false, status: 403, message: 'Cloudflare Access authentication required'}
		}
	}

	#realIp(request: HttpRequest, trustCloudflare: boolean): string {
		const socketIp = normalizeIp(request.socket?.remoteAddress?.replace(/^::ffff:/, '')) ?? '0.0.0.0'
		if (LOOPBACK.has(request.socket?.remoteAddress ?? '') || LOOPBACK.has(socketIp)) {
			if (trustCloudflare) {
				const cfIp = normalizeIp(header(request, 'cf-connecting-ip'))
				if (cfIp && this.#cameThroughCloudflare(request)) return cfIp
			}
			const forwarded = normalizeIp(header(request, 'x-forwarded-for'))
			if (forwarded) return forwarded
		}
		return normalizeIp(request.ip) ?? socketIp
	}

	#cameThroughCloudflare(request: HttpRequest): boolean {
		return Boolean(header(request, 'cf-ray') || header(request, 'cf-visitor'))
	}

	#isCredentialEndpoint(path: string): boolean {
		const clean = path.split('?')[0]
		const procedures = clean
			.replace(/^\/trpc\//, '')
			.split(',')
			.map((procedure) => procedure.split('/')[0])
		return (
			procedures.some(
				(procedure) =>
					procedure === 'user.login' || procedure === 'user.loginNative' || procedure === 'user.refreshNativeAccess',
			) ||
			clean === '/login' ||
			clean.startsWith('/app-auth/')
		)
	}

	#isProtected(path: string, publicProcedures: string[]): boolean {
		if (path === '/' || path === '/login' || path === '/favicon.ico' || path === '/manifest.webmanifest') return false
		if (path.startsWith('/assets/') || path.startsWith('/static/')) return false
		if (path.startsWith('/api/accounts/')) return false
		if (path.startsWith('/app-auth/')) return false
		// Member self-service stays reachable on the public portal; these endpoints
		// still require the member's own browser session and a CSRF token.
		if (path.startsWith('/umbra/api/me/')) return false
		// The official App Store's member flow bootstraps a CSRF token here. It is
		// still session-authenticated; Access protects the admin console, not this
		// token handshake.
		if (path === '/umbra/api/session') return false
		if (path.startsWith('/trpc/')) {
			const procedures = path.slice('/trpc/'.length).split('/')[0].split('?')[0].split(',').filter(Boolean)
			return procedures.some(
				(procedure) =>
					!publicProcedures.includes(procedure) &&
					SENSITIVE_TRPC.some((prefix) => procedure === prefix || procedure.startsWith(prefix)),
			)
		}
		return ['/settings', '/umbra', '/mcp', '/terminal', '/api', '/logs'].some(
			(prefix) => path === prefix || path.startsWith(`${prefix}/`),
		)
	}

	#applyHeaders(
		response: HttpResponse,
		request: HttpRequest,
		publicRequest: boolean,
		security: {hsts: boolean; strictCsp: boolean},
	) {
		response.setHeader('X-Content-Type-Options', 'nosniff')
		response.setHeader('Referrer-Policy', 'no-referrer')
		const path = request.path ?? '/'
		if (path.startsWith('/umbra')) {
			// Same-origin framing is required by the official Settings embed.
			response.setHeader('X-Frame-Options', 'SAMEORIGIN')
			response.setHeader(
				'Content-Security-Policy',
				"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
			)
			response.setHeader('Cache-Control', 'no-store')
		}
		if (publicRequest && security.hsts) {
			response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
		}
		if (publicRequest && security.strictCsp && !path.startsWith('/umbra')) {
			response.setHeader(
				'Content-Security-Policy',
				[
					"default-src 'self'",
					"script-src 'self'",
					"style-src 'self' 'unsafe-inline'",
					"img-src 'self' data: blob: https:",
					"media-src 'self' blob:",
					"connect-src 'self' https://apps.umbrel.com wss://" + (header(request, 'host') ?? ''),
					"font-src 'self' data:",
					"frame-ancestors 'none'",
					"base-uri 'self'",
					"form-action 'self'",
					"object-src 'none'",
					'upgrade-insecure-requests',
				].join('; '),
			)
		}
	}

	#consumeRate(ip: string, perMinute: number): boolean {
		const now = Date.now()
		if (this.#buckets.size > 10_000) this.#buckets.clear()
		const bucket = this.#buckets.get(ip)
		if (!bucket || now - bucket.updatedAt > 60_000) {
			this.#buckets.set(ip, {tokens: perMinute - 1, updatedAt: now})
			return true
		}
		if (bucket.tokens <= 0) return false
		bucket.tokens--
		return true
	}

	#failureBucket(ip: string): FailureBucket {
		if (this.#failures.size > 10_000) this.#failures.clear()
		const existing = this.#failures.get(ip)
		if (existing) return existing
		const created: FailureBucket = {failures: 0, firstFailureAt: Date.now(), lockedUntil: 0}
		this.#failures.set(ip, created)
		return created
	}

	#recordFailure(ip: string, security: {loginLockoutThreshold: number; loginLockoutMinutes: number}) {
		const bucket = this.#failureBucket(ip)
		if (Date.now() - bucket.firstFailureAt > security.loginLockoutMinutes * 60_000) {
			bucket.failures = 0
			bucket.firstFailureAt = Date.now()
		}
		bucket.failures++
		if (bucket.failures >= security.loginLockoutThreshold) {
			bucket.lockedUntil = Date.now() + security.loginLockoutMinutes * 60_000
			bucket.failures = 0
			this.#audit.record({
				type: 'security.block',
				action: 'Account/IP locked after repeated failed sign-ins',
				actor: {type: 'system', id: 'edge'},
				ip,
				outcome: 'denied',
				detail: {lockoutMinutes: security.loginLockoutMinutes},
			})
		}
	}

	#deny(response: HttpResponse, status: number, message: string) {
		if (response.headersSent) return
		response.statusCode = status
		response.setHeader('Content-Type', 'text/plain; charset=utf-8')
		response.end(message)
	}

	/** Test and CLI hook: clear rate/lockout state without a restart. */
	clearLimits(): void {
		this.#buckets.clear()
		this.#failures.clear()
	}

	correlationId(): string {
		return randomId(8)
	}
}
