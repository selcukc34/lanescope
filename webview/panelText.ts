// Text the side panel shows, kept free of DOM code so it can be unit-tested
// in plain Node.

import type { DiffEntry } from '../src/diff/diff';
import type { CalleeStepKind } from '../src/model/model';
import type { CalleeDetails, CalleeStepDetails, DiffView, TraceView } from '../src/views/protocol';
import type { TraceRow, TraceStatus } from '../src/trace/trace';
import type { SearchCaller, SearchGroup, SearchObject, SearchResult } from '../src/search/search';

/**
 * A type is a link only when the Data tab has a row for it. System Data
 * types (String, Decimal, …) and types not in the export are plain text.
 */
export function isLinkedType(type: string | undefined, known: ReadonlySet<string>): type is string {
  return type !== undefined && known.has(type);
}

export const STEP_KIND_LABELS: Readonly<Record<CalleeStepKind, string>> = {
  start: 'Start',
  end: 'End',
  script: 'Script',
  call: 'Call',
  rest: 'REST',
  gateway: 'Gateway',
  coach: 'Coach',
  event: 'Event',
  unknown: 'Unknown',
};

/** "Service flow · 8 steps" */
export function insideSummary(callee: CalleeDetails): string {
  const n = callee.steps.length;
  const count = `${n} ${n === 1 ? 'step' : 'steps'}`;
  return callee.kind ? `${callee.kind} · ${count}` : count;
}

/** What an error boundary catches: "all", an error code, or "" when the source names neither. */
export function catchesText(b: { catchAll?: boolean; errorCode?: string }): string {
  if (b.catchAll) return 'all';
  return b.errorCode ?? '';
}

/** "catches: all", "catches: _WEATHER_TIMEOUT"; empty when the source names neither. */
export function catchesLabel(b: NonNullable<CalleeStepDetails['errorBoundaries']>[number]): string {
  const text = catchesText(b);
  return text ? `catches: ${text}` : '';
}

/** The event type shown next to a step name, unless the name already says it. */
export function stepNote(step: CalleeStepDetails): string | undefined {
  if (step.eventType === undefined) return undefined;
  return step.eventType.trim().toLowerCase() === step.name.trim().toLowerCase() ? undefined : step.eventType;
}

/** Changes tab, before there is a base. */
export const NOTHING_TO_COMPARE =
  'Nothing to compare yet. Use Compare… to pick another version of the process, or keep this file open: when it changes on disk, the new version is compared with the one shown before.';

/** "14:32", local time. */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * "Changes from other.zip to the shown file" (the picked file is the older
 * side) or "Compared with the previous version (loaded 14:32)".
 */
export function comparedWithText(diff: Pick<DiffView, 'baseKind' | 'baseLabel' | 'loadedAt'>): string {
  return diff.baseKind === 'file'
    ? `Changes from ${diff.baseLabel} to the shown file`
    : `Compared with the previous version (loaded ${clockTime(diff.loadedAt)})`;
}

/** Added + removed + changed, business objects included. */
export function changeCount(diff: Pick<DiffView, 'counts'>): number {
  return diff.counts.added + diff.counts.removed + diff.counts.changed;
}

/** "Changes (7)"; just "Changes" while there is nothing to count. */
export function changesTabTitle(diff: Pick<DiffView, 'counts' | 'note'> | undefined): string {
  return diff && diff.note === undefined ? `Changes (${changeCount(diff)})` : 'Changes';
}

export type ChangeStatus = 'added' | 'changed' | 'removed';

/** One row of the Changes tab, as the panel draws it. */
export interface ChangeRow {
  status: ChangeStatus;
  label: string;
  changes: string[];
  /** The diagram element a click selects; only added and changed nodes, flows and lanes that are drawn. */
  revealId?: string;
}

/** The groups of the Changes tab: Added, Changed, Removed (diagram elements) and Business objects. */
export interface ChangeGroups {
  added: ChangeRow[];
  changed: ChangeRow[];
  removed: ChangeRow[];
  businessObjects: ChangeRow[];
}

/**
 * Rows of the Changes tab. `drawn` holds the ids of the drawn elements
 * (RenderMessage.elements): a row links to its element only when the
 * element is in the diagram, or a sub-process around it is (drawn collapsed).
 */
export function changeGroups(
  diff: Pick<DiffView, 'added' | 'changed' | 'removed' | 'enclosing'>,
  drawn: Readonly<Record<string, unknown>>,
): ChangeGroups {
  const isDrawn = (id: string) => Object.prototype.hasOwnProperty.call(drawn, id);
  const row = (e: DiffEntry, status: ChangeStatus): ChangeRow => {
    const linkable =
      status !== 'removed' &&
      (e.elementType === 'node' || e.elementType === 'flow' || e.elementType === 'lane') &&
      e.currentId !== undefined &&
      (isDrawn(e.currentId) || (diff.enclosing?.[e.currentId] ?? []).some(isDrawn));
    return { status, label: e.label, changes: [...e.changes], ...(linkable ? { revealId: e.currentId } : {}) };
  };
  const inDiagram = (e: DiffEntry) => e.elementType !== 'dataType';
  return {
    added: diff.added.filter(inDiagram).map((e) => row(e, 'added')),
    changed: diff.changed.filter(inDiagram).map((e) => row(e, 'changed')),
    removed: diff.removed.filter(inDiagram).map((e) => row(e, 'removed')),
    businessObjects: [
      ...diff.added.filter((e) => !inDiagram(e)).map((e) => row(e, 'added')),
      ...diff.changed.filter((e) => !inDiagram(e)).map((e) => row(e, 'changed')),
      ...diff.removed.filter((e) => !inDiagram(e)).map((e) => row(e, 'removed')),
    ],
  };
}

