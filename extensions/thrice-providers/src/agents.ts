import type { AgentEvent } from "./events";

/**
 * Agents started by another agent through the thrice MCP server. Kept free of `vscode` so the
 * bookkeeping can be tested with node:test; the extension supplies the launcher.
 */

export const AGENT_TOOL_NAMES = {
	list: "listAgents",
	run: "runAgent",
	wait: "waitAgent",
	stop: "stopAgent",
	send: "sendAgent",
} as const;

export const AGENT_MODES = [
	"background",
	"interactive",
	"plan",
	"ask",
	"debug",
	"spec",
	"triage",
] as const;

/** Longest a single blocking call waits before handing back a run id. */
export const MAX_WAIT_MS = 50 * 60 * 1000;
const DEFAULT_RUN_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_WAIT_MS = 30 * 1000;
const MAX_OUTPUT_CHARS = 20000;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

const LIST_TOOL = {
	name: AGENT_TOOL_NAMES.list,
	description:
		"List the agent providers configured in this editor (for example Claude Hub, Codex Hub, Grok Hub), their models, whether each can start, which one you are, and the agents you have started. These are the user's providers, separate from any sub-agents built into your own CLI.",
	inputSchema: { type: "object", properties: {}, required: [] as string[] },
};

const RUN_TOOL = {
	name: AGENT_TOOL_NAMES.run,
	description:
		"Start another agent on one of this editor's providers (ids from listAgents) with a self-contained prompt. It works in the same folder and returns its final answer. Set wait to false to start it in the background and get a run id, then call waitAgent. Start several with wait false to run them in parallel.",
	inputSchema: {
		type: "object",
		properties: {
			agent: str("Provider id from listAgents, such as codex-hub."),
			prompt: str(
				"Everything the agent needs. It does not see this conversation.",
			),
			model: str("Model id from listAgents. Omit for the provider default."),
			mode: {
				type: "string",
				enum: [...AGENT_MODES],
				description:
					"background (default) finishes without asking; ask, plan, spec and triage do not change files.",
			},
			working_directory: str(
				"Absolute folder to run in. Omit to use your folder.",
			),
			wait: {
				type: "boolean",
				description: "False returns a run id at once. Defaults to true.",
			},
			timeout_ms: num(
				`How long to wait before returning the run id instead (default ${DEFAULT_RUN_WAIT_MS}, max ${MAX_WAIT_MS}). The agent keeps running.`,
			),
		},
		required: ["agent", "prompt"],
	},
};

const WAIT_TOOL = {
	name: AGENT_TOOL_NAMES.wait,
	description:
		"Wait for an agent you started to finish and return its answer, or its progress so far when timeout_ms passes. timeout_ms 0 only reads its state.",
	inputSchema: {
		type: "object",
		properties: {
			id: str("Run id from runAgent."),
			timeout_ms: num(
				`How long to wait (default ${DEFAULT_POLL_WAIT_MS}, max ${MAX_WAIT_MS}).`,
			),
		},
		required: ["id"],
	},
};

const SEND_TOOL = {
	name: AGENT_TOOL_NAMES.send,
	description:
		"Send a follow-up to an agent you started, after it finished a turn. It continues its own session, remembering what it already did and read, and returns its answer. Use it to ask the agent to check, explain or go further instead of starting a new one. Agents you started stop when your turn ends.",
	inputSchema: {
		type: "object",
		properties: {
			id: str("Run id from runAgent."),
			prompt: str("The follow-up. The agent remembers its earlier turns."),
			wait: {
				type: "boolean",
				description:
					"False returns at once; then call waitAgent. Defaults to true.",
			},
			timeout_ms: num(
				`How long to wait before returning instead (default ${DEFAULT_RUN_WAIT_MS}, max ${MAX_WAIT_MS}). The agent keeps running.`,
			),
		},
		required: ["id", "prompt"],
	},
};

const STOP_TOOL = {
	name: AGENT_TOOL_NAMES.stop,
	description: "Stop an agent you started.",
	inputSchema: {
		type: "object",
		properties: { id: str("Run id from runAgent.") },
		required: ["id"],
	},
};

