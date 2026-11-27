import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changeRanges, changesToWorkingTree, gitContextBrief, listCheckpoints, parseBranchHeader, sanitizeSessionKey, SESSION_CHANGES_HEADING } from '../src/gitContext.ts';

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
	for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
		delete env[name];
	}
	return { ...env, ...extra };
}

function run(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

/** Mimics Contract 1: a commit of the full working tree parented on HEAD, built in a throwaway index. */
function snapshot(repo: string, ref: string): string {
	const index = join(mkdtempSync(join(tmpdir(), 'thrice-gitctx-idx-')), 'index');
	const env = gitEnv({ GIT_INDEX_FILE: index });
	execFileSync('git', ['add', '-A'], { cwd: repo, env });
	const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
	const commit = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-m', 'snap'], { cwd: repo, env, encoding: 'utf8' }).trim();
	run(repo, 'update-ref', ref, commit);
	return commit;
}

function makeRepo(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), 'thrice-gitctx-')));
	run(repo, 'init', '-q', '-b', 'main');
	writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
	writeFileSync(join(repo, 'a.txt'), 'a\n');
	writeFileSync(join(repo, 'b.txt'), 'b\n');
	run(repo, 'add', '-A');
	run(repo, 'commit', '-q', '-m', 'init');
	return repo;
}

test('sanitizeSessionKey and branch header parsing', () => {
	assert.equal(sanitizeSessionKey('vscode-chat-session://local/abc=='), 'vscode-chat-session___local_abc__');
	assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 2, behind 1]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false });
	assert.deepEqual(parseBranchHeader('## feature/x'), { branch: 'feature/x', upstream: undefined, ahead: 0, behind: 0, detached: false });
	assert.equal(parseBranchHeader('## No commits yet on main').branch, 'main');
	assert.equal(parseBranchHeader('## HEAD (no branch)').detached, true);
});

test('gitContextBrief is empty outside a repository', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'thrice-gitctx-norepo-'));
	try {
		assert.equal(await gitContextBrief(dir, {}), '');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gitContextBrief reports branch, status and changes since the first session snapshot', async () => {
	const repo = makeRepo();
	try {
		assert.match(await gitContextBrief(repo, {}), /branch main\ngit status --short: clean$/);

		writeFileSync(join(repo, 'pre.txt'), 'existed before the chat\n');
		const start = snapshot(repo, 'refs/thrice/checkpoints/chat_1/0/start');
		writeFileSync(join(repo, 'a.txt'), 'a changed\n');
		unlinkSync(join(repo, 'b.txt'));
		writeFileSync(join(repo, 'new.txt'), 'new\n');
		writeFileSync(join(repo, 'ignored.txt'), 'x\n');
		snapshot(repo, 'refs/thrice/checkpoints/chat_1/0/end');
		snapshot(repo, 'refs/thrice/checkpoints/chat_1/1/start');

		const checkpoints = await listCheckpoints(repo, 'chat_1');
		assert.deepEqual(checkpoints.map(c => [c.turn, !!c.start, !!c.end]), [[0, true, true], [1, true, false]]);
		assert.equal(checkpoints[0].start, start);

		const changes = await changesToWorkingTree(repo, start);
		assert.deepEqual(changes, [
			{ path: 'a.txt', status: 'modified' },
			{ path: 'b.txt', status: 'deleted' },
			{ path: 'new.txt', status: 'added' },
		]);
		const indexBefore = run(repo, 'diff', '--cached', '--name-only');
		assert.equal(indexBefore, '', 'real index untouched');

		const brief = await gitContextBrief(repo, { sessionKey: 'chat:1', maxLines: 2 });
		const lines = brief.split('\n');
		assert.match(lines[0], /branch main$/);
		assert.equal(lines[1], 'git status --short:');
		assert.equal(lines.filter(line => line.startsWith('... and')).length, 2, 'both lists are capped');
		assert.ok(brief.includes(`${SESSION_CHANGES_HEADING} (snapshot ${start.slice(0, 12)}, 3 files):\nM a.txt\nD b.txt\n... and 1 more`));
		assert.ok(!brief.includes('ignored.txt'));
		assert.ok(!brief.includes('pre.txt'), 'files that existed at the snapshot and are unchanged are not listed as session changes');

		assert.ok(!(await gitContextBrief(repo, { sessionKey: 'other' })).includes(SESSION_CHANGES_HEADING));

		const ranges = await changeRanges(repo, 'chat_1');
		assert.equal(ranges.session?.from, start);
		assert.equal(ranges.turn?.to, undefined, 'last turn without an end snapshot compares with the working tree');
		assert.equal(ranges.uncommitted?.from, run(repo, 'rev-parse', 'HEAD'));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
