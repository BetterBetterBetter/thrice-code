/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceCancellation, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { AgentProvider, IAgentModelInfo } from '../../common/agent.js';
import { fromAgentHostChatHarness, toAgentHostChatHarness } from '../../common/agentHostChatProviders.js';
import { chatUriFormatOf, subagentChatUri } from '../../common/agentHostChatMinting.js';
import type { IAgentServerToolDefinition } from '../../common/agentServerTools.js';
import type { IAgentMessageDelegationMeta } from '../../common/meta/agentMessageDelegationMeta.js';
import { buildOpenSessionLinkUri, parseOpenSessionLinkChatId } from '../../common/openSessionLink.js';
import { reasoningEffortLevels, type ReasoningEffortLevel } from '../../common/reasoningEffort.js';
import { ProviderSubagentServerToolName } from '../../common/serverToolNames.js';
import { ActionType, type StateAction } from '../../common/state/sessionActions.js';
import { BackgroundWorkKind } from '../../common/state/protocol/state.js';
import { ChatOriginKind, getAgentHostChatId, PendingMessageKind, ResponsePartKind, ToolCallStatus, ToolResultContentType, TurnState, type ModelSelection, type ToolResultContent, type URI as ProtocolURI } from '../../common/state/sessionState.js';
import type { ActionEnvelope } from '../../common/state/protocol/common/actions.js';
import type { AgentHostStateManager } from '../agentHostStateManager.js';
import type { IServerToolDisplay, IServerToolDisplayResult, IServerToolExecutionContext, IServerToolGroup } from './agentServerToolHost.js';
import { assistantTextOf, createAgentSessionMessage, createSessionModelReader, getChatWorkingDirectoryOptions, getOptionalBoolean, getOptionalEnum, getOptionalString, getRequiredString, maxSessionSpawnDepth, resolveCreatedModelSelection, resolveModel, resolveWorkspace, responsePageLength, type IPreparedChatWorkingDirectory, type ISessionServerToolAccessor } from './sessionServerTools.js';

/**
 * How `spawn_provider_agent` returns. `background` (the default) returns as soon as the child started and delivers
 * its result to the calling chat as a message when it finishes; `wait` blocks the tool call until the child's turn
 * ends. Background is the default because no provider bounds a server tool call's duration in a way the host can
 * rely on, and a blocked call is only interruptible where the provider reports cancellation.
 */
export const spawnProviderAgentModes = ['background', 'wait'] as const;
export type SpawnProviderAgentMode = typeof spawnProviderAgentModes[number];
export const defaultSpawnProviderAgentMode: SpawnProviderAgentMode = 'background';

/** Children a single turn of a chat may have running at once. */
export const maxConcurrentProviderSubagentsPerTurn = 4;
/** Longest `description` (the card label), in characters. */
const maxDescriptionLength = 80;
/** `wait_provider_agents`' default and longest wait. */
export const defaultWaitProviderAgentsTimeoutMs = 120_000;
const maxWaitProviderAgentsTimeoutMs = 600_000;
/** How long the spawning tool call may take to appear running in the calling chat before the link is dropped. */
const toolCallAppearanceTimeoutMs = 10_000;

const spawnProviderAgentDescription = 'Delegate a task to another agent (harness) or model as a subagent and get its result. The subagent runs in its own chat nested under this tool call, which the user can open, with its own tools and approvals. Use this to have a different provider or model do or review work. For a task your own agent can do with its own model, prefer your native subagent tool (for example Task or spawn_agent), which is cheaper. Never start agents through the shell or a CLI. `mode` defaults to `background`: the call returns at once and the result arrives later as a message in this chat; call `wait_provider_agents` to wait for it instead. Use `mode: "wait"` to block until the subagent finishes and return its final reply. Set `worktree: true` (with `workspace`) when the subagent will write many files, so its changes stay isolated.';

