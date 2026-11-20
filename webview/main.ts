// Webview entry point: a toolbar, the bpmn-js NavigatedViewer and the side panel.
// Runs in the browser sandbox under a strict CSP: no network requests, and
// all text from the model is set with textContent.

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import './main.css';

import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { isPathPrefix, pathKey } from '../src/views/navigation';
import type {
  DescriptionStatusMessage,
  ErrorMessage,
  ExportFormat,
  ExportSourceMessage,
  HostMessage,
  RefreshErrorMessage,
  RenderMessage,
  ShowLevelMessage,
  ViewOptions,
  WebviewMessage,
} from '../src/views/protocol';
import type { TraceTarget } from '../src/trace/trace';
import type { SearchCaller, SearchLevel, SearchObject, SearchResult, SearchScope, SearchTarget } from '../src/search/search';
import { clear, h } from './dom';
import { addDrilldownArrows, keepImportedRoot, NO_BPMN_DRILLDOWN } from './drilldown';
import { renderExportPng, renderExportSvg } from './exportImage';
import { LOAD_TIMEOUT_MS, startLoadWatchdog } from './loadWatchdog';
import { DropdownMenu } from './menu';
import { isTabId, SidePanel, type TabId } from './panel';
import { traceTabTitle } from './panelText';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  tab?: TabId;
  /** The text in the search box (the state is per editor tab, so per document). */
  search?: string;
  /** What the search looks at: the whole file (default) or the shown process. */
  searchScope?: SearchScope;
}

interface Viewbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiagramElement {
  id: string;
  type: string;
  /** Set on an external label: the element it belongs to. */
  labelTarget?: DiagramElement;
  /** Shapes: their bounds. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Connections: their points. */
  waypoints?: Array<{ x: number; y: number }>;
  /** The external label of an event, gateway or flow, when it has one. */
  label?: DiagramElement;
}

interface Canvas {
  zoom(level?: number | 'fit-viewport', center?: { x: number; y: number }): number;
  viewbox(box?: Viewbox): Viewbox & { scale: number };
  resized(): void;
  addMarker(element: DiagramElement, marker: string): void;
  removeMarker(element: DiagramElement, marker: string): void;
}

interface ElementRegistry {
  get(id: string): DiagramElement | undefined;
}

interface Selection {
  select(element: DiagramElement | null): void;
}

interface EventBus {
  on(event: string, callback: (e: { element?: DiagramElement; oldSelection?: DiagramElement[]; newSelection?: DiagramElement[] }) => void): void;
}

/** What is brought back when the user returns to a level: the view and the selection. */
interface LevelState {
  path: string[];
  viewbox: Viewbox;
  selection: string | undefined;
}

const vscode = acquireVsCodeApi();
const state = (vscode.getState() as PersistedState | undefined) ?? {};

// ---- Layout -------------------------------------------------------------

const fitButton = button('Fit', 'Fit the diagram to the window (0)');
const zoomInButton = button('+', 'Zoom in (+)');
const zoomOutButton = button('−', 'Zoom out (-)');
const labelsToggle = toggle('Hide generated flow labels', 'Hide "To <target>" flow names; condition and default flows keep their label');
const lanesToggle = toggle('Show empty lanes', 'Draw lanes that contain no nodes (the Warnings tab lists them)');
const highlightToggle = toggle('Highlight changes', 'Mark added (green) and changed (amber) elements of the comparison; the Changes tab lists them either way');
const compareButton = button('Compare…', 'Compare with another version of the process (.bpmn, .zip or .twx)');
const title = h('span', { class: 'title' });
// Shown only when the package holds more than one process (a TWX with several BPDs).
const processSelect = h('select', {
  class: 'process-select',
  title: 'Process to show',
  'aria-label': 'Process to show',
  hidden: '',
});
const updated = h('span', { class: 'updated muted', hidden: '' });

// Export: a button with a small menu of the formats.
const exportButton = button('Export', 'Export the diagram to a new file');
const EXPORT_ITEMS: Array<{ format: ExportFormat; text: string; tooltip?: string }> = [
  { format: 'bpmn', text: 'BPMN with layout, no scripts (.bpmn)', tooltip: 'Diagram and layout only. Script code is never exported.' },
  { format: 'svg', text: 'SVG image (.svg)' },
  { format: 'png', text: 'PNG image (.png)' },
];
const exportGroup = h('span', { class: 'menu-anchor' }, exportButton);
const exportMenu = new DropdownMenu(
  exportButton,
  'Export as',
  EXPORT_ITEMS.map(({ format, text, tooltip }) => ({ text, tooltip, run: () => vscode.postMessage({ type: 'exportRequest', format }) })),
  () => exportGroup,
);
exportGroup.append(exportMenu.element);

