// Webview entry point: a toolbar, the bpmn-js NavigatedViewer and the side panel.
// Runs in the browser sandbox under a strict CSP: no network requests, and
// all text from the model is set with textContent.

import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import './main.css';

import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { isPathPrefix, pathKey } from '../src/views/navigation';
import type {
  ErrorMessage,
  ExportFormat,
  ExportSourceMessage,
  HostMessage,
  RefreshErrorMessage,
  RenderMessage,
  ViewOptions,
  WebviewMessage,
} from '../src/views/protocol';
import { clear, h } from './dom';
import { renderExportPng, renderExportSvg } from './exportImage';
import { LOAD_TIMEOUT_MS, startLoadWatchdog } from './loadWatchdog';
import { isTabId, SidePanel, type TabId } from './panel';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  tab?: TabId;
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
}

interface Canvas {
  zoom(level?: number | 'fit-viewport', center?: { x: number; y: number }): number;
  viewbox(box?: Viewbox): Viewbox & { scale: number };
  resized(): void;
  addMarker(element: DiagramElement, marker: string): void;
  scrollToElement(element: DiagramElement, padding?: number): void;
}

interface ElementRegistry {
  get(id: string): DiagramElement | undefined;
}

interface Selection {
  select(element: DiagramElement | null): void;
}

interface EventBus {
  on(event: string, callback: (e: { element?: { id: string; type: string } }) => void): void;
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
exportButton.setAttribute('aria-haspopup', 'menu');
exportButton.setAttribute('aria-expanded', 'false');
const EXPORT_ITEMS: Array<{ format: ExportFormat; text: string; tooltip?: string }> = [
  { format: 'bpmn', text: 'BPMN with layout, no scripts (.bpmn)', tooltip: 'Diagram and layout only. Script code is never exported.' },
  { format: 'svg', text: 'SVG image (.svg)' },
  { format: 'png', text: 'PNG image (.png)' },
];
const exportItems = EXPORT_ITEMS.map(({ format, text, tooltip }) => {
  const item = h('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabindex: '-1', ...(tooltip ? { title: tooltip } : {}) }, text);
  item.addEventListener('click', () => {
    closeExportMenu(true);
    vscode.postMessage({ type: 'exportRequest', format });
  });
  return item;
});
const exportMenu = h('div', { class: 'menu', role: 'menu', 'aria-label': 'Export as', hidden: '' }, ...exportItems);
const exportGroup = h('span', { class: 'menu-anchor' }, exportButton, exportMenu);

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
  },
  // A hidden webview is rebuilt when its editor tab is shown again: start on
  // the tab it had (the state is per editor tab), else on Details.
  isTabId(state.tab) ? state.tab : 'details',
);

const root = document.getElementById('root')!;
root.append(toolbar, crumbs, banner, h('div', { class: 'main' }, stage, panel.element));

// ---- Viewer -------------------------------------------------------------

let viewer = createViewer();
let current: RenderMessage | undefined;
/** Increases with every import; results of older imports are dropped. */
let importGeneration = 0;
/** The view and selection of each level above the shown one, by path key. */
const levelStates = new Map<string, LevelState>();

