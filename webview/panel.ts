// Side panel: element details, XSD data types, warnings, the changes
// against the compared version and the check against a description.
// Everything from the model (scripts, mappings, conditions included) is set
// as text (textContent / text nodes), never parsed as HTML, and never run.

import type {
  CalleeDetails,
  CalleeStepDetails,
  CoachDetails,
  DiffView,
  ElementDetails,
  FlowDetails,
  LaneDetails,
  MappingDetails,
  NodeDetails,
  OutgoingFlowDetails,
  ParameterDetails,
  ProcessSummary,
  RenderMessage,
  ScriptDetails,
  TimerDetails,
  TraceView,
  UserTaskDetails,
  VariableDetails,
} from '../src/views/protocol';
import type { DataType } from '../src/model/model';
import {
  matchesSummary,
  SCRIPTS_NOT_SEARCHED,
  TOOLKITS_NOT_SEARCHED,
  truncatedNote,
  type SearchCaller,
  type SearchHit,
  type SearchObject,
  type SearchResult,
  type SearchResultGroup,
  type SearchResultObject,
  type SearchScope,
  type SearchTarget,
} from '../src/search/search';
import type { TraceRow, TraceTarget } from '../src/trace/trace';
import { clear, h } from './dom';
import {
  catchesLabel,
  catchesText,
  changeCount,
  changeGroups,
  changesTabTitle,
  type ChangeRow,
  comparedWithText,
  containsText,
  insideSummary,
  isLinkedType,
  NOTHING_TO_COMPARE,
  notCheckedText,
  STEP_KIND_LABELS,
  stepNote,
  TRACE_ICONS,
  TRACE_STATUS_LABELS,
  traceDetail,
  traceGroups,
  calledByText,
  callerWhere,
  groupIcon,
  objectIcon,
  pillCategory,
  searchTabTitle,
  traceTabTitle,
} from './panelText';
import { icon } from './icons';

export const TAB_IDS = ['details', 'data', 'warnings', 'changes', 'trace', 'search'] as const;
export type TabId = (typeof TAB_IDS)[number];

/** True for a known tab id; a saved webview state may hold anything. */
export function isTabId(value: unknown): value is TabId {
  return (TAB_IDS as readonly unknown[]).includes(value);
}

/** What the Changes tab asks of the viewer. */
export interface ChangesActions {
  /** Select a diagram element, scroll it into view and show its details. */
  reveal(id: string): void;
  /** Stop comparing with the picked file. */
  clearComparison(): void;
  /** Select a node or flow of the chosen process, opening the sub-processes around it. */
  revealTrace(target: Extract<TraceTarget, { type: 'node' | 'flow' }>): void;
  /** Stop checking against the description. */
  clearDescription(): void;
  /** Go where a search match is (another process, a service, a sub-process level, the Data tab). */
  revealSearch(object: SearchObject, target: SearchResultGroup['group']['target'], dataField?: string): void;
  /** Select an activity or step that calls a service or linked process, where it is drawn. */
  showCaller(caller: SearchCaller): void;
  /** Arrow up from the first search result: back to the search box. */
  focusSearchBox(): void;
  /** The All file / Shown process choice changed. */
  searchScopeChanged(scope: SearchScope): void;
}

/** Objects of a search result shown open; the rest start folded. */
export const OPEN_SEARCH_OBJECTS = 10;

/** Types that have a row in the Data tab, and how to show one there. */
interface RevealType {
  known: ReadonlySet<string>;
  reveal(name: string): void;
}

/** What the details of an activity need besides the activity itself. */
interface NodeContext {
  types: RevealType;
  callees: Record<string, CalleeDetails>;
  openCallee(calleeId: string): void;
}

const STATUS_LABELS = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/** Scripts longer than this are folded to their first lines. */
const SCRIPT_FOLD_LINES = 20;

export class SidePanel {
  readonly element: HTMLElement;
  private readonly tabs = new Map<TabId, { button: HTMLButtonElement; body: HTMLElement }>();
  private active: TabId = 'details';
  private data: RenderMessage | undefined;
  private selectedId: string | undefined;
  private readonly scopeSelect: HTMLSelectElement;
  /** The scroll box of the tab bodies, shared by every tab. */
  private readonly scroller: HTMLElement;
  /** Where each tab was scrolled to when it was left. */
  private readonly tabScroll = new Map<TabId, number>();
  /** The Search row last gone to (data-nav-key); kept over rebuilds of the list. */
  private searchActive: string | undefined;
  /** Objects whose Callers list is open (by object key); kept over rebuilds of the list. */
  private readonly callersOpen = new Set<string>();

