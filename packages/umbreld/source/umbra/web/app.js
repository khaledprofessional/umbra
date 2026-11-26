/* Umbra admin console. No build step, no inline script, no third-party code. */
const app = document.getElementById('app')

const state = {
	session: null,
	summary: null,
	approvals: [],
	page: 'overview',
	eventSource: null,
	toasts: 0,
	timer: null,
}

const PAGES = [
	{id: 'overview', label: 'Overview', icon: '◈'},
	{id: 'agents', label: 'AI Agents', icon: '✦'},
	{id: 'approvals', label: 'Approvals', icon: '⚑', badge: () => state.approvals.length},
	{id: 'audit', label: 'Agent Logs', icon: '☰'},
	{id: 'plugins', label: 'Plugins', icon: '⬡'},
	{id: 'users', label: 'Users & Requests', icon: '◉'},
	{id: 'cloudflare', label: 'Cloudflare', icon: '☁'},
	{id: 'data', label: 'Snapshots & Limits', icon: '⛁'},
]

/* -------------------------------------------------------------------------- */
/* DOM helpers                                                                */
/* -------------------------------------------------------------------------- */

function h(tag, props = {}, ...children) {
	const element = document.createElement(tag)
	for (const [key, value] of Object.entries(props || {})) {
		if (value === undefined || value === null || value === false) continue
		if (key === 'class') element.className = value
		else if (key === 'text') element.textContent = value
		else if (key === 'html') element.innerHTML = value
		else if (key === 'style') element.style.cssText = value
		else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value)
		else if (key === 'dataset') Object.assign(element.dataset, value)
		else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'value') element[key] = value
		else element.setAttribute(key, value)
	}
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) continue
		element.append(child instanceof Node ? child : document.createTextNode(String(child)))
	}
	return element
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild)
	return node
}

function icon(name) {
	return h('span', {class: 'nav-icon', text: name})
}

function fmtDate(ts) {
	if (!ts) return '—'
	return new Date(ts).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	})
}

function ago(ts) {
	if (!ts) return 'never'
	const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
	if (seconds < 45) return 'just now'
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
	return `${Math.round(seconds / 86400)}d ago`
}

function bytes(value) {
	if (!value) return '0 B'
	if (value < 1024) return `${value} B`
	if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
	return `${(value / 1024 ** 2).toFixed(2)} MB`
}

function initial(value) {
	return String(value || '?')
		.trim()
		.slice(0, 1)
		.toUpperCase()
}

function toast(message, kind = '') {
	const wrap = document.querySelector('.toast-wrap') ?? document.body.appendChild(h('div', {class: 'toast-wrap'}))
	const node = h('div', {class: `toast ${kind}`, text: message})
	wrap.append(node)
	setTimeout(() => node.remove(), 4200)
}

function pill(text, kind = '') {
	return h('span', {class: `pill ${kind}`, text})
}

function dotPill(text, kind = '') {
	return h('span', {class: `pill ${kind}`}, h('span', {class: 'dot'}), text)
}

function empty(message) {
	return h('div', {class: 'empty', text: message})
}

function card(title, subtitle, ...children) {
	return h(
		'div',
		{class: 'card'},
		(title || subtitle) &&
			h(
				'div',
				{class: 'card-head'},
				h(
					'div',
					{},
					h('div', {class: 'card-title', text: title}),
					subtitle && h('div', {class: 'card-sub', text: subtitle}),
				),
			),
		...children,
	)
}

function pageHead(title, subtitle, ...actions) {
	return h(
		'div',
		{class: 'page-head'},
		h('div', {}, h('h1', {class: 'page-title', text: title}), subtitle && h('p', {class: 'page-sub', text: subtitle})),
		actions.length && h('div', {class: 'page-actions'}, ...actions),
	)
}

function avatar(agent, size = '') {
	if (agent?.avatarUrl) {
		return h('img', {class: `avatar ${size}`, src: agent.avatarUrl, alt: '', loading: 'lazy'})
	}
	return h('div', {class: `avatar ${size}`, text: initial(agent?.label ?? agent?.name ?? agent?.agentName)})
}

function openModal(title, body, actions) {
	const backdrop = h('div', {class: 'modal-backdrop'})
	const modal = h('div', {class: 'modal'}, h('h3', {text: title}), body, h('div', {class: 'modal-actions'}, ...actions))
	backdrop.append(modal)
	backdrop.addEventListener('click', (event) => {
		if (event.target === backdrop) backdrop.remove()
	})
	document.body.append(backdrop)
	return {close: () => backdrop.remove(), modal}
}

function confirmAction(title, message, label, action, danger = false) {
	openModal(title, h('p', {class: 'muted', text: message}), [
		h('button', {
			class: 'btn ghost',
			text: 'Cancel',
			onclick: () => document.querySelector('.modal-backdrop')?.remove(),
		}),
		h('button', {
			class: `btn ${danger ? 'danger' : 'primary'}`,
			text: label,
			onclick: async () => {
				try {
					await action()
					document.querySelector('.modal-backdrop')?.remove()
				} catch (error) {
					toast(error.message, 'bad')
				}
			},
		}),
	])
}

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

