import {createHash} from 'node:crypto'

import {isRecord, stableJson} from './util.js'

export const PLUGIN_API_VERSION = '1.0'
export const MAX_PLUGIN_FILES = 200
export const MAX_PLUGIN_BYTES = 5 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const PLUGIN_PERMISSIONS = [
	'metrics:read',
	'docker:read',
	'apps:read',
	'storage:plugin',
	'notifications:write',
	'events:subscribe',
	'ui:widget',
	'ui:route',
	'ui:settings',
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export type PluginWidget = {
	id: string
	title: string
	description?: string
	size: 'small' | 'medium' | 'large'
	refreshSeconds?: number
}

export type PluginRoute = {
	id: string
	title: string
	icon?: string
	entry: string
}

export type PluginSettingField = {
	key: string
	label: string
	type: 'string' | 'number' | 'boolean' | 'select'
	default?: string | number | boolean
	description?: string
	options?: {label: string; value: string}[]
	min?: number
	max?: number
}

export type PluginManifest = {
	schemaVersion: 1
	id: string
	name: string
	version: string
	description: string
	author: {name: string; url?: string}
	license: string
	apiVersion: typeof PLUGIN_API_VERSION
	entry?: string
	permissions: PluginPermission[]
	backend?: {
		events?: string[]
		timeoutMs?: number
	}
	ui?: {
		widgets?: PluginWidget[]
		routes?: PluginRoute[]
		settingsPanels?: PluginRoute[]
	}
	settings?: PluginSettingField[]
}

export type PluginFile = {path: string; content: string; encoding?: 'utf8' | 'base64'}

export type PluginValidation = {
	ok: boolean
	errors: string[]
	manifest?: PluginManifest
	manifestHash?: string
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)+$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const PATH_PATTERN = /^(?![./])(?!.*\.\.)[A-Za-z0-9._/-]{1,180}$/

export function manifestHash(manifest: PluginManifest): string {
	return createHash('sha256').update(stableJson(manifest)).digest('hex')
}

function fail(errors: string[], message: string) {
	errors.push(message)
}

function validatePath(value: unknown, label: string, errors: string[], {mustBeFile = true} = {}): string | undefined {
	if (typeof value !== 'string' || !PATH_PATTERN.test(value)) {
		fail(errors, `${label} must be a safe relative path`)
		return undefined
	}
	if (mustBeFile && value.endsWith('/')) {
		fail(errors, `${label} must name a file`)
		return undefined
	}
	return value
}

export function validateManifest(input: unknown): PluginValidation {
	const errors: string[] = []
	if (!isRecord(input)) return {ok: false, errors: ['Manifest must be a JSON object']}
	if (input.schemaVersion !== 1) fail(errors, 'schemaVersion must be 1')
	if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
		fail(errors, 'id must be a reverse-DNS identifier, e.g. com.example.weather')
	}
	if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 60) {
		fail(errors, 'name must be 1-60 characters')
	}
	if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
		fail(errors, 'version must be semver, e.g. 1.2.0')
	}
	if (typeof input.description !== 'string' || input.description.length > 500) {
		fail(errors, 'description must be at most 500 characters')
	}
	if (!isRecord(input.author) || typeof input.author.name !== 'string' || !input.author.name.trim()) {
		fail(errors, 'author.name is required')
	} else if (input.author.url !== undefined && !/^https:\/\//.test(String(input.author.url))) {
		fail(errors, 'author.url must be https')
	}
	if (typeof input.license !== 'string' || !input.license.trim()) fail(errors, 'license is required')
	if (input.apiVersion !== PLUGIN_API_VERSION) fail(errors, `apiVersion must be ${PLUGIN_API_VERSION}`)

	if (!Array.isArray(input.permissions)) {
		fail(errors, 'permissions must be an array')
	}
	const permissions: PluginPermission[] = []
	if (Array.isArray(input.permissions)) {
		for (const permission of input.permissions) {
			if (typeof permission !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)) {
				fail(errors, `Unknown permission: ${String(permission)}`)
				continue
			}
			if (!permissions.includes(permission as PluginPermission)) permissions.push(permission as PluginPermission)
		}
	}

	let entry: string | undefined
	if (input.entry !== undefined) {
		entry = validatePath(input.entry, 'entry', errors)
		if (entry && !/\.(?:mjs|js)$/.test(entry)) fail(errors, 'entry must be a .js or .mjs file')
	}

	let backend: PluginManifest['backend']
	if (input.backend !== undefined) {
		if (!isRecord(input.backend)) fail(errors, 'backend must be an object')
		else {
			const events = input.backend.events
			if (events !== undefined && (!Array.isArray(events) || events.some((event) => typeof event !== 'string'))) {
				fail(errors, 'backend.events must be an array of strings')
			}
			const timeoutMs = input.backend.timeoutMs
			if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs < 500 || timeoutMs > 30_000)) {
				fail(errors, 'backend.timeoutMs must be 500-30000')
			}
			backend = {
				...(Array.isArray(events) ? {events: [...new Set(events as string[])].slice(0, 20)} : {}),
				...(typeof timeoutMs === 'number' ? {timeoutMs} : {}),
			}
		}
	}
	if (entry && !permissions.length) {
		// Backend code with no permissions is fine (UI logic only), but a sandbox
		// will still be started so lifecycle hooks run.
	}

	let ui: PluginManifest['ui']
	if (input.ui !== undefined) {
		if (!isRecord(input.ui)) fail(errors, 'ui must be an object')
		else {
			const widgets: PluginWidget[] = []
			if (input.ui.widgets !== undefined) {
				if (!Array.isArray(input.ui.widgets)) fail(errors, 'ui.widgets must be an array')
				else {
					for (const widget of input.ui.widgets.slice(0, 12)) {
						if (
							!isRecord(widget) ||
							typeof widget.id !== 'string' ||
							!/^[a-z0-9][a-z0-9-]{0,39}$/.test(widget.id) ||
							typeof widget.title !== 'string' ||
							!widget.title.trim()
						) {
							fail(errors, 'Each widget needs a lowercase id and title')
							continue
						}
						if (!['small', 'medium', 'large'].includes(String(widget.size))) {
							fail(errors, `Widget '${widget.id}' size must be small, medium, or large`)
							continue
						}
						widgets.push({
							id: widget.id,
							title: widget.title.slice(0, 80),
							...(typeof widget.description === 'string' ? {description: widget.description.slice(0, 200)} : {}),
							size: widget.size as PluginWidget['size'],
							...(typeof widget.refreshSeconds === 'number'
								? {refreshSeconds: Math.min(3600, Math.max(5, widget.refreshSeconds))}
								: {}),
						})
					}
				}
			}
			const routes: PluginRoute[] = []
			if (input.ui.routes !== undefined) {
				if (!Array.isArray(input.ui.routes)) fail(errors, 'ui.routes must be an array')
				else {
					for (const route of input.ui.routes.slice(0, 20)) {
						if (!isRecord(route) || typeof route.id !== 'string' || typeof route.title !== 'string') {
							fail(errors, 'Each UI route needs an id and title')
							continue
						}
						const routeEntry = validatePath(route.entry, `route '${route.id}' entry`, errors)
						if (!routeEntry) continue
						routes.push({
							id: route.id.slice(0, 40),
							title: route.title.slice(0, 80),
							...(typeof route.icon === 'string' ? {icon: route.icon.slice(0, 40)} : {}),
							entry: routeEntry,
						})
					}
				}
			}
			if (!permissions.includes('ui:widget')) widgets.length = 0
			if (!permissions.includes('ui:route')) routes.length = 0
			ui = {widgets, routes, settingsPanels: []}
		}
	}

	const settings: PluginSettingField[] = []
	if (input.settings !== undefined) {
		if (!Array.isArray(input.settings)) fail(errors, 'settings must be an array')
		else {
			const keys = new Set<string>()
			for (const field of input.settings.slice(0, 40)) {
				if (!isRecord(field) || typeof field.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(field.key)) {
					fail(errors, 'Each setting needs a snake_case key')
					continue
				}
				if (keys.has(field.key)) {
					fail(errors, `Duplicate setting key: ${field.key}`)
					continue
				}
				keys.add(field.key)
				if (typeof field.label !== 'string' || !['string', 'number', 'boolean', 'select'].includes(String(field.type))) {
					fail(errors, `Setting '${field.key}' needs a label and a supported type`)
					continue
				}
				const setting: PluginSettingField = {
					key: field.key,
					label: field.label.slice(0, 80),
					type: field.type as PluginSettingField['type'],
					...(typeof field.description === 'string' ? {description: field.description.slice(0, 200)} : {}),
				}
				if (['string', 'number', 'boolean'].includes(setting.type) && field.default !== undefined) {
					if (setting.type === 'number' && typeof field.default !== 'number') {
						fail(errors, `Setting '${field.key}' default must be a number`)
					} else if (setting.type === 'boolean' && typeof field.default !== 'boolean') {
						fail(errors, `Setting '${field.key}' default must be a boolean`)
					} else if (setting.type === 'string' && typeof field.default !== 'string') {
						fail(errors, `Setting '${field.key}' default must be a string`)
					} else setting.default = field.default as string | number | boolean
				}
				if (setting.type === 'select') {
					const options = Array.isArray(field.options)
						? field.options
								.filter(isRecord)
								.filter((option) => typeof option.label === 'string' && typeof option.value === 'string')
								.map((option) => ({label: String(option.label).slice(0, 60), value: String(option.value).slice(0, 100)}))
						: []
					if (!options.length) fail(errors, `Setting '${field.key}' select needs options`)
					else setting.options = options
					if (typeof field.default === 'string') setting.default = field.default
				}
				if (typeof field.min === 'number') setting.min = field.min
				if (typeof field.max === 'number') setting.max = field.max
				settings.push(setting)
			}
		}
	}

	if (errors.length) return {ok: false, errors}
	const manifest: PluginManifest = {
		schemaVersion: 1,
		id: input.id as string,
		name: (input.name as string).trim(),
		version: input.version as string,
		description: (input.description as string) || '',
		author: {
			name: (input.author as {name: string}).name.trim(),
			...((input.author as {url?: string}).url ? {url: (input.author as {url: string}).url} : {}),
		},
		license: (input.license as string).trim(),
		apiVersion: PLUGIN_API_VERSION,
		...(entry ? {entry} : {}),
		permissions,
		...(backend ? {backend} : {}),
		...(ui ? {ui} : {}),
		...(settings.length ? {settings} : {}),
	}
	return {ok: true, errors: [], manifest, manifestHash: manifestHash(manifest)}
}

