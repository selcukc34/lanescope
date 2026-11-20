// Read-only custom editor that shows a Bob .bpmn file (or a .zip holding one)
// or an IBM BAW .twx export as a BPMN diagram. Nothing is ever written back
// to the opened file: exports go to a new file picked in a save dialog and
// checked by ./exportFiles (never the input, never an input type). A file
// picked to compare with is read the same way as the opened one, and never
// written or watched. A description (Markdown) checked against the process is
// read and watched, never written.

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
import { ViewerSession, type CompareHost, type DescriptionHost, type ExportHost } from './viewerSession';
import { descriptionCandidates, isWatchedChange, watchPatternFor } from './watchPattern';
import { MAX_DESCRIPTION_BYTES } from '../trace/description';
import { buildWebviewHtml, createNonce } from './webviewHtml';

export const VIEW_TYPE = 'lanescope.processViewer';
export const OPEN_COMMAND = 'lanescope.open';
export const EXPORT_COMMAND = 'lanescope.export';
export const COMPARE_COMMAND = 'lanescope.compare';
export const CLEAR_COMPARISON_COMMAND = 'lanescope.clearComparison';
export const CHECK_DESCRIPTION_COMMAND = 'lanescope.checkDescription';
export const CLEAR_DESCRIPTION_COMMAND = 'lanescope.clearDescription';
/** Workspace state key prefix of the description attached to a file (by its URI); null: the user cleared it. */
const DESCRIPTION_KEY_PREFIX = 'lanescope.description:';
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
      vscode.commands.registerCommand(COMPARE_COMMAND, () => provider.compareActive()),
      vscode.commands.registerCommand(CLEAR_COMPARISON_COMMAND, () => provider.clearActive()),
      vscode.commands.registerCommand(CHECK_DESCRIPTION_COMMAND, () => provider.checkDescriptionActive()),
      vscode.commands.registerCommand(CLEAR_DESCRIPTION_COMMAND, () => provider.clearDescriptionActive()),
    );
  }

  /** Session of every open viewer panel. */
  private readonly sessions = new Map<vscode.WebviewPanel, ViewerSession>();
  /** The opened file of every open viewer panel. */
  private readonly documents = new Map<vscode.WebviewPanel, vscode.Uri>();

  private readonly extensionUri: vscode.Uri;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
  }

  /** Where the last export folder is kept: the workspace's state, or the global state without a workspace. */
  private exportState(): vscode.Memento {
    return vscode.workspace.workspaceFolders?.length ? this.context.workspaceState : this.context.globalState;
  }

  private activeSession(): ViewerSession | undefined {
    return [...this.sessions].find(([panel]) => panel.active)?.[1];
  }

  /** Lanescope: Compare With…: compares the active viewer's diagram with a picked file. */
  private async compareActive(): Promise<void> {
    const session = this.activeSession();
    if (!session) {
      void vscode.window.showInformationMessage('Open a diagram in Lanescope to compare it.');
      return;
    }
    if (!(await session.requestCompare())) {
      void vscode.window.showInformationMessage('There is no diagram to compare: it could not be drawn.');
    }
  }

  /** Lanescope: Check Against Description…: picks a Markdown description and shows the Trace tab. */
  private async checkDescriptionActive(): Promise<void> {
    const active = [...this.sessions].find(([panel]) => panel.active);
    const uri = active ? this.documents.get(active[0]) : undefined;
    if (!active || !uri) {
      void vscode.window.showInformationMessage('Open a diagram in Lanescope to check it against a description.');
      return;
    }
    const session = active[1];
    const current = session.descriptionPath;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      defaultUri: current ? vscode.Uri.file(current) : uri.scheme === 'file' ? vscode.Uri.file(path.dirname(uri.fsPath)) : undefined,
      openLabel: 'Check',
      title: `Check ${path.basename(uri.path)} Against Description`,
      filters: { 'Markdown description': ['md', 'markdown'] },
    });
    const md = picked?.[0];
    if (!md) return;
    if (md.scheme !== 'file') {
      void vscode.window.showErrorMessage('Lanescope can read local description files only.');
      return;
    }
    await session.setDescription(md.fsPath, true);
  }

  /** Lanescope: Clear Description Check. */
  private async clearDescriptionActive(): Promise<void> {
    const session = this.activeSession();
    if (!session?.descriptionPath) {
      void vscode.window.showInformationMessage('The diagram is not checked against a description.');
      return;
    }
    await session.clearDescription();
  }

  /**
   * The description a file opens with: the one remembered for it (unless the
   * user cleared it), else, when lanescope.trace.autoDetectDescription is on,
   * <base>-description.md or <base>.md next to it.
   */
  private async initialDescription(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const remembered = this.context.workspaceState.get<string | null>(DESCRIPTION_KEY_PREFIX + uri.toString());
    if (remembered === null) return undefined;
    if (typeof remembered === 'string' && (await fileExists(remembered))) return remembered;
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('trace.autoDetectDescription', true)) return undefined;
    for (const candidate of descriptionCandidates(uri.fsPath)) {
      if (await fileExists(candidate)) return candidate;
    }
    return undefined;
  }

  /** Lanescope: Clear Comparison: back to comparing with the previous version. */
  private async clearActive(): Promise<void> {
    const session = this.activeSession();
    if (!session?.comparingWithFile) {
      void vscode.window.showInformationMessage('The diagram is not compared with a file.');
      return;
    }
    await session.clearComparison();
  }

  /** Lanescope: Export Diagram…: asks for the format and exports the active viewer's diagram. */
  private async exportActive(): Promise<void> {
    const session = this.activeSession();
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
    let descriptionWatcher: vscode.Disposable | undefined;
    const session = new ViewerSession({
      fileName,
      load: () => loadPackage(document.uri),
      post: (message: HostMessage) => webview.postMessage(message),
      settings: readSettings(),
      exporter: exportHost(document.uri, () => this.exportState()),
      comparer: compareHost(document.uri),
      descriptions: descriptionHost((filePath, byUser) => {
        descriptionWatcher?.dispose();
        descriptionWatcher = filePath ? watchFile(filePath, () => session.descriptionChanged()) : undefined;
        if (byUser) void this.context.workspaceState.update(DESCRIPTION_KEY_PREFIX + document.uri.toString(), filePath ?? null);
      }),
    });
    this.sessions.set(panel, session);
    this.documents.set(panel, document.uri);
    // Listen before setting the HTML so the webview's "ready" is never missed.
    const listener = webview.onDidReceiveMessage((msg: unknown) => void session.handleMessage(msg));
    const watcher = watchForChanges(document.uri, () => session.fileChanged());
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) void session.updateSettings(readSettings());
    });
    panel.onDidDispose(() => {
      this.sessions.delete(panel);
      this.documents.delete(panel);
      session.dispose();
      watcher?.dispose();
      descriptionWatcher?.dispose();
      config.dispose();
      listener.dispose();
    });
    // Load while the webview boots; the result is posted once it says "ready".
    void session.start();
    // A remembered or found description is attached without switching tabs.
    void this.initialDescription(document.uri).then((md) => (md ? session.setDescription(md) : undefined));

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

