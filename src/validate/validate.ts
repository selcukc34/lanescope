// Validation rules over the shared model. Each rule reads a Process and
// reports issues; nothing is changed. The views show the issues in the
// Warnings tab.

import type { Flow, FlowNode, FlowNodeKind, Lane, Process } from '../model/model';

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
 * Where the flow gets stuck before an end event, reported once per
 * problem, not once per node on the way there:
 * - a dead end: a node that does not reach an end event and has no outgoing
 *   flow within its level;
 * - a loop without a way out: nodes that reach neither an end event nor a
 *   dead end, grouped by the flows between them, one warning per group, on
 *   the node where the group is entered.
 * Each level is checked on its own: nodes inside a sub-process must reach an
 * end event of that sub-process. A process without any end event gets one
 * warning; a sub-process without one is not checked (BPMN lets it end
 * implicitly). Disconnected nodes and gateways without outgoing flows are
 * left to their own rules (a dead gateway still counts as a dead end for the
 * nodes before it); boundary events and event sub-processes are not checked.
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
      const inScope = (id: string) => nodeById.get(id)?.parentId === scope;
      // Walk back over the incoming flows of this level from `seeds`.
      const walkBack = (seeds: Iterable<string>, into: Set<string>) => {
        const queue = [...seeds];
        for (const id of queue) into.add(id);
        while (queue.length > 0) {
          const id = queue.pop()!;
          const next = index.incoming(id).map((f) => f.sourceId);
          // A boundary event that leads somewhere gives its host a way there too.
          const host = nodeById.get(id)?.attachedToId;
          if (host !== undefined) next.push(host);
          for (const source of next) {
            if (!inScope(source) || into.has(source)) continue;
            into.add(source);
            queue.push(source);
          }
        }
      };
      const reaches = new Set<string>();
      walkBack(
        ends.map((n) => n.id),
        reaches,
      );

      const stuck = nodes.filter((n) => !reaches.has(n.id) && !isBoundaryEvent(n) && !isEventSubProcess(n));
      const isDeadEnd = (n: FlowNode) => !index.outgoing(n.id).some((f) => inScope(f.targetId));
      const deadEnds = stuck.filter((n) => !isDisconnected(n, index) && !isDeadGateway(n, index) && isDeadEnd(n));
      for (const node of deadEnds) {
        issues.push({
          ruleId: 'no-path-to-end',
          severity: 'warning',
          elementId: node.id,
          message: `${nodeLabel(node)}: the path ends here without reaching an end event.`,
        });
      }

      // What reaches neither an end event nor a dead end (or dead gateway) is caught in a loop.
      const reachesDeadEnd = new Set<string>();
      walkBack(
        stuck.filter((n) => isDeadEnd(n) || isDeadGateway(n, index)).map((n) => n.id),
        reachesDeadEnd,
      );
      const looping = stuck.filter((n) => !reachesDeadEnd.has(n.id) && !isDisconnected(n, index));
      for (const group of connectedGroups(looping, index)) {
        const members = new Set(group.map((n) => n.id));
        const entry = group.find((n) => index.incoming(n.id).some((f) => !members.has(f.sourceId))) ?? group[0];
        issues.push({
          ruleId: 'no-path-to-end',
          severity: 'warning',
          elementId: entry.id,
          message: `${nodeLabel(entry)}: the loop starting here has no way out to an end event.`,
        });
      }
    }
    return issues;
  },
};

/**
 * A lane that holds no flow node. Bob output keeps lanes it plans but never
 * fills; BAW keeps them too (as empty lanes of the BPD). The lanes of a
 * sub-process's own diagram are checked here too, with the sub-process named.
 */
export const emptyLane: ValidationRule = {
  id: 'empty-lane',
  check(process) {
    const used = new Set(process.nodes.map((n) => n.laneId).filter((id) => id !== undefined));
    const issue = (lane: Lane, message: string): ValidationIssue => ({ ruleId: 'empty-lane', severity: 'warning', elementId: lane.id, message });
    return [
      ...process.lanes.filter((lane) => !used.has(lane.id)).map((lane) => issue(lane, `Lane ${lane.name || lane.id} has no activities`)),
      ...process.nodes.flatMap((sub) =>
        (sub.lanes ?? [])
          .filter((lane) => !used.has(lane.id))
          .map((lane) => issue(lane, `Lane "${lane.name || lane.id}" in sub-process "${sub.name || sub.id}" has no activities.`)),
      ),
    ];
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

/** Names listed in the activity-without-documentation warning before "and N more". */
const MAX_LISTED_ACTIVITIES = 8;

/**
 * Activities whose documentation is empty or only white space, in one
 * warning per process (BAW exports often leave many undocumented). Events
 * and gateways are not checked.
 */
export const activityWithoutDocumentation: ValidationRule = {
  id: 'activity-without-documentation',
  check(process) {
    const undocumented = process.nodes.filter((n) => DOCUMENTED_KINDS.has(n.kind) && !n.documentation?.trim());
    if (undocumented.length === 0) return [];
    const count = undocumented.length;
    const names = undocumented.slice(0, MAX_LISTED_ACTIVITIES).map((n) => `"${n.name || n.id}"`);
    const more = count - names.length;
    const subject = count === 1 ? '1 activity has' : `${count} activities have`;
    return [
      {
        ruleId: 'activity-without-documentation',
        severity: 'warning',
        elementId: process.id,
        message: `${subject} no documentation: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
      },
    ];
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
  return node.kind === 'subProcess' && node.triggeredByEvent === true;
}

/** Splits `nodes` into groups connected by the flows between them (either direction), in model order. */
function connectedGroups(nodes: FlowNode[], index: FlowIndex): FlowNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const groups: FlowNode[][] = [];
  for (const start of nodes) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const members = new Set([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const neighbours = [...index.outgoing(id).map((f) => f.targetId), ...index.incoming(id).map((f) => f.sourceId)];
      for (const next of neighbours) {
        if (!byId.has(next) || seen.has(next)) continue;
        seen.add(next);
        members.add(next);
        queue.push(next);
      }
    }
    groups.push(nodes.filter((n) => members.has(n.id)));
  }
  return groups;
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
