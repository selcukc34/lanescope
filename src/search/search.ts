// Keyword search over a search index (./searchIndex): a plain, case-folded
// substring match, no regular expressions. Pure: the host keeps the index of
// the open file and answers the webview's queries with it (src/views).

/** One object of the file a result belongs to: a process, a service or a business object. */
export interface SearchObject {
  kind: 'process' | 'service' | 'dataType';
  /** What it is, as shown: "Process", "Service flow", "Client-side human service", "Business object", ... */
  label: string;
  name: string;
  /** process: the process id of the package; service: its object id ("1.…"); dataType: its name. */
  id: string;
  /** The level id it opens with below a caller (a process: originalId ?? id; a service: its object id). */
  levelId?: string;
  /**
   * What calls it (src/model/callGraph): activities of processes, then steps
   * of services. Always there for a service; for a process only when something calls it (a linked process).
   */
  calledBy?: SearchCaller[];
  /** Services: true when it opens as a diagram. */
  openable?: boolean;
  /** Where the object's diagram is drawn; undefined for a service without a diagram and a business object. */
  level?: SearchLevel;
  /** Ids of the services the object calls directly (one level), which the "Shown process" scope takes in. */
  calls?: string[];
}

/**
 * A level of the viewer as a showLevel message names it: a process of the
 * package (picked) or a service on its own, then the levels below it.
 */
export interface SearchLevel {
  processId?: string;
  serviceId?: string;
  below: string[];
}

/** An activity of a process, or a step of a service, that calls a service or a linked process. */
export interface SearchCaller {
  /** A process's activity or a service's step. */
  via: 'process' | 'service';
  /** The process (its id in the package) or service (its object id) that holds it. */
  ownerId: string;
  /** Name of the process or service that holds it. */
  ownerName: string;
  /** Diagram id of the activity or step. */
  nodeId: string;
  name: string;
  /** Sub-process levels of the owner's diagram around it, outermost first. */
  levels: string[];
  /** Where it is drawn when the viewer goes to it. */
  level: SearchLevel;
}

/** What a result selects, inside its object. */
export type SearchTarget =
  /** A node; `levels` are the sub-process levels to open below the object's diagram, outermost first. */
  | { type: 'node'; id: string; levels: string[] }
  /** A sequence flow; `levels` as for a node. */
  | { type: 'flow'; id: string; levels: string[] }
  /** The object's diagram itself: nothing selected, its summary in Details. */
  | { type: 'root' }
  /** A business object (the Data tab). */
  | { type: 'dataType'; name: string };

/** One result group: an element of an object and where it is. */
export interface SearchGroup {
  /** Index into SearchIndex.objects. */
  object: number;
  target: SearchTarget;
  /** "Call activity", "Sequence flow", "Process", "Business object", ... */
  kind: string;
  name: string;
  /** The enclosing sub-processes of the target, outermost first. */
  where: string[];
}

/** One searchable text of a group. */
export interface SearchField {
  /** Index into SearchIndex.groups. */
  group: number;
  /** What the text is, e.g. "Name", "Condition", "Script", "Input mapping". */
  label: string;
  text: string;
  /** True for the group's own name: such hits sort first. */
  isName?: true;
  /** A field of a business object: its name, to show it in the Data tab. */
  dataField?: string;
}

/** Everything that can be searched in the open file, built by buildSearchIndex. */
export interface SearchIndex {
  /** Processes, then services, then business objects, each by name. */
  objects: SearchObject[];
  /** By object, in diagram order. */
  groups: SearchGroup[];
  fields: SearchField[];
  /** Script texts left out because lanescope.showScripts is off (0 when it is on). */
  scriptsOmitted: number;
  /** The file packs toolkits, which are not searched. */
  toolkitsNotSearched: boolean;
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
  dataField?: string;
}

export interface SearchResultGroup {
  group: SearchGroup;
  hits: SearchHit[];
}

export interface SearchResultObject {
  object: SearchObject;
  /** The object the viewer shows (listed first). */
  shown: boolean;
  /** Hits listed for this object. */
  hitCount: number;
  groups: SearchResultGroup[];
}

/** Which objects a search looks at. */
export type SearchScope = 'file' | 'shown';

export interface SearchResult {
  /** The query as searched (trimmed). */
  query: string;
  scope: SearchScope;
  /** The query is shorter than MIN_QUERY_LENGTH: nothing was searched. */
  tooShort: boolean;
  /** The shown object first, then the others in index order. */
  objects: SearchResultObject[];
  /** Groups (elements) with a listed hit: the N of "Search (N)". */
  groupCount: number;
  /** Hits listed (at most MAX_HITS). */
  shown: number;
  /** Every hit, also those past MAX_HITS. */
  total: number;
  /** More than MAX_HITS hits: only the first are listed. */
  truncated: boolean;
  scriptsOmitted: number;
  toolkitsNotSearched: boolean;
}

