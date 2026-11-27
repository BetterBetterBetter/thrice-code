import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecoder } from '../src/text';
import { instanceArgv, missingEnvironment, parseInstalledSettings, parseUserInstances, promptForTurn, resolveInstances } from '../src/instances';
import { modelsForDriver, parseCursorModels, parseFxModels, parseGrokModels, parseOpencodeModels } from '../src/models';
import { environmentForChild } from '../src/run';

test('the three hubs are the defaults and stay separate', () => {
	const instances = resolveInstances([], []);
	assert.deepEqual(modelsForDriver('claude').map(model => model.name), [
		'Claude Opus 5.5',
		'Claude Fable 5.2',
		'Claude Sonnet 5.5',
		'Claude Haiku 5.5',
	]);
	assert.deepEqual(modelsForDriver('antigravity').map(model => model.name), [
		'Gemini 4 Carbon',
		'Gemini 4 Argon',
		'Gemini 3.8 Flash',
		'Gemini 3.8 Flash (High)',
		'Gemini 3.8 Flash (Medium)',
		'Gemini 3.8 Flash (Low)',
	]);
	assert.deepEqual(modelsForDriver('cursor'), []);
	assert.equal(modelsForDriver('codex').some(model => model.name === 'Codex Hub'), false);
	assert.deepEqual(instances.map(instance => [instance.id, instance.displayName, instance.driver]), [
		['claude', 'Claude', 'claude'],
		['codex', 'Codex', 'codex'],
		['claude-hub', 'Claude Hub', 'claude'],
		['codex-hub', 'Codex Hub', 'codex'],
		['grok-hub', 'Grok Hub', 'opencode'],
	]);
	const claude = instances[0];
	const codex = instances[1];
	const claudeHub = instances[2];
	const codexHub = instances[3];
	const grokHub = instances[4];
	assert.deepEqual(claude.requiredEnvironment, []);
	assert.deepEqual(codex.launchArgs, []);
	assert.equal(instanceArgv(codex, 'hello', 'gpt-6.1-sol').includes('model_provider=agentcli'), false);
	assert.deepEqual(instanceArgv(claudeHub, 'hello', 'claude-fable-5-2').slice(0, 3), ['--dangerously-skip-permissions', '--model', 'claude-fable-5-2']);
	const codexArgs = instanceArgv(codexHub, 'hello', 'gpt-6-luna');
	assert.deepEqual(codexArgs.slice(0, -1), [
		'-c', 'model_provider=agentcli', '-m', 'gpt-6-luna', 'exec', '--skip-git-repo-check', '--json', '--',
	]);
	assert.equal(codexArgs.at(-1), promptForTurn('hello'));
	assert.deepEqual(instanceArgv(grokHub, 'hello').slice(0, 6), ['run', '--format', 'json', '--auto', '-m', 'agentcli/grok-4.7']);
	assert.deepEqual(instanceArgv(claudeHub, 'hello', 'claude-fable-5-2', 'plan').slice(0, 4), ['--permission-mode', 'plan', '--model', 'claude-fable-5-2']);
	assert.equal(instanceArgv(claudeHub, 'hello', 'claude-fable-5-2', 'ask').includes('--dangerously-skip-permissions'), false);
	assert.equal(instanceArgv(grokHub, 'hello', undefined, 'ask').includes('--auto'), false);
	assert.equal(instanceArgv(claudeHub, 'hello', 'claude-fable-5-2', 'spec').includes('--dangerously-skip-permissions'), false);
	assert.equal(instanceArgv(claudeHub, 'hello', 'claude-fable-5-2', 'debug').includes('--dangerously-skip-permissions'), true);
	assert.equal(instanceArgv(grokHub, 'hello', undefined, 'triage').includes('--auto'), false);
	assert.equal(instanceArgv(grokHub, 'hello', undefined, 'background').includes('--auto'), true);
	for (const driver of [claudeHub, codex, grokHub]) {
		for (const mode of ['interactive', 'plan', 'ask', 'debug', 'spec', 'triage', 'background'] as const) {
			const prompt = instanceArgv(driver, 'hello', undefined, mode).at(-1) ?? '';
			assert.equal(prompt, promptForTurn('hello', mode));
			assert.match(prompt, /mermaid/);
			assert.match(prompt, /thrice-chart/);
			assert.match(prompt, /hello$/);
		}
	}
	assert.equal(promptForTurn(promptForTurn('hello', 'plan'), 'plan'), promptForTurn('hello', 'plan'));
});

