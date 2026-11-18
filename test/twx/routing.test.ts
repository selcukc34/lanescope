// Lane heights and flow ports of TWX diagrams: lanes are as high as BAW's
// <height>, flows leave and enter through the sides BAW's linkVisualInfo
// names, and no flow segment runs through a node other than its source and
// target.

import { describe, expect, it } from 'vitest';
import { layoutProcess } from '../../src/bpmn/layout';
import { freePort, routeBetweenPorts, segmentCrosses } from '../../src/bpmn/orthogonalRouter';
import type { Bounds, PortLocation, Process } from '../../src/model/model';
import { portLocation } from '../../src/twx/bpdReader';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, LOCAL_TWX, localTwx, type LocalTwx } from '../localFixtures';
import { SYNTHETIC_FILE, syntheticTwxPackage } from '../syntheticTwx';

// The synthetic export always; the local exports when they are there.
const FIXTURES: LocalTwx[] = ['orderDelivery', 'activities', 'services', 'events'];

const cases = [
  ...(await syntheticTwxPackage()).processes.map((p) => [`${SYNTHETIC_FILE} / ${p.name}`, p] as const),
  ...(
    await Promise.all(
      FIXTURES.filter((f) => hasLocalTwx(f)).map(async (file) => {
        const pkg = await readTwxPackage(localTwx(file));
        return pkg.processes.map((p) => [`${LOCAL_TWX[file]} / ${p.name}`, p] as const);
      }),
    )
  ).flat(),
];

/** True when `p` lies on the side of `b` that `port` names (anywhere along it). */
const onSide = (p: { x: number; y: number }, b: Bounds, port: PortLocation) => {
  const e = 1e-6;
  switch (port.side) {
    case 'left':
    case 'right': {
      const x = port.side === 'left' ? b.x : b.x + b.width;
      return Math.abs(p.x - x) < e && p.y >= b.y - e && p.y <= b.y + b.height + e;
    }
    case 'top':
    case 'bottom': {
      const y = port.side === 'top' ? b.y : b.y + b.height;
      return Math.abs(p.y - y) < e && p.x >= b.x - e && p.x <= b.x + b.width + e;
    }
  }
};

describe.each(cases)('%s', (_label, process: Process) => {
  it('reads a port for every flow', () => {
    for (const f of process.flows) {
      expect(f.sourcePort, f.name).toBeDefined();
      expect(f.targetPort, f.name).toBeDefined();
    }
  });

  it('routes no flow segment through a node other than its source and target', async () => {
    const layout = await layoutProcess(process);
    for (const flow of process.flows) {
      const points = layout.edges.get(flow.id);
      if (!points) continue; // not drawn (inside a collapsed sub-process)
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        expect(a.x === b.x || a.y === b.y, `${flow.name}: segment ${i} is orthogonal`).toBe(true);
        for (const [id, box] of layout.shapes) {
          if (id === flow.sourceId || id === flow.targetId) continue;
          const node = process.nodes.find((n) => n.id === id)!;
          expect(segmentCrosses(a, b, box), `"${flow.name}" segment ${i} crosses "${node.name}"`).toBe(false);
        }
      }
    }
  });

  it('leaves and enters each node through the port BAW names (unless it lies inside another node)', async () => {
    const layout = await layoutProcess(process);
    const shapes = [...layout.shapes.values()];
    for (const flow of process.flows) {
      const points = layout.edges.get(flow.id);
      if (!points || !flow.sourcePort || !flow.targetPort) continue;
      const s = layout.shapes.get(flow.sourceId)!;
      const t = layout.shapes.get(flow.targetId)!;
      expect(onSide(points[0], s, freePort(s, flow.sourcePort, shapes)), `${flow.name} start`).toBe(true);
      expect(onSide(points[points.length - 1], t, freePort(t, flow.targetPort, shapes)), `${flow.name} end`).toBe(true);
    }
  });

  it('draws the lanes as high as BAW does, empty ones included', async () => {
    const layout = await layoutProcess(process, { hideEmptyLanes: false });
    expect(process.lanes.every((l) => l.bounds !== undefined)).toBe(true);
    expect(layout.lanes.map((l) => [l.name, l.bounds.height])).toEqual(
      process.lanes.map((l) => [l.name, l.bounds!.height]),
    );
    expect(layout.lanes.map((l) => l.bounds.y)).toEqual(process.lanes.map((l) => l.bounds!.y));
  });
});

