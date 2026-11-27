import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { captureSnapshot, changedSince, diffSnapshots, readAt, repoRoot, restoreFiles, sanitizeSessionKey } from '../src/checkpoints.ts';

function run(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
	});
}

function tempDir(t: TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'thrice-cp-test-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeRepo(t: TestContext, files: Record<string, string> = { 'a.txt': 'a\n' }): string {
	const repo = tempDir(t);
	run(repo, ['init', '-q', '-b', 'main']);
	run(repo, ['config', 'commit.gpgsign', 'false']);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(repo, file, '..'), { recursive: true });
		writeFileSync(join(repo, file), content);
	}
	run(repo, ['add', '-A']);
	run(repo, ['commit', '-q', '-m', 'base']);
	return repo;
}

function state(repo: string) {
	return {
		head: run(repo, ['rev-parse', 'HEAD']).trim(),
		index: run(repo, ['ls-files', '-s']),
		stash: run(repo, ['stash', 'list']),
		status: run(repo, ['status', '--porcelain']),
	};
}

function treeFiles(repo: string, commit: string): string[] {
	return run(repo, ['ls-tree', '-r', '--name-only', commit]).trim().split('\n').filter(Boolean).sort();
}

test('sanitizeSessionKey replaces characters outside the ref-safe set', () => {
	assert.equal(sanitizeSessionKey('vscode-chat-session://local/abc 1'), 'vscode-chat-session___local_abc_1');
	assert.equal(sanitizeSessionKey('A.b_c-9'), 'A.b_c-9');
});

test('clean tree snapshot equals HEAD tree and leaves HEAD, index and stashes alone', async t => {
	const repo = makeRepo(t);
	const before = state(repo);
	const snap = await captureSnapshot(repo, 'session/1', 0, 'start');
	assert.ok(snap);
	assert.equal(snap.ref, 'refs/thrice/checkpoints/session_1/0/start');
	assert.equal(run(repo, ['rev-parse', snap.ref]).trim(), snap.commit);
	assert.equal(run(repo, ['rev-parse', `${snap.commit}^{tree}`]).trim(), run(repo, ['rev-parse', 'HEAD^{tree}']).trim());
	assert.equal(run(repo, ['rev-parse', `${snap.commit}^`]).trim(), before.head);
	assert.deepEqual(state(repo), before);
});

test('untracked files are included, ignored files excluded, real index untouched', async t => {
	const repo = makeRepo(t, { 'a.txt': 'a\n', '.gitignore': 'ignored.log\nbuild/\n' });
	writeFileSync(join(repo, 'new.txt'), 'new\n');
	writeFileSync(join(repo, 'ignored.log'), 'noise\n');
	mkdirSync(join(repo, 'build'));
	writeFileSync(join(repo, 'build', 'out.js'), 'x\n');
	writeFileSync(join(repo, 'a.txt'), 'a2\n');
	run(repo, ['stash', 'push', '-q', '-m', 'keep me']);
	writeFileSync(join(repo, 'a.txt'), 'a3\n');
	const before = state(repo);
	const snap = await captureSnapshot(repo, 's', 1, 'end');
	assert.ok(snap);
	assert.deepEqual(treeFiles(repo, snap.commit), ['.gitignore', 'a.txt', 'new.txt']);
	assert.equal(await readAt(repo, snap.commit, 'a.txt'), 'a3\n');
	assert.equal(await readAt(repo, snap.commit, 'new.txt'), 'new\n');
	assert.equal(await readAt(repo, snap.commit, 'ignored.log'), undefined);
	assert.deepEqual(state(repo), before);
	assert.match(before.stash, /keep me/);
});

