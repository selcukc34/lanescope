import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { Flow, FlowNode, Process } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { gatewayUnconditionedFlow, validateProcess } from '../../src/validate/validate';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
/** The local export (../localFixtures); its case is skipped when it is not there. */
const REAL = hasLocalTwx('orderDelivery');

describe('gateway-unconditioned-flow', () => {
  let bob: Process;
  let twx: Process;

  beforeAll(async () => {
    bob = (await readProcessPackage(await readBpmnPackage(BOB))).processes[0];
    if (REAL) twx = (await readTwxPackage(localTwx('orderDelivery'))).processes[0];
  });

  it('finds nothing in the Bob BPMN, where every non-default flow has a condition', () => {
    expect(validateProcess(bob, [gatewayUnconditionedFlow])).toEqual([]);
  });

  it.skipIf(!REAL)('finds the four flows whose conditions BAW dropped on import', () => {
    const issues = validateProcess(twx, [gatewayUnconditionedFlow]);
    expect(issues).toHaveLength(4);
    expect(issues.every((i) => i.ruleId === 'gateway-unconditioned-flow' && i.severity === 'warning')).toBe(true);

    const byGateway = new Map<string, string[]>();
    const names = new Map(twx.nodes.map((n) => [n.id, n.name]));
    for (const issue of issues) {
      const flow = twx.flows.find((f) => f.id === issue.elementId)!;
      const gateway = names.get(flow.sourceId)!;
      byGateway.set(gateway, [...(byGateway.get(gateway) ?? []), flow.name]);
    }
    expect(Object.fromEntries(byGateway)).toEqual({
      'Validation Passed?': ['Valid'],
      'Route Order': expect.arrayContaining(['AUTO_APPROVE', 'MANAGER_APPROVAL', 'COMPLIANCE_REVIEW']),
    });
    expect(byGateway.get('Route Order')).toHaveLength(3);
    expect(issues.map((i) => i.message)).toContain(
      'Exclusive gateway "Validation Passed?": the outgoing flow "Valid" has no condition and is not the default flow.',
    );
  });

  describe('on small processes', () => {
    const node = (id: string, kind: FlowNode['kind']): FlowNode => ({
      id,
      name: id,
      kind,
      originalType: kind,
      inputs: [],
      outputs: [],
    });
    const flow = (id: string, sourceId: string, targetId: string, extra: Partial<Flow> = {}): Flow => ({
      id,
      name: '',
      sourceId,
      targetId,
      isDefault: false,
      ...extra,
    });
    const process = (nodes: FlowNode[], flows: Flow[]): Process => ({
      id: 'p',
      name: 'p',
      documentation: '',
      lanes: [],
      nodes,
      flows,
    });

    it('checks inclusive gateways and names a flow without a name by its target', () => {
      const issues = gatewayUnconditionedFlow.check(
        process(
          [node('g', 'inclusiveGateway'), node('a', 'task'), node('b', 'task')],
          [flow('f1', 'g', 'a', { condition: 'x' }), flow('f2', 'g', 'b')],
        ),
      );
      expect(issues.map((i) => i.message)).toEqual([
        'Inclusive gateway "g": the outgoing flow to "b" has no condition and is not the default flow.',
      ]);
    });

    it('ignores joins, parallel gateways and default flows', () => {
      const p = process(
        [node('j', 'exclusiveGateway'), node('p', 'parallelGateway'), node('g', 'exclusiveGateway'), node('a', 'task'), node('b', 'task')],
        [
          flow('f1', 'j', 'a'),
          flow('f2', 'p', 'a'),
          flow('f3', 'p', 'b'),
          flow('f4', 'g', 'a', { isDefault: true }),
          flow('f5', 'g', 'b', { condition: 'tw.local.x > 1' }),
        ],
      );
      expect(validateProcess(p)).toEqual([]);
    });
  });
});
