/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { agentWindowShellCommandArgs, agentWindowShellMetadata, agentWindowShellSessionName, readAgentWindowShellParameters } from '../../browser/tools/agentWindowShell.js';

suite('agentWindowShell', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes the command to a unix shell with -c after the profile arguments', () => {
		deepStrictEqual(
			agentWindowShellCommandArgs('/bin/zsh', ['--login'], 'echo hi'),
			['--login', '-c', 'echo hi'],
		);
	});

	test('uses /c for cmd.exe', () => {
		deepStrictEqual(
			agentWindowShellCommandArgs('C:\\Windows\\System32\\cmd.exe', [], 'dir'),
			['/c', 'dir'],
		);
	});

	test('marks the terminal agent-owned', () => {
		deepStrictEqual(agentWindowShellMetadata('session-1'), {
			agentOwned: true,
			conversationId: 'session-1',
		});
	});

	test('reads command and working_directory', () => {
		deepStrictEqual(readAgentWindowShellParameters({ command: 'ls', working_directory: '/repo' }), {
			command: 'ls',
			workingDirectory: '/repo',
			keepOpen: false,
		});
		deepStrictEqual(readAgentWindowShellParameters({ command: 'claude', keep_open: true }), {
			command: 'claude',
			workingDirectory: undefined,
			keepOpen: true,
		});
		strictEqual(readAgentWindowShellParameters({ command: '   ' }), undefined);
		strictEqual(readAgentWindowShellParameters({}), undefined);
	});

	test('names a kept-open terminal after the command', () => {
		strictEqual(agentWindowShellSessionName('claude'), 'claude');
		strictEqual(agentWindowShellSessionName('/usr/local/bin/claude --resume'), 'claude');
	});
});
