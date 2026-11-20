// checkTrace: Bob's Order Delivery Process against the description Bob built
// it from, edits of that description, matching rules, and the same check on
// the BAW export of the app when it is on this machine.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { FlowNode, ProcessPackage } from '../../src/model/model';
import { parseDescription } from '../../src/trace/description';
import { checkTrace, matchLevel, normalizeName, traceSummary, type TraceRow } from '../../src/trace/trace';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '..', 'fixtures', 'bob');
const DESCRIPTION = readFileSync(path.join(BOB, 'order-delivery-process-description.md'), 'utf8');

let bob: ProcessPackage;
beforeAll(async () => {
  bob = await readProcessPackage(await readBpmnPackage(path.join(BOB, 'order-delivery-process.zip')));
});

/** kind · text · status · matched name: what a row says, without ids. */
const brief = (r: TraceRow) => [r.kind, r.text, r.status, r.target && r.target.type !== 'field' ? r.target.name : undefined];

const nodeId = (pkg: ProcessPackage, name: string) => pkg.processes[0].nodes.find((n) => n.name === name)!.id;

describe('checkTrace: Bob output against its description', () => {
  it('gives the expected checklist, row by row', () => {
    const result = checkTrace(parseDescription(DESCRIPTION), bob);
    const rows = result.rows;
    expect(rows.filter((r) => r.kind === 'step').map(brief)).toEqual([
      ['step', 'Submit Order', 'near', 'Order Submitted'],
      ['step', 'Validate Order', 'near', 'Validate Order SF'],
      ['step', 'Lookup Country Info', 'near', 'Lookup Country Info SF'],
      ['step', 'Determine Order Route', 'near', 'Determine Order Route SF'],
      ['step', 'Route Order', 'matched', 'Route Order'],
      ['step', 'Auto Complete Order', 'near', 'Auto Complete Order SF'],
      ['step', 'Manager Approval', 'matched', 'Manager Approval'],
      ['step', 'Compliance Review', 'matched', 'Compliance Review'],
      ['step', 'Handle Exception', 'matched', 'Handle Exception'],
    ]);
    expect(rows.find((r) => r.text === 'Submit Order')!.note).toBe("same words in another order: start event 'Order Submitted'");
    expect(rows.find((r) => r.text === 'Route Order')!.note).toBe('gateway');

    const paths = rows.filter((r) => r.kind === 'gateway-path');
    expect(paths.map(brief)).toEqual([
      ['gateway-path', 'AUTO_APPROVE', 'matched', 'AUTO_APPROVE'],
      ['gateway-path', 'MANAGER_APPROVAL', 'matched', 'MANAGER_APPROVAL'],
      ['gateway-path', 'COMPLIANCE_REVIEW', 'matched', 'COMPLIANCE_REVIEW'],
      ['gateway-path', 'EXCEPTION', 'matched', 'EXCEPTION'],
    ]);
    expect(paths.every((r) => r.note === "outgoing flow of gateway 'Route Order'")).toBe(true);
    expect(paths[0].group).toBe('Gateway paths · after Determine Order Route');

    const fields = rows.filter((r) => r.kind === 'bo-field');
    expect(fields).toHaveLength(11);
    expect(fields.every((r) => r.status === 'matched' && r.target?.type === 'field' && r.target.dataType === 'OrderRequest')).toBe(true);

    const taskFields = rows.filter((r) => r.kind === 'task-field');
    expect(taskFields).toHaveLength(17);
    expect(taskFields.every((r) => r.status === 'unchecked' && r.note === 'the process does not define task fields')).toBe(true);
    // A task field row still selects its task.
    expect(taskFields[0].target).toMatchObject({ type: 'node', name: 'Manager Approval' });

    // The only extra: the validation gateway. No end event, no start event is listed.
    expect(rows.filter((r) => r.status === 'extra').map(brief)).toEqual([['extra-node', 'Validation Passed?', 'extra', 'Validation Passed?']]);
    expect(rows.some((r) => /^Order (Auto Approved|Manager Reviewed|Compliance Reviewed)$|^Exception Handled$/.test(r.text))).toBe(false);

    expect(result.counts).toEqual({ matched: 19, near: 5, missing: 0, unchecked: 17, extra: 1, described: 41 });
    expect(traceSummary(result.counts)).toBe('19 of 41 matched · 5 near · 0 missing · 17 unchecked · 1 extra');
    expect(result.notChecked).toEqual(['Business scenario', 'Validation rules', 'Country lookup', 'Routing rules', 'Expected output']);
  });

  it('points rows at node, flow and field ids of the process', () => {
    const rows = checkTrace(parseDescription(DESCRIPTION), bob).rows;
    expect(rows.find((r) => r.text === 'Validate Order')!.target).toEqual({
      type: 'node',
      id: nodeId(bob, 'Validate Order SF'),
      name: 'Validate Order SF',
      subProcessLevels: [],
    });
    const flow = bob.processes[0].flows.find((f) => f.name === 'EXCEPTION')!;
    expect(rows.find((r) => r.text === 'EXCEPTION')!.target).toEqual({ type: 'flow', id: flow.id, name: 'EXCEPTION', subProcessLevels: [] });
    expect(rows.find((r) => r.text === 'route')!.target).toEqual({ type: 'field', dataType: 'OrderRequest', name: 'route' });
  });

  it('reports a step the process does not have as missing', () => {
    const md = DESCRIPTION.replace('9. Handle Exception', '9. Handle Exception\n10. Ship Order');
    const rows = checkTrace(parseDescription(md), bob).rows;
    expect(rows.find((r) => r.text === 'Ship Order')).toMatchObject({ kind: 'step', status: 'missing', note: 'no activity, gateway or event has this name' });
    expect(checkTrace(parseDescription(md), bob).counts.missing).toBe(1);
  });

  it('reports an outgoing flow the description leaves out as extra', () => {
    const md = DESCRIPTION.replace('- COMPLIANCE_REVIEW\n', '');
    const rows = checkTrace(parseDescription(md), bob).rows.filter((r) => r.kind === 'gateway-path');
    expect(rows.map((r) => [r.text, r.status])).toEqual([
      ['AUTO_APPROVE', 'matched'],
      ['MANAGER_APPROVAL', 'matched'],
      ['EXCEPTION', 'matched'],
      ['COMPLIANCE_REVIEW', 'extra'],
    ]);
    expect(rows[3].note).toBe("outgoing flow of gateway 'Route Order' that no path names");
  });

  it('reports fields of the business object the description does not list as extra, and unknown ones as missing', () => {
    const md = DESCRIPTION.replace('- route\n', '').replace('- status\n', '- state\n');
    const rows = checkTrace(parseDescription(md), bob).rows.filter((r) => r.kind === 'bo-field');
    expect(rows.filter((r) => r.status !== 'matched').map((r) => [r.text, r.status])).toEqual([
      ['state', 'missing'],
      ['route', 'extra'],
      ['status', 'extra'],
    ]);
  });

  it('finds the gateway by its path names when the description does not say where it is', () => {
    const md = DESCRIPTION.replace('The gateway after Determine Order Route should have four outgoing paths:', 'Four outgoing paths:');
    const rows = checkTrace(parseDescription(md), bob).rows.filter((r) => r.kind === 'gateway-path');
    expect(rows.map((r) => r.status)).toEqual(['matched', 'matched', 'matched', 'matched']);
    expect(rows[0].group).toBe('Gateway paths');
  });

  it('matches a path by the string literal of a condition when the flow has no such name', () => {
    const pkg = structuredClone(bob);
    const flow = pkg.processes[0].flows.find((f) => f.name === 'MANAGER_APPROVAL')!;
    flow.name = 'High value';
    const row = checkTrace(parseDescription(DESCRIPTION), pkg).rows.find((r) => r.text === 'MANAGER_APPROVAL')!;
    expect(row).toMatchObject({ status: 'near', note: "named in the condition of flow 'High value' of gateway 'Route Order'" });
  });

  it('reports every path missing when no gateway follows the named step', () => {
    const md = DESCRIPTION.replace('after Determine Order Route', 'after Ship Order');
    const rows = checkTrace(parseDescription(md), bob).rows.filter((r) => r.kind === 'gateway-path');
    expect(rows.map((r) => [r.status, r.note])).toEqual(Array(4).fill(['missing', "no step is named 'Ship Order'"]));
  });

  it('lists no extra nodes when the description has no steps', () => {
    const rows = checkTrace(parseDescription('## Business object\n\nOrderRequest:\n\n- orderId\n'), bob).rows;
    expect(rows.some((r) => r.kind === 'extra-node')).toBe(false);
  });
});

