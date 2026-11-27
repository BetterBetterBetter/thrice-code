/*---------------------------------------------------------------------------------------------
 *  Live recording of a CLI agent's file edits into the chat editing session, file by file as
 *  each edit finishes (partial `_thrice.chat.recordTurnEdits` calls), plus the progress-label
 *  helpers for Write/Edit calls whose content is still streaming.
 *
 *  No `vscode` import: the extension supplies the I/O (`LiveEditIo`) and the command call
 *  (`send`), so the logic here runs under `node --test`.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/** Files larger than this are not recorded into chat edits (same limit as the end-of-turn pass). */
export const MAX_RECORDED_BYTES = 2 * 1024 * 1024;

/** One recorded file. `filePath` is absolute (`<repo root>/<relPath>`); null content = absent. */
export interface LiveEdit {
	readonly filePath: string;
	readonly before: string | null;
	readonly after: string | null;
}

export interface LiveEditIo {
	/** Repository root, as `repoRoot` reports it (the end-of-turn pass builds URIs from it too). */
	readonly root: string;
	/** Content at turn start (start snapshot), or undefined when the file was not in it. */
	readStart(relPath: string): Promise<string | undefined>;
	/** Current content on disk, or undefined when the file does not exist. */
	readCurrent(absPath: string): Promise<Buffer | undefined>;
	/** Resolves symlinks so a path under a linked cwd can still be placed in the repository. */
	realpath?(absPath: string): Promise<string | undefined>;
}

export type ChangeKind = 'add' | 'update' | 'delete';

