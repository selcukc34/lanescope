// The trace check: is everything the description names drawn in the process,
// and is there anything in the process the description does not name? A
// checklist of rows, matched by name only (exact, then normalised, then the
// same words in another order). The logic of the process (conditions,
// routing rules) is not checked. Pure: no vscode, no file access.
//
// Scope: the chosen process. Nodes inside its sub-processes are candidates
// for the steps (a row then names the sub-processes around the node, so the
// view can open them); only top-level activities and gateways count as
// extra. Start, end and other events are never extra.

import type { DataType, Flow, FlowNode, FlowNodeKind, Process, ProcessPackage } from '../model/model';
import { subProcessLevelId } from '../model/subProcess';
import type { DescribedBusinessObject, DescribedHumanTask, DescriptionItem, GatewayPathGroup, ProcessDescription } from './description';

export type TraceRowKind = 'step' | 'gateway-path' | 'bo-field' | 'task-field' | 'extra-node';
export type TraceStatus = 'matched' | 'near' | 'missing' | 'unchecked' | 'extra';

/** What a row points at in the process, when anything. */
export type TraceTarget =
  | { type: 'node'; id: string; name: string; subProcessLevels: string[] }
  | { type: 'flow'; id: string; name: string; subProcessLevels: string[] }
  | { type: 'field'; dataType: string; name: string };

export interface TraceRow {
  kind: TraceRowKind;
  /** Title of the group the row is listed under, e.g. "Main process steps", "Business object · OrderRequest". */
  group: string;
  /** The text of the description (for an extra row: the name in the process). */
  text: string;
  status: TraceStatus;
  /** 1-based line in the description; undefined for extra rows. */
  line?: number;
  target?: TraceTarget;
  /** Short reason, e.g. "matched as start event 'Order Submitted'". */
  note: string;
}

export interface TraceCounts {
  matched: number;
  near: number;
  missing: number;
  unchecked: number;
  extra: number;
  /** Rows the process can answer: matched + near + missing (not unchecked, not extra). */
  checkable: number;
}

export interface TraceResult {
  rows: TraceRow[];
  counts: TraceCounts;
  /** False when the description has none of the checked sections: nothing to check at all. */
  hasSections: boolean;
  /** False when the description has no Main process steps section (no extra activities or gateways then). */
  hasSteps: boolean;
  /** Headings of the sections that are not checked. */
  notChecked: string[];
}

// ---- Names --------------------------------------------------------------

/** Technical suffixes Bob and BAW add to activity names: "Validate Order SF". */
const TECHNICAL_SUFFIX = /(?:\s+(?:sf|service\s+flow|service|task|activity|step))+$/;

/** Lower case, "_" "-" and spaces as one space, no punctuation, no technical suffix. */
export function normalizeName(name: string): string {
  const plain = name
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = plain.replace(TECHNICAL_SUFFIX, '').trim();
  return stripped === '' ? plain : stripped;
}

/** A crude English stem, enough for "submitted" ~ "submit", "approved" ~ "approve". */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** The stems of the words of a name, sorted: the same set in any order matches. */
export function wordKey(name: string): string {
  const words = normalizeName(name).split(' ').filter((w) => w !== '');
  return [...new Set(words.map(stem))].sort().join(' ');
}

export type MatchLevel = 'exact' | 'normalized' | 'words';
const LEVELS: readonly MatchLevel[] = ['exact', 'normalized', 'words'];

/** How `a` matches `b` at this level. */
function matchesAt(level: MatchLevel, a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (level === 'exact') return a.trim() === b.trim();
  if (level === 'normalized') return normalizeName(a) === normalizeName(b);
  const key = wordKey(a);
  return key !== '' && key === wordKey(b);
}

/** The best level at which `a` matches `b`, or undefined. */
export function matchLevel(a: string, b: string): MatchLevel | undefined {
  return LEVELS.find((level) => matchesAt(level, a, b));
}

// ---- Nodes --------------------------------------------------------------

