/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IMenuService, MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownOptions } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { observableConfigValue } from '../../../../../../platform/observable/common/platformObservableUtils.js';
import { logSettingExperimentTrigger } from '../../../../../../platform/telemetry/common/experimentTrigger.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatMode, IChatMode, IChatModes } from '../../../common/chatModes.js';
import { getCompactCodicon } from '../../chatIcons.js';
import { isOrganizationPromptFile } from '../../../common/promptSyntax/utils/promptsServiceUtils.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../../common/constants.js';
import { PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { Target } from '../../../common/promptSyntax/promptTypes.js';
import { getOpenChatActionIdForMode } from '../../actions/chatActions.js';
import { IToggleChatModeArgs, ToggleAgentModeActionId } from '../../actions/chatExecuteActions.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IWorkbenchAssignmentService } from '../../../../../services/assignment/common/assignmentService.js';

export interface IModePickerDelegate {
	readonly currentMode: IObservable<IChatMode>;
	readonly currentChatModes: IObservable<IChatModes>;
	readonly sessionResource: () => URI | undefined;
	readonly supportsAttachContext?: boolean;
	/** Direct mode-change callback for hosts without a registered IChatWidget (bypasses ToggleAgentModeActionId). */
	readonly setMode?: (mode: IChatMode) => void;
	/**
	 * When set, the mode picker will show custom agents whose target matches this value.
	 * Custom agents without a target are always shown in all session types. If no agents match the target, shows a default "Agent" option.
	 */
	readonly customAgentTarget?: () => Target;
}

// TODO: there should be an icon contributed for built-in modes
const builtinDefaultIcon = (mode: IChatMode) => {
	switch (mode.name.get().toLowerCase()) {
		case 'ask': return Codicon.ask;
		case 'plan': return Codicon.tasklist;
		default: return undefined;
	}
};

export function createAgentPickerInAttachContext(delegate: IModePickerDelegate, configurationService: IConfigurationService, telemetryService: ITelemetryService): IObservable<boolean> {
	const setting = observableConfigValue(ChatConfiguration.AgentsPickerInAttachContextMenu, false, configurationService);
	return derived(delegate, reader => {
		if (!delegate.supportsAttachContext || delegate.currentMode.read(reader).id !== ChatMode.Agent.id) {
			return false;
		}
		logSettingExperimentTrigger(telemetryService, ChatConfiguration.AgentsPickerInAttachContextMenu);
		return setting.read(reader);
	});
}

export class ModePickerActionItem extends ChatInputPickerActionViewItem {
	private readonly delegate: IModePickerDelegate;
	private readonly _productService: IProductService;

	constructor(
		action: MenuItemAction,
		delegate: IModePickerDelegate,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMenuService menuService: IMenuService,
		@ICommandService commandService: ICommandService,
		@IProductService productService: IProductService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IOpenerService openerService: IOpenerService,
		@IWorkbenchAssignmentService assignmentService: IWorkbenchAssignmentService,
	) {
		void menuService;
		void assignmentService;

		// Category definitions
		const builtInCategory = { label: localize('built-in', "Built-In"), order: 0 };
		const policyDisabledCategory = { label: localize('managedByOrganization', "Managed by your organization"), order: 999, showHeader: true };

		const agentModeDisabledViaPolicy = configurationService.inspect<boolean>(ChatConfiguration.AgentEnabled).policyValue === false;

		const makeAction = (mode: IChatMode, currentMode: IChatMode): IActionWidgetDropdownAction => {
			const isDisabledViaPolicy =
				mode.kind === ChatModeKind.Agent &&
				agentModeDisabledViaPolicy;

			const tooltip = chatAgentService.getDefaultAgent(ChatAgentLocation.Chat, mode.kind)?.description ?? action.tooltip;

			// Add toolbar actions for Agent modes
			const toolbarActions: IAction[] = [];
			if (mode.kind === ChatModeKind.Agent && !isDisabledViaPolicy) {
				if (mode.uri) {
					let label, icon;
					if (mode.source?.storage === PromptsStorage.extension) {
						icon = Codicon.file;
						label = localize('viewModeConfiguration', "View {0} agent", mode.label.get());
					} else {
						icon = Codicon.edit;
						label = localize('editModeConfiguration', "Edit {0} agent", mode.label.get());
					}

					const modeResource = mode.uri;
					toolbarActions.push({
						id: getModeConfigurationActionId(mode, this._productService),
						label,
						tooltip: label,
						class: ThemeIcon.asClassName(icon),
						enabled: true,
						run: async () => {
							openerService.open(modeResource.get());
						}
					});
				}
			}

			return {
				...action,
				id: getOpenChatActionIdForMode(mode),
				label: mode.label.get(),
				icon: isDisabledViaPolicy ? ThemeIcon.fromId(Codicon.lock.id) : mode.icon.get(),
				class: isDisabledViaPolicy ? 'disabled-by-policy' : undefined,
				enabled: !isDisabledViaPolicy,
				checked: !isDisabledViaPolicy && currentMode.id === mode.id,
				tooltip: '',
				hover: { content: tooltip },
				toolbarActions,
				run: async () => {
					if (isDisabledViaPolicy) {
						return; // Block interaction if disabled by policy
					}
					// Session-less hosts (e.g. the automations dialog) provide
					// `setMode` and a `sessionResource` that returns undefined.
					// Skip the command path because it requires a registered
					// `IChatWidget`. Route the change to the host directly so the
					// input's mode observable is actually updated. Real chat
					// widgets always have a session URI. They always take the
					// command path (telemetry, confirmation, new-chat-on-clear).
					if (this.delegate.setMode && !this.delegate.sessionResource()) {
						this.delegate.setMode(mode);
						if (this.element) {
							this.renderLabel(this.element);
						}
						return;
					}
					const result = await commandService.executeCommand(
						ToggleAgentModeActionId,
						{ modeId: mode.id, sessionResource: this.delegate.sessionResource() } satisfies IToggleChatModeArgs
					);
					if (this.element) {
						this.renderLabel(this.element);
					}
					return result;
				},
				category: isDisabledViaPolicy ? policyDisabledCategory : builtInCategory
			};
		};

		const thriceModes = (): IActionWidgetDropdownAction[] => {
			const modes = delegate.currentChatModes.get();
			const currentMode = delegate.currentMode.get();
			const choices = [
				modes.findModeById(ChatMode.Agent.id) ?? ChatMode.Agent,
				modes.findModeById(ChatMode.Plan.id) ?? ChatMode.Plan,
				modes.findModeById(ChatMode.Ask.id) ?? ChatMode.Ask,
			];
			return choices.map(mode => {
				const item = makeAction(mode, currentMode);
				item.category = undefined;
				return item;
			});
		};

		const modePickerActionWidgetOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider: { getActions: () => thriceModes() },
			actionBarActionProvider: {
				getActions: () => this.getModePickerActionBarActions()
			},
			showItemKeybindings: true,
			reporter: { id: 'ChatModePicker', name: 'ChatModePicker', includeOptions: true },
		};

		super(action, modePickerActionWidgetOptions, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);
		this.delegate = delegate;
		this._productService = productService;

		// Listen to changes in the current mode and its properties
		this._register(autorun(reader => {
			this.delegate.currentMode.read(reader).label.read(reader); // use the reader so autorun tracks it
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	private getModePickerActionBarActions(): IAction[] {
		return [];
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-mode-picker-item');
	}

	get isConnected(): boolean {
		return !!this.element?.isConnected;
	}

	override isFocused(): boolean {
		return !!this.element && dom.isAncestorOfActiveElement(this.element);
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		const currentMode = this.delegate.currentMode.get();
		const state = currentMode.label.get();
		let icon = currentMode.icon.get();

		// Every built-in mode should have an icon. // TODO: this should be provided by the mode itself
		if (!icon && isModeConsideredBuiltIn(currentMode, this._productService)) {
			icon = builtinDefaultIcon(currentMode);
		}

		const labelElements = [];
		const collapsed = this.pickerOptions.compact.get();
		element.classList.toggle('icon-only', collapsed && !!icon);
		if (icon) {
			labelElements.push(...renderLabelWithIcons(`$(${getCompactCodicon(icon).id})`));
		}
		if (!collapsed || !icon) {
			labelElements.push(dom.$('span.chat-input-picker-label', undefined, state));
		}

		dom.reset(element, ...labelElements);
		this.setAriaLabelAttributes(element);
		element.ariaLabel = state;
		return null;
	}
}

/**
 * The id of a mode's Edit Agent or View Agent action. A built-in mode keeps its name; any other is named only by where
 * its file comes from, such as the workspace, the user's prompts, an extension or a plugin.
 */
export function getModeConfigurationActionId(mode: IChatMode, productService: IProductService): string {
	const action = mode.source?.storage === PromptsStorage.extension ? 'viewAgent' : 'editAgent';
	return `${action}:${isModeConsideredBuiltIn(mode, productService) ? mode.name.get() : mode.source?.storage ?? 'other'}`;
}

export function isModeConsideredBuiltIn(mode: IChatMode, productService: IProductService): boolean {
	if (mode.isBuiltin || mode.source?.storage === PromptsStorage.builtIn) {
		return true;
	}
	// Not built-in if not from the built-in chat extension
	if (mode.source?.storage !== PromptsStorage.extension) {
		return false;
	}
	const chatExtensionId = productService.defaultChatAgent?.chatExtensionId;
	if (!chatExtensionId || mode.source.extensionId.value !== chatExtensionId) {
		return false;
	}
	// Organization-provided agents (under /github/ path) are also not considered built-in
	const modeUri = mode.uri?.get();
	if (!modeUri) {
		// If somehow there is no URI, but it's from the built-in chat extension, consider it built-in
		return true;
	}
	return !isOrganizationPromptFile(modeUri, mode.source.extensionId, productService);
}
