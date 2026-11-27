export type MigrationMode = 'off' | 'dry-run' | 'migrate';
export type InferenceRoute = 'auto' | 'always' | 'never';

export function hostOwnedSessionStorageEnabled(setting: boolean, env: string | undefined): boolean {
	return setting || env === '1' || env === 'true';
}

export function legacyMigrationMode(setting: MigrationMode, env: string | undefined): MigrationMode {
	if (env === 'dry-run' || env === 'migrate') {
		return env;
	}
	return setting;
}

export function runMigration(input: {
	mode: MigrationMode;
	hostOwned: boolean;
	requested: boolean;
}): { ran: boolean; wrote: false; reason?: 'migration-tool-unknown' | 'host-owned-storage-off' } {
	if (!input.hostOwned) {
		return { ran: false, wrote: false, reason: 'host-owned-storage-off' };
	}
	if (input.mode === 'off' && !input.requested) {
		return { ran: false, wrote: false };
	}
	if (input.mode === 'dry-run') {
		return { ran: true, wrote: false };
	}
	return { ran: true, wrote: false, reason: 'migration-tool-unknown' };
}

export function resolveInferenceRoute(route: InferenceRoute): { route: InferenceRoute; choice: 'unknown' | 'setting' } {
	if (route === 'auto') {
		return { route, choice: 'unknown' };
	}
	return { route, choice: 'setting' };
}
