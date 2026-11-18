import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_TIMEOUT_MS, startLoadWatchdog } from '../../webview/loadWatchdog';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { DEFAULT_VIEW_OPTIONS, parseWebviewMessage, type HostMessage, type RenderMessage } from '../../src/views/protocol';
import { buildErrorMessage, buildRenderMessage } from '../../src/views/viewModel';
import { ViewerSession } from '../../src/views/viewerSession';
import { buildCsp, buildWebviewHtml, createNonce } from '../../src/views/webviewHtml';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const FIXTURE = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
/** The local exports the TWX cases use (../localFixtures); skipped when they are not there. */
const REAL = hasLocalTwx('orderDelivery', 'services');

let pkg: ProcessPackage;
let twxPkg: ProcessPackage;
let manyPkg: ProcessPackage;

beforeAll(async () => {
  pkg = await readProcessPackage(await readBpmnPackage(FIXTURE));
  if (!REAL) return;
  twxPkg = await readTwxPackage(localTwx('orderDelivery'));
  manyPkg = await readTwxPackage(localTwx('services'));
});

describe('parseWebviewMessage', () => {
  it('accepts valid messages', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'selectProcess', processId: '25.a', extra: 1 })).toEqual({
      type: 'selectProcess',
      processId: '25.a',
    });
    expect(
      parseWebviewMessage({
        type: 'setOptions',
        options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true, extra: 1 },
      }),
    ).toEqual({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true } });
  });

  it('rejects malformed messages', () => {
    for (const value of [
      null,
      undefined,
      'ready',
      42,
      {},
      { type: 'save' },
      { type: 'setOptions' },
      { type: 'setOptions', options: null },
      { type: 'setOptions', options: { hideGeneratedFlowLabels: 'yes', hideEmptyLanes: true } },
      { type: 'selectProcess' },
      { type: 'selectProcess', processId: '' },
      { type: 'selectProcess', processId: 7 },
    ]) {
      expect(parseWebviewMessage(value)).toBeUndefined();
    }
  });
});

describe('buildRenderMessage', () => {
  let msg: RenderMessage;

  beforeAll(async () => {
    msg = await buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS);
  });

  it('describes the process and its source', () => {
    expect(msg.type).toBe('render');
    expect(msg.preserveView).toBe(false);
    expect(msg.options).toEqual(DEFAULT_VIEW_OPTIONS);
    expect(msg.process).toMatchObject({
      name: 'Order Delivery Process',
      sourceFile: 'order-delivery-process.zip / order-delivery-process.bpmn',
      exporter: 'generate-baw-bpmn 1.0.0',
    });
    expect(msg.xml).toContain('bpmndi:BPMNDiagram');
  });

  it('has details for every node and flow, keyed by diagram id', () => {
    const process = pkg.processes[0];
    for (const node of process.nodes) {
      expect(msg.elements[node.id]).toMatchObject({ kind: 'node', id: node.id, name: node.name });
      expect(msg.xml).toContain(`id="${node.id}"`);
    }
    for (const flow of process.flows) {
      expect(msg.elements[flow.id]).toMatchObject({ kind: 'flow', id: flow.id });
    }
    const lanes = Object.values(msg.elements).filter((e) => e.kind === 'lane');
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      expect(msg.xml).toContain(`id="${lane.id}"`);
    }
  });

  it('uses readable names for flow ends and node kinds', () => {
    const process = pkg.processes[0];
    const flow = process.flows[0];
    const details = msg.elements[flow.id];
    expect(details.kind).toBe('flow');
    if (details.kind !== 'flow') return;
    const source = process.nodes.find((n) => n.id === flow.sourceId)!;
    expect(details.source).toBe(source.name || source.id);

    const start = process.nodes.find((n) => n.kind === 'startEvent')!;
    expect(msg.elements[start.id]).toMatchObject({ bpmnKind: 'Start event' });
  });

  it('marks generated flow labels as hidden only when hiding is on', async () => {
    const hidden = Object.values(msg.elements).filter((e) => e.kind === 'flow' && e.labelHidden);
    expect(hidden.length).toBeGreaterThan(0);

    const shown = await buildRenderMessage(pkg, { ...DEFAULT_VIEW_OPTIONS, hideGeneratedFlowLabels: false }, true);
    expect(shown.preserveView).toBe(true);
    expect(Object.values(shown.elements).filter((e) => e.kind === 'flow' && e.labelHidden)).toEqual([]);
  });

  it('passes the XSD data types through', () => {
    expect(msg.dataTypes).toEqual(pkg.dataTypes);
    expect(msg.dataTypes.length).toBeGreaterThan(0);
  });

  it('fails on a package without a process', async () => {
    await expect(buildRenderMessage({ ...pkg, processes: [] }, DEFAULT_VIEW_OPTIONS)).rejects.toThrow(
      /does not contain a process/,
    );
  });

  it('lists every process and shows the requested one, else the first', async () => {
    const twoPkg = { ...pkg, processes: [pkg.processes[0], { ...pkg.processes[0], id: 'Other', name: 'Other' }] };
    const first = await buildRenderMessage(twoPkg, DEFAULT_VIEW_OPTIONS);
    expect(first.processes).toEqual([
      { id: pkg.processes[0].id, name: 'Order Delivery Process' },
      { id: 'Other', name: 'Other' },
    ]);
    expect(first.process.id).toBe(pkg.processes[0].id);
    expect(first.warnings.some((w) => /processes/.test(w))).toBe(false);

    const other = await buildRenderMessage(twoPkg, DEFAULT_VIEW_OPTIONS, false, 0, 'Other');
    expect(other.process.id).toBe('Other');
    const gone = await buildRenderMessage(twoPkg, DEFAULT_VIEW_OPTIONS, false, 0, 'Gone');
    expect(gone.process.id).toBe(pkg.processes[0].id);
  });

  it('has no warnings for the Bob BPMN but its empty lane', () => {
    expect(msg.warnings).toEqual(['Lane Customer has no activities']);
  });
});

