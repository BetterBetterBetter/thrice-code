import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CLAUDE_TERMINAL_TOOL, denialFromHook, EDITOR_TOOL_INSTRUCTION, ensureEditorToolInstruction, externalTerminalDenial, interactiveCliDenial, interpretMcp, mcpStdioFrame, SESSION_TOOL_NAMES, SPAWN_TOOL_NAME, TERMINAL_TOOL_NAME, withEditorTools, type EditorToolLaunch } from '../src/editorToolPolicy.ts';

const launch: EditorToolLaunch = {
	mcpConfigFile: '/tmp/mcp.json',
	settingsFile: '/tmp/settings.json',
	shimPath: '/tmp/shim.mjs',
	port: 4312,
	token: 'token',
	dispose: () => undefined,
};

test('a terminal request stays inside the editor unless the user names the app', () => {
	const command = 'osascript -e \'tell application "iTerm" to create window with default profile\'';
	const denied = externalTerminalDenial(command, 'spawn a new terminal session with claude open and ready', CLAUDE_TERMINAL_TOOL);
	assert.match(denied ?? '', /mcp__thrice__spawnTerminal/);
	assert.equal(externalTerminalDenial(command, 'open that in iTerm', CLAUDE_TERMINAL_TOOL), undefined);
	assert.equal(externalTerminalDenial('echo hello', 'spawn a terminal', CLAUDE_TERMINAL_TOOL), undefined);
	assert.match(externalTerminalDenial('open -a Terminal', 'open a terminal', CLAUDE_TERMINAL_TOOL) ?? '', /Terminal/);
	assert.equal(externalTerminalDenial('open -a Terminal', 'use Terminal.app', CLAUDE_TERMINAL_TOOL), undefined);
});

test('the bash hook reads the command and blocks an unnamed external terminal', () => {
	const reason = denialFromHook(JSON.stringify({
		tool_name: 'Bash',
		tool_input: { command: 'osascript -e \'tell application "iTerm" to activate\'' },
	}), 'spawn a new terminal session');
	assert.match(reason ?? '', /spawnTerminal/);
	assert.equal(denialFromHook('{', 'spawn a terminal'), undefined);
	assert.match(interactiveCliDenial('claude') ?? '', /spawnTerminal/);
	assert.equal(interactiveCliDenial('claude -p "hello"'), undefined);
	assert.equal(interactiveCliDenial('command -v claude'), undefined);
	assert.equal(interactiveCliDenial('echo hello'), undefined);
});

test('claude and codex launches advertise the editor terminal', () => {
	const claude = withEditorTools('claude', ['--dangerously-skip-permissions', '--model', 'claude', '-p', '--', 'hello'], launch);
	assert.ok(claude.indexOf('--mcp-config') < claude.indexOf('--'));
	assert.equal(claude[claude.indexOf('--mcp-config') + 1], '/tmp/mcp.json');
	assert.equal(claude[claude.indexOf('--settings') + 1], '/tmp/settings.json');
	assert.match(claude.at(-1) ?? '', /mcp__thrice__spawnTerminal/);
	assert.match(claude.at(-1) ?? '', /^hello\n/);
	const withDirs = withEditorTools('claude', ['--', 'hello'], launch, ['/tmp/other']);
	assert.ok(withDirs.indexOf('--add-dir') < withDirs.indexOf('--'));
	assert.equal(withDirs[withDirs.indexOf('--add-dir') + 1], '/tmp/other');
	const codex = withEditorTools('codex', ['-m', 'gpt', 'exec', '--json', '--', 'hello'], launch);
	assert.ok(codex.indexOf('mcp_servers.thrice.command="node"') < codex.indexOf('exec'));
	assert.match(codex.find(arg => arg.startsWith('mcp_servers.thrice.args=')) ?? '', /shim\.mjs/);
	assert.match(codex.at(-1) ?? '', new RegExp(SPAWN_TOOL_NAME));
});

