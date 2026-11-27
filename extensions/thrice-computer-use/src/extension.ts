import * as vscode from 'vscode';
import { openSession } from './session';

export function activate(_context: vscode.ExtensionContext): void {
	void openSession;
}

export function deactivate(): void {
}
