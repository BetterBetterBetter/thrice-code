/**
 * One long-lived `claude -p --input-format stream-json` process per chat.
 *
 * Messages go in as stream-json lines on stdin, events come out as stream-json lines on stdout,
 * and each turn ends at the CLI's `{"type":"result"}` line. When the process is gone, the next
 * session is started with `--resume <session_id>`.
 *
 * Observed with claude 2.1.332:
 * - `system/init` is printed only after the first user message arrives, and again at every turn.
 * - `--resume <id>` keeps the same `session_id`; an unknown id yields an error `result` and exit 1.
 * - The interrupt control request is answered by a `control_response`, then the turn ends with a
 *   `result` of subtype `error_during_execution`; the process keeps running.
 * - A user message written while a turn runs (steering) is read at the next tool result and answered
 *   in the same turn. One that arrives too late runs as a follow-up turn right after the `result`,
 *   even after an interrupt. `--replay-user-messages` echoes each user message (`isReplay: true`)
 *   when the CLI consumes it, so a turn stays open until every message it was given is consumed.
 *
 * Kept free of `vscode` so it can be tested with node:test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createEventDecoder, type EventDecoder } from "../events";
import { withEditorTools } from "../editorToolPolicy";
import {
	missingEnvironment,
	promptForTurn,
	type ChatTurnMode,
} from "../instances";
import { defaultModelId } from "../models";
import { environmentForChild } from "../run";
import type {
	AgentSession,
	CancellationTokenLike,
	Disposable,
	SessionLaunch,
	SessionState,
	TurnHandlers,
} from "./types";

/** How long the CLI gets to end a turn after an interrupt before the process is killed. */
const INTERRUPT_TIMEOUT_MS = 5000;
/** How long a terminated process gets before SIGKILL. */
const KILL_TIMEOUT_MS = 3000;
/** How long to wait for stdout to drain after the process exits. */
const CLOSE_GRACE_MS = 1000;
const STDERR_LIMIT = 4000;

/** Test hooks; production callers pass nothing. */
export interface ClaudeSessionOptions {
	readonly interruptTimeoutMs?: number;
}

type ArgvLaunch = Pick<
	SessionLaunch,
	| "instance"
	| "model"
	| "mode"
	| "resumeId"
	| "editorTools"
	| "extraDirectories"
>;

/**
 * The argv for a stream-json Claude session: instance launch args (model removed, permission
 * bypass dropped for read-only modes, as in `instanceArgv`), the chosen model, plan mode,
 * stream-json input and output, `--resume`, and the editor tool flags. No prompt argument.
 */
export function claudeSessionArgv(launch: ArgvLaunch): string[] {
	const { instance, mode } = launch;
	const model =
		launch.model ||
		modelFromArgs(instance.launchArgs) ||
		defaultModelId(instance.driver);
	const argv = [
		...argsForMode(argsWithoutModel(instance.launchArgs), mode),
		...(mode === "plan" ? ["--permission-mode", "plan"] : []),
		"--model",
		model,
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--replay-user-messages",
		...(launch.resumeId ? ["--resume", launch.resumeId] : []),
	];
	if (!launch.editorTools) {
		return argv;
	}
	// withEditorTools inserts the claude flags before a trailing `--` and appends a tool note to the
	// last argument, which it takes to be the prompt. Give it a throwaway `-- <prompt>` tail so the
	// note never lands on a real flag value, then drop that tail.
	const withTools = withEditorTools(
		"claude",
		[...argv, "--", ""],
		launch.editorTools,
		launch.extraDirectories,
	);
	return withTools.slice(0, withTools.lastIndexOf("--"));
}

/** One stream-json user message line, as the CLI reads it on stdin. */
export function claudeUserMessage(prompt: string): string {
	return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
}

/** The stream-json control request that interrupts the running turn. */
export function claudeInterruptRequest(requestId: string): string {
	return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}

interface Turn {
	readonly decoder: EventDecoder;
	readonly handlers: TurnHandlers;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	cancelled: boolean;
	interruptTimer?: ReturnType<typeof setTimeout>;
	cancelListener?: Disposable;
	/** User messages written for this turn (its prompt plus steering) that the CLI has not echoed yet. */
	unconsumed: number;
	/** `result` lines seen; more than one when steering ran as a follow-up turn. */
	results: number;
}

type ExitInfo = { readonly code: number | null; readonly error?: string };