/** Repo-relative path with `/` separators, or undefined when `absPath` is outside `root`. */
export function repoRelative(root: string, absPath: string): string | undefined {
	const rel = path.relative(root, absPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel.split(path.sep).join('/');
}

function looksBinary(text: string): boolean {
	return text.slice(0, 8000).includes('\u0000');
}

export type Resolution =
	| { readonly kind: 'edit'; readonly edit: LiveEdit; readonly createdThisTurn: boolean }
	| { readonly kind: 'skip'; readonly reason: 'outside' | 'unknownBaseline' | 'binary' | 'tooLarge' | 'absent' };

/**
 * Before/after for one file. Before is the turn-start content from the snapshot; a file missing
 * from it counts as created this turn only when the agent said so (`add`) or an earlier recording
 * this turn already treated it as new. Otherwise (e.g. a gitignored file the snapshot skips) the
 * baseline is unknown and the file is left to the end-of-turn pass.
 */
export async function resolveLiveEdit(io: LiveEditIo, absPath: string, change: ChangeKind, knownNew: boolean): Promise<Resolution> {
	let rel = repoRelative(io.root, absPath);
	if (!rel && io.realpath) {
		const real = await io.realpath(absPath) ?? await io.realpath(path.dirname(absPath)).then(dir => dir && path.join(dir, path.basename(absPath)));
		rel = real ? repoRelative(io.root, real) : undefined;
	}
	if (!rel) {
		return { kind: 'skip', reason: 'outside' };
	}
	const start = await io.readStart(rel);
	let before: string | null;
	let createdThisTurn = false;
	if (start !== undefined) {
		before = start;
	} else if (knownNew || change === 'add') {
		before = null;
		createdThisTurn = true;
	} else {
		return { kind: 'skip', reason: 'unknownBaseline' };
	}
	const current = await io.readCurrent(absPath);
	if ((before?.length ?? 0) > MAX_RECORDED_BYTES || (current?.length ?? 0) > MAX_RECORDED_BYTES) {
		return { kind: 'skip', reason: 'tooLarge' };
	}
	if (current && current.subarray(0, 8000).includes(0)) {
		return { kind: 'skip', reason: 'binary' };
	}
	if (before !== null && looksBinary(before)) {
		return { kind: 'skip', reason: 'binary' };
	}
	const after = current === undefined ? null : current.toString('utf8');
	if (before === null && after === null) {
		return { kind: 'skip', reason: 'absent' };
	}
	return { kind: 'edit', edit: { filePath: `${io.root}/${rel}`, before, after }, createdThisTurn };
}

export interface Timers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

export const realTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

export interface LiveEditRecorderOptions {
	readonly io: LiveEditIo;
	/** Records a batch (one partial `recordTurnEdits` call). */
	readonly send: (edits: readonly LiveEdit[]) => Promise<void>;
	/** Quiet time per file before it is recorded, so a burst of edits to one file is one call. */
	readonly delayMs?: number;
	readonly timers?: Timers;
	readonly log?: (message: string, error?: unknown) => void;
}

/**
 * Debounces edits per file and records them in order: at most one `send` runs at a time, and
 * files that become due while one runs go out together in the next call. Each send re-reads the
 * file, so a later call always carries the newest content.
 */
export class LiveEditRecorder {
	private readonly delayMs: number;
	private readonly timers: Timers;
	private readonly debounce = new Map<string, unknown>();
	/** Due files and the strongest change reported for each since its last recording. */
	private readonly ready = new Map<string, ChangeKind>();
	private readonly pendingKind = new Map<string, ChangeKind>();
	/** Files recorded as created this turn: their baseline stays "absent" for later edits. */
	private readonly createdThisTurn = new Set<string>();
	private readonly recorded = new Set<string>();
	private chain: Promise<void> = Promise.resolve();
	private draining = false;
	private closed = false;
	private readonly options: LiveEditRecorderOptions;

	constructor(options: LiveEditRecorderOptions) {
		this.options = options;
		this.delayMs = options.delayMs ?? 200;
		this.timers = options.timers ?? realTimers;
	}

	/** Repo-absolute paths (`<root>/<rel>`) recorded so far this turn. */
	recordedPaths(): string[] {
		return [...this.recorded];
	}

	/** An edit to `absPath` finished; record it once the file has been quiet for `delayMs`. */
	schedule(absPath: string, change: ChangeKind): void {
		if (this.closed) {
			return;
		}
		// 'add' must not be forgotten when a later 'update' to the same file is coalesced into it.
		const previous = this.pendingKind.get(absPath);
		this.pendingKind.set(absPath, previous === 'add' ? 'add' : change);
		const existing = this.debounce.get(absPath);
		if (existing !== undefined) {
			this.timers.clearTimeout(existing);
		}
		this.debounce.set(absPath, this.timers.setTimeout(() => this.due(absPath), this.delayMs));
	}

	/** Stops scheduling, drops files not yet due and waits for the call in flight. */
	async close(): Promise<void> {
		this.closed = true;
		for (const handle of this.debounce.values()) {
			this.timers.clearTimeout(handle);
		}
		this.debounce.clear();
		this.pendingKind.clear();
		this.ready.clear();
		await this.settled();
	}

	/** Records everything pending now (timers skipped) and waits until it is sent. */
	async flush(): Promise<void> {
		for (const [file, handle] of this.debounce) {
			this.timers.clearTimeout(handle);
			this.markReady(file);
		}
		this.debounce.clear();
		this.kick();
		await this.settled();
	}

	/** Waits until no call is in flight, including drains started while waiting. */
	private async settled(): Promise<void> {
		let chain: Promise<void>;
		do {
			chain = this.chain;
			await chain;
		} while (chain !== this.chain || this.draining);
	}

	private due(absPath: string): void {
		this.debounce.delete(absPath);
		if (this.closed) {
			return;
		}
		this.markReady(absPath);
		this.kick();
	}

	private markReady(absPath: string): void {
		const kind = this.pendingKind.get(absPath) ?? 'update';
		this.pendingKind.delete(absPath);
		const previous = this.ready.get(absPath);
		this.ready.set(absPath, previous === 'add' ? 'add' : kind);
	}

	private kick(): void {
		if (this.draining || this.ready.size === 0) {
			return;
		}
		this.draining = true;
		this.chain = this.chain.then(() => this.drain()).finally(() => {
			this.draining = false;
			// Anything that became due between the last loop check and here.
			this.kick();
		});
	}

	private async drain(): Promise<void> {
		while (this.ready.size > 0 && !this.closed) {
			const batch = [...this.ready];
			this.ready.clear();
			const edits: LiveEdit[] = [];
			for (const [file, change] of batch) {
				try {
					const result = await resolveLiveEdit(this.options.io, file, change, this.createdThisTurn.has(file));
					if (result.kind === 'edit') {
						if (result.createdThisTurn) {
							this.createdThisTurn.add(file);
						}
						edits.push(result.edit);
					}
				} catch (error) {
					this.options.log?.(`live edit: could not read ${file}`, error);
				}
			}
			if (edits.length === 0) {
				continue;
			}
			try {
				await this.options.send(edits);
				for (const edit of edits) {
					this.recorded.add(edit.filePath);
				}
			} catch (error) {
				this.options.log?.('live edit: recording failed', error);
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Progress labels for streaming Write/Edit calls
// ---------------------------------------------------------------------------------------------

/** Suffix appended to the in-progress message, e.g. ` · 140 lines…`. */
export function progressSuffix(lines: number): string {
	return lines > 0 ? ` · ${lines} ${lines === 1 ? 'line' : 'lines'}…` : '';
}

/**
 * Rate-limits progress pushes for one tool call: a new line count is shown at once if the last
 * push was at least `intervalMs` ago, otherwise once that interval has passed (latest count wins),
 * and an unchanged count is never pushed again.
 */
export class ProgressThrottle {
	private shown: number | undefined;
	private latest: number | undefined;
	private lastPush = -Infinity;
	private timer: unknown;
	private stopped = false;
	private readonly push: (lines: number) => void;
	private readonly intervalMs: number;
	private readonly timers: Timers;

	constructor(push: (lines: number) => void, intervalMs = 250, timers: Timers = realTimers) {
		this.push = push;
		this.intervalMs = intervalMs;
		this.timers = timers;
	}

	update(lines: number): void {
		if (this.stopped) {
			return;
		}
		this.latest = lines;
		if (lines === this.shown || this.timer !== undefined) {
			return;
		}
		const wait = this.lastPush + this.intervalMs - this.timers.now();
		if (wait <= 0) {
			this.emit();
			return;
		}
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			this.emit();
		}, wait);
	}

	/** The count most recently pushed, if any. */
	current(): number | undefined {
		return this.shown;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			this.timers.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private emit(): void {
		if (this.stopped || this.latest === undefined || this.latest === this.shown) {
			return;
		}
		this.shown = this.latest;
		this.lastPush = this.timers.now();
		this.push(this.latest);
	}
}
