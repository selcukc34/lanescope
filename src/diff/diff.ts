// Compares two versions of a process: what was added, removed or changed in
// its nodes, flows and lanes, in the process itself and in the business
// objects (XSD / TWX data types) of the package. Pure: no vscode, no file
// access. Only reports; nothing is written anywhere.
//
// Matching. Elements of the two versions are paired before they are
// compared. Nodes are paired in three passes; each pass looks only at the
// nodes the earlier passes left unpaired:
//   a. Same identity (originalId ?? id) and the same kind family. Bob keeps
//      its ids when it generates a process again.
//   b. Same name, kind family and scope (parents paired, or both at the top
//      level), when that name is unique on both sides. BAW ids are not stable
//      between versions or across an import. Repeated until nothing new pairs,
//      so the children of a sub-process paired here can pair too.
//   c. Renamed: same kind family, paired lanes, the same paired predecessors
//      and the same paired successors (neither set empty), when there is one
//      candidate on each side. Repeated until nothing new pairs. Catches a
//      rename whose id changed too (Bob ids may be derived from the name).
// Kind families: activities (tasks of every kind, call activities,
// sub-processes, unknown elements), gateways, start events, end events and
// intermediate events. A change of kind within a family is a change ("Type").
// Flows pair by identity, else by paired source and target when one flow on
// each side joins them. Lanes pair by identity, else by a unique name. The
// lanes of a sub-process's own diagram pair the same way, within each pair
// of sub-processes; nodes are paired again with them, so pass c works for
// the nodes inside too.
//
// Compared: names, kinds, lanes, documentation, performers, called elements,
// inputs and outputs, user task and timer settings, conditions and default
// flows, process variables and data type fields. Not compared: positions,
// sizes, ports and label positions, and the ids themselves.
//
// Sub-processes. A sub-process with added, changed or removed elements inside
// it (at any depth), its own lanes included, is marked changed, and its
// entry says "Inner changes: N" (N entries inside it). An added sub-process gets no such line: everything
// in it is new. The elements inside a sub-process list the sub-processes
// that hold them (`enclosing`), so a view that draws the sub-process
// collapsed can point at it.
//
// Script text and mapped values never appear in the result: a changed
// script is reported as "Script changed", a changed mapping by the names of
// its parameters only.

import { KIND_LABELS } from '../model/labels';
import type {
  DataField,
  DataMapping,
  DataParameter,
  DataType,
  Flow,
  FlowNode,
  FlowNodeKind,
  Lane,
  Process,
  ProcessPackage,
  ProcessVariable,
} from '../model/model';

export type DiffElementType = 'process' | 'node' | 'flow' | 'lane' | 'dataType';

/** How an element of the current version is marked in the diagram. */
export type DiffMark = 'added' | 'changed';

export interface DiffEntry {
  elementType: DiffElementType;
  /** Id in the current version (the diagram element id); added and changed entries. A data type's name. */
  currentId?: string;
  /** Id in the base version; removed and changed entries. A data type's name. */
  baseId?: string;
  /** e.g. `User task "Manager Approval"`. */
  label: string;
  /** Changed entries: one line per change, "Field: old → new". Empty for added and removed entries. */
  changes: string[];
}

/** How many nodes each matching pass paired. */
export interface NodeMatchCounts {
  byId: number;
  byName: number;
  byNeighbors: number;
}

export interface ProcessDiff {
  /** In the current version only, in model order. */
  added: DiffEntry[];
  /** In the base version only, in the base's order. */
  removed: DiffEntry[];
  /** In both, with changes; the process first, then nodes, flows, lanes and data types. */
  changed: DiffEntry[];
  counts: { added: number; removed: number; changed: number };
  /** Current element id → mark, for the nodes, flows and lanes that were added or changed. */
  marks: Record<string, DiffMark>;
  /** Current id of an added or changed node or flow inside a sub-process → the sub-processes around it, nearest first. */
  enclosing: Record<string, string[]>;
  nodeMatches: NodeMatchCounts;
}

