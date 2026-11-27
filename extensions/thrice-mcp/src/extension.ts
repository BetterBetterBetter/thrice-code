import * as vscode from 'vscode';
import { handleUri } from './mcp';

const UNCONFIRMED = 'URI grammar is unconfirmed.';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri(uri: vscode.Uri): void {
			handleUri(uri.toString());
			void vscode.window.showWarningMessage(UNCONFIRMED);
		},
	}));
}

export function deactivate(): void {
}
