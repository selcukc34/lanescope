// Text the side panel shows, kept free of DOM code so it can be unit-tested
// in plain Node.

import type { CalleeStepKind } from '../src/model/model';
import type { CalleeDetails, CalleeStepDetails } from '../src/views/protocol';

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
