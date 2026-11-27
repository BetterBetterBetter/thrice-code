/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { describeSessionBar, ThriceSessionBarState } from '../../../common/thriceSessionBar.js';
import './media/thriceSessionBar.css';

const $ = dom.$;

export interface ThriceSessionBarHandlers {
	checkout(): void;
	createPullRequest(): void;
	insertTaskList(): void;
	/**
	 * Opens the git Changes picker (this turn / this session / all uncommitted). Typically
	 * `() => showThriceChanges(commandService, widget.viewModel?.sessionResource)` from
	 * `../../thriceChanges.contribution.js`. The button is hidden when omitted.
	 */
	showChanges?(): void;
}

export class ThriceSessionBar extends Disposable {
	readonly domNode: HTMLElement;
	private readonly _items = this._register(new DisposableStore());

	constructor(parent: HTMLElement, private readonly handlers: ThriceSessionBarHandlers) {
		super();
		this.domNode = $('.thrice-session-bar');
		parent.prepend(this.domNode);
		this.update({ missingFolder: false, branch: undefined });
	}

	update(state: ThriceSessionBarState): void {
		const described = describeSessionBar(state);
		this._items.clear();
		dom.clearNode(this.domNode);

		if (described.missing) {
			const missing = dom.append(this.domNode, $('span.thrice-session-bar-missing'));
			missing.textContent = localize('thriceSessionBar.missing', "This chat's folder is missing.");
		}

		if (described.branch) {
			const branch = dom.append(this.domNode, $('button.thrice-session-bar-branch'));
			branch.setAttribute('type', 'button');
			branch.textContent = described.branch;
			branch.title = localize('thriceSessionBar.checkout', "Checkout a branch");
			this._items.add(dom.addDisposableListener(branch, dom.EventType.CLICK, () => this.handlers.checkout()));
			if (described.sync) {
				const sync = dom.append(branch, $('span.thrice-session-bar-sync'));
				sync.textContent = ` ${described.sync}`;
				branch.title = localize('thriceSessionBar.checkoutSync', "Checkout a branch ({0} compared with upstream)", described.sync);
			}
		}

		const showChanges = this.handlers.showChanges;
		if (described.showChanges && showChanges) {
			const changes = dom.append(this.domNode, $('button.thrice-session-bar-changes'));
			changes.setAttribute('type', 'button');
			changes.textContent = localize('thriceSessionBar.changes', "Changes");
			changes.title = localize('thriceSessionBar.changesTitle', "Show changes from this turn, this session, or all uncommitted work");
			this._items.add(dom.addDisposableListener(changes, dom.EventType.CLICK, () => showChanges.call(this.handlers)));
		}

		if (described.showPullRequest) {
			const pullRequest = dom.append(this.domNode, $('button.thrice-session-bar-pr'));
			pullRequest.setAttribute('type', 'button');
			pullRequest.textContent = localize('thriceSessionBar.pullRequest', "Create PR");
			this._items.add(dom.addDisposableListener(pullRequest, dom.EventType.CLICK, () => this.handlers.createPullRequest()));
		}

		const taskList = dom.append(this.domNode, $('button.thrice-session-bar-tasks'));
		taskList.setAttribute('type', 'button');
		taskList.textContent = localize('thriceSessionBar.taskList', "Task list");
		taskList.title = localize('thriceSessionBar.taskListTitle', "Insert a markdown task list");
		this._items.add(dom.addDisposableListener(taskList, dom.EventType.CLICK, () => this.handlers.insertTaskList()));
	}
}