function createViewer(): NavigatedViewer {
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const v = new NavigatedViewer({
    container: canvasHost,
    keyboard: { bind: false },
    bpmnRenderer: {
      defaultFillColor: color('--vscode-editor-background', '#ffffff'),
      defaultStrokeColor: color('--vscode-editor-foreground', '#000000'),
      defaultLabelColor: color('--vscode-editor-foreground', '#000000'),
    },
  });
  const eventBus = v.get<EventBus>('eventBus');
  eventBus.on('element.click', (e) => {
    const el = e.element;
    // Clicking the pool or empty canvas shows the process details.
    panel.select(el && el.type !== 'bpmn:Participant' && el.type !== 'bpmn:Process' ? el.id : undefined);
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
    // On the same level the selected element is kept while its id exists; another level starts
    // with the selection it had when it was left, or none.
    panel.setData(msg, importWarnings, sameLevel ? undefined : { id: restored?.selection });
    // A file was just picked with Compare…: show what it changed (kept like any tab choice).
    if (msg.showChanges === true) panel.showTab('changes');
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
 * A row of the Changes tab was clicked: select the element (as a click on it
 * does), scroll it into view at the current zoom, and show its details.
 */
function revealElement(id: string): void {
  if (!current) return;
  const registry = viewer.get<ElementRegistry>('elementRegistry');
  // Not drawn at this level (inside a collapsed sub-process): the sub-process that holds it.
  const shownId = [id, ...(current.diff?.enclosing?.[id] ?? [])].find((x) => registry.get(x) !== undefined);
  if (shownId === undefined) return;
  const element = registry.get(shownId)!;
  viewer.get<Selection>('selection').select(element);
  // Scrolls only when the element is (partly) out of view; the zoom stays.
  canvas().scrollToElement(element, 80);
  panel.select(shownId);
  panel.showTab('details');
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
  for (const p of msg.processes) {
    const option = h('option', { value: p.id }, p.name);
    option.selected = p.id === msg.rootProcessId;
    processSelect.append(option);
  }
  processSelect.title = `Process to show (${msg.processes.length} in ${msg.process.sourceFile})`;
}

function setControlsEnabled(enabled: boolean): void {
  for (const control of [fitButton, zoomInButton, zoomOutButton, labelsToggle.input, lanesToggle.input, highlightToggle.input, compareButton, processSelect, backButton]) {
    control.disabled = !enabled;
  }
  // Export works on the drawn diagram only (not on the error screen), one image at a time.
  exportButton.disabled = !enabled || exporting;
  if (exportButton.disabled) closeExportMenu(false);
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
  goToLevel(currentPath().length - 2);
}

function showCrumbs(msg: RenderMessage): void {
  crumbs.hidden = msg.path.length < 2 && !msg.note;
  backButton.hidden = msg.path.length < 2;
  clear(crumbList);
  msg.path.forEach((level, index) => {
    const last = index === msg.path.length - 1;
    const tooltip = `${level.kind}: ${level.name}`;
    if (last) {
      crumbList.append(h('li', { 'aria-current': 'page', title: tooltip }, level.name));
      return;
    }
    const link = h('button', { class: 'link', type: 'button', title: `Back to ${tooltip}` }, level.name);
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
  if (!exportMenu.hidden) {
    closeExportMenu(true);
  } else if (currentPath().length > 1) {
    if (!backButton.disabled) goBack();
  } else {
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

function openExportMenu(): void {
  if (exportButton.disabled) return;
  exportMenu.hidden = false;
  exportButton.setAttribute('aria-expanded', 'true');
  exportItems[0].focus();
}

function closeExportMenu(focusButton: boolean): void {
  if (exportMenu.hidden) return;
  exportMenu.hidden = true;
  exportButton.setAttribute('aria-expanded', 'false');
  if (focusButton) exportButton.focus();
}

exportButton.addEventListener('click', () => {
  if (exportMenu.hidden) openExportMenu();
  else closeExportMenu(false);
});
exportButton.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown') return;
  e.preventDefault();
  openExportMenu();
});
exportMenu.addEventListener('keydown', (e) => {
  const index = exportItems.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    closeExportMenu(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const step = e.key === 'ArrowDown' ? 1 : -1;
    exportItems[(index + step + exportItems.length) % exportItems.length].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    exportItems[e.key === 'Home' ? 0 : exportItems.length - 1].focus();
  } else if (e.key === 'Tab') {
    closeExportMenu(false);
    return;
  } else {
    return;
  }
  // Escape here closes the menu only; it does not go up a level.
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener('pointerdown', (e) => {
  if (!exportGroup.contains(e.target as Node)) closeExportMenu(false);
});

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
  } else if (msg?.type === 'error') {
    watchdog.answered();
    hideBanner();
    showError(msg);
  } else if (msg?.type === 'refreshError') {
    watchdog.answered();
    showBanner(msg);
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
