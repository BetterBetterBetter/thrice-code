/**
 * Typed decoder for the agent CLIs' JSON output (Contract 4 in docs/agent-review-contract.md).
 *
 * The mapping follows the standalone host in `thrice-providers/src/events.js` (Claude and Codex),
 * extended with partial tool input, thinking, sub-agents, Cursor and OpenCode tool parts.
 *
 * This module has no runtime imports so that `node --test` can load it directly.
 */
import type { Driver } from "./instances";
import { resolve as resolvePath } from "node:path";

export type AgentEvent =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; id?: string }
	/** `parentId` is an addition to Contract 4: the id of the sub-agent tool call that issued this call. */
	| {
			kind: "toolStart";
			id: string;
			tool: string;
			label: string;
			input?: unknown;
			parentId?: string;
	  }
	/** `streamedLines` (addition): lines of file content streamed so far for a Write/Edit whose input is still arriving. */
	| {
			kind: "toolUpdate";
			id: string;
			label?: string;
			input?: unknown;
			streamedLines?: number;
	  }
	| {
			kind: "toolEnd";
			id: string;
			ok: boolean;
			output?: string;
			exitCode?: number;
	  }
	/**
	 * A file the agent changed. `toolId` is the tool call that changed it; `added`/`removed` are the
	 * lines that call alone added and removed, when the agent reported them. Sent before that call's
	 * `toolEnd`, so the finished tool row can show them.
	 */
	| {
			kind: "fileChange";
			path: string;
			change: "add" | "update" | "delete";
			toolId?: string;
			added?: number;
			removed?: number;
	  };

export interface EventDecoder {
	push(line: string): AgentEvent[];
	failure(): string | undefined;
}

export interface DecoderOptions {
	/** Used to show paths relative to the workspace in labels. */
	readonly cwd?: string;
}

const OUTPUT_LIMIT = 8000;

type Json = Record<string, unknown>;

function parsed(line: string): Json | undefined {
	try {
		const value = JSON.parse(line) as unknown;
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function cap(text: string): string {
	return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}…`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				isObject(block)
					? str(block.text)
					: typeof block === "string"
						? block
						: "",
			)
			.join("");
	}
	if (isObject(content)) {
		return str(content.text) || str(content.output);
	}
	return "";
}

/** Returns the part of `text` not yet emitted, given what was emitted before for the same key. */
function suffixFor(
	seen: Map<string, string>,
	key: string,
	text: string,
): string {
	const previous = seen.get(key) ?? "";
	const suffix =
		previous && text.startsWith(previous)
			? text.slice(previous.length)
			: previous && previous.startsWith(text)
				? ""
				: text;
	seen.set(key, previous && text.startsWith(previous) ? text : previous + text);
	return suffix;
}

// ---------------------------------------------------------------------------------------------
// Tool descriptions (shared by the decoder labels and the chat renderer)
// ---------------------------------------------------------------------------------------------

export type ToolKind =
	| "read"
	| "search"
	| "list"
	| "run"
	| "edit"
	| "write"
	| "delete"
	| "agent"
	| "web"
	| "todo"
	| "mcp"
	| "plan"
	| "other";

export interface ToolDescription {
	readonly kind: ToolKind;
	/** Present tense verb phrase, e.g. "Reading". */
	readonly present: string;
	/** Past tense verb phrase, e.g. "Read". */
	readonly past: string;
	/** What the tool acts on, shown in code style (file path, pattern, command, url...). */
	readonly target?: string;
	/** Absolute or as-given file path when the target is a file. */
	readonly path?: string;
	readonly startLine?: number;
	readonly endLine?: number;
	/** Plain text after the target, e.g. "in `src`". */
	readonly detail?: string;
	/** Full command line for `run` tools. */
	readonly command?: string;
}

const TOOL_ALIASES: Record<string, string> = {
	read: "Read",
	read_file: "Read",
	readfile: "Read",
	view: "Read",
	cat: "Read",
	write: "Write",
	write_file: "Write",
	create: "Write",
	create_file: "Write",
	edit: "Edit",
	edit_file: "Edit",
	str_replace: "Edit",
	str_replace_based_edit_tool: "Edit",
	patch: "Edit",
	apply_patch: "Edit",
	file_change: "Edit",
	multiedit: "MultiEdit",
	multi_edit: "MultiEdit",
	notebookedit: "NotebookEdit",
	delete: "Delete",
	delete_file: "Delete",
	rm: "Delete",
	bash: "Bash",
	shell: "Bash",
	sh: "Bash",
	command: "Bash",
	command_execution: "Bash",
	exec: "Bash",
	run_terminal_cmd: "Bash",
	grep: "Grep",
	search: "Grep",
	rg: "Grep",
	codebase_search: "Grep",
	glob: "Glob",
	find: "Glob",
	file_search: "Glob",
	ls: "LS",
	list: "LS",
	list_dir: "LS",
	webfetch: "WebFetch",
	fetch: "WebFetch",
	web_fetch: "WebFetch",
	websearch: "WebSearch",
	web_search: "WebSearch",
	task: "Task",
	agent: "Task",
	subagent: "Task",
	todowrite: "TodoWrite",
	todo_write: "TodoWrite",
	todo_list: "TodoWrite",
	todoread: "TodoRead",
	update_todos: "TodoWrite",
	todo: "TodoWrite",
	exitplanmode: "ExitPlanMode",
};

/** Maps CLI-specific tool names to the Claude names used for labels. Unknown names pass through. */
export function canonicalTool(name: string): string {
	if (name.startsWith("mcp__")) {
		return name;
	}
	return TOOL_ALIASES[name.toLowerCase()] ?? name;
}

function pick(input: Json, ...keys: string[]): string {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value) {
			return value;
		}
	}
	return "";
}

function pickNumber(input: Json, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = num(input[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

export function displayPath(path: string, cwd?: string): string {
	if (!cwd || !path) {
		return path;
	}
	const base = cwd.replace(/[\\/]+$/, "");
	if (path === base) {
		return ".";
	}
	if (path.startsWith(base + "/") || path.startsWith(base + "\\")) {
		return path.slice(base.length + 1);
	}
	return path;
}

/** Removes the `bash -lc '...'` wrapper Codex puts around commands. */
export function unwrapShell(command: string): string {
	const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(
		command.trim(),
	);
	if (!match) {
		return command.trim();
	}
	const body = match[1].trim();
	if (
		body.length >= 2 &&
		(body[0] === "'" || body[0] === '"') &&
		body.endsWith(body[0])
	) {
		const inner = body.slice(1, -1);
		return body[0] === "'"
			? inner.replace(/'\\''/g, "'")
			: inner.replace(/\\(["\\$`])/g, "$1");
	}
	return body;
}

