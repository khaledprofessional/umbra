import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto'
import {chmod, readFile} from 'node:fs/promises'
import path from 'node:path'

import {ensureDir, pathExists, writeFileAtomic} from './fs-util.ts'

export type SealedSecret = {
	v: 1
	alg: 'aes-256-gcm'
	iv: string
	tag: string
	data: string
}

const ALGORITHM = 'aes-256-gcm'

export function sealWithKey(key: Buffer, plaintext: string): SealedSecret {
	const iv = randomBytes(12)
	const cipher = createCipheriv(ALGORITHM, key, iv)
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return {
		v: 1,
		alg: ALGORITHM,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64'),
	}
}

export function openWithKey(key: Buffer, sealed: SealedSecret): string {
	if (sealed?.alg !== ALGORITHM) throw new Error('Unsupported secret format')
	const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
	decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
	return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}

export function derivePassphraseKey(passphrase: string, salt: Buffer): Buffer {
	if (passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters')
	return scryptSync(passphrase, salt, 32, {N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024})
}

/**
 * Device-bound secret storage. Secrets are encrypted at rest with a random key
 * held in a 0600 file, so backups of the data directory alone cannot reveal a
 * tunnel token or snapshot passphrase. The key never leaves the device.
 */
export default class SecretStore {
	readonly directory: string
	readonly keyPath: string
	#key?: Buffer

	constructor(dataDirectory: string) {
		this.directory = path.join(dataDirectory, 'secrets')
		this.keyPath = path.join(this.directory, 'device.key')
	}

	async start(): Promise<void> {
		await ensureDir(this.directory, 0o700)
		if (!(await pathExists(this.keyPath))) {
			await writeFileAtomic(this.keyPath, randomBytes(32).toString('base64'), 0o600)
		}
		await chmod(this.keyPath, 0o600).catch(() => {})
		const raw = (await readFile(this.keyPath, 'utf8')).trim()
		const key = Buffer.from(raw, 'base64')
		if (key.length !== 32) throw new Error('Device key is invalid')
		this.#key = key
	}

	get key(): Buffer {
		if (!this.#key) throw new Error('Secret store is not started')
		return this.#key
	}

	seal(plaintext: string): SealedSecret {
		return sealWithKey(this.key, plaintext)
	}

	open(sealed: SealedSecret): string {
		return openWithKey(this.key, sealed)
	}

	async writeSecret(name: string, plaintext: string): Promise<void> {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error('Invalid secret name')
		await writeFileAtomic(path.join(this.directory, `${name}.secret.json`), JSON.stringify(this.seal(plaintext)), 0o600)
	}

	async readSecret(name: string): Promise<string | null> {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error('Invalid secret name')
		const filePath = path.join(this.directory, `${name}.secret.json`)
		try {
			return this.open(JSON.parse(await readFile(filePath, 'utf8')) as SealedSecret)
		} catch {
			return null
		}
	}

	async hasSecret(name: string): Promise<boolean> {
		return pathExists(path.join(this.directory, `${name}.secret.json`))
	}
}
