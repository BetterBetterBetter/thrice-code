/**
 * Maps each chat to one long-lived agent CLI process and resumes the CLI session by id when the
 * process is gone. Free of `vscode`: the extension injects the session factories, the persistence
 * store (backed by `ExtensionContext.workspaceState`) and the editor tool bridge.
 */
import type { EditorToolLaunch } from "../editorToolPolicy";
import type { Driver } from "../instances";
import type { ChildRunSink } from "../agents";
import type {
	AgentSession,
	CancellationTokenLike,
	Disposable,
	SessionFactory,
	SessionLaunch,
	SessionLog,
	TurnHandlers,
} from "./types";

/** What is persisted per chat so a later process can resume the CLI session. */
export interface StoredSession {
	readonly driver: Driver;
	readonly instanceId: string;
	readonly cliSessionId: string;
	readonly cwd: string;
	readonly model?: string;
	/** Milliseconds since the epoch (from the manager's `now`). */
	readonly updatedAt: number;
}

/** Persistence for `StoredSession`s, keyed by chat. The extension backs it with `workspaceState`. */
export interface SessionStore {
	get(chatKey: string): StoredSession | undefined;
	set(chatKey: string, value: StoredSession): PromiseLike<void> | void;
	delete(chatKey: string): PromiseLike<void> | void;
}

/** In-memory `SessionStore` (tests, or when no workspace state is available). */
export class MemorySessionStore implements SessionStore {
	private readonly values = new Map<string, StoredSession>();

	get(chatKey: string): StoredSession | undefined {
		return this.values.get(chatKey);
	}

	set(chatKey: string, value: StoredSession): void {
		this.values.set(chatKey, value);
	}

	delete(chatKey: string): void {
		this.values.delete(chatKey);
	}

	keys(): string[] {
		return [...this.values.keys()];
	}
}

/**
 * Editor tool launch whose guard prompt can change between turns. With a long-lived process the
 * user prompt differs every turn, so the bridge must rewrite the prompt the Bash guard reads.
 */
/** Turn handlers plus the chat that shows runs this agent starts through the thrice tools. */
export interface ManagedTurnHandlers extends TurnHandlers {
	readonly children?: ChildRunSink;
}

export interface UpdatableEditorToolLaunch extends EditorToolLaunch {
	/** Called before every turn with the exact text sent and the chat that shows child runs. */
	updateTurn?(text: string, children?: ChildRunSink): void;
	/** Called after every turn (done, failed or cancelled): stop child agents and close agent-opened terminals. */
	endTurn?(): void;
}

/** What the prompt provider is told about the process the prompt goes to. */
export interface PromptContext {
	/**
	 * True when the process holds no earlier conversation (new chat, different driver/instance/cwd,
	 * or a resume that failed). The caller must then include the chat history in the prompt.
	 * False when the CLI session already has the history (live process, or a successful resume).
	 */
	readonly fresh: boolean;
	/** True when this turn starts a process that resumes a stored CLI session id. */
	readonly resumed: boolean;
}

/**
 * Builds the text sent for a turn. It may be called twice in one turn: once with `fresh: false`
 * for a resumed start, then with `fresh: true` if the resume fails and the manager retries fresh.
 */
export type PromptProvider = (context: PromptContext) => string;

/** Launch options the caller supplies; the manager adds `resumeId` and `editorTools`. */
export type TurnLaunch = Omit<SessionLaunch, "resumeId" | "editorTools">;

export interface TurnResult {
	/** CLI session id after the turn, when known. */
	readonly sessionId: string | undefined;
	/** The turn started a process that resumed a stored session id, and the resume held. */
	readonly resumed: boolean;
	/** The turn ran in a process with no earlier conversation (the prompt was built with `fresh: true`). */
	readonly fresh: boolean;
}

export interface SessionManagerOptions {
	/** Drivers without a factory are not supported (`supports` is false). */
	readonly factories: Partial<Record<Driver, SessionFactory>>;
	readonly store: SessionStore;
	/** Called once per process start; the session disposes the returned launch when it exits. */
	readonly prepareTools?: (
		launch: TurnLaunch,
	) => UpdatableEditorToolLaunch | undefined;
	/** Idle time after a turn before the process is stopped (default 10 minutes). */
	readonly idleTimeoutMs?: number;
	/** Most live processes at once (default 6); the least recently used idle one is stopped first. */
	readonly maxLive?: number;
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	readonly log?: SessionLog;
}