const ACTIVITY_KINDS: ReadonlySet<FlowNodeKind> = new Set(['task', 'scriptTask', 'userTask', 'serviceTask', 'callActivity', 'subProcess']);
const GATEWAY_KINDS: ReadonlySet<FlowNodeKind> = new Set(['exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway']);

const KIND_WORDS: Partial<Record<FlowNodeKind, string>> = {
  startEvent: 'start event',
  endEvent: 'end event',
  intermediateEvent: 'event',
  userTask: 'user task',
  scriptTask: 'script task',
  serviceTask: 'service task',
  callActivity: 'call activity',
  subProcess: 'sub-process',
  exclusiveGateway: 'gateway',
  parallelGateway: 'gateway',
  inclusiveGateway: 'gateway',
  eventBasedGateway: 'gateway',
};

function kindWord(node: FlowNode): string {
  return KIND_WORDS[node.kind] ?? 'activity';
}

const isActivity = (n: FlowNode) => ACTIVITY_KINDS.has(n.kind);
const isGateway = (n: FlowNode) => GATEWAY_KINDS.has(n.kind);

/** Order in which equally good candidates are taken: activities, gateways, events; top level first. */
function candidateRank(n: FlowNode): number {
  const kind = isActivity(n) ? 0 : isGateway(n) ? 1 : 2;
  return kind * 2 + (n.parentId === undefined ? 0 : 1);
}

