import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../src/events.ts";
import type { ProviderInstance } from "../src/instances.ts";
import {
	MemorySessionStore,
	SessionManager,
	type PromptContext,
	type SessionManagerOptions,
	type TurnLaunch,
	type UpdatableEditorToolLaunch,
} from "../src/sessions/manager.ts";
import type {
	AgentSession,
	CancellationTokenLike,
	SessionLaunch,
	SessionState,
	TurnHandlers,
} from "../src/sessions/types.ts";

type ExitInfo = { readonly code: number | null; readonly error?: string };
type Behavior = (
	session: FakeSession,
	prompt: string,
	handlers: TurnHandlers,
	token: CancellationTokenLike,
) => Promise<void>;

class FakeSession implements AgentSession {
	sessionId: string | undefined;
	state: SessionState = "idle";
	disposed = false;
	readonly prompts: string[] = [];
	readonly tokens: CancellationTokenLike[] = [];
	private readonly listeners = new Set<(info: ExitInfo) => void>();

	readonly launch: SessionLaunch;
	private readonly behavior: Behavior;
	private readonly newId: string;

	constructor(launch: SessionLaunch, behavior: Behavior, newId: string) {
		this.launch = launch;
		this.behavior = behavior;
		this.newId = newId;
		this.sessionId = launch.resumeId;
	}

	get driver() {
		return this.launch.instance.driver;
	}

	onDidExit(listener: (info: ExitInfo) => void) {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.listeners.delete(listener);
			},
		};
	}

	async send(
		prompt: string,
		handlers: TurnHandlers,
		token: CancellationTokenLike,
	): Promise<void> {
		if (this.state === "exited") {
			throw new Error("process exited");
		}
		this.prompts.push(prompt);
		this.tokens.push(token);
		this.state = "busy";
		try {
			await this.behavior(this, prompt, handlers, token);
			this.sessionId ??= this.newId;
		} finally {
			if (this.state === "busy") {
				this.state = "idle";
			}
		}
	}

	exit(info: ExitInfo = { code: 0 }): void {
		if (this.state === "exited") {
			return;
		}
		this.state = "exited";
		this.launch.editorTools?.dispose();
		for (const listener of [...this.listeners]) {
			listener(info);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.exit({ code: null });
	}
}

const reply: Behavior = async (_session, prompt, handlers) => {
	handlers.onEvent({ kind: "text", text: `echo ${prompt}` });
};

function instance(
	id = "claude",
	driver: ProviderInstance["driver"] = "claude",
): ProviderInstance {
	return {
		id,
		driver,
		displayName: id,
		enabled: true,
		command: driver,
		launchArgs: [],
		environment: [],
		requiredEnvironment: [],
	};
}

function launch(overrides: Partial<TurnLaunch> = {}): TurnLaunch {
	return {
		instance: instance(),
		cwd: "/repo",
		extraDirectories: [],
		model: "opus",
		mode: undefined,
		env: {},
		...overrides,
	};
}

const noToken: CancellationTokenLike = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

function tokenSource() {
	const listeners = new Set<() => void>();
	const token = {
		isCancellationRequested: false,
		onCancellationRequested(listener: () => void) {
			listeners.add(listener);
			return {
				dispose: () => {
					listeners.delete(listener);
				},
			};
		},
	};
	return {
		token,
		cancel() {
			token.isCancellationRequested = true;
			for (const listener of [...listeners]) {
				listener();
			}
		},
	};
}