interface LiveEntry {
	readonly session: AgentSession;
	readonly key: string;
	readonly driver: Driver;
	readonly instanceId: string;
	readonly cwd: string;
	readonly tools: UpdatableEditorToolLaunch | undefined;
	exitListener: Disposable;
	/** The process was started with a resume id and has not completed a turn yet. */
	unconfirmedResume: boolean;
	/** The process was started without earlier conversation and has not completed a turn yet. */
	fresh: boolean;
	busy: boolean;
	lastUsed: number;
	timer: unknown;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LIVE = 6;

/** Identity of the process configuration: a change restarts the process. */
export function launchKey(launch: TurnLaunch): string {
	const { instance } = launch;
	return JSON.stringify([
		instance.id,
		instance.driver,
		instance.command,
		instance.launchArgs,
		instance.environment.map((entry) => [entry.name, entry.value]),
		launch.model,
		launch.mode ?? null,
		launch.cwd,
		launch.extraDirectories,
	]);
}

/**
 * One long-lived CLI process per chat, resumed by CLI session id.
 *
 * Turns for the same chat are serialized: a call while a turn is running waits for it to finish
 * (the chat UI normally prevents overlap; queueing keeps a racing request from failing). A queued
 * turn whose token is cancelled before it starts returns without sending anything.
 */
export class SessionManager implements Disposable {
	private readonly live = new Map<string, LiveEntry>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly idleMs: number;
	private readonly maxLive: number;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly options: SessionManagerOptions;
	private disposed = false;

