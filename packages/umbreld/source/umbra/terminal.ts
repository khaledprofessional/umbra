import {EventEmitter} from 'node:events'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {stat} from 'node:fs/promises'

import type AuditLog from './audit.js'
import type AgentRegistry from './agents.js'
import type ConfigStore from './config.js'
import type {TerminalMode} from './config.js'
import {HttpError, randomId} from './util.js'

export type ApprovalRequest = {
	id: string
	agentTokenId: string
	agentName: string
	agentType?: string
	clientName?: string
	avatarUrl?: string
	command: string
	cwd: string
	reason?: string
	createdAt: number
	expiresAt: number
	ip?: string
}

export type ApprovalDecision =
	| {approved: true; decidedBy: string; automatic?: boolean}
	| {approved: false; decidedBy: string; reason: string; expired?: boolean}

type PendingApproval = {
	request: ApprovalRequest
	resolve: (decision: ApprovalDecision) => void
	timer: NodeJS.Timeout
}

const MAX_PENDING = 25
const MAX_COMMAND_BYTES = 8 * 1024

function matchesAllowlist(command: string, patterns: string[]): boolean {
	const normalized = command.trim()
	for (const raw of patterns) {
		const pattern = raw.trim()
		if (!pattern) continue
		if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
			try {
				if (new RegExp(pattern.slice(1, -1)).test(normalized)) return true
			} catch {
				// An invalid pattern never matches.
			}
			continue
		}
		if (pattern.endsWith('*')) {
			if (normalized.startsWith(pattern.slice(0, -1))) return true
			continue
		}
		if (normalized === pattern) return true
	}
	return false
}

/**
 * Two-tier terminal permission system.
 *
 * Each credential is either always-allowed (autonomous), ask-every-time
 * (blocked until an owner approves this exact command in the dashboard), or
 * denied. Allowlist patterns can pre-approve narrow commands even in ask mode.
 * Pending prompts are pushed to the UI over SSE and expire to a denial, so an
 * agent can never hang forever on an unattended device.
 */
export class ApprovalManager {
	readonly events = new EventEmitter()
	#pending = new Map<string, PendingApproval>()
	#audit: AuditLog

	constructor(audit: AuditLog) {
		this.#audit = audit
		this.events.setMaxListeners(100)
	}

	list(): ApprovalRequest[] {
		return [...this.#pending.values()].map((entry) => entry.request).sort((a, b) => a.createdAt - b.createdAt)
	}

	get(id: string): ApprovalRequest | undefined {
		return this.#pending.get(id)?.request
	}

	request(
		input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>,
		timeoutMs: number,
	): Promise<ApprovalDecision> {
		if (this.#pending.size >= MAX_PENDING) {
			throw new HttpError(429, 'Too many pending terminal approvals')
		}
		const now = Date.now()
		const request: ApprovalRequest = {
			...input,
			id: randomId(8),
			createdAt: now,
			expiresAt: now + timeoutMs,
		}
		this.#audit.record({
			type: 'terminal.request',
			action: 'Terminal command awaiting approval',
			actor: {
				type: 'agent',
				id: request.agentTokenId,
				name: request.agentName,
				ip: request.ip,
			},
			target: request.cwd,
			outcome: 'pending',
			detail: {approvalId: request.id, command: request.command},
		})
		const promise = new Promise<ApprovalDecision>((resolve) => {
			const timer = setTimeout(() => {
				this.#settle(request.id, {
					approved: false,
					decidedBy: 'timeout',
					reason: 'Approval timed out',
					expired: true,
				})
			}, timeoutMs)
			timer.unref?.()
			this.#pending.set(request.id, {request, resolve, timer})
		})
		this.events.emit('pending', request)
		return promise
	}

	decide(id: string, approved: boolean, actor: {id: string; name?: string; ip?: string}, reason?: string): boolean {
		const entry = this.#pending.get(id)
		if (!entry) return false
		const decision: ApprovalDecision = approved
			? {approved: true, decidedBy: actor.name ?? actor.id}
			: {
					approved: false,
					decidedBy: actor.name ?? actor.id,
					reason: reason?.slice(0, 300) || 'Denied by administrator',
				}
		this.#settle(id, decision)
		this.#audit.record({
			type: approved ? 'terminal.approved' : 'terminal.denied',
			action: approved ? 'Terminal command approved' : 'Terminal command denied',
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: entry.request.agentName,
			outcome: approved ? 'success' : 'denied',
			detail: {
				approvalId: id,
				command: entry.request.command,
				...(reason ? {reason} : {}),
			},
		})
		return true
	}

	#settle(id: string, decision: ApprovalDecision) {
		const entry = this.#pending.get(id)
		if (!entry) return
		clearTimeout(entry.timer)
		this.#pending.delete(id)
		if (decision.approved === false && 'expired' in decision && decision.expired) {
			this.#audit.record({
				type: 'terminal.denied',
				action: 'Terminal command approval expired',
				actor: {type: 'system', id: 'approval-timeout'},
				target: entry.request.agentName,
				outcome: 'denied',
				detail: {approvalId: id, command: entry.request.command},
			})
		}
		entry.resolve(decision)
		this.events.emit('settled', {request: entry.request, decision})
	}

	denyAll(reason: string) {
		for (const id of [...this.#pending.keys()]) {
			const entry = this.#pending.get(id)
			if (!entry) continue
			this.#audit.record({
				type: 'terminal.denied',
				action: 'Terminal command denied (shutdown)',
				actor: {type: 'system', id: 'shutdown'},
				target: entry.request.agentName,
				outcome: 'denied',
				detail: {approvalId: id, command: entry.request.command, reason},
			})
			this.#settle(id, {approved: false, decidedBy: 'system', reason})
		}
	}
}

