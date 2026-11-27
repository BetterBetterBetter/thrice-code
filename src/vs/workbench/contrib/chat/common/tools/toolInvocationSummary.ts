/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { posix, win32 } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatToolInvocation, IChatToolInvocationSerialized } from '../chatService/chatService.js';

export interface IChatToolSummaryResource {
	readonly uri: URI;
}

/** Structured facts used for local tool-group summaries, including after history restoration. */
export type ChatToolInvocationSummary =
	| { readonly kind: 'incomplete' | 'unknown' | 'failed' | 'skipped' | 'denied' | 'blockedByHook' }
	| { readonly kind: 'read'; readonly resources: readonly IChatToolSummaryResource[] }
	| { readonly kind: 'search'; readonly queries: readonly string[]; readonly searchKind: 'text' | 'files' }
	| { readonly kind: 'command' }
	| { readonly kind: 'edit' | 'list' | 'diagnostics'; readonly resources: readonly IChatToolSummaryResource[] };

export function getToolInvocationSummary(invocation: IChatToolInvocation | IChatToolInvocationSerialized): ChatToolInvocationSummary | undefined {
	if (!IChatToolInvocation.isComplete(invocation) || invocation.kind === 'toolInvocationSerialized' && invocation.isComplete === false) {
		return { kind: 'incomplete' };
	}
	return invocation.summary ?? thriceExternalSummary(invocation);
}

/**
 * Tool names the Thrice providers extension reports for its external tool calls (Claude-style,
 * already mapped from Codex and OpenCode names). They carry no structured summary, so the facts
 * come from the row itself: the file link in its message, or the message text for a search.
 */
const THRICE_EXTERNAL_TOOLS: Readonly<Record<string, ChatToolInvocationSummary['kind']>> = {
	Read: 'read',
	LS: 'list',
	Grep: 'search',
	Glob: 'search',
	Bash: 'command',
	Edit: 'edit',
	MultiEdit: 'edit',
	Write: 'edit',
	Delete: 'edit',
	NotebookEdit: 'edit',
};

/** Whether a tool call comes from the Thrice providers extension with one of its named tools. */
export function isThriceExternalTool(invocation: Pick<IChatToolInvocation | IChatToolInvocationSerialized, 'toolId' | 'summary'>): boolean {
	// The name first: a summary can be a getter that does work.
	return Object.prototype.hasOwnProperty.call(THRICE_EXTERNAL_TOOLS, invocation.toolId) && !invocation.summary;
}

function thriceExternalSummary(invocation: IChatToolInvocation | IChatToolInvocationSerialized): ChatToolInvocationSummary | undefined {
	const kind = THRICE_EXTERNAL_TOOLS[invocation.toolId];
	if (!kind) {
		return undefined;
	}
	const message = messageText(invocation.pastTenseMessage) || messageText(invocation.invocationMessage);
	const data = invocation.toolSpecificData;
	const linked = (): IChatToolSummaryResource[] => {
		if (data?.kind === 'thriceFileEdit') {
			try {
				return [{ uri: URI.parse(data.uri) }];
			} catch {
				return [];
			}
		}
		const match = /\]\(((?:file|vscode-remote):[^)\s]+)\)/.exec(message);
		if (!match) {
			return [];
		}
		try {
			return [{ uri: URI.parse(match[1]).with({ fragment: '' }) }];
		} catch {
			return [];
		}
	};
	switch (kind) {
		case 'read':
		case 'list':
		case 'edit':
			return { kind, resources: linked() };
		case 'search': {
			// The message names the pattern, so equal searches count once.
			const query = message.replace(/^\S+\s*/, '').trim();
			return query ? { kind: 'search', queries: [query], searchKind: invocation.toolId === 'Glob' ? 'files' : 'text' } : undefined;
		}
		case 'command':
			return { kind: 'command' };
		default:
			return undefined;
	}
}

function messageText(message: string | { readonly value: string } | undefined): string {
	return typeof message === 'string' ? message : message?.value ?? '';
}

/**
 * Called at the agent-host boundary after validating native tool provenance and successful completion.
 * `viewedResourceType` is what the host reports the path of a `view` call named, when it knows.
 */
