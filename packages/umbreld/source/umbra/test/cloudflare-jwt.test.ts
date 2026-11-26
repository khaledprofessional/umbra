import assert from 'node:assert/strict'
import {generateKeyPairSync, sign} from 'node:crypto'
import {describe, it} from 'node:test'

import AccessJwtVerifier, {AccessJwtError} from '../cloudflare-jwt.ts'

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
const jwk = publicKey.export({format: 'jwk'})

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function token(claims: Record<string, unknown>) {
	const header = base64url(JSON.stringify({alg: 'RS256', kid: 'key-1', typ: 'JWT'}))
	const payload = base64url(JSON.stringify(claims))
	const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
	return `${header}.${payload}.${base64url(signature)}`
}

function verifier() {
	return new AccessJwtVerifier({fetchJwks: async () => ({keys: [{...jwk, kid: 'key-1', alg: 'RS256', use: 'sig'}]})})
}

const policy = {
	teamDomain: 'team.cloudflareaccess.com',
	audience: 'aud-tag',
	allowedEmails: [],
	allowedGroups: [],
}

const now = Math.floor(Date.now() / 1000)
const validClaims = {
	aud: ['aud-tag'],
	iss: 'https://team.cloudflareaccess.com',
	exp: now + 300,
	iat: now,
	email: 'owner@example.com',
	sub: 'user-1',
}

describe('Cloudflare Access JWT verification', () => {
	it('verifies a correctly signed token', async () => {
		const result = await verifier().verify(token(validClaims), policy)
		assert.equal(result.email, 'owner@example.com')
		assert.equal(result.subject, 'user-1')
	})

	it('rejects the wrong audience', async () => {
		await assert.rejects(
			() => verifier().verify(token({...validClaims, aud: ['other']}), policy),
			(error: unknown) => error instanceof AccessJwtError && error.code === 'audience',
		)
	})

	it('rejects expired and not-yet-valid tokens', async () => {
		await assert.rejects(
			() => verifier().verify(token({...validClaims, exp: now - 120}), policy),
			(error: unknown) => error instanceof AccessJwtError && error.code === 'expired',
		)
		await assert.rejects(
			() => verifier().verify(token({...validClaims, nbf: now + 600}), policy),
			(error: unknown) => error instanceof AccessJwtError && error.code === 'not-yet-valid',
		)
	})

	it('rejects a tampered signature', async () => {
		const original = token(validClaims)
		const parts = original.split('.')
		const tampered = `${parts[0]}.${base64url(JSON.stringify({...validClaims, email: 'attacker@example.com'}))}.${parts[2]}`
		await assert.rejects(
			() => verifier().verify(tampered, policy),
			(error: unknown) => error instanceof AccessJwtError && error.code === 'signature',
		)
	})

	it('enforces email and group policy', async () => {
		await assert.rejects(
			() => verifier().verify(token(validClaims), {...policy, allowedEmails: ['other@example.com']}),
			(error: unknown) => error instanceof AccessJwtError && error.code === 'policy',
		)
		const withGroups = token({...validClaims, groups: ['admins']})
		const result = await verifier().verify(withGroups, {...policy, allowedGroups: ['admins']})
		assert.equal(result.email, 'owner@example.com')
	})
})
