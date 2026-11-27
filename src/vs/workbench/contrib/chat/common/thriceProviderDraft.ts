/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ThriceProviderDriver = 'codex' | 'claude' | 'cursor' | 'grok' | 'opencode' | 'antigravity' | 'muse' | 'pi' | 'fx' | 'kiro' | 'acp';

export type ThriceProviderGroup = 'featured' | 'more' | 'manual';

interface ThriceProviderEnvironmentVariable {
	readonly name: string;
	readonly value: string;
}

export interface ThriceProviderDraft {
	readonly driver: ThriceProviderDriver;
	readonly displayName: string;
	readonly instanceId: string;
	readonly command: string;
	readonly homePath: string;
	readonly launchArgs: readonly string[];
	readonly credentials: readonly ThriceProviderEnvironmentVariable[];
	readonly environment: readonly ThriceProviderEnvironmentVariable[];
}

/**
 * One `thrice.providers.instances` entry. `id` is the draft's instance id.
 * Command, launch args, and environment are omitted when nothing usable remains.
 */
export interface ThriceProviderSettingEntry {
	readonly id: string;
	readonly driver: ThriceProviderDriver;
	readonly displayName: string;
	readonly enabled: true;
	readonly command?: string;
	readonly launchArgs?: readonly string[];
	readonly environment?: readonly ThriceProviderEnvironmentVariable[];
}

/** Featured first, then Show more, then the manual ACP command. Same set T3 offers. */
export const THRICE_PROVIDER_DRIVERS: readonly { driver: ThriceProviderDriver; label: string; defaultCommand: string; group: ThriceProviderGroup }[] = [
	{ driver: 'codex', label: 'Codex', defaultCommand: 'codex', group: 'featured' },
	{ driver: 'claude', label: 'Claude', defaultCommand: 'claude', group: 'featured' },
	{ driver: 'cursor', label: 'Cursor', defaultCommand: 'agent', group: 'featured' },
	{ driver: 'grok', label: 'Grok', defaultCommand: 'grok', group: 'featured' },
	{ driver: 'opencode', label: 'OpenCode', defaultCommand: 'opencode', group: 'featured' },
	{ driver: 'antigravity', label: 'Antigravity', defaultCommand: 'agy', group: 'featured' },
	{ driver: 'muse', label: 'Muse Code', defaultCommand: 'muse', group: 'featured' },
	{ driver: 'pi', label: 'Pi', defaultCommand: 'pi', group: 'featured' },
	{ driver: 'fx', label: 'fx', defaultCommand: 'fx', group: 'more' },
	{ driver: 'kiro', label: 'Kiro', defaultCommand: 'kiro-cli', group: 'more' },
	{ driver: 'acp', label: 'Add manually', defaultCommand: '', group: 'manual' },
];

export interface ThriceProviderTextField {
	readonly key: 'command' | 'homePath';
	readonly label: string;
	readonly description: string;
	readonly placeholder: string;
}

export interface ThriceProviderCredentialField {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly secret: boolean;
}

/** Binary path, plus a home directory for the CLIs that read one. Cursor's settings are all hidden. */
export function providerTextFields(driver: ThriceProviderDriver): readonly ThriceProviderTextField[] {
	if (driver === 'cursor') {
		return [];
	}
	const command = providerCommandField(driver);
	if (driver === 'claude') {
		return [
			command,
			{ key: 'homePath', label: 'CLAUDE_CONFIG_DIR path', description: 'Custom Claude home and config directory. Keeps .claude.json and .claude separate.', placeholder: '~/.claude' },
		];
	}
	if (driver === 'codex') {
		return [
			command,
			{ key: 'homePath', label: 'CODEX_HOME path', description: 'Custom Codex home and config directory.', placeholder: '~/.codex' },
		];
	}
	return [command];
}

function providerCommandField(driver: ThriceProviderDriver): ThriceProviderTextField {
	const option = THRICE_PROVIDER_DRIVERS.find(item => item.driver === driver);
	const label = option?.label ?? driver;
	if (driver === 'acp') {
		return { key: 'command', label: 'Binary path', description: 'Path to an ACP executable installed on this machine.', placeholder: '/path/to/agent' };
	}
	return { key: 'command', label: 'Binary path', description: `Path to the ${label} binary used by this instance.`, placeholder: option?.defaultCommand || label.toLowerCase() };
}

/**
 * The add wizard does not collect gateway keys. T3 keeps those on the instance
 * after it exists. A blank value is still left out if a caller supplies one.
 */
export function providerCredentialFields(_driver: ThriceProviderDriver): readonly ThriceProviderCredentialField[] {
	return [];
}

/** Launch arguments are a config field only for the drivers whose T3 form includes them. */
export function providerShowsLaunchArguments(driver: ThriceProviderDriver): boolean {
	return driver === 'claude' || driver === 'codex' || driver === 'pi' || driver === 'acp';
}