describe('checkTrace matching rules', () => {
  it('normalises case, separators, punctuation and technical suffixes', () => {
    expect(normalizeName('Validate Order SF')).toBe('validate order');
    expect(normalizeName('auto_approve')).toBe('auto approve');
    expect(normalizeName('Check-Stock Service')).toBe('check stock');
    expect(normalizeName('Review Task')).toBe('review');
    expect(normalizeName('Validation Passed?')).toBe('validation passed');
    expect(matchLevel('Route Order', 'Route Order')).toBe('exact');
    expect(matchLevel('route order', 'Route Order')).toBe('normalized');
    expect(matchLevel('Submit Order', 'Order Submitted')).toBe('words');
    expect(matchLevel('Approve Order', 'Order Approved')).toBe('words');
    expect(matchLevel('Validate Order', 'Validation Passed?')).toBeUndefined();
  });

  it('takes each node for one step only, the exact match first', () => {
    const pkg = structuredClone(bob);
    const md = '## Steps\n- route order\n- Route Order\n';
    const rows = checkTrace(parseDescription(md), pkg).rows.filter((r) => r.kind === 'step');
    expect(rows.map((r) => [r.text, r.status])).toEqual([
      ['route order', 'missing'],
      ['Route Order', 'matched'],
    ]);
  });

  it('matches a step to a node inside a sub-process and names the levels to open', () => {
    const pkg = structuredClone(bob);
    const p = pkg.processes[0];
    const sub: FlowNode = { id: 'ship', name: 'Shipping', kind: 'subProcess', originalType: 'bpmn:SubProcess', inputs: [], outputs: [] };
    const inner: FlowNode = { id: 'pack', name: 'Pack Parcel', kind: 'task', originalType: 'bpmn:Task', inputs: [], outputs: [], parentId: 'ship' };
    p.nodes.push(sub, inner);
    const rows = checkTrace(parseDescription(`${DESCRIPTION}\n## More steps\n- Pack Parcel\n`), pkg).rows;
    expect(rows.find((r) => r.text === 'Pack Parcel')).toMatchObject({
      status: 'matched',
      note: 'activity (inside a sub-process)',
      target: { type: 'node', id: 'pack', subProcessLevels: ['sub:ship'] },
    });
    // The sub-process is extra (the description does not name it); its inside never is.
    expect(rows.filter((r) => r.kind === 'extra-node').map((r) => r.text)).toEqual(['Validation Passed?', 'Shipping']);
  });

  it('compares task fields with the bindings of the coach controls of the human service a task calls', () => {
    const pkg = structuredClone(bob);
    const task = pkg.processes[0].nodes.find((n) => n.name === 'Manager Approval')!;
    task.calledElement = {
      id: '1.x',
      internals: {
        steps: [],
        flows: [],
        coaches: [
          {
            id: 'c',
            name: 'Approve',
            controls: [
              { id: 'a', binding: 'tw.local.order.orderId' },
              { id: 'b', binding: 'tw.local.order.Amount' },
              { id: 'c', binding: 'tw.local.order.priority' },
              { id: 'd' },
            ],
          },
        ],
      },
    };
    const rows = checkTrace(parseDescription(DESCRIPTION), pkg).rows.filter((r) => r.group === 'Human tasks · Manager Approval');
    expect(rows.map((r) => [r.text, r.status])).toEqual([
      ['orderId', 'matched'],
      ['customerId', 'missing'],
      ['amount', 'near'],
      ['countryName', 'missing'],
      ['countryRegion', 'missing'],
      ['decisionReason', 'missing'],
      ['priority', 'extra'],
    ]);
  });
});