/** Longest value shown in a change line; longer ones are cut. */
export const MAX_VALUE_LENGTH = 80;

const identity = (x: { id: string; originalId?: string }): string => x.originalId ?? x.id;

/**
 * The process of `base` to compare `process` (of `current`) with: the one
 * with the same identity, else the one with the same name (when only one has
 * it), else the only process when both packages hold one.
 */
export function matchProcess(base: ProcessPackage, process: Process, current: ProcessPackage): Process | undefined {
  const id = identity(process);
  const byId = base.processes.find((p) => identity(p) === id);
  if (byId) return byId;
  const name = process.name.trim();
  if (name) {
    const named = base.processes.filter((p) => p.name.trim() === name);
    if (named.length === 1) return named[0];
    if (named.length > 1) return undefined;
  }
  return base.processes.length === 1 && current.processes.length === 1 ? base.processes[0] : undefined;
}

/** Compares `current` with `base`, and the data types of their packages. */
export function diffProcess(base: Process, current: Process, baseTypes: DataType[], currentTypes: DataType[]): ProcessDiff {
  const processLanes = matchLanes(base.lanes, current.lanes);
  let matched = matchNodes(base, current, processLanes);
  let lanes = withSubProcessLanes(processLanes, base, current, matched.nodes);
  // Sub-process lanes pair once their sub-processes do; pairing the nodes again with them can pair more.
  for (let round = 0; round < MAX_LANE_ROUNDS && lanes.toBase.size > processLanes.toBase.size; round++) {
    const again = matchNodes(base, current, lanes);
    const more = withSubProcessLanes(processLanes, base, current, again.nodes);
    const done = again.nodes.toBase.size === matched.nodes.toBase.size && more.toBase.size === lanes.toBase.size;
    matched = again;
    lanes = more;
    if (done) break;
  }
  const { nodes, counts: nodeMatches } = matched;
  const flows = matchFlows(base.flows, current.flows, nodes);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];

  const processChanges = compareProcess(base, current);
  if (processChanges.length > 0) {
    changed.push({ elementType: 'process', currentId: current.id, baseId: base.id, label: `Process ${quote(current.name || current.id)}`, changes: processChanges });
  }

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const currentNodes = new Map(current.nodes.map((n) => [n.id, n]));
  const baseLanes = new Map([...base.lanes, ...base.nodes.flatMap((n) => n.lanes ?? [])].map((l) => [l.id, l]));
  const currentLanes = new Map([...current.lanes, ...current.nodes.flatMap((n) => n.lanes ?? [])].map((l) => [l.id, l]));
  const ctx: Context = { nodes, lanes, baseNodes, currentNodes, baseLanes, currentLanes };

  // Nodes, flows, lanes: in model order (removed: in the base's order).
  const out: Lists = { added, removed, changed, marks: {} };
  diffList(out, 'node', base.nodes, current.nodes, nodes, (n) => nodeLabel(n), (b, c) => compareNodes(b, c, ctx));
  diffList(
    out,
    'flow',
    base.flows,
    current.flows,
    flows,
    (f, side) => flowLabel(f, side === 'base' ? baseNodes : currentNodes),
    (b, c) => compareFlows(b, c, ctx),
  );
  diffList(out, 'lane', base.lanes, current.lanes, lanes, (l) => laneLabel(l), compareLanes);
  // The lanes of each pair of sub-processes; those of an added or removed sub-process are not listed.
  for (const c of current.nodes) {
    const baseId = c.kind === 'subProcess' ? nodes.toBase.get(c.id) : undefined;
    const b = baseId !== undefined ? baseNodes.get(baseId) : undefined;
    if (!b || (!b.lanes && !c.lanes)) continue;
    const where = (side: 'base' | 'current') => ` in sub-process ${quote((side === 'base' ? b : c).name.trim() || (side === 'base' ? b : c).id)}`;
    diffList(out, 'lane', b.lanes ?? [], c.lanes ?? [], lanes, (l, side) => laneLabel(l) + where(side), compareLanes);
  }
  const marks = out.marks;
  const enclosing = rollUpSubProcesses(out, base, current, nodes);

  const types = diffDataTypes(baseTypes, currentTypes);
  added.push(...types.added);
  removed.push(...types.removed);
  changed.push(...types.changed);

  return {
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    marks,
    enclosing,
    nodeMatches,
  };
}

