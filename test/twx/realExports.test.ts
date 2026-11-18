// Real BAW 8.6.6 exports (../localFixtures; skipped when they are not there).
// Expected values were checked against the exports in BAW. Node counts
// include the nodes inside sub-processes; flow counts include their flows.

import { describe, expect, it } from 'vitest';
import type { Process, ProcessPackage } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { layoutProcess } from '../../src/bpmn/layout';
import { hasLocalTwx, localTwx, type LocalTwx } from '../localFixtures';

interface Expected {
  nodes: number;
  /** Nodes on the process level (the rest is inside sub-processes). */
  topLevel: number;
  flows: number;
  lanes: string[];
}

const EXPORTS: Partial<Record<LocalTwx, Record<string, Expected>>> = {
  // MyFirstProcess and MyProcess2 (the two subprocess objects are embedded,
  // not BPDs of their own). MyFirstProcess: 12
  // flow objects (7 activities, 4 events, 1 gateway) and 3 boundary events on the
  // process level; Sub1 holds 4 nodes and the event subprocess 3.
  activities: {
    MyFirstProcess: { nodes: 22, topLevel: 15, flows: 19, lanes: ['All Users', 'System'] },
    MyProcess2: { nodes: 3, topLevel: 3, flows: 2, lanes: ['All Users', 'System'] },
  },
  // Six BPDs. Demo_MainProcess is Start, 2 user tasks, 6
  // system tasks, 2 linked processes, 3 timers and End; Timer 2 has no outgoing
  // flow and End no incoming one, so 15 nodes and 13 flows. MyFirstProcess has
  // gained the decision task, the inline user task and a third service call.
  services: {
    Demo_MainProcess: { nodes: 15, topLevel: 15, flows: 13, lanes: ['All Users', 'System'] },
    Demo_TrackedProcess: { nodes: 3, topLevel: 3, flows: 2, lanes: ['All Users', 'System'] },
    DemoChildProcess: { nodes: 3, topLevel: 3, flows: 2, lanes: ['All Users', 'System'] },
    JsSampleProcess: { nodes: 11, topLevel: 11, flows: 11, lanes: ['All Users', 'System'] },
    MyFirstProcess: { nodes: 26, topLevel: 19, flows: 23, lanes: ['All Users', 'System'] },
    MyProcess2: { nodes: 3, topLevel: 3, flows: 2, lanes: ['All Users', 'System'] },
  },
  // Process1 with an inline user task carrying a UCA message boundary event,
  // a script task and an intermediate timer.
  events: {
    Process1: { nodes: 6, topLevel: 6, flows: 5, lanes: ['MyTeam', 'System'] },
  },
};

describe.each(Object.entries(EXPORTS) as Array<[LocalTwx, Record<string, Expected>]>)('%s', (file, expected) => {
  describe.skipIf(!hasLocalTwx(file))('local export', () => {
    let pkg: ProcessPackage;
    const proc = (name: string): Process => {
      const p = pkg.processes.find((x) => x.name === name);
      if (!p) throw new Error(`process "${name}" not found`);
      return p;
    };

    it('reads every BPD with a diagram, sorted by name, without warnings', async () => {
      pkg = await readTwxPackage(localTwx(file));
      expect(pkg.processes.map((p) => p.name)).toEqual(
        Object.keys(expected).sort((a, b) => a.localeCompare(b)),
      );
      expect(pkg.warnings).toEqual([]);
      expect(pkg.processes.every((p) => p.originalId?.startsWith('25.'))).toBe(true);
    });

    it.each(Object.entries(expected))('%s: nodes, flows and lanes', (name, e) => {
      const p = proc(name);
      expect(p.nodes).toHaveLength(e.nodes);
      expect(p.nodes.filter((n) => n.parentId === undefined)).toHaveLength(e.topLevel);
      expect(p.flows).toHaveLength(e.flows);
      expect(p.lanes.map((l) => l.name)).toEqual(e.lanes);
      expect(p.nodes.filter((n) => n.kind === 'unknown')).toEqual([]);
    });

    it.each(Object.keys(expected))('%s: keeps the BAW positions of every top-level node', async (name) => {
      const p = proc(name);
      const top = p.nodes.filter((n) => n.parentId === undefined);
      expect(top.every((n) => n.bounds !== undefined)).toBe(true);
      // Every node lies in its own lane band (no "do not stack" warning).
      const layout = await layoutProcess(p);
      expect(layout.warnings.filter((w) => /bounds/.test(w))).toEqual([]);
      for (const n of top) expect(layout.shapes.get(n.id)).toEqual(n.bounds);

      // Lanes touch each other and the pool covers them exactly.
      for (let i = 1; i < layout.lanes.length; i++) {
        const above = layout.lanes[i - 1].bounds;
        expect(layout.lanes[i].bounds.y).toBe(above.y + above.height);
      }
      const last = layout.lanes[layout.lanes.length - 1].bounds;
      expect(layout.pool.y).toBe(layout.lanes[0].bounds.y);
      expect(layout.pool.y + layout.pool.height).toBe(last.y + last.height);
      for (const n of top) {
        const lane = layout.lanes.find((l) => l.id === n.laneId)!.bounds;
        const b = layout.shapes.get(n.id)!;
        expect(b.y, n.name).toBeGreaterThanOrEqual(lane.y);
        expect(b.y + b.height, n.name).toBeLessThanOrEqual(lane.y + lane.height);
      }
    });
  });
});

describe.skipIf(!hasLocalTwx('activities'))('BAW element mapping (activities, MyFirstProcess)', () => {
  it('maps BAW activity types onto the model kinds', async () => {
    const pkg = await readTwxPackage(localTwx('activities'));
    const p = pkg.processes.find((x) => x.name === 'MyFirstProcess')!;
    const kind = (name: string) => {
      const n = p.nodes.find((x) => x.name === name);
      if (!n) throw new Error(name);
      return `${n.kind} / ${n.originalType}`;
    };
    expect(kind('CSHS1')).toBe('userTask / callActivity (UserTask)');
    expect(kind('Service flow1')).toBe('task / callActivity (ServiceTask)');
    expect(kind('Set Parameter')).toBe('scriptTask / scriptTask');
    expect(kind('MyProcess2')).toBe('callActivity / callActivity (CalledProcess)');
    expect(kind('Sub1')).toBe('subProcess / subProcess');
    expect(kind('Event subprocess')).toBe('subProcess / subProcess (event)');
    expect(kind('Is 123?')).toBe('exclusiveGateway / exclusiveGateway');
    expect(kind('Boundary event')).toBe('intermediateEvent / boundaryEvent');
    expect(kind('Timer')).toBe('intermediateEvent / intermediateCatchEvent');

    const sub1 = p.nodes.find((n) => n.name === 'Sub1')!;
    expect(p.nodes.find((n) => n.name === 'Service flow2')!.parentId).toBe(sub1.id);

    // A linked process resolves to the BPD it calls.
    expect(p.nodes.find((n) => n.name === 'MyProcess2')!.calledElement).toMatchObject({
      id: '25.589625df-6d22-428c-bdf6-ccbe85ddc843',
      name: 'MyProcess2',
      kind: 'Process',
    });

    // A boundary event sits on the border of its activity (BAW's nodeVisualInfo).
    const host = p.nodes.find((n) => n.name === 'CSHS1')!.bounds!;
    const boundary = p.nodes.find((n) => n.name === 'Boundary event')!.bounds!;
    expect(boundary.y + boundary.height / 2).toBe(host.y + host.height);
  });
});
