/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { THRICE_PROVIDER_DRIVERS, type ThriceProviderDriver } from './thriceProviderDraft.js';
import { providerLogoIcon } from './thriceProviderLogos.js';

export const THRICE_PROVIDERS_SETTING = 'thrice.providers.instances';
export const SELECTED_CHAT_PROVIDER_STORAGE_KEY = 'thrice.chat.selectedProvider';
export const ADD_CHAT_PROVIDER_COMMAND = 'thrice.providers.add';

export type { ThriceProviderDriver } from './thriceProviderDraft.js';

export interface ThriceChatProvider {
	readonly id: string;
	readonly label: string;
	readonly driver: ThriceProviderDriver;
	readonly builtIn: boolean;
}

const BUILT_IN_PROVIDERS: readonly ThriceChatProvider[] = [
	{ id: 'claude', label: 'Claude', driver: 'claude', builtIn: true },
	{ id: 'codex', label: 'Codex', driver: 'codex', builtIn: true },
	{ id: 'claude-hub', label: 'Claude Hub', driver: 'claude', builtIn: true },
	{ id: 'codex-hub', label: 'Codex Hub', driver: 'codex', builtIn: true },
	{ id: 'grok-hub', label: 'Grok Hub', driver: 'opencode', builtIn: true },
];

const PROVIDER_DRIVERS = new Set<string>(THRICE_PROVIDER_DRIVERS.map(item => item.driver));

export function isHubProvider(provider: Pick<ThriceChatProvider, 'id'>): boolean {
	return provider.id.endsWith('-hub');
}

function isDriver(value: unknown): value is ThriceProviderDriver {
	return typeof value === 'string' && PROVIDER_DRIVERS.has(value);
}

/** Personal providers first, then the built-in hubs. */
export function listChatProviders(configurationService: IConfigurationService): ThriceChatProvider[] {
	const added: ThriceChatProvider[] = [];
	const configured = configurationService.getValue(THRICE_PROVIDERS_SETTING);
	if (Array.isArray(configured)) {
		for (const item of configured) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const record = item as { id?: unknown; driver?: unknown; displayName?: unknown; enabled?: unknown };
			if (record.enabled === false || typeof record.id !== 'string' || typeof record.displayName !== 'string' || !isDriver(record.driver)) {
				continue;
			}
			if (BUILT_IN_PROVIDERS.some(provider => provider.id === record.id)) {
				continue;
			}
			added.push({ id: record.id, label: record.displayName, driver: record.driver, builtIn: false });
		}
	}
	const personal = BUILT_IN_PROVIDERS.filter(provider => !isHubProvider(provider));
	const hubs = BUILT_IN_PROVIDERS.filter(isHubProvider);
	return [...personal, ...added, ...hubs];
}

/** The name and logo shown on a hub reply, such as Claude (Sonnet 5.5). */
export function chatReplyIdentity(provider: ThriceChatProvider, modelName: string): { label: string; icon: ThemeIcon } {
	const brand = provider.builtIn
		? provider.driver === 'claude' ? 'Claude' : provider.driver === 'codex' ? 'Codex' : 'Grok'
		: provider.label;
	const detail = modelName.startsWith(`${brand} `) ? modelName.slice(brand.length + 1) : modelName;
	return { label: `${brand} (${detail})`, icon: chatProviderIcon(provider) };
}

export function chatProviderIcon(provider: Pick<ThriceChatProvider, 'id' | 'driver' | 'label'>): ThemeIcon {
	const identity = `${provider.id} ${provider.label}`.toLowerCase();
	if (provider.id === 'grok-hub' || identity.includes('grok') || identity.includes('xai')) {
		return providerLogoIcon('grok');
	}
	return providerLogoIcon(PROVIDER_DRIVERS.has(provider.driver) ? provider.driver : 'acp');
}

/** The logo of the provider id a chat's model belongs to. An unknown id has none. */
export function chatSessionProviderIcon(vendor: string | undefined, providers: readonly ThriceChatProvider[]): ThemeIcon | undefined {
	if (!vendor) {
		return undefined;
	}
	const provider = providers.find(item => item.id === vendor);
	return provider ? chatProviderIcon(provider) : undefined;
}

export function getSelectedChatProviderId(storageService: IStorageService, configurationService: IConfigurationService): string {
	const providers = listChatProviders(configurationService);
	const stored = storageService.get(SELECTED_CHAT_PROVIDER_STORAGE_KEY, StorageScope.PROFILE);
	if (stored && providers.some(provider => provider.id === stored)) {
		return stored;
	}
	return providers[0]?.id ?? 'claude-hub';
}

export function storeSelectedChatProvider(storageService: IStorageService, id: string): void {
	storageService.store(SELECTED_CHAT_PROVIDER_STORAGE_KEY, id, StorageScope.PROFILE, StorageTarget.USER);
}

export const REMEMBERED_CHAT_PERMISSION_STORAGE_KEY = 'thrice.chat.permissionLevel';

export function getRememberedChatPermissionLevel(storageService: IStorageService): string | undefined {
	return storageService.get(REMEMBERED_CHAT_PERMISSION_STORAGE_KEY, StorageScope.PROFILE);
}

export function storeRememberedChatPermissionLevel(storageService: IStorageService, level: string): void {
	storageService.store(REMEMBERED_CHAT_PERMISSION_STORAGE_KEY, level, StorageScope.PROFILE, StorageTarget.USER);
}

function selectedModelKey(providerId: string): string {
	return `thrice.chat.selectedModel.${providerId}`;
}

export function getSelectedChatModel(storageService: IStorageService, providerId: string): string | undefined {
	return storageService.get(selectedModelKey(providerId), StorageScope.PROFILE);
}

export function storeSelectedChatModel(storageService: IStorageService, providerId: string, modelId: string): void {
	storageService.store(selectedModelKey(providerId), modelId, StorageScope.PROFILE, StorageTarget.USER);
}

export { permissionLevelForNewChat, sessionChatProviderId, shouldAdoptSharedChatProvider } from './thriceSessionSettings.js';
