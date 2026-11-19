// The structural rules: gateway-without-outgoing-flow, disconnected-node,
// no-path-to-end and activity-without-documentation. Small hand-written
// models and BPMN documents, the Bob fixture, and (when present) the local
// BAW exports.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBpmn, readProcessPackage } from '../../src/bpmn/bpmnReader';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import type { Flow, FlowNode, Process } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import {
  activityWithoutDocumentation,
  disconnectedNode,
  gatewayWithoutOutgoingFlow,
  noPathToEnd,
  RULES,
  validateProcess,
  type ValidationIssue,
} from '../../src/validate/validate';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';

const STRUCTURAL = [gatewayWithoutOutgoingFlow, disconnectedNode, noPathToEnd];

function node(id: string, kind: FlowNode['kind'], extra: Partial<FlowNode> = {}): FlowNode {
  return { id, name: id, kind, originalType: kind, inputs: [], outputs: [], documentation: `About ${id}.`, ...extra };
}

let flowCount = 0;
function flow(sourceId: string, targetId: string, extra: Partial<Flow> = {}): Flow {
  flowCount += 1;
  return { id: `f${flowCount}`, name: '', sourceId, targetId, isDefault: false, ...extra };
}

function process(nodes: FlowNode[], flows: Flow[], name = 'Sample'): Process {
  return { id: 'p', name, documentation: '', lanes: [], nodes, flows };
}

const messages = (issues: ValidationIssue[]) => issues.map((i) => i.message);
const ruleIds = (issues: ValidationIssue[]) => issues.map((i) => i.ruleId);

/** start → work → approved? → (end | rework → work) */
function soundProcess(): Process {
  return process(
    [
      node('start', 'startEvent'),
      node('work', 'userTask', { name: 'Do work' }),
      node('gw', 'exclusiveGateway', { name: 'Approved?' }),
      node('rework', 'scriptTask', { name: 'Rework' }),
      node('end', 'endEvent'),
    ],
    [
      flow('start', 'work'),
      flow('work', 'gw'),
      flow('gw', 'end', { condition: 'tw.local.approved' }),
      flow('gw', 'rework', { isDefault: true }),
      flow('rework', 'work'),
    ],
  );
}

describe('rule order', () => {
  it('runs the rules in the documented order', () => {
    expect(RULES.map((r) => r.id)).toEqual([
      'gateway-unconditioned-flow',
      'gateway-without-outgoing-flow',
      'disconnected-node',
      'no-path-to-end',
      'empty-lane',
      'activity-without-documentation',
    ]);
  });
});

describe('the Bob fixture', () => {
  it('gives only the empty lane: Bob documents everything and the structure is sound', async () => {
    const bob = (await readProcessPackage(await readBpmnPackage(BOB))).processes[0];
    expect(validateProcess(bob).map((i) => `${i.ruleId}: ${i.message}`)).toEqual([
      'empty-lane: Lane Customer has no activities',
    ]);
  });
});

describe('a sound small process', () => {
  it('gives no warning, a loop with a way out included', () => {
    expect(validateProcess(soundProcess())).toEqual([]);
  });
});

describe('disconnected-node', () => {
  it('reports a task no flow enters or leaves, once', () => {
    const p = soundProcess();
    p.nodes.push(node('lost', 'userTask', { name: 'Lost Task' }));
    expect(validateProcess(p)).toEqual([
      {
        ruleId: 'disconnected-node',
        severity: 'warning',
        elementId: 'lost',
        message: 'User task "Lost Task" is not connected to any sequence flow.',
      },
    ]);
  });

  it('names a node without a name by its id, and an unknown node as an element', () => {
    const p = soundProcess();
    p.nodes.push(node('n1', 'unknown', { name: '' }));
    expect(messages(disconnectedNode.check(p))).toEqual(['Element "n1" is not connected to any sequence flow.']);
  });

  it('reports a disconnected gateway as disconnected, not as a gateway without outgoing flow', () => {
    const p = soundProcess();
    p.nodes.push(node('g2', 'parallelGateway', { name: 'Split' }));
    expect(messages(validateProcess(p))).toEqual(['Parallel gateway "Split" is not connected to any sequence flow.']);
  });

  it('leaves out boundary events and event sub-processes', () => {
    const p = soundProcess();
    p.nodes.push(
      node('b1', 'intermediateEvent', { attachedToId: 'work' }),
      node('b2', 'intermediateEvent', { originalType: 'boundaryEvent' }),
      node('b3', 'intermediateEvent', { originalType: 'bpmn:BoundaryEvent' }),
      node('evsp', 'subProcess', { originalType: 'subProcess (event)' }),
    );
    expect(validateProcess(p)).toEqual([]);
  });
});

