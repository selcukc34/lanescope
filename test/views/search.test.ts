// The search on the host (ViewerSession): the index of the whole file built
// on the first query and again after a reload or a showScripts change, the
// answer per request id (older answers dropped), the hit limit, and the
// levels a result opens (showLevel: another process, a service on its own).

import { describe, expect, it } from 'vitest';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { MAX_HITS, truncatedNote } from '../../src/search/search';
import { parseWebviewMessage, type HostMessage, type RenderMessage, type SearchResultMessage } from '../../src/views/protocol';
import { PROCESSES_ONLY_NOTE, ViewerSession, type Timers } from '../../src/views/viewerSession';
import { DISCOUNT_SERVICE_ID, PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

/** Fires the debounce timer on demand. */
class ManualTimers implements Timers {
  private readonly pending = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.pending.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    callbacks.forEach((c) => c());
  }
}

/** A session on `load`, ready, with every posted message kept. */
async function session(load: () => Promise<ProcessPackage>, timers?: Timers) {
  const posted: HostMessage[] = [];
  const s = new ViewerSession({ fileName: 'synthetic.twx', load, post: (m) => void posted.push(m), ...(timers ? { timers } : {}) });
  await s.handleMessage({ type: 'ready' });
  const results = () => posted.filter((m): m is SearchResultMessage => m.type === 'searchResult');
  const renders = () => posted.filter((m): m is RenderMessage => m.type === 'render');
  return { s, posted, results, renders, last: () => renders()[renders().length - 1] };
}

/** The synthetic export, counting how often the index lists its services. */
async function countedPackage(): Promise<{ pkg: ProcessPackage; lists: () => number }> {
  const pkg = await syntheticTwxPackage();
  const source = pkg.calleeDiagrams!;
  let lists = 0;
  pkg.calleeDiagrams = {
    name: (id) => source.name(id),
    openability: (id) => source.openability(id),
    read: (id) => source.read(id),
    key: (ref) => source.key(ref),
    list: () => {
      lists++;
      return source.list();
    },
  };
  return { pkg, lists: () => lists };
}