const spawnProviderAgentInputSchema: NonNullable<IAgentServerToolDefinition['inputSchema']> = {
	type: 'object',
	properties: {
		harness: { type: 'string', description: 'The agent that runs the subagent.' },
		prompt: { type: 'string', description: 'The complete task for the subagent. It does not see this conversation, so include all the context it needs.' },
		description: { type: 'string', maxLength: maxDescriptionLength, description: 'Short label for the subagent shown to the user, 3-5 words.' },
		model: { type: 'string', description: 'Optional model ID or display name of the harness. Defaults to the harness\'s default model, or to your current model when the harness is your own agent.' },
		reasoningEffort: { type: 'string', enum: [...reasoningEffortLevels], description: 'Optional reasoning effort for the subagent\'s model. Supported values depend on the model.' },
		mode: { type: 'string', enum: [...spawnProviderAgentModes], description: '`background` (default) returns immediately and delivers the result as a later message; `wait` blocks until the subagent finishes and returns its reply.' },
		workspace: { type: 'string', description: 'Optional folder for the subagent: a project name, URI, absolute path, or a working directory of a known session. Defaults to your current folder.' },
		worktree: { type: 'boolean', description: 'Set true to run the subagent in a fresh Git worktree of `workspace` (recommended when it writes many files), or false to use the folder directly. Only valid with `workspace`.' },
	},
	required: ['harness', 'prompt', 'description'],
};

const waitProviderAgentsInputSchema: NonNullable<IAgentServerToolDefinition['inputSchema']> = {
	type: 'object',
	properties: {
		chats: { type: 'array', items: { type: 'string' }, description: 'The `chat` values returned by `spawn_provider_agent`. Omit to wait for every background subagent this chat started.' },
		timeoutMs: { type: 'number', description: `How long to wait, in milliseconds (default ${defaultWaitProviderAgentsTimeoutMs}, at most ${maxWaitProviderAgentsTimeoutMs}). Subagents still running then are reported as \`running\`.` },
	},
};

export const providerSubagentServerToolDefinitions: IAgentServerToolDefinition[] = [
	{
		name: ProviderSubagentServerToolName.SpawnProviderAgent,
		title: 'Spawn Provider Agent',
		description: spawnProviderAgentDescription,
		inputSchema: spawnProviderAgentInputSchema,
		annotations: { readOnlyHint: false },
		deferLoading: true,
	},
	{
		name: ProviderSubagentServerToolName.WaitProviderAgents,
		title: 'Wait for Provider Agents',
		description: 'Wait for background subagents started with `spawn_provider_agent` and return their results. Returns when all have finished or the timeout passes, reporting the ones still running.',
		inputSchema: waitProviderAgentsInputSchema,
		annotations: { readOnlyHint: true },
		deferLoading: true,
	},
];

export type ProviderSubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** The outcome of a child's turn as the tools report it. */
export interface IProviderSubagentResult {
	readonly chat: string;
	readonly openLink: string;
	readonly harness: string;
	readonly description: string;
	readonly status: ProviderSubagentStatus;
	readonly responseTurnId?: string;
	readonly response?: string;
	readonly responseLength?: number;
	readonly truncated?: boolean;
	readonly nextResponseOffset?: number;
	readonly error?: string;
}

interface IProviderSubagent {
	readonly session: URI;
	readonly parentChat: ProtocolURI;
	readonly parentTurnId: string | undefined;
	readonly toolCallId: string;
	readonly chat: ProtocolURI;
	readonly provider: AgentProvider;
	readonly description: string;
	readonly mode: SpawnProviderAgentMode;
	turnId: string | undefined;
	status: ProviderSubagentStatus;
	error?: string;
	/** A `wait` call or `wait_provider_agents` returned the result, so no completion message is sent. */
	delivered: boolean;
	readonly done: DeferredPromise<void>;
}

interface ISpawnProviderAgentArgs {
	readonly harness?: unknown;
	readonly prompt?: unknown;
	readonly description?: unknown;
	readonly model?: unknown;
	readonly reasoningEffort?: unknown;
	readonly mode?: unknown;
	readonly workspace?: unknown;
	readonly worktree?: unknown;
}

export interface IResolvedSpawnProviderAgentArgs {
	readonly provider: AgentProvider;
	readonly prompt: string;
	readonly description: string;
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffortLevel;
	readonly mode: SpawnProviderAgentMode;
	readonly workspace?: string;
	readonly worktree?: boolean;
}

/**
 * Validates `spawn_provider_agent`'s arguments that need no model catalog, resolving `harness` against the harnesses
 * the calling session's chats may use.
 */
