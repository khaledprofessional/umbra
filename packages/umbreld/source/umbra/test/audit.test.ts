import assert from 'node:assert/strict'
import {readdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import AuditLog from '../audit.ts'
import {cleanup, makeTempDir} from './helpers.ts'

describe('audit log', () => {
	let directory: string
	let audit: AuditLog

	before(async () => {
		directory = await makeTempDir()
		audit = new AuditLog(directory)
		await audit.start()
	})
	after(async () => {
		await cleanup(directory)
	})

	it('records a chained entry with redacted detail', async () => {
		const entry = audit.record({
			type: 'terminal.executed',
			action: 'Ran a command',
			actor: {type: 'agent', id: 'a'.repeat(32), name: 'Test agent', ip: '203.0.113.9'},
			target: '/home/umbrel',
			detail: {command: 'echo hi', authorization: 'Bearer secret-token-value', password: 'hunter2'},
		})
		assert.equal(entry.seq, 1)
		assert.equal(entry.prev, '0'.repeat(64))
		assert.match(entry.hash, /^[0-9a-f]{64}$/)
		assert.equal((entry.detail as Record<string, unknown>).password, '[redacted]')
		assert.doesNotMatch(JSON.stringify(entry.detail), /secret-token-value/)
		assert.equal(entry.ip, '203.0.113.9')
		await audit.flush()
	})

	it('queries with filters and pagination', async () => {
		for (let index = 0; index < 5; index++) {
			audit.record({
				type: index % 2 === 0 ? 'mcp.tool' : 'terminal.request',
				action: `Action ${index}`,
				actor: {type: 'agent', id: 'agent1', name: 'Agent'},
				outcome: index === 4 ? 'denied' : 'success',
			})
		}
		await audit.flush()
		const filtered = await audit.query({type: 'mcp.tool', limit: 10})
		assert.equal(filtered.events.length, 3)
		const denied = await audit.query({outcome: 'denied'})
		assert.equal(denied.events.length, 1)
		const firstPage = await audit.query({limit: 2})
		assert.equal(firstPage.events.length, 2)
		assert.ok(firstPage.nextCursor)
		const secondPage = await audit.query({limit: 2, before: firstPage.nextCursor!})
		assert.equal(secondPage.events.length, 2)
		assert.ok(secondPage.events[0].seq < firstPage.events[0].seq)
	})

	it('verifies the hash chain', async () => {
		const result = await audit.verify()
		assert.equal(result.ok, true)
		assert.ok(result.entries >= 6)
	})

	it('detects a modified entry', async () => {
		const files = (await readdir(audit.directory)).filter((file) => file.endsWith('.jsonl')).sort()
		const latest = path.join(audit.directory, files.at(-1)!)
		const text = await readFile(latest, 'utf8')
		const lines = text.split('\n').filter(Boolean)
		const parsed = JSON.parse(lines[0])
		parsed.action = 'Tampered action'
		lines[0] = JSON.stringify(parsed)
		await writeFile(latest, `${lines.join('\n')}\n`)
		const result = await audit.verify()
		assert.equal(result.ok, false)
		assert.match(result.error ?? '', /modified|chain/i)
	})

	it('fingerprints and exports the log', async () => {
		const fingerprint = await audit.fingerprint()
		assert.match(fingerprint, /^[0-9a-f]{64}$/)
		const exported = await audit.exportRange(1, 3)
		assert.equal(exported.length, 3)
		assert.deepEqual(
			exported.map((entry) => entry.seq),
			[1, 2, 3],
		)
	})
})
