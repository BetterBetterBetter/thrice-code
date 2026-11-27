/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../../base/browser/mouseEvent.js';
import { Orientation, Sash, SashState } from '../../../../../../base/browser/ui/sash/sash.js';
import { fromNow } from '../../../../../../base/common/date.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { GroupModelChangeKind, isEditorCommandsContext, type IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IContentPart, IEditorGroup, IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IAgentSession, isLocalAgentSessionItem } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { convertLegacyChatSessionTiming, IChatService } from '../../../common/chatService/chatService.js';
import { chatSessionProviderIcon, getSelectedChatProviderId, listChatProviders } from '../../../common/thriceProviders.js';
import { CHAT_PROVIDER_ID } from '../../../common/participants/chatParticipantContribTypes.js';
import { ChatEditorInput } from '../editor/chatEditorInput.js';
import { CHAT_HISTORY_COLUMN_WIDTH, CHAT_SESSION_TAB_MAX_WIDTH, ChatHistoryActivity, ChatHistoryEntry, ChatHistoryGroupId, ChatHistorySource, chatHistoryColumnWidth, chatHistoryEdge, chatHistoryEntries, chatHistoryGroups, chatHistoryPreferredWidth, chatHistorySections, chatSessionRunActivity, filterChatHistoryEntries, OpenChatSession } from './chatSessionTabs.js';
import { subagentChatsInModel, subagentEditorResource } from './chatSubagentChats.js';
import { IChatSessionsService, ChatSessionStatus } from '../../../common/chatSessionsService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatHistoryCanPin, ChatHistoryCanRename, ChatSessionHistoryContext, chatEditorsForSession } from './chatSessionHistoryMenu.js';

const ChatHistoryWidthKey = 'thrice.chat.historyColumnWidth';
const ChatHistoryCollapsedSectionsKey = 'thrice.chat.historyCollapsedSections';

type ChatHistorySectionId = 'current' | 'history';

const AuxiliaryBarChatViewId = `workbench.panel.chat.view.${CHAT_PROVIDER_ID}`;

/** The add-tab menu of the auxiliary bar chat editors. Its only entry opens another chat. */
export const AuxiliaryBarChatEditorsAddTab = new MenuId('AuxiliaryBarChatEditorsAddTab');

/**
 * The side chat: one editor part filling the Chat view. Each session is a
 * {@link ChatEditorInput}, so its tab moves, splits and reorders like a file tab,
 * including into the main editor area. This part only takes those chats: a file
 * opened or dropped here goes to the main editor area instead.
 * Closing the last one hides the auxiliary bar. A history button on the outer
 * edge of the tabs opens past sessions back into this same part.
 */
export class AuxiliaryBarChatEditors extends Disposable {

	private static nextHistoryId = 0;

	private part: IContentPart | undefined;
	private releasing = false;
	private pending: Promise<void> | undefined;
	private readonly groupListeners = this._register(new DisposableMap<number>());
	private readonly host: HTMLElement;
	private readonly surface: HTMLElement;
	private readonly historyButton: HTMLElement;
	private readonly historyIcon: HTMLElement;
	private readonly historyPanel: HTMLElement;
	private readonly historySearch: HTMLInputElement;
	private readonly historySearchButton: HTMLElement;
	private readonly historyList: HTMLElement;
	private readonly historyListeners = this._register(new DisposableStore());
	private historyOpen = false;
	private historySearching = false;
	private historyQuery = '';
	private readonly historyExpanded = new Set<string>();
	private readonly historyCollapsed = new Set<string>();
	private readonly historySectionsCollapsed = new Set<ChatHistorySectionId>();
	private historyRepaintQueued = false;
	private readonly subagentModelListeners = this._register(new DisposableStore());
	private historyEntries: readonly ChatHistoryEntry[] = [];
	private historyRender = 0;
	private historyListening = false;
	private historyWidthApplied = 0;
	private historyPreferredWidth: number;
	private historyDragWidth: number | undefined;
	private readonly historySash: Sash;
	private lastLayout: { width: number; height: number } | undefined;

