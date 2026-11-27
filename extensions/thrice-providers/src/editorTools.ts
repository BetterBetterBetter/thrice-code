import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
	AGENT_TOOL_NAME_SET,
	AGENT_TOOL_NAMES,
	AgentRuns,
	childMode,
	childPrompt,
	DEFAULT_WAITS,
	followUpPrompt,
	formatAgentList,
	formatRun,
	waitMs,
	type AgentLaunchHandle,
	type AgentRun,
	type AgentRunSink,
	type ChildRunSink,
	type ChildRunView,
} from "./agents";
import {
	denialFromHook,
	interpretMcp,
	mcpStdioFrame,
	SESSION_TOOL_NAMES,
	spawnedTerminalId,
	TERMINAL_TOOL_NAME,
	toolResultMessage,
	type EditorToolLaunch,
} from "./editorToolPolicy";
import type { AgentEvent } from "./events";
import {
	missingEnvironment,
	normalizeChatTurnMode,
	type ChatTurnMode,
	type ProviderInstance,
} from "./instances";

const SHIM = `import { writeSync } from 'node:fs';
import { request } from 'node:http';
const port = process.argv[2];
const token = process.argv[3];
function post(body) {
	return new Promise((resolve, reject) => {
		const req = request({
			hostname: '127.0.0.1', port: Number(port), path: '/mcp', method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + token },
		}, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
		});
		req.on('error', reject);
		req.end(body);
	});
}
let buffer = Buffer.alloc(0);
function takeMessage() {
	const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
	const lineEnd = buffer.indexOf('\\n');
	if (headerEnd !== -1 && (lineEnd === -1 || headerEnd < lineEnd)) {
		const header = buffer.subarray(0, headerEnd).toString('utf8');
		const match = /content-length:\\s*(\\d+)/i.exec(header);
		if (!match) { buffer = buffer.subarray(headerEnd + 4); return null; }
		const length = Number(match[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return null;
		const body = buffer.subarray(start, start + length).toString('utf8');
		buffer = buffer.subarray(start + length);
		return body;
	}
	if (lineEnd === -1) return null;
	const line = buffer.subarray(0, lineEnd).toString('utf8').trim();
	buffer = buffer.subarray(lineEnd + 1);
	return line || null;
}
// Each request is sent as soon as it arrives, so a long call such as runAgent does not hold up
// the next tool call or a cancellation. JSON-RPC replies carry their id, so order does not matter.
function pump() {
	for (;;) {
		const message = takeMessage();
		if (!message) break;
		post(message).then(response => {
			if (response.length > 0) writeSync(1, response);
		}, error => process.stderr.write(String(error) + '\\n'));
	}
}
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); pump(); });
`;

const GUARD = `import { request } from 'node:http';
const port = process.argv[2];
const token = process.argv[3];
const promptFile = process.argv[4];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
	const body = JSON.stringify({ hook: raw, promptFile });
	const req = request({
		hostname: '127.0.0.1', port: Number(port), path: '/guard', method: 'POST',
		headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + token },
	}, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			if (!text) process.exit(0);
			process.stderr.write(text);
			process.stdout.write(text);
			process.exit(2);
		});
	});
	req.on('error', () => process.exit(0));
	req.end(body);
});
`;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) =>
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
		);
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sessionName(command: string): string {
	const token = command.trim().split(/\s+/)[0] ?? "";
	const base = token.split(/[\\/]/).pop() ?? "";
	return base.slice(0, 40) || "Agent Terminal";
}

function waitForShellIntegration(
	terminal: vscode.Terminal,
): Promise<vscode.TerminalShellIntegration | undefined> {
	if (terminal.shellIntegration) {
		return Promise.resolve(terminal.shellIntegration);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(terminal.shellIntegration);
		}, 4000);
		const subscription = vscode.window.onDidChangeTerminalShellIntegration(
			(event) => {
				if (event.terminal === terminal && event.shellIntegration) {
					clearTimeout(timer);
					subscription.dispose();
					resolve(event.shellIntegration);
				}
			},
		);
	});
}

