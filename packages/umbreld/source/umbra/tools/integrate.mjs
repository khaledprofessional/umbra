#!/usr/bin/env node
/**
 * Idempotent Umbra integration doctor.
 *
 * The custom layer is designed so upstream files carry only tiny, marked
 * bridges. This script applies those bridges to a pristine upstream checkout
 * (or re-applies them after an official OTA replaced /opt/umbreld) by anchor,
 * never by line number. Running it twice changes nothing.
 *
 * Usage:
 *   node tools/integrate.mjs --repo /opt/umbreld --data /home/umbrel/umbrel
 *   node tools/integrate.mjs --repo . --check
 */
import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
	const args = {repo: path.resolve(HERE, '../../..'), data: undefined, check: false, quiet: false, from: undefined}
	for (let index = 2; index < argv.length; index++) {
		const value = argv[index]
		if (value === '--repo') args.repo = path.resolve(argv[++index])
		else if (value === '--data') args.data = path.resolve(argv[++index])
		else if (value === '--from') args.from = path.resolve(argv[++index])
		else if (value === '--check') args.check = true
		else if (value === '--quiet') args.quiet = true
		else if (value === '--help') {
			console.log(
				'Usage: node tools/integrate.mjs [--repo <umbreld>] [--data <umbra data>] [--from <runtime>] [--check]',
			)
			process.exit(0)
		}
	}
	return args
}

const args = parseArgs(process.argv)
const log = args.quiet ? () => {} : (...values) => console.log('umbra:', ...values)

