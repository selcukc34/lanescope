import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import type { HostMessage, RenderMessage } from '../../src/views/protocol';
import { REFRESH_DEBOUNCE_MS, ViewerSession, type Timers } from '../../src/views/viewerSession';
import { isWatchedChange, watchPatternFor } from '../../src/views/watchPattern';

const FIXTURE = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');

let pkg: ProcessPackage;

beforeAll(async () => {
  pkg = await readProcessPackage(await readBpmnPackage(FIXTURE));
});

/**
 * Manual clock for the debounce timer only. The layout (elkjs) uses real
 * timers internally, so global fake timers would stall it.
 */
class FakeTimers implements Timers {
  time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get scheduled(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, t] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.time) continue;
      this.timers.delete(id);
      t.callback();
    }
  }
}

/** A viewer whose file content the test controls. */
function liveSession() {
  const timers = new FakeTimers();
  const posted: HostMessage[] = [];
  const file: { content: ProcessPackage | Error } = { content: pkg };
  let loads = 0;
  let clock = 1_000;
  const s = new ViewerSession({
    fileName: 'test.zip',
    load: async () => {
      loads++;
      if (file.content instanceof Error) throw file.content;
      return file.content;
    },
    post: (m) => posted.push(m),
    timers,
    now: () => clock,
  });
  return {
    s,
    timers,
    posted,
    file,
    loads: () => loads,
    tick: (ms = 1_000) => (clock += ms),
    types: () => posted.map((m) => m.type),
  };
}

/** Opens the viewer and waits for the first diagram. */
async function opened() {
  const live = liveSession();
  await live.s.start();
  await live.s.handleMessage({ type: 'ready' });
  expect(live.types()).toEqual(['render']);
  return live;
}

/** Fires the debounce timer and waits for the reload it started. */
async function settle(live: ReturnType<typeof liveSession>) {
  live.timers.advance(REFRESH_DEBOUNCE_MS);
  await live.s.idle;
}

/** Same process, renamed: stands in for Bob writing a new version. */
function renamed(name: string): ProcessPackage {
  return { ...pkg, processes: [{ ...pkg.processes[0], name }, ...pkg.processes.slice(1)] };
}

