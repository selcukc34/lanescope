import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { FlowNode, Process, ProcessPackage } from '../../src/model/model';

const FIXTURE = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');

let pkg: ProcessPackage;
let process: Process;

const byName = (name: string): FlowNode => {
  const node = process.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`node "${name}" not found`);
  return node;
};
const flowByName = (name: string) => {
  const flow = process.flows.find((f) => f.name === name);
  if (!flow) throw new Error(`flow "${name}" not found`);
  return flow;
};

beforeAll(async () => {
  pkg = await readProcessPackage(await readBpmnPackage(FIXTURE));
  process = pkg.processes[0];
});

describe('Bob order-delivery-process.zip', () => {
  it('reads the package source', () => {
    expect(pkg.source).toMatchObject({
      path: FIXTURE,
      format: 'zip',
      bpmnFile: 'order-delivery-process.bpmn',
      xsdFiles: ['order-delivery-process.xsd'],
      exporter: 'generate-baw-bpmn',
      exporterVersion: '1.0.0',
    });
    // The XSD referenced by bpmn:import is present, so no "not found" warning.
    expect(pkg.warnings.filter((w) => w.includes('not found'))).toEqual([]);
  });

  it('has one process with documentation', () => {
    expect(pkg.processes).toHaveLength(1);
    expect(process.name).toBe('Order Delivery Process');
    expect(process.documentation).toMatch(/^A customer submits an order/);
  });

  it('has the expected node and flow counts', () => {
    const count = (kind: FlowNode['kind']) => process.nodes.filter((n) => n.kind === kind).length;
    expect(process.nodes).toHaveLength(14);
    expect(count('startEvent')).toBe(1);
    expect(count('task')).toBe(4);
    expect(count('userTask')).toBe(3);
    expect(count('exclusiveGateway')).toBe(2);
    expect(count('endEvent')).toBe(4);
    expect(count('unknown')).toBe(0);
    expect(process.flows).toHaveLength(14);
  });

  it('marks the four tasks as ServiceFlow service steps', () => {
    const tasks = process.nodes.filter((n) => n.kind === 'task');
    expect(tasks.map((t) => t.name)).toEqual([
      'Validate Order SF',
      'Lookup Country Info SF',
      'Determine Order Route SF',
      'Auto Complete Order SF',
    ]);
    for (const t of tasks) {
      expect(t.originalType).toBe('bpmn:Task');
      expect(t.serviceType).toBe('ServiceFlow');
    }
    expect(process.nodes.filter((n) => n.kind !== 'task').every((n) => n.serviceType === undefined)).toBe(true);
  });

  it('reads documentation on every node', () => {
    for (const node of process.nodes) {
      expect(node.documentation, node.name).toBeTruthy();
    }
    expect(byName('Determine Order Route SF').documentation).toContain('amount > 10000');
  });

  it('reads lanes and their members', () => {
    const lanes = Object.fromEntries(process.lanes.map((l) => [l.name, l]));
    expect(process.lanes.map((l) => l.name)).toEqual([
      'Customer',
      'System',
      'Order Manager',
      'Compliance Reviewer',
      'Operations Team',
    ]);
    expect(lanes['Customer'].nodeIds).toEqual([]);
    expect(lanes['System'].nodeIds).toHaveLength(11);
    expect(lanes['Order Manager'].nodeIds).toEqual([byName('Manager Approval').id]);
    expect(lanes['Compliance Reviewer'].nodeIds).toEqual([byName('Compliance Review').id]);
    expect(lanes['Operations Team'].nodeIds).toEqual([byName('Handle Exception').id]);

    // Every node belongs to exactly one lane, and laneId agrees with the lane lists.
    for (const node of process.nodes) {
      const owner = process.lanes.filter((l) => l.nodeIds.includes(node.id));
      expect(owner, node.name).toHaveLength(1);
      expect(node.laneId).toBe(owner[0].id);
    }
    expect(byName('Order Submitted').laneId).toBe(lanes['System'].id);
  });

  it('reads performers of user tasks', () => {
    const performers = Object.fromEntries(
      process.nodes.filter((n) => n.kind === 'userTask').map((n) => [n.name, n.performer]),
    );
    expect(performers).toEqual({
      'Manager Approval': 'Order Manager',
      'Compliance Review': 'Compliance Reviewer',
      'Handle Exception': 'Operations Team',
    });
  });

  it('reads default flows of both gateways', () => {
    const defaults = process.flows.filter((f) => f.isDefault);
    expect(defaults.map((f) => f.name).sort()).toEqual(['EXCEPTION', 'Invalid']);
    expect(flowByName('Invalid')).toMatchObject({
      sourceId: byName('Validation Passed?').id,
      targetId: byName('Determine Order Route SF').id,
      isDefault: true,
    });
    expect(flowByName('Invalid').condition).toBeUndefined();
    expect(flowByName('Valid')).toMatchObject({
      condition: 'tw.local.order.route != "EXCEPTION"',
      isDefault: false,
    });
  });

  it('reads the four route branches of "Route Order"', () => {
    const gateway = byName('Route Order');
    const routes = process.flows.filter((f) => f.sourceId === gateway.id);
    expect(routes).toHaveLength(4);
    const summary = Object.fromEntries(
      routes.map((f) => [
        f.name,
        { target: process.nodes.find((n) => n.id === f.targetId)?.name, condition: f.condition, isDefault: f.isDefault },
      ]),
    );
    expect(summary).toEqual({
      AUTO_APPROVE: {
        target: 'Auto Complete Order SF',
        condition: 'tw.local.order.route == "AUTO_APPROVE"',
        isDefault: false,
      },
      MANAGER_APPROVAL: {
        target: 'Manager Approval',
        condition: 'tw.local.order.route == "MANAGER_APPROVAL"',
        isDefault: false,
      },
      COMPLIANCE_REVIEW: {
        target: 'Compliance Review',
        condition: 'tw.local.order.route == "COMPLIANCE_REVIEW"',
        isDefault: false,
      },
      // EXCEPTION has no conditionExpression; it is the gateway's default flow.
      EXCEPTION: { target: 'Handle Exception', condition: undefined, isDefault: true },
    });
  });

  it('connects every flow to known nodes', () => {
    const ids = new Set(process.nodes.map((n) => n.id));
    for (const f of process.flows) {
      expect(ids.has(f.sourceId), f.name).toBe(true);
      expect(ids.has(f.targetId), f.name).toBe(true);
    }
  });

  it('reads the "order" data input of every activity', () => {
    const activities = process.nodes.filter((n) => n.kind === 'task' || n.kind === 'userTask');
    expect(activities).toHaveLength(7);
    for (const a of activities) {
      expect(a.inputs, a.name).toHaveLength(1);
      expect(a.inputs[0]).toMatchObject({
        name: 'order',
        typeRef: 'bo:OrderRequest',
        typeName: 'OrderRequest',
        isCollection: false,
      });
      expect(a.outputs).toEqual([]);
    }
    const typeNames = new Set(pkg.dataTypes.map((t) => t.name));
    expect(typeNames.has(activities[0].inputs[0].typeName!)).toBe(true);
  });

  it('has no diagram bounds (no bpmndi section)', () => {
    expect(process.nodes.every((n) => n.bounds === undefined)).toBe(true);
  });

  it('reads OrderRequest from the XSD', () => {
    expect(pkg.dataTypes).toHaveLength(1);
    const order = pkg.dataTypes[0];
    expect(order.name).toBe('OrderRequest');
    expect(order.namespace).toBe('http://Bob%20Order%20Delivery%20Demo/BusinessObjects');
    expect(order.documentation).toMatch(/^Primary order entity\./);
    expect(order.fields).toHaveLength(11);
    expect(order.fields.filter((f) => f.required).map((f) => f.name)).toEqual([
      'orderId',
      'customerId',
      'amount',
      'countryCode',
    ]);
    expect(order.fields.every((f) => !f.list)).toBe(true);
    const types = Object.fromEntries(order.fields.map((f) => [f.name, f.type]));
    expect(types).toMatchObject({ amount: 'decimal', requiresApproval: 'boolean', orderId: 'string' });
  });
});

describe('reading the fixture as a plain .bpmn file', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bob-bpmn-'));
    const zip = await JSZip.loadAsync(await readFile(FIXTURE));
    for (const name of ['order-delivery-process.bpmn', 'order-delivery-process.xsd']) {
      await writeFile(path.join(dir, name), await zip.file(name)!.async('uint8array'));
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('picks up the sibling XSD and gives the same model', async () => {
    const input = await readBpmnPackage(path.join(dir, 'order-delivery-process.bpmn'));
    expect(input.format).toBe('bpmn');
    expect(Object.keys(input.xsdFiles)).toEqual(['order-delivery-process.xsd']);
    const fromFile = await readProcessPackage(input);
    expect(fromFile.processes).toEqual(pkg.processes);
    expect(fromFile.dataTypes).toEqual(pkg.dataTypes);
  });
});