/** "Contains" of a sub-process: "4 nodes", "1 node". */
export function containsText(count: number): string {
  return `${count} ${count === 1 ? 'node' : 'nodes'}`;
}

/** Icon of a trace row by its status. */
export const TRACE_ICONS: Readonly<Record<TraceStatus, string>> = {
  matched: '✓',
  near: '≈',
  missing: '✗',
  unchecked: '?',
  extra: '+',
};

export const TRACE_STATUS_LABELS: Readonly<Record<TraceStatus, string>> = {
  matched: 'Matched',
  near: 'Near match',
  missing: 'Missing',
  unchecked: 'Not checked',
  extra: 'Not in the description',
};

/** The rows of the Trace tab by group, in the order the groups first appear. */
export function traceGroups(rows: readonly TraceRow[]): Array<{ title: string; rows: TraceRow[] }> {
  const groups = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const list = groups.get(r.group) ?? [];
    list.push(r);
    groups.set(r.group, list);
  }
  return [...groups].map(([title, list]) => ({ title, rows: list }));
}

/** The second line of a trace row: "matched as 'Validate Order SF'" for a near match, else the row's note. */
export function traceDetail(row: TraceRow): string {
  if (row.status === 'near' && row.target && row.target.name !== '') return `matched as '${row.target.name}'`;
  return row.note;
}

/** "Trace (2)" when items are missing, else "Trace". Extra items are normal additions and are not counted. */
export function traceTabTitle(trace: Pick<TraceView, 'counts' | 'error'> | undefined): string {
  if (!trace || trace.error !== undefined) return 'Trace';
  return trace.counts.missing > 0 ? `Trace (${trace.counts.missing})` : 'Trace';
}

/** "5 sections not checked: Business scenario, …" */
export function notCheckedText(headings: readonly string[]): string {
  if (headings.length === 0) return '';
  return `${headings.length} ${headings.length === 1 ? 'section' : 'sections'} not checked: ${headings.join(', ')}`;
}

/** "Search (3)": the elements with a listed hit; just "Search" while the query is too short. */
export function searchTabTitle(result: Pick<SearchResult, 'tooShort' | 'groupCount'>): string {
  return result.tooShort ? 'Search' : `Search (${result.groupCount})`;
}

/** The icons of the Search tab (./icons). */
export type IconKind =
  | 'process'
  | 'service'
  | 'humanService'
  | 'dataType'
  | 'task'
  | 'userTask'
  | 'scriptTask'
  | 'callActivity'
  | 'subProcess'
  | 'gateway'
  | 'event'
  | 'flow'
  | 'field';

/** The icon of an object of the file. */
export function objectIcon(o: Pick<SearchObject, 'kind' | 'label'>): IconKind {
  if (o.kind === 'process') return 'process';
  if (o.kind === 'dataType') return 'dataType';
  return /human service/i.test(o.label) ? 'humanService' : 'service';
}

/** The icon of a result group, by the BPMN kind of its element. */
export function groupIcon(group: Pick<SearchGroup, 'target' | 'kind'>, object: Pick<SearchObject, 'kind' | 'label'>): IconKind {
  const t = group.target;
  if (t.type === 'flow') return 'flow';
  if (t.type === 'dataType') return 'field';
  if (t.type === 'root') return objectIcon(object);
  const kind = group.kind.toLowerCase();
  if (kind.includes('gateway')) return 'gateway';
  if (kind.includes('event')) return 'event';
  if (kind.includes('sub-process')) return 'subProcess';
  if (kind === 'user task') return 'userTask';
  if (kind === 'script task') return 'scriptTask';
  if (kind === 'call activity' || kind === 'service task') return 'callActivity';
  return 'task';
}

/** What a field label is about, for the colour-free pill style of the Search tab. */
export type PillCategory = 'name' | 'documentation' | 'script' | 'condition' | 'mapping' | 'data' | 'setting' | 'call' | 'coach' | 'field';

const SETTING_LABELS = new Set(['Lane', 'Performer', 'Assignment', 'Priority', 'Due date', 'Subject', 'Timer', 'Event', 'Catches']);

export function pillCategory(label: string): PillCategory {
  if (label === 'Name') return 'name';
  if (label === 'Documentation') return 'documentation';
  if (label === 'Script') return 'script';
  if (label === 'Condition') return 'condition';
  if (/mapping$/i.test(label)) return 'mapping';
  if (label === 'Field') return 'field';
  if (SETTING_LABELS.has(label)) return 'setting';
  if (label === 'Calls' || label === 'REST service' || label === 'Operation') return 'call';
  if (label.startsWith('Control') || label === 'Binding') return 'coach';
  return 'data';
}

/** "in Process: Order" or "in Service: Price Order": where a caller is. */
export function callerWhere(c: Pick<SearchCaller, 'via' | 'ownerName'>): string {
  return `in ${c.via === 'service' ? 'Service' : 'Process'}: ${c.ownerName}`;
}

/**
 * "called by Order Process, Service: Price Order": what holds the callers
 * (the activities are in the Callers list); "not called" for a service
 * nothing calls; undefined for a process nothing calls.
 */
export function calledByText(o: Pick<SearchObject, 'kind' | 'calledBy'>): string | undefined {
  const callers = o.calledBy;
  if (callers === undefined || (callers.length === 0 && o.kind !== 'service')) return undefined;
  if (callers.length === 0) return 'not called';
  const names = callers.map((c) => (c.via === 'service' ? `Service: ${c.ownerName}` : c.ownerName));
  return `called by ${[...new Set(names)].join(', ')}`;
}