/**
 * Counts the entries inside each sub-process of `current` (removed ones by
 * the base sub-process paired with it), marks those sub-processes changed
 * and adds "Inner changes: N" to their entry, creating the entry when the
 * sub-process itself did not change. Returns the sub-processes around each
 * added or changed node and flow.
 */
function rollUpSubProcesses(out: Lists, base: Process, current: Process, nodes: Matching): Record<string, string[]> {
  const enclosing: Record<string, string[]> = {};
  const nested = (p: Process) => p.nodes.some((n) => n.parentId !== undefined || n.lanes !== undefined);
  if (!nested(current) && !nested(base)) return enclosing;

  const currentParent = new Map(current.nodes.map((n) => [n.id, n.parentId]));
  const baseParent = new Map(base.nodes.map((n) => [n.id, n.parentId]));
  const currentSource = new Map(current.flows.map((f) => [f.id, f.sourceId]));
  const baseSource = new Map(base.flows.map((f) => [f.id, f.sourceId]));
  /** The sub-processes around a node (for a flow: around its source), nearest first. */
  const around = (nodeId: string | undefined, parents: Map<string, string | undefined>): string[] => {
    const chain: string[] = [];
    let at = nodeId !== undefined ? parents.get(nodeId) : undefined;
    while (at !== undefined && parents.has(at) && !chain.includes(at)) {
      chain.push(at);
      at = parents.get(at);
    }
    return chain;
  };
  const inner = new Map<string, number>();
  const count = (subIds: string[]) => {
    for (const id of subIds) inner.set(id, (inner.get(id) ?? 0) + 1);
  };

  // A lane of a sub-process's own diagram is inside that sub-process.
  const laneOwners = (p: Process) => new Map(p.nodes.flatMap((n) => (n.lanes ?? []).map((l) => [l.id, n.id] as const)));
  const currentLaneOwner = laneOwners(current);
  const baseLaneOwner = laneOwners(base);
  const laneChain = (owner: string | undefined, parents: Map<string, string | undefined>) =>
    owner === undefined ? [] : [owner, ...around(owner, parents).filter((id) => id !== owner)];

  for (const e of [...out.added, ...out.changed]) {
    if (e.currentId === undefined) continue;
    if (e.elementType === 'lane') {
      const chain = laneChain(currentLaneOwner.get(e.currentId), currentParent);
      if (chain.length > 0) {
        enclosing[e.currentId] = chain;
        count(chain);
      }
      continue;
    }
    if (e.elementType !== 'node' && e.elementType !== 'flow') continue;
    const chain = around(e.elementType === 'node' ? e.currentId : currentSource.get(e.currentId), currentParent);
    if (chain.length === 0) continue;
    enclosing[e.currentId] = chain;
    count(chain);
  }
  for (const e of out.removed) {
    if (e.baseId === undefined) continue;
    if (e.elementType === 'lane') {
      count(laneChain(baseLaneOwner.get(e.baseId), baseParent).map((id) => nodes.toCurrent.get(id)).filter((id): id is string => id !== undefined));
      continue;
    }
    if (e.elementType !== 'node' && e.elementType !== 'flow') continue;
    const chain = around(e.elementType === 'node' ? e.baseId : baseSource.get(e.baseId), baseParent);
    count(chain.map((id) => nodes.toCurrent.get(id)).filter((id): id is string => id !== undefined));
  }

  const currentNodes = new Map(current.nodes.map((n) => [n.id, n]));
  for (const [subId, n] of inner) {
    const node = currentNodes.get(subId);
    if (!node || out.marks[subId] === 'added') continue;
    const line = `Inner changes: ${n}`;
    const entry = out.changed.find((e) => e.elementType === 'node' && e.currentId === subId);
    if (entry) {
      entry.changes.push(line);
    } else {
      const baseId = nodes.toBase.get(subId);
      out.changed.push({ elementType: 'node', currentId: subId, ...(baseId !== undefined ? { baseId } : {}), label: nodeLabel(node), changes: [line] });
    }
    out.marks[subId] = 'changed';
  }
  // Node entries stay in model order, before flows and lanes.
  const order = new Map(current.nodes.map((n, i) => [n.id, i]));
  const nodeEntries = out.changed.filter((e) => e.elementType === 'node').sort((a, b) => order.get(a.currentId!)! - order.get(b.currentId!)!);
  const head = out.changed.filter((e) => e.elementType === 'process');
  const tail = out.changed.filter((e) => e.elementType !== 'process' && e.elementType !== 'node');
  out.changed.splice(0, out.changed.length, ...head, ...nodeEntries, ...tail);
  return enclosing;
}

