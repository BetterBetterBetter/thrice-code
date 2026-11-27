import { agentToolNote, agentTools } from './agents';

export const EDITOR_TOOL_INSTRUCTION = 'This chat runs inside the editor. Prefer the editor\'s built-in tools over external applications. A terminal, shell, or session means the editor\'s integrated terminal: use spawnTerminal, which opens the terminal panel, then readTerminal or waitTerminal. Call openEditor to show a file in this window. Call sessionContext for this window\'s folders, unsaved editors, problems, and ports. Do not launch Terminal.app, iTerm, or any other external application unless the user names that application.';

export const TERMINAL_TOOL_NAME = 'agentWindowShell';
export const SPAWN_TOOL_NAME = 'spawnTerminal';
export const CLAUDE_TERMINAL_TOOL = 'mcp__thrice__spawnTerminal';

const stringProp = (description: string) => ({ type: 'string', description });
const numberProp = (description: string) => ({ type: 'number', description });

function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>, required: readonly string[] = []): { name: string; description: string; inputSchema: { type: string; properties: typeof properties; required: string[] } } {
	return {
		name,
		description,
		inputSchema: { type: 'object', properties, required: [...required] },
	};
}

export const SESSION_TOOLS = [
	tool('sessionContext', 'Read this window: local or remote, saved or unsaved workspace, folders, the active editor and selection, open and unsaved editors, integrated terminals (the focused one is marked), ports, and problems.', {}),
	tool('listEditors', 'List editors open in this window, including dirty and untitled ones.', {}),
	tool('readEditor', 'Read an open editor, including a dirty or untitled buffer. Pass path from listEditors or sessionContext.', { path: stringProp('Editor path or untitled URI.') }, ['path']),
	tool('writeEditor', 'Change an open editor, including a dirty or untitled buffer. The change stays unsaved. Pass content to replace the document, or old and new for one replacement.', {
		path: stringProp('Editor path or untitled URI.'),
		content: stringProp('Full replacement text.'),
		old: stringProp('Text to find for one replacement.'),
		new: stringProp('Replacement text.'),
	}, ['path']),
	tool('listTerminals', 'List integrated terminals in this window, including ones opened before this chat. The focused terminal is marked. Each entry has an id.', {}),
	tool('readTerminal', 'Read the buffer of an integrated terminal by id.', {
		id: numberProp('Terminal id from listTerminals.'),
		lines: numberProp('Trailing lines to return. Defaults to 200.'),
	}, ['id']),
	tool('openEditor', 'Open a file or untitled editor as a visible tab in this window.', { path: stringProp('File path or untitled URI.') }, ['path']),
	tool('spawnTerminal', 'Open the terminal panel in this window, start a real integrated terminal, and return its id immediately. Use this for a terminal, shell, or interactive program such as claude. Pass command to type it and run it. Then call readTerminal or waitTerminal. Do not use Bash, Terminal.app, or iTerm. A terminal you open for your own work shows an agent icon: close it with closeTerminal when you are done, and it is closed for you when your turn ends.', {
		command: stringProp('Command to type into the terminal. Omit to open a shell.'),
		working_directory: stringProp('Absolute working directory. Omit to use the window default.'),
		for_user: { type: 'boolean', description: 'True only when the user asked for this terminal or session to be opened. It then looks like any terminal and stays open after your turn.' },
	}),
	tool('writeTerminal', 'Type into an integrated terminal by id. text is sent, then Enter, unless submit is false.', {
		id: numberProp('Terminal id.'),
		text: stringProp('Text to send. An empty string sends Enter.'),
		submit: { type: 'boolean', description: 'False inserts the text without Enter.' },
	}, ['id', 'text']),
	tool('closeTerminal', 'Close an integrated terminal by id.', { id: numberProp('Terminal id.') }, ['id']),
	tool('waitTerminal', 'Wait until an integrated terminal prints new output, or until timeout_ms (default 15000, max 60000). Call again to keep monitoring a session.', {
		id: numberProp('Terminal id.'),
		timeout_ms: numberProp('How long to wait for new output, in milliseconds.'),
	}, ['id']),
	tool('listPorts', 'List ports this window has forwarded, detected, or seen listening.', {}),
	tool('forwardPort', 'Forward a port in this window.', {
		port: numberProp('Remote port to forward.'),
		host: stringProp('Remote host. Defaults to localhost.'),
		local_port: numberProp('Local port. Omit to let the window choose.'),
	}, ['port']),
	tool('closePort', 'Close a forwarded port in this window.', {
		port: numberProp('Forwarded port.'),
		host: stringProp('Remote host. Defaults to localhost.'),
	}, ['port']),
	tool('listProblems', 'Errors and warnings from this window\'s Problems panel.', {}),
	tool('addFolder', 'Add a folder to this window\'s workspace, including an unsaved workspace.', { path: stringProp('Absolute folder path.') }, ['path']),
	tool('removeFolder', 'Remove a folder from this window\'s workspace.', { path: stringProp('Folder path from sessionContext.') }, ['path']),
];