test('diff reports added, modified, deleted and renamed files with line counts', async t => {
	const repo = makeRepo(t, {
		'mod.txt': 'one\ntwo\nthree\n',
		'gone.txt': 'bye\n',
		'old/name.txt': 'a long enough body\nto be detected\nas a rename\nby git\n',
		'bin.dat': 'x',
	});
	const start = await captureSnapshot(repo, 's', 0, 'start');
	assert.ok(start);
	writeFileSync(join(repo, 'mod.txt'), 'one\nTWO\nthree\nfour\n');
	unlinkSync(join(repo, 'gone.txt'));
	mkdirSync(join(repo, 'new'));
	writeFileSync(join(repo, 'new', 'name.txt'), readFileSync(join(repo, 'old/name.txt')));
	rmSync(join(repo, 'old'), { recursive: true });
	writeFileSync(join(repo, 'added.txt'), 'x\ny\n');
	writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
	const end = await captureSnapshot(repo, 's', 0, 'end');
	assert.ok(end);
	const changes = await diffSnapshots(repo, start.commit, end.commit);
	const byPath = Object.fromEntries(changes.map(change => [change.path, change]));
	assert.deepEqual(byPath['mod.txt'], { path: 'mod.txt', status: 'modified', additions: 2, deletions: 1 });
	assert.deepEqual(byPath['gone.txt'], { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 });
	assert.deepEqual(byPath['added.txt'], { path: 'added.txt', status: 'added', additions: 2, deletions: 0 });
	assert.deepEqual(byPath['new/name.txt'], { path: 'new/name.txt', status: 'modified', oldPath: 'old/name.txt', additions: 0, deletions: 0 });
	assert.equal(byPath['bin.dat'].status, 'modified');
	assert.equal(byPath['bin.dat'].binary, true);
	assert.equal(changes.length, 5);
});

test('restore round trip rewrites, recreates and deletes files without touching HEAD or index', async t => {
	const repo = makeRepo(t, { 'mod.txt': 'base\n', 'gone.txt': 'bye\n', 'old/name.txt': 'rename body line one\nline two\nline three\n' });
	writeFileSync(join(repo, 'untracked.txt'), 'u1\n');
	const start = await captureSnapshot(repo, 's', 2, 'start');
	assert.ok(start);
	const before = state(repo);

	writeFileSync(join(repo, 'mod.txt'), 'agent\n');
	unlinkSync(join(repo, 'gone.txt'));
	mkdirSync(join(repo, 'new'));
	writeFileSync(join(repo, 'new', 'name.txt'), readFileSync(join(repo, 'old/name.txt')));
	rmSync(join(repo, 'old'), { recursive: true });
	mkdirSync(join(repo, 'deep', 'dir'), { recursive: true });
	writeFileSync(join(repo, 'deep', 'dir', 'created.txt'), 'created\n');
	writeFileSync(join(repo, 'untracked.txt'), 'u2\n');
	const end = await captureSnapshot(repo, 's', 2, 'end');
	assert.ok(end);

	const changes = await diffSnapshots(repo, start.commit, end.commit);
	assert.deepEqual((await changedSince(repo, end.commit, changes.map(c => c.path))), []);
	writeFileSync(join(repo, 'mod.txt'), 'user edit after the turn\n');
	assert.deepEqual(await changedSince(repo, end.commit, ['mod.txt', 'untracked.txt', 'deep/dir/created.txt']), ['mod.txt']);
	assert.deepEqual(await changedSince(repo, start.commit, ['gone.txt', 'deep/dir/created.txt', 'old/name.txt']), ['gone.txt', 'deep/dir/created.txt', 'old/name.txt']);

	await restoreFiles(repo, start.commit, changes);
	assert.equal(readFileSync(join(repo, 'mod.txt'), 'utf8'), 'base\n');
	assert.equal(readFileSync(join(repo, 'gone.txt'), 'utf8'), 'bye\n');
	assert.equal(readFileSync(join(repo, 'old/name.txt'), 'utf8'), 'rename body line one\nline two\nline three\n');
	assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'u1\n');
	assert.equal(existsSync(join(repo, 'new', 'name.txt')), false);
	assert.equal(existsSync(join(repo, 'new')), false, 'empty directory left by a deleted file is pruned');
	assert.equal(existsSync(join(repo, 'deep')), false);
	assert.deepEqual(state(repo), before);
	assert.deepEqual(await changedSince(repo, start.commit, changes.flatMap(c => c.oldPath ? [c.path, c.oldPath] : [c.path])), []);
});

