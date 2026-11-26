import type {McpServer} from '@modelcontextprotocol/server'
import {z} from 'zod4'

import type {McpPermissions} from '../modules/mcp/mcp.js'
import {runTool, type McpToolContext} from '../modules/mcp/tools/shared.js'
import {fetchAndSanitizeAvatar} from './image.js'
import type Umbra from './index.js'

function agentName(agent: McpToolContext['agent']): string {
	if (!agent) return 'Unknown agent'
	return agent.clientName ? `${agent.label} (${agent.clientName})` : agent.label
}

/**
 * Registers Umbra's MCP tools onto the single native umbrelOS MCP endpoint.
 * Terminal access is only advertised when the credential has a live policy,
 * and plugin/audit tools require the existing `manageSystem` grant.
 */
export default function registerUmbraMcpTools(
	server: McpServer,
	context: McpToolContext,
	permissions: McpPermissions,
	umbra: Umbra,
	terminalMode: 'deny' | 'ask' | 'always',
) {
	if (terminalMode !== 'deny') {
		server.registerTool(
			'run_terminal_command',
			{
				title: 'Run a terminal command',
				description:
					'Run a non-interactive shell command on the umbrelOS host and return its exit code, stdout, and stderr. ' +
					'Depending on the permission chosen by the device owner, the command may need explicit approval in the ' +
					'umbrelOS dashboard before it runs. Use it for diagnostics and maintenance, not for editing Umbra files.',
				inputSchema: z.object({
					command: z.string().min(1).max(8192).describe('The exact shell command to execute'),
					cwd: z.string().min(1).max(512).optional().describe('Working directory (defaults to the data directory)'),
					timeout_ms: z.number().int().min(1000).max(600000).optional(),
					justification: z.string().max(500).optional().describe('Why this command is needed; shown to the approver'),
				}),
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
			},
			(input) =>
				runTool(context, 'run_terminal_command', input, async () => {
					if (!context.agent) throw new Error('This tool requires an identified MCP credential')
					const result = await umbra.terminal.execute(
						{
							tokenId: context.agent.tokenId,
							name: agentName(context.agent),
							agentType: context.agent.agentType,
							clientName: context.agent.clientName,
						},
						{
							command: input.command,
							cwd: input.cwd,
							timeoutMs: input.timeout_ms,
							reason: input.justification,
						},
					)
					return result
				}),
		)
	}

	server.registerTool(
		'set_agent_avatar',
		{
			title: 'Set your avatar',
			description:
				'Submit an image URL to use as your avatar in the umbrelOS AI Agent logs and approvals. ' +
				'The device downloads, validates, strips metadata from, and stores the image locally so it persists offline.',
			inputSchema: z.object({
				image_url: z.string().url().max(2048).describe('HTTPS URL of a PNG, JPEG, or WebP image (max 4 MB)'),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		(input) =>
			runTool(context, 'set_agent_avatar', input, async () => {
				if (!context.agent) throw new Error('This tool requires an identified MCP credential')
				await umbra.agents.ensureProfile(context.agent.tokenId, context.agent.label, context.agent.agentType)
				const profile = umbra.agents.getProfile(context.agent.tokenId)
				if (profile?.avatar && Date.now() - profile.avatar.updatedAt < 60_000) {
					throw new Error('Avatar was updated less than a minute ago; try again later')
				}
				const image = await fetchAndSanitizeAvatar(input.image_url)
				const avatar = await umbra.agents.setAvatar(
					context.agent.tokenId,
					image,
					{type: 'agent', id: context.agent.tokenId, name: agentName(context.agent)},
				)
				return {
					ok: true,
					avatarUrl: `/umbra/api/agents/${context.agent.tokenId}/avatar?v=${avatar.sha256.slice(0, 12)}`,
					width: avatar.width,
					height: avatar.height,
					mime: avatar.mime,
				}
			}),
	)

	if (!permissions.manageSystem) return

	server.registerTool(
		'list_plugins',
		{
			title: 'List Umbra plugins',
			description: 'List installed umbrelOS Umbra plugins with their version, enabled state, permissions, and errors.',
			inputSchema: z.object({}),
			annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'list_plugins', input, async () =>
				(await umbra.plugins.list()).map((plugin) => ({
					id: plugin.id,
					version: plugin.version,
					enabled: plugin.enabled,
					running: plugin.running,
					permissions: plugin.manifest?.permissions ?? [],
					lastError: plugin.lastError ?? null,
				})),
			),
	)

	server.registerTool(
		'install_plugin',
		{
			title: 'Install an Umbra plugin',
			description:
				'Install a plugin from its strict manifest and source files. The plugin is validated, sandboxed, and installed disabled unless enable is true. ' +
				'Use plugin_scaffold first to generate a valid manifest and starter files.',
			inputSchema: z.object({
				manifest: z.record(z.string(), z.unknown()).describe('umbra-plugin.json content'),
				files: z
					.array(z.object({path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional()}))
					.max(200),
				enable: z.boolean().optional(),
			}),
			annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'install_plugin', input, async () => {
				if (!context.agent) throw new Error('This tool requires an identified MCP credential')
				const plugin = await umbra.plugins.install(
					{manifest: input.manifest, files: input.files, enable: input.enable},
					{id: context.agent.tokenId, name: agentName(context.agent)},
				)
				return {id: plugin.id, version: plugin.version, enabled: plugin.enabled, running: plugin.running}
			}),
	)

	server.registerTool(
		'plugin_scaffold',
		{
			title: 'Scaffold a plugin',
			description:
				'Generate a deterministic, schema-valid plugin manifest and starter files. Returns the manifest and files ready to pass to install_plugin.',
			inputSchema: z.object({
				id: z.string().describe('Reverse-DNS id, e.g. com.example.weather'),
				name: z.string().min(1).max(60),
				description: z.string().max(500).optional(),
				with_backend: z.boolean().optional(),
				with_widget: z.boolean().optional(),
				with_route: z.boolean().optional(),
			}),
			annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'plugin_scaffold', input, async () =>
				umbra.plugins.scaffold({
					id: input.id,
					name: input.name,
					description: input.description,
					withBackend: input.with_backend,
					withWidget: input.with_widget,
					withRoute: input.with_route,
				}),
			),
	)

	server.registerTool(
		'enable_plugin',
		{
			title: 'Enable a plugin',
			description: 'Enable an installed plugin and start its sandboxed backend.',
			inputSchema: z.object({id: z.string()}),
			annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'enable_plugin', input, async () => {
				if (!context.agent) throw new Error('This tool requires an identified MCP credential')
				return umbra.plugins.enable(input.id, {
					id: context.agent.tokenId,
					name: agentName(context.agent),
				})
			}),
	)

	server.registerTool(
		'disable_plugin',
		{
			title: 'Disable a plugin',
			description: 'Stop a plugin sandbox and mark the plugin disabled.',
			inputSchema: z.object({id: z.string()}),
			annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'disable_plugin', input, async () => {
				if (!context.agent) throw new Error('This tool requires an identified MCP credential')
				return umbra.plugins.disable(input.id, {id: context.agent.tokenId, name: agentName(context.agent)})
			}),
	)

	server.registerTool(
		'uninstall_plugin',
		{
			title: 'Uninstall a plugin',
			description: 'Stop and remove a plugin. Its data is kept unless remove_data is true.',
			inputSchema: z.object({id: z.string(), remove_data: z.boolean().optional()}),
			annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'uninstall_plugin', input, async () => {
				if (!context.agent) throw new Error('This tool requires an identified MCP credential')
				return umbra.plugins.uninstall(
					input.id,
					{id: context.agent.tokenId, name: agentName(context.agent)},
					input.remove_data,
				)
			}),
	)

	server.registerTool(
		'query_audit_log',
		{
			title: 'Query the AI agent audit log',
			description: 'Read tamper-evident audit events for MCP connections, tool calls, terminal commands, approvals, and plugin changes.',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(200).optional(),
				before: z.number().int().optional(),
				type: z.string().max(60).optional(),
				actor_id: z.string().max(64).optional(),
				outcome: z.enum(['success', 'failure', 'denied', 'pending']).optional(),
				search: z.string().max(200).optional(),
			}),
			annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
		},
		(input) =>
			runTool(context, 'query_audit_log', input, () =>
				umbra.audit.query({
					limit: input.limit,
					before: input.before,
					type: input.type,
					actorId: input.actor_id,
					outcome: input.outcome,
					search: input.search,
				}),
			),
	)
}