async function readExecution(
	execution: vscode.TerminalShellExecution,
): Promise<{ output: string; exitCode: number | undefined }> {
	const chunks: string[] = [];
	const reader = (async () => {
		for await (const data of execution.read()) {
			chunks.push(data);
		}
	})();
	const exitCode = await new Promise<number | undefined>((resolve) => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(undefined);
		}, 20000);
		const subscription = vscode.window.onDidEndTerminalShellExecution(
			(event) => {
				if (event.execution === execution) {
					clearTimeout(timer);
					subscription.dispose();
					resolve(event.exitCode);
				}
			},
		);
	});
	await reader;
	return { output: chunks.join("").slice(-20000), exitCode };
}

const SESSION_COMMAND = "thrice.session.invoke";

async function runSessionTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	let result: unknown;
	try {
		result = await vscode.commands.executeCommand(SESSION_COMMAND, {
			tool: name,
			args,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			message || "The editor session tools are not available in this window.",
		);
	}
	if (typeof result !== "string" || !result.trim()) {
		throw new Error(
			"The editor session tools are not available in this window.",
		);
	}
	return result;
}

export async function sessionBrief(): Promise<string> {
	try {
		return await runSessionTool("sessionContext", {});
	} catch {
		return fallbackBrief();
	}
}

function fallbackBrief(): string {
	const folders =
		vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
	const file = vscode.workspace.workspaceFile;
	const lines = [
		"Window session",
		file
			? `Saved workspace at ${file.fsPath}.`
			: folders.length
				? `Unsaved workspace "${vscode.workspace.name}".`
				: "No folder is open. Untitled editors are the workspace.",
		"Folders:",
	];
	lines.push(
		folders.length
			? folders.map((folder) => `- ${folder}`).join("\n")
			: "- none",
	);
	const active = vscode.window.activeTextEditor;
	if (active) {
		const selection = active.selection;
		lines.push(
			`Active editor: ${active.document.uri.scheme === "file" ? active.document.uri.fsPath : active.document.uri.toString()}`,
		);
		if (!selection.isEmpty) {
			lines.push(
				`Selection: lines ${selection.start.line + 1}-${selection.end.line + 1}`,
			);
		}
	}
	const editors = vscode.workspace.textDocuments.filter(
		(document) =>
			document.isUntitled ||
			document.isDirty ||
			document.uri.scheme === "untitled",
	);
	if (editors.length) {
		lines.push("Unsaved editors:");
		for (const document of editors.slice(0, 8)) {
			const label =
				document.uri.scheme === "file"
					? document.uri.fsPath
					: document.uri.toString();
			lines.push(
				`- ${label}${document.isDirty ? " dirty" : ""}${document.isUntitled ? " untitled" : ""}`,
			);
		}
	}
	const terminals = vscode.window.terminals;
	lines.push(
		terminals.length
			? `Integrated terminals: ${terminals.map((terminal) => (terminal === vscode.window.activeTerminal ? `${terminal.name} (focused)` : terminal.name)).join(", ")}`
			: "Integrated terminals: none",
	);
	const problems = vscode.languages.getDiagnostics();
	let errors = 0;
	let warnings = 0;
	for (const [, diagnostics] of problems) {
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
				errors++;
			} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
				warnings++;
			}
		}
	}
	lines.push(`Problems: ${errors} errors, ${warnings} warnings`);
	return lines.join("\n");
}

async function runTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	if (name === TERMINAL_TOOL_NAME && args.keep_open === true) {
		return runSessionTool("spawnTerminal", args);
	}
	if (name === TERMINAL_TOOL_NAME) {
		return runInEditor(args);
	}
	if (SESSION_TOOL_NAMES.has(name)) {
		return runSessionTool(name, args);
	}
	return `Error: Unknown editor tool ${name}.`;
}

