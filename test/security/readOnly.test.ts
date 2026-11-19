// SECURITY.md scope 1: an opened file must not be able to make the extension
// write, change or delete files. The extension has no code that could: these
// tests scan every source file of the extension host and the webview, so a
// write, delete, rename, edit, process or network API added later fails CI
// and has to be looked at.

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
    expect(hits(fsWrites)).toEqual([]);
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

  it('has no VS Code API that writes or edits a file', () => {
    expect(
      hits(/workspace\.fs\.(writeFile|delete|rename|copy|createDirectory)|WorkspaceEdit|applyEdit|\.edit\s*\(|TextEditorEdit|saveAs?\s*\(|onWillSave/),
    ).toEqual([]);
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

  it('contributes no command that exports or writes (the only command opens a file)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect(pkg.contributes.commands.map((c) => c.command)).toEqual(['lanescope.open']);
  });
});
