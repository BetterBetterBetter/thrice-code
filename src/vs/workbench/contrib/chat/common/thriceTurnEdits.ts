/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isUriComponents, URI, UriComponents } from '../../../../base/common/uri.js';

/** Chat participant contributed by the `thrice-providers` extension; it runs CLI agents that write straight to disk. */
export const THRICE_PROVIDERS_CHAT_PARTICIPANT_ID = 'thrice.providers.chat';

/** Internal command that records a turn's on-disk edits into the chat editing session. */
export const THRICE_RECORD_TURN_EDITS_COMMAND_ID = '_thrice.chat.recordTurnEdits';

export function isThriceProvidersParticipant(agentId: string | undefined): boolean {
	return agentId === THRICE_PROVIDERS_CHAT_PARTICIPANT_ID;
}

/** Arguments of {@link THRICE_RECORD_TURN_EDITS_COMMAND_ID}, as sent by the extension. */
export interface IThriceRecordTurnEditsArgs {
	/** Chat session resource (`ChatRequest.sessionResource.toString()`), or the URI itself. */
	readonly sessionResource?: string | UriComponents;
	/** Chat request id (`ChatRequest.id` with `chatParticipantPrivate`, or `toolInvocationToken.requestId`). */
	readonly requestId?: string;
	/** `ChatRequest.toolInvocationToken`; supplies `sessionResource` and `requestId` when those are absent. */
	readonly toolInvocationToken?: unknown;
	/** File URIs as strings (or URIs). `before: null` = created during the turn, `after: null` = deleted. */
	readonly edits: ReadonlyArray<{ readonly uri: string | UriComponents; readonly before: string | null | undefined; readonly after: string | null | undefined }>;
	/**
	 * `true` while the turn is still running: the edits are recorded right away but the
	 * turn's external edit mode stays active, so the agent's later writes keep counting as
	 * agent edits. A file may be recorded several times per turn; its first recording's
	 * `before` is kept as the turn baseline. Send a final call without `partial` (with the
	 * whole turn's edits, or none) when the turn ends.
	 */
	readonly partial?: boolean;
}

export interface IParsedThriceTurnEdits {
	readonly sessionResource: URI | undefined;
	readonly requestId: string | undefined;
	readonly edits: ReadonlyArray<{ readonly uri: URI; readonly before: string | undefined; readonly after: string | undefined }>;
	readonly partial: boolean;
}

function toUri(value: unknown): URI | undefined {
	if (typeof value === 'string' && value) {
		return URI.parse(value);
	}
	if (URI.isUri(value)) {
		return value;
	}
	if (isUriComponents(value)) {
		return URI.revive(value);
	}
	return undefined;
}

function toContent(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * Validates the command argument. Returns `undefined` when it is malformed.
 * Edits whose `before` and `after` are both missing, or equal, are dropped.
 */
export function parseThriceTurnEditsArgs(arg: unknown): IParsedThriceTurnEdits | undefined {
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}
	const raw = arg as Partial<IThriceRecordTurnEditsArgs>;
	if (!Array.isArray(raw.edits)) {
		return undefined;
	}

	const token = raw.toolInvocationToken && typeof raw.toolInvocationToken === 'object'
		? raw.toolInvocationToken as { sessionResource?: unknown; requestId?: unknown }
		: undefined;

	const sessionResource = toUri(raw.sessionResource) ?? toUri(token?.sessionResource);
	const requestId = typeof raw.requestId === 'string' && raw.requestId
		? raw.requestId
		: typeof token?.requestId === 'string' && token.requestId ? token.requestId : undefined;

	const edits: { uri: URI; before: string | undefined; after: string | undefined }[] = [];
	for (const edit of raw.edits) {
		if (!edit || typeof edit !== 'object') {
			return undefined;
		}
		const uri = toUri(edit.uri);
		if (!uri) {
			return undefined;
		}
		const before = toContent(edit.before);
		const after = toContent(edit.after);
		if (before === after) {
			continue; // unchanged, or absent on both sides
		}
		edits.push({ uri, before, after });
	}

	return { sessionResource, requestId, edits, partial: raw.partial === true };
}

/**
 * Opens what one file looked like before and after a Thrice turn: the diff of the request's
 * recorded edits to it, or the file itself when none are recorded (yet). Resolves to true when it
 * showed the diff. Argument: {@link IThriceOpenTurnFileDiffArgs}.
 */
export const THRICE_OPEN_TURN_FILE_DIFF_COMMAND_ID = '_thrice.chat.openTurnFileDiff';

export interface IThriceOpenTurnFileDiffArgs {
	/** The chat session. Without it, the most recently active local Thrice session. */
	readonly sessionResource?: UriComponents | string;
	/** The request whose edits to show. Without it, the session's latest Thrice request. */
	readonly requestId?: string;
	/** The file. */
	readonly uri: UriComponents | string;
	/** Open beside the active editor. */
	readonly sideBySide?: boolean;
}

export interface IParsedThriceOpenTurnFileDiff {
	readonly sessionResource: URI | undefined;
	readonly requestId: string | undefined;
	readonly uri: URI;
	readonly sideBySide: boolean;
}

/** Validates the command argument. Returns `undefined` when it names no file. */
export function parseThriceOpenTurnFileDiffArgs(arg: unknown): IParsedThriceOpenTurnFileDiff | undefined {
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}
	const raw = arg as Partial<IThriceOpenTurnFileDiffArgs>;
	const uri = toUri(raw.uri);
	if (!uri) {
		return undefined;
	}
	return {
		sessionResource: toUri(raw.sessionResource),
		requestId: typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : undefined,
		uri,
		sideBySide: raw.sideBySide === true,
	};
}
