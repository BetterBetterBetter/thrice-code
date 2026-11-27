import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeTool, formatLabel, type AgentEvent, type ToolDescription } from './events';

export interface FileChangeRecord {
	readonly path: string;
	readonly change: 'add' | 'update' | 'delete';
}

interface ToolView {
	readonly id: string;
	readonly tool: string;
	input: unknown;
	label: string;
	readonly parentId?: string;
	pushed: boolean;
	done: boolean;
}

const FILE_KINDS = new Set(['read', 'edit', 'write', 'delete', 'list']);

/**
 * Renders Contract 4 events into the chat response: tool calls as external tool invocations
 * (`ChatToolInvocationPart` with `enablePartialUpdate`), thinking via `thinkingProgress`,
 * Task/sub-agent calls as `ChatSubagentToolInvocationData` with child calls grouped under them.
 *
 * Read/search runs are grouped by the workbench itself into the collapsible "thinking" container
 * (setting `chat.agent.thinking.collapsedTools`), so no grouping is done here.
 */
export class ActivityRenderer {
	private readonly tools = new Map<string, ToolView>();
	private readonly changes = new Map<string, FileChangeRecord>();
	private thinkingId: string | undefined;

	constructor(private readonly stream: vscode.ChatResponseStream, private readonly cwd: string) { }

	/** File changes the agent reported this turn, keyed by absolute path (last change wins). */
	fileChanges(): FileChangeRecord[] {
		return [...this.changes.values()];
	}

	handle(event: AgentEvent): void {
		switch (event.kind) {
			case 'text':
				this.flushPending();
				this.thinkingId = undefined;
				this.stream.markdown(event.text);
				return;
			case 'thinking':
				this.flushPending();
				this.thinkingId = event.id ?? this.thinkingId ?? 'thinking';
				this.stream.thinkingProgress({ text: event.text, id: this.thinkingId });
				return;
			case 'toolStart': {
				this.thinkingId = undefined;
				if (event.parentId) {
					const parent = this.tools.get(event.parentId);
					if (parent && !parent.pushed) {
						this.pushStart(parent);
					}
				}
				const view: ToolView = { id: event.id, tool: event.tool, input: event.input, label: event.label, parentId: event.parentId, pushed: false, done: false };
				this.tools.set(event.id, view);
				if (this.isSpecific(view)) {
					this.pushStart(view);
				}
				return;
			}
			case 'toolUpdate': {
				const view = this.tools.get(event.id);
				if (!view || view.done) {
					return;
				}
				if (event.input !== undefined) {
					view.input = event.input;
				}
				if (event.label) {
					view.label = event.label;
				}
				// The invocation message is fixed once pushed, so wait until it names the target.
				if (!view.pushed && this.isSpecific(view)) {
					this.pushStart(view);
				}
				return;
			}
			case 'toolEnd': {
				const view = this.tools.get(event.id);
				if (!view || view.done) {
					return;
				}
				if (!view.pushed) {
					this.pushStart(view);
				}
				view.done = true;
				this.pushEnd(view, event);
				return;
			}
			case 'fileChange': {
				const absolute = this.absolute(event.path);
				this.changes.set(absolute, { path: absolute, change: event.change });
				return;
			}
		}
	}

	/** Marks tools that never reported a result as finished so no spinner is left behind. */
	finish(): void {
		for (const view of this.tools.values()) {
			if (!view.done) {
				if (!view.pushed) {
					this.pushStart(view);
				}
				view.done = true;
				this.pushEnd(view, { kind: 'toolEnd', id: view.id, ok: false });
			}
		}
	}

	private flushPending(): void {
		for (const view of this.tools.values()) {
			if (!view.pushed && !view.done) {
				this.pushStart(view);
			}
		}
	}

	private isSpecific(view: ToolView): boolean {
		const description = describeTool(view.tool, view.input, this.cwd);
		return description.kind === 'todo' || description.kind === 'plan' || !!description.target;
	}

	private absolute(file: string): string {
		return path.isAbsolute(file) ? file : path.join(this.cwd, file);
	}