  constructor(
    private readonly onTabChange: (tab: TabId) => void,
    /** The user asked to open a called service or linked process as a diagram. */
    private readonly onOpenCallee: (calleeId: string) => void,
    private readonly changes: ChangesActions,
    /** The tab shown first, e.g. the one saved before the webview was hidden; not reported to onTabChange. */
    initialTab: TabId = 'details',
    /** The All file / Shown process choice the Search tab starts with. */
    searchScope: SearchScope = 'file',
  ) {
    this.scopeSelect = h(
      'select',
      { class: 'search-scope', title: 'What the search looks at', 'aria-label': 'What the search looks at' },
      h('option', { value: 'file' }, 'All file'),
      h('option', { value: 'shown' }, 'Shown process'),
    );
    this.scopeSelect.value = searchScope;
    this.scopeSelect.addEventListener('change', () => this.changes.searchScopeChanged(this.searchScope));
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const bodies = h('div', { class: 'tab-bodies' });
    this.scroller = bodies;
    for (const [id, label] of [
      ['details', 'Details'],
      ['data', 'Data'],
      ['warnings', 'Warnings'],
      ['changes', 'Changes'],
      ['trace', 'Trace'],
      ['search', 'Search'],
    ] as Array<[TabId, string]>) {
      const button = h('button', { class: 'tab', role: 'tab', type: 'button', id: `tab-${id}` }, label);
      button.addEventListener('click', () => this.showTab(id));
      const body = h('div', { class: 'tab-body', role: 'tabpanel', 'aria-labelledby': `tab-${id}` });
      tabBar.append(button);
      bodies.append(body);
      this.tabs.set(id, { button, body });
    }
    // Shown once a render carries a description check.
    this.tabs.get('trace')!.button.hidden = true;
    // Shown while there is a search.
    this.tabs.get('search')!.button.hidden = true;
    this.tabs.get('search')!.body.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.element = h('aside', { class: 'panel' }, tabBar, bodies);
    this.applyTab(initialTab);
  }

  get activeTab(): TabId {
    return this.active;
  }

  /** Shows a tab and reports it to onTabChange (a click, a revealed element or type, Compare…). */
  showTab(id: TabId): void {
    this.applyTab(id);
    this.onTabChange(id);
  }

  private applyTab(id: TabId): void {
    // The tabs share one scroll box: each comes back where it was left.
    if (id !== this.active) this.tabScroll.set(this.active, this.scroller.scrollTop);
    this.active = id;
    for (const [tabId, { button, body }] of this.tabs) {
      const on = tabId === id;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', String(on));
      body.hidden = !on;
    }
    this.scroller.scrollTop = this.tabScroll.get(id) ?? 0;
  }

  /**
   * @param importWarnings problems bpmn-js reported while importing the diagram
   * @param selection the element to select; when left out, the selection is kept while its id exists
   */
  setData(data: RenderMessage, importWarnings: string[] = [], selection?: { id: string | undefined }): void {
    this.data = data;
    this.renderData(data.dataTypes);
    this.renderWarnings([...data.warnings, ...importWarnings]);
    this.renderChanges(data);
    this.renderTrace(data.trace);
    const id = selection ? selection.id : this.selectedId;
    this.select(id && data.elements[id] ? id : undefined);
  }

  /** Id of the element whose details are shown; undefined for the process. */
  get selection(): string | undefined {
    return this.selectedId;
  }

  /** Shows the details of a diagram element, or of the process when undefined. */
  select(id: string | undefined): void {
    if (!this.data) return;
    const details = id ? this.data.elements[id] : undefined;
    this.selectedId = details ? id : undefined;
    const body = this.tabs.get('details')!.body;
    clear(body);
    const types: RevealType = {
      known: new Set(this.data.dataTypes.map((t) => t.name)),
      reveal: (type) => this.revealType(type),
    };
    const ctx: NodeContext = { types, callees: this.data.callees ?? {}, openCallee: (id) => this.onOpenCallee(id) };
    body.append(details ? renderElement(details, ctx) : renderProcess(this.data.process, types));
  }

  /** Shows a business object in the Data tab, and one of its fields when given. */
  showType(name: string, field?: string): void {
    this.revealType(name, field);
  }

  /** What the search looks at, as chosen in the Search tab. */
  get searchScope(): SearchScope {
    return this.scopeSelect.value === 'shown' ? 'shown' : 'file';
  }

  /** True while the Search tab is there (a search is on). */
  get searching(): boolean {
    return !this.tabs.get('search')!.button.hidden;
  }

  /**
   * The Search tab: the result of a search of the open file, or no tab at
   * all when undefined (the search box was cleared). Matches are set as
   * text, never as HTML. Called only when the query, the scope or the index
   * changed (never on navigation). A rebuild keeps folded objects and open
   * Callers lists, keeps the row last gone to where it was on screen when
   * it is still listed, and else the scroll position for the same query.
   */
  setSearch(result: SearchResult | undefined): void {
    const { button, body } = this.tabs.get('search')!;
    const folded = new Set(
      [...body.querySelectorAll<HTMLDetailsElement>('details.search-object')].filter((d) => !d.open).map((d) => d.dataset.key ?? ''),
    );
    const sameQuery = result !== undefined && body.dataset.query === result.query && body.dataset.scope === result.scope;
    const shown = this.active === 'search';
    const scrollTop = shown ? this.scroller.scrollTop : (this.tabScroll.get('search') ?? 0);
    const activeBefore = shown ? this.activeElement() : null;
    const activeOffset = activeBefore ? activeBefore.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top : undefined;

    button.hidden = result === undefined;
    clear(body);
    if (!result) {
      delete body.dataset.query;
      this.searchActive = undefined;
      this.tabScroll.set('search', 0);
      if (this.active === 'search') this.showTab('details');
      return;
    }
    body.dataset.query = result.query;
    body.dataset.scope = result.scope;
    button.textContent = searchTabTitle(result);
    const top = h('div', { class: 'search-top' });
    if (!result.tooShort && result.objects.length > 0) top.append(h('span', { class: 'search-summary' }, matchesSummary(result)), h('span', { class: 'muted', 'aria-hidden': 'true' }, '·'));
    top.append(this.scopeSelect);
    body.append(top);
    const notes = [
      result.scriptsOmitted > 0 ? SCRIPTS_NOT_SEARCHED : undefined,
      truncatedNote(result),
      result.toolkitsNotSearched ? TOOLKITS_NOT_SEARCHED : undefined,
    ].filter((n): n is string => n !== undefined);
    if (notes.length > 0) body.append(h('div', { class: 'search-info', role: 'note' }, ...notes.map((n) => h('p', { class: 'search-note' }, n))));
    if (result.tooShort) {
      body.append(h('p', { class: 'empty' }, 'Type at least 2 characters to search.'));
    } else if (result.objects.length === 0) {
      body.append(h('p', { class: 'empty search-empty' }, `No matches for "${result.query}"`));
    } else {
      result.objects.forEach((o, i) => {
        const key = objectKey(o.object);
        const open = sameQuery ? !folded.has(key) : o.shown || i < OPEN_SEARCH_OBJECTS;
        body.append(this.searchObject(o, key, open));
      });
    }

    // Put the list back where it was.
    const active = this.activeElement();
    if (active) this.markActive(active);
    if (!shown) {
      this.tabScroll.set('search', sameQuery ? scrollTop : 0);
    } else if (active && activeOffset !== undefined) {
      this.scroller.scrollTop += active.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - activeOffset;
    } else {
      this.scroller.scrollTop = sameQuery ? scrollTop : 0;
    }
  }

