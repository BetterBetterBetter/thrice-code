import * as path from "node:path";
import * as vscode from "vscode";
import type { ChildRunInfo, ChildRunSink, ChildRunView } from "./agents";
import {
	describeTool,
	formatLabel,
	isRunAgentTool,
	stripWorkspaceCd,
	type AgentEvent,
	type ToolDescription,
} from "./events";
import { progressSuffix, ProgressThrottle } from "./liveEdits";

export interface FileChangeRecord {
	readonly path: string;
	readonly change: "add" | "update" | "delete";
}

interface ToolView {
	readonly id: string;
	readonly tool: string;
	input: unknown;
	label: string;
	readonly parentId?: string;
	pushed: boolean;
	done: boolean;
	/** Live " · N lines…" progress while a Write/Edit's content streams. */
	progress?: ProgressThrottle;
	/** Files this call changed, with the lines it alone added and removed when reported. */
	edits?: FileEdit[];
	/**
	 * A background runAgent call (wait false) returns at once, but its card stays running until
	 * the child finishes so it can be watched and opened. This holds the call's own result.
	 */
	deferredEnd?: Extract<AgentEvent, { kind: "toolEnd" }>;
	/** Set by the paired run's finished(); a deferred end is pushed at once after that. */
	childDone?: boolean;
}

interface FileEdit {
	readonly path: string;
	readonly change: "add" | "update" | "delete";
	readonly added?: number;
	readonly removed?: number;
}

/** The edit row's data class, or undefined in an app built before it existed (the row then stays plain). */
function fileEditDataCtor():
	| typeof vscode.ChatFileEditToolInvocationData
	| undefined {
	const ctor = (vscode as { ChatFileEditToolInvocationData?: unknown })
		.ChatFileEditToolInvocationData;
	return typeof ctor === "function"
		? (ctor as typeof vscode.ChatFileEditToolInvocationData)
		: undefined;
}

const FILE_KINDS = new Set(["read", "edit", "write", "delete", "list"]);

/**
 * Renders Contract 4 events into the chat response: tool calls as external tool invocations
 * (`ChatToolInvocationPart` with `enablePartialUpdate`), thinking via `thinkingProgress`,
 * Task/sub-agent calls as `ChatSubagentToolInvocationData` with child calls grouped under them.
 *
 * Read/search runs are grouped by the workbench itself into the collapsible "thinking" container
 * (setting `chat.agent.thinking.collapsedTools`), so no grouping is done here.
 */
/** A steering message as a quoted block: `> **You:** first line`, then each further line quoted. */
export function steeringMarkdown(prompt: string): string {
	const lines = prompt.trim().split(/\r?\n/);
	const quoted = lines.map((line, index) => `> ${index === 0 ? "**You:** " : ""}${line}`).join("\n");
	return `\n\n${quoted}\n\n`;
}

/** Whether a runAgent call's input asked to start in the background (wait false). */
export function isBackgroundRun(input: unknown): boolean {
	return !!input && typeof input === "object" && (input as Record<string, unknown>).wait === false;
}

export class ActivityRenderer implements ChildRunSink {
	private readonly tools = new Map<string, ToolView>();
	/** runAgent calls already paired with the run they started. */
	private readonly pairedRuns = new Set<string>();
	/** The provider each paired runAgent call started, for its logo. */
	private readonly runProviders = new Map<string, ChildRunInfo>();
	private readonly changes = new Map<string, FileChangeRecord>();
	private thinkingId: string | undefined;

	constructor(
		private readonly stream: vscode.ChatResponseStream,
		private readonly cwd: string,
		/** Called for every file change the agent reports (absolute path), as soon as it is seen. */
		private readonly onFileChange?: (change: FileChangeRecord) => void,
	) {}

	/** File changes the agent reported this turn, keyed by absolute path (last change wins). */
	fileChanges(): FileChangeRecord[] {
		return [...this.changes.values()];
	}

