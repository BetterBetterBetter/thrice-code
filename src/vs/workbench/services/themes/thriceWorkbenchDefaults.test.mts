import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const themeService = readFileSync(new URL('./common/workbenchThemeService.ts', import.meta.url), 'utf8');
const contribution = readFileSync(new URL('../../browser/workbench.contribution.ts', import.meta.url), 'utf8');
const product = readFileSync(new URL('../../../../../product.json', import.meta.url), 'utf8');

function activityBarBlock(): string {
	const start = contribution.indexOf('[LayoutSettings.ACTIVITY_BAR_LOCATION]: {');
	const end = contribution.indexOf('[LayoutSettings.ACTIVITY_BAR_AUTO_HIDE]:');
	assert.ok(start >= 0 && end > start);
	return contribution.slice(start, end);
}

test('the dark color theme defaults to Dark Modern', () => {
	assert.match(themeService, /export const COLOR_THEME_DARK = 'Dark Modern';/);
});

test('legacy 2026 theme ids stay on Dark 2026', () => {
	const migration = themeService.slice(themeService.indexOf('function migrateThemeSettingsId'), themeService.indexOf('export const COLOR_THEME_DARK_INITIAL_COLORS'));
	assert.match(migration, /case 'Experimental Dark':/);
	assert.match(migration, /case 'VS Code Dark':\s*return 'Dark 2026';/);
});

test('the activity bar defaults to the top of the side bar', () => {
	const block = activityBarBlock();
	assert.match(block, /'default': 'top'/);
	assert.match(block, /agentsWindow: \{ default: 'default', readOnly: true \}/);
});

test('onboarding offers Dark Modern as the dark theme', () => {
	const onboarding = JSON.parse(product).onboardingThemes as { themeId: string; type: string }[];
	assert.equal(onboarding.find(theme => theme.type === 'dark' && !theme.themeId.includes('High'))?.themeId, 'Dark Modern');
});

const chatActions = readFileSync(new URL('../../contrib/chat/browser/actions/chatActions.ts', import.meta.url), 'utf8');
const chatNewActions = readFileSync(new URL('../../contrib/chat/browser/actions/chatNewActions.ts', import.meta.url), 'utf8');
const watermark = readFileSync(new URL('../../browser/parts/editor/editorGroupWatermark.ts', import.meta.url), 'utf8');

test('Ctrl+I or Cmd+I opens and closes the chat window', () => {
	const toggle = chatActions.slice(chatActions.indexOf('class ToggleChatAction'), chatActions.indexOf('registerAction2(class NewChatEditorAction'));
	assert.match(chatActions, /const TOGGLE_CHAT_ACTION_ID = 'workbench\.action\.chat\.toggle'/);
	assert.match(toggle, /id: TOGGLE_CHAT_ACTION_ID/);
	assert.match(toggle, /weight: 1600/);
	assert.match(toggle, /primary: KeyMod\.CtrlCmd \| KeyCode\.KeyI/);
	assert.match(toggle, /IChatViewHostService/);
	assert.match(toggle, /\.toggle\(\)/);
	const open = chatActions.slice(chatActions.indexOf('class PrimaryOpenChatGlobalAction'), chatActions.indexOf('export function getOpenChatActionIdForMode'));
	assert.match(open, /KeyMod\.Alt \| KeyCode\.KeyI/);
});

test('the empty editor splash lists Cursor shortcuts', () => {
	for (const label of ['New Agent', 'Show Terminal', 'Hide Terminal', 'Show Files', 'Search Files', 'Open Browser', 'Maximize Chat', 'Add Folder', 'Add Repository']) {
		assert.match(watermark, new RegExp(`"${label}"`));
	}
	const splash = watermark.slice(watermark.indexOf('private splashEntries'), watermark.indexOf('private addFolderEntries'));
	assert.match(watermark, /id: 'workbench\.action\.chat\.newAgent'/);
	const newAgent = chatNewActions.slice(chatNewActions.indexOf('class NewAgentChatAction'), chatNewActions.indexOf('export const NEW_CHAT_ICON_VARIANTS'));
	assert.match(newAgent, /workbench\.action\.chat\.newAgent/);
	assert.match(newAgent, /weight: 1600/);
	assert.match(newAgent, /KeyMod\.CtrlCmd \| KeyMod\.Shift \| KeyCode\.KeyL/);
	const order = ['newAgent', 'showTerminal', 'showFiles', 'searchFiles', 'openBrowser', 'maximizeChat', 'addFolderEntries'];
	let at = 0;
	for (const id of order) {
		const next = splash.indexOf(id, at);
		assert.ok(next > at, id);
		at = next + id.length;
	}
});