/** The level ids of the sub-processes around a node, outermost first. */
function subProcessLevels(process: Process, node: FlowNode): string[] {
  const byId = new Map(process.nodes.map((n) => [n.id, n]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    chain.unshift(subProcessLevelId(parent));
    parent = parent.parentId !== undefined ? byId.get(parent.parentId) : undefined;
  }
  return chain;
}

function nodeTarget(process: Process, node: FlowNode): TraceTarget {
  return { type: 'node', id: node.id, name: node.name, subProcessLevels: subProcessLevels(process, node) };
}

function flowTarget(process: Process, flow: Flow, source: FlowNode | undefined): TraceTarget {
  return { type: 'flow', id: flow.id, name: flow.name, subProcessLevels: source ? subProcessLevels(process, source) : [] };
}

/** The best node for a name (does not take it). */
function findNode(nodes: readonly FlowNode[], name: string): { node: FlowNode; level: MatchLevel } | undefined {
  for (const level of LEVELS) {
    const node = nodes.filter((n) => matchesAt(level, name, n.name)).sort((a, b) => candidateRank(a) - candidateRank(b))[0];
    if (node) return { node, level };
  }
  return undefined;
}

function nearNote(level: MatchLevel, what: string, name: string): string {
  return level === 'words' ? `same words in another order: ${what} '${name}'` : `matched as ${what} '${name}'`;
}

// ---- Check --------------------------------------------------------------

/**
 * Checks `process` (default: the first of the package) against the
 * description. Rows come in the description's order, each section's extra
 * rows after its own, the extra activities and gateways last.
 */
export function checkTrace(description: ProcessDescription, pkg: ProcessPackage, process: Process | undefined = pkg.processes[0]): TraceResult {
  const rows: TraceRow[] = [];
  const flags = { hasSections: description.sections.length > 0, hasSteps: description.sections.includes('steps') };
  if (!process) return { rows, counts: countRows(rows), ...flags, notChecked: [...description.notChecked] };

  /** Nodes that a step or a gateway path group stands for: not extra. */
  const described = new Set<string>();
  rows.push(...stepRows(description, process, described));
  for (const group of description.gatewayPaths) rows.push(...gatewayRows(group, process, described));
  for (const bo of description.businessObjects) rows.push(...businessObjectRows(bo, pkg.dataTypes));
  for (const task of description.humanTasks) rows.push(...taskRows(task, process));

  // Extra: top-level activities and gateways nothing in the description stands for.
  if (description.steps.some((g) => g.steps.length > 0)) {
    for (const n of process.nodes) {
      if (n.parentId !== undefined || described.has(n.id) || !(isActivity(n) || isGateway(n))) continue;
      rows.push({
        kind: 'extra-node',
        group: 'Not in the description',
        text: n.name || n.id,
        status: 'extra',
        target: nodeTarget(process, n),
        note: `${kindWord(n)} in the process that no step names`,
      });
    }
  }
  return { rows, counts: countRows(rows), ...flags, notChecked: [...description.notChecked] };
}

/** Steps: each takes one node, best level first over all steps, so an exact match is never taken by a looser one. */
function stepRows(description: ProcessDescription, process: Process, described: Set<string>): TraceRow[] {
  const steps = description.steps.flatMap((g) => g.steps.map((item) => ({ group: g.section, item })));
  const taken = new Map<number, { node: FlowNode; level: MatchLevel }>();
  const used = new Set<string>();
  const candidates = [...process.nodes].sort((a, b) => candidateRank(a) - candidateRank(b));
  for (const level of LEVELS) {
    steps.forEach(({ item }, i) => {
      if (taken.has(i)) return;
      const node = candidates.find((n) => !used.has(n.id) && matchesAt(level, item.text, n.name));
      if (!node) return;
      taken.set(i, { node, level });
      used.add(node.id);
    });
  }
  return steps.map(({ group, item }, i) => {
    const hit = taken.get(i);
    if (!hit) return { kind: 'step', group, text: item.text, status: 'missing', line: item.line, note: 'no activity, gateway or event has this name' };
    described.add(hit.node.id);
    const where = hit.node.parentId !== undefined ? ' (inside a sub-process)' : '';
    const what = kindWord(hit.node);
    return {
      kind: 'step',
      group,
      text: item.text,
      status: hit.level === 'exact' ? 'matched' : 'near',
      line: item.line,
      target: nodeTarget(process, hit.node),
      note: (hit.level === 'exact' ? `${what}` : nearNote(hit.level, what, hit.node.name)) + where,
    };
  });
}

/** String literals of a condition: "AUTO_APPROVE" in tw.local.order.route == "AUTO_APPROVE". */
function conditionLiterals(condition: string | undefined): string[] {
  if (!condition) return [];
  return [...condition.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((m) => m[1] ?? m[2]).filter((s) => s !== '');
}

/** How a path name matches a flow: by its name, else by a literal of its condition. */
function pathMatch(name: string, flow: Flow): { level: MatchLevel; by: 'name' | 'condition' } | undefined {
  const byName = matchLevel(name, flow.name);
  if (byName === 'exact' || byName === 'normalized') return { level: byName, by: 'name' };
  for (const literal of conditionLiterals(flow.condition)) {
    const level = matchLevel(name, literal);
    if (level === 'exact' || level === 'normalized') return { level, by: 'condition' };
  }
  return undefined;
}

/** The first gateway reached from `start` along the sequence flows (not `start` itself). */
function firstGatewayAfter(process: Process, start: FlowNode): FlowNode | undefined {
  const byId = new Map(process.nodes.map((n) => [n.id, n]));
  const seen = new Set([start.id]);
  let frontier = [start.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const f of process.flows) {
        if (f.sourceId !== id || seen.has(f.targetId)) continue;
        seen.add(f.targetId);
        const target = byId.get(f.targetId);
        if (!target) continue;
        if (isGateway(target)) return target;
        next.push(target.id);
      }
    }
    frontier = next;
  }
  return undefined;
}

