import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThriceModePreface, diagramInstruction, thriceModeForChatMode, thriceModePreface } from './thriceModePreface.js';

test('every mode tells the agent to use a mermaid or thrice-chart fence', () => {
	for (const mode of [undefined, 'interactive', 'plan', 'ask', 'debug', 'spec', 'triage', 'background']) {
		const prompt = applyThriceModePreface('hello', mode);
		assert.equal(prompt.includes(diagramInstruction), true);
		assert.equal(prompt.includes('Prefer the editor\'s built-in tools'), true);
		assert.match(prompt, /hello$/);
		assert.equal(applyThriceModePreface(prompt, mode), prompt);
	}
	assert.match(thriceModePreface('plan'), /Do not edit files or apply the plan/);
	assert.match(thriceModePreface('ask'), /Do not edit files/);
	assert.match(thriceModePreface('debug'), /Reproduce it/);
	assert.match(thriceModePreface('spec'), /Do not implement it/);
	assert.match(thriceModePreface('triage'), /Do not edit files/);
	assert.match(thriceModePreface('background'), /without waiting/);
});

test('builtin mode ids map onto the shared turn mode', () => {
	assert.equal(thriceModeForChatMode('agent', 'agent'), 'interactive');
	assert.equal(thriceModeForChatMode('edit', 'edit'), 'interactive');
	assert.equal(thriceModeForChatMode('ask', 'ask'), 'ask');
	assert.equal(thriceModeForChatMode('plan', 'agent'), 'plan');
	assert.equal(thriceModeForChatMode('debug', 'agent'), 'debug');
	assert.equal(thriceModeForChatMode('spec', 'agent'), 'spec');
	assert.equal(thriceModeForChatMode('triage', 'agent'), 'triage');
	assert.equal(thriceModeForChatMode('background', 'agent'), 'background');
});
