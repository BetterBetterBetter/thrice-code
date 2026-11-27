/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../../../editor/browser/editorBrowser.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { ghostTextSuffix } from '../../../../common/thriceGhostText.js';

/**
 * The Copilot setting that opts into inline completions in chat inputs.
 */
export const chatInputInlineCompletionsSetting = 'github.copilot.completions.chat.enabled';

/** Suggests the rest of a message from chat history. */
export const thriceChatGhostTextSetting = 'thrice.chat.ghostText.enabled';

export interface IThriceGhostTextOptions {
	readonly languageFeaturesService: ILanguageFeaturesService;
	history(): readonly string[];
}

function inlineSuggestionsEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(chatInputInlineCompletionsSetting) === true
		|| configurationService.getValue<boolean>(thriceChatGhostTextSetting) === true;
}

/**
 * Turns automatic inline suggestions in a chat input editor on while Copilot chat
 * completions or Thrice ghost text are enabled. Otherwise, every keystroke would
 * query inline completion providers that match the plaintext input document.
 * Inline suggestions can still be triggered explicitly.
 */
export function bindChatInputInlineSuggestions(editor: ICodeEditor, configurationService: IConfigurationService, ghost?: IThriceGhostTextOptions): IDisposable {
	const store = new DisposableStore();
	const update = () => editor.updateOptions({
		inlineSuggest: { enabled: inlineSuggestionsEnabled(configurationService) },
	});
	update();
	store.add(configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(chatInputInlineCompletionsSetting) || e.affectsConfiguration(thriceChatGhostTextSetting)) {
			update();
		}
	}));
	if (ghost) {
		store.add(ghost.languageFeaturesService.inlineCompletionsProvider.register({ language: 'chatinput' }, {
			provideInlineCompletions(model, position) {
				if (configurationService.getValue<boolean>(thriceChatGhostTextSetting) !== true) {
					return { items: [] };
				}
				if (position.column !== model.getLineMaxColumn(position.lineNumber)) {
					return { items: [] };
				}
				const prefix = model.getValueInRange({
					startLineNumber: 1,
					startColumn: 1,
					endLineNumber: position.lineNumber,
					endColumn: position.column,
				});
				const suffix = ghostTextSuffix(ghost.history(), prefix);
				if (!suffix) {
					return { items: [] };
				}
				return {
					items: [{
						insertText: suffix,
						range: {
							startLineNumber: position.lineNumber,
							startColumn: position.column,
							endLineNumber: position.lineNumber,
							endColumn: position.column,
						},
					}],
				};
			},
			disposeInlineCompletions() { },
		}));
	}
	return store;
}