// Trace: a split button. The main part shows the Trace tab (or asks for a description when none is attached);
// the arrow opens the description commands. The host runs them as it runs the Lanescope commands.
const TRACE_IDLE_TOOLTIP = 'Check this process against a description';
const NEW_DESCRIPTION_LABEL = 'New Process Description';
const OPEN_DESCRIPTION_LABEL = 'Open Process Description';
const NEW_DESCRIPTION_TOOLTIP = 'Write <name>-description.md from a template next to the opened file, open it and check against it';
const OPEN_DESCRIPTION_TOOLTIP = 'Open <name>-description.md next to the opened file and check against it';
const traceBadge = h('span', { class: 'count-badge', hidden: '' });
const traceButton = h('button', { type: 'button', class: 'button split-main', title: TRACE_IDLE_TOOLTIP }, 'Trace', traceBadge);
const traceArrow = h('button', { type: 'button', class: 'button split-arrow', title: 'Description commands', 'aria-label': 'Description commands' }, '▾');
const traceGroup = h('span', { class: 'menu-anchor split' }, traceButton, traceArrow);
const traceMenu = new DropdownMenu(
  traceArrow,
  'Description',
  [
    { text: 'Check Against Description…', tooltip: 'Pick a Markdown description to check this process against', run: () => vscode.postMessage({ type: 'checkDescription' }) },
    // Its label follows the host's answer to descriptionStatus: Open when <name>-description.md is there.
    { text: NEW_DESCRIPTION_LABEL, tooltip: NEW_DESCRIPTION_TOOLTIP, run: () => vscode.postMessage({ type: 'newDescription' }) },
    { text: 'Clear Description Check', tooltip: 'Stop checking against the description', run: () => vscode.postMessage({ type: 'clearDescription' }) },
  ],
  () => traceGroup,
  // The file may have come or gone since the last answer: ask again.
  () => vscode.postMessage({ type: 'descriptionStatus' }),
);
traceGroup.append(traceMenu.element);
const traceDescriptionItem = traceMenu.items[1];
const traceClearItem = traceMenu.items[2];

/** The Trace menu's second item: Open when <name>-description.md is there (it is then only opened), else New. */
function showDescriptionStatus(msg: DescriptionStatusMessage): void {
  traceDescriptionItem.textContent = msg.exists ? OPEN_DESCRIPTION_LABEL : NEW_DESCRIPTION_LABEL;
  traceDescriptionItem.title = msg.exists ? OPEN_DESCRIPTION_TOOLTIP : NEW_DESCRIPTION_TOOLTIP;
}
traceButton.addEventListener('click', () => {
  if (current?.trace) panel.showTab('trace');
  else vscode.postMessage({ type: 'checkDescription' });
});

// Search: always there; Cmd/Ctrl+F focuses it, Escape clears it. Results are listed in the Search tab.
const SEARCH_DEBOUNCE_MS = 200;
const searchInput = h('input', {
  type: 'search',
  class: 'search-input',
  placeholder: 'Search…',
  title: 'Search names, documentation, scripts, conditions… (Cmd/Ctrl+F)',
  'aria-label': 'Search names, documentation, scripts, conditions…',
  spellcheck: 'false',
});
searchInput.value = typeof state.search === 'string' ? state.search : '';

const toolbar = h(
  'div',
  { class: 'toolbar', role: 'toolbar' },
  title,
  processSelect,
  updated,
  h('span', { class: 'spacer' }),
  labelsToggle.label,
  lanesToggle.label,
  highlightToggle.label,
  h('span', { class: 'group' }, zoomOutButton, zoomInButton, fitButton),
  compareButton,
  traceGroup,
  searchInput,
  exportGroup,
);

const canvasHost = h('div', { class: 'canvas', tabindex: '0' });
const overlay = h('div', { class: 'overlay' }, h('p', { class: 'muted' }, 'Loading…'));
const stage = h('div', { class: 'stage' }, canvasHost, overlay);

// Breadcrumb of the open levels; shown once a call has been opened.
const backButton = button('Back', 'Back to the calling diagram (Escape)');
const crumbList = h('ol', {});
const crumbNote = h('span', { class: 'note muted', role: 'status', hidden: '' });
const crumbs = h(
  'nav',
  { class: 'crumbs', 'aria-label': 'Open diagrams', hidden: '' },
  backButton,
  crumbList,
  crumbNote,
);
backButton.addEventListener('click', goBack);