describe('search on the host', () => {
  it('builds the index on the first search only, and again after a reload or a showScripts change', async () => {
    const counted = await countedPackage();
    const timers = new ManualTimers();
    let current = counted.pkg;
    const v = await session(async () => current, timers);
    // Not with the render: the render carries no index.
    expect(counted.lists()).toBe(0);
    expect('search' in v.last()).toBe(false);
    await v.s.handleMessage({ type: 'search', requestId: 1, query: 'Compute', scope: 'file' });
    await v.s.handleMessage({ type: 'search', requestId: 2, query: 'Price', scope: 'file' });
    expect(counted.lists()).toBe(1);
    expect(v.results().map((r) => r.requestId)).toEqual([1, 2]);

    // A reload reads a new package: a new index on the next search.
    const again = await countedPackage();
    current = again.pkg;
    v.s.fileChanged();
    timers.fire();
    await v.s.idle;
    await v.s.handleMessage({ type: 'search', requestId: 3, query: 'Price', scope: 'file' });
    expect(again.lists()).toBe(1);

    // showScripts off: built again, without scripts.
    await v.s.handleMessage({ type: 'search', requestId: 4, query: 'tw.local.total', scope: 'file' });
    expect(v.results()[v.results().length - 1].result.objects.length).toBeGreaterThan(0);
    await v.s.updateSettings({ showScripts: false });
    await v.s.handleMessage({ type: 'search', requestId: 5, query: 'tw.local.total', scope: 'file' });
    expect(again.lists()).toBe(2);
    const off = v.results()[v.results().length - 1];
    expect(off).toMatchObject({ requestId: 5, result: { scriptsOmitted: 1 } });
    // The condition of a flow still matches; the script does not.
    const labels = (m: SearchResultMessage) => m.result.objects.flatMap((o) => o.groups.flatMap((g) => g.hits.map((h) => h.label)));
    expect(labels(v.results()[v.results().length - 2])).toContain('Script');
    expect(labels(off)).not.toContain('Script');
  });

  it('answers only the latest request: an older one still running is dropped', async () => {
    const v = await session(() => syntheticTwxPackage());
    const first = v.s.handleMessage({ type: 'search', requestId: 7, query: 'Price', scope: 'file' });
    const second = v.s.handleMessage({ type: 'search', requestId: 8, query: 'Review', scope: 'file' });
    await Promise.all([first, second]);
    expect(v.results().map((r) => [r.requestId, r.result.query])).toEqual([[8, 'Review']]);
    // An answer is never sent for a request older than one already answered.
    await v.s.handleMessage({ type: 'search', requestId: 6, query: 'Order', scope: 'file' });
    expect(v.results()).toHaveLength(1);
  });

  it(`lists at most ${MAX_HITS} hits, with the note`, async () => {
    const tasks = Array.from({ length: 60 }, (_, i) => `<bpmn:task id="t${i}" name="Task ${i}"><bpmn:documentation>${'needle '.repeat(10)}</bpmn:documentation></bpmn:task>`).join('');
    const bpmn = `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="http://example.com/n"><bpmn:process id="p" name="P">${tasks}</bpmn:process></bpmn:definitions>`;
    const v = await session(() => readProcessPackage({ path: '/work/p.bpmn', format: 'bpmn', bpmnFileName: 'p.bpmn', bpmnText: bpmn, xsdFiles: {} }));
    await v.s.handleMessage({ type: 'search', requestId: 1, query: 'needle', scope: 'file' });
    const { result } = v.results()[0];
    expect(result).toMatchObject({ total: 600, shown: MAX_HITS, truncated: true, groupCount: 50 });
    expect(truncatedNote(result)).toBe('Showing first 500 matches');
  });

  it('refuses malformed search and showLevel messages', () => {
    for (const bad of [
      { type: 'search', requestId: -1, query: 'x', scope: 'file' },
      { type: 'search', requestId: 1.5, query: 'x', scope: 'file' },
      { type: 'search', requestId: 1, query: 'x'.repeat(501), scope: 'file' },
      { type: 'search', requestId: 1, query: 'x', scope: 'other' },
      { type: 'search', requestId: 1, query: 'x', scope: 'file', extra: 1 },
      { type: 'showLevel', below: [] },
      { type: 'showLevel', processId: 'p', serviceId: 's', below: [] },
      { type: 'showLevel', processId: 'p', below: [''] },
      { type: 'showLevel', processId: 'p', below: Array.from({ length: 20 }, (_, i) => `l${i}`) },
    ]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
    expect(parseWebviewMessage({ type: 'showLevel', serviceId: PRICE_SERVICE_ID, below: [] })).toEqual({ type: 'showLevel', serviceId: PRICE_SERVICE_ID, below: [] });
  });
});

describe('levels a search result opens', () => {
  it('draws a service on its own as the root level, and searches it as the shown object', async () => {
    const v = await session(() => syntheticTwxPackage());
    const bpd = v.last();
    await v.s.handleMessage({ type: 'showLevel', serviceId: DISCOUNT_SERVICE_ID, below: [] });
    const msg = v.last();
    expect(msg.serviceRoot).toBe(true);
    expect(msg.path.map((l) => [l.id, l.name])).toEqual([[DISCOUNT_SERVICE_ID, 'Apply Discount']]);
    expect(msg.process.name).toBe('Apply Discount');
    // The picker still holds the chosen process.
    expect(msg.rootProcessId).toBe(bpd.rootProcessId);
    expect(msg.diff).toBeUndefined();
    expect(v.s.currentPath).toEqual([DISCOUNT_SERVICE_ID]);
    // Exported as the service.
    expect((await v.s.exportBpmn()).levelName).toBe('Apply Discount');

    await v.s.handleMessage({ type: 'search', requestId: 1, query: 'Discount', scope: 'shown' });
    expect(v.results()[0].result.objects.map((o) => [o.object.name, o.shown])).toEqual([['Apply Discount', true]]);

    // Picking the process leaves the service.
    await v.s.handleMessage({ type: 'selectProcess', processId: bpd.rootProcessId });
    expect(v.last().serviceRoot).toBeUndefined();
    expect(v.last().path.map((l) => l.name)).toEqual(['Synthetic Order']);
  });

  it('opens a service below its caller, and goes back to the process', async () => {
    const v = await session(() => syntheticTwxPackage());
    const bpd = v.last();
    await v.s.handleMessage({ type: 'showLevel', processId: bpd.rootProcessId, below: [PRICE_SERVICE_ID] });
    expect(v.last().path.map((l) => l.name)).toEqual(['Synthetic Order', 'Price Order']);
    expect(v.last().serviceRoot).toBeUndefined();
    expect(v.last().diff).toBeUndefined();
    await v.s.handleMessage({ type: 'showLevel', processId: bpd.rootProcessId, below: [] });
    expect(v.last().path.map((l) => l.name)).toEqual(['Synthetic Order']);
  });

  it('keeps a service root across a reload; one that cannot be opened falls back with a note', async () => {
    const timers = new ManualTimers();
    const v = await session(() => syntheticTwxPackage(), timers);
    await v.s.handleMessage({ type: 'showLevel', serviceId: PRICE_SERVICE_ID, below: [] });
    v.s.fileChanged();
    timers.fire();
    await v.s.idle;
    expect(v.last()).toMatchObject({ serviceRoot: true, preserveView: true });
    expect(v.last().path.map((l) => l.name)).toEqual(['Price Order']);

    await v.s.handleMessage({ type: 'showLevel', serviceId: '1.00000000-0000-4000-8000-00000000dead', below: [] });
    expect(v.last().serviceRoot).toBeUndefined();
    expect(v.last().path.map((l) => l.name)).toEqual(['Synthetic Order']);
    expect(v.last().note).toMatch(/cannot be opened$/);
  });

  it('a Changes tab while a service is the root says that only processes are compared', async () => {
    const timers = new ManualTimers();
    let n = 0;
    const v = await session(async () => {
      const pkg = await syntheticTwxPackage();
      if (n++ > 0) pkg.processes[0].nodes.find((x) => x.name === 'Approved?')!.name = 'Approved now?';
      return pkg;
    }, timers);
    await v.s.handleMessage({ type: 'showLevel', serviceId: PRICE_SERVICE_ID, below: [] });
    v.s.fileChanged();
    timers.fire();
    await v.s.idle;
    expect(v.last().diff?.note).toBe(PROCESSES_ONLY_NOTE);
  });
});
