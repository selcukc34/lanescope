// Validation rules over the shared model. Each rule reads a Process and
// reports issues; nothing is changed. The views show the issues in the
// Warnings tab.

import type { Flow, FlowNode, FlowNodeKind, Process } from '../model/model';

export type Severity = 'warning';

export interface ValidationIssue {
  /** Stable rule id, e.g. "gateway-unconditioned-flow". */
  ruleId: string;
  severity: Severity;
  /** Id of the element the issue is about. */
  elementId: string;
  message: string;
}

export interface ValidationRule {
  id: string;
  check(process: Process): ValidationIssue[];
}

/**
 * An exclusive or inclusive gateway decides by the conditions of its
 * outgoing flows; only the default flow may go without one. A non-default
 * flow without a condition is a gap (BAW 8.6.6 leaves the conditions empty when it
 * imports a Bob process: its <condition> elements are empty).
 * Gateways with a single outgoing flow (joins) are not checked.
 */
export const gatewayUnconditionedFlow: ValidationRule = {
  id: 'gateway-unconditioned-flow',
  check(process) {
    const issues: ValidationIssue[] = [];
    const { outgoing } = flowIndex(process);
    const nodes = new Map(process.nodes.map((n) => [n.id, n]));
    for (const node of process.nodes) {
      if (node.kind !== 'exclusiveGateway' && node.kind !== 'inclusiveGateway') continue;
      const flows = outgoing(node.id);
      if (flows.length < 2) continue;
      for (const flow of flows) {
        if (flow.isDefault || flow.condition !== undefined) continue;
        issues.push({
          ruleId: 'gateway-unconditioned-flow',
          severity: 'warning',
          elementId: flow.id,
          message:
            `${gatewayLabel(node)} "${node.name || node.id}": the outgoing flow ${flowLabel(flow, nodes)} ` +
            'has no condition and is not the default flow.',
        });
      }
    }
    return issues;
  },
};

/**
 * A gateway (of any type) that flows enter but none leave: the process
 * stops there. A gateway with no flow at all is a disconnected node instead.
 */
export const gatewayWithoutOutgoingFlow: ValidationRule = {
  id: 'gateway-without-outgoing-flow',
  check(process) {
    const index = flowIndex(process);
    return process.nodes.filter((n) => isDeadGateway(n, index)).map((node) => ({
      ruleId: 'gateway-without-outgoing-flow',
      severity: 'warning' as const,
      elementId: node.id,
      message: `${nodeLabel(node)} has no outgoing flow.`,
    }));
  },
};

/**
 * A node that no sequence flow enters or leaves. Boundary events (they
 * hang on their host) and event sub-processes (an event starts them) are
 * not checked.
 */
export const disconnectedNode: ValidationRule = {
  id: 'disconnected-node',
  check(process) {
    const index = flowIndex(process);
    return process.nodes.filter((n) => isDisconnected(n, index)).map((node) => ({
      ruleId: 'disconnected-node',
      severity: 'warning' as const,
      elementId: node.id,
      message: `${nodeLabel(node)} is not connected to any sequence flow.`,
    }));
  },
};

/**
 * A node from which no chain of sequence flows reaches an end event (a
 * dead end, or a loop without a way out). Each level is checked on its own:
 * nodes inside a sub-process must reach an end event of that sub-process.
 * A process without any end event gets one warning instead of one per node;
 * a sub-process without one is not checked (BPMN lets it end implicitly).
 * Disconnected nodes, gateways without outgoing flows, boundary events and
 * event sub-processes are left to the other rules or not checked.
 */
export const noPathToEnd: ValidationRule = {
  id: 'no-path-to-end',
  check(process) {
    const index = flowIndex(process);
    const nodeById = new Map(process.nodes.map((n) => [n.id, n]));
    const scopes = new Map<string | undefined, FlowNode[]>();
    for (const node of process.nodes) {
      const list = scopes.get(node.parentId) ?? [];
      list.push(node);
      scopes.set(node.parentId, list);
    }
    if (!scopes.has(undefined)) scopes.set(undefined, []);

    const issues: ValidationIssue[] = [];
    for (const [scope, nodes] of scopes) {
      const ends = nodes.filter((n) => n.kind === 'endEvent');
      if (ends.length === 0) {
        if (scope === undefined && nodes.length > 0) {
          issues.push({
            ruleId: 'no-path-to-end',
            severity: 'warning',
            elementId: process.id,
            message: `Process "${process.name || process.id}" has no end event.`,
          });
        }
        continue;
      }
      // Walk back from the end events over the incoming flows of this level.
      const reaches = new Set(ends.map((n) => n.id));
      const queue = [...reaches];
      const visit = (id: string) => {
        const node = nodeById.get(id);
        if (!node || node.parentId !== scope || reaches.has(id)) return;
        reaches.add(id);
        queue.push(id);
      };
      while (queue.length > 0) {
        const id = queue.pop()!;
        for (const flow of index.incoming(id)) visit(flow.sourceId);
        // A boundary event that leads to an end gives its host a way there too.
        const node = nodeById.get(id);
        if (node && node.attachedToId !== undefined) visit(node.attachedToId);
      }
      for (const node of nodes) {
        if (reaches.has(node.id)) continue;
        if (isBoundaryEvent(node) || isEventSubProcess(node)) continue;
        if (isDisconnected(node, index) || isDeadGateway(node, index)) continue;
        issues.push({
          ruleId: 'no-path-to-end',
          severity: 'warning',
          elementId: node.id,
          message: `${nodeLabel(node)}: no path from here reaches an end event.`,
        });
      }
    }
    return issues;
  },
};

