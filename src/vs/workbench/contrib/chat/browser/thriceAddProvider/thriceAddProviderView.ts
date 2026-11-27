/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { deriveInstanceId, launchArgumentsDescription, providerCredentialFields, providerShowsLaunchArguments, providerTextFields, THRICE_PROVIDER_DRIVERS, toProviderSettingEntry, validateProviderDraft, type ThriceProviderDraft, type ThriceProviderDriver } from '../../common/thriceProviderDraft.js';
import { providerLogoIcon } from '../../common/thriceProviderLogos.js';

const TITLE = localize('thriceAddProvider.title', "Add provider");
const STEP_LABELS = [
	localize('thriceAddProvider.provider', "Provider"),
	localize('thriceAddProvider.identity', "Identity"),
	localize('thriceAddProvider.config', "Config"),
] as const;
const CANCEL = localize('thriceAddProvider.cancel', "Cancel");
const BACK = localize('thriceAddProvider.back', "Back");
const NEXT = localize('thriceAddProvider.next', "Next");
const ADD = localize('thriceAddProvider.add', "Add provider");
const CONFIGURE_MANUALLY = localize('thriceAddProvider.configureManually', "Configure manually");
const CONTINUE_CHATGPT = localize('thriceAddProvider.continueChatGpt', "Continue with ChatGPT");
const CONTINUE_CLAUDE = localize('thriceAddProvider.continueClaude', "Continue with Claude");

type WizardStep = 0 | 1 | 2;

let nextViewId = 0;

export interface ThriceAddProviderViewOptions {
	readonly takenIds: readonly string[];
	readonly presentation?: 'dialog';
	readonly onAdd: (entry: ReturnType<typeof toProviderSettingEntry>) => void;
	readonly onCancel: () => void;
	/** Codex ChatGPT login, or Claude sign-in when the CLI is not installed. */
	readonly onAccountLogin?: (driver: 'claude' | 'codex') => void;
}

/**
 * Native three-step Add provider wizard. The matching stylesheet is
 * `media/thriceAddProvider.css`; a contribution loads it. The root element
 * uses the class `thrice-add-provider`.
 */
export class ThriceAddProviderView extends Disposable {

	private readonly viewId = ++nextViewId;
	private readonly bodyDisposables = this._register(new DisposableStore());
	private readonly argumentDisposables = this._register(new DisposableStore());

	private readonly root: HTMLElement;
	private readonly steps: HTMLElement;
	private readonly body: HTMLElement;
	private readonly error: HTMLElement;
	private readonly backButton: HTMLButtonElement;
	private readonly manualButton: HTMLButtonElement;
	private readonly primaryButton: HTMLButtonElement;
	private readonly stepButtons: HTMLButtonElement[] = [];

	private step: WizardStep = 0;
	private showMore = false;
	private driver: ThriceProviderDriver = 'claude';
	private displayName = '';
	private instanceId = '';
	/** Stays derived from the display name until the person edits the id. */
	private instanceIdEdited = false;
	private command = '';
	private homePath = '';
	private readonly credentialValues = new Map<string, string>();
	private readonly launchArgs: string[] = [];
	private argumentRows: HTMLElement | undefined;
	private accountNote: HTMLElement | undefined;
	/** False only after a PATH check finds no `claude` binary. */
	private claudeInstalled = true;

	constructor(
		container: HTMLElement,
		private readonly options: ThriceAddProviderViewOptions,
	) {
		super();

		this.root = append(container, $('.thrice-add-provider'));
		if (options.presentation === 'dialog') {
			this.root.classList.add('in-dialog');
		}
		const content = append(this.root, $('.content'));
		const header = append(content, $('.header'));
		if (options.presentation !== 'dialog') {
			const title = append(header, $('h1.title', undefined, TITLE));
			title.id = `thrice-add-provider-title-${this.viewId}`;
		}
		this.steps = append(header, $('nav.steps', { 'aria-label': localize('thriceAddProvider.steps', "Provider / Identity / Config") }));
		this.body = append(content, $('.body'));
		const footer = append(content, $('.footer'));
		this.error = append(footer, $('.error', { role: 'alert' }));
		this.error.hidden = true;
		const actions = append(footer, $('.actions'));
		this.backButton = $<HTMLButtonElement>('button.secondary.back', { type: 'button' }, BACK);
		this.manualButton = $<HTMLButtonElement>('button.secondary.manual', { type: 'button' }, CONFIGURE_MANUALLY);
		this.primaryButton = $<HTMLButtonElement>('button.primary', { type: 'button' }, NEXT);
		const cancelButton = $<HTMLButtonElement>('button.secondary.cancel', { type: 'button' }, CANCEL);
		append(actions, cancelButton, this.backButton, this.manualButton, this.primaryButton);

		this.buildSteps();
		this._register(addDisposableListener(cancelButton, 'click', () => this.options.onCancel()));
		this._register(addDisposableListener(this.backButton, 'click', () => this.back()));
		this._register(addDisposableListener(this.manualButton, 'click', () => this.goTo(1)));
		this._register(addDisposableListener(this.primaryButton, 'click', () => this.onPrimary()));
		this._register(addDisposableListener(this.root, 'keydown', event => this.onKeyDown(event)));
		this.render();
	}

