import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CHAT_SESSION_TAB_MAX_WIDTH, chatHistoryColumnWidth, chatHistoryEdge, chatHistoryEntries, chatHistoryGroups, chatHistorySections, chatHistoryPreferredWidth, chatSessionRunActivity, filterChatHistoryEntries, chatSessionTabLabel, chatSessionTabs, listSubagentChats } from './chatSessionTabs.ts';

const chatViewPane = readFileSync(new URL('./chatViewPane.ts', import.meta.url), 'utf8');
const chatEditors = readFileSync(new URL('./auxiliaryBarChatEditors.ts', import.meta.url), 'utf8');
const chatHistoryMenu = readFileSync(new URL('./chatSessionHistoryMenu.ts', import.meta.url), 'utf8');
const auxiliaryBarPart = readFileSync(new URL('../../../../../browser/parts/auxiliarybar/auxiliaryBarPart.ts', import.meta.url), 'utf8');
const auxiliaryBarCss = readFileSync(new URL('../../../../../browser/parts/auxiliarybar/media/auxiliaryBarPart.css', import.meta.url), 'utf8');
const chatEditorCss = readFileSync(new URL('../editor/media/chatEditor.css', import.meta.url), 'utf8');
const chatViewCss = readFileSync(new URL('./media/chatViewPane.css', import.meta.url), 'utf8');
const chatEditorInput = readFileSync(new URL('../editor/chatEditorInput.ts', import.meta.url), 'utf8');
const runningSubagents = readFileSync(new URL('../../widget/input/runningSubagentsRow.ts', import.meta.url), 'utf8');
const chatInputPart = readFileSync(new URL('../../widget/input/chatInputPart.ts', import.meta.url), 'utf8');
const chatCss = readFileSync(new URL('../../widget/media/chat.css', import.meta.url), 'utf8');
const openSubagent = readFileSync(new URL('../../widget/chatContentParts/chatSubagentOpenChat.ts', import.meta.url), 'utf8');
const resourceLabels = readFileSync(new URL('../../../../../browser/labels.ts', import.meta.url), 'utf8');

test('a session tab uses the session title and no icon', () => {
	assert.equal(chatSessionTabLabel('Fix the chat window', 'New Chat'), 'Fix the chat window');
	assert.equal(chatSessionTabLabel('  ', 'New Chat'), 'New Chat');
	assert.equal(chatSessionTabLabel(undefined, 'New Chat'), 'New Chat');
});

test('session tabs are the open sessions, with the current one selected', () => {
	const tabs = chatSessionTabs([
		{ sessionResource: 'chat-b', title: 'Second', lastMessageDate: 20 },
		{ sessionResource: 'chat-a', title: '', lastMessageDate: 10 },
		{ sessionResource: 'chat-b', title: 'Second renamed', lastMessageDate: 20 },
	], { sessionResource: 'chat-c', title: 'Current', lastMessageDate: 30 });

	assert.deepEqual(tabs.map(tab => tab.label), ['New Chat', 'Second renamed', 'Current']);
	assert.deepEqual(tabs.map(tab => tab.active), [false, false, true]);
	assert.equal(tabs.find(tab => tab.active)?.sessionResource, 'chat-c');
});

test('history lists every session newest first and sits on the outer edge', () => {
	assert.equal(chatHistoryEdge(false), 'end');
	assert.equal(chatHistoryEdge(true), 'start');
	const entries = chatHistoryEntries([
		{ sessionResource: 'chat-old', title: 'Older', lastMessageDate: 10, iconId: 'thrice-logo-claude', activity: 'working' as const },
		{ sessionResource: 'chat-new', title: 'Newer', lastMessageDate: 30, detail: 'Codex', iconId: 'thrice-logo-codex' },
		{ sessionResource: 'chat-old', title: '', lastMessageDate: 25, detail: 'Local', activity: 'finished' as const },
	]);
	assert.deepEqual(entries.map(entry => entry.label), ['Newer', 'Older']);
	assert.equal(entries[0].detail, 'Codex');
	assert.equal(entries[0].iconId, 'thrice-logo-codex');
	assert.equal(entries[1].detail, 'Local');
	assert.equal(entries[1].iconId, 'thrice-logo-claude');
	assert.equal(entries[1].activity, 'finished');
	assert.equal(entries[0].activity, undefined);
	assert.equal(entries[1].lastMessageDate, 25);
});

