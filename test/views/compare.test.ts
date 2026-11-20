// Comparison in the viewer session: a picked file as the base, the previous
// version after a live refresh, Clear, a process switch, drill-down, a base
// that cannot be read, the webview messages, and exports without diff marks.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { parseWebviewMessage, type HostMessage, type RenderMessage } from '../../src/views/protocol';
import { PROCESSES_ONLY_NOTE, ViewerSession, type CompareHost, type ExportHost, type Timers } from '../../src/views/viewerSession';
import { V1_ZIP, V2_ZIP } from '../bobV2';
import { PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

let v1: ProcessPackage;
let v2: ProcessPackage;

beforeAll(async () => {
  v1 = await readProcessPackage(await readBpmnPackage(V1_ZIP));
  v2 = await readProcessPackage(await readBpmnPackage(V2_ZIP));
});

/** Runs the debounce timer by hand; the layout keeps its real timers. */
class ManualTimers implements Timers {
  private readonly timers = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  fire(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const cb of callbacks) cb();
  }
}

interface Options {
  content: ProcessPackage;
  /** What the open dialog gives back, and what reading it gives. */
  bases?: Record<string, ProcessPackage | Error>;
  exporter?: ExportHost;
}

function session(options: Options) {
  const timers = new ManualTimers();
  const posted: HostMessage[] = [];
  const failures: string[] = [];
  const file: { content: ProcessPackage | Error } = { content: options.content };
  let pick: string | undefined;
  const loadedBases: string[] = [];
  let clock = Date.UTC(2026, 10, 20, 14, 32);
  const comparer: CompareHost = {
    chooseBase: async () => pick,
    loadBase: async (p) => {
      loadedBases.push(p);
      const base = options.bases?.[p];
      if (!base) throw new Error('ENOENT');
      if (base instanceof Error) throw base;
      return base;
    },
    failed: (m) => failures.push(m),
  };
  const s = new ViewerSession({
    fileName: 'order-delivery-process.zip',
    load: async () => {
      if (file.content instanceof Error) throw file.content;
      return file.content;
    },
    post: (m) => posted.push(m),
    timers,
    now: () => (clock += 60_000),
    comparer,
    ...(options.exporter ? { exporter: options.exporter } : {}),
  });
  return {
    s,
    posted,
    failures,
    file,
    loadedBases,
    pick: (p: string | undefined) => (pick = p),
    last: () => posted.filter((m): m is RenderMessage => m.type === 'render').at(-1)!,
    renders: () => posted.filter((m) => m.type === 'render').length,
    /** The file changed on disk: fire the debounce and wait for the reload. */
    async changed(content: ProcessPackage | Error) {
      file.content = content;
      s.fileChanged();
      timers.fire();
      await s.idle;
    },
  };
}

async function opened(options: Options) {
  const t = session(options);
  await t.s.start();
  await t.s.handleMessage({ type: 'ready' });
  return t;
}

const summary = (r: RenderMessage) => r.diff && { kind: r.diff.baseKind, label: r.diff.baseLabel, counts: r.diff.counts, note: r.diff.note };

describe('comparison: nothing to compare yet', () => {
  it('sends no diff on the first render', async () => {
    const t = await opened({ content: v1 });
    expect(t.last().diff).toBeUndefined();
  });
});