  /** The row last gone to loses its mark (the user selected something else on the canvas); the list does not move. */
  clearSearchActive(): void {
    this.activeElement()?.classList.remove('active');
    this.activeElement()?.removeAttribute('aria-current');
    this.searchActive = undefined;
  }

  /** Focuses the row last gone to, else the first result (arrow down from the search box); false when there is none. */
  focusFirstSearchResult(): boolean {
    const nav = this.searchNav();
    const active = this.activeElement();
    const target = active && nav.includes(active) ? active : nav[0];
    if (!target) return false;
    if (this.active !== 'search') this.showTab('search');
    target.focus();
    return true;
  }

  private activeElement(): HTMLButtonElement | null {
    if (this.searchActive === undefined) return null;
    return this.tabs.get('search')!.body.querySelector<HTMLButtonElement>(`[data-nav-key="${CSS.escape(this.searchActive)}"]`);
  }

  /** Marks the row gone to, so that it stays visible as the one shown (and keys go on from it). */
  private markActive(el: HTMLElement): void {
    const body = this.tabs.get('search')!.body;
    for (const other of body.querySelectorAll('.search-nav.active')) {
      other.classList.remove('active');
      other.removeAttribute('aria-current');
    }
    el.classList.add('active');
    el.setAttribute('aria-current', 'true');
    this.searchActive = el.dataset.navKey;
  }

  /** The results that can take the focus: those of folded objects and closed Callers lists are skipped. */
  private searchNav(): HTMLButtonElement[] {
    return [...this.tabs.get('search')!.body.querySelectorAll<HTMLButtonElement>('.search-nav')].filter(
      (b) => b.closest('details:not([open])') === null && b.closest('[hidden]') === null,
    );
  }