/**
 * A lane that holds no flow node. Bob output keeps lanes it plans but never
 * fills; BAW keeps them too (as empty lanes of the BPD).
 */
export const emptyLane: ValidationRule = {
  id: 'empty-lane',
  check(process) {
    const used = new Set(process.nodes.map((n) => n.laneId).filter((id) => id !== undefined));
    return process.lanes
      .filter((lane) => !used.has(lane.id))
      .map((lane) => ({
        ruleId: 'empty-lane',
        severity: 'warning' as const,
        elementId: lane.id,
        message: `Lane ${lane.name || lane.id} has no activities`,
      }));
  },
};

const DOCUMENTED_KINDS: ReadonlySet<FlowNodeKind> = new Set<FlowNodeKind>([
  'task',
  'scriptTask',
  'userTask',
  'serviceTask',
  'callActivity',
  'subProcess',
]);

/** An activity whose documentation is empty or only white space. Events and gateways are not checked. */
export const activityWithoutDocumentation: ValidationRule = {
  id: 'activity-without-documentation',
  check(process) {
    return process.nodes
      .filter((n) => DOCUMENTED_KINDS.has(n.kind) && !n.documentation?.trim())
      .map((node) => ({
        ruleId: 'activity-without-documentation',
        severity: 'warning' as const,
        elementId: node.id,
        message: `${nodeLabel(node)} has no documentation.`,
      }));
  },
};

export const RULES: readonly ValidationRule[] = [
  gatewayUnconditionedFlow,
  gatewayWithoutOutgoingFlow,
  disconnectedNode,
  noPathToEnd,
  emptyLane,
  activityWithoutDocumentation,
];

/** Runs every rule over one process. */
export function validateProcess(process: Process, rules: readonly ValidationRule[] = RULES): ValidationIssue[] {
  return rules.flatMap((rule) => rule.check(process));
}

function gatewayLabel(node: FlowNode): string {
  return node.kind === 'inclusiveGateway' ? 'Inclusive gateway' : 'Exclusive gateway';
}

function flowLabel(flow: Flow, nodes: Map<string, FlowNode>): string {
  if (flow.name.trim()) return `"${flow.name}"`;
  const target = nodes.get(flow.targetId);
  return `to "${target?.name || flow.targetId}"`;
}

/** The sequence flows entering and leaving each node. */
interface FlowIndex {
  incoming(nodeId: string): readonly Flow[];
  outgoing(nodeId: string): readonly Flow[];
}

function flowIndex(process: Process): FlowIndex {
  const incoming = new Map<string, Flow[]>();
  const outgoing = new Map<string, Flow[]>();
  const add = (map: Map<string, Flow[]>, key: string, flow: Flow) => {
    const list = map.get(key);
    if (list) list.push(flow);
    else map.set(key, [flow]);
  };
  for (const flow of process.flows) {
    add(outgoing, flow.sourceId, flow);
    add(incoming, flow.targetId, flow);
  }
  return {
    incoming: (id) => incoming.get(id) ?? [],
    outgoing: (id) => outgoing.get(id) ?? [],
  };
}

const GATEWAY_KINDS: ReadonlySet<FlowNodeKind> = new Set<FlowNodeKind>([
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
]);

function isBoundaryEvent(node: FlowNode): boolean {
  return node.attachedToId !== undefined || node.originalType === 'boundaryEvent' || node.originalType === 'bpmn:BoundaryEvent';
}

function isEventSubProcess(node: FlowNode): boolean {
  return node.kind === 'subProcess' && node.originalType === 'subProcess (event)';
}

function isDisconnected(node: FlowNode, index: FlowIndex): boolean {
  if (isBoundaryEvent(node) || isEventSubProcess(node)) return false;
  return index.incoming(node.id).length === 0 && index.outgoing(node.id).length === 0;
}

function isDeadGateway(node: FlowNode, index: FlowIndex): boolean {
  return GATEWAY_KINDS.has(node.kind) && index.incoming(node.id).length > 0 && index.outgoing(node.id).length === 0;
}

const NODE_KIND_LABELS: Record<FlowNodeKind, string> = {
  startEvent: 'Start event',
  endEvent: 'End event',
  intermediateEvent: 'Intermediate event',
  task: 'Task',
  scriptTask: 'Script task',
  userTask: 'User task',
  serviceTask: 'Service task',
  callActivity: 'Call activity',
  subProcess: 'Sub-process',
  exclusiveGateway: 'Exclusive gateway',
  parallelGateway: 'Parallel gateway',
  inclusiveGateway: 'Inclusive gateway',
  eventBasedGateway: 'Event-based gateway',
  unknown: 'Element',
};

/** `<Kind> "<name or id>"`, e.g. `User task "Approve Order"`. */
function nodeLabel(node: FlowNode): string {
  return `${NODE_KIND_LABELS[node.kind]} "${node.name || node.id}"`;
}