	private message(description: ToolDescription, view: ToolView, tense: 'present' | 'past', suffix = ''): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = false;
		if (description.path && FILE_KINDS.has(description.kind)) {
			const uri = vscode.Uri.file(this.absolute(description.path));
			const fragment = description.startLine !== undefined ? `L${description.startLine}${description.endLine !== undefined ? `-L${description.endLine}` : ''}` : '';
			const target = fragment ? uri.with({ fragment }) : uri;
			const verb = tense === 'present' ? description.present : description.past;
			const lines = description.startLine !== undefined
				? description.endLine !== undefined ? `, lines ${description.startLine}-${description.endLine}` : `, from line ${description.startLine}`
				: '';
			// An empty link text renders as a clickable file widget in chat.
			md.appendMarkdown(`${verb} [](${target.toString()})${lines}${suffix}`);
			return md;
		}
		const label = tense === 'present' && view.label ? view.label : formatLabel(description, tense);
		md.appendMarkdown(`${label}${suffix}`);
		return md;
	}

	private part(view: ToolView, complete: boolean): vscode.ChatToolInvocationPart {
		const part = new vscode.ChatToolInvocationPart(view.tool, view.id);
		part.enablePartialUpdate = true;
		part.isComplete = complete;
		if (view.parentId && this.tools.get(view.parentId)?.pushed) {
			part.subAgentInvocationId = view.parentId;
		}
		return part;
	}

	private pushStart(view: ToolView): void {
		view.pushed = true;
		const description = describeTool(view.tool, view.input, this.cwd);
		const part = this.part(view, false);
		part.invocationMessage = this.message(description, view, 'present');
		part.pastTenseMessage = this.message(description, view, 'past');
		const data = this.specificData(description, view, undefined);
		if (data) {
			part.toolSpecificData = data;
		}
		this.stream.push(part);
	}

	private pushEnd(view: ToolView, end: Extract<AgentEvent, { kind: 'toolEnd' }>): void {
		const description = describeTool(view.tool, view.input, this.cwd);
		const part = this.part(view, true);
		let suffix = '';
		if (description.kind === 'run' && end.exitCode !== undefined) {
			suffix = end.exitCode === 0 ? '' : ` (exit ${end.exitCode})`;
		} else if (!end.ok) {
			suffix = ' (failed)';
		}
		part.isError = !end.ok;
		part.pastTenseMessage = this.message(description, view, 'past', suffix);
		const data = this.specificData(description, view, end);
		if (data) {
			part.toolSpecificData = data;
		}
		this.stream.push(part);
	}

	private specificData(description: ToolDescription, view: ToolView, end: Extract<AgentEvent, { kind: 'toolEnd' }> | undefined): vscode.ChatToolInvocationPart['toolSpecificData'] {
		const input = view.input && typeof view.input === 'object' ? view.input as Record<string, unknown> : {};
		if (description.kind === 'run' && description.command) {
			const data: vscode.ChatTerminalToolInvocationData = {
				commandLine: { original: description.command },
				language: 'sh',
			};
			if (end) {
				if (end.output !== undefined) {
					data.output = { text: end.output };
				}
				data.state = { exitCode: end.exitCode ?? (end.ok ? 0 : 1) };
			}
			return data;
		}
		if (description.kind === 'agent' && !view.parentId) {
			const data = new vscode.ChatSubagentToolInvocationData(
				typeof input.description === 'string' ? input.description : description.target,
				typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
				typeof input.prompt === 'string' ? input.prompt : undefined,
				end?.output,
			);
			return data;
		}
		if (description.kind === 'todo') {
			const todos = todoItems(input);
			return todos.length ? { todoList: todos } : undefined;
		}
		return undefined;
	}
}

function todoItems(input: Record<string, unknown>): vscode.ChatTodoToolInvocationData['todoList'] {
	const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.items) ? input.items : [];
	const result: vscode.ChatTodoToolInvocationData['todoList'] = [];
	list.forEach((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			return;
		}
		const item = entry as Record<string, unknown>;
		const title = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : '';
		if (!title) {
			return;
		}
		const status = item.status === 'completed' || item.completed === true
			? vscode.ChatTodoStatus.Completed
			: item.status === 'in_progress' ? vscode.ChatTodoStatus.InProgress : vscode.ChatTodoStatus.NotStarted;
		result.push({ id: index + 1, title, status });
	});
	return result;
}
