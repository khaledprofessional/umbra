import {type ReactNode, useCallback, useEffect, useState} from 'react'

import {Button} from '@/components/ui/button'
import {Card} from '@/components/ui/card'
import {Dialog, DialogHeader, DialogScrollableContent, DialogTitle} from '@/components/ui/dialog'
import {Input} from '@/components/ui/input'
import {listClass, listItemClass} from '@/components/ui/list'
import {Switch} from '@/components/ui/switch'
import {toast} from '@/components/ui/toast'
import {cn} from '@/lib/utils'
import {UmbraApi, type MemberInstallPolicy} from '@/lib/umbra-api'
import {SectionLabel, useSettingsDialogProps} from '@/routes/settings/_components/shared'

type Agent = {
	tokenId: string
	label: string
	agentType?: string
	clientName?: string
	lastSeenAt: number
	lastIp?: string
	terminal: {mode: 'inherit' | 'deny' | 'ask' | 'always'; allowlist: string[]}
	avatarUrl?: string | null
}
type Approval = {
	id: string
	agentName: string
	agentType?: string
	command: string
	cwd: string
	expiresAt: number
	avatarUrl?: string
}
type Plugin = {
	id: string
	version: string
	enabled: boolean
	running: boolean
	lastError?: string
	manifest?: {name?: string; description?: string; permissions?: string[]; settings?: unknown[]}
}
type Member = {userId: string; name: string; policy: MemberInstallPolicy}
type AppRequest = {
	id: string
	appId: string
	appName: string
	userName: string
	status: string
	createdAt: number
	error?: string
}
type Summary = {
	cloudflare: {enabled: boolean; lockdown: boolean; hostname: string; publicUrl: string | null; health: {ready: boolean}}
	agents: Agent[]
	plugins: {id: string; enabled: boolean}[]
	approvals: Approval[]
}
type AuditEntry = {
	seq: number
	ts: number
	type: string
	action: string
	outcome: string
	actor: {type: string; id: string; name?: string}
	target?: string
}

const tabs = [
	{id: 'overview', label: 'Overview'},
	{id: 'agents', label: 'AI Agents'},
	{id: 'plugins', label: 'Plugins'},
	{id: 'users', label: 'Users & Requests'},
	{id: 'cloudflare', label: 'Cloudflare'},
	{id: 'audit', label: 'Logs'},
] as const
type TabId = (typeof tabs)[number]['id']

function useLoad<T>(path: string) {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState('')
	const refresh = useCallback(async () => {
		try {
			setData(await UmbraApi.get<T>(path))
			setError('')
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError))
		}
	}, [path])
	useEffect(() => {
		void refresh()
	}, [refresh])
	return {data, error, refresh, setData}
}

function Status({ok, children}: {ok: boolean; children: ReactNode}) {
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-11 font-medium',
				ok ? 'bg-green-400/15 text-green-300' : 'bg-white/8 text-white/50',
			)}
		>
			<span className={cn('size-1.5 rounded-full', ok ? 'bg-green-400' : 'bg-white/30')} />
			{children}
		</span>
	)
}

function AgentAvatar({agent}: {agent: {label?: string; agentName?: string; avatarUrl?: string | null}}) {
	const name = agent.label ?? agent.agentName ?? 'AI agent'
	if (agent.avatarUrl) return <img src={agent.avatarUrl} alt='' className='size-8 shrink-0 rounded-full object-cover' />
	return (
		<span className='grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-12 font-semibold text-white/80'>
			{name.slice(0, 1).toUpperCase()}
		</span>
	)
}

function Select({value, onChange, children}: {value: string; onChange: (value: string) => void; children: ReactNode}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className='h-9 rounded-full border border-white/10 bg-white/4 px-3 text-13 text-white/90 outline-none focus:border-white/40'
		>
			{children}
		</select>
	)
}

