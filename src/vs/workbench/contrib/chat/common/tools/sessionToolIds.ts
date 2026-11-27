/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Tool ids for the window session. The model-facing names live on each tool. */
export const enum SessionToolId {
	SessionContext = 'session_context',
	ListEditors = 'list_editors',
	ReadEditor = 'read_editor',
	OpenEditor = 'open_editor',
	WriteEditor = 'write_editor',
	ListTerminals = 'list_terminals',
	ReadTerminal = 'read_terminal',
	SpawnTerminal = 'spawn_terminal',
	WriteTerminal = 'write_terminal',
	CloseTerminal = 'close_terminal',
	WaitTerminal = 'wait_terminal',
	ListPorts = 'list_ports',
	ForwardPort = 'forward_port',
	ClosePort = 'close_port',
	ListProblems = 'list_problems',
	AddFolder = 'add_folder',
	RemoveFolder = 'remove_folder',
}