async function runInEditor(args: Record<string, unknown>): Promise<string> {
	const command = typeof args.command === "string" ? args.command.trim() : "";
	if (!command) {
		throw new Error("command is required");
	}
	const cwd =
		typeof args.working_directory === "string" && args.working_directory.trim()
			? args.working_directory.trim()
			: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const keepOpen = args.keep_open === true;
	const name = keepOpen ? sessionName(command) : "Agent Terminal";
	const terminal = vscode.window.createTerminal({
		name,
		cwd,
		hideFromUser: !keepOpen,
		isTransient: !keepOpen,
	});
	if (keepOpen) {
		terminal.show(false);
		terminal.sendText(command, true);
		return `Opened an integrated terminal "${name}" running \`${command}\`. It stays open in the terminal panel.`;
	}
	const integration = await waitForShellIntegration(terminal);
	if (!integration) {
		terminal.sendText(command, true);
		return `Sent \`${command}\` to the integrated terminal "${name}".`;
	}
	const execution = integration.executeCommand(command);
	const result = await readExecution(execution);
	terminal.dispose();
	const exit =
		result.exitCode === undefined ? "" : `\nExit code: ${result.exitCode}`;
	const output = `${result.output}${exit}`.trim();
	return output || `Sent \`${command}\` to the integrated terminal "${name}".`;
}

export interface LaunchContext {
	/** 0 for a chat turn, one more for each agent that started another. */
	readonly depth: number;
	readonly agent?: string;
	readonly displayName?: string;
	readonly model?: string;
	readonly mode?: ChatTurnMode;
	readonly cwd?: string;
	readonly extraDirectories?: readonly string[];
	/** The chat that shows this launch's activity, when there is one. */
	readonly children?: ChildRunSink;
}

export interface AgentHostRequest {
	/** Run id; the host keeps one CLI session per run so sendAgent can continue it. */
	readonly runId: string;
	readonly instance: ProviderInstance;
	readonly model?: string;
	readonly mode: ChatTurnMode;
	/** The text sent. `fresh` is true when the CLI holds none of this run's earlier turns. */
	readonly prompt: (fresh: boolean) => string;
	readonly cwd?: string;
	readonly extraDirectories: readonly string[];
	readonly depth: number;
}

/** What the bridge needs from the extension to list and start agents. */
export interface AgentHost {
	instances(): readonly ProviderInstance[];
	models(
		instance: ProviderInstance,
	): Promise<readonly { readonly id: string; readonly name: string }[]>;
	limits(): { readonly maxDepth: number; readonly maxRunning: number };
	run(
		request: AgentHostRequest,
		handlers: { onText(text: string): void; onEvent(event: AgentEvent): void },
		token: vscode.CancellationToken,
	): Promise<void>;
	/** Whether a run on this provider keeps a CLI session that sendAgent can continue. */
	canFollowUp(instance: ProviderInstance): boolean;
	/** The run is over for good: stop its CLI process and forget its session. */
	release(runId: string): void;
	log(message: string): void;
}

/** A launch that can serve several turns of one long-lived CLI process. */
export interface SessionToolLaunch extends EditorToolLaunch {
	/** Starts the next turn: the guard reads the new prompt, and child runs show in this turn's chat. */
	updateTurn(userPrompt: string, children?: ChildRunSink): void;
	/** Ends the current turn: stops the agents it started and closes the terminals it opened. */
	endTurn(): void;
}

export interface EditorToolBridge extends vscode.Disposable {
	prepare(userPrompt: string, context?: LaunchContext): SessionToolLaunch;
}

interface LaunchState extends Omit<LaunchContext, "children"> {
	readonly id: string;
	/** Replaced per turn when one process serves several turns. */
	children?: ChildRunSink;
	/** Terminals this launch opened for itself. They are closed when it ends. */
	readonly terminals: Set<number>;
}

/** Runs a session tool and keeps track of the terminals the agent opens and closes. */
async function runTrackedTool(
	state: LaunchState,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const result = await runTool(name, args);
	const spawned =
		name === "spawnTerminal" ||
		(name === TERMINAL_TOOL_NAME && args.keep_open === true);
	if (spawned && args.for_user !== true) {
		const id = spawnedTerminalId(result);
		if (id !== undefined) {
			state.terminals.add(id);
		}
	}
	if (name === "closeTerminal") {
		state.terminals.delete(Number(args.id));
	}
	return result;
}

/** Closes what a finished launch left open. A terminal the user already closed is just skipped. */
function closeLaunchTerminals(state: LaunchState): void {
	for (const id of state.terminals) {
		void runTool("closeTerminal", { id }).catch(() => undefined);
	}
	state.terminals.clear();
}

