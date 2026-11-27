import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/events.ts';
import type { ProviderInstance } from '../src/instances.ts';
import type { AgentSession, CancellationTokenLike, SessionLaunch } from '../src/sessions/types.ts';

// src/ uses extensionless relative imports (it compiles to CommonJS). Let node resolve them to .ts.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
			return next(specifier + '.ts', context);
		}
		throw error;
	}
}`)}`);
const { claudeSessionArgv, claudeUserMessage, createClaudeSession } = await import('../src/sessions/claudeSession.ts');

/**
 * A fake `claude -p --input-format stream-json`. Writes its argv to FAKE_ARGV_FILE and answers each
 * user message by its text: `fail` gives an error result, `die` exits mid-turn, `slow` waits for an
 * interrupt, `deaf` ignores the interrupt, anything else echoes `echo:<text>`. Lines end in CRLF and
 * a non-JSON line is mixed in.
 */
const FAKE_CLI = String.raw`
const { writeFileSync } = require('node:fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_FILE) writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv));
const resumeAt = argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : 'fake-session-1';
const out = value => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\r\n');
let pending;
let count = 0;
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, ...extra });
const text = (id, value) => {
	out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: sessionId, parent_tool_use_id: null });
	out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }, session_id: sessionId, parent_tool_use_id: null });
	out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: value }] }, session_id: sessionId, parent_tool_use_id: null });
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	buffer += chunk;
	const lines = buffer.split('\n');
	buffer = lines.pop();
	for (const line of lines) handle(JSON.parse(line));
});
process.stdin.on('end', () => process.exit(0));
function handle(message) {
	if (message.type === 'control_request') {
		if (pending === 'deaf') return;
		out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } });
		out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id: sessionId });
		result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
		pending = undefined;
		return;
	}
	const content = message.message.content;
	// The session prefixes mode and editor instructions (promptForTurn); the user's text is the last paragraph.
	const prompt = (typeof content === 'string' ? content : content.map(block => block.text).join('')).split('\n\n').pop();
	const id = 'msg_' + (++count);
	out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
	out('not json');
	if (prompt === 'fail') {
		text(id, 'API Error: 400 bad model');
		result({ is_error: true, result: 'API Error: 400 bad model' });
	} else if (prompt === 'die') {
		process.stderr.write('fatal: lost connection\n');
		process.stdout.write(JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: 'partial' }] }, session_id: sessionId, parent_tool_use_id: null }));
		setTimeout(() => process.exit(3), 20);
	} else if (prompt === 'slow' || prompt === 'deaf') {
		text(id, 'working');
		pending = prompt;
	} else {
		text(id, 'echo:' + prompt);
		result({ result: 'echo:' + prompt });
	}
}
`;

const dir = mkdtempSync(join(tmpdir(), 'claude-session-test-'));
const fakePath = join(dir, 'fake-claude.cjs');
writeFileSync(fakePath, FAKE_CLI);
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fakeInstance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
	return {
		id: 'claude-hub',
		driver: 'claude',
		displayName: 'Claude Hub',
		enabled: true,
		command: process.execPath,
		launchArgs: [fakePath, '--dangerously-skip-permissions'],
		environment: [],
		requiredEnvironment: [],
		...overrides,
	};
}

let argvFiles = 0;
function launchFor(overrides: Partial<SessionLaunch> = {}): SessionLaunch & { argvFile: string } {
	const argvFile = join(dir, `argv-${++argvFiles}.json`);
	return {
		instance: fakeInstance(),
		cwd: dir,
		extraDirectories: [],
		model: 'haiku',
		mode: undefined,
		env: { PATH: process.env.PATH, FAKE_ARGV_FILE: argvFile },
		argvFile,
		...overrides,
	};
}

const sessions: AgentSession[] = [];
/** Disposes every session after the file runs, so a failed test cannot leave a child holding the loop open. */
function track(session: AgentSession): AgentSession {
	sessions.push(session);
	return session;
}
test.after(() => sessions.forEach(session => session.dispose()));

