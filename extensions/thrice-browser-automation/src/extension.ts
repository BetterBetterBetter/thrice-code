import * as vscode from 'vscode';
import { BROWSER_ERROR_CATALOG } from './errors';

export function activate(_context: vscode.ExtensionContext): void {
	void BROWSER_ERROR_CATALOG;
}

export function deactivate(): void {
}
