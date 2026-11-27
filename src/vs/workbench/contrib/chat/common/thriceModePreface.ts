export const diagramInstruction = 'When a diagram helps, write a mermaid code fence. When a bar chart helps, write a thrice-chart code fence containing JSON with a title and a series of name and value. Do not wrap either in a tool call.';

export const editorToolInstruction = 'This chat runs inside the editor. Prefer the editor\'s built-in tools over external applications. A terminal, shell, or session means the editor\'s integrated terminal: use spawnTerminal, which opens the terminal panel, then readTerminal or waitTerminal. Call openEditor to show a file in this window. Call sessionContext for this window\'s folders, unsaved editors, problems, and ports. Do not launch Terminal.app, iTerm, or any other external application unless the user names that application.';

export const changesInstruction = 'The prompt may include a "Changes since this session started" section listing the files changed since this chat began. When asked to revert or describe your changes, use that list.';

const modeLead: Record<string, string> = {
	plan: 'Research and write a plan. Do not edit files or apply the plan.',
	ask: 'Answer the question. Do not edit files or run commands that change the project.',
	debug: 'Find the cause. Reproduce it, then change only what the fix needs.',
	spec: 'Write a specification of the behavior and the files it touches. Do not implement it.',
	triage: 'Diagnose the failure from the code and the errors. Do not edit files.',
	background: 'Finish this task without waiting for another message.',
};

export function thriceModeForChatMode(modeId: string, kind: string): string {
	switch (modeId) {
		case 'plan':
		case 'ask':
		case 'debug':
		case 'spec':
		case 'triage':
		case 'background':
			return modeId;
		default:
			return kind === 'ask' ? 'ask' : 'interactive';
	}
}

export function thriceModePreface(mode: string | undefined): string {
	const lead = mode ? modeLead[mode] : undefined;
	const body = `${editorToolInstruction}\n\n${changesInstruction}\n\n${diagramInstruction}`;
	return lead ? `${lead}\n\n${body}` : body;
}

export function applyThriceModePreface(prompt: string, mode: string | undefined): string {
	if (prompt.includes(diagramInstruction)) {
		return prompt;
	}
	return `${thriceModePreface(mode)}\n\n${prompt}`;
}
