import assert from 'node:assert/strict'
import http from 'node:http'
import {after, before, describe, it} from 'node:test'

import AppPathProxy from '../app-proxy.js'
import type {HttpRequest, HttpResponse, UmbrelLike} from '../types.js'
import {makeApp, makeUmbreld, makeTempDir, cleanup} from './helpers.js'

function response() {
	const headers: Record<string, string | string[]> = {}
	let resolveEnd!: () => void
	const ended = new Promise<void>((resolve) => {
		resolveEnd = resolve
	})
	const res: HttpResponse & {body: string; ended: Promise<void>; headers: typeof headers} = {
		statusCode: 200,
		headers,
		body: '',
		ended,
		setHeader: (name, value) => {
			headers[name.toLowerCase()] = value
		},
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
	}
	return res
}

function req(path: string): HttpRequest {
	return {
		method: 'GET',
		url: path,
		path,
		headers: {host: 'umbrel.example.com', cookie: 'UMBREL_BROWSER_SESSION=owner'},
		socket: {remoteAddress: '127.0.0.1'},
		umbra: {realIp: '203.0.113.5', viaCloudflare: true, publicRequest: true, startedAt: Date.now()},
	}
}

describe('single-subdomain app path proxy', () => {
	let directory: string
	let upstream: http.Server
	let port: number
	let proxy: AppPathProxy

	before(async () => {
		directory = await makeTempDir()
		upstream = http.createServer((_request, res) => {
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.setHeader('set-cookie', 'app_session=1; Path=/; HttpOnly')
			res.end('<html><head><title>App</title></head><body><script src="/app.js"></script><a href="/next">Next</a></body></html>')
		})
		await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
		port = (upstream.address() as {port: number}).port
		const umbreld = makeUmbreld(directory, [makeApp('demo', `${directory}/demo`)]) as UmbrelLike
		umbreld.apps.getApp = () => ({
			...makeApp('demo', `${directory}/demo`),
			readManifest: async () => ({id: 'demo', name: 'Demo', version: '1.0.0', port}),
		})
		proxy = new AppPathProxy(umbreld, {} as never)
	})
	after(async () => {
		await new Promise<void>((resolve) => upstream.close(() => resolve()))
		await cleanup(directory)
	})

	it('rewrites HTML, cookies, and the base path', async () => {
		const res = response()
		proxy.middleware()(req('/apps/demo/'), res, () => {})
		await res.ended
		assert.equal(res.statusCode, 200)
		assert.match(res.body, /<base href="\/apps\/demo\/">/)
		assert.match(res.body, /src="\/apps\/demo\/app.js"/)
		assert.match(res.body, /href="\/apps\/demo\/next"/)
		assert.match(String(res.headers['set-cookie']), /Path=\/apps\/demo\//)
	})

	it('rejects a member who does not have the app shared', async () => {
		const umbreld = makeUmbreld(directory, [makeApp('demo', `${directory}/demo`)]) as UmbrelLike
		umbreld.auth.authenticate = async () => ({sessionId: 's', accountId: '2', actor: 'account'})
		const isolated = new AppPathProxy(umbreld, {} as never)
		const res = response()
		isolated.middleware()(req('/apps/demo/'), res, () => {})
		await res.ended
		assert.equal(res.statusCode, 403)
	})

	it('passes non-app paths to the next middleware', () => {
		let called = false
		proxy.middleware()(req('/settings'), response(), () => {
			called = true
		})
		assert.equal(called, true)
	})
})