function Overview({summary, onTab}: {summary: Summary; onTab: (tab: TabId) => void}) {
	const connected = summary.agents.filter((agent) => Date.now() - agent.lastSeenAt < 5 * 60_000).length
	return (
		<div className='space-y-4'>
			<div className='grid grid-cols-2 gap-3'>
				<Card className='space-y-1'>
					<div className='text-12 text-white/45'>Cloudflare</div>
					<div className='text-17 font-semibold text-white/90'>
						{summary.cloudflare.lockdown ? 'Lockdown' : summary.cloudflare.health.ready ? 'Connected' : 'Off'}
					</div>
					<div className='truncate text-11 text-white/35'>{summary.cloudflare.hostname || 'No hostname'}</div>
				</Card>
				<Card className='space-y-1'>
					<div className='text-12 text-white/45'>AI agents</div>
					<div className='text-17 font-semibold text-white/90'>{connected} connected</div>
					<div className='text-11 text-white/35'>{summary.agents.length} credentials</div>
				</Card>
				<Card className='space-y-1'>
					<div className='text-12 text-white/45'>Pending approvals</div>
					<div className='text-17 font-semibold text-white/90'>{summary.approvals.length}</div>
					<div className='text-11 text-white/35'>terminal commands waiting</div>
				</Card>
				<Card className='space-y-1'>
					<div className='text-12 text-white/45'>Plugins</div>
					<div className='text-17 font-semibold text-white/90'>
						{summary.plugins.filter((plugin) => plugin.enabled).length} enabled
					</div>
					<div className='text-11 text-white/35'>{summary.plugins.length} installed</div>
				</Card>
			</div>
			<div className='flex flex-wrap gap-2'>
				<Button size='sm' onClick={() => onTab('agents')}>
					Review agents
				</Button>
				<Button size='sm' onClick={() => onTab('cloudflare')}>
					Cloudflare settings
				</Button>
				<Button size='sm' onClick={() => onTab('plugins')}>
					Manage plugins
				</Button>
				<Button size='sm' variant='default' onClick={() => window.open('/umbra/', '_blank', 'noopener,noreferrer')}>
					Open full console
				</Button>
			</div>
		</div>
	)
}