	constructor(
		container: HTMLElement,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IChatService private readonly chatService: IChatService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.historyPreferredWidth = chatHistoryPreferredWidth(this.storageService.get(ChatHistoryWidthKey, StorageScope.PROFILE));
		for (const id of this.storageService.get(ChatHistoryCollapsedSectionsKey, StorageScope.PROFILE, '').split(',')) {
			if (id === 'current' || id === 'history') {
				this.historySectionsCollapsed.add(id);
			}
		}

		const host = this.host = append(container, $('.auxiliary-bar-chat-editors'));
		host.style.width = '100%';
		host.style.height = '100%';
		const surface = this.surface = append(host, $('.auxiliary-bar-chat-editors-surface'));
		const historyId = `auxiliary-bar-chat-history-${AuxiliaryBarChatEditors.nextHistoryId++}`;
		const sessionsLabel = localize('chatSessions', "Sessions");
		this.historyButton = append(surface, $('.chat-history-toggle.monaco-action-bar'));
		const actions = append(this.historyButton, $('ul.actions-container', { role: 'toolbar' }));
		const actionItem = append(actions, $('li.action-item', { role: 'presentation' }));
		this.historyIcon = append(actionItem, $('a.action-label.icon.codicon.codicon-layout-sidebar-right', {
			role: 'button',
			tabindex: '0',
			title: sessionsLabel,
			'aria-label': sessionsLabel,
			'aria-expanded': 'false',
			'aria-controls': historyId,
		}));
		this.historyPanel = append(host, $('.chat-session-history', {
			id: historyId,
			role: 'region',
			'aria-label': sessionsLabel,
		}));
		const toolbar = append(this.historyPanel, $('.chat-session-history-toolbar'));
		const newAgent = append(toolbar, $('button.chat-session-history-command', { type: 'button' }));
		append(newAgent, $('span.codicon.codicon-plus'));
		append(newAgent, $('span', undefined, localize('chatHistoryNewAgent', "New Agent")));
		this.historySearchButton = append(toolbar, $('button.chat-session-history-command', {
			type: 'button',
			'aria-pressed': 'false',
		}));
		append(this.historySearchButton, $('span.codicon.codicon-search'));
		append(this.historySearchButton, $('span', undefined, localize('chatHistorySearch', "Search")));
		this.historySearch = append(toolbar, $('input.chat-session-history-search', {
			type: 'search',
			placeholder: localize('chatHistorySearchPlaceholder', "Search sessions"),
			'aria-label': localize('chatHistorySearch', "Search"),
		})) as HTMLInputElement;
		this.historyList = append(this.historyPanel, $('.chat-session-history-list'));
		this._register(addDisposableListener(this.historyIcon, 'click', event => {
			event.preventDefault();
			this.setHistoryOpen(!this.historyOpen);
		}));
		this._register(addDisposableListener(this.historyIcon, 'keydown', event => {
			if (event.keyCode !== KeyCode.Enter && event.keyCode !== KeyCode.Space) {
				return;
			}
			event.preventDefault();
			this.setHistoryOpen(!this.historyOpen);
		}));
		this._register(addDisposableListener(newAgent, 'click', () => {
			void this.openNewChat();
		}));
		this._register(addDisposableListener(this.historySearchButton, 'click', () => this.setHistorySearching(!this.historySearching)));
		this._register(addDisposableListener(this.historySearch, 'input', () => {
			this.historyQuery = this.historySearch.value;
			this.paintHistory();
		}));
		this._register(addDisposableListener(host, 'keydown', event => {
			if (!this.historyOpen || event.keyCode !== KeyCode.Escape) {
				return;
			}
			if (this.historySearching) {
				this.setHistorySearching(false);
			} else {
				this.setHistoryOpen(false);
			}
			event.preventDefault();
			event.stopPropagation();
		}));
		this._register(this.chatService.onDidDisposeSession(() => {
			if (this.historyOpen) {
				void this.renderHistory();
			}
		}));
		this.historySash = this._register(new Sash(host, {
			getVerticalSashLeft: () => this.historySashLeft(),
		}, { orientation: Orientation.VERTICAL }));
		this.historySash.addClass('chat-history-sash');
		this.historySash.state = SashState.Disabled;
		this._register(this.historySash.onDidStart(() => {
			this.historyDragWidth = this.historyPreferredWidth;
		}));
		this._register(this.historySash.onDidChange(event => {
			if (this.historyDragWidth === undefined) {
				return;
			}
			const delta = event.currentX - event.startX;
			const widerToTheRight = chatHistoryEdge(this.layoutService.getSideBarPosition() === Position.RIGHT) === 'start';
			this.setHistoryPreferredWidth(widerToTheRight ? this.historyDragWidth + delta : this.historyDragWidth - delta, false);
		}));
		this._register(this.historySash.onDidEnd(() => {
			this.historyDragWidth = undefined;
			this.persistHistoryWidth();
		}));
		this._register(this.historySash.onDidReset(() => {
			this.setHistoryPreferredWidth(CHAT_HISTORY_COLUMN_WIDTH, true);
		}));
		this.updateHistorySide();
		const part = this.part = this.editorGroupsService.createEditorPart({
			container: surface,
			label: localize('auxiliaryBarChatEditors', "Chat"),
			partOptions: {
				showTabs: 'multiple',
				showIcons: true,
				enablePreview: false,
				editorActionsLocation: 'hidden',
			},
			groupViewOptions: {
				menuIds: { tabsBarAddTab: AuxiliaryBarChatEditorsAddTab, tabsBarAddTabDirect: true },
				acceptsEditor: (editor: EditorInput | IUntypedEditorInput) => editor instanceof ChatEditorInput,
			},
		});
		for (const group of part.groups) {
			this.trackGroup(group);
		}
		this._register(part.onDidAddGroup(group => this.trackGroup(group)));
		this._register(part.onDidChangeActiveGroup(() => this.refreshHistoryPresentation()));
		this._register(part.onDidRemoveGroup(group => this.groupListeners.deleteAndDispose(group.id)));
		this._register(toDisposable(() => {
			this.releasing = true;
			part.forceClose();
		}));
	}

	get isEmpty(): boolean {
		return !this.part || this.part.groups.every(group => group.isEmpty);
	}