describe.skipIf(!hasLocalTwx('orderDelivery'))('order-delivery-process lanes', () => {
  it('uses the <height> of each BAW lane, stacked from 0', async () => {
    const p = cases.find(([label]) => label.startsWith('order-delivery'))![1];
    expect(p.lanes.map((l) => [l.name, l.bounds!.y, l.bounds!.height])).toEqual([
      ['System', 0, 530],
      ['Order Manager', 530, 130],
      ['Compliance Reviewer', 660, 130],
      ['Operations Team', 790, 130],
      // Bob's empty Customer lane: BAW keeps it (as "Participant") in the BPMN2 laneSet only.
      ['Participant', 920, 150],
    ]);
    expect((await layoutProcess(p)).pool.height).toBe(920);
    expect((await layoutProcess(p, { hideEmptyLanes: false })).pool.height).toBe(1070);
  });
});

describe('portLocation', () => {
  it('reads the BAW port names', () => {
    expect(portLocation('rightCenter')).toEqual({ side: 'right', offset: 0.5 });
    expect(portLocation('leftCenter')).toEqual({ side: 'left', offset: 0.5 });
    expect(portLocation('topCenter')).toEqual({ side: 'top', offset: 0.5 });
    expect(portLocation('bottomCenter')).toEqual({ side: 'bottom', offset: 0.5 });
    expect(portLocation('leftTop')).toEqual({ side: 'left', offset: 0.25 });
    expect(portLocation('bottomLeft')).toEqual({ side: 'bottom', offset: 0.25 });
    expect(portLocation('middle')).toBeUndefined();
    expect(portLocation(undefined)).toBeUndefined();
  });
});

describe('freePort', () => {
  it('keeps a free port and turns one that points into another node', () => {
    const host: Bounds = { x: 0, y: 12, width: 95, height: 70 };
    // A boundary event on the host's top border; its bottom port is inside the host.
    const event: Bounds = { x: 40, y: 0, width: 24, height: 24 };
    expect(freePort(event, { side: 'bottom', offset: 0.5 }, [host, event])).toEqual({ side: 'top', offset: 0.5 });
    expect(freePort(event, { side: 'top', offset: 0.5 }, [host, event])).toEqual({ side: 'top', offset: 0.5 });
    expect(freePort(host, { side: 'right', offset: 0.5 }, [host, event])).toEqual({ side: 'right', offset: 0.5 });
  });
});

describe('routeBetweenPorts', () => {
  const a: Bounds = { x: 0, y: 0, width: 100, height: 80 };
  const b: Bounds = { x: 400, y: 0, width: 100, height: 80 };
  const wall: Bounds = { x: 200, y: -20, width: 100, height: 120 };
  const right: PortLocation = { side: 'right', offset: 0.5 };
  const left: PortLocation = { side: 'left', offset: 0.5 };

  it('goes around a node in the way', () => {
    const points = routeBetweenPorts(a, right, b, left, [a, b, wall])!;
    expect(points[0]).toEqual({ x: 100, y: 40 });
    expect(points[points.length - 1]).toEqual({ x: 400, y: 40 });
    for (let i = 0; i + 1 < points.length; i++) {
      expect(segmentCrosses(points[i], points[i + 1], wall)).toBe(false);
      expect(points[i].x === points[i + 1].x || points[i].y === points[i + 1].y).toBe(true);
    }
  });

  it('passes between nodes closer together than stub and margin', () => {
    // 25 px between the wall and the target: the target's stub ends in the wall's margin.
    const near: Bounds = { x: 0, y: 200, width: 32, height: 32 };
    const blocker: Bounds = { x: 100, y: 80, width: 95, height: 70 };
    const goal: Bounds = { x: 220, y: 80, width: 95, height: 70 };
    const points = routeBetweenPorts(near, { side: 'top', offset: 0.5 }, goal, left, [near, blocker, goal])!;
    expect(points[points.length - 1]).toEqual({ x: 220, y: 115 });
    for (let i = 0; i + 1 < points.length; i++) {
      expect(segmentCrosses(points[i], points[i + 1], blocker), `segment ${i}`).toBe(false);
    }
  });

  it('is a straight line when nothing is in the way', () => {
    expect(routeBetweenPorts(a, right, b, left, [a, b])).toEqual([
      { x: 100, y: 40 },
      { x: 400, y: 40 },
    ]);
  });

  it('leaves through the named side, also backwards', () => {
    const points = routeBetweenPorts(b, { side: 'bottom', offset: 0.5 }, a, { side: 'top', offset: 0.5 }, [a, b])!;
    expect(points[0]).toEqual({ x: 450, y: 80 });
    expect(points[1].x).toBe(450);
    expect(points[1].y).toBeGreaterThan(80);
    const last = points[points.length - 1];
    expect(last).toEqual({ x: 50, y: 0 });
    expect(points[points.length - 2].x).toBe(50);
    expect(points[points.length - 2].y).toBeLessThan(0);
    for (let i = 0; i + 1 < points.length; i++) {
      expect(segmentCrosses(points[i], points[i + 1], a), `segment ${i} vs a`).toBe(false);
      expect(segmentCrosses(points[i], points[i + 1], b), `segment ${i} vs b`).toBe(false);
    }
  });
});