export function homeEnvironmentName(driver: ThriceProviderDriver): string | undefined {
	if (driver === 'claude') {
		return 'CLAUDE_CONFIG_DIR';
	}
	if (driver === 'codex') {
		return 'CODEX_HOME';
	}
	return undefined;
}

export function launchArgumentsDescription(driver: ThriceProviderDriver): string {
	const label = THRICE_PROVIDER_DRIVERS.find(item => item.driver === driver)?.label ?? 'the CLI';
	return `Additional CLI arguments passed to ${label} on session start. One argument per row, in launch order.`;
}

const RESERVED_INSTANCE_IDS: ReadonlySet<string> = new Set(['claude', 'codex', 'claude-hub', 'codex-hub', 'grok-hub']);
const VALID_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DERIVED_ID_LENGTH = 48;

function slugifyDisplayName(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_DERIVED_ID_LENGTH);
	return slug || 'provider';
}

function isUnavailable(id: string, taken: readonly string[]): boolean {
	return RESERVED_INSTANCE_IDS.has(id) || taken.includes(id);
}

/** Lowercase slug of the display name, with -2, -3, … while the id is taken or reserved. */
export function deriveInstanceId(displayName: string, taken: readonly string[]): string {
	const base = slugifyDisplayName(displayName);
	if (!isUnavailable(base, taken)) {
		return base;
	}
	let suffix = 2;
	let candidate = `${base}-${suffix}`;
	while (isUnavailable(candidate, taken)) {
		suffix += 1;
		candidate = `${base}-${suffix}`;
	}
	return candidate;
}

function completeEnvironment(environment: readonly ThriceProviderEnvironmentVariable[]): ThriceProviderEnvironmentVariable[] {
	const entries = new Map<string, string>();
	for (const entry of environment) {
		const name = entry.name.trim();
		const value = entry.value.trim();
		if (name !== '' && value !== '') {
			entries.set(name, value);
		}
	}
	return [...entries].map(([name, value]) => ({ name, value }));
}

function configuredEnvironment(draft: ThriceProviderDraft): ThriceProviderEnvironmentVariable[] {
	const homeName = homeEnvironmentName(draft.driver);
	const home = draft.homePath.trim();
	return completeEnvironment([
		...(homeName && home !== '' ? [{ name: homeName, value: home }] : []),
		...draft.credentials,
		...draft.environment,
	]);
}

/** Blank launch args and environment rows are ignored. A value still needs a unique name. */
export function validateProviderDraft(draft: ThriceProviderDraft, taken: readonly string[]): { ok: true } | { ok: false; message: string } {
	if (draft.displayName.trim() === '') {
		return { ok: false, message: 'Enter a display name.' };
	}
	if (draft.driver === 'acp' && draft.command.trim() === '') {
		return { ok: false, message: 'Enter a binary path.' };
	}
	const instanceId = draft.instanceId.trim();
	if (!VALID_INSTANCE_ID.test(instanceId)) {
		return { ok: false, message: 'Enter a valid instance id.' };
	}
	if (RESERVED_INSTANCE_IDS.has(instanceId)) {
		return { ok: false, message: 'That instance id is reserved.' };
	}
	if (taken.includes(instanceId)) {
		return { ok: false, message: 'That instance id is already in use.' };
	}
	const names = new Set<string>();
	const homeName = homeEnvironmentName(draft.driver);
	if (homeName && draft.homePath.trim() !== '') {
		names.add(homeName);
	}
	for (const entry of draft.credentials) {
		const name = entry.name.trim();
		const value = entry.value.trim();
		if (value === '') {
			continue;
		}
		if (names.has(name)) {
			return { ok: false, message: 'Environment variable names must be unique.' };
		}
		names.add(name);
	}
	for (const entry of draft.environment) {
		const name = entry.name.trim();
		const value = entry.value.trim();
		if (value === '') {
			continue;
		}
		if (name === '') {
			return { ok: false, message: 'Enter a name for each environment variable.' };
		}
		if (names.has(name)) {
			return { ok: false, message: 'Environment variable names must be unique.' };
		}
		names.add(name);
	}
	return { ok: true };
}

/** Trimmed settings entry. Blank command, launch args, and incomplete environment pairs are left out. */
export function toProviderSettingEntry(draft: ThriceProviderDraft): ThriceProviderSettingEntry {
	const command = draft.command.trim();
	const launchArgs = draft.launchArgs.map(arg => arg.trim()).filter(arg => arg !== '');
	const environment = configuredEnvironment(draft);
	return {
		id: draft.instanceId.trim(),
		driver: draft.driver,
		displayName: draft.displayName.trim(),
		enabled: true,
		...(command !== '' ? { command } : {}),
		...(launchArgs.length > 0 ? { launchArgs } : {}),
		...(environment.length > 0 ? { environment } : {}),
	};
}
