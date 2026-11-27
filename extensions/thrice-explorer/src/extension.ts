import * as vscode from 'vscode';
import { createFilter } from './filter';

export function activate(_context: vscode.ExtensionContext): void {
	void createFilter;
}

export function deactivate(): void {
}