/** Tools a launch sees. Below the depth limit it can start agents; at the limit it can only look. */
export function agentTools(
	canSpawn: boolean,
): readonly { name: string; description: string; inputSchema: unknown }[] {
	return canSpawn
		? [LIST_TOOL, RUN_TOOL, WAIT_TOOL, SEND_TOOL, STOP_TOOL]
		: [LIST_TOOL];
}

export const AGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(
	Object.values(AGENT_TOOL_NAMES),
);

export function agentToolNote(prefix: string): string {
	return `To hand work to another of the user's providers, such as Codex Hub or Claude Hub, call ${prefix}listAgents, then ${prefix}runAgent; to follow up with one you started, call ${prefix}sendAgent. When the user names one of those providers, use these tools, not a sub-agent built into your CLI.`;
}

/** What a chat shows about one agent its own agent started. */
export interface ChildRunInfo {
	readonly id: string;
	readonly agent: string;
	readonly displayName: string;
	readonly model?: string;
	readonly mode: string;
	readonly prompt: string;
}

/** Child activity, nested under the runAgent call that started it. */
export interface ChildRunView {
	event(event: AgentEvent): void;
	finished(): void;
}

/** Implemented by the chat renderer of a turn; the bridge reports each run its agent starts. */
export interface ChildRunSink {
	started(run: ChildRunInfo): ChildRunView | undefined;
}

export type AgentRunStatus = "running" | "done" | "failed" | "cancelled";

export interface AgentRunSpec {
	readonly agent: string;
	readonly displayName: string;
	readonly model?: string;
	readonly mode: string;
	readonly prompt: string;
	/** The launch that started this run. Its runs stop when it exits. */
	readonly owner: string;
	readonly depth: number;
	/** Whether sendAgent can continue this run's CLI session. */
	readonly resumable: boolean;
}

export interface AgentRun extends AgentRunSpec {
	readonly id: string;
	/** When the current turn started. */
	startedAt: number;
	/** 1 for the first turn, one more for each sendAgent follow-up. */
	turns: number;
	status: AgentRunStatus;
	endedAt?: number;
	error?: string;
	text: string;
	tools: number;
	lastActivity?: string;
}

export interface AgentRunSink {
	/** Id of the run this turn belongs to. Known before the launcher runs, unlike the `AgentRun` that `start` returns. */
	readonly runId: string;
	text(chunk: string): void;
	activity(label: string): void;
}

export interface AgentLaunchHandle {
	readonly done: Promise<void>;
	stop(): void;
}

export interface WaitCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export class AgentRuns {
	private readonly runs = new Map<string, AgentRun>();
	private readonly stops = new Map<string, () => void>();
	private readonly finished = new Map<string, Promise<void>>();
	private next = 1;
	private readonly onChange?: (run: AgentRun) => void;

	constructor(onChange?: (run: AgentRun) => void) {
		this.onChange = onChange;
	}

	running(): number {
		let count = 0;
		for (const run of this.runs.values()) {
			if (run.status === "running") {
				count++;
			}
		}
		return count;
	}

	start(
		spec: AgentRunSpec,
		launch: (sink: AgentRunSink) => AgentLaunchHandle,
	): AgentRun {
		const run: AgentRun = {
			...spec,
			id: `agent-${this.next++}`,
			startedAt: Date.now(),
			turns: 1,
			status: "running",
			text: "",
			tools: 0,
		};
		this.runs.set(run.id, run);
		this.launchTurn(run, launch);
		return run;
	}

	/**
	 * Starts another turn on a finished, resumable run (sendAgent). The run keeps its id; its
	 * text, tool count and timing are for the new turn. False when that is not possible.
	 */
	resume(
		id: string,
		launch: (sink: AgentRunSink) => AgentLaunchHandle,
	): boolean {
		const run = this.runs.get(id);
		if (!run || run.status === "running" || !run.resumable) {
			return false;
		}
		run.turns++;
		run.startedAt = Date.now();
		run.endedAt = undefined;
		run.error = undefined;
		run.lastActivity = undefined;
		run.status = "running";
		run.text = "";
		run.tools = 0;
		this.launchTurn(run, launch);
		return true;
	}

