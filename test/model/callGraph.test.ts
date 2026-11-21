// The call graph of a package (src/model/callGraph): who calls whom, in
// both directions, cycles and what nothing calls. In-memory packages run
// everywhere; services.twx when it is in test/fixtures/local/.

import { describe, expect, it } from 'vitest';
import { buildCallGraph, refKey, type CallNodeRef } from '../../src/model/callGraph';
import type { CalleeDiagramSource, FlowNode, Process, ProcessPackage, ServiceEntry } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';
import { BPD_ID, DISCOUNT_SERVICE_ID, PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

const keys = (refs: CallNodeRef[]) => refs.map(refKey);

function node(id: string, name: string, calls?: string, parentId?: string): FlowNode {
  return {
    id,
    name,
    kind: calls ? 'callActivity' : 'task',
    originalType: 'task',
    inputs: [],
    outputs: [],
    ...(calls ? { calledElement: { id: calls } } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function process(id: string, name: string, nodes: FlowNode[], originalId?: string): Process {
  return { id, ...(originalId ? { originalId } : {}), name, documentation: '', lanes: [], nodes, flows: [] };
}

/**
 * A package of processes and services held in memory: P calls Q (a linked
 * process) and the service A from inside a sub-process; Q calls P back;
 * A calls B, B calls A; C calls itself; D is called by nothing.
 */
function cyclicPackage(): ProcessPackage {
  const p = process('p', 'P', [node('sub', 'Sub'), node('callQ', 'Call Q', '25.q'), node('callA', 'Call A', '1.a', 'sub')], '25.p');
  p.nodes[0].kind = 'subProcess';
  const q = process('q', 'Q', [node('callP', 'Call P', '25.p'), node('missing', 'Call Missing', '1.zzz')], '25.q');
  const services: Record<string, { entry: ServiceEntry; diagram?: Process }> = {
    '1.a': { entry: { id: '1.a', name: 'A', kind: 'Service flow' }, diagram: process('1.a', 'A', [node('a1', 'Call B', '1.b')]) },
    '1.b': { entry: { id: '1.b', name: 'B', kind: 'Service flow' }, diagram: process('1.b', 'B', [node('b1', 'Call A', '1.a')]) },
    '1.c': { entry: { id: '1.c', name: 'C', kind: 'Service flow' }, diagram: process('1.c', 'C', [node('c1', 'Again', '1.c')]) },
    '1.d': { entry: { id: '1.d', name: 'D', kind: 'External service' } },
  };
  const source: CalleeDiagramSource = {
    name: (id) => services[id]?.entry.name,
    openability: (id) => (services[id]?.diagram ? { openable: true } : { openable: false, reason: 'External service' }),
    read: async (id) => (services[id]?.diagram ? { process: services[id].diagram!, warnings: [] } : undefined),
    list: () => Object.values(services).map((s) => s.entry),
    key: (ref) => ref.slice(ref.lastIndexOf('/') + 1),
  };
  return {
    source: { path: '/work/x.twx', format: 'twx', bpmnFile: '', xsdFiles: [] },
    processes: [p, q],
    dataTypes: [],
    warnings: [],
    calleeDiagrams: source,
  };
}

describe('call graph', () => {
  it('has a node per process and per service, with the level id it opens with', async () => {
    const g = await buildCallGraph(cyclicPackage());
    expect(g.nodes().map((n) => [refKey(n.ref), n.name, n.label, n.levelId, n.hasDiagram])).toEqual([
      ['process:p', 'P', 'Process', '25.p', true],
      ['process:q', 'Q', 'Process', '25.q', true],
      ['service:1.a', 'A', 'Service flow', '1.a', true],
      ['service:1.b', 'B', 'Service flow', '1.b', true],
      ['service:1.c', 'C', 'Service flow', '1.c', true],
      ['service:1.d', 'D', 'External service', '1.d', false],
    ]);
  });

  it('answers in both directions, with the calling activity and the sub-process levels around it', async () => {
    const g = await buildCallGraph(cyclicPackage());
    expect(g.callees({ kind: 'process', id: 'p' })).toEqual([
      { from: { kind: 'process', id: 'p' }, nodeId: 'callQ', name: 'Call Q', levels: [], to: { kind: 'process', id: 'q' } },
      { from: { kind: 'process', id: 'p' }, nodeId: 'callA', name: 'Call A', levels: ['sub:sub'], to: { kind: 'service', id: '1.a' } },
    ]);
    // Activities of processes first, then steps of services.
    expect(g.callers({ kind: 'service', id: '1.a' }).map((s) => `${refKey(s.from)} ${s.name}`)).toEqual(['process:p Call A', 'service:1.b Call A']);
    expect(g.callers({ kind: 'process', id: 'p' }).map((s) => s.nodeId)).toEqual(['callP']);
    // A call to something the package does not hold is no edge.
    expect(g.callees({ kind: 'process', id: 'q' }).map((s) => s.nodeId)).toEqual(['callP']);
    expect(g.node({ kind: 'service', id: '1.zzz' })).toBeUndefined();
  });

  it('finds cycles: through processes, through services, a node calling itself', async () => {
    const g = await buildCallGraph(cyclicPackage());
    expect(g.cycles().map(keys)).toEqual([['process:p', 'process:q'], ['service:1.a', 'service:1.b'], ['service:1.c']]);
  });

  it('lists what nothing calls', async () => {
    const g = await buildCallGraph(cyclicPackage());
    expect(keys(g.uncalled().map((n) => n.ref))).toEqual(['service:1.d']);
  });

  it('follows the chain of the synthetic export: process → service → service, no cycle', async () => {
    const pkg = await syntheticTwxPackage();
    const g = await buildCallGraph(pkg);
    const bpd = pkg.processes[0].id;
    expect(pkg.processes[0].originalId).toBe(BPD_ID);
    expect(g.callees({ kind: 'process', id: bpd }).map((s) => refKey(s.to))).toEqual([`service:${PRICE_SERVICE_ID}`]);
    expect(g.callees({ kind: 'service', id: PRICE_SERVICE_ID }).map((s) => [s.name, refKey(s.to)])).toEqual([['Call Discount', `service:${DISCOUNT_SERVICE_ID}`]]);
    expect(g.callers({ kind: 'service', id: DISCOUNT_SERVICE_ID }).map((s) => refKey(s.from))).toEqual([`service:${PRICE_SERVICE_ID}`]);
    expect(g.cycles()).toEqual([]);
    expect(keys(g.uncalled().map((n) => n.ref))).toEqual([`process:${bpd}`]);
  });

  it('works for Bob output: processes only, no services', async () => {
    const pkg = cyclicPackage();
    delete pkg.calleeDiagrams;
    const g = await buildCallGraph(pkg);
    expect(g.nodes().map((n) => refKey(n.ref))).toEqual(['process:p', 'process:q']);
    expect(g.cycles().map(keys)).toEqual([['process:p', 'process:q']]);
  });
});

describe.skipIf(!hasLocalTwx('services'))('call graph of services.twx', () => {
  it('links BPDs to the linked processes and services they call, and services to the services they call', async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    const g = await buildCallGraph(pkg);
    const byName = (name: string) => g.nodes().find((n) => n.name === name)!.ref;
    expect(g.callers(byName('DemoChildProcess')).map((s) => `${g.node(s.from)!.name} / ${s.name}`)).toEqual([
      'Demo_MainProcess / DemoChildProcess',
      'Demo_MainProcess / DemoChildProcess 1',
    ]);
    expect(g.callers(byName('GetWeather')).every((s) => s.from.kind === 'service')).toBe(true);
    expect(g.callers(byName('GetWeather'))).toHaveLength(5);
    const uncalled = g.uncalled().map((n) => n.name);
    expect(uncalled).toContain('Demo_OrphanWeather');
    expect(uncalled).toContain('Demo_MainProcess');
    expect(uncalled).not.toContain('GetWeather');
    expect(g.cycles()).toEqual([]);
  });
});
