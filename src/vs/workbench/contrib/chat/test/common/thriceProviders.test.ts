/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chatSessionProviderIcon, type ThriceChatProvider } from '../../common/thriceProviders.js';

const providers: readonly ThriceChatProvider[] = [
	{ id: 'claude', label: 'Claude', driver: 'claude', builtIn: true },
	{ id: 'codex', label: 'Codex', driver: 'codex', builtIn: true },
	{ id: 'cursor', label: 'Cursor', driver: 'cursor', builtIn: false },
	{ id: 'claude-hub', label: 'Claude Hub', driver: 'claude', builtIn: true },
	{ id: 'grok-hub', label: 'Grok Hub', driver: 'opencode', builtIn: true },
];

suite('chatSessionProviderIcon', () => {

	test('uses the logo of the provider the session selected', () => {
		assert.deepStrictEqual([
			chatSessionProviderIcon('cursor', providers)?.id,
			chatSessionProviderIcon('claude-hub', providers)?.id,
			chatSessionProviderIcon('grok-hub', providers)?.id,
			chatSessionProviderIcon('codex', providers)?.id,
		], [
			'thrice-logo-cursor',
			'thrice-logo-claude',
			'thrice-logo-grok',
			'thrice-logo-codex',
		]);
	});

	test('an unknown provider has no logo', () => {
		assert.strictEqual(chatSessionProviderIcon('local', providers), undefined);
		assert.strictEqual(chatSessionProviderIcon(undefined, providers), undefined);
	});
});
