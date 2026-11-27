/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';
import { providerIdDisplayName, providerIdLogoDriver, providerIdLogoIcon } from '../../../common/thriceProviderLogos.js';

/** The dot on a sub-agent: still working, waiting on the user, or done. */
export type RunningSubagentStatus = 'working' | 'inputNeeded' | 'finished';

/** One sub-agent on the row above the text field. */
export interface IRunningSubagentEntry {
	readonly label: string;
	readonly status: RunningSubagentStatus;
	readonly icon: ThemeIcon;
	readonly target?: URI;
}

/** The parts of an agent session the row reads for a provider. */
export interface ISubagentProviderSource {
	readonly icon: ThemeIcon;
	readonly providerType: string;
}

const THRICE_LOGO_PREFIX = 'thrice-logo-';

/**
 * The provider of a session for comparing with a child's. A Thrice logo names
 * the provider more precisely than the session type it runs under.
 */
export function subagentSessionProvider(session: ISubagentProviderSource): string {
	return session.icon.id.startsWith(THRICE_LOGO_PREFIX) ? session.icon.id : session.providerType;
}

/** The logo for a parent session; children whose provider is unknown use it too. */
export function subagentParentIcon(session: ISubagentProviderSource): ThemeIcon {
	if (session.icon.id.startsWith(THRICE_LOGO_PREFIX)) {
		return session.icon;
	}
	return providerIdLogoIcon(session.providerType) ?? session.icon;
}

/** A child's logo comes from its own provider, such as Codex under a Claude parent. */
export function subagentChildIcon(childProvider: string | undefined, parentIcon: ThemeIcon): ThemeIcon {
	return providerIdLogoIcon(childProvider) ?? parentIcon;
}

function sameProvider(a: string, b: string | undefined): boolean {
	if (b === undefined) {
		return false;
	}
	return (providerIdLogoDriver(a) ?? a.toLowerCase()) === (providerIdLogoDriver(b) ?? b.toLowerCase());
}

/** `Codex · Fix the tests` for a child on another provider; the bare description otherwise. */
export function subagentChildLabel(description: string, childProvider: string | undefined, parentProvider: string | undefined): string {
	if (!childProvider || sameProvider(childProvider, parentProvider)) {
		return description;
	}
	const name = providerIdDisplayName(childProvider) ?? childProvider;
	return localize('chatRunningSubagentProviderLabel', "{0} · {1}", name, description);
}

/**
 * The child's state. Waiting on the user wins over working. A background child
 * whose spawning tool call already finished is still working while its own
 * chat is busy.
 */
export function subagentStatus(opts: { readonly running: boolean; readonly inputNeeded?: boolean; readonly childBusy?: boolean; readonly childStatus?: ChatSessionStatus }): RunningSubagentStatus {
	if (opts.inputNeeded || opts.childStatus === ChatSessionStatus.NeedsInput) {
		return 'inputNeeded';
	}
	if (opts.running || opts.childBusy || opts.childStatus === ChatSessionStatus.InProgress) {
		return 'working';
	}
	return 'finished';
}

/** A finished peer chat is not a running sub-agent, so it stays off the row. */
export function isActiveSubagentStatus(status: RunningSubagentStatus): boolean {
	return status !== 'finished';
}

/**
 * The same child chat opened as the parent's editor with a selected-chat query,
 * or listed as a session child without one, has one key.
 */
export function subagentEntryKey(target: URI): string {
	return target.with({ query: '' }).toString();
}

const STATUS_RANK: Record<RunningSubagentStatus, number> = { finished: 0, working: 1, inputNeeded: 2 };

/**
 * Sub-agents from the reply's tool calls, then session children not already
 * listed. A child found both ways is one entry, with the more urgent state.
 */
export function mergeSubagentEntries(fromTools: readonly IRunningSubagentEntry[], fromSessions: readonly IRunningSubagentEntry[]): IRunningSubagentEntry[] {
	const merged: IRunningSubagentEntry[] = [];
	const byKey = new Map<string, number>();
	for (const entry of [...fromTools, ...fromSessions]) {
		const key = entry.target ? subagentEntryKey(entry.target) : undefined;
		const index = key !== undefined ? byKey.get(key) : undefined;
		if (index === undefined) {
			if (key !== undefined) {
				byKey.set(key, merged.length);
			}
			merged.push(entry);
			continue;
		}
		const existing = merged[index];
		if (STATUS_RANK[entry.status] > STATUS_RANK[existing.status]) {
			merged[index] = { ...existing, status: entry.status };
		}
	}
	return merged;
}

/** The tooltip and screen reader text for a state. */
export function subagentStatusLabel(status: RunningSubagentStatus): string {
	switch (status) {
		case 'working': return localize('chatRunningSubagent', "Working");
		case 'inputNeeded': return localize('chatInputNeededSubagent', "Waiting for your input");
		case 'finished': return localize('chatFinishedSubagent', "Finished");
	}
}

/** The CSS class of the status dot. */
export function subagentStatusClass(status: RunningSubagentStatus): string {
	switch (status) {
		case 'working': return 'chat-session-working';
		case 'inputNeeded': return 'chat-session-input-needed';
		case 'finished': return 'chat-session-finished';
	}
}
