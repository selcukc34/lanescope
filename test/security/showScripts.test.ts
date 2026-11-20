// SECURITY.md scope 4: with lanescope.showScripts off, no script text may
// reach the diagram view. Every message a viewer posts is captured: first
// load, webview reload, live refresh (good and broken file), toolbar toggles,
// process switch, the inside of called services, service diagrams opened
// from a call (two levels down), breadcrumb navigation back up. Not one of
// them may hold SCRIPT_MARKER, a string that only appears in script bodies.
// A control run with the setting on proves the marker is there to be found.

import { describe, expect, it } from 'vitest';
import { readBpmnZip } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { readTwxArchive } from '../../src/twx/twxReader';
import { twxToProcessPackage } from '../../src/twx/twxImport';
import type { HostMessage, RenderMessage, ViewerSettings } from '../../src/views/protocol';
import { ViewerSession, type Timers } from '../../src/views/viewerSession';
import { craftedBobZip, craftedTwx, INNER_SERVICE_ID, SCRIPT_MARKER, SERVICE_ID } from './crafted';

/** Fires the debounce timer on demand. */
class ManualTimers implements Timers {
  private readonly pending = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.pending.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    callbacks.forEach((c) => c());
  }
}

const twxPackage = async () => twxToProcessPackage(await readTwxArchive(await craftedTwx(), 'crafted.twx'));
const bobPackage = async () => readProcessPackage(await readBpmnZip(await craftedBobZip(), 'crafted.zip'));

/**
 * Drives a viewer through everything it can be asked to do and returns every
 * message it posted, tagged with what caused it.
 */
async function everyMessage(
  load: () => Promise<ProcessPackage>,
  settings: ViewerSettings,
  options: { drillDown: boolean },
): Promise<Array<{ step: string; message: HostMessage }>> {
  const timers = new ManualTimers();
  const log: Array<{ step: string; message: HostMessage }> = [];
  let step = 'first load';
  let broken = false;
  const session = new ViewerSession({
    fileName: 'crafted',
    timers,
    settings,
    load: async () => {
      if (broken) throw new Error('The file is being written.');
      return load();
    },
    post: (message) => log.push({ step, message }),
  });
  const lastRender = () => log.map((l) => l.message).filter((m): m is RenderMessage => m.type === 'render').at(-1)!;
  const act = async (name: string, action: () => Promise<void> | void) => {
    step = name;
    await action();
    await session.idle;
  };

  await act('first load', () => session.handleMessage({ type: 'ready' }));
  await act('webview reload', () => session.handleMessage({ type: 'ready' }));
  await act('toggle labels', () => session.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: false, highlightChanges: true } }));
  await act('live refresh', () => {
    session.fileChanged();
    timers.fire();
  });
  await act('refresh of a broken file', () => {
    broken = true;
    session.fileChanged();
    timers.fire();
  });
  await act('toggle while broken', () => session.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: true } }));
  await act('file fixed', () => {
    broken = false;
    session.fileChanged();
    timers.fire();
  });
  await act('select process', () => session.handleMessage({ type: 'selectProcess', processId: lastRender().rootProcessId }));
  if (options.drillDown) {
    await act('open service', () => session.handleMessage({ type: 'openCallee', calleeId: SERVICE_ID, path: lastRender().path.map((l) => l.id) }));
    await act('open service inside it', () =>
      session.handleMessage({ type: 'openCallee', calleeId: INNER_SERVICE_ID, path: lastRender().path.map((l) => l.id) }),
    );
    await act('refresh two levels down', () => {
      session.fileChanged();
      timers.fire();
    });
    await act('webview reload two levels down', () => session.handleMessage({ type: 'ready' }));
    await act('toggle two levels down', () => session.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true, highlightChanges: true } }));
    await act('breadcrumb back to the service', () => {
      const path = lastRender().path.map((l) => l.id);
      return session.handleMessage({ type: 'openCallee', calleeId: path[1], path: path.slice(0, 1) });
    });
    await act('breadcrumb back to the process', () => {
      const path = lastRender().path.map((l) => l.id);
      return session.handleMessage({ type: 'openCallee', calleeId: path[0], path: [] });
    });
  }
  session.dispose();
  return log;
}

