/*---------------------------------------------------------------------------------------------
 *  Git context for Thrice chats.
 *
 *  - gitContextBrief (Contract 5): a short text block for the agent prompt with the branch,
 *    `git status --short` and the files changed since this chat session's first `start`
 *    snapshot (Contract 1 refs: refs/thrice/checkpoints/<sessionKey>/<turn>/start|end).
 *  - registerGitChangesCommand: registers `thrice.git.showChanges`, the command behind the chat
 *    session bar's Changes button. It offers "This turn", "This session" and "All uncommitted"
 *    and opens the multi-diff editor over the changed files using `git:` URIs, which the
 *    built-in git extension resolves.
 *
 *  Pure Node (child_process.execFile). `vscode` is passed in so this file can be loaded by
 *  `node --test` without the extension host.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as vscodeTypes from 'vscode';

export const SHOW_CHANGES_COMMAND = 'thrice.git.showChanges';
export const SESSION_CHANGES_HEADING = 'Changes since this session started';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_MAX_LINES = 20;
const GIT_TIMEOUT_MS = 5000;

export type ChangeStatus = 'added' | 'modified' | 'deleted';
export interface ChangedFile { path: string; status: ChangeStatus }
export interface BranchInfo { branch: string | undefined; upstream: string | undefined; ahead: number; behind: number; detached: boolean }
export interface Checkpoint { turn: number; start?: string; end?: string }

export function sanitizeSessionKey(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
		delete env[name];
	}
	env.GIT_OPTIONAL_LOCKS = '0';
	env.LC_ALL = 'C';
	return { ...env, ...extra };
}

function git(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: gitEnv(extraEnv), timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const out = await git(cwd, ['rev-parse', '--show-toplevel']);
	const root = out?.trim();
	return root ? root : undefined;
}

/** Parses the `## ...` header of `git status --porcelain=v1 --branch`. */
export function parseBranchHeader(line: string): BranchInfo {
	const info: BranchInfo = { branch: undefined, upstream: undefined, ahead: 0, behind: 0, detached: false };
	const body = line.replace(/^##\s*/, '');
	if (body.startsWith('HEAD (no branch)')) {
		info.detached = true;
		return info;
	}
	const noCommits = body.match(/^(?:No commits yet|Initial commit) on (.+)$/);
	if (noCommits) {
		info.branch = noCommits[1].trim();
		return info;
	}
	const match = body.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
	if (!match) {
		return info;
	}
	info.branch = match[1];
	info.upstream = match[2];
	const counts = match[3] ?? '';
	info.ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
	info.behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
	return info;
}

export function describeBranch(info: BranchInfo): string {
	if (info.detached) {
		return 'detached HEAD';
	}
	if (!info.branch) {
		return 'unknown branch';
	}
	const counts = [info.ahead ? `ahead ${info.ahead}` : '', info.behind ? `behind ${info.behind}` : ''].filter(Boolean).join(', ');
	return counts ? `${info.branch} (${counts})` : info.branch;
}

async function statusLines(root: string): Promise<{ branch: BranchInfo; entries: string[] } | undefined> {
	const out = await git(root, ['status', '--porcelain=v1', '--branch']);
	if (out === undefined) {
		return undefined;
	}
	const lines = out.split('\n').filter(Boolean);
	const header = lines[0]?.startsWith('##') ? lines.shift()! : '## HEAD (no branch)';
	return { branch: parseBranchHeader(header), entries: lines };
}

export async function branchInfo(cwd: string): Promise<BranchInfo | undefined> {
	return (await statusLines(cwd))?.branch;
}

/** Lists the Contract 1 snapshot refs for a session, sorted by turn. */
export async function listCheckpoints(cwd: string, sessionKey: string): Promise<Checkpoint[]> {
	const out = await git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/thrice/checkpoints/${sessionKey}/`]);
	const byTurn = new Map<number, Checkpoint>();
	for (const line of (out ?? '').split('\n')) {
		const match = line.match(/^refs\/thrice\/checkpoints\/[^/]+\/(\d+)\/(start|end) ([0-9a-f]+)$/);
		if (!match) {
			continue;
		}
		const turn = Number(match[1]);
		const checkpoint = byTurn.get(turn) ?? { turn };
		checkpoint[match[2] as 'start' | 'end'] = match[3];
		byTurn.set(turn, checkpoint);
	}
	return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function parseNameStatus(out: string | undefined): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const line of (out ?? '').split('\n')) {
		const tab = line.indexOf('\t');
		if (tab < 0) {
			continue;
		}
		const code = line[0];
		const file = line.slice(tab + 1);
		files.push({ path: file, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
	}
	return files;
}

/** Changes between two commits. */
export async function changesBetween(cwd: string, from: string, to: string): Promise<ChangedFile[]> {
	return parseNameStatus(await git(cwd, ['diff', '--name-status', '--no-renames', '--no-ext-diff', from, to]));
}

/**
 * Changes between a commit and the working tree, including untracked files that .gitignore does
 * not exclude. Uses a throwaway copy of the index so the real index is never touched.
 */
export async function changesToWorkingTree(cwd: string, from: string): Promise<ChangedFile[]> {
	const root = await repoRoot(cwd);
	if (!root) {
		return [];
	}
	const dir = await mkdtemp(path.join(tmpdir(), 'thrice-gitctx-'));
	try {
		const index = path.join(dir, 'index');
		const realIndex = (await git(root, ['rev-parse', '--git-path', 'index']))?.trim();
		if (realIndex) {
			await copyFile(path.resolve(root, realIndex), index).catch(() => undefined);
		}
		const env = { GIT_INDEX_FILE: index };
		if (await git(root, ['add', '-A', '--', '.'], env) === undefined) {
			return [];
		}
		return parseNameStatus(await git(root, ['diff', '--cached', '--name-status', '--no-renames', '--no-ext-diff', from], env));
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function headCommit(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() || EMPTY_TREE;
}

const statusLetter: Record<ChangeStatus, string> = { added: 'A', modified: 'M', deleted: 'D' };

function capped(lines: string[], max: number): string[] {
	return lines.length > max ? [...lines.slice(0, max), `... and ${lines.length - max} more`] : lines;
}

/** Contract 5. Returns '' outside a git repository. `maxLines` caps each list (default 20). */
export async function gitContextBrief(cwd: string, opts: { sessionKey?: string; maxLines?: number } = {}): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) {
		return '';
	}
	const status = await statusLines(root);
	if (!status) {
		return '';
	}
	const max = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
	const out = [`Git: ${root}, branch ${describeBranch(status.branch)}`];
	out.push(status.entries.length ? 'git status --short:' : 'git status --short: clean');
	out.push(...capped(status.entries, max));
	if (opts.sessionKey) {
		const first = (await listCheckpoints(root, sanitizeSessionKey(opts.sessionKey))).find(checkpoint => checkpoint.start);
		if (first?.start) {
			const changes = await changesToWorkingTree(root, first.start);
			out.push(`${SESSION_CHANGES_HEADING} (snapshot ${first.start.slice(0, 12)}, ${changes.length} file${changes.length === 1 ? '' : 's'}):`);
			out.push(...capped(changes.map(change => `${statusLetter[change.status]} ${change.path}`), max));
		}
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Changes view (extension command behind the session bar's Changes button)
// ---------------------------------------------------------------------------------------------

export interface ShowChangesArgs {
	/** Chat session id (see Contract 1). Sanitized here. */
	sessionId?: string;
	/** Chat session resource URI string, used when `sessionId` is missing. */
	sessionResource?: string;
	/** Directory inside the repository; defaults to the first workspace folder. */
	cwd?: string;
	/** Skip the picker and open this range directly. */
	range?: 'turn' | 'session' | 'uncommitted';
}

export interface ChangeRange { label: string; from: string; to: string | undefined; title: string }

/** Computes the diff endpoints for each range. `to: undefined` means the working tree. */
export async function changeRanges(cwd: string, sessionKey: string | undefined): Promise<Partial<Record<'turn' | 'session' | 'uncommitted', ChangeRange>>> {
	const ranges: Partial<Record<'turn' | 'session' | 'uncommitted', ChangeRange>> = {
		uncommitted: { label: 'All uncommitted', from: await headCommit(cwd), to: undefined, title: 'Uncommitted Changes' },
	};
	if (sessionKey) {
		const checkpoints = (await listCheckpoints(cwd, sessionKey)).filter(checkpoint => checkpoint.start);
		const first = checkpoints[0];
		const last = checkpoints[checkpoints.length - 1];
		if (first?.start) {
			ranges.session = { label: 'This session', from: first.start, to: undefined, title: 'Changes in This Chat' };
		}
		if (last?.start) {
			ranges.turn = { label: 'This turn', from: last.start, to: last.end, title: `Changes in Turn ${last.turn + 1}` };
		}
	}
	return ranges;
}

export function registerGitChangesCommand(vscode: typeof vscodeTypes): vscodeTypes.Disposable {
	const gitUri = (root: string, file: string, ref: string) => {
		const uri = vscode.Uri.file(path.join(root, file));
		return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
	};

	const open = async (root: string, range: ChangeRange) => {
		const changes = range.to ? await changesBetween(root, range.from, range.to) : await changesToWorkingTree(root, range.from);
		if (!changes.length) {
			void vscode.window.showInformationMessage(`${range.label}: no changes.`);
			return;
		}
		const resources = changes.map(change => ({
			originalUri: change.status === 'added' || range.from === EMPTY_TREE ? undefined : gitUri(root, change.path, range.from),
			modifiedUri: change.status === 'deleted' ? undefined : range.to ? gitUri(root, change.path, range.to) : vscode.Uri.file(path.join(root, change.path)),
		}));
		await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { title: range.title, resources });
	};

	const commit = async (root: string) => {
		await vscode.commands.executeCommand('workbench.view.scm');
		// product.json names this as the commit-message generator; run it only if something registered it.
		const generator = 'thrice.chat.git.generateCommitMessage';
		if ((await vscode.commands.getCommands(true)).includes(generator)) {
			await vscode.commands.executeCommand(generator, vscode.Uri.file(root));
		}
	};

	return vscode.commands.registerCommand(SHOW_CHANGES_COMMAND, async (args?: ShowChangesArgs) => {
		const cwd = args?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const root = cwd ? await repoRoot(cwd) : undefined;
		if (!root) {
			void vscode.window.showInformationMessage('This chat\'s folder is not a git repository.');
			return;
		}
		const id = args?.sessionId ?? args?.sessionResource;
		const ranges = await changeRanges(root, id ? sanitizeSessionKey(id) : undefined);
		if (args?.range) {
			const range = ranges[args.range];
			if (range) {
				await open(root, range);
			}
			return;
		}
		type Item = vscodeTypes.QuickPickItem & { run: () => Promise<void> };
		const noSnapshot = 'No snapshots recorded for this chat';
		const items: Item[] = [];
		for (const key of ['turn', 'session', 'uncommitted'] as const) {
			const range = ranges[key];
			const label = key === 'turn' ? 'This turn' : key === 'session' ? 'This session' : 'All uncommitted';
			const detail = key === 'turn' ? 'What the agent changed in its last reply' : key === 'session' ? 'Everything changed since this chat started' : 'HEAD compared with the working tree';
			items.push(range
				? { label, detail, run: () => open(root, range) }
				: { label, description: noSnapshot, detail, run: async () => { void vscode.window.showInformationMessage(`${label}: ${noSnapshot.toLowerCase()}.`); } });
		}
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, run: async () => { } });
		items.push({ label: '$(git-commit) Commit...', detail: 'Open Source Control to commit', run: () => commit(root) });
		const branch = await branchInfo(root);
		const picked = await vscode.window.showQuickPick(items, { title: `Changes on ${branch ? describeBranch(branch) : path.basename(root)}`, placeHolder: 'Show changes' });
		await picked?.run();
	});
}
