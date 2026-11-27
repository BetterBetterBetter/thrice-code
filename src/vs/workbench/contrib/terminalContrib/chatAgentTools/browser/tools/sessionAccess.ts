/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { isCodeEditor, isDiffEditor, type ICodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { IMarkerService, MarkerSeverity, type IMarker } from '../../../../../../platform/markers/common/markers.js';
import { TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IRemoteExplorerService } from '../../../../../services/remote/common/remoteExplorerService.js';
import { TunnelCloseReason, UserTunnelSource, type Tunnel } from '../../../../../services/remote/common/tunnelModel.js';
import { IWorkingCopyService } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { IWorkspaceEditingService } from '../../../../../services/workspaces/common/workspaceEditing.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { getOutput } from '../outputHelpers.js';
import { agentWindowShellSessionName } from './agentWindowShell.js';

/** Command the session MCP calls. The argument is `{ tool, args }`. */
export const SESSION_INVOKE_COMMAND = 'thrice.session.invoke';

const CONTEXT_LIMIT = 12000;
const PREVIEW_LIMIT = 1500;
const SELECTION_LIMIT = 2000;
const EDITOR_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);

interface IOpenEditor {
	readonly resource: URI;
	readonly dirty: boolean;
	readonly untitled: boolean;
}

export class SessionAccess {
	constructor(
		@ITerminalService private readonly _terminals: ITerminalService,
		@IRemoteExplorerService private readonly _remoteExplorer: IRemoteExplorerService,
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly _workspaceEditing: IWorkspaceEditingService,
		@IModelService private readonly _models: IModelService,
		@IWorkingCopyService private readonly _workingCopies: IWorkingCopyService,
		@IEditorService private readonly _editors: IEditorService,
		@IMarkerService private readonly _markers: IMarkerService,
		@IWorkbenchEnvironmentService private readonly _environment: IWorkbenchEnvironmentService,
	) { }

	async invoke(tool: string, args: Record<string, unknown>): Promise<string> {
		try {
			return await this._dispatch(tool, args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `Error: ${message}`;
		}
	}

	private async _dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
		switch (tool) {
			case 'sessionContext': return this._context();
			case 'listEditors': return this._listEditors();
			case 'readEditor': return this._readEditor(args);
			case 'openEditor': return this._openEditor(args);
			case 'writeEditor': return this._writeEditor(args);
			case 'listTerminals': return this._listTerminals();
			case 'readTerminal': return this._readTerminal(args);
			case 'spawnTerminal': return this._spawnTerminal(args);
			case 'writeTerminal': return this._writeTerminal(args);
			case 'closeTerminal': return this._closeTerminal(args);
			case 'waitTerminal': return this._waitTerminal(args);
			case 'listPorts': return this._listPorts();
			case 'forwardPort': return this._forwardPort(args);
			case 'closePort': return this._closePort(args);
			case 'listProblems': return this._listProblems();
			case 'addFolder': return this._addFolder(args);
			case 'removeFolder': return this._removeFolder(args);
			default: return `Error: Unknown session tool ${tool}.`;
		}
	}

	private _context(): string {
		const lines = [
			'Window session',
			`Window: ${this._where()}`,
			this._workspaceSummary(),
			'',
			this._activeEditorSection(),
			'',
			'Open editors:',
			this._editorLines() || '- none',
			'',
			this._dirtyPreviews(),
			'Integrated terminals:',
			this._terminalLines(true) || '- none',
			'',
			'Ports:',
			this._portLines() || '- none',
			'',
			this._problemSection(12),
			'',
			'Use the session tools to read or change editors, terminals, and ports in this window. spawnTerminal opens a real integrated terminal. readTerminal and waitTerminal return its output.',
		];
		return cap(lines.filter(line => line !== undefined && line !== '').join('\n'), CONTEXT_LIMIT);
	}

	private _where(): string {
		const remote = this._environment.remoteAuthority;
		return remote ? `remote ${remote}` : 'local';
	}