function setup(
	options: Partial<SessionManagerOptions> & {
		behavior?: Behavior;
		behaviors?: Behavior[];
	} = {},
) {
	const sessions: FakeSession[] = [];
	const store = options.store ?? new MemorySessionStore();
	const timers = new Map<number, { callback: () => void; ms: number }>();
	let nextTimer = 1;
	let clock = 1000;
	let ids = 0;
	const factory = (sessionLaunch: SessionLaunch) => {
		const behavior =
			options.behaviors?.[sessions.length] ?? options.behavior ?? reply;
		const session = new FakeSession(sessionLaunch, behavior, `sid-${++ids}`);
		sessions.push(session);
		return session;
	};
	const manager = new SessionManager({
		factories: { claude: factory, codex: factory },
		store,
		now: () => clock++,
		setTimer: (callback, ms) => {
			const id = nextTimer++;
			timers.set(id, { callback, ms });
			return id;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
		...options,
	});
	const fireTimers = () => {
		for (const [id, timer] of [...timers]) {
			timers.delete(id);
			timer.callback();
		}
	};
	return { manager, sessions, store, timers, fireTimers };
}

function collect() {
	const events: AgentEvent[] = [];
	return {
		events,
		handlers: {
			onEvent: (event: AgentEvent) => {
				events.push(event);
			},
		},
	};
}

test("unsupported driver", async () => {
	const { manager } = setup();
	assert.equal(manager.supports("claude"), true);
	assert.equal(manager.supports("opencode"), false);
	await assert.rejects(
		manager.runTurn(
			"c",
			launch({ instance: instance("oc", "opencode") }),
			"hi",
			collect().handlers,
			noToken,
		),
		/No long-lived session support/,
	);
});

test("reuses the live process across turns and persists the session id", async () => {
	const { manager, sessions, store } = setup();
	const first = collect();
	const r1 = await manager.runTurn(
		"chat",
		launch(),
		"one",
		first.handlers,
		noToken,
	);
	assert.deepEqual(r1, { sessionId: "sid-1", resumed: false, fresh: true });
	assert.deepEqual(first.events, [{ kind: "text", text: "echo one" }]);
	assert.equal(store.get("chat")?.cliSessionId, "sid-1");
	assert.equal(store.get("chat")?.driver, "claude");
	assert.equal(store.get("chat")?.model, "opus");

	const contexts: PromptContext[] = [];
	const r2 = await manager.runTurn(
		"chat",
		launch(),
		(context) => {
			contexts.push(context);
			return "two";
		},
		collect().handlers,
		noToken,
	);
	assert.deepEqual(r2, { sessionId: "sid-1", resumed: false, fresh: false });
	assert.deepEqual(contexts, [{ fresh: false, resumed: false }]);
	assert.equal(sessions.length, 1);
	assert.deepEqual(sessions[0].prompts, ["one", "two"]);
	assert.equal(manager.isLive("chat"), true);
	assert.equal(manager.sessionIdFor("chat"), "sid-1");
});

test("resumes from the store after the process exits on its own", async () => {
	const { manager, sessions } = setup();
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	sessions[0].exit({ code: 1, error: "crashed" });
	assert.equal(manager.isLive("chat"), false);
	assert.equal(manager.sessionIdFor("chat"), "sid-1");

	const contexts: PromptContext[] = [];
	const result = await manager.runTurn(
		"chat",
		launch(),
		(context) => {
			contexts.push(context);
			return "two";
		},
		collect().handlers,
		noToken,
	);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[1].launch.resumeId, "sid-1");
	assert.deepEqual(contexts, [{ fresh: false, resumed: true }]);
	assert.deepEqual(result, { sessionId: "sid-1", resumed: true, fresh: false });
});

test("resumes from a store written by an earlier window", async () => {
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "old",
		cwd: "/repo",
		updatedAt: 1,
	});
	const { manager, sessions } = setup({ store });
	const result = await manager.runTurn(
		"chat",
		launch(),
		"hi",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions[0].launch.resumeId, "old");
	assert.equal(result.resumed, true);
});

test("stored id for another cwd is not resumed", async () => {
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "old",
		cwd: "/elsewhere",
		updatedAt: 1,
	});
	const { manager, sessions } = setup({ store });
	const result = await manager.runTurn(
		"chat",
		launch(),
		"hi",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions[0].launch.resumeId, undefined);
	assert.equal(result.fresh, true);
	assert.equal(store.get("chat")?.cliSessionId, "sid-1");
});