describe.skipIf(!REAL)('buildRenderMessage for a TWX', () => {
  let msg: RenderMessage;

  beforeAll(async () => {
    msg = await buildRenderMessage(twxPkg, DEFAULT_VIEW_OPTIONS);
  });

  it('describes the BPD, the process app and its toolkits', () => {
    expect(msg.processes).toEqual([{ id: 'id_25.98749a22-2145-4dd0-897c-f2943c465813', name: 'Order Delivery Process' }]);
    expect(msg.process.originalId).toBe('25.98749a22-2145-4dd0-897c-f2943c465813');
    expect(msg.process).toMatchObject({
      name: 'Order Delivery Process',
      sourceFile: 'order-delivery-process.no-toolkits.twx',
      exporter: 'IBM BAW 8.6.6.23020',
      app: 'order-delivery-process / Initial Import 2',
      toolkits: ['System Data 8.6.0.0', 'UI Toolkit 8.6.0.0'],
    });
  });

  it('shows exactly the four unconditioned gateway flows and the empty lane in the Warnings tab', () => {
    expect(msg.warnings).toHaveLength(5);
    expect(msg.warnings).toContain('Lane Participant has no activities');
    expect(msg.warnings.filter((w) => w.startsWith('Exclusive gateway "Validation Passed?"'))).toHaveLength(1);
    expect(msg.warnings.filter((w) => w.startsWith('Exclusive gateway "Route Order"'))).toHaveLength(3);
  });

  it('draws the nodes at their BAW positions', () => {
    const validate = twxPkg.processes[0].nodes.find((n) => n.name === 'Validate Order SF')!;
    expect(msg.xml).toMatch(
      new RegExp(`bpmnElement="${validate.id}"[^>]*>\\s*<dc:Bounds x="158" y="432" width="95" height="70"`),
    );
  });

  it('names the service a call activity calls', () => {
    const validate = twxPkg.processes[0].nodes.find((n) => n.name === 'Validate Order SF')!;
    expect(msg.elements[validate.id]).toMatchObject({
      kind: 'node',
      bpmnKind: 'Task',
      serviceType: 'ServiceFlow',
      calls: 'Order Delivery Process_Validate Order SF (Service flow)',
      lane: 'System',
    });
  });

  it('notes packed toolkits that are not read', async () => {
    const many = await buildRenderMessage(manyPkg, DEFAULT_VIEW_OPTIONS);
    expect(many.process.toolkits).toEqual([
      'UI Toolkit 8.6.0.0',
      'System Data 8.6.0.0_TC',
      'MigTK 1.2',
      '(3 packed in the export, not read)',
    ]);
    expect(many.processes.map((p) => p.name)).toEqual([
      'Demo_MainProcess',
      'Demo_TrackedProcess',
      'DemoChildProcess',
      'JsSampleProcess',
      'MyFirstProcess',
      'MyProcess2',
    ]);
  });
});

