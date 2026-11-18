// Validation rules over the shared model. Each rule reads a Process and
// reports issues; nothing is changed. The views show the issues in the
// Warnings tab.

import type { Flow, FlowNode, Process } from '../model/model';

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
    const outgoing = new Map<string, Flow[]>();
    for (const flow of process.flows) {
      const list = outgoing.get(flow.sourceId) ?? [];
      list.push(flow);
      outgoing.set(flow.sourceId, list);
    }
    const nodes = new Map(process.nodes.map((n) => [n.id, n]));
    for (const node of process.nodes) {
      if (node.kind !== 'exclusiveGateway' && node.kind !== 'inclusiveGateway') continue;
      const flows = outgoing.get(node.id) ?? [];
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

export const RULES: readonly ValidationRule[] = [gatewayUnconditionedFlow, emptyLane];

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
