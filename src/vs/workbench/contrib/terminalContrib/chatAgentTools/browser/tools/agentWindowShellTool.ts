/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { OS } from '../../../../../../base/common/platform.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { TerminalToolId } from '../../../../chat/common/tools/terminalToolIds.js';
import { ToolDataSource, type CountTokensCallback, type IToolData, type IToolImpl, type IToolInvocation, type IToolResult, type ToolProgress } from '../../../../chat/common/tools/languageModelToolsService.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { ITerminalProfileResolverService } from '../../../../terminal/common/terminal.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { getOutput, truncateLargeOutput } from '../outputHelpers.js';
import { AGENT_WINDOW_SHELL_OWNER_ID, AGENT_WINDOW_SHELL_TERMINAL_NAME, agentWindowShellCommandArgs, agentWindowShellMetadata, agentWindowShellSessionName, readAgentWindowShellParameters } from './agentWindowShell.js';

export const AgentWindowShellToolData: IToolData = {
	id: TerminalToolId.AgentWindowShell,
	toolReferenceName: 'agentWindowShell',
	displayName: localize('agentWindowShell.displayName', 'Agent Shell'),
	userDescription: localize('agentWindowShell.userDescription', 'Run a command in an integrated terminal'),
	modelDescription: [
		'Run one command and return its output. For an interactive or long-running program, use spawnTerminal instead, then readTerminal or waitTerminal.',
		'Never launch Terminal.app, `open`, or `osascript`.',
		'To leave a program running in the terminal panel, set `keep_open` to true. The terminal is shown and this call returns as soon as it is open.',
		'For a command whose output you need, omit `keep_open`. The call waits until the command exits and returns its output.',
		'Pass `command` as the command string and an optional absolute `working_directory`.',
		'When `working_directory` is omitted, the session folder is used.',
	].join(' '),
	icon: Codicon.terminal,
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	runsInWorkspace: true,
	inputSchema: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The command string passed to the user shell.',
			},
			working_directory: {
				type: 'string',
				description: 'Absolute working directory for the command.',
			},
			keep_open: {
				type: 'boolean',
				description: 'When true, show the terminal in the panel and leave the command running.',
			},
		},
		required: ['command'],
	},
};

/**
 * Runs one shell command as a child of an integrated terminal and returns the
 * visible output. Approval and sandbox policy are intentionally not applied.
 */
export class AgentWindowShellTool extends Disposable implements IToolImpl {
	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalProfileResolverService private readonly _terminalProfileResolverService: ITerminalProfileResolverService,
	) {
		super();
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const parsed = readAgentWindowShellParameters(invocation.parameters);
		if (!parsed) {
			return textResult('The command must be a non-empty string.', true);
		}

		const cwd = parsed.workingDirectory
			? URI.file(parsed.workingDirectory)
			: invocation.context?.workingDirectory;
		const shell = await this._terminalProfileResolverService.getDefaultShell({ remoteAuthority: undefined, os: OS });
		const profileArgs = await this._terminalProfileResolverService.getDefaultShellArgs({ remoteAuthority: undefined, os: OS });
		const args = agentWindowShellCommandArgs(shell, profileArgs, parsed.command);
		const conversationId = invocation.context?.sessionResource.toString();
		const sessionName = agentWindowShellSessionName(parsed.command);

		const instance = await this._terminalService.createTerminal({
			cwd,
			location: parsed.keepOpen ? TerminalLocation.Panel : undefined,
			config: {
				name: parsed.keepOpen ? sessionName : AGENT_WINDOW_SHELL_TERMINAL_NAME,
				executable: shell,
				args,
				cwd,
				hideFromUser: !parsed.keepOpen,
				isFeatureTerminal: !parsed.keepOpen,
				icon: Codicon.terminal,
				reconnectionProperties: {
					ownerId: AGENT_WINDOW_SHELL_OWNER_ID,
					data: agentWindowShellMetadata(conversationId),
				},
			},
		});

		if (parsed.keepOpen) {
			if (token.isCancellationRequested) {
				instance.dispose();
				return textResult('The command was cancelled.', true);
			}
			this._terminalService.setActiveInstance(instance);
			await this._terminalService.focusInstance(instance);
			return textResult(`Opened an integrated terminal "${sessionName}" running \`${parsed.command}\`. It stays open in the terminal panel.`, false);
		}

		const captured = await captureTerminal(instance, token);
		const output = truncateLargeOutput(captured.output);
		if (!instance.isDisposed) {
			instance.dispose();
		}
		if (token.isCancellationRequested) {
			return textResult('The command was cancelled.', true);
		}
		const exitLine = captured.exitCode === undefined ? 'The command ended without an exit code.' : `Exit code: ${captured.exitCode}`;
		return {
			content: [{ kind: 'text', value: `${exitLine}\n${output}`.trimEnd() }],
			toolResultError: captured.exitCode !== undefined && captured.exitCode !== 0 ? exitLine : undefined,
		};
	}
}

function textResult(value: string, isError: boolean): IToolResult {
	return {
		content: [{ kind: 'text', value }],
		toolResultError: isError ? value : undefined,
	};
}

function captureTerminal(instance: ITerminalInstance, token: CancellationToken): Promise<{ readonly exitCode: number | undefined; readonly output: string }> {
	const chunks: string[] = [];
	const store = new DisposableStore();
	store.add(instance.onData(data => chunks.push(data)));
	const finish = async (exitCode: number | undefined) => {
		store.dispose();
		await instance.xtermReadyPromise;
		const initial = instance.initialDataEvents?.join('') ?? '';
		const buffer = getOutput(instance);
		const streamed = chunks.join('');
		const output = initial.length > 0 ? initial : (buffer.length > 0 ? buffer : streamed);
		return { exitCode, output };
	};
	if (instance.exitReason !== undefined) {
		return finish(instance.exitCode);
	}
	return new Promise(resolve => {
		store.add(instance.onExit(code => { void finish(typeof code === 'number' ? code : undefined).then(resolve); }));
		store.add(token.onCancellationRequested(() => {
			instance.dispose();
			void finish(undefined).then(resolve);
		}));
	});
}