export function validatePluginFiles(files: PluginFile[], manifest: PluginManifest): string[] {
	const errors: string[] = []
	if (!Array.isArray(files) || files.length === 0) return ['Plugin contains no files']
	if (files.length > MAX_PLUGIN_FILES) return [`Plugin has more than ${MAX_PLUGIN_FILES} files`]
	let total = 0
	const paths = new Set<string>()
	for (const file of files) {
		if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
			errors.push('Each file needs a path and content')
			continue
		}
		if (!PATH_PATTERN.test(file.path) || file.path.includes('..')) {
			errors.push(`Unsafe file path: ${file.path}`)
			continue
		}
		if (paths.has(file.path)) errors.push(`Duplicate file: ${file.path}`)
		paths.add(file.path)
		if (file.encoding && !['utf8', 'base64'].includes(file.encoding)) {
			errors.push(`Unsupported encoding for ${file.path}`)
			continue
		}
		const bytes = file.encoding === 'base64' ? Math.ceil((file.content.length * 3) / 4) : Buffer.byteLength(file.content)
		if (bytes > MAX_FILE_BYTES) errors.push(`File too large: ${file.path}`)
		total += bytes
	}
	if (total > MAX_PLUGIN_BYTES) errors.push(`Plugin exceeds ${MAX_PLUGIN_BYTES} bytes`)
	if (manifest.entry && !paths.has(manifest.entry)) errors.push(`Entry file is missing: ${manifest.entry}`)
	for (const route of manifest.ui?.routes ?? []) {
		if (!paths.has(route.entry)) errors.push(`Route file is missing: ${route.entry}`)
	}
	return errors
}

