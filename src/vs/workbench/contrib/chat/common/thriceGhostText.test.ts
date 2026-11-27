import assert from 'node:assert/strict';
import test from 'node:test';
import { ghostTextSuffix } from './thriceGhostText.js';

test('ghost text completes the current prefix from the newest matching history entry', () => {
	const history = ['fix the tests', 'fix the build', 'explain this'];
	assert.equal(ghostTextSuffix(history, 'fix the b'), 'uild');
	assert.equal(ghostTextSuffix(history, 'explain'), ' this');
	assert.equal(ghostTextSuffix(history, ''), undefined);
	assert.equal(ghostTextSuffix(history, 'fix the build'), undefined);
	assert.equal(ghostTextSuffix(['line one\nline two'], 'line'), undefined);
});