test('the editor rule is added even when the diagram preface is already present', () => {
	const already = 'When a diagram helps, write a mermaid code fence.\n\nUser:\nspawn a terminal';
	const prompt = ensureEditorToolInstruction(already);
	assert.equal(prompt.includes(EDITOR_TOOL_INSTRUCTION), true);
	assert.equal(ensureEditorToolInstruction(prompt), prompt);
	const listed = interpretMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	if (listed.kind === 'reply') {
		const tools = (listed.message as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
		assert.equal(tools.some(item => item.name === 'sessionContext'), true);
		assert.equal(tools.some(item => item.name === SPAWN_TOOL_NAME), true);
		assert.equal(tools.some(item => item.name === 'openEditor'), true);
		assert.equal(SESSION_TOOL_NAMES.has('waitTerminal'), true);
	}
	const initialized = interpretMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
	assert.equal(initialized.kind, 'reply');
	if (initialized.kind === 'reply') {
		const body = mcpStdioFrame(initialized.message);
		const line = body.slice(0, body.indexOf('\n'));
		assert.equal(body.endsWith('\n'), true);
		assert.equal(line.includes('Content-Length'), false);
		const parsed = JSON.parse(line) as { result?: { serverInfo?: { name?: string } } };
		assert.equal(parsed.result?.serverInfo?.name, 'thrice');
	}
	const source = readFileSync(new URL('../src/editorTools.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('Content-Length:'), false);
	assert.equal(source.includes('mcpStdioFrame'), true);
	const notification = interpretMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
	assert.equal(notification.kind, 'none');
	const call = interpretMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: TERMINAL_TOOL_NAME, arguments: { command: 'claude', keep_open: true } } });
	assert.equal(call.kind, 'tool');
	if (call.kind === 'tool') {
		assert.equal(call.args.command, 'claude');
		assert.equal(call.args.keep_open, true);
	}
});

test('agent tools are listed by depth, and a cancellation is passed on', () => {
	const names = (options?: { agents?: boolean; canSpawn?: boolean }) => {
		const listed = interpretMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, options);
		assert.equal(listed.kind, 'reply');
		return listed.kind === 'reply' ? ((listed.message as { result: { tools: { name: string }[] } }).result.tools.map(item => item.name)) : [];
	};
	assert.equal(names().includes('listAgents'), false);
	assert.equal(names({ agents: true }).includes('listAgents'), true);
	assert.equal(names({ agents: true }).includes('runAgent'), false);
	assert.equal(names({ agents: true, canSpawn: true }).includes('runAgent'), true);
	assert.deepEqual(interpretMcp({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }), { kind: 'cancel', requestId: 7 });
	assert.deepEqual(interpretMcp({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), { kind: 'none' });
});

test('a launch that may start agents says so, and codex waits long enough for them', () => {
	const agents = { ...launch, agentTools: true };
	const claude = withEditorTools('claude', ['--', 'hello'], agents);
	assert.match(claude[claude.indexOf('--append-system-prompt') + 1], /mcp__thrice__runAgent/);
	assert.match(claude.at(-1) ?? '', /mcp__thrice__listAgents/);
	assert.doesNotMatch(withEditorTools('claude', ['--', 'hello'], launch).at(-1) ?? '', /runAgent/);
	const codex = withEditorTools('codex', ['exec', '--', 'hello'], agents);
	assert.equal(codex.includes('mcp_servers.thrice.tool_timeout_sec=3600'), true);
	assert.match(codex.at(-1) ?? '', /runAgent/);
});

test('a claude launch that cannot skip permissions is allowed the read-only thrice tools only', async () => {
	const { READ_ONLY_THRICE_TOOLS } = await import('../src/editorToolPolicy.ts');
	const readOnly = withEditorTools('claude', ['--model', 'x', '-p', '--', 'hello'], launch);
	const allowed = readOnly[readOnly.indexOf('--allowedTools') + 1].split(',');
	assert.ok(readOnly.indexOf('--allowedTools') < readOnly.indexOf('--'));
	assert.deepEqual(allowed, READ_ONLY_THRICE_TOOLS.map(name => `mcp__thrice__${name}`));
	assert.equal(allowed.includes('mcp__thrice__writeEditor'), false);
	assert.equal(allowed.includes('mcp__thrice__spawnTerminal'), false);
	const skipping = withEditorTools('claude', ['--dangerously-skip-permissions', '-p', '--', 'hello'], launch);
	assert.equal(skipping.includes('--allowedTools'), false);
});

test('opencode gets the thrice server through its config environment, keeping the user\'s', async () => {
	const { editorToolEnvironment } = await import('../src/editorToolPolicy.ts');
	assert.deepEqual(editorToolEnvironment('claude', launch), {});
	assert.deepEqual(editorToolEnvironment('opencode', undefined), {});
	const env = editorToolEnvironment('opencode', launch, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'agentcli/grok', mcp: { mine: { type: 'local', command: ['x'] } } }) });
	const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { model: string; mcp: Record<string, { command: string[] }> };
	assert.equal(config.model, 'agentcli/grok');
	assert.deepEqual(config.mcp.mine.command, ['x']);
	assert.deepEqual(config.mcp.thrice.command, ['node', '/tmp/shim.mjs', '4312', 'token']);
	assert.ok(JSON.parse(editorToolEnvironment('opencode', launch, { OPENCODE_CONFIG_CONTENT: '{' }).OPENCODE_CONFIG_CONTENT).mcp.thrice);
	const args = withEditorTools('opencode', ['run', '--format', 'json', '-m', 'grok', 'hello'], { ...launch, agentTools: true });
	assert.match(args.at(-1) ?? '', /^hello\n\n.*thrice_spawnTerminal.*thrice_runAgent/s);
	assert.equal(args.length, 6);
});