test('subscription CLIs keep an explicit key and drop gateway keys inherited from the shell', () => {
	const instances = resolveInstances([], [], {
		ANTHROPIC_BASE_URL: 'https://hub.example',
		ANTHROPIC_AUTH_TOKEN: 'hub-token',
		AGENTCLI_KEY: 'hub-key',
		PATH: '/usr/bin',
	});
	const claude = instances.find(instance => instance.id === 'claude')!;
	const hub = instances.find(instance => instance.id === 'claude-hub')!;
	const subscription = environmentForChild(claude, {
		ANTHROPIC_BASE_URL: 'https://hub.example',
		ANTHROPIC_AUTH_TOKEN: 'hub-token',
		AGENTCLI_KEY: 'hub-key',
		PATH: '/usr/bin',
	});
	assert.equal(subscription.PATH, '/usr/bin');
	assert.equal(subscription.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(subscription.ANTHROPIC_BASE_URL, undefined);
	assert.equal(subscription.AGENTCLI_KEY, undefined);
	const gateway = environmentForChild(hub, {
		ANTHROPIC_BASE_URL: 'https://hub.example',
		ANTHROPIC_AUTH_TOKEN: 'hub-token',
	});
	assert.equal(gateway.ANTHROPIC_AUTH_TOKEN, 'hub-token');
	assert.equal(gateway.ANTHROPIC_BASE_URL, 'https://hub.example');
});

test('installed T3 settings fill hub credentials without adding disabled providers', () => {
	const instances = resolveInstances(parseInstalledSettings({
		providerInstances: {
			'claude-hub': {
				driver: 'claudeAgent',
				displayName: 'Claude Hub',
				enabled: true,
				environment: [
					{ name: 'ANTHROPIC_BASE_URL', value: 'https://hub.example' },
					{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'hub-token' },
				],
			},
			'codex-hub': {
				driver: 'codex',
				enabled: true,
				environment: [{ name: 'AGENTCLI_KEY', value: 'hub-key' }],
				config: { launchArgs: '-c model_provider=agentcli -m gpt-6.1-sol' },
			},
			claudeAgent: { driver: 'claudeAgent', enabled: false },
		},
	}), [], {});
	const claude = instances.find(instance => instance.id === 'claude-hub');
	const codex = instances.find(instance => instance.id === 'codex-hub');
	assert.deepEqual(missingEnvironment(claude!), []);
	assert.deepEqual(claude?.environment.map(entry => entry.name), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
	assert.equal(claude?.environment[1]?.value, 'hub-token');
	assert.deepEqual(codex?.launchArgs, ['-c', 'model_provider=agentcli', '-m', 'gpt-6.1-sol']);
	assert.equal(instances.some(instance => instance.id === 'claudeAgent'), false);
	const withDisabledCodex = resolveInstances(parseInstalledSettings({
		providerInstances: {
			codex: { driver: 'codex', enabled: false },
		},
	}), [], {});
	assert.equal(withDisabledCodex.find(instance => instance.id === 'codex')?.enabled, true);
});

test('cursor uses the agent CLI print mode and its saved login', () => {
	const cursor = {
		id: 'cursor',
		driver: 'cursor' as const,
		displayName: 'Cursor',
		enabled: true,
		command: 'agent',
		launchArgs: [],
		environment: [],
		requiredEnvironment: [],
	};
	const args = instanceArgv(cursor, 'hello', 'default');
	assert.deepEqual(args.slice(0, 7), ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--force', '--']);
	assert.equal(args.includes('--model'), false);
	assert.ok(args.at(-1)?.includes('hello'));
	const ask = instanceArgv(cursor, 'hello', 'default', 'ask');
	assert.equal(ask.includes('--force'), false);
	assert.deepEqual(ask.slice(ask.indexOf('--mode'), ask.indexOf('--mode') + 2), ['--mode', 'ask']);
});

test('another instance uses the same shape and a hub id replaces that hub', () => {
	const instances = resolveInstances([], parseUserInstances([
		{ id: 'local-claude', driver: 'claude', displayName: 'Local Claude', environment: [{ name: 'ANTHROPIC_API_KEY', value: 'local' }] },
		{ id: 'grok-hub', driver: 'opencode', displayName: 'Grok Local', launchArgs: ['-m', 'agentcli/grok-4'], enabled: true },
		{ id: 'bad id', driver: 'codex', displayName: 'Nope' },
	]), { AGENTCLI_KEY: 'from-env' });
	assert.equal(instances.find(instance => instance.id === 'grok-hub')?.displayName, 'Grok Local');
	assert.deepEqual(instances.find(instance => instance.id === 'grok-hub')?.launchArgs, ['-m', 'agentcli/grok-4']);
	assert.equal(instances.find(instance => instance.id === 'local-claude')?.environment[0]?.value, 'local');
	assert.equal(instances.find(instance => instance.id === 'codex-hub')?.environment[0]?.value, 'from-env');
	assert.equal(instances.some(instance => instance.id === 'bad id'), false);
});

test('stream decoders emit only new text', () => {
	const claude = createDecoder('claude');
	assert.deepEqual(claude.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}'), ['Hi']);
	const cursor = createDecoder('cursor');
	assert.deepEqual(cursor.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}'), ['Hi']);
	const codex = createDecoder('codex');
	assert.deepEqual(codex.push('{"type":"agent_message_content_delta","delta":"Yo"}'), ['Yo']);
	const grok = createDecoder('opencode');
	assert.deepEqual(grok.push('{"type":"message.part.updated","properties":{"part":{"id":"1","type":"text","text":"Hi"}}}'), ['Hi']);
	assert.deepEqual(grok.push('{"type":"message.part.updated","properties":{"part":{"id":"1","type":"text","text":"Hi there"}}}'), [' there']);
});

test('provider catalogs follow the lists T3 shows', () => {
	const cursor = parseCursorModels([
		'Available models',
		'',
		'auto - Auto (current, default)',
		'gpt-5.3-codex-low - Codex 5.3 Low',
		'gpt-5.3-codex-high - Codex 5.3 High',
		'gpt-5.3-codex-high-fast - Codex 5.3 High Fast',
		'composer-2.5 - Composer 2.5',
		'composer-2.5-fast - Composer 2.5 Fast',
	].join('\n'));
	assert.deepEqual(cursor.map(model => [model.id, model.name]), [
		['auto', 'Auto'],
		['gpt-5.3-codex-high', 'Codex 5.3'],
		['gpt-5.3-codex-high-fast', 'Codex 5.3'],
		['composer-2.5', 'Composer 2.5'],
		['composer-2.5-fast', 'Composer 2.5'],
	]);
	assert.equal(cursor[0]?.isDefault, true);
	assert.deepEqual(parseOpencodeModels('agentcli/grok-4.6\nagentcli/grok-4.7\n').map(model => model.id), [
		'agentcli/grok-4.7',
		'agentcli/grok-4.6',
	]);
	assert.deepEqual(parseGrokModels('* grok-4.7 (default)\n* grok-4.7\n- grok-4\n').map(model => model.id), ['grok-4.7', 'grok-4']);
	assert.deepEqual(parseFxModels('{"ids":["alpha","default"]}').map(model => model.id), ['default', 'alpha']);
});
