// Cross test: the local export order-delivery-process.no-toolkits.twx is Bob's
// order-delivery-process.zip imported into IBM BAW and exported again (its
// toolkits removed). Both must give the same process. Ids differ (Bob
// "bpmnid-…", BAW "bpdid:…"), so everything is compared by name. Skipped
// when the export is not under test/fixtures/local/ (../localFixtures).

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { Process, ProcessPackage } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const REAL = hasLocalTwx('orderDelivery');

let bobPkg: ProcessPackage;
let twxPkg: ProcessPackage;
let bob: Process;
let twx: Process;

beforeAll(async () => {
  if (!REAL) return;
  bobPkg = await readProcessPackage(await readBpmnPackage(BOB));
  twxPkg = await readTwxPackage(localTwx('orderDelivery'));
  bob = bobPkg.processes[0];
  twx = twxPkg.processes[0];
});

/** "name -> kind" per node, sorted. */
const nodeSignature = (p: Process) => p.nodes.map((n) => `${n.name} -> ${n.kind}`).sort();

/** "source -> target (name)" per flow, sorted. */
function flowSignature(p: Process): string[] {
  const names = new Map(p.nodes.map((n) => [n.id, n.name]));
  return p.flows.map((f) => `${names.get(f.sourceId)} -> ${names.get(f.targetId)} (${f.name})`).sort();
}

describe.skipIf(!REAL)('order-delivery-process: Bob BPMN vs. BAW TWX round trip', () => {
  it('reads one BPD from the TWX, without warnings', () => {
    expect(twxPkg.processes).toHaveLength(1);
    expect(twx.name).toBe(bob.name);
    expect(twx.originalId).toBe('25.98749a22-2145-4dd0-897c-f2943c465813');
    expect(twx.id).toBe('id_25.98749a22-2145-4dd0-897c-f2943c465813');
    expect(twxPkg.warnings).toEqual([]);
    expect(twxPkg.source).toMatchObject({
      format: 'twx',
      exporter: 'IBM BAW',
      exporterVersion: '8.6.6.23020',
      twx: {
        app: 'order-delivery-process',
        snapshot: 'Initial Import 2',
        toolkits: ['System Data 8.6.0.0', 'UI Toolkit 8.6.0.0'],
        packedToolkits: 0,
      },
    });
  });

  it('has 14 nodes and 14 flows in both', () => {
    expect(bob.nodes).toHaveLength(14);
    expect(twx.nodes).toHaveLength(14);
    expect(bob.flows).toHaveLength(14);
    expect(twx.flows).toHaveLength(14);
  });

  it('has the same node names and kinds', () => {
    expect(nodeSignature(twx)).toEqual(nodeSignature(bob));
  });

  it('has the same flows between the same nodes', () => {
    expect(flowSignature(twx)).toEqual(flowSignature(bob));
  });

  it('has the same default flows', () => {
    const defaults = (p: Process) => p.flows.filter((f) => f.isDefault).map((f) => f.name).sort();
    expect(defaults(twx)).toEqual(['EXCEPTION', 'Invalid']);
    expect(defaults(twx)).toEqual(defaults(bob));
  });

  it('marks the system tasks as service flow calls, as Bob does', () => {
    const services = (p: Process) =>
      p.nodes
        .filter((n) => n.serviceType !== undefined)
        .map((n) => `${n.name}: ${n.serviceType}`)
        .sort();
    expect(services(twx)).toEqual(services(bob));
  });

  it('has the same lanes with nodes; the empty one comes back as "Participant"', () => {
    const withNodes = (p: Process) => p.lanes.filter((l) => l.nodeIds.length > 0).map((l) => l.name);
    expect(withNodes(twx)).toEqual(['System', 'Order Manager', 'Compliance Reviewer', 'Operations Team']);
    expect(withNodes(twx)).toEqual(withNodes(bob));
    // Bob's empty Customer lane: BAW keeps it as an empty lane named "Participant" (BPMN2 laneSet only).
    expect(twx.lanes.filter((l) => l.nodeIds.length === 0).map((l) => l.name)).toEqual(['Participant']);
    expect(bob.lanes.filter((l) => l.nodeIds.length === 0).map((l) => l.name)).toEqual(['Customer']);

    const laneOf = (p: Process) => {
      const laneName = new Map(p.lanes.map((l) => [l.id, l.name]));
      return p.nodes.map((n) => `${n.name} @ ${laneName.get(n.laneId ?? '')}`).sort();
    };
    expect(laneOf(twx)).toEqual(laneOf(bob));
  });

  it('has the same performers of the user tasks', () => {
    const performers = (p: Process) =>
      Object.fromEntries(p.nodes.filter((n) => n.kind === 'userTask').map((n) => [n.name, n.performer]));
    expect(performers(twx)).toEqual(performers(bob));
  });

  it('has the same documentation text', () => {
    expect(twx.documentation).toBe(bob.documentation);
    const docs = (p: Process) => Object.fromEntries(p.nodes.map((n) => [n.name, n.documentation]));
    expect(docs(twx)).toEqual(docs(bob));
  });

  it('reads the order input of every activity, typed with the business object', () => {
    const inputs = (p: Process) =>
      p.nodes
        .filter((n) => n.inputs.length > 0)
        .map((n) => `${n.name}: ${n.inputs.map((i) => `${i.name}:${i.typeName}`).join(',')}`)
        .sort();
    expect(inputs(twx)).toEqual(inputs(bob));
    expect(twxPkg.dataTypes.map((t) => t.name)).toEqual(['OrderRequest']);
    expect(twxPkg.dataTypes[0].fields.map((f) => f.name)).toEqual(bobPkg.dataTypes[0].fields.map((f) => f.name));
  });

  it('loses the gateway conditions in BAW (known import behaviour)', () => {
    const conditions = (p: Process) => p.flows.filter((f) => f.condition !== undefined).length;
    expect(conditions(bob)).toBe(4);
    expect(conditions(twx)).toBe(0);
  });

  it('resolves the services the call activities call', () => {
    const validate = twx.nodes.find((n) => n.name === 'Validate Order SF')!;
    expect(validate.calledElement).toMatchObject({
      id: '1.bebd697e-4cba-4ea8-b26a-a3c6e9255375',
      name: 'Order Delivery Process_Validate Order SF',
      kind: 'Service flow',
    });
    const approval = twx.nodes.find((n) => n.name === 'Manager Approval')!;
    expect(approval.calledElement).toMatchObject({ kind: 'Client-side human service, generated' });
  });

  it('places every node as in the BAW diagram', () => {
    expect(twx.nodes.every((n) => n.bounds !== undefined)).toBe(true);
    const at = (name: string) => twx.nodes.find((n) => n.name === name)!.bounds;
    // System lane (height 530): location as written.
    expect(at('Validate Order SF')).toEqual({ x: 158, y: 432, width: 95, height: 70 });
    expect(at('Order Submitted')).toEqual({ x: 53, y: 452, width: 24, height: 24 });
    expect(at('Route Order')).toEqual({ x: 649, y: 347, width: 32, height: 32 });
    // Lanes below: the heights of the lanes above are added (530, then 130 each).
    expect(at('Manager Approval')).toEqual({ x: 758, y: 530 + 32, width: 95, height: 70 });
    expect(at('Compliance Review')).toEqual({ x: 758, y: 660 + 32, width: 95, height: 70 });
    expect(at('Handle Exception')).toEqual({ x: 758, y: 790 + 32, width: 95, height: 70 });
  });
});