// Refresh failures: shown above the last good diagram until the next render.
const bannerTitle = h('strong', {});
const bannerText = h('span', {});
const bannerClose = h('button', { type: 'button', class: 'banner-close', title: 'Dismiss', 'aria-label': 'Dismiss' }, '×');
const banner = h(
  'div',
  { class: 'banner', role: 'alert', hidden: '' },
  h('div', { class: 'banner-text' }, bannerTitle, bannerText),
  bannerClose,
);
bannerClose.addEventListener('click', hideBanner);

const panel = new SidePanel(
  (tab) => {
    state.tab = tab;
    vscode.setState(state);
  },
  (calleeId) => openCallee(calleeId),
  {
    reveal: (id) => revealElement(id),
    clearComparison: () => vscode.postMessage({ type: 'clearComparison' }),
    revealTrace: (target) => revealTraceTarget(target),
    clearDescription: () => vscode.postMessage({ type: 'clearDescription' }),
    revealSearch: (object, target, dataField) => revealSearchResult(object, target, dataField),
    showCaller: (caller) => showCaller(caller),
    focusSearchBox: () => searchInput.focus(),
    searchScopeChanged: (scope) => {
      state.searchScope = scope;
      vscode.setState(state);
      runSearch(false);
    },
  },
  // A hidden webview is rebuilt when its editor tab is shown again: start on
  // the tab it had (the state is per editor tab), else on Details.
  isTabId(state.tab) && (state.tab !== 'search' || searchInput.value.trim() !== '') ? state.tab : 'details',
  state.searchScope === 'shown' ? 'shown' : 'file',
);

const root = document.getElementById('root')!;
// The diagram's focus frame is for keyboard users only: a click focuses the diagram too, and must not frame it.
document.addEventListener('keydown', () => (document.documentElement.dataset.input = 'keyboard'), true);
document.addEventListener('pointerdown', () => (document.documentElement.dataset.input = 'pointer'), true);
root.append(toolbar, crumbs, banner, h('div', { class: 'main' }, stage, panel.element));

// ---- Viewer -------------------------------------------------------------

let viewer = createViewer();
let current: RenderMessage | undefined;
/** Increases with every import; results of older imports are dropped. */
let importGeneration = 0;
/** The view and selection of each level above the shown one, by path key. */
const levelStates = new Map<string, LevelState>();
/** A trace or search row asked for an element on another level: select it once that level is drawn. */
let pendingReveal: PendingReveal | undefined;

interface PendingReveal {
  /** Element to select; undefined selects nothing (the level's summary in Details). */
  id: string | undefined;
  /** The level asked for. */
  where: ShowLevelMessage;
  /** A search row: stay on the Search tab. */
  fromSearch?: boolean;
}

function createViewer(): NavigatedViewer {
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const v = new NavigatedViewer({
    container: canvasHost,
    keyboard: { bind: false },
    // bpmn-js's drill-down would switch to an empty plane of the sub-process; ours opens its level (./drilldown).
    additionalModules: [NO_BPMN_DRILLDOWN],
    bpmnRenderer: {
      defaultFillColor: color('--vscode-editor-background', '#ffffff'),
      defaultStrokeColor: color('--vscode-editor-foreground', '#000000'),
      defaultLabelColor: color('--vscode-editor-foreground', '#000000'),
    },
  });
  keepImportedRoot(v);
  const eventBus = v.get<EventBus>('eventBus');
  eventBus.on('element.click', (e) => {
    // An external label stands for its element (a gateway's or an event's name).
    const el = e.element?.labelTarget ?? e.element;
    if (el && e.element?.labelTarget) v.get<Selection>('selection').select(el);
    // Clicking the pool or empty canvas shows the process details.
    panel.select(el && el.type !== 'bpmn:Participant' && el.type !== 'bpmn:Process' ? el.id : undefined);
  });
  // The one way the selection is drawn: every select (a click, a Changes or Trace row, the
  // selection kept over a re-render or brought back after a drill-down) goes through here.
  eventBus.on('selection.changed', (e) => {
    const c = v.get<Canvas>('canvas');
    for (const el of e.oldSelection ?? []) for (const marker of SELECTION_MARKERS) c.removeMarker(el, marker);
    for (const el of e.newSelection ?? []) for (const marker of selectionMarkers(el)) c.addMarker(el, marker);
  });
  // Double-clicking a call opens what it calls, like the "Open diagram" button.
  eventBus.on('element.dblclick', (e) => {
    const details = e.element ? current?.elements[e.element.id] : undefined;
    if (details?.kind === 'node' && details.openCallee !== undefined) openCallee(details.openCallee);
  });
  return v;
}

function canvas(): Canvas {
  return viewer.get<Canvas>('canvas');
}

