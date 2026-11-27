/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deriveInstanceId, homeEnvironmentName, launchArgumentsDescription, providerCredentialFields, providerShowsLaunchArguments, providerTextFields, THRICE_PROVIDER_DRIVERS, ThriceProviderDraft, toProviderSettingEntry, validateProviderDraft } from '../../common/thriceProviderDraft.js';

function draft(overrides: Partial<ThriceProviderDraft> = {}): ThriceProviderDraft {
	return {
		driver: 'claude',
		displayName: 'Work Claude',
		instanceId: 'work-claude',
		command: '',
		homePath: '',
		launchArgs: [],
		credentials: [],
		environment: [],
		...overrides,
	};
}

suite('ThriceProviderDraft', () => {

	test('lists the T3 providers, with fx and Kiro under more and ACP as a manual command', () => {
		assert.deepStrictEqual(THRICE_PROVIDER_DRIVERS.map(item => [item.driver, item.group, item.defaultCommand]), [
			['codex', 'featured', 'codex'],
			['claude', 'featured', 'claude'],
			['cursor', 'featured', 'agent'],
			['grok', 'featured', 'grok'],
			['opencode', 'featured', 'opencode'],
			['antigravity', 'featured', 'agy'],
			['muse', 'featured', 'muse'],
			['pi', 'featured', 'pi'],
			['fx', 'more', 'fx'],
			['kiro', 'more', 'kiro-cli'],
			['acp', 'manual', ''],
		]);
	});

	test('deriveInstanceId slugs the display name and suffixes collisions, including reserved hub ids', () => {
		assert.strictEqual(deriveInstanceId('  Hello,   World!  ', []), 'hello-world');
		assert.strictEqual(deriveInstanceId('My.Provider_Name', []), 'my-provider-name');
		assert.strictEqual(deriveInstanceId('A'.repeat(60), []).length, 48);
		assert.strictEqual(deriveInstanceId('***', []), 'provider');
		assert.strictEqual(deriveInstanceId('Work Claude', []), 'work-claude');
		assert.strictEqual(deriveInstanceId('Work Claude', ['work-claude']), 'work-claude-2');
		assert.strictEqual(deriveInstanceId('Work Claude', ['work-claude', 'work-claude-2']), 'work-claude-3');
		assert.strictEqual(deriveInstanceId('Claude Hub', []), 'claude-hub-2');
		assert.strictEqual(deriveInstanceId('Codex Hub', []), 'codex-hub-2');
		assert.strictEqual(deriveInstanceId('Grok Hub', ['grok-hub-2']), 'grok-hub-3');
		assert.strictEqual(deriveInstanceId('Claude Hub', ['claude-hub-2', 'claude-hub-4']), 'claude-hub-3');
		assert.strictEqual(deriveInstanceId('---', ['provider', 'provider-2']), 'provider-3');
	});

	test('validateProviderDraft requires a display name', () => {
		assert.deepStrictEqual(validateProviderDraft(draft({ displayName: '' }), []), { ok: false, message: 'Enter a display name.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ displayName: '   ' }), []), { ok: false, message: 'Enter a display name.' });
	});

	test('validateProviderDraft rejects reserved hub ids and ids already in use', () => {
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'claude' }), []), { ok: false, message: 'That instance id is reserved.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'claude-hub' }), []), { ok: false, message: 'That instance id is reserved.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'codex-hub' }), []), { ok: false, message: 'That instance id is reserved.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: ' grok-hub ' }), []), { ok: false, message: 'That instance id is reserved.' });
		assert.deepStrictEqual(validateProviderDraft(draft(), ['work-claude']), { ok: false, message: 'That instance id is already in use.' });
	});

	test('validateProviderDraft rejects instance ids the provider setting cannot store', () => {
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: '' }), []), { ok: false, message: 'Enter a valid instance id.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: '-work' }), []), { ok: false, message: 'Enter a valid instance id.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'a'.repeat(65) }), []), { ok: false, message: 'Enter a valid instance id.' });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'a'.repeat(64) }), []), { ok: true });
		assert.deepStrictEqual(validateProviderDraft(draft({ instanceId: 'work.claude_1' }), []), { ok: true });
	});

	test('validateProviderDraft ignores blank launch arguments and incomplete environment rows', () => {
		const result = validateProviderDraft(draft({
			command: '   ',
			launchArgs: ['', '   '],
			environment: [
				{ name: '', value: '' },
				{ name: 'UNUSED', value: '   ' },
				{ name: ' AGENTCLI_KEY ', value: 'secret' },
				{ name: 'EMPTY_NAME_IGNORED', value: '' },
			],
		}), ['other-provider']);
		assert.deepStrictEqual(result, { ok: true });
	});

	test('validateProviderDraft requires a unique name when an environment value is present', () => {
		assert.deepStrictEqual(validateProviderDraft(draft({
			environment: [{ name: '   ', value: 'secret' }],
		}), []), { ok: false, message: 'Enter a name for each environment variable.' });
		assert.deepStrictEqual(validateProviderDraft(draft({
			environment: [
				{ name: 'AGENTCLI_KEY', value: 'one' },
				{ name: ' AGENTCLI_KEY ', value: 'two' },
			],
		}), []), { ok: false, message: 'Environment variable names must be unique.' });
	});

	test('toProviderSettingEntry omits a blank command and drops empty launch args and incomplete environment rows', () => {
		const entry = toProviderSettingEntry(draft({
			displayName: '  Work Claude  ',
			instanceId: ' work-claude ',
			command: '   ',
			launchArgs: ['', '  --verbose  ', '   ', '0'],
			environment: [
				{ name: '', value: '' },
				{ name: 'UNUSED', value: '   ' },
				{ name: '', value: 'orphan' },
				{ name: '  AGENTCLI_KEY  ', value: ' secret ' },
				{ name: 'COUNT', value: '0' },
			],
		}));
		assert.deepStrictEqual(entry, {
			id: 'work-claude',
			driver: 'claude',
			displayName: 'Work Claude',
			enabled: true,
			launchArgs: ['--verbose', '0'],
			environment: [
				{ name: 'AGENTCLI_KEY', value: 'secret' },
				{ name: 'COUNT', value: '0' },
			],
		});
		assert.strictEqual('command' in entry, false);
	});

	test('provider fields follow the settings T3 shows while adding a provider', () => {
		assert.deepStrictEqual(providerTextFields('claude').map(field => field.key), ['command', 'homePath']);
		assert.strictEqual(providerTextFields('claude')[0]?.label, 'Binary path');
		assert.strictEqual(homeEnvironmentName('claude'), 'CLAUDE_CONFIG_DIR');
		assert.deepStrictEqual(providerTextFields('codex').map(field => field.key), ['command', 'homePath']);
		assert.strictEqual(homeEnvironmentName('codex'), 'CODEX_HOME');
		assert.deepStrictEqual(providerTextFields('opencode').map(field => field.key), ['command']);
		assert.strictEqual(homeEnvironmentName('opencode'), undefined);
		assert.deepStrictEqual(providerTextFields('cursor'), []);
		assert.deepStrictEqual(providerCredentialFields('claude'), []);
		assert.deepStrictEqual(providerCredentialFields('codex'), []);
		assert.deepStrictEqual(providerCredentialFields('cursor'), []);
		assert.strictEqual(providerShowsLaunchArguments('claude'), true);
		assert.strictEqual(providerShowsLaunchArguments('codex'), true);
		assert.strictEqual(providerShowsLaunchArguments('pi'), true);
		assert.strictEqual(providerShowsLaunchArguments('cursor'), false);
		assert.strictEqual(providerShowsLaunchArguments('grok'), false);
		assert.ok(launchArgumentsDescription('codex').includes('Codex'));
	});

	test('toProviderSettingEntry stores a home path and a filled credential, and leaves a blank credential out', () => {
		const entry = toProviderSettingEntry(draft({
			command: 'claude',
			homePath: '  ~/.claude-work  ',
			credentials: [
				{ name: 'ANTHROPIC_BASE_URL', value: '  https://gateway.example  ' },
				{ name: 'ANTHROPIC_AUTH_TOKEN', value: '   ' },
			],
			environment: [{ name: 'EXTRA', value: '1' }],
		}));
		assert.deepStrictEqual(entry.environment, [
			{ name: 'CLAUDE_CONFIG_DIR', value: '~/.claude-work' },
			{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' },
			{ name: 'EXTRA', value: '1' },
		]);
	});

	test('validateProviderDraft rejects a home path or credential that repeats an environment name', () => {
		assert.deepStrictEqual(validateProviderDraft(draft({
			homePath: '~/.claude',
			environment: [{ name: 'CLAUDE_CONFIG_DIR', value: '/other' }],
		}), []), { ok: false, message: 'Environment variable names must be unique.' });
		assert.deepStrictEqual(validateProviderDraft(draft({
			credentials: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'one' }],
			environment: [{ name: ' ANTHROPIC_AUTH_TOKEN ', value: 'two' }],
		}), []), { ok: false, message: 'Environment variable names must be unique.' });
	});

	test('toProviderSettingEntry keeps a command and omits launch args and environment when none remain', () => {
		const entry = toProviderSettingEntry(draft({
			driver: 'opencode',
			displayName: '  Work OpenCode  ',
			instanceId: 'work-opencode',
			command: '  opencode  ',
			launchArgs: ['', '   '],
			environment: [
				{ name: 'TOKEN', value: '' },
				{ name: '   ', value: '   ' },
			],
		}));
		assert.deepStrictEqual(entry, {
			id: 'work-opencode',
			driver: 'opencode',
			displayName: 'Work OpenCode',
			enabled: true,
			command: 'opencode',
		});
		assert.strictEqual('launchArgs' in entry, false);
		assert.strictEqual('environment' in entry, false);
	});
});