test("a launch-key change restarts the process resuming the same session", async () => {
	const { manager, sessions } = setup();
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	const result = await manager.runTurn(
		"chat",
		launch({ model: "sonnet", mode: "plan" }),
		"two",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[0].disposed, true);
	assert.equal(sessions[1].launch.resumeId, "sid-1");
	assert.equal(sessions[1].launch.model, "sonnet");
	assert.deepEqual(result, { sessionId: "sid-1", resumed: true, fresh: false });
	// Same launch again: reused.
	await manager.runTurn(
		"chat",
		launch({ model: "sonnet", mode: "plan" }),
		"three",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions.length, 2);
	// Extra directories are part of the key too.
	await manager.runTurn(
		"chat",
		launch({ model: "sonnet", mode: "plan", extraDirectories: ["/other"] }),
		"four",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions.length, 3);
	assert.equal(sessions[2].launch.resumeId, "sid-1");
});

test("a driver or instance change starts fresh and drops the stored id", async () => {
	const { manager, sessions, store } = setup({
		behaviors: [
			reply,
			async () => {
				throw new Error("boom");
			},
		],
	});
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	await assert.rejects(
		manager.runTurn(
			"chat",
			launch({ instance: instance("codex", "codex") }),
			"two",
			collect().handlers,
			noToken,
		),
		/boom/,
	);
	assert.equal(sessions[0].disposed, true);
	assert.equal(sessions[1].launch.resumeId, undefined);
	assert.equal(store.get("chat"), undefined);
});

test("a different instance of the same driver starts fresh", async () => {
	const { manager, sessions } = setup();
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	const contexts: PromptContext[] = [];
	const result = await manager.runTurn(
		"chat",
		launch({ instance: instance("claude-work") }),
		(context) => {
			contexts.push(context);
			return "two";
		},
		collect().handlers,
		noToken,
	);
	assert.equal(sessions[1].launch.resumeId, undefined);
	assert.deepEqual(contexts, [{ fresh: true, resumed: false }]);
	assert.deepEqual(result, { sessionId: "sid-2", resumed: false, fresh: true });
});

test("a failed resume retries once fresh and asks for history", async () => {
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "gone",
		cwd: "/repo",
		updatedAt: 1,
	});
	const failResume: Behavior = async (session) => {
		session.exit({
			code: 1,
			error: "No conversation found with session ID: gone",
		});
		throw new Error("No conversation found with session ID: gone");
	};
	const { manager, sessions } = setup({
		store,
		behaviors: [failResume, reply],
	});
	const contexts: PromptContext[] = [];
	const { events, handlers } = collect();
	const result = await manager.runTurn(
		"chat",
		launch(),
		(context) => {
			contexts.push(context);
			return context.fresh ? "history + hi" : "hi";
		},
		handlers,
		noToken,
	);
	assert.deepEqual(contexts, [
		{ fresh: false, resumed: true },
		{ fresh: true, resumed: false },
	]);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[1].launch.resumeId, undefined);
	assert.deepEqual(sessions[1].prompts, ["history + hi"]);
	assert.deepEqual(result, { sessionId: "sid-2", resumed: false, fresh: true });
	assert.deepEqual(events, [{ kind: "text", text: "echo history + hi" }]);
	assert.equal(store.get("chat")?.cliSessionId, "sid-2");
});

test("a resume that throws at start retries fresh", async () => {
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "gone",
		cwd: "/repo",
		updatedAt: 1,
	});
	let calls = 0;
	const disposedTools: number[] = [];
	const manager = new SessionManager({
		store,
		prepareTools: () => {
			const n = calls;
			return {
				mcpConfigFile: "",
				settingsFile: "",
				shimPath: "",
				port: 0,
				token: "",
				dispose: () => disposedTools.push(n),
			};
		},
		factories: {
			claude: (sessionLaunch) => {
				calls++;
				if (sessionLaunch.resumeId) {
					throw new Error("spawn failed");
				}
				return new FakeSession(sessionLaunch, reply, "fresh");
			},
		},
	});
	const result = await manager.runTurn(
		"chat",
		launch(),
		"hi",
		collect().handlers,
		noToken,
	);
	assert.deepEqual(result, { sessionId: "fresh", resumed: false, fresh: true });
	assert.deepEqual(disposedTools, [0]);
	manager.dispose();
});