const TS_BLOCKS = {
	import: {
		file: 'source/index.ts',
		anchor: "import Mcp, {type McpStoreSettings} from './modules/mcp/mcp.js'",
		block: "// <umbra:import>\nimport Umbra from './umbra/index.js'\n// </umbra:import>",
	},
	property: {
		file: 'source/index.ts',
		anchor: '\tmcp: Mcp\n\tphotos: Photos',
		replacement: '\tmcp: Mcp\n\t// <umbra:property>\n\tumbra: Umbra\n\t// </umbra:property>\n\tphotos: Photos',
		block: '\t// <umbra:property>\n\tumbra: Umbra\n\t// </umbra:property>',
	},
	construct: {
		file: 'source/index.ts',
		anchor: '\t\tthis.mcp = new Mcp(this)',
		block: [
			'\t\t// <umbra:construct>',
			'\t\t// Constructed after MCP so the custom layer can attach tools and observe requests.',
			'\t\tthis.umbra = new Umbra({umbreld: this})',
			'\t\t// </umbra:construct>',
		].join('\n'),
	},
	start: {
		file: 'source/index.ts',
		anchor: '\t\t// Account deletion spans several modules.',
		block: [
			'\t\t// <umbra:start>',
			'\t\t// Start the custom layer once core modules and the HTTP listener exist.',
			'\t\t// Failures stay contained: a broken plugin or tunnel must never stop umbrelOS.',
			"\t\tawait this.umbra.start().catch((error) => this.logger.error('Failed to start Umbra', error))",
			'\t\t// </umbra:start>',
		].join('\n'),
		position: 'before',
	},
	stop: {
		file: 'source/index.ts',
		anchor: '\t\t\t\tthis.mcp.stop(),',
		block: '\t\t\t\t// <umbra:stop>\n\t\t\t\tthis.umbra.stop(),\n\t\t\t\t// </umbra:stop>',
	},
	serverEdge: {
		file: 'source/modules/server/index.ts',
		anchor: "\t\tthis.app.set('logger', this.logger)",
		block: [
			'\t\t// <umbra:server-edge>',
			'\t\t// Public-edge policy: real IP, lockdown, Cloudflare Access, origin lock, rate limits.',
			'\t\tthis.app.use(this.umbreld.umbra.edgeMiddleware())',
			'\t\t// <umbra:server-apps>',
			'\t\tthis.app.use(this.umbreld.umbra.appProxyMiddleware())',
			'\t\t// </umbra:server-apps>',
			'\t\t// </umbra:server-edge>',
		].join('\n'),
	},
	serverRouter: {
		file: 'source/modules/server/index.ts',
		anchor: "\t\tthis.app.use('/mcp', this.umbreld.mcp.router)",
		block:
			"\t\t// <umbra:server-router>\n\t\tthis.app.use('/umbra', this.umbreld.umbra.router)\n\t\t// </umbra:server-router>",
	},
	serverUpgrade: {
		file: 'source/modules/server/index.ts',
		anchor: "\t\t\t\tconst ticket = searchParams.get('ticket')",
		block: [
			'\t\t\t\t// <umbra:server-upgrade>',
			'\t\t\t\tconst umbraUpgrade = await this.umbreld.umbra.edge.authorizeUpgrade(request)',
			'\t\t\t\tif (!umbraUpgrade.ok) throw new Error(umbraUpgrade.message)',
			'\t\t\t\t// </umbra:server-upgrade>',
		].join('\n'),
		position: 'before',
	},
	mcpTools: {
		file: 'source/modules/mcp/server.ts',
		anchor: '\tregisterMachineTools(server, context, permissions)\n\treturn server',
		replacement: [
			'\tregisterMachineTools(server, context, permissions)',
			'\t// <umbra:mcp-tools>',
			'\tawait umbreld.umbra.registerMcpTools(server, context, permissions).catch((error) => {',
			"\t\tumbreld.mcp.logger.error('Failed to register Umbra MCP tools', error)",
			'\t})',
			'\t// </umbra:mcp-tools>',
			'\treturn server',
		].join('\n'),
		block:
			"\t// <umbra:mcp-tools>\n\tawait umbreld.umbra.registerMcpTools(server, context, permissions).catch((error) => {\n\t\tumbreld.mcp.logger.error('Failed to register Umbra MCP tools', error)\n\t})\n\t// </umbra:mcp-tools>",
		position: 'before',
	},
	mcpObserve: {
		file: 'source/modules/mcp/server.ts',
		anchor: '\t\t\tumbreld.mcp.recordRequest(tokenId, body)',
		block:
			'\t\t\t// <umbra:mcp-observe>\n\t\t\tvoid umbreld.umbra.observeMcpRequest(tokenId, body, (request as {umbra?: {realIp?: string}}).umbra?.realIp)\n\t\t\t// </umbra:mcp-observe>',
	},
	preUpdate: {
		file: 'source/modules/system/update.ts',
		anchor: "setUpdateStatus({running: true, progress: 0, description: 'Updating...', error: false})",
		block: [
			'\t// <umbra:pre-update>',
			'\t// Capture the custom configuration before the A/B update replaces root.',
			"\tawait umbreld.umbra?.snapshots.create('pre-os-update', {type: 'system', id: 'os-update'}).catch((error) => umbreld.logger.error('Pre-update snapshot failed', error))",
			'\t// </umbra:pre-update>',
		].join('\n'),
		position: 'before',
	},
	appScript: {
		file: 'source/modules/apps/legacy-compat/app-script',
		anchor:
			'  if [[ -f "${user_settings_compose_file}" ]]; then\n    compose_files+=( "--file" "${user_settings_compose_file}" )\n  fi',
		replacement: [
			'  if [[ -f "${user_settings_compose_file}" ]]; then',
			'    compose_files+=( "--file" "${user_settings_compose_file}" )',
			'  fi',
			'',
			'  # <umbra:app-script>',
			'  # Persistent user overrides live outside the app directory so updates cannot erase them.',
			'  local -r umbra_quota_override="${UMBREL_ROOT}/umbra/app-overrides/${app}/docker-compose.override.yml"',
			'  local -r umbra_custom_override="${UMBREL_ROOT}/umbra/app-overrides/${app}/docker-compose.umbra-custom.yml"',
			'  if [[ -f "${umbra_quota_override}" ]]; then',
			'    compose_files+=( "--file" "${umbra_quota_override}" )',
			'  fi',
			'  if [[ -f "${umbra_custom_override}" ]]; then',
			'    compose_files+=( "--file" "${umbra_custom_override}" )',
			'  fi',
			'  # </umbra:app-script>',
		].join('\n'),
		block:
			'  # <umbra:app-script>\n  # Persistent user overrides live outside the app directory so updates cannot erase them.\n  local -r umbra_quota_override="${UMBREL_ROOT}/umbra/app-overrides/${app}/docker-compose.override.yml"\n  local -r umbra_custom_override="${UMBREL_ROOT}/umbra/app-overrides/${app}/docker-compose.umbra-custom.yml"\n  if [[ -f "${umbra_quota_override}" ]]; then\n    compose_files+=( "--file" "${umbra_quota_override}" )\n  fi\n  if [[ -f "${umbra_custom_override}" ]]; then\n    compose_files+=( "--file" "${umbra_custom_override}" )\n  fi\n  # </umbra:app-script>',
	},
}

