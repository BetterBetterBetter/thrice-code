/** Height of the session tab strip. Matches the auxiliary bar title it replaces. */
export const CHAT_SESSION_TABS_HEIGHT = 35;

export interface ChatSessionTabSource {
	readonly sessionResource: string;
	readonly title: string;
	readonly lastMessageDate: number;
}

/** Whether a session is still running, or has stopped, during this app run. */
export type ChatHistoryActivity = 'working' | 'finished';

/** Sessions that have had a reply running since this process started. */
const chatSessionsActiveThisRun = new Set<string>();

export interface SubagentChatPart {
	readonly toolCallId: string;
	readonly subAgentInvocationId?: string;
	readonly complete: boolean;
	readonly toolSpecificData?: {
		readonly kind: string;
		readonly presentation?: string;
		readonly description?: string;
		readonly agentDisplayName?: string;
		readonly isActive?: boolean;
		readonly chatResource?: string;
		readonly chatProvider?: string;
		readonly isInputNeeded?: boolean;
	};
}

export interface ListedSubagentChat {
	readonly id: string;
	readonly label: string;
	readonly resource?: string;
	readonly running: boolean;
	/** Agent provider id of the child chat, when the host reports one. */
	readonly provider?: string;
	/** Whether the child chat is waiting on the user for input or an approval. */
	readonly inputNeeded?: boolean;
}

/** Parent sub-agent tools on a chat. Nested tool calls inside a sub-agent are not separate rows. */
export function listSubagentChats(parts: readonly SubagentChatPart[]): ListedSubagentChat[] {
	const listed: ListedSubagentChat[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		const data = part.toolSpecificData;
		if (!data || data.kind !== 'subagent' || part.subAgentInvocationId || data.presentation === 'phase') {
			continue;
		}
		const id = data.chatResource || part.toolCallId;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		listed.push({
			id,
			label: data.description?.trim() || data.agentDisplayName?.trim() || 'Subagent',
			resource: data.chatResource,
			running: data.isActive === true || (!part.complete && data.isActive !== false),
			provider: data.chatProvider,
			inputNeeded: data.isInputNeeded === true,
		});
	}
	return listed;
}

/**
 * The status dot for a session. A chat that has not run during this app
 * session has no dot, including a new chat and an older one left idle.
 */
export function chatSessionRunActivity(sessionResource: string, busy: boolean): ChatHistoryActivity | undefined {
	if (busy) {
		chatSessionsActiveThisRun.add(sessionResource);
	}
	if (!chatSessionsActiveThisRun.has(sessionResource)) {
		return undefined;
	}
	return busy ? 'working' : 'finished';
}

export interface ChatHistorySource extends ChatSessionTabSource {
	readonly detail?: string;
	/** Theme icon id for the provider logo, such as `thrice-logo-claude`. */
	readonly iconId?: string;
	/** Thrice provider id for this session, when the logo was not resolved yet. */
	readonly providerId?: string;
	readonly activity?: ChatHistoryActivity;
	readonly pinned?: boolean;
	readonly children?: readonly ChatHistorySource[];
	/** Spawned from a sub-agent tool on this chat, rather than a published peer chat. */
	readonly spawned?: boolean;
}

export interface ChatHistoryEntry {
	readonly sessionResource: string;
	readonly label: string;
	readonly detail: string;
	readonly iconId: string;
	readonly providerId?: string;
	readonly activity?: ChatHistoryActivity;
	readonly pinned?: boolean;
	readonly children?: readonly ChatHistoryEntry[];
	readonly spawned?: boolean;
	readonly lastMessageDate: number;
}

export interface ChatSessionTab {
	readonly sessionResource: string;
	readonly label: string;
	readonly active: boolean;
}

/** The words on a session tab. Blank titles use the untitled label, never an icon. */
export function chatSessionTabLabel(title: string | undefined, untitledLabel: string): string {
	const trimmed = title?.trim();
	return trimmed ? trimmed : untitledLabel;
}

/**
 * Open sessions as tabs, oldest first. A later entry for the same session
 * replaces the earlier one. The current session is included even when it is
 * not in the open list yet.
 */
export function chatSessionTabs(sessions: readonly ChatSessionTabSource[], active: ChatSessionTabSource | undefined, untitledLabel = 'New Chat'): ChatSessionTab[] {
	const byResource = new Map<string, ChatSessionTabSource>();
	for (const session of sessions) {
		byResource.set(session.sessionResource, session);
	}
	if (active && !byResource.has(active.sessionResource)) {
		byResource.set(active.sessionResource, active);
	}
	const activeResource = active?.sessionResource;
	return [...byResource.values()]
		.sort((a, b) => a.lastMessageDate - b.lastMessageDate || a.sessionResource.localeCompare(b.sessionResource))
		.map(session => ({
			sessionResource: session.sessionResource,
			label: chatSessionTabLabel(session.title, untitledLabel),
			active: session.sessionResource === activeResource,
		}));
}