	override dispose(): void {
		super.dispose();
		this.root.remove();
	}

	focus(): void {
		this.focusStep();
	}

	private buildSteps(): void {
		STEP_LABELS.forEach((label, index) => {
			if (index > 0) {
				append(this.steps, $('span.sep', { 'aria-hidden': 'true' }, '/'));
			}
			const button = append(this.steps, $<HTMLButtonElement>('button.step', { type: 'button' }, label));
			this.stepButtons.push(button);
			const step: WizardStep = index === 0 ? 0 : index === 1 ? 1 : 2;
			this._register(addDisposableListener(button, 'click', () => this.goTo(step)));
		});
	}

	/** Called once a PATH check knows whether `claude` is installed. */
	setClaudeInstalled(installed: boolean): void {
		this.claudeInstalled = installed;
		this.updateChrome();
	}

	private render(focus = true): void {
		this.argumentDisposables.clear();
		this.bodyDisposables.clear();
		clearNode(this.body);
		this.argumentRows = undefined;
		this.accountNote = undefined;
		this.updateChrome();
		if (this.step === 0) {
			this.renderProvider();
		} else if (this.step === 1) {
			this.renderIdentity();
		} else {
			this.renderConfig();
		}
		if (focus) {
			this.focusStep();
		}
	}

	private updateChrome(): void {
		const codexAccount = this.step === 0 && this.driver === 'codex';
		const claudeOauth = this.step === 0 && this.driver === 'claude' && !this.claudeInstalled;
		this.backButton.disabled = this.step === 0;
		this.manualButton.hidden = !codexAccount;
		this.primaryButton.textContent = codexAccount
			? CONTINUE_CHATGPT
			: claudeOauth
				? CONTINUE_CLAUDE
				: this.step === 2 ? ADD : NEXT;
		for (let index = 0; index < this.stepButtons.length; index++) {
			const button = this.stepButtons[index];
			const current = index === this.step;
			button.classList.toggle('current', current);
			if (current) {
				button.setAttribute('aria-current', 'step');
			} else {
				button.removeAttribute('aria-current');
			}
		}
	}

	private renderProvider(): void {
		const featured = THRICE_PROVIDER_DRIVERS.filter(option => option.group === 'featured');
		const more = THRICE_PROVIDER_DRIVERS.filter(option => option.group === 'more');
		const manual = THRICE_PROVIDER_DRIVERS.filter(option => option.group === 'manual');
		if (more.some(option => option.driver === this.driver)) {
			this.showMore = true;
		}
		const providers = $('.providers');
		append(providers, this.providerCards(featured, STEP_LABELS[0]));
		const manualCards = this.providerCards(manual, localize('thriceAddProvider.manual', "Add manually"));
		manualCards.classList.add('manual');
		append(providers, manualCards);
		const toggle = $<HTMLButtonElement>('button.more-toggle', {
			type: 'button',
			'aria-expanded': this.showMore ? 'true' : 'false',
		}, this.showMore
			? localize('thriceAddProvider.showLess', "Show less")
			: localize('thriceAddProvider.showMore', "Show more"));
		append(providers, toggle);
		this.bodyDisposables.add(addDisposableListener(toggle, 'click', () => {
			this.showMore = !this.showMore;
			this.render(false);
		}));
		if (this.showMore) {
			append(providers, $('p.more-heading', undefined, localize('thriceAddProvider.more', "More providers")));
			append(providers, this.providerCards(more, localize('thriceAddProvider.more', "More providers")));
		}
		this.accountNote = $('p.account-note', { role: 'note' });
		append(providers, this.accountNote);
		this.refreshAccountNote();
		this.bodyDisposables.add(addDisposableListener(providers, 'keydown', event => this.onCardKeyDown(event, providers)));
		append(this.body, providers);
	}

