export function ghostTextSuffix(history: readonly string[], prefix: string): string | undefined {
	if (!prefix || prefix.trim().length === 0 || prefix.includes('\n')) {
		return undefined;
	}
	for (let index = history.length - 1; index >= 0; index--) {
		const entry = history[index];
		if (!entry.startsWith(prefix) || entry.length === prefix.length || entry.slice(prefix.length).includes('\n')) {
			continue;
		}
		return entry.slice(prefix.length);
	}
	return undefined;
}