export function getSpawnProviderAgentArgs(rawArgs: unknown, harnesses: readonly AgentProvider[]): IResolvedSpawnProviderAgentArgs {
	const name = ProviderSubagentServerToolName.SpawnProviderAgent;
	const args = (rawArgs ?? {}) as ISpawnProviderAgentArgs;
	const harness = getRequiredString(args.harness, 'harness', name);
	const provider = harnesses.includes(harness) ? harness : fromAgentHostChatHarness(harness);
	if (!harnesses.includes(provider)) {
		throw new Error(`Invalid ${name} input: harness "${harness}" is not available. Use one of: ${harnesses.map(toAgentHostChatHarness).join(', ')}.`);
	}
	const prompt = getRequiredString(args.prompt, 'prompt', name);
	const description = getRequiredString(args.description, 'description', name).trim();
	if (!description || description.length > maxDescriptionLength || /[\r\n]/.test(description)) {
		throw new Error(`Invalid ${name} input: description must be a single line of at most ${maxDescriptionLength} characters (3-5 words).`);
	}
	const model = getOptionalString(args.model, 'model', name);
	const reasoningEffort = getOptionalEnum(args.reasoningEffort, 'reasoningEffort', reasoningEffortLevels, name);
	const mode = getOptionalEnum(args.mode, 'mode', spawnProviderAgentModes, name) ?? defaultSpawnProviderAgentMode;
	const workspace = getOptionalString(args.workspace, 'workspace', name);
	const worktree = getOptionalBoolean(args.worktree, 'worktree', name);
	if (worktree !== undefined && workspace === undefined) {
		throw new Error(`Invalid ${name} input: worktree is only valid together with workspace.`);
	}
	return {
		provider, prompt, description, mode,
		...(model !== undefined ? { model } : {}),
		...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
		...(workspace !== undefined ? { workspace } : {}),
		...(worktree !== undefined ? { worktree } : {}),
	};
}

/**
 * Resolves the child's model in the catalog the calling chat uses: an explicit `model` must belong to the harness
 * (a mismatch fails before anything is created); without one, a child on the calling chat's agent inherits its
 * selection, and a child on another agent starts with that agent's default.
 */
export async function resolveSpawnProviderAgentModel(args: IResolvedSpawnProviderAgentArgs, getModels: () => Promise<readonly IAgentModelInfo[]>, inherited: { readonly provider?: AgentProvider; readonly model?: ModelSelection } | undefined): Promise<ModelSelection | undefined> {
	const name = ProviderSubagentServerToolName.SpawnProviderAgent;
	try {
		let model: IAgentModelInfo | undefined;
		if (args.model !== undefined) {
			const models = await getModels();
			try {
				model = resolveModel(args.model, models, args.provider, true);
			} catch (error) {
				const other = models.find(candidate => candidate.provider !== args.provider && (candidate.id === args.model || candidate.name === args.model));
				if (other) {
					throw new Error(`Invalid ${name} input: model "${other.id}" belongs to harness "${toAgentHostChatHarness(other.provider)}", but harness "${toAgentHostChatHarness(args.provider)}" was requested. Pass a model of that harness, or omit model.`);
				}
				throw error;
			}
		}
		return await resolveCreatedModelSelection(
			{ ...(model !== undefined ? { model } : {}), ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}) },
			args.provider,
			inherited?.provider === args.provider ? inherited.model : undefined,
			getModels,
			true,
		);
	} catch (error) {
		// Shared model checks name `create_session`; the agent called this tool.
		if (error instanceof Error && error.message.includes('create_session input')) {
			throw new Error(error.message.replaceAll('create_session input', `${name} input`));
		}
		throw error;
	}
}

/** The chat whose tool calls key subagent chat ids: the outermost chat a chain of spawn edges leads to. */
function rootConversationChat(stateManager: AgentHostStateManager, chat: ProtocolURI): ProtocolURI {
	let root = chat;
	const visited = new Set<string>();
	for (let parent = stateManager.getChatParent(root); parent !== undefined && !visited.has(parent); parent = stateManager.getChatParent(root)) {
		visited.add(root);
		root = parent;
	}
	return root;
}

/**
 * Mints the child chat of the server tool call `toolCallId` in `parentChat`, deterministically: a retried or
 * replayed call yields the same chat, as a native subagent's spawn does.
 */
export function mintProviderSubagentChatUri(stateManager: AgentHostStateManager, session: ProtocolURI, parentChat: ProtocolURI, toolCallId: string): ProtocolURI {
	return subagentChatUri(chatUriFormatOf(stateManager.getDefaultChat(session)), session, rootConversationChat(stateManager, parentChat), toolCallId);
}

