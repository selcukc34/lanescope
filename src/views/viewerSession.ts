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

import type { Process, ProcessPackage } from '../model/model';
import { MAX_PATH_DEPTH, openInPath, resolvePath } from './navigation';
import {
  DEFAULT_VIEW_OPTIONS,
  DEFAULT_VIEWER_SETTINGS,
  defaultViewOptions,
  parseWebviewMessage,
  type ErrorMessage,
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
}

interface Loaded {
  pkg: ProcessPackage;
  loadedAt: number;
}

type RunMode = 'initial' | 'options' | 'settings' | 'select' | 'navigate' | 'reload';

interface Built {
  loaded: Loaded;
  render: RenderMessage;
  /** Level ids below the chosen process, as drawn. */
  below: string[];
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
    const msg = parseWebviewMessage(raw);
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
    } else {
      this.options = { ...msg.options };
      this.pending = this.run('options');
      await this.pending;
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
    // A toggle, a settings change, a process switch or a navigation while the file is broken redraws the last good package.
    const redraw = mode === 'options' || mode === 'settings';
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
      const render = await buildRenderMessage(
        loaded.pkg,
        options,
        preserveView,
        loaded.loadedAt,
        plan.root.id,
        this.settings,
        level,
      );
      result = { loaded, render, below };
    } catch (err) {
      result = buildErrorMessage(this.deps.fileName, err);
    }
    if (generation !== this.generation || this.disposed) return;
    this.pending = undefined;

    if ('render' in result) {
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

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}
