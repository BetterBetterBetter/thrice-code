/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { THRICE_PROVIDER_DRIVERS, type ThriceProviderDriver } from './thriceProviderDraft.js';

const LOGO_DRIVERS = new Set<string>(THRICE_PROVIDER_DRIVERS.map(item => item.driver));

/** White provider mark. The shapes live in thriceAddProvider.css as masks. */
export function providerLogoIcon(driver: string): ThemeIcon {
	return ThemeIcon.fromId(`thrice-logo-${LOGO_DRIVERS.has(driver) ? driver : 'acp'}`);
}

/** Other names a provider id can carry for a logo driver. */
const PROVIDER_ID_ALIASES: Readonly<Record<string, ThriceProviderDriver>> = {
	anthropic: 'claude',
	openai: 'codex',
	xai: 'grok',
	agy: 'antigravity',
};

/**
 * The logo driver a provider id belongs to: an agent-host provider (`claude`,
 * `codex`), a session type (`agent-host-claude`) or a Thrice instance
 * (`claude-hub`). Short driver names, such as `pi`, match only a whole word of
 * the id. Undefined when the id names no known logo.
 */
export function providerIdLogoDriver(providerId: string | undefined): ThriceProviderDriver | undefined {
	const id = providerId?.trim().toLowerCase();
	if (!id) {
		return undefined;
	}
	const words = id.split(/[^a-z0-9]+/).filter(word => word.length > 0);
	// The Grok hub runs on the OpenCode driver but shows the Grok mark.
	if (words.includes('grok') || words.includes('xai')) {
		return 'grok';
	}
	for (const word of words) {
		const alias = PROVIDER_ID_ALIASES[word];
		if (alias) {
			return alias;
		}
		if (word !== 'acp' && LOGO_DRIVERS.has(word)) {
			return word as ThriceProviderDriver;
		}
	}
	for (const { driver } of THRICE_PROVIDER_DRIVERS) {
		if (driver.length >= 4 && id.includes(driver)) {
			return driver;
		}
	}
	return undefined;
}

/** The logo for a provider id, or undefined so a caller can keep its own fallback. */
export function providerIdLogoIcon(providerId: string | undefined): ThemeIcon | undefined {
	const driver = providerIdLogoDriver(providerId);
	return driver ? providerLogoIcon(driver) : undefined;
}

/** The brand name for a provider id, such as Codex for `codex`. Undefined when the id names no known provider. */
export function providerIdDisplayName(providerId: string | undefined): string | undefined {
	const driver = providerIdLogoDriver(providerId);
	return driver ? THRICE_PROVIDER_DRIVERS.find(item => item.driver === driver)?.label : undefined;
}