export type TerminalResult = {
	exitCode: number | null
	signal: string | null
	stdout: string
	stderr: string
	timedOut: boolean
	truncated: boolean
	durationMs: number
	policy: TerminalMode | 'allowlist'
}

export type TerminalActor = {
	tokenId: string
	name: string
	agentType?: string
	clientName?: string
	ip?: string
}

/**
 * Non-interactive command execution. The terminal is a privileged capability:
 * it is only reachable through an MCP token whose owner has explicitly granted
 * it, and every invocation (including denials) lands in the audit log.
 */
export default class TerminalExecutor {
	#config: ConfigStore
	#agents: AgentRegistry
	#audit: AuditLog
	#approvals: ApprovalManager
	#shell: string
	#defaultCwd: string

	constructor(
		config: ConfigStore,
		agents: AgentRegistry,
		audit: AuditLog,
		approvals: ApprovalManager,
		options: {shell?: string; defaultCwd?: string} = {},
	) {
		this.#config = config
		this.#agents = agents
		this.#audit = audit
		this.#approvals = approvals
		this.#shell = options.shell ?? process.env.UMBRA_SHELL ?? '/bin/bash'
		this.#defaultCwd = options.defaultCwd ?? process.env.HOME ?? '/home/umbrel/umbrel'
	}

	get approvals() {
		return this.#approvals
	}

	async policyFor(tokenId: string): Promise<{mode: TerminalMode; allowlist: string[]}> {
		const config = await this.#config.load()
		const profile = this.#agents.getProfile(tokenId)
		const mode = profile?.terminal.mode && profile.terminal.mode !== 'inherit' ? profile.terminal.mode : 'ask'
		if (!config.terminal.enabled) return {mode: 'deny', allowlist: []}
		return {mode, allowlist: profile?.terminal.allowlist ?? []}
	}

