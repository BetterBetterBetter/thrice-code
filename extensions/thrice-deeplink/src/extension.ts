import * as vscode from 'vscode';
import { triggerDeeplink } from './deeplink';

const UNCONFIRMED = 'URI grammar is unconfirmed.';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('thrice.deeplink.debug.triggerDeeplink', () => {
			const result = triggerDeeplink('');
			void vscode.window.showWarningMessage(result.reason === 'uri-grammar-unconfirmed' ? UNCONFIRMED : result.reason);
		}),
		vscode.window.registerUriHandler({
			handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
				triggerDeeplink(uri.toString());
				void vscode.window.showWarningMessage(UNCONFIRMED);
			},
		}),
	);
}

export function deactivate(): void {
}