	handle(event: AgentEvent): void {
		switch (event.kind) {
			case "text":
				this.flushPending();
				this.thinkingId = undefined;
				this.stream.markdown(event.text);
				return;
			case "thinking":
				this.flushPending();
				this.thinkingId = event.id ?? this.thinkingId ?? "thinking";
				this.stream.thinkingProgress({ text: event.text, id: this.thinkingId });
				return;
			case "toolStart": {
				this.thinkingId = undefined;
				if (event.parentId) {
					const parent = this.tools.get(event.parentId);
					if (parent && !parent.pushed) {
						this.pushStart(parent);
					}
				}
				const view: ToolView = {
					id: event.id,
					tool: event.tool,
					input: event.input,
					label: event.label,
					parentId: event.parentId,
					pushed: false,
					done: false,
				};
				this.tools.set(event.id, view);
				if (this.isSpecific(view)) {
					this.pushStart(view);
				}
				return;
			}
			case "toolUpdate": {
				const view = this.tools.get(event.id);
				if (!view || view.done) {
					return;
				}
				if (event.input !== undefined) {
					view.input = event.input;
				}
				if (event.label) {
					view.label = event.label;
				}
				// The invocation message is fixed once pushed, so wait until it names the target.
				if (!view.pushed && this.isSpecific(view)) {
					this.pushStart(view);
				}
				if (event.streamedLines !== undefined) {
					this.progress(view, event.streamedLines);
				}
				return;
			}
			case "toolEnd": {
				const view = this.tools.get(event.id);
				if (!view || view.done) {
					return;
				}
				if (event.ok && !view.childDone && this.pairedRuns.has(view.id) && isBackgroundRun(view.input)) {
					view.deferredEnd = event;
					return;
				}
				if (!view.pushed) {
					this.pushStart(view);
				}
				view.done = true;
				this.pushEnd(view, event);
				return;
			}
			case "fileChange": {
				const absolute = this.absolute(event.path);
				const record: FileChangeRecord = {
					path: absolute,
					change: event.change,
				};
				this.changes.set(absolute, record);
				const view = event.toolId ? this.tools.get(event.toolId) : undefined;
				if (view) {
					(view.edits ??= []).push({
						path: absolute,
						change: event.change,
						added: event.added,
						removed: event.removed,
					});
				}
				try {
					this.onFileChange?.(record);
				} catch (error) {
					console.error("[thrice] file change hook failed", error);
				}
				return;
			}
		}
	}

	/**
	 * Pairs a run the bridge started with this turn's runAgent call that asked for it (same
	 * prompt, else the oldest unpaired call), and nests the child's tool calls under that call.
	 */
	started(run: ChildRunInfo): ChildRunView | undefined {
		const open = [...this.tools.values()].filter(
			(view) => isRunAgentTool(view.tool) && !this.pairedRuns.has(view.id),
		);
		const promptOf = (view: ToolView) => {
			const input =
				view.input && typeof view.input === "object"
					? (view.input as Record<string, unknown>)
					: {};
			return typeof input.prompt === "string" ? input.prompt.trim() : undefined;
		};
		const call =
			open.find((view) => promptOf(view) === run.prompt) ??
			open.find((view) => !view.done) ??
			open[0];
		if (!call) {
			return undefined;
		}
		this.pairedRuns.add(call.id);
		this.runProviders.set(call.id, run);
		// Re-sent with the provider so the card and the running row show the child's logo.
		if (call.pushed && !call.done) {
			this.pushStart(call);
		}
		const prefix = `${run.id}:`;
		return {
			event: (event) => {
				switch (event.kind) {
					case "toolStart":
						this.handle({
							...event,
							id: prefix + event.id,
							parentId: event.parentId ? prefix + event.parentId : call.id,
						});
						return;
					case "toolUpdate":
					case "toolEnd":
						this.handle({ ...event, id: prefix + event.id });
						return;
					case "fileChange":
						this.handle(
							event.toolId
								? { ...event, toolId: prefix + event.toolId }
								: event,
						);
						return;
					default:
						// The child's answer comes back as the runAgent result.
						return;
				}
			},
			finished: () => {
				for (const view of this.tools.values()) {
					if (view.id.startsWith(prefix) && !view.done) {
						if (!view.pushed) {
							this.pushStart(view);
						}
						view.done = true;
						this.pushEnd(view, { kind: "toolEnd", id: view.id, ok: false });
					}
				}
				call.childDone = true;
				const deferred = call.deferredEnd;
				if (deferred && !call.done) {
					call.deferredEnd = undefined;
					if (!call.pushed) {
						this.pushStart(call);
					}
					call.done = true;
					this.pushEnd(call, deferred);
				}
			},
		};
	}

	/** Shows a steering message where it joined the running turn, as the CLI does. */
	steered(prompt: string): void {
		this.flushPending();
		this.thinkingId = undefined;
		this.stream.markdown(steeringMarkdown(prompt));
	}

	/** Marks tools that never reported a result as finished so no spinner is left behind. */
	finish(): void {
		for (const view of this.tools.values()) {
			if (!view.done) {
				if (!view.pushed) {
					this.pushStart(view);
				}
				view.done = true;
				this.pushEnd(view, view.deferredEnd ?? { kind: "toolEnd", id: view.id, ok: false });
			}
		}
	}

