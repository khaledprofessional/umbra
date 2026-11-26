import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import AppAccessManager from '../access.ts'
import AuditLog from '../audit.ts'
import ConfigStore from '../config.ts'
import {cleanup, makeApp, makeTempDir, makeUmbreld, silentLogger} from './helpers.ts'

describe('member app permissions and request queue', () => {
	let directory: string
	let config: ConfigStore
	let audit: AuditLog
	let umbreld: ReturnType<typeof makeUmbreld>
	let access: AppAccessManager

	before(async () => {
		directory = await makeTempDir()
		config = new ConfigStore(directory)
		audit = new AuditLog(directory)
		await audit.start()
		umbreld = makeUmbreld(directory, [makeApp('plex', `${directory}/app-data/plex`)])
		access = new AppAccessManager({config, audit, umbreld, logger: silentLogger})
	})
	after(async () => {
		await audit.flush()
		await cleanup(directory)
	})

	it('treats the owner as always able to install', async () => {
		assert.equal(await access.policyFor('0'), 'manage')
		assert.equal(await access.canInstallDirectly('0'), true)
	})

	it('defaults members to request-only', async () => {
		assert.equal(await access.policyFor('1'), 'request')
		assert.equal(await access.canInstallDirectly('1'), false)
	})

	it('changes a member policy and audits it', async () => {
		await access.setPolicy('1', 'manage', {id: '0', name: 'Owner'})
		assert.equal(await access.policyFor('1'), 'manage')
		await access.setPolicy('1', 'request', {id: '0', name: 'Owner'})
		await audit.flush()
		const entries = await audit.query({type: 'access.policy'})
		assert.equal(entries.events.length, 2)
	})

	it('queues a request and installs + shares it on approval', async () => {
		const request = await access.requestApp({
			userId: '1',
			userName: 'Alice',
			appId: 'sonarr',
			appName: 'Sonarr',
			message: 'Please',
		})
		assert.equal(request.status, 'pending')
		const pending = await access.listRequests({status: 'pending'})
		assert.equal(pending.length, 1)
		await access.decide(request.id, true, {id: '0', name: 'Owner'})
		for (let attempt = 0; attempt < 50; attempt++) {
			const requests = await access.listRequests()
			if (requests[0].status === 'installed') break
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		const [installed] = await access.listRequests()
		assert.equal(installed.status, 'installed')
		assert.equal(await umbreld.apps.isInstalled('sonarr'), true)
		const shares = await umbreld.apps.listMemberShares()
		assert.deepEqual(shares, [{appId: 'sonarr', sharedWith: ['1']}])
	})

	it('marks an interrupted install as failed so it can be retried', async () => {
		const request = await access.requestApp({
			userId: '2',
			userName: 'Bob',
			appId: 'readarr',
			appName: 'Readarr',
		})
		await config.update((draft) => {
			const entry = draft.access.requests.find((candidate) => candidate.id === request.id)
			if (entry) entry.status = 'installing'
		})
		await access.reconcileInterruptedInstalls()
		const [reconciled] = (await access.listRequests()).filter((entry) => entry.id === request.id)
		assert.equal(reconciled.status, 'failed')
		assert.match(reconciled.error ?? '', /interrupted/i)
	})

	it('denies a request without installing', async () => {
		const request = await access.requestApp({
			userId: '2',
			userName: 'Bob',
			appId: 'radarr',
			appName: 'Radarr',
		})
		await access.decide(request.id, false, {id: '0', name: 'Owner'}, 'Not now')
		const requests = await access.listRequests()
		const denied = requests.find((entry) => entry.id === request.id)
		assert.equal(denied?.status, 'denied')
		assert.equal(await umbreld.apps.isInstalled('radarr'), false)
	})

	it('installs directly for a manage policy and shares with that member', async () => {
		await access.setPolicy('2', 'manage', {id: '0', name: 'Owner'})
		await access.installForMember('2', 'lidarr', 'Lidarr')
		const shares = await umbreld.apps.listMemberShares()
		assert.ok(shares.some((share) => share.appId === 'lidarr' && share.sharedWith.includes('2')))
	})
})