export function validateSettings(
	manifest: PluginManifest,
	input: Record<string, unknown>,
): {ok: boolean; errors: string[]; values: Record<string, unknown>} {
	const errors: string[] = []
	const values: Record<string, unknown> = {}
	for (const setting of manifest.settings ?? []) {
		const raw = input[setting.key]
		const value = raw === undefined ? setting.default : raw
		if (value === undefined) continue
		if (setting.type === 'number') {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				errors.push(`Setting '${setting.key}' must be a number`)
				continue
			}
			if (setting.min !== undefined && value < setting.min) {
				errors.push(`Setting '${setting.key}' must be at least ${setting.min}`)
				continue
			}
			if (setting.max !== undefined && value > setting.max) {
				errors.push(`Setting '${setting.key}' must be at most ${setting.max}`)
				continue
			}
		} else if (setting.type === 'boolean') {
			if (typeof value !== 'boolean') {
				errors.push(`Setting '${setting.key}' must be a boolean`)
				continue
			}
		} else if (setting.type === 'string') {
			if (typeof value !== 'string' || value.length > 1000) {
				errors.push(`Setting '${setting.key}' must be a string`)
				continue
			}
		} else if (setting.type === 'select') {
			if (typeof value !== 'string' || !setting.options?.some((option) => option.value === value)) {
				errors.push(`Setting '${setting.key}' must be one of its options`)
				continue
			}
		}
		values[setting.key] = value
	}
	return {ok: errors.length === 0, errors, values}
}