function shortCommand(command: string): string {
	const first = command.split(/\r?\n/)[0].trim();
	const short = first.length > 80 ? `${first.slice(0, 79)}…` : first;
	return command.includes("\n") && short === first ? `${short} …` : short;
}

function asInput(input: unknown): Json {
	if (isObject(input)) {
		return input;
	}
	if (typeof input === "string") {
		const value = parsed(input);
		if (value) {
			return value;
		}
	}
	return {};
}

/**
 * runAgent or sendAgent on the thrice MCP server, as Claude and Codex (`mcp__thrice__runAgent`)
 * or OpenCode (`thrice_runAgent`) name them. Both start a child turn shown under the call.
 */
export function isRunAgentTool(name: string): boolean {
	return (
		name === "mcp__thrice__runAgent" ||
		name === "thrice_runAgent" ||
		isSendAgentTool(name)
	);
}

export function isSendAgentTool(name: string): boolean {
	return name === "mcp__thrice__sendAgent" || name === "thrice_sendAgent";
}

/**
 * The tool's own name when it comes from the editor's built-in `thrice` MCP server
 * (`mcp__thrice__openEditor` from Claude and Codex, `thrice_openEditor` from OpenCode).
 */
export function thriceToolName(name: string): string | undefined {
	if (name.startsWith("mcp__thrice__")) {
		return name.slice("mcp__thrice__".length);
	}
	if (name.startsWith("thrice_")) {
		return name.slice("thrice_".length);
	}
	return undefined;
}

/**
 * The editor's own tools read as editor actions ("Opened foo.ts", "Read terminal 3"), not as
 * calls to an MCP server. Undefined for names this does not know, which keep the MCP label.
 */
function describeEditorTool(
	tool: string,
	args: Json,
	path: string,
	shown: string,
	cwd: string | undefined,
): ToolDescription | undefined {
	const terminal = pickNumber(args, "id");
	const terminalTarget =
		terminal !== undefined ? `terminal ${terminal}` : "terminal";
	const port = pickNumber(args, "port");
	switch (tool) {
		case "agentWindowShell": {
			const command = pick(args, "command");
			return {
				kind: "run",
				present: "Running",
				past: "Ran",
				target: command ? shortCommand(command) : undefined,
				command: command || undefined,
			};
		}
		case "spawnTerminal": {
			const command = pick(args, "command");
			return {
				kind: "other",
				present: "Opening terminal",
				past: "Opened terminal",
				target: command ? shortCommand(command) : undefined,
			};
		}
		case "readTerminal":
			return {
				kind: "other",
				present: "Reading",
				past: "Read",
				target: terminalTarget,
			};
		case "waitTerminal":
			return {
				kind: "other",
				present: "Watching",
				past: "Watched",
				target: terminalTarget,
			};
		case "writeTerminal": {
			const text = pick(args, "text");
			return {
				kind: "other",
				present: `Typing into ${terminalTarget}`,
				past: `Typed into ${terminalTarget}`,
				target: text ? shortCommand(text) : undefined,
			};
		}
		case "closeTerminal":
			return {
				kind: "other",
				present: "Closing",
				past: "Closed",
				target: terminalTarget,
			};
		case "listTerminals":
			return {
				kind: "other",
				present: "Listing terminals",
				past: "Listed terminals",
			};
		case "sessionContext":
			return {
				kind: "other",
				present: "Reading window context",
				past: "Read window context",
			};
		case "listEditors":
			return {
				kind: "other",
				present: "Listing open editors",
				past: "Listed open editors",
			};
		case "readEditor":
			return {
				kind: "read",
				present: "Reading",
				past: "Read",
				target: shown || undefined,
				path: path || undefined,
			};
		case "openEditor":
			return {
				kind: "read",
				present: "Opening",
				past: "Opened",
				target: shown || undefined,
				path: path || undefined,
			};
		case "writeEditor":
			return {
				kind: "edit",
				present: "Editing unsaved",
				past: "Edited unsaved",
				target: shown || undefined,
				path: path || undefined,
			};
		case "listProblems":
			return {
				kind: "other",
				present: "Checking problems",
				past: "Checked problems",
			};
		case "listPorts":
			return { kind: "other", present: "Listing ports", past: "Listed ports" };
		case "forwardPort":
			return {
				kind: "other",
				present: "Forwarding port",
				past: "Forwarded port",
				target: port !== undefined ? String(port) : undefined,
			};
		case "closePort":
			return {
				kind: "other",
				present: "Closing port",
				past: "Closed port",
				target: port !== undefined ? String(port) : undefined,
			};
		case "addFolder":
			return {
				kind: "other",
				present: "Adding folder",
				past: "Added folder",
				target: path ? displayPath(path, cwd) : undefined,
				detail: "to the workspace",
			};
		case "removeFolder":
			return {
				kind: "other",
				present: "Removing folder",
				past: "Removed folder",
				target: path ? displayPath(path, cwd) : undefined,
				detail: "from the workspace",
			};
		case "listAgents":
			return {
				kind: "other",
				present: "Listing agents",
				past: "Listed agents",
			};
		case "waitAgent":
			return {
				kind: "other",
				present: "Waiting for agent",
				past: "Agent finished",
				target: pick(args, "id") || undefined,
			};
		case "stopAgent":
			return {
				kind: "other",
				present: "Stopping agent",
				past: "Stopped agent",
				target: pick(args, "id") || undefined,
			};
		default:
			return undefined;
	}
}

