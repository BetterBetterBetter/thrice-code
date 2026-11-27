/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { revive } from '../../../../../../base/common/marshalling.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, IAction2Options, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { EditorTitleContextEditorIdContext, ResourceContextKey } from '../../../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { isEditorCommandsContext } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { AGENT_SESSION_RENAME_ACTION_ID } from '../../agentSessions/agentSessions.js';
import { IAgentSession, isLocalAgentSessionItem } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { IChatService, ResponseModelState } from '../../../common/chatService/chatService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import type { ISerializableChatData } from '../../../common/model/chatModel.js';
import { getChatSessionType, LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { CHAT_PROVIDER_ID } from '../../../common/participants/chatParticipantContribTypes.js';
import { ChatEditorInput } from '../editor/chatEditorInput.js';

/** Right-click and hover menu for one row in the side chat's session list. */
export const ChatSessionHistoryContext = new MenuId('ChatSessionHistoryContext');

/** True when the row is an agent session that can be pinned. */
export const ChatHistoryCanPin = new RawContextKey<boolean>('chatHistoryCanPin', false);

/** True when this session can be renamed. */
export const ChatHistoryCanRename = new RawContextKey<boolean>('chatHistoryCanRename', false);

/**
 * The tab menu has no per-row context keys, so the open chat tabs publish their
 * state here as lists of tab resources, matched with `resource in ...`.
 */
const ChatTabPinnableResources = new RawContextKey<string[]>('chatTabPinnableResources', []);
const ChatTabPinnedResources = new RawContextKey<string[]>('chatTabPinnedResources', []);
const ChatTabRenamableResources = new RawContextKey<string[]>('chatTabRenamableResources', []);

const SideChatViewId = `workbench.panel.chat.view.${CHAT_PROVIDER_ID}`;

interface ISideChatSessionsHost {
	openSessionEditor(resource: URI): Promise<void>;
	closeSessionEditors(resource: URI): Promise<boolean>;
	refreshSessionHistory(): void;
}

interface IChatSessionHistoryActionContext {
	readonly sessionResource: URI;
}

/** A chat tab, in the side chat or the main editor area. */
const chatTabWhen = EditorTitleContextEditorIdContext.isEqualTo(ChatEditorInput.EditorID);

function inTabList(key: RawContextKey<string[]>): ContextKeyExpression {
	return ContextKeyExpr.in(ResourceContextKey.Resource.key, key.key);
}

function notInTabList(key: RawContextKey<string[]>): ContextKeyExpression {
	return ContextKeyExpr.notIn(ResourceContextKey.Resource.key, key.key);
}

/** The menus of an action shown on both a session row and a chat tab. */
function rowAndTabMenus(group: string, order: number, rowWhen: ContextKeyExpression | undefined, tabGroup: string, tabWhen?: ContextKeyExpression): IAction2Options['menu'] {
	return [{
		id: ChatSessionHistoryContext,
		group,
		order,
		when: rowWhen,
	}, {
		id: MenuId.EditorTitleContext,
		group: tabGroup,
		order,
		when: tabWhen ? ContextKeyExpr.and(chatTabWhen, tabWhen) : chatTabWhen,
	}];
}

/**
 * The session a menu action targets: a session row passes `{ sessionResource }`;
 * a tab passes its resource and `{ groupId, editorIndex }`.
 */
function actionResource(accessor: ServicesAccessor, args: readonly unknown[]): URI | undefined {
	const [first] = args;
	if (first && typeof first === 'object' && URI.isUri((first as IChatSessionHistoryActionContext).sessionResource)) {
		return (first as IChatSessionHistoryActionContext).sessionResource;
	}
	const context = args.find(isEditorCommandsContext);
	if (context) {
		const group = accessor.get(IEditorGroupsService).getGroup(context.groupId);
		const editor = typeof context.editorIndex === 'number' ? group?.getEditorByIndex(context.editorIndex) : group?.activeEditor;
		if (editor instanceof ChatEditorInput) {
			return editor.sessionResource ?? editor.resource;
		}
	}
	return undefined;
}

function sideChatSessions(accessor: ServicesAccessor): ISideChatSessionsHost | undefined {
	const view = accessor.get(IViewsService).getViewWithId(SideChatViewId);
	if (!view || typeof (view as unknown as ISideChatSessionsHost).openSessionEditor !== 'function') {
		return undefined;
	}
	return view as unknown as ISideChatSessionsHost;
}

function showsSession(editor: EditorInput, resource: URI): editor is ChatEditorInput {
	return editor instanceof ChatEditorInput && (isEqual(editor.sessionResource, resource) || isEqual(editor.resource, resource));
}

/** Every open tab of the session, in any editor part. */
export function chatEditorsForSession(editorGroupsService: IEditorGroupsService, resource: URI): { group: IEditorGroup; editor: ChatEditorInput }[] {
	const found: { group: IEditorGroup; editor: ChatEditorInput }[] = [];
	for (const part of editorGroupsService.parts) {
		for (const group of part.groups) {
			for (const editor of group.editors) {
				if (showsSession(editor, resource)) {
					found.push({ group, editor });
				}
			}
		}
	}
	return found;
}

async function closeSessionEditors(accessor: ServicesAccessor, resource: URI): Promise<void> {
	const host = sideChatSessions(accessor);
	if (host) {
		await host.closeSessionEditors(resource);
		return;
	}
	for (const { group, editor } of chatEditorsForSession(accessor.get(IEditorGroupsService), resource)) {
		await group.closeEditor(editor);
	}
}

/**
 * Deletes a session after one confirmation and closes its tabs. A local chat is
 * removed from history; a provider session is deleted by its provider.
 */
async function deleteChatSession(accessor: ServicesAccessor, resource: URI): Promise<void> {
	const agentSessionsService = accessor.get(IAgentSessionsService);
	const chatService = accessor.get(IChatService);
	const chatSessionsService = accessor.get(IChatSessionsService);
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	const host = sideChatSessions(accessor);
	const closeTabs = () => closeSessionEditors(accessor, resource);

	const localSessionId = LocalChatSessionUri.parseLocalSessionId(resource);
	const session = agentSessionsService.getSession(resource);
	if (!localSessionId && !session) {
		// A chat that never started, or a sub-agent recorded on a reply, has nothing stored to delete.
		if (chatEditorsForSession(accessor.get(IEditorGroupsService), resource).length > 0) {
			await closeTabs();
		} else {
			notificationService.info(localize('chatHistory.delete.nothing', "This chat has nothing stored to delete."));
		}
		return;
	}

	const confirmed = await dialogService.confirm({
		message: localize('chatHistory.delete.confirm', "Are you sure you want to delete this chat session?"),
		detail: localize('chatHistory.delete.detail', "This action cannot be undone."),
		primaryButton: localize('chatHistory.delete.button', "Delete"),
	});
	if (!confirmed.confirmed) {
		return;
	}

	if (localSessionId) {
		// Deleting first marks a loaded model deleted, so closing its tab does not save it back.
		await chatService.removeHistoryEntry(resource);
		commandService.executeCommand('github.copilot.sessionSync.deleteSessionFromCloud', [localSessionId]).catch(() => { /* best effort */ });
	} else {
		try {
			await chatSessionsService.deleteChatSessionItem(resource, CancellationToken.None);
		} catch (error) {
			dialogService.error(localize('chatHistory.delete.failed', "The chat could not be deleted: {0}", toErrorMessage(error)));
			return;
		}
	}
	await closeTabs();
	host?.refreshSessionHistory();
}

function canRenameSession(resource: URI, session: IAgentSession | undefined, chatSessionsService: IChatSessionsService): boolean {
	return !session || isLocalAgentSessionItem(session) || chatSessionsService.sessionSupportsRename(resource);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.openInNewTab',
			title: localize2('chatHistory.openInNewTab', "Open in New Tab"),
			icon: Codicon.goToFile,
			f1: false,
			menu: {
				id: ChatSessionHistoryContext,
				group: 'navigation',
				order: 1,
			},
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		if (!resource) {
			return;
		}
		await sideChatSessions(accessor)?.openSessionEditor(resource);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.pin',
			title: localize2('chatHistory.pin', "Pin"),
			icon: Codicon.pin,
			f1: false,
			menu: rowAndTabMenus('1_edit', 1, ContextKeyExpr.and(ChatHistoryCanPin, ChatContextKeys.isPinnedAgentSession.negate()),
				'0_chatSession', ContextKeyExpr.and(inTabList(ChatTabPinnableResources), notInTabList(ChatTabPinnedResources))),
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		const session = resource ? accessor.get(IAgentSessionsService).getSession(resource) : undefined;
		session?.setPinned(true);
		sideChatSessions(accessor)?.refreshSessionHistory();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.unpin',
			title: localize2('chatHistory.unpin', "Unpin"),
			icon: Codicon.pinned,
			f1: false,
			menu: rowAndTabMenus('1_edit', 1, ContextKeyExpr.and(ChatHistoryCanPin, ChatContextKeys.isPinnedAgentSession),
				'0_chatSession', inTabList(ChatTabPinnedResources)),
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		const session = resource ? accessor.get(IAgentSessionsService).getSession(resource) : undefined;
		session?.setPinned(false);
		sideChatSessions(accessor)?.refreshSessionHistory();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.rename',
			title: localize2('chatHistory.rename', "Rename..."),
			icon: Codicon.edit,
			f1: false,
			menu: rowAndTabMenus('1_edit', 2, ChatHistoryCanRename, '0_chatSession', inTabList(ChatTabRenamableResources)),
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		if (!resource) {
			return;
		}
		const session = accessor.get(IAgentSessionsService).getSession(resource);
		if (session && !isLocalAgentSessionItem(session)) {
			await accessor.get(ICommandService).executeCommand(AGENT_SESSION_RENAME_ACTION_ID, session);
		} else {
			const chatService = accessor.get(IChatService);
			const current = session?.label || chatService.getSessionTitle(resource) || '';
			const title = await accessor.get(IQuickInputService).input({
				prompt: localize('chatHistory.newTitle', "New chat title"),
				value: current,
			});
			if (!title) {
				return;
			}
			chatService.setChatSessionTitle(resource, title);
		}
		sideChatSessions(accessor)?.refreshSessionHistory();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.fork',
			title: localize2('chatHistory.fork', "Fork Chat"),
			icon: Codicon.repoForked,
			f1: false,
			menu: rowAndTabMenus('1_edit', 3, undefined, '0_chatSession'),
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		if (!resource) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		try {
			const forked = await forkSession(accessor, resource);
			if (!forked) {
				notificationService.info(localize('chatHistory.forkEmpty', "This chat has nothing to fork yet."));
				return;
			}
			try {
				await sideChatSessions(accessor)?.openSessionEditor(forked.resource);
				sideChatSessions(accessor)?.refreshSessionHistory();
			} finally {
				forked.release();
			}
		} catch (error) {
			notificationService.error(localize('chatHistory.forkFailed', "The chat could not be forked: {0}", toErrorMessage(error)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.sessionHistory.delete',
			title: localize2('chatHistory.delete', "Delete..."),
			icon: Codicon.trash,
			f1: false,
			menu: rowAndTabMenus('z_delete', 1, undefined, 'z_chatSessionDelete'),
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = actionResource(accessor, args);
		if (!resource) {
			return;
		}
		await deleteChatSession(accessor, resource);
	}
});

/** Publishes which open chat tabs can be pinned, are pinned, or can be renamed, for the tab menu. */
class ChatTabSessionContextKeys extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatTabSessionContextKeys';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
	) {
		super();
		const pinnable = ChatTabPinnableResources.bindTo(contextKeyService);
		const pinned = ChatTabPinnedResources.bindTo(contextKeyService);
		const renamable = ChatTabRenamableResources.bindTo(contextKeyService);
		const update = () => {
			const pinnableTabs: string[] = [];
			const pinnedTabs: string[] = [];
			const renamableTabs: string[] = [];
			for (const editor of this.editorService.editors) {
				if (!(editor instanceof ChatEditorInput) || !editor.sessionResource) {
					continue;
				}
				const tab = editor.resource.toString();
				const session = this.agentSessionsService.getSession(editor.sessionResource);
				if (session) {
					pinnableTabs.push(tab);
					if (session.isPinned()) {
						pinnedTabs.push(tab);
					}
				}
				if (canRenameSession(editor.sessionResource, session, this.chatSessionsService)) {
					renamableTabs.push(tab);
				}
			}
			pinnable.set(pinnableTabs);
			pinned.set(pinnedTabs);
			renamable.set(renamableTabs);
		};
		this._register(this.editorService.onDidEditorsChange(update));
		this._register(this.agentSessionsService.model.onDidChangeSessions(update));
		update();
	}
}

