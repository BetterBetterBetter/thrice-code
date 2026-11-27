import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventDecoder, StreamedLineCounter, type AgentEvent } from '../src/events.ts';
import { LiveEditRecorder, MAX_RECORDED_BYTES, progressSuffix, ProgressThrottle, repoRelative, resolveLiveEdit, type LiveEdit, type LiveEditIo, type Timers } from '../src/liveEdits.ts';

/** Manual clock: timers fire only on `advance`. */
function fakeTimers() {
	let now = 0;
	let next = 1;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const timers: Timers & { advance(ms: number): void; pending(): number } = {
		now: () => now,
		setTimeout: (callback, ms) => {
			const id = next++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: handle => { pending.delete(handle as number); },
		advance(ms) {
			const target = now + ms;
			for (; ;) {
				const due = [...pending].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				pending.delete(due[0]);
				now = due[1].at;
				due[1].callback();
			}
			now = target;
		},
		pending: () => pending.size,
	};
	return timers;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function memoryIo(start: Record<string, string>, disk: Record<string, string | Buffer>): LiveEditIo {
	return {
		root: '/repo',
		readStart: async rel => start[rel],
		readCurrent: async file => {
			const value = disk[file];
			return value === undefined ? undefined : Buffer.isBuffer(value) ? value : Buffer.from(value);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// before/after resolution
// ---------------------------------------------------------------------------------------------

test('repoRelative: inside, outside, root itself', () => {
	assert.equal(repoRelative('/repo', '/repo/src/a.ts'), 'src/a.ts');
	assert.equal(repoRelative('/repo', '/other/a.ts'), undefined);
	assert.equal(repoRelative('/repo', '/repo'), undefined);
	assert.equal(repoRelative('/repo', '/repository/a.ts'), undefined);
});

test('resolveLiveEdit: modified file uses the turn-start content as before', async () => {
	const io = memoryIo({ 'a.ts': 'old\n' }, { '/repo/a.ts': 'new\n' });
	assert.deepEqual(await resolveLiveEdit(io, '/repo/a.ts', 'update', false), {
		kind: 'edit', edit: { filePath: '/repo/a.ts', before: 'old\n', after: 'new\n' }, createdThisTurn: false,
	});
});

test('resolveLiveEdit: new file has before null; unknown baseline without add is skipped', async () => {
	const io = memoryIo({}, { '/repo/new.ts': 'x' });
	assert.deepEqual(await resolveLiveEdit(io, '/repo/new.ts', 'add', false), {
		kind: 'edit', edit: { filePath: '/repo/new.ts', before: null, after: 'x' }, createdThisTurn: true,
	});
	// A later Edit of the file created this turn keeps the absent baseline.
	assert.equal((await resolveLiveEdit(io, '/repo/new.ts', 'update', true)).kind, 'edit');
	// Not in the snapshot and not reported as created (e.g. gitignored): baseline unknown.
	assert.deepEqual(await resolveLiveEdit(io, '/repo/new.ts', 'update', false), { kind: 'skip', reason: 'unknownBaseline' });
});

test('resolveLiveEdit: deleted file has after null; created-then-deleted is skipped', async () => {
	const io = memoryIo({ 'gone.ts': 'bye' }, {});
	assert.deepEqual(await resolveLiveEdit(io, '/repo/gone.ts', 'delete', false), {
		kind: 'edit', edit: { filePath: '/repo/gone.ts', before: 'bye', after: null }, createdThisTurn: false,
	});
	assert.deepEqual(await resolveLiveEdit(io, '/repo/tmp.ts', 'add', false), { kind: 'skip', reason: 'absent' });
});

test('resolveLiveEdit: too large, binary and outside the repository are skipped', async () => {
	const big = 'x'.repeat(MAX_RECORDED_BYTES + 1);
	assert.deepEqual(await resolveLiveEdit(memoryIo({ 'big.txt': 'small' }, { '/repo/big.txt': big }), '/repo/big.txt', 'update', false), { kind: 'skip', reason: 'tooLarge' });
	assert.deepEqual(await resolveLiveEdit(memoryIo({ 'big.txt': big }, { '/repo/big.txt': 'small' }), '/repo/big.txt', 'update', false), { kind: 'skip', reason: 'tooLarge' });
	assert.deepEqual(await resolveLiveEdit(memoryIo({}, { '/repo/a.png': Buffer.from([0x89, 0x50, 0, 1]) }), '/repo/a.png', 'add', false), { kind: 'skip', reason: 'binary' });
	assert.deepEqual(await resolveLiveEdit(memoryIo({}, { '/elsewhere/a.ts': 'x' }), '/elsewhere/a.ts', 'add', false), { kind: 'skip', reason: 'outside' });
});

test('resolveLiveEdit: a symlinked path is placed in the repository through realpath', async () => {
	const io: LiveEditIo = { ...memoryIo({ 'a.ts': 'old' }, { '/link/a.ts': 'new' }), realpath: async file => file.replace(/^\/link/, '/repo') };
	assert.deepEqual(await resolveLiveEdit(io, '/link/a.ts', 'update', false), {
		kind: 'edit', edit: { filePath: '/repo/a.ts', before: 'old', after: 'new' }, createdThisTurn: false,
	});
});

// ---------------------------------------------------------------------------------------------
// coalescing and serialization
// ---------------------------------------------------------------------------------------------

test('recorder: debounces per file and batches files that become due together', async () => {
	const timers = fakeTimers();
	const disk: Record<string, string> = { '/repo/a.ts': 'a1', '/repo/b.ts': 'b1' };
	const sent: LiveEdit[][] = [];
	const recorder = new LiveEditRecorder({ io: memoryIo({ 'a.ts': 'a0', 'b.ts': 'b0' }, disk), send: async edits => { sent.push([...edits]); }, delayMs: 200, timers });
	recorder.schedule('/repo/a.ts', 'update');
	timers.advance(100);
	disk['/repo/a.ts'] = 'a2';
	recorder.schedule('/repo/a.ts', 'update'); // restarts a.ts's quiet period
	recorder.schedule('/repo/b.ts', 'update');
	timers.advance(199);
	await tick();
	assert.equal(sent.length, 0);
	timers.advance(1);
	await recorder.flush();
	assert.deepEqual(sent, [[
		{ filePath: '/repo/a.ts', before: 'a0', after: 'a2' },
		{ filePath: '/repo/b.ts', before: 'b0', after: 'b1' },
	]]);
	assert.deepEqual(recorder.recordedPaths().sort(), ['/repo/a.ts', '/repo/b.ts']);
});

test('recorder: one send at a time; files due meanwhile go out in the next call with fresh content', async () => {
	const timers = fakeTimers();
	const disk: Record<string, string> = { '/repo/a.ts': 'a1', '/repo/b.ts': 'b1' };
	const sent: LiveEdit[][] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let release!: () => void;
	const recorder = new LiveEditRecorder({
		io: memoryIo({ 'a.ts': 'a0', 'b.ts': 'b0' }, disk),
		send: async edits => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			sent.push([...edits]);
			if (sent.length === 1) {
				await new Promise<void>(resolve => { release = resolve; });
			}
			inFlight--;
		},
		delayMs: 50,
		timers,
	});
	recorder.schedule('/repo/a.ts', 'update');
	timers.advance(50);
	await tick();
	assert.equal(sent.length, 1);
	disk['/repo/a.ts'] = 'a2';
	recorder.schedule('/repo/a.ts', 'update');
	recorder.schedule('/repo/b.ts', 'update');
	timers.advance(50);
	await tick();
	assert.equal(sent.length, 1, 'second call waits for the first');
	release();
	await recorder.flush();
	assert.equal(maxInFlight, 1);
	assert.deepEqual(sent, [
		[{ filePath: '/repo/a.ts', before: 'a0', after: 'a1' }],
		[{ filePath: '/repo/a.ts', before: 'a0', after: 'a2' }, { filePath: '/repo/b.ts', before: 'b0', after: 'b1' }],
	]);
});

test('recorder: a file created this turn keeps before null on later edits', async () => {
	const timers = fakeTimers();
	const disk: Record<string, string> = { '/repo/n.ts': 'v1' };
	const sent: LiveEdit[][] = [];
	const recorder = new LiveEditRecorder({ io: memoryIo({}, disk), send: async edits => { sent.push([...edits]); }, delayMs: 10, timers });
	recorder.schedule('/repo/n.ts', 'add');
	timers.advance(10);
	await recorder.flush();
	disk['/repo/n.ts'] = 'v2';
	recorder.schedule('/repo/n.ts', 'update');
	timers.advance(10);
	await recorder.flush();
	assert.deepEqual(sent, [[{ filePath: '/repo/n.ts', before: null, after: 'v1' }], [{ filePath: '/repo/n.ts', before: null, after: 'v2' }]]);
});

test('recorder: add coalesced with a later update is still treated as new', async () => {
	const timers = fakeTimers();
	const sent: LiveEdit[][] = [];
	const recorder = new LiveEditRecorder({ io: memoryIo({}, { '/repo/n.ts': 'v2' }), send: async edits => { sent.push([...edits]); }, delayMs: 10, timers });
	recorder.schedule('/repo/n.ts', 'add');
	recorder.schedule('/repo/n.ts', 'update');
	timers.advance(10);
	await recorder.flush();
	assert.deepEqual(sent, [[{ filePath: '/repo/n.ts', before: null, after: 'v2' }]]);
});

test('recorder: close drops files not yet due, waits for the call in flight, ignores later schedules', async () => {
	const timers = fakeTimers();
	const sent: LiveEdit[][] = [];
	let release!: () => void;
	let finished = false;
	const recorder = new LiveEditRecorder({
		io: memoryIo({ 'a.ts': 'a0', 'b.ts': 'b0' }, { '/repo/a.ts': 'a1', '/repo/b.ts': 'b1' }),
		send: async edits => {
			sent.push([...edits]);
			await new Promise<void>(resolve => { release = resolve; });
			finished = true;
		},
		delayMs: 10,
		timers,
	});
	recorder.schedule('/repo/a.ts', 'update');
	timers.advance(10);
	await tick();
	recorder.schedule('/repo/b.ts', 'update');
	const closing = recorder.close();
	await tick();
	assert.equal(finished, false);
	release();
	await closing;
	assert.equal(finished, true);
	recorder.schedule('/repo/b.ts', 'update');
	timers.advance(100);
	await tick();
	assert.equal(timers.pending(), 0);
	assert.deepEqual(sent, [[{ filePath: '/repo/a.ts', before: 'a0', after: 'a1' }]]);
});

test('recorder: a failed send or read is logged and does not stop later recordings', async () => {
	const timers = fakeTimers();
	const logged: string[] = [];
	const sent: LiveEdit[][] = [];
	let fail = true;
	const io: LiveEditIo = {
		root: '/repo',
		readStart: async rel => rel === 'bad.ts' ? Promise.reject(new Error('git')) : 'old',
		readCurrent: async () => Buffer.from('new'),
	};
	const recorder = new LiveEditRecorder({
		io,
		send: async edits => { if (fail) { fail = false; throw new Error('no command'); } sent.push([...edits]); },
		delayMs: 10,
		timers,
		log: message => logged.push(message),
	});
	recorder.schedule('/repo/a.ts', 'update');
	recorder.schedule('/repo/bad.ts', 'update');
	timers.advance(10);
	await recorder.flush();
	recorder.schedule('/repo/a.ts', 'update');
	timers.advance(10);
	await recorder.flush();
	assert.equal(logged.length, 2);
	assert.deepEqual(sent, [[{ filePath: '/repo/a.ts', before: 'old', after: 'new' }]]);
	// Only successful sends count as recorded.
	assert.deepEqual(recorder.recordedPaths(), ['/repo/a.ts']);
});

// ---------------------------------------------------------------------------------------------
// progress labels
// ---------------------------------------------------------------------------------------------

test('progressSuffix', () => {
	assert.equal(progressSuffix(0), '');
	assert.equal(progressSuffix(1), ' · 1 line…');
	assert.equal(progressSuffix(140), ' · 140 lines…');
});

test('ProgressThrottle: first count at once, then at most one push per interval with the latest count', () => {
	const timers = fakeTimers();
	const pushed: number[] = [];
	const throttle = new ProgressThrottle(lines => pushed.push(lines), 250, timers);
	throttle.update(1);
	assert.deepEqual(pushed, [1]);
	throttle.update(1); // unchanged: never pushed again
	timers.advance(100);
	throttle.update(2);
	throttle.update(3);
	assert.deepEqual(pushed, [1]);
	timers.advance(149);
	assert.deepEqual(pushed, [1]);
	timers.advance(1);
	assert.deepEqual(pushed, [1, 3]);
	assert.equal(throttle.current(), 3);
	timers.advance(1000);
	throttle.update(3);
	assert.deepEqual(pushed, [1, 3]);
	throttle.update(9);
	assert.deepEqual(pushed, [1, 3, 9]);
	// Ten updates within a second: at most 4 more pushes.
	for (let i = 0; i < 10; i++) {
		timers.advance(100);
		throttle.update(10 + i);
	}
	timers.advance(1000);
	assert.ok(pushed.length - 3 <= 5, `pushed ${pushed.length - 3}`);
	assert.equal(pushed.at(-1), 19);
});

test('ProgressThrottle: a pending count is dropped on stop, and an unchanged pending count is not pushed', () => {
	const timers = fakeTimers();
	const pushed: number[] = [];
	const throttle = new ProgressThrottle(lines => pushed.push(lines), 250, timers);
	throttle.update(5);
	throttle.update(6);
	throttle.update(5); // back to what is shown
	timers.advance(250);
	assert.deepEqual(pushed, [5]);
	throttle.update(7);
	throttle.update(8);
	throttle.stop();
	timers.advance(1000);
	throttle.update(9);
	assert.deepEqual(pushed, [5, 7]);
});

test('StreamedLineCounter: counts content lines across chunks, ignoring other keys and escapes', () => {
	const json = JSON.stringify({ file_path: '/repo/a.ts', content: 'one\ntwo\n"three" \\n\nfour' });
	const counter = new StreamedLineCounter();
	let lines = 0;
	for (let i = 0; i < json.length; i += 3) {
		lines = counter.push(json.slice(i, i + 3));
	}
	assert.equal(lines, 4);
	const partial = new StreamedLineCounter();
	assert.equal(partial.push('{"file_path":"/a\\nb","content":"'), 0);
	assert.equal(partial.push('x'), 1);
	assert.equal(partial.push('\\'), 1);
	assert.equal(partial.push('ny\\n'), 2);
	assert.equal(partial.push('z'), 3);
});

test('StreamedLineCounter: sums MultiEdit new_string values, skips old_string', () => {
	const json = JSON.stringify({ file_path: 'a', edits: [{ old_string: 'a\nb\nc', new_string: 'x\ny' }, { old_string: 'q', new_string: 'z\n' }] });
	assert.equal(new StreamedLineCounter().push(json), 3);
	assert.equal(new StreamedLineCounter().push(JSON.stringify({ content: '' })), 0);
});

test('claude decoder: streaming Write content emits toolUpdate with streamedLines when the count changes', () => {
	const decoder = createEventDecoder('claude', { cwd: '/repo' });
	const stream = (event: unknown) => JSON.stringify({ type: 'stream_event', event, session_id: 's1', parent_tool_use_id: null, uuid: 'u' });
	const events: AgentEvent[] = [];
	const push = (event: unknown) => events.push(...decoder.push(stream(event)));
	push({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } });
	push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } });
	push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/a.ts","content":"line1' } });
	push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'more' } });
	push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '\\nline2\\nline3' } });
	const counts = events.filter((event): event is Extract<AgentEvent, { kind: 'toolUpdate' }> => event.kind === 'toolUpdate' && event.streamedLines !== undefined).map(event => event.streamedLines);
	assert.deepEqual(counts, [1, 3]);
});