test('a status dot appears only after a session runs during this app session', () => {
	assert.equal(chatSessionRunActivity('chat-idle', false), undefined);
	assert.equal(chatSessionRunActivity('chat-live', true), 'working');
	assert.equal(chatSessionRunActivity('chat-live', false), 'finished');
	assert.equal(chatSessionRunActivity('chat-idle', false), undefined);
	assert.equal(CHAT_SESSION_TAB_MAX_WIDTH, 200);
});

test('the sessions column width stays inside its drag range and leaves the chat room', () => {
	assert.equal(chatHistoryPreferredWidth(undefined), 260);
	assert.equal(chatHistoryPreferredWidth('nope'), 260);
	assert.equal(chatHistoryPreferredWidth('10'), 180);
	assert.equal(chatHistoryPreferredWidth('900'), 480);
	assert.equal(chatHistoryColumnWidth(320, 600), 320);
	assert.equal(chatHistoryColumnWidth(320, 400), 240);
	assert.equal(chatHistoryColumnWidth(100, 100), 0);
});

test('sessions group by date and search matches the title', () => {
	const now = new Date(2026, 10, 27, 15).getTime();
	const start = new Date(now).setHours(0, 0, 0, 0);
	const day = 24 * 60 * 60 * 1000;
	const entries = [
		{ sessionResource: 'today', label: 'Now', detail: '', iconId: '', activity: 'finished' as const, lastMessageDate: start + 1000 },
		{ sessionResource: 'yesterday', label: 'Yday', detail: 'Codex', iconId: 'thrice-logo-codex', activity: 'working' as const, lastMessageDate: start - 1000 },
		{ sessionResource: 'week', label: 'This week', detail: '', iconId: '', activity: 'finished' as const, lastMessageDate: start - 3 * day },
		{ sessionResource: 'older', label: 'Old', detail: '', iconId: '', activity: 'finished' as const, lastMessageDate: start - 10 * day },
	];
	assert.deepEqual(chatHistoryGroups(entries, now).map(group => group.id), ['today', 'yesterday', 'week', 'older']);
	const pinned = { sessionResource: 'pinned', label: 'Kept', detail: '', iconId: '', lastMessageDate: start - 10 * day, pinned: true };
	const withPinned = chatHistoryGroups([pinned, ...entries], now);
	assert.deepEqual(withPinned.map(group => group.id), ['pinned', 'today', 'yesterday', 'week', 'older']);
	assert.deepEqual(withPinned[0].entries.map(entry => entry.sessionResource), ['pinned']);
	assert.equal(withPinned.some(group => group.id !== 'pinned' && group.entries.some(entry => entry.sessionResource === 'pinned')), false);
	assert.deepEqual(filterChatHistoryEntries(entries, 'codex').map(entry => entry.sessionResource), ['yesterday']);
	assert.equal(filterChatHistoryEntries(entries, '  ').length, entries.length);
});

test('a sub-agent stays under the chat that started it', () => {
	const entries = chatHistoryEntries([
		{
			sessionResource: 'parent',
			title: 'Parent',
			lastMessageDate: 30,
			children: [{ sessionResource: 'child', title: 'Research', lastMessageDate: 20, detail: 'notes' }],
		},
		{ sessionResource: 'child', title: 'Research', lastMessageDate: 20 },
		{ sessionResource: 'other', title: 'Other', lastMessageDate: 10 },
	]);
	assert.deepEqual(entries.map(entry => entry.sessionResource), ['parent', 'other']);
	assert.equal(entries[0].children?.[0].sessionResource, 'child');
	assert.equal(entries[0].children?.[0].label, 'Research');
	const matched = filterChatHistoryEntries(entries, 'notes');
	assert.deepEqual(matched.map(entry => entry.sessionResource), ['parent']);
	assert.deepEqual(matched[0].children?.map(child => child.sessionResource), ['child']);
});

