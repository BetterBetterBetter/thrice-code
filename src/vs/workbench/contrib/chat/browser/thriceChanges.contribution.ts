/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../common/constants.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { chatSessionResourceToId } from '../common/model/chatUri.js';
import { IChatWidgetService } from './chat.js';

/** Workbench command behind the Thrice session bar's Changes button. */
export const THRICE_SHOW_CHANGES_COMMAND_ID = 'thrice.chat.showChanges';

/**
 * Extension command registered by `extensions/thrice-providers/src/gitContext.ts`
 * (`registerGitChangesCommand`). It runs git, shows the range picker and opens the multi-diff editor.
 */
export const THRICE_GIT_SHOW_CHANGES_COMMAND_ID = 'thrice.git.showChanges';

export type ThriceChangesRange = 'turn' | 'session' | 'uncommitted';

/** Opens the Changes picker (or one range directly) for a chat session. */
export async function showThriceChanges(commandService: ICommandService, sessionResource: URI | undefined, range?: ThriceChangesRange): Promise<void> {
	await commandService.executeCommand(THRICE_GIT_SHOW_CHANGES_COMMAND_ID, {
		sessionId: sessionResource ? chatSessionResourceToId(sessionResource) : undefined,
		sessionResource: sessionResource?.toString(),
		range,
	});
}

registerAction2(class ShowThriceChangesAction extends Action2 {
	constructor() {
		super({
			id: THRICE_SHOW_CHANGES_COMMAND_ID,
			title: localize2('thrice.chat.showChanges', "Show Chat Changes"),
			category: localize2('thrice.category', "Thrice"),
			f1: true,
			icon: Codicon.gitCompare,
			// The session bar that was meant to host this button is not mounted, so the action
			// lives in the chat input toolbar instead.
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.and(
					ChatContextKeys.inQuickChat.negate(),
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
				),
			}],
		});
	}

	override async run(accessor: ServicesAccessor, sessionResource?: URI | string, range?: ThriceChangesRange): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const resource = typeof sessionResource === 'string'
			? URI.parse(sessionResource)
			: URI.isUri(sessionResource) ? sessionResource : accessor.get(IChatWidgetService).lastFocusedWidget?.viewModel?.sessionResource;
		try {
			await showThriceChanges(commandService, resource, range);
		} catch (error) {
			notificationService.warn(localize('thrice.chat.showChanges.failed', "Could not show changes: {0}", error instanceof Error ? error.message : String(error)));
		}
	}
});