interface Lists {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  marks: Record<string, DiffMark>;
}

/** Adds the entries and marks of one kind of element. */
function diffList<T extends { id: string }>(
  out: Lists,
  type: DiffElementType,
  base: T[],
  current: T[],
  matching: Matching,
  label: (item: T, side: 'base' | 'current') => string,
  compare: (b: T, c: T) => string[],
): void {
  const baseById = new Map(base.map((x) => [x.id, x]));
  for (const c of current) {
    const baseId = matching.toBase.get(c.id);
    const b = baseId !== undefined ? baseById.get(baseId) : undefined;
    if (baseId === undefined || !b) {
      out.added.push({ elementType: type, currentId: c.id, label: label(c, 'current'), changes: [] });
      out.marks[c.id] = 'added';
      continue;
    }
    const changes = compare(b, c);
    if (changes.length === 0) continue;
    out.changed.push({ elementType: type, currentId: c.id, baseId, label: label(c, 'current'), changes });
    out.marks[c.id] = 'changed';
  }
  for (const b of base) {
    if (!matching.toCurrent.has(b.id)) out.removed.push({ elementType: type, baseId: b.id, label: label(b, 'base'), changes: [] });
  }
}

// ---------------------------------------------------------------------------
// Matching

/** Pairs of base and current ids, both ways. */
class Matching {
  readonly toCurrent = new Map<string, string>();
  readonly toBase = new Map<string, string>();

  add(baseId: string, currentId: string): void {
    this.toCurrent.set(baseId, currentId);
    this.toBase.set(currentId, baseId);
  }
}

/** Marks a base id that has no pair, so it never equals a current id. */
const UNPAIRED = '\u0001';
const SEP = '\u0000';

type Family = 'activity' | 'gateway' | 'startEvent' | 'endEvent' | 'intermediateEvent';

function family(kind: FlowNodeKind): Family {
  switch (kind) {
    case 'startEvent':
    case 'endEvent':
    case 'intermediateEvent':
      return kind;
    case 'exclusiveGateway':
    case 'parallelGateway':
    case 'inclusiveGateway':
    case 'eventBasedGateway':
      return 'gateway';
    default:
      return 'activity';
  }
}

function matchLanes(base: Lane[], current: Lane[]): Matching {
  const m = new Matching();
  const byIdentity = new Map(current.map((l) => [identity(l), l]));
  for (const b of base) {
    const c = byIdentity.get(identity(b));
    if (c && !m.toBase.has(c.id)) m.add(b.id, c.id);
  }
  pairUnique(
    m,
    base.filter((b) => !m.toCurrent.has(b.id)),
    current.filter((c) => !m.toBase.has(c.id)),
    (l) => l.name.trim() || undefined,
    (l) => l.name.trim() || undefined,
  );
  return m;
}

/** Most times nodes are paired again with the lanes of newly paired sub-processes; a guard. */
const MAX_LANE_ROUNDS = 8;

