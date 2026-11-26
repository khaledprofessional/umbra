import {constants} from 'node:fs'
import {access, chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat} from 'node:fs/promises'
import path from 'node:path'

import {isRecord} from './util.ts'

export async function ensureDir(directory: string, mode = 0o700): Promise<void> {
	await mkdir(directory, {recursive: true, mode})
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await access(target)
		return true
	} catch {
		return false
	}
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		const text = await readFile(filePath, 'utf8')
		const parsed: unknown = JSON.parse(text)
		return parsed as T
	} catch {
		return fallback
	}
}

/**
 * Write a file atomically with tight permissions.
 *
 * `rename` is atomic on the same filesystem. We fsync the file before renaming
 * so a power loss cannot leave a renamed-but-empty config (the failure mode
 * that loses credentials). The directory fsync is best-effort: Windows and
 * some network filesystems reject opening directories.
 */
export async function writeFileAtomic(filePath: string, contents: string | Buffer, mode = 0o600): Promise<void> {
	await ensureDir(path.dirname(filePath), 0o700)
	const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	const handle = await open(temporary, 'w', mode)
	try {
		await handle.writeFile(contents)
		await handle.sync()
	} finally {
		await handle.close()
	}
	await rename(temporary, filePath)
	await chmod(filePath, mode).catch(() => {})
	try {
		const directory = await open(path.dirname(filePath), constants.O_RDONLY)
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	} catch {
		// Not supported on every platform; the file itself is already durable.
	}
}

export async function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): Promise<void> {
	await writeFileAtomic(filePath, `${JSON.stringify(value, null, '\t')}\n`, mode)
}

export async function readJsonOrNull(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
		return isRecord(parsed) ? parsed : null
	} catch {
		return null
	}
}

export async function removeIfExists(target: string): Promise<void> {
	await rm(target, {recursive: true, force: true})
}

export async function statSize(target: string): Promise<number> {
	try {
		return (await stat(target)).size
	} catch {
		return 0
	}
}

/**
 * Resolve `candidate` inside `base` and reject traversal and symlink escapes.
 * Returns the absolute path. The base itself is allowed.
 */
export async function resolveInside(base: string, candidate: string): Promise<string> {
	const absoluteBase = await realpath(path.resolve(base)).catch(() => path.resolve(base))
	const absolute = path.resolve(absoluteBase, candidate)
	const relative = path.relative(absoluteBase, absolute)
	if (relative === '') return absolute
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Path escapes its allowed base')
	}
	// Resolve symlinks in the deepest existing ancestor, then re-check. A file
	// that does not exist yet is validated through its existing parent.
	let probe = absolute
	for (let index = 0; index < 64; index++) {
		try {
			const realProbe = await realpath(probe)
			const realRelative = path.relative(absoluteBase, realProbe)
			if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
				throw new Error('Path escapes its allowed base through a symlink')
			}
			return absolute
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			const parent = path.dirname(probe)
			if (parent === probe) return absolute
			probe = parent
		}
	}
	throw new Error('Could not resolve path')
}

export async function listDirectories(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, {withFileTypes: true})
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	} catch {
		return []
	}
}

export async function ensurePrivateFile(filePath: string, contents: string | Buffer): Promise<void> {
	if (await pathExists(filePath)) return
	await writeFileAtomic(filePath, contents, 0o600)
}