const auxiliaryBarActions = readFileSync(new URL('../../browser/parts/auxiliarybar/auxiliaryBarActions.ts', import.meta.url), 'utf8');
const workspaceActions = readFileSync(new URL('../../browser/actions/workspaceActions.ts', import.meta.url), 'utf8');

test('maximize chat uses Ctrl+Alt+E or Cmd+Opt+E and fills the window with the chat side bar', () => {
	const action = auxiliaryBarActions.slice(auxiliaryBarActions.indexOf('class MaximizeChatSizeAction'), auxiliaryBarActions.indexOf('registerAction2(MaximizeChatSizeAction)') + 40);
	assert.match(action, /workbench\.action\.maximizeChatSize/);
	assert.match(action, /weight: 1600/);
	assert.match(action, /KeyMod\.CtrlCmd \| KeyMod\.Alt \| KeyCode\.KeyE/);
	assert.match(action, /toggleMaximizedAuxiliaryBar\(\)/);
	assert.match(action, /WorkbenchState\.EMPTY/);
});

test('add folder uses Ctrl+Alt+A or Cmd+Opt+A in a folder window', () => {
	const action = workspaceActions.slice(workspaceActions.indexOf('class AddRootFolderAction'), workspaceActions.indexOf('class RemoveRootFolderAction'));
	assert.match(action, /weight: 1600/);
	assert.match(action, /KeyMod\.CtrlCmd \| KeyMod\.Alt \| KeyCode\.KeyA/);
	assert.match(action, /WorkbenchStateContext\.isEqualTo\('folder'\)/);
});

const panelActions = readFileSync(new URL('../../browser/parts/panel/panelActions.ts', import.meta.url), 'utf8');
const quickAccessActions = readFileSync(new URL('../../browser/actions/quickAccessActions.ts', import.meta.url), 'utf8');
const explorerViewlet = readFileSync(new URL('../../contrib/files/browser/explorerViewlet.ts', import.meta.url), 'utf8');
const browserActions = readFileSync(new URL('../../contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts', import.meta.url), 'utf8');

test('show terminal, search files, and show files use the same shortcut priority as opening chat', () => {
	assert.match(panelActions.slice(panelActions.indexOf('class TogglePanelAction'), panelActions.indexOf('registerAction2(TogglePanelAction)')), /weight: 1600/);
	const quickOpen = quickAccessActions.slice(quickAccessActions.indexOf("id: 'workbench.action.quickOpen'"), quickAccessActions.indexOf("id: 'workbench.action.quickOpenWithModes'"));
	assert.match(quickOpen, /weight: 1600/);
	assert.match(explorerViewlet, /primary: KeyMod\.CtrlCmd \| KeyMod\.Shift \| KeyCode\.KeyE, weight: 1600/);
});

test('open browser has no shortcut of its own, matching Cursor', () => {
	const action = browserActions.slice(browserActions.indexOf('class OpenBrowserTabAction'), browserActions.indexOf('class OpenIntegratedBrowserAction'));
	assert.match(action, /composer\.openBrowserTab/);
	assert.doesNotMatch(action, /keybinding:/);
	assert.match(action, /BrowserEditorInput/);
	assert.match(action, /BrowserViewCommandId\.Open/);
	const list = browserActions.slice(browserActions.indexOf('class OpenOrListBrowsersAction'), browserActions.indexOf('async run(accessor: ServicesAccessor): Promise<void> {\n\t\tconst browserViewService'));
	assert.match(list, /KeyMod\.CtrlCmd \| KeyMod\.Alt \| KeyCode\.Slash/);
});
