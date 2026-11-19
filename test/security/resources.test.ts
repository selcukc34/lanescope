// SECURITY.md scope 3: crafted .bpmn, .zip or .twx files must not exhaust
// memory or CPU despite the size limits. Covers zip bombs (also ones that
// lie about their sizes), entry counts, unsafe and nested entries, very large
// and cyclic processes, the rich text converter, and live refresh bursts.
//
// Inflation is observed through JSZip's DEFLATE decompressor: a limit that is
// checked "before" means not a single entry was inflated when it fired.

import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layoutProcess, MAX_DIAGRAM_FLOWS, MAX_DIAGRAM_NODES } from '../../src/bpmn/layout';
import { createRouteBudget, routeBetweenPorts } from '../../src/bpmn/orthogonalRouter';
import { readBpmnZip, DEFAULT_LIMITS } from '../../src/input/bpmnInput';
import { declaredEntryCount } from '../../src/input/zip';
import type { Flow, FlowNode, Process, ProcessPackage } from '../../src/model/model';
import { htmlToPlainText } from '../../src/model/plainText';
import { readTwxArchive } from '../../src/twx/twxReader';
import type { HostMessage } from '../../src/views/protocol';
import { ViewerSession, type Timers } from '../../src/views/viewerSession';
import { craftedBpmn, craftedTwx, patchEntry, zeros, zipOf } from './crafted';

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Zip archives

const compressions = createRequire(__filename)('jszip/lib/compressions') as {
  DEFLATE: { uncompressWorker: () => unknown };
};

let inflations: ReturnType<typeof vi.spyOn>;
let loads: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  inflations = vi.spyOn(compressions.DEFLATE, 'uncompressWorker');
  loads = vi.spyOn(JSZip, 'loadAsync');
});
afterEach(() => vi.restoreAllMocks());

/** A Bob package plus `extra` entries. */
const bobZip = (extra: Record<string, string | Uint8Array>) => zipOf({ 'p.bpmn': craftedBpmn(), ...extra });

describe('zip bombs', () => {
  it('the spy sees inflation (control)', async () => {
    await readBpmnZip(await bobZip({}), 'ok.zip');
    expect(inflations).toHaveBeenCalledTimes(1);
  });

  it('Bob .zip: 51 MB that compress to a few KB are refused before anything is inflated', async () => {
    const data = await bobZip({ 'big.xsd': zeros(51 * MB) });
    expect(data.length).toBeLessThan(200 * 1024);
    await expect(readBpmnZip(data, 'bomb.zip')).rejects.toThrow(`larger than ${DEFAULT_LIMITS.maxUncompressedBytes} bytes when uncompressed`);
    expect(inflations).not.toHaveBeenCalled();
  });

  it('Bob .zip: the bomb is refused even when it is an entry the reader would skip', async () => {
    const data = await bobZip({ 'ignored.bin': zeros(51 * MB) });
    await expect(readBpmnZip(data, 'bomb.zip')).rejects.toThrow('when uncompressed');
    expect(inflations).not.toHaveBeenCalled();
  });

  it('Bob .zip: an entry that declares a small size is stopped by the bytes actually inflated', async () => {
    const data = patchEntry(await bobZip({ 'big.xsd': zeros(20 * MB) }), 'big.xsd', { size: 10 });
    await expect(readBpmnZip(data, 'liar.zip', { maxUncompressedBytes: 2 * MB })).rejects.toThrow('larger than 2097152 bytes when uncompressed');
  });

  it('TWX: refused before inflating when the declared total is over the limit', async () => {
    const data = await craftedTwx({ extra: { 'files/big.bin': zeros(20 * MB) } });
    await expect(readTwxArchive(data, 'bomb.twx', { maxTotalUncompressedBytes: 10 * MB })).rejects.toThrow(
      'larger than 10485760 bytes when uncompressed',
    );
    expect(inflations).not.toHaveBeenCalled();
  });

  it('TWX: an object that lies about its size is stopped by the per-entry limit', async () => {
    const id = '25.00000000-0000-4000-8000-0000000000ff';
    const data = patchEntry(await craftedTwx({ extra: { [`objects/${id}.xml`]: zeros(20 * MB) } }), `objects/${id}.xml`, { size: 10 });
    await expect(readTwxArchive(data, 'liar.twx', { maxEntryBytes: 1 * MB })).rejects.toThrow('larger than 1048576 bytes when uncompressed');
  });

  it('TWX: entries the reader does not need are never inflated, whatever their size', async () => {
    const data = await craftedTwx({ extra: { 'files/big.bin': zeros(30 * MB), 'objects/64.big.xml': zeros(30 * MB) } });
    const archive = await readTwxArchive(data, 'ok.twx', { maxTotalUncompressedBytes: 100 * MB, maxEntryBytes: 1 * MB });
    expect(archive.objects.size).toBe(3);
    // package.xml and the three objects.
    expect(inflations).toHaveBeenCalledTimes(4);
  });
});

