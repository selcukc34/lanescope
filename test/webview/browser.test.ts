// The webview bundle in a real browser, with the real bpmn-js and the real
// Content Security Policy: what unit tests of the host cannot see (diff
// markers on the canvas, the Changes tab, a click or Enter on one of its
// rows selecting the element, the Trace tab and its rows). Runs headless Chrome over the DevTools
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
import { syntheticTwxPackage } from '../syntheticTwx';

const DESCRIPTION_MD = path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process-description.md');

/**
 * Renders of a package with a description attached: the first one (as found
 * next to the file), the one after a pick (with showTrace), and the level a
 * message from the webview opens.
 */
async function traceRenders(pkg: ProcessPackage, md: string) {
  const renders: RenderMessage[] = [];
  const s = new ViewerSession({
    fileName: 'order.zip',
    load: async () => pkg,
    post: (m) => void (m.type === 'render' && renders.push(m)),
    descriptions: { read: async () => md, attached: () => undefined },
  });
  await s.handleMessage({ type: 'ready' });
  await s.setDescription('/work/order-description.md');
  const found = renders[renders.length - 1];
  await s.setDescription('/work/order-description.md', true);
  const picked = renders[renders.length - 1];
  return { found, picked, open: async (msg: unknown) => (await s.handleMessage(msg), renders[renders.length - 1]) };
}

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.LANESCOPE_CHROME ?? (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
const ROOT = path.join(__dirname, '..', '..');
const MANAGER_TASK_ID = 'bpmnid-8bb2f288-e134-5909-b32a-670be5367f60';
const ROUTE_GATEWAY_ID = 'bpmnid-77703ca3-6892-5eb3-99bb-7aace6e9d4d5';
const SYSTEM_LANE_ID = 'bpmnid-b5e70782-904e-5775-923d-ee932662da40';
const EXCEPTION_FLOW_ID = 'bpmnid-e60e39f8-8ad4-5c29-a934-8bc13a6f4a3e';

/**
 * Stands in for the VS Code webview API and records what the page posts,
 * reports and keeps. A \`?state=<json>\` query is the state VS Code hands a
 * webview rebuilt after its editor tab was hidden.
 */
const STUB = `
window.__posted = [];
window.__state = (() => { const s = new URLSearchParams(location.search).get('state'); return s === null ? undefined : JSON.parse(s); })();
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

  /** A real mouse click in the middle of the first element matching `selector`. */
  async clickSelector(selector: string): Promise<void> {
    const at = await this.eval<{ x: number; y: number } | null>(
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!at) throw new Error(`Nothing matches ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
  }

  async pressKey(key: string, code = key, keyCode = 0): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
    }
  }

  /** A real mouse click at a point of the page. */
  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
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