  /** Arrow up and down move through the results; up from the first goes back to the search box. */
  private onSearchKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const nav = this.searchNav();
    const index = nav.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && index === 0) this.changes.focusSearchBox();
    else nav[Math.min(nav.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  }

  /** A button of the list that goes somewhere: marked as the row gone to when clicked. */
  private navButton(key: string, cls: string, title: string, go: () => void, ...children: Array<Node | string | null>): HTMLButtonElement {
    const b = h('button', { class: `${cls} search-nav`, type: 'button', title, 'data-nav-key': key }, ...children);
    b.addEventListener('click', () => {
      this.markActive(b);
      go();
    });
    return b;
  }

  /**
   * An object of the file: a sticky head (icon, kind and name, match count,
   * what calls it), its Callers list, then its groups. Folds.
   */
  private searchObject(o: SearchResultObject, key: string, open: boolean): HTMLElement {
    const { object } = o;
    const calledBy = calledByText(object);
    const details = h(
      'details',
      { class: `search-object search-${object.kind}${o.shown ? ' shown' : ''}`, 'data-key': key },
      h(
        'summary',
        { title: o.shown ? `${object.label} shown now` : object.label },
        h('span', { class: 'search-object-line' },
          icon(objectIcon(object)),
          h('span', { class: 'search-object-name' }, h('span', { class: 'search-object-kind' }, `${object.label}: `), h('strong', {}, object.name || '(unnamed)')),
          h('span', { class: 'count-badge', title: `${o.hitCount} ${o.hitCount === 1 ? 'match' : 'matches'}` }, String(o.hitCount)),
        ),
        calledBy !== undefined ? h('span', { class: 'search-called-by muted' }, calledBy) : null,
      ),
      this.callersList(object, key),
      ...o.groups.map((g) => this.searchGroup(object, key, g)),
    );
    details.open = open;
    return details;
  }

  /**
   * "Callers (n)": a list that opens below the head, one row per activity
   * or step that calls the object. A row goes there; the list stays open.
   */
  private callersList(object: SearchObject, key: string): HTMLElement | null {
    const callers = object.calledBy ?? [];
    if (callers.length === 0) return null;
    const open = this.callersOpen.has(key);
    const list = h('ul', { class: 'search-callers', ...(open ? {} : { hidden: '' }) });
    const toggle = h(
      'button',
      { class: 'link search-callers-toggle search-nav', type: 'button', 'aria-expanded': String(open), 'data-nav-key': `${key}|callers`, title: 'Show or hide what calls it' },
      `${open ? '▾' : '▸'} Callers (${callers.length})`,
    );
    toggle.addEventListener('click', () => {
      const now = list.hidden;
      list.hidden = !now;
      toggle.setAttribute('aria-expanded', String(now));
      toggle.textContent = `${now ? '▾' : '▸'} Callers (${callers.length})`;
      if (now) this.callersOpen.add(key);
      else this.callersOpen.delete(key);
    });
    callers.forEach((c, i) => {
      const where = callerWhere(c);
      list.append(
        h(
          'li',
          {},
          this.navButton(`${key}|caller|${i}`, 'search-caller-row', `Select ${c.name} ${where}`, () => this.changes.showCaller(c),
            icon(c.via === 'service' ? 'service' : 'process'),
            h('span', { class: 'search-caller-name' }, c.name),
            h('span', { class: 'muted' }, ` ${where}`),
          ),
        ),
      );
    });
    return h('div', { class: 'search-callers-box' }, toggle, list);
  }

  /** A group: its element (icon, where it is, name) and one row per hit. */
  private searchGroup(object: SearchObject, objKey: string, g: SearchResultGroup): HTMLElement {
    const { group } = g;
    const key = `${objKey}|${targetKey(group.target)}`;
    const head = this.navButton(`${key}|head`, 'search-head', `${group.kind} · ${goTitle(object)}`, () => this.changes.revealSearch(object, group.target),
      icon(groupIcon(group, object), group.kind),
      group.where.length > 0 ? h('span', { class: 'muted search-where' }, `${group.where.join(' › ')} › `) : null,
      h('span', { class: 'search-name' }, group.name || '(unnamed)'),
    );
    return h(
      'section',
      { class: 'search-group', 'data-depth': String(Math.min(group.where.length, 4)) },
      head,
      h('ul', { class: 'search-list' }, ...g.hits.map((hit, i) => h('li', { class: 'search-hit' }, this.searchRow(object, group.target, hit, `${key}|${i}`)))),
    );
  }

  /** A row: the field as a pill and the text around the match. It goes where the match is (revealSearch). */
  private searchRow(object: SearchObject, target: SearchTarget, hit: SearchHit, key: string): HTMLButtonElement {
    return this.navButton(key, 'search-row', goTitle(object), () => this.changes.revealSearch(object, target, hit.dataField),
      h('span', { class: 'search-pill', 'data-category': pillCategory(hit.label) }, hit.label),
      h('span', { class: 'search-snippet' }, hit.before, h('mark', {}, hit.match), hit.after),
    );
  }

  private revealType(name: string, field?: string): void {
    this.showTab('data');
    const type = this.tabs.get('data')!.body.querySelector<HTMLElement>(`[data-type-name="${CSS.escape(name)}"]`);
    const row = field !== undefined ? type?.querySelector<HTMLElement>(`[data-field-name="${CSS.escape(field)}"]`) : undefined;
    const target = row ?? type;
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    }
  }

  private renderData(types: DataType[]): void {
    const body = this.tabs.get('data')!.body;
    clear(body);
    if (types.length === 0) {
      body.append(h('p', { class: 'empty' }, 'No data types in the package.'));
      return;
    }
    for (const t of types) {
      const rows = t.fields.map((f) =>
        h(
          'tr',
          { 'data-field-name': f.name },
          h('td', {}, f.name),
          h('td', { class: 'mono' }, f.type),
          h('td', { class: 'center' }, f.required ? 'yes' : 'no'),
          h('td', { class: 'center' }, f.list ? 'yes' : 'no'),
        ),
      );
      body.append(
        h(
          'section',
          { class: 'datatype', 'data-type-name': t.name },
          h('h3', {}, t.name),
          t.namespace ? h('div', { class: 'muted mono' }, t.namespace) : null,
          t.documentation ? h('p', { class: 'doc' }, t.documentation) : null,
          t.fields.length === 0
            ? h('p', { class: 'empty' }, 'No fields.')
            : h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Required'), h('th', {}, 'List')),
                ),
                h('tbody', {}, ...rows),
              ),
        ),
      );
    }
  }

  private renderChanges(data: RenderMessage): void {
    const { button, body } = this.tabs.get('changes')!;
    const diff = data.diff;
    button.textContent = changesTabTitle(diff);
    button.classList.toggle('has-changes', diff !== undefined && diff.note === undefined && changeCount(diff) > 0);
    clear(body);
    if (!diff) {
      body.append(h('p', { class: 'empty' }, NOTHING_TO_COMPARE));
      return;
    }
    body.append(this.comparedWith(diff));
    if (diff.note !== undefined) {
      body.append(h('p', { class: 'hint' }, diff.note));
      return;
    }
    if (changeCount(diff) === 0) {
      body.append(h('p', { class: 'empty' }, 'No changes.'));
      return;
    }
    const groups = changeGroups(diff, data.elements);
    const group = (title: string, rows: ChangeRow[], badge: boolean) =>
      rows.length > 0
        ? h('section', { class: 'changes' }, h('h3', {}, `${title} (${rows.length})`), h('ul', { class: 'change-list' }, ...rows.map((r) => this.changeRow(r, badge))))
        : null;
    body.append(
      ...[
        group('Added', groups.added, false),
        group('Changed', groups.changed, false),
        group('Removed', groups.removed, false),
        group('Business objects', groups.businessObjects, true),
      ].filter((x): x is HTMLElement => x !== null),
    );
    if (groups.removed.length > 0) body.append(h('p', { class: 'hint' }, 'Removed elements are not drawn.'));
  }

  private comparedWith(diff: DiffView): HTMLElement {
    const at = new Date(diff.loadedAt).toLocaleString();
    const text = h('span', { title: diff.baseKind === 'file' ? `Read ${at}` : `The version shown before the latest reload, read ${at}` }, comparedWithText(diff));
    let clearButton: HTMLButtonElement | null = null;
    if (diff.baseKind === 'file') {
      clearButton = h('button', { class: 'button small', type: 'button', title: 'Stop comparing with this file' }, 'Clear');
      clearButton.addEventListener('click', () => this.changes.clearComparison());
    }
    return h('div', { class: 'compared-with' }, text, clearButton);
  }

  /** One entry: its label (a button that selects the element, when it is drawn) and its change lines. */
  private changeRow(r: ChangeRow, badge: boolean): HTMLElement {
    let label: HTMLElement;
    const id = r.revealId;
    if (id !== undefined) {
      // A real button: mouse, Enter and Space all work; the listener is bound each time the list is drawn.
      const link = h('button', { class: 'link', type: 'button', title: 'Select in the diagram and show its details' }, r.label);
      link.addEventListener('click', () => this.changes.reveal(id));
      label = link;
    } else {
      label = h('span', { class: 'change-label' }, r.label);
    }
    return h(
      'li',
      { class: `change ${r.status}` },
      h('div', { class: 'change-line' }, badge ? h('span', { class: `badge kind diff-${r.status}` }, STATUS_LABELS[r.status]) : null, label),
      r.changes.length > 0 ? h('ul', { class: 'change-details' }, ...r.changes.map((c) => h('li', {}, c))) : null,
    );
  }

  /** The Trace tab: there only while a description is attached. */
  private renderTrace(trace: TraceView | undefined): void {
    const { button, body } = this.tabs.get('trace')!;
    button.hidden = trace === undefined;
    button.textContent = traceTabTitle(trace);
    button.classList.toggle('has-changes', trace !== undefined && trace.error === undefined && trace.counts.missing > 0);
    clear(body);
    if (!trace) {
      // The description was cleared while its tab was shown.
      if (this.active === 'trace') this.showTab('details');
      return;
    }
    const clearButton = h('button', { class: 'button small', type: 'button', title: 'Stop checking against this description' }, 'Clear');
    clearButton.addEventListener('click', () => this.changes.clearDescription());
    body.append(
      h('div', { class: 'compared-with' }, h('span', { class: 'trace-file', title: 'Description the process is checked against' }, `Checked against ${trace.fileName}`), clearButton),
    );
    if (trace.error !== undefined) {
      body.append(h('p', { class: 'hint trace-error' }, trace.error));
      return;
    }
    if (trace.summary === '') {
      // No checked section: one line, no rows, no error.
      if (trace.notice !== undefined) body.append(h('p', { class: 'hint trace-notice' }, trace.notice));
      return;
    }
    body.append(h('p', { class: 'trace-summary' }, trace.summary));
    if (trace.notice !== undefined) body.append(h('p', { class: 'hint trace-notice' }, trace.notice));
    if (trace.rows.length === 0) body.append(h('p', { class: 'empty' }, 'The description has no steps, gateway paths, business objects or human tasks to check.'));
    for (const group of traceGroups(trace.rows)) {
      body.append(h('section', { class: 'trace' }, h('h3', {}, group.title), h('ul', { class: 'trace-list' }, ...group.rows.map((r) => this.traceRow(r)))));
    }
    const notChecked = notCheckedText(trace.notChecked);
    if (notChecked) body.append(h('p', { class: 'hint' }, notChecked));
  }

  /** One row: icon, the description's text (a button when it points at something) and the match or reason. */
  private traceRow(r: TraceRow): HTMLElement {
    const target = r.target;
    let label: HTMLElement;
    if (target && (target.type === 'node' || target.type === 'flow')) {
      label = h('button', { class: 'link', type: 'button', title: 'Select in the diagram and show its details' }, r.text);
      label.addEventListener('click', () => this.changes.revealTrace(target));
    } else if (target && target.type === 'field') {
      const type = target.dataType;
      label = h('button', { class: 'link', type: 'button', title: 'Show in Data tab' }, r.text);
      label.addEventListener('click', () => this.revealType(type));
    } else {
      label = h('span', { class: 'trace-text' }, r.text);
    }
    const lineInfo = r.line !== undefined ? ` (line ${r.line})` : '';
    return h(
      'li',
      { class: `trace-row ${r.status}`, 'data-status': r.status },
      h('span', { class: 'trace-icon', title: TRACE_STATUS_LABELS[r.status], 'aria-label': TRACE_STATUS_LABELS[r.status] }, TRACE_ICONS[r.status]),
      h('span', { class: 'trace-body' }, label, h('span', { class: 'trace-detail muted', title: `${r.note}${lineInfo}` }, traceDetail(r))),
    );
  }

  private renderWarnings(warnings: string[]): void {
    const { button, body } = this.tabs.get('warnings')!;
    button.textContent = `Warnings (${warnings.length})`;
    button.classList.toggle('has-warnings', warnings.length > 0);
    clear(body);
    body.append(
      warnings.length === 0
        ? h('p', { class: 'empty' }, 'No warnings.')
        : h('ul', { class: 'warnings' }, ...warnings.map((w) => h('li', {}, w))),
    );
  }
}