export interface SearchOptions {
  /** "shown": the shown object (a process with its sub-processes, or a service) and the services it calls. */
  scope: SearchScope;
  /** Index into SearchIndex.objects of the object the viewer shows; none when undefined. */
  shownObject?: number;
}

export const MIN_QUERY_LENGTH = 2;
export const MAX_HITS = 500;
/** Characters shown on each side of a match. */
export const SNIPPET_CONTEXT = 40;
/** Longest query accepted. */
export const MAX_QUERY_LENGTH = 500;

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

/** The index of an object in `index.objects`, or undefined. */
export function findObject(index: SearchIndex, kind: SearchObject['kind'], id: string): number | undefined {
  const at = index.objects.findIndex((o) => o.kind === kind && o.id === id);
  return at >= 0 ? at : undefined;
}

/**
 * Every occurrence of `query` in the index: case-insensitive, plain
 * substring, trimmed; nothing for a query shorter than MIN_QUERY_LENGTH.
 * The shown object comes first, the others in index order; inside an object,
 * groups with a hit in their name come first, the rest in diagram order;
 * hits keep the order of the fields. At most MAX_HITS hits are listed.
 * With scope "shown", only the shown object and the services it calls are searched.
 */
export function search(index: SearchIndex, rawQuery: string, options: SearchOptions = { scope: 'file' }): SearchResult {
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const result: SearchResult = {
    query,
    scope: options.scope,
    tooShort: query.length < MIN_QUERY_LENGTH,
    objects: [],
    groupCount: 0,
    shown: 0,
    total: 0,
    truncated: false,
    scriptsOmitted: index.scriptsOmitted,
    toolkitsNotSearched: index.toolkitsNotSearched,
  };
  if (result.tooShort) return result;
  const needle = foldCase(query);
  const shown = options.shownObject !== undefined ? index.objects[options.shownObject] : undefined;
  const callees = new Set(shown?.calls ?? []);
  const inScope = (object: number) => {
    if (options.scope === 'file' || object === options.shownObject) return true;
    const o = index.objects[object];
    return o.kind === 'service' && callees.has(o.id);
  };

  const hitsByGroup = new Map<number, { hits: SearchHit[]; nameHit: boolean }>();
  for (const field of index.fields) {
    if (!inScope(index.groups[field.group].object)) continue;
    const folded = foldCase(field.text);
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
      result.total++;
      let entry = hitsByGroup.get(field.group);
      if (!entry) {
        entry = { hits: [], nameHit: false };
        hitsByGroup.set(field.group, entry);
      }
      if (field.isName) entry.nameHit = true;
      entry.hits.push(hit(field, at, needle.length));
    }
  }

  const objectRank = (o: number) => (o === options.shownObject ? -1 : o);
  const order = [...hitsByGroup.keys()].sort((a, b) => {
    const byObject = objectRank(index.groups[a].object) - objectRank(index.groups[b].object);
    if (byObject !== 0) return byObject;
    const nameFirst = Number(hitsByGroup.get(b)!.nameHit) - Number(hitsByGroup.get(a)!.nameHit);
    return nameFirst !== 0 ? nameFirst : a - b;
  });
  let last: SearchResultObject | undefined;
  for (const g of order) {
    if (result.shown >= MAX_HITS) break;
    const group = index.groups[g];
    const hits = hitsByGroup.get(g)!.hits.slice(0, MAX_HITS - result.shown);
    result.shown += hits.length;
    result.groupCount++;
    if (!last || last.object !== index.objects[group.object]) {
      last = { object: index.objects[group.object], shown: group.object === options.shownObject, hitCount: 0, groups: [] };
      result.objects.push(last);
    }
    last.hitCount += hits.length;
    last.groups.push({ group, hits });
  }
  result.truncated = result.total > result.shown;
  return result;
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
    ...(field.dataField !== undefined ? { dataField: field.dataField } : {}),
  };
}

/** "Showing first 500 matches" when the list is cut; undefined otherwise. */
export function truncatedNote(result: Pick<SearchResult, 'truncated'>): string | undefined {
  return result.truncated ? `Showing first ${MAX_HITS} matches` : undefined;
}

/** "12 matches in 3 objects". */
export function matchesSummary(result: Pick<SearchResult, 'shown' | 'objects'>): string {
  const m = result.objects.length;
  return `${result.shown} ${result.shown === 1 ? 'match' : 'matches'} in ${m} ${m === 1 ? 'object' : 'objects'}`;
}

/** The note above the results while lanescope.showScripts keeps scripts out of the index. */
export const SCRIPTS_NOT_SEARCHED = 'Scripts were not searched because lanescope.showScripts is off.';

/** The note below the results when the file packs toolkits. */
export const TOOLKITS_NOT_SEARCHED = 'Toolkits are not searched (toolkit contents cannot be opened in Lanescope yet).';
