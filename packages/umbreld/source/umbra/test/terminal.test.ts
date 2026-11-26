import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {after, before, describe, it} from 'node:test'

import AgentRegistry from '../agents.js'
import AuditLog from '../audit.js'
import ConfigStore from '../config.js'
import SecretStore from '../secrets.js'
import TerminalExecutor, {ApprovalManager} from '../terminal.js'
import {cleanup, makeTempDir} from './helpers.js'

const TOKEN = 'a'.repeat(32)

describe('terminal approvals and policy', () => {
	let directory: string
	let config: ConfigStore
	let audit: AuditLog
	let agents: AgentRegistry
	let approvals: ApprovalManager
	let terminal: TerminalExecutor

	before(async () => {
		directory = await makeTempDir()
		config = new ConfigStore(directory)
		const secrets = new SecretStore(directory)
		audit = new AuditLog(directory)
		await secrets.start()
		await audit.start()
		agents = new AgentRegistry(directory, audit, secrets)
		await agents.start()
		approvals = new ApprovalManager(audit)
		terminal = new TerminalExecutor(config, agents, audit, approvals)
		await agents.observe({tokenId: TOKEN, label: 'Claude Code', agentType: 'claude-code', clientName: 'claude'})
	})
	after(async () => {
		await cleanup(directory)
	})

	it('defaults an agent to ask-every-time', async () => {
		const policy = await terminal.policyFor(TOKEN)
		assert.equal(policy.mode, 'ask')
	})

	it('approves a pending command and records both sides', async () => {
		const decision = approvals.request(
			{
				agentTokenId: TOKEN,
				agentName: 'Claude Code (claude)',
				command: 'df -h',
				cwd: '/home/umbrel',
				ip: '203.0.113.5',
			},
			5_000,
		)
		const pending = approvals.list()
		assert.equal(pending.length, 1)
		assert.equal(pending[0].command, 'df -h')
		assert.equal(approvals.decide(pending[0].id, true, {id: '0', name: 'Owner'}), true)
		const result = await decision
		assert.equal(result.approved, true)
		await audit.flush()
		const entries = await audit.query({limit: 20})
		assert.ok(entries.events.some((entry) => entry.type === 'terminal.request'))
		assert.ok(entries.events.some((entry) => entry.type === 'terminal.approved'))
	})

	it('expires to a denial so an agent cannot hang forever', async () => {
		const decision = approvals.request(
			{agentTokenId: TOKEN, agentName: 'Claude Code', command: 'rm -rf /', cwd: '/home/umbrel'},
			60,
		)
		const result = await decision
		assert.equal(result.approved, false)
		assert.equal('expired' in result && result.expired, true)
	})

	it('denies execution when the agent policy is deny', async () => {
		await agents.setTerminalPolicy(TOKEN, {mode: 'deny'}, {id: '0', name: 'Owner'})
		assert.equal((await terminal.policyFor(TOKEN)).mode, 'deny')
		await assert.rejects(
			() => terminal.execute({tokenId: TOKEN, name: 'Claude Code'}, {command: 'id'}),
			/not granted/,
		)
	})

	it('runs a pre-approved command when bash is available', async (context) => {
		if (!existsSync('/bin/bash')) {
			context.skip('bash is not available on this platform')
			return
		}
		await agents.setTerminalPolicy(TOKEN, {mode: 'always'}, {id: '0', name: 'Owner'})
		const result = await terminal.execute(
			{tokenId: TOKEN, name: 'Claude Code'},
			{command: 'printf "hello"', cwd: '/tmp', timeoutMs: 5_000},
		)
		assert.equal(result.exitCode, 0)
		assert.equal(result.stdout, 'hello')
		assert.equal(result.policy, 'always')
	})

	it('never lets a command escape the configured working roots', async () => {
		await config.update((draft) => {
			draft.terminal.allowedRoots = ['/tmp']
		})
		await agents.setTerminalPolicy(TOKEN, {mode: 'always'}, {id: '0', name: 'Owner'})
		await assert.rejects(
			() => terminal.execute({tokenId: TOKEN, name: 'Agent'}, {command: 'id', cwd: '/'}),
			/outside the allowed roots/,
		)
	})
})
