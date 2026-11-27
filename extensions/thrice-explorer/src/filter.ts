export const ABORT_MESSAGE = 'Workspace explorer aborted';

export type EntryKind = 'directory' | 'file' | 'symlink';

const NAMED_KINDS: Record<string, string> = {
	HEAD: 'HEAD',
	refs: 'refs',
	objects: 'objects',
};

export function classify(entry: { name: string; entryKind: EntryKind }): string {
	if (entry.name === '.git' && entry.entryKind === 'directory') {
		return 'git-directory';
	}
	if (entry.name === '.git' && entry.entryKind === 'file') {
		return 'git-file';
	}
	return NAMED_KINDS[entry.name] ?? entry.entryKind;
}

export type Filter = {
	patterns: readonly string[];
	abortedMessage(aborted: boolean): string | undefined;
};

export function createFilter(): Filter {
	return {
		patterns: [],
		abortedMessage(aborted: boolean): string | undefined {
			return aborted ? ABORT_MESSAGE : undefined;
		},
	};
}

export function addPattern(filter: Filter, pattern: string): Filter {
	return {
		patterns: [...filter.patterns, pattern],
		abortedMessage: filter.abortedMessage,
	};
}

export function ignores(filter: Filter, relativePath: string): boolean {
	return filter.patterns.includes(relativePath);
}
