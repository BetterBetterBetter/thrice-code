/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../../../../base/common/themables.js';
import { SessionToolId } from '../../../../chat/common/tools/sessionToolIds.js';
import { ToolDataSource, type CountTokensCallback, type IToolData, type IToolImpl, type IToolInvocation, type IToolResult, type ToolProgress } from '../../../../chat/common/tools/languageModelToolsService.js';
import { SessionAccess } from './sessionAccess.js';

interface IToolSpec {
	readonly id: SessionToolId;
	readonly name: string;
	readonly display: string;
	readonly description: string;
	readonly icon: ThemeIcon;
	readonly properties: Record<string, { type: string; description: string }>;
	readonly required?: readonly string[];
}

const specs: readonly IToolSpec[] = [
	{
		id: SessionToolId.SessionContext,
		name: 'sessionContext',
		display: 'Window',
		description: 'Read this window: local or remote, saved or unsaved workspace, folders, the active editor and selection, open and unsaved editors, integrated terminals (the focused one is marked), ports, and problems.',
		icon: Codicon.window,
		properties: {},
	},
	{
		id: SessionToolId.ListEditors,
		name: 'listEditors',
		display: 'List Editors',
		description: 'List editors open in this window, including dirty and untitled ones.',
		icon: Codicon.file,
		properties: {},
	},
	{
		id: SessionToolId.ReadEditor,
		name: 'readEditor',
		display: 'Read Editor',
		description: 'Read an open editor, including a dirty or untitled buffer. Pass path from listEditors or sessionContext.',
		icon: Codicon.file,
		properties: { path: { type: 'string', description: 'Editor path or untitled URI from listEditors.' } },
		required: ['path'],
	},
	{
		id: SessionToolId.OpenEditor,
		name: 'openEditor',
		display: 'Open Editor',
		description: 'Open a file or untitled editor as a visible tab in this window.',
		icon: Codicon.file,
		properties: { path: { type: 'string', description: 'File path or untitled URI.' } },
		required: ['path'],
	},
	{
		id: SessionToolId.WriteEditor,
		name: 'writeEditor',
		display: 'Write Editor',
		description: 'Change an open editor, including a dirty or untitled buffer. The change stays unsaved in the editor. Pass content to replace the document, or old and new for one replacement.',
		icon: Codicon.file,
		properties: {
			path: { type: 'string', description: 'Editor path or untitled URI.' },
			content: { type: 'string', description: 'Full replacement text.' },
			old: { type: 'string', description: 'Text to find for one replacement.' },
			new: { type: 'string', description: 'Replacement text.' },
		},
		required: ['path'],
	},
	{
		id: SessionToolId.ListTerminals,
		name: 'listTerminals',
		display: 'List Terminals',
		description: 'List integrated terminals in this window, including ones opened before this chat. The focused terminal is marked. Each entry has an id and a short tail.',
		icon: Codicon.terminal,
		properties: {},
	},
	{
		id: SessionToolId.ReadTerminal,
		name: 'readTerminal',
		display: 'Read Terminal',
		description: 'Read the buffer of an integrated terminal by id.',
		icon: Codicon.terminal,
		properties: {
			id: { type: 'number', description: 'Terminal id from listTerminals.' },
			lines: { type: 'number', description: 'How many trailing lines to return. Defaults to 200.' },
		},
		required: ['id'],
	},
	{
		id: SessionToolId.SpawnTerminal,
		name: 'spawnTerminal',
		display: 'Spawn Terminal',
		description: 'Open the terminal panel in this window, start a real integrated terminal, and return its id immediately. Use this for a terminal, shell, or interactive program such as claude. Pass command to type it and run it. Then call readTerminal or waitTerminal. Do not use Bash, Terminal.app, or iTerm for this.',
		icon: Codicon.terminal,
		properties: {
			command: { type: 'string', description: 'Command to type into the terminal. Omit to open a shell.' },
			working_directory: { type: 'string', description: 'Absolute working directory. Omit to use the window default.' },
		},
	},
	{
		id: SessionToolId.WriteTerminal,
		name: 'writeTerminal',
		display: 'Write Terminal',
		description: 'Type into an integrated terminal by id. text is sent, then Enter, unless submit is false.',
		icon: Codicon.terminal,
		properties: {
			id: { type: 'number', description: 'Terminal id.' },
			text: { type: 'string', description: 'Text to send. An empty string sends Enter.' },
			submit: { type: 'boolean', description: 'False inserts the text without Enter.' },
		},
		required: ['id', 'text'],
	},
	{
		id: SessionToolId.CloseTerminal,
		name: 'closeTerminal',
		display: 'Close Terminal',
		description: 'Close an integrated terminal by id.',
		icon: Codicon.terminal,
		properties: { id: { type: 'number', description: 'Terminal id.' } },
		required: ['id'],
	},
	{
		id: SessionToolId.WaitTerminal,
		name: 'waitTerminal',
		display: 'Wait Terminal',
		description: 'Wait until an integrated terminal prints new output, or until timeout_ms (default 15000, max 60000). Call again to keep monitoring a session.',
		icon: Codicon.terminal,
		properties: {
			id: { type: 'number', description: 'Terminal id.' },
			timeout_ms: { type: 'number', description: 'How long to wait for new output, in milliseconds.' },
		},
		required: ['id'],
	},
	{
		id: SessionToolId.ListPorts,
		name: 'listPorts',
		display: 'List Ports',
		description: 'List ports this window has forwarded, detected, or seen listening.',
		icon: Codicon.plug,
		properties: {},
	},
	{
		id: SessionToolId.ForwardPort,
		name: 'forwardPort',
		display: 'Forward Port',
		description: 'Forward a port in this window.',
		icon: Codicon.plug,
		properties: {
			port: { type: 'number', description: 'Remote port to forward.' },
			host: { type: 'string', description: 'Remote host. Defaults to localhost.' },
			local_port: { type: 'number', description: 'Local port. Omit to let the window choose.' },
		},
		required: ['port'],
	},
	{
		id: SessionToolId.ClosePort,
		name: 'closePort',
		display: 'Close Port',
		description: 'Close a forwarded port in this window.',
		icon: Codicon.plug,
		properties: {
			port: { type: 'number', description: 'Forwarded port.' },
			host: { type: 'string', description: 'Remote host. Defaults to localhost.' },
		},
		required: ['port'],
	},
	{
		id: SessionToolId.ListProblems,
		name: 'listProblems',
		display: 'Problems',
		description: 'Errors and warnings from this window\'s Problems panel.',
		icon: Codicon.warning,
		properties: {},
	},
	{
		id: SessionToolId.AddFolder,
		name: 'addFolder',
		display: 'Add Folder',
		description: 'Add a folder to this window\'s workspace, including an unsaved workspace.',
		icon: Codicon.folder,
		properties: { path: { type: 'string', description: 'Absolute folder path.' } },
		required: ['path'],
	},
	{
		id: SessionToolId.RemoveFolder,
		name: 'removeFolder',
		display: 'Remove Folder',
		description: 'Remove a folder from this window\'s workspace.',
		icon: Codicon.folder,
		properties: { path: { type: 'string', description: 'Folder path from sessionContext.' } },
		required: ['path'],
	},
];

export const SessionToolData: readonly IToolData[] = specs.map((spec): IToolData => ({
	id: spec.id,
	toolReferenceName: spec.name,
	displayName: spec.display,
	modelDescription: spec.description,
	icon: spec.icon,
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: true,
	runsInWorkspace: true,
	inputSchema: {
		type: 'object',
		properties: spec.properties,
		required: spec.required ? [...spec.required] : [],
	} as IToolData['inputSchema'],
}));

export class SessionTool implements IToolImpl {
	constructor(
		private readonly _name: string,
		private readonly _session: SessionAccess,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters;
		const args = parameters && typeof parameters === 'object' ? parameters as Record<string, unknown> : {};
		const value = await this._session.invoke(this._name, args);
		return {
			content: [{ kind: 'text', value }],
			toolResultError: value.startsWith('Error:') ? value : undefined,
		};
	}
}