/**
 * Open dialog and read-only load of the file to compare with. It is read
 * like an opened file (same readers and limits), once, and not watched.
 */
function compareHost(source: vscode.Uri): CompareHost {
  return {
    async chooseBase() {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        defaultUri: source.scheme === 'file' ? vscode.Uri.file(path.dirname(source.fsPath)) : undefined,
        openLabel: 'Compare',
        title: `Compare ${path.basename(source.path)} With`,
        filters: { 'Bob BPMN package or BAW export': ['zip', 'bpmn', 'twx'] },
      });
      const uri = picked?.[0];
      if (!uri) return undefined;
      if (uri.scheme !== 'file' || !SUPPORTED.has(path.extname(uri.fsPath).toLowerCase())) {
        void vscode.window.showErrorMessage('Lanescope can compare with local .bpmn, .zip and .twx files only.');
        return undefined;
      }
      return uri.fsPath;
    },
    loadBase: (filePath) => loadPackage(vscode.Uri.file(filePath)),
    failed(message) {
      void vscode.window.showErrorMessage(message);
    },
  };
}

/**
 * Read-only access to description files: a local file of at most
 * MAX_DESCRIPTION_BYTES, read as UTF-8. `attached` hears every attach and clear.
 */
function descriptionHost(attached: DescriptionHost['attached']): DescriptionHost {
  return {
    async read(filePath) {
      const uri = vscode.Uri.file(filePath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_DESCRIPTION_BYTES) throw new Error(`it is larger than ${MAX_DESCRIPTION_BYTES / (1024 * 1024)} MB`);
      return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
    },
    attached,
  };
}

/** Watches one file (change, create, delete) through a watcher on its directory. Only reads file events. */
function watchFile(filePath: string, onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), '*'));
  const handle = (changed: vscode.Uri) => {
    if (changed.scheme === 'file' && changed.fsPath === filePath) onChange();
  };
  return vscode.Disposable.from(watcher, watcher.onDidChange(handle), watcher.onDidCreate(handle), watcher.onDidDelete(handle));
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