	private refreshAccountNote(): void {
		const note = this.accountNote;
		if (!note) {
			return;
		}
		const name = this.driver === 'claude' ? 'Claude' : this.driver === 'codex' ? 'Codex' : undefined;
		note.hidden = name === undefined;
		if (name) {
			note.textContent = localize('thriceAddProvider.multipleAccounts', "We do not recommend managing multiple {0} accounts. Thrice does not switch between them automatically, to avoid risking a provider ban.", name);
		}
	}

	private providerCards(options: readonly { driver: ThriceProviderDriver; label: string }[], label: string): HTMLElement {
		const cards = $('.cards', { role: 'radiogroup', 'aria-label': label });
		for (const option of options) {
			const selected = option.driver === this.driver;
			const card = $<HTMLButtonElement>('button.card', {
				type: 'button',
				role: 'radio',
				'data-driver': option.driver,
				'aria-checked': selected ? 'true' : 'false',
			});
			card.tabIndex = selected ? 0 : -1;
			if (selected) {
				card.classList.add('selected');
			}
			append(card, this.icon(providerLogoIcon(option.driver), 'card-icon'), $('span.label', undefined, option.label), this.icon(Codicon.check, 'check'));
			append(cards, card);
			this.bodyDisposables.add(addDisposableListener(card, 'click', () => {
				this.driver = option.driver;
				this.clearError();
				this.updateCardSelection();
				this.refreshAccountNote();
				this.updateChrome();
			}));
		}
		return cards;
	}

