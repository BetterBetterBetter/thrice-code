/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatService } from '../common/chatService/chatService.js';
import { localChatSessionType } from '../common/chatSessionsService.js';
import { IChatModel, IChatRequestModel } from '../common/model/chatModel.js';
import { getChatSessionType } from '../common/model/chatUri.js';
import { isThriceProvidersParticipant, parseThriceTurnEditsArgs, THRICE_RECORD_TURN_EDITS_COMMAND_ID } from '../common/thriceTurnEdits.js';
import { ChatEditingSession } from './chatEditing/chatEditingSession.js';

function isThriceRequest(request: IChatRequestModel): boolean {
	return isThriceProvidersParticipant(request.response?.agent?.id);
}

/**
 * Finds the chat model and request a turn's edits belong to.
 *
 * - `sessionResource` + `requestId`: that request.
 * - `sessionResource` only: the latest request answered by the Thrice participant in that session.
 * - neither: the latest request of the most recently active local chat session whose last request
 *   was answered by the Thrice participant.
 */
export function resolveThriceTurn(models: Iterable<IChatModel>, sessionResource: URI | undefined, requestId: string | undefined): { model: IChatModel; request: IChatRequestModel } | undefined {
	let candidates: IChatModel[];
	if (sessionResource) {
		const key = sessionResource.toString();
		candidates = Array.from(models).filter(m => m.sessionResource.toString() === key);
	} else {
		candidates = Array.from(models).filter(m => {
			if (getChatSessionType(m.sessionResource) !== localChatSessionType) {
				return false;
			}
			const last = m.lastRequest;
			return !!last && (requestId ? m.getRequests().some(r => r.id === requestId) : isThriceRequest(last));
		});
		candidates.sort((a, b) => (b.lastRequest?.timestamp ?? 0) - (a.lastRequest?.timestamp ?? 0));
	}

	for (const model of candidates) {
		const requests = model.getRequests();
		const request = requestId
			? requests.find(r => r.id === requestId)
			: sessionResource
				? requests.findLast(isThriceRequest)
				: requests.at(-1);
		if (request) {
			return { model, request };
		}
	}
	return undefined;
}

CommandsRegistry.registerCommand(THRICE_RECORD_TURN_EDITS_COMMAND_ID, async (accessor: ServicesAccessor, arg: unknown): Promise<boolean> => {
	const chatService = accessor.get(IChatService);
	const logService = accessor.get(ILogService);

	const parsed = parseThriceTurnEditsArgs(arg);
	if (!parsed) {
		logService.warn(`${THRICE_RECORD_TURN_EDITS_COMMAND_ID}: malformed argument`);
		return false;
	}

	const turn = resolveThriceTurn(chatService.chatModels.get(), parsed.sessionResource, parsed.requestId);
	if (!turn) {
		logService.warn(`${THRICE_RECORD_TURN_EDITS_COMMAND_ID}: no chat request found (session: ${parsed.sessionResource?.toString() ?? 'none'}, request: ${parsed.requestId ?? 'none'})`);
		return false;
	}

	const response = turn.request.response;
	if (!response) {
		logService.warn(`${THRICE_RECORD_TURN_EDITS_COMMAND_ID}: request ${turn.request.id} has no response`);
		return false;
	}

	if (!turn.model.editingSession) {
		turn.model.startEditingSession(true);
	}
	const session = turn.model.editingSession;
	if (!(session instanceof ChatEditingSession)) {
		logService.warn(`${THRICE_RECORD_TURN_EDITS_COMMAND_ID}: session ${turn.model.sessionResource.toString()} has no local editing session`);
		return false;
	}

	if (parsed.edits.length === 0) {
		session.endExternalTurn(turn.request.id);
		return true;
	}

	const recorded = await session.recordExternalTurnEdits(response, parsed.edits);
	return recorded.length === parsed.edits.length;
});

/** How long entries stay in external edit mode after a Thrice turn completes, if its edits are never recorded. */
const EXTERNAL_TURN_GRACE_MS = 15_000;

/**
 * While the Thrice participant answers a request, marks the session's existing
 * entries as externally edited so that the agent's writes to disk (which reload
 * open models) count as agent edits rather than user edits. Recording the turn
 * through {@link THRICE_RECORD_TURN_EDITS_COMMAND_ID} ends the mode; otherwise
 * it ends shortly after the response completes.
 */
export class ThriceTurnEditsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.thriceTurnEdits';

	private readonly _models = this._register(new DisposableMap<IChatModel, DisposableStore>());

	constructor(
		@IChatService chatService: IChatService,
	) {
		super();
		for (const model of chatService.chatModels.get()) {
			this._watch(model);
		}
		this._register(chatService.onDidCreateModel(model => this._watch(model)));
	}

	private _watch(model: IChatModel): void {
		if (this._models.has(model)) {
			return;
		}
		const store = new DisposableStore();
		this._models.set(model, store);
		const turn = store.add(new DisposableStore());

		store.add(model.onDidDispose(() => this._models.deleteAndDispose(model)));
		store.add(model.onDidChange(e => {
			if (e.kind !== 'addRequest' || !isThriceRequest(e.request)) {
				return;
			}
			const session = model.editingSession;
			const response = e.request.response;
			if (!(session instanceof ChatEditingSession) || !response) {
				return;
			}

			turn.clear();
			const requestId = e.request.id;
			session.beginExternalTurn(requestId);
			turn.add({ dispose: () => session.endExternalTurn(requestId) });

			let scheduled = false;
			turn.add(autorun(reader => {
				if (!scheduled && !response.isIncomplete.read(reader)) {
					scheduled = true;
					turn.add(disposableTimeout(() => turn.clear(), EXTERNAL_TURN_GRACE_MS));
				}
			}));
		}));
	}
}
