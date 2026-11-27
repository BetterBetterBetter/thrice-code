const ENTRY = /^(\*|[^:]+):(\*|[^:]+)$/;
const APPROVAL_MODES = ['allowlist', 'unrestricted', 'manual'] as const;
const TOP_LEVEL = new Set(['approvalMode', 'autoReview', 'autoRun', 'mcpAllowlist', 'terminalAllowlist']);
const INSTRUCTION_KEYS = new Set(['allow_instructions', 'block_instructions']);

export function entryAllowed(entry: string): boolean {
	return ENTRY.test(entry);
}

function instructionsOk(value: unknown): boolean {
	if (value === undefined) {
		return true;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.keys(value).every(key => INSTRUCTION_KEYS.has(key));
}

export function validatePermissions(value: Record<string, unknown>): { ok: boolean } {
	if (!Object.keys(value).every(key => TOP_LEVEL.has(key))) {
		return { ok: false };
	}
	if (value.approvalMode !== undefined && !APPROVAL_MODES.includes(value.approvalMode as typeof APPROVAL_MODES[number])) {
		return { ok: false };
	}
	if (value.mcpAllowlist !== undefined) {
		if (!Array.isArray(value.mcpAllowlist) || value.mcpAllowlist.some(entry => typeof entry !== 'string' || !entryAllowed(entry))) {
			return { ok: false };
		}
	}
	if (value.terminalAllowlist !== undefined) {
		if (!Array.isArray(value.terminalAllowlist) || value.terminalAllowlist.some(entry => typeof entry !== 'string')) {
			return { ok: false };
		}
	}
	if (!instructionsOk(value.autoRun) || !instructionsOk(value.autoReview)) {
		return { ok: false };
	}
	return { ok: true };
}