function renderProcess(p: ProcessSummary, revealType: RevealType): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, p.name || p.id),
    p.kind !== 'Process' ? h('div', { class: 'subtitle muted' }, p.kind) : null,
    h('p', { class: 'hint' }, 'Click a node or flow to see its details.'),
    fields([
      ['Kind', p.kind],
      ['Source', p.sourceFile],
      ['Process app', p.app],
      ['Exporter', p.exporter],
      ['Id', p.originalId ?? p.id, true],
    ]),
    p.documentation ? section('Documentation', h('p', { class: 'doc' }, p.documentation)) : null,
    p.inputs && p.inputs.length > 0 ? section('Inputs', parameters(p.inputs, revealType)) : null,
    p.outputs && p.outputs.length > 0 ? section('Outputs', parameters(p.outputs, revealType)) : null,
    p.variables && p.variables.length > 0 ? section('Variables', variablesTable(p.variables, revealType)) : null,
    p.toolkits && p.toolkits.length > 0
      ? section('Toolkits', h('ul', { class: 'params' }, ...p.toolkits.map((t) => h('li', {}, t))))
      : null,
  );
}

function renderElement(d: ElementDetails, ctx: NodeContext): HTMLElement {
  if (d.kind === 'node') return renderNode(d, ctx);
  if (d.kind === 'flow') return renderFlow(d);
  return renderLane(d);
}