function AgentsSection() {
	const agents = useLoad<Agent[]>('/agents')
	const approvals = useLoad<Approval[]>('/approvals')
	const [allowlists, setAllowlists] = useState<Record<string, string>>({})

	const decide = async (id: string, approved: boolean) => {
		try {
			await UmbraApi.post(`/approvals/${id}/decide`, {approved})
			toast(approved ? 'Command approved' : 'Command denied')
			await approvals.refresh()
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	const setPolicy = async (tokenId: string, mode: string) => {
		try {
			await UmbraApi.post(`/agents/${tokenId}/terminal-policy`, {mode})
			toast('Terminal policy saved')
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	const saveAllowlist = async (agent: Agent) => {
		try {
			await UmbraApi.post(`/agents/${agent.tokenId}/terminal-policy`, {
				mode: agent.terminal.mode,
				allowlist: (allowlists[agent.tokenId] ?? agent.terminal.allowlist.join('\n'))
					.split('\n')
					.map((line) => line.trim())
					.filter(Boolean),
			})
			toast('Allowlist saved')
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}

	return (
		<div className='space-y-5'>
			{approvals.data && approvals.data.length > 0 && (
				<div className='space-y-2'>
					<SectionLabel>Waiting for approval</SectionLabel>
					<div className='space-y-2'>
						{approvals.data.map((approval) => (
							<Card key={approval.id} className='space-y-2 border border-red-400/20 bg-red-400/5'>
								<div className='flex items-center gap-2'>
									<AgentAvatar agent={approval} />
									<div className='min-w-0 flex-1'>
										<div className='truncate text-13 font-medium text-white/90'>{approval.agentName}</div>
										<div className='text-11 text-white/40'>{approval.cwd}</div>
									</div>
								</div>
								<pre className='max-h-32 overflow-auto rounded-8 bg-black/30 p-2 text-11 text-white/75'>
									{approval.command}
								</pre>
								<div className='flex gap-2'>
									<Button size='sm' variant='destructive' onClick={() => decide(approval.id, false)}>
										Deny
									</Button>
									<Button size='sm' variant='primary' onClick={() => decide(approval.id, true)}>
										Approve
									</Button>
								</div>
							</Card>
						))}
					</div>
				</div>
			)}

			<div className='space-y-2'>
				<SectionLabel>MCP credentials</SectionLabel>
				{agents.error && <p className='text-13 text-red-300'>{agents.error}</p>}
				<div className={listClass}>
					{(agents.data ?? []).map((agent) => (
						<div key={agent.tokenId} className='space-y-3 p-3'>
							<div className='flex items-center gap-3'>
								<AgentAvatar agent={agent} />
								<div className='min-w-0 flex-1'>
									<div className='truncate text-13 font-medium text-white/90'>{agent.label}</div>
									<div className='truncate text-11 text-white/40'>
										{[agent.agentType, agent.clientName, agent.lastIp].filter(Boolean).join(' · ') || 'never connected'}
									</div>
								</div>
								<Select value={agent.terminal.mode} onChange={(mode) => setPolicy(agent.tokenId, mode)}>
									<option value='inherit'>Ask (default)</option>
									<option value='ask'>Ask every time</option>
									<option value='always'>Always allowed</option>
									<option value='deny'>Denied</option>
								</Select>
							</div>
							<div className='flex gap-2'>
								<Input
									sizeVariant='short'
									placeholder='Pre-approved commands, one per line'
									value={allowlists[agent.tokenId] ?? agent.terminal.allowlist.join('\n')}
									onChange={(event) =>
										setAllowlists((current) => ({...current, [agent.tokenId]: event.target.value}))
									}
								/>
								<Button size='sm' onClick={() => saveAllowlist(agent)}>
									Save
								</Button>
							</div>
						</div>
					))}
					{agents.data?.length === 0 && (
						<div className={listItemClass}>
							<span className='text-13 text-white/45'>No agents connected. Create a token in Settings → AI agents.</span>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

function PluginsSection() {
	const plugins = useLoad<Plugin[]>('/plugins')
	const action = async (id: string, name: string, body: Record<string, unknown> = {}) => {
		try {
			await UmbraApi.post(`/plugins/${id}/${name}`, body)
			toast(`Plugin ${name}d`)
			await plugins.refresh()
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	return (
		<div className='space-y-2'>
			<SectionLabel>Installed plugins</SectionLabel>
			<div className={listClass}>
				{(plugins.data ?? []).map((plugin) => (
					<div key={plugin.id} className='space-y-2 p-3'>
						<div className='flex items-center gap-3'>
							<div className='min-w-0 flex-1'>
								<div className='truncate text-13 font-medium text-white/90'>
									{plugin.manifest?.name ?? plugin.id}
								</div>
								<div className='truncate text-11 text-white/40'>
									{plugin.id} · v{plugin.version}
								</div>
							</div>
							<Status ok={plugin.running}>{plugin.running ? 'Running' : plugin.enabled ? 'Enabled' : 'Disabled'}</Status>
						</div>
						{plugin.lastError && <div className='text-11 text-red-300'>{plugin.lastError}</div>}
						{plugin.manifest?.permissions && plugin.manifest.permissions.length > 0 && (
							<div className='flex flex-wrap gap-1'>
								{plugin.manifest.permissions.map((permission) => (
									<span key={permission} className='rounded-full bg-white/6 px-2 py-0.5 text-10 text-white/45'>
										{permission}
									</span>
								))}
							</div>
						)}
						<div className='flex gap-2'>
							{plugin.enabled ? (
								<Button size='sm' onClick={() => action(plugin.id, 'disable')}>
									Disable
								</Button>
							) : (
								<Button size='sm' variant='primary' onClick={() => action(plugin.id, 'enable')}>
									Enable
								</Button>
							)}
							<Button
								size='sm'
								variant='destructive'
								onClick={() => {
									if (window.confirm(`Uninstall ${plugin.id}? Its data is kept.`)) void action(plugin.id, 'uninstall')
								}}
							>
								Uninstall
							</Button>
						</div>
					</div>
				))}
				{plugins.data?.length === 0 && (
					<div className={listItemClass}>
						<span className='text-13 text-white/45'>No plugins installed. Use the full console to install or scaffold one.</span>
					</div>
				)}
			</div>
			<Button size='sm' variant='default' onClick={() => window.open('/umbra/#/plugins', '_blank', 'noopener,noreferrer')}>
				Install or scaffold a plugin
			</Button>
		</div>
	)
}

function UsersSection() {
	const members = useLoad<Member[]>('/access/members')
	const requests = useLoad<AppRequest[]>('/access/requests')
	const setPolicy = async (userId: string, policy: MemberInstallPolicy) => {
		try {
			await UmbraApi.post(`/access/members/${userId}/policy`, {policy})
			toast('Member policy saved')
			await members.refresh()
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	const decide = async (id: string, approved: boolean) => {
		try {
			await UmbraApi.post(`/access/requests/${id}/decide`, {approved})
			toast(approved ? 'Installing app…' : 'Request denied')
			setTimeout(() => void requests.refresh(), 1200)
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	return (
		<div className='space-y-5'>
			<div className='space-y-2'>
				<SectionLabel>Members</SectionLabel>
				<div className={listClass}>
					{(members.data ?? []).map((member) => (
						<div key={member.userId} className={listItemClass}>
							<div className='min-w-0 flex-1'>
								<div className='truncate text-13 font-medium text-white/90'>{member.name}</div>
								<div className='truncate text-11 text-white/40'>{member.userId}</div>
							</div>
							<Select value={member.policy} onChange={(policy) => setPolicy(member.userId, policy as MemberInstallPolicy)}>
								<option value='none'>No installs</option>
								<option value='request'>Request only</option>
								<option value='manage'>Can install</option>
							</Select>
						</div>
					))}
					{members.data?.length === 0 && (
						<div className={listItemClass}>
							<span className='text-13 text-white/45'>No member accounts.</span>
						</div>
					)}
				</div>
			</div>
			<div className='space-y-2'>
				<SectionLabel>App requests</SectionLabel>
				<div className={listClass}>
					{(requests.data ?? []).map((request) => (
						<div key={request.id} className='space-y-2 p-3'>
							<div className='flex items-center gap-3'>
								<div className='min-w-0 flex-1'>
									<div className='truncate text-13 font-medium text-white/90'>{request.appName}</div>
									<div className='truncate text-11 text-white/40'>
										{request.appId} · {request.userName}
									</div>
								</div>
								<span className='text-11 text-white/45'>{request.status}</span>
							</div>
							{request.error && <div className='text-11 text-red-300'>{request.error}</div>}
							{request.status === 'pending' && (
								<div className='flex gap-2'>
									<Button size='sm' variant='destructive' onClick={() => decide(request.id, false)}>
										Deny
									</Button>
									<Button size='sm' variant='primary' onClick={() => decide(request.id, true)}>
										Approve and install
									</Button>
								</div>
							)}
						</div>
					))}
					{requests.data?.length === 0 && (
						<div className={listItemClass}>
							<span className='text-13 text-white/45'>No app requests.</span>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

type CloudflareSettings = {
	enabled: boolean
	hostname: string
	mode: 'token' | 'credentials'
	image: string
	tokenSet: boolean
	credentialsSet: boolean
	access: {enabled: boolean; teamDomain: string; audience: string; allowedEmails: string[]; protectedPrefixes: string[]}
	security: {
		loginRateLimitPerMinute: number
		loginLockoutThreshold: number
		loginLockoutMinutes: number
		hsts: boolean
		strictCsp: boolean
		originLock: boolean
		blockDirectIp: boolean
	}
}
type CloudflareStatus = {
	enabled: boolean
	lockdown: boolean
	hostname: string
	publicUrl: string | null
	health: {ready: boolean; error?: string}
	container: {exists: boolean; state: string}
	lastError?: string
}

function CloudflareSection() {
	const cloudflare = useLoad<{settings: CloudflareSettings; status: CloudflareStatus; logs: string}>('/cloudflare')
	const [form, setForm] = useState<CloudflareSettings | null>(null)
	const [token, setToken] = useState('')
	const [credentials, setCredentials] = useState('')

	useEffect(() => {
		if (cloudflare.data?.settings) setForm(cloudflare.data.settings)
	}, [cloudflare.data])
	if (!form) return <p className='text-13 text-white/45'>Loading Cloudflare settings…</p>

	const update = (patch: Partial<CloudflareSettings>) => setForm((current) => ({...current!, ...patch}))
	const updateAccess = (patch: Partial<CloudflareSettings['access']>) =>
		setForm((current) => ({...current!, access: {...current!.access, ...patch}}))
	const updateSecurity = (patch: Partial<CloudflareSettings['security']>) =>
		setForm((current) => ({...current!, security: {...current!.security, ...patch}}))

	const run = async (operation: () => Promise<unknown>, message: string) => {
		try {
			await operation()
			toast(message)
			await cloudflare.refresh()
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		}
	}
	const save = () =>
		run(
			() =>
				UmbraApi.post('/cloudflare/settings', {
					hostname: form.hostname,
					mode: form.mode,
					image: form.image,
					access: form.access,
					security: form.security,
				}),
			'Cloudflare settings saved',
		)

	const status = cloudflare.data?.status
	return (
		<div className='space-y-5'>
			<Card className='space-y-2'>
				<div className='flex items-center justify-between gap-2'>
					<div>
						<div className='text-13 font-medium text-white/90'>{status?.publicUrl ?? 'Not configured'}</div>
						<div className='text-11 text-white/40'>{status?.hostname || 'No hostname set'}</div>
					</div>
					<Status ok={Boolean(status?.health.ready)}>
						{status?.lockdown ? 'Lockdown' : status?.health.ready ? 'Connected' : status?.enabled ? 'Starting' : 'Off'}
					</Status>
				</div>
				{status?.lastError && <div className='text-11 text-red-300'>{status.lastError}</div>}
				<div className='flex flex-wrap gap-2'>
					{status?.enabled ? (
						<Button size='sm' onClick={() => run(() => UmbraApi.post('/cloudflare/disable'), 'Tunnel disabled')}>
							Disable
						</Button>
					) : (
						<Button
							size='sm'
							variant='primary'
							onClick={() => run(() => UmbraApi.post('/cloudflare/enable'), 'Tunnel enabled')}
						>
							Enable
						</Button>
					)}
					<Button
						size='sm'
						variant='destructive'
						onClick={() =>
							run(() => UmbraApi.post('/cloudflare/lockdown', {locked: true}), 'Emergency lockdown enabled')
						}
					>
						Kill switch
					</Button>
				</div>
			</Card>

			<div className='space-y-2'>
				<SectionLabel>Tunnel</SectionLabel>
				<Card className='space-y-3'>
					<label className='block space-y-1'>
						<span className='text-12 text-white/50'>Public hostname</span>
						<Input
							sizeVariant='short'
							placeholder='umbrel.example.com'
							value={form.hostname}
							onChange={(event) => update({hostname: event.target.value})}
						/>
					</label>
					<div className='flex items-center justify-between gap-3'>
						<span className='text-12 text-white/50'>Mode</span>
						<Select value={form.mode} onChange={(mode) => update({mode: mode as CloudflareSettings['mode']})}>
							<option value='token'>Tunnel token</option>
							<option value='credentials'>Credentials file</option>
						</Select>
					</div>
					<label className='block space-y-1'>
						<span className='text-12 text-white/50'>Cloudflared image</span>
						<Input
							sizeVariant='short'
							value={form.image}
							onChange={(event) => update({image: event.target.value})}
						/>
					</label>
				</Card>
			</div>

			<div className='space-y-2'>
				<SectionLabel>Credentials</SectionLabel>
				<Card className='space-y-3'>
					<div className='flex gap-2'>
						<Input
							sizeVariant='short'
							type='password'
							placeholder={form.tokenSet ? 'Token stored — paste to replace' : 'Tunnel token'}
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
						<Button
							size='sm'
							onClick={() => run(() => UmbraApi.post('/cloudflare/token', {token}), 'Tunnel token stored')}
						>
							Store
						</Button>
					</div>
					<textarea
						className='min-h-20 w-full rounded-8 border border-white/10 bg-white/4 p-2 text-11 text-white/80 outline-none focus:border-white/40'
						placeholder='{"AccountTag":"…","TunnelID":"…","TunnelSecret":"…"}'
						value={credentials}
						onChange={(event) => setCredentials(event.target.value)}
					/>
					<Button
						size='sm'
						onClick={() =>
							run(() => UmbraApi.post('/cloudflare/credentials', {credentials: JSON.parse(credentials)}), 'Credentials stored')
						}
					>
						Store credentials
					</Button>
					<div className='flex gap-3 text-11 text-white/40'>
						<span>Token: {form.tokenSet ? 'stored' : 'missing'}</span>
						<span>Credentials: {form.credentialsSet ? 'stored' : 'missing'}</span>
					</div>
				</Card>
			</div>

			<div className='space-y-2'>
				<SectionLabel>Zero Trust & hardening</SectionLabel>
				<Card className='space-y-3'>
					<label className='flex items-center justify-between gap-3'>
						<span className='text-13 text-white/80'>Require Cloudflare Access</span>
						<Switch checked={form.access.enabled} onCheckedChange={(enabled) => updateAccess({enabled})} />
					</label>
					<label className='block space-y-1'>
						<span className='text-12 text-white/50'>Team domain</span>
						<Input
							sizeVariant='short'
							value={form.access.teamDomain}
							onChange={(event) => updateAccess({teamDomain: event.target.value})}
						/>
					</label>
					<label className='block space-y-1'>
						<span className='text-12 text-white/50'>Audience tag</span>
						<Input
							sizeVariant='short'
							value={form.access.audience}
							onChange={(event) => updateAccess({audience: event.target.value})}
						/>
					</label>
					<label className='block space-y-1'>
						<span className='text-12 text-white/50'>Allowed emails (comma separated, empty = any)</span>
						<Input
							sizeVariant='short'
							value={form.access.allowedEmails.join(', ')}
							onChange={(event) =>
								updateAccess({
									allowedEmails: event.target.value
										.split(',')
										.map((email) => email.trim())
										.filter(Boolean),
								})
							}
						/>
					</label>
					<div className='grid grid-cols-3 gap-2'>
						<label className='block space-y-1'>
							<span className='text-11 text-white/40'>Logins/min</span>
							<Input
								sizeVariant='short'
								type='number'
								value={form.security.loginRateLimitPerMinute}
								onChange={(event) => updateSecurity({loginRateLimitPerMinute: Number(event.target.value)})}
							/>
						</label>
						<label className='block space-y-1'>
							<span className='text-11 text-white/40'>Lockout after</span>
							<Input
								sizeVariant='short'
								type='number'
								value={form.security.loginLockoutThreshold}
								onChange={(event) => updateSecurity({loginLockoutThreshold: Number(event.target.value)})}
							/>
						</label>
						<label className='block space-y-1'>
							<span className='text-11 text-white/40'>Minutes</span>
							<Input
								sizeVariant='short'
								type='number'
								value={form.security.loginLockoutMinutes}
								onChange={(event) => updateSecurity({loginLockoutMinutes: Number(event.target.value)})}
							/>
						</label>
					</div>
					<div className='grid grid-cols-2 gap-2'>
						<label className='flex items-center justify-between gap-2 text-12 text-white/70'>
							HSTS
							<Switch checked={form.security.hsts} onCheckedChange={(hsts) => updateSecurity({hsts})} />
						</label>
						<label className='flex items-center justify-between gap-2 text-12 text-white/70'>
							Strict CSP
							<Switch checked={form.security.strictCsp} onCheckedChange={(strictCsp) => updateSecurity({strictCsp})} />
						</label>
						<label className='flex items-center justify-between gap-2 text-12 text-white/70'>
							Origin lock
							<Switch checked={form.security.originLock} onCheckedChange={(originLock) => updateSecurity({originLock})} />
						</label>
						<label className='flex items-center justify-between gap-2 text-12 text-white/70'>
							Block direct origin
							<Switch
								checked={form.security.blockDirectIp}
								onCheckedChange={(blockDirectIp) => updateSecurity({blockDirectIp})}
							/>
						</label>
					</div>
				</Card>
			</div>

			<div className='flex flex-wrap gap-2'>
				<Button size='sm' variant='primary' onClick={save}>
					Save settings
				</Button>
				<Button
					size='sm'
					onClick={() => run(() => UmbraApi.post('/cloudflare/lockdown', {locked: false}), 'Lockdown released')}
				>
					Release lockdown
				</Button>
			</div>
		</div>
	)
}

function AuditSection() {
	const audit = useLoad<{events: AuditEntry[]; nextCursor: number | null}>('/audit?limit=50')
	const [verifying, setVerifying] = useState(false)
	const verify = async () => {
		setVerifying(true)
		try {
			const result = await UmbraApi.get<{ok: boolean; entries: number; error?: string}>('/audit/verify')
			toast(result.ok ? `Audit chain verified (${result.entries} entries)` : `Chain broken: ${result.error}`)
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error))
		} finally {
			setVerifying(false)
		}
	}
	return (
		<div className='space-y-3'>
			<div className='flex items-center justify-between gap-2'>
				<SectionLabel>Recent AI agent activity</SectionLabel>
				<Button size='sm' onClick={verify} disabled={verifying}>
					{verifying ? 'Verifying…' : 'Verify integrity'}
				</Button>
			</div>
			<div className={listClass}>
				{(audit.data?.events ?? []).map((event) => (
					<div key={event.seq} className='space-y-1 p-3'>
						<div className='flex items-center gap-2'>
							<span className='min-w-0 flex-1 truncate text-13 text-white/85'>{event.action}</span>
							<span
								className={cn(
									'rounded-full px-2 py-0.5 text-10',
									event.outcome === 'success'
										? 'bg-green-400/15 text-green-300'
										: event.outcome === 'denied' || event.outcome === 'failure'
											? 'bg-red-400/15 text-red-300'
											: 'bg-white/8 text-white/45',
								)}
							>
								{event.outcome}
							</span>
						</div>
						<div className='text-11 text-white/40'>
							{new Date(event.ts).toLocaleString()} · {event.actor.name ?? event.actor.id} · {event.type}
						</div>
					</div>
				))}
				{audit.data?.events.length === 0 && (
					<div className={listItemClass}>
						<span className='text-13 text-white/45'>No audit events yet.</span>
					</div>
				)}
			</div>
		</div>
	)
}

export function UmbraSettings({
	page = 'overview',
	title,
	description,
}: {
	page?: TabId
	title?: string
	description?: string
}) {
	const dialogProps = useSettingsDialogProps()
	const [tab, setTab] = useState<TabId>(page)
	const summary = useLoad<Summary>('/summary')
	const heading = title ?? tabs.find((entry) => entry.id === tab)?.label ?? 'Umbra'

	return (
		<Dialog {...dialogProps}>
			<DialogScrollableContent className='sm:max-w-[680px]'>
				<div className='space-y-5 px-5 py-6'>
					<DialogHeader>
						<DialogTitle>{heading}</DialogTitle>
					{description && <p className='text-12 leading-tight text-white/45'>{description}</p>}
					</DialogHeader>
					<div className='flex flex-wrap gap-1'>
						{tabs.map((entry) => (
							<Button
								key={entry.id}
								size='sm'
								variant={tab === entry.id ? 'primary' : 'default'}
								onClick={() => setTab(entry.id)}
							>
								{entry.label}
							</Button>
						))}
					</div>
					{tab === 'overview' &&
						(summary.data ? (
							<Overview summary={summary.data} onTab={setTab} />
						) : (
							<p className='text-13 text-white/45'>{summary.error || 'Loading…'}</p>
						))}
					{tab === 'agents' && <AgentsSection />}
					{tab === 'plugins' && <PluginsSection />}
					{tab === 'users' && <UsersSection />}
					{tab === 'cloudflare' && <CloudflareSection />}
					{tab === 'audit' && <AuditSection />}
				</div>
			</DialogScrollableContent>
		</Dialog>
	)
}