test('an agent\'s own terminals are tracked so they can be closed, and the notes say to close them', async () => {
	const { spawnedTerminalId, TERMINAL_CLOSE_RULE, claudeToolNote, codexToolNote, opencodeToolNote, SESSION_TOOLS, TERMINAL_TOOL } = await import('../src/editorToolPolicy.ts');
	assert.equal(spawnedTerminalId('Opened the terminal panel on terminal 12 "npm". Call readTerminal or waitTerminal with id 12 for output.'), 12);
	assert.equal(spawnedTerminalId('Error: No integrated terminal with id 12.'), undefined);
	assert.equal(spawnedTerminalId('Sent text to terminal 3.'), undefined);
	const spawn = SESSION_TOOLS.find(item => item.name === SPAWN_TOOL_NAME);
	assert.equal(spawn?.inputSchema.properties.for_user?.type, 'boolean');
	assert.equal(TERMINAL_TOOL.inputSchema.properties.for_user?.type, 'boolean');
	for (const note of [claudeToolNote(), codexToolNote(), opencodeToolNote()]) {
		assert.ok(note.includes(TERMINAL_CLOSE_RULE));
		assert.ok(note.startsWith(EDITOR_TOOL_INSTRUCTION));
	}
});

test('the session shim answers initialize as one json line', async () => {
	const source = readFileSync(new URL('../src/editorTools.ts', import.meta.url), 'utf8');
	const start = source.indexOf('const SHIM = `');
	const end = source.indexOf('`;', start);
	const shim = eval(source.slice(start + 'const SHIM = '.length, end + 1)) as string;
	const dir = mkdtempSync(join(tmpdir(), 'thrice-mcp-'));
	const shimPath = join(dir, 'shim.mjs');
	writeFileSync(shimPath, shim);
	const token = 'token';
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			if (req.headers.authorization !== `Bearer ${token}`) {
				res.statusCode = 401;
				res.end();
				return;
			}
			const action = interpretMcp(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			res.end(action.kind === 'reply' ? mcpStdioFrame(action.message) : '');
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	const port = address && typeof address === 'object' ? address.port : 0;
	const child = spawn(process.execPath, [shimPath, String(port), token], { stdio: ['pipe', 'pipe', 'pipe'] });
	const stdout = new Promise<string>((resolve, reject) => {
		let body = '';
		const timer = setTimeout(() => reject(new Error(`shim produced ${JSON.stringify(body)}`)), 3000);
		child.stdout.on('data', chunk => {
			body += chunk.toString('utf8');
			if (body.includes('\n')) {
				clearTimeout(timer);
				resolve(body);
			}
		});
		child.on('exit', () => {
			clearTimeout(timer);
			reject(new Error(`shim exited with ${JSON.stringify(body)}`));
		});
	});
	child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
	try {
		const body = await stdout;
		const parsed = JSON.parse(body.slice(0, body.indexOf('\n'))) as { result?: { serverInfo?: { name?: string } } };
		assert.equal(parsed.result?.serverInfo?.name, 'thrice');
	} finally {
		child.kill();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the session shim does not hold a quick call behind a slow one', async () => {
	const source = readFileSync(new URL('../src/editorTools.ts', import.meta.url), 'utf8');
	const start = source.indexOf('const SHIM = `');
	const end = source.indexOf('`;', start);
	const shim = eval(source.slice(start + 'const SHIM = '.length, end + 1)) as string;
	const dir = mkdtempSync(join(tmpdir(), 'thrice-mcp-'));
	const shimPath = join(dir, 'shim.mjs');
	writeFileSync(shimPath, shim);
	let releaseSlow: (() => void) | undefined;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number };
			const reply = () => res.end(mcpStdioFrame({ jsonrpc: '2.0', id: message.id, result: {} }));
			if (message.id === 1) {
				releaseSlow = reply;
			} else {
				reply();
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	const port = address && typeof address === 'object' ? address.port : 0;
	const child = spawn(process.execPath, [shimPath, String(port), 'token'], { stdio: ['pipe', 'pipe', 'pipe'] });
	const ids: number[] = [];
	const both = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`shim answered ${JSON.stringify(ids)}`)), 3000);
		let body = '';
		child.stdout.on('data', chunk => {
			body += chunk.toString('utf8');
			const lines = body.split('\n');
			body = lines.pop() ?? '';
			for (const line of lines) {
				ids.push((JSON.parse(line) as { id: number }).id);
				if (ids.length === 1) {
					releaseSlow?.();
				}
				if (ids.length === 2) {
					clearTimeout(timer);
					resolve();
				}
			}
		});
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
	try {
		await both;
		assert.deepEqual(ids, [2, 1]);
	} finally {
		child.kill();
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
