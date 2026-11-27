import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { readInstalledInstances } from './installed';
import { missingEnvironment, normalizeChatTurnMode, parseUserInstances, resolveInstances, type ProviderInstance } from './instances';
import { discoverModels } from './catalog';
import { modelsForDriver, type HubModel } from './models';
import { sessionBrief, startEditorToolBridge, type EditorToolBridge } from './editorTools';
import { runInstance, type RunOptions } from './run';
import { ActivityRenderer, type FileChangeRecord } from './activity';
import { captureSnapshot, diffSnapshots, readAt, repoRoot, sanitizeSessionKey, type SnapshotResult } from './checkpoints';
import { gitContextBrief, registerGitChangesCommand } from './gitContext';

const SETTING = 'thrice.providers.instances';

function promptFrom(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	return messages.map(message => {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'User';
		const text = message.content.map(part => {
			if (typeof part === 'string') {
				return part;
			}
			if (part && typeof part === 'object' && 'value' in part && typeof (part as { value?: unknown }).value === 'string') {
				return (part as { value: string }).value;
			}
			return '';
		}).join('');
		return text ? `${role}:\n${text}` : '';
	}).filter(Boolean).join('\n\n');
}

function currentInstances(): ProviderInstance[] {
	const configured = vscode.workspace.getConfiguration().get(SETTING);
	return resolveInstances(readInstalledInstances(), parseUserInstances(configured), process.env);
}

let editorToolBridge: EditorToolBridge | undefined;

/**
 * Runs one turn on a hub instance: instance lookup, environment check, chat mode, workspace
 * folders, session brief, then the CLI. Shared by the LM provider (text only) and the
 * participant (full activity).
 */
async function runHubTurn(
	hubId: string,
	modelId: string,
	modelName: string,
	prompt: string,
	token: vscode.CancellationToken,
	handlers: Pick<RunOptions, 'onText' | 'onEvent'>,
	cwdOverride?: string,
	extraBrief?: string,
): Promise<void> {
	const instance = currentInstances().find(item => item.id === hubId);
	if (!instance) {
		throw new Error(`${modelName} is no longer available.`);
	}
	const missing = missingEnvironment(instance);
	if (missing.length > 0) {
		throw new Error(`${instance.displayName} needs ${missing.join(', ')} from your environment or Thrice provider settings.`);
	}
	const abort = new AbortController();
	const subscription = token.onCancellationRequested(() => abort.abort());
	try {
		const mode = normalizeChatTurnMode(vscode.workspace.getConfiguration('thrice').get<string>('chat.mode'));
		const folders = workspaceFolders();
		const brief = [await sessionBrief(), extraBrief].filter(Boolean).join('\n\n');
		await runInstance(instance, `${brief}\n\n${prompt}`, {
			cwd: cwdOverride ?? folders[0] ?? homedir(),
			extraDirectories: folders.slice(1),
			model: modelId,
			mode,
			editorTools: editorToolBridge,
			signal: abort.signal,
			...handlers,
		});
	} finally {
		subscription.dispose();
	}
}

function workspaceFolders(): string[] {
	return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
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
	// Taken before the CLI starts, so every edit the agent makes is covered by this snapshot.
	const start = await captureSnapshot(ctx.cwd, key, ctx.turn, 'start');
	if (start) {
		startSnapshots.set(ctx, start);
	}
}

const startSnapshots = new WeakMap<TurnContext, SnapshotResult>();

/** Snapshot ref key: the same id the workbench's Changes command sends (local id, else resource URI). */
function sessionKeyOf(ctx: TurnContext): string | undefined {
	const id = ctx.sessionId ?? ctx.sessionResource?.toString();
	return id ? sanitizeSessionKey(id) : undefined;
}

/** Files larger than this are listed in the diff view but not recorded into chat edits. */
const MAX_RECORDED_BYTES = 2 * 1024 * 1024;

async function recordTurnEdits(ctx: TurnContext, start: SnapshotResult, end: SnapshotResult): Promise<void> {
	const root = await repoRoot(ctx.cwd);
	if (!root) {
		return;
	}
	const changes = await diffSnapshots(ctx.cwd, start.commit, end.commit);
	const edits: { uri: string; before: string | null; after: string | null }[] = [];
	for (const change of changes) {
		if ((change as { binary?: boolean }).binary) {
			continue;
		}
		if (change.oldPath && change.oldPath !== change.path) {
			const before = await readAt(ctx.cwd, start.commit, change.oldPath);
			edits.push({ uri: vscode.Uri.file(`${root}/${change.oldPath}`).toString(), before: before ?? null, after: null });
		}
		const before = change.status === 'added' || change.oldPath ? undefined : await readAt(ctx.cwd, start.commit, change.path);
		const after = change.status === 'deleted' ? undefined : await readAt(ctx.cwd, end.commit, change.path);
		if ((before?.length ?? 0) > MAX_RECORDED_BYTES || (after?.length ?? 0) > MAX_RECORDED_BYTES) {
			continue;
		}
		edits.push({ uri: vscode.Uri.file(`${root}/${change.path}`).toString(), before: before ?? null, after: after ?? null });
	}
	if (edits.length === 0) {
		return;
	}
	await vscode.commands.executeCommand<boolean>('_thrice.chat.recordTurnEdits', {
		toolInvocationToken: ctx.request.toolInvocationToken,
		sessionResource: ctx.sessionResource?.toString(),
		requestId: ctx.requestId,
		edits,
	});
}

/**
 * Integration hook: runs after the CLI finished, failed or was cancelled (e.g. capture an end
 * snapshot, diff, record edits). `fileChanges` are the paths the agent reported editing (absolute).
 */
