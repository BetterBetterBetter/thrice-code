/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { subagentEditorResource } from '../../../../browser/widgetHosts/viewPane/chatSubagentChats.js';
import { listSubagentChats } from '../../../../browser/widgetHosts/viewPane/chatSessionTabs.js';
import { IRunningSubagentEntry, isActiveSubagentStatus, mergeSubagentEntries, subagentChildIcon, subagentChildLabel, subagentParentIcon, subagentSessionProvider, subagentStatus, subagentStatusClass } from '../../../../browser/widget/input/runningSubagentsEntries.js';
import { ChatSessionStatus } from '../../../../common/chatSessionsService.js';
import { providerIdDisplayName, providerIdLogoDriver, providerIdLogoIcon } from '../../../../common/thriceProviderLogos.js';

suite('RunningSubagentsEntries', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const claudeParent = { icon: Codicon.claude, providerType: 'agent-host-claude' };

	suite('provider ids', () => {
		test('map agent-host providers, session types and Thrice instances to a logo', () => {
			assert.deepStrictEqual([
				providerIdLogoDriver('codex'),
				providerIdLogoDriver('agent-host-claude'),
				providerIdLogoDriver('claude-hub'),
				providerIdLogoDriver('grok-hub'),
				providerIdLogoDriver('openai'),
				providerIdLogoDriver('thrice-logo-cursor'),
			], ['codex', 'claude', 'claude', 'grok', 'codex', 'cursor']);
		});

		test('a short driver name matches only a whole word', () => {
			assert.strictEqual(providerIdLogoDriver('copilotcli'), undefined);
			assert.strictEqual(providerIdLogoDriver('pi'), 'pi');
			assert.strictEqual(providerIdLogoDriver(undefined), undefined);
			assert.strictEqual(providerIdLogoIcon('copilotcli'), undefined);
		});

		test('display names come from the driver list', () => {
			assert.strictEqual(providerIdDisplayName('codex'), 'Codex');
			assert.strictEqual(providerIdDisplayName('unknown-agent'), undefined);
		});
	});

	suite('icons', () => {
		test('a child uses its own provider logo', () => {
			const parentIcon = subagentParentIcon(claudeParent);
			assert.strictEqual(parentIcon.id, 'thrice-logo-claude');
			assert.strictEqual(subagentChildIcon('codex', parentIcon).id, 'thrice-logo-codex');
			assert.strictEqual(subagentChildIcon('claude', parentIcon).id, 'thrice-logo-claude');
		});

		test('a child with no known provider falls back to the parent logo', () => {
			const parentIcon = subagentParentIcon(claudeParent);
			assert.strictEqual(subagentChildIcon(undefined, parentIcon), parentIcon);
			assert.strictEqual(subagentChildIcon('copilotcli', parentIcon), parentIcon);
		});

		test('a parent with a Thrice logo keeps it; an unknown parent keeps its own icon', () => {
			const logo = ThemeIcon.fromId('thrice-logo-grok');
			assert.strictEqual(subagentParentIcon({ icon: logo, providerType: 'agent-host-opencode' }), logo);
			assert.strictEqual(subagentParentIcon({ icon: Codicon.copilot, providerType: 'agent-host-copilotcli' }), Codicon.copilot);
		});
	});

	suite('labels', () => {
		test('a child on another provider is prefixed with that provider', () => {
			assert.strictEqual(subagentChildLabel('Fix the tests', 'codex', subagentSessionProvider(claudeParent)), 'Codex · Fix the tests');
		});

		test('a child on the parent provider keeps the bare description', () => {
			assert.strictEqual(subagentChildLabel('Read the readme', 'claude', subagentSessionProvider(claudeParent)), 'Read the readme');
			assert.strictEqual(subagentChildLabel('Read the readme', undefined, subagentSessionProvider(claudeParent)), 'Read the readme');
		});
	});

	suite('status', () => {
		test('waiting on the user is its own state and wins over working', () => {
			assert.strictEqual(subagentStatus({ running: true, inputNeeded: true }), 'inputNeeded');
			assert.strictEqual(subagentStatus({ running: false, childStatus: ChatSessionStatus.NeedsInput }), 'inputNeeded');
			assert.strictEqual(subagentStatusClass('inputNeeded'), 'chat-session-input-needed');
			assert.ok(isActiveSubagentStatus('inputNeeded'));
		});

		test('a background child is still working after its tool call completed', () => {
			const [listed] = listSubagentChats([
				{ toolCallId: 'spawn', complete: true, toolSpecificData: { kind: 'subagent', description: 'Port the parser', chatResource: 'agent-host-chat://codex/1', isActive: true, chatProvider: 'codex' } },
			]);
			assert.deepStrictEqual({ running: listed.running, provider: listed.provider, inputNeeded: listed.inputNeeded }, { running: true, provider: 'codex', inputNeeded: false });
			assert.strictEqual(subagentStatus({ running: listed.running }), 'working');
			assert.strictEqual(subagentStatus({ running: false, childBusy: true }), 'working');
			assert.strictEqual(subagentStatus({ running: false, childStatus: ChatSessionStatus.InProgress }), 'working');
		});

		test('a child is finished only when neither its tool call nor its chat is active', () => {
			assert.strictEqual(subagentStatus({ running: false, childBusy: false, childStatus: ChatSessionStatus.Completed }), 'finished');
			assert.ok(!isActiveSubagentStatus('finished'));
		});

		test('a tool part reports a child waiting on the user', () => {
			const [listed] = listSubagentChats([
				{ toolCallId: 'spawn', complete: true, toolSpecificData: { kind: 'subagent', description: 'Deploy', chatResource: 'chat://deploy', isActive: true, isInputNeeded: true } },
			]);
			assert.strictEqual(subagentStatus({ running: listed.running, inputNeeded: listed.inputNeeded }), 'inputNeeded');
		});
	});

	suite('dedupe', () => {
		const parent = URI.parse('agent-host-claude://local/session-1');
		const chatResource = 'agent-host-chat://local/child-1';
		const toolTarget = subagentEditorResource(parent, chatResource)!;
		const sessionTarget = parent.with({ fragment: toolTarget.fragment });
		const icon = ThemeIcon.fromId('thrice-logo-codex');

		test('a child found from both the tool call and the session children is one entry', () => {
			const fromTools: IRunningSubagentEntry[] = [{ label: 'Codex · Port the parser', icon, status: 'finished', target: toolTarget }];
			const fromSessions: IRunningSubagentEntry[] = [{ label: 'Port the parser', icon: Codicon.claude, status: 'working', target: sessionTarget }];
			const merged = mergeSubagentEntries(fromTools, fromSessions);
			assert.strictEqual(merged.length, 1);
			assert.deepStrictEqual({ label: merged[0].label, icon: merged[0].icon.id, status: merged[0].status }, { label: 'Codex · Port the parser', icon: 'thrice-logo-codex', status: 'working' });
		});

		test('the more urgent state wins and distinct children stay separate', () => {
			const other = parent.with({ fragment: 'other' });
			const merged = mergeSubagentEntries(
				[{ label: 'A', icon, status: 'working', target: toolTarget }, { label: 'No target', icon, status: 'working' }],
				[{ label: 'A', icon, status: 'inputNeeded', target: sessionTarget }, { label: 'B', icon, status: 'working', target: other }],
			);
			assert.deepStrictEqual(merged.map(entry => [entry.label, entry.status]), [['A', 'inputNeeded'], ['No target', 'working'], ['B', 'working']]);
		});
	});
});