describe('live refresh', () => {
  it('debounces: five changes in a row give one reload and one render', async () => {
    const live = await opened();
    live.file.content = renamed('Version 2');

    for (let i = 0; i < 5; i++) {
      live.s.fileChanged();
      live.timers.advance(REFRESH_DEBOUNCE_MS - 50);
    }
    // Still inside the quiet period of the last change: nothing re-read yet.
    expect(live.loads()).toBe(1);
    expect(live.timers.scheduled).toBe(1);

    await settle(live);
    expect(live.loads()).toBe(2);
    expect(live.types()).toEqual(['render', 'render']);
    const refreshed = live.posted[1] as RenderMessage;
    expect(refreshed.process.name).toBe('Version 2');
    // Keeps zoom, scroll and selection in the webview.
    expect(refreshed.preserveView).toBe(true);
  });

  it('catches a delete followed by a re-create as one reload', async () => {
    const live = await opened();
    live.file.content = new Error('ENOENT: no such file');
    live.s.fileChanged(); // deleted
    live.timers.advance(100);
    live.file.content = renamed('Rewritten');
    live.s.fileChanged(); // created again
    await settle(live);

    expect(live.types()).toEqual(['render', 'render']);
    expect((live.posted[1] as RenderMessage).process.name).toBe('Rewritten');
  });

  it('stamps each read with the time it was read from disk', async () => {
    const live = await opened();
    const first = (live.posted[0] as RenderMessage).loadedAt;
    live.tick(5_000);
    live.s.fileChanged();
    await settle(live);
    expect((live.posted[1] as RenderMessage).loadedAt).toBe(first + 5_000);

    // A toggle redraws the same read: the time does not change.
    live.tick(5_000);
    await live.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true, highlightChanges: true } });
    expect((live.posted[2] as RenderMessage).loadedAt).toBe(first + 5_000);
  });

  it('keeps the last good diagram and sends a banner when the new file is broken', async () => {
    const live = await opened();
    live.file.content = new Error('Unexpected end of XML');
    live.s.fileChanged();
    await settle(live);

    expect(live.types()).toEqual(['render', 'refreshError']);
    expect(live.posted[1]).toEqual({
      type: 'refreshError',
      title: 'Cannot reload test.zip; showing the last good version',
      message: 'Unexpected end of XML',
    });

    // A reloaded webview gets the last good diagram back, then the banner.
    await live.s.handleMessage({ type: 'ready' });
    expect(live.types().slice(2)).toEqual(['render', 'refreshError']);
    expect((live.posted[2] as RenderMessage).process.name).toBe(pkg.processes[0].name);

    // A toggle while broken redraws the last good package and keeps the banner.
    await live.s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true, highlightChanges: true } });
    expect(live.types().slice(4)).toEqual(['render', 'refreshError']);
    expect((live.posted[4] as RenderMessage).options.hideGeneratedFlowLabels).toBe(false);
    expect(live.loads()).toBe(2);
  });

  it('clears the banner with a normal render once the file is fixed', async () => {
    const live = await opened();
    live.file.content = new Error('Unexpected end of XML');
    live.s.fileChanged();
    await settle(live);

    live.file.content = renamed('Fixed');
    live.s.fileChanged();
    await settle(live);
    expect(live.types()).toEqual(['render', 'refreshError', 'render']);
    expect((live.posted[2] as RenderMessage).process.name).toBe('Fixed');

    // The error is gone for good: a reloaded webview gets no banner.
    await live.s.handleMessage({ type: 'ready' });
    expect(live.types().slice(3)).toEqual(['render']);
  });

  it('uses the full error screen when there never was a good diagram, then recovers', async () => {
    const live = liveSession();
    live.file.content = new Error('not a zip');
    await live.s.start();
    await live.s.handleMessage({ type: 'ready' });
    expect(live.types()).toEqual(['error']);

    live.file.content = pkg;
    live.s.fileChanged();
    await settle(live);
    expect(live.types()).toEqual(['error', 'render']);
  });

  it('stops reloading and posting once disposed', async () => {
    const live = await opened();
    live.s.fileChanged();
    live.s.dispose();
    expect(live.timers.scheduled).toBe(0);

    live.s.fileChanged();
    await live.s.handleMessage({ type: 'ready' });
    await settle(live);
    expect(live.loads()).toBe(1);
    expect(live.types()).toEqual(['render']);
  });

  it('drops a reload that finishes after the editor closed', async () => {
    const live = await opened();
    live.s.fileChanged();
    live.timers.advance(REFRESH_DEBOUNCE_MS); // reload starts
    live.s.dispose();
    await live.s.idle;
    expect(live.types()).toEqual(['render']);
  });
});

describe('watched files', () => {
  it('watches the direct children of the opened file\'s directory', () => {
    expect(watchPatternFor('/work/out/order.zip')).toEqual({ base: '/work/out', glob: '*' });
  });

  it('reloads a .zip only for the zip itself', () => {
    expect(isWatchedChange('/work/out/order.zip', '/work/out/order.zip')).toBe(true);
    expect(isWatchedChange('/work/out/order.zip', '/work/out/order.xsd')).toBe(false);
    expect(isWatchedChange('/work/out/order.zip', '/work/out/other.zip')).toBe(false);
  });

  it('reloads a .bpmn for the file and the .xsd files next to it', () => {
    expect(isWatchedChange('/work/out/order.BPMN', '/work/out/order.BPMN')).toBe(true);
    expect(isWatchedChange('/work/out/order.BPMN', '/work/out/types.XSD')).toBe(true);
    expect(isWatchedChange('/work/out/order.BPMN', '/work/out/sub/types.xsd')).toBe(false);
    expect(isWatchedChange('/work/out/order.BPMN', '/work/out/other.bpmn')).toBe(false);
    expect(isWatchedChange('/work/out/order.BPMN', '/work/out/notes.txt')).toBe(false);
  });

  it('matches names with glob characters literally', () => {
    expect(isWatchedChange('/w/a{1},[b]*?.zip', '/w/a{1},[b]*?.zip')).toBe(true);
    expect(isWatchedChange('/w/a{1},[b]*?.zip', '/w/a1b.zip')).toBe(false);
  });
});