/** A Bob process with a sub-process that opens (Prepare) and an empty one. */
const SUB_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs" targetNamespace="http://example.com/sub">
  <bpmn:process id="order" name="Order">
    <bpmn:startEvent id="start" name="Start"/>
    <bpmn:subProcess id="prepare" name="Prepare">
      <bpmn:startEvent id="prepStart" name="Prepare Start"/>
      <bpmn:task id="pick" name="Pick Items"/>
      <bpmn:endEvent id="prepEnd" name="Prepare End"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="prepStart" targetRef="pick"/>
      <bpmn:sequenceFlow id="sf2" sourceRef="pick" targetRef="prepEnd"/>
    </bpmn:subProcess>
    <bpmn:subProcess id="empty" name="Empty"/>
    <bpmn:endEvent id="end" name="End"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="prepare"/>
    <bpmn:sequenceFlow id="f2" sourceRef="prepare" targetRef="empty"/>
    <bpmn:sequenceFlow id="f3" sourceRef="empty" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`;

/** The first render of a package, as the host posts it. */
async function plainRender(pkg: ProcessPackage): Promise<RenderMessage> {
  const renders: RenderMessage[] = [];
  const s = new ViewerSession({ fileName: 'order.bpmn', load: async () => pkg, post: (m) => void (m.type === 'render' && renders.push(m)) });
  await s.handleMessage({ type: 'ready' });
  return renders[renders.length - 1];
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
  /** A TWX process compared with a version where a task inside the sub-process "Check Stock" has another name. */
  let subRender: RenderMessage;
  /** SUB_BPMN: a sub-process that opens and an empty one. */
  let drillRender: RenderMessage;
  let trace: Awaited<ReturnType<typeof traceRenders>>;
  let v1Package: ProcessPackage;
  let subTrace: Awaited<ReturnType<typeof traceRenders>>;

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
    const renamed = await syntheticTwxPackage({ subProcess: true });
    renamed.processes[0].nodes.find((n) => n.name === 'Count Items')!.name = 'Count All Items';
    drillRender = await plainRender(
      await readProcessPackage({ path: '/work/order.bpmn', format: 'bpmn', bpmnFileName: 'order.bpmn', bpmnText: SUB_BPMN, xsdFiles: {} }),
    );
    ({ withShow: subRender } = await renderOf(renamed, await syntheticTwxPackage({ subProcess: true })));
    v1Package = v1;
    trace = await traceRenders(v1, readFileSync(DESCRIPTION_MD, 'utf8'));
    subTrace = await traceRenders(
      await readProcessPackage({ path: '/work/order.bpmn', format: 'bpmn', bpmnFileName: 'order.bpmn', bpmnText: SUB_BPMN, xsdFiles: {} }),
      '## Main process steps\n- Prepare\n- Pick Items\n',
    );

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

  it('marks a sub-process with inner changes, and a row of an element inside it selects the sub-process', async () => {
    const checkId = Object.values(subRender.elements).find((e) => e.name === 'Check Stock')!.id;
    await page.open(url, subRender);
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.djs-element.ls-diff-changed')].map((e) => e.getAttribute('data-element-id'))`)).toEqual([checkId]);
    await page.clickButton('Script task "Count All Items"');
    const after = await page.eval<{ selected: string[]; details: string; errors: string[] }>(`({
      selected: [...document.querySelectorAll('.djs-element.selected')].map((e) => e.getAttribute('data-element-id')),
      details: document.querySelector('[aria-labelledby="tab-details"] h2').textContent,
      errors: window.__errors,
    })`);
    expect(after).toEqual({ selected: [checkId], details: 'Check Stock', errors: [] });
    // Selected from the Changes tab: its drill-down arrow shows.
    expect(
      await page.eval<string[]>(
        `[...document.querySelectorAll('.ls-drilldown')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.closest('.djs-overlays').getAttribute('data-container-id'))`,
      ),
    ).toEqual([checkId]);
  });

  it('shows our drill-down arrow only on the selected sub-process that opens; a click opens its level and the canvas stays', async () => {
    expect(drillRender.elements.prepare).toMatchObject({ openCallee: 'sub:prepare' });
    expect(drillRender.elements.empty).toMatchObject({ openUnavailable: 'Empty sub-process' });
    await page.open(url, drillRender);
    const state = `({
      arrows: [...document.querySelectorAll('.bjs-drilldown')]
        .filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0)
        .map((b) => [b.closest('.djs-overlays').getAttribute('data-container-id'), b.classList.contains('ls-drilldown'), b.title]),
      breadcrumbs: document.querySelectorAll('.bjs-breadcrumbs').length,
      start: document.querySelector('[data-element-id="start"]').getBoundingClientRect().width > 0,
      details: document.querySelector('[aria-labelledby="tab-details"] h2').textContent,
    })`;
    type State = { arrows: unknown[]; breadcrumbs: number; start: boolean; details: string };
    const ARROW = ['prepare', true, 'Open Prepare'];

    // Nothing selected: no arrow; no breadcrumb of bpmn-js.
    expect(await page.eval<State>(state)).toMatchObject({ arrows: [], breadcrumbs: 0, start: true });
    // The sub-process selected: its arrow, and only that one.
    await page.clickSelector('[data-element-id="prepare"] .djs-hit');
    expect(await page.eval<State>(state)).toMatchObject({ arrows: [ARROW], details: 'Prepare' });
    // Another element: gone. The empty sub-process: none.
    await page.clickSelector('[data-element-id="start"] .djs-hit');
    expect((await page.eval<State>(state)).arrows).toEqual([]);
    await page.clickSelector('[data-element-id="empty"] .djs-hit');
    expect(await page.eval<State>(state)).toMatchObject({ arrows: [], details: 'Empty' });
    // The empty canvas: gone.
    await page.clickSelector('[data-element-id="prepare"] .djs-hit');
    const box = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.canvas').getBoundingClientRect(); return { x: r.x + 4, y: r.bottom - 4 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    expect((await page.eval<State>(state)).arrows).toEqual([]);

    // A re-render that keeps the selection (a toggle) keeps the arrow on it.
    await page.clickSelector('[data-element-id="prepare"] .djs-hit');
    await page.eval(`(async () => { window.postMessage(${JSON.stringify({ ...drillRender, preserveView: true })}, '*'); await new Promise((r) => setTimeout(r, 300)); })()`);
    expect(await page.eval<State>(state)).toMatchObject({ arrows: [ARROW], details: 'Prepare' });

    // A click on the arrow opens the level, as a double-click does; the canvas stays on the process.
    await page.eval('window.__posted.length = 0');
    await page.clickSelector('.ls-drilldown');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'openCallee', calleeId: 'sub:prepare', path: ['order'] }]);
    expect(await page.eval<State>(state)).toMatchObject({ breadcrumbs: 0, start: true });
    expect(await page.eval<string[]>('window.__errors')).toEqual([]);
  });

  it('keeps the drill-down arrows out of an exported image', async () => {
    await page.open(url, drillRender);
    const xml = drillRender.xml;
    await page.eval(`window.postMessage(${JSON.stringify({ type: 'exportSource', requestId: 'export-1', format: 'svg', xml })}, '*')`);
    await page.eval(`new Promise((r) => { const t = () => (window.__posted.some((m) => m.type === 'exportData') ? r(true) : setTimeout(t, 20)); t(); })`);
    const svg = await page.eval<string>(`(() => { const m = window.__posted.find((m) => m.type === 'exportData'); return typeof m.data === 'string' ? m.data : JSON.stringify(m); })()`);
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/drilldown|<button/);
    expect(await page.eval<number>(`document.querySelectorAll('.bjs-breadcrumbs').length`)).toBe(0);
  });

  it('opens the saved tab when the webview is rebuilt (its editor tab was shown again)', async () => {
    await page.open(url, renderAgain, `document.getElementById('tab-warnings').click()`);
    const saved = await page.eval<unknown>('window.__state');
    expect(saved).toEqual({ tab: 'warnings' });

    await page.open(`${url}?state=${encodeURIComponent(JSON.stringify(saved))}`, renderAgain);
    const shown = await page.eval<{ tab: string; state: unknown; errors: string[] }>(`({
      tab: document.querySelector('.tab.active').textContent,
      state: window.__state,
      errors: window.__errors,
    })`);
    expect(shown.tab).toMatch(/^Warnings/);
    expect(shown.state).toEqual({ tab: 'warnings' });
    expect(shown.errors).toEqual([]);
  });

  it('opens Details when the saved tab is not one it knows', async () => {
    await page.open(`${url}?state=${encodeURIComponent(JSON.stringify({ tab: 'settings' }))}`, renderAgain);
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Details');
  });

  it('hides the Trace tab while no description is attached', async () => {
    await page.open(url, renderAgain);
    expect(await page.eval<boolean>(`document.getElementById('tab-trace').hidden`)).toBe(true);
  });

  it('shows the Trace tab with a found description, without switching to it', async () => {
    await page.open(url, trace.found);
    const shown = await page.eval<{ hidden: boolean; active: string; summary: string; file: string; groups: string[]; errors: string[] }>(`({
      hidden: document.getElementById('tab-trace').hidden,
      active: document.querySelector('.tab.active').textContent,
      summary: document.querySelector('.trace-summary').textContent,
      file: document.querySelector('.trace-file').textContent,
      groups: [...document.querySelectorAll('.trace h3')].map((h) => h.textContent),
      errors: window.__errors,
    })`);
    expect(shown).toEqual({
      hidden: false,
      active: 'Details',
      summary: '24 of 24 checkable items found (19 exact, 5 near) · 0 missing · 17 unchecked · 1 extra',
      file: 'Checked against order-description.md',
      groups: [
        'Main process steps',
        'Gateway paths · after Determine Order Route',
        'Business object · OrderRequest',
        'Human tasks · Manager Approval',
        'Human tasks · Compliance Review',
        'Human tasks · Handle Exception',
        'Not in the description',
      ],
      errors: [],
    });
    // No marks on the canvas.
    expect(await page.eval<number>(`document.querySelectorAll('.ls-diff-added, .ls-diff-changed').length`)).toBe(0);
  });

  it('opens the Trace tab after a pick and shows icons and near matches', async () => {
    await page.open(url, trace.picked);
    const rows = await page.eval<string[][]>(
      `[...document.querySelectorAll('.trace-row')].slice(0, 3).map((r) => [r.querySelector('.trace-icon').textContent, r.querySelector('.trace-body > :first-child').textContent, r.querySelector('.trace-detail').textContent])`,
    );
    // Extra items are normal additions: the tab counts missing items only.
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Trace');
    expect(rows).toEqual([
      ['≈', 'Submit Order', "matched as 'Order Submitted'"],
      ['≈', 'Validate Order', "matched as 'Validate Order SF'"],
      ['≈', 'Lookup Country Info', "matched as 'Lookup Country Info SF'"],
    ]);
  });

  it('selects the node of a clicked row and shows its details', async () => {
    await page.open(url, trace.picked);
    await page.clickButton('Validate Order');
    const after = await page.eval<{ selected: string[]; details: string; tab: string }>(`({
      selected: [...document.querySelectorAll('.djs-element.selected')].map((e) => e.getAttribute('data-element-id')),
      details: document.querySelector('[aria-labelledby="tab-details"] h2').textContent,
      tab: document.querySelector('.tab.active').textContent,
    })`);
    const id = trace.picked.trace!.rows.find((r) => r.text === 'Validate Order')!.target as { id: string };
    expect(after).toEqual({ selected: [id.id], details: 'Validate Order SF', tab: 'Details' });
  });

  it('opens the sub-process level of a row inside a sub-process, then selects the node there', async () => {
    await page.open(url, subTrace.picked);
    await page.eval('window.__posted.length = 0');
    await page.clickButton('Pick Items');
    const posted = await page.eval<unknown[]>('window.__posted');
    expect(posted).toEqual([{ type: 'openCallee', calleeId: 'sub:prepare', path: ['order'] }]);
    const level = await subTrace.open(posted[0]);
    expect(level.path.map((l) => l.id)).toEqual(['order', 'sub:prepare']);
    await page.eval(`(async () => { window.postMessage(${JSON.stringify(level)}, '*'); await new Promise((r) => setTimeout(r, 300)); })()`);
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.djs-element.selected')].map((e) => e.getAttribute('data-element-id'))`)).toEqual(['pick']);
    expect(await page.eval<string>(`document.querySelector('[aria-labelledby="tab-details"] h2').textContent`)).toBe('Pick Items');
  });

  it('shows one notice line for a description without a section of the format, and counts missing items on the tab', async () => {
    const empty = await traceRenders(v1Package, '# Orders\n\nThe customer orders and we deliver.\n');
    await page.open(url, empty.picked);
    expect(
      await page.eval<{ tab: string; lines: string[]; rows: number; error: boolean }>(`({
        tab: document.querySelector('.tab.active').textContent,
        lines: [...document.querySelectorAll('[aria-labelledby="tab-trace"] p')].map((p) => p.textContent),
        rows: document.querySelectorAll('.trace-row').length,
        error: document.querySelector('.trace-error') !== null,
      })`),
    ).toEqual({
      tab: 'Trace',
      lines: ['No checkable sections found in order-description.md. Lanescope reads the Lanescope description format, see the README.'],
      rows: 0,
      error: false,
    });
    const missing = await traceRenders(v1Package, '## Main process steps\n- Ship Order\n- Bill Order\n- Route Order\n');
    await page.open(url, missing.picked);
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Trace (2)');
  });

  it('Clear in the Trace tab asks the host to stop the check', async () => {
    await page.open(url, trace.picked);
    await page.eval('window.__posted.length = 0');
    await page.clickSelector('[aria-labelledby="tab-trace"] .compared-with .button');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'clearDescription' }]);
    // The next render has no trace: the tab goes, Details comes back.
    await page.eval(`(async () => { window.postMessage(${JSON.stringify({ ...renderAgain, preserveView: true })}, '*'); await new Promise((r) => setTimeout(r, 300)); })()`);
    expect(await page.eval<{ hidden: boolean; active: string }>(`({ hidden: document.getElementById('tab-trace').hidden, active: document.querySelector('.tab.active').textContent })`)).toEqual({
      hidden: true,
      active: 'Details',
    });
  });

  // ---- Trace button ------------------------------------------------------

  const traceUi = `({
    tooltip: document.querySelector('.split-main').title,
    badge: document.querySelector('.split-main .count-badge').hidden ? null : document.querySelector('.split-main .count-badge').textContent,
    menuOpen: !document.querySelector('.split .menu').hidden,
    items: [...document.querySelectorAll('.split .menu-item')].map((i) => [i.textContent, i.disabled]),
    focused: document.activeElement.textContent,
    tab: document.querySelector('.tab.active').textContent,
  })`;
  type TraceUi = { tooltip: string; badge: string | null; menuOpen: boolean; items: Array<[string, boolean]>; focused: string; tab: string };

  it('Trace button without a description: the main part asks for one, the menu offers the commands, Clear is disabled', async () => {
    await page.open(url, renderAgain);
    // After the render, the webview asks for the label of the description item.
    expect(await page.eval<unknown[]>('window.__posted')).toContainEqual({ type: 'descriptionStatus' });
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({ tooltip: 'Check this process against a description', badge: null, menuOpen: false });
    await page.eval('window.__posted.length = 0');
    await page.clickSelector('.split-main');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'checkDescription' }]);

    await page.clickSelector('.split-arrow');
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({
      menuOpen: true,
      items: [
        ['Check Against Description…', false],
        ['New Process Description', false],
        ['Clear Description Check', true],
      ],
      focused: 'Check Against Description…',
    });
    // Arrow keys skip the disabled item.
    await page.pressKey('ArrowDown', 'ArrowDown', 40);
    expect((await page.eval<TraceUi>(traceUi)).focused).toBe('New Process Description');
    await page.pressKey('ArrowDown', 'ArrowDown', 40);
    expect((await page.eval<TraceUi>(traceUi)).focused).toBe('Check Against Description…');
    // Escape closes it, back on the arrow.
    await page.pressKey('Escape', 'Escape', 27);
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({ menuOpen: false, focused: '▾' });
    // Enter on the arrow opens it again; an item posts its command.
    await page.pressEnter();
    expect((await page.eval<TraceUi>(traceUi)).menuOpen).toBe(true);
    await page.eval('window.__posted.length = 0');
    await page.clickButton('New Process Description');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'newDescription' }]);
    expect((await page.eval<TraceUi>(traceUi)).menuOpen).toBe(false);
    // A click outside closes it.
    await page.clickSelector('.split-arrow');
    await page.clickSelector('.title');
    expect((await page.eval<TraceUi>(traceUi)).menuOpen).toBe(false);

    // The label follows the host: a render and every opening ask whether the description is there.
    await page.eval('window.__posted.length = 0');
    await page.clickSelector('.split-arrow');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'descriptionStatus' }]);
    await page.eval(`(async () => { window.postMessage({ type: 'descriptionStatus', exists: true }, '*'); await new Promise((r) => setTimeout(r, 50)); })()`);
    expect((await page.eval<TraceUi>(traceUi)).items[1]).toEqual(['Open Process Description', false]);
    await page.eval(`(async () => { window.postMessage({ type: 'descriptionStatus', exists: false }, '*'); await new Promise((r) => setTimeout(r, 50)); })()`);
    expect((await page.eval<TraceUi>(traceUi)).items[1]).toEqual(['New Process Description', false]);
    await page.pressKey('Escape', 'Escape', 27);
    expect(await page.eval<string[]>('window.__errors')).toEqual([]);
  });

  it('Trace button with a description: badge of the missing items, file in the tooltip, the main part opens the tab', async () => {
    const missing = await traceRenders(v1Package, '## Main process steps\n- Ship Order\n- Bill Order\n- Route Order\n');
    await page.open(url, missing.found);
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({
      tooltip: 'Show the check against order-description.md (2 missing)',
      badge: '2',
      tab: 'Details',
    });
    await page.eval('window.__posted.length = 0');
    await page.clickSelector('.split-main');
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({ tab: 'Trace (2)' });
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([]);
    await page.clickSelector('.split-arrow');
    expect((await page.eval<TraceUi>(traceUi)).items[2]).toEqual(['Clear Description Check', false]);
    await page.eval('window.__posted.length = 0');
    await page.clickButton('Clear Description Check');
    expect(await page.eval<unknown[]>('window.__posted')).toEqual([{ type: 'clearDescription' }]);
    // Nothing missing: no badge.
    await page.open(url, trace.found);
    expect(await page.eval<TraceUi>(traceUi)).toMatchObject({ badge: null, tooltip: 'Show the check against order-description.md' });
  });

  // ---- Selection ---------------------------------------------------------

  const selection = `({
    marked: [...document.querySelectorAll('.ls-selected')].map((e) => e.getAttribute('data-element-id')),
    lane: [...document.querySelectorAll('.ls-selected-lane')].map((e) => e.getAttribute('data-element-id')),
    svgOutline: getComputedStyle(document.querySelector('.djs-container svg')).outlineStyle,
    canvasOutline: getComputedStyle(document.querySelector('.canvas')).outlineStyle,
    focusInCanvas: document.querySelector('.canvas').contains(document.activeElement),
  })`;
  type SelectionUi = { marked: string[]; lane: string[]; svgOutline: string; canvasOutline: string; focusInCanvas: boolean };
  const shapeStyle = (id: string) =>
    page.eval<{ stroke: string; width: string; filter: string; dash: string }>(
      `(() => { const v = document.querySelector('[data-element-id="${id}"] .djs-visual'); const s = getComputedStyle(v.firstElementChild); return { stroke: s.stroke, width: s.strokeWidth, filter: getComputedStyle(v).filter, dash: s.strokeDasharray }; })()`,
    );

  it('highlights a clicked task and frames nothing; the highlight moves with the next click and goes on empty canvas', async () => {
    await page.open(url, trace.found);
    await page.clickSelector(`[data-element-id="${MANAGER_TASK_ID}"] .djs-hit`);
    expect(await page.eval<SelectionUi>(selection)).toEqual({ marked: [MANAGER_TASK_ID], lane: [], svgOutline: 'none', canvasOutline: 'none', focusInCanvas: true });
    const style = await shapeStyle(MANAGER_TASK_ID);
    expect(style.stroke).toBe('rgb(0, 120, 212)');
    expect(style.width).toBe('3px');
    expect(style.filter).toMatch(/drop-shadow/);
    expect(await page.eval<string>(`document.querySelector('[aria-labelledby="tab-details"] h2').textContent`)).toBe('Manager Approval');

    // A gateway: the highlight moves.
    await page.clickSelector(`[data-element-id="${ROUTE_GATEWAY_ID}"] .djs-hit`);
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([ROUTE_GATEWAY_ID]);
    expect((await shapeStyle(ROUTE_GATEWAY_ID)).stroke).toBe('rgb(0, 120, 212)');
    expect((await shapeStyle(MANAGER_TASK_ID)).width).not.toBe('3px');

    // A sequence flow.
    await page.eval(`window.__lanescopeFlow = document.querySelector('[data-element-id="${EXCEPTION_FLOW_ID}"] .djs-hit')`);
    await page.clickSelector(`[data-element-id="${EXCEPTION_FLOW_ID}"] .djs-hit`);
    const flow = await page.eval<{ marked: string[]; stroke: string; width: string }>(
      `(() => { const p = getComputedStyle(document.querySelector('[data-element-id="${EXCEPTION_FLOW_ID}"] .djs-visual > path')); return { marked: [...document.querySelectorAll('.ls-selected')].map((e) => e.getAttribute('data-element-id')), stroke: p.stroke, width: p.strokeWidth }; })()`,
    );
    expect(flow).toEqual({ marked: [EXCEPTION_FLOW_ID], stroke: 'rgb(0, 120, 212)', width: '3px' });

    // A lane: plainer (dashed, no glow).
    const lane = await page.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('[data-element-id="${SYSTEM_LANE_ID}"]').getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`,
    );
    await page.clickAt(lane.x, lane.y);
    expect(await page.eval<SelectionUi>(selection)).toMatchObject({ marked: [SYSTEM_LANE_ID], lane: [SYSTEM_LANE_ID] });
    const laneStyle = await shapeStyle(SYSTEM_LANE_ID);
    expect(laneStyle.dash).not.toBe('none');
    expect(laneStyle.filter).toBe('none');

    // Empty canvas: nothing.
    const corner = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.canvas').getBoundingClientRect(); return { x: r.x + 4, y: r.bottom - 4 }; })()`);
    await page.clickAt(corner.x, corner.y);
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([]);
    expect(await page.eval<string[]>('window.__errors')).toEqual([]);
  });

  it('frames the diagram thinly for a keyboard user only', async () => {
    await page.open(url, trace.found);
    await page.eval(`document.querySelector('.canvas').focus()`);
    await page.pressKey('Shift', 'ShiftLeft', 16);
    await page.pressKey('Shift', 'ShiftLeft', 16);
    expect(await page.eval<string>(`getComputedStyle(document.querySelector('.canvas')).outline`)).toBe('rgb(0, 120, 212) solid 1px');
    await page.clickSelector(`[data-element-id="${MANAGER_TASK_ID}"] .djs-hit`);
    expect(await page.eval<string>(`getComputedStyle(document.querySelector('.canvas')).outlineStyle`)).toBe('none');
  });

  it('a Trace row and a Changes row highlight the same way, and a re-render keeps it', async () => {
    await page.open(url, trace.picked);
    await page.clickButton('Validate Order');
    const validateId = (trace.picked.trace!.rows.find((r) => r.text === 'Validate Order')!.target as { id: string }).id;
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([validateId]);
    await page.eval(`(async () => { window.postMessage(${JSON.stringify({ ...trace.found, preserveView: true })}, '*'); await new Promise((r) => setTimeout(r, 300)); })()`);
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([validateId]);

    await page.open(url, render);
    await page.clickButton('User task "Manager Review"');
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([MANAGER_TASK_ID]);
    // The diff mark keeps its colour under the selection; the selection adds the glow.
    const style = await shapeStyle(MANAGER_TASK_ID);
    expect(style.stroke).toBe('rgb(226, 192, 141)');
    expect(style.width).toBe('3px');
    expect(style.filter).toMatch(/drop-shadow/);
  });

  it('follows the theme: the focus colour of light, dark and high contrast themes', async () => {
    for (const [theme, color, rgb] of [
      ['vscode-light', '#005fb8', 'rgb(0, 95, 184)'],
      ['vscode-high-contrast', '#f38518', 'rgb(243, 133, 24)'],
      ['vscode-dark', '#0078d4', 'rgb(0, 120, 212)'],
    ]) {
      await page.open(url, trace.found, `document.body.style.setProperty('--vscode-focusBorder', '${color}'); document.body.className = '${theme}'; await new Promise((r) => setTimeout(r, 50))`);
      await page.clickSelector(`[data-element-id="${MANAGER_TASK_ID}"] .djs-hit`);
      expect((await shapeStyle(MANAGER_TASK_ID)).stroke).toBe(rgb);
    }
  });

  it('keeps the selection highlight out of an exported image', async () => {
    await page.open(url, trace.found);
    await page.clickSelector(`[data-element-id="${MANAGER_TASK_ID}"] .djs-hit`);
    expect((await page.eval<SelectionUi>(selection)).marked).toEqual([MANAGER_TASK_ID]);
    await page.eval(`window.postMessage(${JSON.stringify({ type: 'exportSource', requestId: 'export-9', format: 'svg', xml: trace.found.xml })}, '*')`);
    await page.eval(`new Promise((r) => { const t = () => (window.__posted.some((m) => m.type === 'exportData' && m.requestId === 'export-9') ? r(true) : setTimeout(t, 20)); t(); })`);
    const svg = await page.eval<string>(`window.__posted.find((m) => m.type === 'exportData' && m.requestId === 'export-9').data`);
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/ls-selected|selected|split-main|count-badge/);
  });

  it('keeps the chosen tab on a render without the Compare… flag', async () => {
    expect(renderAgain.showChanges).toBeUndefined();
    await page.open(url, renderAgain, `document.getElementById('tab-data').click()`);
    expect(await page.eval<string>(`document.querySelector('.tab.active').textContent`)).toBe('Data');
  });
});
