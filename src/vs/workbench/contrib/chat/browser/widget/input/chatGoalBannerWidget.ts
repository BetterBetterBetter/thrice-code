/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';
import './media/chatGoalBannerWidget.css';

const $ = dom.$;

/**
 * Slim banner that surfaces the current turn above the chat input.
 * Shows the objective, how long the turn has been running, stop, and dismiss.
 *
 * The widget is purely presentational — owners drive its content with
 * {@link setLoading}, {@link setGoal}, and {@link clear}, and observe dismissals via
 * {@link onDismiss}.
 */
export class ChatGoalBannerWidget extends Disposable {

	readonly domNode: HTMLElement;

	private readonly _bannerEl: HTMLElement;
	private readonly _textEl: HTMLElement;
	private readonly _elapsedEl: HTMLElement;
	private readonly _onDismissEmitter = this._register(new Emitter<void>());
	private _onStop: (() => void) | undefined;
	private _startedAt: number | undefined;
	private _elapsedTimer: ReturnType<Window['setInterval']> | undefined;
	readonly onDismiss = this._onDismissEmitter.event;
	private _slot: HTMLElement | undefined;
	private _visible = false;

	/** Add the banner to its slot in the chat input stack. */
	attachTo(slot: HTMLElement): void {
		this._slot = slot;
		slot.appendChild(this.domNode);
		setChatInputStackSlot(slot, this._visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
	}

	constructor() {
		super();

		this.domNode = $('.chat-goal-banner-widget');

		this._bannerEl = dom.append(this.domNode, $('.chat-goal-banner'));

		const iconEl = dom.append(this._bannerEl, $('.chat-goal-banner-icon'));
		iconEl.appendChild($(ThemeIcon.asCSSSelector(Codicon.target)));

		const labelEl = dom.append(this._bannerEl, $('.chat-goal-banner-label'));
		labelEl.textContent = localize('chat.goalBanner.label', "Goal");

		this._textEl = dom.append(this._bannerEl, $('.chat-goal-banner-text'));
		this._elapsedEl = dom.append(this._bannerEl, $('.chat-goal-banner-elapsed'));

		const stopBtn = dom.append(this._bannerEl, $('button.chat-goal-banner-stop'));
		stopBtn.setAttribute('type', 'button');
		stopBtn.textContent = localize('chat.goalBanner.stop', "Stop");
		this._register(dom.addDisposableListener(stopBtn, dom.EventType.CLICK, () => this._onStop?.()));

		const dismissBtn = dom.append(this._bannerEl, $('button.chat-goal-banner-dismiss'));
		dismissBtn.title = localize('chat.goalBanner.dismiss', "Dismiss");
		dismissBtn.setAttribute('aria-label', localize('chat.goalBanner.dismiss', "Dismiss"));
		dismissBtn.appendChild($(ThemeIcon.asCSSSelector(Codicon.closeSmall)));
		this._register(dom.addDisposableListener(dismissBtn, dom.EventType.CLICK, () => {
			this.clear();
			this._onDismissEmitter.fire();
		}));

		this.clear();
	}

	override dispose(): void {
		this._stopElapsed();
		super.dispose();
	}

	setStopHandler(onStop: (() => void) | undefined): void {
		this._onStop = onStop;
	}

	setLoading(): void {
		this._textEl.textContent = localize('chat.goalBanner.loading', "Determining goal…");
		this._textEl.classList.add('loading');
		this._ensureElapsed();
		this._show();
	}

	setGoal(summary: string): void {
		const trimmed = summary.trim();
		if (!trimmed) {
			this.clear();
			return;
		}
		this._textEl.textContent = trimmed;
		this._textEl.classList.remove('loading');
		this._bannerEl.title = trimmed;
		this._ensureElapsed();
		this._show();
	}

	clear(): void {
		this._textEl.textContent = '';
		this._textEl.classList.remove('loading');
		this._bannerEl.removeAttribute('title');
		this._elapsedEl.textContent = '';
		this._onStop = undefined;
		this._startedAt = undefined;
		this._stopElapsed();
		this._setVisible(false);
	}

	private _ensureElapsed(): void {
		if (this._startedAt === undefined) {
			this._startedAt = Date.now();
		}
		this._renderElapsed();
		if (this._elapsedTimer === undefined) {
			const window = dom.getWindow(this.domNode);
			this._elapsedTimer = window.setInterval(() => this._renderElapsed(), 1000);
		}
	}

	private _renderElapsed(): void {
		if (this._startedAt === undefined) {
			this._elapsedEl.textContent = '';
			return;
		}
		const total = Math.max(0, Math.floor((Date.now() - this._startedAt) / 1000));
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		this._elapsedEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}

	private _stopElapsed(): void {
		if (this._elapsedTimer !== undefined) {
			dom.getWindow(this.domNode).clearInterval(this._elapsedTimer);
			this._elapsedTimer = undefined;
		}
	}

	private _show(): void {
		this._setVisible(true);
	}

	private _setVisible(visible: boolean): void {
		this._visible = visible;
		this.domNode.style.display = visible ? '' : 'none';
		setChatInputStackSlot(this._slot, visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
	}
}