/** The pairs of `processLanes` and of the own lanes of every pair of sub-processes. */
function withSubProcessLanes(processLanes: Matching, base: Process, current: Process, nodes: Matching): Matching {
  const m = new Matching();
  for (const [b, c] of processLanes.toCurrent) m.add(b, c);
  const currentById = new Map(current.nodes.map((n) => [n.id, n]));
  for (const b of base.nodes) {
    if (!b.lanes) continue;
    const cId = nodes.toCurrent.get(b.id);
    const c = cId !== undefined ? currentById.get(cId) : undefined;
    if (!c?.lanes) continue;
    for (const [bl, cl] of matchLanes(b.lanes, c.lanes).toCurrent) m.add(bl, cl);
  }
  return m;
}

function matchNodes(base: Process, current: Process, lanes: Matching): { nodes: Matching; counts: NodeMatchCounts } {
  const m = new Matching();
  const counts: NodeMatchCounts = { byId: 0, byName: 0, byNeighbors: 0 };
  const unpairedBase = () => base.nodes.filter((n) => !m.toCurrent.has(n.id));
  const unpairedCurrent = () => current.nodes.filter((n) => !m.toBase.has(n.id));

  // a. Same identity, same family.
  const byIdentity = new Map(current.nodes.map((n) => [identity(n), n]));
  for (const b of base.nodes) {
    const c = byIdentity.get(identity(b));
    if (c && !m.toBase.has(c.id) && family(b.kind) === family(c.kind)) {
      m.add(b.id, c.id);
      counts.byId++;
    }
  }

  // b. Same name, family and scope; unique on both sides.
  const baseScope = (n: FlowNode) => (n.parentId === undefined ? '' : (m.toCurrent.get(n.parentId) ?? UNPAIRED + n.parentId));
  for (;;) {
    const paired = pairUnique(
      m,
      unpairedBase(),
      unpairedCurrent(),
      (n) => (n.name.trim() ? [family(n.kind), baseScope(n), n.name.trim()].join(SEP) : undefined),
      (n) => (n.name.trim() ? [family(n.kind), n.parentId ?? '', n.name.trim()].join(SEP) : undefined),
    );
    counts.byName += paired;
    if (paired === 0) break;
  }

  // c. Same family, lane and paired neighbours; one candidate on each side.
  const baseEdges = edges(base.flows);
  const currentEdges = edges(current.flows);
  const baseLane = (n: FlowNode) => (n.laneId === undefined ? '' : (lanes.toCurrent.get(n.laneId) ?? UNPAIRED + n.laneId));
  const pairedIds = (ids: Set<string> | undefined, map: (id: string) => string | undefined) =>
    [...new Set([...(ids ?? [])].map(map).filter((id): id is string => id !== undefined))].sort();
  const neighbourKey = (fam: Family, lane: string, prev: string[], next: string[]) =>
    prev.length === 0 || next.length === 0 ? undefined : [fam, lane, prev.join(','), next.join(',')].join(SEP);
  for (;;) {
    const toCurrent = (id: string) => m.toCurrent.get(id);
    const ifPaired = (id: string) => (m.toBase.has(id) ? id : undefined);
    const paired = pairUnique(
      m,
      unpairedBase(),
      unpairedCurrent(),
      (n) => neighbourKey(family(n.kind), baseLane(n), pairedIds(baseEdges.prev.get(n.id), toCurrent), pairedIds(baseEdges.next.get(n.id), toCurrent)),
      (n) => neighbourKey(family(n.kind), n.laneId ?? '', pairedIds(currentEdges.prev.get(n.id), ifPaired), pairedIds(currentEdges.next.get(n.id), ifPaired)),
    );
    counts.byNeighbors += paired;
    if (paired === 0) break;
  }
  return { nodes: m, counts };
}