describe.skipIf(!hasLocalTwx('orderDelivery'))('checkTrace: the BAW export of the app (local fixture)', () => {
  it('matches the steps and the paths by flow names (the import leaves no conditions)', async () => {
    const pkg = await readTwxPackage(localTwx('orderDelivery'));
    const result = checkTrace(parseDescription(DESCRIPTION), pkg);
    const status = (kind: TraceRow['kind']) => result.rows.filter((r) => r.kind === kind).map((r) => [r.text, r.status]);
    expect(status('step')).toEqual([
      ['Submit Order', 'near'],
      ['Validate Order', 'near'],
      ['Lookup Country Info', 'near'],
      ['Determine Order Route', 'near'],
      ['Route Order', 'matched'],
      ['Auto Complete Order', 'near'],
      ['Manager Approval', 'matched'],
      ['Compliance Review', 'matched'],
      ['Handle Exception', 'matched'],
    ]);
    expect(status('gateway-path').map(([, s]) => s)).toEqual(['matched', 'matched', 'matched', 'matched']);
    expect(status('bo-field').every(([, s]) => s === 'matched')).toBe(true);
    // The coaches of the human services bind no field: nothing to compare with.
    expect(status('task-field').every(([, s]) => s === 'unchecked')).toBe(true);
    expect(status('extra-node')).toEqual([['Validation Passed?', 'extra']]);
    expect(traceSummary(result.counts)).toBe('19 of 41 matched · 5 near · 0 missing · 17 unchecked · 1 extra');
  });
});
