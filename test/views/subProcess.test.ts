// Sub-process drill-down: the diagram of a sub-process's inside
// (src/model/subProcess), its roll-up in the comparison, and the viewer
// session opening it as a level of its own for Bob output and TWX exports.

import { describe, expect, it } from 'vitest';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import { diffProcess } from '../../src/diff/diff';
import type { Flow, FlowNode, Process, ProcessPackage } from '../../src/model/model';
import { childCounts, findSubProcess, subProcessDiagram, subProcessLevelId } from '../../src/model/subProcess';
import type { HostMessage, NodeDetails, RenderMessage } from '../../src/views/protocol';
import { PROCESSES_ONLY_NOTE, ViewerSession } from '../../src/views/viewerSession';
import { readTwxPackage } from '../../src/twx/twxImport';
import { changeGroups } from '../../webview/panelText';
import { hasLocalTwx, localTwx } from '../localFixtures';
import { CHECK_STOCK_ID, ON_ERROR_ID, syntheticTwxPackage } from '../syntheticTwx';

const node = (id: string, kind: FlowNode['kind'], extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  name: id.toUpperCase(),
  kind,
  originalType: kind,
  inputs: [],
  outputs: [],
  ...extra,
});
const flow = (id: string, sourceId: string, targetId: string): Flow => ({ id, name: '', sourceId, targetId, isDefault: false });

/**
 *   start -> S -> end            (lane L)
 *   S:  a (boundary bnd) -> b -> N        and a flow from a to the outer end
 *   N:  x
 */
function nested(): Process {
  return {
    id: 'p',
    name: 'P',
    documentation: '',
    source: { kind: 'bpd' },
    lanes: [{ id: 'L', name: 'Lane', nodeIds: ['start', 'S', 'end'] }],
    nodes: [
      node('start', 'startEvent', { laneId: 'L' }),
      node('S', 'subProcess', { laneId: 'L', documentation: 'Inside S', originalId: 'S-original' }),
      node('a', 'task', { parentId: 'S', laneId: 'L' }),
      node('bnd', 'intermediateEvent', { parentId: 'S', attachedToId: 'a' }),
      node('b', 'task', { parentId: 'S' }),
      node('N', 'subProcess', { parentId: 'S' }),
      node('x', 'task', { parentId: 'N' }),
      node('end', 'endEvent', { laneId: 'L' }),
      node('E', 'subProcess', { triggeredByEvent: true }),
    ],
    flows: [flow('f1', 'start', 'S'), flow('f2', 'S', 'end'), flow('fa', 'a', 'b'), flow('fb', 'b', 'N'), flow('cross', 'a', 'end')],
  };
}

describe('subProcessDiagram', () => {
  it('takes every node inside; direct children go to the top, deeper ones keep their parent', () => {
    const d = subProcessDiagram(nested(), 'sub:S-original')!;
    expect(d.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ['a', undefined],
      ['bnd', undefined],
      ['b', undefined],
      ['N', undefined],
      ['x', 'N'],
    ]);
    expect(d).toMatchObject({ id: 'S', originalId: 'S-original', name: 'S', documentation: 'Inside S', lanes: [], source: { kind: 'bpd' } });
    expect(d.subProcess).toEqual({ levelId: 'sub:S-original', eventSubProcess: false });
    // No lanes at this level.
    expect(d.nodes.some((n) => n.laneId !== undefined)).toBe(false);
  });

  it('keeps only the flows between nodes inside', () => {
    expect(subProcessDiagram(nested(), 'sub:S-original')!.flows.map((f) => f.id)).toEqual(['fa', 'fb']);
  });

  it('opens a nested sub-process from the diagram above it', () => {
    const outer = subProcessDiagram(nested(), 'sub:S-original')!;
    const inner = subProcessDiagram(outer, 'sub:N')!;
    expect(inner.nodes.map((n) => [n.id, n.parentId])).toEqual([['x', undefined]]);
    expect(inner.name).toBe('N');
  });

  it('brings a boundary event along with its host, whatever parent it was read with', () => {
    const p = nested();
    p.nodes.find((n) => n.id === 'bnd')!.parentId = undefined;
    const d = subProcessDiagram(p, 'sub:S-original')!;
    expect(d.nodes.find((n) => n.id === 'bnd')).toMatchObject({ attachedToId: 'a' });
    expect(d.nodes.find((n) => n.id === 'bnd')!.parentId).toBeUndefined();
    expect(childCounts(p).get('S')).toBe(4);
  });

  it('never modifies the process it reads', () => {
    const p = nested();
    const before = structuredClone(p);
    const d = subProcessDiagram(p, 'sub:S-original')!;
    d.nodes[0].name = 'changed';
    d.flows[0].name = 'changed';
    expect(p).toEqual(before);
  });

  it('is undefined for an empty sub-process, a node that is not a sub-process and an unknown id', () => {
    const p = nested();
    expect(subProcessDiagram(p, 'sub:E')).toBeUndefined();
    expect(subProcessDiagram(p, 'sub:a')).toBeUndefined();
    expect(subProcessDiagram(p, 'sub:missing')).toBeUndefined();
    expect(findSubProcess(p, 'sub:S-original')?.id).toBe('S');
  });

  it('marks an event sub-process', () => {
    const p = nested();
    p.nodes.push(node('e1', 'startEvent', { parentId: 'E' }));
    expect(subProcessDiagram(p, 'sub:E')!.subProcess).toEqual({ levelId: 'sub:E', eventSubProcess: true });
  });

  it('counts what each sub-process draws at its top', () => {
    expect(Object.fromEntries(childCounts(nested()))).toEqual({ S: 4, N: 1 });
  });
});