	async execute(
		actor: TerminalActor,
		input: {command: string; cwd?: string; timeoutMs?: number; reason?: string},
	): Promise<TerminalResult> {
		const config = await this.#config.load()
		if (!config.terminal.enabled) throw new HttpError(403, 'Terminal access is disabled')
		const profile = this.#agents.getProfile(actor.tokenId)
		const actorIp = actor.ip ?? profile?.lastIp
		if (typeof input.command !== 'string') throw new HttpError(400, 'Command is required')
		const command = input.command.trim()
		if (!command) throw new HttpError(400, 'Command is empty')
		if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new HttpError(413, 'Command is too long')
		if (command.includes('\u0000')) throw new HttpError(400, 'Command contains a null byte')

		const timeoutMs = Math.min(Math.max(input.timeoutMs ?? config.terminal.defaultTimeoutMs, 1_000), 10 * 60_000)
		const policy = await this.policyFor(actor.tokenId)
		if (policy.mode === 'deny') {
			this.#audit.record({
				type: 'terminal.denied',
				action: 'Terminal access denied by policy',
				actor: {type: 'agent', id: actor.tokenId, name: actor.name, ip: actorIp},
				target: input.cwd ?? undefined,
				outcome: 'denied',
				detail: {command},
			})
			throw new HttpError(403, 'Terminal access is not granted for this agent')
		}
		const cwd = await this.#resolveCwd(input.cwd, config.terminal.allowedRoots)

		let effectivePolicy: TerminalResult['policy'] = policy.mode
		if (policy.mode === 'ask') {
			if (matchesAllowlist(command, policy.allowlist)) {
				effectivePolicy = 'allowlist'
			} else {
				const decision = await this.#approvals.request(
					{
						agentTokenId: actor.tokenId,
						agentName: actor.name,
						agentType: actor.agentType,
						clientName: actor.clientName,
						avatarUrl: profile?.avatar
							? `/umbra/api/agents/${actor.tokenId}/avatar?v=${profile.avatar.sha256.slice(0, 12)}`
							: undefined,
						command,
						cwd,
						reason: input.reason,
						ip: actorIp,
					},
					config.terminal.approvalTimeoutMs,
				)
				if (!decision.approved) {
					this.#audit.record({
						type: 'terminal.denied',
						action: 'Terminal command denied',
						actor: {type: 'agent', id: actor.tokenId, name: actor.name, ip: actorIp},
						target: cwd,
						outcome: 'denied',
						detail: {command, reason: decision.reason, decidedBy: decision.decidedBy},
					})
					throw new HttpError(403, `Terminal command denied: ${decision.reason}`)
				}
			}
		}

		const startedAt = Date.now()
		const result = await this.#spawn(command, cwd, timeoutMs, config.terminal.maxOutputBytes)
		this.#audit.record({
			type: 'terminal.executed',
			action: 'Terminal command executed',
			actor: {type: 'agent', id: actor.tokenId, name: actor.name, ip: actorIp},
			target: cwd,
			outcome: result.exitCode === 0 ? 'success' : 'failure',
			detail: {
				command,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				truncated: result.truncated,
				durationMs: result.durationMs,
				policy: effectivePolicy,
				// Output can contain credentials; only sizes are audited. The
				// agent receives the output it asked for in the tool result.
				stdoutBytes: Buffer.byteLength(result.stdout),
				stderrBytes: Buffer.byteLength(result.stderr),
			},
		})
		return {...result, policy: effectivePolicy}
	}

	async #resolveCwd(rawCwd: string | undefined, allowedRoots: string[]): Promise<string> {
		const candidate = path.resolve(rawCwd || this.#defaultCwd)
		for (const blocked of ['/proc', '/sys', '/dev']) {
			if (candidate === blocked || candidate.startsWith(`${blocked}/`)) {
				throw new HttpError(400, `Working directory cannot be ${blocked}`)
			}
		}
		if (allowedRoots.length) {
			const allowed = allowedRoots.some((root) => {
				const absolute = path.resolve(root)
				return candidate === absolute || candidate.startsWith(`${absolute}${path.sep}`)
			})
			if (!allowed) throw new HttpError(403, 'Working directory is outside the allowed roots')
		}
		const stats = await stat(candidate).catch(() => null)
		if (!stats?.isDirectory()) throw new HttpError(400, 'Working directory does not exist')
		return candidate
	}

	#spawn(
		command: string,
		cwd: string,
		timeoutMs: number,
		maxOutputBytes: number,
	): Promise<Omit<TerminalResult, 'policy'>> {
		const startedAt = Date.now()
		return new Promise((resolve) => {
			// A CPU rlimit bounds a runaway process even if the wall-clock timeout
			// is delayed by a stuck child. The command is passed as $1, never
			// interpolated into the wrapper script.
			const cpuSeconds = Math.ceil(timeoutMs / 1000) + 5
			const child = spawn(
				this.#shell,
				['-c', `ulimit -t ${cpuSeconds} 2>/dev/null; exec "${this.#shell}" -lc "$1"`, 'umbra-terminal', command],
				{
					cwd,
					detached: process.platform !== 'win32',
					stdio: ['ignore', 'pipe', 'pipe'],
					env: {
						PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
						HOME: process.env.HOME ?? '/root',
						LANG: process.env.LANG ?? 'C.UTF-8',
						TERM: 'dumb',
						UMBRA_TERMINAL: '1',
					},
				},
			)

			let stdout = ''
			let stderr = ''
			let truncated = false
			let timedOut = false
			const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
				const current = target === 'stdout' ? stdout : stderr
				if (Buffer.byteLength(current) >= maxOutputBytes) {
					truncated = true
					return
				}
				const remaining = maxOutputBytes - Buffer.byteLength(current)
				const text = chunk.length > remaining ? chunk.subarray(0, remaining).toString('utf8') : chunk.toString('utf8')
				if (chunk.length > remaining) truncated = true
				if (target === 'stdout') stdout += text
				else stderr += text
			}
			child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
			child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))

			const kill = (signal: NodeJS.Signals) => {
				if (child.pid === undefined) return
				try {
					if (process.platform === 'win32') child.kill(signal)
					else process.kill(-child.pid, signal)
				} catch {
					// The process already exited.
				}
			}

			const timer = setTimeout(() => {
				timedOut = true
				kill('SIGTERM')
				const force = setTimeout(() => kill('SIGKILL'), 2_000)
				force.unref?.()
			}, timeoutMs)
			timer.unref?.()

			child.on('error', (error) => {
				clearTimeout(timer)
				resolve({
					exitCode: null,
					signal: null,
					stdout,
					stderr: `${stderr}${stderr ? '\n' : ''}Failed to start command: ${error.message}`,
					timedOut,
					truncated,
					durationMs: Date.now() - startedAt,
				})
			})
			child.on('close', (exitCode, signal) => {
				clearTimeout(timer)
				resolve({
					exitCode,
					signal: signal ?? null,
					stdout,
					stderr,
					timedOut,
					truncated,
					durationMs: Date.now() - startedAt,
				})
			})
		})
	}
}
