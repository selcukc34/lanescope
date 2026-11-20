// Text the side panel shows, kept free of DOM code so it can be unit-tested
// in plain Node.

import type { DiffEntry } from '../src/diff/diff';
import type { CalleeStepKind } from '../src/model/model';
import type { CalleeDetails, CalleeStepDetails, DiffView } from '../src/views/protocol';

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
 * element is in the diagram.
 */
export function changeGroups(diff: Pick<DiffView, 'added' | 'changed' | 'removed'>, drawn: Readonly<Record<string, unknown>>): ChangeGroups {
  const row = (e: DiffEntry, status: ChangeStatus): ChangeRow => {
    const linkable =
      status !== 'removed' &&
      (e.elementType === 'node' || e.elementType === 'flow' || e.elementType === 'lane') &&
      e.currentId !== undefined &&
      Object.prototype.hasOwnProperty.call(drawn, e.currentId);
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
