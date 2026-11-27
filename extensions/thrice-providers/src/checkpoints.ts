/*---------------------------------------------------------------------------------------------
 *  Per-turn git snapshots of the working tree (Contract 2 in docs/agent-review-contract.md).
 *
 *  A snapshot is a commit whose tree is the whole working tree: tracked files plus untracked
 *  files that .gitignore does not exclude. It is built in a throwaway index (GIT_INDEX_FILE in a
 *  temp directory), so HEAD, the real index and the stash list are never touched, and is kept
 *  alive by `refs/thrice/checkpoints/<sessionKey>/<turn>/<phase>`.
 *
 *  Paths: every path taken or returned here (FileChange.path, readAt, restoreFiles,
 *  changedSince) is relative to the repository root, with `/` separators, even when `cwd` is a
 *  subdirectory of the repository. `cwd` only selects the repository.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface SnapshotResult { commit: string; ref: string }

export interface FileChange {
	path: string;
	/** A rename is reported as `modified` with `oldPath` set to the path it was renamed from. */
	status: 'added' | 'modified' | 'deleted';
	oldPath?: string;
	/** Lines added; 0 for binary files. */
	additions: number;
	/** Lines deleted; 0 for binary files. */
	deletions: number;
	/** Set when git reports the file as binary (numstat `-`). Optional addition to Contract 2. */
	binary?: boolean;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;
/** Per-command ceiling for the operations that have no caller-supplied timeout. */
const COMMAND_TIMEOUT_MS = 60_000;
/** Keeps argv well under platform limits when many paths are passed to one command. */
const PATH_CHUNK = 200;

const IDENTITY = {
	GIT_AUTHOR_NAME: 'Thrice',
	GIT_AUTHOR_EMAIL: 'checkpoints@thrice.local',
	GIT_COMMITTER_NAME: 'Thrice',
	GIT_COMMITTER_EMAIL: 'checkpoints@thrice.local',
};

class GitError extends Error {
	readonly exitCode: number | null;
	constructor(message: string, exitCode: number | null) {
		super(message);
		this.exitCode = exitCode;
	}
}

class TimeoutError extends Error { }

interface RunOptions {
	env?: Record<string, string>;
	input?: string | Buffer;
	signal?: AbortSignal;
}

function baseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
	// Variables inherited from a parent git process (hooks, rebase exec) would redirect every command.
	for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
		delete env[name];
	}
	return env;
}

function git(cwd: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
	const signal = options.signal ?? AbortSignal.timeout(COMMAND_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new TimeoutError('git timed out'));
			return;
		}
		const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
			cwd,
			env: { ...baseEnv(), ...options.env },
			signal,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
		child.stdin.on('error', () => { /* the process exited before reading its input */ });
		child.on('error', error => {
			reject(error.name === 'AbortError' || signal.aborted ? new TimeoutError('git timed out') : error);
		});
		child.on('close', code => {
			if (signal.aborted) {
				reject(new TimeoutError('git timed out'));
			} else if (code === 0) {
				resolve(Buffer.concat(out));
			} else {
				const detail = Buffer.concat(err).toString('utf8').trim().split('\n').find(line => line.trim());
				reject(new GitError(detail || `git ${args[0]} failed`, code));
			}
		});
		child.stdin.end(options.input);
	});
}

async function gitText(cwd: string, args: string[], options?: RunOptions): Promise<string> {
	return (await git(cwd, args, options)).toString('utf8');
}

function chunks<T>(items: T[]): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += PATH_CHUNK) {
		result.push(items.slice(i, i + PATH_CHUNK));
	}
	return result;
}

async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), 'thrice-index-'));
	try {
		return await fn({ GIT_INDEX_FILE: path.join(dir, 'index') });
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Repository-root-relative path that cannot escape the root. */
function assertRepoPath(file: string): string {
	if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) {
		throw new Error(`Invalid repository path: ${JSON.stringify(file)}`);
	}
	const normalized = file.replace(/\\/g, '/');
	if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(segment => segment === '..' || segment === '.git')) {
		throw new Error(`Invalid repository path: ${file}`);
	}
	return normalized;
}

function diskPath(root: string, file: string): string {
	const absolute = path.resolve(root, ...file.split('/'));
	const relative = path.relative(root, absolute);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`Invalid repository path: ${file}`);
	}
	return absolute;
}

interface TreeEntry { mode: string; type: string; oid: string }