export function describeTool(
	tool: string,
	input: unknown,
	cwd?: string,
): ToolDescription {
	const name = canonicalTool(tool);
	const args = asInput(input);
	const path = pick(
		args,
		"file_path",
		"filePath",
		"path",
		"notebook_path",
		"target_file",
		"file",
	);
	const shown = path ? displayPath(path, cwd) : "";
	switch (name) {
		case "Read": {
			const offset = pickNumber(args, "offset", "start_line", "startLine");
			const limit = pickNumber(args, "limit");
			const start = offset !== undefined ? Math.max(1, offset) : undefined;
			const end =
				start !== undefined && limit !== undefined
					? start + limit - 1
					: pickNumber(args, "end_line", "endLine");
			const lines =
				start !== undefined
					? end !== undefined
						? `L${start}-${end}`
						: `from L${start}`
					: undefined;
			return {
				kind: "read",
				present: "Reading",
				past: "Read",
				target: shown || undefined,
				path: path || undefined,
				startLine: start,
				endLine: end,
				detail: lines,
			};
		}
		case "Write":
			return {
				kind: "write",
				present: "Writing",
				past: "Wrote",
				target: shown || undefined,
				path: path || undefined,
			};
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return {
				kind: "edit",
				present: "Editing",
				past: "Edited",
				target: shown || undefined,
				path: path || undefined,
			};
		case "Delete":
			return {
				kind: "delete",
				present: "Deleting",
				past: "Deleted",
				target: shown || undefined,
				path: path || undefined,
			};
		case "Bash": {
			const raw = pick(args, "command", "cmd", "commandLine");
			const command = unwrapShell(
				Array.isArray(args.command)
					? (args.command as unknown[]).map(String).join(" ")
					: raw,
			);
			return {
				kind: "run",
				present: "Running",
				past: "Ran",
				target: command ? shortCommand(command) : undefined,
				command: command || undefined,
			};
		}
		case "Grep": {
			const pattern = pick(args, "pattern", "query", "regex");
			const where = path
				? ` in \`${shown}\``
				: pick(args, "glob", "include")
					? ` in \`${pick(args, "glob", "include")}\``
					: "";
			return {
				kind: "search",
				present: "Searching",
				past: "Searched",
				target: pattern || undefined,
				detail: where.trim() || undefined,
			};
		}
		case "Glob": {
			const pattern = pick(args, "pattern", "glob", "query");
			return {
				kind: "search",
				present: "Finding files",
				past: "Found files",
				target: pattern || undefined,
				detail: path ? `in \`${shown}\`` : undefined,
			};
		}
		case "LS":
			return {
				kind: "list",
				present: "Listing",
				past: "Listed",
				target: shown || undefined,
				path: path || undefined,
			};
		case "WebFetch":
			return {
				kind: "web",
				present: "Fetching",
				past: "Fetched",
				target: pick(args, "url") || undefined,
			};
		case "WebSearch":
			return {
				kind: "web",
				present: "Searching the web for",
				past: "Searched the web for",
				target: pick(args, "query") || undefined,
			};
		case "Task": {
			const description = pick(args, "description", "prompt");
			const agent = pick(args, "subagent_type", "agent", "agentName");
			return {
				kind: "agent",
				present: "Running sub-agent",
				past: "Sub-agent finished",
				target: description ? shortCommand(description) : undefined,
				detail: agent ? `(${agent})` : undefined,
			};
		}
		case "TodoWrite":
		case "TodoRead":
			return { kind: "todo", present: "Updating todos", past: "Updated todos" };
		case "ExitPlanMode":
			return {
				kind: "plan",
				present: "Presenting plan",
				past: "Presented plan",
			};
		default: {
			if (isSendAgentTool(name)) {
				const run = pick(args, "id");
				const prompt = pick(args, "prompt");
				return {
					kind: "agent",
					present: "Following up with agent",
					past: "Agent answered",
					target: run || undefined,
					detail: prompt ? shortCommand(prompt) : undefined,
				};
			}
			if (isRunAgentTool(name)) {
				const agent = pick(args, "agent");
				const prompt = pick(args, "prompt");
				return {
					kind: "agent",
					present: "Running agent",
					past: "Agent finished",
					target: agent || undefined,
					detail: prompt ? shortCommand(prompt) : undefined,
				};
			}
			const editorTool = thriceToolName(name);
			if (editorTool) {
				const described = describeEditorTool(
					editorTool,
					args,
					path,
					shown,
					cwd,
				);
				if (described) {
					return described;
				}
			}
			if (name.startsWith("mcp__")) {
				const [, server, ...rest] = name.split("__");
				return {
					kind: "mcp",
					present: "Calling",
					past: "Called",
					target: `${server}.${rest.join("__")}`,
				};
			}
			return {
				kind: "other",
				present: "Using",
				past: "Used",
				target: name || undefined,
			};
		}
	}
}

