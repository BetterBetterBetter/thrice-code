import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSessionBar } from './thriceSessionBar.js';

test('the session bar shows the branch, a pull request and changes only while the folder exists', () => {
	assert.deepEqual(describeSessionBar({ missingFolder: false, branch: 'thrice/feature' }), {
		missing: false,
		branch: 'thrice/feature',
		sync: undefined,
		showPullRequest: true,
		showChanges: true,
	});
	assert.deepEqual(describeSessionBar({ missingFolder: true, branch: 'thrice/feature' }), {
		missing: true,
		branch: 'thrice/feature',
		sync: undefined,
		showPullRequest: false,
		showChanges: false,
	});
	const noBranch = describeSessionBar({ missingFolder: false, branch: undefined });
	assert.equal(noBranch.showPullRequest, false);
	assert.equal(noBranch.showChanges, false);
});

test('the session bar shows ahead and behind counts next to the branch', () => {
	assert.equal(describeSessionBar({ missingFolder: false, branch: 'main', ahead: 2, behind: 1 }).sync, '↑2 ↓1');
	assert.equal(describeSessionBar({ missingFolder: false, branch: 'main', ahead: 0, behind: 3 }).sync, '↓3');
	assert.equal(describeSessionBar({ missingFolder: false, branch: 'main', ahead: 0, behind: 0 }).sync, undefined);
});
