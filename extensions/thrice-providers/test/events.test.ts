import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventDecoder, describeTool, partialToolInput, toolLabel, unwrapShell, type AgentEvent } from '../src/events.ts';

function feed(driver: string, lines: unknown[], cwd = '/repo'): { events: AgentEvent[]; failure: string | undefined } {
	const decoder = createEventDecoder(driver, { cwd });
	const events: AgentEvent[] = [];
	for (const line of lines) {
		events.push(...decoder.push(typeof line === 'string' ? line : JSON.stringify(line)));
	}
	return { events, failure: decoder.failure() };
}

const textOf = (events: AgentEvent[]) => events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join('');

const stream = (event: unknown, parent: string | null = null) => ({ type: 'stream_event', event, session_id: 's1', parent_tool_use_id: parent, uuid: 'u' });

test('claude partial messages: thinking, streamed tool input, result, text without duplicates', () => {
	const { events, failure } = feed('claude', [
		{ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', tools: ['Read', 'Bash'] },
		stream({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
		stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
		stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look at the ' } }),
		stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'parser.' } }),
		stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
		stream({ type: 'content_block_stop', index: 0 }),
		{ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at the parser.', signature: 'abc' }] }, parent_tool_use_id: null, session_id: 's1' },
		stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }),
		stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/repo/src/pa' } }),
		stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'rser.ts", "offset": 120, "limit"' } }),
		stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ': 61}' } }),
		stream({ type: 'content_block_stop', index: 1 }),
		{ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/src/parser.ts', offset: 120, limit: 61 } }] }, parent_tool_use_id: null, session_id: 's1' },
		stream({ type: 'message_stop' }),
		{ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: '   120\tconst x = 1;' }] }, parent_tool_use_id: null, session_id: 's1', tool_use_result: { type: 'text', file: { filePath: '/repo/src/parser.ts' } } },
		stream({ type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [] } }),
		stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
		stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The parser ' } }),
		stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is fine.' } }),
		stream({ type: 'content_block_stop', index: 0 }),
		{ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'The parser is fine.' }] }, parent_tool_use_id: null, session_id: 's1' },
		{ type: 'result', subtype: 'success', is_error: false, result: 'The parser is fine.', session_id: 's1' },
	]);
	assert.equal(failure, undefined);
	assert.equal(textOf(events), 'The parser is fine.');
	assert.deepEqual(events.filter(event => event.kind === 'thinking').map(event => (event as { text: string }).text), ['Look at the ', 'parser.']);
	const tools = events.filter(event => event.kind.startsWith('tool'));
	assert.deepEqual(tools[0], { kind: 'toolStart', id: 'toolu_1', tool: 'Read', label: 'Reading' });
	// Partial JSON gives the path (only once its string is complete) before the input is complete.
	assert.deepEqual(tools[1], { kind: 'toolUpdate', id: 'toolu_1', label: 'Reading `src/parser.ts` from L120', input: { file_path: '/repo/src/parser.ts', offset: 120 } });
	const final = tools.filter(event => event.kind === 'toolUpdate').at(-1);
	assert.equal((final as { label: string }).label, 'Reading `src/parser.ts` L120-180');
	assert.deepEqual((final as { input: unknown }).input, { file_path: '/repo/src/parser.ts', offset: 120, limit: 61 });
	// The full assistant message does not restart or re-update the tool.
	assert.equal(tools.filter(event => event.kind === 'toolStart').length, 1);
	assert.deepEqual(tools.at(-1), { kind: 'toolEnd', id: 'toolu_1', ok: true, output: '   120\tconst x = 1;' });
});

test('claude without partial messages: tools from assistant blocks, bash exit codes, edits become file changes', () => {
	const { events } = feed('claude', [
		{ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Running tests.' }, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] }, parent_tool_use_id: null },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'Exit code 1\nFAIL test/a.test.ts' }] }, parent_tool_use_id: null },
		{ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/repo/new.ts', content: 'x' } }, { type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/repo/old.ts', old_string: 'a', new_string: 'b' } }] }, parent_tool_use_id: null },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'File created successfully at: /repo/new.ts' }] }, tool_use_result: { type: 'create', filePath: '/repo/new.ts' } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'The file /repo/old.ts has been updated.' }] }, tool_use_result: { filePath: '/repo/old.ts', structuredPatch: [] } },
		{ type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: ' Done.' }] }, parent_tool_use_id: null },
	]);
	assert.equal(textOf(events), 'Running tests. Done.');
	assert.deepEqual(events.find(event => event.kind === 'toolStart'), { kind: 'toolStart', id: 'toolu_b', tool: 'Bash', label: 'Running `npm test`', input: { command: 'npm test', description: 'Run tests' } });
	assert.deepEqual(events.find(event => event.kind === 'toolEnd'), { kind: 'toolEnd', id: 'toolu_b', ok: false, output: 'Exit code 1\nFAIL test/a.test.ts', exitCode: 1 });
	assert.deepEqual(events.filter(event => event.kind === 'fileChange'), [
		{ kind: 'fileChange', path: '/repo/new.ts', change: 'add' },
		{ kind: 'fileChange', path: '/repo/old.ts', change: 'update' },
	]);
	assert.deepEqual(events.filter(event => event.kind === 'toolStart').map(event => (event as { label: string }).label), ['Running `npm test`', 'Writing `new.ts`', 'Editing `old.ts`']);
});