function renderNode(d: NodeDetails, ctx: NodeContext): HTMLElement {
  const revealType = ctx.types;
  const callee = d.callee !== undefined ? ctx.callees[d.callee] : undefined;
  let open: HTMLElement | null = null;
  if (d.openCallee !== undefined) {
    const calleeId = d.openCallee;
    const isProcess = d.openProcessId !== undefined;
    const isSub = d.containsNodes !== undefined;
    const [title, label] = isSub
      ? ['Open the inside of the sub-process as a diagram (or double-click it)', 'Open sub-process']
      : isProcess
        ? ['Open the called process (or double-click the activity)', 'Open process']
        : ['Open the called service as a diagram (or double-click the activity)', 'Open diagram'];
    const button = h('button', { class: 'button', type: 'button', title }, label);
    button.addEventListener('click', () => ctx.openCallee(calleeId));
    open = button;
  } else if (d.openUnavailable !== undefined) {
    const title = d.containsNodes !== undefined ? 'This sub-process holds no nodes' : 'This call cannot be opened as a diagram';
    open = h('span', { class: 'muted', title }, d.openUnavailable);
  }
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed)'),
    fields([
      ['BPMN kind', d.bpmnKind],
      ['Original type', d.originalType, true],
      ['Service type', d.serviceType],
      ['Calls', d.calls],
      ['Contains', d.containsNodes !== undefined ? containsText(d.containsNodes) : undefined],
      ['Event', d.eventType],
      ['Attached to', d.boundary?.attachedTo],
      ['Catches', d.boundary ? catchesText(d.boundary) : undefined],
      ['Service', d.rest?.service],
      ['Operation', d.rest?.operation],
      ['Lane', d.lane],
      // A user task shows its performer under Assignment.
      ['Performer', d.userTask ? undefined : d.performer],
      ['Id', d.originalId ?? d.id, true],
    ]),
    open ? h('p', { class: 'actions' }, open) : null,
    d.documentation ? section('Documentation', h('p', { class: 'doc' }, d.documentation)) : null,
    d.script ? scriptSection(d.script) : null,
    d.coach ? section('Controls', controlsTable(d.coach)) : null,
    d.userTask ? assignmentSection(d.userTask) : null,
    d.timer ? timerSection(d.timer) : null,
    d.outgoing ? section('Outgoing conditions', outgoingTable(d.outgoing)) : null,
    // A call's mapping lists every parameter of the signature, so it replaces the plain list.
    d.inputMappings
      ? section('Input mapping', inputMappingTable(d.inputMappings, revealType))
      : d.inputs.length > 0
        ? section('Inputs', parameters(d.inputs, revealType))
        : null,
    d.outputMappings
      ? section('Output mapping', outputMappingTable(d.outputMappings))
      : d.outputs.length > 0
        ? section('Outputs', parameters(d.outputs, revealType))
        : null,
    callee ? insideSection(callee, revealType) : null,
  );
}

/** "Inside <service>": the steps, data and coaches of the called service, folded by default. */
function insideSection(c: CalleeDetails, revealType: RevealType): HTMLElement {
  const steps =
    c.steps.length === 0
      ? h('p', { class: 'empty' }, 'No steps between start and end.')
      : h('ol', { class: 'steps' }, ...c.steps.map((s) => stepItem(s, revealType)));
  return h(
    'details',
    { class: 'inside' },
    h('summary', {}, h('span', { class: 'inside-title' }, `Inside ${c.name}`), h('span', { class: 'muted' }, insideSummary(c))),
    h('section', {}, h('h4', {}, 'Steps'), steps),
    c.inputs && c.inputs.length > 0 ? subsection('Inputs', parameters(c.inputs, revealType)) : null,
    c.outputs && c.outputs.length > 0 ? subsection('Outputs', parameters(c.outputs, revealType)) : null,
    c.variables && c.variables.length > 0 ? subsection('Variables', variablesTable(c.variables, revealType)) : null,
    c.coaches && c.coaches.length > 0 ? h('section', {}, h('h4', {}, 'Coaches'), ...c.coaches.map(coachBlock)) : null,
  );
}