	private launchTurn(
		run: AgentRun,
		launch: (sink: AgentRunSink) => AgentLaunchHandle,
	): void {
		// A late result from an earlier turn must not settle the current one.
		const turn = run.turns;
		let handle: AgentLaunchHandle;
		try {
			handle = launch({
				runId: run.id,
				text: (chunk) => {
					run.text += chunk;
					if (run.text.length > MAX_OUTPUT_CHARS * 2) {
						run.text = run.text.slice(-MAX_OUTPUT_CHARS);
					}
				},
				activity: (label) => {
					run.tools++;
					run.lastActivity = label;
				},
			});
		} catch (error) {
			this.settle(run, turn, "failed", error);
			this.finished.set(run.id, Promise.resolve());
			return;
		}
		this.stops.set(run.id, () => handle.stop());
		this.onChange?.(run);
		this.finished.set(
			run.id,
			handle.done.then(
				() =>
					this.settle(
						run,
						turn,
						run.status === "cancelled" ? "cancelled" : "done",
					),
				(error) =>
					this.settle(
						run,
						turn,
						run.status === "cancelled" ? "cancelled" : "failed",
						error,
					),
			),
		);
	}

	private settle(
		run: AgentRun,
		turn: number,
		status: AgentRunStatus,
		error?: unknown,
	): void {
		if (run.endedAt !== undefined || run.turns !== turn) {
			return;
		}
		run.status = status;
		run.endedAt = Date.now();
		if (error !== undefined && status !== "cancelled") {
			run.error = error instanceof Error ? error.message : String(error);
		}
		this.stops.delete(run.id);
		this.onChange?.(run);
	}

	get(id: string): AgentRun | undefined {
		return this.runs.get(id);
	}

	ownedBy(owner: string): AgentRun[] {
		return [...this.runs.values()].filter((run) => run.owner === owner);
	}

	stop(id: string): boolean {
		const run = this.runs.get(id);
		const stop = this.stops.get(id);
		if (!run || run.status !== "running" || !stop) {
			return false;
		}
		run.status = "cancelled";
		stop();
		return true;
	}

	/** Stops a launch's running agents and forgets its finished ones. Returns the ids it let go. */
	release(owner: string): string[] {
		const released: string[] = [];
		for (const run of this.ownedBy(owner)) {
			this.stop(run.id);
			if (run.status !== "running") {
				this.runs.delete(run.id);
				this.finished.delete(run.id);
				released.push(run.id);
			}
		}
		return released;
	}

	/** Resolves when the run ends, the timeout passes, or the wait is cancelled. */
	async wait(
		id: string,
		timeoutMs: number,
		cancellation?: WaitCancellation,
	): Promise<AgentRun | undefined> {
		const run = this.runs.get(id);
		const finished = this.finished.get(id);
		if (
			!run ||
			!finished ||
			run.status !== "running" ||
			timeoutMs <= 0 ||
			cancellation?.isCancellationRequested
		) {
			return run;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let subscription: { dispose(): void } | undefined;
		try {
			await Promise.race([
				finished,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
				}),
				new Promise<void>((resolve) => {
					subscription = cancellation?.onCancellationRequested(resolve);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			subscription?.dispose();
		}
		return run;
	}
}

const READ_ONLY_MODES: ReadonlySet<string> = new Set([
	"plan",
	"ask",
	"spec",
	"triage",
]);

/**
 * The mode a child runs in: what was asked for (background when nothing valid was), except that a
 * read-only parent only starts read-only children, in its own mode.
 */
export function childMode(
	parentMode: string | undefined,
	requested: unknown,
): { readonly mode: string; readonly forced: boolean } {
	const asked =
		typeof requested === "string" &&
		(AGENT_MODES as readonly string[]).includes(requested)
			? requested
			: "background";
	if (
		parentMode &&
		READ_ONLY_MODES.has(parentMode) &&
		!READ_ONLY_MODES.has(asked)
	) {
		return { mode: parentMode, forced: true };
	}
	return { mode: asked, forced: false };
}

export function waitMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(value)));
}

export const DEFAULT_WAITS = {
	run: DEFAULT_RUN_WAIT_MS,
	poll: DEFAULT_POLL_WAIT_MS,
};

function seconds(run: AgentRun, now: number): string {
	return `${Math.round(((run.endedAt ?? now) - run.startedAt) / 1000)}s`;
}