	private _workspaceSummary(): string {
		const workspace = this._workspaceContext.getWorkspace();
		const state = this._workspaceContext.getWorkbenchState();
		const configuration = workspace.configuration;
		let kind: string;
		if (state === WorkbenchState.EMPTY) {
			kind = 'No folder is open. Untitled editors are the workspace.';
		} else if (!configuration) {
			kind = state === WorkbenchState.WORKSPACE
				? `Unsaved workspace "${workspace.name}".`
				: `Folder window "${workspace.name}".`;
		} else {
			kind = `Saved workspace "${workspace.name}" at ${configuration.fsPath}.`;
		}
		const folders = workspace.folders.map(folder => `- ${folder.uri.fsPath}`);
		return [kind, 'Folders:', folders.length ? folders.join('\n') : '- none'].join('\n');
	}

	private _activeEditorSection(): string {
		const editor = activeCodeEditor(this._editors.activeTextEditorControl);
		const model = editor?.getModel();
		if (!editor || !model) {
			return 'Active editor: none';
		}
		const lines = [`Active editor: ${editorLabel(model.uri)}`];
		const position = editor.getPosition();
		if (position) {
			lines.push(`Cursor: line ${position.lineNumber} column ${position.column}`);
		}
		const selection = editor.getSelection();
		if (selection && !selection.isEmpty()) {
			lines.push(`Selection: lines ${selection.startLineNumber}-${selection.endLineNumber}`);
			const text = model.getValueInRange(selection);
			if (text.trim()) {
				lines.push(text.length > SELECTION_LIMIT ? `${text.slice(0, SELECTION_LIMIT)}\n[selection truncated]` : text);
			}
		}
		const visible = editor.getVisibleRanges();
		if (visible.length) {
			lines.push(`Visible: ${visible.map(range => `lines ${range.startLineNumber}-${range.endLineNumber}`).join(', ')}`);
		}
		return lines.join('\n');
	}

	private _openEditors(): IOpenEditor[] {
		const seen = new Set<string>();
		const editors: IOpenEditor[] = [];
		for (const input of this._editors.editors) {
			const resource = input.resource;
			if (!resource || !EDITOR_SCHEMES.has(resource.scheme)) {
				continue;
			}
			const key = resource.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			editors.push({
				resource,
				dirty: this._workingCopies.isDirty(resource),
				untitled: resource.scheme === 'untitled',
			});
		}
		return editors;
	}

	private _editorLines(): string {
		return this._openEditors().map(editor => {
			const model = this._models.getModel(editor.resource);
			const flags = [editor.untitled ? 'untitled' : 'file', editor.dirty ? 'dirty' : 'saved', model?.getLanguageId()].filter(Boolean);
			return `- ${editorLabel(editor.resource)} [${flags.join(', ')}]`;
		}).join('\n');
	}

	private _listEditors(): string {
		const lines = this._editorLines();
		return lines || 'Open editors: none';
	}

