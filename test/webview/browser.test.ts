// The webview bundle in a real browser, with the real bpmn-js and the real
// Content Security Policy: what unit tests of the host cannot see (diff
// markers on the canvas, the Changes tab, a click or Enter on one of its
// rows selecting the element). Runs headless Chrome over the DevTools
// protocol with Node's own fetch and WebSocket, so it needs no dependency.
//
// Skipped where Chrome is not found (CI). Set LANESCOPE_CHROME to the
// Chrome or Chromium binary to run it elsewhere.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import type { RenderMessage } from '../../src/views/protocol';
import { ViewerSession } from '../../src/views/viewerSession';
import { buildCsp } from '../../src/views/webviewHtml';
import { NOTIFY_TASK_ID, V1_ZIP, V2_ZIP } from '../bobV2';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.LANESCOPE_CHROME ?? (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
const ROOT = path.join(__dirname, '..', '..');
const MANAGER_TASK_ID = 'bpmnid-8bb2f288-e134-5909-b32a-670be5367f60';

/** Stands in for the VS Code webview API and records what the page posts, reports and keeps. */
const STUB = `
window.__posted = [];
window.__state = undefined;
window.__errors = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => window.__posted.push(m),
  getState: () => window.__state,
  setState: (s) => { window.__state = s; },
});
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
document.addEventListener('securitypolicyviolation', (e) => window.__errors.push('CSP ' + e.violatedDirective));
`;

/** A few VS Code theme variables, as the webview gets them (dark theme). */
const THEME = [
  '--vscode-editor-background:#1e1e1e',
  '--vscode-editor-foreground:#d4d4d4',
  '--vscode-foreground:#cccccc',
  '--vscode-focusBorder:#0078d4',
  '--vscode-textLink-foreground:#3794ff',
  '--vscode-gitDecoration-addedResourceForeground:#81b88b',
  '--vscode-gitDecoration-modifiedResourceForeground:#e2c08d',
].join(';');

class Page {
  private id = 0;
  private readonly pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown };
      if (m.id !== undefined) this.pending.get(m.id)?.(m);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: unknown }> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page (awaiting a promise) and returns its value. */
  async eval<T>(expression: string): Promise<T> {
    const m = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result?: { result?: { value?: T }; exceptionDetails?: { text: string } };
    };
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text);
    return m.result?.result?.value as T;
  }

  /** A real mouse click in the middle of the first button whose text includes `text`. */
  async clickButton(text: string): Promise<void> {
    const at = await this.eval<{ x: number; y: number } | null>(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + Math.min(10, r.width / 2), y: r.y + r.height / 2 }; })()`,
    );
    if (!at) throw new Error(`No button "${text}"`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
  }

  async pressEnter(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }

  /** Opens the harness afresh and posts `render` as the host would. */
  async open(url: string, render: RenderMessage, before = ''): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.eval(`new Promise((r) => { const t = () => (document.querySelector('.tab') ? r(true) : setTimeout(t, 20)); t(); })`);
    await this.eval(`(async () => { ${before}; window.postMessage(${JSON.stringify(render)}, '*'); })()`);
    await this.eval(`new Promise((r) => { const t = () => (document.querySelector('.djs-element') && document.querySelector('.overlay').hidden ? r(true) : setTimeout(t, 20)); t(); })`);
  }
}

async function renderOf(open: ProcessPackage, base: ProcessPackage): Promise<{ withShow: RenderMessage; again: RenderMessage }> {
  const renders: RenderMessage[] = [];
  const s = new ViewerSession({
    fileName: 'order-delivery-process.v2.zip',
    load: async () => open,
    post: (m) => void (m.type === 'render' && renders.push(m)),
    comparer: { chooseBase: async () => '/work/order-delivery-process.zip', loadBase: async () => base, failed: () => undefined },
  });
  await s.start();
  await s.handleMessage({ type: 'ready' });
  await s.requestCompare();
  const withShow = renders[renders.length - 1];
  // A reloaded webview gets the same render back, without the one-time flag.
  await s.handleMessage({ type: 'ready' });
  return { withShow, again: renders[renders.length - 1] };
}

describe.skipIf(!CHROME)('webview in a real browser', () => {
  let dir: string;
  let url: string;
  let chrome: ChildProcess;
  let page: Page;
  let ws: WebSocket;
  let render: RenderMessage;
  let renderAgain: RenderMessage;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lanescope-browser-'));
    const site = path.join(dir, 'site');
    mkdirSync(site);
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'webview/main.ts')],
      outfile: path.join(site, 'main.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      logLevel: 'silent',
    });
    writeFileSync(path.join(site, 'stub.js'), STUB);
    writeFileSync(
      path.join(site, 'index.html'),
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp('file:', 'N0NCE')}">
<link rel="stylesheet" href="main.css"><title>Lanescope</title></head>
<body class="vscode-dark" style="${THEME}"><div id="root"></div>
<script nonce="N0NCE" src="stub.js"></script><script nonce="N0NCE" src="main.js"></script></body></html>`,
    );
    url = pathToFileURL(path.join(site, 'index.html')).href;

    const v1 = await readProcessPackage(await readBpmnPackage(V1_ZIP));
    const v2 = await readProcessPackage(await readBpmnPackage(V2_ZIP));
    ({ withShow: render, again: renderAgain } = await renderOf(v2, v1));

    const profile = path.join(dir, 'profile');
    chrome = spawn(CHROME!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1400,900', 'about:blank'], {
      stdio: 'ignore',
    });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((r) => chrome.once('exit', r));
      chrome.kill();
      await exited;
    }
    // Chrome's helpers may still be closing files in the profile for a moment.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('marks added and changed elements and opens the Changes tab after Compare…', async () => {
    // The user was on the Data tab.
    await page.open(url, render, `document.getElementById('tab-data').click()`);
    const shown = await page.eval<{ tab: string; state: unknown; added: string[]; changed: string[]; errors: string[] }>(`({
      tab: document.querySelector('.tab.active').textContent,
      state: window.__state,
      added: [...document.querySelectorAll('.ls-diff-added')].map((e) => e.getAttribute('data-element-id')),
      changed: [...document.querySelectorAll('.ls-diff-changed')].map((e) => e.getAttribute('data-element-id')),
      errors: window.__errors,
    })`);
    expect(shown.tab).toBe('Changes (10)');
    expect(shown.state).toEqual({ tab: 'changes' });
    expect(shown.added.sort()).toEqual(Object.entries(render.diff!.marks).filter(([, m]) => m === 'added').map(([id]) => id).sort());
    expect(shown.changed.sort()).toEqual(Object.entries(render.diff!.marks).filter(([, m]) => m === 'changed').map(([id]) => id).sort());
    expect(shown.errors).toEqual([]);
  });

  it('makes only added and changed diagram rows buttons; removed and business object rows are plain text', async () => {
    await page.open(url, render);
    const rows = await page.eval<{ buttons: string[]; plain: string[] }>(`({
      buttons: [...document.querySelectorAll('.change-list button.link')].map((b) => b.textContent),
      plain: [...document.querySelectorAll('.change-list .change-label')].map((s) => s.textContent),
    })`);
    expect(rows.buttons).toEqual([
      'Task "Notify Customer SF"',
      'Flow "To Order Auto Approved"',
      'User task "Manager Review"',
      'User task "Handle Exception"',
      'Flow "Valid"',
      'Flow "AUTO_APPROVE"',
      'Flow "To Notify Customer SF"',
    ]);
    expect(rows.plain).toEqual(['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"', 'Business object "OrderRequest"']);
  });

  it('selects the element of a clicked row, scrolls it into view and shows its details', async () => {
    await page.open(url, render);
    // Zoomed in far enough that the new task is out of view.
    await page.eval(`(() => { const plus = [...document.querySelectorAll('button')].find((b) => b.textContent === '+'); for (let i = 0; i < 8; i++) plus.click(); })()`);
    const inView = `(() => { const t = document.querySelector('[data-element-id="${NOTIFY_TASK_ID}"]').getBoundingClientRect(); const c = document.querySelector('.canvas').getBoundingClientRect(); return t.left >= c.left && t.right <= c.right && t.top >= c.top && t.bottom <= c.bottom; })()`;
    expect(await page.eval<boolean>(inView)).toBe(false);

    await page.clickButton('Task "Notify Customer SF"');
    const after = await page.eval<{ selected: string[]; glow: string; details: string; tab: string }>(`({
      selected: [...document.querySelectorAll('.djs-element.selected')].map((e) => e.getAttribute('data-element-id')),
      glow: getComputedStyle(document.querySelector('.djs-element.selected .djs-visual')).filter,
      details: document.querySelector('[aria-labelledby="tab-details"] h2').textContent,
      tab: document.querySelector('.tab.active').textContent,
    })`);
    expect(after.selected).toEqual([NOTIFY_TASK_ID]);
    expect(after.glow).toMatch(/drop-shadow/);
    expect(after.details).toBe('Notify Customer SF');
    expect(after.tab).toBe('Details');
    expect(await page.eval<boolean>(inView)).toBe(true);
  });

  it('works from the keyboard: Enter on a focused row', async () => {
    await page.open(url, render);
    await page.eval(`[...document.querySelectorAll('.change-list button.link')].find((b) => b.textContent === 'User task "Manager Review"').focus()`);
    await page.pressEnter();
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.djs-element.selected')].map((e) => e.getAttribute('data-element-id'))`)).toEqual([MANAGER_TASK_ID]);
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Details');
  });

  it('keeps the chosen tab on a render without the Compare… flag', async () => {
    expect(renderAgain.showChanges).toBeUndefined();
    await page.open(url, renderAgain, `document.getElementById('tab-data').click()`);
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Data');
  });
});
