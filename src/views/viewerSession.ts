// Host side of one open viewer: loads the package, builds render or error
// messages and delivers them to the webview. Free of the vscode module (the
// provider passes in how to load the package, how to post a message and
// reports file changes) so it is unit-testable.
//
// Delivery handshake: a message posted to a webview before its script is
// listening is lost. So nothing is posted until the webview sends "ready".
// Loading starts right away (start()), and the result is posted as soon as
// both the result and the "ready" message are there, in either order. When
// the webview reloads and sends "ready" again, the current state is re-sent.
//
// Live refresh: fileChanged() re-reads the package after a quiet period
// (debounce). At most one such read runs at a time: changes that come in
// while it runs give one more read after it, however many there are. If that fails while a good diagram is shown, the diagram stays
// and the failure is sent as a "refreshError" banner; the next good read
// replaces it with a normal render.
//
// Process choice: a package can hold several processes (a TWX holds one per
// BPD). The chosen one is kept across toggles and reloads while its id
// exists; otherwise the first process is shown.
//
// Display options: the toolbar toggles. Until the user changes one, the
// first package read sets them by its format (defaultViewOptions); after that
// they are kept across reloads, process switches and navigation.
//
// Settings: extension settings (showScripts) are passed in and updated with
// updateSettings(); a change re-renders the open view, keeping the zoom.
//
// Drill-down: "openCallee" opens a called service or linked process as a
// diagram one level below the shown one (./navigation). Service diagrams are
// read on first open, not with the package, and cached with it. The path
// below the chosen process is kept across toggles and settings; a reload
// resolves it again and stays at the deepest level that still exists. Picking
// another process in the picker starts a new path.
//
// Export: exportBpmn() lays out the drawn level again with every flow name
// and lane kept (the toolbar toggles do not apply) and never with script
// text. A BPMN export is written by the host right away; for an SVG or PNG
// the host sends that XML to the webview (exportSource) and accepts the
// image back (exportData) only for the request id it gave out last. Where to
// write is asked (ExportHost) before anything is drawn.
//
// Comparison: every render of a process carries its comparison (src/diff)
// with a base version. The base is a file the user picked (requestCompare;
// read once through CompareHost, never watched, never written), else the
// package that was shown before the latest reload ("previous version"). A
// picked file stays the base across reloads until clearComparison(); the
// previous version moves on with every reload that reads a package that
// differs from the shown one (by the comparison of the chosen process and
// the business objects, not by file bytes): a reload with the same content
// (a touch, Bob writing the same process again) keeps the base, so the
// changes stay on screen.
// The comparison covers processes only: a drawn service diagram or linked
// process gets a note instead.

import * as path from 'node:path';
import { diffProcess, matchProcess } from '../diff/diff';
import { toDiagramXml } from '../bpmn/toDiagramXml';
import { BPMN_EXPORT_COMMENT } from './exportFiles';
import type { Process, ProcessPackage } from '../model/model';
import { MAX_PATH_DEPTH, openInPath, resolvePath } from './navigation';
import {
  DEFAULT_VIEW_OPTIONS,
  DEFAULT_VIEWER_SETTINGS,
  defaultViewOptions,
  parseWebviewMessage,
  type DiffView,
  type ErrorMessage,
  type ExpectedExport,
  type ExportFormat,
  type HostMessage,
  type LevelSummary,
  type OpenCalleeMessage,
  type RenderMessage,
  type ViewerSettings,
  type ViewOptions,
} from './protocol';
import { buildErrorMessage, buildRenderMessage, levelSummary, processLevelId, type LevelView } from './viewModel';

export const REFRESH_DEBOUNCE_MS = 300;

/** setTimeout/clearTimeout, injectable so tests control time. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ViewerSessionDeps {
  /** File name shown in error messages. */
  fileName: string;
  /** Reads the package from disk. Called once, then again for every reload. */
  load: () => Promise<ProcessPackage>;
  post: (message: HostMessage) => unknown;
  /** Quiet period before a file change triggers a reload. */
  debounceMs?: number;
  timers?: Timers;
  /** Current time in epoch milliseconds. */
  now?: () => number;
  /** Extension settings at the time the viewer opens. */
  settings?: ViewerSettings;
  /** Asks where to save an export and writes it; without it nothing is exported. */
  exporter?: ExportHost;
  /** Asks for a file to compare with and reads it; without it only the previous version is compared. */
  comparer?: CompareHost;
}