	private _dirtyPreviews(): string {
		const blocks: string[] = [];
		for (const editor of this._openEditors()) {
			if (!editor.dirty && !editor.untitled) {
				continue;
			}
			if (blocks.length >= 4) {
				break;
			}
			const model = this._models.getModel(editor.resource);
			const text = model?.getValue() ?? '';
			if (!text.trim()) {
				continue;
			}
			const body = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n[preview truncated]` : text;
			blocks.push(`Unsaved preview ${editorLabel(editor.resource)}:\n${body}`);
		}
		return blocks.length ? `${blocks.join('\n\n')}\n` : '';
	}

	private _findEditor(id: string): IOpenEditor | undefined {
		const editors = this._openEditors();
		const exact = editors.find(editor => editor.resource.toString() === id || editor.resource.fsPath === id || editor.resource.path === id);
		if (exact) {
			return exact;
		}
		const tail = editors.filter(editor => editor.resource.fsPath.endsWith(`/${id}`) || editor.resource.path.endsWith(`/${id}`) || editorLabel(editor.resource) === id);
		return tail.length === 1 ? tail[0] : undefined;
	}

	private _readEditor(args: Record<string, unknown>): string {
		const id = stringArg(args, 'path');
		if (!id) {
			return 'Error: path is required. Use a path from listEditors or sessionContext.';
		}
		const editor = this._findEditor(id);
		if (!editor) {
			return `Error: No open editor matches ${id}.`;
		}
		const model = this._models.getModel(editor.resource);
		if (!model) {
			return `Error: ${editorLabel(editor.resource)} is open but its text is not loaded.`;
		}
		const flags = editor.untitled ? 'untitled' : editor.dirty ? 'dirty' : 'saved';
		return cap(`${editorLabel(editor.resource)} [${flags}]\n${model.getValue()}`, 20000);
	}

	private async _openEditor(args: Record<string, unknown>): Promise<string> {
		const id = stringArg(args, 'path');
		if (!id) {
			return 'Error: path is required.';
		}
		const resource = id.includes('://') ? URI.parse(id) : URI.file(id);
		const pane = await this._editors.openEditor({ resource });
		if (!pane) {
			return `Error: Could not open ${id}.`;
		}
		return `Opened ${editorLabel(resource)} in this window.`;
	}

	private async _writeEditor(args: Record<string, unknown>): Promise<string> {
		const id = stringArg(args, 'path');
		if (!id) {
			return 'Error: path is required.';
		}
		const editor = this._findEditor(id);
		if (!editor) {
			return `Error: No open editor matches ${id}.`;
		}
		const model = this._models.getModel(editor.resource);
		if (!model) {
			return `Error: ${editorLabel(editor.resource)} is open but its text is not loaded.`;
		}
		if (typeof args.content === 'string') {
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text: args.content }], () => null);
			await this._editors.openEditor({ resource: editor.resource });
			return `Replaced ${editorLabel(editor.resource)}. It stays unsaved until the editor saves it.`;
		}
		const oldText = typeof args.old === 'string' ? args.old : undefined;
		const newText = typeof args.new === 'string' ? args.new : undefined;
		if (oldText === undefined || newText === undefined) {
			return 'Error: pass content to replace the editor, or old and new for one replacement.';
		}
		if (!oldText) {
			return 'Error: old must be a non-empty string.';
		}
		const value = model.getValue();
		const at = value.indexOf(oldText);
		if (at < 0) {
			return `Error: old text was not found in ${editorLabel(editor.resource)}.`;
		}
		const start = model.getPositionAt(at);
		const end = model.getPositionAt(at + oldText.length);
		model.pushEditOperations([], [{ range: Range.fromPositions(start, end), text: newText }], () => null);
		await this._editors.openEditor({ resource: editor.resource });
		return `Updated ${editorLabel(editor.resource)}. It stays unsaved until the editor saves it.`;
	}

	private _visibleTerminals(): ITerminalInstance[] {
		return this._terminals.instances.filter(instance => !instance.shellLaunchConfig.hideFromUser);
	}

	private _terminalLines(withTail: boolean): string {
		const activeId = this._terminals.activeInstance?.instanceId;
		return this._visibleTerminals().map(instance => {
			const cwd = instance.cwd || instance.initialCwd || '';
			const state = instance.exitReason !== undefined ? 'exited' : instance.hasChildProcesses ? 'running' : 'idle';
			const focused = instance.instanceId === activeId ? ' focused' : '';
			const head = `- id ${instance.instanceId} "${instance.title}"${cwd ? ` cwd ${cwd}` : ''}${focused} ${state}`;
			if (!withTail) {
				return head;
			}
			const tail = getOutput(instance, undefined, { lastNLines: 8 }).trim();
			return tail ? `${head}\n${tail}` : head;
		}).join('\n');
	}

	private _listTerminals(): string {
		const lines = this._terminalLines(true);
		return lines || 'Integrated terminals: none';
	}

	private _terminal(args: Record<string, unknown>): ITerminalInstance | string {
		const id = intArg(args, 'id');
		if (id === undefined) {
			return 'Error: id is required. Use an id from listTerminals or sessionContext.';
		}
		const instance = this._terminals.getInstanceFromId(id);
		if (!instance || instance.isDisposed) {
			return `Error: No integrated terminal with id ${id}.`;
		}
		return instance;
	}

	private _readTerminal(args: Record<string, unknown>): string {
		const instance = this._terminal(args);
		if (typeof instance === 'string') {
			return instance;
		}
		const lines = intArg(args, 'lines') ?? 200;
		const output = getOutput(instance, undefined, { lastNLines: Math.min(Math.max(lines, 1), 1000) });
		const exit = instance.exitCode === undefined ? '' : `\nExit code: ${instance.exitCode}`;
		return cap(`Terminal ${instance.instanceId} "${instance.title}"\n${output}${exit}`.trim(), 20000) || `Terminal ${instance.instanceId} has no output.`;
	}

	private async _spawnTerminal(args: Record<string, unknown>): Promise<string> {
		const command = stringArg(args, 'command');
		const directory = stringArg(args, 'working_directory');
		const cwd = directory ? URI.file(directory) : undefined;
		const name = command ? agentWindowShellSessionName(command) : 'Terminal';
		const instance = await this._terminals.createTerminal({
			cwd,
			location: TerminalLocation.Panel,
			config: { name, cwd, hideFromUser: false, isFeatureTerminal: false },
		});
		if (command) {
			await Promise.race([
				instance.processReady.then(() => instance.sendText(command, true)),
				wait(8000),
			]);
		}
		this._terminals.setActiveInstance(instance);
		await this._terminals.focusInstance(instance);
		const running = command ? ` running \`${command}\`` : '';
		return `Opened the terminal panel on terminal ${instance.instanceId} "${name}"${running}. Call readTerminal or waitTerminal with id ${instance.instanceId} for output.`;
	}

	private async _writeTerminal(args: Record<string, unknown>): Promise<string> {
		const instance = this._terminal(args);
		if (typeof instance === 'string') {
			return instance;
		}
		const text = typeof args.text === 'string' ? args.text : undefined;
		if (text === undefined) {
			return 'Error: text is required. Use an empty string to send Enter.';
		}
		await instance.sendText(text, args.submit !== false);
		await this._terminals.focusInstance(instance);
		return `Sent text to terminal ${instance.instanceId}. The terminal panel is open. Call readTerminal or waitTerminal for the result.`;
	}

	private _closeTerminal(args: Record<string, unknown>): string {
		const instance = this._terminal(args);
		if (typeof instance === 'string') {
			return instance;
		}
		const id = instance.instanceId;
		instance.dispose();
		return `Closed terminal ${id}.`;
	}

	private _waitTerminal(args: Record<string, unknown>): Promise<string> {
		const instance = this._terminal(args);
		if (typeof instance === 'string') {
			return Promise.resolve(instance);
		}
		const timeout = clamp(intArg(args, 'timeout_ms') ?? 15000, 1000, 60000);
		const before = getOutput(instance);
		return new Promise(resolve => {
			const store = new DisposableStore();
			let quiet: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (quiet !== undefined) {
					clearTimeout(quiet);
				}
				store.dispose();
				const after = getOutput(instance);
				const delta = after.startsWith(before) ? after.slice(before.length).trim() : after.trim();
				resolve(delta ? cap(delta, 20000) : 'No new output.');
			};
			const timer = setTimeout(finish, timeout);
			store.add({ dispose: () => clearTimeout(timer) });
			store.add(instance.onData(() => {
				if (quiet !== undefined) {
					clearTimeout(quiet);
				}
				quiet = setTimeout(finish, 400);
			}));
			store.add(instance.onExit(() => finish()));
		});
	}

