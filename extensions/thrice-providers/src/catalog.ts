import { execFile } from 'node:child_process';
import type { ProviderInstance } from './instances';
import { parseCursorModels, parseFxModels, parseGrokModels, parseOpencodeModels, type HubModel } from './models';
import { environmentForChild } from './run';

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Drivers whose picker list comes from the installed CLI, as T3 reads it.
 * Claude, Codex, and Antigravity stay on T3's current manifest instead.
 */
export function discoverModels(
	instance: ProviderInstance,
	base: Readonly<Record<string, string | undefined>>,
): Promise<readonly HubModel[] | undefined> {
	const command = discoveryCommand(instance);
	if (!command) {
		return Promise.resolve(undefined);
	}
	return run(instance.command, command, environmentForChild(instance, base))
		.then(output => parseDiscovery(instance.driver, output))
		.catch(() => undefined);
}

function discoveryCommand(instance: ProviderInstance): readonly string[] | undefined {
	switch (instance.driver) {
		case 'cursor': return ['models'];
		case 'opencode': return ['models', '--pure'];
		case 'grok': return ['models'];
		case 'fx': return ['models', '--json'];
		default: return undefined;
	}
}

function parseDiscovery(driver: ProviderInstance['driver'], output: string): readonly HubModel[] {
	switch (driver) {
		case 'cursor': return parseCursorModels(output);
		case 'opencode': return parseOpencodeModels(output);
		case 'grok': return parseGrokModels(output);
		case 'fx': return parseFxModels(output);
		default: return [];
	}
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, {
			timeout: DISCOVERY_TIMEOUT_MS,
			env: { ...env, NO_COLOR: '1', TERM: 'dumb' },
			maxBuffer: 1_000_000,
			windowsHide: true,
		}, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
}