function stepItem(s: CalleeStepDetails, revealType: RevealType): HTMLElement {
  const note = stepNote(s);
  const boundaries = (s.errorBoundaries ?? []).map((b) => {
    const catches = catchesLabel(b);
    return h(
      'div',
      { class: 'step-line' },
      h('span', { class: 'badge kind' }, 'Error boundary'),
      h('span', {}, b.name || '(unnamed)'),
      catches ? h('span', { class: 'muted' }, ` · ${catches}`) : null,
      b.to !== undefined ? h('span', { class: 'muted' }, ` · to ${b.to}`) : null,
    );
  });
  return h(
    'li',
    { class: 'step' },
    h(
      'div',
      { class: 'step-line' },
      h('span', { class: 'badge kind' }, STEP_KIND_LABELS[s.kind]),
      h('span', {}, s.name || '(unnamed)'),
      note ? h('span', { class: 'muted' }, ` · ${note}`) : null,
    ),
    ...boundaries,
    s.calls ? fields([['Calls', s.calls]]) : null,
    s.rest
      ? fields([
          ['Service', s.rest.service],
          ['Operation', s.rest.operation],
        ])
      : null,
    s.script ? foldedScript(s.script) : null,
    s.conditions ? conditionsTable(s.conditions) : null,
    s.inputMappings ? subsection('Input mapping', inputMappingTable(s.inputMappings, revealType)) : null,
    s.outputMappings ? subsection('Output mapping', outputMappingTable(s.outputMappings)) : null,
  );
}

/** A step's script, folded by default; the same block as a script task's. */
function foldedScript(s: ScriptDetails): HTMLElement {
  if (s.hidden) return h('p', { class: 'hint' }, 'Script content hidden by the lanescope.showScripts setting.');
  const lines = `${s.lineCount} ${s.lineCount === 1 ? 'line' : 'lines'}`;
  return h('details', { class: 'fold' }, h('summary', {}, `Script · ${lines}`), scriptSection(s));
}

function conditionsTable(rows: NonNullable<CalleeStepDetails['conditions']>): HTMLElement {
  return table(
    ['To', 'Condition', 'Default'],
    rows.map((c) => [
      h('td', {}, c.to),
      c.condition !== undefined ? h('td', {}, h('code', { class: 'expr' }, c.condition)) : h('td', { class: 'muted' }, 'no condition'),
      h('td', { class: 'center' }, c.isDefault ? 'yes' : ''),
    ]),
  );
}

function coachBlock(c: CoachDetails): HTMLElement {
  return h(
    'div',
    { class: 'coach' },
    h('div', { class: 'step-line' }, h('span', { class: 'badge kind' }, 'Coach'), h('span', {}, c.name || '(unnamed)')),
    controlsTable(c),
  );
}

/** Control · Type · Binding of a coach. */
function controlsTable(c: CoachDetails): HTMLElement {
  if (c.controls.length === 0) return h('p', { class: 'empty' }, 'No controls.');
  return table(
    ['Control', 'Type', 'Binding'],
    c.controls.map((k) => [
      h('td', {}, k.label ?? k.id),
      h('td', {}, k.type ?? ''),
      k.binding !== undefined ? h('td', {}, h('code', { class: 'expr' }, k.binding)) : h('td', {}),
    ]),
  );
}

function subsection(title: string, content: Node): HTMLElement {
  return h('section', {}, h('h4', {}, title), content);
}

function scriptSection(s: ScriptDetails): HTMLElement {
  if (s.hidden) {
    return section('Script', h('p', { class: 'hint' }, 'Script content hidden by the lanescope.showScripts setting.'));
  }
  const lines = s.text.split('\n');
  const folded = lines.length > SCRIPT_FOLD_LINES;
  const pre = h('pre', { class: 'code script' });
  pre.textContent = folded ? lines.slice(0, SCRIPT_FOLD_LINES).join('\n') : s.text;

  const copy = h('button', { class: 'button small', type: 'button', title: 'Copy the script to the clipboard' }, 'Copy');
  let reset: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', () => {
    const done = (label: string) => {
      copy.textContent = label;
      clearTimeout(reset);
      reset = setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    // Only on a click: the clipboard is never read and never written otherwise.
    navigator.clipboard.writeText(s.text).then(
      () => done('Copied'),
      () => done('Copy failed'),
    );
  });

  let expand: HTMLButtonElement | null = null;
  if (folded) {
    const button = h('button', { class: 'link', type: 'button' }, `Show all ${s.lineCount} lines`);
    button.addEventListener('click', () => {
      pre.textContent = s.text;
      button.remove();
    });
    expand = button;
  }

  const meta = `${s.lineCount} ${s.lineCount === 1 ? 'line' : 'lines'}${s.language ? ` · ${s.language}` : ''}`;
  return h(
    'section',
    {},
    h('div', { class: 'section-head' }, h('h3', {}, 'Script'), h('span', { class: 'muted' }, meta), copy),
    pre,
    expand,
  );
}

function assignmentSection(u: UserTaskDetails): HTMLElement | null {
  const dl = fields([
    ['Assignment type', u.assignment],
    ['Lane', u.lane],
    ['Performer', u.performer],
    ['Priority', u.priority],
    ['Due date', u.dueDate],
    ['Subject', u.subject, true],
  ]);
  return dl.childElementCount > 0 ? section('Assignment', dl) : null;
}

