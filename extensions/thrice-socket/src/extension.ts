import * as vscode from 'vscode';
import { createLease } from './lease';

export function activate(_context: vscode.ExtensionContext): void {
	void createLease;
}

export function deactivate(): void {
}
