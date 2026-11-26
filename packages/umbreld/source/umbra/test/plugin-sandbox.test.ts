import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import AuditLog from '../audit.js'
import ConfigStore from '../config.js'
import PluginManager from '../plugins.js'
import {cleanup, makeTempDir, makeUmbreld, silentLogger} from './helpers.js'

const manifest = {
	schemaVersion: 1,
	id: 'com.example.backend',
	name: 'Backend',
	version: '1.0.0',
	description: 'Sandboxed backend',
	author: {name: 'Example'},
	license: 'MIT',
	apiVersion: '1.0',
	permissions: ['storage:plugin', 'metrics:read'],
	entry: 'backend/index.js',
	backend: {timeoutMs: 5000},
}

describe('plugin sandbox', () => {
	let directory: string
	let plugins: PluginManager

	before(async () => {
		directory = await makeTempDir()
		const config = new ConfigStore(directory)
		const audit = new AuditLog(directory)
		await audit.start()
		plugins = new PluginManager({
			dataDirectory: directory,
			config,
			audit,
			umbreld: makeUmbreld(directory),
			logger: silentLogger,
		})
		await plugins.start()
	})
	after(async () => {
		await plugins.stop()
		await cleanup(directory)
	})

	it('runs a backend in a permission-restricted process and stops it cleanly', async () => {
		await plugins.install(
			{
				manifest,
				files: [
					{
						path: 'backend/index.js',
						content: [
							'export async function activate(ctx) {',
							"  await ctx.storage.set('activated', true)",
							'  const metrics = await ctx.metrics()',
							"  ctx.log('info', 'plugins=' + metrics.cpus)",
							'}',
							'export async function deactivate() {}',
						].join('\n'),
					},
				],
			},
			{id: '0', name: 'Owner'},
		)
		const enabled = await plugins.enable('com.example.backend', {id: '0', name: 'Owner'})
		assert.equal(enabled.enabled, true)
		assert.equal(enabled.running, true)
		await plugins.disable('com.example.backend', {id: '0', name: 'Owner'})
		const disabled = await plugins.get('com.example.backend')
		assert.equal(disabled.running, false)
	})
})
