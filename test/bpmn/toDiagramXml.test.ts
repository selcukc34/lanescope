import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { icpDescriptor, readBpmn, readProcessPackage } from '../../src/bpmn/bpmnReader';
import {
  EVENT_SIZE,
  GATEWAY_SIZE,
  NODE_LABEL_MIN_WIDTH,
  ROW_HEIGHT,
  TASK_SIZE,
  isGeneratedFlowLabel,
  layoutProcess,
} from '../../src/bpmn/layout';
import { toDiagramXml } from '../../src/bpmn/toDiagramXml';
import type { Bounds, FlowNode, Process } from '../../src/model/model';

const FIXTURE = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const OUTPUT_DIR = path.join(__dirname, '../output');

interface Diagram {
  definitions: ModdleElement;
  process: ModdleElement;
  warnings: string[];
  /** DI element (shape or edge) by id of the semantic element. */
  di: Map<string, ModdleElement>;
}

/** Loads XML with bpmn-moddle the way bpmn-js does and indexes the DI. */
async function loadDiagram(xml: string): Promise<Diagram> {
  const result = await BpmnModdle({ icp: icpDescriptor }).fromXML(xml);
  const definitions = result.rootElement;
  const rootElements = definitions.rootElements as ModdleElement[];
  const process = rootElements.find((e) => e.$type === 'bpmn:Process')!;
  const di = new Map<string, ModdleElement>();
  for (const diagram of definitions.diagrams as ModdleElement[]) {
    const plane = diagram.plane as ModdleElement;
    for (const el of plane.planeElement as ModdleElement[]) {
      di.set((el.bpmnElement as ModdleElement).id as string, el);
    }
  }
  return { definitions, process, warnings: result.warnings.map((w) => w.message), di };
}

const boundsOf = (shape: ModdleElement): Bounds => {
  const b = shape.bounds as ModdleElement;
  return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
};
const center = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const inside = (p: { x: number; y: number }, b: Bounds) =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
const labelOf = (di: ModdleElement): Bounds | undefined => {
  const label = di.label as ModdleElement | undefined;
  return label ? boundsOf(label) : undefined;
};
const waypoints = (di: ModdleElement) =>
  (di.waypoint as ModdleElement[]).map((p) => ({ x: p.x as number, y: p.y as number }));
