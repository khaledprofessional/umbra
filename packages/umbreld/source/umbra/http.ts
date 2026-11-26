import {createHmac, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type Umbra from './index.ts'
import type {HttpRequest, HttpResponse, NextFunction, Principal, UmbrelLike} from './types.ts'
import {HttpError, errorMessage, isRecord, parseJsonObject} from './util.ts'

const WEB_DIRECTORY = fileURLToPath(new URL('./web/', import.meta.url))
const MAX_BODY_BYTES = 8 * 1024 * 1024
const SESSION_COOKIE_HTTPS = '__Host-UMBREL_BROWSER_SESSION_HTTPS'
const SESSION_COOKIE_HTTP = 'UMBREL_BROWSER_SESSION'

type Ctx = {
	umbreld: UmbrelLike
	umbra: Umbra
	principal: Principal
	owner: boolean
	request: HttpRequest
	response: HttpResponse
}

function header(request: HttpRequest, name: string): string | undefined {
	const value = request.headers[name] ?? request.headers[name.toLowerCase()]
	return Array.isArray(value) ? value[0] : value
}

function cookies(request: HttpRequest): Record<string, string> {
	const parsed: Record<string, string> = {}
	for (const part of (header(request, 'cookie') ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key) parsed[key] = decodeURIComponent(rest.join('='))
	}
	return parsed
}

function sessionToken(request: HttpRequest): string | undefined {
	const jar = cookies(request)
	const forwarded = header(request, 'x-forwarded-proto')
	const secure = request.secure || forwarded === 'https'
	return secure ? jar[SESSION_COOKIE_HTTPS] : jar[SESSION_COOKIE_HTTP]
}

function sendJson(response: HttpResponse, status: number, value: unknown) {
	if (response.headersSent) return
	const body = JSON.stringify(value)
	response.statusCode = status
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.setHeader('Cache-Control', 'no-store')
	response.end(body)
}

function sendText(response: HttpResponse, status: number, value: string, contentType = 'text/plain; charset=utf-8') {
	if (response.headersSent) return
	response.statusCode = status
	response.setHeader('Content-Type', contentType)
	response.setHeader('Cache-Control', 'no-store')
	response.end(value)
}

async function readBody(request: HttpRequest & {on?: (...args: unknown[]) => void}): Promise<Record<string, unknown>> {
	const contentLength = Number(header(request, 'content-length') ?? 0)
	if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large')
	if (typeof request.on !== 'function') return isRecord(request.body) ? request.body : {}
	const chunks: Buffer[] = []
	let total = 0
	await new Promise<void>((resolve, reject) => {
		request.on!('data', (chunk: Buffer) => {
			total += chunk.length
			if (total > MAX_BODY_BYTES) {
				reject(new HttpError(413, 'Request body is too large'))
				return
			}
			chunks.push(chunk)
		})
		request.on!('end', resolve)
		request.on!('error', reject)
	})
	if (!chunks.length) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	return parseJsonObject(text, MAX_BODY_BYTES)
}

function assertMethod(request: HttpRequest, method: string) {
	if ((request.method ?? 'GET').toUpperCase() !== method) throw new HttpError(405, 'Method not allowed')
}

function csrfFor(umbra: Umbra, principal: Principal): string {
	return createHmac('sha256', umbra.secrets.key)
		.update(`csrf:${principal.sessionId}:${principal.accountId}`)
		.digest('hex')
}

function assertCsrf(ctx: Ctx) {
	const expected = csrfFor(ctx.umbra, ctx.principal)
	const provided = header(ctx.request, 'x-umbra-csrf') ?? ''
	if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
		throw new HttpError(403, 'Invalid CSRF token', 'csrf')
	}
	// Defence in depth: a browser cross-site POST would also carry a foreign
	// Origin. Same-origin console requests always match Host.
	const origin = header(ctx.request, 'origin')
	if (origin) {
		const host = header(ctx.request, 'host') ?? ''
		try {
			if (new URL(origin).host !== host) throw new HttpError(403, 'Cross-origin request blocked')
		} catch {
			throw new HttpError(403, 'Cross-origin request blocked')
		}
	}
}