/**
 * The history control sits on the outer edge of the chat panel: the right when the
 * auxiliary bar is on the right, and the left when that panel is on the left.
 */
export function chatHistoryEdge(auxiliaryBarOnLeft: boolean): 'start' | 'end' {
	return auxiliaryBarOnLeft ? 'start' : 'end';
}

/** A chat tab stops growing past this, so one long title cannot fill the strip. */
export const CHAT_SESSION_TAB_MAX_WIDTH = 200;

/** Default width of the sessions column. Dragging the sash stores a new one. */
export const CHAT_HISTORY_COLUMN_WIDTH = 260;

/** The sessions column cannot be dragged narrower or wider than this. */
export const CHAT_HISTORY_COLUMN_MIN_WIDTH = 180;
export const CHAT_HISTORY_COLUMN_MAX_WIDTH = 480;

/** The chat beside the sessions column keeps at least this much width. */
export const CHAT_HISTORY_CHAT_MIN_WIDTH = 160;

/** A stored width, clamped to the drag range. Anything unreadable uses the default. */
export function chatHistoryPreferredWidth(stored: string | undefined): number {
	const parsed = Number(stored);
	if (!Number.isFinite(parsed)) {
		return CHAT_HISTORY_COLUMN_WIDTH;
	}
	return Math.min(CHAT_HISTORY_COLUMN_MAX_WIDTH, Math.max(CHAT_HISTORY_COLUMN_MIN_WIDTH, Math.round(parsed)));
}

/** The column width that fits in `available` while the chat keeps its minimum. */
export function chatHistoryColumnWidth(preferred: number, available: number): number {
	const room = Math.max(0, available - CHAT_HISTORY_CHAT_MIN_WIDTH);
	const wanted = chatHistoryPreferredWidth(String(preferred));
	return Math.min(wanted, room);
}

export type ChatHistoryGroupId = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export interface ChatHistoryGroup {
	readonly id: ChatHistoryGroupId;
	readonly entries: readonly ChatHistoryEntry[];
}

const CHAT_HISTORY_DAY = 24 * 60 * 60 * 1000;

/** Sessions whose title or detail contains the query. A matching child keeps its parent. A blank query keeps every session. */
export function filterChatHistoryEntries(entries: readonly ChatHistoryEntry[], query: string): ChatHistoryEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [...entries];
	}
	const result: ChatHistoryEntry[] = [];
	for (const entry of entries) {
		const children = filterChatHistoryEntries(entry.children ?? [], query);
		const self = entry.label.toLowerCase().includes(needle) || entry.detail.toLowerCase().includes(needle);
		if (self) {
			result.push(entry);
		} else if (children.length > 0) {
			result.push({ ...entry, children });
		}
	}
	return result;
}

/**
 * Sessions grouped by calendar day, newest group first. Empty groups are omitted.
 * `now` is injectable so a test can pin midnight.
 */
export function chatHistoryGroups(entries: readonly ChatHistoryEntry[], now = Date.now()): ChatHistoryGroup[] {
	const pinned = entries.filter(entry => entry.pinned);
	const dated = entries.filter(entry => !entry.pinned);
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	const startOfYesterday = startOfToday - CHAT_HISTORY_DAY;
	const weekThreshold = now - 7 * CHAT_HISTORY_DAY;
	const groups: { id: ChatHistoryGroupId; entries: ChatHistoryEntry[] }[] = [
		{ id: 'today', entries: [] },
		{ id: 'yesterday', entries: [] },
		{ id: 'week', entries: [] },
		{ id: 'older', entries: [] },
	];
	for (const entry of dated) {
		if (entry.lastMessageDate >= startOfToday) {
			groups[0].entries.push(entry);
		} else if (entry.lastMessageDate >= startOfYesterday) {
			groups[1].entries.push(entry);
		} else if (entry.lastMessageDate >= weekThreshold) {
			groups[2].entries.push(entry);
		} else {
			groups[3].entries.push(entry);
		}
	}
	const result = groups.filter(group => group.entries.length > 0);
	return pinned.length > 0 ? [{ id: 'pinned', entries: pinned }, ...result] : result;
}

/**
 * Every session history, newest first. A later entry for the same session fills in
 * a missing title or detail and keeps the newer date.
 */