/** The editor side of Compare… (open dialog, read-only load, messages). */
export interface CompareHost {
  /** Asks for the file to compare with; its path, or undefined when cancelled. */
  chooseBase(): Promise<string | undefined>;
  /** Reads the package of that file, with the same reader and limits as the opened file. Never writes. */
  loadBase(filePath: string): Promise<ProcessPackage>;
  /** The base could not be read; the viewer is left as it is. */
  failed(message: string): void;
}

/** What an export is about: its format, and the drawn level's name when it is below the chosen process. */
export interface ExportRequest {
  format: ExportFormat;
  levelName?: string;
}

/** The editor side of an export (save dialog, file write, messages). */
export interface ExportHost {
  /** Asks where to save; a checked path of a new file, or undefined when cancelled or refused. */
  chooseTarget(request: ExportRequest): Promise<string | undefined>;
  /** Writes the export to the path chooseTarget gave. */
  write(target: string, format: ExportFormat, bytes: Uint8Array): Promise<void>;
  /** The export failed; the viewer is left as it is. */
  failed(message: string): void;
}

/** The drawn level as BPMN with diagram interchange, ready to be exported. */
export interface BpmnExport {
  xml: string;
  /** Name of the drawn level, only when it is below the chosen process. */
  levelName?: string;
}

/** Exports keep every flow name and every lane, whatever the toolbar shows. */
const EXPORT_DIAGRAM_OPTIONS = { hideGeneratedFlowLabels: false, hideEmptyLanes: false } as const;

/** A BPMN script element (bpmn:script), which an export must never hold. */
const SCRIPT_ELEMENT = /<(?:[\w.-]+:)?script[\s/>]/;

interface Loaded {
  pkg: ProcessPackage;
  loadedAt: number;
}

/** A version to compare with, and what the Changes tab calls it. */
interface Base {
  kind: 'file' | 'previous';
  loaded: Loaded;
  /** File name. */
  label: string;
}

/** Shown in the Changes tab while a service diagram or linked process is drawn. */
export const PROCESSES_ONLY_NOTE = 'Comparison covers processes only.';

type RunMode = 'initial' | 'options' | 'settings' | 'select' | 'navigate' | 'reload' | 'compare';

interface Built {
  loaded: Loaded;
  render: RenderMessage;
  /** Level ids below the chosen process, as drawn. */
  below: string[];
  /** The previous version once this render is shown. */
  previous: Loaded | undefined;
}

/** A level that resolved: its diagram and the problems reading it. */
interface Level {
  process: Process;
  warnings: string[];
}