test('claude sub-agents: child tools carry the parent id and sub-agent text stays out of the answer', () => {
	const { events } = feed('claude', [
		{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Find callers', prompt: 'Find all callers of parse()', subagent_type: 'Explore' } }] }, parent_tool_use_id: null },
		{ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'I will grep.' }, { type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { pattern: 'parse\\(', path: '/repo/src' } }] }, parent_tool_use_id: 'toolu_task' },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_g', content: 'src/a.ts\nsrc/b.ts' }] }, parent_tool_use_id: 'toolu_task' },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: [{ type: 'text', text: 'Two callers: a.ts, b.ts' }] }] }, parent_tool_use_id: null },
	]);
	assert.equal(textOf(events), '');
	const starts = events.filter(event => event.kind === 'toolStart') as Extract<AgentEvent, { kind: 'toolStart' }>[];
	assert.equal(starts[0].label, 'Running sub-agent `Find callers` (Explore)');
	assert.equal(starts[0].parentId, undefined);
	assert.equal(starts[1].label, 'Searching `parse\\(` in `src`');
	assert.equal(starts[1].parentId, 'toolu_task');
	assert.deepEqual(events.at(-1), { kind: 'toolEnd', id: 'toolu_task', ok: true, output: 'Two callers: a.ts, b.ts' });
});

test('claude failures are reported', () => {
	const { failure } = feed('claude', [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Overloaded' }]);
	assert.equal(failure, 'Overloaded');
});

test('cursor keeps the cumulative text dedupe and maps tool_call lines', () => {
	const { events } = feed('cursor', [
		{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] } },
		{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
		{ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls -la' } } } },
		{ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls -la' }, result: { success: { exitCode: 0, stdout: 'a\nb' } } } } },
		{ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { readToolCall: { args: { path: '/repo/README.md' } } } },
	]);
	assert.equal(textOf(events), 'Hello');
	assert.deepEqual(events.filter(event => event.kind.startsWith('tool')), [
		{ kind: 'toolStart', id: 'c1', tool: 'Bash', label: 'Running `ls -la`', input: { command: 'ls -la' } },
		{ kind: 'toolEnd', id: 'c1', ok: true, output: 'a\nb', exitCode: 0 },
		{ kind: 'toolStart', id: 'c2', tool: 'Read', label: 'Reading `README.md`', input: { path: '/repo/README.md' } },
	]);
});

test('codex exec --json: reasoning, commands with exit codes, file changes, mcp, todo, text', () => {
	const { events, failure } = feed('codex', [
		{ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
		{ type: 'turn.started' },
		{ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Inspecting the repo**' } },
		{ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc \'rg -n "parse" src\'', aggregated_output: '', exit_code: null, status: 'in_progress' } },
		{ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc \'rg -n "parse" src\'', aggregated_output: 'src/a.ts:3:parse()\n', exit_code: 0, status: 'completed' } },
		{ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc "npm test"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
		{ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc "npm test"', aggregated_output: 'FAIL', exit_code: 1, status: 'failed' } },
		{ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/repo/src/a.ts', kind: 'update' }, { path: '/repo/src/new.ts', kind: 'add' }], status: 'completed' } },
		{ type: 'item.started', item: { id: 'item_4', type: 'mcp_tool_call', server: 'thrice', tool: 'readEditor', arguments: { path: '/repo/src/a.ts' }, status: 'in_progress' } },
		{ type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'thrice', tool: 'readEditor', arguments: { path: '/repo/src/a.ts' }, result: { content: [{ type: 'text', text: 'ok' }] }, status: 'completed' } },
		{ type: 'item.started', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'Fix parser', completed: false }] } },
		{ type: 'item.updated', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'Fix parser', completed: true }] } },
		{ type: 'item.completed', item: { id: 'item_6', type: 'web_search', query: 'node test runner strip types' } },
		{ type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: 'Fixed the parser.' } },
		{ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
	]);
	assert.equal(failure, undefined);
	assert.equal(textOf(events), 'Fixed the parser.');
	assert.deepEqual(events[0], { kind: 'thinking', text: '**Inspecting the repo**', id: 'item_0' });
	assert.deepEqual(events[1], { kind: 'toolStart', id: 'item_1', tool: 'Bash', label: 'Running `rg -n "parse" src`', input: { command: 'bash -lc \'rg -n "parse" src\'' } });
	assert.deepEqual(events[2], { kind: 'toolEnd', id: 'item_1', ok: true, output: 'src/a.ts:3:parse()\n', exitCode: 0 });
	assert.deepEqual(events.find(event => event.kind === 'toolEnd' && event.id === 'item_2'), { kind: 'toolEnd', id: 'item_2', ok: false, output: 'FAIL', exitCode: 1 });
	assert.equal((events.find(event => event.kind === 'toolStart' && event.id === 'item_3') as { label: string }).label, 'Editing 2 files');
	assert.deepEqual(events.filter(event => event.kind === 'fileChange'), [
		{ kind: 'fileChange', path: '/repo/src/a.ts', change: 'update' },
		{ kind: 'fileChange', path: '/repo/src/new.ts', change: 'add' },
	]);
	assert.equal((events.find(event => event.kind === 'toolStart' && event.id === 'item_4') as { label: string }).label, 'Calling `thrice.readEditor`');
	assert.deepEqual(events.find(event => event.kind === 'toolEnd' && event.id === 'item_4'), { kind: 'toolEnd', id: 'item_4', ok: true, output: 'ok' });
	assert.deepEqual(events.find(event => event.kind === 'toolUpdate' && event.id === 'item_5'), { kind: 'toolUpdate', id: 'item_5', label: 'Updating todos', input: { items: [{ text: 'Fix parser', completed: true }] } });
	assert.equal((events.find(event => event.kind === 'toolStart' && event.id === 'item_6') as { label: string }).label, 'Searching the web for `node test runner strip types`');
});