test('a spawned sub-agent is listed from the reply that started it', () => {
	const listed = listSubagentChats([
		{ toolCallId: 'phase', complete: false, toolSpecificData: { kind: 'subagent', presentation: 'phase', description: 'Phase', isActive: true } },
		{ toolCallId: 'inner', complete: false, subAgentInvocationId: 'parent', toolSpecificData: { kind: 'subagent', description: 'Inner', isActive: true } },
		{ toolCallId: 'read', complete: false, toolSpecificData: { kind: 'subagent', description: 'Read the readme', chatResource: 'chat://read', isActive: true } },
		{ toolCallId: 'scripts', complete: true, toolSpecificData: { kind: 'subagent', description: 'List scripts', chatResource: 'chat://scripts', isActive: false } },
	]);
	assert.deepEqual(listed.map(chat => chat.label), ['Read the readme', 'List scripts']);
	assert.deepEqual(listed.map(chat => chat.running), [true, false]);
});

test('running sub-agents are a row above the text field and open as a side chat tab', () => {
	assert.match(runningSubagents, /class RunningSubagentsRow/);
	assert.match(runningSubagents, /container\.hidden = spawned\.length === 0/);
	assert.match(runningSubagents, /subagentChatsInModel/);
	assert.match(runningSubagents, /subagentEditorResource/);
	assert.match(runningSubagents, /openSessionEditor/);
	assert.match(chatInputPart, /chat-running-subagents@runningSubagentsContainer/);
	assert.match(chatInputPart, /runningSubagentsRow\?\.refresh\(\)/);
	assert.match(chatCss, /\.chat-running-subagents\[hidden\]/);
	assert.match(chatCss, /chat-running-subagent-status/);
	assert.match(chatEditors, /childHistorySources/);
	assert.match(chatEditors, /chat-session-history-children/);
	assert.match(chatViewCss, /chat-session-history-children-toggle/);
	assert.match(openSubagent, /openAuxiliaryChatSession/);
	assert.match(chatEditorInput, /descendantBusy/);
});