export class ViewerSession {
  /** Toolbar options; undefined until the user sets them or the first package is read. */
  private options: ViewOptions | undefined;
  private settings: ViewerSettings;
  /** Id of the process the user picked; undefined shows the first. */
  private processId: string | undefined;
  /** Level ids of the open levels below the chosen process; empty shows the process itself. */
  private below: string[] = [];
  /** Read of the file the next render uses; cleared to force a re-read. */
  private loaded: Promise<Loaded> | undefined;
  /** Last package that produced a diagram, and that diagram. */
  private good: Built | undefined;
  /** The file picked with Compare…, while it is the base. */
  private fileBase: Base | undefined;
  /** The package shown before the one in `good`, when a reload brought a new one. */
  private previous: Loaded | undefined;
  /** Why the latest read or build failed; undefined after a good one. */
  private failure: ErrorMessage | undefined;
  /** Increases with every render request; older results are dropped. */
  private generation = 0;
  /** Render in progress for the latest request, if any. */
  private pending: Promise<void> | undefined;
  /** True once the webview has said it is listening. */
  private webviewReady = false;
  private refreshTimer: unknown;
  /** The reload fileChanged() started, while it runs. */
  private refreshing: Promise<void> | undefined;
  /** A change came in while `refreshing` ran: read once more after it. */
  private refreshAgain = false;
  private disposed = false;
  /** The image export the webview is drawing, and where it goes. */
  private expectedExport: (ExpectedExport & { target: string }) | undefined;
  private exportCounter = 0;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: ViewerSessionDeps) {
    this.timers = deps.timers ?? GLOBAL_TIMERS;
    this.debounceMs = deps.debounceMs ?? REFRESH_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
    this.settings = { ...(deps.settings ?? DEFAULT_VIEWER_SETTINGS) };
  }

  get currentOptions(): ViewOptions {
    return { ...(this.options ?? DEFAULT_VIEW_OPTIONS) };
  }

  get currentProcessId(): string | undefined {
    return this.processId;
  }

  /** Level ids of the drawn path, the chosen process first. */
  get currentPath(): string[] {
    return this.good ? this.good.render.path.map((l) => l.id) : [];
  }

  /** Resolves when the latest render request has finished. */
  get idle(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  /**
   * Starts loading and laying out the package before the webview is ready.
   * Safe to call more than once; resolves when the first render is built.
   */
  start(): Promise<void> {
    if (!this.pending && !this.good && !this.failure) this.pending = this.run('initial');
    return this.idle;
  }

  /** The opened file (or a file it depends on) changed, was created or deleted. */
  fileChanged(): void {
    if (this.disposed) return;
    if (this.refreshTimer !== undefined) this.timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, this.debounceMs);
  }

  /** A debounced reload; never more than one at a time, so slow reads do not pile up. */
  private refresh(): void {
    if (this.disposed) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = this.reload().finally(() => {
      this.refreshing = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refresh();
      }
    });
  }

  /** Re-reads the file now and posts the result. */
  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = this.run('reload');
    return this.pending;
  }

  /** The extension settings changed: re-render the open view when they differ. */
  updateSettings(settings: ViewerSettings): Promise<void> {
    if (this.disposed || settings.showScripts === this.settings.showScripts) return this.idle;
    this.settings = { ...settings };
    // Nothing shown yet: the render in progress (or the first one) uses the new settings.
    if (!this.good && !this.failure) return this.idle;
    this.pending = this.run('settings');
    return this.pending;
  }

  /** The editor closed: stop pending reloads and never post again. */
  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) this.timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Handles one raw message from the webview. Unknown messages are ignored. */
  async handleMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw, this.expectedExport);
    if (!msg || this.disposed) return;
    if (msg.type === 'ready') {
      this.webviewReady = true;
      this.resendState();
      // If nothing was there yet, the render in progress posts when done.
      await this.start();
    } else if (msg.type === 'selectProcess') {
      this.processId = msg.processId;
      this.below = [];
      this.pending = this.run('select');
      await this.pending;
    } else if (msg.type === 'openCallee') {
      this.pending = this.run('navigate', msg);
      await this.pending;
    } else if (msg.type === 'setOptions') {
      this.options = { ...msg.options };
      this.pending = this.run('options');
      await this.pending;
    } else if (msg.type === 'exportRequest') {
      await this.requestExport(msg.format);
    } else if (msg.type === 'compareRequest') {
      await this.requestCompare();
    } else if (msg.type === 'clearComparison') {
      await this.clearComparison();
    } else {
      const expected = this.expectedExport!;
      this.expectedExport = undefined;
      await this.writeExport(expected.target, expected.format, msg.bytes);
    }
  }

  /** True while a file picked with Compare… is the base. */
  get comparingWithFile(): boolean {
    return this.fileBase !== undefined;
  }

  /**
   * Compare…: asks for a file, reads it and makes it the base. False when
   * there is nothing to compare (no diagram drawn, or no comparer). A file
   * that cannot be read is reported; the view stays as it is.
   */
  async requestCompare(): Promise<boolean> {
    const comparer = this.deps.comparer;
    if (this.disposed || !this.good || !comparer) return false;
    const picked = await comparer.chooseBase();
    if (picked === undefined || this.disposed) return true;
    const label = path.basename(picked);
    let pkg: ProcessPackage;
    try {
      pkg = await comparer.loadBase(picked);
    } catch (err) {
      comparer.failed(`Cannot compare with ${label}: ${errorText(err)}`);
      return true;
    }
    if (this.disposed) return true;
    this.fileBase = { kind: 'file', loaded: { pkg, loadedAt: this.now() }, label };
    this.pending = this.run('compare');
    await this.pending;
    return true;
  }

  /** Stops comparing with the picked file: the previous version is the base again. */
  clearComparison(): Promise<void> {
    if (this.disposed || !this.fileBase) return this.idle;
    this.fileBase = undefined;
    this.pending = this.run('compare');
    return this.pending;
  }

  /**
   * Exports the drawn level: asks where, then writes the BPMN, or has the
   * webview draw the image. False when there is nothing to export (no
   * diagram drawn, or no exporter).
   */
  async requestExport(format: ExportFormat): Promise<boolean> {
    const exporter = this.deps.exporter;
    if (this.disposed || !this.good || !exporter) return false;
    let bpmn: BpmnExport;
    try {
      bpmn = await this.exportBpmn();
    } catch (err) {
      exporter.failed(`Cannot export the diagram: ${errorText(err)}`);
      return true;
    }
    const target = await exporter.chooseTarget({ format, ...(bpmn.levelName !== undefined ? { levelName: bpmn.levelName } : {}) });
    if (target === undefined || this.disposed) return true;
    if (format === 'bpmn') {
      await this.writeExport(target, format, new TextEncoder().encode(bpmn.xml));
      return true;
    }
    // A newer request replaces an older one: data for the older id is refused.
    const requestId = `export-${++this.exportCounter}`;
    this.expectedExport = { requestId, format, target };
    this.post({ type: 'exportSource', requestId, format, xml: bpmn.xml });
    return true;
  }

  /**
   * The drawn level as BPMN with its layout: the same process the viewer
   * shows (chosen process and opened levels), laid out with every flow name
   * and lane. Holds no script text.
   */
  async exportBpmn(): Promise<BpmnExport> {
    const good = this.good;
    if (!good) throw new Error('There is no diagram to export.');
    const pkg = good.loaded.pkg;
    const root = pkg.processes.find((p) => p.id === good.render.rootProcessId);
    if (!root) throw new Error('The shown process is no longer in the file.');
    const resolved = await resolvePath<Level>([processLevelId(root), ...good.below], (id, depth) =>
      depth === 0 ? { process: root, warnings: [] } : this.level(pkg, id),
    );
    if (resolved.missing !== undefined) throw new Error('The shown diagram is no longer in the file.');
    const process = resolved.levels[resolved.levels.length - 1].value.process;
    const { xml } = await toDiagramXml(process, EXPORT_DIAGRAM_OPTIONS);
    // toDiagramXml writes no script; this keeps it that way.
    if (SCRIPT_ELEMENT.test(xml)) throw new Error('The export would contain script text.');
    return { xml: withExportComment(xml), ...(good.below.length > 0 ? { levelName: process.name || process.id } : {}) };
  }

  private async writeExport(target: string, format: ExportFormat, bytes: Uint8Array): Promise<void> {
    const exporter = this.deps.exporter;
    if (!exporter || this.disposed) return;
    try {
      await exporter.write(target, format, bytes);
    } catch (err) {
      exporter.failed(`Cannot export the diagram: ${errorText(err)}`);
    }
  }

  /** A (re)loaded webview has nothing: send what it should show now. */
  private resendState(): void {
    if (this.good) {
      // A fresh webview has no view to keep: fit the diagram.
      this.post({ ...this.good.render, preserveView: false });
      if (this.failure) this.post(this.banner(this.failure));
    } else if (this.failure) {
      this.post(this.failure);
    }
  }

  private async run(mode: RunMode, open?: OpenCalleeMessage): Promise<void> {
    const generation = ++this.generation;
    if (mode === 'reload') this.loaded = undefined;
    // A toggle, a settings change, a new base, a process switch or a navigation while the file is broken redraws the last good package.
    const redraw = mode === 'options' || mode === 'settings' || mode === 'compare';
    const fromGood = (redraw || mode === 'select' || mode === 'navigate') && this.failure !== undefined && this.good !== undefined;

    let result: Built | ErrorMessage;
    try {
      const loaded = fromGood ? this.good!.loaded : await (this.loaded ??= this.read());
      const options = (this.options ??= defaultViewOptions(loaded.pkg.source.format));
      const plan = await this.levels(loaded.pkg, open);
      const below = plan.levels.slice(1).map((l) => l.id);
      // A toggle keeps the zoom, and so does a reload that shows the same level; a new level is fitted
      // (the webview brings back the view of a level it showed before).
      const sameLevel = this.good !== undefined && sameIds(this.good.below, below) && this.good.render.rootProcessId === plan.root.id;
      const preserveView = redraw || (mode === 'reload' && sameLevel);
      const drawn = plan.levels[plan.levels.length - 1];
      const level: LevelView | undefined =
        plan.levels.length > 1 || plan.note
          ? {
              process: drawn.value.process,
              path: plan.levels.map((l) => levelSummary(l.value.process)),
              warnings: drawn.value.warnings,
              ...(plan.note ? { note: plan.note } : {}),
            }
          : undefined;
      const built = await buildRenderMessage(
        loaded.pkg,
        options,
        preserveView,
        loaded.loadedAt,
        plan.root.id,
        this.settings,
        level,
      );
      // A package that differs from the shown one: the shown one becomes the previous version.
      const previous = this.good && this.good.loaded !== loaded && this.differs(this.good.loaded, loaded, plan.root) ? this.good.loaded : this.previous;
      const diff = this.diffView(loaded, plan.root, drawn.value.process, plan.levels.length > 1, previous);
      const render: RenderMessage = diff ? { ...built, diff } : built;
      result = { loaded, render, below, previous };
    } catch (err) {
      result = buildErrorMessage(this.deps.fileName, err);
    }
    if (generation !== this.generation || this.disposed) return;
    this.pending = undefined;

    if ('render' in result) {
      this.previous = result.previous;
      this.good = result;
      this.below = result.below;
      if (!fromGood) this.failure = undefined;
      this.post(result.render);
      if (this.failure) this.post(this.banner(this.failure));
    } else {
      this.failure = result;
      // Keep the last good diagram on screen and report the failure above it.
      this.post(this.good ? this.banner(result) : result);
    }
  }

  /**
   * The levels to draw: the chosen process, then the open levels below it,
   * after `open` when given. Each level is resolved again; the path ends at
   * the deepest level that still exists, with a note when one is gone.
   */
  private async levels(
    pkg: ProcessPackage,
    open: OpenCalleeMessage | undefined,
  ): Promise<{ root: Process; levels: Array<{ id: string; value: Level }>; note?: string }> {
    const root = pkg.processes.find((p) => p.id === this.processId) ?? pkg.processes[0];
    if (!root) throw new Error('The BPMN file does not contain a process.');
    const rootId = processLevelId(root);
    // The chosen process is gone (the file changed): its levels are gone with it.
    const below = this.processId === undefined || root.id === this.processId ? this.below : [];
    let path = [rootId, ...below];
    let note: string | undefined;
    if (open) {
      const target = openInPath(open.path, open.calleeId);
      // A message about another chosen process is stale (the picker changed meanwhile): keep the path.
      if (target.path[0] === rootId) {
        path = target.path;
        if (target.kind === 'limit') note = `Cannot open more than ${MAX_PATH_DEPTH} levels.`;
      }
    }
    const jumped = open !== undefined && path[0] === rootId && openInPath(open.path, open.calleeId).kind === 'jump';

    const resolved = await resolvePath<Level>(path, (id, depth) =>
      depth === 0 ? { process: root, warnings: [] } : this.level(pkg, id),
    );
    if (jumped && resolved.missing === undefined) {
      const at = resolved.levels[resolved.levels.length - 1].value.process;
      note = `${at.name || at.id} is already open in this path`;
    }
    if (resolved.missing !== undefined) {
      const deepest = resolved.levels[resolved.levels.length - 1].value.process;
      const name = this.levelName(pkg, resolved.missing);
      note = open?.calleeId === resolved.missing
        ? `${name} cannot be opened`
        : `${name} is no longer in the file; showing ${deepest.name || deepest.id}`;
    }
    return { root, levels: resolved.levels, ...(note ? { note } : {}) };
  }

  /**
   * True when `loaded` differs from `shown` in the chosen process or the
   * business objects, as the comparison sees it (layout alone is no difference).
   */
  private differs(shown: Loaded, loaded: Loaded, root: Process): boolean {
    const before = matchProcess(shown.pkg, root, loaded.pkg);
    if (!before) return true;
    const d = diffProcess(before, root, shown.pkg.dataTypes, loaded.pkg.dataTypes);
    return d.counts.added + d.counts.removed + d.counts.changed > 0;
  }

  /**
   * The comparison of the chosen process with the base: the picked file, else
   * the previous version; undefined when there is neither.
   */
  private diffView(loaded: Loaded, root: Process, drawn: Process, below: boolean, previous: Loaded | undefined): DiffView | undefined {
    const base: Base | undefined =
      this.fileBase ?? (previous ? { kind: 'previous', loaded: previous, label: this.deps.fileName } : undefined);
    if (!base) return undefined;
    const empty: DiffView = {
      baseKind: base.kind,
      baseLabel: base.label,
      loadedAt: base.loaded.loadedAt,
      counts: { added: 0, removed: 0, changed: 0 },
      added: [],
      removed: [],
      changed: [],
      marks: {},
    };
    // Like the validation rules, the comparison is about processes, not service diagrams.
    if (below || (drawn.source?.kind ?? 'bpd') !== 'bpd') return { ...empty, note: PROCESSES_ONLY_NOTE };
    const baseProcess = matchProcess(base.loaded.pkg, root, loaded.pkg);
    if (!baseProcess) {
      const where = base.kind === 'file' ? `"${base.label}"` : 'the previous version';
      return { ...empty, note: `No process in ${where} matches "${root.name || root.id}".` };
    }
    const d = diffProcess(baseProcess, root, base.loaded.pkg.dataTypes, loaded.pkg.dataTypes);
    return { ...empty, counts: d.counts, added: d.added, removed: d.removed, changed: d.changed, marks: d.marks };
  }

  /** A level below the chosen process: a linked process of the package, or a service diagram. */
  private async level(pkg: ProcessPackage, id: string): Promise<Level | undefined> {
    const linked = pkg.processes.find((p) => processLevelId(p) === id);
    if (linked) return { process: linked, warnings: [] };
    const diagram = await pkg.calleeDiagrams?.read(id);
    return diagram ? { process: diagram.process, warnings: diagram.warnings } : undefined;
  }

  /** A name for a level id: from the levels drawn last, from the package, else the id. */
  private levelName(pkg: ProcessPackage, id: string): string {
    const shown: LevelSummary | undefined = this.good?.render.path.find((l) => l.id === id);
    if (shown) return shown.name;
    const process = pkg.processes.find((p) => processLevelId(p) === id);
    if (process) return process.name || id;
    return pkg.calleeDiagrams?.name(id) ?? id;
  }

  private read(): Promise<Loaded> {
    return this.deps.load().then((pkg) => ({ pkg, loadedAt: this.now() }));
  }

  private banner(error: ErrorMessage): HostMessage {
    return {
      type: 'refreshError',
      title: `Cannot reload ${this.deps.fileName}; showing the last good version`,
      message: error.message,
    };
  }

  private post(message: HostMessage): void {
    if (this.webviewReady && !this.disposed) this.deps.post(message);
  }
}

/** The XML with BPMN_EXPORT_COMMENT after its XML declaration (at the top when it has none). */
function withExportComment(xml: string): string {
  const declaration = /^<\?xml[^>]*\?>\r?\n?/.exec(xml);
  const end = declaration ? declaration[0].length : 0;
  const head = declaration ? `${declaration[0].trimEnd()}\n` : '';
  return `${head}${BPMN_EXPORT_COMMENT}\n${xml.slice(end)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}
