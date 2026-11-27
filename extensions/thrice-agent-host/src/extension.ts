import * as vscode from 'vscode';
import { hostOwnedSessionStorageEnabled, legacyMigrationMode, resolveInferenceRoute, runMigration } from './host';

const STORE_UNKNOWN = 'Agent host store format is unconfirmed. Nothing was written.';

export function activate(context: vscode.ExtensionContext): void {
	const config = vscode.workspace.getConfiguration();
	const hostOwned = hostOwnedSessionStorageEnabled(
		config.get<boolean>('thrice.agentHost.experimentalHostOwnedSessionStorage', false),
		process.env.CURSOR_AGENT_HOST_OWNED_SESSION_STORAGE,
	);
	const mode = legacyMigrationMode(
		config.get<'off' | 'dry-run' | 'migrate'>('thrice.agentHost.experimentalLegacyMigration', 'off'),
		process.env.CURSOR_AGENT_HOST_LEGACY_MIGRATION,
	);
	runMigration({ mode, hostOwned, requested: false });
	resolveInferenceRoute(config.get<'auto' | 'always' | 'never'>('thrice.agentHost.remoteInferenceRoute', 'auto'));

	context.subscriptions.push(
		vscode.commands.registerCommand('thrice.agentHost.developer.compareStoresOnce', () => {
			void vscode.window.showWarningMessage(STORE_UNKNOWN);
		}),
		vscode.commands.registerCommand('thrice.agentHost.developer.migrateLegacyChats', () => {
			runMigration({ mode, hostOwned, requested: true });
			void vscode.window.showWarningMessage(STORE_UNKNOWN);
		}),
	);
}

export function deactivate(): void {
}