async function render(msg: RenderMessage): Promise<void> {
  const generation = ++importGeneration;
  const path = msg.path.map((l) => l.id);
  const sameLevel = current !== undefined && pathKey(currentPath()) === pathKey(path);
  // Leaving a level: remember its view and selection for the way back.
  if (current && !sameLevel) {
    const box = canvas().viewbox();
    const from = currentPath();
    levelStates.set(pathKey(from), {
      path: from,
      viewbox: { x: box.x, y: box.y, width: box.width, height: box.height },
      selection: panel.selection,
    });
  }
  // Only the levels above the new one can be returned to (another chosen process starts afresh).
  for (const [key, saved] of [...levelStates]) {
    if (!isPathPrefix(saved.path, path)) levelStates.delete(key);
  }
  const restored = !sameLevel ? levelStates.get(pathKey(path)) : undefined;
  levelStates.delete(pathKey(path));
  const previous = current && msg.preserveView ? canvas().viewbox() : restored?.viewbox;
  current = msg;
  // A new render replaces any refresh error; one sent after it shows again.
  hideBanner();
  title.textContent = msg.process.name || msg.process.id;
  title.title = msg.process.sourceFile;
  showProcessChoices(msg);
  showCrumbs(msg);
  labelsToggle.input.checked = msg.options.hideGeneratedFlowLabels;
  lanesToggle.input.checked = !msg.options.hideEmptyLanes;
  highlightToggle.input.checked = msg.options.highlightChanges;
  setControlsEnabled(true);
  showTraceState(msg);

  // Any failure below must end on the error screen, never on "Loading…".
  try {
    const result = await viewer.importXML(msg.xml);
    if (generation !== importGeneration) return;
    // Elements bpmn-js could not read are left out of the drawing: say so.
    // The typings say string[]; at run time bpmn-js gives Error objects.
    const importWarnings = ((result.warnings ?? []) as unknown[]).map((w) => {
      const text = w instanceof Error ? w.message : String((w as { message?: unknown })?.message ?? w);
      return `Diagram: ${text.split('\n')[0]}`;
    });
    if (previous) {
      canvas().viewbox({ x: previous.x, y: previous.y, width: previous.width, height: previous.height });
    } else {
      canvas().zoom('fit-viewport');
    }
    markChanges(msg);
    // The arrow on a sub-process opens its level, like a double-click; it shows while the sub-process is selected.
    addDrilldownArrows(viewer, msg.elements, openCallee);
    // On the same level the selected element is kept while its id exists; another level starts
    // with the selection it had when it was left, or none.
    panel.setData(msg, importWarnings, sameLevel ? undefined : { id: restored?.selection });
    // The diagram selects the same element again (its drill-down arrow with it).
    const kept = panel.selection !== undefined ? viewer.get<ElementRegistry>('elementRegistry').get(panel.selection) : undefined;
    if (kept) viewer.get<Selection>('selection').select(kept);
    // Back on a level (breadcrumb, Back, Escape): the selection it had is brought into view if needed.
    if (kept && restored) revealInView(kept);
    // A file was just picked with Compare…: show what it changed (kept like any tab choice).
    if (msg.showChanges === true) panel.showTab('changes');
    // A description was just picked: show its check.
    if (msg.showTrace === true) panel.showTab('trace');
    // The search runs again on what is drawn now (a reload, a toggle, another level).
    runSearch(false);
    // The level a trace or search row opened: select its element (only for this render).
    const reveal = pendingReveal;
    pendingReveal = undefined;
    if (reveal && isShown(reveal.where)) finishReveal(reveal);
    overlay.hidden = true;
    showUpdated(msg.loadedAt);
  } catch (err) {
    if (generation !== importGeneration) return;
    showError({
      type: 'error',
      title: 'Cannot draw the diagram',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const DIFF_MARKERS = { added: 'ls-diff-added', changed: 'ls-diff-changed' } as const;

/** Markers of the selected element: ls-selected, with ls-selected-lane for a lane or pool (drawn plainer). */
const SELECTION_MARKERS = ['ls-selected', 'ls-selected-lane', 'ls-selected-own-width'] as const;

/** Types whose border is thicker than the selection stroke: the selection keeps their width. */
const THICK_BORDER_TYPES = new Set(['bpmn:CallActivity', 'bpmn:EndEvent', 'bpmn:Transaction']);

function selectionMarkers(el: DiagramElement): string[] {
  if (el.type === 'bpmn:Lane' || el.type === 'bpmn:Participant') return ['ls-selected', 'ls-selected-lane'];
  return THICK_BORDER_TYPES.has(el.type) ? ['ls-selected', 'ls-selected-own-width'] : ['ls-selected'];
}

/** Marks the added and changed elements of the comparison (this viewer only; exports draw in a viewer of their own). */
function markChanges(msg: RenderMessage): void {
  if (!msg.diff || !msg.options.highlightChanges) return;
  const registry = viewer.get<ElementRegistry>('elementRegistry');
  for (const [id, mark] of Object.entries(msg.diff.marks)) {
    const element = registry.get(id);
    // Elements the toolbar hides (empty lanes) are not drawn.
    if (element && (mark === 'added' || mark === 'changed')) canvas().addMarker(element, DIFF_MARKERS[mark]);
  }
}

/**
 * A row of the Changes, Trace or Search tab was clicked: select the element
 * (as a click on it does), bring it into view if needed (revealInView) and
 * show its details. A Search row keeps the Search tab on screen.
 */
function revealElement(id: string, fromSearch = false): void {
  if (!current) return;
  const registry = viewer.get<ElementRegistry>('elementRegistry');
  // Not drawn at this level (inside a collapsed sub-process): the sub-process that holds it.
  const shownId = [id, ...(current.diff?.enclosing?.[id] ?? [])].find((x) => registry.get(x) !== undefined);
  if (shownId === undefined) return;
  const element = registry.get(shownId)!;
  viewer.get<Selection>('selection').select(element);
  panel.select(shownId);
  revealInView(element);
  if (!fromSearch) panel.showTab('details');
}

/** Margin, in screen pixels, an element is given from the edge of the view when the view has to move. */
const REVEAL_MARGIN_PX = 40;

/** The box of an element and its external label, in diagram coordinates. */
function elementBox(element: DiagramElement): { x: number; y: number; right: number; bottom: number } | undefined {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of element.waypoints ?? []) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const part of [element, element.label]) {
    if (!part || part.waypoints || part.x === undefined || part.y === undefined) continue;
    xs.push(part.x, part.x + (part.width ?? 0));
    ys.push(part.y, part.y + (part.height ?? 0));
  }
  if (xs.length === 0) return undefined;
  return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * The one way a revealed element is brought into view (Search, Changes and
 * Trace rows, the selection brought back to a level): when it and its label
 * are in view, nothing moves; otherwise the view moves by as little as puts
 * them REVEAL_MARGIN_PX inside the edge, at the same zoom, never to the
 * middle. An element larger than the view shows its top left corner.
 */
function revealInView(element: DiagramElement): void {
  const box = elementBox(element);
  if (!box) return;
  const c = canvas();
  const view = c.viewbox();
  const margin = REVEAL_MARGIN_PX / view.scale;
  /** The new start of the view along one axis. */
  const shift = (start: number, size: number, from: number, to: number): number => {
    const end = start + size;
    if (from >= start && to <= end) return start;
    // Larger than the view: its top left corner, unless that is in view already.
    if (to - from + 2 * margin > size) return from >= start && from <= end ? start : from - margin;
    return from < start ? from - margin : to + margin - size;
  };
  const x = shift(view.x, view.width, box.x, box.right);
  const y = shift(view.y, view.height, box.y, box.bottom);
  if (x === view.x && y === view.y) return;
  c.viewbox({ x, y, width: view.width, height: view.height });
}

/** Selects what a pending reveal asked for, once its level is drawn. */
function finishReveal(reveal: PendingReveal): void {
  if (!current) return;
  if (reveal.id === undefined) {
    viewer.get<Selection>('selection').select(null);
    panel.select(undefined);
    return;
  }
  revealElement(reveal.id, reveal.fromSearch === true);
}

/** Whether the drawn path is the level `where` asks for. */
function isShown(where: ShowLevelMessage): boolean {
  if (!current) return false;
  const root = where.serviceId !== undefined
    ? current.serviceRoot === true && current.path[0].id === where.serviceId
    : current.serviceRoot !== true && current.rootProcessId === where.processId;
  return root && pathKey(currentPath().slice(1)) === pathKey(where.below);
}

/**
 * Selects element `id` (none when undefined) on the level `where`: right
 * away when it is drawn, else once the host has drawn it (from wherever the
 * view is: another process, a service, a sub-process).
 */
function goTo(where: ShowLevelMessage, id: string | undefined, fromSearch: boolean): void {
  if (!current) return;
  const reveal: PendingReveal = { id, where, fromSearch };
  if (isShown(where)) {
    finishReveal(reveal);
    return;
  }
  pendingReveal = reveal;
  setControlsEnabled(false);
  vscode.postMessage(where);
}

/**
 * A row of the Search tab was clicked: go where the match is. In a process
 * of the file: that process (picked), the sub-process level around the
 * element, the element. In a service: its diagram where the index says it
 * is drawn (below the first activity of a process that calls it, else on
 * its own); a service without a diagram selects its caller. A business
 * object: the Data tab.
 */
function revealSearchResult(object: SearchObject, target: SearchTarget, dataField?: string): void {
  if (!current) return;
  if (target.type === 'dataType') {
    panel.showType(target.name, dataField);
    return;
  }
  const level = object.level;
  if (!level) {
    const caller = object.calledBy?.[0];
    if (caller) showCaller(caller);
    return;
  }
  const levels = target.type === 'root' ? [] : target.levels;
  goTo(showLevel(level, levels), target.type === 'root' ? undefined : target.id, true);
}

/** "Show caller": the activity of a process, or the step of a service, that calls a service. */
function showCaller(caller: SearchCaller): void {
  goTo(showLevel(caller.level), caller.nodeId, true);
}

/** The showLevel message of a level, with `more` levels below it. */
function showLevel(level: SearchLevel, more: string[] = []): ShowLevelMessage {
  const below = [...level.below, ...more];
  return level.serviceId !== undefined ? { type: 'showLevel', serviceId: level.serviceId, below } : { type: 'showLevel', processId: level.processId!, below };
}

// ---- Search -------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Id of the latest search sent to the host; only its answer is shown. */
let searchRequest = 0;
/** The latest search was typed: its answer brings the Search tab to the front. */
let searchWasTyped = false;

/**
 * Sends the text in the search box to the host, which searches the open
 * file and answers with a searchResult. `typed`: the user changed the query,
 * which brings the Search tab to the front once there is something to search.
 */
function runSearch(typed: boolean): void {
  if (!current) return;
  const query = searchInput.value;
  if (query.trim() === '') {
    // A cleared box: no answer to wait for.
    searchRequest++;
    panel.setSearch(undefined);
    return;
  }
  // One character does not start a search; it only updates one that is on.
  if (query.trim().length < 2 && !panel.searching) return;
  searchWasTyped = typed;
  vscode.postMessage({ type: 'search', requestId: ++searchRequest, query: query.slice(0, 500), scope: panel.searchScope });
}

/** The host's answer to a search; an answer to an older request is dropped. */
function showSearchResult(requestId: number, result: SearchResult): void {
  if (requestId !== searchRequest || !current || searchInput.value.trim() === '') return;
  panel.setSearch(result);
  if (searchWasTyped && !result.tooShort && panel.activeTab !== 'search') panel.showTab('search');
}

function searchTyped(): void {
  state.search = searchInput.value;
  vscode.setState(state);
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    runSearch(true);
  }, SEARCH_DEBOUNCE_MS);
}

function clearSearch(): void {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = undefined;
  searchInput.value = '';
  state.search = '';
  vscode.setState(state);
  runSearch(false);
}

searchInput.addEventListener('input', searchTyped);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Escape here clears the search only; it does not go up a level.
    e.preventDefault();
    e.stopPropagation();
    if (searchInput.value !== '') clearSearch();
    else searchInput.blur();
  } else if (e.key === 'ArrowDown') {
    // The results of what is typed now, not of the last debounced query.
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
      runSearch(true);
    }
    if (panel.focusFirstSearchResult()) e.preventDefault();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
    runSearch(true);
  }
});
// The clear button of a search field.
searchInput.addEventListener('search', () => {
  if (searchInput.value === '') clearSearch();
});
document.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      searchInput.focus();
      searchInput.select();
    }
  },
  true,
);