test('codex streamed text deltas and failures', () => {
	const { events, failure } = feed('codex', [
		{ type: 'agent_message_content_delta', delta: 'Yo' },
		{ type: 'item.updated', item: { id: 'm', type: 'agent_message', text: 'Hi' } },
		{ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Hi there' } },
		{ type: 'turn.failed', error: { message: 'stream disconnected' } },
	]);
	assert.equal(textOf(events), 'YoHi there');
	assert.equal(failure, 'stream disconnected');
});

test('opencode text, reasoning and tool parts', () => {
	const { events, failure } = feed('opencode', [
		{ type: 'message.part.updated', properties: { part: { id: '1', type: 'text', text: 'Hi' } } },
		{ type: 'message.part.updated', properties: { part: { id: '1', type: 'text', text: 'Hi there' } } },
		{ type: 'reasoning', part: { id: 'r', type: 'reasoning', text: 'Thinking' } },
		{ type: 'tool_use', part: { id: 'p1', callID: 'call_1', type: 'tool', tool: 'read', state: { status: 'running', input: { filePath: '/repo/a.ts', offset: 9, limit: 10 } } } },
		{ type: 'tool_use', part: { id: 'p1', callID: 'call_1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/repo/a.ts', offset: 9, limit: 10 }, output: 'text', title: 'a.ts', metadata: {} } } },
		{ type: 'tool_use', part: { id: 'p2', callID: 'call_2', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'false' }, output: '', metadata: { exit: 1 } } } },
		{ type: 'tool_use', part: { id: 'p3', callID: 'call_3', type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }, output: '', metadata: {} } } },
	]);
	assert.equal(failure, undefined);
	assert.equal(textOf(events), 'Hi there');
	assert.deepEqual(events.find(event => event.kind === 'thinking'), { kind: 'thinking', text: 'Thinking', id: 'r' });
	assert.equal((events.find(event => event.kind === 'toolStart' && event.id === 'call_1') as { label: string }).label, 'Reading `a.ts` L10-19');
	assert.deepEqual(events.find(event => event.kind === 'toolEnd' && event.id === 'call_1'), { kind: 'toolEnd', id: 'call_1', ok: true, output: 'text' });
	assert.deepEqual(events.find(event => event.kind === 'toolEnd' && event.id === 'call_2'), { kind: 'toolEnd', id: 'call_2', ok: false, exitCode: 1 });
	assert.deepEqual(events.at(-1), { kind: 'fileChange', path: '/repo/a.ts', change: 'update' });
});

test('plain drivers pass non-JSON lines as text', () => {
	const { events } = feed('grok', ['hello', '{"type":"noise"}', '  world  ']);
	assert.deepEqual(events, [{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }]);
});

test('labels name the target', () => {
	assert.equal(toolLabel('Glob', { pattern: '**/*.ts', path: '/repo/src' }, '/repo'), 'Finding files `**/*.ts` in `src`');
	assert.equal(toolLabel('mcp__thrice__openEditor', {}), 'Calling `thrice.openEditor`');
	assert.equal(toolLabel('WebFetch', { url: 'https://example.com' }), 'Fetching `https://example.com`');
	assert.equal(toolLabel('Mystery', {}), 'Using `Mystery`');
	assert.equal(describeTool('Bash', { command: 'echo `date`' }).target, 'echo `date`');
	assert.equal(toolLabel('Bash', { command: 'echo `date`' }), 'Running `echo \'date\'`');
	assert.equal(describeTool('Read', { file_path: '/repo/a.ts' }, '/repo').past, 'Read');
	assert.equal(unwrapShell('bash -lc \'echo \'\\\'\'hi\'\\\'\'\''), 'echo \'hi\'');
	assert.equal(unwrapShell('git status'), 'git status');
	assert.deepEqual(partialToolInput('{"command": "npm run'), undefined);
	assert.deepEqual(partialToolInput('{"command": "npm run build", "timeout": 1'), { command: 'npm run build' });
});