function gatewayRows(group: GatewayPathGroup, process: Process, described: Set<string>): TraceRow[] {
  const gateways = process.nodes.filter(isGateway);
  const outgoing = (g: FlowNode) => process.flows.filter((f) => f.sourceId === g.id);
  let gateway: FlowNode | undefined;
  let why = '';

  if (group.after !== undefined) {
    const from = findNode(process.nodes, group.after);
    if (from) {
      gateway = firstGatewayAfter(process, from.node);
      if (!gateway) why = `no gateway follows '${from.node.name}'`;
    } else {
      why = `no step is named '${group.after}'`;
    }
  } else {
    // No gateway named: the one whose outgoing flows carry the most path names.
    let best = 0;
    for (const g of gateways) {
      const hits = group.paths.filter((p) => outgoing(g).some((f) => pathMatch(p.text, f))).length;
      if (hits > best) {
        best = hits;
        gateway = g;
      }
    }
    if (!gateway) why = 'no gateway has an outgoing flow with this name';
  }

  const title = group.after !== undefined ? `${group.section} · after ${group.after}` : group.section;
  if (!gateway) {
    return group.paths.map((p) => ({ kind: 'gateway-path', group: title, text: p.text, status: 'missing', line: p.line, note: why }));
  }
  described.add(gateway.id);
  const gw = gateway;
  const gwName = gw.name || gw.id;
  const flows = outgoing(gw);
  const usedFlows = new Set<string>();
  const rows: TraceRow[] = group.paths.map((p) => {
    let hit: { flow: Flow; level: MatchLevel; by: 'name' | 'condition' } | undefined;
    for (const f of flows) {
      if (usedFlows.has(f.id)) continue;
      const m = pathMatch(p.text, f);
      if (m && (!hit || rankPath(m) < rankPath(hit))) hit = { flow: f, ...m };
    }
    if (!hit) {
      return { kind: 'gateway-path', group: title, text: p.text, status: 'missing', line: p.line, note: `no outgoing flow of gateway '${gwName}' has this name` };
    }
    usedFlows.add(hit.flow.id);
    const exact = hit.level === 'exact' && hit.by === 'name';
    const note =
      hit.by === 'condition'
        ? `named in the condition of flow '${hit.flow.name || hit.flow.id}' of gateway '${gwName}'`
        : exact
          ? `outgoing flow of gateway '${gwName}'`
          : `matched as flow '${hit.flow.name}' of gateway '${gwName}'`;
    return { kind: 'gateway-path', group: title, text: p.text, status: exact ? 'matched' : 'near', line: p.line, target: flowTarget(process, hit.flow, gw), note };
  });
  for (const f of flows) {
    if (usedFlows.has(f.id)) continue;
    const target = process.nodes.find((n) => n.id === f.targetId);
    rows.push({
      kind: 'gateway-path',
      group: title,
      text: f.name || `to ${target?.name || f.targetId}`,
      status: 'extra',
      target: flowTarget(process, f, gw),
      note: `outgoing flow of gateway '${gwName}' that no path names`,
    });
  }
  return rows;
}

function rankPath(m: { level: MatchLevel; by: 'name' | 'condition' }): number {
  return (m.by === 'name' ? 0 : 2) + (m.level === 'exact' ? 0 : 1);
}

/** The data type the description names: the same name, else the same normalised name. */
function findDataType(bo: DescribedBusinessObject, types: readonly DataType[]): DataType | undefined {
  return types.find((t) => t.name === bo.name) ?? types.find((t) => normalizeName(t.name) === normalizeName(bo.name));
}

function businessObjectRows(bo: DescribedBusinessObject, types: readonly DataType[]): TraceRow[] {
  const type = findDataType(bo, types);
  const group = `${bo.section} · ${bo.name}`;
  if (!type) {
    const note = `the process has no business object '${bo.name}'`;
    return bo.fields.map((f) => ({ kind: 'bo-field', group, text: f.text, status: 'missing', line: f.line, note }));
  }
  const { rows, extra } = matchFields(bo.fields, type.fields.map((f) => f.name));
  return [
    ...rows.map(({ item, name, level }): TraceRow => {
      if (name === undefined) return { kind: 'bo-field', group, text: item.text, status: 'missing', line: item.line, note: `${type.name} has no such field` };
      return {
        kind: 'bo-field',
        group,
        text: item.text,
        status: level === 'exact' ? 'matched' : 'near',
        line: item.line,
        target: { type: 'field', dataType: type.name, name },
        note: level === 'exact' ? `field of ${type.name}` : `matched as field '${name}' of ${type.name}`,
      };
    }),
    ...extra.map((name): TraceRow => ({
      kind: 'bo-field',
      group,
      text: name,
      status: 'extra',
      target: { type: 'field', dataType: type.name, name },
      note: `field of ${type.name} that the description does not list`,
    })),
  ];
}

