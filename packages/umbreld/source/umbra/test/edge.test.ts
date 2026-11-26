import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import AuditLog from '../audit.js'
import type CloudflareManager from '../cloudflare.js'
import ConfigStore from '../config.js'
import EdgeGuard from '../edge.js'
import type {HttpRequest, HttpResponse} from '../types.js'
import {cleanup, makeTempDir} from './helpers.js'

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
	return {
		method: 'GET',
		url: '/',
		path: '/',
		headers: {host: 'umbrel.example.com'},
		socket: {remoteAddress: '127.0.0.1'},
		...overrides,
	}
}

function response() {
	const headers: Record<string, string | string[]> = {}
	const listeners: Record<string, (() => void)[]> = {}
	const res: HttpResponse & {body: string; headers: typeof headers} = {
		statusCode: 200,
		headers,
		body: '',
		setHeader: (name, value) => {
			headers[name.toLowerCase()] = value
		},
		getHeader: (name) => headers[name.toLowerCase()] as string | undefined,
		writeHead: () => {},
		write: () => true,
		end: (chunk) => {
			res.body = chunk ? String(chunk) : ''
		},
		on: (event, listener) => {
			;(listeners[event] ??= []).push(listener as () => void)
		},
	}
	return res
}

describe('public edge guard', () => {
	let directory: string
	let config: ConfigStore
	let guard: EdgeGuard

	before(async () => {
		directory = await makeTempDir()
		config = new ConfigStore(directory)
		const audit = new AuditLog(directory)
		await audit.start()
		await config.update((draft) => {
			draft.cloudflare.hostname = 'umbrel.example.com'
			draft.cloudflare.enabled = true
			draft.cloudflare.security.loginRateLimitPerMinute = 2
			draft.cloudflare.security.originLock = true
		})
		guard = new EdgeGuard(config, {} as CloudflareManager, audit)
	})
	after(async () => {
		await cleanup(directory)
	})

	it('allows a local request through and records the real IP', async () => {
		let called = false
		const req = request({headers: {host: '192.168.1.10', 'x-forwarded-for': '192.168.1.50'}})
		await guard.handle(req, response(), () => {
			called = true
		})
		assert.equal(called, true)
		assert.equal(req.umbra?.realIp, '192.168.1.50')
	})

	it('refuses public traffic during emergency lockdown', async () => {
		await config.update((draft) => {
			draft.cloudflare.lockdown = true
		})
		const res = response()
		await guard.handle(request(), res, () => {})
		assert.equal(res.statusCode, 503)
		await config.update((draft) => {
			draft.cloudflare.lockdown = false
		})
	})

	it('blocks cross-origin mutations', async () => {
		const res = response()
		await guard.handle(
			request({method: 'POST', path: '/trpc/apps.install', url: '/trpc/apps.install', headers: {host: 'umbrel.example.com', origin: 'https://evil.example'}}),
			res,
			() => {},
		)
		assert.equal(res.statusCode, 403)
	})

	it('accepts a same-origin mutation', async () => {
		let called = false
		const res = response()
		await guard.handle(
			request({method: 'POST', path: '/trpc/apps.install', url: '/trpc/apps.install', headers: {host: 'umbrel.example.com', origin: 'https://umbrel.example.com'}}),
			res,
			() => {
				called = true
			},
		)
		assert.equal(called, true)
		assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains')
	})

	it('rate-limits repeated login attempts', async () => {
		const first = response()
		await guard.handle(request({method: 'POST', path: '/trpc/user.login', url: '/trpc/user.login', headers: {host: 'umbrel.example.com', origin: 'https://umbrel.example.com'}}), first, () => {})
		assert.equal(first.statusCode, 200)
		const second = response()
		await guard.handle(request({method: 'POST', path: '/trpc/user.login', url: '/trpc/user.login', headers: {host: 'umbrel.example.com', origin: 'https://umbrel.example.com'}}), second, () => {})
		const third = response()
		await guard.handle(request({method: 'POST', path: '/trpc/user.login', url: '/trpc/user.login', headers: {host: 'umbrel.example.com', origin: 'https://umbrel.example.com'}}), third, () => {})
		assert.equal(third.statusCode, 429)
	})

	it('requires a Cloudflare Access token on privileged routes when enabled', async () => {
		await config.update((draft) => {
			draft.cloudflare.access.enabled = true
			draft.cloudflare.access.teamDomain = 'team.cloudflareaccess.com'
			draft.cloudflare.access.audience = 'aud'
		})
		const res = response()
		await guard.handle(request({path: '/settings', url: '/settings'}), res, () => {})
		assert.equal(res.statusCode, 403)
		// The public login page stays reachable without Access.
		let called = false
		await guard.handle(request({path: '/login', url: '/login'}), response(), () => {
			called = true
		})
		assert.equal(called, true)
		// Owner-only mutations require Access …
		const install = response()
		await guard.handle(
			request({
				method: 'POST',
				path: '/trpc/apps.install',
				url: '/trpc/apps.install',
				headers: {host: 'umbrel.example.com', origin: 'https://umbrel.example.com'},
			}),
			install,
			() => {},
		)
		assert.equal(install.statusCode, 403)
		// … while member-readable procedures stay on the portal.
		let listCalled = false
		await guard.handle(request({path: '/trpc/apps.list', url: '/trpc/apps.list'}), response(), () => {
			listCalled = true
		})
		assert.equal(listCalled, true)
		// The member App Store flow must be able to bootstrap its CSRF token.
		let sessionCalled = false
		await guard.handle(request({path: '/umbra/api/session', url: '/umbra/api/session'}), response(), () => {
			sessionCalled = true
		})
		assert.equal(sessionCalled, true)
	})
})