export function formatLabel(
	description: ToolDescription,
	tense: "present" | "past" = "present",
): string {
	const verb = tense === "present" ? description.present : description.past;
	const target = description.target
		? ` \`${description.target.replace(/`/g, "'")}\``
		: "";
	const detail = description.detail ? ` ${description.detail}` : "";
	return `${verb}${target}${detail}`;
}

export function toolLabel(tool: string, input: unknown, cwd?: string): string {
	return formatLabel(describeTool(tool, input, cwd));
}

const PARTIAL_STRING_KEYS = [
	"file_path",
	"filePath",
	"path",
	"notebook_path",
	"pattern",
	"glob",
	"command",
	"description",
	"subagent_type",
	"url",
	"query",
];
const PARTIAL_NUMBER_KEYS = ["offset", "limit"];

/** Keys whose (large, still streaming) string values are file content being written. */
const CONTENT_KEYS = new Set([
	"content",
	"new_string",
	"new_source",
	"newString",
]);

/**
 * Counts the lines of file content in a tool input whose JSON is still streaming, without parsing
 * it: a tiny incremental tokenizer that tracks string values of `CONTENT_KEYS` (summed, so MultiEdit
 * counts every `new_string`). Each chunk is scanned once.
 */
export class StreamedLineCounter {
	private inString = false;
	private escape = false;
	/** The string being read, kept only while short enough to be a key. */
	private text = "";
	private textLength = 0;
	private counting = false;
	/** Last token outside strings: a closed string, ':' or another delimiter. */
	private lastToken: "string" | "colon" | "other" = "other";
	private lastString = "";
	private key = "";
	private newlines = 0;
	/** Content characters seen after the last newline in each counted value, summed as open lines. */
	private openLines = 0;
	private tail = false;

	/** Feeds the next chunk; returns the line count so far. */
	push(chunk: string): number {
		for (let i = 0; i < chunk.length; i++) {
			const ch = chunk[i];
			if (this.inString) {
				if (this.escape) {
					this.escape = false;
					if (this.counting) {
						if (ch === "n") {
							this.newlines++;
							this.tail = false;
						} else {
							this.tail = true;
						}
					}
					this.append("\\" + ch);
					continue;
				}
				if (ch === "\\") {
					this.escape = true;
					continue;
				}
				if (ch === '"') {
					this.inString = false;
					if (this.counting && this.tail) {
						this.openLines++;
					}
					this.counting = false;
					this.tail = false;
					this.lastString = this.textLength <= 64 ? this.text : "";
					this.lastToken = "string";
					continue;
				}
				if (this.counting) {
					this.tail = true;
				}
				this.append(ch);
				continue;
			}
			if (ch === '"') {
				this.inString = true;
				this.text = "";
				this.textLength = 0;
				this.counting =
					this.lastToken === "colon" && CONTENT_KEYS.has(this.key);
				continue;
			}
			if (ch === ":") {
				this.key = this.lastToken === "string" ? this.lastString : "";
				this.lastToken = "colon";
				continue;
			}
			if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
				continue;
			}
			this.lastToken = "other";
		}
		return this.lines();
	}

	lines(): number {
		return (
			this.newlines + this.openLines + (this.counting && this.tail ? 1 : 0)
		);
	}

	private append(value: string): void {
		this.textLength += value.length;
		if (this.textLength <= 64) {
			this.text += value;
		}
	}
}

/**
 * Best-effort view of a tool input whose JSON is still streaming. Only complete string values of
 * the keys that name a target are read, so huge fields (file contents, prompts) cost nothing.
 */