	private flushPending(): void {
		for (const view of this.tools.values()) {
			if (!view.pushed && !view.done) {
				this.pushStart(view);
			}
		}
	}

	private isSpecific(view: ToolView): boolean {
		const description = describeTool(view.tool, view.input, this.cwd);
		return (
			description.kind === "todo" ||
			description.kind === "plan" ||
			!!description.target
		);
	}

	private absolute(file: string): string {
		return path.isAbsolute(file) ? file : path.join(this.cwd, file);
	}

	/** Streamed line count for an in-progress Write/Edit: re-sends the running card, throttled. */
	private progress(view: ToolView, lines: number): void {
		const kind = describeTool(view.tool, view.input, this.cwd).kind;
		if (kind !== "write" && kind !== "edit") {
			return;
		}
		view.progress ??= new ProgressThrottle(() => {
			// Before the target is known the card is not shown yet; pushStart picks the count up then.
			if (view.pushed && !view.done) {
				this.pushStart(view);
			}
		});
		view.progress.update(lines);
	}

	private message(
		description: ToolDescription,
		view: ToolView,
		tense: "present" | "past",
		suffix = "",
	): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = false;
		if (description.path && FILE_KINDS.has(description.kind)) {
			const uri = vscode.Uri.file(this.absolute(description.path));
			const fragment =
				description.startLine !== undefined
					? `L${description.startLine}${description.endLine !== undefined ? `-L${description.endLine}` : ""}`
					: "";
			const target = fragment ? uri.with({ fragment }) : uri;
			const verb = tense === "present" ? description.present : description.past;
			const lines =
				description.startLine !== undefined
					? description.endLine !== undefined
						? `, lines ${description.startLine}-${description.endLine}`
						: `, from line ${description.startLine}`
					: "";
			// An empty link text renders as a clickable file widget in chat.
			md.appendMarkdown(`${verb} [](${target.toString()})${lines}${suffix}`);
			return md;
		}
		const label =
			tense === "present" && view.label
				? view.label
				: formatLabel(description, tense);
		md.appendMarkdown(`${label}${suffix}`);
		return md;
	}

	private part(
		view: ToolView,
		complete: boolean,
	): vscode.ChatToolInvocationPart {
		const part = new vscode.ChatToolInvocationPart(view.tool, view.id);
		part.enablePartialUpdate = true;
		part.isComplete = complete;
		if (view.parentId && this.tools.get(view.parentId)?.pushed) {
			part.subAgentInvocationId = view.parentId;
		}
		return part;
	}

	private pushStart(view: ToolView): void {
		view.pushed = true;
		const description = describeTool(view.tool, view.input, this.cwd);
		const part = this.part(view, false);
		const lines = view.progress?.current();
		part.invocationMessage = this.message(
			description,
			view,
			"present",
			lines ? progressSuffix(lines) : "",
		);
		if (!isTerminal(description)) {
			part.pastTenseMessage = this.message(description, view, "past");
		}
		const data = this.specificData(description, view, undefined);
		if (data) {
			part.toolSpecificData = data;
		}
		this.stream.push(part);
	}

	private pushEnd(
		view: ToolView,
		end: Extract<AgentEvent, { kind: "toolEnd" }>,
	): void {
		view.progress?.stop();
		const description = describeTool(view.tool, view.input, this.cwd);
		const part = this.part(view, true);
		let suffix = "";
		if (description.kind === "run" && end.exitCode !== undefined) {
			suffix = end.exitCode === 0 ? "" : ` (exit ${end.exitCode})`;
		} else if (!end.ok) {
			suffix = " (failed)";
		}
		part.isError = !end.ok;
		// The terminal card already shows the command and its exit status; a past-tense message
		// would be rendered again inside the card body under the command.
		if (!isTerminal(description)) {
			part.pastTenseMessage = this.message(description, view, "past", suffix);
		}
		const data = this.specificData(description, view, end);
		if (data) {
			part.toolSpecificData = data;
		}
		this.stream.push(part);
	}

	private specificData(
		description: ToolDescription,
		view: ToolView,
		end: Extract<AgentEvent, { kind: "toolEnd" }> | undefined,
	): vscode.ChatToolInvocationPart["toolSpecificData"] {
		const input =
			view.input && typeof view.input === "object"
				? (view.input as Record<string, unknown>)
				: {};
		if (description.kind === "run" && description.command) {
			const data: vscode.ChatTerminalToolInvocationData = {
				commandLine: { original: description.command },
				language: "sh",
			};
			const shown = stripWorkspaceCd(description.command, this.cwd);
			if (shown !== description.command) {
				data.presentationOverrides = { commandLine: shown };
			}
			if (typeof input.description === "string" && input.description.trim()) {
				data.intention = input.description.trim();
			}
			if (end) {
				if (end.output !== undefined) {
					// The output view is a terminal emulator: a bare LF moves down without returning
					// to column 0, which staircases every line after the first.
					data.output = { text: end.output.replace(/\r?\n/g, "\r\n") };
				}
				data.state = { exitCode: end.exitCode ?? (end.ok ? 0 : 1) };
			}
			return data;
		}
		if (
			description.kind === "agent" &&
			!view.parentId &&
			isRunAgentTool(view.tool)
		) {
			const run = this.runProviders.get(view.id);
			const agent = typeof input.agent === "string" ? input.agent : run?.agent;
			const prompt =
				typeof input.prompt === "string" ? input.prompt : run?.prompt;
			const data = new vscode.ChatSubagentToolInvocationData(
				prompt ? firstLine(prompt) : agent,
				agent,
				prompt,
				end?.output,
			);
			const model = typeof input.model === "string" ? input.model : run?.model;
			if (model) {
				data.modelName = model;
			}
			if (agent) {
				data.chatProvider = agent;
			}
			return data;
		}
		if (description.kind === "agent" && !view.parentId) {
			const data = new vscode.ChatSubagentToolInvocationData(
				typeof input.description === "string"
					? input.description
					: description.target,
				typeof input.subagent_type === "string"
					? input.subagent_type
					: undefined,
				typeof input.prompt === "string" ? input.prompt : undefined,
				end?.output,
			);
			return data;
		}
		if (description.kind === "todo") {
			const todos = todoItems(input);
			return todos.length ? { todoList: todos } : undefined;
		}
		if (
			description.kind === "edit" ||
			description.kind === "write" ||
			description.kind === "delete"
		) {
			return this.fileEditData(description, view, input, end);
		}
		return undefined;
	}

	/**
	 * The edit row's file and the lines this call added and removed. While the call runs, or when
	 * the agent did not report counts, they are 0. A call that changed several files (a Codex patch)
	 * shows its first. A failed call reports no file.
	 */
	private fileEditData(
		description: ToolDescription,
		view: ToolView,
		input: Record<string, unknown>,
		end: Extract<AgentEvent, { kind: "toolEnd" }> | undefined,
	): vscode.ChatToolInvocationPart["toolSpecificData"] {
		const Ctor = fileEditDataCtor();
		if (!Ctor || (end && !end.ok)) {
			return undefined;
		}
		const edit = view.edits?.[0];
		const file = edit?.path ?? editTarget(input);
		if (!file) {
			return undefined;
		}
		const change =
			edit?.change ?? (description.kind === "delete" ? "delete" : "update");
		return new Ctor(
			vscode.Uri.file(this.absolute(file)),
			edit?.added ?? 0,
			edit?.removed ?? 0,
			change,
		);
	}
}

