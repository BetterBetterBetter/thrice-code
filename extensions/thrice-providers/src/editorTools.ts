import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { denialFromHook, interpretMcp, mcpStdioFrame, SESSION_TOOL_NAMES, TERMINAL_TOOL_NAME, toolResultMessage, type EditorToolLaunch } from './editorToolPolicy';

const SHIM = `import { writeSync } from 'node:fs';
import { request } from 'node:http';
const port = process.argv[2];
const token = process.argv[3];
function post(body) {
	return new Promise((resolve, reject) => {
		const req = request({
			hostname: '127.0.0.1', port: Number(port), path: '/mcp', method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + token },
		}, res => {
			const chunks = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
		});
		req.on('error', reject);
		req.end(body);
	});
}
let buffer = Buffer.alloc(0);
let pumping = false;
let pending = false;
function takeMessage() {
	const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
	const lineEnd = buffer.indexOf('\\n');
	if (headerEnd !== -1 && (lineEnd === -1 || headerEnd < lineEnd)) {
		const header = buffer.subarray(0, headerEnd).toString('utf8');
		const match = /content-length:\\s*(\\d+)/i.exec(header);
		if (!match) { buffer = buffer.subarray(headerEnd + 4); return null; }
		const length = Number(match[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return null;
		const body = buffer.subarray(start, start + length).toString('utf8');
		buffer = buffer.subarray(start + length);
		return body;
	}
	if (lineEnd === -1) return null;
	const line = buffer.subarray(0, lineEnd).toString('utf8').trim();
	buffer = buffer.subarray(lineEnd + 1);
	return line || null;
}
async function pump() {
	if (pumping) { pending = true; return; }
	pumping = true;
	try {
		do {
			pending = false;
			for (;;) {
				const message = takeMessage();
				if (!message) break;
				const response = await post(message);
				if (response.length > 0) writeSync(1, response);
			}
		} while (pending);
	} catch (error) {
		process.stderr.write(String(error) + '\\n');
	} finally {
		pumping = false;
	}
}
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); void pump(); });
`;

const GUARD = `import { request } from 'node:http';
const port = process.argv[2];
const token = process.argv[3];
const promptFile = process.argv[4];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
	const body = JSON.stringify({ hook: raw, promptFile });
	const req = request({
		hostname: '127.0.0.1', port: Number(port), path: '/guard', method: 'POST',
		headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + token },
	}, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			if (!text) process.exit(0);
			process.stderr.write(text);
			process.stdout.write(text);
			process.exit(2);
		});
	});
	req.on('error', () => process.exit(0));
	req.end(body);
});
`;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sessionName(command: string): string {
	const token = command.trim().split(/\s+/)[0] ?? '';
	const base = token.split(/[\\/]/).pop() ?? '';
	return base.slice(0, 40) || 'Agent Terminal';
}

function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
	if (terminal.shellIntegration) {
		return Promise.resolve(terminal.shellIntegration);
	}
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(terminal.shellIntegration);
		}, 4000);
		const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
			if (event.terminal === terminal && event.shellIntegration) {
				clearTimeout(timer);
				subscription.dispose();
				resolve(event.shellIntegration);
			}
		});
	});
}

async function readExecution(execution: vscode.TerminalShellExecution): Promise<{ output: string; exitCode: number | undefined }> {
	const chunks: string[] = [];
	const reader = (async () => {
		for await (const data of execution.read()) {
			chunks.push(data);
		}
	})();
	const exitCode = await new Promise<number | undefined>(resolve => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(undefined);
		}, 20000);
		const subscription = vscode.window.onDidEndTerminalShellExecution(event => {
			if (event.execution === execution) {
				clearTimeout(timer);
				subscription.dispose();
				resolve(event.exitCode);
			}
		});
	});
	await reader;
	return { output: chunks.join('').slice(-20000), exitCode };
}

const SESSION_COMMAND = 'thrice.session.invoke';

async function runSessionTool(name: string, args: Record<string, unknown>): Promise<string> {
	let result: unknown;
	try {
		result = await vscode.commands.executeCommand(SESSION_COMMAND, { tool: name, args });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || 'The editor session tools are not available in this window.');
	}
	if (typeof result !== 'string' || !result.trim()) {
		throw new Error('The editor session tools are not available in this window.');
	}
	return result;
}

export async function sessionBrief(): Promise<string> {
	try {
		return await runSessionTool('sessionContext', {});
	} catch {
		return fallbackBrief();
	}
}

function fallbackBrief(): string {
	const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
	const file = vscode.workspace.workspaceFile;
	const lines = ['Window session', file ? `Saved workspace at ${file.fsPath}.` : folders.length ? `Unsaved workspace "${vscode.workspace.name}".` : 'No folder is open. Untitled editors are the workspace.', 'Folders:'];
	lines.push(folders.length ? folders.map(folder => `- ${folder}`).join('\n') : '- none');
	const active = vscode.window.activeTextEditor;
	if (active) {
		const selection = active.selection;
		lines.push(`Active editor: ${active.document.uri.scheme === 'file' ? active.document.uri.fsPath : active.document.uri.toString()}`);
		if (!selection.isEmpty) {
			lines.push(`Selection: lines ${selection.start.line + 1}-${selection.end.line + 1}`);
		}
	}
	const editors = vscode.workspace.textDocuments.filter(document => document.isUntitled || document.isDirty || document.uri.scheme === 'untitled');
	if (editors.length) {
		lines.push('Unsaved editors:');
		for (const document of editors.slice(0, 8)) {
			const label = document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
			lines.push(`- ${label}${document.isDirty ? ' dirty' : ''}${document.isUntitled ? ' untitled' : ''}`);
		}
	}
	const terminals = vscode.window.terminals;
	lines.push(terminals.length ? `Integrated terminals: ${terminals.map(terminal => terminal === vscode.window.activeTerminal ? `${terminal.name} (focused)` : terminal.name).join(', ')}` : 'Integrated terminals: none');
	const problems = vscode.languages.getDiagnostics();
	let errors = 0;
	let warnings = 0;
	for (const [, diagnostics] of problems) {
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
				errors++;
			} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
				warnings++;
			}
		}
	}
	lines.push(`Problems: ${errors} errors, ${warnings} warnings`);
	return lines.join('\n');
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
	if (name === TERMINAL_TOOL_NAME && args.keep_open === true) {
		return runSessionTool('spawnTerminal', args);
	}
	if (name === TERMINAL_TOOL_NAME) {
		return runInEditor(args);
	}
	if (SESSION_TOOL_NAMES.has(name)) {
		return runSessionTool(name, args);
	}
	return `Error: Unknown editor tool ${name}.`;
}