test("a resumed turn that fails after producing output is not retried", async () => {
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "old",
		cwd: "/repo",
		updatedAt: 1,
	});
	const failLate: Behavior = async (_session, _prompt, handlers) => {
		handlers.onEvent({ kind: "text", text: "partial" });
		throw new Error("rate limited");
	};
	const { manager, sessions } = setup({ store, behaviors: [failLate] });
	await assert.rejects(
		manager.runTurn("chat", launch(), "hi", collect().handlers, noToken),
		/rate limited/,
	);
	assert.equal(sessions.length, 1);
	assert.equal(store.get("chat")?.cliSessionId, "old");
});

test("a fresh start that fails is not retried", async () => {
	const { manager, sessions } = setup({
		behavior: async () => {
			throw new Error("auth");
		},
	});
	await assert.rejects(
		manager.runTurn("chat", launch(), "hi", collect().handlers, noToken),
		/auth/,
	);
	assert.equal(sessions.length, 1);
});

test("idle timeout stops the process and keeps the stored id", async () => {
	const { manager, sessions, timers, fireTimers, store } = setup({
		idleTimeoutMs: 5000,
	});
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	assert.equal(timers.size, 1);
	assert.equal([...timers.values()][0].ms, 5000);
	fireTimers();
	assert.equal(sessions[0].disposed, true);
	assert.equal(manager.isLive("chat"), false);
	assert.equal(store.get("chat")?.cliSessionId, "sid-1");
	await manager.runTurn("chat", launch(), "two", collect().handlers, noToken);
	assert.equal(sessions[1].launch.resumeId, "sid-1");
});