describe('entry counts', () => {
  it('reads the declared count from the end of the archive', async () => {
    const data = await zipOf(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, 'x'])));
    expect(declaredEntryCount(data)).toBe(7);
    expect(declaredEntryCount(new Uint8Array(100))).toBeUndefined();
  });

  it('Bob .zip: 501 entries are refused before the archive is parsed', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`f${i}.txt`] = 'x';
    const data = await bobZip(files);
    await expect(readBpmnZip(data, 'many.zip')).rejects.toThrow('501 entries; the limit is 500');
    expect(loads).not.toHaveBeenCalled();
    expect(inflations).not.toHaveBeenCalled();
  });

  it('TWX: more entries than the limit are refused before the archive is parsed', async () => {
    const data = await craftedTwx({ extra: { a: 'x', b: 'y' } });
    await expect(readTwxArchive(data, 'many.twx', { maxEntries: 5 })).rejects.toThrow(/^The TWX archive has \d+ entries; the limit is 5\.$/);
    expect(loads).not.toHaveBeenCalled();
  });

  it('an archive whose count field is understated is still checked after parsing', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`f${i}.txt`] = 'x';
    const data = await bobZip(files);
    // The end of central directory record: entries on this disk and in total.
    const view = new DataView(data.buffer, data.byteOffset);
    const eocd = data.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    view.setUint16(eocd + 8, 1, true);
    view.setUint16(eocd + 10, 1, true);
    await expect(readBpmnZip(data, 'liar.zip', { maxEntries: 5 })).rejects.toThrow(/entries; the limit is 5|Not a valid zip file/);
    expect(inflations).not.toHaveBeenCalled();
  });
});

describe('unsafe and nested entries', () => {
  it.each(['../evil.xsd', '../../etc/passwd', '/abs/evil.xsd', 'a/../../evil.xsd', 'C:/evil.xsd', 'a\\..\\..\\evil.xsd'])(
    'Bob .zip: "%s" is refused, nothing inflated',
    async (name) => {
      const data = await bobZip({ [name]: '<x/>' });
      await expect(readBpmnZip(data, 'evil.zip')).rejects.toThrow('has an unsafe path');
      expect(inflations).not.toHaveBeenCalled();
    },
  );

  it('TWX: unsafe entries are skipped with a warning and never inflated', async () => {
    const data = await craftedTwx({ extra: { '../objects/25.evil.xml': '<x/>', '/objects/25.abs.xml': '<x/>' } });
    const archive = await readTwxArchive(data, 'evil.twx');
    expect(archive.warnings.filter((w) => w.includes('unsafe path'))).toHaveLength(2);
    expect([...archive.objects.keys()].some((k) => k.includes('evil') || k.includes('abs'))).toBe(false);
    expect(inflations).toHaveBeenCalledTimes(4);
  });

  it('Bob .zip: a nested zip (even a bomb) is not opened', async () => {
    const inner = await zipOf({ 'inner.bpmn': craftedBpmn(), 'big.bin': zeros(20 * MB) });
    const pkg = await readBpmnZip(await bobZip({ 'inner.zip': inner }), 'nested.zip');
    expect(pkg.bpmnFileName).toBe('p.bpmn');
    expect(inflations).toHaveBeenCalledTimes(1);
  });

  it('TWX: of a packed toolkit only its package.xml is inflated, under the outer budget', async () => {
    const toolkit = await zipOf({
      'META-INF/package.xml': '<p:package xmlns:p="urn:x"><target><project name="Kit"/></target></p:package>',
      'objects/64.big.xml': zeros(30 * MB),
      'toolkits/deeper.zip': await zipOf({ 'x.bin': zeros(30 * MB) }),
    });
    const archive = await readTwxArchive(await craftedTwx({ extra: { 'toolkits/kit.zip': toolkit } }), 'kit.twx', {
      maxTotalUncompressedBytes: 2 * MB,
    });
    const { packages, warnings } = await archive.lazy!.toolkitPackages();
    expect(warnings).toEqual([]);
    expect(packages).toHaveLength(1);
    // package.xml, three objects, the toolkit zip, its package.xml.
    expect(inflations).toHaveBeenCalledTimes(6);
  });

  it('TWX: a packed toolkit with too many entries is skipped before it is parsed', async () => {
    const files: Record<string, string> = { 'META-INF/package.xml': '<p/>' };
    for (let i = 0; i < 20; i++) files[`f${i}`] = 'x';
    const archive = await readTwxArchive(await craftedTwx({ extra: { 'toolkits/kit.zip': await zipOf(files) } }), 'kit.twx', {
      maxEntries: 10,
    });
    const { packages, warnings } = await archive.lazy!.toolkitPackages();
    expect(packages).toEqual([]);
    expect(warnings[0]).toContain('more than 10 entries');
  });

  it('checks the CRC-32 of what it inflates (the archive is no longer checked as a whole when opened)', async () => {
    const bad = patchEntry(await bobZip({}), 'p.bpmn', { crc32: 0x12345678 });
    await expect(readBpmnZip(bad, 'bad.zip')).rejects.toThrow('CRC-32 mismatch');
    const badTwx = patchEntry(await craftedTwx(), 'META-INF/package.xml', { crc32: 1 });
    await expect(readTwxArchive(badTwx, 'bad.twx')).rejects.toThrow('truncated or corrupt');
  });
});

