// "Lanescope: New Process Description" end to end through the real provider,
// with a stand-in for the vscode module that records every call that could
// write or edit: an existing description is opened and attached, its bytes
// and mtime stay as they were, and nothing edits, saves or dirties the
// opened document. A missing one is created once from the template, and a
// second run never overwrites it.

import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the stand-in saw. */
const calls = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  providers: [] as Array<{ resolveCustomEditor(doc: unknown, panel: unknown): void }>,
  warnings: [] as string[],
  errors: [] as string[],
  /** What the modal answers. */
  answer: undefined as string | undefined,
  opened: [] as string[],
  /** Every write, edit or save asked of VS Code. */
  writes: [] as string[],
  posted: [] as unknown[],
  documents: [] as Array<{ isDirty: boolean }>,
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly fsPath: string,
    ) {}
    get path() {
      return this.fsPath;
    }
    static file(p: string) {
      return new Uri('file', p);
    }
    static joinPath(base: Uri, ...parts: string[]) {
      return new Uri(base.scheme, [base.fsPath, ...parts].join('/'));
    }
    toString() {
      return `${this.scheme}://${this.fsPath}`;
    }
  }
  const disposable = { dispose: () => undefined };
  const memento = { get: () => undefined, update: async () => undefined };
  return {
    Uri,
    Disposable: { from: () => disposable },
    RelativePattern: class {},
    ViewColumn: { Beside: -2 },
    FileType: { Directory: 2 },
    TabInputText: class {},
    TabInputCustom: class {},
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => (calls.commands.set(id, fn), disposable),
      executeCommand: async () => undefined,
    },
    window: {
      registerCustomEditorProvider: (_: string, p: (typeof calls.providers)[number]) => (calls.providers.push(p), disposable),
      showWarningMessage: async (m: string) => (calls.warnings.push(m), calls.answer),
      showErrorMessage: async (m: string) => void calls.errors.push(m),
      showInformationMessage: async () => undefined,
      showTextDocument: async (uri: Uri) => {
        calls.opened.push(uri.fsPath);
        const document = { uri, isDirty: false, save: async () => void calls.writes.push(`save ${uri.fsPath}`) };
        calls.documents.push(document);
        return {
          document,
          edit: async () => (calls.writes.push(`edit ${uri.fsPath}`), true),
          insertSnippet: async () => (calls.writes.push(`snippet ${uri.fsPath}`), true),
        };
      },
    },
    workspace: {
      workspaceFolders: undefined,
      fs: {
        stat: async (uri: Uri) => {
          const s = await stat(uri.fsPath);
          return { size: s.size, type: s.isDirectory() ? 2 : 1 };
        },
        readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)),
        writeFile: async (uri: Uri) => void calls.writes.push(`fs.writeFile ${uri.fsPath}`),
      },
      applyEdit: async () => (calls.writes.push('applyEdit'), true),
      getConfiguration: () => ({ get: (_: string, fallback: unknown) => fallback }),
      onDidChangeConfiguration: () => disposable,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable }),
      getWorkspaceFolder: () => undefined,
    },
    __memento: memento,
  };
});

import * as vscode from 'vscode';
import { NEW_DESCRIPTION_COMMAND, ProcessEditorProvider } from '../../src/views/processEditorProvider';
import { DESCRIPTION_TEMPLATE } from '../../src/trace/template';

const BOB = path.join(__dirname, '..', 'fixtures', 'bob');

let dir: string;
let zip: string;
let md: string;

/** Opens the zip in the provider (as the custom editor) and makes its panel the active one. */
function openViewer() {
  calls.commands.clear();
  calls.providers.length = 0;
  const memento = (vscode as unknown as { __memento: unknown }).__memento;
  ProcessEditorProvider.register({ extensionUri: vscode.Uri.file('/ext'), workspaceState: memento, globalState: memento } as never);
  const panel = {
    active: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      postMessage: async (m: unknown) => void calls.posted.push(m),
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  calls.providers[0].resolveCustomEditor({ uri: vscode.Uri.file(zip) }, panel);
}

async function runCommand() {
  await calls.commands.get(NEW_DESCRIPTION_COMMAND)!();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lanescope-newdesc-'));
  zip = path.join(dir, 'order.zip');
  md = path.join(dir, 'order-description.md');
  copyFileSync(path.join(BOB, 'order-delivery-process.zip'), zip);
  Object.assign(calls, { answer: undefined });
  for (const list of [calls.warnings, calls.errors, calls.opened, calls.writes, calls.posted, calls.documents]) list.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('New Process Description with an existing description', () => {
  beforeEach(() => copyFileSync(path.join(BOB, 'order-delivery-process-description.md'), md));

  it('"Open existing" only opens and attaches it: same bytes, same mtime, no write, no edit, nothing dirty', async () => {
    const before = { bytes: readFileSync(md), mtime: statSync(md).mtimeMs };
    openViewer();
    calls.answer = 'Open existing';
    await runCommand();

    expect(calls.warnings).toEqual(['order-description.md already exists. It is not overwritten.']);
    expect(calls.opened).toEqual([md]);
    expect(calls.writes).toEqual([]);
    expect(calls.documents.map((d) => d.isDirty)).toEqual([false]);
    expect(readFileSync(md).equals(before.bytes)).toBe(true);
    expect(statSync(md).mtimeMs).toBe(before.mtime);
  });

  it('Cancel opens nothing and writes nothing', async () => {
    const before = { bytes: readFileSync(md), mtime: statSync(md).mtimeMs };
    openViewer();
    calls.answer = undefined;
    await runCommand();
    expect(calls.opened).toEqual([]);
    expect(calls.writes).toEqual([]);
    expect(readFileSync(md).equals(before.bytes)).toBe(true);
    expect(statSync(md).mtimeMs).toBe(before.mtime);
  });
});

describe('New Process Description without a description', () => {
  it('creates it once from the template, opens it, and a second run never overwrites it', async () => {
    openViewer();
    await runCommand();
    expect(readFileSync(md, 'utf8')).toBe(DESCRIPTION_TEMPLATE);
    expect(calls.opened).toEqual([md]);
    expect(calls.warnings).toEqual([]);
    // Through Node's exclusive create, not through VS Code.
    expect(calls.writes).toEqual([]);

    // The user edits it; the command again finds it and only offers to open it.
    writeFileSync(md, '## Main process steps\n- Mine\n');
    const before = { bytes: readFileSync(md), mtime: statSync(md).mtimeMs };
    calls.answer = 'Open existing';
    await runCommand();
    expect(readFileSync(md).equals(before.bytes)).toBe(true);
    expect(statSync(md).mtimeMs).toBe(before.mtime);
    expect(calls.writes).toEqual([]);
  });
});
