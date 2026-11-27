import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { readInstalledInstances } from "./installed";
import {
	missingEnvironment,
	normalizeChatTurnMode,
	parseUserInstances,
	resolveInstances,
	type ProviderInstance,
} from "./instances";
import { discoverModels } from "./catalog";
import { modelsForDriver, type HubModel } from "./models";
import {
	sessionBrief,
	startEditorToolBridge,
	type AgentHost,
	type EditorToolBridge,
} from "./editorTools";
import { runInstance, type RunOptions } from "./run";
import { ActivityRenderer, type FileChangeRecord } from "./activity";
import {
	captureSnapshot,
	diffSnapshots,
	readAt,
	repoRoot,
	sanitizeSessionKey,
	type SnapshotResult,
} from "./checkpoints";
import { gitContextBrief, registerGitChangesCommand } from "./gitContext";
import { LiveEditRecorder } from "./liveEdits";
import { TurnScopes, type TurnScope } from "./turnScope";
import { watchYield } from "./steering";
import { createClaudeSession } from "./sessions/claudeSession";
import { createCodexSession } from "./sessions/codexSession";
import {
	MemorySessionStore,
	SessionManager,
	type SessionStore,
	type StoredSession,
	type TurnLaunch,
} from "./sessions/manager";

const SETTING = "thrice.providers.instances";

