import * as vscode from 'vscode';
import { ProcessEditorProvider } from './views/processEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ProcessEditorProvider.register(context));
}

export function deactivate(): void {
  // Nothing to clean up: all disposables are registered on the context.
}