	constructor(options: SessionManagerOptions) {
		this.options = options;
		this.idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
		this.maxLive = Math.max(1, options.maxLive ?? DEFAULT_MAX_LIVE);
		this.now = options.now ?? Date.now;
		this.setTimer =
			options.setTimer ??
			((callback, ms) => {
				const handle = setTimeout(callback, ms);
				handle.unref?.();
				return handle;
			});
		this.clearTimer =
			options.clearTimer ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	/** True when a session factory exists for the driver; otherwise use the one-shot path. */
	supports(driver: Driver): boolean {
		return typeof this.options.factories[driver] === "function";
	}

	/** Stored CLI session id for the chat, if any (live or not). */
	sessionIdFor(chatKey: string): string | undefined {
		return (
			this.live.get(chatKey)?.session.sessionId ??
			this.options.store.get(chatKey)?.cliSessionId
		);
	}

	/** True when the chat has a running process. */
	isLive(chatKey: string): boolean {
		return this.live.has(chatKey);
	}

	/**
	 * Runs one turn for the chat in its long-lived process, starting or resuming one as needed.
	 * `prompt` is a string (always sent as is) or a provider told whether the process is fresh,
	 * i.e. whether the caller must include the chat history. Rejects with the CLI's error.
	 */
	runTurn(
		chatKey: string,
		launch: TurnLaunch,
		prompt: string | PromptProvider,
		handlers: ManagedTurnHandlers,
		token: CancellationTokenLike,
	): Promise<TurnResult> {
		if (!chatKey) {
			// Every caller with an empty key would share one process and queue behind each other.
			return Promise.reject(new Error("A session needs a non-empty chat key."));
		}
		if (this.disposed) {
			return Promise.reject(new Error("Session manager is disposed."));
		}
		if (!this.supports(launch.instance.driver)) {
			return Promise.reject(
				new Error(
					`No long-lived session support for ${launch.instance.driver}.`,
				),
			);
		}
		const previous = this.queues.get(chatKey) ?? Promise.resolve();
		const run = previous.then(() =>
			this.turn(chatKey, launch, prompt, handlers, token),
		);
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(chatKey, settled);
		void settled.then(() => {
			if (this.queues.get(chatKey) === settled) {
				this.queues.delete(chatKey);
			}
		});
		return run;
	}

	/**
	 * Steers the chat's running turn with another user message (see `AgentSession.steer`).
	 * Resolves `false` when the chat has no running turn or its CLI cannot take steering.
	 */
	async steer(chatKey: string, prompt: string): Promise<boolean> {
		const session = this.live.get(chatKey)?.session;
		if (!session?.steer || session.state !== "busy") {
			return false;
		}
		try {
			return await session.steer(prompt);
		} catch (error) {
			this.log(
				"warn",
				`steering ${chatKey} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/** Stops the chat's process but keeps the stored id (e.g. before a terminal takes over the session). */
	release(chatKey: string): void {
		this.stop(chatKey, "released");
	}

	/** Stops the chat's process and deletes its stored id. */
	forget(chatKey: string): void {
		this.stop(chatKey, "forgotten");
		void this.persist(() => this.options.store.delete(chatKey));
	}

	/** Stops every live process. Stored ids are kept. */
	dispose(): void {
		this.disposed = true;
		for (const chatKey of [...this.live.keys()]) {
			this.stop(chatKey, "disposed");
		}
	}

	private async turn(
		chatKey: string,
		launch: TurnLaunch,
		prompt: string | PromptProvider,
		handlers: ManagedTurnHandlers,
		token: CancellationTokenLike,
	): Promise<TurnResult> {
		if (this.disposed) {
			throw new Error("Session manager is disposed.");
		}
		if (token.isCancellationRequested) {
			return {
				sessionId: this.sessionIdFor(chatKey),
				resumed: false,
				fresh: false,
			};
		}
		const key = launchKey(launch);
		const { driver, id: instanceId } = launch.instance;
		let entry = this.live.get(chatKey);
		let resumeId: string | undefined;
		if (entry && entry.key !== key) {
			// Model, mode or folders changed: restart, continuing the same CLI session when the driver allows.
			// CLI sessions are stored per working directory, so a new cwd cannot resume either.
			const sameInstance =
				entry.driver === driver && entry.instanceId === instanceId;
			const carried =
				sameInstance && entry.cwd === launch.cwd
					? (entry.session.sessionId ??
						this.options.store.get(chatKey)?.cliSessionId)
					: undefined;
			this.log("info", `restarting session for ${chatKey}: launch changed`);
			this.stop(chatKey, "launch changed");
			entry = undefined;
			resumeId = carried;
			if (!sameInstance) {
				await this.persist(() => this.options.store.delete(chatKey));
			}
		} else if (!entry) {
			const stored = this.options.store.get(chatKey);
			if (
				stored &&
				stored.driver === driver &&
				stored.instanceId === instanceId &&
				stored.cwd === launch.cwd
			) {
				resumeId = stored.cliSessionId;
			} else if (
				stored &&
				(stored.driver !== driver || stored.instanceId !== instanceId)
			) {
				await this.persist(() => this.options.store.delete(chatKey));
			}
		}

		if (!entry) {
			try {
				entry = this.start(chatKey, launch, key, resumeId);
			} catch (error) {
				if (resumeId === undefined) {
					throw error;
				}
				this.log(
					"warn",
					`resume of ${resumeId} failed to start (${errorText(error)}); starting fresh`,
				);
				entry = this.start(chatKey, launch, key, undefined);
			}
		}

		const first = await this.send(entry, prompt, handlers, token);
		if (first.ok) {
			return this.finish(chatKey, entry, launch, first.fresh, first.resumed);
		}
		const retry =
			entry.unconfirmedResume &&
			!first.forwarded &&
			!token.isCancellationRequested;
		if (!retry) {
			await this.finishFailed(chatKey, entry, launch, first.forwarded);
			throw first.error;
		}
		this.log(
			"warn",
			`resume of ${resumeId ?? "session"} failed (${errorText(first.error)}); retrying fresh`,
		);
		this.stop(chatKey, "resume failed");
		await this.persist(() => this.options.store.delete(chatKey));
		const freshEntry = this.start(chatKey, launch, key, undefined);
		const second = await this.send(freshEntry, prompt, handlers, token);
		if (second.ok) {
			return this.finish(chatKey, freshEntry, launch, true, false);
		}
		await this.finishFailed(chatKey, freshEntry, launch, second.forwarded);
		throw second.error;
	}

	private start(
		chatKey: string,
		launch: TurnLaunch,
		key: string,
		resumeId: string | undefined,
	): LiveEntry {
		const factory = this.options.factories[launch.instance.driver];
		if (!factory) {
			throw new Error(
				`No long-lived session support for ${launch.instance.driver}.`,
			);
		}
		const tools = this.options.prepareTools?.(launch);
		let session: AgentSession;
		try {
			session = factory({
				...launch,
				resumeId,
				editorTools: tools,
				log: launch.log ?? this.options.log,
			});
		} catch (error) {
			tools?.dispose();
			throw error;
		}
		const entry: LiveEntry = {
			session,
			key,
			driver: launch.instance.driver,
			instanceId: launch.instance.id,
			cwd: launch.cwd,
			tools,
			exitListener: { dispose() {} },
			unconfirmedResume: resumeId !== undefined,
			fresh: resumeId === undefined,
			busy: false,
			lastUsed: this.now(),
			timer: undefined,
		};
		entry.exitListener = session.onDidExit((info) => {
			if (this.live.get(chatKey) === entry) {
				this.clearIdle(entry);
				this.live.delete(chatKey);
				entry.exitListener.dispose();
				this.log(
					"info",
					`session for ${chatKey} exited (${info.error ?? `code ${info.code}`})`,
				);
			}
		});
		this.live.set(chatKey, entry);
		this.log(
			"info",
			`started ${launch.instance.driver} session for ${chatKey}${resumeId ? ` resuming ${resumeId}` : ""}`,
		);
		this.enforceCap(chatKey);
		return entry;
	}

	private async send(
		entry: LiveEntry,
		prompt: string | PromptProvider,
		handlers: ManagedTurnHandlers,
		token: CancellationTokenLike,
	): Promise<
		| { ok: true; fresh: boolean; resumed: boolean }
		| { ok: false; error: unknown; forwarded: boolean }
	> {
		const context: PromptContext = {
			fresh: entry.fresh,
			resumed: entry.unconfirmedResume,
		};
		let forwarded = false;
		this.clearIdle(entry);
		entry.busy = true;
		entry.lastUsed = this.now();
		try {
			const text = typeof prompt === "function" ? prompt(context) : prompt;
			entry.tools?.updateTurn?.(text, handlers.children);
			await entry.session.send(
				text,
				{
					onEvent: (event) => {
						forwarded = true;
						handlers.onEvent(event);
					},
				},
				token,
			);
			return { ok: true, fresh: context.fresh, resumed: context.resumed };
		} catch (error) {
			return { ok: false, error, forwarded };
		} finally {
			try {
				entry.tools?.endTurn?.();
			} catch (error) {
				this.log(
					"warn",
					`ending turn tools failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			entry.busy = false;
			entry.lastUsed = this.now();
		}
	}

	private async finish(
		chatKey: string,
		entry: LiveEntry,
		launch: TurnLaunch,
		fresh: boolean,
		resumed: boolean,
	): Promise<TurnResult> {
		entry.unconfirmedResume = false;
		entry.fresh = false;
		await this.afterTurn(chatKey, entry, launch);
		return { sessionId: entry.session.sessionId, resumed, fresh };
	}

	private async finishFailed(
		chatKey: string,
		entry: LiveEntry,
		launch: TurnLaunch,
		forwarded: boolean,
	): Promise<void> {
		if (forwarded) {
			// The CLI produced output, so its session holds this turn: later turns need no history.
			entry.unconfirmedResume = false;
			entry.fresh = false;
		}
		await this.afterTurn(chatKey, entry, launch);
	}

	private async afterTurn(
		chatKey: string,
		entry: LiveEntry,
		launch: TurnLaunch,
	): Promise<void> {
		const sessionId = entry.session.sessionId;
		if (sessionId) {
			const value: StoredSession = {
				driver: launch.instance.driver,
				instanceId: launch.instance.id,
				cliSessionId: sessionId,
				cwd: launch.cwd,
				model: launch.model,
				updatedAt: this.now(),
			};
			await this.persist(() => this.options.store.set(chatKey, value));
		}
		if (this.live.get(chatKey) === entry) {
			this.armIdle(chatKey, entry);
		}
	}

	private armIdle(chatKey: string, entry: LiveEntry): void {
		this.clearIdle(entry);
		entry.timer = this.setTimer(() => {
			entry.timer = undefined;
			if (this.live.get(chatKey) === entry && !entry.busy) {
				this.stop(chatKey, "idle");
			}
		}, this.idleMs);
	}

	private clearIdle(entry: LiveEntry): void {
		if (entry.timer !== undefined) {
			this.clearTimer(entry.timer);
			entry.timer = undefined;
		}
	}

	/** Stops least recently used idle processes (never `keep`) until within the cap. */
	private enforceCap(keep: string): void {
		while (this.live.size > this.maxLive) {
			let victim: [string, LiveEntry] | undefined;
			for (const item of this.live) {
				if (
					item[0] !== keep &&
					!item[1].busy &&
					(!victim || item[1].lastUsed < victim[1].lastUsed)
				) {
					victim = item;
				}
			}
			if (!victim) {
				return;
			}
			this.stop(victim[0], "live session cap");
		}
	}

	private stop(chatKey: string, reason: string): void {
		const entry = this.live.get(chatKey);
		if (!entry) {
			return;
		}
		this.live.delete(chatKey);
		this.clearIdle(entry);
		entry.exitListener.dispose();
		this.log("info", `stopping session for ${chatKey}: ${reason}`);
		try {
			entry.session.dispose();
		} catch (error) {
			this.log(
				"warn",
				`disposing session for ${chatKey} failed: ${errorText(error)}`,
			);
		}
	}

	private async persist(write: () => PromiseLike<void> | void): Promise<void> {
		try {
			await write();
		} catch (error) {
			this.log("warn", `session store write failed: ${errorText(error)}`);
		}
	}

	private log(level: "info" | "warn", message: string): void {
		this.options.log?.[level](`[sessions] ${message}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