class Token implements CancellationTokenLike {
	isCancellationRequested = false;
	private readonly listeners = new Set<() => void>();
	onCancellationRequested(listener: () => void) {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}
	cancel() {
		this.isCancellationRequested = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

function collector() {
	const events: AgentEvent[] = [];
	return {
		events,
		handlers: { onEvent: (event: AgentEvent) => events.push(event) },
		text: () => events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join(''),
	};
}

function exited(session: AgentSession): Promise<{ code: number | null; error?: string }> {
	return new Promise(resolve => session.onDidExit(info => resolve(info)));
}

test('argv: launch args, model, stream-json flags, no prompt', () => {
	const argv = claudeSessionArgv({ instance: fakeInstance({ launchArgs: ['--dangerously-skip-permissions', '--model', 'opus'] }), model: 'haiku', mode: undefined, extraDirectories: [] });
	assert.deepEqual(argv, ['--dangerously-skip-permissions', '--model', 'haiku', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
});

test('argv: plan mode drops the permission bypass, resume id is passed, baked-in model is the fallback', () => {
	const argv = claudeSessionArgv({ instance: fakeInstance({ launchArgs: ['--dangerously-skip-permissions', '--model', 'opus'] }), model: '', mode: 'plan', resumeId: 'abc-123', extraDirectories: [] });
	assert.deepEqual(argv, ['--permission-mode', 'plan', '--model', 'opus', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--resume', 'abc-123']);
});

test('argv: editor tool flags are added without touching the last flag', () => {
	const tools = { mcpConfigFile: '/t/mcp.json', settingsFile: '/t/settings.json', shimPath: '/t/shim.js', port: 1, token: 'x', dispose() { } };
	const argv = claudeSessionArgv({ instance: fakeInstance({ launchArgs: [] }), model: 'haiku', mode: undefined, resumeId: 'sid', editorTools: tools, extraDirectories: ['/extra', ' '] });
	assert.deepEqual(argv.slice(0, 11), ['--model', 'haiku', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--resume', 'sid']);
	const flag = (name: string) => argv[argv.indexOf(name) + 1];
	assert.deepEqual(argv.filter(arg => arg === '--add-dir'), ['--add-dir']);
	assert.equal(flag('--add-dir'), '/extra');
	assert.equal(flag('--mcp-config'), '/t/mcp.json');
	assert.equal(flag('--settings'), '/t/settings.json');
	assert.match(flag('--append-system-prompt'), /mcp__thrice__spawnTerminal/);
	assert.ok(!argv.includes('--'));
	assert.ok(!argv.includes(''));
});

test('user message line shape', () => {
	assert.equal(claudeUserMessage('hi'), '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n');
});

test('two turns on one process, session id captured, events forwarded without duplicates', async () => {
	const launch = launchFor();
	const session = track(createClaudeSession(launch));
	assert.equal(session.state, 'starting');
	assert.equal(session.sessionId, undefined);
	const first = collector();
	const pending = session.send('one', first.handlers, new Token());
	assert.equal(session.state, 'busy');
	await pending;
	assert.equal(session.state, 'idle');
	assert.equal(first.text(), 'echo:one');
	assert.equal(session.sessionId, 'fake-session-1');
	const second = collector();
	await session.send('two', second.handlers, new Token());
	assert.equal(second.text(), 'echo:two');
	const argv = JSON.parse(readFileSync(launch.argvFile, 'utf8')) as string[];
	assert.ok(argv.includes('--input-format'));
	assert.ok(!argv.includes('one'));
	const exit = exited(session);
	session.dispose();
	await exit;
	assert.equal(session.state, 'exited');
});

test('resume: session id is known at once and stays the resumed id', async () => {
	const launch = launchFor({ resumeId: 'resumed-42', mode: 'plan' });
	const session = track(createClaudeSession(launch));
	assert.equal(session.sessionId, 'resumed-42');
	await session.send('hi', collector().handlers, new Token());
	assert.equal(session.sessionId, 'resumed-42');
	const argv = JSON.parse(readFileSync(launch.argvFile, 'utf8')) as string[];
	assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', 'resumed-42']);
	assert.ok(argv.includes('--permission-mode'));
	assert.ok(!argv.includes('--dangerously-skip-permissions'));
	session.dispose();
	await exited(session);
});

test('an error result rejects the turn and the session stays usable', async () => {
	const session = track(createClaudeSession(launchFor()));
	await assert.rejects(session.send('fail', collector().handlers, new Token()), /API Error: 400 bad model/);
	assert.equal(session.state, 'idle');
	const next = collector();
	await session.send('again', next.handlers, new Token());
	assert.equal(next.text(), 'echo:again');
	session.dispose();
	await exited(session);
});

test('busy: a second send while a turn runs rejects', async () => {
	const session = track(createClaudeSession(launchFor()));
	const token = new Token();
	const running = session.send('slow', collector().handlers, token);
	await assert.rejects(session.send('other', collector().handlers, new Token()), /still working/);
	token.cancel();
	await running;
	session.dispose();
	await exited(session);
});

test('cancel sends an interrupt, resolves on the result, and keeps the process', async () => {
	const session = track(createClaudeSession(launchFor()));
	const token = new Token();
	const seen = collector();
	const running = session.send('slow', { onEvent: event => { seen.handlers.onEvent(event); if (event.kind === 'text') { token.cancel(); } } }, token);
	await running;
	assert.equal(seen.text(), 'working');
	assert.equal(session.state, 'idle');
	const after = collector();
	await session.send('after', after.handlers, new Token());
	assert.equal(after.text(), 'echo:after');
	session.dispose();
	await exited(session);
});

test('cancel without an acknowledgement kills the process and resolves', async () => {
	const session = track(createClaudeSession(launchFor(), { interruptTimeoutMs: 100 }));
	const exit = exited(session);
	const token = new Token();
	const running = session.send('deaf', { onEvent: event => { if (event.kind === 'text') { token.cancel(); } } }, token);
	await running;
	const info = await exit;
	assert.equal(info.error, undefined);
	assert.equal(session.state, 'exited');
});

test('process death mid-turn rejects with the stderr tail and flushes the last partial line', async () => {
	const tools = { mcpConfigFile: '/t/mcp.json', settingsFile: '/t/settings.json', shimPath: '/t/shim.js', port: 1, token: 'x', disposed: 0, dispose() { this.disposed++; } };
	// The fake CLI ignores the editor tool flags.
	const session = track(createClaudeSession(launchFor({ editorTools: tools })));
	const exits: unknown[] = [];
	session.onDidExit(info => exits.push(info));
	const seen = collector();
	await assert.rejects(session.send('die', seen.handlers, new Token()), /fatal: lost connection/);
	assert.equal(seen.text(), 'partial');
	assert.equal(session.state, 'exited');
	assert.deepEqual(exits, [{ code: 3, error: 'fatal: lost connection' }]);
	assert.equal(tools.disposed, 1);
	await assert.rejects(session.send('more', collector().handlers, new Token()), /fatal: lost connection/);
});

test('dispose fires onDidExit once, and late listeners still hear about it', async () => {
	const session = track(createClaudeSession(launchFor()));
	await session.send('hi', collector().handlers, new Token());
	let count = 0;
	const exit = exited(session);
	session.onDidExit(() => count++);
	session.dispose();
	session.dispose();
	await exit;
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(count, 1);
	assert.equal(await exited(session).then(() => 'late'), 'late');
});

test('dispose mid-turn rejects the turn', async () => {
	const session = track(createClaudeSession(launchFor()));
	const running = session.send('slow', collector().handlers, new Token());
	setTimeout(() => session.dispose(), 50);
	await assert.rejects(running, /closed/);
	assert.equal(session.state, 'exited');
});

test('a missing command gives a clear message', async () => {
	const session = track(createClaudeSession(launchFor({ instance: fakeInstance({ command: 'no-such-claude-binary-xyz', launchArgs: [] }) })));
	const exit = exited(session);
	await assert.rejects(session.send('hi', collector().handlers, new Token()), /could not find no-such-claude-binary-xyz/);
	assert.match((await exit).error ?? '', /could not find/);
});

test('missing required environment exits with the reason', async () => {
	const session = track(createClaudeSession(launchFor({ instance: fakeInstance({ requiredEnvironment: ['ANTHROPIC_AUTH_TOKEN'] }) })));
	const info = await exited(session);
	assert.match(info.error ?? '', /needs ANTHROPIC_AUTH_TOKEN/);
	await assert.rejects(session.send('hi', collector().handlers, new Token()), /needs ANTHROPIC_AUTH_TOKEN/);
});
