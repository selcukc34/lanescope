// SECURITY.md scope 1: an opened file must not be able to make the extension
// write, change or delete files. These tests scan every source file of the
// extension host and the webview, so a write, delete, rename, edit, process
// or network API added later fails CI and has to be looked at. The one write
// is the export: a new file the user picks in a save dialog, checked by
// src/views/exportFiles.ts so it is never the input or an input type.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)));
}

const FILES = [...sourceFiles('src'), ...sourceFiles('webview')];

/** The one file write of the extension: an export (see processEditorProvider's exportHost). */
const EXPORT_WRITE = `${path.join('src', 'views', 'processEditorProvider.ts')}:${
  code(path.join('src', 'views', 'processEditorProvider.ts'))
    .split('\n')
    .findIndex((line) => line.includes('await vscode.workspace.fs.writeFile(uri, bytes);')) + 1
}: await vscode.workspace.fs.writeFile(uri, bytes);`;

/** Code without comments, so prose about "writing" does not count. */
function code(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function hits(pattern: RegExp): string[] {
  return FILES.flatMap((file) =>
    code(file)
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe('read-only: no API that writes, deletes, edits or runs anything', () => {
  it('scans a non-trivial set of files', () => {
    expect(FILES).toContain(path.join('src', 'views', 'processEditorProvider.ts'));
    expect(FILES).toContain(path.join('webview', 'main.ts'));
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('has no file system write, delete, rename or permission call', () => {
    const fsWrites =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdir|rmdirSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|copyFile|copyFileSync|cp|cpSync|truncate|ftruncate|symlink|link|chmod|chown|utimes|lchown|futimes)\s*\(|\brm\s*\(|\bopen\s*\([^)]*['"][wa]\+?['"]/;
    expect(hits(fsWrites)).toEqual([EXPORT_WRITE]);
  });

  it('writes only an export, to a path the export checks accepted', () => {
    const provider = code(path.join('src', 'views', 'processEditorProvider.ts'));
    // The target comes from the save dialog, through checkExportTarget, and nowhere else.
    expect(provider).toContain('checkExportTarget(picked.fsPath, source.fsPath, format)');
    expect(provider.match(/writeFile\(/g)).toHaveLength(1);
    const session = code(path.join('src', 'views', 'viewerSession.ts'));
    expect(session).toContain('const target = await exporter.chooseTarget(');
  });

  it('imports only readFile, readdir and stat from the file system module (existsSync in the ELK runner)', () => {
    const imports = FILES.flatMap((file) =>
      [...code(file).matchAll(/import\s+(?:\*\s+as\s+\w+|\{([^}]*)\}|\w+)\s+from\s+'(?:node:)?fs(?:\/promises)?'/g)].map(
        (m) => `${file}: ${m[1] ?? m[0]}`,
      ),
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      const names = (line.split(': ')[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
      // existsSync only finds the ELK script the layout worker loads (src/bpmn/elkRunner.ts).
      const allowed = line.startsWith(path.join('src', 'bpmn', 'elkRunner.ts')) ? ['existsSync'] : ['readFile', 'readdir', 'stat'];
      for (const name of names) expect(allowed).toContain(name);
    }
  });

  it('has no VS Code API that writes or edits a file (but the export write)', () => {
    expect(
      hits(/workspace\.fs\.(writeFile|delete|rename|copy|createDirectory)|WorkspaceEdit|applyEdit|\.edit\s*\(|TextEditorEdit|saveAs?\s*\(|onWillSave/),
    ).toEqual([EXPORT_WRITE]);
  });

  it('registers a read-only custom editor (no save, revert or backup handlers)', () => {
    const provider = code(path.join('src', 'views', 'processEditorProvider.ts'));
    expect(provider).toContain('implements vscode.CustomReadonlyEditorProvider');
    expect(provider).not.toMatch(/saveCustomDocument|revertCustomDocument|backupCustomDocument|onDidChangeCustomDocument/);
  });

  it('starts no process and makes no network request', () => {
    expect(hits(/child_process|cluster|\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bfork\s*\(/)).toEqual([]);
    // The one worker thread runs ELK (a computation on data passed in); it is created in one place only.
    const workers = hits(/worker_threads|new Worker\b/).map((h) => h.split(':')[0]);
    expect(workers.length).toBeGreaterThan(0);
    expect(new Set(workers)).toEqual(new Set([path.join('src', 'bpmn', 'elkRunner.ts')]));
    expect(
      hits(/from\s+'(?:node:)?(?:http|https|http2|net|tls|dgram|dns)'|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|openExternal/),
    ).toEqual([]);
  });

  it('contributes six commands: open a file, export the shown diagram to a new file, compare with a file and clear that, check against a description and clear that', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }>; menus: { commandPalette: Array<{ command: string; when?: string }> } };
    };
    expect(pkg.contributes.commands.map((c) => c.command)).toEqual([
      'lanescope.open',
      'lanescope.export',
      'lanescope.compare',
      'lanescope.clearComparison',
      'lanescope.checkDescription',
      'lanescope.clearDescription',
    ]);
    for (const command of ['lanescope.export', 'lanescope.compare', 'lanescope.clearComparison', 'lanescope.checkDescription', 'lanescope.clearDescription']) {
      expect(pkg.contributes.menus.commandPalette).toContainEqual({ command, when: 'activeCustomEditorId == lanescope.processViewer' });
    }
  });

  it('reads the file to compare with through the same loader as the opened file, and never watches it', () => {
    const provider = readFileSync(path.join(ROOT, 'src/views/processEditorProvider.ts'), 'utf8');
    expect(provider).toContain('loadBase: (filePath) => loadPackage(vscode.Uri.file(filePath)),');
    // Two watchers: the opened file's, and the attached description's (watchFile). The base is never watched.
    expect(provider.match(/createFileSystemWatcher\(/g)).toHaveLength(2);
    expect(provider.match(/watchFile\(/g)).toHaveLength(2);
    expect(provider).toContain('watchFile(filePath, () => session.descriptionChanged())');
  });

  it('reads a description only: a local file of at most 1 MB, through readFile', () => {
    const provider = code(path.join('src', 'views', 'processEditorProvider.ts'));
    const host = provider.slice(provider.indexOf('function descriptionHost('), provider.indexOf('function watchFile('));
    expect(host).toContain('if (stat.size > MAX_DESCRIPTION_BYTES)');
    expect(host).toContain('await vscode.workspace.fs.readFile(uri)');
    expect(host).not.toMatch(/writeFile|delete|rename/);
  });
});