const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('toDiagramXml with the Bob fixture', () => {
  let model: Process;
  let xml: string;
  let warnings: string[];
  let diagram: Diagram;

  beforeAll(async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(FIXTURE));
    model = pkg.processes[0];
    ({ xml, warnings } = await toDiagramXml(model));
    diagram = await loadDiagram(xml);
    // For opening by hand in demo.bpmn.io (test/output is git-ignored).
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, 'order-delivery-process.diagram.bpmn'), xml);
  });

  it('loads without warnings', () => {
    expect(diagram.warnings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('wraps the process in a collaboration with one participant', () => {
    const rootElements = diagram.definitions.rootElements as ModdleElement[];
    const collaboration = rootElements.find((e) => e.$type === 'bpmn:Collaboration')!;
    const participants = collaboration.participants as ModdleElement[];
    expect(participants).toHaveLength(1);
    expect(participants[0].processRef).toBe(diagram.process);
    const plane = (diagram.definitions.diagrams as ModdleElement[])[0].plane as ModdleElement;
    expect(plane.bpmnElement).toBe(collaboration);
    expect(diagram.di.get(participants[0].id as string)?.isHorizontal).toBe(true);
  });

  it('has a shape for every flow node and an edge for every flow', () => {
    const elements = diagram.process.flowElements as ModdleElement[];
    expect(elements.filter((e) => e.$instanceOf('bpmn:FlowNode'))).toHaveLength(model.nodes.length);
    expect(elements.filter((e) => e.$type === 'bpmn:SequenceFlow')).toHaveLength(model.flows.length);
    for (const el of elements) {
      const di = diagram.di.get(el.id as string);
      expect(di?.$type, el.id as string).toBe(el.$type === 'bpmn:SequenceFlow' ? 'bpmndi:BPMNEdge' : 'bpmndi:BPMNShape');
    }
  });

  it('uses the standard node sizes', () => {
    for (const node of model.nodes) {
      const b = boundsOf(diagram.di.get(node.id)!);
      const expected = node.kind.endsWith('Event') ? EVENT_SIZE : node.kind.endsWith('Gateway') ? GATEWAY_SIZE : TASK_SIZE;
      expect({ width: b.width, height: b.height }, node.name).toEqual(expected);
    }
  });

  it('stacks lanes of equal width top to bottom in document order', () => {
    const shown = model.lanes.filter((l) => l.nodeIds.length > 0);
    expect(shown.map((l) => l.name)).toEqual(['System', 'Order Manager', 'Compliance Reviewer', 'Operations Team']);
    const lanes = shown.map((l) => boundsOf(diagram.di.get(l.id)!));
    const pool = boundsOf([...diagram.di.values()].find((d) => d.bpmnElement && (d.bpmnElement as ModdleElement).$type === 'bpmn:Participant')!);
    for (let i = 0; i < lanes.length; i++) {
      expect(lanes[i].width).toBe(lanes[0].width);
      expect(lanes[i].x).toBe(lanes[0].x);
      expect(lanes[i].height).toBeGreaterThan(0);
      if (i > 0) expect(lanes[i].y).toBe(lanes[i - 1].y + lanes[i - 1].height);
    }
    expect(lanes[0].y).toBe(pool.y);
    expect(lanes[lanes.length - 1].y + lanes[lanes.length - 1].height).toBe(pool.y + pool.height);
    expect(lanes[0].x + lanes[0].width).toBe(pool.x + pool.width);
  });

  it('leaves out the empty "Customer" lane by default', async () => {
    const customer = model.lanes[0];
    expect(customer.name).toBe('Customer');
    expect(customer.nodeIds).toEqual([]);
    expect(diagram.di.has(customer.id)).toBe(false);
    const laneSets = diagram.process.laneSets as ModdleElement[];
    const laneIds = laneSets.flatMap((ls) => (ls.lanes as ModdleElement[]).map((l) => l.id));
    expect(laneIds).not.toContain(customer.id);
    expect(laneIds).toHaveLength(4);
  });

  it('keeps the empty lane as a band of its own with hideEmptyLanes: false', async () => {
    const { xml: full, layout } = await toDiagramXml(model, { hideEmptyLanes: false });
    const d = await loadDiagram(full);
    expect(d.warnings).toEqual([]);
    expect(layout.lanes.map((l) => l.name)).toEqual(model.lanes.map((l) => l.name));
    const customer = boundsOf(d.di.get(model.lanes[0].id)!);
    const system = boundsOf(d.di.get(model.lanes[1].id)!);
    expect(customer.height).toBeGreaterThanOrEqual(80);
    expect(system.y).toBe(customer.y + customer.height);
    expect(customer.width).toBe(system.width);
  });

  it('puts the center of every shape inside its own lane', () => {
    const laneOf = new Map<string, string>();
    for (const laneSet of diagram.process.laneSets as ModdleElement[]) {
      for (const lane of laneSet.lanes as ModdleElement[]) {
        for (const ref of (lane.flowNodeRef ?? []) as ModdleElement[]) laneOf.set(ref.id as string, lane.id as string);
      }
    }
    for (const node of model.nodes) {
      expect(laneOf.get(node.id), node.name).toBe(node.laneId);
      const laneBounds = boundsOf(diagram.di.get(node.laneId!)!);
      expect(inside(center(boundsOf(diagram.di.get(node.id)!)), laneBounds), node.name).toBe(true);
    }
  });

  it('does not let nodes overlap', () => {
    const shapes = model.nodes.map((n) => ({ name: n.name, b: boundsOf(diagram.di.get(n.id)!) }));
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(overlaps(shapes[i].b, shapes[j].b), `${shapes[i].name} / ${shapes[j].name}`).toBe(false);
      }
    }
  });

  it('routes flows orthogonally from source to target', () => {
    const touches = (p: { x: number; y: number }, b: Bounds) =>
      inside(p, { x: b.x - 1, y: b.y - 1, width: b.width + 2, height: b.height + 2 });
    for (const flow of model.flows) {
      const points = (diagram.di.get(flow.id)!.waypoint as ModdleElement[]).map((p) => ({ x: p.x as number, y: p.y as number }));
      expect(points.length, flow.name).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        expect(a.x === b.x || a.y === b.y, `${flow.name} segment ${i}`).toBe(true);
      }
      expect(touches(points[0], boundsOf(diagram.di.get(flow.sourceId)!)), flow.name).toBe(true);
      expect(touches(points[points.length - 1], boundsOf(diagram.di.get(flow.targetId)!)), flow.name).toBe(true);
    }
  });

  it('keeps default flows and conditions', () => {
    const byId = new Map((diagram.process.flowElements as ModdleElement[]).map((e) => [e.id as string, e]));
    for (const flow of model.flows) {
      const el = byId.get(flow.id)!;
      const source = byId.get(flow.sourceId)!;
      expect(source.default === el, flow.name).toBe(flow.isDefault);
      expect((el.conditionExpression as ModdleElement | undefined)?.body, flow.name).toBe(flow.condition);
    }
    expect(xml).toContain('default="bpmnid-e60e39f8-8ad4-5c29-a934-8bc13a6f4a3e"');
  });

  it('stacks no end events: the System lane is at most two rows high', () => {
    const system = model.lanes.find((l) => l.name === 'System')!;
    expect(boundsOf(diagram.di.get(system.id)!).height).toBeLessThanOrEqual(2 * ROW_HEIGHT);
  });

  it('puts an end event fed from another lane right of its source', () => {
    for (const name of ['Manager Approval', 'Compliance Review', 'Handle Exception']) {
      const source = model.nodes.find((n) => n.name === name)!;
      const end = model.nodes.find((n) => model.flows.some((f) => f.sourceId === source.id && f.targetId === n.id))!;
      expect(end.kind).toBe('endEvent');
      const s = boundsOf(diagram.di.get(source.id)!);
      expect(boundsOf(diagram.di.get(end.id)!).x, end.name).toBeGreaterThan(s.x + s.width);
    }
  });

  it('gives each outgoing flow of "Route Order" its own first segment', () => {
    const gateway = model.nodes.find((n) => n.name === 'Route Order')!;
    const outs = model.flows.filter((f) => f.sourceId === gateway.id);
    expect(outs).toHaveLength(4);
    const firsts = outs.map((f) => JSON.stringify(waypoints(diagram.di.get(f.id)!).slice(0, 2)));
    expect(new Set(firsts).size).toBe(4);
    const starts = outs.map((f) => waypoints(diagram.di.get(f.id)!)[0]);
    expect(new Set(starts.map((p) => `${p.x},${p.y}`)).size).toBe(4);
  });

  it('hides generated flow labels but keeps condition and default labels', () => {
    const elements = new Map((diagram.process.flowElements as ModdleElement[]).map((e) => [e.id as string, e]));
    const nameOf = (id: string) => model.nodes.find((n) => n.id === id)!.name;
    let hidden = 0;
    for (const flow of model.flows) {
      const generated = isGeneratedFlowLabel(flow, nameOf(flow.targetId));
      const shown = !generated || flow.condition !== undefined || flow.isDefault;
      if (!shown) hidden++;
      expect(elements.get(flow.id)!.name, flow.name).toBe(shown ? flow.name : undefined);
      expect(labelOf(diagram.di.get(flow.id)!) !== undefined, flow.name).toBe(shown);
    }
    expect(hidden).toBe(8);
    for (const name of ['Valid', 'Invalid', 'AUTO_APPROVE', 'MANAGER_APPROVAL', 'COMPLIANCE_REVIEW', 'EXCEPTION']) {
      const flow = model.flows.find((f) => f.name === name)!;
      expect(labelOf(diagram.di.get(flow.id)!), name).toBeDefined();
    }
  });

  it('keeps flow labels clear of nodes', () => {
    const shapes = model.nodes.map((n) => boundsOf(diagram.di.get(n.id)!));
    for (const flow of model.flows) {
      const label = labelOf(diagram.di.get(flow.id)!);
      if (!label) continue;
      for (const s of shapes) expect(overlaps(label, s), flow.name).toBe(false);
    }
  });

  it('gives event and gateway labels a box at least 120px wide below the shape', () => {
    for (const node of model.nodes) {
      const label = labelOf(diagram.di.get(node.id)!);
      if (node.kind.endsWith('Event') || node.kind.endsWith('Gateway')) {
        const shape = boundsOf(diagram.di.get(node.id)!);
        expect(label!.width, node.name).toBeGreaterThanOrEqual(NODE_LABEL_MIN_WIDTH);
        expect(label!.y, node.name).toBeGreaterThanOrEqual(shape.y + shape.height);
        expect(center(label!).x, node.name).toBeCloseTo(center(shape).x, 0);
      } else {
        expect(label, node.name).toBeUndefined();
      }
    }
  });

  it('reads back to the same process model with all flow labels kept', async () => {
    const back = await readBpmn(
      (await toDiagramXml(model, { hideGeneratedFlowLabels: false, hideEmptyLanes: false })).xml,
    );
    expect(back.warnings).toEqual([]);
    const strip = (n: FlowNode) => ({ ...n, bounds: undefined, inputs: [], outputs: [] });
    expect(back.processes[0].nodes.map(strip)).toEqual(model.nodes.map(strip));
    expect(back.processes[0].flows).toEqual(model.flows);
    expect(back.processes[0].lanes).toEqual(model.lanes);
    expect(back.processes[0].nodes.every((n) => n.bounds !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const node = (id: string, kind: FlowNode['kind'], extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  name: id,
  kind,
  originalType: `bpmn:${kind[0].toUpperCase()}${kind.slice(1)}`,
  inputs: [],
  outputs: [],
  ...extra,
});

function smallProcess(): Process {
  return {
    id: 'p',
    name: 'P',
    documentation: '',
    lanes: [
      { id: 'l1', name: 'One', nodeIds: ['s', 't1'] },
      { id: 'l2', name: 'Two', nodeIds: ['t2', 'e'] },
    ],
    nodes: [
      node('s', 'startEvent', { laneId: 'l1' }),
      node('t1', 'task', { laneId: 'l1' }),
      node('t2', 'userTask', { laneId: 'l2' }),
      node('e', 'endEvent', { laneId: 'l2' }),
    ],
    flows: [
      { id: 'f1', name: '', sourceId: 's', targetId: 't1', isDefault: false },
      { id: 'f2', name: '', sourceId: 't1', targetId: 't2', isDefault: false },
      { id: 'f3', name: '', sourceId: 't2', targetId: 'e', isDefault: false },
    ],
  };
}

describe('flow labels', () => {
  const flow = (name: string, extra: Partial<Process['flows'][number]> = {}) => ({
    id: 'f',
    name,
    sourceId: 's',
    targetId: 't',
    isDefault: false,
    ...extra,
  });

  it('recognises generated "To <target>" labels', () => {
    expect(isGeneratedFlowLabel(flow('To Validate Order SF'), 'Validate Order SF')).toBe(true);
    expect(isGeneratedFlowLabel(flow(' to validate order sf '), 'Validate Order SF')).toBe(true);
    expect(isGeneratedFlowLabel(flow('To Something Else'), 'Validate Order SF')).toBe(false);
    expect(isGeneratedFlowLabel(flow('Valid'), 'Validate Order SF')).toBe(false);
    expect(isGeneratedFlowLabel(flow(''), '')).toBe(false);
  });

  it('shows generated labels of conditional and default flows, and all labels when asked', async () => {
    const p = smallProcess();
    p.flows[0].name = 'To t1';
    p.flows[1].name = 'To t2';
    p.flows[1].condition = 'tw.local.x == 1';
    p.flows[2].name = 'Done';
    const hidden = await layoutProcess(p);
    expect([...hidden.flowLabels]).toEqual([
      ['f2', 'To t2'],
      ['f3', 'Done'],
    ]);
    expect([...hidden.edgeLabels.keys()].sort()).toEqual(['f2', 'f3']);
    const all = await layoutProcess(p, { hideGeneratedFlowLabels: false });
    expect([...all.flowLabels.keys()]).toEqual(['f1', 'f2', 'f3']);
    // The model keeps every name.
    expect(p.flows[0].name).toBe('To t1');
  });
});

describe('layoutProcess', () => {
  it('keeps existing bounds when every node has them and only routes flows', async () => {
    const p = smallProcess();
    const given: Record<string, Bounds> = {
      s: { x: 100, y: 40, width: 36, height: 36 },
      t1: { x: 200, y: 18, width: 100, height: 80 },
      t2: { x: 360, y: 160, width: 100, height: 80 },
      e: { x: 520, y: 182, width: 36, height: 36 },
    };
    for (const n of p.nodes) n.bounds = given[n.id];
    const layout = await layoutProcess(p);
    expect(layout.warnings).toEqual([]);
    for (const n of p.nodes) expect(layout.shapes.get(n.id), n.id).toEqual(given[n.id]);
    expect(layout.edges.get('f2')).toEqual([
      { x: 300, y: 58 },
      { x: 330, y: 58 },
      { x: 330, y: 200 },
      { x: 360, y: 200 },
    ]);
    // Model is not modified.
    expect(p.nodes[0].bounds).toEqual(given.s);
  });

  it('lays out everything again when only some nodes have bounds', async () => {
    const p = smallProcess();
    p.nodes[1].bounds = { x: 5000, y: 5000, width: 10, height: 10 };
    const layout = await layoutProcess(p);
    expect(layout.warnings).toEqual([expect.stringContaining('Only 1 of 4 nodes have diagram bounds')]);
    expect(layout.shapes.get('t1')).toMatchObject(TASK_SIZE);
    expect(layout.shapes.get('t1')!.x).toBeLessThan(5000);
  });

  it('draws a sub-process collapsed and skips its inner nodes, without a warning (it opens as a level of its own)', async () => {
    const p = smallProcess();
    p.nodes[1] = node('t1', 'subProcess', { laneId: 'l1' });
    p.nodes.push(node('inner1', 'task', { parentId: 't1' }), node('inner2', 'task', { parentId: 't1' }));
    p.flows.push({ id: 'fi', name: '', sourceId: 'inner1', targetId: 'inner2', isDefault: false });
    const { xml, layout, warnings } = await toDiagramXml(p);
    expect(warnings).toEqual([]);
    expect(layout.shapes.get('t1')).toMatchObject(TASK_SIZE);
    expect(layout.shapes.has('inner1')).toBe(false);
    expect(layout.edges.has('fi')).toBe(false);
    const d = await loadDiagram(xml);
    expect(d.warnings).toEqual([]);
    expect(d.di.get('t1')?.isExpanded).toBe(false);
    expect(xml).not.toContain('inner1');
  });

  it('puts nodes without a lane into an extra lane', async () => {
    const p = smallProcess();
    p.nodes.push(node('x', 'task'));
    p.flows.push({ id: 'fx', name: '', sourceId: 'e', targetId: 'x', isDefault: false });
    const { xml, layout, warnings } = await toDiagramXml(p);
    expect(warnings).toEqual([expect.stringContaining('1 node(s) have no lane')]);
    expect(layout.lanes.map((l) => l.name)).toEqual(['One', 'Two', '(No lane)']);
    const lane = layout.lanes[2].bounds;
    expect(inside(center(layout.shapes.get('x')!), lane)).toBe(true);
    expect((await loadDiagram(xml)).warnings).toEqual([]);
  });

  it('draws a plain pool when every lane is empty', async () => {
    const p = smallProcess();
    p.lanes.push({ id: 'l3', name: 'Empty', nodeIds: [] });
    for (const n of p.nodes) delete n.laneId;
    for (const l of p.lanes) l.nodeIds = [];
    const { xml, layout, warnings } = await toDiagramXml(p);
    expect(layout.lanes.map((l) => l.name)).toEqual(['(No lane)']);
    expect(warnings).toEqual([expect.stringContaining('4 node(s) have no lane')]);
    expect((await loadDiagram(xml)).warnings).toEqual([]);

    const none = await layoutProcess({ ...smallProcess(), nodes: [], flows: [] });
    expect(none.lanes).toEqual([]);
  });

  it('hides only lanes without drawn nodes', async () => {
    const p = smallProcess();
    p.lanes.splice(1, 0, { id: 'mid', name: 'Middle', nodeIds: [] });
    expect((await layoutProcess(p)).lanes.map((l) => l.name)).toEqual(['One', 'Two']);
    const kept = await layoutProcess(p, { hideEmptyLanes: false });
    expect(kept.lanes.map((l) => l.name)).toEqual(['One', 'Middle', 'Two']);
    expect(kept.lanes[1].bounds.height).toBeGreaterThanOrEqual(80);
  });

  it('draws a process without lanes in a pool', async () => {
    const p = smallProcess();
    p.lanes = [];
    for (const n of p.nodes) delete n.laneId;
    const { xml, layout } = await toDiagramXml(p);
    expect(layout.lanes).toEqual([]);
    for (const b of layout.shapes.values()) expect(inside(center(b), layout.pool)).toBe(true);
    const d = await loadDiagram(xml);
    expect(d.warnings).toEqual([]);
    expect(d.process.laneSets).toBeUndefined();
  });

  it('handles a cycle', async () => {
    const p = smallProcess();
    p.flows.push({ id: 'back', name: '', sourceId: 't2', targetId: 't1', isDefault: false });
    const layout = await layoutProcess(p);
    expect(layout.edges.get('back')!.length).toBeGreaterThanOrEqual(2);
    for (const n of p.nodes) {
      const lane = layout.lanes.find((l) => l.id === n.laneId)!;
      expect(inside(center(layout.shapes.get(n.id)!), lane.bounds), n.id).toBe(true);
    }
  });
});
