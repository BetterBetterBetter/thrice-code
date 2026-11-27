import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import type { EditorToolBridge } from './editorTools';
import { editorToolEnvironment, withEditorTools } from './editorToolPolicy';
import type { ChildRunSink } from './agents';
import { instanceArgv, missingEnvironment, type ChatTurnMode, type ProviderInstance } from './instances';
import { createEventDecoder, type AgentEvent } from './events';

export interface RunOptions {
	readonly cwd?: string;
	readonly signal?: AbortSignal;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly model?: string;
	readonly mode?: ChatTurnMode;
	readonly editorTools?: EditorToolBridge;
	readonly extraDirectories?: readonly string[];
	/** How many agents started this one: 0 for a chat turn. Limits runAgent through the thrice MCP. */
	readonly agentDepth?: number;
	/** Shows the agents this run starts, nested under its runAgent calls. */
	readonly childRuns?: ChildRunSink;
	/** Answer text only. */
	readonly onText?: (text: string) => void;
	/** Every decoded event, including text, thinking and tool activity (Contract 4). */
	readonly onEvent?: (event: AgentEvent) => void;
}

/** Shell values that would send a CLI to the gateway instead of its own saved login. */
const INHERITED_GATEWAY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'AGENTCLI_KEY', 'OPENAI_API_KEY'];

export function environmentForChild(instance: Pick<ProviderInstance, 'environment'>, base: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (typeof value === 'string') {
			env[key] = value;
		}
	}
	const explicit = new Set<string>();
	for (const entry of instance.environment) {
		env[entry.name] = expandHome(entry.value);
		explicit.add(entry.name);
	}
	for (const name of INHERITED_GATEWAY_ENV) {
		if (!explicit.has(name)) {
			delete env[name];
		}
	}
	return env;
}

function childEnv(instance: ProviderInstance, base: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
	return environmentForChild(instance, base);
}

function expandHome(value: string): string {
	if (value === '~') {
		return homedir();
	}
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return homedir() + value.slice(1);
	}
	return value;
}

function terminate(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const pid = child.pid;
	if (process.platform !== 'win32') {
		try {
			process.kill(-pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	} else {
		child.kill('SIGTERM');
	}
}

export function runInstance(instance: ProviderInstance, prompt: string, options: RunOptions): Promise<void> {
	const missing = missingEnvironment(instance);
	if (missing.length > 0) {
		return Promise.reject(new Error(`${instance.displayName} needs ${missing.join(', ')} from your environment or Thrice provider settings.`));
	}
	const decoder = createEventDecoder(instance.driver, { cwd: options.cwd });
	const emit = (line: string) => {
		for (const event of decoder.push(line)) {
			if (event.kind === 'text') {
				options.onText?.(event.text);
			}
			options.onEvent?.(event);
		}
	};
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = '';
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const launch = options.editorTools?.prepare(prompt, {
			depth: options.agentDepth ?? 0,
			agent: instance.id,
			displayName: instance.displayName,
			model: options.model,
			mode: options.mode,
			cwd: options.cwd,
			extraDirectories: options.extraDirectories,
			children: options.childRuns,
		});
		let child: ChildProcess;
		try {
			const base = options.env ?? process.env;
			child = spawn(instance.command, withEditorTools(instance.driver, instanceArgv(instance, prompt, options.model, options.mode), launch, options.extraDirectories), {
				cwd: options.cwd,
				env: { ...childEnv(instance, base), ...editorToolEnvironment(instance.driver, launch, base) },
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			launch?.dispose();
			finish(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const onAbort = () => terminate(child);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				emit(line);
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.on('error', error => {
			launch?.dispose();
			options.signal?.removeEventListener('abort', onAbort);
			const missingCommand = (error as NodeJS.ErrnoException).code === 'ENOENT';
			finish(new Error(missingCommand ? `${instance.displayName} could not find ${instance.command}.` : error.message));
		});
		child.on('exit', code => {
			launch?.dispose();
			options.signal?.removeEventListener('abort', onAbort);
			if (buffer.trim()) {
				emit(buffer);
			}
			if (options.signal?.aborted) {
				finish(new Error(`${instance.displayName} was cancelled.`));
				return;
			}
			const failure = decoder.failure();
			if (failure) {
				finish(new Error(failure));
				return;
			}
			if (code !== 0) {
				finish(new Error(stderr.trim() || `${instance.displayName} exited with code ${code}.`));
				return;
			}
			finish();
		});
	});
}
