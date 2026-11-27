const EXTERNAL_TERMINALS: readonly { readonly app: string; readonly pattern: RegExp; readonly named: RegExp }[] = [
	{ app: 'iTerm', pattern: /iTerm2?\.app|tell application\s+["']iTerm|open\s+\S*\s*["']?iTerm/i, named: /iterm/i },
	{ app: 'Terminal', pattern: /Terminal\.app|tell application\s+["']Terminal["']|open\s+\S*\s*["']?Terminal(?:\.app)?["']?(?:\s|$)/i, named: /terminal\.app|terminal app|apple terminal/i },
	{ app: 'Warp', pattern: /Warp\.app|tell application\s+["']Warp|open\s+\S*\s*["']?Warp(?:\.app)?["']?/i, named: /\bwarp\b/i },
	{ app: 'Ghostty', pattern: /Ghostty\.app|tell application\s+["']Ghostty|open\s+\S*\s*["']?Ghostty/i, named: /ghostty/i },
	{ app: 'kitty', pattern: /kitty\.app|tell application\s+["']kitty|open\s+\S*\s*["']?kitty(?:\.app)?/i, named: /\bkitty\b/i },
	{ app: 'Alacritty', pattern: /Alacritty\.app|tell application\s+["']Alacritty|open\s+\S*\s*["']?Alacritty/i, named: /alacritty/i },
	{ app: 'WezTerm', pattern: /WezTerm\.app|tell application\s+["']WezTerm|open\s+\S*\s*["']?WezTerm/i, named: /wezterm/i },
];

export const AGENT_HOST_EDITOR_INSTRUCTION = 'This chat runs inside the editor. Prefer the editor\'s built-in tools over external applications. A terminal, shell, or session means the integrated terminal tool mcp__client__agentWindowShell. Set keep_open to true to leave a program running in the terminal panel. Do not launch Terminal.app, iTerm, or any other external application unless the user names that application.';

/** A reason to block the command, when it launches an external terminal the user did not name. */
export function externalTerminalDenial(command: string, userText: string): string | undefined {
	for (const launch of EXTERNAL_TERMINALS) {
		if (!launch.pattern.test(command)) {
			continue;
		}
		if (launch.named.test(userText)) {
			return undefined;
		}
		return `Use the editor's integrated terminal tool mcp__client__agentWindowShell. Set keep_open to true to leave a program running in the terminal panel. Launch ${launch.app} only when the user names that application.`;
	}
	return undefined;
}

export function bashCommand(input: unknown): string {
	if (typeof input === 'string') {
		return input;
	}
	if (input && typeof input === 'object' && 'command' in input && typeof (input as { command?: unknown }).command === 'string') {
		return (input as { command: string }).command;
	}
	return '';
}

export function textFromSdkContent(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(textFromSdkContent).filter(part => part.length > 0).join('\n');
	}
	if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') {
		return (value as { text: string }).text;
	}
	return '';
}