describe('comparison with a picked file', () => {
  const groups = (r: RenderMessage) => ({
    added: r.diff!.added.map((e) => e.label),
    removed: r.diff!.removed.map((e) => e.label),
    changed: r.diff!.changed.map((e) => `${e.label}: ${e.changes.join('; ')}`),
  });

  it('opened v2, compared with v1: the changes from v1 to v2', async () => {
    const t = await opened({ content: v2, bases: { '/work/order-delivery-process.zip': v1 } });
    t.pick('/work/order-delivery-process.zip');
    await t.s.requestCompare();
    expect(groups(t.last())).toEqual({
      added: ['Task "Notify Customer SF"', 'Flow "To Order Auto Approved"'],
      removed: ['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"'],
      changed: [
        'User task "Manager Review": Name: "Manager Approval" → "Manager Review"',
        'User task "Handle Exception": Lane: "Operations Team" → "Order Manager"',
        'Flow "Valid": Target: "Lookup Country Info SF" → "Determine Order Route SF"',
        'Flow "AUTO_APPROVE": Condition: "tw.local.order.route == "AUTO_APPROVE"" → "tw.local.order.route == "AUTO_APPROVE" && tw.local.order.amount < 5000"',
        'Flow "To Notify Customer SF": Name: "To Order Auto Approved" → "To Notify Customer SF"; Target: "Order Auto Approved" → "Notify Customer SF"',
        'Business object "OrderRequest": Field added: priority (string); Field removed: countryRegion',
      ],
    });
  });

  it('opened v1, compared with v2: the picked file is the older side, so the result is mirrored', async () => {
    const t = await opened({ content: v1, bases: { '/work/order-delivery-process.v2.zip': v2 } });
    t.pick('/work/order-delivery-process.v2.zip');
    await t.s.requestCompare();
    expect(groups(t.last())).toEqual({
      added: ['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"'],
      removed: ['Task "Notify Customer SF"', 'Flow "To Order Auto Approved"'],
      changed: [
        'User task "Manager Approval": Name: "Manager Review" → "Manager Approval"',
        'User task "Handle Exception": Lane: "Order Manager" → "Operations Team"',
        'Flow "Valid": Target: "Determine Order Route SF" → "Lookup Country Info SF"',
        'Flow "AUTO_APPROVE": Condition: "tw.local.order.route == "AUTO_APPROVE" && tw.local.order.amount < 5000" → "tw.local.order.route == "AUTO_APPROVE""',
        'Flow "To Order Auto Approved": Name: "To Notify Customer SF" → "To Order Auto Approved"; Target: "Notify Customer SF" → "Order Auto Approved"',
        'Business object "OrderRequest": Field added: countryRegion (string); Field removed: priority',
      ],
    });
  });

  it('reads the picked file once and compares the shown process with it', async () => {
    const t = await opened({ content: v1, bases: { '/work/order-delivery-process.v2.zip': v2 } });
    t.pick('/work/order-delivery-process.v2.zip');
    expect(await t.s.requestCompare()).toBe(true);
    const r = t.last();
    expect(summary(r)).toEqual({ kind: 'file', label: 'order-delivery-process.v2.zip', counts: { added: 2, removed: 2, changed: 6 }, note: undefined });
    expect(r.preserveView).toBe(true);
    expect(r.diff!.added.map((e) => e.label)).toEqual(['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"']);
    expect(Object.values(r.diff!.marks)).toContain('changed');
    expect(t.loadedBases).toEqual(['/work/order-delivery-process.v2.zip']);
    expect(t.s.comparingWithFile).toBe(true);
  });

  it('says "no changes" for the opened file itself', async () => {
    const t = await opened({ content: v1, bases: { '/work/order-delivery-process.zip': v1 } });
    t.pick('/work/order-delivery-process.zip');
    await t.s.handleMessage({ type: 'compareRequest' });
    expect(t.last().diff!.counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('keeps the file as the base across live refreshes, until Clear', async () => {
    const t = await opened({ content: v1, bases: { '/work/v2.zip': v2 } });
    t.pick('/work/v2.zip');
    await t.s.requestCompare();
    await t.changed(v2);
    expect(summary(t.last())).toMatchObject({ kind: 'file', counts: { added: 0, removed: 0, changed: 0 } });
    expect(t.loadedBases).toHaveLength(1);

    // Clear: back to the previous version, which is v1 (shown before the refresh).
    await t.s.handleMessage({ type: 'clearComparison' });
    expect(summary(t.last())).toMatchObject({ kind: 'previous', label: 'order-delivery-process.zip', counts: { added: 2, removed: 2, changed: 6 } });
    expect(t.s.comparingWithFile).toBe(false);
  });

  it('after Clear with no earlier version, there is nothing to compare', async () => {
    const t = await opened({ content: v1, bases: { '/work/v2.zip': v2 } });
    t.pick('/work/v2.zip');
    await t.s.requestCompare();
    await t.s.clearComparison();
    expect(t.last().diff).toBeUndefined();
  });

  it('reports a base that cannot be read and leaves the view as it is', async () => {
    const t = await opened({ content: v1, bases: { '/work/broken.zip': new Error('not a zip') } });
    t.pick('/work/broken.zip');
    await t.s.requestCompare();
    expect(t.failures).toEqual(['Cannot compare with broken.zip: not a zip']);
    expect(t.renders()).toBe(1);
    expect(t.s.comparingWithFile).toBe(false);
  });

  it('does nothing when the dialog is cancelled', async () => {
    const t = await opened({ content: v1 });
    t.pick(undefined);
    await t.s.requestCompare();
    expect(t.renders()).toBe(1);
    expect(t.loadedBases).toEqual([]);
  });
});

describe('Compare…: the Changes tab is shown once', () => {
  const shows = (t: ReturnType<typeof session>) => t.posted.filter((m): m is RenderMessage => m.type === 'render').map((r) => r.showChanges ?? false);

  it('flags only the render after a picked file was read', async () => {
    const t = await opened({ content: v1, bases: { '/work/v2.zip': v2 } });
    t.pick('/work/v2.zip');
    await t.s.requestCompare();
    expect(shows(t)).toEqual([false, true]);

    // Not on a toggle, a reload, a webview reload, or Clear.
    await t.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: true } });
    await t.changed(v2);
    await t.s.handleMessage({ type: 'ready' });
    await t.s.clearComparison();
    expect(shows(t)).toEqual([false, true, false, false, false, false]);
  });

  it('never flags a live refresh against the previous version', async () => {
    const t = await opened({ content: v1 });
    await t.changed(v2);
    await t.changed(v1);
    expect(shows(t)).toEqual([false, false, false]);
  });

  it('does not flag (or render) when the dialog is cancelled or the file cannot be read', async () => {
    const t = await opened({ content: v1, bases: { '/work/broken.zip': new Error('not a zip') } });
    t.pick(undefined);
    await t.s.requestCompare();
    t.pick('/work/broken.zip');
    await t.s.requestCompare();
    expect(shows(t)).toEqual([false]);
  });
});