test('a subdirectory cwd resolves to the repository root and uses root-relative paths', async t => {
	const repo = makeRepo(t, { 'pkg/src/a.txt': 'a\n', 'top.txt': 't\n' });
	const sub = join(repo, 'pkg', 'src');
	assert.equal(await repoRoot(sub), repo);
	const start = await captureSnapshot(sub, 's', 0, 'start');
	writeFileSync(join(repo, 'top.txt'), 't2\n');
	writeFileSync(join(sub, 'a.txt'), 'a2\n');
	const end = await captureSnapshot(sub, 's', 0, 'end');
	assert.ok(start && end);
	const changes = await diffSnapshots(sub, start.commit, end.commit);
	assert.deepEqual(changes.map(c => c.path).sort(), ['pkg/src/a.txt', 'top.txt']);
	assert.equal(await readAt(sub, start.commit, 'top.txt'), 't\n');
	await restoreFiles(sub, start.commit, changes);
	assert.equal(readFileSync(join(repo, 'top.txt'), 'utf8'), 't\n');
	assert.equal(readFileSync(join(sub, 'a.txt'), 'utf8'), 'a\n');
});

test('outside a repository capture returns undefined and repoRoot is undefined', async t => {
	const dir = tempDir(t);
	writeFileSync(join(dir, 'f.txt'), 'x\n');
	assert.equal(await repoRoot(dir), undefined);
	assert.equal(await captureSnapshot(dir, 's', 0, 'start'), undefined);
});

test('a capture that exceeds its timeout returns undefined', async t => {
	const repo = makeRepo(t);
	assert.equal(await captureSnapshot(repo, 's', 0, 'start', { timeoutMs: 1 }), undefined);
});

test('unborn HEAD produces a parentless snapshot and HEAD stays unborn', async t => {
	const repo = tempDir(t);
	run(repo, ['init', '-q', '-b', 'main']);
	writeFileSync(join(repo, 'first.txt'), 'hello\n');
	const start = await captureSnapshot(repo, 's', 0, 'start');
	assert.ok(start);
	assert.deepEqual(treeFiles(repo, start.commit), ['first.txt']);
	assert.equal(run(repo, ['rev-list', '--parents', '-n', '1', start.commit]).trim(), start.commit);
	assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repo, stdio: 'ignore' }));
	assert.equal(run(repo, ['ls-files']), '');
	writeFileSync(join(repo, 'second.txt'), 'two\n');
	const end = await captureSnapshot(repo, 's', 0, 'end');
	assert.ok(end);
	const changes = await diffSnapshots(repo, start.commit, end.commit);
	assert.deepEqual(changes, [{ path: 'second.txt', status: 'added', additions: 1, deletions: 0 }]);
	await restoreFiles(repo, start.commit, changes);
	assert.equal(existsSync(join(repo, 'second.txt')), false);
	assert.equal(readFileSync(join(repo, 'first.txt'), 'utf8'), 'hello\n');
});

test('readAt and restoreFiles reject paths that escape the repository', async t => {
	const repo = makeRepo(t);
	const snap = await captureSnapshot(repo, 's', 0, 'start');
	assert.ok(snap);
	await assert.rejects(readAt(repo, snap.commit, '../x'));
	await assert.rejects(restoreFiles(repo, snap.commit, [{ path: '/etc/passwd', status: 'modified', additions: 0, deletions: 0 }]));
	await assert.rejects(restoreFiles(repo, snap.commit, [{ path: '.git/config', status: 'deleted', additions: 0, deletions: 0 }]));
});
