import * as vscode from 'vscode';
import { CHANGE_PORT, DEFAULT_BIND, PORT_IN_USE, createIngest, reassignPort, resolveListenPort, start, stop, type Ingest } from './ingest';

let ingest: Ingest = createIngest();

function configuredPort(): number {
	return vscode.workspace.getConfiguration().get<number>('thrice.ndjson.port', 0);
}

function configuredBind(): string {
	return vscode.workspace.getConfiguration().get<string>('thrice.ndjson.bindAddress', DEFAULT_BIND);
}

function taken(port: number): boolean {
	return ingest.state === 'listening' && ingest.port === port;
}

function describe(current: Ingest): string {
	if (current.state === 'listening') {
		return `${current.state} ${current.bindAddress}:${current.port}`;
	}
	return current.state;
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('thrice.ndjson.start', async () => {
			const resolved = resolveListenPort(configuredPort(), taken);
			if (typeof resolved !== 'number') {
				const choice = await vscode.window.showErrorMessage(resolved.error, resolved.action);
				if (choice === CHANGE_PORT) {
					await vscode.commands.executeCommand('thrice.ndjson.reassignPort');
				}
				return;
			}
			ingest = start(ingest, { port: resolved, bindAddress: configuredBind() });
			void vscode.window.showInformationMessage(describe(ingest));
		}),
		vscode.commands.registerCommand('thrice.ndjson.stop', () => {
			ingest = stop(ingest);
			void vscode.window.showInformationMessage(ingest.state);
		}),
		vscode.commands.registerCommand('thrice.ndjson.showStatus', () => {
			void vscode.window.showInformationMessage(describe(ingest));
		}),
		vscode.commands.registerCommand('thrice.ndjson.reassignPort', () => {
			const resolved = resolveListenPort(0, port => taken(port));
			if (typeof resolved !== 'number') {
				void vscode.window.showErrorMessage(PORT_IN_USE, CHANGE_PORT);
				return;
			}
			const bindAddress = ingest.state === 'listening' ? ingest.bindAddress : configuredBind();
			ingest = reassignPort(ingest.state === 'listening' ? ingest : start(ingest, { port: resolved, bindAddress }), resolved);
			void vscode.window.showInformationMessage(describe(ingest));
		}),
	);
}

export function deactivate(): void {
	ingest = stop(ingest);
}