/**
 * A row of the Trace tab was clicked. Its element belongs to the chosen
 * process, maybe inside sub-processes: draw that level first (from wherever
 * the view is), then select it as a Changes row does.
 */
function revealTraceTarget(target: Extract<TraceTarget, { type: 'node' | 'flow' }>): void {
  if (!current) return;
  goTo({ type: 'showLevel', processId: current.rootProcessId, below: target.subProcessLevels }, target.id, false);
}

/** The Trace button: a badge of the missing items (as the tab counts them), the description in its tooltip. */
function showTraceState(msg: RenderMessage): void {
  const trace = msg.trace;
  const title = traceTabTitle(trace);
  const missing = /\((\d+)\)$/.exec(title)?.[1];
  traceBadge.textContent = missing ?? '';
  traceBadge.hidden = missing === undefined;
  traceButton.title = trace ? `Show the check against ${trace.fileName}${missing ? ` (${missing} missing)` : ''}` : TRACE_IDLE_TOOLTIP;
  traceButton.setAttribute('aria-label', traceButton.title);
  traceClearItem.disabled = trace === undefined;
}

function showError(msg: ErrorMessage): void {
  current = undefined;
  setControlsEnabled(false);
  clear(overlay);
  overlay.append(
    h('div', { class: 'error' }, h('h2', {}, msg.title), h('p', {}, msg.message)),
  );
  overlay.hidden = false;
}

