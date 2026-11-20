// Keyword search over a search index (./searchIndex): a plain, case-folded
// substring match, no regular expressions. Pure and free of the model's
// readers, so the webview bundles it and searches as the user types; the
// index is built on the host and sent with every render.

/** What a result selects in the viewer. */
export type SearchTarget =
  /** A node of the chosen process; `levels` are the sub-process levels to open first, outermost first. */
  | { type: 'node'; id: string; levels: string[] }
  /** A sequence flow of the chosen process; `levels` as for a node. */
  | { type: 'flow'; id: string; levels: string[] }
  /** The chosen process itself (its details: variables, inputs, outputs). */
  | { type: 'process' }
  /** A business object of the package (the Data tab). */
  | { type: 'dataType'; name: string };

/**
 * One result group: an element of the process and where it is, or the
 * inside of a service an activity calls.
 */
export interface SearchGroup {
  /** The element of the chosen process; for the inside of a service, the activity that calls it. */
  target: SearchTarget;
  /** "Call activity", "Sequence flow", "Process", "Business object", "Inside service", ... */
  kind: string;
  /** The element's name; for the inside of a service, the service's name. */
  name: string;
  /** The enclosing sub-processes of the target, outermost first. */
  where: string[];
  /** The inside of a service: the name of the activity that calls it. */
  caller?: string;
  /** The inside of a service that opens as a diagram: its level (no step). */
  open?: SearchOpen;
}

/** A diagram level a field can open: a called service, and the step of it to select. */
export interface SearchOpen {
  /** Level id to open from the level of the group's target (a service, "1.…"). */
  levelId: string;
  /** Id of the step in that service, as the source writes it (the drawn element's id or originalId). */
  stepId?: string;
}

/** One searchable text of a group. */
export interface SearchField {
  /** Index into SearchIndex.groups. */
  group: number;
  /** What the text is, e.g. "Name", "Condition", "Script", "Step \"Init\" · Script". */
  label: string;
  text: string;
  /** True for the group's own name: such hits sort first. */
  isName?: true;
  /** Inside a called service that opens as a diagram: the service and the step to select there. */
  open?: SearchOpen;
}

/** Everything that can be searched in the shown process, built by buildSearchIndex. */
export interface SearchIndex {
  /** In diagram order. */
  groups: SearchGroup[];
  fields: SearchField[];
  /** Script texts left out because lanescope.showScripts is off (0 when it is on). */
  scriptsOmitted: number;
  /** The package holds other processes, which are not searched. */
  otherProcesses: boolean;
}

/** One occurrence of the query, with up to SNIPPET_CONTEXT characters around it. */
export interface SearchHit {
  label: string;
  /** Text before the match (white space collapsed), "…" first when cut. */
  before: string;
  /** The matched text as written. */
  match: string;
  /** Text after the match, "…" last when cut. */
  after: string;
  open?: SearchOpen;
}

export interface SearchResultGroup {
  group: SearchGroup;
  hits: SearchHit[];
}

export interface SearchResult {
  /** The query as searched (trimmed). */
  query: string;
  /** The query is shorter than MIN_QUERY_LENGTH: nothing was searched. */
  tooShort: boolean;
  groups: SearchResultGroup[];
  /** Hits listed (at most MAX_HITS). */
  shown: number;
  /** Every hit, also those past MAX_HITS. */
  total: number;
  /** More than MAX_HITS hits: only the first are listed. */
  truncated: boolean;
}

export const MIN_QUERY_LENGTH = 2;
export const MAX_HITS = 500;
/** Characters shown on each side of a match. */
export const SNIPPET_CONTEXT = 40;

/**
 * Case folding that keeps every UTF-16 unit in its place (so a match in the
 * folded text is at the same offsets in the original): each unit is
 * lower-cased on its own, and the Turkish dotted capital İ and dotless ı
 * both fold to "i", like I. A unit whose lower case is longer than one unit
 * stays as it is. No locale is involved, so the result is the same everywhere.
 */
export function foldCase(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === 'İ' || c === 'ı') {
      out += 'i';
      continue;
    }
    const lower = c.toLowerCase();
    out += lower.length === 1 ? lower : c;
  }
  return out;
}

/**
 * Every occurrence of `query` in the index: case-insensitive, plain
 * substring, trimmed; nothing for a query shorter than MIN_QUERY_LENGTH.
 * Groups with a hit in their name come first, the rest in diagram order;
 * hits keep the order of the fields. At most MAX_HITS hits are listed.
 */
export function search(index: SearchIndex, rawQuery: string): SearchResult {
  const query = rawQuery.trim();
  const empty: SearchResult = { query, tooShort: query.length < MIN_QUERY_LENGTH, groups: [], shown: 0, total: 0, truncated: false };
  if (empty.tooShort) return empty;
  const needle = foldCase(query);

  const hitsByGroup = new Map<number, { hits: SearchHit[]; nameHit: boolean }>();
  let total = 0;
  for (const field of index.fields) {
    const folded = foldCase(field.text);
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
      total++;
      let entry = hitsByGroup.get(field.group);
      if (!entry) {
        entry = { hits: [], nameHit: false };
        hitsByGroup.set(field.group, entry);
      }
      if (field.isName) entry.nameHit = true;
      entry.hits.push(hit(field, at, needle.length));
    }
  }

  const order = [...hitsByGroup.keys()].sort((a, b) => {
    const nameFirst = Number(hitsByGroup.get(b)!.nameHit) - Number(hitsByGroup.get(a)!.nameHit);
    return nameFirst !== 0 ? nameFirst : a - b;
  });
  const groups: SearchResultGroup[] = [];
  let shown = 0;
  for (const g of order) {
    if (shown >= MAX_HITS) break;
    const hits = hitsByGroup.get(g)!.hits.slice(0, MAX_HITS - shown);
    shown += hits.length;
    groups.push({ group: index.groups[g], hits });
  }
  return { query, tooShort: false, groups, shown, total, truncated: total > shown };
}

function hit(field: SearchField, at: number, length: number): SearchHit {
  const text = field.text;
  const from = Math.max(0, at - SNIPPET_CONTEXT);
  const to = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  const collapse = (s: string) => s.replace(/\s+/g, ' ');
  return {
    label: field.label,
    before: (from > 0 ? '…' : '') + collapse(text.slice(from, at)).trimStart(),
    match: text.slice(at, at + length),
    after: collapse(text.slice(at + length, to)).trimEnd() + (to < text.length ? '…' : ''),
    ...(field.open ? { open: field.open } : {}),
  };
}

/** "Showing first 500 matches" when the list is cut; undefined otherwise. */
export function truncatedNote(result: SearchResult): string | undefined {
  return result.truncated ? `Showing first ${MAX_HITS} matches` : undefined;
}

/** The note above the results while lanescope.showScripts keeps scripts out of the index. */
export const SCRIPTS_NOT_SEARCHED = 'Scripts were not searched because lanescope.showScripts is off.';

/** The note below the results when the package holds other processes. */
export const ONLY_SHOWN_PROCESS = 'Only the shown process is searched.';
