import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { AgentEvent } from '../src/events.ts';
import type { ProviderInstance } from '../src/instances.ts';
import type { AgentSession, CancellationTokenLike, SessionLaunch } from '../src/sessions/types.ts';

// The extension's sources import each other without extensions (for tsc). Resolve those to `.ts`
// so codexSession.ts can load run.ts, instances.ts and editorToolPolicy.ts under `node --test`.
const resolveHook = `export async function resolve(specifier, context, next) {
	if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL && context.parentURL.includes('/thrice-providers/')) {
		try { return await next(specifier + '.ts', context); } catch {}
	}
	return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(resolveHook)}`);
const { appServerArgs, codexAppServerArgv, createCodexSession, sandboxFor, toExecItem } = await import('../src/sessions/codexSession.ts');

/** A fake `codex app-server`: the JSON-RPC subset the session uses, driven by keywords in the prompt. */
const FAKE_SERVER = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const log = process.env.FAKE_LOG;
const record = entry => appendFileSync(log, JSON.stringify(entry) + '\\n');
record({ argv: process.argv.slice(2), pid: process.pid });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const notify = (method, params) => send({ method, params });
let thread = '';
let turns = 0;
let active;
const waiting = new Map();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	buffer += chunk;
	const lines = buffer.split('\\n');
	buffer = lines.pop();
	for (const line of lines) {
		if (line.trim()) handle(JSON.parse(line));
	}
});
function item(turnId, completed, value) {
	notify(completed ? 'item/completed' : 'item/started', { threadId: thread, turnId, item: value });
}
function complete(turnId, status, error) {
	notify('turn/completed', { threadId: thread, turn: { id: turnId, status, error: error ?? null, items: [] } });
}
function handle(message) {
	record(message);
	if (message.method === undefined && waiting.has(message.id)) {
		waiting.get(message.id)(message.result);
		waiting.delete(message.id);
		return;
	}
	const { id, method, params } = message;
	switch (method) {
		case 'initialize':
			return send({ id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
		case 'initialized':
			return;
		case 'thread/start':
			thread = 'thr-new';
			return send({ id, result: { thread: { id: thread, path: null }, model: params.model, modelProvider: 'fake', approvalPolicy: params.approvalPolicy, sandbox: params.sandbox ?? null } });
		case 'thread/resume':
			if (params.threadId === 'missing') {
				return send({ id, error: { code: -32600, message: 'no rollout found for thread id missing' } });
			}
			thread = params.threadId;
			return send({ id, result: { thread: { id: thread, path: null }, model: params.model, modelProvider: 'fake', approvalPolicy: params.approvalPolicy, sandbox: null } });
		case 'turn/interrupt':
			send({ id, result: {} });
			if (active && params.turnId === active) {
				complete(active, 'interrupted');
				active = undefined;
			}
			return;
		case 'turn/start':
			return startTurn(id, params);
		default:
			return send({ id, error: { code: -32601, message: 'unknown ' + method } });
	}
}
function startTurn(id, params) {
	const turnId = 'turn-' + (++turns);
	const text = params.input[0].text;
	send({ id, result: { turn: { id: turnId, status: 'inProgress', error: null, items: [] } } });
	notify('turn/started', { threadId: thread, turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
	if (text.includes('EVENTS')) {
		notify('item/reasoning/summaryTextDelta', { threadId: thread, turnId, itemId: 'rs1', delta: 'Thinking ', summaryIndex: 0 });
		item(turnId, true, { type: 'reasoning', id: 'rs1', summary: ['Thinking hard'], content: [] });
		item(turnId, false, { type: 'agentMessage', id: 'm1', text: '' });
		notify('item/agentMessage/delta', { threadId: thread, turnId, itemId: 'm1', delta: 'Look' });
		notify('item/agentMessage/delta', { threadId: thread, turnId, itemId: 'm1', delta: 'ing.' });
		item(turnId, true, { type: 'agentMessage', id: 'm1', text: 'Looking.' });
		item(turnId, false, { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'", cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null });
		item(turnId, true, { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'", cwd: '/repo', status: 'failed', aggregatedOutput: '1 failing', exitCode: 2 });
		item(turnId, false, { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null }, diff: '' }], status: 'inProgress' });
		item(turnId, true, { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1,2 @@\\n-a\\n+b\\n+c\\n' }], status: 'completed' });
		item(turnId, false, { type: 'mcpToolCall', id: 't1', server: 'thrice', tool: 'sessionContext', status: 'inProgress', arguments: {}, result: null, error: null });
		item(turnId, true, { type: 'mcpToolCall', id: 't1', server: 'thrice', tool: 'sessionContext', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'one folder' }] }, error: null });
		notify('turn/plan/updated', { threadId: thread, turnId, explanation: null, plan: [{ step: 'Fix', status: 'inProgress' }] });
		item(turnId, true, { type: 'agentMessage', id: 'm2', text: 'Done.' });
		return complete(turnId, 'completed');
	}
	if (text.includes('FAIL')) {
		notify('error', { threadId: thread, turnId, willRetry: true, error: { message: 'retrying' } });
		notify('error', { threadId: thread, turnId, willRetry: false, error: { message: 'stream disconnected' } });
		return complete(turnId, 'failed', { message: 'boom' });
	}
	if (text.includes('HANG')) {
		active = turnId;
		item(turnId, false, { type: 'commandExecution', id: 'sleep1', command: 'sleep 30', cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null });
		return;
	}
	if (text.includes('DIE')) {
		process.stderr.write('fatal: model exploded\\n');
		return setTimeout(() => process.exit(3), 20);
	}
	if (text.includes('APPROVE')) {
		const requestId = 'srv-' + turnId;
		waiting.set(requestId, result => {
			item(turnId, true, { type: 'agentMessage', id: 'a1', text: 'decision=' + JSON.stringify(result) });
			complete(turnId, 'completed');
		});
		return send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId, itemId: 'c9', command: 'rm -rf build' } });
	}
	notify('item/agentMessage/delta', { threadId: thread, turnId, itemId: 'm-' + turnId, delta: 'ok ' + process.pid });
	complete(turnId, 'completed');
}
`;

const dir = mkdtempSync(join(tmpdir(), 'codex-session-test-'));
const fake = join(dir, 'fake-codex');
writeFileSync(fake, FAKE_SERVER);
chmodSync(fake, 0o755);
const sessions: AgentSession[] = [];
after(() => {
	// A failed assertion must not leave a fake server holding the test process open.
	for (const session of sessions) {
		session.dispose();
	}
	rmSync(dir, { recursive: true, force: true });
});

function open(launch: SessionLaunch): AgentSession {
	const session = createCodexSession(launch);
	sessions.push(session);
	return session;
}

let logCounter = 0;

function instance(log: string, overrides: Partial<ProviderInstance> = {}): ProviderInstance {
	return {
		id: 'codex-hub',
		driver: 'codex',
		displayName: 'Codex Hub',
		enabled: true,
		command: fake,
		launchArgs: ['-c', 'model_provider=agentcli', '-m', 'gpt-baked'],
		environment: [{ name: 'FAKE_LOG', value: log }],
		requiredEnvironment: [],
		...overrides,
	};
}

function launchFor(overrides: Partial<SessionLaunch> = {}, instanceOverrides: Partial<ProviderInstance> = {}): { launch: SessionLaunch; log: string } {
	const log = join(dir, `log-${++logCounter}.jsonl`);
	writeFileSync(log, '');
	const launch: SessionLaunch = {
		instance: instance(log, instanceOverrides),
		cwd: dir,
		extraDirectories: [],
		model: 'gpt-picked',
		mode: 'interactive',
		env: { PATH: process.env.PATH },
		...overrides,
	};
	return { launch, log };
}

function readLog(log: string): Array<Record<string, any>> {
	return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

class Token implements CancellationTokenLike {
	isCancellationRequested = false;
	private readonly listeners = new Set<() => void>();
	onCancellationRequested(listener: () => void) {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}
	cancel(): void {
		this.isCancellationRequested = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

async function collect(session: AgentSession, prompt: string, token: CancellationTokenLike = new Token()): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	await session.send(prompt, { onEvent: event => events.push(event) }, token);
	return events;
}

function exited(session: AgentSession): Promise<{ code: number | null; error?: string }> {
	return new Promise(resolve => session.onDidExit(info => resolve(info)));
}

async function closed(session: AgentSession): Promise<void> {
	const exit = exited(session);
	session.dispose();
	await exit;
}

const textOf = (events: AgentEvent[]) => events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join('');

test('appServerArgs keeps config overrides and moves the model to the thread', () => {
	const parsed = appServerArgs(['-c', 'model_provider=agentcli', '-m', 'gpt-6.1-sol', '--enable', 'x', '--profile', 'work', '-s', 'workspace-write', '--json']);
	assert.deepEqual(parsed.config, ['-c', 'model_provider=agentcli', '--enable', 'x', '-c', 'profile="work"']);
	assert.equal(parsed.model, 'gpt-6.1-sol');
	assert.equal(parsed.sandbox, 'workspace-write');
	assert.deepEqual(parsed.dropped, ['--json']);
	assert.equal(appServerArgs(['-c', 'model="o3"']).model, 'o3');
	assert.deepEqual(appServerArgs(['--dangerously-bypass-approvals-and-sandbox']), { config: [], model: undefined, sandbox: 'danger-full-access', approval: 'never', dropped: [] });
});

test('sandboxFor: read-only modes are read-only with no approvals; others keep the config sandbox', () => {
	assert.deepEqual(sandboxFor('plan', { sandbox: 'danger-full-access' }), { sandbox: 'read-only', approvalPolicy: 'never' });
	assert.deepEqual(sandboxFor('interactive', {}), { sandbox: undefined, approvalPolicy: 'on-request' });
	assert.deepEqual(sandboxFor('background', { sandbox: 'workspace-write', approval: 'never' }), { sandbox: 'workspace-write', approvalPolicy: 'never' });
});

test('argv carries editor tool MCP overrides before app-server', () => {
	const { launch } = launchFor({ editorTools: { mcpConfigFile: '', settingsFile: '', shimPath: '/shim.js', port: 4242, token: 'tok', dispose() { } } });
	const argv = codexAppServerArgv(launch);
	assert.equal(argv[argv.length - 1], 'app-server');
	assert.deepEqual(argv.slice(0, 2), ['-c', 'model_provider=agentcli']);
	assert.ok(argv.includes('mcp_servers.thrice.command="node"'));
	assert.ok(argv.includes('mcp_servers.thrice.args=["/shim.js","4242","tok"]'));
	assert.ok(!argv.includes('-m'));
});

test('toExecItem maps app-server items to the exec shapes', () => {
	assert.deepEqual(toExecItem({ type: 'commandExecution', id: 'c', command: 'ls', cwd: '/', status: 'completed', aggregatedOutput: 'a', exitCode: 0 }), { type: 'command_execution', id: 'c', command: 'ls', status: 'completed', aggregated_output: 'a', exit_code: 0 });
	assert.deepEqual(toExecItem({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: '/a', kind: { type: 'add' }, diff: 'x\n' }] }), { type: 'file_change', id: 'f', status: 'in_progress', changes: [{ path: '/a', kind: 'add', diff: 'x\n' }] });
	assert.equal(toExecItem({ type: 'userMessage', id: 'u' }), undefined);
});

test('handshake starts a thread with the picked model and launch config overrides', async () => {
	const { launch, log } = launchFor();
	const session = open(launch);
	assert.equal(session.state, 'starting');
	assert.equal(session.driver, 'codex');
	const events = await collect(session, 'hello');
	assert.match(textOf(events), /^ok \d+$/);
	assert.equal(session.sessionId, 'thr-new');
	assert.equal(session.state, 'idle');
	const entries = readLog(log);
	assert.deepEqual(entries[0].argv, ['-c', 'model_provider=agentcli', 'app-server']);
	assert.deepEqual(entries.slice(1).map(entry => entry.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
	const start = entries.find(entry => entry.method === 'thread/start')!;
	assert.deepEqual(start.params, { cwd: dir, approvalPolicy: 'on-request', model: 'gpt-picked' });
	const turn = entries.find(entry => entry.method === 'turn/start')!;
	assert.equal(turn.params.threadId, 'thr-new');
	assert.equal(turn.params.model, 'gpt-picked');
	assert.match(turn.params.input[0].text, /hello$/);
	assert.match(turn.params.input[0].text, /mermaid/, 'mode preface from promptForTurn');
	await closed(session);
});

test('resume uses the thread id and two turns share one process', async () => {
	const { launch, log } = launchFor({ resumeId: 'thr-old', mode: 'plan' });
	const session = open(launch);
	const first = textOf(await collect(session, 'one'));
	assert.equal(session.sessionId, 'thr-old');
	const second = textOf(await collect(session, 'two'));
	assert.equal(first, second, 'same pid answered both turns');
	const entries = readLog(log);
	assert.equal(entries.filter(entry => entry.argv).length, 1);
	const resume = entries.find(entry => entry.method === 'thread/resume')!;
	assert.deepEqual(resume.params, { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-picked', threadId: 'thr-old', excludeTurns: true });
	assert.deepEqual(entries.filter(entry => entry.method === 'turn/start').map(entry => entry.params.threadId), ['thr-old', 'thr-old']);
	assert.match(entries.find(entry => entry.method === 'turn/start')!.params.input[0].text, /Research and write a plan/);
	await closed(session);
});

test('maps text, reasoning, commands with exit codes, file changes, MCP calls and plans', async () => {
	const { launch } = launchFor();
	const session = open(launch);
	const events = await collect(session, 'EVENTS');
	assert.equal(textOf(events), 'Looking.\n\nDone.');
	const thinking = events.filter(event => event.kind === 'thinking').map(event => (event as { text: string }).text).join('');
	assert.equal(thinking, 'Thinking hard');
	const starts = events.filter(event => event.kind === 'toolStart') as Array<Extract<AgentEvent, { kind: 'toolStart' }>>;
	assert.deepEqual(starts.map(event => [event.id, event.tool]), [['c1', 'Bash'], ['f1', 'Edit'], ['t1', 'mcp__thrice__sessionContext'], ['plan-turn-1', 'TodoWrite']]);
	assert.equal(starts[0].label, 'Running `npm test`');
	const ends = events.filter(event => event.kind === 'toolEnd') as Array<Extract<AgentEvent, { kind: 'toolEnd' }>>;
	assert.deepEqual(ends.find(event => event.id === 'c1'), { kind: 'toolEnd', id: 'c1', ok: false, output: '1 failing', exitCode: 2 });
	assert.deepEqual(ends.find(event => event.id === 'f1'), { kind: 'toolEnd', id: 'f1', ok: true });
	assert.deepEqual(ends.find(event => event.id === 't1'), { kind: 'toolEnd', id: 't1', ok: true, output: 'one folder' });
	assert.ok(ends.find(event => event.id === 'plan-turn-1'), 'plan card closes at turn end');
	assert.deepEqual(events.filter(event => event.kind === 'fileChange'), [{ kind: 'fileChange', path: '/repo/a.ts', change: 'update', toolId: 'f1', added: 2, removed: 1 }]);
	await closed(session);
});

test('a failed turn rejects with the CLI error and the session stays usable', async () => {
	const { launch } = launchFor();
	const session = open(launch);
	await assert.rejects(collect(session, 'FAIL'), /boom/);
	assert.equal(session.state, 'idle');
	assert.match(textOf(await collect(session, 'again')), /^ok/);
	await closed(session);
});

test('cancel interrupts the turn and resolves when it ends; the process stays alive', async () => {
	const { launch, log } = launchFor();
	const session = open(launch);
	const token = new Token();
	const pending = collect(session, 'HANG', token);
	while (!readLog(log).some(entry => entry.method === 'turn/start')) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	await new Promise(resolve => setTimeout(resolve, 20));
	token.cancel();
	const events = await pending;
	assert.deepEqual(events.filter(event => event.kind === 'toolEnd'), [{ kind: 'toolEnd', id: 'sleep1', ok: false }], 'running command card is closed');
	const interrupt = readLog(log).find(entry => entry.method === 'turn/interrupt')!;
	assert.deepEqual(interrupt.params, { threadId: 'thr-new', turnId: 'turn-1' });
	assert.equal(session.state, 'idle');
	assert.match(textOf(await collect(session, 'after')), /^ok/);
	await closed(session);
});

test('a second send while busy rejects', async () => {
	const { launch } = launchFor();
	const session = open(launch);
	const token = new Token();
	const first = collect(session, 'HANG', token);
	await assert.rejects(collect(session, 'second'), /still answering/);
	token.cancel();
	await first;
	await closed(session);
});

test('process death mid-turn rejects with the stderr tail and fires onDidExit once', async () => {
	const { launch } = launchFor();
	const session = open(launch);
	const exits: Array<{ code: number | null; error?: string }> = [];
	session.onDidExit(info => exits.push(info));
	await assert.rejects(collect(session, 'DIE'), /model exploded/);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(session.state, 'exited');
	assert.equal(exits.length, 1);
	assert.equal(exits[0].code, 3);
	assert.match(exits[0].error ?? '', /model exploded/);
	await assert.rejects(collect(session, 'more'), /model exploded/);
});

test('dispose ends the process, fires onDidExit once and disposes editor tools', async () => {
	let toolDisposals = 0;
	const { launch } = launchFor({ editorTools: { mcpConfigFile: '', settingsFile: '', shimPath: '/shim.js', port: 1, token: 't', dispose: () => { toolDisposals++; } } });
	const session = open(launch);
	await collect(session, 'hello');
	const exits: Array<{ code: number | null; error?: string }> = [];
	session.onDidExit(info => exits.push(info));
	const exit = exited(session);
	session.dispose();
	session.dispose();
	const info = await exit;
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(exits.length, 1);
	assert.equal(info.error, undefined);
	assert.equal(toolDisposals, 1);
	assert.equal(session.state, 'exited');
});

test('approvals: accepted outside read-only modes, declined in them', async () => {
	for (const [mode, decision] of [['interactive', 'accept'], ['ask', 'decline']] as const) {
		const { launch } = launchFor({ mode });
		const session = open(launch);
		assert.equal(textOf(await collect(session, 'APPROVE')), `decision={"decision":"${decision}"}`);
		await closed(session);
	}
});

test('a missing command gives a clear error', async () => {
	const { launch } = launchFor({}, { command: join(dir, 'no-such-codex') });
	const session = open(launch);
	const exit = exited(session);
	await assert.rejects(collect(session, 'hello'), /could not find .*no-such-codex/);
	assert.match((await exit).error ?? '', /could not find/);
	assert.equal(session.state, 'exited');
});

test('a thread that cannot be resumed ends the session with the reason', async () => {
	const { launch } = launchFor({ resumeId: 'missing' });
	const session = open(launch);
	const exit = exited(session);
	await assert.rejects(collect(session, 'hello'), /could not resume thread missing: no rollout found/);
	assert.match((await exit).error ?? '', /could not resume/);
});
