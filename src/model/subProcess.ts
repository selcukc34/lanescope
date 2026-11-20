// The inside of a sub-process as a diagram of its own: a level the viewer
// opens below the process that holds it, as it opens a called service.
// Pure: no vscode, no file access. The process it reads is never modified;
// the diagram holds copies of its nodes and flows.

import type { Flow, FlowNode, Process } from './model';

/** Level ids of sub-process diagrams start with this; BAW object ids never do. */
export const SUB_LEVEL_PREFIX = 'sub:';

/** The level id of a sub-process node: "sub:" and its identity (originalId ?? id). */
export function subProcessLevelId(node: FlowNode): string {
  return SUB_LEVEL_PREFIX + (node.originalId ?? node.id);
}

export function isSubProcessLevelId(id: string): boolean {
  return id.startsWith(SUB_LEVEL_PREFIX);
}

/** The sub-process node of `process` with this level id. */
export function findSubProcess(process: Process, levelId: string): FlowNode | undefined {
  return process.nodes.find((n) => n.kind === 'subProcess' && subProcessLevelId(n) === levelId);
}

/**
 * For each sub-process of `process` that holds nodes: how many its diagram
 * draws at the top (its direct children and their boundary events).
 */
export function childCounts(process: Process): Map<string, number> {
  const parentOf = new Map(process.nodes.map((n) => [n.id, n.parentId]));
  const counts = new Map<string, number>();
  for (const n of process.nodes) {
    // A boundary event read without a parent counts where its host is.
    const parent = n.parentId ?? (n.attachedToId !== undefined ? parentOf.get(n.attachedToId) : undefined);
    if (parent !== undefined && parent !== n.id) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

/**
 * The diagram of the sub-process with `levelId` in `process`: every node
 * inside it, at any depth, and the flows between them. Its direct children
 * are top-level nodes of the diagram; deeper nodes keep their parents, so a
 * nested sub-process is drawn collapsed and opens as one more level. A
 * boundary event comes with the node it is attached to. No lanes: one pool,
 * named after the sub-process. Undefined when there is no such sub-process
 * or it holds no node.
 */
export function subProcessDiagram(process: Process, levelId: string): Process | undefined {
  const sub = findSubProcess(process, levelId);
  if (!sub) return undefined;

  const byParent = new Map<string, FlowNode[]>();
  for (const n of process.nodes) {
    if (n.parentId === undefined) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  // Everything below the sub-process; `seen` keeps a cycle of parents finite.
  const inside = new Set<string>();
  const queue = [sub.id];
  while (queue.length > 0) {
    for (const n of byParent.get(queue.pop()!) ?? []) {
      if (n.id === sub.id || inside.has(n.id)) continue;
      inside.add(n.id);
      queue.push(n.id);
    }
  }
  // A boundary event belongs where its host is, whatever parent it was read with.
  for (const n of process.nodes) {
    if (!inside.has(n.id) && n.id !== sub.id && n.attachedToId !== undefined && inside.has(n.attachedToId)) inside.add(n.id);
  }
  if (inside.size === 0) return undefined;

  const original = new Map(process.nodes.map((n) => [n.id, n]));
  const nodes: FlowNode[] = [];
  for (const n of process.nodes) {
    if (!inside.has(n.id)) continue;
    const copy: FlowNode = { ...n };
    // There are no lanes at this level.
    delete copy.laneId;
    const host = n.attachedToId !== undefined && n.parentId === undefined ? original.get(n.attachedToId) : undefined;
    const parent = host ? host.parentId : n.parentId;
    if (parent === sub.id || parent === undefined) delete copy.parentId;
    else copy.parentId = parent;
    nodes.push(copy);
  }
  const flows: Flow[] = process.flows.filter((f) => inside.has(f.sourceId) && inside.has(f.targetId)).map((f) => ({ ...f }));

  return {
    id: sub.id,
    ...(sub.originalId !== undefined ? { originalId: sub.originalId } : {}),
    name: sub.name,
    documentation: sub.documentation ?? '',
    lanes: [],
    nodes,
    flows,
    // The kind of diagram it is part of: the comparison and the views read it.
    ...(process.source ? { source: { ...process.source } } : {}),
    subProcess: { levelId, eventSubProcess: sub.triggeredByEvent === true },
  };
}
