import * as vscode from 'vscode';
import { developerCommand } from './commands';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('thrice.retrieval.grepClient.debug', () => {
			const result = developerCommand('debug');
			void vscode.window.showWarningMessage(result.reason);
		}),
		vscode.commands.registerCommand('thrice.retrieval.codebaseTelemetry.triggerSnapshot', () => {
			const result = developerCommand('snapshot');
			void vscode.window.showWarningMessage(result.reason);
		}),
		vscode.commands.registerCommand('thrice.retrieval.codebaseTelemetry.reportComposerRequest', () => {
			const result = developerCommand('report');
			void vscode.window.showWarningMessage(result.reason);
		}),
	);
}

export function deactivate(): void {
}
