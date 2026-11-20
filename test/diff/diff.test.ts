// The comparison engine (src/diff): Bob's order-delivery process against
// its v2 (../bobV2), the three node matching passes, what is not compared,
// and that scripts and mapped values never reach the result.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import { diffProcess, matchProcess, type DiffEntry, type ProcessDiff } from '../../src/diff/diff';
import type { Flow, FlowNode, Lane, Process, ProcessPackage } from '../../src/model/model';
import { AUTO_APPROVE_CONDITION_V2, NOTIFY_FLOW_ID, NOTIFY_TASK_ID, V1_ZIP, V2_ZIP, orderDeliveryV2 } from '../bobV2';
import { syntheticTwxPackage } from '../syntheticTwx';

let v1: ProcessPackage;
let v2: ProcessPackage;

beforeAll(async () => {
  v1 = await readProcessPackage(await readBpmnPackage(V1_ZIP));
  v2 = await readProcessPackage(await readBpmnPackage(V2_ZIP));
});

const diff = (base: ProcessPackage, current: ProcessPackage): ProcessDiff =>
  diffProcess(base.processes[0], current.processes[0], base.dataTypes, current.dataTypes);

/** "label: change; change" per entry, for readable expectations. */
const lines = (entries: DiffEntry[]) => entries.map((e) => (e.changes.length > 0 ? `${e.label}: ${e.changes.join('; ')}` : e.label));

const AUTO_APPROVE_V1 = 'tw.local.order.route == "AUTO_APPROVE"';

describe('the v2 fixture', () => {
  it('holds exactly what the edits of test/bobV2.ts give', async () => {
    const zip = await import('jszip').then((m) => m.default.loadAsync(readFileSync(V2_ZIP)));
    const expected = await orderDeliveryV2(readFileSync(V1_ZIP));
    expect(await zip.file('order-delivery-process.bpmn')!.async('string')).toBe(expected.bpmn);
    expect(await zip.file('order-delivery-process.xsd')!.async('string')).toBe(expected.xsd);
    expect(Object.keys(zip.files).sort()).toEqual(['order-delivery-process.bpmn', 'order-delivery-process.xsd']);
  });
});

describe('diffProcess: order-delivery v1 and v2', () => {
  it('finds no change between a version and itself', () => {
    const d = diff(v1, v1);
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(d.marks).toEqual({});
    expect(d.nodeMatches).toEqual({ byId: v1.processes[0].nodes.length, byName: 0, byNeighbors: 0 });
  });

  it('lists what v2 adds, removes and changes', () => {
    const d = diff(v1, v2);
    expect(lines(d.added)).toEqual(['Task "Notify Customer SF"', 'Flow "To Order Auto Approved"']);
    expect(d.added.map((e) => e.currentId)).toEqual([NOTIFY_TASK_ID, NOTIFY_FLOW_ID]);
    expect(lines(d.removed)).toEqual(['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"']);
    expect(lines(d.changed)).toEqual([
      'User task "Manager Review": Name: "Manager Approval" → "Manager Review"',
      'User task "Handle Exception": Lane: "Operations Team" → "Order Manager"',
      'Flow "Valid": Target: "Lookup Country Info SF" → "Determine Order Route SF"',
      `Flow "AUTO_APPROVE": Condition: "${AUTO_APPROVE_V1}" → "${AUTO_APPROVE_CONDITION_V2}"`,
      'Flow "To Notify Customer SF": Name: "To Order Auto Approved" → "To Notify Customer SF"; Target: "Order Auto Approved" → "Notify Customer SF"',
      'Business object "OrderRequest": Field added: priority (string); Field removed: countryRegion',
    ]);
    expect(d.counts).toEqual({ added: 2, removed: 2, changed: 6 });
    // Bob keeps its ids: every node pairs by id.
    expect(d.nodeMatches).toEqual({ byId: v1.processes[0].nodes.length - 1, byName: 0, byNeighbors: 0 });
  });

  it('keeps the id of the retargeted flow in v2 and pairs it by that id: changed, not removed and added', () => {
    const RETARGETED = 'bpmnid-de6141ef-60c0-5e7f-b5b5-0b0334d0ae6e';
    const before = v1.processes[0].flows.find((f) => f.id === RETARGETED)!;
    const after = v2.processes[0].flows.find((f) => f.id === RETARGETED)!;
    expect([before.name, after.name]).toEqual(['To Order Auto Approved', 'To Notify Customer SF']);
    expect(after.targetId).toBe(NOTIFY_TASK_ID);
    for (const d of [diff(v1, v2), diff(v2, v1)]) {
      const entry = d.changed.find((e) => e.currentId === RETARGETED);
      expect(entry?.baseId).toBe(RETARGETED);
      expect([...d.added, ...d.removed].some((e) => e.currentId === RETARGETED || e.baseId === RETARGETED)).toBe(false);
    }
  });

  it('marks the added and changed nodes and flows of the current version only', () => {
    const d = diff(v1, v2);
    const marked = Object.entries(d.marks).map(([id, mark]) => `${mark} ${nameOf(v2.processes[0], id)}`);
    expect(marked.sort()).toEqual(
      [
        'added Notify Customer SF',
        'added To Order Auto Approved',
        'changed AUTO_APPROVE',
        'changed Handle Exception',
        'changed Manager Review',
        'changed To Notify Customer SF',
        'changed Valid',
      ].sort(),
    );
  });

  it('gives the mirrored result the other way round', () => {
    const d = diff(v2, v1);
    expect(lines(d.added)).toEqual(['Task "Lookup Country Info SF"', 'Flow "To Determine Order Route SF"']);
    expect(lines(d.removed)).toEqual(['Task "Notify Customer SF"', 'Flow "To Order Auto Approved"']);
    expect(lines(d.changed)).toEqual([
      'User task "Manager Approval": Name: "Manager Review" → "Manager Approval"',
      'User task "Handle Exception": Lane: "Order Manager" → "Operations Team"',
      'Flow "Valid": Target: "Determine Order Route SF" → "Lookup Country Info SF"',
      `Flow "AUTO_APPROVE": Condition: "${AUTO_APPROVE_CONDITION_V2}" → "${AUTO_APPROVE_V1}"`,
      'Flow "To Order Auto Approved": Name: "To Notify Customer SF" → "To Order Auto Approved"; Target: "Notify Customer SF" → "Order Auto Approved"',
      'Business object "OrderRequest": Field added: countryRegion (string); Field removed: priority',
    ]);
  });
});