async function runInEditor(args: Record<string, unknown>): Promise<string> {
	const command = typeof args.command === 'string' ? args.command.trim() : '';
	if (!command) {
		throw new Error('command is required');
	}
	const cwd = typeof args.working_directory === 'string' && args.working_directory.trim()
		? args.working_directory.trim()
		: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const keepOpen = args.keep_open === true;
	const name = keepOpen ? sessionName(command) : 'Agent Terminal';
	const terminal = vscode.window.createTerminal({ name, cwd, hideFromUser: !keepOpen, isTransient: !keepOpen });
	if (keepOpen) {
		terminal.show(false);
		terminal.sendText(command, true);
		return `Opened an integrated terminal "${name}" running \`${command}\`. It stays open in the terminal panel.`;
	}
	const integration = await waitForShellIntegration(terminal);
	if (!integration) {
		terminal.sendText(command, true);
		return `Sent \`${command}\` to the integrated terminal "${name}".`;
	}
	const execution = integration.executeCommand(command);
	const result = await readExecution(execution);
	terminal.dispose();
	const exit = result.exitCode === undefined ? '' : `\nExit code: ${result.exitCode}`;
	const output = `${result.output}${exit}`.trim();
	return output || `Sent \`${command}\` to the integrated terminal "${name}".`;
}

export interface EditorToolBridge extends vscode.Disposable {
	prepare(userPrompt: string): EditorToolLaunch;
}

export async function startEditorToolBridge(): Promise<EditorToolBridge> {
	const token = randomBytes(24).toString('hex');
	const dir = mkdtempSync(join(tmpdir(), 'thrice-editor-tools-'));
	const shimPath = join(dir, 'shim.mjs');
	const guardPath = join(dir, 'guard.mjs');
	writeFileSync(shimPath, SHIM);
	writeFileSync(guardPath, GUARD);
	const server = createServer((req, res) => {
		void handle(req, res, token);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	const port = address && typeof address === 'object' ? address.port : 0;
	const mcpConfigFile = join(dir, 'mcp.json');
	writeFileSync(mcpConfigFile, JSON.stringify({
		mcpServers: {
			thrice: { command: 'node', args: [shimPath, String(port), token] },
		},
	}));

	async function handle(req: IncomingMessage, res: ServerResponse, expected: string): Promise<void> {
		if (req.headers.authorization !== `Bearer ${expected}`) {
			res.statusCode = 401;
			res.end();
			return;
		}
		try {
			const body = await readBody(req);
			if (req.url === '/guard') {
				const parsed = JSON.parse(body) as { hook?: unknown; promptFile?: unknown };
				const hook = typeof parsed.hook === 'string' ? parsed.hook : '';
				const promptFile = typeof parsed.promptFile === 'string' ? parsed.promptFile : '';
				let userText = '';
				try {
					userText = promptFile ? readFileSync(promptFile, 'utf8') : '';
				} catch {
					userText = '';
				}
				const reason = denialFromHook(hook, userText);
				res.setHeader('content-type', 'application/json');
				res.end(reason ? JSON.stringify({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						permissionDecision: 'deny',
						permissionDecisionReason: reason,
					},
					permissionDecision: 'deny',
					permissionDecisionReason: reason,
				}) : '');
				return;
			}
			const action = interpretMcp(JSON.parse(body));
			if (action.kind === 'none') {
				res.end();
				return;
			}
			if (action.kind === 'reply') {
				res.end(mcpStdioFrame(action.message));
				return;
			}
			try {
				const text = await runTool(action.name, action.args);
				const isError = text.startsWith('Error:');
				res.end(mcpStdioFrame(toolResultMessage(action.id, text, isError)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.end(mcpStdioFrame(toolResultMessage(action.id, message, true)));
			}
		} catch (error) {
			res.statusCode = 400;
			res.end(error instanceof Error ? error.message : String(error));
		}
	}

	return {
		prepare(userPrompt: string): EditorToolLaunch {
			const launchDir = join(dir, `turn-${randomBytes(4).toString('hex')}`);
			mkdirSync(launchDir);
			const promptFile = join(launchDir, 'prompt.txt');
			const settingsFile = join(launchDir, 'settings.json');
			writeFileSync(promptFile, userPrompt);
			const command = `node ${shellQuote(guardPath)} ${port} ${token} ${shellQuote(promptFile)}`;
			writeFileSync(settingsFile, JSON.stringify({
				hooks: {
					PreToolUse: [{
						matcher: 'Bash',
						hooks: [{ type: 'command', command, timeout: 10 }],
					}],
				},
			}));
			let disposed = false;
			return {
				mcpConfigFile,
				settingsFile,
				shimPath,
				port,
				token,
				dispose: () => {
					if (disposed) {
						return;
					}
					disposed = true;
					rmSync(launchDir, { recursive: true, force: true });
				},
			};
		},
		dispose: () => {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
