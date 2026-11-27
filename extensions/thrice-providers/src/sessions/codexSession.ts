/**
 * One long-lived `codex app-server` process per chat, speaking JSON-RPC over stdio, holding one
 * Codex thread. A new process resumes the thread by id (`thread/resume`), which reads the rollout
 * file under `~/.codex/sessions`, so the same thread also opens with `codex resume <id>`.
 *
 * Policy (see `sandboxFor`):
 * - Read-only modes (plan, ask, spec, triage): sandbox `read-only`, approval `never`, and any
 *   approval request that still arrives is declined.
 * - Other modes: the sandbox is whatever `codex exec` gets today (the user's config, or a sandbox
 *   flag in the instance's launch args) and approval is `on-request`; every approval request
 *   (escalated command, file change, MCP tool call, extra permissions) is accepted. Plain `never`
 *   would match `exec` exactly, but then MCP tools that need approval, the thrice editor tools
 *   included, fail with "approval policy is never".
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
	createEventDecoder,
	type AgentEvent,
	type EventDecoder,
} from "../events";
import { withEditorTools } from "../editorToolPolicy";
import {
	missingEnvironment,
	promptForTurn,
	type ChatTurnMode,
} from "../instances";
import { environmentForChild } from "../run";
import {
	APPROVAL_METHODS,
	type AskForApproval,
	type DeltaNotification,
	type ErrorNotification,
	type InitializeParams,
	type ItemNotification,
	type PlanNotification,
	type RequestId,
	type SandboxMode,
	type ThreadItem,
	type ThreadResponse,
	type ThreadResumeParams,
	type ThreadStartParams,
	type TurnNotification,
	type TurnStartParams,
	type TurnStartResponse,
	type TurnSteerParams,
} from "./codexProtocol";
import type {
	AgentSession,
	CancellationTokenLike,
	Disposable,
	SessionLaunch,
	SessionState,
	TurnHandlers,
} from "./types";

/** How long a cancelled turn may take to acknowledge `turn/interrupt` before the process is killed. */
export const INTERRUPT_TIMEOUT_MS = 5000;

const STDERR_LIMIT = 4000;

/** Notifications the session never reads; opting out keeps stdout quiet. */
const QUIET_NOTIFICATIONS = [
	"mcpServer/startupStatus/updated",
	"account/rateLimits/updated",
	"account/updated",
	"thread/tokenUsage/updated",
	"remoteControl/status/changed",
	"item/commandExecution/outputDelta",
	"item/fileChange/outputDelta",
	"rawResponseItem/completed",
	"rawResponse/completed",
];

/** What the instance's launch args mean for `codex app-server`. */
export interface AppServerArgs {
	/** Arguments `app-server` accepts (`-c key=value`, `--enable`, `--disable`), in order. */
	readonly config: string[];
	/** `-m`/`--model` or `-c model=...`; not an app-server option, so it goes on the thread. */
	readonly model?: string;
	readonly sandbox?: SandboxMode;
	readonly approval?: AskForApproval;
	/** Arguments that mean nothing to `app-server` and were left out. */
	readonly dropped: string[];
}

/**
 * Splits instance launch args (written for `codex exec`) into app-server config overrides and the
 * settings that app-server takes per thread instead.
 */