describe('comparison of a process with sub-processes', () => {
  it('marks a sub-process with changes inside it as changed, with the number of inner changes', () => {
    const base = nested();
    const current = nested();
    current.nodes.find((n) => n.id === 'a')!.name = 'A renamed';
    current.nodes = current.nodes.filter((n) => n.id !== 'b');
    current.flows = current.flows.filter((f) => f.id !== 'fa' && f.id !== 'fb');
    current.nodes.push(node('y', 'task', { parentId: 'N' }));
    const d = diffProcess(base, current, [], []);

    // In S: a changed, b removed, fa and fb removed, y added (inside N, inside S).
    const s = d.changed.find((e) => e.currentId === 'S')!;
    expect(s.changes).toEqual(['Inner changes: 5']);
    expect(d.changed.find((e) => e.currentId === 'N')!.changes).toEqual(['Inner changes: 1']);
    expect(d.marks).toMatchObject({ S: 'changed', N: 'changed', a: 'changed', y: 'added' });
    expect(d.enclosing).toEqual({ a: ['S'], y: ['N', 'S'] });
    // Node entries stay in model order.
    expect(d.changed.map((e) => e.currentId)).toEqual(['S', 'a', 'N']);
    expect(d.counts.changed).toBe(3);
  });

  it('adds the inner changes to the entry of a sub-process that changed itself', () => {
    const base = nested();
    const current = nested();
    current.nodes.find((n) => n.id === 'S')!.documentation = 'New text';
    current.nodes.find((n) => n.id === 'x')!.name = 'X2';
    const d = diffProcess(base, current, [], []);
    expect(d.changed.find((e) => e.currentId === 'S')!.changes).toEqual([expect.stringMatching(/^Documentation/), 'Inner changes: 1']);
  });

  it('says nothing more about an added sub-process, or a process without sub-processes', () => {
    const base = nested();
    base.nodes = base.nodes.filter((n) => n.id !== 'N' && n.id !== 'x');
    base.flows = base.flows.filter((f) => f.id !== 'fb');
    const d = diffProcess(base, nested(), [], []);
    expect(d.marks.N).toBe('added');
    expect(d.changed.find((e) => e.currentId === 'N')).toBeUndefined();
    expect(d.changed.find((e) => e.currentId === 'S')!.changes).toEqual(['Inner changes: 3']);

    const flat = nested();
    flat.nodes = flat.nodes.filter((n) => n.parentId === undefined);
    expect(diffProcess(flat, flat, [], []).enclosing).toEqual({});
  });

  it('links a row to the sub-process that holds its element when the element is not drawn', () => {
    const entry = { elementType: 'node' as const, currentId: 'y', label: 'Task "Y"', changes: [] };
    const drawnAtRoot = { S: {} };
    expect(changeGroups({ added: [entry], changed: [], removed: [], enclosing: { y: ['N', 'S'] } }, drawnAtRoot).added[0].revealId).toBe('y');
    expect(changeGroups({ added: [entry], changed: [], removed: [] }, drawnAtRoot).added[0].revealId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Viewer session

function session(load: () => Promise<ProcessPackage>, fileName = 'process.bpmn') {
  const posted: HostMessage[] = [];
  const s = new ViewerSession({ fileName, load, post: (m) => posted.push(m) });
  const renders = () => posted.filter((m): m is RenderMessage => m.type === 'render');
  const last = () => renders()[renders().length - 1];
  const open = async (calleeId: string, path = last().path.map((l) => l.id)) => {
    await s.handleMessage({ type: 'openCallee', calleeId, path });
    return last();
  };
  return { s, posted, last, open };
}

/** The element of a render by its name (ids may be safe replacements). */
const named = (r: RenderMessage, name: string) => Object.values(r.elements).find((e) => e.name === name) as NodeDetails;

/** A Bob process: Start -> Prepare (start, task, nested sub-process, end) -> End. */
const BOB_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs" targetNamespace="http://example.com/sub">
  <bpmn:process id="order" name="Order">
    <bpmn:startEvent id="start" name="Start"/>
    <bpmn:subProcess id="prepare" name="Prepare">
      <bpmn:startEvent id="prepStart" name="Prepare Start"/>
      <bpmn:task id="pick" name="Pick Items"/>
      <bpmn:subProcess id="pack" name="Pack">
        <bpmn:startEvent id="packStart" name="Pack Start"/>
        <bpmn:task id="wrap" name="Wrap"/>
        <bpmn:endEvent id="packEnd" name="Pack End"/>
        <bpmn:sequenceFlow id="pf1" sourceRef="packStart" targetRef="wrap"/>
        <bpmn:sequenceFlow id="pf2" sourceRef="wrap" targetRef="packEnd"/>
      </bpmn:subProcess>
      <bpmn:endEvent id="prepEnd" name="Prepare End"/>
      <bpmn:sequenceFlow id="sf1" sourceRef="prepStart" targetRef="pick"/>
      <bpmn:sequenceFlow id="sf2" sourceRef="pick" targetRef="pack"/>
      <bpmn:sequenceFlow id="sf3" sourceRef="pack" targetRef="prepEnd"/>
    </bpmn:subProcess>
    <bpmn:endEvent id="end" name="End"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="prepare"/>
    <bpmn:sequenceFlow id="f2" sourceRef="prepare" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`;

const bobPackage = (xml = BOB_BPMN) =>
  readProcessPackage({ path: '/work/order.bpmn', format: 'bpmn', bpmnFileName: 'order.bpmn', bpmnText: xml, xsdFiles: {} });

describe('Bob output: a sub-process opens as a level of its own', () => {
  it('has no "drawn collapsed" warning and an Open action on the sub-process', async () => {
    const { s, last } = session(() => bobPackage());
    await s.handleMessage({ type: 'ready' });
    const root = last();
    expect(root.warnings.filter((w) => /collapsed|inner node/.test(w))).toEqual([]);
    expect(root.elements.prepare).toMatchObject({ openCallee: 'sub:prepare', containsNodes: 4 });
    expect(root.elements.pick).toBeUndefined();
  });

  it('draws the inside, opens the nested sub-process and goes back by the breadcrumb', async () => {
    const { s, open } = session(() => bobPackage());
    await s.handleMessage({ type: 'ready' });
    const prepare = await open('sub:prepare');
    expect(prepare.path).toEqual([
      { id: 'order', name: 'Order', kind: 'Process' },
      { id: 'sub:prepare', name: 'Prepare', kind: 'Sub-process' },
    ]);
    expect(Object.keys(prepare.elements).sort()).toEqual(['pack', 'pick', 'prepEnd', 'prepStart', 'sf1', 'sf2', 'sf3']);
    expect(prepare.xml).toContain('id="pick"');
    expect(prepare.xml).not.toContain('id="wrap"');
    expect(prepare.process).toMatchObject({ name: 'Prepare', kind: 'Sub-process' });
    expect(prepare.elements.pack).toMatchObject({ openCallee: 'sub:pack', containsNodes: 3 });
    // The validation rules ran on the process; they do not run again here.
    expect(prepare.warnings).toEqual([]);

    const pack = await open('sub:pack');
    expect(pack.path.map((l) => l.name)).toEqual(['Order', 'Prepare', 'Pack']);
    expect(Object.keys(pack.elements).sort()).toEqual(['packEnd', 'packStart', 'pf1', 'pf2', 'wrap']);
    expect(s.currentPath).toEqual(['order', 'sub:prepare', 'sub:pack']);

    // Breadcrumb: back to the process (as the webview asks for it).
    const back = await open('order', []);
    expect(back.path.map((l) => l.name)).toEqual(['Order']);
    expect(back.elements.prepare).toBeDefined();
  });

  it('exports the drawn sub-process diagram', async () => {
    const { s, open } = session(() => bobPackage());
    await s.handleMessage({ type: 'ready' });
    await open('sub:prepare');
    const exported = await s.exportBpmn();
    expect(exported.levelName).toBe('Prepare');
    expect(exported.xml).toContain('id="pick"');
    expect(exported.xml).not.toContain('id="start"');
  });

  it('cannot open an empty sub-process', async () => {
    const xml = BOB_BPMN.replace('<bpmn:endEvent id="end" name="End"/>', '<bpmn:endEvent id="end" name="End"/><bpmn:subProcess id="empty" name="Empty"/>');
    const { s, last } = session(() => bobPackage(xml));
    await s.handleMessage({ type: 'ready' });
    expect(last().elements.empty).toMatchObject({ openUnavailable: 'Empty sub-process', containsNodes: 0 });
    expect((last().elements.empty as NodeDetails).openCallee).toBeUndefined();
  });

  it('goes back up with a note when a refresh no longer holds the open sub-process', async () => {
    let xml = BOB_BPMN;
    const { s, last, open } = session(() => bobPackage(xml));
    await s.handleMessage({ type: 'ready' });
    await open('sub:prepare');
    await open('sub:pack');
    // Pack is gone; Prepare is still there.
    xml = BOB_BPMN.replace(/<bpmn:subProcess id="pack"[\s\S]*?<\/bpmn:subProcess>/, '<bpmn:task id="pack" name="Pack"/>');
    await s.reload();
    expect(last().path.map((l) => l.name)).toEqual(['Order', 'Prepare']);
    expect(last().note).toBe('Pack is no longer in the file; showing Prepare');
  });
});

describe('synthetic TWX: sub-processes and event sub-processes', () => {
  const levelOf = (id: string) => `sub:${id}`;

  it('places the nodes inside from the diagram objects BAW keeps for each sub-process', async () => {
    const pkg = await syntheticTwxPackage({ subProcess: true });
    const p = pkg.processes[0];
    const check = subProcessDiagram(p, levelOf(CHECK_STOCK_ID))!;
    const byName = (name: string) => check.nodes.find((n) => n.name === name)!;
    expect(check.nodes.filter((n) => n.parentId === undefined).map((n) => n.name)).toEqual(['Check Start', 'Count Items', 'Timeout', 'Reserve Items', 'Check End']);
    expect(byName('Check Start').bounds).toEqual({ x: 25, y: 80, width: 24, height: 24 });
    expect(byName('Count Items').bounds).toEqual({ x: 150, y: 57, width: 95, height: 70 });
    expect(byName('Timeout').bounds).toEqual({ x: 200, y: 110, width: 24, height: 24 });
    // Reserve Items has no diagram object: its nodes have no positions.
    const reserve = subProcessDiagram(check, subProcessLevelId(byName('Reserve Items')))!;
    expect(reserve.nodes.map((n) => [n.name, n.bounds])).toEqual([
      ['Reserve Start', undefined],
      ['Reserve End', undefined],
    ]);
    expect(subProcessDiagram(p, levelOf(ON_ERROR_ID))!.nodes.map((n) => n.bounds?.x)).toEqual([25, 300]);
    // The process itself is still drawn with BAW's positions.
    expect(pkg.warnings).toEqual([]);
  });

  it('opens Check Stock, Reserve Items in it, and On Error', async () => {
    const { s, last, open } = session(() => syntheticTwxPackage({ subProcess: true }), 'synthetic.twx');
    await s.handleMessage({ type: 'ready' });
    const root = last();
    expect(root.warnings.filter((w) => /collapsed|inner node/.test(w))).toEqual([]);
    expect(named(root, 'Check Stock')).toMatchObject({ openCallee: levelOf(CHECK_STOCK_ID), containsNodes: 5 });
    expect(named(root, 'On Error')).toMatchObject({ openCallee: levelOf(ON_ERROR_ID), containsNodes: 2 });

    const check = await open(levelOf(CHECK_STOCK_ID));
    expect(check.path.map((l) => `${l.name} (${l.kind})`)).toEqual(['Synthetic Order (Process)', 'Check Stock (Sub-process)']);
    expect(Object.values(check.elements).filter((e) => e.kind === 'node').map((e) => e.name)).toEqual(['Check Start', 'Count Items', 'Timeout', 'Reserve Items', 'Check End']);
    // Drawn with the positions of the diagram object: no "laid out again" warning.
    expect(check.warnings).toEqual([]);
    expect(check.note).toBeUndefined();

    const reserve = await open(named(check, 'Reserve Items').openCallee!);
    expect(reserve.path.map((l) => l.name)).toEqual(['Synthetic Order', 'Check Stock', 'Reserve Items']);
    expect(Object.values(reserve.elements).filter((e) => e.kind === 'node').map((e) => e.name)).toEqual(['Reserve Start', 'Reserve End']);

    const onError = await open(levelOf(ON_ERROR_ID), [root.path[0].id]);
    expect(onError.path.map((l) => `${l.name} (${l.kind})`)).toEqual(['Synthetic Order (Process)', 'On Error (Event sub-process)']);
  });

  it('exports a sub-process level without script text', async () => {
    const { s, open } = session(() => syntheticTwxPackage({ subProcess: true }), 'synthetic.twx');
    await s.handleMessage({ type: 'ready' });
    await open(levelOf(CHECK_STOCK_ID));
    const exported = await s.exportBpmn();
    expect(exported.levelName).toBe('Check Stock');
    expect(exported.xml).toContain('name="Count Items"');
    expect(exported.xml).not.toContain('tw.local.count');
  });

  it('shows the comparison of the process at a sub-process level, with its marks on the elements drawn there', async () => {
    let renamed = false;
    const load = async () => {
      const pkg = await syntheticTwxPackage({ subProcess: true });
      if (renamed) pkg.processes[0].nodes.find((n) => n.name === 'Count Items')!.name = 'Count All Items';
      return pkg;
    };
    const { s, last, open } = session(load, 'synthetic.twx');
    await s.handleMessage({ type: 'ready' });
    renamed = true;
    await s.reload();

    const root = last();
    const checkId = named(root, 'Check Stock').id;
    expect(root.diff!.note).toBeUndefined();
    expect(root.diff!.changed.map((e) => [e.label, e.changes])).toEqual([
      ['Sub-process "Check Stock"', ['Inner changes: 1']],
      ['Script task "Count All Items"', ['Name: "Count Items" → "Count All Items"']],
    ]);
    expect(root.diff!.marks[checkId]).toBe('changed');
    const countId = root.diff!.changed[1].currentId!;
    expect(root.diff!.enclosing).toEqual({ [countId]: [checkId] });
    // The inner task is not drawn here; its row leads to Check Stock.
    expect(root.elements[countId]).toBeUndefined();

    const check = await open(levelOf(CHECK_STOCK_ID));
    expect(check.diff!.note).toBeUndefined();
    expect(check.diff!.changed).toEqual(root.diff!.changed);
    expect(check.diff!.marks[countId]).toBe('changed');
    expect(check.elements[countId]).toMatchObject({ name: 'Count All Items' });
  });

  it('keeps the note for service flows', async () => {
    let renamed = false;
    const load = async () => {
      const pkg = await syntheticTwxPackage({ subProcess: true });
      if (renamed) pkg.processes[0].nodes.find((n) => n.name === 'Count Items')!.name = 'Count All Items';
      return pkg;
    };
    const { s, last, open } = session(load, 'synthetic.twx');
    await s.handleMessage({ type: 'ready' });
    renamed = true;
    await s.reload();
    const service = await open(named(last(), 'Review Order').openCallee!);
    expect(service.path[1].kind).toBe('Service flow');
    expect(service.diff!.note).toBe(PROCESSES_ONLY_NOTE);
    expect(service.diff!.changed).toEqual([]);
  });
});

describe.skipIf(!hasLocalTwx('activities'))('local export: activities.twx', () => {
  it('opens Sub1 and the event sub-process with BAW positions', async () => {
    const { s, last, open } = session(() => readTwxPackage(localTwx('activities')), 'activities.twx');
    await s.handleMessage({ type: 'ready' });
    const pick = last().processes.find((p) => p.name === 'MyFirstProcess')!;
    await s.handleMessage({ type: 'selectProcess', processId: pick.id });
    const root = last();
    expect(root.warnings.filter((w) => /collapsed|inner node/.test(w))).toEqual([]);

    const sub1 = named(root, 'Sub1');
    expect(sub1).toMatchObject({ containsNodes: 4 });
    const inside = await open(sub1.openCallee!);
    expect(inside.path.map((l) => l.name)).toEqual(['MyFirstProcess', 'Sub1']);
    expect(Object.values(inside.elements).filter((e) => e.kind === 'node')).toHaveLength(4);
    expect(inside.warnings.filter((w) => /bounds/.test(w))).toEqual([]);

    const eventSub = Object.values(root.elements).find((e) => e.kind === 'node' && e.originalType === 'subProcess (event)') as NodeDetails;
    const events = await open(eventSub.openCallee!, [root.path[0].id]);
    expect(events.path[1].kind).toBe('Event sub-process');
    expect(Object.values(events.elements).filter((e) => e.kind === 'node')).toHaveLength(3);
    expect(events.warnings.filter((w) => /bounds/.test(w))).toEqual([]);
  });
});
