/**
 * Hand-written subset of the `codex app-server` JSON-RPC protocol (codex-cli 0.172.0), taken from
 * `codex app-server generate-ts`. Only the messages `codexSession.ts` sends or reads are here;
 * everything else is ignored by the session. Wire format: one JSON object per line on stdio, no
 * `jsonrpc` member, request ids chosen by the sender.
 */

export type RequestId = string | number;

export interface RpcRequest {
	readonly id: RequestId;
	readonly method: string;
	readonly params?: unknown;
}

export interface RpcNotification {
	readonly method: string;
	readonly params?: unknown;
}

export interface RpcResponse {
	readonly id: RequestId;
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

// -- Client requests ------------------------------------------------------------------------------

export interface InitializeParams {
	readonly clientInfo: {
		readonly name: string;
		readonly title: string | null;
		readonly version: string;
	};
	readonly capabilities: {
		readonly experimentalApi: boolean;
		readonly requestAttestation: boolean;
		/** Exact notification methods the server should not send on this connection. */
		readonly optOutNotificationMethods?: readonly string[];
	} | null;
}

export type SandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";

/** The object form (`granular`) needs the experimental API, so it is left out. */
export type AskForApproval = "untrusted" | "on-request" | "never";

/** `thread/start`. */
export interface ThreadStartParams {
	readonly model?: string | null;
	readonly cwd?: string | null;
	readonly approvalPolicy?: AskForApproval | null;
	readonly sandbox?: SandboxMode | null;
	readonly developerInstructions?: string | null;
}

/** `thread/resume`: loads `~/.codex/sessions/.../rollout-*-<threadId>.jsonl` when the thread is not running. */
export interface ThreadResumeParams extends ThreadStartParams {
	readonly threadId: string;
	/** Skip hydrating `thread.turns`; the session never reads them. */
	readonly excludeTurns?: boolean;
}

export interface ThreadResponse {
	readonly thread: { readonly id: string; readonly path?: string | null };
	readonly model: string;
	readonly modelProvider: string;
	readonly approvalPolicy: unknown;
	readonly sandbox: unknown;
}

export interface TextInput {
	readonly type: "text";
	readonly text: string;
	readonly text_elements: readonly unknown[];
}

/** `turn/start`. */
export interface TurnStartParams {
	readonly threadId: string;
	readonly input: readonly TextInput[];
	readonly model?: string | null;
}

export interface TurnStartResponse {
	readonly turn: Turn;
}

/** `turn/steer`: adds input to the running turn; fails when `expectedTurnId` is not the active turn. */
export interface TurnSteerParams {
	readonly threadId: string;
	readonly input: readonly TextInput[];
	readonly expectedTurnId: string;
}

/** `turn/interrupt`; the turn then completes with status `interrupted`. */
export interface TurnInterruptParams {
	readonly threadId: string;
	readonly turnId: string;
}

// -- Server notifications ------------------------------------------------------------------------

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnError {
	readonly message: string;
	readonly additionalDetails?: string | null;
}

export interface Turn {
	readonly id: string;
	readonly status: TurnStatus;
	readonly error: TurnError | null;
}

/** `turn/started`, `turn/completed`. */
export interface TurnNotification {
	readonly threadId: string;
	readonly turn: Turn;
}

/** `error`: a turn error; `willRetry` false means the turn will fail. */
export interface ErrorNotification {
	readonly error: TurnError;
	readonly willRetry: boolean;
	readonly threadId: string;
	readonly turnId: string;
}

/** `item/started`, `item/completed`. */
export interface ItemNotification {
	readonly threadId: string;
	readonly turnId: string;
	readonly item: ThreadItem;
}

/** `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`. */
export interface DeltaNotification {
	readonly threadId: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly delta: string;
}

/** `turn/plan/updated`. */
export interface PlanNotification {
	readonly threadId: string;
	readonly turnId: string;
	readonly explanation: string | null;
	readonly plan: readonly {
		readonly step: string;
		readonly status: "pending" | "inProgress" | "completed";
	}[];
}

export type ItemStatus = "inProgress" | "completed" | "failed" | "declined";

export interface FileUpdateChange {
	readonly path: string;
	readonly kind: {
		readonly type: "add" | "delete" | "update";
		readonly move_path?: string | null;
	};
	readonly diff: string;
}

/** The thread items the session maps; other item types pass through unread. */
export type ThreadItem =
	| {
			readonly type: "agentMessage";
			readonly id: string;
			readonly text: string;
	  }
	| {
			readonly type: "reasoning";
			readonly id: string;
			readonly summary: readonly string[];
			readonly content: readonly string[];
	  }
	| {
			readonly type: "commandExecution";
			readonly id: string;
			readonly command: string;
			readonly cwd: string;
			readonly status: ItemStatus;
			readonly aggregatedOutput: string | null;
			readonly exitCode: number | null;
	  }
	| {
			readonly type: "fileChange";
			readonly id: string;
			readonly changes: readonly FileUpdateChange[];
			readonly status: ItemStatus;
	  }
	| {
			readonly type: "mcpToolCall";
			readonly id: string;
			readonly server: string;
			readonly tool: string;
			readonly status: ItemStatus;
			readonly arguments: unknown;
			readonly result: { readonly content: readonly unknown[] } | null;
			readonly error: { readonly message: string } | null;
	  }
	| {
			readonly type: "dynamicToolCall";
			readonly id: string;
			readonly namespace: string | null;
			readonly tool: string;
			readonly arguments: unknown;
			readonly status: ItemStatus;
			readonly success: boolean | null;
	  }
	| { readonly type: "webSearch"; readonly id: string; readonly query: string }
	| { readonly type: string; readonly id: string };

// -- Server requests (approvals) -----------------------------------------------------------------

/**
 * Server-to-client requests the session answers. v2 approvals take `{ decision: 'accept' | 'decline' }`,
 * the legacy v1 ones (`execCommandApproval`, `applyPatchApproval`) take a `ReviewDecision`.
 */
export const APPROVAL_METHODS = {
	command: "item/commandExecution/requestApproval",
	fileChange: "item/fileChange/requestApproval",
	permissions: "item/permissions/requestApproval",
	elicitation: "mcpServer/elicitation/request",
	userInput: "item/tool/requestUserInput",
	legacyExec: "execCommandApproval",
	legacyPatch: "applyPatchApproval",
} as const;