const holdsMarker = (m: HostMessage) => JSON.stringify(m).includes(SCRIPT_MARKER);

describe.each([
  ['TWX', twxPackage, true],
  ['Bob .zip', bobPackage, false],
] as const)('%s: showScripts', (_name, load, drillDown) => {
  it('off: no message, at any step, holds script text', async () => {
    const log = await everyMessage(load, { showScripts: false }, { drillDown });
    const steps = new Set(log.map((l) => l.step));
    // Every step posted something; the message kinds cover render, banner and recovery.
    expect(steps.size).toBe(drillDown ? 15 : 8);
    expect(new Set(log.map((l) => l.message.type))).toEqual(new Set(['render', 'refreshError']));
    expect(log.filter((l) => holdsMarker(l.message)).map((l) => l.step)).toEqual([]);
    // Script tasks still say that a script is there.
    const renders = log.map((l) => l.message).filter((m): m is RenderMessage => m.type === 'render');
    const hidden = renders.flatMap((r) => [
      ...Object.values(r.elements).flatMap((e) => (e.kind === 'node' && e.script ? [e.script] : [])),
      ...Object.values(r.callees).flatMap((c) => c.steps.flatMap((s) => (s.script ? [s.script] : []))),
    ]);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((s) => s.hidden)).toBe(true);
  });

  it('on (control): the marker is found where scripts are shown', async () => {
    const log = await everyMessage(load, { showScripts: true }, { drillDown });
    const withMarker = new Set(log.filter((l) => holdsMarker(l.message)).map((l) => l.step));
    expect(withMarker).toContain('first load');
    if (drillDown) {
      const first = log.find((l) => l.step === 'first load')!.message as RenderMessage;
      // Script task of the BPD, and the script step inside the called service.
      expect(Object.values(first.elements).some((e) => e.kind === 'node' && e.script && !e.script.hidden && e.script.text.includes(SCRIPT_MARKER))).toBe(true);
      expect(JSON.stringify(first.callees)).toContain(SCRIPT_MARKER);
      expect(withMarker).toContain('open service');
      expect(withMarker).toContain('open service inside it');
    }
  });
});

describe('turning showScripts off while a viewer is open', () => {
  it('re-renders without script text, and nothing posted after the switch holds any', async () => {
    const posted: HostMessage[] = [];
    const pkg = await twxPackage();
    const session = new ViewerSession({ fileName: 'crafted.twx', load: async () => pkg, post: (m) => posted.push(m), settings: { showScripts: true } });
    await session.handleMessage({ type: 'ready' });
    const path = (posted.at(-1) as RenderMessage).path.map((l) => l.id);
    await session.handleMessage({ type: 'openCallee', calleeId: SERVICE_ID, path });
    expect(holdsMarker(posted.at(-1)!)).toBe(true);

    const before = posted.length;
    await session.updateSettings({ showScripts: false });
    const after = posted.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'render', preserveView: true });
    // Still at the service level, now without its script.
    expect((after[0] as RenderMessage).path).toHaveLength(2);
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'openCallee', calleeId: INNER_SERVICE_ID, path: (posted.at(-1) as RenderMessage).path.map((l) => l.id) });
    expect(posted.slice(before).filter(holdsMarker)).toEqual([]);
  });

  it('the diagram XML never carries script text, whatever the setting', async () => {
    const log = await everyMessage(twxPackage, { showScripts: true }, { drillDown: true });
    for (const { message } of log) {
      if (message.type === 'render') expect(message.xml).not.toContain(SCRIPT_MARKER);
    }
  });
});