describe('buildErrorMessage', () => {
  it('uses the error message', () => {
    expect(buildErrorMessage('a.zip', new Error('boom'))).toEqual({
      type: 'error',
      title: 'Cannot show a.zip',
      message: 'boom',
    });
    expect(buildErrorMessage('a.zip', 'plain').message).toBe('plain');
  });
});

describe('ViewerSession', () => {
  function session(load: () => Promise<ProcessPackage>) {
    const posted: HostMessage[] = [];
    let loads = 0;
    const s = new ViewerSession({
      fileName: 'test.zip',
      load: () => {
        loads++;
        return load();
      },
      post: (m) => posted.push(m),
    });
    return { s, posted, loads: () => loads };
  }

  it('renders on ready and re-renders with new options, loading once', async () => {
    const { s, posted, loads } = session(async () => pkg);
    await s.handleMessage({ type: 'ready' });
    await s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: false } });

    expect(posted.map((m) => m.type)).toEqual(['render', 'render']);
    const [first, second] = posted as RenderMessage[];
    expect(first.preserveView).toBe(false);
    expect(second.preserveView).toBe(true);
    expect(second.options).toEqual({ hideGeneratedFlowLabels: false, hideEmptyLanes: false });
    expect(s.currentOptions).toEqual(second.options);
    expect(loads()).toBe(1);
  });

  it.skipIf(!REAL)('switches the process on selectProcess, fits it, and keeps the choice on toggles', async () => {
    const { s, posted, loads } = session(async () => manyPkg);
    await s.handleMessage({ type: 'ready' });
    const target = manyPkg.processes[4];
    await s.handleMessage({ type: 'selectProcess', processId: target.id });
    await s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true } });

    const [first, selected, toggled] = posted as RenderMessage[];
    expect(first.process.id).toBe(manyPkg.processes[0].id);
    expect(selected.process.id).toBe(target.id);
    expect(selected.preserveView).toBe(false);
    expect(toggled.process.id).toBe(target.id);
    expect(toggled.preserveView).toBe(true);
    expect(s.currentProcessId).toBe(target.id);
    expect(loads()).toBe(1);
  });

  it('ignores unknown messages', async () => {
    const { s, posted } = session(async () => pkg);
    await s.handleMessage({ type: 'write', path: '/etc/passwd' });
    expect(posted).toEqual([]);
  });

  it('posts an error when the file cannot be read', async () => {
    const { s, posted } = session(async () => {
      throw new Error('not a zip');
    });
    await s.handleMessage({ type: 'ready' });
    expect(posted).toEqual([{ type: 'error', title: 'Cannot show test.zip', message: 'not a zip' }]);
  });

  describe('ready handshake', () => {
    /** A load that finishes only when the test says so. */
    function deferredLoad() {
      let resolve!: (p: ProcessPackage) => void;
      const promise = new Promise<ProcessPackage>((r) => (resolve = r));
      return { load: () => promise, resolve };
    }

    it('posts nothing before ready, then the finished result at once (result first)', async () => {
      const { s, posted, loads } = session(async () => pkg);
      await s.start();
      expect(posted).toEqual([]);

      void s.handleMessage({ type: 'ready' });
      // Posted synchronously on ready: no second load or layout run.
      expect(posted.map((m) => m.type)).toEqual(['render']);
      expect((posted[0] as RenderMessage).preserveView).toBe(false);
      expect(loads()).toBe(1);
    });

    it('posts the result when it is done if ready came first (ready first)', async () => {
      const deferred = deferredLoad();
      const { s, posted, loads } = session(deferred.load);
      const started = s.start();
      const ready = s.handleMessage({ type: 'ready' });
      await Promise.resolve();
      expect(posted).toEqual([]);

      deferred.resolve(pkg);
      await Promise.all([started, ready]);
      expect(posted.map((m) => m.type)).toEqual(['render']);
      expect(loads()).toBe(1);
    });

    it('renders on ready without an explicit start', async () => {
      const { s, posted } = session(async () => pkg);
      await s.handleMessage({ type: 'ready' });
      expect(posted.map((m) => m.type)).toEqual(['render']);
    });

    it('re-sends the last result when a reloaded webview sends ready again', async () => {
      const { s, posted, loads } = session(async () => pkg);
      await s.start();
      await s.handleMessage({ type: 'ready' });
      await s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: false } });
      await s.handleMessage({ type: 'ready' });

      expect(posted.map((m) => m.type)).toEqual(['render', 'render', 'render']);
      const [, toggled, resent] = posted as RenderMessage[];
      expect(toggled.preserveView).toBe(true);
      // Same diagram and options, but a fresh webview fits it to the window.
      expect(resent).toEqual({ ...toggled, preserveView: false });
      expect(loads()).toBe(1);
    });

    it('re-sends an error when the webview sends ready again', async () => {
      const { s, posted } = session(async () => {
        throw new Error('not a zip');
      });
      await s.start();
      await s.handleMessage({ type: 'ready' });
      await s.handleMessage({ type: 'ready' });
      expect(posted.map((m) => m.type)).toEqual(['error', 'error']);
    });

    it('re-sends the last result, then the toggled one, when ready arrives mid-toggle', async () => {
      const { s, posted } = session(async () => pkg);
      await s.handleMessage({ type: 'ready' });
      const toggle = s.handleMessage({
        type: 'setOptions',
        options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true },
      });
      const ready = s.handleMessage({ type: 'ready' });
      await Promise.all([toggle, ready]);
      // Initial render, the re-sent initial render, then the toggled one.
      expect(posted).toHaveLength(3);
      expect((posted[2] as RenderMessage).options.hideGeneratedFlowLabels).toBe(false);
    });
  });

  it('drops a render that a newer request overtook', async () => {
    const { s, posted } = session(async () => pkg);
    const a = s.handleMessage({ type: 'ready' });
    const b = s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true } });
    await Promise.all([a, b]);
    expect(posted).toHaveLength(1);
    expect((posted[0] as RenderMessage).options.hideGeneratedFlowLabels).toBe(false);
  });
});

