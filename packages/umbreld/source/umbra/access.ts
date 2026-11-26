import type AuditLog from './audit.ts'
import type ConfigStore from './config.ts'
import type {AppAccessPolicy, AppRequest} from './config.ts'
import type {UmbrelLike} from './types.ts'
import {HttpError, randomId} from './util.ts'

export type MemberSummary = {
	userId: string
	name: string
	policy: AppAccessPolicy
}

const POLICIES: AppAccessPolicy[] = ['none', 'request', 'manage']
const MAX_REQUESTS = 200

/**
 * Role-based app installation plus the member request queue.
 *
 * The owner always manages apps. Each member gets one of three policies:
 *   none    - cannot install or request
 *   request - Install becomes Request App; the owner decides
 *   manage   - may install directly from the App Store
 * Approved requests install through the same `apps.install` path as the
 * official UI and share the app with the requester so it appears on their
 * desktop.
 */
export default class AppAccessManager {
	#config: ConfigStore
	#audit: AuditLog
	#umbreld: UmbrelLike
	#logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	#installing = new Set<string>()

	constructor(input: {
		config: ConfigStore
		audit: AuditLog
		umbreld: UmbrelLike
		logger: {log: (...args: unknown[]) => void; error: (...args: unknown[]) => void}
	}) {
		this.#config = input.config
		this.#audit = input.audit
		this.#umbreld = input.umbreld
		this.#logger = input.logger
	}

	async policyFor(userId: string): Promise<AppAccessPolicy> {
		if (userId === '0') return 'manage'
		const config = await this.#config.load()
		return config.access.members[userId]?.appInstall ?? config.access.defaultPolicy
	}

	async canInstallDirectly(userId: string): Promise<boolean> {
		return (await this.policyFor(userId)) === 'manage'
	}

