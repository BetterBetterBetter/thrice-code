/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Reconnection owner for terminals this tool creates. */
export const AGENT_WINDOW_SHELL_OWNER_ID = 'thrice.agentWindowShell';

/** Title used for a one-shot command. The terminal is hidden from the terminal list. */
export const AGENT_WINDOW_SHELL_TERMINAL_NAME = 'Agent Terminal';

export interface IAgentWindowShellMetadata {
	readonly agentOwned: true;
	readonly conversationId: string | undefined;
}

export function agentWindowShellMetadata(conversationId: string | undefined): IAgentWindowShellMetadata {
	return { agentOwned: true, conversationId };
}

/**
 * Arguments passed to the user's shell. Unix shells and PowerShell take `-c`.
 * `cmd.exe` takes `/c`.
 */
export function agentWindowShellCommandArgs(shellPath: string, profileArgs: readonly string[] | string | undefined, command: string): string[] {
	const base = (typeof profileArgs === 'string' ? [profileArgs] : (profileArgs ?? [])).filter(arg => arg.length > 0);
	const fileName = shellPath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
	const flag = fileName === 'cmd.exe' || fileName === 'cmd' ? '/c' : '-c';
	return [...base, flag, command];
}

/** Tab title for a terminal that stays open in the panel. */
export function agentWindowShellSessionName(command: string): string {
	const first = command.trim().split(/\s+/)[0] ?? '';
	const base = first.split(/[/\\]/).pop() || AGENT_WINDOW_SHELL_TERMINAL_NAME;
	return base.length > 40 ? base.slice(0, 40) : base;
}

export function readAgentWindowShellParameters(parameters: Record<string, unknown> | undefined): { readonly command: string; readonly workingDirectory: string | undefined; readonly keepOpen: boolean } | undefined {
	const command = parameters?.command;
	if (typeof command !== 'string' || command.trim().length === 0) {
		return undefined;
	}
	const workingDirectory = parameters?.working_directory;
	return {
		command,
		workingDirectory: typeof workingDirectory === 'string' && workingDirectory.length > 0 ? workingDirectory : undefined,
		keepOpen: parameters?.keep_open === true,
	};
}