export function formatRun(run: AgentRun, now = Date.now()): string {
	const model = run.model ? ` (${run.model})` : "";
	const turn = run.turns > 1 ? ` (turn ${run.turns})` : "";
	const head = `Run ${run.id}${turn}: ${run.displayName}${model}, ${run.status} after ${seconds(run, now)}, ${run.tools} tool calls.`;
	const text = run.text.trim();
	const body =
		text.length > MAX_OUTPUT_CHARS ? `…${text.slice(-MAX_OUTPUT_CHARS)}` : text;
	if (run.status === "running") {
		const activity = run.lastActivity
			? ` Last activity: ${run.lastActivity}.`
			: "";
		return `${head}${activity} Still running: call waitAgent with id ${run.id} for the answer, or stopAgent to end it.${body ? `\n\nOutput so far:\n${body}` : ""}`;
	}
	if (run.status === "failed") {
		return `${head}\n\nError: ${run.error ?? "unknown failure"}${body ? `\n\nOutput before it failed:\n${body}` : ""}`;
	}
	const followUp =
		run.status === "done" && run.resumable
			? `\n\nTo follow up, call sendAgent with id ${run.id}.`
			: "";
	return body
		? `${head}\n\n${body}${followUp}`
		: `${head} It returned no text.${followUp}`;
}

export interface AgentListing {
	readonly id: string;
	readonly displayName: string;
	readonly driver: string;
	readonly models: readonly { readonly id: string; readonly name: string }[];
	/** Environment variables the provider needs and does not have. */
	readonly missing: readonly string[];
}

export interface AgentListContext {
	readonly self?: { readonly agent?: string; readonly model?: string };
	readonly depth: number;
	readonly maxDepth: number;
	readonly running: number;
	readonly maxRunning: number;
	readonly runs: readonly AgentRun[];
}

export function formatAgentList(
	agents: readonly AgentListing[],
	context: AgentListContext,
	now = Date.now(),
): string {
	const lines = ["Agent providers in this editor:"];
	for (const agent of agents) {
		const you =
			context.self?.agent === agent.id
				? ` (you${context.self.model ? `, ${context.self.model}` : ""})`
				: "";
		const state = agent.missing.length
			? `cannot start: needs ${agent.missing.join(", ")}`
			: "ready";
		lines.push(
			`- ${agent.id}: ${agent.displayName}${you}, ${agent.driver} CLI, ${state}.`,
		);
		if (agent.models.length) {
			lines.push(
				`  models: ${agent.models.map((model) => (model.id === model.name ? model.id : `${model.id} (${model.name})`)).join(", ")}`,
			);
		}
	}
	if (agents.length === 0) {
		lines.push("- none are enabled.");
	}
	const canSpawn = context.depth < context.maxDepth;
	lines.push("");
	lines.push(
		canSpawn
			? `You can start agents with runAgent. You are at depth ${context.depth} of ${context.maxDepth}; ${context.running} of ${context.maxRunning} agents are running.`
			: `You cannot start agents: you are at depth ${context.depth} and the limit is ${context.maxDepth} (setting thrice.agents.maxDepth).`,
	);
	if (context.runs.length) {
		lines.push("", "Agents you started:");
		for (const run of context.runs) {
			lines.push(
				`- ${run.id}: ${run.displayName}${run.model ? ` (${run.model})` : ""}, ${run.status}, ${seconds(run, now)}.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * A sendAgent turn. When the CLI kept the session it gets just the follow-up; when it had to start
 * fresh (the process and its session were lost) it gets the original task again first.
 */
export function followUpPrompt(
	message: string,
	original: string,
	parent: { readonly displayName?: string; readonly depth: number },
	fresh: boolean,
): string {
	const from = parent.displayName
		? `the agent that started you (${parent.displayName})`
		: "the agent that started you";
	const followUp = `Follow-up from ${from}. Nobody else will answer, so finish on your own and end with a complete final answer.\n\n${message}`;
	return fresh ? `${childPrompt(original, parent)}\n\n${followUp}` : followUp;
}

export function childPrompt(
	prompt: string,
	parent: { readonly displayName?: string; readonly depth: number },
): string {
	const from = parent.displayName
		? `another agent (${parent.displayName})`
		: "another agent";
	return `You were started by ${from} in this editor as a sub-agent at depth ${parent.depth + 1}. Nobody will answer questions, so finish on your own and end with a complete final answer for that agent.\n\n${prompt}`;
}
