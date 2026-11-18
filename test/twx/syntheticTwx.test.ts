// The TWX readers on the synthetic export of ../syntheticTwx: runs everywhere,
// with or without the real exports under test/fixtures/local/.

import { beforeAll, describe, expect, it } from 'vitest';
import { layoutProcess } from '../../src/bpmn/layout';
import type { CalleeStep, Process, ProcessPackage } from '../../src/model/model';
import { readServiceDiagram } from '../../src/twx/serviceReader';
import { TwxResolver } from '../../src/twx/resolver';
import { readPackageXml } from '../../src/twx/packageXml';
import {
  BPD_ID,
  DISCOUNT_SERVICE_ID,
  PRICE_SERVICE_ID,
  syntheticTwxArchive,
  syntheticTwxPackage,
} from '../syntheticTwx';

let pkg: ProcessPackage;
let bpd: Process;
const node = (name: string) => {
  const n = bpd.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node "${name}" not found`);
  return n;
};

beforeAll(async () => {
  pkg = await syntheticTwxPackage();
  bpd = pkg.processes[0];
});

describe('synthetic TWX: archive and package.xml', () => {
  it('reads package.xml and the BPD and service objects', async () => {
    const archive = await syntheticTwxArchive();
    expect([...archive.objects.keys()].sort()).toEqual([DISCOUNT_SERVICE_ID, PRICE_SERVICE_ID, BPD_ID].sort());
    expect(archive.toolkitEntries).toEqual([]);
    expect(archive.warnings).toEqual([]);
    const info = readPackageXml(archive.packageXml!);
    expect(info.project.name).toBe('Synthetic App');
    expect(info.snapshot).toBe('1.0');
    expect(info.buildVersion).toBe('8.6.6');
  });

  it('describes the source', () => {
    expect(pkg.warnings).toEqual([]);
    expect(pkg.source).toMatchObject({
      format: 'twx',
      exporter: 'IBM BAW',
      twx: { app: 'Synthetic App', snapshot: '1.0', toolkits: [], packedToolkits: 0 },
    });
  });
});

describe('synthetic TWX: BPD', () => {
  it('reads the one BPD with its lanes, nodes and flows', () => {
    expect(pkg.processes.map((p) => p.name)).toEqual(['Synthetic Order']);
    expect(bpd.originalId).toBe(BPD_ID);
    expect(bpd.documentation).toBe('Reviews an order and approves or rejects it.');
    expect(bpd.lanes.map((l) => l.name)).toEqual(['Customer', 'System']);
    expect(bpd.nodes.map((n) => [n.name, n.kind])).toEqual([
      ['Start', 'startEvent'],
      ['Review Order', 'task'],
      ['Approved?', 'exclusiveGateway'],
      ['Done', 'endEvent'],
      ['Rejected', 'endEvent'],
    ]);
    expect(bpd.flows).toHaveLength(4);
    const lane = (id: string | undefined) => bpd.lanes.find((l) => l.id === id)?.name;
    expect(lane(node('Start').laneId)).toBe('Customer');
    expect(lane(node('Review Order').laneId)).toBe('Customer');
    expect(lane(node('Approved?').laneId)).toBe('System');
  });

  it('stacks the lanes by their <height> and places nodes relative to their lane', () => {
    expect(bpd.lanes.map((l) => l.bounds)).toEqual([
      { x: 0, y: 0, width: 900, height: 200 },
      { x: 0, y: 200, width: 900, height: 160 },
    ]);
    expect(node('Review Order').bounds).toEqual({ x: 180, y: 60, width: 95, height: 70 });
    expect(node('Approved?').bounds).toEqual({ x: 400, y: 260, width: 32, height: 32 });
    expect(node('Rejected').bounds).toEqual({ x: 560, y: 300, width: 24, height: 24 });
  });

  it('keeps the BAW positions in the layout', async () => {
    const layout = await layoutProcess(bpd);
    for (const n of bpd.nodes) expect(layout.shapes.get(n.id), n.name).toEqual(n.bounds);
    expect(layout.lanes.map((l) => [l.name, l.bounds.y])).toEqual([
      ['Customer', 0],
      ['System', 200],
    ]);
    expect(layout.lanes[0].bounds.height).toBe(200);
  });

  it('reads gateway conditions, the default flow and the ports', () => {
    const flow = (name: string) => bpd.flows.find((f) => f.name === name)!;
    expect(flow('yes')).toMatchObject({ condition: 'tw.local.approved == true', isDefault: false });
    expect(flow('no')).toMatchObject({ isDefault: true, sourcePort: { side: 'bottom', offset: 0.5 } });
    expect(bpd.flows.every((f) => f.sourcePort && f.targetPort)).toBe(true);
  });

  it('resolves the called service flow and its signature', () => {
    const task = node('Review Order');
    expect(task.originalType).toBe('callActivity (ServiceTask)');
    expect(task.serviceType).toBe('ServiceFlow');
    expect(task.calledElement).toMatchObject({ id: PRICE_SERVICE_ID, name: 'Price Order', kind: 'Service flow' });
    expect(task.inputs.map((p) => [p.name, p.typeName])).toEqual([['amount', 'Decimal']]);
    expect(task.outputs.map((p) => [p.name, p.typeName])).toEqual([['total', 'Decimal']]);
    expect(task.inputMappings).toEqual([{ parameterId: '2055.amount', parameter: 'amount', mapped: false, literal: false }]);
  });
});

describe('synthetic TWX: service flow', () => {
  const steps = (): CalleeStep[] => node('Review Order').calledElement!.internals!.steps;

  it('reads the steps of the called service in flow order', () => {
    expect(steps().map((s) => [s.kind, s.name])).toEqual([
      ['start', 'Start'],
      ['script', 'Compute Total'],
      ['call', 'Call Discount'],
      ['gateway', 'Has Total?'],
      ['end', 'Priced'],
      ['end', 'Unpriced'],
    ]);
    expect(node('Review Order').calledElement!.internals!.variables?.map((v) => [v.name, v.typeName])).toEqual([
      ['discount', 'Decimal'],
    ]);
  });

  it('reads the script, the call and the gateway conditions as written', () => {
    const [, script, call, gateway] = steps();
    expect(script.script).toEqual({ language: 'text/x-javascript', text: 'tw.local.total = tw.local.amount * 1.2;' });
    expect(call).toMatchObject({ calledId: DISCOUNT_SERVICE_ID, calledName: 'Apply Discount', calledKind: 'Service flow' });
    expect(gateway.conditions).toEqual([
      { to: 'Priced', condition: 'tw.local.total\t>\t0', isDefault: false },
      { to: 'Unpriced', isDefault: true },
    ]);
  });

  it('opens the service as a diagram with the positions of nodeVisualInfo', async () => {
    expect(pkg.calleeDiagrams!.openability(PRICE_SERVICE_ID)).toEqual({ openable: true });
    const diagram = await pkg.calleeDiagrams!.read(PRICE_SERVICE_ID);
    expect(diagram?.warnings).toEqual([]);
    const p = diagram!.process;
    expect(p.name).toBe('Price Order');
    expect(p.source).toEqual({ kind: 'serviceFlow', processType: '12' });
    expect(p.lanes).toEqual([]);
    expect(p.nodes.map((n) => [n.name, n.kind])).toEqual([
      ['Start', 'startEvent'],
      ['Compute Total', 'scriptTask'],
      ['Call Discount', 'callActivity'],
      ['Has Total?', 'exclusiveGateway'],
      ['Priced', 'endEvent'],
      ['Unpriced', 'endEvent'],
    ]);
    expect(p.nodes.find((n) => n.name === 'Compute Total')!.bounds).toEqual({ x: 120, y: 80, width: 95, height: 70 });
    expect(p.flows).toHaveLength(5);
  });

  it('takes the positions from the classic model when nodeVisualInfo is missing', async () => {
    const archive = await syntheticTwxArchive();
    const resolver = new TwxResolver(archive.objects, readPackageXml(archive.packageXml!));
    const p = readServiceDiagram(DISCOUNT_SERVICE_ID, resolver)!;
    expect(p.nodes.map((n) => [n.name, n.bounds?.x, n.bounds?.y])).toEqual([
      ['Start', 40, 60],
      ['End', 200, 60],
    ]);
  });
});
