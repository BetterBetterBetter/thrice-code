/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { GeneralShellType } from '../../../../../platform/terminal/common/terminal.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';

/**
 * Agent CLIs that can run in a terminal. Kept in sync with
 * `TerminalLabelComputer.agentCliShellTypes`.
 */
const agentCliShellTypes: ReadonlySet<string> = new Set([
	GeneralShellType.Claude,
	GeneralShellType.Codex,
	GeneralShellType.CommandCode,
	GeneralShellType.Copilot,
	GeneralShellType.Gemini,
]);

/**
 * Agent CLIs put a braille spinner frame (U+2800-U+28FF) at the start of their OSC title
 * while they work, then swap it for a static glyph (for example `✳`) once they go idle.
 */
const busyTitlePattern = /^\s*[⠀-⣿]/;

/**
 * Several of the signals below can describe the same turn ending (a title change followed
 * by a bell or notification), so only one sound plays inside this window.
 */
const dedupeWindowMs = 3000;

/**
 * Plays {@link AccessibilitySignal.agentFinished} when an agent CLI running in this terminal
 * finishes a turn. A turn has ended when any of these happens:
 * - the OSC title goes from a busy spinner frame to a non-spinner title
 * - the agent rings the bell (BEL)
 * - the agent sends a desktop notification (OSC 9 or OSC 777;notify)
 */
class TerminalAgentSignalsContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.agentSignals';

	private _busy = false;
	private _lastSignalTime = 0;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IAccessibilitySignalService private readonly _accessibilitySignalService: IAccessibilitySignalService,
	) {
		super();
		this._register(this._ctx.instance.onDidChangeShellType(() => {
			if (!this._isAgent()) {
				this._busy = false;
			}
		}));
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._register(xterm.raw.onTitleChange(title => {
			const busy = busyTitlePattern.test(title);
			if (this._busy && !busy) {
				this._signal();
			}
			this._busy = busy && this._isAgent();
		}));
		this._register(xterm.raw.onBell(() => this._signal()));
		// Return false so other handlers, such as OSC 9;4 progress, still see the sequence.
		this._register(xterm.raw.parser.registerOscHandler(9, data => {
			if (!data.startsWith('4;')) {
				this._signal();
			}
			return false;
		}));
		this._register(xterm.raw.parser.registerOscHandler(777, data => {
			if (data.startsWith('notify;')) {
				this._signal();
			}
			return false;
		}));
	}

	private _isAgent(): boolean {
		const shellType = this._ctx.instance.shellType;
		return shellType !== undefined && agentCliShellTypes.has(shellType);
	}

	private _signal(): void {
		if (!this._isAgent()) {
			return;
		}
		const now = Date.now();
		if (now - this._lastSignalTime < dedupeWindowMs) {
			return;
		}
		this._lastSignalTime = now;
		this._busy = false;
		this._accessibilitySignalService.playSignal(AccessibilitySignal.agentFinished, { allowManyInParallel: true });
	}
}

registerTerminalContribution(TerminalAgentSignalsContribution.ID, TerminalAgentSignalsContribution);
