#!/usr/bin/env node
/**
 * Non-destructive upstream sync for the Umbra fork.
 *
 * The fork keeps custom code in new files and upstream edits inside marked
 * blocks. Rebasing the custom commits onto a new stable tag therefore either
 * applies cleanly or stops on the one or two bridge hunks, never on the custom
 * modules themselves.
 *
 * Usage:
 *   node scripts/umbra/sync-upstream.mjs            # latest stable tag
 *   node scripts/umbra/sync-upstream.mjs --to 2.1.0
 *   node scripts/umbra/sync-upstream.mjs --check    # only report
 */
import {execFileSync, spawnSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FORK_FILE = path.join(REPO, 'umbra-fork.json')

function git(args, options = {}) {
	return execFileSync('git', args, {cwd: REPO, encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe'}).trim()
}

function parseArgs(argv) {
	const args = {to: undefined, check: false, remote: undefined}
	for (let index = 2; index < argv.length; index++) {
		if (argv[index] === '--to') args.to = argv[++index]
		else if (argv[index] === '--check') args.check = true
		else if (argv[index] === '--remote') args.remote = argv[++index]
		else if (argv[index] === '--help') {
			console.log('Usage: node scripts/umbra/sync-upstream.mjs [--to <tag>] [--remote upstream] [--check]')
			process.exit(0)
		}
	}
	return args
}

function isSemverTag(tag) {
	return /^v?\d+\.\d+\.\d+$/.test(tag)
}

function semverParts(tag) {
	return tag.replace(/^v/, '').split('.').map(Number)
}

function latestStableTag() {
	const tags = git(['tag', '--list'])
		.split('\n')
		.map((tag) => tag.trim())
		.filter(isSemverTag)
		.sort((first, second) => {
			const a = semverParts(first)
			const b = semverParts(second)
			for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]
			return 0
		})
	return tags.at(-1)
}

const args = parseArgs(process.argv)
if (!existsSync(FORK_FILE)) {
	console.error('umbra: umbra-fork.json is missing')
	process.exit(1)
}
const fork = JSON.parse(readFileSync(FORK_FILE, 'utf8'))
const remote = args.remote ?? fork.upstreamRemote ?? 'upstream'

try {
	git(['remote', 'get-url', remote])
} catch {
	console.error(`umbra: git remote '${remote}' does not exist. Add it with:`)
	console.error(`  git remote add ${remote} https://github.com/${fork.upstream}.git`)
	process.exit(1)
}

if (!args.check) {
	const dirty = git(['status', '--porcelain'])
	if (dirty) {
		console.error('umbra: the working tree is not clean; commit or stash first')
		console.error(dirty)
		process.exit(1)
	}
	console.log(`umbra: fetching ${remote}`)
	spawnSync('git', ['fetch', remote, '--tags', '--prune'], {cwd: REPO, stdio: 'inherit'})
}

const target = args.to ?? latestStableTag()
if (!target) {
	console.error('umbra: no stable semver tag found')
	process.exit(1)
}
const base = fork.base
console.log(`umbra: base ${base} -> target ${target}`)
if (args.check) {
	const behind = Number(git(['rev-list', '--count', `${base}..${target}`]))
	console.log(`umbra: ${behind} commit(s) upstream; run without --check to rebase`)
	process.exit(0)
}

git(['rev-parse', '--verify', target])
const backup = `backup/umbra-${new Date().toISOString().replace(/[:.]/g, '-')}`
git(['branch', backup])
console.log(`umbra: backup branch ${backup}`)

const rebase = spawnSync('git', ['rebase', '--onto', target, base], {cwd: REPO, stdio: 'inherit'})
if (rebase.status !== 0) {
	console.error('umbra: rebase stopped. Resolve conflicts only in the marked bridge blocks, then run:')
	console.error('  git rebase --continue')
	console.error(`  node ${path.relative(REPO, path.join(REPO, 'packages/umbreld/source/umbra/tools/integrate.mjs'))} --check`)
	console.error(`umbra: restore with 'git rebase --abort' or reset to ${backup}`)
	process.exit(rebase.status ?? 1)
}

// The integration blocks normally survive the rebase. Re-apply them if a
// conflict resolution or an upstream refactor removed one, then verify.
const integrate = spawnSync(
	process.execPath,
	[path.join(REPO, 'packages/umbreld/source/umbra/tools/integrate.mjs'), '--repo', path.join(REPO, 'packages/umbreld')],
	{cwd: REPO, stdio: 'inherit'},
)
if (integrate.status !== 0) {
	console.error('umbra: the integration could not be re-applied; inspect the report above')
	process.exit(integrate.status ?? 1)
}

const verify = spawnSync(
	process.execPath,
	[path.join(REPO, 'packages/umbreld/source/umbra/tools/integrate.mjs'), '--repo', path.join(REPO, 'packages/umbreld'), '--check'],
	{cwd: REPO, stdio: 'inherit'},
)
if (verify.status !== 0) process.exit(verify.status ?? 1)

fork.base = target
writeFileSync(FORK_FILE, `${JSON.stringify(fork, null, '\t')}\n`)
console.log(`umbra: rebased onto ${target}. Base updated in umbra-fork.json.`)
console.log('umbra: run the unit tests and a VM smoke test before building or pushing.')
