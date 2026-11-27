import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseInstalledSettings, type InstalledInstance } from './instances';

/** Reads provider instances the user already configured for T3. Missing file means none. */
export function readInstalledInstances(path = join(homedir(), '.t3', 'userdata', 'settings.json')): InstalledInstance[] {
	try {
		return parseInstalledSettings(JSON.parse(readFileSync(path, 'utf8')) as unknown);
	} catch {
		return [];
	}
}