registerWorkbenchContribution2(ChatTabSessionContextKeys.ID, ChatTabSessionContextKeys, WorkbenchPhase.AfterRestored);

/** A copy of the session. `release` drops the copy's model once its new tab has taken a reference. An empty chat returns nothing. */
async function forkSession(accessor: ServicesAccessor, resource: URI): Promise<{ resource: URI; release: () => void } | undefined> {
	const chatSessionsService = accessor.get(IChatSessionsService);
	if (chatSessionsService.getContentProviderSchemes().includes(getChatSessionType(resource))) {
		const item = await chatSessionsService.forkChatSession(resource, undefined, CancellationToken.None);
		return { resource: item.resource, release: () => { } };
	}

	const chatService = accessor.get(IChatService);
	const owned = chatService.acquireExistingSession(resource, 'ChatSessionHistory#fork')
		?? await chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None, 'ChatSessionHistory#fork');
	if (!owned) {
		return undefined;
	}
	try {
		const serialized = owned.object.toJSON();
		if (serialized.requests.length === 0) {
			return undefined;
		}
		const cleanData = revive(JSON.parse(JSON.stringify(serialized))) as ISerializableChatData;
		cleanData.sessionId = generateUuid();
		const forkTimestamp = Date.now();
		cleanData.creationDate = forkTimestamp;
		const prefix = localize('chatHistory.forkedPrefix', "Forked: ");
		cleanData.customTitle = owned.object.title.startsWith(prefix)
			? owned.object.title
			: localize('chatHistory.forkedTitle', "Forked: {0}", owned.object.title);
		for (const [index, request] of cleanData.requests.entries()) {
			request.shouldBeRemovedOnSend = undefined;
			request.isHidden = undefined;
			request.requestId = generateUuid();
			request.responseId = request.responseId ? generateUuid() : undefined;
			request.timestamp = forkTimestamp + index;
			if (request.response) {
				request.modelState = { value: ResponseModelState.Complete, completedAt: forkTimestamp + index };
			}
		}
		const forked = chatService.loadSessionFromData(cleanData, 'ChatSessionHistory#fork', 'currentSession');
		return { resource: forked.object.sessionResource, release: () => forked.dispose() };
	} finally {
		owned.dispose();
	}
}
