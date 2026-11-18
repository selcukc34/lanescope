// Read-only custom editor that shows a Bob .bpmn file (or a .zip holding one)
// or an IBM BAW .twx export as a BPMN diagram. Nothing is ever written back
// to the opened file.

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readBpmnPackage } from '../input/bpmnInput';
import { readProcessPackage } from '../bpmn/bpmnReader';
import { readTwxPackage } from '../twx/twxImport';
import type { HostMessage, ViewerSettings } from './protocol';
import { ViewerSession } from './viewerSession';
import { isWatchedChange, watchPatternFor } from './watchPattern';
import { buildWebviewHtml, createNonce } from './webviewHtml';

export const VIEW_TYPE = 'lanescope.processViewer';
export const OPEN_COMMAND = 'lanescope.open';
export const CONFIG_SECTION = 'lanescope';

const SUPPORTED = new Set(['.bpmn', '.zip', '.twx']);

export class ProcessEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ProcessEditorProvider(context.extensionUri);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand(OPEN_COMMAND, (uri?: vscode.Uri) => openInViewer(uri)),
    );
  }

  private constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };

    const fileName = path.basename(document.uri.path);
    const session = new ViewerSession({
      fileName,
      load: () => loadPackage(document.uri),
      post: (message: HostMessage) => webview.postMessage(message),
      settings: readSettings(),
    });
    // Listen before setting the HTML so the webview's "ready" is never missed.
    const listener = webview.onDidReceiveMessage((msg: unknown) => void session.handleMessage(msg));
    const watcher = watchForChanges(document.uri, () => session.fileChanged());
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) void session.updateSettings(readSettings());
    });
    panel.onDidDispose(() => {
      session.dispose();
      watcher?.dispose();
      config.dispose();
      listener.dispose();
    });
    // Load while the webview boots; the result is posted once it says "ready".
    void session.start();

    webview.html = buildWebviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.css')).toString(),
      nonce: createNonce((n) => randomBytes(n)),
      title: fileName,
    });
  }
}

function readSettings(): ViewerSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return { showScripts: config.get<boolean>('showScripts', true) !== false };
}

/**
 * Watches the opened file (and, for a .bpmn, the .xsd files next to it).
 * Create and delete count as changes: Bob may delete a file and write it anew.
 * Only reads file events; never touches the files.
 */
function watchForChanges(uri: vscode.Uri, onChange: () => void): vscode.Disposable | undefined {
  if (uri.scheme !== 'file') return undefined;
  const { base, glob } = watchPatternFor(uri.fsPath);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
  const handle = (changed: vscode.Uri) => {
    if (changed.scheme === 'file' && isWatchedChange(uri.fsPath, changed.fsPath)) onChange();
  };
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(handle),
    watcher.onDidCreate(handle),
    watcher.onDidDelete(handle),
  );
}

async function loadPackage(uri: vscode.Uri) {
  if (uri.scheme !== 'file') {
    throw new Error(`Only local files can be opened (this file is on "${uri.scheme}").`);
  }
  if (path.extname(uri.fsPath).toLowerCase() === '.twx') return readTwxPackage(uri.fsPath);
  return readProcessPackage(await readBpmnPackage(uri.fsPath));
}

/** Opens a .bpmn, .zip or .twx in the viewer: the Explorer selection, the active editor, or a picked file. */
async function openInViewer(uri?: vscode.Uri): Promise<void> {
  const target = (uri instanceof vscode.Uri ? uri : undefined) ?? activeFileUri() ?? (await pickFile());
  if (!target) return;
  if (!SUPPORTED.has(path.extname(target.path).toLowerCase())) {
    void vscode.window.showErrorMessage('Lanescope can open .bpmn, .zip and .twx files only.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

function activeFileUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri =
    input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
  return uri && SUPPORTED.has(path.extname(uri.path).toLowerCase()) ? uri : undefined;
}

async function pickFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Open in Lanescope',
    filters: { 'Bob BPMN package or BAW export': ['zip', 'bpmn', 'twx'] },
  });
  return picked?.[0];
}
