import type { Driver } from './instances';

/** A model inside a hub. The hub itself is the provider, not a model. */
export interface HubModel {
	readonly id: string;
	readonly name: string;
	readonly isDefault?: boolean;
}

/** Current models from T3's catalog. Legacy rows stay out of the picker. */
const CLAUDE_MODELS: readonly HubModel[] = [
	{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
	{ id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
	{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
	{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];

const CODEX_MODELS: readonly HubModel[] = [
	{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
	{ id: 'gpt-6-astra', name: 'GPT-6 Astra' },
	{ id: 'gpt-6-luna', name: 'GPT-6 Luna' },
];

const GROK_MODELS: readonly HubModel[] = [
	{ id: 'agentcli/grok-4.7', name: 'Grok 4.7', isDefault: true },
];

/** Current Antigravity rows from T3's model manifest. The default is Gemini 3.8 Flash (High). */
const ANTIGRAVITY_MODELS: readonly HubModel[] = [
	{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
	{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
	{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
	{ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', isDefault: true },
	{ id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
	{ id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
];

/** fx always offers this row. Signed-in backends add their own ids beside it. */
const FX_MODELS: readonly HubModel[] = [
	{ id: 'default', name: 'Default', isDefault: true },
];

export function modelsForDriver(driver: Driver): readonly HubModel[] {
	switch (driver) {
		case 'claude': return CLAUDE_MODELS;
		case 'codex': return CODEX_MODELS;
		case 'antigravity': return ANTIGRAVITY_MODELS;
		case 'opencode':
		case 'grok': return GROK_MODELS;
		case 'fx': return FX_MODELS;
		default: return [];
	}
}

export function defaultModelId(driver: Driver): string {
	const models = modelsForDriver(driver);
	return models.find(model => model.isDefault)?.id ?? models[0]?.id ?? 'default';
}

const ANSI = /\u001b\[[0-9;]*m/g;
const CURSOR_LINE = /^(\S+)\s+-\s+(.+)$/;
const CURSOR_FLAGS = /\s+\(([^)]+)\)\s*$/;
const NAME_SUFFIX = /\s+(?:Extra High|Low|Medium|High|Max|Fast|Thinking)$/i;
const FAST_SUFFIX = '-fast';

function baseName(name: string): string {
	let value = name.replace(/\s+/g, ' ').trim();
	let next = value.replace(NAME_SUFFIX, '').trim();
	while (next !== value) {
		value = next;
		next = value.replace(NAME_SUFFIX, '').trim();
	}
	return value;
}

function withoutFast(id: string): string {
	return id.endsWith(FAST_SUFFIX) ? id.slice(0, -FAST_SUFFIX.length) : id;
}

/** Lower is a better stand-in for T3's one row per model. Bare and high ids win over the other efforts. */
function effortRank(id: string): number {
	const bare = withoutFast(id);
	if (/-thinking(?:-|$)/.test(bare)) {
		return 50;
	}
	if (/(?:^|-)high$/.test(bare)) {
		return 0;
	}
	if (/(?:^|-)medium$/.test(bare)) {
		return 1;
	}
	if (!/-(?:low|medium|high|xhigh|max)$/.test(bare)) {
		return 2;
	}
	if (/(?:^|-)xhigh$/.test(bare)) {
		return 3;
	}
	if (/(?:^|-)max$/.test(bare)) {
		return 4;
	}
	return 5;
}

interface ParsedCursorModel {
	readonly id: string;
	readonly name: string;
	readonly isDefault: boolean;
}

/**
 * `agent models` prints one line per effort and speed. T3 keeps one row per model
 * and a fast twin, so the picker can offer speed without listing every effort.
 */
export function parseCursorModels(output: string): HubModel[] {
	const parsed: ParsedCursorModel[] = [];
	for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
		const match = line.trim().match(CURSOR_LINE);
		if (!match?.[1] || !match[2]) {
			continue;
		}
		const flags = match[2].match(CURSOR_FLAGS);
		const flagText = flags?.[1] ?? '';
		if (flags && !/^(?:current|default)(?:,\s*(?:current|default))?$/.test(flagText)) {
			continue;
		}
		parsed.push({
			id: match[1],
			name: flags ? match[2].slice(0, flags.index).trim() : match[2].trim(),
			isDefault: flagText.split(',').some(flag => flag.trim() === 'default'),
		});
	}
	const groups = new Map<string, ParsedCursorModel[]>();
	for (const model of parsed) {
		const key = baseName(model.name);
		const group = groups.get(key);
		if (group) {
			group.push(model);
		} else {
			groups.set(key, [model]);
		}
	}
	const listed: HubModel[] = [];
	for (const [name, group] of groups) {
		const primary = [...group].sort((left, right) => {
			if (left.isDefault !== right.isDefault) {
				return left.isDefault ? -1 : 1;
			}
			const rank = effortRank(left.id) - effortRank(right.id);
			return rank !== 0 ? rank : left.id.length - right.id.length;
		})[0];
		if (!primary) {
			continue;
		}
		listed.push({ id: primary.id, name, isDefault: group.some(model => model.isDefault) });
		const fastId = `${withoutFast(primary.id)}${FAST_SUFFIX}`;
		if (fastId !== primary.id && group.some(model => model.id === fastId)) {
			listed.push({ id: fastId, name });
		}
	}
	return listed.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
}

/** OpenCode prints one `provider/model` id per line. */
export function parseOpencodeModels(output: string): HubModel[] {
	const seen = new Set<string>();
	const models: HubModel[] = [];
	for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
		const id = line.trim();
		if (!id || /\s/.test(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const slug = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
		const name = slug.split('-').map(part => part.toLowerCase() === 'grok' ? 'Grok' : part).join(' ');
		models.push({ id, name, ...(id === 'agentcli/grok-4.7' ? { isDefault: true } : {}) });
	}
	return models.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
}

/** `grok models` prints a bullet per slug. The same slug is listed once. */
export function parseGrokModels(output: string): HubModel[] {
	const seen = new Set<string>();
	const models: HubModel[] = [];
	for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
		const bullet = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
		const id = bullet?.[1];
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		models.push({
			id,
			name: id.split(/[-_]/g).map(part => part.toLowerCase() === 'grok' ? 'Grok' : part).join(' '),
			...(/\bdefault\b/i.test(bullet?.[2] ?? '') ? { isDefault: true } : {}),
		});
	}
	return models;
}

/** `fx models --json` is `{ "ids": ["..."] }`. Default stays the row T3 always shows. */
export function parseFxModels(output: string): HubModel[] {
	let ids: unknown;
	try {
		ids = (JSON.parse(output) as { ids?: unknown }).ids;
	} catch {
		return [...FX_MODELS];
	}
	if (!Array.isArray(ids)) {
		return [...FX_MODELS];
	}
	const models: HubModel[] = [...FX_MODELS];
	const seen = new Set(models.map(model => model.id));
	for (const id of ids) {
		if (typeof id !== 'string' || !id.trim() || seen.has(id)) {
			continue;
		}
		seen.add(id);
		models.push({ id, name: id });
	}
	return models;
}
