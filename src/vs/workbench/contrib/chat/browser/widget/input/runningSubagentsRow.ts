/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IAgentSession } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { ChatViewId, IChatWidgetService } from '../../chat.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { providerLogoIcon } from '../../../common/thriceProviderLogos.js';
import { subagentChatsInModel, subagentEditorResource } from '../../widgetHosts/viewPane/chatSubagentChats.js';
import { ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';
import { IRunningSubagentEntry, isActiveSubagentStatus, mergeSubagentEntries, subagentChildIcon, subagentChildLabel, subagentParentIcon, subagentSessionProvider, subagentStatus, subagentStatusClass, subagentStatusLabel } from './runningSubagentsEntries.js';

/**
 * Opens a chat as a tab in the auxiliary chat strip. Falls back to the
 * ordinary session opener when that strip is not the open chat.
 */
export async function openAuxiliaryChatSession(viewsService: IViewsService, chatWidgetService: IChatWidgetService, resource: URI): Promise<void> {
	const view = viewsService.getActiveViewWithId(ChatViewId) ?? viewsService.getViewWithId(ChatViewId);
	const opener = view as unknown as { openSessionEditor?: (resource: URI) => Promise<void> };
	if (viewsService.isViewVisible(ChatViewId) && typeof opener?.openSessionEditor === 'function') {
		await opener.openSessionEditor(resource);
		return;
	}
	await chatWidgetService.openSession(resource);
}

/** A collapsible list of the sub-agents this chat spawned, docked above the text field. */
export class RunningSubagentsRow extends Disposable {
	private readonly listeners = this._register(new DisposableStore());
	private readonly modelListener = this._register(new MutableDisposable());
	/** A completed tool call no longer changes its chat, so a background child's updates are watched here. */
	private readonly invocationWatcher = this._register(new MutableDisposable());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.refresh(), 0));
	private watchedSession: string | undefined;
	/** Folded to a summary line by default, like the changed-files list. */
	private collapsed = true;

	constructor(
		private readonly container: HTMLElement,
		private readonly currentSession: () => URI | undefined,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatService private readonly chatService: IChatService,
		@IViewsService private readonly viewsService: IViewsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();
		this.container.hidden = true;
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.refresh()));
		this._register(autorun(reader => {
			this.chatService.requestInProgressObs.read(reader);
			this.refresh();
		}));
		this.refresh();
	}

	refresh(): void {
		const resource = this.currentSession();
		const model = resource ? this.chatService.getSession(resource) : undefined;
		const watched = resource?.toString();
		if (watched !== this.watchedSession) {
			this.watchedSession = watched;
			this.modelListener.value = model?.onDidChange(() => this.refresh());
		}
		this.watchSubagentInvocations(model);
		const spawned = resource ? this.spawnedChats(resource) : [];
		this.listeners.clear();
		clearNode(this.container);
		const visible = spawned.length > 0;
		this.container.hidden = !visible;
		setChatInputStackSlot(this.container, visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
		if (!visible) {
			return;
		}

		const panel = append(this.container, $('.chat-running-subagents-container'));
		const working = spawned.filter(session => session.status === 'working').length;
		const waiting = spawned.filter(session => session.status === 'inputNeeded').length;
		const title = spawned.length === 1
			? localize('chatRunningSubagents.one', "1 agent")
			: localize('chatRunningSubagents.many', "{0} agents", spawned.length);
		const details: string[] = [];
		if (working > 0) {
			details.push(localize('chatRunningSubagents.working', "{0} working", working));
		}
		if (waiting > 0) {
			details.push(localize('chatRunningSubagents.waiting', "{0} waiting", waiting));
		}
		const header = append(panel, $('button.chat-running-subagents-overview', {
			type: 'button',
			'aria-expanded': String(!this.collapsed),
			'aria-label': localize('chatRunningSubagents.toggle', "Toggle agents. {0}", [title, ...details].join(', ')),
		}));
		const chevron = append(header, $('span.chat-running-subagents-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(this.collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		append(header, $('span.chat-running-subagents-title', undefined, title));
		if (details.length) {
			append(header, $('span.chat-running-subagents-details', undefined, details.join(' · ')));
		}
		this.listeners.add(addDisposableListener(header, 'click', () => {
			this.collapsed = !this.collapsed;
			this.refresh();
		}));

		const list = append(panel, $('.chat-running-subagents-list', { role: 'list' }));
		list.classList.toggle('collapsed', this.collapsed);
		for (const session of spawned) {
			const statusLabel = subagentStatusLabel(session.status);
			const button = append(list, $('button.chat-running-subagent', {
				type: 'button',
				role: 'listitem',
				title: session.label,
				'aria-label': localize('chatRunningSubagentAriaLabel', "{0}, {1}", session.label, statusLabel),
			}));
			const mark = append(button, $('span.chat-running-subagent-mark'));
			const iconEl = append(mark, $('span.chat-running-subagent-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(session.icon));
			const status = append(mark, $('span.chat-running-subagent-status', { title: statusLabel }));
			status.classList.add(subagentStatusClass(session.status));
			append(button, $('span.chat-running-subagent-title', undefined, session.label));
			const stateLabel = append(button, $('span.chat-running-subagent-state', undefined, statusLabel));
			stateLabel.classList.add(subagentStatusClass(session.status));
			const target = session.target;
			if (!target) {
				button.setAttribute('disabled', 'true');
				continue;
			}
			this.listeners.add(addDisposableListener(button, 'click', () => {
				void openAuxiliaryChatSession(this.viewsService, this.chatWidgetService, target);
			}));
		}
	}

	/** Refreshes when a live sub-agent tool call changes, including after it completed. */
	private watchSubagentInvocations(model: IChatModel | undefined): void {
		if (!model) {
			this.invocationWatcher.clear();
			return;
		}
		let initial = true;
		this.invocationWatcher.value = autorun(reader => {
			for (const request of model.getRequests()) {
				for (const part of request.response?.response.value ?? []) {
					if (part.kind === 'toolInvocation' && part.toolSpecificData?.kind === 'subagent') {
						part.state.read(reader);
					}
				}
			}
			if (!initial) {
				this.refreshScheduler.schedule();
			}
			initial = false;
		});
	}

	/** Sub-agents this chat spawned. Finished ones stay so they can be opened. */
	private spawnedChats(resource: URI): IRunningSubagentEntry[] {
		const parent = this.agentSessionsService.getSession(resource);
		const parentIcon = parent ? subagentParentIcon(parent) : providerLogoIcon('acp');
		const parentProvider = parent ? subagentSessionProvider(parent) : undefined;
		const model = this.chatService.getSession(resource);
		const fromModel = model ? subagentChatsInModel(model) : [];
		const fromTools = fromModel.map((chat): IRunningSubagentEntry => {
			const target = chat.resource ? subagentEditorResource(resource, chat.resource) : undefined;
			return {
				label: subagentChildLabel(chat.label, chat.provider, parentProvider),
				icon: subagentChildIcon(chat.provider, parentIcon),
				status: subagentStatus({
					running: chat.running,
					inputNeeded: chat.inputNeeded,
					childBusy: this.isChatBusy(chat.resource),
					childStatus: target ? this.agentSessionsService.getSession(target.with({ query: '' }))?.status : undefined,
				}),
				target,
			};
		});
		return mergeSubagentEntries(fromTools, this.activeChildren(parent, parentIcon));
	}

	/** Direct children of the open chat. A nested agent shows on that child's own composer. */
	private activeChildren(parent: IAgentSession | undefined, parentIcon: ThemeIcon): IRunningSubagentEntry[] {
		const entries: IRunningSubagentEntry[] = [];
		for (const child of parent?.children ?? []) {
			if (child.isArchived()) {
				continue;
			}
			const status = subagentStatus({
				running: false,
				childStatus: child.status,
				childBusy: this.chatService.getSession(child.resource)?.requestInProgress.get() === true,
			});
			if (!isActiveSubagentStatus(status)) {
				continue;
			}
			entries.push({
				label: child.label,
				icon: child.icon.id.startsWith('thrice-logo-') ? child.icon : parentIcon,
				status,
				target: child.resource,
			});
		}
		return entries;
	}

	/** Whether the child's own chat still has a reply running, whatever its spawning tool call reports. */
	private isChatBusy(chatResource: string | undefined): boolean {
		if (!chatResource) {
			return false;
		}
		try {
			return this.chatService.getSession(URI.parse(chatResource, true))?.requestInProgress.get() === true;
		} catch {
			return false;
		}
	}
}
