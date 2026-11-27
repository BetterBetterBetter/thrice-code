import * as vscode from 'vscode';
import { checkout } from './checkout';

export function activate(_context: vscode.ExtensionContext): void {
	void checkout;
}

export function deactivate(): void {
}