export function appServerArgs(launchArgs: readonly string[]): AppServerArgs {
	const config: string[] = [];
	const dropped: string[] = [];
	let model: string | undefined;
	let sandbox: SandboxMode | undefined;
	let approval: AskForApproval | undefined;
	for (let index = 0; index < launchArgs.length; index++) {
		const arg = launchArgs[index];
		const next = launchArgs[index + 1];
		const [flag, inline] =
			arg.startsWith("--") && arg.includes("=")
				? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
				: [arg, undefined];
		const value = inline ?? next;
		const consumed = inline === undefined ? 1 : 0;
		switch (flag) {
			case "-c":
			case "--config":
				if (value !== undefined) {
					if (value.startsWith("model=")) {
						model = unquote(value.slice("model=".length));
					} else {
						config.push("-c", value);
					}
					index += consumed;
				}
				break;
			case "--enable":
			case "--disable":
				if (value !== undefined) {
					config.push(flag, value);
					index += consumed;
				}
				break;
			case "-m":
			case "--model":
				if (value !== undefined) {
					model = value;
					index += consumed;
				}
				break;
			case "-p":
			case "--profile":
				if (value !== undefined) {
					config.push("-c", `profile=${JSON.stringify(value)}`);
					index += consumed;
				}
				break;
			case "-s":
			case "--sandbox":
				if (
					value === "read-only" ||
					value === "workspace-write" ||
					value === "danger-full-access"
				) {
					sandbox = value;
				}
				index += value !== undefined ? consumed : 0;
				break;
			case "-a":
			case "--ask-for-approval":
				if (
					value === "untrusted" ||
					value === "on-request" ||
					value === "never"
				) {
					approval = value;
				}
				index += value !== undefined ? consumed : 0;
				break;
			case "--full-auto":
				sandbox = "workspace-write";
				break;
			case "--dangerously-bypass-approvals-and-sandbox":
			case "--yolo":
				sandbox = "danger-full-access";
				approval = "never";
				break;
			default:
				dropped.push(arg);
		}
	}
	return { config, model, sandbox, approval, dropped };
}

function unquote(value: string): string {
	return value.length >= 2 &&
		(value[0] === '"' || value[0] === "'") &&
		value.endsWith(value[0])
		? value.slice(1, -1)
		: value;
}

/** Plan, ask, spec and triage must not change the project (same set as `instances.ts`). */
export function isReadOnlyMode(mode: ChatTurnMode | undefined): boolean {
	return (
		mode === "plan" || mode === "ask" || mode === "spec" || mode === "triage"
	);
}

/** Sandbox and approval policy for a thread; `sandbox` undefined keeps the user's config, as `exec` does. */
export function sandboxFor(
	mode: ChatTurnMode | undefined,
	args: Pick<AppServerArgs, "sandbox" | "approval">,
): { sandbox?: SandboxMode; approvalPolicy: AskForApproval } {
	if (isReadOnlyMode(mode)) {
		return { sandbox: "read-only", approvalPolicy: "never" };
	}
	return {
		sandbox: args.sandbox,
		approvalPolicy: args.approval ?? "on-request",
	};
}

/** The full argv for `launch.instance.command`: config overrides, editor-tool MCP overrides, `app-server`. */
export function codexAppServerArgv(
	launch: Pick<SessionLaunch, "instance" | "editorTools">,
): string[] {
	const parsed = appServerArgs(launch.instance.launchArgs);
	return [...parsed.config, ...editorToolOverrides(launch), "app-server"];
}

/** The `-c mcp_servers.thrice...` overrides `withEditorTools` adds for `codex exec`. */
function editorToolOverrides(
	launch: Pick<SessionLaunch, "editorTools">,
): string[] {
	if (!launch.editorTools) {
		return [];
	}
	// withEditorTools inserts the overrides before `exec` (index 0 here) and decorates the last
	// argument with the tool note; the placeholder takes the note and is dropped.
	return withEditorTools("codex", [""], launch.editorTools).slice(0, -1);
}

/** The text sent as the user input of one turn: mode preface, editor instruction, tool note. */
export function codexTurnText(
	prompt: string,
	launch: Pick<SessionLaunch, "mode" | "editorTools">,
): string {
	const text = promptForTurn(prompt, launch.mode);
	const decorated = withEditorTools("codex", [text], launch.editorTools);
	return decorated[decorated.length - 1];
}

/** Starts the app-server process for `launch` and returns its session. */
export function createCodexSession(launch: SessionLaunch): AgentSession {
	return new CodexSession(launch);
}

