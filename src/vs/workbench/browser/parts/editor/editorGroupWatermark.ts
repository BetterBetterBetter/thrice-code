/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, h } from '../../../../base/browser/dom.js';
import { ActionBar, ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isWeb, OS } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';

interface WatermarkEntry {
	readonly id: string;
	readonly text: string;
	readonly icon: ThemeIcon;
	readonly suppressKeybindingLabel?: boolean;
	readonly when?: {
		native?: ContextKeyExpression;
		web?: ContextKeyExpression;
	};
}

const showChatContextKey = ContextKeyExpr.and(ContextKeyExpr.equals('chatSetupHidden', false), ContextKeyExpr.equals('chatSetupDisabledInWorkspace', false));
const panelVisibleKey = 'panelVisible';
const explorerVisibleKey = 'explorerViewletVisible';

const newAgent: WatermarkEntry = {
	text: localize('watermark.newAgent', "New Agent"), id: 'workbench.action.chat.newAgent',
	icon: registerIcon('watermark-chat', Codicon.chatSparkle, localize('watermark.chatIcon', "Icon for opening chat in the editor watermark.")),
	when: { native: showChatContextKey, web: showChatContextKey }
};
const showTerminal: WatermarkEntry = {
	text: localize('watermark.showTerminal', "Show Terminal"), id: 'workbench.action.togglePanel',
	icon: registerIcon('watermark-terminal', Codicon.terminal, localize('watermark.terminalIcon', "Icon for toggling the terminal in the editor watermark."))
};
const hideTerminal: WatermarkEntry = {
	text: localize('watermark.hideTerminal', "Hide Terminal"), id: 'workbench.action.togglePanel',
	icon: showTerminal.icon
};
const showFiles: WatermarkEntry = {
	text: localize('watermark.showFiles', "Show Files"), id: 'workbench.view.explorer',
	icon: registerIcon('watermark-files', Codicon.files, localize('watermark.filesIcon', "Icon for showing files in the editor watermark."))
};
const searchFiles: WatermarkEntry = {
	text: localize('watermark.searchFiles', "Search Files"), id: 'workbench.action.quickOpen',
	icon: registerIcon('watermark-quick-open', Codicon.goToFile, localize('watermark.quickOpenIcon', "Icon for searching files in the editor watermark."))
};
const openBrowser: WatermarkEntry = {
	text: localize('watermark.openBrowser', "Open Browser"), id: 'composer.openBrowserTab',
	icon: registerIcon('watermark-browser', Codicon.globe, localize('watermark.browserIcon', "Icon for opening the browser in the editor watermark."))
};
const maximizeChat: WatermarkEntry = {
	text: localize('watermark.maximizeChat', "Maximize Chat"), id: 'workbench.action.maximizeChatSize',
	icon: registerIcon('watermark-maximize-chat', Codicon.screenFull, localize('watermark.maximizeChatIcon', "Icon for maximizing chat in the editor watermark."))
};
const addFolder: WatermarkEntry = {
	text: localize('watermark.addFolder', "Add Folder"), id: 'workbench.action.addRootFolder',
	icon: registerIcon('watermark-add-folder', Codicon.folderOpened, localize('watermark.addFolderIcon', "Icon for adding a folder in the editor watermark."))
};
const addRepository: WatermarkEntry = {
	text: localize('watermark.addRepository', "Add Repository"), id: 'workbench.action.addRootFolder',
	icon: addFolder.icon
};

const allEntries: WatermarkEntry[] = [newAgent];

function getWhen(entry: WatermarkEntry): ContextKeyExpression | undefined {
	return isWeb ? entry.when?.web : entry.when?.native;
}

const whenKeys = new Set(allEntries.flatMap(entry => getWhen(entry)?.keys() ?? []));

export class EditorGroupWatermark extends Disposable {

	private static readonly CACHED_WHEN = 'editorGroupWatermark.whenConditions';
	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';

	private readonly cachedWhen: { [when: string]: boolean };
	private readonly renderedWhenResults = new Map<string, boolean>();