function markerPattern(name) {
	return new RegExp(`[ \\t]*${escapeRegExp(`<umbra:${name}>`)}[\\s\\S]*?${escapeRegExp(`</umbra:${name}>`)}`, 'm')
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indentBlock(block, indent) {
	return block
		.split('\n')
		.map((line) => (line.trim() ? `${indent}${line.replace(/^\t+/, '')}` : line))
		.join('\n')
}

async function applyPatch(patch, {check}) {
	const filePath = path.join(args.repo, patch.file)
	if (!existsSync(filePath)) return {ok: false, changed: false, reason: `missing file ${patch.file}`}
	let contents = await readFile(filePath, 'utf8')
	// Upstream files are LF; normalize a Windows checkout so anchors match and
	// the patched shell script keeps working on the device.
	contents = contents.replace(/\r\n/g, '\n')
	const pattern = markerPattern(patch.marker ?? patchName(patch))
	const hasMarker = pattern.test(contents)
	if (hasMarker) {
		if (check) return {ok: true, changed: false}
		contents = contents.replace(pattern, patch.block)
		await writeFile(filePath, contents)
		return {ok: true, changed: true}
	}
	if (patch.replacement && contents.includes(patch.replacement.split('\n').slice(0, 3).join('\n'))) {
		// Already in the upstream-shaped form without markers: leave it alone only
		// if the marked block is already present (handled above).
	}
	if (!contents.includes(patch.anchor)) {
		return {ok: false, changed: false, reason: `anchor not found in ${patch.file}`}
	}
	if (check) return {ok: false, changed: true, reason: `integration missing in ${patch.file}`}
	// Insert after the anchor's full statement. For multi-line anchors, use the
	// anchor text itself, then add the block, preserving indentation.
	const anchorIndex = contents.indexOf(patch.anchor)
	const anchorEnd = anchorIndex + patch.anchor.length
	const before = contents.slice(0, anchorEnd)
	const after = contents.slice(anchorEnd)
	const block = patch.position === 'before' ? `${patch.block}\n${patch.anchor}` : `${patch.anchor}\n${patch.block}`
	contents =
		patch.position === 'before'
			? before.slice(0, anchorIndex) + `${patch.block}\n` + patch.anchor + after
			: before + `\n${patch.block}` + after
	if (patch.file.endsWith('.ts')) {
		// No reformat: the blocks already carry the repository's tab indentation.
	}
	await writeFile(filePath, contents, 'utf8')
	return {ok: true, changed: true}
}

function patchName(patch) {
	for (const [name, value] of Object.entries(TS_BLOCKS)) if (value === patch) return name
	return 'unknown'
}

async function copyRuntime() {
	if (!args.data) return {copied: false}
	const source = args.from ?? path.join(args.repo, 'source', 'umbra')
	if (!existsSync(source)) return {copied: false, reason: 'runtime source missing'}
	// After a stock OTA, /opt/umbreld/source/umbra is gone. Restore it from the
	// persistent copy before the bridge import is added, otherwise umbreld
	// would fail to resolve ./umbra/index.js at boot.
	const repoRuntime = path.join(args.repo, 'source', 'umbra')
	if (!existsSync(repoRuntime)) {
		await mkdir(path.dirname(repoRuntime), {recursive: true})
		await import('node:fs/promises').then((fs) => fs.cp(source, repoRuntime, {recursive: true, force: true}))
	}
	const destination = path.join(args.data, 'umbra', 'runtime')
	if (path.resolve(source) === path.resolve(destination)) return {copied: false, reason: 'already persistent'}
	const relative = path.relative(destination, source)
	if (relative && !relative.startsWith('..')) return {copied: false, reason: 'source is inside the destination'}
	const reverse = path.relative(source, destination)
	if (reverse && !reverse.startsWith('..')) return {copied: false, reason: 'destination is inside the source'}
	await mkdir(path.dirname(destination), {recursive: true})
	await import('node:fs/promises').then((fs) => fs.rm(destination, {recursive: true, force: true}))
	await import('node:fs/promises').then((fs) => fs.cp(source, destination, {recursive: true, force: true}))
	// The runtime is code, not a data directory; make it readable/executable by root.
	return {copied: true, destination}
}

const patches = new Map(Object.entries(TS_BLOCKS))
let failures = 0
let changes = 0
const results = []
for (const [name, patch] of patches) {
	patch.marker = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
	const result = await applyPatch(patch, {check: args.check})
	results.push({name, file: patch.file, ...result})
	if (!result.ok) failures++
	if (result.changed) changes++
	if (result.ok && result.changed) log(`applied ${name} -> ${patch.file}`)
}
if (args.check) {
	if (changes || failures) {
		console.error(`umbra: integration is incomplete (${changes} change(s), ${failures} failure(s))`)
		for (const result of results.filter((entry) => !entry.ok || entry.changed)) {
			console.error(`  ${result.name}: ${result.reason ?? 'missing'}`)
		}
		process.exit(1)
	}
	log('integration is complete')
	process.exit(0)
}
if (args.data) {
	const copy = await copyRuntime()
	if (copy.copied) log(`runtime copied to ${copy.destination}`)
	else if (copy.reason) log(`runtime not copied: ${copy.reason}`)
}
if (failures) {
	console.error(`umbra: ${failures} patch(es) could not be applied`)
	for (const result of results.filter((entry) => !entry.ok)) console.error(`  ${result.name}: ${result.reason}`)
	process.exit(1)
}
log(`integration up to date (${changes} patch(es) applied)`)
