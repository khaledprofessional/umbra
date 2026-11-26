import http from 'node:http'
import path from 'node:path'

import type Umbra from './index.ts'
import type {HttpRequest, HttpResponse, Middleware, NextFunction, Principal, UmbrelLike} from './types.ts'
import {HttpError, isRecord} from './util.ts'

const MAX_HTML_BYTES = 2 * 1024 * 1024
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
])

function header(request: HttpRequest, name: string): string | undefined {
	const value = request.headers[name] ?? request.headers[name.toLowerCase()]
	return Array.isArray(value) ? value[0] : value
}

function cookies(request: HttpRequest): Record<string, string> {
	const result: Record<string, string> = {}
	for (const part of (header(request, 'cookie') ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key) result[key] = decodeURIComponent(rest.join('='))
	}
	return result
}

function sessionToken(request: HttpRequest): string | undefined {
	const jar = cookies(request)
	const secure = request.secure || header(request, 'x-forwarded-proto') === 'https'
	return secure ? jar['__Host-UMBREL_BROWSER_SESSION_HTTPS'] : jar['UMBREL_BROWSER_SESSION']
}

function send(response: HttpResponse, status: number, message: string) {
	if (response.headersSent) return
	response.statusCode = status
	response.setHeader('Content-Type', 'text/plain; charset=utf-8')
	response.end(message)
}

/**
 * Experimental single-subdomain app routing.
 *
 * `/apps/<id>/…` is authenticated with the umbrelOS browser session, checked
 * against member app sharing, then proxied to the app's app-gateway port with
 * the session's app-gateway cookie. HTML gets a `<base>` and root-absolute
 * attributes are rewritten so path-safe apps work through one hostname.
 *
 * Apps that hard-code `fetch('/api')`, service workers, or WebSockets cannot be
 * made path-safe by rewriting. Those need a dedicated hostname; this proxy
 * returns a clear 501 for upgrades instead of silently breaking them.
 */
export default class AppPathProxy {
	#umbreld: UmbrelLike
	#umbra: Umbra

	constructor(umbreld: UmbrelLike, umbra: Umbra) {
		this.#umbreld = umbreld
		this.#umbra = umbra
	}

	middleware(): Middleware {
		return (request, response, next) => {
			void this.handle(request, response, next).catch((error) => {
				if (error instanceof HttpError) send(response, error.status, error.message)
				else send(response, 502, 'App gateway error')
			})
		}
	}

	async handle(request: HttpRequest, response: HttpResponse, next: NextFunction): Promise<void> {
		const rawPath = (request.url ?? '/').split('?')[0]
		const match = /^\/apps\/([a-zA-Z0-9-_]{1,80})(\/.*)?$/.exec(rawPath)
		if (!match) {
			next()
			return
		}
		const appId = match[1]
		const rest = match[2] ?? '/'
		const query = (request.url ?? '').includes('?') ? `?${(request.url ?? '').split('?').slice(1).join('?')}` : ''
		const principal = await this.#authenticate(request)
		await this.#authorize(principal, appId)
		if (!(await this.#umbreld.apps.isInstalled(appId))) throw new HttpError(404, 'App is not installed')
		const app = this.#umbreld.apps.getApp(appId)
		const manifest = await app.readManifest()
		const portValue = Number((manifest as {port?: unknown}).port)
		if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
			throw new HttpError(502, 'App does not declare a routable port')
		}
		await this.#proxy(request, response, {appId, port: portValue, path: rest, query})
	}

	async #authenticate(request: HttpRequest): Promise<Principal> {
		const token = sessionToken(request)
		if (!token) throw new HttpError(401, 'Sign in to open apps')
		try {
			const principal = await this.#umbreld.auth.authenticate(token, 'browser-session')
			await this.#umbreld.auth.validatePrincipal?.(principal)
			return principal
		} catch {
			throw new HttpError(401, 'Session expired')
		}
	}