export const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map(item => item.name));

export const TERMINAL_TOOL = tool(
	TERMINAL_TOOL_NAME,
	'Run one command in an integrated terminal and return its output. For an interactive or long-running program, use spawnTerminal instead. Do not launch Terminal.app, iTerm, open, or osascript.',
	{
		command: stringProp('The shell command to run.'),
		working_directory: stringProp('Absolute working directory. Omit to use the workspace folder.'),
		keep_open: { type: 'boolean', description: 'True opens a real terminal with spawnTerminal and returns immediately.' },
		for_user: { type: 'boolean', description: 'With keep_open, true only when the user asked for this terminal. Otherwise it is closed when your turn ends.' },
	},
	['command'],
);

const EXTERNAL_TERMINALS: readonly { readonly app: string; readonly pattern: RegExp; readonly named: RegExp }[] = [
	{ app: 'iTerm', pattern: /iTerm2?\.app|tell application\s+["']iTerm|open\s+\S*\s*["']?iTerm/i, named: /iterm/i },
	{ app: 'Terminal', pattern: /Terminal\.app|tell application\s+["']Terminal["']|open\s+\S*\s*["']?Terminal(?:\.app)?["']?(?:\s|$)/i, named: /terminal\.app|terminal app|apple terminal/i },
	{ app: 'Warp', pattern: /Warp\.app|tell application\s+["']Warp|open\s+\S*\s*["']?Warp(?:\.app)?["']?/i, named: /\bwarp\b/i },
	{ app: 'Ghostty', pattern: /Ghostty\.app|tell application\s+["']Ghostty|open\s+\S*\s*["']?Ghostty/i, named: /ghostty/i },
	{ app: 'kitty', pattern: /kitty\.app|tell application\s+["']kitty|open\s+\S*\s*["']?kitty(?:\.app)?/i, named: /\bkitty\b/i },
	{ app: 'Alacritty', pattern: /Alacritty\.app|tell application\s+["']Alacritty|open\s+\S*\s*["']?Alacritty/i, named: /alacritty/i },
	{ app: 'WezTerm', pattern: /WezTerm\.app|tell application\s+["']WezTerm|open\s+\S*\s*["']?WezTerm/i, named: /wezterm/i },
];

/** A reason to block the command, when it launches an external terminal the user did not name. */
export function externalTerminalDenial(command: string, userText: string, toolName: string): string | undefined {
	for (const launch of EXTERNAL_TERMINALS) {
		if (!launch.pattern.test(command)) {
			continue;
		}
		if (launch.named.test(userText)) {
			return undefined;
		}
		return `Use ${toolName} to open the editor's integrated terminal, then readTerminal or waitTerminal. Launch ${launch.app} only when the user names that application.`;
	}
	return undefined;
}

/** The terminal id in a spawnTerminal result, which the bridge tracks so it can close the terminal later. */
export function spawnedTerminalId(result: string): number | undefined {
	const match = /^Opened the terminal panel on terminal (\d+)\b/.exec(result);
	return match ? Number(match[1]) : undefined;
}

/** Interactive CLIs exit when Bash starts them in a pipe. They belong in spawnTerminal. */
export function interactiveCliDenial(command: string): string | undefined {
	const stripped = command.replace(/\b(?:which|type|command\s+-v)\s+\S+/g, '');
	if (!/(?:^|[;&|`(]\s*)(?:sudo\s+)?(?:command\s+)?(?:claude|codex)\b/.test(stripped)) {
		return undefined;
	}
	if (/(?:^|\s)(?:-p|--print)\b/.test(command)) {
		return undefined;
	}
	return 'This shell is a pipe, so an interactive program exits immediately. Call spawnTerminal with the command, then waitTerminal or readTerminal.';
}

export function denialFromHook(hookJson: string, userText: string): string | undefined {
	let command = '';
	try {
		const hook = JSON.parse(hookJson) as { tool_input?: { command?: unknown } | string };
		const input = hook.tool_input;
		if (typeof input === 'string') {
			command = input;
		} else if (input && typeof input.command === 'string') {
			command = input.command;
		}
	} catch {
		return undefined;
	}
	return externalTerminalDenial(command, userText, CLAUDE_TERMINAL_TOOL) ?? interactiveCliDenial(command);
}

export function ensureEditorToolInstruction(text: string): string {
	if (text.includes(EDITOR_TOOL_INSTRUCTION)) {
		return text;
	}
	return `${EDITOR_TOOL_INSTRUCTION}\n\n${text}`;
}

/** Terminals an agent opens for itself are closed when its turn ends; this tells it to close them first. */
export const TERMINAL_CLOSE_RULE = 'Close every terminal you opened for your own work with closeTerminal as soon as you are done with it. Set for_user only when the user asked for that terminal; it then stays open.';

export function claudeToolNote(agents = false): string {
	const base = `${EDITOR_TOOL_INSTRUCTION} The session tools are already on the thrice MCP server. Call ${CLAUDE_TERMINAL_TOOL} for a terminal. Call mcp__thrice__sessionContext to see this window. ${TERMINAL_CLOSE_RULE}`;
	return agents ? `${base} ${agentToolNote('mcp__thrice__')}` : base;
}

export function codexToolNote(agents = false): string {
	const base = `${EDITOR_TOOL_INSTRUCTION} Use the thrice MCP tool ${SPAWN_TOOL_NAME} for a terminal and sessionContext to see this window. ${TERMINAL_CLOSE_RULE}`;
	return agents ? `${base} ${agentToolNote('the thrice MCP tool ')}` : base;
}

/**
 * Thrice tools that only read the window, plus the agent tools (a read-only launch only starts
 * read-only agents). Claude asks before any other MCP tool, and a print-mode run cannot ask, so a
 * launch without --dangerously-skip-permissions is allowed these and nothing else.
 */
export const READ_ONLY_THRICE_TOOLS = ['sessionContext', 'listEditors', 'readEditor', 'listTerminals', 'readTerminal', 'listPorts', 'listProblems', 'listAgents', 'runAgent', 'waitAgent', 'stopAgent'] as const;

export function opencodeToolNote(agents = false): string {
	const base = `${EDITOR_TOOL_INSTRUCTION} Use the thrice MCP tool thrice_${SPAWN_TOOL_NAME} for a terminal and thrice_sessionContext to see this window. ${TERMINAL_CLOSE_RULE}`;
	return agents ? `${base} ${agentToolNote('thrice_')}` : base;
}

/**
 * Environment that gives a launch the thrice MCP server when its CLI takes configuration that
 * way. OpenCode reads OPENCODE_CONFIG_CONTENT on top of the user's own config.
 */
export function editorToolEnvironment(driver: string, launch: EditorToolLaunch | undefined, base: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
	if (!launch || driver !== 'opencode') {
		return {};
	}
	let config: Record<string, unknown> = {};
	const existing = base.OPENCODE_CONFIG_CONTENT;
	if (existing) {
		try {
			const parsed = JSON.parse(existing) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				config = parsed as Record<string, unknown>;
			}
		} catch {
			config = {};
		}
	}
	const mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp as Record<string, unknown> : {};
	return {
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			...config,
			mcp: { ...mcp, thrice: { type: 'local', command: ['node', launch.shimPath, String(launch.port), launch.token], enabled: true } },
		}),
	};
}

/** Codex gives an MCP tool 60 seconds by default; runAgent and waitAgent can wait far longer. */
export const CODEX_TOOL_TIMEOUT_SEC = 3600;

export interface EditorToolLaunch {
	readonly mcpConfigFile: string;
	readonly settingsFile: string;
	readonly shimPath: string;
	readonly port: number;
	readonly token: string;
	/** True when this launch may start other agents through runAgent. */
	readonly agentTools?: boolean;
	dispose(): void;
}

export interface McpToolOptions {
	/** Offer the agent tools at all. */
	readonly agents?: boolean;
	/** Offer runAgent, waitAgent and stopAgent as well as listAgents. */
	readonly canSpawn?: boolean;
}

export type McpAction =
	| { readonly kind: 'none' }
	| { readonly kind: 'cancel'; readonly requestId: unknown }
	| { readonly kind: 'reply'; readonly message: unknown }
	| { readonly kind: 'tool'; readonly id: unknown; readonly name: string; readonly args: Record<string, unknown> };

export function interpretMcp(message: unknown, options: McpToolOptions = {}): McpAction {
	if (!message || typeof message !== 'object') {
		return { kind: 'none' };
	}
	const record = message as { id?: unknown; method?: unknown; params?: unknown };
	if (typeof record.method !== 'string') {
		return { kind: 'none' };
	}
	if (record.method === 'notifications/cancelled') {
		const params = record.params as { requestId?: unknown } | undefined;
		return params && params.requestId !== undefined ? { kind: 'cancel', requestId: params.requestId } : { kind: 'none' };
	}
	if (record.method.startsWith('notifications/')) {
		return { kind: 'none' };
	}
	if (!Object.prototype.hasOwnProperty.call(record, 'id')) {
		return { kind: 'none' };
	}
	const id = record.id;
	if (record.method === 'initialize') {
		const params = record.params as { protocolVersion?: unknown } | undefined;
		const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
		return {
			kind: 'reply',
			message: {
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: 'thrice', version: '1.0.0' },
				},
			},
		};
	}
	if (record.method === 'tools/list') {
		return { kind: 'reply', message: { jsonrpc: '2.0', id, result: { tools: [...SESSION_TOOLS, TERMINAL_TOOL, ...(options.agents ? agentTools(options.canSpawn === true) : [])] } } };
	}
	if (record.method === 'ping') {
		return { kind: 'reply', message: { jsonrpc: '2.0', id, result: {} } };
	}
	if (record.method === 'tools/call') {
		const params = record.params as { name?: unknown; arguments?: unknown } | undefined;
		const name = typeof params?.name === 'string' ? params.name : '';
		const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
		return { kind: 'tool', id, name, args };
	}
	return { kind: 'reply', message: { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${record.method}` } } };
}

export function toolResultMessage(id: unknown, text: string, isError: boolean): unknown {
	return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

/** MCP stdio is one JSON object per line. A Content-Length frame never completes the client's read. */
export function mcpStdioFrame(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

export function withEditorTools(driver: string, args: readonly string[], launch: EditorToolLaunch | undefined, extraDirectories: readonly string[] = []): string[] {
	const next = [...args];
	const agents = launch?.agentTools === true;
	const note = !launch ? undefined : driver === 'claude' ? claudeToolNote(agents) : driver === 'codex' ? codexToolNote(agents) : driver === 'opencode' ? opencodeToolNote(agents) : undefined;
	if (note && next.length > 0 && !next[next.length - 1].includes(CLAUDE_TERMINAL_TOOL) && !next[next.length - 1].includes(`MCP tool ${SPAWN_TOOL_NAME}`) && !next[next.length - 1].includes(`MCP tool thrice_${SPAWN_TOOL_NAME}`)) {
		next[next.length - 1] = `${next[next.length - 1]}\n\n${note}`;
	}
	if (!launch) {
		return next;
	}
	if (driver === 'claude') {
		const at = next.lastIndexOf('--');
		const index = at === -1 ? next.length : at;
		const flags: string[] = [];
		for (const dir of extraDirectories) {
			if (dir.trim()) {
				flags.push('--add-dir', dir);
			}
		}
		flags.push(
			'--mcp-config', launch.mcpConfigFile,
			'--settings', launch.settingsFile,
			'--append-system-prompt', claudeToolNote(agents),
		);
		if (!next.includes('--dangerously-skip-permissions')) {
			flags.push('--allowedTools', READ_ONLY_THRICE_TOOLS.map(name => `mcp__thrice__${name}`).join(','));
		}
		next.splice(index, 0, ...flags);
		return next;
	}
	if (driver === 'codex') {
		const at = next.indexOf('exec');
		const index = at === -1 ? 0 : at;
		const mcpArgs = JSON.stringify([launch.shimPath, String(launch.port), launch.token]);
		next.splice(index, 0,
			'-c', 'mcp_servers.thrice.command="node"',
			'-c', `mcp_servers.thrice.args=${mcpArgs}`,
			'-c', 'mcp_servers.thrice.enabled=true',
			'-c', `mcp_servers.thrice.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
		);
	}
	return next;
}
