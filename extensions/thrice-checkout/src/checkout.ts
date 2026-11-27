export const HOOKS_PATH_KEY = 'core.hooksPath';
export const GIT_FLAGS = ['--ext-diff', '--no-ext-diff', '--textconv', '--no-textconv'] as const;

export function normalizeBranchName(name: string): string | { ok: false; reason: 'empty-branch' } {
	const trimmed = name.trim();
	if (!trimmed) {
		return { ok: false, reason: 'empty-branch' };
	}
	return trimmed;
}

export function normalizeRemoteName(name: string): string {
	const trimmed = name.trim();
	return trimmed.length === 0 ? 'origin' : trimmed;
}

export function workingTreeIsDirty(porcelain: string): boolean {
	return porcelain.trim().length > 0;
}

export function checkout(input: { dirty: boolean }): { ok: true } | { ok: false; reason: 'dirty-tree-choice-unknown' } {
	if (input.dirty) {
		return { ok: false, reason: 'dirty-tree-choice-unknown' };
	}
	return { ok: true };
}

export function isNonFastForwardPushError(text: string): boolean {
	return text.includes('non-fast-forward');
}