	/** A restart during installation must not leave a request "installing" forever. */
	async reconcileInterruptedInstalls() {
		await this.#config.update((draft) => {
			for (const request of draft.access.requests) {
				if (request.status !== 'installing') continue
				request.status = 'failed'
				request.error = 'Installation was interrupted by a restart; approve it again to retry.'
			}
		})
	}

	async listMembers(): Promise<MemberSummary[]> {
		const config = await this.#config.load()
		const members = (await this.#umbreld.user?.listMembers?.()) ?? []
		return members.map((member) => ({
			userId: member.id,
			name: member.name,
			policy: config.access.members[member.id]?.appInstall ?? config.access.defaultPolicy,
		}))
	}

	async setPolicy(userId: string, policy: AppAccessPolicy, actor: {id: string; name?: string; ip?: string}) {
		if (!POLICIES.includes(policy)) throw new HttpError(400, 'Invalid app install policy')
		if (userId === '0') throw new HttpError(400, 'The owner always manages apps')
		const member = await this.#umbreld.user?.getMember?.(userId)
		if (!member) throw new HttpError(404, 'Member not found')
		await this.#config.update((draft) => {
			const now = Date.now()
			draft.access.members[userId] = {
				appInstall: policy,
				createdAt: draft.access.members[userId]?.createdAt ?? now,
				updatedAt: now,
			}
		})
		this.#audit.record({
			type: 'access.policy',
			action: `Set app install policy to '${policy}'`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: member.name ?? userId,
			detail: {userId, policy},
		})
		return {userId, policy}
	}

	async listRequests(options: {status?: string; limit?: number} = {}) {
		const config = await this.#config.load()
		const requests = config.access.requests
			.filter((request) => !options.status || request.status === options.status)
			.slice()
			.reverse()
			.slice(0, Math.min(options.limit ?? 100, MAX_REQUESTS))
		return requests
	}

	async requestApp(input: {
		userId: string
		userName: string
		appId: string
		appName: string
		message?: string
		ip?: string
	}): Promise<AppRequest> {
		const policy = await this.policyFor(input.userId)
		if (policy === 'none') throw new HttpError(403, 'App installation is not permitted for this account')
		if (policy === 'manage') {
			await this.installForMember(input.userId, input.appId, input.appName)
			const config = await this.#config.load()
			return (
				config.access.requests.find(
					(request) =>
						request.appId === input.appId && request.userId === input.userId && request.status === 'installed',
				) ?? {
					id: randomId(8),
					appId: input.appId,
					appName: input.appName,
					userId: input.userId,
					userName: input.userName,
					status: 'installed',
					createdAt: Date.now(),
				}
			)
		}
		if (!/^[a-zA-Z0-9-_]{1,80}$/.test(input.appId)) throw new HttpError(400, 'Invalid app id')
		const config = await this.#config.load()
		const existing = config.access.requests.find(
			(request) =>
				request.appId === input.appId &&
				request.userId === input.userId &&
				(['pending', 'installing', 'installed'] as string[]).includes(request.status),
		)
		if (existing) return existing
		if (config.access.requests.filter((request) => request.status === 'pending').length >= MAX_REQUESTS) {
			throw new HttpError(429, 'The request queue is full')
		}
		const request: AppRequest = {
			id: randomId(8),
			appId: input.appId,
			appName: input.appName.slice(0, 80),
			userId: input.userId,
			userName: input.userName.slice(0, 80),
			...(input.message ? {message: input.message.slice(0, 500)} : {}),
			status: 'pending',
			createdAt: Date.now(),
		}
		await this.#config.update((draft) => {
			draft.access.requests.push(request)
			if (draft.access.requests.length > MAX_REQUESTS) {
				const firstSettled = draft.access.requests.findIndex(
					(entry) => entry.status === 'denied' || entry.status === 'installed' || entry.status === 'failed',
				)
				if (firstSettled >= 0) draft.access.requests.splice(firstSettled, 1)
			}
		})
		this.#audit.record({
			type: 'access.request',
			action: `Requested app '${request.appName}'`,
			actor: {type: 'user', id: input.userId, name: input.userName, ip: input.ip},
			target: input.appId,
			outcome: 'pending',
			detail: {requestId: request.id},
		})
		return request
	}

	async decide(requestId: string, approved: boolean, actor: {id: string; name?: string; ip?: string}, reason?: string) {
		const config = await this.#config.load()
		const request = config.access.requests.find((entry) => entry.id === requestId)
		if (!request) throw new HttpError(404, 'Request not found')
		if (!['pending', 'failed'].includes(request.status)) throw new HttpError(409, 'Request has already been decided')
		await this.#config.update((draft) => {
			const entry = draft.access.requests.find((candidate) => candidate.id === requestId)
			if (!entry) return
			entry.status = approved ? 'installing' : 'denied'
			entry.decidedAt = Date.now()
			entry.decidedBy = actor.name ?? actor.id
			entry.reason = reason?.slice(0, 500)
		})
		this.#audit.record({
			type: approved ? 'access.approve' : 'access.deny',
			action: approved ? `Approved app request '${request.appName}'` : `Denied app request '${request.appName}'`,
			actor: {type: 'user', id: actor.id, name: actor.name, ip: actor.ip},
			target: request.appId,
			detail: {requestId, userId: request.userId, ...(reason ? {reason} : {})},
		})
		if (!approved) return {requestId, status: 'denied'}
		void this.#installApproved(requestId).catch((error) =>
			this.#logger.error(`Failed to install approved app '${request.appId}'`, error),
		)
		return {requestId, status: 'installing'}
	}

	async #installApproved(requestId: string) {
		const config = await this.#config.load()
		const request = config.access.requests.find((entry) => entry.id === requestId)
		if (!request || request.status !== 'installing') return
		if (this.#installing.has(request.appId)) return
		this.#installing.add(request.appId)
		try {
			if (!(await this.#umbreld.apps.isInstalled(request.appId))) {
				await this.#umbreld.apps.install(request.appId, {})
			}
			await this.#shareWithMember(request.appId, request.userId)
			await this.#config.update((draft) => {
				const entry = draft.access.requests.find((candidate) => candidate.id === requestId)
				if (entry) {
					entry.status = 'installed'
					entry.error = undefined
				}
			})
			this.#audit.record({
				type: 'access.approve',
				action: `Installed and shared '${request.appName}'`,
				actor: {type: 'system', id: 'app-request-queue'},
				target: request.appId,
				detail: {requestId, userId: request.userId},
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await this.#config.update((draft) => {
				const entry = draft.access.requests.find((candidate) => candidate.id === requestId)
				if (entry) {
					entry.status = 'failed'
					entry.error = message.slice(0, 500)
				}
			})
			this.#audit.record({
				type: 'access.approve',
				action: `Failed to install '${request.appName}'`,
				actor: {type: 'system', id: 'app-request-queue'},
				target: request.appId,
				outcome: 'failure',
				detail: {requestId, message: message.slice(0, 300)},
			})
		} finally {
			this.#installing.delete(request.appId)
		}
	}

	async installForMember(userId: string, appId: string, appName: string) {
		if (!(await this.#umbreld.apps.isInstalled(appId))) {
			await this.#umbreld.apps.install(appId, {})
		}
		await this.#shareWithMember(appId, userId)
		this.#audit.record({
			type: 'access.approve',
			action: `Member installed '${appName}'`,
			actor: {type: 'user', id: userId},
			target: appId,
		})
	}

	async #shareWithMember(appId: string, userId: string) {
		const shares = await this.#umbreld.apps.listMemberShares()
		const existing = shares.find((share) => share.appId === appId)
		if (!existing) {
			await this.#umbreld.apps.addMemberShare(appId, [userId])
			return
		}
		if (existing.sharedWith === 'all' || existing.sharedWith.includes(userId)) return
		await this.#umbreld.apps.addMemberShare(appId, [...existing.sharedWith, userId])
	}
}