test("idle timer is cleared while a turn runs and re-armed after", async () => {
	let release: () => void = () => {};
	let calls = 0;
	const gated: Behavior = async () => {
		if (++calls === 2) {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
	};
	const { manager, timers, fireTimers, sessions } = setup({ behavior: gated });
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	assert.equal(timers.size, 1);
	const pending = manager.runTurn(
		"chat",
		launch(),
		"two",
		collect().handlers,
		noToken,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(timers.size, 0);
	fireTimers();
	assert.equal(sessions[0].disposed, false);
	release();
	await pending;
	assert.equal(timers.size, 1);
});

test("caps live processes, stopping the least recently used idle one", async () => {
	const { manager, sessions } = setup({ maxLive: 2 });
	await manager.runTurn("a", launch(), "x", collect().handlers, noToken);
	await manager.runTurn("b", launch(), "x", collect().handlers, noToken);
	await manager.runTurn("a", launch(), "y", collect().handlers, noToken);
	await manager.runTurn("c", launch(), "x", collect().handlers, noToken);
	assert.equal(manager.isLive("a"), true);
	assert.equal(manager.isLive("b"), false);
	assert.equal(manager.isLive("c"), true);
	assert.equal(sessions[1].disposed, true);
	assert.equal(manager.sessionIdFor("b"), "sid-2");
});

test("release keeps the stored id; forget deletes it", async () => {
	const { manager, sessions, store } = setup();
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	manager.release("chat");
	assert.equal(sessions[0].disposed, true);
	assert.equal(manager.isLive("chat"), false);
	assert.equal(manager.sessionIdFor("chat"), "sid-1");
	await manager.runTurn("chat", launch(), "two", collect().handlers, noToken);
	assert.equal(sessions[1].launch.resumeId, "sid-1");
	manager.forget("chat");
	assert.equal(sessions[1].disposed, true);
	assert.equal(store.get("chat"), undefined);
	assert.equal(manager.sessionIdFor("chat"), undefined);
	const result = await manager.runTurn(
		"chat",
		launch(),
		"three",
		collect().handlers,
		noToken,
	);
	assert.equal(sessions[2].launch.resumeId, undefined);
	assert.equal(result.fresh, true);
});

test("cancellation token is passed through and a cancelled resume is not retried", async () => {
	const source = tokenSource();
	const cancellable: Behavior = (_session, _prompt, _handlers, token) =>
		new Promise<void>((_resolve, reject) => {
			token.onCancellationRequested(() => reject(new Error("interrupted")));
		});
	const store = new MemorySessionStore();
	store.set("chat", {
		driver: "claude",
		instanceId: "claude",
		cliSessionId: "old",
		cwd: "/repo",
		updatedAt: 1,
	});
	const { manager, sessions } = setup({ store, behavior: cancellable });
	const pending = manager.runTurn(
		"chat",
		launch(),
		"hi",
		collect().handlers,
		source.token,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sessions[0].tokens[0], source.token);
	source.cancel();
	await assert.rejects(pending, /interrupted/);
	assert.equal(sessions.length, 1);
	assert.equal(manager.isLive("chat"), true);
	// The resumed id is still stored (sessionId is known from the resume).
	assert.equal(store.get("chat")?.cliSessionId, "old");
});

test("turns for one chat are serialized; a queued turn cancelled before it starts sends nothing", async () => {
	let release: () => void = () => {};
	let calls = 0;
	const gated: Behavior = async (_session, prompt, handlers) => {
		calls++;
		if (calls === 1) {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
		handlers.onEvent({ kind: "text", text: prompt });
	};
	const { manager, sessions } = setup({ behavior: gated });
	const order: string[] = [];
	const first = manager.runTurn(
		"chat",
		launch(),
		"one",
		{ onEvent: () => order.push("one") },
		noToken,
	);
	const second = manager.runTurn(
		"chat",
		launch(),
		"two",
		{ onEvent: () => order.push("two") },
		noToken,
	);
	const source = tokenSource();
	source.cancel();
	const third = manager.runTurn(
		"chat",
		launch(),
		"three",
		{ onEvent: () => order.push("three") },
		source.token,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sessions[0].prompts, ["one"]);
	release();
	await Promise.all([first, second, third]);
	assert.deepEqual(order, ["one", "two"]);
	assert.deepEqual(sessions[0].prompts, ["one", "two"]);
});

test("prepares editor tools per process and updates the guard prompt each turn", async () => {
	const prepared: { prompts: string[]; disposed: boolean }[] = [];
	const { manager, sessions } = setup({
		prepareTools: (): UpdatableEditorToolLaunch => {
			const record = { prompts: [] as string[], disposed: false };
			prepared.push(record);
			return {
				mcpConfigFile: "m",
				settingsFile: "s",
				shimPath: "x",
				port: 1,
				token: "t",
				updateTurn: (text) => record.prompts.push(text),
				dispose: () => {
					record.disposed = true;
				},
			};
		},
	});
	await manager.runTurn("chat", launch(), "one", collect().handlers, noToken);
	await manager.runTurn("chat", launch(), "two", collect().handlers, noToken);
	assert.equal(prepared.length, 1);
	assert.deepEqual(prepared[0].prompts, ["one", "two"]);
	assert.equal(sessions[0].launch.editorTools?.settingsFile, "s");
	manager.dispose();
	assert.equal(prepared[0].disposed, true);
	assert.equal(sessions[0].disposed, true);
	await assert.rejects(
		manager.runTurn("chat", launch(), "three", collect().handlers, noToken),
		/disposed/,
	);
});

test("an empty chat key is refused instead of sharing one process", async () => {
	const { manager, sessions } = setup();
	await assert.rejects(
		manager.runTurn(
			"",
			launch(),
			"hi",
			{ onEvent: () => {} },
			tokenSource().token,
		),
		/non-empty chat key/,
	);
	assert.equal(sessions.length, 0);
});