/** How many spawn edges lead from `chat` up to a chat no tool call spawned. */
function chatSpawnDepth(stateManager: AgentHostStateManager, chat: ProtocolURI): number {
	let depth = 0;
	const visited = new Set<string>();
	for (let current: string | undefined = chat; current !== undefined && !visited.has(current); current = stateManager.getChatParent(current)) {
		visited.add(current);
		if (stateManager.getChatOrigin(current)?.kind === ChatOriginKind.Tool) {
			depth++;
		}
	}
	return depth;
}

/**
 * The folders a child works in when no workspace is requested: the nearest of the calling chat and the chats that
 * provider-spawned it with folders of their own, else none (the child then works in its session's folders).
 */
function inheritedWorkingDirectories(stateManager: AgentHostStateManager, chat: ProtocolURI): readonly URI[] | undefined {
	const visited = new Set<string>();
	for (let current: string | undefined = chat; current !== undefined && !visited.has(current); current = stateManager.isProviderSpawnedChat(current) ? stateManager.getChatParent(current) : undefined) {
		visited.add(current);
		const own = stateManager.isProviderSpawnedChat(current) ? undefined : stateManager.getChatState(current)?.workingDirectories;
		if (own?.length) {
			return own.map(directory => URI.parse(directory));
		}
	}
	return undefined;
}

function runningToolCallContent(stateManager: AgentHostStateManager, chat: ProtocolURI, turnId: string, toolCallId: string): ToolResultContent[] | undefined {
	const activeTurn = stateManager.getChatState(chat)?.activeTurn;
	if (!activeTurn || activeTurn.id !== turnId) {
		return undefined;
	}
	for (const part of activeTurn.responseParts) {
		if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId && part.toolCall.status === ToolCallStatus.Running) {
			return part.toolCall.content ? [...part.toolCall.content] : [];
		}
	}
	return undefined;
}

function isTurnEnd(action: StateAction): action is Extract<StateAction, { type: ActionType.ChatTurnComplete | ActionType.ChatTurnCancelled | ActionType.ChatError }> {
	return action.type === ActionType.ChatTurnComplete || action.type === ActionType.ChatTurnCancelled || action.type === ActionType.ChatError;
}

/**
 * Builds the `spawn_provider_agent` / `wait_provider_agents` group. Each child is a host-driven
 * {@link ChatOriginKind.Tool} chat of the calling chat's session (see `AgentHostChatDriver`), created on the requested
 * harness and linked to the spawning tool call with a {@link ToolResultContentType.Subagent} content block — the same
 * link a native subagent's tool call carries, which clients read to list and open subagents.
 *
 * Lifecycle: cancelling the calling turn cancels the children it started; archiving the calling chat archives its
 * children; spawn depth follows `maxSessionSpawnDepth` and a turn runs at most
 * {@link maxConcurrentProviderSubagentsPerTurn} children at once. A child's approvals stay in the child's chat.
 */