export function partialToolInput(buffer: string): Json | undefined {
	const complete = parsed(buffer);
	if (complete) {
		return complete;
	}
	const result: Json = {};
	for (const key of PARTIAL_STRING_KEYS) {
		const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(
			buffer,
		);
		if (match) {
			try {
				result[key] = JSON.parse(`"${match[1]}"`);
			} catch {
				// ignore malformed escape
			}
		}
	}
	for (const key of PARTIAL_NUMBER_KEYS) {
		const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)\\s*[,}]`).exec(buffer);
		if (match) {
			result[key] = Number(match[1]);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------------

export function createEventDecoder(
	driver: Driver | string,
	options: DecoderOptions = {},
): EventDecoder {
	switch (driver) {
		case "claude":
			return createClaudeDecoder(options, "Claude Hub failed");
		case "cursor":
			return createClaudeDecoder(options, "Cursor failed");
		case "codex":
			return createCodexDecoder(options);
		case "opencode":
			return createOpencodeDecoder(options);
		default:
			return createPlainDecoder();
	}
}

function createPlainDecoder(): EventDecoder {
	return {
		push(line) {
			const text = line.trim();
			return text && !text.startsWith("{") ? [{ kind: "text", text }] : [];
		},
		failure: () => undefined,
	};
}

const EDIT_TOOLS = new Set([
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"Delete",
]);

interface ToolState {
	readonly tool: string;
	label: string;
	input?: unknown;
	buffer: string;
	finalized: boolean;
	ended: boolean;
	/** Lines of streamed content, for Write/Edit progress. */
	lines?: StreamedLineCounter;
	streamedLines?: number;
}

/** Claude `-p --output-format stream-json --verbose [--include-partial-messages]`, and Cursor's Claude-shaped stream. */
function createClaudeDecoder(
	options: DecoderOptions,
	failureLabel: string,
): EventDecoder {
	const cwd = options.cwd;
	let error: string | undefined;
	// Global text dedupe for streams without message ids (Cursor's --stream-partial-output).
	let streamed = "";
	// Per-message dedupe when partial messages were streamed.
	const streamedText = new Map<string, string>();
	const accountedText = new Map<string, string>();
	const streamedThinking = new Set<string>();
	let currentMessage = "";
	const blockTool = new Map<string, string>();
	const tools = new Map<string, ToolState>();

	const startTool = (
		events: AgentEvent[],
		id: string,
		name: string,
		input: unknown,
		parentId: string | undefined,
		finalized: boolean,
	) => {
		const label = toolLabel(name, input ?? {}, cwd);
		tools.set(id, {
			tool: canonicalTool(name),
			label,
			input,
			buffer: "",
			finalized,
			ended: false,
		});
		const event: Extract<AgentEvent, { kind: "toolStart" }> = {
			kind: "toolStart",
			id,
			tool: canonicalTool(name),
			label,
		};
		if (input !== undefined) {
			event.input = input;
		}
		if (parentId) {
			event.parentId = parentId;
		}
		events.push(event);
	};

	const updateTool = (
		events: AgentEvent[],
		id: string,
		input: unknown,
		final: boolean,
	) => {
		const state = tools.get(id);
		if (!state || state.finalized) {
			return;
		}
		const label = toolLabel(state.tool, input ?? {}, cwd);
		const changed = label !== state.label;
		state.input = input;
		state.label = label;
		if (final) {
			state.finalized = true;
			events.push({ kind: "toolUpdate", id, label, input });
		} else if (changed) {
			events.push({ kind: "toolUpdate", id, label, input });
		}
	};

	const endTool = (
		events: AgentEvent[],
		id: string,
		ok: boolean,
		output: string,
		structured: unknown,
	) => {
		const state = tools.get(id);
		if (state?.ended) {
			return;
		}
		if (state) {
			state.ended = true;
		}
		const event: Extract<AgentEvent, { kind: "toolEnd" }> = {
			kind: "toolEnd",
			id,
			ok,
		};
		if (output) {
			event.output = cap(output);
		}
		if (state?.tool === "Bash") {
			const exit = /^Exit code (\d+)/.exec(output);
			event.exitCode = exit ? Number(exit[1]) : ok ? 0 : undefined;
			if (event.exitCode === undefined) {
				delete event.exitCode;
			}
		}
		if (ok && state && EDIT_TOOLS.has(state.tool)) {
			const args = asInput(state.input);
			const path = pick(args, "file_path", "filePath", "path", "notebook_path");
			if (path) {
				const kind = isObject(structured) ? str(structured.type) : "";
				const change =
					state.tool === "Delete"
						? "delete"
						: kind === "create"
							? "add"
							: "update";
				events.push({
					kind: "fileChange",
					path,
					change,
					toolId: id,
					...claudeEditCounts(structured, args, change),
				});
			}
		}
		events.push(event);
	};

	const pushAssistantText = (
		events: AgentEvent[],
		messageId: string,
		text: string,
	) => {
		const streamedForMessage = messageId
			? streamedText.get(messageId)
			: undefined;
		if (streamedForMessage !== undefined) {
			const previous = accountedText.get(messageId) ?? "";
			const next = previous + text;
			accountedText.set(messageId, next);
			if (streamedForMessage.startsWith(next)) {
				return;
			}
			if (next.startsWith(streamedForMessage)) {
				const suffix = next.slice(
					Math.max(streamedForMessage.length, previous.length),
				);
				streamedText.set(messageId, next);
				if (suffix) {
					events.push({ kind: "text", text: suffix });
				}
				return;
			}
			events.push({ kind: "text", text });
			return;
		}
		const suffix =
			streamed && text.startsWith(streamed)
				? text.slice(streamed.length)
				: text;
		streamed = streamed && text.startsWith(streamed) ? text : streamed + text;
		if (suffix) {
			events.push({ kind: "text", text: suffix });
		}
	};

	const streamEvent = (message: Json): AgentEvent[] => {
		const event = isObject(message.event) ? message.event : undefined;
		if (!event) {
			return [];
		}
		const parentId = str(message.parent_tool_use_id) || undefined;
		const events: AgentEvent[] = [];
		const type = str(event.type);
		if (type === "message_start") {
			currentMessage = isObject(event.message) ? str(event.message.id) : "";
			return [];
		}
		const blockKey = `${currentMessage}:${num(event.index) ?? 0}`;
		if (type === "content_block_start" && isObject(event.content_block)) {
			const block = event.content_block;
			if (block.type === "tool_use" || block.type === "server_tool_use") {
				const id = str(block.id);
				if (id && !tools.has(id)) {
					blockTool.set(blockKey, id);
					const input =
						isObject(block.input) && Object.keys(block.input).length > 0
							? block.input
							: undefined;
					startTool(events, id, str(block.name), input, parentId, false);
				}
			}
			return events;
		}
		if (type === "content_block_delta" && isObject(event.delta)) {
			const delta = event.delta;
			if (
				delta.type === "text_delta" &&
				typeof delta.text === "string" &&
				delta.text
			) {
				if (parentId) {
					return [];
				}
				if (currentMessage) {
					streamedText.set(
						currentMessage,
						(streamedText.get(currentMessage) ?? "") + delta.text,
					);
				}
				streamed += delta.text;
				return [{ kind: "text", text: delta.text }];
			}
			if (
				delta.type === "thinking_delta" &&
				typeof delta.thinking === "string" &&
				delta.thinking
			) {
				if (parentId) {
					return [];
				}
				if (currentMessage) {
					streamedThinking.add(currentMessage);
				}
				return [{ kind: "thinking", text: delta.thinking, id: blockKey }];
			}
			if (
				delta.type === "input_json_delta" &&
				typeof delta.partial_json === "string"
			) {
				const id = blockTool.get(blockKey);
				const state = id ? tools.get(id) : undefined;
				if (id && state && !state.finalized) {
					state.buffer += delta.partial_json;
					const input = partialToolInput(state.buffer);
					if (input) {
						updateTool(events, id, input, false);
					}
					if (EDIT_TOOLS.has(state.tool) && state.tool !== "Delete") {
						state.lines ??= new StreamedLineCounter();
						const lines = state.lines.push(delta.partial_json);
						if (lines > 0 && lines !== state.streamedLines) {
							state.streamedLines = lines;
							events.push({ kind: "toolUpdate", id, streamedLines: lines });
						}
					}
				}
			}
			return events;
		}
		if (type === "content_block_stop") {
			const id = blockTool.get(blockKey);
			const state = id ? tools.get(id) : undefined;
			if (id && state && !state.finalized) {
				const input = state.buffer ? parsed(state.buffer) : undefined;
				if (input) {
					updateTool(events, id, input, true);
				}
			}
			blockTool.delete(blockKey);
			return events;
		}
		return [];
	};

	const cursorToolCall = (message: Json): AgentEvent[] => {
		// Cursor: {"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{"readToolCall":{"args":{...},"result":{...}}}}
		const id = str(message.call_id) || str(message.id);
		const call = isObject(message.tool_call) ? message.tool_call : undefined;
		if (!id || !call) {
			return [];
		}
		const key = Object.keys(call)[0] ?? "";
		const body = isObject(call[key]) ? (call[key] as Json) : {};
		let name = key.replace(/ToolCall$/, "");
		let args: Json = isObject(body.args) ? body.args : {};
		if (key === "function") {
			name = str(body.name);
			args = asInput(body.arguments);
		}
		const tool = canonicalTool(name === "shell" ? "bash" : name);
		const events: AgentEvent[] = [];
		if (!tools.has(id)) {
			startTool(events, id, tool, args, undefined, true);
		}
		if (message.subtype === "completed") {
			const result = isObject(body.result) ? body.result : {};
			const success = isObject(result.success) ? result.success : undefined;
			const failed = isObject(result.error)
				? result.error
				: result.error !== undefined
					? { message: result.error }
					: undefined;
			const output = success
				? str(success.stdout) || str(success.content) || str(success.output)
				: failed
					? str(failed.message) || str(failed.error) || str(failed.stderr)
					: "";
			const exitCode = num(success?.exitCode) ?? num(failed?.exitCode);
			const ok = !failed && (exitCode === undefined || exitCode === 0);
			const before = events.length;
			endTool(events, id, ok, output, undefined);
			const end = events[before];
			if (end?.kind === "toolEnd" && exitCode !== undefined) {
				end.exitCode = exitCode;
			}
		}
		return events;
	};

	return {
		push(line) {
			const message = parsed(line);
			if (!message) {
				return [];
			}
			const parentId = str(message.parent_tool_use_id) || undefined;
			if (message.type === "stream_event") {
				return streamEvent(message);
			}
			if (message.type === "tool_call") {
				return cursorToolCall(message);
			}
			if (message.type === "thinking" && !parentId) {
				// Cursor: {"type":"thinking","subtype":"delta","text":"..."}
				const text = str(message.text);
				return text
					? [
							{
								kind: "thinking",
								text,
								id: str(message.session_id) || undefined,
							},
						]
					: [];
			}
			if (message.type === "assistant") {
				const body = isObject(message.message) ? message.message : undefined;
				const content = body?.content;
				if (!Array.isArray(content)) {
					return [];
				}
				const messageId = str(body?.id);
				const events: AgentEvent[] = [];
				for (const block of content) {
					if (!isObject(block)) {
						continue;
					}
					if (block.type === "text") {
						const text = str(block.text);
						if (text && !parentId) {
							pushAssistantText(events, messageId, text);
						}
					} else if (block.type === "thinking") {
						const text = str(block.thinking);
						if (
							text &&
							!parentId &&
							!(messageId && streamedThinking.has(messageId))
						) {
							events.push({
								kind: "thinking",
								text,
								id: messageId || undefined,
							});
						}
					} else if (
						block.type === "tool_use" ||
						block.type === "server_tool_use"
					) {
						const id = str(block.id);
						if (!id) {
							continue;
						}
						if (tools.has(id)) {
							updateTool(events, id, block.input ?? {}, true);
						} else {
							startTool(
								events,
								id,
								str(block.name),
								block.input ?? {},
								parentId,
								true,
							);
						}
					}
				}
				return events;
			}
			if (message.type === "user") {
				const content = isObject(message.message)
					? message.message.content
					: undefined;
				if (!Array.isArray(content)) {
					return [];
				}
				const events: AgentEvent[] = [];
				for (const block of content) {
					if (!isObject(block) || block.type !== "tool_result") {
						continue;
					}
					const id = str(block.tool_use_id);
					if (id) {
						endTool(
							events,
							id,
							block.is_error !== true,
							contentText(block.content),
							message.tool_use_result,
						);
					}
				}
				return events;
			}
			if (
				message.type === "result" &&
				(message.is_error === true ||
					message.subtype === "error" ||
					(typeof message.subtype === "string" &&
						message.subtype.startsWith("error")))
			) {
				error = str(message.result) || failureLabel;
			}
			return [];
		},
		failure: () => error,
	};
}

const CODEX_TOOL_NAMES: Record<string, string> = {
	command_execution: "Bash",
	file_change: "Edit",
	web_search: "WebSearch",
	todo_list: "TodoWrite",
};

function codexItemText(item: Json): string {
	return str(item.text) || str(item.message) || contentText(item.content);
}

/** Lines in `text`, not counting the empty piece after a final newline. */
export function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/** Added and removed lines of a unified diff, skipping the `+++`/`---` file headers. */
export function countDiffLines(lines: Iterable<string>): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++ ")) {
			added++;
		} else if (line.startsWith("-") && !line.startsWith("--- ")) {
			removed++;
		}
	}
	return { added, removed };
}

/**
 * Line counts of one Claude Write/Edit call, from the tool result's `structuredPatch` hunks, or for
 * a newly created file its content. Undefined fields when the result carries neither.
 */
function claudeEditCounts(
	structured: unknown,
	input: Record<string, unknown>,
	change: "add" | "update" | "delete",
): { added?: number; removed?: number } {
	const result = isObject(structured) ? structured : {};
	const hunks = Array.isArray(result.structuredPatch)
		? result.structuredPatch.filter(isObject)
		: [];
	if (hunks.length) {
		return countDiffLines(
			hunks.flatMap((hunk) =>
				Array.isArray(hunk.lines)
					? hunk.lines.filter(
							(line): line is string => typeof line === "string",
						)
					: [],
			),
		);
	}
	if (change === "add") {
		const content =
			typeof result.content === "string"
				? result.content
				: typeof input.content === "string"
					? input.content
					: undefined;
		return content === undefined
			? {}
			: { added: countLines(content), removed: 0 };
	}
	return {};
}

/** Codex sends a created or deleted file's whole content as its `diff`, and a unified diff for an update. */
function codexEditCounts(
	diff: unknown,
	change: "add" | "update" | "delete",
): { added?: number; removed?: number } {
	if (typeof diff !== "string") {
		return {};
	}
	if (change === "add") {
		return { added: countLines(diff), removed: 0 };
	}
	if (change === "delete") {
		return { added: 0, removed: countLines(diff) };
	}
	return countDiffLines(diff.split("\n"));
}

function codexChangeKind(kind: string): "add" | "update" | "delete" {
	return kind === "add" || kind === "create"
		? "add"
		: kind === "delete" || kind === "remove"
			? "delete"
			: "update";
}

/** Codex `exec --json`. */
function createCodexDecoder(options: DecoderOptions): EventDecoder {
	const cwd = options.cwd;
	const seen = new Map<string, string>();
	const started = new Map<string, { tool: string; label: string }>();
	const ended = new Set<string>();
	let error: string | undefined;

	const toolFor = (
		item: Json,
	): { tool: string; input: Json; label: string } => {
		const type = str(item.type);
		if (type === "mcp_tool_call") {
			const server = str(item.server);
			const name = str(item.tool) || str(item.name);
			const tool = `mcp__${server}__${name}`;
			const input = asInput(item.arguments);
			return { tool, input, label: toolLabel(tool, input, cwd) };
		}
		if (type === "file_change") {
			const changes = Array.isArray(item.changes)
				? item.changes.filter(isObject)
				: [];
			const paths = changes.map((change) => str(change.path)).filter(Boolean);
			const input: Json = {
				changes: changes
					.slice(0, 50)
					.map((change) => ({
						path: str(change.path),
						kind: str(change.kind),
					})),
			};
			if (paths.length === 1) {
				input.file_path = paths[0];
			}
			const label =
				paths.length > 1
					? `Editing ${paths.length} files`
					: toolLabel("Edit", input, cwd);
			return { tool: "Edit", input, label };
		}
		if (type === "todo_list") {
			const items = Array.isArray(item.items)
				? item.items
						.filter(isObject)
						.map((entry) => ({
							text: str(entry.text),
							completed: entry.completed === true,
						}))
				: [];
			return {
				tool: "TodoWrite",
				input: { items },
				label: toolLabel("TodoWrite", {}, cwd),
			};
		}
		const tool = CODEX_TOOL_NAMES[type] ?? type;
		const input: Json = {};
		if (typeof item.command === "string") {
			input.command = item.command;
		}
		if (typeof item.query === "string") {
			input.query = item.query;
		}
		return { tool, input, label: toolLabel(tool, input, cwd) };
	};

	return {
		push(line) {
			const message = parsed(line);
			if (!message || typeof message.type !== "string") {
				return [];
			}
			if (message.type === "turn.failed" || message.type === "error") {
				const nested = isObject(message.error)
					? str(message.error.message)
					: "";
				error =
					str(message.message) ||
					str(message.error) ||
					nested ||
					"Codex Hub failed";
				return [];
			}
			if (
				message.type === "agent_message_content_delta" ||
				message.type === "agent_message_delta"
			) {
				const text = str(message.delta);
				return text ? [{ kind: "text", text }] : [];
			}
			if (
				message.type === "agent_reasoning_delta" ||
				message.type === "reasoning_content_delta"
			) {
				const text = str(message.delta);
				return text ? [{ kind: "thinking", text }] : [];
			}
			if (
				message.type !== "item.completed" &&
				message.type !== "item.updated" &&
				message.type !== "item.started"
			) {
				return [];
			}
			const item = isObject(message.item) ? message.item : undefined;
			const type = item ? str(item.type) : "";
			if (!item || !type) {
				return [];
			}
			if (type === "agent_message" || type === "reasoning") {
				const text = codexItemText(item);
				if (!text) {
					return [];
				}
				const key = str(item.id) || type;
				const suffix = suffixFor(seen, key, text);
				if (!suffix) {
					return [];
				}
				return type === "reasoning"
					? [{ kind: "thinking", text: suffix, id: key }]
					: [{ kind: "text", text: suffix }];
			}
			if (type === "error") {
				return [];
			}
			const id = str(item.id) || `${type}-${started.size}`;
			if (ended.has(id)) {
				return [];
			}
			const events: AgentEvent[] = [];
			const described = toolFor(item);
			const previous = started.get(id);
			if (!previous) {
				started.set(id, { tool: described.tool, label: described.label });
				events.push({
					kind: "toolStart",
					id,
					tool: described.tool,
					label: described.label,
					input: described.input,
				});
			} else if (previous.label !== described.label || type === "todo_list") {
				previous.label = described.label;
				events.push({
					kind: "toolUpdate",
					id,
					label: described.label,
					input: described.input,
				});
			}
			const status = str(item.status);
			if (
				message.type === "item.completed" ||
				status === "completed" ||
				status === "failed" ||
				status === "declined"
			) {
				ended.add(id);
				const exitCode = num(item.exit_code);
				const failed =
					status === "failed" ||
					status === "declined" ||
					(exitCode !== undefined && exitCode !== 0) ||
					(item.error !== undefined && item.error !== null);
				const end: Extract<AgentEvent, { kind: "toolEnd" }> = {
					kind: "toolEnd",
					id,
					ok: !failed,
				};
				const output =
					str(item.aggregated_output) ||
					(isObject(item.error) ? str(item.error.message) : str(item.error)) ||
					contentText(isObject(item.result) ? item.result.content : undefined);
				if (output) {
					end.output = cap(output);
				}
				if (exitCode !== undefined) {
					end.exitCode = exitCode;
				}
				if (type === "file_change" && !failed) {
					for (const change of Array.isArray(item.changes)
						? item.changes.filter(isObject)
						: []) {
						const path = str(change.path);
						if (path) {
							const kind = codexChangeKind(str(change.kind));
							events.push({
								kind: "fileChange",
								path,
								change: kind,
								toolId: id,
								...codexEditCounts(change.diff, kind),
							});
						}
					}
				}
				events.push(end);
			}
			return events;
		},
		failure: () => error,
	};
}

function opencodeInput(tool: string, input: Json): Json {
	// OpenCode uses camelCase keys; labels read the Claude names too, so pass both through.
	const result: Json = { ...input };
	if (typeof input.filePath === "string" && result.file_path === undefined) {
		result.file_path = input.filePath;
	}
	if (tool === "Read" && typeof input.offset === "number") {
		// OpenCode offsets are zero-based.
		result.offset = input.offset + 1;
	}
	return result;
}

/** OpenCode `run --format json`, both the flat `{type, part}` lines and `message.part.updated` events. */
function createOpencodeDecoder(options: DecoderOptions): EventDecoder {
	const cwd = options.cwd;
	const seen = new Map<string, string>();
	const started = new Map<string, { tool: string; label: string }>();
	const ended = new Set<string>();
	let error: string | undefined;
	return {
		push(line) {
			const message = parsed(line);
			if (!message) {
				return [];
			}
			if (message.type === "error") {
				const nested = isObject(message.error)
					? str(message.error.message) ||
						(isObject(message.error.data)
							? str(message.error.data.message)
							: "")
					: "";
				error =
					str(message.error) ||
					nested ||
					str(message.message) ||
					"Grok Hub failed";
				return [];
			}
			const properties = isObject(message.properties)
				? message.properties
				: undefined;
			const part = isObject(properties?.part)
				? properties.part
				: isObject(message.part)
					? message.part
					: undefined;
			if (!part) {
				return [];
			}
			if (part.type === "text" || part.type === "reasoning") {
				const text = str(part.text);
				if (!text) {
					return [];
				}
				const key = `${part.type}:${str(part.id) || "text"}`;
				const suffix = suffixFor(seen, key, text);
				if (!suffix) {
					return [];
				}
				return part.type === "reasoning"
					? [{ kind: "thinking", text: suffix, id: str(part.id) || undefined }]
					: [{ kind: "text", text: suffix }];
			}
			if (part.type !== "tool") {
				return [];
			}
			const id = str(part.callID) || str(part.id);
			if (!id || ended.has(id)) {
				return [];
			}
			const tool = canonicalTool(str(part.tool));
			const state = isObject(part.state) ? part.state : {};
			const input = opencodeInput(
				tool,
				isObject(state.input) ? state.input : {},
			);
			const label = toolLabel(tool, input, cwd);
			const events: AgentEvent[] = [];
			const previous = started.get(id);
			if (!previous) {
				started.set(id, { tool, label });
				events.push({ kind: "toolStart", id, tool, label, input });
			} else if (previous.label !== label) {
				previous.label = label;
				events.push({ kind: "toolUpdate", id, label, input });
			}
			const status = str(state.status);
			if (status === "completed" || status === "error") {
				ended.add(id);
				const metadata = isObject(state.metadata) ? state.metadata : {};
				const exitCode = num(metadata.exit) ?? num(metadata.exitCode);
				const ok =
					status === "completed" && (exitCode === undefined || exitCode === 0);
				const end: Extract<AgentEvent, { kind: "toolEnd" }> = {
					kind: "toolEnd",
					id,
					ok,
				};
				const output =
					status === "error"
						? str(state.error)
						: str(state.output) || str(metadata.output);
				if (output) {
					end.output = cap(output);
				}
				if (exitCode !== undefined) {
					end.exitCode = exitCode;
				}
				events.push(end);
				if (ok && EDIT_TOOLS.has(tool)) {
					const path = pick(input, "file_path", "filePath", "path");
					if (path) {
						events.push({
							kind: "fileChange",
							path,
							change:
								tool === "Delete"
									? "delete"
									: metadata.exists === false
										? "add"
										: "update",
						});
					}
				}
			}
			return events;
		},
		failure: () => error,
	};
}

/**
 * Drops a leading `cd <workspace> &&` (or `;`) from a command for display: the agent already
 * runs there, so the prefix only pushes the real command out of the card title.
 */
export function stripWorkspaceCd(command: string, cwd: string): string {
	const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/.exec(
		command,
	);
	if (!match) {
		return command;
	}
	const dir = match[1] ?? match[2] ?? match[3];
	const rest = command.slice(match[0].length);
	return rest && resolvePath(cwd, dir) === resolvePath(cwd) ? rest : command;
}