describe('comparison with the previous version (live refresh)', () => {
  it('compares a reloaded package with the one shown before, and moves on with every reload', async () => {
    const t = await opened({ content: v1 });
    await t.changed(v2);
    const r = t.last();
    expect(summary(r)).toEqual({ kind: 'previous', label: 'order-delivery-process.zip', counts: { added: 2, removed: 2, changed: 6 }, note: undefined });
    // The time the previous version was read.
    expect(r.diff!.loadedAt).toBeLessThan(r.loadedAt);

    // A toggle redraws the same comparison.
    await t.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: false } });
    expect(summary(t.last())).toMatchObject({ kind: 'previous', counts: { added: 2, removed: 2, changed: 6 } });
    expect(t.last().options.highlightChanges).toBe(false);

    // The next refresh compares with v2, the version before it.
    await t.changed(v1);
    expect(summary(t.last())).toMatchObject({ kind: 'previous', counts: { added: 2, removed: 2, changed: 6 } });
    expect(t.last().diff!.added.map((e) => e.label)).toContain('Task "Lookup Country Info SF"');
  });

  it('keeps the base and its time when a reload brings the same content, and moves on when it differs', async () => {
    const t = await opened({ content: v1 });
    await t.changed(v2);
    const first = t.last().diff!;
    expect(first.counts).toEqual({ added: 2, removed: 2, changed: 6 });

    // Bob writes the same v2 again (a new read of equal content): the changes stay.
    await t.changed({ ...v2, processes: v2.processes.map((p) => ({ ...p })) });
    const again = t.last().diff!;
    expect(again.counts).toEqual(first.counts);
    expect(again.loadedAt).toBe(first.loadedAt);
    expect(again.changed.map((e) => e.label)).toEqual(first.changed.map((e) => e.label));
    expect(again.marks).toEqual(first.marks);

    // v1 again: compared with v2, mirrored.
    await t.changed(v1);
    const back = t.last().diff!;
    expect(back.loadedAt).toBeGreaterThan(first.loadedAt);
    expect(back.added.map((e) => e.label)).toEqual(['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"']);
    expect(back.removed.map((e) => e.label)).toEqual(['Task "Notify Customer SF"', 'Flow "To Order Auto Approved"']);
  });

  it('keeps the previous version when a reload fails', async () => {
    const t = await opened({ content: v1 });
    await t.changed(v2);
    await t.changed(new Error('Unexpected end of XML'));
    expect(t.posted.at(-1)?.type).toBe('refreshError');
    // A toggle while broken redraws the last good package with the same comparison.
    await t.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: true } });
    expect(summary(t.last())).toMatchObject({ kind: 'previous', counts: { added: 2, removed: 2, changed: 6 } });
  });
});