// ---------------------------------------------------------------------------
// Very large and cyclic processes

function node(i: number, bounds: boolean): FlowNode {
  return {
    id: `n${i}`,
    name: `Task ${i}`,
    kind: i % 7 === 0 ? 'exclusiveGateway' : 'task',
    originalType: 'bpmn:Task',
    inputs: [],
    outputs: [],
    ...(bounds ? { bounds: { x: (i % 50) * 150, y: Math.floor(i / 50) * 120, width: 100, height: 80 } } : {}),
  };
}

/**
 * n nodes and f flows: a ring (every node a cycle), self-loops, back edges
 * and long cross edges; with ports, every flow goes through the router.
 */
function bigProcess(n: number, f: number, opts: { bounds?: boolean; ports?: boolean } = {}): Process {
  const nodes = Array.from({ length: n }, (_, i) => node(i, opts.bounds ?? false));
  const flows: Flow[] = Array.from({ length: f }, (_, i) => {
    const source = i % n;
    const kind = Math.floor(i / n);
    const target = kind === 0 ? (source + 1) % n : kind === 1 ? source : kind === 2 ? (source + n - 3) % n : (source * 7919 + kind) % n;
    return {
      id: `f${i}`,
      name: '',
      sourceId: `n${source}`,
      targetId: `n${target}`,
      isDefault: false,
      ...(opts.ports ? { sourcePort: { side: 'bottom' as const, offset: 0.5 }, targetPort: { side: 'top' as const, offset: 0.5 } } : {}),
    };
  });
  return { id: 'big', name: 'Big', documentation: '', nodes, flows, lanes: [] };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

describe('large and cyclic processes', () => {
  it(`lays out ${MAX_DIAGRAM_NODES} nodes and ${MAX_DIAGRAM_FLOWS} crossing flows (with cycles) with ELK in reasonable time`, async () => {
    const process = bigProcess(MAX_DIAGRAM_NODES, 0);
    const n = MAX_DIAGRAM_NODES;
    // Long edges in every direction: many cycles, every node four times a source.
    process.flows = Array.from({ length: MAX_DIAGRAM_FLOWS }, (_, i) => ({
      id: `f${i}`, name: '', sourceId: `n${i % n}`, targetId: `n${(i * 7 + 3) % n}`, isDefault: false,
    }));
    const { value, ms } = await timed(() => layoutProcess(process));
    expect(value.shapes.size).toBe(MAX_DIAGRAM_NODES);
    expect(value.edges.size).toBe(MAX_DIAGRAM_FLOWS);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);

  it('a densely cyclic graph that keeps ELK busy is stopped after the time limit, with a readable error', async () => {
    const { value, ms } = await timed(() =>
      layoutProcess(bigProcess(500, 2000), { elkTimeoutMs: 2_000 }).catch((e: Error) => e),
    );
    expect(value).toBeInstanceOf(Error);
    // ELK either overflows its stack or runs past the limit; both end the same way.
    expect(String(value)).toMatch(/"Big" \(500 nodes, 2000 flows\) (could not be laid out within 2 seconds|is too large or too densely connected to lay out)\./);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  it('ELK runs beside the extension host: its thread keeps running while a layout is busy', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const start = performance.now();
    await layoutProcess(bigProcess(500, 2000), { elkTimeoutMs: 1_500 }).catch(() => undefined);
    clearInterval(timer);
    const elapsed = performance.now() - start;
    // On a blocked thread the interval would not fire at all until the layout ends.
    expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
  }, 30_000);

  it('lays out again after a layout was stopped (a new worker), cycles and self-loops included', async () => {
    await layoutProcess(bigProcess(500, 2000), { elkTimeoutMs: 500 }).catch(() => undefined);
    const value = await layoutProcess(bigProcess(60, 240));
    expect(value.edges.size).toBe(240);
  }, 30_000);

  it('routes around nodes within a budget: a huge diagram with ports ends quickly and says so', async () => {
    const { value, ms } = await timed(() => layoutProcess(bigProcess(MAX_DIAGRAM_NODES, MAX_DIAGRAM_FLOWS, { bounds: true, ports: true })));
    expect(value.edges.size).toBe(MAX_DIAGRAM_FLOWS);
    for (const points of value.edges.values()) expect(points.length).toBeGreaterThanOrEqual(2);
    expect(value.warnings.join('\n')).toMatch(/too large to route every flow around the nodes; \d+ flow\(s\) are drawn with simple routes/);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);

  it('routes a small cyclic diagram with ports fully (the budget is not hit)', async () => {
    const value = await layoutProcess(bigProcess(60, 240, { bounds: true, ports: true }));
    expect(value.edges.size).toBe(240);
    expect(value.warnings.join('\n')).not.toContain('too large to route');
  });

  it('a spent budget makes the router give up at once', () => {
    const a = { x: 0, y: 0, width: 100, height: 80 };
    const b = { x: 0, y: 300, width: 100, height: 80 };
    const ports = [{ side: 'bottom', offset: 0.5 }, { side: 'top', offset: 0.5 }] as const;
    expect(routeBetweenPorts(a, ports[0], b, ports[1], [a, b], createRouteBudget(0))).toBeUndefined();
    expect(routeBetweenPorts(a, ports[0], b, ports[1], [a, b], createRouteBudget())).toBeDefined();
  });

  it(`refuses more than ${MAX_DIAGRAM_NODES} nodes or ${MAX_DIAGRAM_FLOWS} flows with a readable error, at once`, async () => {
    const tooMany = await timed(() => layoutProcess(bigProcess(MAX_DIAGRAM_NODES + 1, 0)).catch((e: Error) => e));
    expect(String(tooMany.value)).toContain(`"Big" has ${MAX_DIAGRAM_NODES + 1} nodes to draw; Lanescope draws diagrams of up to ${MAX_DIAGRAM_NODES} nodes.`);
    expect(tooMany.ms).toBeLessThan(1_000);
    const tooManyFlows = await layoutProcess(bigProcess(100, MAX_DIAGRAM_FLOWS + 1)).catch((e: Error) => e);
    expect(String(tooManyFlows)).toContain(`has ${MAX_DIAGRAM_FLOWS + 1} sequence flows to draw`);
  });

  it('the viewer shows that error instead of a diagram', async () => {
    const pkg: ProcessPackage = {
      source: { path: '/x/big.bpmn', format: 'bpmn', bpmnFile: 'big.bpmn', xsdFiles: [] },
      processes: [bigProcess(MAX_DIAGRAM_NODES + 1, 0)],
      dataTypes: [],
      warnings: [],
    };
    const posted: HostMessage[] = [];
    const session = new ViewerSession({ fileName: 'big.bpmn', load: async () => pkg, post: (m) => posted.push(m) });
    await session.handleMessage({ type: 'ready' });
    expect(posted).toEqual([
      { type: 'error', title: 'Cannot show big.bpmn', message: expect.stringContaining('Lanescope draws diagrams of up to') },
    ]);
  });

  it('nodes hidden inside deeply nested sub-processes do not count, and are handled in linear time', async () => {
    const depth = 50_000;
    const nodes: FlowNode[] = [node(0, false)];
    nodes[0].kind = 'subProcess';
    for (let i = 1; i <= depth; i++) nodes.push({ ...node(i, false), kind: 'subProcess', parentId: `n${i - 1}` });
    const { value, ms } = await timed(() => layoutProcess({ id: 'deep', name: 'Deep', documentation: '', nodes, flows: [], lanes: [] }));
    expect(value.hiddenNodeIds.size).toBe(depth);
    expect(value.warnings[0]).toContain(`its ${depth} inner node(s) are not shown`);
    expect(ms).toBeLessThan(5_000);
  });

  it('a parent cycle among nested nodes ends', async () => {
    const nodes = [0, 1, 2].map((i) => ({ ...node(i, false), parentId: `n${(i + 1) % 3}` }));
    const value = await layoutProcess({ id: 'loop', name: 'Loop', documentation: '', nodes, flows: [], lanes: [] });
    expect(value.hiddenNodeIds.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Rich text conversion

describe('htmlToPlainText runs in linear time on hostile input', () => {
  const SIZE = 2 * MB;
  it.each([
    ['unclosed script tags', '<script>'],
    ['closed script blocks', '<script>a</script>b'],
    ['tags without ">"', '<a'],
    ['unclosed quotes', '<a "'],
    ['unclosed declarations', '<!x'],
    ['unclosed comments', '<!--'],
    ['entity-like runs', '&aaaaaaaaaaaaaaaaaaaa'],
    ['list items without ">"', '<li'],
  ])('%s', (_name, unit) => {
    const input = `<p>x</p>${unit.repeat(Math.ceil(SIZE / unit.length))}`;
    const start = performance.now();
    htmlToPlainText(input);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Live refresh

/** Debounce timer under the test's control. */
class ManualTimers implements Timers {
  time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, t] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.time) continue;
      this.timers.delete(id);
      t.callback();
    }
  }
}

describe('live refresh under a storm of file changes', () => {
  const pkg = (): ProcessPackage => ({
    source: { path: '/x/p.bpmn', format: 'bpmn', bpmnFile: 'p.bpmn', xsdFiles: [] },
    processes: [bigProcess(3, 2)],
    dataTypes: [],
    warnings: [],
  });

  /** A session whose reads finish only when the test says so. */
  function slowSession() {
    const timers = new ManualTimers();
    const pending: Array<() => void> = [];
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const session = new ViewerSession({
      fileName: 'p.bpmn',
      debounceMs: 300,
      timers,
      post: () => undefined,
      load: () => {
        reads++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<ProcessPackage>((resolve) =>
          pending.push(() => {
            inFlight--;
            resolve(pkg());
          }),
        );
      },
    });
    const finishReads = async () => {
      while (pending.length > 0) {
        pending.shift()!();
        await session.idle;
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    return { session, timers, finishReads, reads: () => reads, maxInFlight: () => maxInFlight };
  }

  it('1,000 changes a millisecond apart give one read', async () => {
    const s = slowSession();
    void s.session.handleMessage({ type: 'ready' });
    await s.finishReads();
    expect(s.reads()).toBe(1);
    for (let i = 0; i < 1000; i++) {
      s.session.fileChanged();
      s.timers.advance(1);
    }
    expect(s.reads()).toBe(1);
    s.timers.advance(300);
    await s.finishReads();
    expect(s.reads()).toBe(2);
  });

  it('changes that keep coming while a slow read runs give one more read, never parallel ones', async () => {
    const s = slowSession();
    void s.session.handleMessage({ type: 'ready' });
    await s.finishReads();
    // A change every 400 ms (past the debounce) for 20 s while each read hangs.
    for (let i = 0; i < 50; i++) {
      s.session.fileChanged();
      s.timers.advance(400);
    }
    expect(s.reads()).toBe(2);
    await s.finishReads();
    expect(s.reads()).toBe(3);
    expect(s.maxInFlight()).toBe(1);
  });
});