	private _portLines(): string {
		const model = this._remoteExplorer.tunnelModel;
		const lines: string[] = [];
		const seen = new Set<string>();
		const remember = (host: string, port: number) => {
			const key = `${host}:${port}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		};
		for (const tunnel of model.forwarded.values()) {
			if (!remember(tunnel.remoteHost, tunnel.remotePort)) {
				continue;
			}
			lines.push(`- forwarded ${tunnel.remoteHost}:${tunnel.remotePort} -> ${tunnel.localAddress}${portDetail(tunnel)}`);
		}
		for (const tunnel of model.detected.values()) {
			if (!remember(tunnel.remoteHost, tunnel.remotePort)) {
				continue;
			}
			lines.push(`- detected ${tunnel.remoteHost}:${tunnel.remotePort}${portDetail(tunnel)}`);
		}
		for (const candidate of model.candidates) {
			if (!remember(candidate.host, candidate.port)) {
				continue;
			}
			lines.push(`- listening ${candidate.host}:${candidate.port}${candidate.pid ? ` pid ${candidate.pid}` : ''}${candidate.detail ? ` ${candidate.detail}` : ''}`);
		}
		return lines.join('\n');
	}

	private _listPorts(): string {
		const lines = this._portLines();
		return lines || 'Ports: none';
	}

	private async _forwardPort(args: Record<string, unknown>): Promise<string> {
		const port = intArg(args, 'port');
		if (port === undefined || port < 1 || port > 65535) {
			return 'Error: port must be a number from 1 to 65535.';
		}
		const host = stringArg(args, 'host') ?? 'localhost';
		const local = intArg(args, 'local_port');
		const result = await this._remoteExplorer.forward({
			remote: { host, port },
			local,
			source: UserTunnelSource,
		});
		if (typeof result === 'string') {
			return `Error: ${result}`;
		}
		if (!result) {
			return `Error: Port ${host}:${port} was not forwarded.`;
		}
		return `Forwarded ${result.tunnelRemoteHost}:${result.tunnelRemotePort} to ${result.localAddress}.`;
	}

	private async _closePort(args: Record<string, unknown>): Promise<string> {
		const port = intArg(args, 'port');
		if (port === undefined) {
			return 'Error: port is required.';
		}
		const host = stringArg(args, 'host') ?? 'localhost';
		await this._remoteExplorer.close({ host, port }, TunnelCloseReason.User);
		return `Closed forwarded port ${host}:${port}.`;
	}

	private _problems(): IMarker[] {
		return this._markers.read()
			.filter(marker => marker.severity === MarkerSeverity.Error || marker.severity === MarkerSeverity.Warning)
			.sort((left, right) => MarkerSeverity.compare(left.severity, right.severity));
	}

	private _problemSection(limit: number): string {
		const problems = this._problems();
		const errors = problems.filter(marker => marker.severity === MarkerSeverity.Error).length;
		const warnings = problems.length - errors;
		const lines = [`Problems: ${errors} errors, ${warnings} warnings`];
		for (const marker of problems.slice(0, limit)) {
			const severity = marker.severity === MarkerSeverity.Error ? 'Error' : 'Warning';
			const message = marker.message.replace(/\s+/g, ' ').slice(0, 200);
			lines.push(`- ${severity} ${editorLabel(marker.resource)}:${marker.startLineNumber} ${message}`);
		}
		if (problems.length > limit) {
			lines.push(`- ${problems.length - limit} more. Call listProblems.`);
		}
		return lines.join('\n');
	}

	private _listProblems(): string {
		return this._problemSection(40);
	}

	private async _addFolder(args: Record<string, unknown>): Promise<string> {
		const path = stringArg(args, 'path');
		if (!path) {
			return 'Error: path is required.';
		}
		const uri = path.includes('://') ? URI.parse(path) : URI.file(path);
		await this._workspaceEditing.addFolders([{ uri }]);
		return `Added folder ${uri.fsPath} to this window.`;
	}

	private async _removeFolder(args: Record<string, unknown>): Promise<string> {
		const path = stringArg(args, 'path');
		if (!path) {
			return 'Error: path is required.';
		}
		const folder = this._workspaceContext.getWorkspace().folders.find(candidate => candidate.uri.fsPath === path || candidate.uri.toString() === path);
		if (!folder) {
			return `Error: ${path} is not a folder in this window.`;
		}
		await this._workspaceEditing.removeFolders([folder.uri]);
		return `Removed folder ${folder.uri.fsPath} from this window.`;
	}
}

function activeCodeEditor(control: unknown): ICodeEditor | undefined {
	if (isCodeEditor(control)) {
		return control;
	}
	if (isDiffEditor(control)) {
		return control.getModifiedEditor();
	}
	return undefined;
}

function editorLabel(resource: URI): string {
	return resource.scheme === 'file' ? resource.fsPath : resource.toString();
}

function portDetail(tunnel: Tunnel): string {
	const parts = [tunnel.runningProcess ? ` ${tunnel.runningProcess}` : '', tunnel.pid ? ` pid ${tunnel.pid}` : ''];
	return parts.join('');
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function intArg(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isInteger(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function cap(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n[truncated]`;
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