export function createProviderSubagentServerToolGroup(accessor?: ISessionServerToolAccessor): IServerToolGroup {
	const children = new Map<ProtocolURI, IProviderSubagent>();
	let listener: IDisposable | undefined;
	let observedStateManager: AgentHostStateManager | undefined;

	const settle = (child: IProviderSubagent, status: ProviderSubagentStatus, error?: string) => {
		if (child.status !== 'running') {
			return;
		}
		child.status = status;
		if (error !== undefined) {
			child.error = error;
		}
		child.done.complete();
	};

	const readResult = (stateManager: AgentHostStateManager, child: IProviderSubagent): IProviderSubagentResult => {
		const base = {
			chat: child.chat,
			openLink: buildOpenSessionLinkUri(child.session, getAgentHostChatId(child.chat)),
			harness: toAgentHostChatHarness(child.provider),
			description: child.description,
			status: child.status,
			...(child.error !== undefined ? { error: child.error } : {}),
		};
		const turn = child.turnId === undefined ? undefined : stateManager.getChatState(child.chat)?.turns.find(candidate => candidate.id === child.turnId);
		if (!turn) {
			return base;
		}
		const response = assistantTextOf(turn.responseParts);
		const end = Math.min(responsePageLength, response.length);
		const errorPart = turn.responseParts.find(part => part.kind === ResponsePartKind.Error);
		return {
			...base,
			...(base.error === undefined && errorPart?.kind === ResponsePartKind.Error ? { error: errorPart.error.message } : {}),
			responseTurnId: turn.id,
			response: response.slice(0, end),
			responseLength: response.length,
			truncated: end < response.length,
			...(end < response.length ? { nextResponseOffset: end } : {}),
		};
	};

	const notifyParent = (stateManager: AgentHostStateManager, child: IProviderSubagent) => {
		if (child.delivered || child.mode !== 'background' || !stateManager.getChatOwner(child.parentChat)) {
			return;
		}
		child.delivered = true;
		const result = readResult(stateManager, child);
		const lines = [
			`Background subagent "${child.description}" (${result.harness}) ${result.status}.`,
			...(result.error ? [`Error: ${result.error}`] : []),
			...(result.response ? ['Result:', result.response] : []),
			...(result.truncated ? [`(The result is truncated. Read the rest with get_session_context, passing session "${result.openLink}", responseTurnId "${result.responseTurnId}" and responseOffset ${result.nextResponseOffset}.)`] : []),
			`Subagent chat: ${result.openLink}`,
		];
		const messageId = generateUuid();
		const delegation: IAgentMessageDelegationMeta = {
			sourceSession: child.session.toString(),
			sourceChat: child.chat,
			...(child.turnId !== undefined ? { sourceTurnId: child.turnId } : {}),
			messageId,
			revision: 1,
		};
		const message = createAgentSessionMessage(lines.join('\n'), delegation);
		// Steering reaches an active turn at once; a queued message starts the next turn of an idle chat.
		const active = stateManager.getChatState(child.parentChat)?.activeTurn !== undefined;
		stateManager.dispatchServerAction(child.parentChat, {
			type: ActionType.ChatPendingMessageSet,
			kind: active ? PendingMessageKind.Steering : PendingMessageKind.Queued,
			id: messageId,
			message,
		}, accessor?.getCredentialSource(URI.parse(child.parentChat)));
	};

	const onEnvelope = (stateManager: AgentHostStateManager, envelope: ActionEnvelope) => {
		const { channel, action } = envelope;
		const child = children.get(channel);
		if (child) {
			if (action.type === ActionType.ChatTurnStarted && child.turnId === undefined) {
				child.turnId = action.turnId;
			} else if (isTurnEnd(action) && action.turnId === child.turnId && child.status === 'running') {
				settle(child, action.type === ActionType.ChatTurnComplete ? 'completed' : action.type === ActionType.ChatTurnCancelled ? 'cancelled' : 'failed',
					action.type === ActionType.ChatError ? action.part.error.message : undefined);
				if (child.mode === 'background') {
					stateManager.dispatchServerAction(child.parentChat, { type: ActionType.ChatBackgroundWorkRemoved, id: backgroundWorkId(child) });
					notifyParent(stateManager, child);
				}
			}
			return;
		}
		if (action.type === ActionType.ChatTurnCancelled) {
			// Cancelling a turn cancels the children it started, waiting or in the background.
			for (const candidate of children.values()) {
				if (candidate.parentChat === channel && candidate.parentTurnId === action.turnId && candidate.status === 'running') {
					candidate.delivered = true;
					accessor?.cancelChatTurn?.(URI.parse(candidate.chat));
				}
			}
		} else if (action.type === ActionType.ChatIsArchivedChanged && action.isArchived) {
			// Archiving a chat archives the children it spawned.
			for (const candidate of children.values()) {
				if (candidate.parentChat === channel) {
					void accessor?.archiveChat(URI.parse(candidate.chat)).catch(() => { /* already archived or gone */ });
				}
			}
		}
	};

	const observe = (stateManager: AgentHostStateManager) => {
		if (observedStateManager === stateManager) {
			return;
		}
		listener?.dispose();
		observedStateManager = stateManager;
		listener = stateManager.onDidEmitEnvelope(envelope => onEnvelope(stateManager, envelope));
	};

	/** Links the child to the running spawning tool call once the call is running in the calling chat. */
	const linkToToolCall = async (stateManager: AgentHostStateManager, child: IProviderSubagent, harnessTitle: string) => {
		const turnId = child.parentTurnId;
		if (turnId === undefined) {
			return;
		}
		const dispatch = (): boolean => {
			const existing = runningToolCallContent(stateManager, child.parentChat, turnId, child.toolCallId);
			if (existing === undefined) {
				return false;
			}
			if (existing.some(content => content.type === ToolResultContentType.Subagent && content.resource === child.chat)) {
				return true;
			}
			stateManager.dispatchServerAction(child.parentChat, {
				type: ActionType.ChatToolCallContentChanged,
				turnId,
				toolCallId: child.toolCallId,
				content: [...existing, { type: ToolResultContentType.Subagent, resource: child.chat, title: harnessTitle, agentName: toAgentHostChatHarness(child.provider), description: child.description }],
			});
			return true;
		};
		if (dispatch()) {
			return;
		}
		// Some providers report the call as running only after its handler started.
		const linked = new DeferredPromise<void>();
		const waiting = stateManager.onDidEmitEnvelope(envelope => {
			if (envelope.channel === child.parentChat && dispatch()) {
				linked.complete();
			}
		});
		const timer = timeout(toolCallAppearanceTimeoutMs);
		try {
			await Promise.race([linked.p, timer]);
		} finally {
			timer.cancel();
			waiting.dispose();
		}
	};

	const waitFor = async (pending: readonly IProviderSubagent[], timeoutMs: number | undefined, token: CancellationToken): Promise<void> => {
		const all = Promise.all(pending.map(child => child.done.p));
		const timer = timeoutMs === undefined ? undefined : timeout(timeoutMs);
		try {
			await raceCancellation(timer === undefined ? all : Promise.race([all, timer]), token);
		} finally {
			timer?.cancel();
		}
	};

	const spawn = async (stateManager: AgentHostStateManager, context: IServerToolExecutionContext, rawArgs: unknown): Promise<string> => {
		const name = ProviderSubagentServerToolName.SpawnProviderAgent;
		if (!accessor?.createHostDrivenChat) {
			throw new Error(`${name} is unavailable on this host.`);
		}
		const toolCallId = context.toolCallId;
		if (!toolCallId) {
			throw new Error(`${name} needs the tool call id, which this agent did not report.`);
		}
		const session = URI.parse(context.sessionUri);
		const parentChat = context.chatUri;
		const harnesses = accessor.getChatHarnesses(session);
		if (!harnesses?.length) {
			throw new Error(`${name} is unavailable: chats in this session can't use other agents (multiple chat providers is off, or this session's agent doesn't support multiple chats).`);
		}
		const args = getSpawnProviderAgentArgs(rawArgs, harnesses);
		const token = context.token ?? CancellationToken.None;
		const chat = mintProviderSubagentChatUri(stateManager, context.sessionUri, parentChat, toolCallId);

		// A retried or replayed call attaches to the child it already created.
		let child = children.get(chat);
		if (!child && stateManager.getChatOwner(chat) !== undefined) {
			if (!stateManager.isHostDrivenChat(chat)) {
				throw new Error(`${name}: tool call ${toolCallId} already has a subagent chat that this tool did not create.`);
			}
			const activeTurnId = stateManager.getActiveTurnId(chat);
			const lastTurn = stateManager.getChatState(chat)?.turns.at(-1);
			child = {
				session, parentChat, parentTurnId: context.turnId, toolCallId, chat, provider: args.provider, description: args.description, mode: args.mode,
				turnId: activeTurnId ?? lastTurn?.id,
				status: activeTurnId !== undefined ? 'running' : lastTurn?.state === TurnState.Complete ? 'completed' : lastTurn?.state === TurnState.Cancelled ? 'cancelled' : 'failed',
				delivered: args.mode === 'wait',
				done: new DeferredPromise<void>(),
			};
			if (child.status !== 'running') {
				child.done.complete();
			}
			children.set(chat, child);
		}
		if (!child) {
			child = await create(stateManager, context, args, chat, toolCallId);
		}
		observe(stateManager);
		if (args.mode === 'background') {
			return JSON.stringify({ chat: child.chat, openLink: buildOpenSessionLinkUri(session, getAgentHostChatId(child.chat)), status: child.status, harness: toAgentHostChatHarness(child.provider) });
		}
		child.delivered = true;
		try {
			await waitFor([child], undefined, token);
		} finally {
			if (token.isCancellationRequested && child.status === 'running') {
				accessor.cancelChatTurn?.(URI.parse(child.chat));
			}
		}
		if (token.isCancellationRequested) {
			throw new Error(`${name} was cancelled; the subagent was stopped.`);
		}
		return JSON.stringify(readResult(stateManager, child));
	};

	const create = async (stateManager: AgentHostStateManager, context: IServerToolExecutionContext, args: IResolvedSpawnProviderAgentArgs, chat: ProtocolURI, toolCallId: string): Promise<IProviderSubagent> => {
		const access = accessor!;
		const session = URI.parse(context.sessionUri);
		const parentChat = context.chatUri;
		const depth = access.getSessionSpawnDepth(session) + chatSpawnDepth(stateManager, parentChat);
		if (depth >= maxSessionSpawnDepth) {
			throw new Error(`Refusing to spawn a subagent: recursion limit reached (max spawn depth ${maxSessionSpawnDepth}).`);
		}
		const running = [...children.values()].filter(candidate => candidate.parentChat === parentChat && candidate.parentTurnId === context.turnId && candidate.status === 'running');
		if (running.length >= maxConcurrentProviderSubagentsPerTurn) {
			throw new Error(`Refusing to spawn a subagent: this turn already runs ${running.length} subagents (at most ${maxConcurrentProviderSubagentsPerTurn}). Wait for one with wait_provider_agents first.`);
		}
		const credentials = access.getCredentialSource(URI.parse(parentChat));
		const defaults = access.getCreationDefaults(URI.parse(parentChat), context.turnId);
		const model = await resolveSpawnProviderAgentModel(args, createSessionModelReader(access, credentials), defaults);
		let prepared: IPreparedChatWorkingDirectory | undefined;
		let workingDirectories: readonly URI[] | undefined;
		if (args.workspace !== undefined) {
			const folder = resolveWorkspace(args.workspace, await access.listSessions());
			prepared = await access.prepareChatWorkingDirectory(session, folder, { ...getChatWorkingDirectoryOptions(args.worktree, defaults?.isolation, args.prompt), ...(credentials ? { credentialSource: credentials } : {}) });
			workingDirectories = [prepared.directory];
		} else {
			workingDirectories = inheritedWorkingDirectories(stateManager, parentChat);
		}
		const child: IProviderSubagent = {
			session, parentChat, parentTurnId: context.turnId, toolCallId, chat,
			provider: args.provider, description: args.description, mode: args.mode,
			turnId: undefined, status: 'running', delivered: args.mode === 'wait', done: new DeferredPromise<void>(),
		};
		try {
			await prepared?.associateWithChat?.(URI.parse(chat));
			await access.createHostDrivenChat!(session, URI.parse(chat), { parentChat: URI.parse(parentChat), toolCallId }, {
				provider: args.provider,
				title: args.description,
				...(model !== undefined ? { model } : {}),
				...(workingDirectories !== undefined ? { workingDirectories } : {}),
			}, credentials);
		} catch (error) {
			await prepared?.release();
			throw error;
		}
		children.set(chat, child);
		observe(stateManager);
		const harnessTitle = toAgentHostChatHarness(args.provider);
		await linkToToolCall(stateManager, child, harnessTitle);
		if (args.mode === 'background') {
			stateManager.dispatchServerAction(parentChat, {
				type: ActionType.ChatBackgroundWorkSet,
				work: { kind: BackgroundWorkKind.Subagent, id: backgroundWorkId(child), label: args.description, startedAt: new Date().toISOString(), chat },
			});
		}
		const delegation: IAgentMessageDelegationMeta = {
			sourceSession: session.toString(),
			sourceChat: parentChat,
			...(context.turnId !== undefined ? { sourceTurnId: context.turnId } : {}),
		};
		try {
			await (access.startToolPrompt ?? access.startPrompt)(session, URI.parse(chat), args.prompt, delegation, credentials);
		} catch (error) {
			settle(child, 'failed', error instanceof Error ? error.message : String(error));
			throw error;
		}
		child.turnId ??= stateManager.getActiveTurnId(chat);
		if (child.turnId === undefined) {
			// The turn was refused, or ended before this read: report its last state.
			const last = stateManager.getChatState(chat)?.turns.at(-1);
			child.turnId = last?.id;
			settle(child, last?.state === TurnState.Complete ? 'completed' : last?.state === TurnState.Cancelled ? 'cancelled' : 'failed', last ? undefined : 'The subagent\'s turn did not start.');
		}
		return child;
	};

	const waitAgents = async (stateManager: AgentHostStateManager, context: IServerToolExecutionContext, rawArgs: unknown): Promise<string> => {
		const name = ProviderSubagentServerToolName.WaitProviderAgents;
		const args = (rawArgs ?? {}) as { chats?: unknown; timeoutMs?: unknown };
		if (args.chats !== undefined && (!Array.isArray(args.chats) || args.chats.some(chat => typeof chat !== 'string' || !chat))) {
			throw new Error(`Invalid ${name} input: chats must be an array of chat URIs or links returned by spawn_provider_agent.`);
		}
		if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs < 0)) {
			throw new Error(`Invalid ${name} input: timeoutMs must be a nonnegative number.`);
		}
		const timeoutMs = Math.min(args.timeoutMs === undefined ? defaultWaitProviderAgentsTimeoutMs : Math.floor(args.timeoutMs), maxWaitProviderAgentsTimeoutMs);
		const requested = args.chats as string[] | undefined;
		const own = [...children.values()].filter(child => child.parentChat === context.chatUri);
		const resolved: (IProviderSubagent | string)[] = requested === undefined
			? own.filter(child => child.mode === 'background' && (child.status === 'running' || !child.delivered))
			: requested.map(input => {
				const chatId = parseOpenSessionLinkChatId(input);
				return own.find(child => child.chat === input || (chatId !== undefined && getAgentHostChatId(child.chat) === chatId)) ?? input;
			});
		const tracked = resolved.filter((entry): entry is IProviderSubagent => typeof entry !== 'string');
		await waitFor(tracked, timeoutMs, context.token ?? CancellationToken.None);
		const results = resolved.map(entry => {
			if (typeof entry === 'string') {
				return { chat: entry, status: 'unknown', error: 'Not a subagent this chat started with spawn_provider_agent in this host process.' };
			}
			if (entry.status !== 'running') {
				entry.delivered = true;
			}
			return readResult(stateManager, entry);
		});
		return JSON.stringify({ results, ...(tracked.some(child => child.status === 'running') ? { note: 'Some subagents are still running; call wait_provider_agents again, or continue and receive their results as messages.' } : {}) });
	};

	return {
		definitions: providerSubagentServerToolDefinitions,
		isEnabled(): boolean {
			return accessor === undefined || accessor.createHostDrivenChat !== undefined;
		},
		isEnabledForSession(_toolName: string, sessionUri: ProtocolURI): boolean {
			return (accessor?.getChatHarnesses(URI.parse(sessionUri))?.length ?? 0) > 0;
		},
		getDefinitionForSession(definition, sessionUri): IAgentServerToolDefinition {
			if (definition.name !== ProviderSubagentServerToolName.SpawnProviderAgent) {
				return definition;
			}
			const harnesses = accessor?.getChatHarnesses(URI.parse(sessionUri));
			if (!harnesses?.length) {
				return definition;
			}
			const inputSchema = definition.inputSchema ?? spawnProviderAgentInputSchema;
			const harness = { ...(inputSchema.properties?.harness as object), enum: harnesses.map(toAgentHostChatHarness), description: `The agent that runs the subagent: one of ${harnesses.map(provider => `\`${toAgentHostChatHarness(provider)}\``).join(', ')}.` };
			return { ...definition, inputSchema: { ...inputSchema, properties: { ...inputSchema.properties, harness } } };
		},
		canRequireConfirmation(): boolean {
			return false;
		},
		getDisplay(toolName: string, args: unknown, result?: IServerToolDisplayResult): IServerToolDisplay | undefined {
			if (toolName === ProviderSubagentServerToolName.WaitProviderAgents) {
				return { displayName: 'Wait for Agents', invocationMessage: 'Waiting for agents', pastTenseMessage: result?.success === false ? 'Waiting for agents failed' : 'Finished waiting for agents' };
			}
			if (toolName !== ProviderSubagentServerToolName.SpawnProviderAgent) {
				return undefined;
			}
			const typed = (args ?? {}) as ISpawnProviderAgentArgs;
			const harness = typeof typed.harness === 'string' ? typed.harness : 'agent';
			const description = typeof typed.description === 'string' ? typed.description : undefined;
			const label = description ? `${harness}: ${description}` : harness;
			return { displayName: 'Spawn Agent', invocationMessage: `Delegating to ${label}`, pastTenseMessage: result?.success === false ? `Delegating to ${label} failed` : `Delegated to ${label}` };
		},
		async execute(stateManager: AgentHostStateManager, context, toolName: string, rawArgs: unknown): Promise<string> {
			switch (toolName) {
				case ProviderSubagentServerToolName.SpawnProviderAgent:
					return spawn(stateManager, context, rawArgs);
				case ProviderSubagentServerToolName.WaitProviderAgents:
					return waitAgents(stateManager, context, rawArgs);
				default:
					throw new Error(`Unknown provider subagent tool: ${toolName}`);
			}
		},
	};
}

function backgroundWorkId(child: Pick<IProviderSubagent, 'toolCallId'>): string {
	return `hostSubagent:${child.toolCallId}`;
}
