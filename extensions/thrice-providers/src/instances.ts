import { ensureEditorToolInstruction } from './editorToolPolicy';
import { defaultModelId } from './models';

export type Driver = 'claude' | 'codex' | 'opencode' | 'cursor' | 'grok' | 'antigravity' | 'muse' | 'pi' | 'fx' | 'kiro' | 'acp';

export interface EnvironmentEntry {
	readonly name: string;
	readonly value: string;
}

export interface ProviderInstance {
	readonly id: string;
	readonly driver: Driver;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly command: string;
	readonly launchArgs: readonly string[];
	readonly environment: readonly EnvironmentEntry[];
	readonly requiredEnvironment: readonly string[];
}

/** A provider instance read from the user's installed T3 settings. Values never belong in the repo. */
export interface InstalledInstance {
	readonly id: string;
	readonly driver?: string;
	readonly displayName?: string;
	readonly enabled?: boolean;
	readonly launchArgs?: string | readonly string[];
	readonly environment?: readonly EnvironmentEntry[];
	readonly command?: string;
}

const DRIVERS = new Set<Driver>(['claude', 'codex', 'opencode', 'cursor', 'grok', 'antigravity', 'muse', 'pi', 'fx', 'kiro', 'acp']);

export function defaultInstances(): ProviderInstance[] {
	return [
		{
			id: 'claude',
			driver: 'claude',
			displayName: 'Claude',
			enabled: true,
			command: 'claude',
			launchArgs: ['--dangerously-skip-permissions'],
			environment: [],
			requiredEnvironment: [],
		},
		{
			id: 'codex',
			driver: 'codex',
			displayName: 'Codex',
			enabled: true,
			command: 'codex',
			launchArgs: [],
			environment: [],
			requiredEnvironment: [],
		},
		{
			id: 'claude-hub',
			driver: 'claude',
			displayName: 'Claude Hub',
			enabled: true,
			command: 'claude',
			launchArgs: ['--dangerously-skip-permissions'],
			environment: [],
			requiredEnvironment: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
		},
		{
			id: 'codex-hub',
			driver: 'codex',
			displayName: 'Codex Hub',
			enabled: true,
			command: 'codex',
			launchArgs: ['-c', 'model_provider=agentcli', '-m', 'gpt-6.1-sol'],
			environment: [],
			requiredEnvironment: ['AGENTCLI_KEY'],
		},
		{
			id: 'grok-hub',
			driver: 'opencode',
			displayName: 'Grok Hub',
			enabled: true,
			command: 'opencode',
			launchArgs: ['-m', 'agentcli/grok-4.7'],
			environment: [],
			requiredEnvironment: ['AGENTCLI_KEY'],
		},
	];
}

function modelFromArgs(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if ((arg === '-m' || arg === '--model') && args[index + 1]) {
			return args[index + 1];
		}
		if (arg === '-c' && args[index + 1]?.startsWith('model=')) {
			return args[index + 1].slice('model='.length);
		}
	}
	return undefined;
}

/** Drop a baked-in model so the picker's choice is the one that launches. */
function argsWithoutModel(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '-m' || arg === '--model') {
			index++;
			continue;
		}
		if (arg === '-c' && args[index + 1]?.startsWith('model=')) {
			index++;
			continue;
		}
		if (arg.startsWith('--model=')) {
			continue;
		}
		result.push(arg);
	}
	return result;
}

export type ChatTurnMode = 'interactive' | 'plan' | 'ask' | 'debug' | 'spec' | 'triage' | 'background';

const diagramInstruction = 'When a diagram helps, write a mermaid code fence. When a bar chart helps, write a thrice-chart code fence containing JSON with a title and a series of name and value. Do not wrap either in a tool call.';

const modeLead: Record<string, string> = {
	plan: 'Research and write a plan. Do not edit files or apply the plan.',
	ask: 'Answer the question. Do not edit files or run commands that change the project.',
	debug: 'Find the cause. Reproduce it, then change only what the fix needs.',
	spec: 'Write a specification of the behavior and the files it touches. Do not implement it.',
	triage: 'Diagnose the failure from the code and the errors. Do not edit files.',
	background: 'Finish this task without waiting for another message.',
};

export function normalizeChatTurnMode(mode: string | undefined): ChatTurnMode {
	switch (mode) {
		case 'plan':
		case 'ask':
		case 'debug':
		case 'spec':
		case 'triage':
		case 'background':
			return mode;
		default:
			return 'interactive';
	}
}