describe('load watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after 10 seconds without an answer', () => {
    const onTimeout = vi.fn();
    const watchdog = startLoadWatchdog(onTimeout);
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.timedOut).toBe(true);
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire once the host answered', () => {
    const onTimeout = vi.fn();
    const watchdog = startLoadWatchdog(onTimeout);
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS / 2);
    watchdog.answered();
    watchdog.answered();
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(watchdog.timedOut).toBe(false);
  });
});

describe('webview HTML', () => {
  it('has a strict CSP without inline or remote sources', () => {
    const csp = buildCsp('vscode-webview://abc', 'N0NCE');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0NCE'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it('loads only the bundled script and stylesheet and escapes the title', () => {
    const html = buildWebviewHtml({
      cspSource: 'vscode-webview://abc',
      scriptUri: 'vscode-webview://abc/dist/webview/main.js',
      styleUri: 'vscode-webview://abc/dist/webview/main.css',
      nonce: 'N0NCE',
      title: '<b>x</b>.bpmn',
    });
    expect(html).toContain('<script nonce="N0NCE" src="vscode-webview://abc/dist/webview/main.js"></script>');
    expect(html).toContain('href="vscode-webview://abc/dist/webview/main.css"');
    expect(html).toContain('<title>&lt;b&gt;x&lt;/b&gt;.bpmn</title>');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('creates alphanumeric nonces', () => {
    const nonce = createNonce((n) => new Uint8Array(n).map((_, i) => i * 37));
    expect(nonce).toMatch(/^[A-Za-z0-9]{16,}$/);
  });
});