/** The file an edit tool's input names. */
function editTarget(input: Record<string, unknown>): string | undefined {
	for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
		const value = input[key];
		if (typeof value === "string" && value) {
			return value;
		}
	}
	return undefined;
}

/** A sub-agent card title: the prompt's first line, cut to a short label. */
function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/)[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Bash-style calls are drawn as terminal cards (see `specificData`). */
function isTerminal(description: ToolDescription): boolean {
	return description.kind === "run" && !!description.command;
}

function todoItems(
	input: Record<string, unknown>,
): vscode.ChatTodoToolInvocationData["todoList"] {
	const list = Array.isArray(input.todos)
		? input.todos
		: Array.isArray(input.items)
			? input.items
			: [];
	const result: vscode.ChatTodoToolInvocationData["todoList"] = [];
	list.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") {
			return;
		}
		const item = entry as Record<string, unknown>;
		const title =
			typeof item.content === "string"
				? item.content
				: typeof item.text === "string"
					? item.text
					: "";
		if (!title) {
			return;
		}
		const status =
			item.status === "completed" || item.completed === true
				? vscode.ChatTodoStatus.Completed
				: item.status === "in_progress"
					? vscode.ChatTodoStatus.InProgress
					: vscode.ChatTodoStatus.NotStarted;
		result.push({ id: index + 1, title, status });
	});
	return result;
}
