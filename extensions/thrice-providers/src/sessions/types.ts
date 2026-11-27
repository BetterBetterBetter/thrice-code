/**
 * Long-lived agent CLI sessions: one process per open chat, resumed by CLI session id when the
 * process is gone (reload, crash, idle shutdown, terminal handoff).
 *
 * Kept free of `vscode` so every module under `sessions/` can be tested with node:test.
 */
import type { AgentEvent } from "../events";
import type { EditorToolLaunch } from "../editorToolPolicy";
import type { ChatTurnMode, ProviderInstance } from "../instances";

/** Structural subset of `vscode.CancellationToken`, so a real token can be passed straight in. */
export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface Disposable {
	dispose(): void;
}

export interface SessionLog {
	info(message: string): void;
	warn(message: string): void;
}

/** Everything needed to start (or restart) the CLI process for one chat. */
export interface SessionLaunch {
	readonly instance: ProviderInstance;
	readonly cwd: string;
	readonly extraDirectories: readonly string[];
	readonly model: string;
	readonly mode: ChatTurnMode | undefined;
	/** Environment the child is built from (normally `process.env`); see `environmentForChild`. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** CLI session id (Claude `session_id`) or thread id (Codex) to continue. */
	readonly resumeId?: string;
	/**
	 * How many agents started this one: 0 (or absent) for a chat, 1 for an agent a chat agent
	 * started through runAgent. The editor tools use it for the thrice.agents.maxDepth limit.
	 */
	readonly agentDepth?: number;
	/**
	 * Editor tool bridge for the lifetime of the process. Owned by the caller; the session
	 * calls `dispose()` on it when the process exits.
	 */
	readonly editorTools?: EditorToolLaunch;
	readonly log?: SessionLog;
}

export interface TurnHandlers {
	/** Every decoded event of this turn, in order (same `AgentEvent` contract as `run.ts`). */
	onEvent(event: AgentEvent): void;
}

export type SessionState = "starting" | "idle" | "busy" | "exited";

/** One live CLI process holding one CLI session. */
export interface AgentSession extends Disposable {
	readonly driver: ProviderInstance["driver"];
	/** CLI session/thread id, known after the process reports it (first turn, or at once when resumed). */
	readonly sessionId: string | undefined;
	readonly state: SessionState;
	/** Fires once when the process exits for any reason (including `dispose`). */
	onDidExit(
		listener: (info: {
			readonly code: number | null;
			readonly error?: string;
		}) => void,
	): Disposable;
	/**
	 * Sends one user message and resolves when the CLI finishes that turn.
	 * Rejects with the CLI's error when the turn fails or the process dies mid-turn.
	 * Cancelling the token interrupts the turn (the process stays alive when the CLI supports
	 * interrupting) and resolves once the CLI acknowledges or the process is gone.
	 * Only one turn at a time: calling while `busy` rejects.
	 */
	send(
		prompt: string,
		handlers: TurnHandlers,
		token: CancellationTokenLike,
	): Promise<void>;
	/**
	 * Steering: delivers another user message into the running turn, the way the CLI does when you type
	 * while it works. The CLI reads it at its next opportunity (usually the next tool result) and the
	 * same `send` keeps streaming until the message is answered. Resolves `false` when no turn is
	 * running or the CLI refused it; the caller then falls back to sending it as its own turn.
	 */
	steer?(prompt: string): Promise<boolean>;
}

export type SessionFactory = (launch: SessionLaunch) => AgentSession;