export function promptForTurn(prompt: string, mode?: ChatTurnMode): string {
	let text = prompt;
	if (!text.includes(diagramInstruction)) {
		const lead = mode ? modeLead[mode] : undefined;
		const preface = lead ? `${lead}\n\n${diagramInstruction}` : diagramInstruction;
		text = `${preface}\n\n${text}`;
	}
	return ensureEditorToolInstruction(text);
}

export function instanceArgv(instance: ProviderInstance, prompt: string, model?: string, mode?: ChatTurnMode): string[] {
	const selected = model || modelFromArgs(instance.launchArgs) || defaultModelId(instance.driver);
	const launchArgs = argsForMode(argsWithoutModel(instance.launchArgs), mode);
	const text = promptForTurn(prompt, mode);
	if (instance.driver === 'claude') {
		const plan = mode === 'plan' ? ['--permission-mode', 'plan'] : [];
		return [...launchArgs, ...plan, '--model', selected, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--', text];
	}
	if (instance.driver === 'codex') {
		// Codex refuses to start outside a trusted git repo unless this flag is set.
		return [...launchArgs, '-m', selected, 'exec', '--skip-git-repo-check', '--json', '--', text];
	}
	if (instance.driver === 'opencode') {
		const auto = isReadOnlyMode(mode) ? [] : ['--auto'];
		return ['run', '--format', 'json', ...auto, '-m', selected, ...launchArgs, text];
	}
	if (instance.driver === 'cursor') {
		const cliMode = mode === 'plan' || mode === 'ask' ? ['--mode', mode] : [];
		const modelFlag = selected && selected !== 'default' ? ['--model', selected] : [];
		return [
			...launchArgs,
			'-p',
			'--output-format', 'stream-json',
			'--stream-partial-output',
			'--trust',
			...(isReadOnlyMode(mode) ? [] : ['--force']),
			...cliMode,
			...modelFlag,
			'--',
			text,
		];
	}
	return [...launchArgs, text];
}

function isReadOnlyMode(mode: ChatTurnMode | undefined): boolean {
	return mode === 'plan' || mode === 'ask' || mode === 'spec' || mode === 'triage';
}

function argsForMode(args: readonly string[], mode: ChatTurnMode | undefined): string[] {
	if (!isReadOnlyMode(mode)) {
		return [...args];
	}
	return args.filter(arg => arg !== '--dangerously-skip-permissions');
}

export function missingEnvironment(instance: ProviderInstance): string[] {
	const present = new Set(instance.environment.map(entry => entry.name));
	return instance.requiredEnvironment.filter(name => !present.has(name));
}

function isDriver(value: string): value is Driver {
	return DRIVERS.has(value as Driver);
}

function canonicalDriver(value: string | undefined): Driver | undefined {
	if (value === 'claudeAgent') {
		return 'claude';
	}
	return value !== undefined && isDriver(value) ? value : undefined;
}

function commandFor(driver: Driver): string {
	switch (driver) {
		case 'claude': return 'claude';
		case 'codex': return 'codex';
		case 'opencode': return 'opencode';
		case 'cursor': return 'agent';
		case 'grok': return 'grok';
		case 'antigravity': return 'agy';
		case 'muse': return 'muse';
		case 'pi': return 'pi';
		case 'fx': return 'fx';
		case 'kiro': return 'kiro-cli';
		case 'acp': return 'acp';
	}
}

function splitLaunchArgs(value: string | readonly string[] | undefined): string[] {
	if (Array.isArray(value)) {
		return value.filter(item => typeof item === 'string');
	}
	if (typeof value !== 'string' || value.trim() === '') {
		return [];
	}
	return value.split(/\s+/);
}

function environmentEntries(value: unknown): EnvironmentEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const entries: EnvironmentEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const name = (item as { name?: unknown }).name;
		const entryValue = (item as { value?: unknown }).value;
		if (typeof name === 'string' && name && typeof entryValue === 'string' && entryValue) {
			entries.push({ name, value: entryValue });
		}
	}
	return entries;
}

function fillEnvironment(
	required: readonly string[],
	provided: readonly EnvironmentEntry[],
	processEnv: Readonly<Record<string, string | undefined>>,
): EnvironmentEntry[] {
	const values = new Map<string, string>();
	for (const name of required) {
		const fromProcess = processEnv[name];
		if (fromProcess) {
			values.set(name, fromProcess);
		}
	}
	for (const entry of provided) {
		if (entry.value) {
			values.set(entry.name, entry.value);
		}
	}
	return [...values].map(([name, value]) => ({ name, value }));
}

