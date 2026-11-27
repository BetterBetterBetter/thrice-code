import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import {
	GIT_FLAGS,
	HOOKS_PATH_KEY,
	checkout,
	isNonFastForwardPushError,
	normalizeBranchName,
	normalizeRemoteName,
	workingTreeIsDirty,
} from '../src/checkout.ts';

test('branch and remote names trim, and an empty remote is origin', () => {
	same(normalizeBranchName('  main  '), 'main');
	same(normalizeBranchName('   '), { ok: false, reason: 'empty-branch' });
	same(normalizeRemoteName(''), 'origin');
	same(normalizeRemoteName(' upstream '), 'upstream');
});

test('retained git flags and the hooks path key are the only extra argv pieces', () => {
	same(HOOKS_PATH_KEY, 'core.hooksPath');
	same(GIT_FLAGS, ['--ext-diff', '--no-ext-diff', '--textconv', '--no-textconv']);
});

test('a porcelain status with any line is a dirty tree', () => {
	same(workingTreeIsDirty(''), false);
	same(workingTreeIsDirty(' M file\n'), true);
});

test('a dirty tree refuses checkout instead of choosing stash, discard, or commit', () => {
	same(checkout({ dirty: true }), { ok: false, reason: 'dirty-tree-choice-unknown' });
	same(checkout({ dirty: false }), { ok: true });
});

test('non-fast-forward is classified from the git phrase, not a guessed UI sentence', () => {
	same(isNonFastForwardPushError('! [rejected] non-fast-forward'), true);
	same(isNonFastForwardPushError('everything up-to-date'), false);
});