function showBanner(msg: RefreshErrorMessage): void {
  // Without a diagram there is nothing to keep: use the full error screen.
  if (!current) {
    showError({ type: 'error', title: msg.title, message: msg.message });
    return;
  }
  bannerTitle.textContent = msg.title;
  bannerText.textContent = msg.message;
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

function showUpdated(loadedAt: number): void {
  const at = new Date(loadedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  updated.textContent = `Updated ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  updated.title = `Last read from disk: ${at.toLocaleString()}`;
  updated.hidden = false;
}

function showProcessChoices(msg: RenderMessage): void {
  const many = msg.processes.length > 1;
  processSelect.hidden = !many;
  // With a selector the title would repeat the selected name.
  title.hidden = many;
  clear(processSelect);
  if (!many) return;
  // A service shown on its own is not a process of the picker: it is named on top; picking a process leaves it.
  if (msg.serviceRoot) {
    const option = h('option', { value: '', disabled: '' }, `Service: ${msg.path[0].name}`);
    option.selected = true;
    processSelect.append(option);
  }
  for (const p of msg.processes) {
    const option = h('option', { value: p.id }, p.name);
    option.selected = !msg.serviceRoot && p.id === msg.rootProcessId;
    processSelect.append(option);
  }
  processSelect.title = `Process to show (${msg.processes.length} in ${msg.process.sourceFile})`;
}

function setControlsEnabled(enabled: boolean): void {
  for (const control of [fitButton, zoomInButton, zoomOutButton, labelsToggle.input, lanesToggle.input, highlightToggle.input, compareButton, traceButton, traceArrow, processSelect, backButton]) {
    control.disabled = !enabled;
  }
  // Export works on the drawn diagram only (not on the error screen), one image at a time.
  exportButton.disabled = !enabled || exporting;
  if (exportButton.disabled) exportMenu.close(false);
  if (!enabled) traceMenu.close(false);
  for (const crumb of crumbList.querySelectorAll('button')) crumb.disabled = !enabled;
}

// ---- Navigation ---------------------------------------------------------

/** Level ids of the shown path, the chosen process first. */
function currentPath(): string[] {
  return current ? current.path.map((l) => l.id) : [];
}

/** Opens a called service or linked process one level below the shown one. */
function openCallee(calleeId: string): void {
  if (!current) return;
  setControlsEnabled(false);
  vscode.postMessage({ type: 'openCallee', calleeId, path: currentPath() });
}

/** Back to the level at `index` of the path (0 is the chosen process). */
function goToLevel(index: number): void {
  const path = currentPath();
  if (index < 0 || index >= path.length - 1) return;
  setControlsEnabled(false);
  // Opening a level from the one above it: the host draws it, the saved view comes back here.
  vscode.postMessage({ type: 'openCallee', calleeId: path[index], path: path.slice(0, index) });
}

function goBack(): void {
  if (currentPath().length < 2 && current?.serviceRoot) leaveServiceRoot();
  else goToLevel(currentPath().length - 2);
}

/** From a service shown on its own back to the chosen process. */
function leaveServiceRoot(): void {
  if (!current) return;
  setControlsEnabled(false);
  vscode.postMessage({ type: 'selectProcess', processId: current.rootProcessId });
}

/** True when there is a level to go back to: one above, or the chosen process above a service shown on its own. */
function canGoBack(): boolean {
  return currentPath().length > 1 || current?.serviceRoot === true;
}

function showCrumbs(msg: RenderMessage): void {
  const serviceRoot = msg.serviceRoot === true;
  crumbs.hidden = msg.path.length < 2 && !msg.note && !serviceRoot;
  backButton.hidden = msg.path.length < 2 && !serviceRoot;
  clear(crumbList);
  if (serviceRoot) {
    // "<file> › Service: X": the file leads back to the chosen process.
    const file = h('button', { class: 'link', type: 'button', title: 'Back to the chosen process' }, msg.process.sourceFile);
    file.addEventListener('click', leaveServiceRoot);
    crumbList.append(h('li', {}, file));
  }
  msg.path.forEach((level, index) => {
    const last = index === msg.path.length - 1;
    const tooltip = `${level.kind}: ${level.name}`;
    const text = serviceRoot && index === 0 ? `Service: ${level.name}` : level.name;
    if (last) {
      crumbList.append(h('li', { 'aria-current': 'page', title: tooltip }, text));
      return;
    }
    const link = h('button', { class: 'link', type: 'button', title: `Back to ${tooltip}` }, text);
    link.addEventListener('click', () => goToLevel(index));
    crumbList.append(h('li', {}, link));
  });
  crumbNote.textContent = msg.note ?? '';
  crumbNote.hidden = !msg.note;
}

// ---- Controls -----------------------------------------------------------

function zoomBy(factor: number): void {
  const c = canvas();
  const box = c.viewbox();
  c.zoom(Math.min(4, Math.max(0.2, box.scale * factor)), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
}

fitButton.addEventListener('click', () => canvas().zoom('fit-viewport'));
zoomInButton.addEventListener('click', () => zoomBy(1.2));
zoomOutButton.addEventListener('click', () => zoomBy(1 / 1.2));

function sendOptions(): void {
  const options: ViewOptions = {
    hideGeneratedFlowLabels: labelsToggle.input.checked,
    hideEmptyLanes: !lanesToggle.input.checked,
    highlightChanges: highlightToggle.input.checked,
  };
  setControlsEnabled(false);
  vscode.postMessage({ type: 'setOptions', options });
}
labelsToggle.input.addEventListener('change', sendOptions);
processSelect.addEventListener('change', () => {
  setControlsEnabled(false);
  vscode.postMessage({ type: 'selectProcess', processId: processSelect.value });
});
lanesToggle.input.addEventListener('change', sendOptions);
highlightToggle.input.addEventListener('change', sendOptions);
compareButton.addEventListener('click', () => vscode.postMessage({ type: 'compareRequest' }));

canvasHost.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  else if (e.key === '-') zoomBy(1 / 1.2);
  else if (e.key === '0') canvas().zoom('fit-viewport');
  else return;
  e.preventDefault();
});

// Escape goes up one level (wherever the focus is, except in the picker); on the chosen
// process it clears the selection.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !current || e.target instanceof HTMLSelectElement) return;
  if (exportMenu.isOpen) {
    exportMenu.close(true);
  } else if (traceMenu.isOpen) {
    traceMenu.close(true);
  } else if (canGoBack()) {
    if (!backButton.disabled) goBack();
  } else {
    viewer.get<Selection>('selection').select(null);
    panel.select(undefined);
  }
  e.preventDefault();
});

new ResizeObserver(() => {
  if (current) canvas().resized();
}).observe(canvasHost);

// Redraw with the new colours when the VS Code theme changes.
new MutationObserver(() => {
  const last = current;
  viewer.destroy();
  viewer = createViewer();
  if (last) void render({ ...last, preserveView: false });
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---- Export -------------------------------------------------------------

/** True while an image is drawn for the host. */
let exporting = false;

/** Draws the export BPMN the host sent as an image and sends it back. */
async function exportImage(msg: ExportSourceMessage): Promise<void> {
  exporting = true;
  exportButton.disabled = true;
  try {
    const svg = await renderExportSvg(msg.xml);
    const data = msg.format === 'svg' ? svg : await renderExportPng(svg);
    vscode.postMessage({ type: 'exportData', requestId: msg.requestId, format: msg.format, data });
  } catch (err) {
    showBanner({
      type: 'refreshError',
      title: 'Cannot export the diagram',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    exporting = false;
    exportButton.disabled = !current;
  }
}

// ---- Host messages ------------------------------------------------------

const watchdog = startLoadWatchdog(() => {
  if (current) return;
  showError({
    type: 'error',
    title: 'The diagram did not load',
    message: `No answer from the extension after ${LOAD_TIMEOUT_MS / 1000} seconds. Close the editor and open the file again.`,
  });
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (msg?.type === 'render') {
    watchdog.answered();
    void render(msg);
    // The label of the Trace menu's description item, ready before the menu opens.
    vscode.postMessage({ type: 'descriptionStatus' });
  } else if (msg?.type === 'error') {
    watchdog.answered();
    hideBanner();
    showError(msg);
  } else if (msg?.type === 'refreshError') {
    watchdog.answered();
    showBanner(msg);
  } else if (msg?.type === 'descriptionStatus' && typeof msg.exists === 'boolean') {
    showDescriptionStatus(msg);
  } else if (msg?.type === 'searchResult' && typeof msg.requestId === 'number') {
    showSearchResult(msg.requestId, msg.result);
  } else if (msg?.type === 'exportSource' && (msg.format === 'svg' || msg.format === 'png')) {
    void exportImage(msg);
  }
});

setControlsEnabled(false);
// Tell the host we are listening; it posts the first render only after this.
vscode.postMessage({ type: 'ready' });

// ---- Helpers ------------------------------------------------------------

function button(text: string, tooltip: string): HTMLButtonElement {
  return h('button', { type: 'button', class: 'button', title: tooltip, 'aria-label': tooltip }, text);
}

function toggle(text: string, tooltip: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox' });
  const label = h('label', { class: 'toggle', title: tooltip }, input, text);
  return { label, input };
}
