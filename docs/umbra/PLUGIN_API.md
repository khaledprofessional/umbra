# Umbra plugin API

A plugin is a directory with `umbra-plugin.json` and bounded static files. It can run a sandboxed backend and contribute declarative widgets, sandboxed pages, and typed settings.

The schema is intentionally **closed**: unknown keys, permissions, or paths fail validation. This is what makes AI-generated plugins safe to validate deterministically.

## Manifest

```json
{
	"schemaVersion": 1,
	"id": "com.example.weather",
	"name": "Weather",
	"version": "1.0.0",
	"description": "Current conditions for your city.",
	"author": {"name": "Example", "url": "https://example.com"},
	"license": "MIT",
	"apiVersion": "1.0",
	"entry": "backend/index.js",
	"permissions": ["metrics:read", "storage:plugin", "ui:widget", "ui:route"],
	"backend": {
		"events": ["apps:state:change"],
		"timeoutMs": 5000
	},
	"ui": {
		"widgets": [{"id": "now", "title": "Weather now", "size": "small", "refreshSeconds": 60}],
		"routes": [{"id": "details", "title": "Weather", "icon": "cloud", "entry": "ui/index.html"}]
	},
	"settings": [
		{"key": "city", "label": "City", "type": "string", "default": "Oslo"},
		{
			"key": "units",
			"label": "Units",
			"type": "select",
			"options": [{"label": "Metric", "value": "c"}, {"label": "Imperial", "value": "f"}]
		}
	]
}
```

### Fields

| Field | Rules |
| --- | --- |
| `schemaVersion` | exactly `1` |
| `id` | reverse-DNS, lowercase, segments `[a-z0-9-]`, at least two segments, ≤ 80 chars |
| `version` | semver, e.g. `1.2.0` or `1.2.0-beta.1` |
| `name` | 1–60 chars |
| `description` | ≤ 500 chars |
| `author.name` | required; `author.url` must be HTTPS |
| `license` | required |
| `apiVersion` | exactly `"1.0"` |
| `entry` | optional; `.js`/`.mjs`, safe relative path, must exist |
| `permissions` | fixed enum, no duplicates |
| `backend.events` | ≤ 20 strings; host drops undeclared/unauthorized events |
| `backend.timeoutMs` | 500–30 000 |
| `ui.widgets` | ≤ 12; `id` lowercase, `size` small/medium/large |
| `ui.routes` | ≤ 20; each `entry` must exist and live inside the plugin |
| `settings` | ≤ 40; unique snake_case keys |

### Permissions

| Permission | Host API |
| --- | --- |
| `metrics:read` | `ctx.metrics()` → CPU count, load average, memory, uptime |
| `docker:read` | `ctx.docker.list()` → id/name/image/state/status (≤ 200) |
| `apps:read` | `ctx.apps.list()` → installed app id/state |
| `storage:plugin` | `ctx.storage.get/set/delete` — 256 KB total, 64 KB per value |
| `notifications:write` | `ctx.notify(title, message)` |
| `events:subscribe` | receive declared events |
| `ui:widget` | `ctx.widgets.setData(id, data)` — 16 KB |
| `ui:route` | serve an iframe page |
| `ui:settings` | reserved for settings panels |

There is no terminal, filesystem, network, Docker write, or app install permission for plugins. Those remain MCP/owner capabilities.

## Backend contract

`backend/index.js` is an ES module. It may export:

```js
export async function activate(ctx) {}
export async function deactivate() {}
export async function onEvent(event, payload) {}
```

The host starts it with Node's permission model (read-only access to its own directory) and, on Linux, `unshare --net`. `fetch`, `WebSocket`, `EventSource`, and `XMLHttpRequest` throw.

`ctx` shape:

```ts
type Context = {
	plugin: {id: string}
	log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void
	storage: {
		get(key: string): Promise<unknown>
		set(key: string, value: unknown): Promise<void>
		delete(key: string): Promise<void>
	}
	metrics(): Promise<{cpus: number; loadavg: number[]; memory: {total: number; free: number; used: number}; uptime: number}>
	docker: {list(): Promise<Array<{id: string; name: string; image: string; state: string; status: string}>>}
	apps: {list(): Promise<Array<{id: string; state: string}>>}
	notify(title: string, message: string): Promise<void>
	widgets: {setData(widgetId: string, data: unknown): Promise<void>}
	settings: Record<string, unknown>
}
```

Lifecycle: `activate` runs once after start; events are delivered only after activation; `deactivate` is called on disable/uninstall/shutdown with a 2 s budget.

## Installation payloads

### Inline (AI agents)

```json
{
	"manifest": {"schemaVersion": 1, "id": "com.example.hello", "...": "..."},
	"files": [
		{"path": "backend/index.js", "content": "export async function activate(ctx) {}"},
		{"path": "ui/index.html", "content": "<!doctype html>..."},
		{"path": "assets/logo.png", "content": "<base64>", "encoding": "base64"}
	],
	"enable": true
}
```

Limits: ≤ 200 files, ≤ 5 MB total, ≤ 2 MB per file, no symlinks, no traversal, no duplicate paths, entry/route files must exist.

### Local directory (owner, server-side)

`POST /umbra/api/plugins/install-path {"path":"/home/umbrel/umbrel/Home/my-plugin","enable":true}`

Directories are walked without following symlinks; dot directories and `node_modules` are skipped.

## MCP tools for AI generation

All plugin tools require the caller's MCP token to have `manageSystem`.

| Tool | Purpose |
| --- | --- |
| `plugin_scaffold` | `{id, name, description?, with_backend?, with_widget?, with_route?}` → `{manifest, files}` |
| `install_plugin` | `{manifest, files, enable?}` → installed record |
| `list_plugins` | installed plugins + permissions + errors |
| `enable_plugin` / `disable_plugin` | lifecycle |
| `uninstall_plugin` | `{id, remove_data?}` |

Deterministic agent loop:

1. `plugin_scaffold`
2. edit returned files
3. `install_plugin` with `enable: true`
4. `list_plugins` to verify `running: true`
5. if a backend error appears, fix and reinstall the same version or bump it

## Declarative widget data

The backend sets data by widget id:

```js
export async function activate(ctx) {
	await ctx.widgets.setData('now', {temperature: 7, units: 'c'})
}
```

The dashboard fetch returns:

```json
[{"pluginId":"com.example.weather","pluginName":"Weather","id":"now","title":"Weather now","size":"small","data":{"temperature":7,"units":"c"}}]
```

Widgets never inject HTML into the dashboard origin.

## Sandboxed pages

Route entries are served at `/umbra/api/plugins/<id>/ui/<entry>` with:

```
Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox allow-scripts
X-Content-Type-Options: nosniff
```

Relative assets are served only when declared as a route entry; do not rely on arbitrary subpaths yet.