async function api(path, options = {}) {
	const headers = {Accept: 'application/json', ...(options.headers || {})}
	let body = options.body
	if (body !== undefined && typeof body !== 'string') {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(body)
	}
	if ((options.method || 'GET').toUpperCase() !== 'GET' && state.session?.csrfToken) {
		headers['x-umbra-csrf'] = state.session.csrfToken
	}
	const response = await fetch(`/umbra/api${path}`, {
		credentials: 'same-origin',
		cache: 'no-store',
		...options,
		headers,
		body,
	})
	const text = await response.text()
	let data = {}
	try {
		data = text ? JSON.parse(text) : {}
	} catch {
		data = {error: text.slice(0, 300)}
	}
	if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
	return data
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

function renderSignedOut(message) {
	clear(app)
	app.className = 'boot'
	app.append(
		h('div', {class: 'boot-mark', text: 'U'}),
		h('h1', {text: 'Umbra'}),
		h('p', {class: 'muted', text: message || 'Sign in to umbrelOS to continue.'}),
		h('a', {class: 'btn primary', href: '/login', text: 'Open umbrelOS login'}),
	)
}

function navItems() {
	const isOwner = state.session?.principal?.role === 'owner'
	if (!isOwner) {
		return [
			{id: 'overview', label: 'Overview', icon: '◈'},
			{id: 'users', label: 'App requests', icon: '◉'},
		]
	}
	return PAGES
}

function renderShell() {
	clear(app)
	app.className = ''
	const isOwner = state.session?.principal?.role === 'owner'
	const sidebar = h(
		'aside',
		{class: 'sidebar'},
		h(
			'div',
			{class: 'brand'},
			h('div', {class: 'brand-mark', text: 'U'}),
			h(
				'div',
				{},
				h('div', {class: 'brand-name', text: 'Umbra'}),
				h('div', {class: 'brand-sub', text: 'umbrelOS custom layer'}),
			),
		),
		h('div', {class: 'nav-label', text: 'Control'}),
		...navItems().map((page) => {
			const badgeCount = page.badge?.() ?? 0
			return h(
				'button',
				{class: `nav-item ${state.page === page.id ? 'active' : ''}`, onclick: () => navigate(page.id)},
				icon(page.icon),
				h('span', {text: page.label}),
				badgeCount ? h('span', {class: 'nav-badge', text: String(badgeCount)}) : null,
			)
		}),
		h(
			'div',
			{class: 'sidebar-foot'},
			h('div', {text: `v${state.session?.version ?? ''}`}),
			h('div', {text: isOwner ? 'owner session' : 'member session'}),
		),
	)
	const main = h('main', {class: 'main'})
	app.append(h('div', {class: 'shell'}, sidebar, main))
	return main
}

function navigate(page) {
	state.page = page
	location.hash = `#/${page}`
	render()
}

async function render() {
	if (!state.session) return renderSignedOut()
	const main = renderShell()
	const pending = state.approvals[0]
	if (pending) main.append(renderApprovalBanner(pending))
	const content = h(
		'div',
		{},
		h('div', {class: 'row'}, h('span', {class: 'spinner'}), h('span', {class: 'muted', text: 'Loading…'})),
	)
	main.append(content)
	try {
		const page = await PAGES.find((entry) => entry.id === state.page)?.render?.()
		clear(content)
		if (!page) content.append(pageHead('Not found'), empty('This page does not exist.'))
		else content.append(page)
	} catch (error) {
		clear(content)
		content.append(pageHead('Something went wrong'), card('Error', error.message))
	}
}

function renderApprovalBanner(approval) {
	return h(
		'div',
		{class: 'banner'},
		avatar(approval, 'lg'),
		h(
			'div',
			{class: 'grow'},
			h('div', {style: 'font-weight:650'}, `${approval.agentName} wants to run a command`),
			h('div', {
				class: 'tiny muted',
				text: `${approval.agentType ? `${approval.agentType} · ` : ''}${approval.cwd} · expires ${fmtDate(approval.expiresAt)}`,
			}),
			h('div', {class: 'command', text: approval.command}),
		),
		h(
			'div',
			{class: 'row', style: 'flex:0 0 auto'},
			h('button', {class: 'btn danger', text: 'Deny', onclick: () => decideApproval(approval.id, false)}),
			h('button', {class: 'btn primary', text: 'Approve', onclick: () => decideApproval(approval.id, true)}),
		),
	)
}

async function decideApproval(id, approved) {
	try {
		await api(`/approvals/${id}/decide`, {method: 'POST', body: {approved}})
		state.approvals = state.approvals.filter((approval) => approval.id !== id)
		toast(approved ? 'Approved' : 'Denied', approved ? 'ok' : 'bad')
		render()
	} catch (error) {
		toast(error.message, 'bad')
	}
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */

async function renderMemberOverview() {
	const [policy, requests] = await Promise.all([api('/me/policy'), api('/me/requests')])
	const pending = requests.filter((request) => request.status === 'pending' || request.status === 'installing').length
	return h(
		'div',
		{},
		pageHead('Overview', `Signed in as a member. App install policy: ${policy.policy}.`),
		h(
			'div',
			{class: 'grid cols-3'},
			statCard(
				'Install policy',
				policy.policy === 'manage' ? 'Can install' : policy.policy === 'request' ? 'Request only' : 'No installs',
				'Set by the device owner',
			),
			statCard('Open requests', String(pending), 'Waiting for the owner'),
			statCard('All requests', String(requests.length), 'Submitted by you'),
		),
		h('div', {class: 'section-label', text: 'Quick action'}),
		card(
			'Need an app?',
			'Request it and the owner can approve installation in one click.',
			h('button', {class: 'btn primary', text: 'Request an app', onclick: () => navigate('users')}),
		),
	)
}

PAGES[0].render = async () => {
	if (state.session.principal.role !== 'owner') return renderMemberOverview()
	const summary = await api('/summary')
	state.summary = summary
	const cloudflare = summary.cloudflare
	const connected = summary.agents.filter((agent) => Date.now() - agent.lastSeenAt < 5 * 60_000).length
	const enabledPlugins = summary.plugins.filter((plugin) => plugin.enabled).length
	const recent = await api('/audit?limit=10').catch(() => ({events: []}))
	const tunnelPill = cloudflare.lockdown
		? dotPill('Lockdown', 'bad')
		: cloudflare.health?.ready
			? dotPill('Tunnel online', 'ok')
			: cloudflare.enabled
				? dotPill('Tunnel starting', 'warn')
				: dotPill('Tunnel off', '')
	return h(
		'div',
		{},
		pageHead(
			'Overview',
			'Modding, AI agents, and hardened remote access for this umbrelOS device.',
			h('button', {class: 'btn', text: 'Refresh', onclick: () => render()}),
		),
		h(
			'div',
			{class: 'grid cols-4'},
			statCard(
				'Pending approvals',
				String(summary.approvals.length),
				summary.approvals.length ? 'Agent command waiting' : 'Nothing waiting',
			),
			statCard('Connected agents', String(connected), `${summary.agents.length} known credentials`),
			statCard('Plugins enabled', String(enabledPlugins), `${summary.plugins.length} installed`),
			statCard(
				'Public exposure',
				cloudflare.hostname || 'Not configured',
				cloudflare.publicUrl || 'Cloudflare Tunnel',
				tunnelPill,
			),
		),
		h('div', {class: 'section-label', text: 'Quick actions'}),
		h(
			'div',
			{class: 'grid cols-3'},
			actionCard('Review approvals', 'Approve or deny queued terminal commands.', 'Open', () => navigate('approvals')),
			actionCard('AI Agent logs', 'Every connection, tool call, and command.', 'View logs', () => navigate('audit')),
			actionCard('Cloudflare exposure', 'Tunnel health, Access policy, kill switch.', 'Configure', () =>
				navigate('cloudflare'),
			),
		),
		h('div', {class: 'section-label', text: 'Recent activity'}),
		card(
			'Latest audit events',
			'Tamper-evident log of agent and owner actions.',
			recent.events.length
				? h(
						'div',
						{class: 'list'},
						...recent.events.slice(0, 8).map((event) =>
							h(
								'div',
								{class: 'list-row'},
								h(
									'div',
									{class: 'grow'},
									h('div', {class: 'truncate', text: event.action}),
									h('div', {
										class: 'tiny faint',
										text: `${event.actor.name || event.actor.id} · ${fmtDate(event.ts)}`,
									}),
								),
								outcomePill(event.outcome),
							),
						),
					)
				: empty('No audit events yet.'),
		),
	)
}

PAGES[1].render = async () => {
	const agents = await api('/agents')
	return h(
		'div',
		{},
		pageHead('AI Agents', 'MCP credentials, terminal permissions, and locally stored avatars.'),
		agents.length
			? h(
					'div',
					{class: 'grid'},
					...agents.map((agent) =>
						card(
							null,
							null,
							h(
								'div',
								{class: 'row', style: 'align-items:flex-start'},
								avatar(agent, 'lg'),
								h(
									'div',
									{class: 'grow', style: 'flex:1 1 260px'},
									h('div', {style: 'font-weight:650', text: agent.label}),
									h('div', {
										class: 'tiny muted',
										text: [agent.agentType, agent.clientName, `token ${agent.tokenId.slice(0, 8)}…`]
											.filter(Boolean)
											.join(' · '),
									}),
									h('div', {
										class: 'tiny faint',
										text: `Last seen ${ago(agent.lastSeenAt)}${agent.lastIp ? ` from ${agent.lastIp}` : ''}`,
									}),
								),
								agent.avatar
									? h('button', {
											class: 'btn sm ghost',
											text: 'Remove avatar',
											onclick: () => removeAvatar(agent.tokenId),
										})
									: null,
							),
							h('div', {class: 'section-label', text: 'Terminal policy'}),
							policyEditor(agent),
						),
					),
				)
			: empty('No agents have connected yet. Create an MCP token in Settings → AI agents (MCP).'),
	)
}

function policyEditor(agent) {
	const select = h(
		'select',
		{},
		...['inherit', 'deny', 'ask', 'always'].map((mode) =>
			h('option', {
				value: mode,
				selected: agent.terminal.mode === mode,
				text:
					mode === 'inherit'
						? 'Follow global (ask)'
						: mode === 'always'
							? 'Always allowed'
							: mode === 'ask'
								? 'Ask every time'
								: 'Denied',
			}),
		),
	)
	const allowlist = h('textarea', {
		placeholder: 'Optional pre-approved commands, one per line. Prefix with * to match a prefix.',
		style: 'min-height:64px',
	})
	allowlist.value = agent.terminal.allowlist.join('\n')
	const save = async () => {
		try {
			await api(`/agents/${agent.tokenId}/terminal-policy`, {
				method: 'POST',
				body: {
					mode: select.value,
					allowlist: allowlist.value
						.split('\n')
						.map((entry) => entry.trim())
						.filter(Boolean),
				},
			})
			toast('Policy saved', 'ok')
		} catch (error) {
			toast(error.message, 'bad')
		}
	}
	return h(
		'div',
		{class: 'form'},
		h(
			'div',
			{class: 'row'},
			h('div', {class: 'field'}, h('label', {text: 'Mode'}), select),
			h('div', {class: 'field'}, h('label', {text: 'Allowlist'}), allowlist),
		),
		h('div', {}, h('button', {class: 'btn primary sm', text: 'Save policy', onclick: save})),
		h('p', {
			class: 'hint faint tiny',
			text: '"Ask every time" blocks the command and pushes the exact command to this console for approval.',
		}),
	)
}

async function removeAvatar(tokenId) {
	try {
		await api(`/agents/${tokenId}/avatar/remove`, {method: 'POST'})
		toast('Avatar removed', 'ok')
		render()
	} catch (error) {
		toast(error.message, 'bad')
	}
}

PAGES[2].render = async () => {
	state.approvals = await api('/approvals')
	return h(
		'div',
		{},
		pageHead('Approvals', 'Commands blocked until you decide. Timeouts deny automatically.'),
		state.approvals.length
			? h('div', {class: 'grid'}, ...state.approvals.map((approval) => renderApprovalCard(approval)))
			: empty('No commands are waiting for approval.'),
	)
}

function renderApprovalCard(approval) {
	return card(
		null,
		null,
		h(
			'div',
			{class: 'row', style: 'align-items:flex-start'},
			avatar(approval, 'lg'),
			h(
				'div',
				{class: 'grow', style: 'flex:1 1 280px'},
				h('div', {style: 'font-weight:650', text: approval.agentName}),
				h('div', {
					class: 'tiny muted',
					text: `${approval.agentType ?? 'MCP agent'}${approval.clientName ? ` · ${approval.clientName}` : ''}`,
				}),
				h('div', {class: 'tiny faint', text: `Requested ${ago(approval.createdAt)} · ${approval.cwd}`}),
			),
			pill(`expires ${new Date(approval.expiresAt).toLocaleTimeString()}`, 'warn'),
		),
		h('div', {class: 'command', text: approval.command}),
		approval.reason && h('p', {class: 'tiny muted', style: 'margin-top:8px', text: `Reason: ${approval.reason}`}),
		h(
			'div',
			{class: 'row', style: 'margin-top:14px'},
			h('button', {class: 'btn danger', text: 'Deny', onclick: () => decideApproval(approval.id, false)}),
			h('button', {class: 'btn primary', text: 'Approve command', onclick: () => decideApproval(approval.id, true)}),
		),
	)
}

PAGES[3].render = async () => {
	const type = h(
		'select',
		{},
		h('option', {value: '', text: 'All event types'}),
		...[
			'mcp.connect',
			'mcp.tool',
			'terminal.request',
			'terminal.approved',
			'terminal.denied',
			'terminal.executed',
			'plugin.install',
			'plugin.enable',
			'plugin.disable',
			'plugin.uninstall',
			'cloudflare.enable',
			'cloudflare.disable',
			'cloudflare.lockdown',
			'security.block',
			'auth.denied',
			'access.request',
			'access.approve',
			'access.deny',
			'snapshot.create',
			'snapshot.restore',
			'override.update',
		].map((value) => h('option', {value, text: value})),
	)
	const outcome = h(
		'select',
		{},
		h('option', {value: '', text: 'Any outcome'}),
		...['success', 'failure', 'denied', 'pending'].map((value) => h('option', {value, text: value})),
	)
	const search = h('input', {type: 'text', placeholder: 'Search action, target, detail…'})
	const agentMap = new Map()
	try {
		for (const agent of await api('/agents')) agentMap.set(agent.tokenId, agent)
	} catch {
		// Avatars are cosmetic; the audit view still renders without them.
	}
	const limit = 100
	const load = async (before) => {
		const query = new URLSearchParams({limit: String(limit)})
		if (type.value) query.set('type', type.value)
		if (outcome.value) query.set('outcome', outcome.value)
		if (search.value) query.set('q', search.value)
		if (before) query.set('before', String(before))
		return api(`/audit?${query}`)
	}
	const container = h('div', {})
	const draw = async (before) => {
		clear(container).append(h('span', {class: 'spinner'}))
		try {
			const result = await load(before)
			const table = h(
				'table',
				{class: 'table'},
				h(
					'thead',
					{},
					h('tr', {}, ...['Time', 'Type', 'Actor', 'Action', 'Outcome'].map((label) => h('th', {text: label}))),
				),
				h(
					'tbody',
					{},
					...result.events.map((event) =>
						h(
							'tr',
							{},
							h('td', {class: 'nowrap tiny muted', text: fmtDate(event.ts)}),
							h('td', {class: 'mono tiny', text: event.type}),
							h(
								'td',
								{},
								h(
									'div',
									{class: 'row', style: 'gap:8px;flex-wrap:nowrap;align-items:center'},
									avatar(agentMap.get(event.actor.id) ?? {label: event.actor.name || event.actor.id}),
									h(
										'div',
										{},
										h('div', {text: event.actor.name || event.actor.id}),
										h('div', {class: 'tiny faint', text: `${event.actor.type}${event.ip ? ` · ${event.ip}` : ''}`}),
									),
								),
							),
							h(
								'td',
								{},
								h('div', {text: event.action}),
								event.target && h('div', {class: 'tiny faint break', text: event.target}),
								event.detail &&
									h(
										'details',
										{},
										h('summary', {class: 'tiny faint', text: 'detail'}),
										h('pre', {class: 'code', text: JSON.stringify(event.detail, null, 2)}),
									),
							),
							h('td', {}, outcomePill(event.outcome)),
						),
					),
				),
			)
			clear(container)
			container.append(table)
			if (result.nextCursor) {
				container.append(
					h('button', {
						class: 'btn sm',
						style: 'margin-top:12px',
						text: 'Load older',
						onclick: () => draw(result.nextCursor),
					}),
				)
			}
		} catch (error) {
			clear(container).append(empty(error.message))
		}
	}
	void draw()
	return h(
		'div',
		{},
		pageHead(
			'AI Agent logs',
			'Every MCP connection, tool call, terminal command, approval, and plugin change.',
			h('button', {
				class: 'btn',
				text: 'Verify integrity',
				onclick: async () => {
					try {
						const result = await api('/audit/verify')
						toast(
							result.ok ? `Chain verified (${result.entries} entries)` : `Chain broken: ${result.error}`,
							result.ok ? 'ok' : 'bad',
						)
					} catch (error) {
						toast(error.message, 'bad')
					}
				},
			}),
			h('a', {class: 'btn', href: '/umbra/api/audit/export', text: 'Export JSON'}),
		),
		h(
			'div',
			{class: 'card tight', style: 'margin-bottom:14px'},
			h(
				'div',
				{class: 'row'},
				type,
				outcome,
				search,
				h('button', {class: 'btn', text: 'Filter', onclick: () => draw()}),
			),
		),
		card('Audit events', null, container),
	)
}

PAGES[4].render = async () => {
	const [plugins, widgets] = await Promise.all([api('/plugins'), api('/plugins/widgets')])
	return h(
		'div',
		{},
		pageHead(
			'Plugins',
			'Sandboxed extensions installed outside the OS image. Survives app and OS updates.',
			h('button', {class: 'btn primary', text: 'Install plugin', onclick: installPluginModal}),
			h('button', {class: 'btn', text: 'Scaffold', onclick: scaffoldModal}),
		),
		plugins.length
			? h('div', {class: 'grid'}, ...plugins.map((plugin) => pluginCard(plugin)))
			: empty('No plugins installed. Use Scaffold to generate one, or install from a manifest.'),
		h('div', {class: 'section-label', text: 'Dashboard widgets'}),
		widgets.length
			? h(
					'div',
					{class: 'grid cols-3'},
					...widgets.map((widget) =>
						card(
							widget.title,
							`${widget.pluginName} · ${widget.size}`,
							h('pre', {class: 'code', text: JSON.stringify(widget.data ?? {status: 'no data yet'}, null, 2)}),
						),
					),
				)
			: empty('No plugin widgets enabled.'),
	)
}

function pluginCard(plugin) {
	const manifest = plugin.manifest || {}
	return card(
		null,
		null,
		h(
			'div',
			{class: 'row', style: 'align-items:flex-start'},
			h(
				'div',
				{class: 'grow'},
				h('div', {style: 'font-weight:650', text: manifest.name || plugin.id}),
				h('div', {class: 'tiny muted', text: `${plugin.id} · v${plugin.version}`}),
			),
			plugin.enabled ? dotPill(plugin.running ? 'Running' : 'Enabled', 'ok') : pill('Disabled'),
		),
		h('p', {class: 'card-sub', text: manifest.description || ''}),
		(manifest.permissions || []).length
			? h('div', {class: 'row', style: 'margin:10px 0'}, ...manifest.permissions.map((permission) => pill(permission)))
			: null,
		(manifest.ui?.routes || []).length
			? h(
					'div',
					{class: 'row', style: 'margin-bottom:10px'},
					...manifest.ui.routes.map((route) =>
						h('button', {
							class: 'btn sm',
							text: `Open ${route.title}`,
							onclick: () =>
								window.open(`/umbra/api/plugins/${plugin.id}/ui/${route.entry}`, '_blank', 'noopener,noreferrer'),
						}),
					),
				)
			: null,
		plugin.lastError && h('p', {class: 'tiny', style: 'color:var(--red)', text: plugin.lastError}),
		h(
			'div',
			{class: 'row', style: 'margin-top:14px'},
			plugin.enabled
				? h('button', {class: 'btn sm', text: 'Disable', onclick: () => pluginAction(plugin.id, 'disable')})
				: h('button', {class: 'btn sm primary', text: 'Enable', onclick: () => pluginAction(plugin.id, 'enable')}),
			h('button', {
				class: 'btn sm danger',
				text: 'Uninstall',
				onclick: () =>
					confirmAction('Uninstall plugin', `Remove ${plugin.id}? Its data is kept.`, 'Uninstall', () =>
						pluginAction(plugin.id, 'uninstall', {removeData: false}),
					),
			}),
		),
	)
}

async function pluginAction(id, action, body = {}) {
	try {
		await api(`/plugins/${id}/${action}`, {method: 'POST', body})
		toast(`${action} complete`, 'ok')
		render()
	} catch (error) {
		toast(error.message, 'bad')
	}
}

function installPluginModal() {
	const manifest = h('textarea', {placeholder: '{\n  "schemaVersion": 1,\n  ...\n}', style: 'min-height:180px'})
	const files = h('textarea', {
		placeholder: '[{"path":"ui/index.html","content":"<h1>Hi</h1>"}]',
		style: 'min-height:140px',
	})
	const enable = h('input', {type: 'checkbox'})
	const {close} = openModal(
		'Install plugin',
		h(
			'div',
			{class: 'form'},
			h('div', {class: 'field'}, h('label', {text: 'Manifest (umbra-plugin.json)'}), manifest),
			h('div', {class: 'field'}, h('label', {text: 'Files (JSON array)'}), files),
			h('label', {class: 'check'}, enable, 'Enable after install'),
		),
		[
			h('button', {class: 'btn ghost', text: 'Cancel', onclick: close}),
			h('button', {
				class: 'btn primary',
				text: 'Validate & install',
				onclick: async () => {
					try {
						const parsedManifest = JSON.parse(manifest.value)
						const parsedFiles = JSON.parse(files.value || '[]')
						await api('/plugins/install', {
							method: 'POST',
							body: {manifest: parsedManifest, files: parsedFiles, enable: enable.checked},
						})
						close()
						toast('Plugin installed', 'ok')
						render()
					} catch (error) {
						toast(error.message, 'bad')
					}
				},
			}),
		],
	)
}

function scaffoldModal() {
	const id = h('input', {type: 'text', placeholder: 'com.example.weather'})
	const name = h('input', {type: 'text', placeholder: 'Weather'})
	const backend = h('input', {type: 'checkbox', checked: true})
	const widget = h('input', {type: 'checkbox', checked: true})
	const route = h('input', {type: 'checkbox'})
	const output = h('pre', {class: 'code', text: 'Generated files appear here.'})
	let generated = null
	const {close} = openModal(
		'Scaffold a plugin',
		h(
			'div',
			{class: 'form'},
			h(
				'div',
				{class: 'row'},
				h('div', {class: 'field'}, h('label', {text: 'Plugin id'}), id),
				h('div', {class: 'field'}, h('label', {text: 'Name'}), name),
			),
			h(
				'div',
				{class: 'row'},
				h('label', {class: 'check'}, backend, 'Backend'),
				h('label', {class: 'check'}, widget, 'Widget'),
				h('label', {class: 'check'}, route, 'Route'),
			),
			output,
		),
		[
			h('button', {class: 'btn ghost', text: 'Cancel', onclick: close}),
			h('button', {
				class: 'btn',
				text: 'Generate',
				onclick: async () => {
					try {
						generated = await api('/plugins/scaffold', {
							method: 'POST',
							body: {
								id: id.value,
								name: name.value,
								withBackend: backend.checked,
								withWidget: widget.checked,
								withRoute: route.checked,
							},
						})
						output.textContent = JSON.stringify(generated, null, 2)
					} catch (error) {
						toast(error.message, 'bad')
					}
				},
			}),
			h('button', {
				class: 'btn primary',
				text: 'Install generated',
				onclick: async () => {
					if (!generated) return toast('Generate first', 'bad')
					try {
						await api('/plugins/install', {
							method: 'POST',
							body: {manifest: generated.manifest, files: generated.files, enable: true},
						})
						close()
						toast('Plugin installed', 'ok')
						render()
					} catch (error) {
						toast(error.message, 'bad')
					}
				},
			}),
		],
	)
}

PAGES[5].render = async () => {
	if (state.session.principal.role !== 'owner') {
		const [policy, requests] = await Promise.all([api('/me/policy'), api('/me/requests')])
		const appId = h('input', {type: 'text', placeholder: 'app-id'})
		const appName = h('input', {type: 'text', placeholder: 'App name'})
		const message = h('input', {type: 'text', placeholder: 'Why do you need it? (optional)'})
		return h(
			'div',
			{},
			pageHead('App requests', `Your install policy: ${policy.policy}.`),
			card(
				'Request an app',
				policy.policy === 'request'
					? 'Your request goes to the owner for approval.'
					: policy.policy === 'manage'
						? 'You can install apps directly.'
						: 'App installation is disabled for your account.',
				h(
					'div',
					{class: 'form'},
					h('div', {class: 'row'}, appId, appName),
					message,
					h('button', {
						class: 'btn primary',
						text: 'Submit request',
						disabled: policy.policy !== 'request',
						onclick: async () => {
							try {
								await api('/me/request-app', {
									method: 'POST',
									body: {appId: appId.value, appName: appName.value, message: message.value},
								})
								toast('Request submitted', 'ok')
								render()
							} catch (error) {
								toast(error.message, 'bad')
							}
						},
					}),
				),
			),
			card('Your requests', null, requests.length ? requestTable(requests, false) : empty('No requests yet.')),
		)
	}
	const [members, requests] = await Promise.all([api('/access/members'), api('/access/requests')])
	return h(
		'div',
		{},
		pageHead('Users & Requests', 'Grant app install rights or approve member requests.'),
		card(
			'Members',
			'Owners always manage apps. Changes take effect immediately.',
			members.length
				? h(
						'table',
						{class: 'table'},
						h('thead', {}, h('tr', {}, ...['Member', 'App install policy', ''].map((label) => h('th', {text: label})))),
						h(
							'tbody',
							{},
							...members.map((member) =>
								h(
									'tr',
									{},
									h('td', {}, h('div', {text: member.name}), h('div', {class: 'tiny faint', text: member.userId})),
									h(
										'td',
										{},
										h(
											'select',
											{
												onchange: async (event) => {
													try {
														await api(`/access/members/${member.userId}/policy`, {
															method: 'POST',
															body: {policy: event.target.value},
														})
														toast('Policy updated', 'ok')
													} catch (error) {
														toast(error.message, 'bad')
													}
												},
											},
											...['none', 'request', 'manage'].map((policy) =>
												h('option', {
													value: policy,
													selected: member.policy === policy,
													text:
														policy === 'manage' ? 'Can install' : policy === 'request' ? 'Request only' : 'No installs',
												}),
											),
										),
									),
									h('td', {}, h('span', {class: 'tiny faint', text: member.policy})),
								),
							),
						),
					)
				: empty('No member accounts.'),
		),
		h('div', {class: 'section-label', text: 'Request queue'}),
		card(
			'Pending and recent requests',
			null,
			requests.length ? requestTable(requests, true) : empty('No app requests.'),
		),
	)
}

function requestTable(requests, canDecide) {
	return h(
		'table',
		{class: 'table'},
		h(
			'thead',
			{},
			h(
				'tr',
				{},
				...['App', 'Requested by', 'Status', 'When', canDecide ? 'Action' : ''].map((label, index) =>
					label || index < 4 ? h('th', {text: label}) : null,
				),
			),
		),
		h(
			'tbody',
			{},
			...requests.map((request) =>
				h(
					'tr',
					{},
					h('td', {}, h('div', {text: request.appName}), h('div', {class: 'tiny faint', text: request.appId})),
					h('td', {text: request.userName}),
					h(
						'td',
						{},
						statusPill(request.status),
						request.error && h('div', {class: 'tiny', style: 'color:var(--red)', text: request.error}),
					),
					h('td', {class: 'tiny muted nowrap', text: ago(request.createdAt)}),
					canDecide && request.status === 'pending'
						? h(
								'td',
								{},
								h(
									'div',
									{class: 'row', style: 'flex-wrap:nowrap'},
									h('button', {
										class: 'btn sm primary',
										text: 'Approve',
										onclick: async () => {
											try {
												await api(`/access/requests/${request.id}/decide`, {method: 'POST', body: {approved: true}})
												toast('Installing…', 'ok')
												setTimeout(() => render(), 1200)
											} catch (error) {
												toast(error.message, 'bad')
											}
										},
									}),
									h('button', {
										class: 'btn sm danger',
										text: 'Deny',
										onclick: async () => {
											try {
												await api(`/access/requests/${request.id}/decide`, {method: 'POST', body: {approved: false}})
												toast('Denied', 'ok')
												render()
											} catch (error) {
												toast(error.message, 'bad')
											}
										},
									}),
								),
							)
						: h('td', {}),
				),
			),
		),
	)
}

PAGES[6].render = async () => {
	const data = await api('/cloudflare')
	const settings = data.settings
	const status = data.status
	const hostname = h('input', {type: 'text', value: settings.hostname, placeholder: 'umbrel.example.com'})
	const mode = h(
		'select',
		{},
		...['token', 'credentials'].map((value) =>
			h('option', {
				value,
				selected: settings.mode === value,
				text: value === 'token' ? 'Tunnel token (dashboard-managed)' : 'Credentials file (local ingress config)',
			}),
		),
	)
	const image = h('input', {type: 'text', value: settings.image})
	const token = h('input', {
		type: 'password',
		placeholder: settings.tokenSet ? 'Token stored — paste to replace' : 'Paste Cloudflare tunnel token',
	})
	const credentials = h('textarea', {
		placeholder: '{"AccountTag":"…","TunnelID":"…","TunnelSecret":"…"}',
		style: 'min-height:90px',
	})
	const accessEnabled = h('input', {type: 'checkbox', checked: settings.access.enabled})
	const teamDomain = h('input', {
		type: 'text',
		value: settings.access.teamDomain,
		placeholder: 'team.cloudflareaccess.com',
	})
	const audience = h('input', {type: 'text', value: settings.access.audience})
	const emails = h('input', {
		type: 'text',
		value: settings.access.allowedEmails.join(', '),
		placeholder: 'owner@example.com, admin@example.com',
	})
	const protectedPrefixes = h('input', {type: 'text', value: settings.access.protectedPrefixes.join(', ')})
	const rate = h('input', {type: 'number', value: settings.security.loginRateLimitPerMinute, min: 1, max: 120})
	const threshold = h('input', {type: 'number', value: settings.security.loginLockoutThreshold, min: 1, max: 100})
	const lockout = h('input', {type: 'number', value: settings.security.loginLockoutMinutes, min: 1, max: 1440})
	const hsts = h('input', {type: 'checkbox', checked: settings.security.hsts})
	const strictCsp = h('input', {type: 'checkbox', checked: settings.security.strictCsp})
	const originLock = h('input', {type: 'checkbox', checked: settings.security.originLock})
	const blockDirectIp = h('input', {type: 'checkbox', checked: settings.security.blockDirectIp})

	const save = async () => {
		try {
			await api('/cloudflare/settings', {
				method: 'POST',
				body: {
					hostname: hostname.value,
					mode: mode.value,
					image: image.value,
					access: {
						enabled: accessEnabled.checked,
						teamDomain: teamDomain.value,
						audience: audience.value,
						allowedEmails: emails.value
							.split(',')
							.map((email) => email.trim())
							.filter(Boolean),
						protectedPrefixes: protectedPrefixes.value
							.split(',')
							.map((prefix) => prefix.trim())
							.filter(Boolean),
					},
					security: {
						loginRateLimitPerMinute: Number(rate.value),
						loginLockoutThreshold: Number(threshold.value),
						loginLockoutMinutes: Number(lockout.value),
						hsts: hsts.checked,
						strictCsp: strictCsp.checked,
						originLock: originLock.checked,
						blockDirectIp: blockDirectIp.checked,
					},
				},
			})
			toast('Settings saved', 'ok')
			render()
		} catch (error) {
			toast(error.message, 'bad')
		}
	}
	return h(
		'div',
		{},
		pageHead(
			'Cloudflare exposure',
			'Single-subdomain public access with no inbound ports. Protect privileged routes with Cloudflare Access.',
		),
		status.lockdown &&
			h(
				'div',
				{class: 'banner'},
				h(
					'div',
					{class: 'grow'},
					h('div', {style: 'font-weight:650', text: 'Emergency lockdown is active'}),
					h('div', {class: 'tiny muted', text: 'The tunnel is stopped and public requests are refused.'}),
				),
				h('button', {class: 'btn primary', text: 'Release lockdown', onclick: () => lockdown(false)}),
			),
		h(
			'div',
			{class: 'grid cols-2'},
			card(
				'Tunnel',
				status.publicUrl ?? 'Not configured',
				h(
					'div',
					{class: 'list'},
					infoRow(
						'Status',
						status.lockdown
							? pill('Lockdown', 'bad')
							: status.health?.ready
								? dotPill('Connected', 'ok')
								: status.enabled
									? dotPill('Starting', 'warn')
									: pill('Off'),
					),
					infoRow('Container', status.container.exists ? `${status.container.state}` : 'not created'),
					infoRow('Health', status.health.ready ? 'ready' : status.health.error || 'not checked'),
					infoRow('Docker', status.dockerAvailable ? 'available' : 'unavailable'),
					infoRow('Last error', status.lastError || 'none'),
				),
				h(
					'div',
					{class: 'row', style: 'margin-top:14px'},
					status.enabled
						? h('button', {class: 'btn', text: 'Disable', onclick: () => cloudflareAction('disable')})
						: h('button', {class: 'btn primary', text: 'Enable tunnel', onclick: () => cloudflareAction('enable')}),
					h('button', {
						class: 'btn danger',
						text: 'Kill switch',
						onclick: () =>
							confirmAction(
								'Emergency lockdown',
								'Stop the tunnel immediately and refuse all public traffic?',
								'Lock down',
								() => lockdown(true),
								true,
							),
					}),
				),
			),
			card(
				'Tunnel configuration',
				null,
				h(
					'div',
					{class: 'form'},
					h('div', {class: 'field'}, h('label', {text: 'Public hostname'}), hostname),
					h('div', {class: 'field'}, h('label', {text: 'Mode'}), mode),
					h('div', {class: 'field'}, h('label', {text: 'Cloudflared image'}), image),
				),
			),
		),
		h('div', {class: 'section-label', text: 'Credentials'}),
		h(
			'div',
			{class: 'grid cols-2'},
			card(
				'Tunnel token',
				'Token-based tunnels use ingress rules managed in the Cloudflare dashboard.',
				h(
					'div',
					{class: 'form'},
					token,
					h(
						'div',
						{class: 'row'},
						h('button', {
							class: 'btn',
							text: 'Store token',
							onclick: async () => {
								try {
									await api('/cloudflare/token', {method: 'POST', body: {token: token.value}})
									toast('Token stored', 'ok')
									render()
								} catch (error) {
									toast(error.message, 'bad')
								}
							},
						}),
						settings.tokenSet
							? h('button', {
									class: 'btn ghost',
									text: 'Clear',
									onclick: async () => {
										await api('/cloudflare/clear-secret', {method: 'POST', body: {kind: 'token'}})
										render()
									},
								})
							: null,
					),
				),
			),
			card(
				'Credentials file',
				'Credentials mode writes local ingress rules for the configured hostname.',
				h(
					'div',
					{class: 'form'},
					credentials,
					h('button', {
						class: 'btn',
						text: 'Store credentials',
						onclick: async () => {
							try {
								await api('/cloudflare/credentials', {
									method: 'POST',
									body: {credentials: JSON.parse(credentials.value)},
								})
								toast('Credentials stored', 'ok')
								render()
							} catch (error) {
								toast(error.message, 'bad')
							}
						},
					}),
				),
			),
		),
		h('div', {class: 'section-label', text: 'Zero Trust & hardening'}),
		card(
			'Cloudflare Access',
			'Privileged routes require a verified Access JWT. Public portal routes stay reachable.',
			h(
				'div',
				{class: 'form'},
				h('label', {class: 'check'}, accessEnabled, 'Require Cloudflare Access for privileged routes'),
				h(
					'div',
					{class: 'row'},
					h('div', {class: 'field'}, h('label', {text: 'Team domain'}), teamDomain),
					h('div', {class: 'field'}, h('label', {text: 'Audience (AUD) tag'}), audience),
				),
				h(
					'div',
					{class: 'field'},
					h('label', {text: 'Allowed emails (comma separated, empty = any Access identity)'}),
					emails,
				),
				h('div', {class: 'field'}, h('label', {text: 'Protected path prefixes'}), protectedPrefixes),
				h(
					'div',
					{class: 'row'},
					h('div', {class: 'field'}, h('label', {text: 'Login rate / minute / IP'}), rate),
					h('div', {class: 'field'}, h('label', {text: 'Lockout threshold'}), threshold),
					h('div', {class: 'field'}, h('label', {text: 'Lockout minutes'}), lockout),
				),
				h(
					'div',
					{class: 'row'},
					h('label', {class: 'check'}, hsts, 'HSTS'),
					h('label', {class: 'check'}, strictCsp, 'Strict CSP'),
					h('label', {class: 'check'}, originLock, 'Origin lock'),
					h('label', {class: 'check'}, blockDirectIp, 'Block non-Cloudflare origin access'),
				),
				h('button', {class: 'btn primary', text: 'Save settings', onclick: save}),
			),
		),
		h('div', {class: 'section-label', text: 'Tunnel logs'}),
		card('Latest container output', null, h('pre', {class: 'code', text: data.logs || 'No logs.'})),
	)
}

function infoRow(label, value) {
	return h(
		'div',
		{class: 'list-row'},
		h('div', {class: 'grow tiny muted', text: label}),
		h('div', {class: 'tiny'}, value),
	)
}

async function cloudflareAction(action) {
	try {
		await api(`/cloudflare/${action}`, {method: 'POST'})
		toast(`${action} requested`, 'ok')
		setTimeout(() => render(), 800)
	} catch (error) {
		toast(error.message, 'bad')
	}
}

async function lockdown(locked) {
	try {
		await api('/cloudflare/lockdown', {method: 'POST', body: {locked}})
		toast(locked ? 'Lockdown enabled' : 'Lockdown released', 'ok')
		render()
	} catch (error) {
		toast(error.message, 'bad')
	}
}

PAGES[7].render = async () => {
	const [snapshots, autoUpdate, apps] = await Promise.all([api('/snapshots'), api('/auto-update'), api('/apps')])
	const appSelect = h(
		'select',
		{},
		h('option', {value: '', text: 'Select an app…'}),
		...apps.map((app) => h('option', {value: app.id, text: `${app.name} (${app.id})`})),
	)
	const quotaCpus = h('input', {type: 'number', step: '0.1', min: '0', placeholder: 'e.g. 2'})
	const quotaMemory = h('input', {type: 'number', min: '64', placeholder: 'e.g. 2048'})
	const quotaPids = h('input', {type: 'number', min: '16', placeholder: 'e.g. 512'})
	const quotaVram = h('input', {type: 'number', min: '256', placeholder: 'e.g. 8192 (label only)'})
	const overrideText = h('textarea', {
		placeholder: 'services:\n  web:\n    environment:\n      MY_FLAG: "1"',
		style: 'min-height:120px',
	})
	const loadOverride = async () => {
		if (!appSelect.value) return
		try {
			const existing = await api(`/apps/${appSelect.value}/overrides`)
			overrideText.value = existing?.composeOverride ?? ''
			quotaCpus.value = existing?.quota?.cpus ?? ''
			quotaMemory.value = existing?.quota?.memoryMb ?? ''
			quotaPids.value = existing?.quota?.pids ?? ''
			quotaVram.value = existing?.quota?.vramMb ?? ''
		} catch (error) {
			toast(error.message, 'bad')
		}
	}
	appSelect.addEventListener('change', loadOverride)
	const saveOverride = async () => {
		try {
			await api(`/apps/${appSelect.value}/overrides`, {
				method: 'POST',
				body: {
					composeOverride: overrideText.value,
					quota: {
						...(quotaCpus.value ? {cpus: Number(quotaCpus.value)} : {}),
						...(quotaMemory.value ? {memoryMb: Number(quotaMemory.value)} : {}),
						...(quotaPids.value ? {pids: Number(quotaPids.value)} : {}),
						...(quotaVram.value ? {vramMb: Number(quotaVram.value)} : {}),
					},
				},
			})
			toast('Overrides saved. Restart the app to apply.', 'ok')
		} catch (error) {
			toast(error.message, 'bad')
		}
	}
	const autoEnabled = h('input', {type: 'checkbox', checked: autoUpdate.enabled})
	const autoStart = h('input', {type: 'text', value: autoUpdate.window.start})
	const autoEnd = h('input', {type: 'text', value: autoUpdate.window.end})
	const autoDays = h('input', {type: 'text', value: autoUpdate.window.days.join(',')})
	return h(
		'div',
		{},
		pageHead(
			'Snapshots & limits',
			'Per-app resources, persistent compose overrides, encrypted configuration snapshots, and maintenance windows.',
		),
		h(
			'div',
			{class: 'grid cols-2'},
			card(
				'Encrypted snapshots',
				'Configuration only. AES-256-GCM with this device key (or a passphrase).',
				h(
					'div',
					{class: 'form'},
					h('button', {
						class: 'btn primary',
						text: 'Create snapshot now',
						onclick: async () => {
							try {
								await api('/snapshots', {method: 'POST', body: {reason: 'manual'}})
								toast('Snapshot created', 'ok')
								render()
							} catch (error) {
								toast(error.message, 'bad')
							}
						},
					}),
					snapshots.length
						? h(
								'div',
								{class: 'list'},
								...snapshots.map((snapshot) =>
									h(
										'div',
										{class: 'list-row'},
										h(
											'div',
											{class: 'grow'},
											h('div', {text: snapshot.reason}),
											h('div', {
												class: 'tiny faint',
												text: `${fmtDate(snapshot.createdAt)} · ${bytes(snapshot.sizeBytes)} · ${snapshot.encryptedWith}`,
											}),
										),
										h('button', {
											class: 'btn sm',
											text: 'Restore',
											onclick: () =>
												confirmAction(
													'Restore snapshot',
													`Restore ${snapshot.id}? A restart is required afterwards.`,
													'Restore',
													async () => {
														await api(`/snapshots/${snapshot.id}/restore`, {method: 'POST', body: {}})
														toast('Restored. Restart umbreld to apply.', 'ok')
													},
													true,
												),
										}),
									),
								),
							)
						: empty('No snapshots yet.'),
				),
			),
			card(
				'Auto-update window',
				'Updates apps inside a maintenance window with a pre-update snapshot.',
				h(
					'div',
					{class: 'form'},
					h('label', {class: 'check'}, autoEnabled, 'Enable automatic app updates'),
					h(
						'div',
						{class: 'row'},
						h('div', {class: 'field'}, h('label', {text: 'Start (HH:MM)'}), autoStart),
						h('div', {class: 'field'}, h('label', {text: 'End (HH:MM)'}), autoEnd),
					),
					h('div', {class: 'field'}, h('label', {text: 'Days (0=Sunday … 6=Saturday)'}), autoDays),
					h('button', {
						class: 'btn primary',
						text: 'Save window',
						onclick: async () => {
							try {
								await api('/auto-update', {
									method: 'POST',
									body: {
										enabled: autoEnabled.checked,
										window: {
											start: autoStart.value,
											end: autoEnd.value,
											days: autoDays.value
												.split(',')
												.map(Number)
												.filter((day) => day >= 0 && day <= 6),
										},
									},
								})
								toast('Auto-update saved', 'ok')
							} catch (error) {
								toast(error.message, 'bad')
							}
						},
					}),
				),
			),
		),
		h('div', {class: 'section-label', text: 'App runtime overrides'}),
		card(
			'Compose override & quotas',
			'Stored outside the app directory, so it survives app updates and reinstalls.',
			h(
				'div',
				{class: 'form'},
				appSelect,
				h(
					'div',
					{class: 'row'},
					h('div', {class: 'field'}, h('label', {text: 'CPU limit'}), quotaCpus),
					h('div', {class: 'field'}, h('label', {text: 'Memory (MB)'}), quotaMemory),
					h('div', {class: 'field'}, h('label', {text: 'PIDs'}), quotaPids),
					h('div', {class: 'field'}, h('label', {text: 'VRAM label (MB)'}), quotaVram),
				),
				overrideText,
				h(
					'div',
					{class: 'row'},
					h('button', {class: 'btn primary', text: 'Save override', onclick: saveOverride}),
					h('button', {
						class: 'btn danger',
						text: 'Remove',
						onclick: async () => {
							try {
								await api(`/apps/${appSelect.value}/overrides`, {method: 'DELETE'})
								toast('Removed', 'ok')
								loadOverride()
							} catch (error) {
								toast(error.message, 'bad')
							}
						},
					}),
				),
			),
		),
	)
}

function statCard(label, value, sub, extra) {
	return h(
		'div',
		{class: 'card'},
		h('div', {class: 'tiny muted', text: label}),
		h('div', {class: 'stat'}, value),
		extra || (sub && h('div', {class: 'tiny faint', text: sub})),
	)
}

function actionCard(title, subtitle, label, action) {
	return h(
		'div',
		{class: 'card'},
		h('div', {class: 'card-title', text: title}),
		h('p', {class: 'card-sub', text: subtitle}),
		h('button', {class: 'btn sm', style: 'margin-top:14px', text: label, onclick: action}),
	)
}

function outcomePill(outcome) {
	const kind =
		outcome === 'success'
			? 'ok'
			: outcome === 'denied' || outcome === 'failure'
				? 'bad'
				: outcome === 'pending'
					? 'warn'
					: ''
	return pill(outcome, kind)
}

function statusPill(status) {
	const kind =
		status === 'installed'
			? 'ok'
			: status === 'denied' || status === 'failed'
				? 'bad'
				: status === 'pending' || status === 'installing'
					? 'warn'
					: ''
	return pill(status, kind)
}

/* -------------------------------------------------------------------------- */
/* Live approvals + boot                                                      */
/* -------------------------------------------------------------------------- */

async function refreshApprovals() {
	try {
		const approvals = await api('/approvals')
		const previous = state.approvals.length
		state.approvals = approvals
		const badge = document.querySelector('.nav-badge')
		if (badge) badge.textContent = String(approvals.length)
		if (previous !== approvals.length && ['overview', 'approvals'].includes(state.page)) render()
	} catch {
		// Signed out or transient; the next poll retries.
	}
}

function connectEvents() {
	if (state.eventSource) state.eventSource.close()
	const source = new EventSource('/umbra/api/approvals/stream')
	state.eventSource = source
	source.addEventListener('approval', (event) => {
		try {
			const approval = JSON.parse(event.data)
			if (!state.approvals.some((entry) => entry.id === approval.id)) state.approvals.unshift(approval)
			toast(`${approval.agentName} is waiting for approval`, 'bad')
			render()
		} catch {
			// Ignore malformed event.
		}
	})
	source.addEventListener('settled', () => refreshApprovals())
	source.onerror = () => {
		source.close()
		state.eventSource = null
		setTimeout(() => {
			if (state.session) connectEvents()
		}, 5000)
	}
}

async function boot() {
	try {
		state.session = await api('/session')
	} catch (error) {
		renderSignedOut(error.message === 'Not signed in' ? 'Sign in to umbrelOS to open Umbra.' : error.message)
		return
	}
	const hash = location.hash.replace(/^#\//, '')
	state.page = PAGES.some((page) => page.id === hash) ? hash : 'overview'
	try {
		if (state.session.principal.role === 'owner') await refreshApprovals()
	} catch {
		// ignore
	}
	render()
	if (state.session.principal.role === 'owner') {
		connectEvents()
		state.timer = setInterval(() => {
			void refreshApprovals()
		}, 20_000)
	}
}

window.addEventListener('hashchange', () => {
	const hash = location.hash.replace(/^#\//, '')
	if (!PAGES.some((page) => page.id === hash)) return
	state.page = hash
	render()
})

boot()