	layout(width: number, height: number): void {
		this.lastLayout = { width, height };
		this.host.style.setProperty('--chat-session-tab-max-width', `${CHAT_SESSION_TAB_MAX_WIDTH}px`);
		this.updateHistorySide();
		const column = this.historyOpen ? chatHistoryColumnWidth(this.historyPreferredWidth, width) : 0;
		this.historyPanel.style.flexBasis = `${column}px`;
		this.historyPanel.style.width = `${column}px`;
		this.part?.layout(Math.max(0, width - column), height, 0, 0);
		this.historySash.state = this.historyOpen ? SashState.Enabled : SashState.Disabled;
		this.historySash.layout();
		this.placeHistoryChrome();
	}

	setVisible(visible: boolean): void {
		this.part?.setVisible(visible);
	}

	/** Opens a chat when the part has none, such as the first time the view shows or after the last one closed. */
	ensureOpen(resource?: URI): Promise<void> {
		if (!this.isEmpty) {
			return Promise.resolve();
		}
		return this.pending ?? this.openNewChat(resource);
	}

	/** Opens another chat and leaves the ones already open. */
	openNewChat(resource?: URI, group?: IEditorGroup): Promise<void> {
		const target = this.groupFor(group);
		if (!target || this.releasing) {
			return Promise.resolve();
		}
		const opening = this.openInGroup(target, resource);
		this.pending = opening;
		return opening.finally(() => {
			if (this.pending === opening) {
				this.pending = undefined;
			}
		});
	}

	private groupFor(group: IEditorGroup | undefined): IEditorGroup | undefined {
		if (!this.part) {
			return undefined;
		}
		if (group && this.part.groups.some(candidate => candidate.id === group.id)) {
			return group;
		}
		return this.part.activeGroup;
	}

	private async openInGroup(target: IEditorGroup, resource: URI | undefined): Promise<void> {
		const input = this.instantiationService.createInstance(ChatEditorInput, resource ?? ChatEditorInput.getNewEditorUri(), {});
		await target.openEditor(input, { pinned: true, index: target.count });
	}

	/** Opens a past session as a tab in this part. A session that is already open is shown in place. */
	openSession(resource: URI): Promise<void> {
		return this.resumeSession(resource);
	}

	refreshHistory(): void {
		if (this.historyOpen) {
			void this.renderHistory();
		}
	}

	/**
	 * Closes every tab of the session, in this part or the main editor area. When
	 * that would empty this part, a new chat opens first so the side chat stays.
	 * Returns false when a tab refused to close.
	 */
	async closeSessionEditors(resource: URI): Promise<boolean> {
		const targets = chatEditorsForSession(this.editorGroupsService, resource);
		const part = this.part;
		if (part && !this.releasing) {
			const own = targets.filter(target => part.groups.some(group => group.id === target.group.id));
			const open = part.groups.reduce((count, group) => count + group.count, 0);
			if (own.length > 0 && own.length >= open) {
				await this.openNewChat();
			}
		}
		let closed = true;
		for (const { group, editor } of targets) {
			closed = await group.closeEditor(editor) && closed;
		}
		this.refreshHistory();
		return closed;
	}

	private showHistoryMenu(resource: URI, anchor: HTMLElement | StandardMouseEvent, row: HTMLElement): void {
		const session = this.agentSessionsService.getSession(resource);
		const canRename = !session || isLocalAgentSessionItem(session) || this.chatSessionsService.sessionSupportsRename(resource);
		const contextKeyService = this.contextKeyService.createOverlay([
			[ChatHistoryCanPin.key, !!session],
			[ChatHistoryCanRename.key, canRename],
			[ChatContextKeys.isPinnedAgentSession.key, session?.isPinned() === true],
		]);
		row.classList.add('menu-open');
		this.contextMenuService.showContextMenu({
			menuId: ChatSessionHistoryContext,
			contextKeyService,
			menuActionOptions: { arg: { sessionResource: resource }, shouldForwardArgs: true },
			getAnchor: () => anchor,
			onHide: () => row.classList.remove('menu-open'),
		});
	}

	private async resumeSession(resource: URI): Promise<void> {
		const part = this.part;
		if (!part || this.releasing) {
			return;
		}
		for (const group of part.groups) {
			const existing = group.editors.find((editor): editor is ChatEditorInput => editor instanceof ChatEditorInput && (isEqual(editor.sessionResource, resource) || isEqual(editor.resource, resource)));
			if (existing) {
				await group.openEditor(existing, { pinned: true });
				return;
			}
		}
		await this.openInGroup(part.activeGroup, resource);
	}

	private updateHistorySide(): void {
		const edge = chatHistoryEdge(this.layoutService.getSideBarPosition() === Position.RIGHT);
		this.host.classList.toggle('chat-history-at-start', edge === 'start');
		this.host.classList.toggle('chat-history-at-end', edge === 'end');
		this.historyIcon.classList.toggle('codicon-layout-sidebar-left', edge === 'start');
		this.historyIcon.classList.toggle('codicon-layout-sidebar-right', edge === 'end');
	}

	/** Keeps the sessions button centered in the chat tab row. */
	private placeHistoryChrome(): void {
		const title = this.surface.querySelector(':scope > .content .editor-group-container > .title');
		const row = title instanceof HTMLElement ? Number.parseFloat(title.style.getPropertyValue('--editor-group-tab-height')) : Number.NaN;
		const rowHeight = Number.isFinite(row) && row > 0 ? row : 35;
		const titleHeight = title instanceof HTMLElement && title.offsetHeight > 0 ? title.offsetHeight : rowHeight;
		this.historyButton.style.height = `${titleHeight}px`;
	}