export function chatHistoryEntries(sessions: readonly ChatHistorySource[], untitledLabel = 'New Chat'): ChatHistoryEntry[] {
	const byResource = new Map<string, ChatHistorySource>();
	for (const session of sessions) {
		const previous = byResource.get(session.sessionResource);
		if (!previous) {
			byResource.set(session.sessionResource, session);
			continue;
		}
		byResource.set(session.sessionResource, {
			sessionResource: session.sessionResource,
			title: session.title.trim() ? session.title : previous.title,
			detail: session.detail || previous.detail,
			iconId: session.iconId || previous.iconId,
			providerId: session.providerId || previous.providerId,
			activity: session.activity || previous.activity,
			pinned: session.pinned || previous.pinned,
			spawned: session.spawned || previous.spawned,
			children: mergeHistoryChildren(session.children, previous.children),
			lastMessageDate: Math.max(session.lastMessageDate, previous.lastMessageDate),
		});
	}
	const owned = new Set<string>();
	const visit = (children: readonly ChatHistorySource[] | undefined) => {
		for (const child of children ?? []) {
			owned.add(child.sessionResource);
			visit(child.children);
		}
	};
	for (const session of byResource.values()) {
		visit(session.children);
	}
	return [...byResource.values()]
		.filter(session => !owned.has(session.sessionResource))
		.sort((a, b) => b.lastMessageDate - a.lastMessageDate || a.sessionResource.localeCompare(b.sessionResource))
		.map(session => toHistoryEntry(session, untitledLabel));
}

function mergeHistoryChildren(next: readonly ChatHistorySource[] | undefined, previous: readonly ChatHistorySource[] | undefined): ChatHistorySource[] | undefined {
	if (!next?.length && !previous?.length) {
		return undefined;
	}
	const byResource = new Map<string, ChatHistorySource>();
	for (const child of [...(previous ?? []), ...(next ?? [])]) {
		const prior = byResource.get(child.sessionResource);
		if (!prior) {
			byResource.set(child.sessionResource, child);
			continue;
		}
		byResource.set(child.sessionResource, {
			...prior,
			...child,
			title: child.title.trim() ? child.title : prior.title,
			detail: child.detail || prior.detail,
			iconId: child.iconId || prior.iconId,
			spawned: child.spawned || prior.spawned,
			children: mergeHistoryChildren(child.children, prior.children),
		});
	}
	return [...byResource.values()];
}

function toHistoryEntry(session: ChatHistorySource, untitledLabel: string): ChatHistoryEntry {
	return {
		sessionResource: session.sessionResource,
		label: chatSessionTabLabel(session.title, untitledLabel),
		detail: session.detail ?? '',
		iconId: session.iconId ?? '',
		providerId: session.providerId,
		activity: session.activity,
		pinned: session.pinned === true,
		spawned: session.spawned === true,
		children: session.children?.map(child => toHistoryEntry(child, untitledLabel)),
		lastMessageDate: session.lastMessageDate,
	};
}

/** A chat that has a tab open somewhere, in tab order. `aliases` are other resources the same tab answers to. */
export interface OpenChatSession {
	readonly sessionResource: string;
	readonly aliases?: readonly string[];
	readonly label: string;
}

export interface ChatHistorySections {
	/** Chats that have an open tab, in tab order. */
	readonly current: readonly ChatHistoryEntry[];
	/** Every other session. */
	readonly past: readonly ChatHistoryEntry[];
}

/**
 * Splits the session list into the chats that are open as tabs and the rest.
 * An open chat that has no history row yet, such as a new chat with no reply,
 * gets a row from its tab. An open sub-agent is listed on its own under Current
 * and stays under its parent in History.
 */
export function chatHistorySections(entries: readonly ChatHistoryEntry[], open: readonly OpenChatSession[], untitledLabel = 'New Chat'): ChatHistorySections {
	const byResource = new Map<string, ChatHistoryEntry>();
	const index = (list: readonly ChatHistoryEntry[] | undefined) => {
		for (const entry of list ?? []) {
			if (!byResource.has(entry.sessionResource)) {
				byResource.set(entry.sessionResource, entry);
			}
			index(entry.children);
		}
	};
	index(entries);
	const current: ChatHistoryEntry[] = [];
	const listed = new Set<string>();
	for (const tab of open) {
		const keys = [tab.sessionResource, ...(tab.aliases ?? [])];
		if (keys.some(key => listed.has(key))) {
			continue;
		}
		const found = keys.map(key => byResource.get(key)).find((entry): entry is ChatHistoryEntry => !!entry);
		const entry = found ?? {
			sessionResource: tab.sessionResource,
			label: chatSessionTabLabel(tab.label, untitledLabel),
			detail: '',
			iconId: '',
			lastMessageDate: 0,
		};
		for (const key of [...keys, entry.sessionResource]) {
			listed.add(key);
		}
		current.push(entry);
	}
	return { current, past: entries.filter(entry => !listed.has(entry.sessionResource)) };
}
