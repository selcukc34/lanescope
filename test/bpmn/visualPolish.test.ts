// Gateway flow labels, pool and lane header strips, and empty lanes: in the
// layout (Bob output laid out with ELK, TWX with BAW's positions), in the
// validation rules and in the viewer session's toolbar defaults.

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmn, readProcessPackage } from '../../src/bpmn/bpmnReader';
import {
  EMPTY_LANE_HEIGHT,
  headerMinHeight,
  LANE_HEADER,
  layoutProcess,
  POOL_HEADER,
  type ProcessLayout,
} from '../../src/bpmn/layout';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import type { Bounds, Process, ProcessPackage } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { emptyLane, validateProcess } from '../../src/validate/validate';
import type { HostMessage, RenderMessage } from '../../src/views/protocol';
import { ViewerSession } from '../../src/views/viewerSession';
import { hasLocalTwx, localTwx } from '../localFixtures';
import { syntheticTwxPackage } from '../syntheticTwx';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
/** The local exports these tests use (../localFixtures); skipped when they are not there. */
const REAL = hasLocalTwx('services', 'orderDelivery');

const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';

/** A small Bob-style process: lanes A and C hold nodes, lane B is empty. */
const EMPTY_LANE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="d" targetNamespace="http://example.com">
  <bpmn:process id="p" name="Empty lane sample">
    <bpmn:laneSet id="ls">
      <bpmn:lane id="laneA" name="Clerk"><bpmn:flowNodeRef>start</bpmn:flowNodeRef><bpmn:flowNodeRef>work</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="laneB" name="Auditor"></bpmn:lane>
      <bpmn:lane id="laneC" name="System"><bpmn:flowNodeRef>end</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="start" name="Start" />
    <bpmn:userTask id="work" name="Do work" />
    <bpmn:endEvent id="end" name="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="work" />
    <bpmn:sequenceFlow id="f2" sourceRef="work" targetRef="end" />
  </bpmn:process>
