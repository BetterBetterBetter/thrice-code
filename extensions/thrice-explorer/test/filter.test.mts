import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import { ABORT_MESSAGE, addPattern, classify, createFilter, ignores } from '../src/filter.ts';

test('entry names map onto the retained kind labels', () => {
	same(classify({ name: '.git', entryKind: 'directory' }), 'git-directory');
	same(classify({ name: '.git', entryKind: 'file' }), 'git-file');
	same(classify({ name: 'HEAD', entryKind: 'file' }), 'HEAD');
	same(classify({ name: 'refs', entryKind: 'directory' }), 'refs');
	same(classify({ name: 'objects', entryKind: 'directory' }), 'objects');
	same(classify({ name: 'src', entryKind: 'directory' }), 'directory');
	same(classify({ name: 'a.txt', entryKind: 'file' }), 'file');
	same(classify({ name: 'link', entryKind: 'symlink' }), 'symlink');
});

test('patterns match the full relative path and nothing else', () => {
	const filter = addPattern(createFilter(), 'secret.txt');
	same(ignores(filter, 'secret.txt'), true);
	same(ignores(filter, 'dir/secret.txt'), false);
});

test('an aborted walk returns the retained sentence', () => {
	same(ABORT_MESSAGE, 'Workspace explorer aborted');
	const filter = createFilter();
	same(filter.abortedMessage(true), ABORT_MESSAGE);
	same(filter.abortedMessage(false), undefined);
});