	private onCardKeyDown(event: KeyboardEvent, cards: HTMLElement): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') {
			return;
		}
		const current = event.target;
		if (!(current instanceof HTMLButtonElement) || !current.classList.contains('card')) {
			return;
		}
		event.preventDefault();
		const buttons = [...cards.querySelectorAll<HTMLButtonElement>('.card')];
		const index = buttons.indexOf(current);
		if (index < 0 || buttons.length === 0) {
			return;
		}
		const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
		const next = buttons[(index + delta + buttons.length) % buttons.length];
		next.focus();
		next.click();
	}

	private updateCardSelection(): void {
		for (const card of this.body.querySelectorAll<HTMLButtonElement>('.card')) {
			const selected = card.dataset.driver === this.driver;
			card.classList.toggle('selected', selected);
			card.setAttribute('aria-checked', selected ? 'true' : 'false');
			card.tabIndex = selected ? 0 : -1;
		}
	}

	private renderIdentity(): void {
		this.applyDerivedInstanceId();
		const nameLabel = localize('thriceAddProvider.displayName', "Label");
		const idLabel = localize('thriceAddProvider.instanceId', "Instance ID");
		const name = $<HTMLInputElement>('input.display-name', {
			type: 'text',
			value: this.displayName,
			autocomplete: 'off',
			placeholder: localize('thriceAddProvider.displayNamePlaceholder', "Work {0}", this.driverLabel()),
		});
		const id = $<HTMLInputElement>('input.instance-id', {
			type: 'text',
			value: this.instanceId,
			autocomplete: 'off',
			autocapitalize: 'off',
			spellcheck: 'false',
			placeholder: localize('thriceAddProvider.instanceIdPlaceholder', "work-claude"),
		});
		const nameHelp = $('p.helper', undefined, localize('thriceAddProvider.displayNameHelp', "Shown in the provider list."));
		const helper = $('p.helper', undefined, localize(
			'thriceAddProvider.instanceIdHelp',
			"Starts with a letter or digit and may include '.', '_', or '-'. Filled in from the label until you edit it.",
		));
		helper.id = `thrice-add-provider-instance-help-${this.viewId}`;
		id.setAttribute('aria-describedby', helper.id);

		const nameField = this.labeledField(nameLabel, name);
		append(nameField, nameHelp);
		append(this.body, nameField);
		const idField = this.labeledField(idLabel, id);
		append(idField, helper);
		append(this.body, idField);

		this.bodyDisposables.add(addDisposableListener(name, 'input', () => {
			this.displayName = name.value;
			this.applyDerivedInstanceId();
			this.clearError();
		}));
		this.bodyDisposables.add(addDisposableListener(id, 'input', () => {
			this.instanceIdEdited = true;
			this.instanceId = id.value;
			this.clearError();
		}));
	}

	private renderConfig(): void {
		const fields = providerTextFields(this.driver);
		const launchArguments = providerShowsLaunchArguments(this.driver);
		if (fields.length === 0 && !launchArguments) {
			append(this.body, $('p.empty-config', undefined, localize('thriceAddProvider.noConfiguration', "This driver has no required configuration. You can add the instance now.")));
			return;
		}
		for (const field of fields) {
			const value = field.key === 'command' ? this.command : this.homePath;
			const input = $<HTMLInputElement>(`input.${field.key}`, {
				type: 'text',
				value,
				placeholder: field.placeholder,
				autocomplete: 'off',
				spellcheck: 'false',
			});
			const row = this.settingRow(field.label, field.description, input);
			append(this.body, row);
			this.bodyDisposables.add(addDisposableListener(input, 'input', () => {
				if (field.key === 'command') {
					this.command = input.value;
				} else {
					this.homePath = input.value;
				}
				this.clearError();
			}));
		}

		for (const field of providerCredentialFields(this.driver)) {
			const input = $<HTMLInputElement>(`input.credential`, {
				type: field.secret ? 'password' : 'text',
				value: this.credentialValues.get(field.name) ?? '',
				placeholder: localize('thriceAddProvider.credentialPlaceholder', "From this machine"),
				autocomplete: 'off',
				spellcheck: 'false',
			});
			append(this.body, this.settingRow(field.label, field.description, input));
			this.bodyDisposables.add(addDisposableListener(input, 'input', () => {
				this.credentialValues.set(field.name, input.value);
				this.clearError();
			}));
		}

		if (!launchArguments) {
			return;
		}
		append(this.body, $('div.section-label', undefined, localize('thriceAddProvider.launchArguments', "Launch arguments")));
		append(this.body, $('p.helper', undefined, launchArgumentsDescription(this.driver)));
		this.argumentRows = append(this.body, $('.rows'));
		this.renderArgumentRows();
		const addArgument = this.addButton(
			'add-argument',
			localize('thriceAddProvider.addArgument', "Add argument"),
		);
		append(this.body, addArgument);
		this.bodyDisposables.add(addDisposableListener(addArgument, 'click', () => this.addArgument()));
	}

	private renderArgumentRows(): void {
		const rows = this.argumentRows;
		if (!rows) {
			return;
		}
		this.argumentDisposables.clear();
		clearNode(rows);
		this.launchArgs.forEach((value, index) => {
			const row = append(rows, $('.row'));
			const input = $<HTMLInputElement>('input.arg', {
				type: 'text',
				value,
				spellcheck: 'false',
				autocomplete: 'off',
				placeholder: localize('thriceAddProvider.argumentPlaceholder', "Argument"),
				'aria-label': localize('thriceAddProvider.argumentLabel', "Launch argument {0}", index + 1),
			});
			const removeLabel = localize('thriceAddProvider.removeArgument', "Remove argument {0}", index + 1);
			const remove = this.removeButton(removeLabel);
			append(row, input);
			append(row, remove);
			this.argumentDisposables.add(addDisposableListener(input, 'input', () => {
				this.launchArgs[index] = input.value;
				this.clearError();
			}));
			this.argumentDisposables.add(addDisposableListener(remove, 'click', () => {
				this.launchArgs.splice(index, 1);
				this.renderArgumentRows();
			}));
		});
	}

	private settingRow(label: string, description: string, control: HTMLElement): HTMLElement {
		const row = $('.setting');
		const copy = append(row, $('.copy'));
		append(copy, $('div.setting-label', undefined, label));
		append(copy, $('p.helper', undefined, description));
		append(row, control);
		return row;
	}

	private labeledField(label: string, control: HTMLElement): HTMLElement {
		const field = $('.field');
		const labelElement = $('label.field-label');
		append(labelElement, $('span', undefined, label), control);
		append(field, labelElement);
		return field;
	}

	private addButton(className: string, label: string): HTMLButtonElement {
		const button = $<HTMLButtonElement>(`button.secondary.add.${className}`, { type: 'button' });
		append(button, this.icon(Codicon.add), label);
		return button;
	}

	private removeButton(label: string): HTMLButtonElement {
		const button = $<HTMLButtonElement>('button.secondary.icon', {
			type: 'button',
			'aria-label': label,
			title: label,
		});
		append(button, this.icon(Codicon.close));
		return button;
	}

	private icon(icon: ThemeIcon, className?: string): HTMLElement {
		const element = $(`span${ThemeIcon.asCSSSelector(icon)}`);
		if (className) {
			element.classList.add(className);
		}
		element.setAttribute('aria-hidden', 'true');
		return element;
	}

	private driverLabel(): string {
		return THRICE_PROVIDER_DRIVERS.find(item => item.driver === this.driver)?.label ?? this.driver;
	}

	private applyDerivedInstanceId(): void {
		if (this.instanceIdEdited) {
			return;
		}
		const next = this.displayName.trim()
			? deriveInstanceId(this.displayName, this.options.takenIds)
			: '';
		this.instanceId = next;
		const input = this.body.querySelector<HTMLInputElement>('.instance-id');
		if (input && input.value !== next) {
			input.value = next;
		}
	}

	private draft(): ThriceProviderDraft {
		return {
			driver: this.driver,
			displayName: this.displayName,
			instanceId: this.instanceId,
			command: this.command,
			homePath: this.homePath,
			launchArgs: this.launchArgs.slice(),
			credentials: providerCredentialFields(this.driver).map(field => ({
				name: field.name,
				value: this.credentialValues.get(field.name) ?? '',
			})),
			environment: [],
		};
	}

	private prepareDraft(): ThriceProviderDraft {
		this.applyDerivedInstanceId();
		return this.draft();
	}

	private addArgument(): void {
		this.launchArgs.push('');
		this.renderArgumentRows();
		const inputs = this.argumentRows?.querySelectorAll<HTMLInputElement>('input');
		inputs?.item(inputs.length - 1)?.focus();
	}

	private focusStep(): void {
		if (this.step === 0) {
			this.body.querySelector<HTMLButtonElement>('.card.selected')?.focus();
			return;
		}
		if (this.step === 1) {
			this.body.querySelector<HTMLInputElement>('.display-name')?.focus();
			return;
		}
		this.body.querySelector<HTMLInputElement>('.command')?.focus();
	}

	private focusCorrection(): void {
		if (this.step === 2) {
			this.body.querySelector<HTMLElement>('.env-name, .add-environment')?.focus();
			return;
		}
		const name = this.body.querySelector<HTMLInputElement>('.display-name');
		if (!name || name.value.trim() === '') {
			name?.focus();
			return;
		}
		this.body.querySelector<HTMLInputElement>('.instance-id')?.focus();
	}

	/** Name and id failures stay on Identity. Environment-variable failures open Config, where those rows are. */
	private correctionStep(message: string): WizardStep {
		return /environment variable/i.test(message) ? 2 : 1;
	}

	private revealValidation(message: string): void {
		this.showError(message);
		const step = this.correctionStep(message);
		if (this.step !== step) {
			this.step = step;
			this.render(false);
		}
		this.focusCorrection();
	}

	private showError(message: string): void {
		this.error.hidden = true;
		this.error.textContent = message;
		this.error.hidden = false;
	}

	private clearError(): void {
		this.error.hidden = true;
		this.error.textContent = '';
	}

	private goTo(step: WizardStep): void {
		if (step === this.step) {
			return;
		}
		if (step > this.step && step > 1) {
			const result = validateProviderDraft(this.prepareDraft(), this.options.takenIds);
			if (!result.ok) {
				this.revealValidation(result.message);
				return;
			}
		}
		this.clearError();
		this.step = step;
		this.render();
	}

	private back(): void {
		if (this.step === 0) {
			return;
		}
		this.goTo(this.step === 1 ? 0 : 1);
	}

	private onPrimary(): void {
		if (this.step === 0 && this.driver === 'codex') {
			this.options.onAccountLogin?.('codex');
			return;
		}
		if (this.step === 0 && this.driver === 'claude' && !this.claudeInstalled) {
			this.showError(localize('thriceAddProvider.installClaude', "Install Claude Code in the browser, then run claude auth login."));
			this.options.onAccountLogin?.('claude');
			return;
		}
		if (this.step === 2) {
			this.submit();
			return;
		}
		this.goTo(this.step === 0 ? 1 : 2);
	}

	private submit(): void {
		const draft = this.prepareDraft();
		const result = validateProviderDraft(draft, this.options.takenIds);
		if (!result.ok) {
			this.revealValidation(result.message);
			return;
		}
		this.clearError();
		this.options.onAdd(toProviderSettingEntry(draft));
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.repeat || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		if (this.step === 2) {
			return;
		}
		const target = event.target;
		if (target instanceof HTMLButtonElement && !target.classList.contains('card')) {
			return;
		}
		event.preventDefault();
		this.onPrimary();
	}
}