function matchFlows(base: Flow[], current: Flow[], nodes: Matching): Matching {
  const m = new Matching();
  const byIdentity = new Map(current.map((f) => [identity(f), f]));
  for (const b of base) {
    const c = byIdentity.get(identity(b));
    if (c && !m.toBase.has(c.id)) m.add(b.id, c.id);
  }
  pairUnique(
    m,
    base.filter((b) => !m.toCurrent.has(b.id)),
    current.filter((c) => !m.toBase.has(c.id)),
    (f) => {
      const source = nodes.toCurrent.get(f.sourceId);
      const target = nodes.toCurrent.get(f.targetId);
      return source !== undefined && target !== undefined ? source + SEP + target : undefined;
    },
    (f) => f.sourceId + SEP + f.targetId,
  );
  return m;
}

/** Pairs the items whose key occurs exactly once on each side; returns how many were paired. */
function pairUnique<B extends { id: string }, C extends { id: string }>(
  m: Matching,
  base: B[],
  current: C[],
  baseKey: (b: B) => string | undefined,
  currentKey: (c: C) => string | undefined,
): number {
  const group = <T>(items: T[], key: (t: T) => string | undefined) => {
    const out = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      if (k === undefined) continue;
      const list = out.get(k);
      if (list) list.push(item);
      else out.set(k, [item]);
    }
    return out;
  };
  const currentGroups = group(current, currentKey);
  let paired = 0;
  for (const [key, bs] of group(base, baseKey)) {
    const cs = currentGroups.get(key);
    if (bs.length === 1 && cs?.length === 1) {
      m.add(bs[0].id, cs[0].id);
      paired++;
    }
  }
  return paired;
}

function edges(flows: Flow[]): { prev: Map<string, Set<string>>; next: Map<string, Set<string>> } {
  const prev = new Map<string, Set<string>>();
  const next = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };
  for (const f of flows) {
    add(next, f.sourceId, f.targetId);
    add(prev, f.targetId, f.sourceId);
  }
  return { prev, next };
}

// ---------------------------------------------------------------------------
// Comparison

interface Context {
  nodes: Matching;
  lanes: Matching;
  baseNodes: Map<string, FlowNode>;
  currentNodes: Map<string, FlowNode>;
  baseLanes: Map<string, Lane>;
  currentLanes: Map<string, Lane>;
}

function compareProcess(b: Process, c: Process): string[] {
  const out: string[] = [];
  textChange(out, 'Name', b.name, c.name);
  documentationChange(out, b.documentation, c.documentation);
  byName(out, 'Variable', b.variables ?? [], c.variables ?? [], (v) => v.name, variableType);
  return out;
}

function compareNodes(b: FlowNode, c: FlowNode, ctx: Context): string[] {
  const out: string[] = [];
  textChange(out, 'Name', b.name, c.name);
  if (b.kind !== c.kind) out.push(`Type: ${KIND_LABELS[b.kind]} → ${KIND_LABELS[c.kind]}`);
  const lanePaired = b.laneId === undefined ? c.laneId === undefined : ctx.lanes.toCurrent.get(b.laneId) === c.laneId;
  if (!lanePaired) {
    out.push(`Lane: ${laneName(b.laneId, ctx.baseLanes)} → ${laneName(c.laneId, ctx.currentLanes)}`);
  }
  documentationChange(out, b.documentation, c.documentation);
  textChange(out, 'Performer', b.performer, c.performer);
  textChange(out, 'Called element', calledName(b), calledName(c));
  byName(out, 'Input', b.inputs, c.inputs, parameterName, parameterType);
  byName(out, 'Output', b.outputs, c.outputs, parameterName, parameterType);
  textChange(out, 'User task assignment', b.userTask?.assignment, c.userTask?.assignment);
  textChange(out, 'User task priority', b.userTask?.priority, c.userTask?.priority);
  textChange(out, 'User task due date', b.userTask?.dueDate, c.userTask?.dueDate);
  textChange(out, 'User task subject', b.userTask?.subject, c.userTask?.subject);
  textChange(out, 'Timer duration', timerDuration(b), timerDuration(c));
  flagChange(out, 'Timer interrupting', b.timer?.interrupting, c.timer?.interrupting);
  flagChange(out, 'Timer repeating', b.timer?.repeating, c.timer?.repeating);
  // The script itself is never put in the result, whatever lanescope.showScripts says.
  if ((b.script?.text ?? '') !== (c.script?.text ?? '') || (b.script?.language ?? '') !== (c.script?.language ?? '')) {
    out.push('Script changed');
  }
  mappingChange(out, 'Input mappings changed', b.inputMappings, c.inputMappings);
  mappingChange(out, 'Output mappings changed', b.outputMappings, c.outputMappings);
  return out;
}

