/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	$,
	addDisposableListener,
	append,
	EventType,
} from "../../../../../../../base/browser/dom.js";
import { StandardKeyboardEvent } from "../../../../../../../base/browser/keyboardEvent.js";
import { Codicon } from "../../../../../../../base/common/codicons.js";
import { KeyCode } from "../../../../../../../base/common/keyCodes.js";
import { autorun } from "../../../../../../../base/common/observable.js";
import {
	basename,
	dirname,
} from "../../../../../../../base/common/resources.js";
import { ThemeIcon } from "../../../../../../../base/common/themables.js";
import { URI } from "../../../../../../../base/common/uri.js";
import { getIconClasses } from "../../../../../../../editor/common/services/getIconClasses.js";
import { ILanguageService } from "../../../../../../../editor/common/languages/language.js";
import { IModelService } from "../../../../../../../editor/common/services/model.js";
import { localize } from "../../../../../../../nls.js";
import { ICommandService } from "../../../../../../../platform/commands/common/commands.js";
import { FileKind } from "../../../../../../../platform/files/common/files.js";
import { ILabelService } from "../../../../../../../platform/label/common/label.js";
import { IOpenerService } from "../../../../../../../platform/opener/common/opener.js";
import {
	IChatThriceFileEditData,
	IChatToolInvocation,
	IChatToolInvocationSerialized,
} from "../../../../common/chatService/chatService.js";
import { isResponseVM } from "../../../../common/model/chatViewModel.js";
import { IChatCodeBlockInfo } from "../../../chat.js";
import { IChatContentPartRenderContext } from "../chatContentParts.js";
import { BaseChatToolInvocationSubPart } from "./chatToolInvocationSubPart.js";
import "../media/thriceTrace.css";

/** Registered by thriceRecordTurnEdits.ts: opens this file's diff for the request, or the file. */
const OPEN_TURN_FILE_DIFF_COMMAND = "_thrice.chat.openTurnFileDiff";

/**
 * One file an agent's edit call changed, as a single inline row in the trace:
 * `[file icon] name  folder   +12 −3  ›`. Clicking it opens the file's diff for this turn.
 */
export class ChatThriceFileEditSubPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;
	public readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		data: IChatThriceFileEditData,
		context: IChatContentPartRenderContext,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILabelService labelService: ILabelService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
	) {
		super(toolInvocation);

		let uri: URI;
		try {
			uri = URI.parse(data.uri);
		} catch {
			uri = URI.file(data.uri);
		}
		const complete = IChatToolInvocation.isComplete(toolInvocation);
		const failed = this.getIcon().id === Codicon.error.id;
		const name = basename(uri);
		const folder = labelService.getUriLabel(dirname(uri), { relative: true });

		const row = (this.domNode = $("div.chat-thrice-file-edit.show-file-icons", {
			role: "button",
			tabIndex: 0,
		}));
		row.classList.toggle("running", !complete);
		row.classList.toggle("failed", failed);
		row.classList.add(`change-${data.change}`);

		const icon = append(row, $("span.chat-thrice-file-edit-icon"));
		icon.classList.add(
			...getIconClasses(modelService, languageService, uri, FileKind.FILE),
		);
		append(row, $("span.chat-thrice-file-edit-name", undefined, name));
		if (folder && folder !== ".") {
			append(row, $("span.chat-thrice-file-edit-folder", undefined, folder));
		}
		const stats = append(row, $("span.chat-thrice-file-edit-stats"));
		if (data.change === "delete") {
			append(
				stats,
				$(
					"span.chat-thrice-file-edit-deleted",
					undefined,
					localize("thriceFileEdit.deleted", "deleted"),
				),
			);
		} else if (complete || data.added > 0 || data.removed > 0) {
			append(
				stats,
				$("span.chat-thrice-file-edit-added", undefined, `+${data.added}`),
			);
			if (data.change !== "add" || data.removed > 0) {
				append(
					stats,
					$(
						"span.chat-thrice-file-edit-removed",
						undefined,
						`−${data.removed}`,
					),
				);
			}
		}
		append(
			row,
			$(
				`span.chat-thrice-file-edit-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`,
			),
		);

		const verb =
			data.change === "add"
				? localize("thriceFileEdit.created", "Created {0}", name)
				: data.change === "delete"
					? localize("thriceFileEdit.deletedFile", "Deleted {0}", name)
					: localize("thriceFileEdit.edited", "Edited {0}", name);
		const counts =
			data.change === "delete"
				? ""
				: localize(
						"thriceFileEdit.counts",
						"{0} lines added, {1} removed",
						data.added,
						data.removed,
					);
		row.setAttribute(
			"aria-label",
			counts
				? localize(
						"thriceFileEdit.aria",
						"{0}, {1}. Open the diff.",
						verb,
						counts,
					)
				: localize("thriceFileEdit.ariaNoCounts", "{0}. Open the file.", verb),
		);
		row.title = uri.scheme === "file" ? uri.fsPath : uri.toString();

		const open = () => this.open(uri, context);
		this._register(addDisposableListener(row, EventType.CLICK, open));
		this._register(
			addDisposableListener(row, EventType.KEY_DOWN, (event) => {
				const keyboard = new StandardKeyboardEvent(event);
				if (keyboard.equals(KeyCode.Enter) || keyboard.equals(KeyCode.Space)) {
					keyboard.preventDefault();
					open();
				}
			}),
		);

		// The end of the call brings the final counts, so draw the row again once it completes.
		if (toolInvocation.kind === "toolInvocation" && !complete) {
			this._register(
				autorun((reader) => {
					if (IChatToolInvocation.isComplete(toolInvocation, reader)) {
						this._onNeedsRerender.fire();
					}
				}),
			);
		}
	}

	private async open(
		uri: URI,
		context: IChatContentPartRenderContext,
	): Promise<void> {
		const element = context.element;
		const args = {
			uri: uri.toString(),
			sessionResource: element.sessionResource.toString(),
			requestId: isResponseVM(element) ? element.requestId : element.id,
		};
		try {
			await this.commandService.executeCommand(
				OPEN_TURN_FILE_DIFF_COMMAND,
				args,
			);
		} catch {
			// The diff command is missing or failed; the file itself is the next best thing.
			await this.openerService.open(uri);
		}
	}
}