async function afterTurn(ctx: TurnContext, _fileChanges: readonly FileChangeRecord[], _outcome: { readonly error?: unknown }): Promise<void> {
	// Recorded even after a failure or cancel: whatever the agent wrote is on disk either way.
	const start = startSnapshots.get(ctx);
	const key = sessionKeyOf(ctx);
	if (!start || !key) {
		return;
	}
	const end = await captureSnapshot(ctx.cwd, key, ctx.turn, 'end');
	if (end) {
		await recordTurnEdits(ctx, start, end);
	}
}

function turnContext(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, cwd: string): TurnContext {
	const extra = request as Partial<Pick<vscode.ChatRequest, 'id' | 'sessionId' | 'sessionResource'>>;
	return {
		cwd,
		sessionId: typeof extra.sessionId === 'string' ? extra.sessionId : undefined,
		sessionResource: extra.sessionResource,
		requestId: typeof extra.id === 'string' ? extra.id : undefined,
		turn: chatContext.history.filter(turn => turn instanceof vscode.ChatRequestTurn).length,
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

function historyPrompt(chatContext: vscode.ChatContext, prompt: string): string {
	const parts: string[] = [];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			parts.push(`User:\n${turn.prompt}`);
			continue;
		}
		const text = turn.response.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '').join('');
		if (text) {
			parts.push(`Assistant:\n${text}`);
		}
	}
	parts.push(`User:\n${prompt}`);
	return parts.join('\n\n');
}

class HubModels implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
	private discovered: readonly HubModel[] | undefined;
	private discovery: Promise<void> | undefined;

	constructor(private readonly hubId: string) { }

	refresh(): void {
		this.discovery = undefined;
		void this.ensureDiscovered();
		this._onDidChange.fire();
	}

	private ensureDiscovered(): Promise<void> {
		if (!this.discovery) {
			const instance = this.instance();
			this.discovery = instance
				? discoverModels(instance, process.env).then(models => {
					if (models && models.length > 0) {
						this.discovered = models;
						this._onDidChange.fire();
					}
				}).catch(() => undefined)
				: Promise.resolve();
		}
		return this.discovery;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	private instance(): ProviderInstance | undefined {
		return currentInstances().find(item => item.id === this.hubId);
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const instance = this.instance();
		if (!instance) {
			return [];
		}
		await this.ensureDiscovered();
		const models = this.discovered?.length ? this.discovered : modelsForDriver(instance.driver);
		return models.map(model => ({
			id: model.id,
			name: model.name,
			family: instance.driver,
			version: '1',
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
		await runHubTurn(this.hubId, model.id, model.name, promptFrom(messages), token, {
			onText: text => progress.report(new vscode.LanguageModelTextPart(text)),
		});
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const value = typeof text === 'string' ? text : promptFrom([text]);
		return Math.ceil(value.length / 4);
	}
}

async function addProvider(): Promise<void> {
	await vscode.commands.executeCommand('thrice.openAddProvider');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		editorToolBridge = await startEditorToolBridge();
		context.subscriptions.push(editorToolBridge);
	} catch (error) {
		console.error('[thrice] Editor tools failed to start', error);
	}
	const hubs = new Map<string, HubModels>();
	const registerHub = (id: string) => {
		if (hubs.has(id)) {
			return;
		}
		const models = new HubModels(id);
		hubs.set(id, models);
		context.subscriptions.push(models);
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(id, models));
	};
	for (const instance of currentInstances()) {
		registerHub(instance.id);
	}
	for (const models of hubs.values()) {
		models.refresh();
	}
	context.subscriptions.push(vscode.commands.registerCommand('thrice.providers.add', () => addProvider()));
	context.subscriptions.push(registerGitChangesCommand(vscode));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration(SETTING)) {
			return;
		}
		for (const instance of currentInstances()) {
			registerHub(instance.id);
		}
		for (const models of hubs.values()) {
			models.refresh();
		}
	}));

	const participant = vscode.chat.createChatParticipant('thrice.providers.chat', async (request, chatContext, stream, token) => {
		const model = request.model;
		if (!model) {
			stream.markdown('Choose Claude Hub, Codex Hub, or Grok Hub.');
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
			const text = turn.response.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '').join('');
			if (text) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
		const response = await model.sendRequest(messages, {}, token);
		for await (const chunk of response.text) {
			stream.markdown(chunk);
		}
	});
	context.subscriptions.push(participant);
}

/** Runs a turn on one of our hubs directly so tool activity reaches the chat (not just text). */
async function runParticipantTurn(request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
	const cwd = workspaceFolders()[0] ?? homedir();
	const ctx = turnContext(request, chatContext, stream, token, cwd);
	const renderer = new ActivityRenderer(stream, cwd);
	await runHook('beforeTurn', () => beforeTurn(ctx));
	let gitBrief = '';
	await runHook('gitContextBrief', async () => { gitBrief = await gitContextBrief(cwd, { sessionKey: sessionKeyOf(ctx) }); });
	let failure: unknown;
	try {
		await runHubTurn(request.model.vendor, request.model.id, request.model.name, historyPrompt(chatContext, request.prompt), token, {
			onEvent: event => renderer.handle(event),
		}, cwd, gitBrief);
	} catch (error) {
		failure = error;
	} finally {
		renderer.finish();
	}
	await runHook('afterTurn', () => afterTurn(ctx, renderer.fileChanges(), { error: failure }));
	if (failure !== undefined && !token.isCancellationRequested) {
		throw failure;
	}
}

export function deactivate(): void { }