/** Description items against field names: exact, then normalised; each name is taken once. */
function matchFields(items: readonly DescriptionItem[], names: readonly string[]) {
  const taken = new Map<number, { name: string; level: MatchLevel }>();
  const used = new Set<string>();
  for (const level of ['exact', 'normalized'] as const) {
    items.forEach((item, i) => {
      if (taken.has(i)) return;
      const name = names.find((n) => !used.has(n) && matchesAt(level, item.text, n));
      if (name === undefined) return;
      taken.set(i, { name, level });
      used.add(name);
    });
  }
  return {
    rows: items.map((item, i) => ({ item, name: taken.get(i)?.name, level: taken.get(i)?.level })),
    extra: [...new Set(names)].filter((n) => !used.has(n)),
  };
}

/**
 * The fields a task shows: the last part of each coach control's binding
 * ("tw.local.order.amount" gives "amount"), from the coaches of the human
 * service it calls. Empty when the process says nothing about the task's fields.
 */
function taskFields(node: FlowNode): string[] {
  const coaches = [...(node.calledElement?.internals?.coaches ?? []), ...(node.coach ? [node.coach] : [])];
  const names: string[] = [];
  for (const c of coaches) {
    for (const k of c.controls) {
      const last = k.binding?.replace(/\[[^\]]*\]/g, '').split('.').filter((s) => s !== '').pop();
      if (last && last !== 'local' && last !== 'tw') names.push(last);
    }
  }
  return [...new Set(names)];
}

function taskRows(task: DescribedHumanTask, process: Process): TraceRow[] {
  const group = `${task.section} · ${task.name}`;
  const found = findNode(process.nodes.filter((n) => n.kind === 'userTask'), task.name) ?? findNode(process.nodes.filter(isActivity), task.name);
  if (!found) {
    return task.fields.map((f) => ({ kind: 'task-field', group, text: f.text, status: 'unchecked', line: f.line, note: `no task of the process is named '${task.name}'` }));
  }
  const node = found.node;
  const fields = taskFields(node);
  if (fields.length === 0) {
    return task.fields.map((f) => ({
      kind: 'task-field',
      group,
      text: f.text,
      status: 'unchecked',
      line: f.line,
      target: nodeTarget(process, node),
      note: 'the process does not define task fields',
    }));
  }
  const { rows, extra } = matchFields(task.fields, fields);
  const target = nodeTarget(process, node);
  return [
    ...rows.map(({ item, name, level }): TraceRow =>
      name === undefined
        ? { kind: 'task-field', group, text: item.text, status: 'missing', line: item.line, target, note: `no control of '${node.name}' is bound to it` }
        : {
            kind: 'task-field',
            group,
            text: item.text,
            status: level === 'exact' ? 'matched' : 'near',
            line: item.line,
            target,
            note: level === 'exact' ? `bound to a control of '${node.name}'` : `matched as '${name}', bound to a control of '${node.name}'`,
          },
    ),
    ...extra.map((name): TraceRow => ({ kind: 'task-field', group, text: name, status: 'extra', target, note: `bound to a control of '${node.name}' but not listed` })),
  ];
}

function countRows(rows: readonly TraceRow[]): TraceCounts {
  const counts: TraceCounts = { matched: 0, near: 0, missing: 0, unchecked: 0, extra: 0, checkable: 0 };
  for (const r of rows) counts[r.status]++;
  counts.checkable = counts.matched + counts.near + counts.missing;
  return counts;
}

/**
 * "24 of 24 checkable items found (19 exact, 5 near) · 0 missing · 17 unchecked · 1 extra".
 * Unchecked rows are not counted as checkable: the process cannot answer them.
 */
export function traceSummary(counts: TraceCounts): string {
  const found = counts.matched + counts.near;
  return `${found} of ${counts.checkable} checkable items found (${counts.matched} exact, ${counts.near} near) · ${counts.missing} missing · ${counts.unchecked} unchecked · ${counts.extra} extra`;
}