function timerSection(t: TimerDetails): HTMLElement {
  const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 'yes' : 'no');
  return section(
    'Timer',
    fields([
      ['Duration', t.unit ? `${t.duration} ${t.unit}` : t.duration, !/^\d+(\.\d+)?$/.test(t.duration)],
      ['Interrupting', flag(t.interrupting)],
      ['Repeating', flag(t.repeating)],
    ]),
  );
}

function outgoingTable(flows: OutgoingFlowDetails[]): HTMLElement {
  return table(
    ['To', 'Condition', 'Default'],
    flows.map((f) => [
      h('td', {}, f.target),
      f.condition !== undefined ? h('td', {}, h('code', { class: 'expr' }, f.condition)) : h('td', { class: 'muted' }, '—'),
      h('td', { class: 'center' }, f.isDefault ? 'yes' : ''),
    ]),
  );
}

function inputMappingTable(rows: MappingDetails[], revealType: RevealType): HTMLElement {
  return table(
    ['Parameter', 'Type', 'Value'],
    rows.map((m) => [h('td', {}, m.parameter), h('td', {}, typeLink(m.type, m.isCollection, revealType)), mappedValue(m)]),
  );
}

function outputMappingTable(rows: MappingDetails[]): HTMLElement {
  return table(
    ['Parameter', 'Target'],
    rows.map((m) => [h('td', {}, m.parameter), mappedValue(m)]),
  );
}

function mappedValue(m: MappingDetails): HTMLElement {
  if (!m.mapped) return h('td', { class: 'muted' }, 'not mapped');
  const value = m.value ?? '';
  return h(
    'td',
    {},
    value === '' ? h('span', { class: 'muted' }, m.literal ? '(empty text)' : '(empty)') : h('code', { class: 'expr' }, value),
    m.literal ? h('span', { class: 'badge', title: 'A literal value, not an expression' }, 'literal') : null,
  );
}

function variablesTable(vars: VariableDetails[], revealType: RevealType): HTMLElement {
  return table(
    ['Name', 'Type', 'List', 'Default', 'Tracked'],
    vars.map((v) => [
      h('td', {}, v.name),
      h('td', {}, typeLink(v.type, false, revealType)),
      h('td', { class: 'center' }, v.isCollection ? 'yes' : 'no'),
      v.defaultValue !== undefined ? h('td', {}, h('code', { class: 'expr' }, v.defaultValue)) : h('td', {}),
      h('td', { class: 'center' }, v.tracked ? 'yes' : 'no'),
    ]),
  );
}

function table(headers: string[], rows: HTMLElement[][]): HTMLElement {
  return h(
    'table',
    { class: 'grid' },
    h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map((cells) => h('tr', {}, ...cells))),
  );
}

/** A type name; a link that opens the type in the Data tab when the tab has it. */
function typeLink(type: string | undefined, isCollection: boolean, revealType: RevealType): Node | null {
  if (!type) return isCollection ? h('span', { class: 'muted' }, 'list') : null;
  const text = isCollection ? `${type}[]` : type;
  if (!isLinkedType(type, revealType.known)) return h('span', { class: 'mono' }, text);
  const link = h('button', { class: 'link mono', type: 'button', title: 'Show in Data tab' }, text);
  link.addEventListener('click', () => revealType.reveal(type));
  return link;
}

function renderFlow(d: FlowDetails): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed flow)'),
    d.labelHidden ? h('p', { class: 'hint' }, 'Generated label, hidden in the diagram.') : null,
    fields([
      ['Kind', 'Sequence flow'],
      ['From', d.source],
      ['To', d.target],
      ['Default flow', d.isDefault ? 'yes' : 'no'],
      ['Id', d.originalId ?? d.id, true],
    ]),
    d.condition !== undefined ? section('Condition', h('pre', { class: 'code' }, d.condition)) : null,
  );
}

function renderLane(d: LaneDetails): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed lane)'),
    fields([
      ['Kind', 'Lane'],
      ['Nodes', String(d.nodeCount)],
      ['Id', d.originalId ?? d.id, true],
    ]),
  );
}

function fields(rows: Array<[string, string | undefined, boolean?]>): HTMLElement {
  const dl = h('dl', { class: 'fields' });
  for (const [label, value, mono] of rows) {
    if (value === undefined || value === '') continue;
    dl.append(h('dt', {}, label), h('dd', mono ? { class: 'mono' } : {}, value));
  }
  return dl;
}

function section(title: string, content: Node): HTMLElement {
  return h('section', {}, h('h3', {}, title), content);
}

function parameters(params: ParameterDetails[], revealType: RevealType): HTMLElement {
  return h(
    'ul',
    { class: 'params' },
    ...params.map((p) => {
      const type = typeLink(p.type, p.isCollection, revealType);
      return h('li', {}, h('span', {}, p.name), type ? ' : ' : null, type);
    }),
  );
}

/** Where a click on a search result goes, as a tooltip. */
function goTitle(object: SearchObject): string {
  if (object.kind === 'dataType') return 'Show in Data tab';
  if (object.kind === 'service') {
    if (!object.openable) return 'This service has no diagram: selects the activity that calls it';
    return 'Open the service as a diagram and select this element';
  }
  return 'Select in the diagram and show its details';
}

/** A stable key of an object of a search result, to keep its fold and Callers list over rebuilds. */
function objectKey(o: SearchObject): string {
  return `${o.kind}:${o.id}`;
}

function targetKey(t: SearchTarget): string {
  if (t.type === 'node' || t.type === 'flow') return `${t.type}:${t.id}`;
  return t.type === 'dataType' ? `dataType:${t.name}` : 'root';
}