function compareFlows(b: Flow, c: Flow, ctx: Context): string[] {
  const out: string[] = [];
  textChange(out, 'Name', b.name, c.name);
  if (ctx.nodes.toCurrent.get(b.sourceId) !== c.sourceId) {
    out.push(`Source: ${nodeName(b.sourceId, ctx.baseNodes)} → ${nodeName(c.sourceId, ctx.currentNodes)}`);
  }
  if (ctx.nodes.toCurrent.get(b.targetId) !== c.targetId) {
    out.push(`Target: ${nodeName(b.targetId, ctx.baseNodes)} → ${nodeName(c.targetId, ctx.currentNodes)}`);
  }
  textChange(out, 'Condition', b.condition, c.condition);
  flagChange(out, 'Default', b.isDefault, c.isDefault);
  return out;
}

function compareLanes(b: Lane, c: Lane): string[] {
  const out: string[] = [];
  textChange(out, 'Name', b.name, c.name);
  return out;
}

function diffDataTypes(base: DataType[], current: DataType[]): { added: DiffEntry[]; removed: DiffEntry[]; changed: DiffEntry[] } {
  const baseByName = new Map(base.map((t) => [t.name, t]));
  const currentByName = new Map(current.map((t) => [t.name, t]));
  const label = (t: DataType) => `Business object ${quote(t.name)}`;
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  for (const c of current) {
    const b = baseByName.get(c.name);
    if (!b) {
      added.push({ elementType: 'dataType', currentId: c.name, label: label(c), changes: [] });
      continue;
    }
    const changes: string[] = [];
    byName(changes, 'Field', b.fields, c.fields, (f) => f.name, (f) => f.type);
    const baseFields = new Map(b.fields.map((f) => [f.name, f]));
    for (const f of c.fields) {
      const old = baseFields.get(f.name);
      if (!old) continue;
      fieldFlag(changes, 'required', f.name, old, f);
      fieldFlag(changes, 'list', f.name, old, f);
    }
    if (changes.length > 0) changed.push({ elementType: 'dataType', currentId: c.name, baseId: b.name, label: label(c), changes });
  }
  for (const b of base) {
    if (!currentByName.has(b.name)) removed.push({ elementType: 'dataType', baseId: b.name, label: label(b), changes: [] });
  }
  return { added, removed, changed };
}

function fieldFlag(out: string[], flag: 'required' | 'list', name: string, b: DataField, c: DataField): void {
  if (b[flag] !== c[flag]) out.push(`Field ${flag} changed: ${name}: ${yesNo(b[flag])} → ${yesNo(c[flag])}`);
}

/**
 * Items of a list compared by name: "<What> added: name (type)",
 * "<What> removed: name", "<What> type changed: name: old → new".
 */
function byName<T>(out: string[], what: string, base: T[], current: T[], name: (t: T) => string, type: (t: T) => string | undefined): void {
  const baseByName = new Map(base.map((t) => [name(t), t]));
  const currentByName = new Map(current.map((t) => [name(t), t]));
  for (const c of current) {
    const n = name(c);
    const b = baseByName.get(n);
    if (!b) {
      const t = type(c);
      out.push(`${what} added: ${n}${t ? ` (${t})` : ''}`);
    } else if ((type(b) ?? '') !== (type(c) ?? '')) {
      out.push(`${what} type changed: ${n}: ${type(b) || NONE} → ${type(c) || NONE}`);
    }
  }
  for (const b of base) {
    if (!currentByName.has(name(b))) out.push(`${what} removed: ${name(b)}`);
  }
}

