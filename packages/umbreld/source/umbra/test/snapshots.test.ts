import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import AuditLog from '../audit.js'
import ConfigStore from '../config.js'
import {SnapshotManager} from '../extras.js'
import SecretStore from '../secrets.js'
import {cleanup, makeApp, makeTempDir, makeUmbreld, silentLogger} from './helpers.js'

describe('encrypted configuration snapshots', () => {
	let directory: string
	let config: ConfigStore
	let snapshots: SnapshotManager

	before(async () => {
		directory = await makeTempDir()
		const secrets = new SecretStore(directory)
		const audit = new AuditLog(directory)
		await secrets.start()
		await audit.start()
		config = new ConfigStore(path.join(directory, 'umbra'))
		await config.update((draft) => {
			draft.cloudflare.hostname = 'umbrel.example.com'
		})
		await mkdir(path.join(directory, 'app-data', 'plex'), {recursive: true})
		await writeFile(path.join(directory, 'umbrel.yaml'), 'version: 2.0.1\n')
		await writeFile(path.join(directory, 'app-data', 'plex', 'settings.yml'), 'auth:\n  enabled: true\n')
		const umbreld = makeUmbreld(directory, [makeApp('plex', path.join(directory, 'app-data', 'plex'))])
		snapshots = new SnapshotManager({
			dataDirectory: directory,
			config,
			secrets,
			audit,
			umbreld,
			logger: silentLogger,
		})
	})
	after(async () => {
		await cleanup(directory)
	})

	it('creates an encrypted, device-bound snapshot', async () => {
		const summary = await snapshots.create('manual', {type: 'user', id: '0', name: 'Owner'})
		assert.equal(summary.reason, 'manual')
		const raw = await readFile(path.join(snapshots.directory, `${summary.id}.usnap.json`), 'utf8')
		assert.doesNotMatch(raw, /umbrel\.example\.com/)
		assert.match(raw, /aes-256-gcm/)
		const list = await snapshots.list()
		assert.equal(list.length, 1)
	})

	it('restores Umbra-managed configuration and reports skipped files', async () => {
		const [snapshot] = await snapshots.list()
		await config.update((draft) => {
			draft.cloudflare.hostname = 'changed.example.com'
		})
		const result = await snapshots.restore(snapshot.id, {id: '0', name: 'Owner'})
		assert.ok(result.restored.includes('umbra/config.json'))
		assert.ok(result.skipped.includes('umbrel.yaml'))
		const restored = JSON.parse(await readFile(path.join(directory, 'umbra', 'config.json'), 'utf8'))
		assert.equal(restored.cloudflare.hostname, 'umbrel.example.com')
	})

	it('supports passphrase snapshots and rejects the wrong passphrase', async () => {
		const summary = await snapshots.create('manual', {type: 'user', id: '0'}, 'correct horse battery staple')
		assert.equal(summary.encryptedWith, 'passphrase')
		await assert.rejects(
			() => snapshots.restore(summary.id, {id: '0'}, 'wrong passphrase value'),
			/could not be decrypted/i,
		)
		const result = await snapshots.restore(summary.id, {id: '0'}, 'correct horse battery staple')
		assert.ok(result.restored.length > 0)
	})
})