	async #authorize(principal: Principal, appId: string) {
		if (principal.accountId === '0') return
		const shared = await this.#umbreld.apps.sharedAppIdsForUser(principal.accountId)
		if (!shared.includes(appId)) throw new HttpError(403, 'This app is not shared with your account')
	}

	#proxy(
		request: HttpRequest & {on?: (...args: unknown[]) => void; pipe?: (target: unknown) => void},
		response: HttpResponse,
		target: {appId: string; port: number; path: string; query: string},
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string | string[]> = {}
			for (const [name, value] of Object.entries(request.headers)) {
				if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue
				if (name.toLowerCase() === 'host' || name.toLowerCase() === 'accept-encoding') continue
				headers[name] = value
			}
			headers.host = `127.0.0.1:${target.port}`
			headers['x-forwarded-host'] = header(request, 'host') ?? ''
			headers['x-forwarded-proto'] = header(request, 'x-forwarded-proto') ?? 'http'
			headers['x-forwarded-for'] = request.umbra?.realIp ?? header(request, 'x-forwarded-for') ?? ''
			headers['x-umbra-app-id'] = target.appId
			const upstream = http.request(
				{
					host: '127.0.0.1',
					port: target.port,
					method: request.method,
					path: `${target.path}${target.query}`,
					headers,
				},
				(upstreamResponse) => {
					void this.#relay(upstreamResponse, response, target).then(resolve, reject)
				},
			)
			upstream.on('error', reject)
			if (request.on && typeof request.on === 'function' && request.method !== 'GET' && request.method !== 'HEAD') {
				request.on('data', (chunk: Buffer) => upstream.write(chunk))
				request.on('end', () => upstream.end())
			} else upstream.end()
		})
	}

	async #relay(
		upstream: http.IncomingMessage,
		response: HttpResponse,
		target: {appId: string; path: string},
	): Promise<void> {
		const status = upstream.statusCode ?? 502
		const contentType = String(upstream.headers['content-type'] ?? '')
		response.statusCode = status
		for (const [name, value] of Object.entries(upstream.headers)) {
			if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue
			if (name.toLowerCase() === 'location') {
				const location = String(value)
				response.setHeader('location', this.#rewriteLocation(location, target.appId))
				continue
			}
			if (name.toLowerCase() === 'set-cookie') {
				const list = Array.isArray(value) ? value : [String(value)]
				response.setHeader(
					'set-cookie',
					list.map((cookie) => cookie.replace(/;\s*Path=\/(?=;|$)/i, `; Path=/apps/${target.appId}/`)),
				)
				continue
			}
			if (name.toLowerCase() === 'content-security-policy') continue
			response.setHeader(name, value)
		}
		response.setHeader('X-Frame-Options', 'SAMEORIGIN')
		response.setHeader('Referrer-Policy', 'same-origin')

		if (contentType.includes('text/html') && (upstream.statusCode ?? 0) < 400) {
			const chunks: Buffer[] = []
			let total = 0
			for await (const chunk of upstream) {
				total += (chunk as Buffer).length
				if (total > MAX_HTML_BYTES) {
					// Too large to rewrite safely; stream it untouched instead.
					response.removeHeader?.('content-length')
					response.write(Buffer.concat(chunks).toString('utf8'))
					response.end()
					return
				}
				chunks.push(chunk as Buffer)
			}
			const html = this.#rewriteHtml(Buffer.concat(chunks).toString('utf8'), target.appId)
			response.removeHeader?.('content-length')
			response.setHeader('Content-Length', String(Buffer.byteLength(html)))
			response.end(html)
			return
		}
		upstream.on('data', (chunk: Buffer) => response.write(chunk))
		await new Promise<void>((resolve, reject) => {
			upstream.on('end', () => {
				response.end()
				resolve()
			})
			upstream.on('error', reject)
		})
	}

	#rewriteLocation(location: string, appId: string): string {
		if (location.startsWith('/') && !location.startsWith('//') && !location.startsWith(`/apps/${appId}`)) {
			return `/apps/${appId}${location}`
		}
		return location
	}

	#rewriteHtml(html: string, appId: string): string {
		const prefix = `/apps/${appId}`
		// Rewrite root-absolute attributes before inserting <base>, otherwise the
		// injected base href would be rewritten a second time.
		let output = html.replace(
			/(\s(?:src|href|action|poster|data-src)=)(["'])\/(?!\/)([^"']*)\2/gi,
			(_match, attribute: string, quote: string, value: string) => `${attribute}${quote}${prefix}/${value}${quote}`,
		)
		output = output.replace(/url\(\s*(['"]?)\/(?!\/)/gi, (_match, quote: string) => `url(${quote}${prefix}/`)
		output = output.replace(/<head(\s[^>]*)?>/i, (match) => `${match}<base href="${prefix}/">`)
		return output
	}
}