/** Names of the parameters whose mapping differs; the mapped values are never shown. */
function mappingChange(out: string[], what: string, base: DataMapping[] | undefined, current: DataMapping[] | undefined): void {
  const key = (m: DataMapping) => JSON.stringify([m.mapped, m.literal, m.value ?? null]);
  const baseBy = new Map((base ?? []).map((m) => [m.parameter, key(m)]));
  const currentBy = new Map((current ?? []).map((m) => [m.parameter, key(m)]));
  const names = [...new Set([...currentBy.keys(), ...baseBy.keys()])].filter((n) => baseBy.get(n) !== currentBy.get(n));
  if (names.length > 0) out.push(`${what}: ${names.join(', ')}`);
}

const NONE = '(none)';

function textChange(out: string[], what: string, base: string | undefined, current: string | undefined): void {
  const b = base?.trim() ?? '';
  const c = current?.trim() ?? '';
  if (b !== c) out.push(`${what}: ${shown(b)} → ${shown(c)}`);
}

/** Documentation as plain text on one line; when the cut values look the same, only that it changed. */
function documentationChange(out: string[], base: string | undefined, current: string | undefined): void {
  const b = oneLine(base);
  const c = oneLine(current);
  if (b === c) return;
  const from = shown(b);
  const to = shown(c);
  out.push(from === to ? 'Documentation changed' : `Documentation: ${from} → ${to}`);
}

function flagChange(out: string[], what: string, base: boolean | undefined, current: boolean | undefined): void {
  if ((base ?? false) !== (current ?? false)) out.push(`${what}: ${yesNo(base ?? false)} → ${yesNo(current ?? false)}`);
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** A value as a change line shows it: quoted, cut to MAX_VALUE_LENGTH, or "(none)". */
function shown(value: string): string {
  if (!value) return NONE;
  const line = oneLine(value);
  return quote(line.length > MAX_VALUE_LENGTH ? `${line.slice(0, MAX_VALUE_LENGTH - 1)}…` : line);
}

const quote = (s: string) => `"${s}"`;
const yesNo = (v: boolean) => (v ? 'yes' : 'no');

const parameterName = (p: DataParameter) => p.name || p.id;
const parameterType = (p: DataParameter) => typeText(p.typeName ?? p.typeRef, p.isCollection);
const variableType = (v: ProcessVariable) => typeText(v.typeName ?? v.typeRef, v.isCollection);
const typeText = (type: string | undefined, list: boolean) => (type ? `${type}${list ? '[]' : ''}` : list ? 'list' : undefined);

function calledName(n: FlowNode): string | undefined {
  return n.calledElement ? (n.calledElement.name ?? n.calledElement.id) : undefined;
}

function timerDuration(n: FlowNode): string | undefined {
  return n.timer ? (n.timer.unit ? `${n.timer.duration} ${n.timer.unit}` : n.timer.duration) : undefined;
}

function laneName(id: string | undefined, lanes: Map<string, Lane>): string {
  if (id === undefined) return NONE;
  return quote(lanes.get(id)?.name || id);
}

function nodeName(id: string, nodes: Map<string, FlowNode>): string {
  return quote(nodes.get(id)?.name || id);
}

function nodeLabel(n: FlowNode): string {
  return `${KIND_LABELS[n.kind]} ${n.name.trim() ? quote(n.name.trim()) : '(unnamed)'}`;
}

function flowLabel(f: Flow, nodes: Map<string, FlowNode>): string {
  if (f.name.trim()) return `Flow ${quote(f.name.trim())}`;
  return `Flow from ${nodeName(f.sourceId, nodes)} to ${nodeName(f.targetId, nodes)}`;
}

function laneLabel(l: Lane): string {
  return `Lane ${l.name.trim() ? quote(l.name.trim()) : '(unnamed)'}`;
}