function promptFrom(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
	return messages
		.map((message) => {
			const role =
				message.role === vscode.LanguageModelChatMessageRole.Assistant
					? "Assistant"
					: "User";
			const text = message.content
				.map((part) => {
					if (typeof part === "string") {
						return part;
					}
					if (
						part &&
						typeof part === "object" &&
						"value" in part &&
						typeof (part as { value?: unknown }).value === "string"
					) {
						return (part as { value: string }).value;
					}
					return "";
				})
				.join("");
			return text ? `${role}:\n${text}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function currentInstances(): ProviderInstance[] {
	const configured = vscode.workspace.getConfiguration().get(SETTING);
	return resolveInstances(
		readInstalledInstances(),
		parseUserInstances(configured),
		process.env,
	);
}

let editorToolBridge: EditorToolBridge | undefined;
/** One long-lived CLI process per chat for drivers that support it (Claude, Codex). */
let sessions: SessionManager | undefined;
/**
 * One CLI session per agent another agent started (keyed by run id), so sendAgent can continue
 * it. Separate from chat sessions: never persisted, and it does not count against their limit.
 */
let agentSessions: SessionManager | undefined;

const SESSION_STATE_PREFIX = "thrice.sessions.";

/** Chat → CLI session id, kept per workspace so a reloaded window resumes the same CLI sessions. */
function workspaceSessionStore(state: vscode.Memento): SessionStore {
	return {
		get: (chatKey) => state.get<StoredSession>(SESSION_STATE_PREFIX + chatKey),
		set: (chatKey, value) =>
			state.update(SESSION_STATE_PREFIX + chatKey, value),
		delete: (chatKey) =>
			state.update(SESSION_STATE_PREFIX + chatKey, undefined),
	};
}

/** Lets an agent list this editor's providers and start one through the thrice MCP server. */
function agentHost(log: vscode.LogOutputChannel): AgentHost {
	return {
		instances: () => currentInstances(),
		models: async (instance) => {
			const models = await vscode.lm.selectChatModels({ vendor: instance.id });
			return models.length
				? models.map((model) => ({ id: model.id, name: model.name }))
				: modelsForDriver(instance.driver);
		},
		limits: () => {
			const config = vscode.workspace.getConfiguration("thrice.agents");
			return {
				maxDepth: Math.max(0, Math.floor(config.get<number>("maxDepth", 1))),
				maxRunning: Math.max(
					1,
					Math.floor(config.get<number>("maxRunning", 4)),
				),
			};
		},
		canFollowUp: (instance) =>
			agentSessions?.supports(instance.driver) === true,
		release: (runId) => agentSessions?.forget(runId),
		run: async (request, handlers, token) => {
			const brief = await sessionBrief();
			if (agentSessions?.supports(request.instance.driver)) {
				await agentSessions.runTurn(
					request.runId,
					{
						instance: request.instance,
						cwd: request.cwd ?? workspaceFolders()[0] ?? homedir(),
						extraDirectories: request.extraDirectories,
						model: request.model ?? "",
						mode: request.mode,
						env: process.env,
						agentDepth: request.depth,
					},
					({ fresh }) =>
						fresh
							? `${brief}\n\n${request.prompt(true)}`
							: request.prompt(false),
					{
						onEvent: (event) => {
							if (event.kind === "text") {
								handlers.onText(event.text);
							}
							handlers.onEvent(event);
						},
					},
					token,
				);
				return;
			}
			const abort = new AbortController();
			const subscription = token.onCancellationRequested(() => abort.abort());
			try {
				await runInstance(
					request.instance,
					`${brief}\n\n${request.prompt(true)}`,
					{
						cwd: request.cwd ?? workspaceFolders()[0] ?? homedir(),
						extraDirectories: request.extraDirectories,
						model: request.model,
						mode: request.mode,
						editorTools: editorToolBridge,
						agentDepth: request.depth,
						signal: abort.signal,
						onText: handlers.onText,
						onEvent: handlers.onEvent,
					},
				);
			} finally {
				subscription.dispose();
			}
		},
		log: (message) => log.info(message),
	};
}

/**
 * Runs one turn on a hub instance: instance lookup, environment check, chat mode, workspace
 * folders, session brief, then the CLI. Shared by the LM provider (text only) and the
 * participant (full activity).
 */
async function runHubTurn(
	hubId: string,
	modelId: string,
	modelName: string,
	prompt: string | HubPrompt,
	token: vscode.CancellationToken,
	handlers: Pick<RunOptions, "onText" | "onEvent" | "childRuns">,
	cwdOverride?: string,
	extraBrief?: string,
	chatKey?: string,
): Promise<void> {
	const instance = currentInstances().find((item) => item.id === hubId);
	if (!instance) {
		throw new Error(`${modelName} is no longer available.`);
	}
	const missing = missingEnvironment(instance);
	if (missing.length > 0) {
		throw new Error(
			`${instance.displayName} needs ${missing.join(", ")} from your environment or Thrice provider settings.`,
		);
	}
	const mode = normalizeChatTurnMode(
		vscode.workspace.getConfiguration("thrice").get<string>("chat.mode"),
	);
	const folders = workspaceFolders();
	const brief = [await sessionBrief(), extraBrief].filter(Boolean).join("\n\n");
	if (chatKey && sessions?.supports(instance.driver)) {
		// The CLI keeps the conversation; history is only sent when it has to start a fresh session.
		await sessions.runTurn(
			chatKey,
			{
				instance,
				cwd: cwdOverride ?? folders[0] ?? homedir(),
				extraDirectories: folders.slice(1),
				model: modelId,
				mode,
				env: process.env,
			},
			({ fresh }) =>
				`${brief}\n\n${typeof prompt === "string" ? prompt : prompt(fresh)}`,
			{
				onEvent: (event) => handlers.onEvent?.(event),
				children: handlers.childRuns,
			},
			token,
		);
		return;
	}
	const abort = new AbortController();
	const subscription = token.onCancellationRequested(() => abort.abort());
	try {
		await runInstance(
			instance,
			`${brief}\n\n${typeof prompt === "string" ? prompt : prompt(true)}`,
			{
				cwd: cwdOverride ?? folders[0] ?? homedir(),
				extraDirectories: folders.slice(1),
				model: modelId,
				mode,
				editorTools: editorToolBridge,
				signal: abort.signal,
				...handlers,
			},
		);
	} finally {
		subscription.dispose();
	}
}

/** Prompt text for a turn: with `fresh`, the CLI holds none of the chat yet, so include the history. */
type HubPrompt = (fresh: boolean) => string;

function workspaceFolders(): string[] {
	return (
		vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
	);
}

/**
 * What the participant knows about a turn. Built before the CLI starts.
 */
export interface TurnContext {
	/** Working directory the CLI runs in (first workspace folder, else home). */
	readonly cwd: string;
	/** `request.sessionId` (chatParticipantPrivate, deprecated upstream in favour of sessionResource). */
	readonly sessionId: string | undefined;
	/** `request.sessionResource` (chatParticipantPrivate). */
	readonly sessionResource: vscode.Uri | undefined;
	/** `request.id` (chatParticipantPrivate). */
	readonly requestId: string | undefined;
	/**
	 * Zero-based index of this request in the session: the number of `ChatRequestTurn`s in
	 * `chatContext.history`. The default participant sees every earlier request that has a response.
	 */
	readonly turn: number;
	/** Hub (vendor) id and model id that run the turn. */
	readonly hubId: string;
	readonly modelId: string;
	readonly request: vscode.ChatRequest;
	readonly stream: vscode.ChatResponseStream;
	readonly token: vscode.CancellationToken;
}

/**
 * Integration hook: runs before the CLI starts (e.g. capture a start snapshot). Must not throw;
 * errors are logged and the turn continues.
 */
async function beforeTurn(ctx: TurnContext): Promise<void> {
	const key = sessionKeyOf(ctx);
	if (!key) {
		return;
	}
	// Begun before the start snapshot, so any change another turn makes after it is seen.
	const root = await repoRoot(ctx.cwd);
	if (root) {
		turnScopeOf.set(ctx, turnScopes.begin(root));
	}
	// Taken before the CLI starts, so every edit the agent makes is covered by this snapshot.
	const start = await captureSnapshot(ctx.cwd, key, ctx.turn, "start");
	if (start) {
		startSnapshots.set(ctx, start);
	}
}

const startSnapshots = new WeakMap<TurnContext, SnapshotResult>();

/** The turns running in each repo, so a turn's sweep does not claim another turn's or the user's changes. */
const turnScopes = new TurnScopes();
const turnScopeOf = new WeakMap<TurnContext, TurnScope>();
let turnLog: vscode.LogOutputChannel | undefined;

/** `file` with symlinks resolved, as the repo root is; for a deleted file, its folder's. */
async function realFile(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch {
		const slash = file.lastIndexOf("/");
		if (slash <= 0) {
			return file;
		}
		const dir = await fs
			.realpath(file.slice(0, slash))
			.catch(() => file.slice(0, slash));
		return `${dir}/${file.slice(slash + 1)}`;
	}
}

/** Records that the turn's agent edited `file`, so other turns running in the repo leave it alone. */
function reportTurnFile(ctx: TurnContext, file: string): void {
	const scope = turnScopeOf.get(ctx);
	if (!scope) {
		return;
	}
	scope.report(file);
	void realFile(file).then((real) => {
		if (real !== file) {
			scope.report(real);
		}
	});
}

/** Snapshot ref key: the same id the workbench's Changes command sends (local id, else resource URI). */
function sessionKeyOf(ctx: TurnContext): string | undefined {
	const id = ctx.sessionId ?? ctx.sessionResource?.toString();
	return id ? sanitizeSessionKey(id) : undefined;
}

/** Files larger than this are listed in the diff view but not recorded into chat edits. */
const MAX_RECORDED_BYTES = 2 * 1024 * 1024;

type TurnEdit = { uri: string; before: string | null; after: string | null };

/**
 * `partial` records files into the chat editing session while the turn is still running, without
 * ending the turn's external-edit mode; the final (non-partial) call at turn end does that.
 */
async function sendTurnEdits(
	ctx: TurnContext,
	edits: readonly TurnEdit[],
	partial: boolean,
): Promise<void> {
	await vscode.commands.executeCommand<boolean>(
		"_thrice.chat.recordTurnEdits",
		{
			toolInvocationToken: ctx.request.toolInvocationToken,
			sessionResource: ctx.sessionResource?.toString(),
			requestId: ctx.requestId,
			edits,
			...(partial ? { partial: true } : {}),
		},
	);
}

const liveRecorders = new WeakMap<TurnContext, LiveEditRecorder>();

/** Records each file into chat edits as soon as the agent reports editing it (needs the start snapshot). */
async function startLiveEdits(
	ctx: TurnContext,
): Promise<LiveEditRecorder | undefined> {
	const start = startSnapshots.get(ctx);
	const root = start && (await repoRoot(ctx.cwd));
	if (!start || !root) {
		return undefined;
	}
	const recorder = new LiveEditRecorder({
		io: {
			root,
			readStart: (rel) => readAt(ctx.cwd, start.commit, rel),
			readCurrent: (file) =>
				fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT" || error.code === "ENOTDIR") {
						return undefined;
					}
					throw error;
				}),
			realpath: (file) => fs.realpath(file).catch(() => undefined),
		},
		send: (edits) =>
			sendTurnEdits(
				ctx,
				edits.map((edit) => ({
					uri: vscode.Uri.file(edit.filePath).toString(),
					before: edit.before,
					after: edit.after,
				})),
				true,
			),
		log: (message, error) => console.error(`[thrice] ${message}`, error),
	});
	liveRecorders.set(ctx, recorder);
	return recorder;
}

/**
 * `liveRecorded` are the files already recorded during the turn (`<root>/<rel>`). One the diff no
 * longer lists (the agent reverted it) is recorded again with its unchanged content.
 */
async function recordTurnEdits(
	ctx: TurnContext,
	start: SnapshotResult,
	end: SnapshotResult,
	liveRecorded: readonly string[] = [],
): Promise<void> {
	const root = await repoRoot(ctx.cwd);
	if (!root) {
		return;
	}
	const changes = await diffSnapshots(ctx.cwd, start.commit, end.commit);
	const scope = turnScopeOf.get(ctx);
	const edits: TurnEdit[] = [];
	const listed = new Set<string>();
	const dropped: string[] = [];
	for (const change of changes) {
		if ((change as { binary?: boolean }).binary) {
			continue;
		}
		if (scope) {
			// A rename counts as this turn's when the agent reported either path.
			const paths = [
				change.path,
				...(change.oldPath ? [change.oldPath] : []),
			].map((rel) => `${root}/${rel}`);
			const why = paths.map((file) => scope.attribute(file));
			if (
				!why.includes("reported") &&
				!why.every((reason) => reason === "unreported")
			) {
				dropped.push(
					`${change.path} (${why.find((reason) => reason !== "unreported")})`,
				);
				continue;
			}
		}
		if (change.oldPath && change.oldPath !== change.path) {
			const before = await readAt(ctx.cwd, start.commit, change.oldPath);
			listed.add(change.oldPath);
			edits.push({
				uri: vscode.Uri.file(`${root}/${change.oldPath}`).toString(),
				before: before ?? null,
				after: null,
			});
		}
		listed.add(change.path);
		const before =
			change.status === "added" || change.oldPath
				? undefined
				: await readAt(ctx.cwd, start.commit, change.path);
		const after =
			change.status === "deleted"
				? undefined
				: await readAt(ctx.cwd, end.commit, change.path);
		if (
			(before?.length ?? 0) > MAX_RECORDED_BYTES ||
			(after?.length ?? 0) > MAX_RECORDED_BYTES
		) {
			continue;
		}
		edits.push({
			uri: vscode.Uri.file(`${root}/${change.path}`).toString(),
			before: before ?? null,
			after: after ?? null,
		});
	}
	for (const file of liveRecorded) {
		const rel = file.startsWith(`${root}/`)
			? file.slice(root.length + 1)
			: undefined;
		if (!rel || listed.has(rel)) {
			continue;
		}
		const before = await readAt(ctx.cwd, start.commit, rel);
		const after = await readAt(ctx.cwd, end.commit, rel);
		if (
			(before === undefined && after === undefined) ||
			(before?.length ?? 0) > MAX_RECORDED_BYTES ||
			(after?.length ?? 0) > MAX_RECORDED_BYTES
		) {
			continue;
		}
		edits.push({
			uri: vscode.Uri.file(file).toString(),
			before: before ?? null,
			after: after ?? null,
		});
	}
	if (dropped.length) {
		turnLog?.info(
			`[edits] turn ${ctx.requestId ?? "?"} left out files it cannot attribute to its agent: ${dropped.join(", ")}`,
		);
	}
	if (edits.length === 0) {
		return;
	}
	await sendTurnEdits(ctx, edits, false);
}

/**
 * Integration hook: runs after the CLI finished, failed or was cancelled (e.g. capture an end
 * snapshot, diff, record edits). `fileChanges` are the paths the agent reported editing (absolute).
 */
async function afterTurn(
	ctx: TurnContext,
	fileChanges: readonly FileChangeRecord[],
	_outcome: { readonly error?: unknown },
): Promise<void> {
	// Every reported file under its real path (as the diff names it) before the sweep attributes files.
	const scope = turnScopeOf.get(ctx);
	if (scope) {
		for (const change of fileChanges) {
			scope.report(await realFile(change.path));
		}
	}
	// Live recording stops here (files not yet due are covered by the full pass below), and the
	// call in flight finishes first so the final record lands after every partial one.
	const live = liveRecorders.get(ctx);
	await live?.close();
	// Recorded even after a failure or cancel: whatever the agent wrote is on disk either way.
	const start = startSnapshots.get(ctx);
	const key = sessionKeyOf(ctx);
	if (!start || !key) {
		return;
	}
	const end = await captureSnapshot(ctx.cwd, key, ctx.turn, "end");
	if (end) {
		await recordTurnEdits(ctx, start, end, live?.recordedPaths());
	}
}

function turnContext(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	cwd: string,
): TurnContext {
	const extra = request as Partial<
		Pick<vscode.ChatRequest, "id" | "sessionId" | "sessionResource">
	>;
	return {
		cwd,
		sessionId:
			typeof extra.sessionId === "string" ? extra.sessionId : undefined,
		sessionResource: extra.sessionResource,
		requestId: typeof extra.id === "string" ? extra.id : undefined,
		turn: chatContext.history.filter(
			(turn) => turn instanceof vscode.ChatRequestTurn,
		).length,
		hubId: request.model.vendor,
		modelId: request.model.id,
		request,
		stream,
		token,
	};
}

async function runHook(name: string, hook: () => Promise<void>): Promise<void> {
	try {
		await hook();
	} catch (error) {
		console.error(`[thrice] ${name} failed`, error);
	}
}

function historyPrompt(
	chatContext: vscode.ChatContext,
	prompt: string,
): string {
	const parts: string[] = [];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			parts.push(`User:\n${turn.prompt}`);
			continue;
		}
		const text = turn.response
			.map((part) =>
				part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : "",
			)
			.join("");
		if (text) {
			parts.push(`Assistant:\n${text}`);
		}
	}
	parts.push(`User:\n${prompt}`);
	return parts.join("\n\n");
}

class HubModels implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
	private discovered: readonly HubModel[] | undefined;
	private discovery: Promise<void> | undefined;

	constructor(private readonly hubId: string) {}

	refresh(): void {
		this.discovery = undefined;
		void this.ensureDiscovered();
		this._onDidChange.fire();
	}

	private ensureDiscovered(): Promise<void> {
		if (!this.discovery) {
			const instance = this.instance();
			this.discovery = instance
				? discoverModels(instance, process.env)
						.then((models) => {
							if (models && models.length > 0) {
								this.discovered = models;
								this._onDidChange.fire();
							}
						})
						.catch(() => undefined)
				: Promise.resolve();
		}
		return this.discovery;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	private instance(): ProviderInstance | undefined {
		return currentInstances().find((item) => item.id === this.hubId);
	}

	async provideLanguageModelChatInformation(): Promise<
		vscode.LanguageModelChatInformation[]
	> {
		const instance = this.instance();
		if (!instance) {
			return [];
		}
		await this.ensureDiscovered();
		const models = this.discovered?.length
			? this.discovered
			: modelsForDriver(instance.driver);
		return models.map((model) => ({
			id: model.id,
			name: model.name,
			family: instance.driver,
			version: "1",
			tooltip: `${model.name} on ${instance.displayName}`,
			maxInputTokens: 200000,
			maxOutputTokens: 32000,
			capabilities: { toolCalling: true },
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		await runHubTurn(
			this.hubId,
			model.id,
			model.name,
			promptFrom(messages),
			token,
			{
				onText: (text) =>
					progress.report(new vscode.LanguageModelTextPart(text)),
			},
		);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		const value = typeof text === "string" ? text : promptFrom([text]);
		return Math.ceil(value.length / 4);
	}
}

async function addProvider(): Promise<void> {
	await vscode.commands.executeCommand("thrice.openAddProvider");
}

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	const agentLog = vscode.window.createOutputChannel("Thrice Agents", {
		log: true,
	});
	context.subscriptions.push(agentLog);
	turnLog = agentLog;
	// A file the user saves while a turn runs is theirs, unless the turn's agent reported editing it.
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.scheme === "file") {
				void realFile(document.uri.fsPath).then((file) =>
					turnScopes.saved(file),
				);
			}
		}),
	);
	try {
		editorToolBridge = await startEditorToolBridge(agentHost(agentLog));
		context.subscriptions.push(editorToolBridge);
	} catch (error) {
		console.error("[thrice] Editor tools failed to start", error);
	}
	const prepareTools = (launch: TurnLaunch) =>
		editorToolBridge?.prepare("", {
			depth: launch.agentDepth ?? 0,
			agent: launch.instance.id,
			displayName: launch.instance.displayName,
			model: launch.model,
			mode: launch.mode,
			cwd: launch.cwd,
			extraDirectories: launch.extraDirectories,
		});
	agentSessions = new SessionManager({
		factories: { claude: createClaudeSession, codex: createCodexSession },
		store: new MemorySessionStore(),
		prepareTools,
		log: {
			info: (message) => agentLog.info(`[agents] ${message}`),
			warn: (message) => agentLog.warn(`[agents] ${message}`),
		},
	});
	context.subscriptions.push(agentSessions);
	sessions = new SessionManager({
		factories: { claude: createClaudeSession, codex: createCodexSession },
		store: workspaceSessionStore(context.workspaceState),
		prepareTools: (launch) =>
			editorToolBridge?.prepare("", {
				depth: 0,
				agent: launch.instance.id,
				displayName: launch.instance.displayName,
				model: launch.model,
				mode: launch.mode,
				cwd: launch.cwd,
				extraDirectories: launch.extraDirectories,
			}),
		log: {
			info: (message) => agentLog.info(message),
			warn: (message) => agentLog.warn(message),
		},
	});
	context.subscriptions.push(sessions);
	const hubs = new Map<string, HubModels>();
	const registerHub = (id: string) => {
		if (hubs.has(id)) {
			return;
		}
		const models = new HubModels(id);
		hubs.set(id, models);
		context.subscriptions.push(models);
		context.subscriptions.push(
			vscode.lm.registerLanguageModelChatProvider(id, models),
		);
	};
	for (const instance of currentInstances()) {
		registerHub(instance.id);
	}
	for (const models of hubs.values()) {
		models.refresh();
	}
	context.subscriptions.push(
		vscode.commands.registerCommand("thrice.providers.add", () =>
			addProvider(),
		),
	);
	context.subscriptions.push(registerGitChangesCommand(vscode));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(SETTING)) {
				return;
			}
			for (const instance of currentInstances()) {
				registerHub(instance.id);
			}
			for (const models of hubs.values()) {
				models.refresh();
			}
		}),
	);

	const participant = vscode.chat.createChatParticipant(
		"thrice.providers.chat",
		async (request, chatContext, stream, token) => {
			const model = request.model;
			if (!model) {
				stream.markdown("Choose Claude Hub, Codex Hub, or Grok Hub.");
				return;
			}
			if (hubs.has(model.vendor)) {
				await runParticipantTurn(request, chatContext, stream, token);
				return;
			}
			const messages: vscode.LanguageModelChatMessage[] = [];
			for (const turn of chatContext.history) {
				if (turn instanceof vscode.ChatRequestTurn) {
					messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
					continue;
				}
				const text = turn.response
					.map((part) =>
						part instanceof vscode.ChatResponseMarkdownPart
							? part.value.value
							: "",
					)
					.join("");
				if (text) {
					messages.push(vscode.LanguageModelChatMessage.Assistant(text));
				}
			}
			messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
			const response = await model.sendRequest(messages, {}, token);
			for await (const chunk of response.text) {
				stream.markdown(chunk);
			}
		},
	);
	context.subscriptions.push(participant);
}

/** Runs a turn on one of our hubs directly so tool activity reaches the chat (not just text). */
async function runParticipantTurn(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<void> {
	const cwd = workspaceFolders()[0] ?? homedir();
	const ctx = turnContext(request, chatContext, stream, token, cwd);
	await runHook("beforeTurn", () => beforeTurn(ctx));
	let live: LiveEditRecorder | undefined;
	await runHook("liveEdits", async () => {
		live = await startLiveEdits(ctx);
	});
	const renderer = new ActivityRenderer(stream, cwd, (change) => {
		reportTurnFile(ctx, change.path);
		live?.schedule(change.path, change.change);
	});
	let gitBrief = "";
	await runHook("gitContextBrief", async () => {
		gitBrief = await gitContextBrief(cwd, { sessionKey: sessionKeyOf(ctx) });
	});
	let failure: unknown;
	// A steering message sets yieldRequested; interrupt the CLI turn (its session stays) so the chat sends it now.
	const turnToken = new vscode.CancellationTokenSource();
	const parentCancel = token.onCancellationRequested(() => turnToken.cancel());
	const steer = watchYield(
		() => chatContext.yieldRequested,
		() => turnToken.cancel(),
	);
	// Steering as in the CLIs: a message sent while the turn runs joins it instead of waiting or restarting.
	const chatKey = sessionKeyOf(ctx);
	const steering = chatKey
		? chatContext.registerSteeringHandler?.(async (message) => {
				const delivered =
					(await sessions?.steer(chatKey, message.prompt)) ?? false;
				if (delivered) {
					renderer.steered(message.prompt);
				}
				return delivered;
			})
		: undefined;
	try {
		await runHubTurn(
			request.model.vendor,
			request.model.id,
			request.model.name,
			(fresh) =>
				fresh ? historyPrompt(chatContext, request.prompt) : request.prompt,
			turnToken.token,
			{
				onEvent: (event) => renderer.handle(event),
				childRuns: renderer,
			},
			cwd,
			gitBrief,
			sessionKeyOf(ctx),
		);
	} catch (error) {
		failure = error;
	} finally {
		steering?.dispose();
		steer.dispose();
		parentCancel.dispose();
		turnToken.dispose();
		renderer.finish();
	}
	try {
		await runHook("afterTurn", () =>
			afterTurn(ctx, renderer.fileChanges(), { error: failure }),
		);
	} finally {
		turnScopeOf.get(ctx)?.end();
	}
	if (
		failure !== undefined &&
		!token.isCancellationRequested &&
		!steer.yielded
	) {
		throw failure;
	}
}

export function deactivate(): void {}
