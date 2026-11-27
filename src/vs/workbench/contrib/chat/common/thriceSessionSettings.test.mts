import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionLevelForNewChat, sessionChatProviderId, shouldAdoptSharedChatProvider } from './thriceSessionSettings.ts';

const providers = [{ id: 'claude-hub' }, { id: 'codex-hub' }, { id: 'grok-hub' }];

test('a chat that already has a model keeps that provider', () => {
	assert.equal(sessionChatProviderId('grok-hub', providers, 'codex-hub'), 'grok-hub');
	assert.equal(shouldAdoptSharedChatProvider(true), false);
});

test('a new chat uses the last provider, and an unknown vendor does not count as one', () => {
	assert.equal(sessionChatProviderId(undefined, providers, 'codex-hub'), 'codex-hub');
	assert.equal(sessionChatProviderId('copilot', providers, 'claude-hub'), 'claude-hub');
	assert.equal(shouldAdoptSharedChatProvider(false), true);
});

test('a new chat keeps the last permission, and falls back to the configured default', () => {
	assert.equal(permissionLevelForNewChat('autoApprove', 'default'), 'autoApprove');
	assert.equal(permissionLevelForNewChat('autopilot', 'assisted'), 'autopilot');
	assert.equal(permissionLevelForNewChat(undefined, 'assisted'), 'assisted');
	assert.equal(permissionLevelForNewChat('nope', 'default'), 'default');
	assert.equal(permissionLevelForNewChat(undefined, undefined), 'default');
});