/** Entries at `commit` for exactly the given root-relative paths (directories excluded by type). */
async function treeEntries(root: string, commit: string, files: string[]): Promise<Map<string, TreeEntry>> {
	const entries = new Map<string, TreeEntry>();
	for (const group of chunks(files)) {
		const stdout = await gitText(root, ['ls-tree', '-z', '--full-tree', commit, '--', ...group]);
		for (const record of stdout.split('\0')) {
			const tab = record.indexOf('\t');
			if (tab < 0) {
				continue;
			}
			const [mode, type, oid] = record.slice(0, tab).split(' ');
			entries.set(record.slice(tab + 1), { mode, type, oid });
		}
	}
	return entries;
}

export function sanitizeSessionKey(id: string): string {
	return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	try {
		const root = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) {
		throw new Error(`Not inside a git working tree: ${cwd}`);
	}
	return root;
}

/**
 * Captures the working tree under `refs/thrice/checkpoints/<sessionKey>/<turn>/<phase>`.
 * Returns undefined when `cwd` is not in a git working tree, when the capture exceeds
 * `timeoutMs` (default 5000), or when git fails for any other reason; it never throws.
 */
export async function captureSnapshot(cwd: string, sessionKey: string, turn: number, phase: 'start' | 'end', opts?: { timeoutMs?: number }): Promise<SnapshotResult | undefined> {
	if (!Number.isSafeInteger(turn) || turn < 0 || (phase !== 'start' && phase !== 'end')) {
		return undefined;
	}
	const key = sanitizeSessionKey(sessionKey);
	const ref = `refs/thrice/checkpoints/${key}/${turn}/${phase}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
	const signal = controller.signal;
	try {
		const root = (await gitText(cwd, ['rev-parse', '--show-toplevel'], { signal })).trim();
		if (!root) {
			return undefined;
		}
		await git(root, ['check-ref-format', ref], { signal });
		let head: string | undefined;
		try {
			head = (await gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal })).trim() || undefined;
		} catch (error) {
			if (error instanceof TimeoutError) {
				throw error;
			}
			head = undefined; // unborn HEAD
		}
		const commit = await withTempIndex(async env => {
			if (head) {
				await git(root, ['read-tree', head], { env, signal });
			}
			await git(root, ['add', '-A', '--', '.'], { env, signal });
			const tree = (await gitText(root, ['write-tree'], { env, signal })).trim();
			const args = ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `thrice checkpoint ${key} turn ${turn} ${phase}`];
			return (await gitText(root, args, { env: IDENTITY, signal })).trim();
		});
		await git(root, ['update-ref', '-m', 'thrice checkpoint', ref, commit], { signal });
		return { commit, ref };
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function statusFromLetter(letter: string): FileChange['status'] {
	switch (letter) {
		case 'A': return 'added';
		case 'D': return 'deleted';
		default: return 'modified'; // M, T (type change), R (rename)
	}
}

/** Files that differ between two snapshot commits (or any two commit-ish values). */
export async function diffSnapshots(cwd: string, from: string, to: string): Promise<FileChange[]> {
	const root = await requireRoot(cwd);
	const common = ['-c', 'diff.relative=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '-z'];
	const [nameStatus, numstat] = await Promise.all([
		gitText(root, [...common, '--name-status', from, to, '--']),
		gitText(root, [...common, '--numstat', from, to, '--']),
	]);

	const changes: FileChange[] = [];
	const byPath = new Map<string, FileChange>();
	const fields = nameStatus.split('\0');
	for (let i = 0; i < fields.length;) {
		const code = fields[i++];
		if (!code) {
			continue;
		}
		const letter = code[0];
		let change: FileChange;
		if (letter === 'R' || letter === 'C') {
			const oldPath = fields[i++];
			const newPath = fields[i++];
			change = letter === 'R'
				? { path: newPath, status: 'modified', oldPath, additions: 0, deletions: 0 }
				: { path: newPath, status: 'added', additions: 0, deletions: 0 };
		} else {
			change = { path: fields[i++], status: statusFromLetter(letter), additions: 0, deletions: 0 };
		}
		changes.push(change);
		byPath.set(change.path, change);
	}

	const stats = numstat.split('\0');
	for (let i = 0; i < stats.length;) {
		const record = stats[i++];
		if (!record) {
			continue;
		}
		const [added, deleted, inlinePath] = record.split('\t');
		let file = inlinePath;
		if (file === '') {
			// Rename: "<a>\t<d>\t\0<old>\0<new>\0"
			i++;
			file = stats[i++];
		}
		const change = byPath.get(file);
		if (!change) {
			continue;
		}
		if (added === '-' || deleted === '-') {
			change.binary = true;
		} else {
			change.additions = Number(added) || 0;
			change.deletions = Number(deleted) || 0;
		}
	}
	return changes;
}

/** Content of `file` at `commit` as UTF-8, or undefined when the file is absent there. */
export async function readAt(cwd: string, commit: string, file: string): Promise<string | undefined> {
	const root = await requireRoot(cwd);
	const clean = assertRepoPath(file);
	try {
		return (await git(root, ['cat-file', 'blob', `${commit}:${clean}`])).toString('utf8');
	} catch (error) {
		if (error instanceof GitError) {
			return undefined;
		}
		throw error;
	}
}

async function removeFile(root: string, file: string): Promise<void> {
	const absolute = diskPath(root, file);
	const stat = await fs.lstat(absolute).catch(() => undefined);
	if (!stat) {
		return;
	}
	if (stat.isDirectory()) {
		throw new Error(`Refusing to delete directory during restore: ${file}`);
	}
	await fs.rm(absolute, { force: true });
	// Prune directories the deleted file leaves empty, never the root itself.
	let dir = path.dirname(absolute);
	while (dir !== root && dir.startsWith(root + path.sep)) {
		try {
			await fs.rmdir(dir);
		} catch {
			break;
		}
		dir = path.dirname(dir);
	}
}

/**
 * Puts each changed path back to its state at `commit`: files present there are rewritten from
 * the commit (through git's checkout filters and eol handling), files absent there are deleted.
 * For a rename both `oldPath` (restored) and `path` (deleted) are handled. The real index and
 * HEAD are not modified: content is written through a throwaway index with `checkout-index`.
 * Submodule entries are skipped.
 */
export async function restoreFiles(cwd: string, commit: string, changes: FileChange[]): Promise<void> {
	const root = await requireRoot(cwd);
	const targets = new Set<string>();
	for (const change of changes) {
		targets.add(assertRepoPath(change.path));
		if (change.oldPath) {
			targets.add(assertRepoPath(change.oldPath));
		}
	}
	if (targets.size === 0) {
		return;
	}
	const resolved = (await gitText(root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])).trim();
	const entries = await treeEntries(root, resolved, [...targets]);
	const present: string[] = [];
	const absent: string[] = [];
	for (const file of targets) {
		const entry = entries.get(file);
		if (!entry || entry.type === 'tree') {
			absent.push(file);
		} else if (entry.type === 'blob') {
			present.push(file);
		}
	}
	for (const file of absent) {
		await removeFile(root, file);
	}
	if (present.length === 0) {
		return;
	}
	await withTempIndex(async env => {
		await git(root, ['read-tree', resolved], { env });
		for (const file of present) {
			// A directory now occupying the path would make checkout-index fail; leave that to the caller.
			const stat = await fs.lstat(diskPath(root, file)).catch(() => undefined);
			if (stat?.isDirectory()) {
				throw new Error(`Cannot restore ${file}: a directory exists at that path`);
			}
		}
		await git(root, ['checkout-index', '-f', '-z', '--stdin'], { env, input: present.join('\0') + '\0' });
	});
}

/**
 * Paths (from `paths`) whose current disk content differs from their content at `commit`.
 * Presence counts: a file present on only one side differs. Only content is compared, through
 * git's clean filters, so line-ending normalization does not count as a change; mode bits do not.
 */
export async function changedSince(cwd: string, commit: string, paths: string[]): Promise<string[]> {
	const root = await requireRoot(cwd);
	const files = paths.map(assertRepoPath);
	if (files.length === 0) {
		return [];
	}
	const resolved = (await gitText(root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])).trim();
	const entries = await treeEntries(root, resolved, [...new Set(files)]);

	const changed = new Set<string>();
	const toHash: string[] = [];
	const symlinks: string[] = [];
	for (const file of new Set(files)) {
		const entry = entries.get(file);
		const stat = await fs.lstat(diskPath(root, file)).catch(() => undefined);
		const atCommit = entry && entry.type === 'blob' ? entry : undefined;
		if (!stat || stat.isDirectory()) {
			if (atCommit) {
				changed.add(file);
			}
		} else if (!atCommit) {
			changed.add(file);
		} else if (stat.isSymbolicLink() || atCommit.mode === '120000') {
			symlinks.push(file);
		} else {
			toHash.push(file);
		}
	}
	for (const file of symlinks) {
		const entry = entries.get(file)!;
		const target = await fs.readlink(diskPath(root, file)).catch(() => undefined);
		if (entry.mode !== '120000' || target === undefined) {
			changed.add(file);
			continue;
		}
		const oid = (await gitText(root, ['hash-object', '--stdin'], { input: target })).trim();
		if (oid !== entry.oid) {
			changed.add(file);
		}
	}
	for (const group of chunks(toHash)) {
		const oids = (await gitText(root, ['hash-object', '--stdin-paths'], { input: group.join('\n') + '\n' })).trim().split('\n');
		group.forEach((file, index) => {
			if (oids[index] !== entries.get(file)!.oid) {
				changed.add(file);
			}
		});
	}
	return paths.filter(file => changed.has(assertRepoPath(file)));
}