</bpmn:definitions>`;

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The vertical strip bpmn-js draws the pool's name in. */
const poolStrip = (lay: ProcessLayout): Bounds => ({ ...lay.pool, width: POOL_HEADER });
/** The vertical strip bpmn-js draws a lane's name in. */
const laneStrip = (b: Bounds): Bounds => ({ ...b, width: LANE_HEADER });

async function smallBob(): Promise<Process> {
  const { processes } = await readBpmn(EMPTY_LANE_BPMN);
  return processes[0];
}

describe('empty-lane rule', () => {
  it('reports the empty lane of a small Bob BPMN, and nothing else', async () => {
    const p = await smallBob();
    expect(validateProcess(p)).toEqual([
      { ruleId: 'empty-lane', severity: 'warning', elementId: 'laneB', message: 'Lane Auditor has no activities' },
    ]);
  });

  it('reports the empty Customer lane of the Bob fixture', async () => {
    const bob = (await readProcessPackage(await readBpmnPackage(BOB))).processes[0];
    expect(emptyLane.check(bob).map((i) => i.message)).toEqual(['Lane Customer has no activities']);
  });

  it.skipIf(!REAL)('reports the System lane of DemoChildProcess, and no lane of Demo_MainProcess', async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    const byName = (name: string) => pkg.processes.find((p) => p.name === name)!;
    expect(emptyLane.check(byName('DemoChildProcess')).map((i) => i.message)).toEqual(['Lane System has no activities']);
    expect(emptyLane.check(byName('Demo_MainProcess'))).toEqual([]);
  });

  it('is silent for a process without lanes', async () => {
    const p = await smallBob();
    expect(emptyLane.check({ ...p, lanes: [] })).toEqual([]);
  });
});

describe('empty lanes in the Bob layout', () => {
  it('leaves the empty lane out by default and draws it with hideEmptyLanes: false', async () => {
    const p = await smallBob();
    const hidden = await layoutProcess(p);
    expect(hidden.lanes.map((l) => l.name)).toEqual(['Clerk', 'System']);

    const shown = await layoutProcess(p, { hideEmptyLanes: false });
    expect(shown.lanes.map((l) => l.name)).toEqual(['Clerk', 'Auditor', 'System']);
    const [clerk, auditor, system] = shown.lanes.map((l) => l.bounds);
    expect(auditor.height).toBeGreaterThanOrEqual(EMPTY_LANE_HEIGHT);
    expect(auditor.y).toBe(clerk.y + clerk.height);
    expect(system.y).toBe(auditor.y + auditor.height);
    // The empty lane holds no node.
    for (const b of shown.shapes.values()) expect(overlaps(b, auditor)).toBe(false);
  });
});

describe.skipIf(!REAL)('empty lanes of a TWX export (DemoChildProcess)', () => {
  let child: Process;

  beforeAll(async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    child = pkg.processes.find((p) => p.name === 'DemoChildProcess')!;
  });

  it('reads the System lane from the BPMN2 laneSet, with its BAW height, below All Users', () => {
    expect(child.lanes.map((l) => [l.name, l.nodeIds.length, l.bounds?.y, l.bounds?.height])).toEqual([
      ['All Users', 3, 0, 200],
      ['System', 0, 200, 200],
    ]);
  });

  it('draws it as high as BAW does when empty lanes are shown, and leaves it out otherwise', async () => {
    const shown = await layoutProcess(child, { hideEmptyLanes: false });
    expect(shown.lanes.map((l) => [l.name, l.bounds.y, l.bounds.height])).toEqual([
      ['All Users', 0, 200],
      ['System', 200, 200],
    ]);
    expect(shown.pool.height).toBe(400);
    // The BAW positions stay as they are.
    for (const n of child.nodes) expect(shown.shapes.get(n.id)).toEqual(n.bounds);

    const hidden = await layoutProcess(child, { hideEmptyLanes: true });
    expect(hidden.lanes.map((l) => l.name)).toEqual(['All Users']);
    expect(hidden.pool.height).toBe(200);
  });
});

describe('pool and lane header strips', () => {
  const cases: Array<[string, () => Promise<Process[]>]> = [
    ['Bob fixture', async () => (await readProcessPackage(await readBpmnPackage(BOB))).processes],
    ['synthetic TWX', async () => (await syntheticTwxPackage()).processes],
    ...(REAL
      ? ([
          ['services TWX', async () => (await readTwxPackage(localTwx('services'))).processes],
          ['order delivery TWX', async () => (await readTwxPackage(localTwx('orderDelivery'))).processes],
        ] as Array<[string, () => Promise<Process[]>]>)
      : []),
  ];

  it.each(cases)('%s: lanes start right of the pool strip, nodes right of the lane strip', async (_, read) => {
    for (const p of await read()) {
      for (const hideEmptyLanes of [true, false]) {
        const lay = await layoutProcess(p, { hideEmptyLanes });
        expect(lay.lanes.length, p.name).toBeGreaterThan(0);
        const pool = poolStrip(lay);
        for (const lane of lay.lanes) {
          expect(lane.bounds.x, `${p.name} / ${lane.name}`).toBe(lay.pool.x + POOL_HEADER);
          expect(overlaps(pool, laneStrip(lane.bounds)), `${p.name} / ${lane.name}`).toBe(false);
        }
        const strips = lay.lanes.map((l) => laneStrip(l.bounds));
        for (const [id, b] of [...lay.shapes, ...lay.nodeLabels, ...lay.edgeLabels]) {
          for (const strip of [pool, ...strips]) expect(overlaps(b, strip), `${p.name}: ${id}`).toBe(false);
        }
        for (const pts of lay.edges.values()) {
          for (const pt of pts) expect(pt.x, p.name).toBeGreaterThan(lay.pool.x + POOL_HEADER + LANE_HEADER);
        }
      }
    }
  });

  it('makes a pool and an empty lane tall enough for a long name', async () => {
    const p = await smallBob();
    p.name = 'A process name that is long enough to need more than two lines in a short pool header';
    p.lanes[1].name = 'A lane name that is long enough to need more than two lines in an empty lane';
    const lay = await layoutProcess(p, { hideEmptyLanes: false });
    expect(lay.pool.height).toBeGreaterThanOrEqual(headerMinHeight(p.name));
    expect(lay.lanes[1].bounds.height).toBeGreaterThanOrEqual(headerMinHeight(p.lanes[1].name));
    expect(headerMinHeight(p.lanes[1].name)).toBeGreaterThan(EMPTY_LANE_HEIGHT);
  });
});

describe('labels of the outgoing flows of "Route Order"', () => {
  const routeOrderLabels = async (p: Process) => {
    const gateway = p.nodes.find((n) => n.name === 'Route Order')!;
    const lay = await layoutProcess(p);
    const outs = p.flows.filter((f) => f.sourceId === gateway.id);
    expect(outs).toHaveLength(4);
    return { lay, outs, labels: outs.map((f) => ({ name: f.name, b: lay.edgeLabels.get(f.id)! })) };
  };

  const expectApart = (labels: Array<{ name: string; b: Bounds }>) => {
    expect(labels.every((l) => l.b !== undefined)).toBe(true);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(overlaps(labels[i].b, labels[j].b), `${labels[i].name} / ${labels[j].name}`).toBe(false);
      }
    }
  };

  it('do not intersect in the Bob layout (ELK)', async () => {
    const bob = (await readProcessPackage(await readBpmnPackage(BOB))).processes[0];
    const { labels } = await routeOrderLabels(bob);
    expect(labels.map((l) => l.name).sort()).toEqual(['AUTO_APPROVE', 'COMPLIANCE_REVIEW', 'EXCEPTION', 'MANAGER_APPROVAL']);
    expectApart(labels);
  });

  it.skipIf(!REAL)('do not intersect in the TWX layout, and sit beside the own part of their first vertical segment', async () => {
    const twx = (await readTwxPackage(localTwx('orderDelivery'))).processes[0];
    const { lay, outs, labels } = await routeOrderLabels(twx);
    expectApart(labels);
    for (const f of outs) {
      const pts = lay.edges.get(f.id)!;
      const label = lay.edgeLabels.get(f.id)!;
      const i = pts.findIndex((p, k) => k > 0 && p.x === pts[k - 1].x);
      expect(i, f.name).toBeGreaterThan(0);
      const [a, b] = [pts[i - 1], pts[i]];
      const mid = label.y + label.height / 2;
      expect(mid, f.name).toBeGreaterThan(Math.min(a.y, b.y));
      expect(mid, f.name).toBeLessThan(Math.max(a.y, b.y));
      expect(label.x === a.x + 4 || label.x + label.width === a.x - 4, f.name).toBe(true);
    }
  });
});

describe('ViewerSession: "Show empty lanes" default by input type', () => {
  function session(load: () => Promise<ProcessPackage>) {
    const posted: HostMessage[] = [];
    let current = load;
    const s = new ViewerSession({ fileName: 'x', load: () => current(), post: (m) => posted.push(m), debounceMs: 0 });
    return { s, posted, renders: () => posted.filter((m): m is RenderMessage => m.type === 'render'), swap: (l: typeof load) => (current = l) };
  }

  it.skipIf(!REAL)('shows empty lanes of a TWX and hides those of Bob output on first open', async () => {
    const twx = await readTwxPackage(localTwx('services'));
    const t = session(async () => twx);
    await t.s.handleMessage({ type: 'ready' });
    expect(t.renders()[0].options.hideEmptyLanes).toBe(false);

    const bob = await readProcessPackage(await readBpmnPackage(BOB));
    const b = session(async () => bob);
    await b.s.handleMessage({ type: 'ready' });
    expect(b.renders()[0].options.hideEmptyLanes).toBe(true);
    expect(b.renders()[0].warnings).toContain('Lane Customer has no activities');
  });

  it.skipIf(!REAL)('keeps the user choice across the process picker and live refresh', async () => {
    const twx = await readTwxPackage(localTwx('services'));
    const t = session(async () => twx);
    await t.s.handleMessage({ type: 'ready' });
    await t.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true } });
    const child = twx.processes.find((p) => p.name === 'DemoChildProcess')!;
    await t.s.handleMessage({ type: 'selectProcess', processId: child.id });
    await t.s.reload();
    const renders = t.renders();
    expect(renders.map((r) => r.options.hideEmptyLanes)).toEqual([false, true, true, true]);
    // DemoChildProcess drawn without its empty System lane, still named in the Warnings tab.
    const last = renders[renders.length - 1];
    expect(last.xml).not.toContain('name="System"');
    expect(last.warnings).toContain('Lane System has no activities');
  });
});
