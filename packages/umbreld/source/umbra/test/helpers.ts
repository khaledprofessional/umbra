import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import type {AppLike, UmbrelLike} from '../types.ts'

export async function makeTempDir(prefix = 'umbra-test-'): Promise<string> {
	return mkdtemp(path.join(tmpdir(), prefix))
}

export async function cleanup(directory: string): Promise<void> {
	await rm(directory, {recursive: true, force: true})
}

export const silentLogger = {
	log: () => {},
	error: () => {},
}

export function makeApp(id: string, dataDirectory: string, version = '1.0.0'): AppLike {
	return {
		id,
		dataDirectory,
		state: 'running',
		readManifest: async () => ({id, name: id, version}),
		readCompose: async () => ({services: {web: {image: 'nginx'}, app_proxy: {image: 'proxy'}}}),
		start: async () => {},
		stop: async () => {},
		restart: async () => {},
		update: async () => {},
	}
}

export function makeUmbreld(dataDirectory: string, apps: AppLike[] = []): UmbrelLike {
	const shares: {appId: string; sharedWith: 'all' | string[]}[] = []
	const installed = new Set(apps.map((app) => app.id))
	return {
		dataDirectory,
		version: '2.0.1',
		port: 22080,
		logger: silentLogger,
		store: {
			get: async () => undefined,
			set: async () => {},
		},
		apps: {
			instances: apps,
			isInstalled: async (appId: string) => installed.has(appId),
			getApp: (appId: string) => {
				const app = apps.find((candidate) => candidate.id === appId)
				if (!app) throw new Error('App not found')
				return app
			},
			install: async (appId: string) => {
				installed.add(appId)
			},
			uninstall: async (appId: string) => {
				installed.delete(appId)
			},
			update: async () => {},
			listMemberShares: async () => shares,
			addMemberShare: async (appId: string, sharedWith: 'all' | string[]) => {
				const existing = shares.findIndex((share) => share.appId === appId)
				if (existing >= 0) shares.splice(existing, 1)
				shares.push({appId, sharedWith})
			},
			sharedAppIdsForUser: async (userId: string) =>
				shares
					.filter((share) => share.sharedWith === 'all' || share.sharedWith.includes(userId))
					.map((share) => share.appId),
		},
		auth: {
			authenticate: async () => ({sessionId: 's', accountId: '0', actor: 'account'}),
		},
		server: {},
		eventBus: {
			on: () => () => {},
			emit: async () => {},
		},
		user: {
			get: async () => ({name: 'Owner'}),
			getMember: async (id: string) => ({name: id === '1' ? 'Alice' : 'Bob'}),
			listMembers: async () => [
				{id: '1', name: 'Alice'},
				{id: '2', name: 'Bob'},
			],
		},
		mcp: {
			listTokens: async () => [],
		},
	}
}
