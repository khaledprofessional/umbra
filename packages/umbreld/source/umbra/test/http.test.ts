import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {after, before, describe, it} from 'node:test'

import Umbra from '../index.js'
import type {HttpRequest, HttpResponse, Principal} from '../types.js'
import {cleanup, makeApp, makeTempDir, makeUmbreld} from './helpers.js'

function response() {
	const headers: Record<string, string | string[]> = {}
	const listeners: Record<string, (() => void)[]> = {}
	let resolveEnd!: () => void
	const ended = new Promise<void>((resolve) => {
		resolveEnd = resolve
	})
	const res: HttpResponse & {body: string; headers: typeof headers; ended: Promise<void>} = {
		statusCode: 200,
		headers,
		body: '',
		ended,
		setHeader: (name, value) => {
			headers[name.toLowerCase()] = value
		},
		getHeader: (name) => headers[name.toLowerCase()] as string | undefined,
		removeHeader: (name) => {
			delete headers[name.toLowerCase()]
		},
		writeHead: () => {},
		write: (chunk) => {
			res.body += String(chunk)
			return true
		},
		end: (chunk) => {
			if (chunk) res.body += String(chunk)
			resolveEnd()
		},
		on: (event, listener) => {
			;(listeners[event] ??= []).push(listener as () => void)
		},
	}
	return res
}

function getRequest(path: string, cookie: string): HttpRequest {
	return {
		method: 'GET',
		url: path,
		path,
		headers: {host: 'umbrel.local', cookie},
		socket: {remoteAddress: '127.0.0.1'},
	}
}

function postRequest(path: string, cookie: string, body: unknown, csrf: string) {
	const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as HttpRequest & {
		on: (...args: unknown[]) => void
	}
	stream.method = 'POST'
	stream.url = path
	stream.path = path
	stream.headers = {
		host: 'umbrel.local',
		cookie,
		'content-type': 'application/json',
		'x-umbra-csrf': csrf,
	}
	stream.socket = {remoteAddress: '127.0.0.1'}
	return stream
}

describe('Umbra HTTP API', () => {
	let directory: string
	let umbra: Umbra
	let router: (req: HttpRequest, res: HttpResponse, next: (error?: unknown) => void) => void

	before(async () => {
		directory = await makeTempDir()
		const umbreld = makeUmbreld(directory, [makeApp('plex', `${directory}/app-data/plex`)])
		umbreld.auth.authenticate = async (token: string): Promise<Principal> => ({
			sessionId: 'session-1',
			accountId: token === 'member' ? '1' : '0',
			actor: 'account',
		})
		umbreld.user = {
			get: async () => ({name: 'Owner'}),
			getMember: async () => ({name: 'Alice'}),
			listMembers: async () => [{id: '1', name: 'Alice'}],
		}
		umbreld.mcp = {
			listTokens: async () => [
				{id: 'a'.repeat(32), label: 'Claude Code', agentType: 'claude-code'},
				{id: 'b'.repeat(32), label: 'Codex', agentType: 'codex'},
			],
		}
		umbra = new Umbra({umbreld})
		await umbra.start()
		router = umbra.router
	})
	after(async () => {
		await umbra.stop()
		await cleanup(directory)
	})

	it('rejects an unauthenticated session request', async () => {
		const res = response()
		router({...getRequest('/api/session', ''), headers: {host: 'umbrel.local'}}, res, () => {})
		await res.ended
		assert.equal(res.statusCode, 401)
	})

	it('returns a session and CSRF token for the owner', async () => {
		const res = response()
		router(getRequest('/api/session', 'UMBREL_BROWSER_SESSION=owner'), res, () => {})
		await res.ended
		assert.equal(res.statusCode, 200)
		const body = JSON.parse(res.body)
		assert.equal(body.principal.role, 'owner')
		assert.match(body.csrfToken, /^[0-9a-f]{64}$/)
	})

	it('lists every MCP token, including ones that never connected', async () => {
		const res = response()
		router(getRequest('/api/agents', 'UMBREL_BROWSER_SESSION=owner'), res, () => {})
		await res.ended
		assert.equal(res.statusCode, 200)
		const agents = JSON.parse(res.body)
		assert.equal(agents.length, 2)
		assert.equal(agents[0].terminal.mode, 'inherit')
	})

	it('requires CSRF on mutations and accepts a valid member request', async () => {
		const sessionRes = response()
		router(getRequest('/api/session', 'UMBREL_BROWSER_SESSION=member'), sessionRes, () => {})
		await sessionRes.ended
		const {csrfToken} = JSON.parse(sessionRes.body)

		const denied = response()
		router(postRequest('/api/me/request-app', 'UMBREL_BROWSER_SESSION=member', {appId: 'sonarr', appName: 'Sonarr'}, 'bad'), denied, () => {})
		await denied.ended
		assert.equal(denied.statusCode, 403)

		const accepted = response()
		router(
			postRequest('/api/me/request-app', 'UMBREL_BROWSER_SESSION=member', {appId: 'sonarr', appName: 'Sonarr'}, csrfToken),
			accepted,
			() => {},
		)
		await accepted.ended
		assert.equal(accepted.statusCode, 200)
		const request = JSON.parse(accepted.body)
		assert.equal(request.status, 'pending')
		assert.equal(request.userId, '1')

		const ownerQueue = response()
		router(getRequest('/api/access/requests', 'UMBREL_BROWSER_SESSION=owner'), ownerQueue, () => {})
		await ownerQueue.ended
		assert.equal(JSON.parse(ownerQueue.body).length, 1)
	})
})