async function authenticate(umbra: Umbra, request: HttpRequest): Promise<Principal> {
	const token = sessionToken(request)
	if (!token) throw new HttpError(401, 'Not signed in')
	let principal: Principal
	try {
		principal = await umbra.umbreld.auth.authenticate(token, 'browser-session')
	} catch {
		throw new HttpError(401, 'Session expired')
	}
	if (principal.actor !== 'account') throw new HttpError(403, 'A browser session is required')
	try {
		const validation = umbra.umbreld.auth.validatePrincipal?.(principal)
		if (validation) await validation
	} catch {
		throw new HttpError(401, 'Session expired')
	}
	return principal
}

async function accountName(umbra: Umbra, principal: Principal): Promise<string> {
	if (principal.accountId === '0') {
		try {
			return (await umbra.umbreld.user?.get?.())?.name ?? 'Owner'
		} catch {
			return 'Owner'
		}
	}
	try {
		return (await umbra.umbreld.user?.getMember?.(principal.accountId))?.name ?? 'Member'
	} catch {
		return 'Member'
	}
}

function requireOwner(ctx: Ctx) {
	if (!ctx.owner) throw new HttpError(403, 'This action can only be performed by the owner')
}

function requireString(value: unknown, label: string, max = 200): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label} is required`)
	return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be a boolean`)
	return value
}

/* -------------------------------------------------------------------------- */
/* Static console                                                             */
/* -------------------------------------------------------------------------- */

const STATIC_FILES: Record<string, {file: string; type: string}> = {
	'/': {file: 'index.html', type: 'text/html; charset=utf-8'},
	'/index.html': {file: 'index.html', type: 'text/html; charset=utf-8'},
	'/app.js': {file: 'app.js', type: 'text/javascript; charset=utf-8'},
	'/styles.css': {file: 'styles.css', type: 'text/css; charset=utf-8'},
	'/favicon.svg': {file: 'favicon.svg', type: 'image/svg+xml'},
}

async function serveStatic(response: HttpResponse, pathname: string) {
	const entry = STATIC_FILES[pathname]
	if (!entry) {
		sendText(response, 404, 'Not found')
		return
	}
	try {
		const contents = await readFile(path.join(WEB_DIRECTORY, entry.file))
		response.statusCode = 200
		response.setHeader('Content-Type', entry.type)
		response.setHeader('Cache-Control', 'no-store')
		response.end(contents)
	} catch {
		sendText(response, 500, 'Admin console is missing')
	}
}

/* -------------------------------------------------------------------------- */
/* SSE                                                                        */
/* -------------------------------------------------------------------------- */

