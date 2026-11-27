/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { CHAT_SUBAGENT_RESOURCE_QUERY_PARAM } from '../../../../../../platform/agentHost/common/agentHostSessionIdentity.js';
import { getAgentHostChatId } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { IChatModel } from '../../../common/model/chatModel.js';
import { listSubagentChats, ListedSubagentChat } from './chatSessionTabs.js';

/** Sub-agent chats recorded on a reply, including ones the session list keeps hidden. */
export function subagentChatsInModel(model: IChatModel): ListedSubagentChat[] {
	const parts = [];
	for (const request of model.getRequests()) {
			for (const part of request.response?.response.value ?? []) {
			if (part.kind !== 'toolInvocation' && part.kind !== 'toolInvocationSerialized') {
				continue;
			}
			parts.push({
				toolCallId: part.toolCallId,
				subAgentInvocationId: part.subAgentInvocationId,
				complete: part.kind === 'toolInvocationSerialized' || IChatToolInvocation.isComplete(part),
				toolSpecificData: part.toolSpecificData?.kind === 'subagent' ? part.toolSpecificData : undefined,
			});
		}
	}
	return listSubagentChats(parts);
}

/**
 * The editor resource Open Subagent uses: the parent session, with the child
 * chat selected. Opening the child URI on its own does not land in that chat.
 */
export function subagentEditorResource(parent: URI, chatResource: string): URI | undefined {
	try {
		URI.parse(chatResource, true);
		const query = new URLSearchParams(parent.query);
		query.set(CHAT_SUBAGENT_RESOURCE_QUERY_PARAM, chatResource);
		return parent.with({ fragment: getAgentHostChatId(chatResource), query: query.toString() });
	} catch {
		return undefined;
	}
}
