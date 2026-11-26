import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import AuditLog from '../audit.ts'
import ConfigStore from '../config.ts'
import PluginManager from '../plugins.ts'
import {cleanup, makeTempDir, makeUmbreld, silentLogger} from './helpers.ts'

const manifest = {
	schemaVersion: 1,
	id: 'com.example.hello',
	name: 'Hello',
	version: '1.0.0',
	description: 'Hello widget',
	author: {name: 'Example'},
	license: 'MIT',
	apiVersion: '1.0',
	permissions: ['ui:widget', 'metrics:read'],
	ui: {widgets: [{id: 'hello', title: 'Hello', size: 'small'}]},
}

describe('plugin lifecycle', () => {
	let directory: string
	let config: ConfigStore
	let plugins: PluginManager

	before(async () => {
		directory = await makeTempDir()
		config = new ConfigStore(directory)
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

	it('installs a validated UI-only plugin disabled by default', async () => {
		const installed = await plugins.install(
			{manifest, files: [{path: 'ui/index.html', content: '<h1>Hello</h1>'}]},
			{id: '0', name: 'Owner'},
		)
		assert.equal(installed.id, 'com.example.hello')
		assert.equal(installed.enabled, false)
		assert.equal(installed.manifest?.version, '1.0.0')
	})

	it('rejects traversal and invalid manifests', async () => {
		await assert.rejects(
			() =>
				plugins.install(
					{manifest: {...manifest, id: 'com.example.evil'}, files: [{path: '../escape.js', content: 'x'}]},
					{id: '0', name: 'Owner'},
				),
			/Unsafe file path/,
		)
		await assert.rejects(
			() => plugins.install({manifest: {...manifest, permissions: ['root']}, files: []}, {id: '0'}),
			/Invalid manifest/,
		)
	})

	it('enables, exposes widgets, and disables without a backend', async () => {
		await plugins.enable('com.example.hello', {id: '0', name: 'Owner'})
		const widgets = await plugins.widgets()
		assert.equal(widgets.length, 1)
		assert.equal((widgets[0] as {pluginId: string}).pluginId, 'com.example.hello')
		await plugins.disable('com.example.hello', {id: '0', name: 'Owner'})
		assert.equal((await plugins.widgets()).length, 0)
	})

	it('refuses to serve an unknown UI file', async () => {
		await assert.rejects(() => plugins.uiFile('com.example.hello', '../umbra-plugin.json'), /not found|Not found/i)
	})

	it('uninstalls and removes its record', async () => {
		await plugins.uninstall('com.example.hello', {id: '0', name: 'Owner'})
		assert.equal((await plugins.list()).length, 0)
	})
})
