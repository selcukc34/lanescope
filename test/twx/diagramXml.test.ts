// Regression: BAW ids ("25.…", "bpdid:…:-68b1") are not valid XML ids, and
// bpmn-moddle dropped the whole <bpmn:process>, so bpmn-js drew an empty
// pool. The diagram XML of every BPD of the TWX fixtures must read back
// without warnings, with a shape inside its own lane for every drawn node.

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import { describe, expect, it } from 'vitest';
import { isXmlId, XmlIdMap } from '../../src/model/ids';
import type { Bounds } from '../../src/model/model';
import { toDiagramXml } from '../../src/bpmn/toDiagramXml';
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

describe.each(cases)('%s', (_label, process) => {
  it('gives diagram XML that bpmn-moddle reads without warnings, every node in its lane', async () => {
    const { xml, layout } = await toDiagramXml(process);
    const result = await BpmnModdle().fromXML(xml);
    expect(result.warnings.map((w) => w.message.split('\n')[0])).toEqual([]);

    const ids = Object.keys(result.elementsById);
    expect(ids.every(isXmlId)).toBe(true);
    expect(result.elementsById[process.id]?.$type).toBe('bpmn:Process');

    const shapes = new Map<string, Bounds>();
    const plane = (result.rootElement.diagrams as ModdleElement[])[0].plane as ModdleElement;
    for (const di of plane.planeElement as ModdleElement[]) {
      if (di.$type !== 'bpmndi:BPMNShape') continue;
      const el = di.bpmnElement as ModdleElement | undefined;
      expect(el, 'every shape resolves to a model element').toBeDefined();
      const b = di.bounds as ModdleElement;
      shapes.set(String(el!.id), { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) });
    }

    const drawn = process.nodes.filter((n) => !layout.hiddenNodeIds.has(n.id));
    expect(drawn.length).toBeGreaterThan(0);
    for (const node of drawn) {
      const shape = shapes.get(node.id);
      expect(shape, `shape of "${node.name}"`).toBeDefined();
      const lane = shapes.get(node.laneId!);
      expect(lane, `lane shape of "${node.name}"`).toBeDefined();
      expect(shape!.y, node.name).toBeGreaterThanOrEqual(lane!.y);
      expect(shape!.y + shape!.height, node.name).toBeLessThanOrEqual(lane!.y + lane!.height);
      expect(shape!.x, node.name).toBeGreaterThanOrEqual(lane!.x);
      expect(shape!.x + shape!.width, node.name).toBeLessThanOrEqual(lane!.x + lane!.width);
    }
    for (const lane of process.lanes) {
      if (lane.nodeIds.length > 0) expect(shapes.has(lane.id), `lane "${lane.name}"`).toBe(true);
    }
  });

  it('keeps the BAW ids as originalId', () => {
    for (const el of [process, ...process.lanes, ...process.nodes, ...process.flows]) {
      expect(isXmlId(el.id)).toBe(true);
      if (el.originalId !== undefined) expect(el.originalId).not.toBe(el.id);
    }
    expect(process.originalId).toMatch(/^25\./);
  });
});

describe('XmlIdMap', () => {
  it('keeps valid ids and maps the others to unique, stable XML ids', () => {
    const ids = new XmlIdMap();
    ids.reserve(['Task_1', 'bpdid_a_-1']);
    expect(ids.get('Task_1')).toBe('Task_1');
    expect(ids.get('25.98749a22-2145')).toBe('id_25.98749a22-2145');
    expect(ids.get('bpdid:a:-1')).toBe('bpdid_a_-1_2');
    expect(ids.get('bpdid:a:-1')).toBe('bpdid_a_-1_2');
    expect(ids.get('-x')).toBe('id_-x');
  });
});