describe('diffProcess: what is not a change', () => {
  it('ignores positions, sizes, ports and lane bands', () => {
    const p = v1.processes[0];
    const moved: Process = {
      ...p,
      nodes: p.nodes.map((n, i) => ({ ...n, bounds: { x: i * 10, y: 5, width: 100, height: 80 } })),
      flows: p.flows.map((f) => ({ ...f, sourcePort: { side: 'right', offset: 0.5 }, targetPort: { side: 'left', offset: 0.2 } })),
      lanes: p.lanes.map((l, i) => ({ ...l, bounds: { x: 0, y: i * 200, width: 900, height: 200 } })),
    };
    expect(diffProcess(p, moved, v1.dataTypes, v1.dataTypes).counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('cuts long documentation and conditions to 80 characters', () => {
    const p = v1.processes[0];
    const longer = { ...p, nodes: p.nodes.map((n, i) => (i === 1 ? { ...n, documentation: 'x'.repeat(200) } : n)) };
    const [entry] = diffProcess(p, longer, [], []).changed;
    const [line] = entry.changes;
    expect(line).toMatch(/^Documentation: ".{79}…" → "x{79}…"$/);
  });
});

describe('diffProcess: scripts and mappings', () => {
  const SECRET = 'tw.local.secretToken = "s3cr3t-value";';
  const MAPPED = 'tw.local.customer.privateNote';

  function scripted(script: string, value: string): Process {
    const node: FlowNode = {
      id: 'script',
      name: 'Compute',
      kind: 'scriptTask',
      originalType: 'bpmn:ScriptTask',
      inputs: [],
      outputs: [],
      script: { language: 'text/x-javascript', text: script },
      inputMappings: [
        { parameter: 'orderId', value, mapped: true, literal: false },
        { parameter: 'amount', value: 'tw.local.amount', mapped: true, literal: false },
      ],
    };
    return { id: 'p', name: 'P', documentation: '', lanes: [], nodes: [node], flows: [] };
  }

  it('says only that a script changed, never what it holds', () => {
    const d = diffProcess(scripted('tw.local.x = 1;', 'tw.local.orderId'), scripted(SECRET, MAPPED), [], []);
    expect(d.changed[0].changes).toEqual(['Script changed', 'Input mappings changed: orderId']);
    const json = JSON.stringify(d);
    expect(json).not.toContain('secretToken');
    expect(json).not.toContain('s3cr3t');
    expect(json).not.toContain('tw.local.x');
    expect(json).not.toContain(MAPPED);
    expect(json).not.toContain('tw.local.orderId');
  });
});

describe('diffProcess: node matching passes', () => {
  // start -> A -> B -> end, in one lane.
  function chain(ids: { a: string; b: string }, names: { a: string; b: string }, extra: FlowNode[] = []): Process {
    const lane: Lane = { id: 'lane', name: 'System', nodeIds: [] };
    const node = (id: string, name: string, kind: FlowNode['kind']): FlowNode => ({ id, name, kind, originalType: '', inputs: [], outputs: [], laneId: 'lane' });
    const flow = (id: string, sourceId: string, targetId: string): Flow => ({ id, name: '', sourceId, targetId, isDefault: false });
    return {
      id: 'p',
      name: 'P',
      documentation: '',
      lanes: [lane],
      nodes: [node('start', 'Start', 'startEvent'), node(ids.a, names.a, 'task'), node(ids.b, names.b, 'userTask'), node('end', 'End', 'endEvent'), ...extra],
      flows: [flow('f1', 'start', ids.a), flow('f2', ids.a, ids.b), flow('f3', ids.b, 'end')],
    };
  }

  it('b: pairs a node whose id changed by its name', () => {
    const d = diffProcess(chain({ a: 'a', b: 'b' }, { a: 'Check', b: 'Approve' }), chain({ a: 'a2', b: 'b' }, { a: 'Check', b: 'Approve' }), [], []);
    expect(d.nodeMatches).toEqual({ byId: 3, byName: 1, byNeighbors: 0 });
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('c: pairs a node whose id and name changed by its neighbours, as a rename', () => {
    const d = diffProcess(chain({ a: 'a', b: 'b' }, { a: 'Check', b: 'Approve' }), chain({ a: 'a2', b: 'b' }, { a: 'Verify', b: 'Approve' }), [], []);
    expect(d.nodeMatches).toEqual({ byId: 3, byName: 0, byNeighbors: 1 });
    expect(lines(d.changed)).toEqual(['Task "Verify": Name: "Check" → "Verify"']);
    expect(d.marks).toEqual({ a2: 'changed' });
  });

  it('pairs nothing when two nodes share a name and their neighbours: removed and added instead', () => {
    // Two "Check" tasks side by side between Start and Approve, both with new ids.
    const twins = (a: string, x: string, flowPrefix: string): Process => {
      const p = chain({ a, b: 'b' }, { a: 'Check', b: 'Approve' }, [{ id: x, name: 'Check', kind: 'task', originalType: '', inputs: [], outputs: [], laneId: 'lane' }]);
      const flow = (id: string, sourceId: string, targetId: string): Flow => ({ id: `${flowPrefix}${id}`, name: '', sourceId, targetId, isDefault: false });
      return { ...p, flows: [flow('1', 'start', a), flow('2', a, 'b'), p.flows[2], flow('3', 'start', x), flow('4', x, 'b')] };
    };
    const d = diffProcess(twins('a', 'x', 'base-'), twins('a2', 'x2', 'current-'), [], []);
    expect(d.nodeMatches).toEqual({ byId: 3, byName: 0, byNeighbors: 0 });
    expect(lines(d.removed.filter((e) => e.elementType === 'node'))).toEqual(['Task "Check"', 'Task "Check"']);
    expect(lines(d.added.filter((e) => e.elementType === 'node'))).toEqual(['Task "Check"', 'Task "Check"']);
    expect(d.counts).toEqual({ added: 6, removed: 6, changed: 0 });
  });

  it('does not pair across kind families, and reports a change of kind within one', () => {
    const base = chain({ a: 'a', b: 'b' }, { a: 'Check', b: 'Approve' });
    const gateway = { ...base, nodes: base.nodes.map((n) => (n.id === 'a' ? { ...n, kind: 'exclusiveGateway' as const } : n)) };
    expect(diffProcess(base, gateway, [], []).counts.added).toBeGreaterThan(0);
    const user = { ...base, nodes: base.nodes.map((n) => (n.id === 'a' ? { ...n, kind: 'userTask' as const } : n)) };
    expect(lines(diffProcess(base, user, [], []).changed)).toEqual(['User task "Check": Type: Task → User task']);
  });

  it('pairs flows whose ids changed by their paired source and target', () => {
    const base = chain({ a: 'a', b: 'b' }, { a: 'Check', b: 'Approve' });
    const current = { ...base, flows: base.flows.map((f) => ({ ...f, id: `${f.id}-new` })) };
    const d = diffProcess(base, current, [], []);
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe('matchProcess', () => {
  it('matches by id, then by name, then the only process on both sides', async () => {
    const p = v1.processes[0];
    expect(matchProcess(v2, p, v1)).toBe(v2.processes[0]);
    const other: ProcessPackage = { ...v2, processes: [{ ...v2.processes[0], id: 'other-id' }] };
    expect(matchProcess(other, p, v1)).toBe(other.processes[0]);
    const renamed: ProcessPackage = { ...v2, processes: [{ ...v2.processes[0], id: 'other-id', name: 'Other' }] };
    expect(matchProcess(renamed, p, v1)).toBe(renamed.processes[0]);
    const two: ProcessPackage = { ...renamed, processes: [renamed.processes[0], { ...renamed.processes[0], id: 'third' }] };
    expect(matchProcess(two, p, v1)).toBeUndefined();
  });
});

describe('synthetic TWX: the same process with other ids', () => {
  it('pairs everything by name and finds no change', async () => {
    const a = await syntheticTwxPackage();
    const b = await syntheticTwxPackage({ otherIds: true });
    const base = a.processes[0];
    const current = b.processes[0];
    expect(current.id).not.toBe(base.id);
    expect(current.nodes.map((n) => n.id).filter((id) => base.nodes.some((n) => n.id === id))).toEqual([]);
    const matched = matchProcess(a, current, b);
    expect(matched).toBe(base);
    const d = diffProcess(matched!, current, a.dataTypes, b.dataTypes);
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(d.nodeMatches).toEqual({ byId: 0, byName: base.nodes.length, byNeighbors: 0 });
  });
});

function nameOf(p: Process, id: string): string {
  return p.nodes.find((n) => n.id === id)?.name ?? p.flows.find((f) => f.id === id)?.name ?? p.lanes.find((l) => l.id === id)?.name ?? id;
}