	private setHistoryOpen(open: boolean): void {
		if (this.historyOpen === open) {
			return;
		}
		this.historyOpen = open;
		this.host.classList.toggle('chat-history-open', open);
		this.historyIcon.setAttribute('aria-expanded', String(open));
		this.syncHistoryWidth();
		if (this.lastLayout) {
			this.layout(this.lastLayout.width, this.lastLayout.height);
		}
		if (!open) {
			return;
		}
		this.ensureHistoryListening();
		void this.renderHistory();
	}

	/** Grows or shrinks the chat's auxiliary bar by the sessions column, so the chat itself keeps its width. */
	private syncHistoryWidth(): void {
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}
		const target = this.historyOpen ? this.historyPreferredWidth : 0;
		const delta = target - this.historyWidthApplied;
		if (delta === 0) {
			return;
		}
		const before = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, delta, 0);
		const after = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		this.historyWidthApplied += after - before;
	}

	private setHistorySearching(searching: boolean): void {
		this.historySearching = searching;
		this.historyPanel.classList.toggle('searching', searching);
		this.historySearchButton.setAttribute('aria-pressed', String(searching));
		if (!searching) {
			this.historyQuery = '';
			this.historySearch.value = '';
			this.paintHistory();
			return;
		}
		this.historySearch.focus();
	}

	private ensureHistoryListening(): void {
		if (this.historyListening) {
			void this.agentSessionsService.model.resolve(undefined);
			return;
		}
		this.historyListening = true;
		const model = this.agentSessionsService.model;
		this._register(model.onDidChangeSessions(() => {
			if (this.historyOpen) {
				void this.renderHistory();
			}
		}));
		this._register(autorun(reader => {
			this.chatService.requestInProgressObs.read(reader);
			if (this.historyOpen && this.historyEntries.length > 0) {
				this.paintHistory();
			}
		}));
	}

	private async renderHistory(): Promise<void> {
		const render = ++this.historyRender;
		const sources: ChatHistorySource[] = [];
		try {
			const local = await this.chatService.getLocalSessionHistory();
			if (render !== this.historyRender) {
				return;
			}
			for (const session of local) {
				const timing = convertLegacyChatSessionTiming(session.timing);
				const resource = session.sessionResource.toString();
				const providerId = this.providerIdFor(session.sessionResource, session.providerId);
				sources.push({
					sessionResource: resource,
					title: session.title,
					providerId,
					iconId: this.iconIdFor(resource, providerId),
					activity: this.sessionActivity(session.sessionResource),
					pinned: this.agentSessionsService.getSession(session.sessionResource)?.isPinned() === true,
					lastMessageDate: session.lastMessageDate || timing.lastRequestEnded || timing.lastRequestStarted || timing.created,
				});
			}
		} catch {
			// Provider sessions still fill the list when local history cannot be read.
		}
		for (const session of this.agentSessionsService.model.sessions) {
			this.appendAgentSession(session, sources);
		}
		if (render !== this.historyRender || !this.historyOpen) {
			return;
		}
		this.historyEntries = chatHistoryEntries(sources, localize('chatHistoryUntitled', "New Chat"));
		this.paintHistory();
	}

	private appendAgentSession(session: IAgentSession, sources: ChatHistorySource[]): void {
		if (session.isArchived()) {
			return;
		}
		const resource = session.resource.toString();
		const providerId = this.providerIdFor(session.resource);
		sources.push({
			sessionResource: resource,
			title: session.label,
			detail: session.providerLabel,
			providerId,
			iconId: this.iconIdFor(resource, providerId),
			activity: this.sessionActivity(session.resource, this.sessionTreeBusy(session) ? ChatSessionStatus.InProgress : session.status),
			pinned: session.isPinned(),
			children: this.childHistorySources(session, providerId),
			lastMessageDate: session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created,
		});
	}

	/** Sub-agents stay under the chat that started them, including ones that have finished. */
	private childHistorySources(session: IAgentSession, parentProviderId: string | undefined): ChatHistorySource[] | undefined {
		const children = (session.children ?? []).filter(child => !child.isArchived()).map(child => {
			const resource = child.resource.toString();
			const providerId = this.providerIdFor(child.resource, parentProviderId);
			return {
				sessionResource: resource,
				title: child.label,
				detail: child.providerLabel,
				providerId,
				iconId: this.iconIdFor(resource, providerId),
				activity: this.sessionActivity(child.resource, this.sessionTreeBusy(child) ? ChatSessionStatus.InProgress : child.status),
				pinned: child.isPinned(),
				children: this.childHistorySources(child, providerId),
				lastMessageDate: child.timing.lastRequestEnded ?? child.timing.lastRequestStarted ?? child.timing.created,
			};
		});
		return children.length > 0 ? children : undefined;
	}

	/** This chat, or a sub-agent under it, still has a reply running. */
	private sessionTreeBusy(session: IAgentSession): boolean {
		if (this.chatService.getSession(session.resource)?.requestInProgress.get() === true || session.status === ChatSessionStatus.InProgress) {
			return true;
		}
		return (session.children ?? []).some(child => !child.isArchived() && this.sessionTreeBusy(child));
	}

	private paintHistory(): void {
		this.historyListeners.clear();
		clearNode(this.historyList);
		const decorated = this.historyEntries.map(entry => this.withSpawnedSubagents(entry));
		for (const entry of decorated) {
			if ((entry.children ?? []).some(child => child.spawned) && !this.historyCollapsed.has(entry.sessionResource)) {
				this.historyExpanded.add(entry.sessionResource);
			}
		}
		this.watchSubagentModels(decorated);
		const entries = filterChatHistoryEntries(decorated, this.historyQuery);
		const sections = chatHistorySections(decorated, this.openChatSessions(), localize('chatHistoryUntitled', "New Chat"));
		const current = filterChatHistoryEntries(sections.current.map(entry => entry.iconId ? entry : { ...entry, iconId: this.iconIdFor(entry.sessionResource, entry.providerId) ?? '' }), this.historyQuery);
		const currentResources = new Set(sections.current.map(entry => entry.sessionResource));
		const groups = chatHistoryGroups(entries.filter(entry => !currentResources.has(entry.sessionResource)));
		const active = this.activeSessionResources();
		const searching = this.historyQuery.trim().length > 0;

		const currentBody = this.paintHistorySection('current', localize('chatHistoryCurrent', "Current"), current.length);
		if (currentBody) {
			if (current.length === 0) {
				append(currentBody, $('.chat-session-history-empty', undefined, searching
					? localize('chatHistoryNoMatches', "No matching chats")
					: localize('chatHistoryNoOpen', "No open chats")));
			}
			for (const entry of current) {
				this.paintHistoryItem(currentBody, entry, active);
			}
		}

		const pastCount = groups.reduce((count, group) => count + group.entries.length, 0);
		const historyBody = this.paintHistorySection('history', localize('chatHistoryPast', "History"), pastCount);
		if (!historyBody) {
			return;
		}
		if (groups.length === 0) {
			append(historyBody, $('.chat-session-history-empty', undefined, searching
				? localize('chatHistoryNoMatches', "No matching chats")
				: localize('chatHistoryEmpty', "No past chats")));
			return;
		}
		for (const group of groups) {
			const section = append(historyBody, $('.chat-session-history-group'));
			append(section, $('.chat-session-history-group-label', undefined, this.historyGroupLabel(group.id)));
			for (const entry of group.entries) {
				this.paintHistoryItem(section, entry, active);
			}
		}
	}

	/** One accordion of the session list. Returns its body, or undefined while it is collapsed. A search opens every section. */
	private paintHistorySection(id: ChatHistorySectionId, label: string, count: number): HTMLElement | undefined {
		const expanded = this.historyQuery.trim().length > 0 || !this.historySectionsCollapsed.has(id);
		const section = append(this.historyList, $(`.chat-session-history-section.chat-session-history-section-${id}`));
		section.classList.toggle('collapsed', !expanded);
		const bodyId = `${this.historyPanel.id}-${id}`;
		const header = append(section, $('button.chat-session-history-section-header', {
			type: 'button',
			'aria-expanded': String(expanded),
			'aria-controls': bodyId,
		}));
		append(header, $(`span.chat-session-history-section-chevron.codicon.${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`));
		append(header, $('span.chat-session-history-section-label', undefined, label));
		append(header, $('span.chat-session-history-section-count', undefined, String(count)));
		this.historyListeners.add(addDisposableListener(header, 'click', event => {
			event.preventDefault();
			if (this.historySectionsCollapsed.has(id)) {
				this.historySectionsCollapsed.delete(id);
			} else {
				this.historySectionsCollapsed.add(id);
			}
			this.storageService.store(ChatHistoryCollapsedSectionsKey, [...this.historySectionsCollapsed].join(','), StorageScope.PROFILE, StorageTarget.USER);
			this.paintHistory();
			this.historyList.querySelector<HTMLElement>(`.chat-session-history-section-${id} > .chat-session-history-section-header`)?.focus();
		}));
		if (!expanded) {
			return undefined;
		}
		return append(section, $('.chat-session-history-section-body', { id: bodyId, role: 'group', 'aria-label': label }));
	}

	/** Every chat tab, in this part first and then the main editor area, in tab order. */
	private openChatSessions(): OpenChatSession[] {
		const open: OpenChatSession[] = [];
		const parts = this.part ? [this.part, ...this.editorGroupsService.parts.filter(part => part !== this.part)] : this.editorGroupsService.parts;
		for (const part of parts) {
			for (const group of part.groups) {
				for (const editor of group.editors) {
					if (!(editor instanceof ChatEditorInput)) {
						continue;
					}
					const primary = (editor.sessionResource ?? editor.resource).toString();
					const aliases = editor.sessionResource ? [editor.resource.toString()] : [];
					open.push({ sessionResource: primary, aliases, label: editor.getName() });
				}
			}
		}
		return open;
	}

	/** Moves rows between Current and History when a tab opens, closes or is renamed. */
	private scheduleHistoryRepaint(): void {
		if (!this.historyOpen || this.historyRepaintQueued) {
			return;
		}
		this.historyRepaintQueued = true;
		queueMicrotask(() => {
			this.historyRepaintQueued = false;
			if (this.historyOpen) {
				this.paintHistory();
			}
		});
	}

	private paintHistoryItem(parent: HTMLElement, entry: ChatHistoryEntry, active: readonly URI[]): void {
				const item = append(parent, $('.chat-session-history-item', {
					role: 'button',
					tabindex: '0',
					title: entry.label,
					'data-session-resource': entry.sessionResource,
				}));
				if (entry.providerId) {
					item.dataset.providerId = entry.providerId;
				}
				this.paintHistoryExpander(item, entry);
				if (this.isActiveHistoryResource(entry.sessionResource, active)) {
					item.classList.add('active');
					item.setAttribute('aria-current', 'true');
				}
				const activity = this.entryActivity(entry);
				const mark = append(item, $('span.chat-session-history-mark'));
				const icon = append(mark, $('span.chat-session-history-icon'));
				if (entry.iconId) {
					icon.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(entry.iconId)));
				}
				if (activity) {
					const status = append(mark, $('span.chat-session-history-status', {
						title: activity === 'working' ? localize('chatHistoryWorking', "Working") : localize('chatHistoryFinished', "Finished"),
					}));
					status.classList.add(activity === 'working' ? 'chat-session-working' : 'chat-session-finished');
				}
				append(item, $('span.chat-session-history-title', undefined, entry.label));
				if (entry.pinned) {
					append(item, $('span.chat-session-history-pin.codicon.codicon-pin', { title: localize('chatHistoryPinned', "Pinned") }));
				}
				if (entry.lastMessageDate > 0) {
					append(item, $('span.chat-session-history-time', undefined, fromNow(entry.lastMessageDate, false)));
				}
				const moreLabel = localize('chatHistoryMore', "Chat Actions");
				const more = append(item, $('button.chat-session-history-more.codicon.codicon-ellipsis', {
					type: 'button',
					title: moreLabel,
					'aria-label': moreLabel,
					'aria-haspopup': 'menu',
				}));
				const resource = URI.parse(entry.sessionResource);
				const open = () => { void this.resumeSession(resource); };
				this.historyListeners.add(addDisposableListener(item, 'click', event => {
					if (event.target instanceof HTMLElement && event.target.closest('.chat-session-history-more, .chat-session-history-children-toggle')) {
						return;
					}
					open();
				}));
				this.historyListeners.add(addDisposableListener(item, 'keydown', event => {
					if (event.keyCode !== KeyCode.Enter && event.keyCode !== KeyCode.Space) {
						return;
					}
					if (event.target instanceof HTMLElement && event.target.closest('.chat-session-history-more, .chat-session-history-children-toggle')) {
						return;
					}
					event.preventDefault();
					open();
				}));
				this.historyListeners.add(addDisposableListener(item, 'contextmenu', event => {
					event.preventDefault();
					event.stopPropagation();
					this.showHistoryMenu(resource, new StandardMouseEvent(getWindow(item), event), item);
				}));
				this.historyListeners.add(addDisposableListener(more, 'click', event => {
					event.preventDefault();
					event.stopPropagation();
					this.showHistoryMenu(resource, more, item);
				}));
				if (entry.children?.length && this.historyChildrenExpanded(entry)) {
					const nested = append(parent, $('.chat-session-history-children'));
					for (const child of entry.children) {
						this.paintHistoryItem(nested, child, active);
					}
				}
	}

	/** Sub-agents recorded on the reply, which the session list otherwise hides. */
	private withSpawnedSubagents(entry: ChatHistoryEntry): ChatHistoryEntry {
		let parent: URI;
		try {
			parent = URI.parse(entry.sessionResource);
		} catch {
			return entry;
		}
		const model = this.chatService.getSession(parent);
		if (!model) {
			return entry;
		}
		const spawned = subagentChatsInModel(model).flatMap(chat => {
			if (!chat.resource) {
				return [];
			}
			const target = subagentEditorResource(parent, chat.resource);
			if (!target) {
				return [];
			}
			return [{
				sessionResource: target.toString(),
				label: chat.label,
				detail: '',
				iconId: entry.iconId,
				providerId: entry.providerId,
				activity: chatSessionRunActivity(target.toString(), chat.running),
				spawned: true,
				lastMessageDate: entry.lastMessageDate,
			} satisfies ChatHistoryEntry];
		});
		if (spawned.length === 0) {
			return entry;
		}
		const seen = new Set((entry.children ?? []).map(child => child.sessionResource));
		const children = [...(entry.children ?? [])];
		for (const child of spawned) {
			if (!seen.has(child.sessionResource)) {
				children.push(child);
			}
		}
		return { ...entry, children };
	}

	private watchSubagentModels(entries: readonly ChatHistoryEntry[]): void {
		this.subagentModelListeners.clear();
		const resources = new Set(entries.map(entry => entry.sessionResource));
		for (const resource of this.activeSessionResources()) {
			resources.add(resource.toString());
		}
		for (const resource of resources) {
			let uri: URI;
			try {
				uri = URI.parse(resource);
			} catch {
				continue;
			}
			const model = this.chatService.getSession(uri);
			if (!model) {
				continue;
			}
			this.subagentModelListeners.add(model.onDidChange(() => {
				if (this.historyOpen) {
					this.paintHistory();
				}
			}));
		}
	}

	private historyChildrenExpanded(entry: ChatHistoryEntry): boolean {
		return this.historyQuery.trim().length > 0 || this.historyExpanded.has(entry.sessionResource);
	}

	private paintHistoryExpander(item: HTMLElement, entry: ChatHistoryEntry): void {
		if (!entry.children?.length) {
			return;
		}
		const expanded = this.historyChildrenExpanded(entry);
		const label = expanded
			? localize('chatHistoryCollapseChildren', "Collapse sub-agents")
			: localize('chatHistoryExpandChildren', "Expand sub-agents");
		const toggle = append(item, $('button.chat-session-history-children-toggle.codicon', {
			type: 'button',
			title: label,
			'aria-label': label,
			'aria-expanded': String(expanded),
		}));
		toggle.classList.add(expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
		this.historyListeners.add(addDisposableListener(toggle, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
		if (this.historyChildrenExpanded(entry)) {
			this.historyExpanded.delete(entry.sessionResource);
			this.historyCollapsed.add(entry.sessionResource);
		} else {
			this.historyCollapsed.delete(entry.sessionResource);
			this.historyExpanded.add(entry.sessionResource);
		}
		this.paintHistory();
		}));
	}

	/** A dot only after this app run has seen the session working. */
	private sessionActivity(resource: URI, status?: ChatSessionStatus): ChatHistoryActivity | undefined {
		const busy = this.chatService.getSession(resource)?.requestInProgress.get() === true || status === ChatSessionStatus.InProgress;
		return chatSessionRunActivity(resource.toString(), busy);
	}

	/** The dot follows a loaded session's live request, then the status stored with the row. A running sub-agent keeps the parent blue. */
	private entryActivity(entry: ChatHistoryEntry): ChatHistoryActivity | undefined {
		if ((entry.children ?? []).some(child => this.entryActivity(child) === 'working')) {
			return chatSessionRunActivity(entry.sessionResource, true);
		}
		const model = this.chatService.getSession(URI.parse(entry.sessionResource));
		if (model) {
			return chatSessionRunActivity(entry.sessionResource, model.requestInProgress.get());
		}
		return entry.activity;
	}

	/** Where the drag handle sits: on the inner edge of the sessions column. */
	private historySashLeft(): number {
		const column = this.historyPanel.offsetWidth;
		const onTheLeft = chatHistoryEdge(this.layoutService.getSideBarPosition() === Position.RIGHT) === 'start';
		return onTheLeft ? column : Math.max(0, this.host.clientWidth - column);
	}

	/**
	 * Remembers a dragged column width. When the chat would be squeezed below its
	 * minimum, the auxiliary bar grows so the column can keep that width.
	 */
	private setHistoryPreferredWidth(width: number, persist: boolean): void {
		this.historyPreferredWidth = chatHistoryPreferredWidth(String(width));
		if (persist) {
			this.persistHistoryWidth();
		}
		if (!this.historyOpen || !this.lastLayout) {
			return;
		}
		let layoutWidth = this.lastLayout.width;
		const fitted = chatHistoryColumnWidth(this.historyPreferredWidth, layoutWidth);
		const shortfall = this.historyPreferredWidth - fitted;
		if (shortfall > 0 && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			const before = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
			this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, shortfall, 0);
			const grown = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width - before;
			this.historyWidthApplied += grown;
			layoutWidth += grown;
		}
		this.layout(layoutWidth, this.lastLayout.height);
	}

	private persistHistoryWidth(): void {
		this.storageService.store(ChatHistoryWidthKey, this.historyPreferredWidth, StorageScope.PROFILE, StorageTarget.USER);
	}

	private historyGroupLabel(id: ChatHistoryGroupId): string {
		switch (id) {
			case 'pinned': return localize('chatHistoryPinnedGroup', "Pinned");
			case 'today': return localize('chatHistoryToday', "Today");
			case 'yesterday': return localize('chatHistoryYesterday', "Yesterday");
			case 'week': return localize('chatHistoryWeek', "Last 7 days");
			case 'older': return localize('chatHistoryOlder', "Older");
		}
	}

	private activeSessionResources(): URI[] {
		const editor = this.part?.activeGroup.activeEditor;
		if (!(editor instanceof ChatEditorInput)) {
			return [];
		}
		return [editor.sessionResource, editor.resource].filter((resource): resource is URI => !!resource);
	}

	private isActiveHistoryResource(resource: string, active: readonly URI[]): boolean {
		let parsed: URI;
		try {
			parsed = URI.parse(resource);
		} catch {
			return false;
		}
		return active.some(candidate => isEqual(candidate, parsed));
	}

	/** The provider selected on this chat, preferring the live model over the id saved with history. */
	private providerIdFor(resource: URI, stored?: string): string | undefined {
		const live = this.chatService.getSession(resource)?.inputModel.state.get()?.selectedModel?.metadata?.vendor;
		if (live) {
			return live;
		}
		for (const group of this.part?.groups ?? []) {
			for (const editor of group.editors) {
				if (!(editor instanceof ChatEditorInput) || !editor.sessionResource) {
					continue;
				}
				if (!isEqual(editor.sessionResource, resource) && !isEqual(editor.resource, resource)) {
					continue;
				}
				const vendor = this.chatService.getSession(editor.sessionResource)?.inputModel.state.get()?.selectedModel?.metadata?.vendor;
				if (vendor) {
					return vendor;
				}
			}
		}
		return stored;
	}

	/** The logo of the provider this session is using. The open chat with no model yet uses the picker. */
	private iconIdFor(resource: string, providerId: string | undefined): string | undefined {
		const providers = listChatProviders(this.configurationService);
		const resolved = providerId
			?? (this.isActiveHistoryResource(resource, this.activeSessionResources())
				? getSelectedChatProviderId(this.storageService, this.configurationService)
				: undefined);
		return chatSessionProviderIcon(resolved, providers)?.id;
	}

	/** Moves the highlight, and the logos, to the chat tab that is open. */
	private refreshHistoryPresentation(): void {
		if (!this.historyOpen) {
			return;
		}
		const active = this.activeSessionResources();
		for (const item of this.historyList.querySelectorAll<HTMLElement>('.chat-session-history-item')) {
			const resource = item.dataset.sessionResource;
			if (!resource) {
				continue;
			}
			const selected = this.isActiveHistoryResource(resource, active);
			item.classList.toggle('active', selected);
			if (selected) {
				item.setAttribute('aria-current', 'true');
			} else {
				item.removeAttribute('aria-current');
			}
			const icon = item.querySelector('.chat-session-history-icon');
			if (!(icon instanceof HTMLElement)) {
				continue;
			}
			let parsed: URI;
			try {
				parsed = URI.parse(resource);
			} catch {
				continue;
			}
			const providerId = this.providerIdFor(parsed, item.dataset.providerId);
			if (providerId) {
				item.dataset.providerId = providerId;
			}
			const iconId = this.iconIdFor(resource, providerId);
			icon.className = 'chat-session-history-icon';
			if (iconId) {
				icon.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
			}
		}
	}

	private trackGroup(group: IEditorGroup): void {
		if (this.groupListeners.has(group.id)) {
			return;
		}
		const store = new DisposableStore();
		const iconListener = new MutableDisposable();
		const trackIcon = () => {
			iconListener.clear();
			const editor = group.activeEditor;
			if (editor instanceof ChatEditorInput) {
				iconListener.value = editor.onDidChangeLabel(() => this.refreshHistoryPresentation());
			}
		};
		store.add(iconListener);
		store.add(group.onDidCloseEditor(() => this.hideIfEmpty()));
		store.add(group.onDidModelChange(event => {
			if (event.kind === GroupModelChangeKind.EDITOR_OPEN) {
				this.relocateForeignEditors(group);
			}
			if (event.kind === GroupModelChangeKind.EDITOR_OPEN || event.kind === GroupModelChangeKind.EDITOR_CLOSE || event.kind === GroupModelChangeKind.EDITOR_LABEL || event.kind === GroupModelChangeKind.EDITOR_MOVE) {
				this.scheduleHistoryRepaint();
			}
		}));
		store.add(group.onDidActiveEditorChange(() => {
			trackIcon();
			this.refreshHistoryPresentation();
		}));
		trackIcon();
		this.groupListeners.set(group.id, store);
		this.relocateForeignEditors(group);
	}

	/** A file that landed in the chat part belongs in the main editor area. */
	private relocateForeignEditors(group: IEditorGroup): void {
		if (this.releasing) {
			return;
		}
		const foreign = group.editors.filter(editor => !(editor instanceof ChatEditorInput));
		if (foreign.length === 0) {
			return;
		}
		const destination = this.editorGroupsService.mainPart.activeGroup;
		if (destination.id === group.id) {
			return;
		}
		group.moveEditors(foreign.map(editor => ({ editor })), destination);
	}

	/** After a move settles, an empty part hides the auxiliary bar. A move inside the part leaves a group occupied. */
	private hideIfEmpty(): void {
		queueMicrotask(() => {
			if (this.releasing || !this.part || this.part.groups.some(group => !group.isEmpty)) {
				return;
			}
			void this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		});
	}
}

interface IAuxiliaryBarChatEditorsHost {
	openNewChatEditor(group?: IEditorGroup): Promise<void>;
}

function isAuxiliaryBarChatEditorsHost(candidate: object): candidate is IAuxiliaryBarChatEditorsHost {
	return typeof (candidate as IAuxiliaryBarChatEditorsHost).openNewChatEditor === 'function';
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.auxiliaryBarNewChatTab',
			title: localize2('auxiliaryBarChatEditors.new', "New Chat"),
			f1: false,
			menu: [{
				id: AuxiliaryBarChatEditorsAddTab,
				group: 'navigation',
				order: 1,
			}],
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const view = accessor.get(IViewsService).getViewWithId(AuxiliaryBarChatViewId);
		if (!view || !isAuxiliaryBarChatEditorsHost(view)) {
			return;
		}
		const context = args.find(isEditorCommandsContext);
		const group = context ? accessor.get(IEditorGroupsService).getGroup(context.groupId) : undefined;
		await view.openNewChatEditor(group);
	}
});