export function getToolInvocationSummaryFromInput(toolId: string, input: unknown, mapResource: (uri: URI) => URI = uri => uri, viewedResourceType?: 'file' | 'directory'): ChatToolInvocationSummary | undefined {
	const resource = (value: unknown): IChatToolSummaryResource | undefined => {
		if (typeof value !== 'string' || !value) {
			return undefined;
		}
		let uri: URI;
		if (posix.isAbsolute(value)) {
			uri = URI.file(value);
		} else if (win32.isAbsolute(value)) {
			uri = URI.file(value.replaceAll('\\', '/'));
		} else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
			uri = URI.parse(value);
			if (uri.scheme !== Schemas.file && uri.scheme !== Schemas.vscodeRemote) {
				return undefined;
			}
		} else {
			return undefined;
		}
		return { uri: mapResource(uri) };
	};
	const file = () => resource(getProperty(input, 'filePath') ?? getProperty(input, 'file_path') ?? getProperty(input, 'path'));
	switch (toolId) {
		case 'copilot_readFile':
		case 'read_file': {
			// Requested ranges can be expanded or truncated by the tool.
			const target = file();
			return { kind: 'read', resources: target ? [target] : [] };
		}
		case 'view': {
			const target = file();
			if (!target) {
				return undefined;
			}
			// The tool also lists directories. A host that does not say which the path named leaves a line range as the only sign of a file.
			if (viewedResourceType === 'directory') {
				return { kind: 'list', resources: [target] };
			}
			const viewRange = getProperty(input, 'view_range');
			const hasLineRange = Array.isArray(viewRange) && viewRange.length === 2 && Number.isSafeInteger(viewRange[0]) && viewRange[0] > 0
				&& Number.isSafeInteger(viewRange[1]) && (viewRange[1] === -1 || viewRange[1] >= viewRange[0]);
			return viewedResourceType === 'file' || hasLineRange ? { kind: 'read', resources: [target] } : undefined;
		}
		case 'copilot_findTextInFiles':
		case 'grep_search':
		case 'copilot_searchCodebase':
		case 'semantic_search':
		case 'grep':
		case 'rg':
		case 'copilot_findFiles':
		case 'file_search':
		case 'glob': {
			const query = getProperty(input, 'query') ?? getProperty(input, 'pattern');
			if (typeof query !== 'string' || !query.trim()) {
				return undefined;
			}
			return {
				kind: 'search',
				queries: [query],
				searchKind: toolId === 'copilot_findFiles' || toolId === 'file_search' || toolId === 'glob' ? 'files' : 'text',
			};
		}
		case 'run_in_terminal':
		case 'bash':
		case 'powershell':
		case 'shell': {
			const command = getProperty(input, 'command');
			return typeof command === 'string' && command.trim() ? { kind: 'command' } : undefined;
		}
		case 'copilot_listDirectory':
		case 'list_dir': {
			const target = file();
			return target ? { kind: 'list', resources: [target] } : undefined;
		}
		case 'copilot_getErrors':
		case 'get_errors': {
			const paths = getProperty(input, 'filePaths');
			if (!Array.isArray(paths) || paths.length === 0) {
				return undefined;
			}
			const resources = paths.map(resource);
			return resources.every(value => value !== undefined) ? { kind: 'diagnostics', resources } : undefined;
		}
		case 'copilot_applyPatch':
		case 'apply_patch':
			return { kind: 'edit', resources: [] };
		case 'copilot_replaceString':
		case 'replace_string_in_file':
		case 'copilot_insertEdit':
		case 'insert_edit_into_file':
		case 'copilot_createFile':
		case 'create_file':
		case 'edit': {
			const target = file();
			return target ? { kind: 'edit', resources: [target] } : undefined;
		}
		case 'vscode_editFile':
		case 'vscode_editFile_internal': {
			const target = resource(getProperty(input, 'uri'));
			return target ? { kind: 'edit', resources: [target] } : undefined;
		}
		case 'copilot_multiReplaceString':
		case 'multi_replace_string_in_file': {
			const replacements = getProperty(input, 'replacements');
			if (!Array.isArray(replacements) || replacements.length === 0) {
				return undefined;
			}
			const resources = replacements.map(replacement => resource(getProperty(replacement, 'filePath')));
			return resources.every(value => value !== undefined) ? { kind: 'edit', resources } : undefined;
		}
		default:
			return undefined;
	}
}

function getProperty(input: unknown, key: string): unknown {
	return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;
}