describe('gateway-without-outgoing-flow', () => {
  it.each([
    ['exclusiveGateway', 'Exclusive gateway'],
    ['parallelGateway', 'Parallel gateway'],
    ['inclusiveGateway', 'Inclusive gateway'],
    ['eventBasedGateway', 'Event-based gateway'],
  ] as const)('reports a %s that flows enter but none leave, once', (kind, label) => {
    const p = process(
      [node('start', 'startEvent'), node('gw', kind, { name: 'Approved?' }), node('end', 'endEvent')],
      [flow('start', 'gw'), flow('start', 'end')],
    );
    expect(validateProcess(p)).toEqual([
      {
        ruleId: 'gateway-without-outgoing-flow',
        severity: 'warning',
        elementId: 'gw',
        message: `${label} "Approved?" has no outgoing flow.`,
      },
    ]);
  });

  it('does not report a gateway with an outgoing flow', () => {
    expect(gatewayWithoutOutgoingFlow.check(soundProcess())).toEqual([]);
  });
});

describe('no-path-to-end', () => {
  it('reports every node of a dead-end branch, and nothing on the way that still reaches an end', () => {
    const p = soundProcess();
    p.nodes.push(node('esc', 'task', { name: 'Escalate' }), node('notify', 'intermediateEvent', { name: 'Notify' }));
    p.flows.push(flow('gw', 'esc', { condition: 'tw.local.late' }), flow('esc', 'notify'));
    expect(validateProcess(p)).toEqual([
      {
        ruleId: 'no-path-to-end',
        severity: 'warning',
        elementId: 'esc',
        message: 'Task "Escalate": no path from here reaches an end event.',
      },
      {
        ruleId: 'no-path-to-end',
        severity: 'warning',
        elementId: 'notify',
        message: 'Intermediate event "Notify": no path from here reaches an end event.',
      },
    ]);
  });

  it('reports both nodes of a loop without a way out', () => {
    const p = soundProcess();
    p.nodes.push(node('a', 'task', { name: 'Check' }), node('b', 'task', { name: 'Wait' }));
    p.flows.push(flow('gw', 'a', { condition: 'tw.local.wait' }), flow('a', 'b'), flow('b', 'a'));
    expect(messages(validateProcess(p))).toEqual([
      'Task "Check": no path from here reaches an end event.',
      'Task "Wait": no path from here reaches an end event.',
    ]);
  });

  it('gives one warning for a process without an end event', () => {
    const p = process(
      [node('start', 'startEvent'), node('a', 'task'), node('b', 'task')],
      [flow('start', 'a'), flow('a', 'b')],
    );
    expect(validateProcess(p)).toEqual([
      { ruleId: 'no-path-to-end', severity: 'warning', elementId: 'p', message: 'Process "Sample" has no end event.' },
    ]);
  });

  it('names a process without a name by its id', () => {
    const p = process([node('a', 'task')], [], '');
    expect(messages(noPathToEnd.check(p))).toEqual(['Process "p" has no end event.']);
  });

  it('checks the nodes of a sub-process against the end events of that sub-process', () => {
    const p = soundProcess();
    // work → sub → end at the top; inside sub: s → x → e and s → y (dead end).
    p.nodes.push(
      node('sub', 'subProcess', { name: 'Handle' }),
      node('s', 'startEvent', { parentId: 'sub' }),
      node('x', 'task', { parentId: 'sub' }),
      node('y', 'task', { name: 'Archive', parentId: 'sub' }),
      node('e', 'endEvent', { parentId: 'sub' }),
    );
    p.flows.push(flow('work', 'sub'), flow('sub', 'end'), flow('s', 'x'), flow('x', 'e'), flow('s', 'y'));
    expect(messages(validateProcess(p))).toEqual(['Task "Archive": no path from here reaches an end event.']);
  });

  it('does not count the end event of the process for a node inside a sub-process', () => {
    const p = soundProcess();
    p.nodes.push(
      node('sub', 'subProcess'),
      node('s', 'startEvent', { parentId: 'sub' }),
      node('x', 'task', { name: 'Inside', parentId: 'sub' }),
      node('e', 'endEvent', { parentId: 'sub' }),
    );
    // x leaves the sub-process to the process's end; it never reaches e.
    p.flows.push(flow('work', 'sub'), flow('sub', 'end'), flow('s', 'e'), flow('x', 'end'), flow('s', 'x'));
    expect(messages(noPathToEnd.check(p))).toEqual(['Task "Inside": no path from here reaches an end event.']);
  });

  it('skips a sub-process without an end event', () => {
    const p = soundProcess();
    p.nodes.push(
      node('sub', 'subProcess'),
      node('s', 'startEvent', { parentId: 'sub' }),
      node('x', 'task', { parentId: 'sub' }),
    );
    p.flows.push(flow('work', 'sub'), flow('sub', 'end'), flow('s', 'x'));
    expect(validateProcess(p)).toEqual([]);
  });

  it('does not report nodes the other rules report, boundary events or event sub-processes', () => {
    const p = soundProcess();
    p.nodes.push(
      node('lost', 'task'),
      node('dead', 'exclusiveGateway'),
      node('bnd', 'intermediateEvent', { attachedToId: 'work' }),
      node('evsp', 'subProcess', { originalType: 'subProcess (event)' }),
      node('es', 'startEvent', { parentId: 'evsp' }),
    );
    p.flows.push(flow('gw', 'dead', { condition: 'tw.local.dead' }), flow('es', 'es'));
    expect(ruleIds(validateProcess(p))).toEqual(['gateway-without-outgoing-flow', 'disconnected-node']);
    expect(noPathToEnd.check(p)).toEqual([]);
  });

  it('lets a host reach an end event through its boundary event', () => {
    const p = process(
      [
        node('start', 'startEvent'),
        node('work', 'task'),
        node('bnd', 'intermediateEvent', { attachedToId: 'work', originalType: 'boundaryEvent' }),
        node('end', 'endEvent'),
      ],
      [flow('start', 'work'), flow('bnd', 'end')],
    );
    expect(noPathToEnd.check(p)).toEqual([]);
  });

  describe('a small Bob BPMN with a boundary event', () => {
    const bpmn = (branchEnd: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="d" targetNamespace="http://example.com">
  <bpmn:process id="p" name="Boundary sample">
    <bpmn:startEvent id="start" name="Start" />
    <bpmn:userTask id="review" name="Review"><bpmn:documentation>Reviews.</bpmn:documentation></bpmn:userTask>
    <bpmn:boundaryEvent id="late" name="Too late" attachedToRef="review"><bpmn:timerEventDefinition /></bpmn:boundaryEvent>
    <bpmn:task id="escalate" name="Escalate"><bpmn:documentation>Escalates.</bpmn:documentation></bpmn:task>
    <bpmn:endEvent id="end" name="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="review" />
    <bpmn:sequenceFlow id="f2" sourceRef="review" targetRef="end" />
    <bpmn:sequenceFlow id="f3" sourceRef="late" targetRef="escalate" />
    ${branchEnd ? '<bpmn:sequenceFlow id="f4" sourceRef="escalate" targetRef="end" />' : ''}
  </bpmn:process>
</bpmn:definitions>`;

    it('reports the branch that leaves the boundary and never reaches an end, not the boundary itself', async () => {
      const p = (await readBpmn(bpmn(false))).processes[0];
      expect(validateProcess(p)).toEqual([
        {
          ruleId: 'no-path-to-end',
          severity: 'warning',
          elementId: 'escalate',
          message: 'Task "Escalate": no path from here reaches an end event.',
        },
      ]);
    });

    it('gives no warning when the branch reaches the end', async () => {
      const p = (await readBpmn(bpmn(true))).processes[0];
      expect(validateProcess(p)).toEqual([]);
    });
  });
});

describe('activity-without-documentation', () => {
  it('reports empty and white-space-only documentation, and missing documentation', () => {
    const p = soundProcess();
    p.nodes.find((n) => n.id === 'work')!.documentation = '';
    p.nodes.find((n) => n.id === 'rework')!.documentation = '  \n\t ';
    p.nodes.push(node('calc', 'scriptTask', { name: 'Compute', documentation: undefined }));
    p.flows.push(flow('start', 'calc'), flow('calc', 'end'));
    expect(validateProcess(p)).toEqual([
      { ruleId: 'activity-without-documentation', severity: 'warning', elementId: 'work', message: 'User task "Do work" has no documentation.' },
      { ruleId: 'activity-without-documentation', severity: 'warning', elementId: 'rework', message: 'Script task "Rework" has no documentation.' },
      { ruleId: 'activity-without-documentation', severity: 'warning', elementId: 'calc', message: 'Script task "Compute" has no documentation.' },
    ]);
  });

  it('checks every activity kind and leaves out events, gateways and unknown elements', () => {
    const kinds: FlowNode['kind'][] = [
      'task',
      'scriptTask',
      'userTask',
      'serviceTask',
      'callActivity',
      'subProcess',
      'startEvent',
      'endEvent',
      'intermediateEvent',
      'exclusiveGateway',
      'parallelGateway',
      'inclusiveGateway',
      'eventBasedGateway',
      'unknown',
    ];
    const p = process(kinds.map((k) => node(k, k, { documentation: undefined })), []);
    expect(messages(activityWithoutDocumentation.check(p))).toEqual([
      'Task "task" has no documentation.',
      'Script task "scriptTask" has no documentation.',
      'User task "userTask" has no documentation.',
      'Service task "serviceTask" has no documentation.',
      'Call activity "callActivity" has no documentation.',
      'Sub-process "subProcess" has no documentation.',
    ]);
  });
});

describe('the local BAW exports', () => {
  const byRule = (issues: ValidationIssue[], ruleId: string) => issues.filter((i) => i.ruleId === ruleId);

  it.skipIf(!hasLocalTwx('orderDelivery'))('order-delivery round trip: no structural warning, every activity documented', async () => {
    const p = (await readTwxPackage(localTwx('orderDelivery'))).processes[0];
    const issues = validateProcess(p);
    expect(validateProcess(p, STRUCTURAL)).toEqual([]);
    expect(byRule(issues, 'activity-without-documentation')).toEqual([]);
  });

  it.skipIf(!hasLocalTwx('services'))('DemoChildProcess: one undocumented script task, no structural warning', async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    const p = pkg.processes.find((x) => x.name === 'DemoChildProcess')!;
    expect(validateProcess(p, STRUCTURAL)).toEqual([]);
    expect(messages(activityWithoutDocumentation.check(p))).toEqual(['Script task "Decide" has no documentation.']);
  });

  it.skipIf(!hasLocalTwx('services'))('Demo_MainProcess: ten undocumented activities; its End event is not connected', async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    const p = pkg.processes.find((x) => x.name === 'Demo_MainProcess')!;
    expect(activityWithoutDocumentation.check(p)).toHaveLength(10);
    // The export itself has no flow into "End": the chain stops at "Timer 2".
    // So End is disconnected, and no node above it reaches an end event.
    expect(gatewayWithoutOutgoingFlow.check(p)).toEqual([]);
    expect(messages(disconnectedNode.check(p))).toEqual(['End event "End" is not connected to any sequence flow.']);
    const noPath = noPathToEnd.check(p);
    expect(noPath).toHaveLength(14);
    expect(messages(noPath)).toContain('Intermediate event "Timer 2": no path from here reaches an end event.');
  });

  it.skipIf(!hasLocalTwx('activities'))('activities: boundary events and the event sub-process give no structural warning', async () => {
    const pkg = await readTwxPackage(localTwx('activities'));
    for (const p of pkg.processes) expect(validateProcess(p, STRUCTURAL)).toEqual([]);
  });
});