function findInstance(
	instances: readonly ProviderInstance[],
	name: string,
): ProviderInstance | undefined {
	const wanted = name.trim().toLowerCase();
	return (
		instances.find((item) => item.id.toLowerCase() === wanted) ??
		instances.find((item) => item.displayName.toLowerCase() === wanted)
	);
}

export async function startEditorToolBridge(
	host?: AgentHost,
): Promise<EditorToolBridge> {
	const dir = mkdtempSync(join(tmpdir(), "thrice-editor-tools-"));
	const shimPath = join(dir, "shim.mjs");
	const guardPath = join(dir, "guard.mjs");
	writeFileSync(shimPath, SHIM);
	writeFileSync(guardPath, GUARD);
	/** Each launch has its own token, so a tool call says which agent made it. */
	const launches = new Map<string, LaunchState>();
	const pending = new Map<string, vscode.CancellationTokenSource>();
	const runs = new AgentRuns((run) => {
		if (run.status === "running") {
			host?.log(
				`${run.id} started: ${run.displayName}${run.model ? ` (${run.model})` : ""}, ${run.mode}, depth ${run.depth}, in ${run.owner}`,
			);
		} else {
			host?.log(`${run.id} ${run.status}${run.error ? `: ${run.error}` : ""}`);
		}
	});
	const server = createServer((req, res) => {
		void handle(req, res);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : 0;

	function canSpawn(state: LaunchState): boolean {
		return !!host && state.depth < host.limits().maxDepth;
	}

	async function listAgents(state: LaunchState): Promise<string> {
		if (!host) {
			return "Error: Agent providers are not available in this window.";
		}
		const instances = host.instances().filter((item) => item.enabled);
		const listings = await Promise.all(
			instances.map(async (instance) => ({
				id: instance.id,
				displayName: instance.displayName,
				driver: instance.driver,
				models: await host.models(instance).catch(() => []),
				missing: missingEnvironment(instance),
			})),
		);
		const limits = host.limits();
		return formatAgentList(listings, {
			self: { agent: state.agent, model: state.model },
			depth: state.depth,
			maxDepth: limits.maxDepth,
			running: runs.running(),
			maxRunning: limits.maxRunning,
			runs: runs.ownedBy(state.id),
		});
	}

	function refuseStart(
		state: LaunchState,
		limits: { readonly maxDepth: number; readonly maxRunning: number },
	): string | undefined {
		if (state.depth >= limits.maxDepth) {
			return `Error: You cannot start agents at depth ${state.depth}. The limit is ${limits.maxDepth} (setting thrice.agents.maxDepth).`;
		}
		if (runs.running() >= limits.maxRunning) {
			return `Error: ${runs.running()} agents are already running, the limit (setting thrice.agents.maxRunning). Wait for one with waitAgent or end one with stopAgent.`;
		}
		return undefined;
	}

	interface ChildTurn {
		readonly instance: ProviderInstance;
		readonly model?: string;
		readonly mode: ChatTurnMode;
		readonly cwd?: string;
		/** What the parent asked this turn, shown in its chat. */
		readonly asked: string;
		readonly text: (fresh: boolean) => string;
	}

	/**
	 * The launcher for one turn of a child run: starts it through the host, feeds the run's
	 * progress, and nests its activity under the parent's runAgent or sendAgent call.
	 */
	function childTurn(
		agentHost: AgentHost,
		state: LaunchState,
		turn: ChildTurn,
		view: () => ChildRunView | undefined,
	): (sink: AgentRunSink) => AgentLaunchHandle {
		const show = (action: (view: ChildRunView) => void) => {
			try {
				const current = view();
				if (current) {
					action(current);
				}
			} catch (error) {
				agentHost.log(
					`Could not show agent activity: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};
		return (sink) => {
			const source = new vscode.CancellationTokenSource();
			const done = agentHost
				.run(
					{
						// From the sink: `runs.start` calls this before it returns the run, so the run id is not
						// known to the caller yet. An empty id would put every child on one shared session.
						runId: sink.runId,
						instance: turn.instance,
						model: turn.model,
						mode: turn.mode,
						prompt: turn.text,
						cwd: turn.cwd,
						extraDirectories:
							turn.cwd === state.cwd ? (state.extraDirectories ?? []) : [],
						depth: state.depth + 1,
					},
					{
						onText: (text) => sink.text(text),
						onEvent: (event) => {
							if (event.kind === "toolStart") {
								sink.activity(event.label);
							}
							show((current) => current.event(event));
						},
					},
					source.token,
				)
				.finally(() => {
					source.dispose();
					show((current) => current.finished());
				});
			return { done, stop: () => source.cancel() };
		};
	}

	function showChild(
		agentHost: AgentHost,
		state: LaunchState,
		run: AgentRun,
		turn: ChildTurn,
	): ChildRunView | undefined {
		try {
			return state.children?.started({
				id: `${run.id}.${run.turns}`,
				agent: turn.instance.id,
				displayName: turn.instance.displayName,
				model: turn.model,
				mode: turn.mode,
				prompt: turn.asked,
			});
		} catch (error) {
			agentHost.log(
				`Could not show ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	/** Returns at once for wait false; otherwise waits, and stops the run if the caller gave up. */
	async function answer(
		run: AgentRun,
		args: Record<string, unknown>,
		token: vscode.CancellationToken,
		started: string,
		note: string,
	): Promise<string> {
		if (args.wait === false) {
			return `${started}${note} Call waitAgent with id ${run.id} for its answer.`;
		}
		await runs.wait(run.id, waitMs(args.timeout_ms, DEFAULT_WAITS.run), token);
		if (token.isCancellationRequested) {
			runs.stop(run.id);
		}
		return note ? `${formatRun(run)}\n\n${note.trim()}` : formatRun(run);
	}

	async function runAgent(
		state: LaunchState,
		args: Record<string, unknown>,
		token: vscode.CancellationToken,
	): Promise<string> {
		if (!host) {
			return "Error: Agent providers are not available in this window.";
		}
		const refused = refuseStart(state, host.limits());
		if (refused) {
			return refused;
		}
		const name = typeof args.agent === "string" ? args.agent : "";
		const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
		if (!name || !prompt) {
			return "Error: agent and prompt are required.";
		}
		const instance = findInstance(
			host.instances().filter((item) => item.enabled),
			name,
		);
		if (!instance) {
			return `Error: No enabled provider is called ${name}. Call listAgents for the ids.`;
		}
		const missing = missingEnvironment(instance);
		if (missing.length > 0) {
			return `Error: ${instance.displayName} needs ${missing.join(", ")} from your environment or Thrice provider settings.`;
		}
		const model =
			typeof args.model === "string" && args.model.trim()
				? args.model.trim()
				: undefined;
		// A read-only turn cannot change the project through an agent it starts.
		const chosen = childMode(state.mode, args.mode);
		const mode = normalizeChatTurnMode(chosen.mode);
		const cwd =
			typeof args.working_directory === "string" &&
			args.working_directory.trim()
				? args.working_directory.trim()
				: state.cwd;
		const turn: ChildTurn = {
			instance,
			model,
			mode,
			cwd,
			asked: prompt,
			text: () => childPrompt(prompt, state),
		};
		// Set once the run exists; the chat matches it to the runAgent call that asked for it.
		let view: ChildRunView | undefined;
		const run = runs.start(
			{
				agent: instance.id,
				displayName: instance.displayName,
				model,
				mode,
				prompt,
				owner: state.id,
				depth: state.depth + 1,
				resumable: host.canFollowUp(instance),
			},
			childTurn(host, state, turn, () => view),
		);
		view = showChild(host, state, run, turn);
		const note = chosen.forced
			? ` It runs in ${mode} mode because you do.`
			: "";
		return answer(
			run,
			args,
			token,
			`Started ${run.id} on ${run.displayName}${model ? ` (${model})` : ""}.`,
			note,
		);
	}

	async function sendAgent(
		state: LaunchState,
		args: Record<string, unknown>,
		token: vscode.CancellationToken,
	): Promise<string> {
		if (!host) {
			return "Error: Agent providers are not available in this window.";
		}
		const id = typeof args.id === "string" ? args.id : "";
		const message = typeof args.prompt === "string" ? args.prompt.trim() : "";
		const run = runs.get(id);
		if (!run || run.owner !== state.id) {
			return `Error: You have no agent run ${id || "(missing id)"}. Call listAgents to see yours.`;
		}
		if (!message) {
			return "Error: prompt is required.";
		}
		if (run.status === "running") {
			return `Error: ${run.id} is still running. Call waitAgent with id ${run.id} first.`;
		}
		if (!run.resumable) {
			return `Error: ${run.displayName} does not keep a session to continue. Start a new agent with runAgent and include what it needs.`;
		}
		const instance = host
			.instances()
			.find((item) => item.id === run.agent && item.enabled);
		if (!instance) {
			return `Error: ${run.displayName} is no longer enabled.`;
		}
		const refused = refuseStart(state, host.limits());
		if (refused) {
			return refused;
		}
		const turn: ChildTurn = {
			instance,
			model: run.model,
			mode: normalizeChatTurnMode(run.mode),
			cwd:
				typeof args.working_directory === "string" &&
				args.working_directory.trim()
					? args.working_directory.trim()
					: state.cwd,
			asked: message,
			text: (fresh) => followUpPrompt(message, run.prompt, state, fresh),
		};
		let view: ChildRunView | undefined;
		if (
			!runs.resume(
				run.id,
				childTurn(host, state, turn, () => view),
			)
		) {
			return `Error: ${run.id} cannot take a follow-up right now.`;
		}
		view = showChild(host, state, run, turn);
		return answer(
			run,
			args,
			token,
			`Sent a follow-up to ${run.id} on ${run.displayName}.`,
			"",
		);
	}

	/** Stops a launch's agents and frees their CLI sessions. */
	function releaseRuns(state: LaunchState): void {
		for (const id of runs.release(state.id)) {
			try {
				host?.release(id);
			} catch (error) {
				host?.log(
					`Could not release ${id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async function waitAgent(
		state: LaunchState,
		args: Record<string, unknown>,
		token: vscode.CancellationToken,
	): Promise<string> {
		const id = typeof args.id === "string" ? args.id : "";
		const run = runs.get(id);
		if (!run || run.owner !== state.id) {
			return `Error: You have no agent run ${id || "(missing id)"}. Call listAgents to see yours.`;
		}
		await runs.wait(id, waitMs(args.timeout_ms, DEFAULT_WAITS.poll), token);
		return formatRun(run);
	}

	function stopAgent(
		state: LaunchState,
		args: Record<string, unknown>,
	): string {
		const id = typeof args.id === "string" ? args.id : "";
		const run = runs.get(id);
		if (!run || run.owner !== state.id) {
			return `Error: You have no agent run ${id || "(missing id)"}.`;
		}
		return runs.stop(id)
			? `Stopped ${id}.`
			: `${id} had already ${run.status === "done" ? "finished" : run.status}.`;
	}

	function runAgentTool(
		state: LaunchState,
		name: string,
		args: Record<string, unknown>,
		token: vscode.CancellationToken,
	): Promise<string> | string {
		switch (name) {
			case AGENT_TOOL_NAMES.list:
				return listAgents(state);
			case AGENT_TOOL_NAMES.run:
				return runAgent(state, args, token);
			case AGENT_TOOL_NAMES.wait:
				return waitAgent(state, args, token);
			case AGENT_TOOL_NAMES.send:
				return sendAgent(state, args, token);
			case AGENT_TOOL_NAMES.stop:
				return stopAgent(state, args);
			default:
				return `Error: Unknown agent tool ${name}.`;
		}
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const header = req.headers.authorization ?? "";
		const state = header.startsWith("Bearer ")
			? launches.get(header.slice("Bearer ".length))
			: undefined;
		if (!state) {
			res.statusCode = 401;
			res.end();
			return;
		}
		try {
			const body = await readBody(req);
			if (req.url === "/guard") {
				const parsed = JSON.parse(body) as {
					hook?: unknown;
					promptFile?: unknown;
				};
				const hook = typeof parsed.hook === "string" ? parsed.hook : "";
				const promptFile =
					typeof parsed.promptFile === "string" ? parsed.promptFile : "";
				let userText = "";
				try {
					userText = promptFile ? readFileSync(promptFile, "utf8") : "";
				} catch {
					userText = "";
				}
				const reason = denialFromHook(hook, userText);
				res.setHeader("content-type", "application/json");
				res.end(
					reason
						? JSON.stringify({
								hookSpecificOutput: {
									hookEventName: "PreToolUse",
									permissionDecision: "deny",
									permissionDecisionReason: reason,
								},
								permissionDecision: "deny",
								permissionDecisionReason: reason,
							})
						: "",
				);
				return;
			}
			const action = interpretMcp(JSON.parse(body), {
				agents: !!host,
				canSpawn: canSpawn(state),
			});
			if (action.kind === "none") {
				res.end();
				return;
			}
			if (action.kind === "cancel") {
				pending
					.get(`${state.id}:${JSON.stringify(action.requestId)}`)
					?.cancel();
				res.end();
				return;
			}
			if (action.kind === "reply") {
				res.end(mcpStdioFrame(action.message));
				return;
			}
			const key = `${state.id}:${JSON.stringify(action.id)}`;
			const source = new vscode.CancellationTokenSource();
			pending.set(key, source);
			res.on("close", () => {
				if (!res.writableFinished) {
					source.cancel();
				}
			});
			try {
				const text = AGENT_TOOL_NAME_SET.has(action.name)
					? await runAgentTool(state, action.name, action.args, source.token)
					: await runTrackedTool(state, action.name, action.args);
				const isError = text.startsWith("Error:");
				res.end(mcpStdioFrame(toolResultMessage(action.id, text, isError)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.end(mcpStdioFrame(toolResultMessage(action.id, message, true)));
			} finally {
				pending.delete(key);
				source.dispose();
			}
		} catch (error) {
			res.statusCode = 400;
			res.end(error instanceof Error ? error.message : String(error));
		}
	}

	return {
		prepare(
			userPrompt: string,
			context: LaunchContext = { depth: 0 },
		): SessionToolLaunch {
			const id = randomBytes(4).toString("hex");
			const token = randomBytes(24).toString("hex");
			const state: LaunchState = {
				...context,
				id: `launch-${id}`,
				terminals: new Set(),
			};
			launches.set(token, state);
			const launchDir = join(dir, `turn-${id}`);
			mkdirSync(launchDir);
			const promptFile = join(launchDir, "prompt.txt");
			const settingsFile = join(launchDir, "settings.json");
			const mcpConfigFile = join(launchDir, "mcp.json");
			writeFileSync(promptFile, userPrompt);
			writeFileSync(
				mcpConfigFile,
				JSON.stringify({
					mcpServers: {
						thrice: { command: "node", args: [shimPath, String(port), token] },
					},
				}),
			);
			const command = `node ${shellQuote(guardPath)} ${port} ${token} ${shellQuote(promptFile)}`;
			writeFileSync(
				settingsFile,
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [{ type: "command", command, timeout: 10 }],
							},
						],
					},
				}),
			);
			let disposed = false;
			return {
				mcpConfigFile,
				settingsFile,
				shimPath,
				port,
				token,
				agentTools: canSpawn(state),
				updateTurn: (text, children) => {
					if (disposed) {
						return;
					}
					writeFileSync(promptFile, text);
					state.children = children;
				},
				endTurn: () => {
					if (disposed) {
						return;
					}
					// Same cleanup as dispose, which no longer runs between turns of a long-lived process.
					releaseRuns(state);
					closeLaunchTerminals(state);
				},
				dispose: () => {
					if (disposed) {
						return;
					}
					disposed = true;
					launches.delete(token);
					for (const [key, source] of pending) {
						if (key.startsWith(`${state.id}:`)) {
							source.cancel();
						}
					}
					// An agent's children and its own terminals end with it, so nothing keeps running unseen.
					releaseRuns(state);
					closeLaunchTerminals(state);
					rmSync(launchDir, { recursive: true, force: true });
				},
			};
		},
		dispose: () => {
			for (const state of launches.values()) {
				releaseRuns(state);
				closeLaunchTerminals(state);
			}
			launches.clear();
			server.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
