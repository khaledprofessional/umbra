import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
	scaffoldPlugin,
	validateManifest,
	validatePluginFiles,
	validateSettings,
	type PluginManifest,
} from '../plugin-manifest.ts'

const base: PluginManifest = {
	schemaVersion: 1,
	id: 'com.example.weather',
	name: 'Weather',
	version: '1.2.3',
	description: 'A weather widget',
	author: {name: 'Example'},
	license: 'MIT',
	apiVersion: '1.0' as const,
	permissions: ['metrics:read', 'ui:widget'],
	entry: 'backend/index.js',
	backend: {events: ['apps:state:change'], timeoutMs: 3000},
	ui: {widgets: [{id: 'now', title: 'Weather now', size: 'small'}]},
	settings: [
		{key: 'city', label: 'City', type: 'string', default: 'Oslo'},
		{
			key: 'units',
			label: 'Units',
			type: 'select',
			options: [
				{label: 'Metric', value: 'c'},
				{label: 'Imperial', value: 'f'},
			],
		},
	],
}

describe('plugin manifest', () => {
	it('accepts a strict, well-formed manifest', () => {
		const result = validateManifest(base)
		assert.equal(result.ok, true)
		assert.equal(result.manifest?.id, base.id)
		assert.match(result.manifestHash ?? '', /^[0-9a-f]{64}$/)
	})

	it('rejects unknown permissions and bad ids', () => {
		const result = validateManifest({...base, id: 'Weather', permissions: ['root:everything']})
		assert.equal(result.ok, false)
		assert.ok(result.errors.some((error) => error.includes('reverse-DNS')))
		assert.ok(result.errors.some((error) => error.includes('Unknown permission')))
	})

	it('rejects path traversal in the entry', () => {
		const result = validateManifest({...base, entry: '../../etc/passwd'})
		assert.equal(result.ok, false)
	})

	it('rejects unknown fields at every level', () => {
		const top = validateManifest({...base, surprise: true})
		assert.equal(top.ok, false)
		assert.ok(top.errors.some((error) => error.includes("unknown field 'surprise'")))
		const nested = validateManifest({...base, ui: {widgets: [{id: 'x', title: 'X', size: 'small', evil: true}]}})
		assert.equal(nested.ok, false)
		assert.ok(nested.errors.some((error) => error.includes("unknown field 'evil'")))
	})

	it('validates file lists against the manifest', () => {
		assert.deepEqual(validatePluginFiles([{path: 'backend/index.js', content: 'export {}'}], base), [])
		assert.ok(validatePluginFiles([{path: '../escape.js', content: 'x'}], base).length > 0)
		assert.ok(
			validatePluginFiles([{path: 'other.js', content: 'x'}], base).some((error) => error.includes('Entry file')),
		)
	})

	it('applies setting defaults and enforces option values', () => {
		const values = validateSettings(base as never, {})
		assert.equal(values.ok, true)
		assert.equal(values.values.city, 'Oslo')
		const bad = validateSettings(base as never, {units: 'kelvin'})
		assert.equal(bad.ok, false)
	})

	it('scaffolds a manifest that validates', () => {
		const {manifest, files} = scaffoldPlugin({
			id: 'com.example.hello',
			name: 'Hello',
			withBackend: true,
			withWidget: true,
			withRoute: true,
		})
		const validation = validateManifest(manifest)
		assert.equal(validation.ok, true)
		assert.ok(files.some((file) => file.path === 'backend/index.js'))
		assert.ok(files.some((file) => file.path === 'ui/index.html'))
		assert.deepEqual(validatePluginFiles(files, manifest), [])
	})
})
