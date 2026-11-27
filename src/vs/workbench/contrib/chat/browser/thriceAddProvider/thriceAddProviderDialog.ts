/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { createWorkbenchDialogOptions } from '../../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITerminalGroupService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { listChatProviders, storeSelectedChatProvider, THRICE_PROVIDERS_SETTING } from '../../common/thriceProviders.js';
import type { ThriceProviderSettingEntry } from '../../common/thriceProviderDraft.js';
import { ThriceAddProviderView } from './thriceAddProviderView.js';

/** One Add provider modal. Opening it again while it is visible keeps that modal. */
export class ThriceAddProviderDialog extends Disposable {

	private static current: ThriceAddProviderDialog | undefined;

	private readonly dialog: Dialog;
	private readonly view: ThriceAddProviderView;
	private adding = false;
	private shown: Promise<void> | undefined;

	static open(instantiationService: IInstantiationService): Promise<void> {
		const current = ThriceAddProviderDialog.current;
		if (current?.shown) {
			return current.shown;
		}
		const dialog = instantiationService.createInstance(ThriceAddProviderDialog);
		ThriceAddProviderDialog.current = dialog;
		const shown = dialog.show().finally(() => {
			if (ThriceAddProviderDialog.current === dialog) {
				ThriceAddProviderDialog.current = undefined;
			}
		});
		dialog.shown = shown;
		return shown;
	}

	constructor(
		@ILayoutService layoutService: ILayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHostService hostService: IHostService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
	) {
		super();
		const slots: { body?: HTMLElement } = {};
		this.dialog = this._register(new Dialog(
			layoutService.activeContainer,
			localize('thrice.addProvider.dialogTitle', "Add provider"),
			[],
			createWorkbenchDialogOptions({
				type: 'none',
				extraClasses: ['thrice-add-provider-dialog'],
				detail: localize('thrice.addProvider.dialogDetail', "Add a CLI that is already installed on this machine, or enter one manually."),
				disableDefaultAction: true,
				renderBody: container => { slots.body = container; },
			}, keybindingService, layoutService, hostService),
		));
		const body = slots.body ?? layoutService.activeContainer;
		this.view = this._register(new ThriceAddProviderView(body, {
			takenIds: this.takenProviderIds(),
			presentation: 'dialog',
			onAdd: entry => { void this.addProvider(entry); },
			onCancel: () => this.dispose(),
			onAccountLogin: driver => { void this.startAccountLogin(driver); },
		}));
		void this.commandExists('claude').then(installed => this.view.setClaudeInstalled(installed));
	}

	private async commandExists(command: string): Promise<boolean> {
		const pathValue = typeof process !== 'undefined' ? process.env.PATH : undefined;
		if (!pathValue) {
			return true;
		}
		const directories = pathValue.split(process.platform === 'win32' ? ';' : ':');
		for (const directory of directories) {
			if (directory === '') {
				continue;
			}
			try {
				if (await this.fileService.exists(URI.file(`${directory}/${command}`))) {
					return true;
				}
			} catch {
				// A directory that cannot be read is not an install.
			}
		}
		return false;
	}

	private async startAccountLogin(driver: 'claude' | 'codex'): Promise<void> {
		if (driver === 'claude') {
			await this.openerService.open(URI.parse('https://claude.com/product/claude-code'), { openExternal: true });
			return;
		}
		const terminal = await this.terminalService.createTerminal({
			config: {
				name: localize('thrice.addProvider.chatGptTerminal', "ChatGPT"),
				executable: 'codex',
				args: ['login'],
				useShellEnvironment: true,
				isFeatureTerminal: true,
				isTransient: true,
			},
			location: TerminalLocation.Panel,
		});
		this.terminalService.setActiveInstance(terminal);
		await this.terminalGroupService.showPanel(true);
		this.dispose();
	}

	private async show(): Promise<void> {
		const closed = this.dialog.show();
		this.view.focus();
		await closed;
		this.dispose();
	}

	private takenProviderIds(): readonly string[] {
		const ids = new Set<string>();
		for (const provider of listChatProviders(this.configurationService)) {
			ids.add(provider.id);
		}
		const configured = this.configurationService.getValue(THRICE_PROVIDERS_SETTING);
		if (Array.isArray(configured)) {
			for (const item of configured) {
				if (!item || typeof item !== 'object') {
					continue;
				}
				const id = (item as { id?: unknown }).id;
				if (typeof id === 'string') {
					ids.add(id);
				}
			}
		}
		return [...ids];
	}

	private async addProvider(entry: ThriceProviderSettingEntry): Promise<void> {
		if (this.adding) {
			return;
		}
		this.adding = true;
		try {
			const current = this.configurationService.getValue(THRICE_PROVIDERS_SETTING);
			const instances = Array.isArray(current) ? current.slice() : [];
			instances.push({ ...entry });
			await this.configurationService.updateValue(THRICE_PROVIDERS_SETTING, instances, configurationTargetForProviders());
			storeSelectedChatProvider(this.storageService, entry.id);
			this.dispose();
		} finally {
			this.adding = false;
		}
	}
}

function configurationTargetForProviders(): ConfigurationTarget {
	const scope = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()[THRICE_PROVIDERS_SETTING]?.scope;
	switch (scope) {
		case undefined:
		case ConfigurationScope.APPLICATION:
		case ConfigurationScope.APPLICATION_MACHINE:
			return ConfigurationTarget.APPLICATION;
		case ConfigurationScope.MACHINE:
			return ConfigurationTarget.USER_LOCAL;
		case ConfigurationScope.RESOURCE:
		case ConfigurationScope.LANGUAGE_OVERRIDABLE:
		case ConfigurationScope.MACHINE_OVERRIDABLE:
			return ConfigurationTarget.WORKSPACE;
		default:
			return ConfigurationTarget.USER;
	}
}