type Json = Record<string, unknown>;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveTurn {
	readonly handlers: TurnHandlers;
	readonly decoder: EventDecoder;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	id?: string;
	cancelled: boolean;
	done: boolean;
	error?: string;
	killTimer?: ReturnType<typeof setTimeout>;
	cancelListener?: Disposable;
	/** Text emitted so far per agent message / reasoning stream. */
	readonly streamed: Map<string, string>;
	lastTextItem?: string;
	planId?: string;
	planItems?: { text: string; completed: boolean }[];
	interruptSent?: boolean;
	/** Tool cards started and not yet ended; closed as failed when the turn ends without them. */
	readonly openTools: Set<string>;
}

class CodexSession implements AgentSession {
	readonly driver = "codex" as const;

	private _state: SessionState = "starting";
	private _sessionId: string | undefined;
	private child: ChildProcess | undefined;
	private readonly name: string;
	private readonly parsed: AppServerArgs;
	private readonly model: string | undefined;
	private readonly ready: Promise<void>;
	private nextId = 1;
	private readonly pending = new Map<RequestId, PendingRequest>();
	private turn: ActiveTurn | undefined;
	private stdout = "";
	private stderr = "";
	private disposed = false;
	private exitInfo: { code: number | null; error?: string } | undefined;
	private startError: string | undefined;
	private readonly exitListeners = new Set<
		(info: { readonly code: number | null; readonly error?: string }) => void
	>();
	private editorToolsDisposed = false;

	private readonly launch: SessionLaunch;