/** Starts one long-lived Claude CLI process for a chat. See `AgentSession`. */
export function createClaudeSession(
	launch: SessionLaunch,
	options: ClaudeSessionOptions = {},
): AgentSession {
	const { instance } = launch;
	const name = instance.displayName;
	const interruptTimeout = options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
	const listeners = new Set<(info: ExitInfo) => void>();
	let state: SessionState = "starting";
	let sessionId = launch.resumeId;
	let exitInfo: ExitInfo | undefined;
	let turn: Turn | undefined;
	let disposed = false;
	/** Set once the session itself stops the process (dispose or an unanswered interrupt). */
	let stopping = false;
	let toolsDisposed = false;
	let stdout = "";
	let stderr = "";
	let interrupts = 0;
	let child: ChildProcess | undefined;

	const disposeTools = () => {
		if (!toolsDisposed) {
			toolsDisposed = true;
			launch.editorTools?.dispose();
		}
	};

	const endTurn = (error?: Error) => {
		const current = turn;
		if (!current) {
			return;
		}
		turn = undefined;
		if (current.interruptTimer) {
			clearTimeout(current.interruptTimer);
		}
		current.cancelListener?.dispose();
		if (state === "busy") {
			state = "idle";
		}
		if (error) {
			current.reject(error);
		} else {
			current.resolve();
		}
	};

	const handleLine = (line: string) => {
		const message = parseObject(line);
		if (!message) {
			return;
		}
		if (
			(message.type === "system" && message.subtype === "init") ||
			message.type === "result"
		) {
			if (typeof message.session_id === "string" && message.session_id) {
				sessionId = message.session_id;
			}
		}
		const current = turn;
		if (!current) {
			return;
		}
		if (message.type === "user" && message.isReplay === true) {
			current.unconsumed = Math.max(0, current.unconsumed - 1);
			if (current.cancelled && current.results > 0) {
				// A steering message is starting a follow-up turn after the user stopped: stop that too.
				sendInterrupt(current, interruptTimeout);
			}
		}
		for (const event of current.decoder.push(line)) {
			try {
				current.handlers.onEvent(event);
			} catch (error) {
				launch.log?.warn(
					`${name} turn handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (message.type === "result") {
			current.results++;
			if (current.unconsumed > 0) {
				// Steering the CLI has not read yet runs as a follow-up turn; keep streaming into this one.
				if (current.cancelled) {
					armGiveUp(current, interruptTimeout * 3);
				}
				return;
			}
			const failure = current.cancelled
				? undefined
				: (resultFailure(message) ?? current.decoder.failure());
			endTurn(failure ? new Error(failure) : undefined);
		}
	};

	const pushStdout = (chunk: string) => {
		stdout += chunk;
		const lines = stdout.split(/\r?\n/);
		stdout = lines.pop() ?? "";
		for (const line of lines) {
			handleLine(line);
		}
	};

	const finish = (code: number | null, spawnError?: string) => {
		if (state === "exited") {
			return;
		}
		if (stdout.trim()) {
			const rest = stdout;
			stdout = "";
			handleLine(rest);
		}
		state = "exited";
		disposeTools();
		const tail = stderr.trim();
		const error =
			spawnError ??
			(code !== 0 && !stopping
				? tail || `${name} exited with code ${code}.`
				: undefined);
		if (turn) {
			if (turn.cancelled) {
				endTurn();
			} else {
				endTurn(
					new Error(
						spawnError ??
							turn.decoder.failure() ??
							(disposed
								? `${name} session was closed.`
								: tail ||
									`${name} exited with code ${code} before the turn finished.`),
					),
				);
			}
		}
		exitInfo = error === undefined ? { code } : { code, error };
		launch.log?.info(
			`${name} session ${sessionId ?? "(no id)"} exited with code ${code}.`,
		);
		const info = exitInfo;
		const pending = [...listeners];
		listeners.clear();
		for (const listener of pending) {
			listener(info);
		}
	};

	const missing = missingEnvironment(instance);
	if (missing.length > 0) {
		const message = `${name} needs ${missing.join(", ")} from your environment or Thrice provider settings.`;
		setImmediate(() => finish(null, message));
	} else {
		try {
			child = spawn(instance.command, claudeSessionArgv(launch), {
				cwd: launch.cwd,
				env: environmentForChild(instance, launch.env),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setImmediate(() => finish(null, message));
		}
	}

	if (child) {
		const proc = child;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		proc.on("spawn", () => {
			if (state === "starting") {
				state = "idle";
			}
		});
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", pushStdout);
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_LIMIT);
		});
		proc.stdin?.on("error", (error) =>
			launch.log?.warn(`${name} stdin: ${error.message}`),
		);
		proc.on("error", (error) => {
			if (proc.pid === undefined) {
				const missingCommand =
					(error as NodeJS.ErrnoException).code === "ENOENT";
				finish(
					null,
					missingCommand
						? `${name} could not find ${instance.command}.`
						: error.message,
				);
			} else {
				launch.log?.warn(`${name}: ${error.message}`);
			}
		});
		proc.on("exit", (code) => {
			// Wait for stdout to drain, but not forever: a grandchild may hold the pipe open.
			closeTimer = setTimeout(() => finish(code), CLOSE_GRACE_MS);
		});
		proc.on("close", (code) => {
			if (closeTimer) {
				clearTimeout(closeTimer);
			}
			finish(code);
		});
	}

	const write = (data: string): boolean => {
		const stdin = child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			return false;
		}
		stdin.write(data);
		return true;
	};

	const giveUp = (current: Turn) => {
		if (turn !== current) {
			return;
		}
		launch.log?.warn(
			`${name} did not acknowledge the interrupt; stopping the process.`,
		);
		kill();
		endTurn();
	};

	const armGiveUp = (current: Turn, ms: number) => {
		if (current.interruptTimer) {
			clearTimeout(current.interruptTimer);
		}
		current.interruptTimer = setTimeout(() => giveUp(current), ms);
	};

	const sendInterrupt = (current: Turn, timeoutMs: number) => {
		if (write(claudeInterruptRequest(`interrupt-${++interrupts}`))) {
			armGiveUp(current, timeoutMs);
		} else {
			giveUp(current);
		}
	};

	const interrupt = (current: Turn) => {
		if (current.cancelled || turn !== current) {
			return;
		}
		current.cancelled = true;
		sendInterrupt(current, interruptTimeout);
	};

	const kill = () => {
		if (!child) {
			return;
		}
		const proc = child;
		stopping = true;
		proc.stdin?.end();
		terminate(proc);
		setTimeout(() => terminate(proc, "SIGKILL"), KILL_TIMEOUT_MS).unref();
	};

	return {
		driver: instance.driver,
		get sessionId() {
			return sessionId;
		},
		get state() {
			return state;
		},
		onDidExit(listener) {
			if (exitInfo) {
				const info = exitInfo;
				let live = true;
				setImmediate(() => live && listener(info));
				return {
					dispose: () => {
						live = false;
					},
				};
			}
			listeners.add(listener);
			return {
				dispose: () => {
					listeners.delete(listener);
				},
			};
		},
		send(
			prompt: string,
			handlers: TurnHandlers,
			token: CancellationTokenLike,
		): Promise<void> {
			if (state === "exited" || stopping) {
				return Promise.reject(
					new Error(exitInfo?.error ?? `${name} session has exited.`),
				);
			}
			if (turn || state === "busy") {
				return Promise.reject(
					new Error(`${name} is still working on the previous message.`),
				);
			}
			if (token.isCancellationRequested) {
				return Promise.resolve();
			}
			return new Promise<void>((resolve, reject) => {
				const current: Turn = {
					decoder: createEventDecoder("claude", { cwd: launch.cwd }),
					handlers,
					resolve,
					reject,
					cancelled: false,
					unconsumed: 1,
					results: 0,
				};
				turn = current;
				state = "busy";
				if (!write(claudeUserMessage(promptForTurn(prompt, launch.mode)))) {
					endTurn(new Error(`${name} is not accepting input.`));
					return;
				}
				current.cancelListener = token.onCancellationRequested(() =>
					interrupt(current),
				);
			});
		},
		steer(prompt: string): Promise<boolean> {
			const current = turn;
			if (!current || current.cancelled || state !== "busy" || stopping) {
				return Promise.resolve(false);
			}
			if (!write(claudeUserMessage(promptForTurn(prompt, launch.mode)))) {
				return Promise.resolve(false);
			}
			current.unconsumed++;
			return Promise.resolve(true);
		},
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			if (state === "exited") {
				return;
			}
			kill();
		},
	};
}

/** The error a `result` line reports, if any. Interrupts are handled before this is asked. */
function resultFailure(message: Record<string, unknown>): string | undefined {
	const subtype = typeof message.subtype === "string" ? message.subtype : "";
	if (message.is_error !== true && !subtype.startsWith("error")) {
		return undefined;
	}
	if (typeof message.result === "string" && message.result.trim()) {
		return message.result.trim();
	}
	if (Array.isArray(message.errors)) {
		const errors = message.errors.filter(
			(item): item is string => typeof item === "string" && item.trim() !== "",
		);
		if (errors.length > 0) {
			return errors.join("\n");
		}
	}
	return undefined;
}

function parseObject(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) {
		return undefined;
	}
	try {
		const value = JSON.parse(line) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Same as `terminate` in run.ts (not exported there): signal the whole process group. */
function terminate(
	child: ChildProcess,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through to the child itself.
		}
	}
	child.kill(signal);
}

// The three helpers below mirror the private ones in instances.ts used by `instanceArgv`.

function modelFromArgs(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if ((arg === "-m" || arg === "--model") && args[index + 1]) {
			return args[index + 1];
		}
		if (arg === "-c" && args[index + 1]?.startsWith("model=")) {
			return args[index + 1].slice("model=".length);
		}
	}
	return undefined;
}

function argsWithoutModel(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-m" || arg === "--model") {
			index++;
			continue;
		}
		if (arg === "-c" && args[index + 1]?.startsWith("model=")) {
			index++;
			continue;
		}
		if (arg.startsWith("--model=")) {
			continue;
		}
		result.push(arg);
	}
	return result;
}

function argsForMode(
	args: readonly string[],
	mode: ChatTurnMode | undefined,
): string[] {
	const readOnly =
		mode === "plan" || mode === "ask" || mode === "spec" || mode === "triage";
	return readOnly
		? args.filter((arg) => arg !== "--dangerously-skip-permissions")
		: [...args];
}