test('side chat sessions are real editors filling the auxiliary bar', () => {
	assert.match(chatViewPane, /createInstance\(AuxiliaryBarChatEditors/);
	assert.match(chatViewPane, /openNewChatEditor/);
	assert.match(chatViewPane, /chatEditors\?\.openNewChat\(\)/);
	assert.doesNotMatch(chatViewPane, /ChatSessionChrome|ChatSessionTabBar/);
	assert.match(chatEditors, /showTabs: 'multiple'/);
	assert.match(chatEditors, /showIcons: true/);
	assert.match(chatEditors, /enablePreview: false/);
	assert.match(chatEditors, /ChatEditorInput\.getNewEditorUri\(\)/);
	assert.match(chatEditors, /pinned: true/);
	assert.match(chatEditors, /setPartHidden\(true, Parts\.AUXILIARYBAR_PART\)/);
	assert.match(chatEditors, /tabsBarAddTab: AuxiliaryBarChatEditorsAddTab, tabsBarAddTabDirect: true/);
	assert.match(chatEditors, /editorActionsLocation: 'hidden'/);
	assert.match(chatEditors, /chat-history-toggle/);
	assert.match(chatEditors, /codicon-layout-sidebar-right/);
	assert.match(chatEditors, /monaco-action-bar/);
	assert.match(chatEditors, /New Agent/);
	assert.match(chatEditors, /chatHistoryGroups/);
	assert.match(chatEditors, /chat-session-history-icon/);
	assert.match(chatEditors, /chat-session-history-status/);
	assert.match(chatEditorInput, /getLabelExtraClasses/);
	assert.match(chatEditorInput, /chatSessionRunActivity/);
	assert.match(resourceLabels, /thrice-logo-/);
	assert.match(chatEditors, /chat-session-history-time/);
	assert.match(chatEditors, /new Sash/);
	assert.doesNotMatch(chatEditors, /chat-session-history-meta/);
	assert.doesNotMatch(chatEditors, /codicon-history/);
	assert.match(chatEditors, /getLocalSessionHistory/);
	assert.match(chatEditors, /chatHistoryEdge/);
	assert.match(chatEditors, /resumeSession/);
	assert.match(chatViewCss, /chat-history-at-start/);
	assert.match(chatViewCss, /chat-history-at-end/);
	assert.match(chatViewCss, /flex-direction: row/);
	assert.match(chatViewCss, /flex-direction: column/);
	assert.match(chatViewCss, /--modern-ui-connected-tab-strip-background/);
	assert.match(chatViewCss, /margin-top: var\(--vscode-spacing-size120\)/);
	assert.match(chatViewCss, /chat-history-sash/);
	assert.match(chatViewCss, /chat-session-history-time/);
	assert.match(chatViewCss, /gap: 10px/);
	assert.match(chatViewCss, /chat-session-history-status/);
	assert.match(chatViewCss, /chat-session-working::after/);
	assert.match(chatViewCss, /--chat-session-tab-max-width/);
	assert.match(chatEditors, /CHAT_SESSION_TAB_MAX_WIDTH/);
	assert.match(chatEditors, /contextmenu/);
	assert.match(chatEditors, /chat-session-history-more/);
	assert.match(chatEditors, /ChatSessionHistoryContext/);
	assert.match(chatViewPane, /openSessionEditor/);
	assert.match(chatHistoryMenu, /Open in New Tab/);
	assert.match(chatHistoryMenu, /Fork Chat/);
	assert.match(chatHistoryMenu, /Rename\.\.\./);
	assert.match(chatHistoryMenu, /Delete\.\.\./);
	assert.match(chatHistoryMenu, /"Pin"/);
	assert.match(chatViewCss, /chat-session-history-more/);
	assert.doesNotMatch(chatViewCss, /chat-session-history \{\s*display: none;\s*position: absolute/);
	assert.doesNotMatch(chatEditors, /setMoveRestriction|composite\.title/);
	assert.match(auxiliaryBarPart, /has-auxiliary-chat-editors/);
	assert.match(auxiliaryBarPart, /headerHeight:/);
	assert.match(auxiliaryBarCss, /has-auxiliary-chat-editors > \.composite\.title/);
	assert.match(auxiliaryBarCss, /has-auxiliary-chat-editors > \.header-or-footer/);
	assert.match(auxiliaryBarCss, /auxiliary-bar-chat-editors-surface\.part\.editor/);
	assert.match(auxiliaryBarCss, /--modern-ui-connected-tab-surface: var\(--vscode-editor-background\)/);
	assert.match(auxiliaryBarCss, /has-auxiliary-chat-editors > \.content/);
	assert.match(auxiliaryBarCss, /height: auto !important/);
	assert.match(chatViewPane, /ResizeObserver/);
	assert.doesNotMatch(chatEditorCss, /chat-secondary-toolbar/);
	assert.doesNotMatch(auxiliaryBarCss, /has-chat-session-chrome|chat-session-chrome/);
});

test('the session list splits into open chats and past sessions', () => {
	const entries = chatHistoryEntries([
		{ sessionResource: 'chat-a', title: 'Alpha', lastMessageDate: 30 },
		{ sessionResource: 'chat-b', title: 'Beta', lastMessageDate: 20, children: [{ sessionResource: 'sub-1', title: 'Sub', lastMessageDate: 21 }] },
		{ sessionResource: 'chat-c', title: 'Gamma', lastMessageDate: 10 },
	]);
	const sections = chatHistorySections(entries, [
		{ sessionResource: 'chat-c', label: 'Gamma' },
		{ sessionResource: 'untitled-1', aliases: ['chat-a'], label: 'Alpha' },
		{ sessionResource: 'new-1', label: '' },
		{ sessionResource: 'sub-1', label: 'Sub' },
		{ sessionResource: 'chat-c', label: 'Gamma again' },
	]);
	assert.deepEqual(sections.current.map(entry => entry.label), ['Gamma', 'Alpha', 'New Chat', 'Sub']);
	assert.deepEqual(sections.past.map(entry => entry.sessionResource), ['chat-b']);
	assert.equal(chatHistorySections(entries, []).past.length, 3);
	assert.match(chatEditors, /localize\('chatHistoryCurrent', "Current"\)/);
	assert.match(chatEditors, /localize\('chatHistoryPast', "History"\)/);
	assert.match(chatViewCss, /\.chat-session-history-section-header \{/);
});