	constructor(launch: SessionLaunch) {
		this.launch = launch;
		this.name = launch.instance.displayName;
		this.parsed = appServerArgs(launch.instance.launchArgs);
		this.model = launch.model || this.parsed.model || undefined;
		this.ready = this.start();
		this.ready.catch(() => {
			/* surfaced through send() and onDidExit */
		});
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	get state(): SessionState {
		return this._state;
	}

	onDidExit(
		listener: (info: {
			readonly code: number | null;
			readonly error?: string;
		}) => void,
	): Disposable {
		if (this.exitInfo) {
			const info = this.exitInfo;
			queueMicrotask(() => listener(info));
			return {
				dispose() {
					/* already fired */
				},
			};
		}
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}

	send(
		prompt: string,
		handlers: TurnHandlers,
		token: CancellationTokenLike,
	): Promise<void> {
		if (this._state === "exited") {
			return Promise.reject(new Error(this.exitMessage()));
		}
		if (this.turn) {
			return Promise.reject(
				new Error(`${this.name} is still answering the previous message.`),
			);
		}
		if (token.isCancellationRequested) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const turn: ActiveTurn = {
				handlers,
				decoder: createEventDecoder("codex", { cwd: this.launch.cwd }),
				resolve,
				reject,
				cancelled: false,
				done: false,
				streamed: new Map(),
				openTools: new Set(),
			};
			this.turn = turn;
			turn.cancelListener = token.onCancellationRequested(() =>
				this.cancel(turn),
			);
			this.ready.then(
				() => {
					if (turn.done) {
						return;
					}
					if (turn.cancelled) {
						this.finishTurn(turn);
						return;
					}
					this.setState("busy");
					const params: TurnStartParams = {
						threadId: this._sessionId!,
						input: [
							{
								type: "text",
								text: codexTurnText(prompt, this.launch),
								text_elements: [],
							},
						],
						...(this.model ? { model: this.model } : {}),
					};
					this.request<TurnStartResponse>("turn/start", params).then(
						(response) => {
							turn.id ??= response.turn.id;
							if (turn.cancelled) {
								this.interrupt(turn);
							}
						},
						(error) => this.finishTurn(turn, error),
					);
				},
				(error) =>
					this.finishTurn(
						turn,
						error instanceof Error ? error : new Error(String(error)),
					),
			);
		});
	}

	/** Steering through app-server `turn/steer`: the message joins the running turn. */
	async steer(prompt: string): Promise<boolean> {
		const turn = this.turn;
		if (!turn || turn.done || turn.cancelled || !turn.id || !this._sessionId) {
			return false;
		}
		const params: TurnSteerParams = {
			threadId: this._sessionId,
			expectedTurnId: turn.id,
			input: [
				{
					type: "text",
					text: codexTurnText(prompt, this.launch),
					text_elements: [],
				},
			],
		};
		try {
			await this.request("turn/steer", params);
			return this.turn === turn && !turn.done;
		} catch (error) {
			this.launch.log?.warn(
				`${this.name}: turn/steer failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.child && this.isRunning(this.child)) {
			terminate(this.child);
		}
	}

	// -- process ----------------------------------------------------------------------------------

	private async start(): Promise<void> {
		const instance = this.launch.instance;
		const missing = missingEnvironment(instance);
		if (missing.length > 0) {
			this.fail(
				`${this.name} needs ${missing.join(", ")} from your environment or Thrice provider settings.`,
			);
			throw new Error(this.startError);
		}
		if (this.parsed.dropped.length > 0) {
			this.launch.log?.warn(
				`${this.name}: ignoring launch args app-server does not take: ${this.parsed.dropped.join(" ")}`,
			);
		}
		const argv = codexAppServerArgv(this.launch);
		this.launch.log?.info(
			`${this.name}: starting ${instance.command} app-server in ${this.launch.cwd}${this.launch.resumeId ? ` to resume thread ${this.launch.resumeId}` : ""}`,
		);
		let child: ChildProcess;
		try {
			child = spawn(instance.command, argv, {
				cwd: this.launch.cwd,
				env: environmentForChild(instance, this.launch.env),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			throw new Error(this.startError);
		}
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
		});
		child.stdin?.on("error", () => {
			/* the exit handler reports it */
		});
		child.on("error", (error) => {
			const missingCommand = (error as NodeJS.ErrnoException).code === "ENOENT";
			this.startError ??= missingCommand
				? `${this.name} could not find ${instance.command}.`
				: error.message;
			if (child.pid === undefined || child.exitCode !== null) {
				this.onExit(child.exitCode);
			}
		});
		child.on("exit", (code) => this.onExit(code));

		await this.request("initialize", {
			clientInfo: { name: "thrice", title: "Thrice", version: "1.0.0" },
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: QUIET_NOTIFICATIONS,
			},
		} satisfies InitializeParams);
		this.write({ method: "initialized" });
		const policy = sandboxFor(this.launch.mode, this.parsed);
		const base: ThreadStartParams = {
			cwd: this.launch.cwd,
			approvalPolicy: policy.approvalPolicy,
			...(policy.sandbox ? { sandbox: policy.sandbox } : {}),
			...(this.model ? { model: this.model } : {}),
		};
		let response: ThreadResponse;
		if (this.launch.resumeId) {
			try {
				response = await this.request<ThreadResponse>("thread/resume", {
					...base,
					threadId: this.launch.resumeId,
					excludeTurns: true,
				} satisfies ThreadResumeParams);
			} catch (error) {
				const message = `${this.name} could not resume thread ${this.launch.resumeId}: ${error instanceof Error ? error.message : String(error)}`;
				this.startError ??= message;
				this.dispose();
				throw new Error(message);
			}
		} else {
			response = await this.request<ThreadResponse>("thread/start", base);
		}
		this._sessionId = response.thread.id;
		this.launch.log?.info(
			`${this.name}: thread ${response.thread.id} (${response.modelProvider}/${response.model})${response.thread.path ? ` at ${response.thread.path}` : ""}`,
		);
		if (this._state === "starting") {
			this.setState("idle");
		}
	}

	/** Ends a session that never got a process. */
	private fail(message: string): void {
		this.startError = message;
		queueMicrotask(() => this.onExit(null));
	}

	private isRunning(child: ChildProcess): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	private onExit(code: number | null): void {
		if (this.exitInfo) {
			return;
		}
		const tail = lastLines(this.stderr);
		const error =
			this.startError ??
			(this.disposed
				? undefined
				: code === 0
					? undefined
					: tail || `${this.name} exited with code ${code}.`);
		this.exitInfo = error ? { code, error } : { code };
		this.setState("exited");
		this.disposeEditorTools();
		const reason = new Error(this.exitMessage());
		for (const request of this.pending.values()) {
			request.reject(reason);
		}
		this.pending.clear();
		const turn = this.turn;
		if (turn) {
			this.finishTurn(
				turn,
				turn.cancelled
					? undefined
					: this.disposed && !this.startError
						? new Error(`${this.name} session was closed.`)
						: reason,
			);
		}
		const info = this.exitInfo;
		for (const listener of [...this.exitListeners]) {
			try {
				listener(info);
			} catch (listenerError) {
				this.launch.log?.warn(
					`${this.name}: exit listener failed: ${listenerError}`,
				);
			}
		}
		this.exitListeners.clear();
	}

	private exitMessage(): string {
		const info = this.exitInfo;
		return (
			info?.error ??
			this.startError ??
			`${this.name} exited${info && info.code !== null ? ` with code ${info.code}` : ""}.`
		);
	}

	private disposeEditorTools(): void {
		if (this.editorToolsDisposed) {
			return;
		}
		this.editorToolsDisposed = true;
		try {
			this.launch.editorTools?.dispose();
		} catch (error) {
			this.launch.log?.warn(
				`${this.name}: editor tools dispose failed: ${error}`,
			);
		}
	}

	private setState(state: SessionState): void {
		if (this._state !== "exited") {
			this._state = state;
		}
	}

	// -- JSON-RPC ---------------------------------------------------------------------------------

	private write(message: unknown): void {
		const stdin = this.child?.stdin;
		if (stdin && !stdin.destroyed && stdin.writable) {
			stdin.write(`${JSON.stringify(message)}\n`);
		}
	}

	private request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.exitInfo) {
			return Promise.reject(new Error(this.exitMessage()));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.write({ id, method, params });
		});
	}

	private onStdout(chunk: string): void {
		this.stdout += chunk;
		const lines = this.stdout.split(/\r?\n/);
		this.stdout = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			let message: Json;
			try {
				const value = JSON.parse(line) as unknown;
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					continue;
				}
				message = value as Json;
			} catch {
				this.launch.log?.warn(
					`${this.name}: unreadable app-server line: ${line.slice(0, 200)}`,
				);
				continue;
			}
			try {
				this.onMessage(message);
			} catch (error) {
				this.launch.log?.warn(
					`${this.name}: failed to handle ${String(message.method ?? "response")}: ${error}`,
				);
			}
		}
	}

	private onMessage(message: Json): void {
		const id = message.id as RequestId | undefined;
		const method =
			typeof message.method === "string" ? message.method : undefined;
		if (id !== undefined && method) {
			this.onServerRequest(id, method, message.params);
			return;
		}
		if (id !== undefined) {
			const pending = this.pending.get(id);
			if (!pending) {
				return;
			}
			this.pending.delete(id);
			const error = message.error as { message?: unknown } | undefined;
			if (error) {
				pending.reject(
					new Error(
						typeof error.message === "string"
							? error.message
							: JSON.stringify(error),
					),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (method) {
			this.onNotification(method, (message.params ?? {}) as Json);
		}
	}

	/** Approvals: accept outside read-only modes, decline inside them. Anything else is refused. */
	private onServerRequest(
		id: RequestId,
		method: string,
		params: unknown,
	): void {
		const allow = !isReadOnlyMode(this.launch.mode);
		const record = (params ?? {}) as Json;
		let result: unknown;
		switch (method) {
			case APPROVAL_METHODS.command:
			case APPROVAL_METHODS.fileChange:
				result = { decision: allow ? "accept" : "decline" };
				break;
			case APPROVAL_METHODS.legacyExec:
			case APPROVAL_METHODS.legacyPatch:
				result = {
					decision: allow
						? "approved"
						: { denied: { rejection: "This chat is in a read-only mode." } },
				};
				break;
			case APPROVAL_METHODS.elicitation:
				result = {
					action: allow ? "accept" : "decline",
					content: null,
					_meta: null,
				};
				break;
			case APPROVAL_METHODS.permissions: {
				const requested = (record.permissions ?? {}) as Json;
				const granted: Json = {};
				if (allow) {
					for (const key of ["network", "fileSystem"]) {
						if (requested[key] !== null && requested[key] !== undefined) {
							granted[key] = requested[key];
						}
					}
				}
				result = { permissions: granted, scope: "turn" };
				break;
			}
			case APPROVAL_METHODS.userInput:
				result = { answers: {} };
				break;
			default:
				this.write({
					id,
					error: { code: -32601, message: `Thrice does not handle ${method}.` },
				});
				return;
		}
		this.launch.log?.info(
			`${this.name}: ${allow ? "accepted" : "declined"} ${method}`,
		);
		this.write({ id, result });
	}

	// -- turn events ------------------------------------------------------------------------------

	private onNotification(method: string, params: Json): void {
		const turn = this.turn;
		if (!turn || turn.done) {
			return;
		}
		if (
			typeof params.threadId === "string" &&
			this._sessionId &&
			params.threadId !== this._sessionId
		) {
			return;
		}
		if (
			typeof params.turnId === "string" &&
			turn.id &&
			params.turnId !== turn.id
		) {
			return;
		}
		switch (method) {
			case "turn/started": {
				const started = params as unknown as TurnNotification;
				turn.id ??= started.turn?.id;
				if (turn.cancelled) {
					this.interrupt(turn);
				}
				return;
			}
			case "turn/completed": {
				const completed = params as unknown as TurnNotification;
				if (turn.id && completed.turn?.id && completed.turn.id !== turn.id) {
					return;
				}
				this.closePlan(turn);
				if (completed.turn?.status === "failed") {
					const message =
						completed.turn.error?.message ||
						turn.error ||
						`${this.name} failed.`;
					this.finishTurn(turn, new Error(message));
				} else {
					this.finishTurn(turn);
				}
				return;
			}
			case "error": {
				const failure = params as unknown as ErrorNotification;
				const message = failure.error?.message;
				if (failure.willRetry) {
					this.launch.log?.warn(`${this.name}: ${message} (retrying)`);
				} else if (message) {
					turn.error = message;
				}
				return;
			}
			case "item/agentMessage/delta": {
				const delta = params as unknown as DeltaNotification;
				this.emitText(turn, delta.itemId, delta.delta);
				return;
			}
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta": {
				const delta = params as unknown as DeltaNotification;
				const key = `${delta.itemId}:${method.endsWith("summaryTextDelta") ? "summary" : "content"}`;
				this.emitThinking(turn, key, delta.itemId, delta.delta);
				return;
			}
			case "item/reasoning/summaryPartAdded": {
				const itemId = String(params.itemId ?? "");
				const key = `${itemId}:summary`;
				if (turn.streamed.get(key)) {
					this.emitThinking(turn, key, itemId, "\n\n");
				}
				return;
			}
			case "turn/plan/updated":
				this.onPlan(turn, params as unknown as PlanNotification);
				return;
			case "item/started":
			case "item/completed":
				this.onItem(
					turn,
					method === "item/completed",
					(params as unknown as ItemNotification).item,
				);
				return;
		}
	}

	private onItem(
		turn: ActiveTurn,
		completed: boolean,
		item: ThreadItem | undefined,
	): void {
		if (!item || typeof item.type !== "string") {
			return;
		}
		if (item.type === "agentMessage") {
			if (completed) {
				const text = (item as { text?: unknown }).text;
				if (typeof text === "string") {
					this.emitRemainder(turn, item.id, text, (value) =>
						this.emitText(turn, item.id, value),
					);
				}
			}
			return;
		}
		if (item.type === "reasoning") {
			if (completed) {
				const reasoning = item as { summary?: unknown; content?: unknown };
				const summary = Array.isArray(reasoning.summary)
					? reasoning.summary
							.filter((part) => typeof part === "string")
							.join("\n\n")
					: "";
				const content = Array.isArray(reasoning.content)
					? reasoning.content
							.filter((part) => typeof part === "string")
							.join("\n\n")
					: "";
				if (summary) {
					this.emitRemainder(turn, `${item.id}:summary`, summary, (value) =>
						this.emitThinking(turn, `${item.id}:summary`, item.id, value),
					);
				} else if (content) {
					this.emitRemainder(turn, `${item.id}:content`, content, (value) =>
						this.emitThinking(turn, `${item.id}:content`, item.id, value),
					);
				}
			}
			return;
		}
		const execItem = toExecItem(item);
		if (execItem) {
			this.decode(turn, {
				type: completed ? "item.completed" : "item.started",
				item: execItem,
			});
		}
	}

	/** `turn/plan/updated` becomes the same `todo_list` card `codex exec` produces. */
	private onPlan(turn: ActiveTurn, plan: PlanNotification): void {
		turn.planId ??= `plan-${plan.turnId || turn.id || "turn"}`;
		const items = (plan.plan ?? []).map((step) => ({
			text: step.step,
			completed: step.status === "completed",
		}));
		turn.planItems = items;
		this.decode(turn, {
			type: "item.updated",
			item: { type: "todo_list", id: turn.planId, items },
		});
	}

	private closePlan(turn: ActiveTurn): void {
		if (turn.planId) {
			this.decode(turn, {
				type: "item.completed",
				item: {
					type: "todo_list",
					id: turn.planId,
					status: "completed",
					items: turn.planItems ?? [],
				},
			});
		}
	}

	private decode(turn: ActiveTurn, line: Json): void {
		for (const event of turn.decoder.push(JSON.stringify(line))) {
			this.emit(turn, event);
		}
	}

	private emitText(turn: ActiveTurn, itemId: string, text: string): void {
		if (!text) {
			return;
		}
		const previous = turn.streamed.get(itemId);
		if (
			previous === undefined &&
			turn.lastTextItem &&
			turn.lastTextItem !== itemId
		) {
			// A new agent message in the same turn (commentary, then the answer): keep them apart.
			this.emit(turn, { kind: "text", text: "\n\n" });
		}
		turn.lastTextItem = itemId;
		turn.streamed.set(itemId, (previous ?? "") + text);
		this.emit(turn, { kind: "text", text });
	}

	private emitThinking(
		turn: ActiveTurn,
		key: string,
		itemId: string,
		text: string,
	): void {
		if (!text) {
			return;
		}
		turn.streamed.set(key, (turn.streamed.get(key) ?? "") + text);
		this.emit(turn, { kind: "thinking", text, id: itemId });
	}

	/** Emits the part of a completed item's text that its deltas did not already deliver. */
	private emitRemainder(
		turn: ActiveTurn,
		key: string,
		full: string,
		emit: (text: string) => void,
	): void {
		const streamed = turn.streamed.get(key) ?? "";
		if (!streamed) {
			emit(full);
		} else if (full.startsWith(streamed) && full.length > streamed.length) {
			emit(full.slice(streamed.length));
		}
	}

	private emit(turn: ActiveTurn, event: AgentEvent): void {
		if (event.kind === "toolStart") {
			turn.openTools.add(event.id);
		} else if (event.kind === "toolEnd") {
			turn.openTools.delete(event.id);
		}
		try {
			turn.handlers.onEvent(event);
		} catch (error) {
			this.launch.log?.warn(`${this.name}: event handler failed: ${error}`);
		}
	}

	// -- cancel / finish --------------------------------------------------------------------------

	private cancel(turn: ActiveTurn): void {
		if (turn.done || turn.cancelled) {
			return;
		}
		turn.cancelled = true;
		if (!this._sessionId || this._state === "starting") {
			// Not started yet: send() sees `cancelled` once the handshake ends and resolves.
			return;
		}
		this.interrupt(turn);
	}

	/** Arms the kill timer once and sends `turn/interrupt` as soon as the turn id is known. */
	private interrupt(turn: ActiveTurn): void {
		if (turn.done) {
			return;
		}
		turn.killTimer ??= setTimeout(() => {
			if (!turn.done && this.child) {
				this.launch.log?.warn(
					`${this.name}: no answer to turn/interrupt after ${INTERRUPT_TIMEOUT_MS} ms; stopping the process.`,
				);
				terminate(this.child);
			}
		}, INTERRUPT_TIMEOUT_MS);
		if (turn.id && this._sessionId && !turn.interruptSent) {
			turn.interruptSent = true;
			this.request("turn/interrupt", {
				threadId: this._sessionId,
				turnId: turn.id,
			}).catch((error) => {
				this.launch.log?.warn(
					`${this.name}: turn/interrupt failed: ${error instanceof Error ? error.message : error}`,
				);
			});
		}
	}

	private finishTurn(turn: ActiveTurn, error?: Error): void {
		if (turn.done) {
			return;
		}
		// An interrupted or dead turn never completes its running commands; close their cards.
		for (const id of [...turn.openTools]) {
			this.emit(turn, { kind: "toolEnd", id, ok: false });
		}
		turn.done = true;
		if (turn.killTimer) {
			clearTimeout(turn.killTimer);
		}
		turn.cancelListener?.dispose();
		if (this.turn === turn) {
			this.turn = undefined;
		}
		if (this._state === "busy") {
			this.setState("idle");
		}
		if (error && !turn.cancelled) {
			turn.reject(error);
		} else {
			turn.resolve();
		}
	}
}

/** Maps an app-server thread item to the `codex exec --json` item shape `createEventDecoder('codex')` reads. */
export function toExecItem(item: ThreadItem): Json | undefined {
	const record = item as unknown as Json;
	const status = execStatus(record.status);
	switch (item.type) {
		case "commandExecution":
			return {
				type: "command_execution",
				id: item.id,
				command: record.command,
				status,
				...(typeof record.aggregatedOutput === "string"
					? { aggregated_output: record.aggregatedOutput }
					: {}),
				...(typeof record.exitCode === "number"
					? { exit_code: record.exitCode }
					: {}),
			};
		case "fileChange": {
			const changes = Array.isArray(record.changes)
				? (record.changes as Json[])
				: [];
			return {
				type: "file_change",
				id: item.id,
				status,
				changes: changes.map((change) => ({
					path: change.path,
					kind: (change.kind as Json | undefined)?.type ?? "update",
					...(typeof change.diff === "string" ? { diff: change.diff } : {}),
				})),
			};
		}
		case "mcpToolCall":
			return {
				type: "mcp_tool_call",
				id: item.id,
				server: record.server,
				tool: record.tool,
				arguments: record.arguments,
				status,
				result: record.result ?? null,
				error: record.error ?? null,
			};
		case "dynamicToolCall":
			return {
				type: "mcp_tool_call",
				id: item.id,
				server: record.namespace || "tool",
				tool: record.tool,
				arguments: record.arguments,
				status: record.success === false ? "failed" : status,
				result: null,
				error: null,
			};
		case "webSearch":
			return { type: "web_search", id: item.id, query: record.query, status };
		default:
			return undefined;
	}
}

function execStatus(status: unknown): string {
	return status === "inProgress"
		? "in_progress"
		: typeof status === "string"
			? status
			: "in_progress";
}

function lastLines(text: string, count = 12): string {
	return text.trim().split(/\r?\n/).slice(-count).join("\n").trim();
}

/** SIGTERM the process group (the app-server's shells and MCP servers too), then SIGKILL. */
function terminate(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const pid = child.pid;
	const signal = (name: NodeJS.Signals) => {
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, name);
				return;
			} catch {
				// fall through to the child alone
			}
		}
		try {
			child.kill(name);
		} catch {
			// already gone
		}
	};
	signal("SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			signal("SIGKILL");
		}
	}, 2000);
	timer.unref?.();
	child.once("exit", () => clearTimeout(timer));
}