describe('comparison and the chosen process', () => {
  it('compares the process picked in the toolbar, and says when the base has none like it', async () => {
    const other = { ...v2.processes[0], id: 'other', name: 'Other Process' };
    const twoProcesses: ProcessPackage = { ...v2, processes: [v2.processes[0], other] };
    const t = await opened({ content: twoProcesses, bases: { '/work/v1.zip': v1 } });
    t.pick('/work/v1.zip');
    await t.s.requestCompare();
    expect(t.last().diff!.counts).toEqual({ added: 2, removed: 2, changed: 6 });

    await t.s.handleMessage({ type: 'selectProcess', processId: 'other' });
    expect(t.last().rootProcessId).toBe('other');
    expect(summary(t.last())).toMatchObject({ kind: 'file', note: 'No process in "v1.zip" matches "Other Process".' });
    expect(t.last().diff!.marks).toEqual({});
  });

  it('shows no comparison inside a service diagram', async () => {
    const twx = await syntheticTwxPackage();
    const t = await opened({ content: twx, bases: { '/work/other.twx': await syntheticTwxPackage({ otherIds: true }) } });
    t.pick('/work/other.twx');
    await t.s.requestCompare();
    expect(t.last().diff!.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(t.last().diff!.note).toBeUndefined();

    await t.s.handleMessage({ type: 'openCallee', calleeId: PRICE_SERVICE_ID, path: t.s.currentPath });
    const inside = t.last();
    expect(inside.path).toHaveLength(2);
    expect(inside.diff).toMatchObject({ note: PROCESSES_ONLY_NOTE, marks: {}, added: [], removed: [], changed: [] });
  });
});

describe('exports while comparing', () => {
  it('carry no diff marks: the BPMN, and the XML the webview draws images from', async () => {
    const written: Uint8Array[] = [];
    const exporter: ExportHost = {
      chooseTarget: async ({ format }) => `/work/out.${format}`,
      write: async (_t, _f, bytes) => void written.push(bytes),
      failed: (m) => {
        throw new Error(m);
      },
    };
    const t = await opened({ content: v1, bases: { '/work/v2.zip': v2 }, exporter });
    t.pick('/work/v2.zip');
    await t.s.requestCompare();
    expect(Object.keys(t.last().diff!.marks).length).toBeGreaterThan(0);

    await t.s.handleMessage({ type: 'exportRequest', format: 'bpmn' });
    const bpmn = new TextDecoder().decode(written[0]);
    expect(bpmn).toContain('<bpmn:process');
    expect(bpmn).not.toMatch(/ls-diff/);

    await t.s.handleMessage({ type: 'exportRequest', format: 'svg' });
    const source = t.posted.find((m) => m.type === 'exportSource');
    expect(source).toBeDefined();
    expect(source && 'xml' in source ? source.xml : '').not.toMatch(/ls-diff/);
  });
});

describe('webview: diff marks stay in the on-screen viewer', () => {
  it('draws image exports in a viewer of their own that never gets a marker', () => {
    const root = path.join(__dirname, '..', '..', 'webview');
    for (const file of ['exportImage.ts', 'exportSvg.ts']) {
      expect(readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(/addMarker|ls-diff|ls-selected|\.diff\b/);
    }
    const main = readFileSync(path.join(root, 'main.ts'), 'utf8');
    // Markers are added in two places, both on the on-screen viewer: the diff marks, only with
    // "Highlight changes" on, and the selection, on its selection.changed event.
    expect(main.match(/\.addMarker\(/g)).toHaveLength(2);
    expect(main).toContain('if (!msg.diff || !msg.options.highlightChanges) return;');
    expect(main).toContain('for (const el of e.newSelection ?? []) for (const marker of selectionMarkers(el)) c.addMarker(el, marker);');
  });
});

describe('parseWebviewMessage: comparison', () => {
  it('accepts compareRequest and clearComparison with nothing else in them', () => {
    expect(parseWebviewMessage({ type: 'compareRequest' })).toEqual({ type: 'compareRequest' });
    expect(parseWebviewMessage({ type: 'clearComparison' })).toEqual({ type: 'clearComparison' });
  });

  it('refuses them with any other field', () => {
    for (const value of [
      { type: 'compareRequest', path: '/etc/passwd' },
      { type: 'compareRequest', uri: 'file:///x.zip' },
      { type: 'clearComparison', all: true },
      { type: 'compareRequest', __proto__: { x: 1 }, extra: undefined },
    ]) {
      expect(parseWebviewMessage(value)).toBeUndefined();
    }
  });

  it('needs highlightChanges in setOptions', () => {
    expect(parseWebviewMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: 'no' } })).toBeUndefined();
  });
});