function streamApprovals(umbra: Umbra, response: HttpResponse) {
	response.statusCode = 200
	response.setHeader('Content-Type', 'text/event-stream')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('Connection', 'keep-alive')
	response.setHeader('X-Accel-Buffering', 'no')
	response.write(': connected\n\n')
	const send = (event: string, data: unknown) => {
		try {
			response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		} catch {
			// Client went away.
		}
	}
	const onPending = (request: unknown) => send('approval', request)
	const onSettled = (payload: unknown) => send('settled', payload)
	umbra.approvals.events.on('pending', onPending)
	umbra.approvals.events.on('settled', onSettled)
	const heartbeat = setInterval(() => {
		try {
			response.write(': heartbeat\n\n')
		} catch {
			// Ignore.
		}
	}, 25_000)
	heartbeat.unref?.()
	const cleanup = () => {
		clearInterval(heartbeat)
		umbra.approvals.events.off('pending', onPending)
		umbra.approvals.events.off('settled', onSettled)
	}
	response.on?.('close', cleanup)
	response.on?.('error', cleanup)
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export default function createUmbraRouter(umbreld: UmbrelLike, umbra: Umbra) {
	const handle = async (request: HttpRequest, response: HttpResponse) => {
		const url = new URL(`http://localhost${request.url ?? '/'}`)
		const pathname = decodeURIComponent(url.pathname)
		const method = (request.method ?? 'GET').toUpperCase()

		// Static assets are readable before the session query so the console can
		// load and then report the signed-out state.
		if (method === 'GET' && STATIC_FILES[pathname]) {
			await serveStatic(response, pathname)
			return
		}
		if (method === 'GET' && pathname === '') {
			response.statusCode = 302
			response.setHeader('Location', '/umbra/')
			response.end()
			return
		}

		const principal = await authenticate(umbra, request)
		const ctx: Ctx = {
			umbreld,
			umbra,
			principal,
			owner: principal.accountId === '0',
			request,
			response,
		}

		// Read-only session bootstrap: the CSRF token is bound to this session.
		if (pathname === '/api/session' && method === 'GET') {
			sendJson(response, 200, {
				principal: {accountId: principal.accountId, role: ctx.owner ? 'owner' : 'member'},
				name: await accountName(umbra, principal),
				csrfToken: csrfFor(umbra, principal),
				version: umbreld.version,
			})
			return
		}

		if (method !== 'GET' && method !== 'HEAD') assertCsrf(ctx)

		// Member-facing surface: request apps and see their own requests.
		if (pathname === '/api/me/requests' && method === 'GET') {
			const requests = await umbra.access.listRequests({limit: 100})
			sendJson(
				response,
				200,
				requests.filter((request) => request.userId === principal.accountId),
			)
			return
		}
		if (pathname === '/api/me/request-app' && method === 'POST') {
			const body = await readBody(request)
			const appId = requireString(body.appId, 'appId', 80)
			const appName = requireString(body.appName ?? appId, 'appName', 80)
			const requestResult = await umbra.access.requestApp({
				userId: principal.accountId,
				userName: await accountName(umbra, principal),
				appId,
				appName,
				message: typeof body.message === 'string' ? body.message : undefined,
				ip: request.umbra?.realIp,
			})
			sendJson(response, 200, requestResult)
			return
		}
		if (pathname === '/api/me/install-app' && method === 'POST') {
			const body = await readBody(request)
			const appId = requireString(body.appId, 'appId', 80)
			if (!(await umbra.access.canInstallDirectly(principal.accountId))) {
				throw new HttpError(403, 'This account cannot install apps directly')
			}
			await umbra.access.installForMember(
				principal.accountId,
				appId,
				requireString(body.appName ?? appId, 'appName', 80),
			)
			sendJson(response, 200, {ok: true})
			return
		}
		if (pathname === '/api/me/policy' && method === 'GET') {
			sendJson(response, 200, {policy: await umbra.access.policyFor(principal.accountId)})
			return
		}
		if (pathname.startsWith('/api/me')) {
			requireOwner(ctx)
		}

		requireOwner(ctx)

		/* ------------------------------ summary ------------------------------ */
		if (pathname === '/api/summary' && method === 'GET') {
			sendJson(response, 200, await umbra.summary())
			return
		}
		if (pathname === '/api/health' && method === 'GET') {
			sendJson(response, 200, {ok: true, version: umbreld.version, uptime: process.uptime()})
			return
		}

		/* ------------------------------ apps -------------------------------- */
		if (pathname === '/api/apps' && method === 'GET') {
			const apps = await Promise.all(
				umbreld.apps.instances.map(async (app) => {
					const manifest = await app.readManifest().catch(() => null)
					return {
						id: app.id,
						name: manifest?.name ?? app.id,
						version: manifest?.version ?? null,
						state: app.state ?? 'unknown',
					}
				}),
			)
			sendJson(
				response,
				200,
				apps.sort((first, second) => first.name.localeCompare(second.name)),
			)
			return
		}

		/* ------------------------------ agents ------------------------------- */
		if (pathname === '/api/agents' && method === 'GET') {
			const tokens = (await umbreld.mcp?.listTokens?.()) ?? []
			const labels = new Map(
				(tokens as {id: string; label: string; agentType?: string}[]).map((token) => [token.id, token]),
			)
			const profiles = new Map(umbra.agents.list().map((agent) => [agent.tokenId, agent]))
			for (const token of labels.values()) {
				if (profiles.has(token.id)) continue
				profiles.set(token.id, {
					tokenId: token.id,
					label: token.label,
					...(token.agentType ? {agentType: token.agentType} : {}),
					firstSeenAt: 0,
					lastSeenAt: 0,
					terminal: {mode: 'inherit', allowlist: []},
				})
			}
			sendJson(
				response,
				200,
				[...profiles.values()]
					.sort((first, second) => second.lastSeenAt - first.lastSeenAt)
					.map((agent) => ({
						...agent,
						token: labels.get(agent.tokenId) ?? null,
						avatarUrl: agent.avatar
							? `/umbra/api/agents/${agent.tokenId}/avatar?v=${agent.avatar.sha256.slice(0, 12)}`
							: null,
					})),
			)
			return
		}
		const agentPolicy = /^\/api\/agents\/([0-9a-f]{32})\/terminal-policy$/.exec(pathname)
		if (agentPolicy && method === 'POST') {
			const body = await readBody(request)
			const mode = requireString(body.mode, 'mode', 10)
			if (!['inherit', 'deny', 'ask', 'always'].includes(mode)) throw new HttpError(400, 'Invalid mode')
			const allowlist = Array.isArray(body.allowlist)
				? body.allowlist.filter((entry): entry is string => typeof entry === 'string').slice(0, 100)
				: []
			if (!umbra.agents.getProfile(agentPolicy[1])) {
				const tokens = (await umbreld.mcp?.listTokens?.()) ?? []
				const token = (tokens as {id: string; label: string; agentType?: string}[]).find(
					(candidate) => candidate.id === agentPolicy[1],
				)
				if (!token) throw new HttpError(404, 'Agent credential not found')
				await umbra.agents.ensureProfile(token.id, token.label, token.agentType)
			}
			const profile = await umbra.agents.setTerminalPolicy(
				agentPolicy[1],
				{mode: mode as 'inherit' | 'deny' | 'ask' | 'always', allowlist},
				{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
			)
			sendJson(response, 200, profile)
			return
		}
		const agentAvatar = /^\/api\/agents\/([0-9a-f]{32})\/avatar$/.exec(pathname)
		if (agentAvatar && method === 'GET') {
			const filePath = await umbra.agents.avatarPath(agentAvatar[1])
			if (!filePath) throw new HttpError(404, 'No avatar')
			const contents = await readFile(filePath)
			const profile = umbra.agents.getProfile(agentAvatar[1])
			response.statusCode = 200
			response.setHeader('Content-Type', profile?.avatar?.mime ?? 'application/octet-stream')
			response.setHeader('Cache-Control', 'private, max-age=300')
			response.setHeader('X-Content-Type-Options', 'nosniff')
			response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
			response.end(contents)
			return
		}
		const agentAvatarRemove = /^\/api\/agents\/([0-9a-f]{32})\/avatar\/remove$/.exec(pathname)
		if (agentAvatarRemove && method === 'POST') {
			await umbra.agents.removeAvatar(agentAvatarRemove[1], {
				id: principal.accountId,
				name: await accountName(umbra, principal),
			})
			sendJson(response, 200, {ok: true})
			return
		}

		/* ---------------------------- approvals ------------------------------ */
		if (pathname === '/api/approvals' && method === 'GET') {
			sendJson(response, 200, umbra.approvals.list())
			return
		}
		if (pathname === '/api/approvals/stream' && method === 'GET') {
			streamApprovals(umbra, response)
			return
		}
		const approvalDecision = /^\/api\/approvals\/([0-9a-f]{16})\/decide$/.exec(pathname)
		if (approvalDecision && method === 'POST') {
			const body = await readBody(request)
			const approved = requireBoolean(body.approved, 'approved')
			const reason = typeof body.reason === 'string' ? body.reason : undefined
			const found = umbra.approvals.decide(
				approvalDecision[1],
				approved,
				{
					id: principal.accountId,
					name: await accountName(umbra, principal),
					ip: request.umbra?.realIp,
				},
				reason,
			)
			if (!found) throw new HttpError(404, 'Approval request is no longer pending')
			sendJson(response, 200, {ok: true})
			return
		}

		/* ------------------------------- audit ------------------------------- */
		if (pathname === '/api/audit' && method === 'GET') {
			const query = url.searchParams
			sendJson(
				response,
				200,
				await umbra.audit.query({
					limit: Number(query.get('limit') ?? 100),
					before: query.get('before') ? Number(query.get('before')) : undefined,
					type: query.get('type') ?? undefined,
					actorId: query.get('actor') ?? undefined,
					outcome: query.get('outcome') ?? undefined,
					search: query.get('q') ?? undefined,
				}),
			)
			return
		}
		if (pathname === '/api/audit/verify' && method === 'GET') {
			sendJson(response, 200, await umbra.audit.verify())
			return
		}
		if (pathname === '/api/audit/export' && method === 'GET') {
			const from = Number(url.searchParams.get('from') ?? 1)
			const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER)
			const entries = await umbra.audit.exportRange(from, to)
			response.setHeader('Content-Disposition', `attachment; filename="umbra-audit-${Date.now()}.json"`)
			sendJson(response, 200, {exportedAt: Date.now(), entries})
			return
		}

		/* ----------------------------- cloudflare ---------------------------- */
		if (pathname === '/api/cloudflare' && method === 'GET') {
			sendJson(response, 200, {
				settings: (await umbra.config.load()).cloudflare,
				status: await umbra.cloudflare.status({refresh: true}),
				logs: await umbra.cloudflare.logs(80).catch(() => ''),
			})
			return
		}
		if (pathname === '/api/cloudflare/settings' && method === 'POST') {
			const body = await readBody(request)
			const settings = await umbra.cloudflare.updateSettings(
				{
					...(typeof body.hostname === 'string' ? {hostname: body.hostname} : {}),
					...(body.mode === 'token' || body.mode === 'credentials' ? {mode: body.mode} : {}),
					...(typeof body.tunnelId === 'string' ? {tunnelId: body.tunnelId} : {}),
					...(typeof body.targetUrl === 'string' ? {targetUrl: body.targetUrl} : {}),
					...(typeof body.image === 'string' ? {image: body.image} : {}),
					...(isRecord(body.access) ? {access: body.access as never} : {}),
					...(isRecord(body.security) ? {security: body.security as never} : {}),
				},
				{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
			)
			sendJson(response, 200, settings)
			return
		}
		if (pathname === '/api/cloudflare/token' && method === 'POST') {
			const body = await readBody(request)
			await umbra.cloudflare.setToken(requireString(body.token, 'token', 4096), {
				id: principal.accountId,
				name: await accountName(umbra, principal),
				ip: request.umbra?.realIp,
			})
			sendJson(response, 200, {ok: true})
			return
		}
		if (pathname === '/api/cloudflare/credentials' && method === 'POST') {
			const body = await readBody(request)
			await umbra.cloudflare.setCredentials(body.credentials, {
				id: principal.accountId,
				name: await accountName(umbra, principal),
				ip: request.umbra?.realIp,
			})
			sendJson(response, 200, {ok: true})
			return
		}
		if (pathname === '/api/cloudflare/clear-secret' && method === 'POST') {
			const body = await readBody(request)
			const kind = body.kind === 'credentials' ? 'credentials' : 'token'
			await umbra.cloudflare.clearSecret(kind, {
				id: principal.accountId,
				name: await accountName(umbra, principal),
				ip: request.umbra?.realIp,
			})
			sendJson(response, 200, {ok: true})
			return
		}
		if (pathname === '/api/cloudflare/enable' && method === 'POST') {
			sendJson(
				response,
				200,
				await umbra.cloudflare.enable({
					id: principal.accountId,
					name: await accountName(umbra, principal),
					ip: request.umbra?.realIp,
				}),
			)
			return
		}
		if (pathname === '/api/cloudflare/disable' && method === 'POST') {
			sendJson(
				response,
				200,
				await umbra.cloudflare.disable({
					id: principal.accountId,
					name: await accountName(umbra, principal),
					ip: request.umbra?.realIp,
				}),
			)
			return
		}
		if (pathname === '/api/cloudflare/lockdown' && method === 'POST') {
			const body = await readBody(request)
			sendJson(
				response,
				200,
				await umbra.cloudflare.setLockdown(requireBoolean(body.locked, 'locked'), {
					id: principal.accountId,
					name: await accountName(umbra, principal),
					ip: request.umbra?.realIp,
				}),
			)
			return
		}

		/* ------------------------------ plugins ------------------------------ */
		if (pathname === '/api/plugins' && method === 'GET') {
			const plugins = await umbra.plugins.list()
			sendJson(
				response,
				200,
				plugins.map((plugin) => ({...plugin, manifest: plugin.manifest})),
			)
			return
		}
		if (pathname === '/api/plugins/install' && method === 'POST') {
			const body = await readBody(request)
			const plugin = await umbra.plugins.install(
				{
					manifest: body.manifest,
					files: Array.isArray(body.files) ? (body.files as never) : [],
					enable: Boolean(body.enable),
				},
				{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
			)
			sendJson(response, 200, plugin)
			return
		}
		if (pathname === '/api/plugins/install-path' && method === 'POST') {
			const body = await readBody(request)
			const plugin = await umbra.plugins.installFromPath(
				requireString(body.path, 'path', 4096),
				{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
				Boolean(body.enable),
			)
			sendJson(response, 200, plugin)
			return
		}
		if (pathname === '/api/plugins/scaffold' && method === 'POST') {
			const body = await readBody(request)
			sendJson(
				response,
				200,
				umbra.plugins.scaffold({
					id: requireString(body.id, 'id', 80),
					name: requireString(body.name, 'name', 60),
					description: typeof body.description === 'string' ? body.description : undefined,
					withBackend: Boolean(body.withBackend),
					withWidget: Boolean(body.withWidget),
					withRoute: Boolean(body.withRoute),
				}),
			)
			return
		}
		if (pathname === '/api/plugins/widgets' && method === 'GET') {
			sendJson(response, 200, await umbra.plugins.widgets())
			return
		}
		const pluginAction = /^\/api\/plugins\/([a-z0-9.-]{3,80})\/(enable|disable|uninstall|settings)$/.exec(pathname)
		if (pluginAction && method === 'POST') {
			const [, id, action] = pluginAction
			const actor = {id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp}
			if (action === 'enable') sendJson(response, 200, await umbra.plugins.enable(id, actor))
			else if (action === 'disable') sendJson(response, 200, await umbra.plugins.disable(id, actor))
			else if (action === 'uninstall') {
				const body = await readBody(request)
				sendJson(response, 200, await umbra.plugins.uninstall(id, actor, Boolean(body.removeData)))
			} else {
				const body = await readBody(request)
				sendJson(response, 200, await umbra.plugins.setSettings(id, body.settings as never, actor))
			}
			return
		}
		const pluginUi = /^\/api\/plugins\/([a-z0-9.-]{3,80})\/ui\/(.+)$/.exec(pathname)
		if (pluginUi && method === 'GET') {
			const file = await umbra.plugins.uiFile(pluginUi[1], pluginUi[2])
			response.statusCode = 200
			response.setHeader('Content-Type', file.contentType)
			response.setHeader('Cache-Control', 'no-store')
			response.setHeader('X-Content-Type-Options', 'nosniff')
			response.setHeader(
				'Content-Security-Policy',
				"default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox allow-scripts",
			)
			response.end(file.contents)
			return
		}

		/* ------------------------------- access ------------------------------ */
		if (pathname === '/api/access/members' && method === 'GET') {
			sendJson(response, 200, await umbra.access.listMembers())
			return
		}
		const memberPolicy = /^\/api\/access\/members\/([^/]{1,80})\/policy$/.exec(pathname)
		if (memberPolicy && method === 'POST') {
			const body = await readBody(request)
			const policy = requireString(body.policy, 'policy', 10)
			if (!['none', 'request', 'manage'].includes(policy)) throw new HttpError(400, 'Invalid policy')
			sendJson(
				response,
				200,
				await umbra.access.setPolicy(memberPolicy[1], policy as 'none' | 'request' | 'manage', {
					id: principal.accountId,
					name: await accountName(umbra, principal),
					ip: request.umbra?.realIp,
				}),
			)
			return
		}
		if (pathname === '/api/access/requests' && method === 'GET') {
			sendJson(response, 200, await umbra.access.listRequests({status: url.searchParams.get('status') ?? undefined}))
			return
		}
		const requestDecision = /^\/api\/access\/requests\/([0-9a-f]{16})\/decide$/.exec(pathname)
		if (requestDecision && method === 'POST') {
			const body = await readBody(request)
			sendJson(
				response,
				200,
				await umbra.access.decide(
					requestDecision[1],
					requireBoolean(body.approved, 'approved'),
					{
						id: principal.accountId,
						name: await accountName(umbra, principal),
						ip: request.umbra?.realIp,
					},
					typeof body.reason === 'string' ? body.reason : undefined,
				),
			)
			return
		}

		/* ------------------------------ extras ------------------------------- */
		const overrideRoute = /^\/api\/apps\/([a-zA-Z0-9-_]{1,80})\/overrides$/.exec(pathname)
		if (overrideRoute) {
			const appId = overrideRoute[1]
			if (method === 'GET') {
				const config = await umbra.config.load()
				sendJson(response, 200, config.extras.overrides[appId] ?? null)
				return
			}
			if (method === 'POST') {
				const body = await readBody(request)
				sendJson(
					response,
					200,
					await umbra.overrides.save(
						appId,
						{
							composeOverride: typeof body.composeOverride === 'string' ? body.composeOverride : undefined,
							quota: isRecord(body.quota) ? (body.quota as never) : undefined,
						},
						{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
					),
				)
				return
			}
			if (method === 'DELETE') {
				sendJson(
					response,
					200,
					await umbra.overrides.remove(appId, {
						id: principal.accountId,
						name: await accountName(umbra, principal),
						ip: request.umbra?.realIp,
					}),
				)
				return
			}
		}
		if (pathname === '/api/snapshots') {
			if (method === 'GET') {
				sendJson(response, 200, await umbra.snapshots.list())
				return
			}
			if (method === 'POST') {
				const body = await readBody(request)
				sendJson(
					response,
					200,
					await umbra.snapshots.create(
						requireString(body.reason ?? 'manual', 'reason', 60),
						{
							type: 'user',
							id: principal.accountId,
							name: await accountName(umbra, principal),
							ip: request.umbra?.realIp,
						},
						typeof body.passphrase === 'string' ? body.passphrase : undefined,
					),
				)
				return
			}
		}
		const snapshotRestore = /^\/api\/snapshots\/([^/]{1,120})\/restore$/.exec(pathname)
		if (snapshotRestore && method === 'POST') {
			const body = await readBody(request)
			sendJson(
				response,
				200,
				await umbra.snapshots.restore(
					snapshotRestore[1],
					{id: principal.accountId, name: await accountName(umbra, principal), ip: request.umbra?.realIp},
					typeof body.passphrase === 'string' ? body.passphrase : undefined,
				),
			)
			return
		}
		if (pathname === '/api/auto-update') {
			const config = await umbra.config.load()
			if (method === 'GET') {
				sendJson(response, 200, config.extras.autoUpdate)
				return
			}
			if (method === 'POST') {
				const body = await readBody(request)
				const updated = await umbra.config.update((draft) => {
					if (typeof body.enabled === 'boolean') draft.extras.autoUpdate.enabled = body.enabled
					if (body.apps === 'all' || Array.isArray(body.apps)) {
						draft.extras.autoUpdate.apps =
							body.apps === 'all' ? 'all' : body.apps.filter((id: unknown) => typeof id === 'string')
					}
					if (isRecord(body.window)) {
						const window = body.window as Record<string, unknown>
						if (Array.isArray(window.days)) {
							draft.extras.autoUpdate.window.days = window.days.filter(
								(day): day is number => Number.isInteger(day) && day >= 0 && day <= 6,
							)
						}
						if (typeof window.start === 'string') draft.extras.autoUpdate.window.start = window.start
						if (typeof window.end === 'string') draft.extras.autoUpdate.window.end = window.end
					}
					return structuredClone(draft.extras.autoUpdate)
				})
				sendJson(response, 200, updated)
				return
			}
		}

		throw new HttpError(404, 'Not found')
	}

	return function umbraRouter(request: HttpRequest, response: HttpResponse, next: NextFunction) {
		void handle(request, response).catch((error) => {
			if (response.headersSent) return
			const status = error instanceof HttpError ? error.status : 500
			if (status >= 500) umbra.logger.error('Umbra API request failed', error)
			sendJson(response, status, {
				error: errorMessage(error),
				...(error instanceof HttpError ? {code: error.code} : {}),
			})
		})
	}
}