/** Deterministic starter plugin used by the AI scaffold endpoint and CLI. */
export function scaffoldPlugin(spec: {
	id: string
	name: string
	description?: string
	withBackend?: boolean
	withWidget?: boolean
	withRoute?: boolean
	author?: string
}): {manifest: PluginManifest; files: PluginFile[]} {
	const files: PluginFile[] = []
	const manifest: PluginManifest = {
		schemaVersion: 1,
		id: spec.id,
		name: spec.name,
		version: '1.0.0',
		description: spec.description ?? `${spec.name} for umbrelOS`,
		author: {name: spec.author ?? 'Umbra'},
		license: 'MIT',
		apiVersion: PLUGIN_API_VERSION,
		permissions: [],
	}
	if (spec.withBackend) {
		manifest.entry = 'backend/index.js'
		manifest.permissions.push('metrics:read', 'storage:plugin')
		manifest.backend = {events: []}
		files.push({
			path: 'backend/index.js',
			content: `// Umbra plugin backend. Runs in a permission-restricted child process.\nlet context\n\nexport async function activate(ctx) {\n\tcontext = ctx\n\tctx.log('info', 'plugin activated')\n\tawait ctx.storage.set('activatedAt', Date.now())\n}\n\nexport async function deactivate() {}\n\nexport async function onEvent(event, payload) {\n\tcontext?.log('debug', event, payload)\n}\n`,
		})
	}
	if (spec.withWidget) {
		manifest.permissions.push('ui:widget', 'metrics:read')
		manifest.ui = {
			widgets: [{id: 'summary', title: `${spec.name} summary`, size: 'small', refreshSeconds: 30}],
		}
	}
	if (spec.withRoute) {
		manifest.permissions.push('ui:route')
		manifest.ui = {
			...manifest.ui,
			routes: [{id: 'home', title: spec.name, entry: 'ui/index.html'}],
		}
		files.push({
			path: 'ui/index.html',
			content: `<!doctype html>\n<html><head><meta charset="utf-8"><title>${spec.name}</title></head>\n<body style="font-family:system-ui;background:#111;color:#eee;padding:2rem">\n<h1>${spec.name}</h1><p>This page runs in a sandboxed frame.</p>\n</body></html>\n`,
		})
	}
	return {manifest, files}
}
