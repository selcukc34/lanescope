// Read-only custom editor that shows a Bob .bpmn file (or a .zip holding one)
// or an IBM BAW .twx export as a BPMN diagram. Nothing is ever written back
// to the opened file: exports go to a new file picked in a save dialog and
// checked by ./exportFiles (never the input, never an input type).

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readBpmnPackage } from '../input/bpmnInput';
import { readProcessPackage } from '../bpmn/bpmnReader';
import { readTwxPackage } from '../twx/twxImport';
import {
  BPMN_EXPORT_NOTE,
  checkExportTarget,
  chooseExportFolder,
  defaultExportPath,
  EXPORT_EXTENSIONS,
  EXPORT_LABELS,
} from './exportFiles';
import { EXPORT_FORMATS, type ExportFormat, type HostMessage, type ViewerSettings } from './protocol';
import { ViewerSession, type ExportHost } from './viewerSession';
import { isWatchedChange, watchPatternFor } from './watchPattern';
import { buildWebviewHtml, createNonce } from './webviewHtml';

export const VIEW_TYPE = 'lanescope.processViewer';
export const OPEN_COMMAND = 'lanescope.open';
export const EXPORT_COMMAND = 'lanescope.export';
/** Memento key of the folder the last export was written to. */
const LAST_EXPORT_FOLDER_KEY = 'lanescope.lastExportFolder';
export const CONFIG_SECTION = 'lanescope';

const SUPPORTED = new Set(['.bpmn', '.zip', '.twx']);

export class ProcessEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ProcessEditorProvider(context);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand(OPEN_COMMAND, (uri?: vscode.Uri) => openInViewer(uri)),
      vscode.commands.registerCommand(EXPORT_COMMAND, () => provider.exportActive()),
    );
  }

  /** Session of every open viewer panel. */
  private readonly sessions = new Map<vscode.WebviewPanel, ViewerSession>();

  private readonly extensionUri: vscode.Uri;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
  }

  /** Where the last export folder is kept: the workspace's state, or the global state without a workspace. */
  private exportState(): vscode.Memento {
    return vscode.workspace.workspaceFolders?.length ? this.context.workspaceState : this.context.globalState;
  }

  /** Lanescope: Export Diagram…: asks for the format and exports the active viewer's diagram. */
  private async exportActive(): Promise<void> {
    const session = [...this.sessions].find(([panel]) => panel.active)?.[1];
    if (!session) {
      void vscode.window.showInformationMessage('Open a diagram in Lanescope to export it.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      EXPORT_FORMATS.map((format) => ({
        label: EXPORT_LABELS[format],
        format,
        ...(format === 'bpmn' ? { detail: BPMN_EXPORT_NOTE } : {}),
      })),
      { title: 'Export Diagram', placeHolder: 'Export the shown diagram to a new file as' },
    );
    if (!picked) return;
    if (!(await session.requestExport(picked.format))) {
      void vscode.window.showInformationMessage('There is no diagram to export: it could not be drawn.');
    }
  }

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
      exporter: exportHost(document.uri, () => this.exportState()),
    });
    this.sessions.set(panel, session);
    // Listen before setting the HTML so the webview's "ready" is never missed.
    const listener = webview.onDidReceiveMessage((msg: unknown) => void session.handleMessage(msg));
    const watcher = watchForChanges(document.uri, () => session.fileChanged());
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) void session.updateSettings(readSettings());
    });
    panel.onDidDispose(() => {
      this.sessions.delete(panel);
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

/**
 * Save dialog and file write for exports of the file at `source`. The picked
 * path is checked (checkExportTarget) before anything is written; the opened
 * file and its package are never written.
 */
function exportHost(source: vscode.Uri, state: () => vscode.Memento): ExportHost {
  return {
    async chooseTarget({ format, levelName }) {
      if (source.scheme !== 'file') {
        void vscode.window.showErrorMessage('Only diagrams of local files can be exported.');
        return undefined;
      }
      const lastFolder = state().get<string>(LAST_EXPORT_FOLDER_KEY);
      const folder = chooseExportFolder(
        lastFolder,
        lastFolder !== undefined && (await isFolder(lastFolder)),
        path.dirname(source.fsPath),
      );
      const suggested = await defaultExportPath({ sourcePath: source.fsPath, format, levelName }, fileExists, folder);
      const picked = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(suggested),
        filters: { [EXPORT_LABELS[format]]: [EXPORT_EXTENSIONS[format].slice(1)] },
        saveLabel: 'Export',
        title: 'Export Diagram',
      });
      if (!picked) return undefined;
      const check = picked.scheme === 'file'
        ? checkExportTarget(picked.fsPath, source.fsPath, format)
        : { ok: false as const, message: 'Exports can be saved to local files only.' };
      if (!check.ok) {
        void vscode.window.showErrorMessage(check.message);
        return undefined;
      }
      return check.path;
    },
    async write(target, format, bytes) {
      const uri = vscode.Uri.file(target);
      // The only write of the extension: a new export file, never an input (see chooseTarget).
      await vscode.workspace.fs.writeFile(uri, bytes);
      // Only a written export moves the save dialog's folder; a cancel or a refused path does not.
      await state().update(LAST_EXPORT_FOLDER_KEY, path.dirname(target));
      void showExported(uri, format);
    },
    failed(message) {
      void vscode.window.showErrorMessage(message);
    },
  };
}

async function showExported(uri: vscode.Uri, format: ExportFormat): Promise<void> {
  const choice = await vscode.window.showInformationMessage(`Exported ${path.basename(uri.fsPath)}`, 'Open', 'Reveal in Explorer');
  if (choice === 'Open') {
    // The BPMN opens as text, not in Lanescope; images open in VS Code's image preview.
    if (format === 'bpmn') await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    else await vscode.commands.executeCommand('vscode.open', uri);
  } else if (choice === 'Reveal in Explorer') {
    const inWorkspace = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
    await vscode.commands.executeCommand(inWorkspace ? 'revealInExplorer' : 'revealFileInOS', uri);
  }
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(vscode.Uri.file(folder))).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
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