	private readonly shortcuts: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());
	private readonly shortcutDisposables = this._register(new DisposableStore());

	private enabled = false;
	private workbenchState: WorkbenchState;
	private isRepository = false;
	private repositoryCheckedFor: string | undefined;

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService
	) {
		super();

		this.cachedWhen = this.storageService.getObject(EditorGroupWatermark.CACHED_WHEN, StorageScope.PROFILE, Object.create(null));
		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark-toolbar-container@toolbarContainer'),
			h('.editor-group-watermark', [
				h('.watermark-container', [
					h('.letterpress'),
					h('.shortcuts@shortcuts'),
				])
			])
		]);

		append(container, elements.root);
		this.shortcuts = elements.shortcuts;
		this.toolbarContainer = elements.toolbarContainer;

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.toolbarContainer, MenuId.EditorGroupWatermarkToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			highlightToggledItems: true,
			menuOptions: { shouldForwardArgs: true }
		}));

		this.registerListeners();

		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY) &&
				this.enabled !== this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY)
			) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this.repositoryCheckedFor = undefined;
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkspaceFolders(() => {
			this.repositoryCheckedFor = undefined;
			this.render();
		}));

		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([panelVisibleKey, explorerVisibleKey]))) {
				this.render();
				return;
			}

			if (!e.affectsSome(whenKeys)) {
				return;
			}

			let visibilityChanged = false;
			for (const entry of allEntries) {
				const when = getWhen(entry);
				if (when && e.affectsSome(new Set(when.keys()))) {
					// Once a condition changes, the live value replaces the result cached from the previous session
					const matches = this.contextKeyService.contextMatchesRules(when);
					this.cachedWhen[entry.id] = matches;
					if (this.renderedWhenResults.has(entry.id) && this.renderedWhenResults.get(entry.id) !== matches) {
						visibilityChanged = true;
					}
				}
			}

			if (visibilityChanged) {
				this.render();
			}
		}));

		this._register(this.storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN) {
				for (const entry of allEntries) {
					const when = getWhen(entry);
					if (when) {
						this.cachedWhen[entry.id] = this.contextKeyService.contextMatchesRules(when);
					}
				}

				this.storageService.store(EditorGroupWatermark.CACHED_WHEN, JSON.stringify(this.cachedWhen), StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}));
	}

	private render(): void {
		this.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);

		clearNode(this.shortcuts);
		this.transientDisposables.clear();
		this.shortcutDisposables.clear();
		this.renderedWhenResults.clear();

		this.refreshRepositoryEntry();

		if (!this.enabled) {
			return;
		}

		const entries = this.filterEntries(this.splashEntries());

		const box = append(this.shortcuts, $('.watermark-box'));

		const update = () => {
			clearNode(box);
			this.shortcutDisposables.clear();

			const shortcuts = new Map<string, { entry: WatermarkEntry; keybinding: ResolvedKeybinding | undefined }>();
			for (const entry of entries) {
				const keybinding = entry.suppressKeybindingLabel ? undefined : this.keybindingService.lookupKeybinding(entry.id);
				if (!entry.suppressKeybindingLabel && !keybinding) {
					continue;
				}
				shortcuts.set(entry.id, { entry, keybinding });
			}

			const actionBar = this.shortcutDisposables.add(new ActionBar(box, {
				orientation: ActionsOrientation.VERTICAL,
				ariaLabel: localize('watermark.shortcuts', "Editor Shortcuts"),
				actionViewItemProvider: action => {
					const shortcut = shortcuts.get(action.id);
					return shortcut ? this.instantiationService.createInstance(WatermarkActionViewItem, action, shortcut.entry.icon, shortcut.keybinding) : undefined;
				},
			}));
			this.shortcutDisposables.add(actionBar.onDidRun(e => {
				if (e.error && !isCancellationError(e.error)) {
					this.notificationService.error(e.error);
				}
			}));

			for (const { entry } of shortcuts.values()) {
				actionBar.push(this.shortcutDisposables.add(new Action(entry.id, entry.text, undefined, true, () => this.commandService.executeCommand(entry.id))));
			}
		};

		update();
		this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));
	}

	private splashEntries(): WatermarkEntry[] {
		const panelVisible = this.contextKeyService.contextMatchesRules(ContextKeyExpr.equals(panelVisibleKey, true));
		const explorerVisible = this.contextKeyService.contextMatchesRules(ContextKeyExpr.equals(explorerVisibleKey, true));
		return [
			newAgent,
			panelVisible ? hideTerminal : showTerminal,
			...(explorerVisible ? [] : [showFiles]),
			searchFiles,
			openBrowser,
			maximizeChat,
			...this.addFolderEntries(),
		];
	}

	private addFolderEntries(): WatermarkEntry[] {
		const folder = this.singleFolder();
		if (!folder) {
			return [];
		}

		const entry = this.isRepository ? addRepository : addFolder;
		return [this.workbenchState === WorkbenchState.WORKSPACE ? { ...entry, suppressKeybindingLabel: true } : entry];
	}

	private singleFolder(): IWorkspaceFolder | undefined {
		if (this.workbenchState !== WorkbenchState.FOLDER && this.workbenchState !== WorkbenchState.WORKSPACE) {
			return undefined;
		}

		const folders = this.contextService.getWorkspace().folders;
		return folders.length === 1 ? folders[0] : undefined;
	}

	private refreshRepositoryEntry(): void {
		const folder = this.singleFolder();
		const key = folder?.uri.toString();
		if (this.repositoryCheckedFor === key) {
			return;
		}

		this.repositoryCheckedFor = key;
		this.isRepository = false;
		if (!folder) {
			return;
		}

		this.fileService.resolve(joinPath(folder.uri, '.git')).then(stat => {
			if (this._store.isDisposed || this.repositoryCheckedFor !== key) {
				return;
			}

			if (stat.isDirectory || stat.isFile) {
				this.isRepository = true;
				this.render();
			}
		}, () => undefined);
	}

	private filterEntries(entries: WatermarkEntry[]): WatermarkEntry[] {
		const filteredEntries = entries
			.filter(entry => {
				const contextKey = getWhen(entry);
				if (!contextKey) {
					return true; // works without context
				}

				const matches = !!this.cachedWhen[entry.id] /* cached from previous session */ || this.contextKeyService.contextMatchesRules(contextKey);
				this.renderedWhenResults.set(entry.id, matches);
				return matches;
			})
			.filter(entry => !!CommandsRegistry.getCommand(entry.id))
			.filter(entry => entry.suppressKeybindingLabel || !!this.keybindingService.lookupKeybinding(entry.id));

		return filteredEntries;
	}
}

/**
 * A row of the editor group watermark: icon, label and keybinding. Also used by the empty editor hint.
 */
export class WatermarkActionViewItem extends BaseActionViewItem {

	constructor(
		action: IAction,
		private readonly icon: ThemeIcon,
		private readonly keybinding: ResolvedKeybinding | undefined,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		const row = append(container, $('a.action-label.watermark-entry'));
		super.render(row);
		row.setAttribute('role', 'button');
		const keybindingAriaLabel = this.keybinding?.getAriaLabel();
		row.setAttribute('aria-label', keybindingAriaLabel ? localize('watermark.shortcutAriaLabel', "{0} ({1})", this._action.label, keybindingAriaLabel) : this._action.label);

		const icon = append(row, renderIcon(this.icon));
		icon.classList.add('watermark-icon');
		icon.setAttribute('aria-hidden', 'true');
		append(row, $('span.watermark-label')).textContent = this._action.label;
		if (this.keybinding) {
			this._register(new KeybindingLabel(append(row, $('span.watermark-keybinding')), OS, defaultKeybindingLabelStyles)).set(this.keybinding);
		}
		this._register(this.hoverService.setupDelayedHover(row, { content: this._action.label }));
	}
}
