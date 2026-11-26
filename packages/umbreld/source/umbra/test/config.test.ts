import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import ConfigStore, {defaultConfig, isValidHostname, normalizeConfig} from '../config.js'
import {cleanup, makeTempDir} from './helpers.js'

describe('config', () => {
	let directory: string

	before(async () => {
		directory = await makeTempDir()
	})
	after(async () => {
		await cleanup(directory)
	})

	it('starts from safe defaults', async () => {
		const store = new ConfigStore(directory)
		const config = await store.load()
		assert.equal(config.version, 1)
		assert.equal(config.cloudflare.enabled, false)
		assert.equal(config.cloudflare.lockdown, false)
		assert.deepEqual(config.terminal.allowedRoots, [])
		assert.equal(config.access.defaultPolicy, 'request')
	})

	it('persists updates atomically with 0600 permissions', async () => {
		const store = new ConfigStore(directory)
		await store.load()
		await store.update((draft) => {
			draft.cloudflare.hostname = 'umbrel.example.com'
			draft.terminal.enabled = false
		})
		const raw = await readFile(path.join(directory, 'config.json'), 'utf8')
		assert.match(raw, /umbrel\.example\.com/)
		const reloaded = await new ConfigStore(directory).load()
		assert.equal(reloaded.terminal.enabled, false)
	})

	it('drops unknown and malformed values instead of trusting them', () => {
		const normalized = normalizeConfig({
			version: 1,
			cloudflare: {hostname: 'not a hostname', enabled: 'yes', access: {allowedEmails: ['a@b.c', 42]}},
			terminal: {defaultTimeoutMs: 1, maxOutputBytes: 99999999},
			access: {requests: [{id: 'x', appId: 'a', appName: 'A', userId: '1', userName: 'U', status: 'bogus'}]},
			__proto__: {polluted: true},
		})
		assert.equal(normalized.cloudflare.enabled, false)
		assert.equal(normalized.cloudflare.hostname, '')
		assert.deepEqual(normalized.cloudflare.access.allowedEmails, ['a@b.c'])
		assert.equal(normalized.terminal.defaultTimeoutMs, 1000)
		assert.equal(normalized.terminal.maxOutputBytes, 1_000_000)
		assert.equal(normalized.access.requests[0].status, 'pending')
	})

	it('validates hostnames and rejects .local', () => {
		assert.equal(isValidHostname('umbrel.example.com'), true)
		assert.equal(isValidHostname('umbrel.iagsoftware.org'), true)
		assert.equal(isValidHostname('localhost'), false)
		assert.equal(isValidHostname('umbrel.local'), false)
		assert.equal(isValidHostname('https://example.com'), false)
	})

	it('serializes concurrent updates without losing writes', async () => {
		const store = new ConfigStore(await makeTempDir())
		await store.load()
		await Promise.all(
			Array.from({length: 20}, (_, index) =>
				store.update((draft) => {
					draft.access.requests.push({
						id: `r${index}`,
						appId: 'app',
						appName: 'App',
						userId: '1',
						userName: 'A',
						status: 'pending',
						createdAt: Date.now(),
					})
				}),
			),
		)
		const config = await new ConfigStore(path.dirname(store.filePath)).load()
		assert.equal(config.access.requests.length, 20)
	})

	it('default config is independent per call', () => {
		const first = defaultConfig()
		first.cloudflare.hostname = 'x.example.com'
		assert.equal(defaultConfig().cloudflare.hostname, '')
	})
})