function validId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

export function parseInstalledSettings(settings: unknown): InstalledInstance[] {
	if (!settings || typeof settings !== 'object') {
		return [];
	}
	const instances = (settings as { providerInstances?: unknown }).providerInstances;
	if (!instances || typeof instances !== 'object') {
		return [];
	}
	const parsed: InstalledInstance[] = [];
	for (const [id, value] of Object.entries(instances)) {
		if (!validId(id) || !value || typeof value !== 'object') {
			continue;
		}
		const record = value as {
			driver?: unknown;
			displayName?: unknown;
			enabled?: unknown;
			environment?: unknown;
			config?: { launchArgs?: unknown };
		};
		parsed.push({
			id,
			driver: typeof record.driver === 'string' ? record.driver : undefined,
			displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
			enabled: record.enabled !== false,
			launchArgs: typeof record.config?.launchArgs === 'string' || Array.isArray(record.config?.launchArgs)
				? record.config.launchArgs as string | string[]
				: undefined,
			environment: environmentEntries(record.environment),
		});
	}
	return parsed;
}

export function parseUserInstances(value: unknown): InstalledInstance[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const parsed: InstalledInstance[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const record = item as {
			id?: unknown;
			driver?: unknown;
			displayName?: unknown;
			enabled?: unknown;
			command?: unknown;
			launchArgs?: unknown;
			environment?: unknown;
		};
		if (typeof record.id !== 'string' || !validId(record.id) || typeof record.driver !== 'string' || typeof record.displayName !== 'string') {
			continue;
		}
		parsed.push({
			id: record.id,
			driver: record.driver,
			displayName: record.displayName,
			enabled: record.enabled !== false,
			launchArgs: Array.isArray(record.launchArgs) ? record.launchArgs.filter((entry): entry is string => typeof entry === 'string') : undefined,
			environment: environmentEntries(record.environment),
			...(typeof record.command === 'string' && record.command.trim() ? { command: record.command.trim() } : {}),
		});
	}
	return parsed;
}

function toInstance(
	base: ProviderInstance | undefined,
	overlay: InstalledInstance,
	processEnv: Readonly<Record<string, string | undefined>>,
): ProviderInstance | undefined {
	const driver = canonicalDriver(overlay.driver) ?? base?.driver;
	if (!driver || !validId(overlay.id)) {
		return undefined;
	}
	const command = overlay.command || base?.command || commandFor(driver);
	const launchArgs = overlay.launchArgs !== undefined ? splitLaunchArgs(overlay.launchArgs) : [...(base?.launchArgs ?? [])];
	const required = base?.requiredEnvironment ?? overlay.environment?.map(entry => entry.name) ?? [];
	const provided = [...(base?.environment ?? []), ...(overlay.environment ?? [])];
	return {
		id: overlay.id,
		driver,
		displayName: overlay.displayName || base?.displayName || overlay.id,
		enabled: overlay.enabled !== false,
		command,
		launchArgs,
		environment: fillEnvironment(required, provided, processEnv),
		requiredEnvironment: required,
	};
}

export function resolveInstances(
	installed: readonly InstalledInstance[],
	user: readonly InstalledInstance[],
	processEnv: Readonly<Record<string, string | undefined>> = {},
): ProviderInstance[] {
	const byId = new Map<string, ProviderInstance>();
	for (const instance of defaultInstances()) {
		const match = installed.find(item => item.id === instance.id);
		const resolved = match ? toInstance(instance, match, processEnv) : {
			...instance,
			environment: fillEnvironment(instance.requiredEnvironment, [], processEnv),
		};
		if (resolved) {
			// The T3 file is only a credential source. Its enabled flag is T3's own switch.
			byId.set(instance.id, { ...resolved, enabled: instance.enabled });
		}
	}
	for (const instance of installed) {
		if (byId.has(instance.id) || instance.enabled === false) {
			continue;
		}
		const resolved = toInstance(undefined, instance, processEnv);
		if (resolved) {
			byId.set(instance.id, resolved);
		}
	}
	for (const instance of user) {
		const base = byId.get(instance.id);
		const resolved = toInstance(base, instance, processEnv);
		if (resolved) {
			byId.set(instance.id, resolved);
		}
	}
	return [...byId.values()].filter(instance => instance.enabled);
}
