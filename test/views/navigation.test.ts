// Drill-down navigation: the pure path functions, and the viewer session
// opening called services and linked processes of a TWX export on demand.

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { isPathPrefix, MAX_PATH_DEPTH, openInPath, pathKey, resolvePath } from '../../src/views/navigation';
import { parseWebviewMessage, type HostMessage, type NodeDetails, type RenderMessage } from '../../src/views/protocol';
import { ViewerSession } from '../../src/views/viewerSession';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
/** The local export the session tests use (../localFixtures); skipped when it is not there. */
const REAL = hasLocalTwx('services');

const ROUTING = '1.aa781ea0-0f1c-46c8-8c92-eb9f7cbebc18';
const CATCH_ALL = '1.5acb6779-d642-48ae-980e-9ca2f18de0e4';
const GET_WEATHER = '1.0b7a1dc5-6b81-49c2-82ae-dd4e33e9647f';
const CUSTOMER_FORM = '1.3a787902-2ca0-485e-9ad7-3a99b262ecfd';
const DB_CONNECTION = '1.81a17321-aed7-4455-bf32-bb3001ef61af';

describe('openInPath', () => {
  it('opens a new id one level down', () => {
    expect(openInPath(['a'], 'b')).toEqual({ kind: 'push', path: ['a', 'b'] });
    expect(openInPath([], 'a')).toEqual({ kind: 'push', path: ['a'] });
  });

  it('goes back to an id that is already open instead of opening it again', () => {
    expect(openInPath(['a', 'b', 'c'], 'b')).toEqual({ kind: 'jump', path: ['a', 'b'], index: 1 });
    expect(openInPath(['a', 'b', 'c'], 'a')).toEqual({ kind: 'jump', path: ['a'], index: 0 });
    expect(openInPath(['a', 'b'], 'b')).toEqual({ kind: 'jump', path: ['a', 'b'], index: 1 });
  });

  it(`stops at ${MAX_PATH_DEPTH} levels`, () => {
    const deep = Array.from({ length: MAX_PATH_DEPTH }, (_, i) => `l${i}`);
    expect(MAX_PATH_DEPTH).toBe(20);
    expect(openInPath(deep, 'next')).toEqual({ kind: 'limit', path: deep });
    expect(openInPath(deep.slice(0, 19), 'next').kind).toBe('push');
    // A loop is still found at the limit.
    expect(openInPath(deep, 'l3')).toEqual({ kind: 'jump', path: deep.slice(0, 4), index: 3 });
    expect(openInPath(['a', 'b'], 'c', 2).kind).toBe('limit');
  });
});

describe('resolvePath', () => {
  it('resolves every level, or stops above the first that is gone', async () => {
    const known: Record<string, number> = { a: 1, b: 2, c: 3 };
    expect(await resolvePath(['a', 'b', 'c'], (id) => known[id])).toEqual({
      levels: [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
        { id: 'c', value: 3 },
      ],
    });
    expect(await resolvePath(['a', 'x', 'c'], async (id) => known[id])).toEqual({ levels: [{ id: 'a', value: 1 }], missing: 'x' });
  });

  it('passes the depth and never resolves more than the limit', async () => {
    const depths: number[] = [];
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const r = await resolvePath(long, (_id, depth) => {
      depths.push(depth);
      return depth;
    });
    expect(r.levels).toHaveLength(MAX_PATH_DEPTH);
    expect(depths[depths.length - 1]).toBe(MAX_PATH_DEPTH - 1);
  });

  it('isPathPrefix and pathKey', () => {
    expect(isPathPrefix(['a'], ['a', 'b'])).toBe(true);
    expect(isPathPrefix(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isPathPrefix(['b'], ['a', 'b'])).toBe(false);
    expect(isPathPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(pathKey(['a', 'b'])).not.toBe(pathKey(['ab']));
  });
});

describe('openCallee messages from the webview', () => {
  it('are validated', () => {
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: ROUTING, path: ['25.x'] })).toEqual({
      type: 'openCallee',
      calleeId: ROUTING,
      path: ['25.x'],
    });
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: '', path: [] })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: 'x', path: 'a' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: 'x', path: [1] })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: 'x'.repeat(300), path: [] })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openCallee', calleeId: 'x', path: Array(21).fill('a') })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Viewer session

let services: ProcessPackage;

beforeAll(async () => {
  if (!REAL) return;
  services = await readTwxPackage(localTwx('services'));
});

const processOf = (pkg: ProcessPackage, name: string) => pkg.processes.find((p) => p.name === name)!;
const levelId = (pkg: ProcessPackage, name: string) => {
  const p = processOf(pkg, name);
  return p.originalId ?? p.id;
};

function session(load: () => Promise<ProcessPackage>, showScripts = true) {
  const posted: HostMessage[] = [];
  const s = new ViewerSession({ fileName: 'services.twx', load, post: (m) => posted.push(m), settings: { showScripts } });
  const last = (): RenderMessage => {
    const m = [...posted].reverse().find((x) => x.type === 'render');
    if (!m || m.type !== 'render') throw new Error('nothing rendered');
    return m;
  };
  const open = async (calleeId: string) => {
    await s.handleMessage({ type: 'openCallee', calleeId, path: last().path.map((l) => l.id) });
    return last();
  };
  return { s, posted, last, open };
}

async function onMain(pkg: ProcessPackage = services, showScripts = true) {
  const v = session(async () => pkg, showScripts);
  await v.s.handleMessage({ type: 'ready' });
  await v.s.handleMessage({ type: 'selectProcess', processId: processOf(pkg, 'Demo_MainProcess').id });
  return v;
}

function nodeDetails(msg: RenderMessage, name: string): NodeDetails {
  const d = Object.values(msg.elements).find((e) => e.kind === 'node' && e.name === name);
  if (!d || d.kind !== 'node') throw new Error(`node "${name}" not in the message`);
  return d;
}

const names = (msg: RenderMessage) => msg.path.map((l) => l.name);

describe.skipIf(!REAL)('ViewerSession: opening calls', () => {
  it('starts on the chosen process; its calls say whether they open', async () => {
    const { last } = await onMain();
    const msg = last();
    expect(names(msg)).toEqual(['Demo_MainProcess']);
    expect(msg.rootProcessId).toBe(processOf(services, 'Demo_MainProcess').id);
    expect(nodeDetails(msg, 'Demo_Routing').openCallee).toBe(ROUTING);
    expect(nodeDetails(msg, 'Enter Customer').openCallee).toBe(CUSTOMER_FORM);
    expect(nodeDetails(msg, 'DemoChildProcess').openCallee).toBe(levelId(services, 'DemoChildProcess'));
  });

  it('opens Demo_Routing as a service flow below the process, without the BPD rules', async () => {
    const { open, s } = await onMain();
    const msg = await open(ROUTING);
    expect(names(msg)).toEqual(['Demo_MainProcess', 'Demo_Routing']);
    expect(msg.path.map((l) => l.kind)).toEqual(['Process', 'Service flow']);
    expect(msg.process).toMatchObject({ name: 'Demo_Routing', kind: 'Service flow' });
    expect(msg.preserveView).toBe(false);
    expect(msg.note).toBeUndefined();
    expect(msg.rootProcessId).toBe(processOf(services, 'Demo_MainProcess').id);
    expect(msg.warnings.filter((w) => w.includes('has no condition and is not the default flow'))).toEqual([]);
    expect(msg.process.inputs?.map((i) => i.name)).toEqual(['amount', 'region']);
    expect(s.currentPath).toEqual([levelId(services, 'Demo_MainProcess'), ROUTING]);
  });

  it('goes three levels down to the REST step of GetWeather, and back from the breadcrumb', async () => {
    const { open, s, last } = await onMain();
    await open(CATCH_ALL);
    const msg = await open(GET_WEATHER);
    expect(names(msg)).toEqual(['Demo_MainProcess', 'Demo_WeatherCatchAll', 'GetWeather']);
    const rest = nodeDetails(msg, 'Open-Meteo Historical Weather API');
    expect(rest.rest).toEqual({ service: 'Open-Meteo Historical Weather API', operation: 'getArchive' });
    expect(rest.openUnavailable).toBe('External service');
    expect(rest.openCallee).toBeUndefined();

    // Breadcrumb: the chosen process, opened from nothing above it.
    await s.handleMessage({ type: 'openCallee', calleeId: levelId(services, 'Demo_MainProcess'), path: [] });
    expect(names(last())).toEqual(['Demo_MainProcess']);
    expect(last().note).toBeUndefined();
  });

  it('shows the boundary of the catch-all call in the panel data', async () => {
    const { open } = await onMain();
    const msg = await open(CATCH_ALL);
    const boundary = Object.values(msg.elements).find((e) => e.kind === 'node' && e.boundary !== undefined) as NodeDetails;
    expect(boundary.boundary).toEqual({ attachedTo: 'GetWeather', catchAll: true });
    expect(nodeDetails(msg, 'GetWeather').openCallee).toBe(GET_WEATHER);
  });

  it('does not open a level twice: an id already in the path goes back to it, with a note', async () => {
    const { open, s, last } = await onMain();
    await open(CATCH_ALL);
    await open(GET_WEATHER);
    await s.handleMessage({ type: 'openCallee', calleeId: CATCH_ALL, path: last().path.map((l) => l.id) });
    expect(names(last())).toEqual(['Demo_MainProcess', 'Demo_WeatherCatchAll']);
    expect(last().note).toBe('Demo_WeatherCatchAll is already open in this path');
  });

  it('opens Enter Customer as a human service with the coach controls', async () => {
    const { open } = await onMain();
    const msg = await open(CUSTOMER_FORM);
    expect(msg.process.kind).toBe('Client-side human service');
    const coach = nodeDetails(msg, 'Coach');
    expect(coach.bpmnKind).toBe('User task');
    expect(coach.coach?.controls.map((c) => [c.label, c.type, c.binding])).toEqual([
      ['Customer Name', 'Text', 'tw.local.customerName'],
      ['Age', 'Integer', 'tw.local.age'],
      ['Birth Date', 'Date Time Picker', 'tw.local.birthDate'],
      ['Segment', 'Text', 'tw.local.segment'],
      ['Single select', 'Single Select', undefined],
      ['OK', 'Button', undefined],
    ]);
    expect(nodeDetails(msg, 'Stay on page').eventType).toBe('Stay on page');
  });

  it('opens a linked process with its lanes', async () => {
    const { open } = await onMain();
    const msg = await open(levelId(services, 'DemoChildProcess'));
    expect(names(msg)).toEqual(['Demo_MainProcess', 'DemoChildProcess']);
    expect(msg.process.kind).toBe('Process');
    expect(Object.values(msg.elements).some((e) => e.kind === 'lane')).toBe(true);
    // The picker still shows the chosen process.
    expect(msg.rootProcessId).toBe(processOf(services, 'Demo_MainProcess').id);
  });

  it('a call of a toolkit service does not open', async () => {
    const v = await onMain(services);
    await v.s.handleMessage({ type: 'selectProcess', processId: processOf(services, 'MyFirstProcess').id });
    const msg = await v.open(DB_CONNECTION);
    expect(names(msg)).toEqual(['MyFirstProcess', 'Service flowDB Connection']);
    const sql = nodeDetails(msg, 'SQL Execute Statement');
    expect(sql.openCallee).toBeUndefined();
    expect(sql.openUnavailable).toBe('Not in this export');
    // Asking anyway changes nothing but the note.
    const again = await v.s
      .handleMessage({ type: 'openCallee', calleeId: '1.8ca80af0-a727-4b90-9e04-21b32cd0c65c', path: msg.path.map((l) => l.id) })
      .then(() => v.last());
    expect(names(again)).toEqual(['MyFirstProcess', 'Service flowDB Connection']);
    expect(again.note).toBe('1.8ca80af0-a727-4b90-9e04-21b32cd0c65c cannot be opened');
  });

  it('picking a process in the picker starts a new path; a stale openCallee is ignored', async () => {
    const { open, s, last } = await onMain();
    await open(ROUTING);
    await s.handleMessage({ type: 'selectProcess', processId: processOf(services, 'JsSampleProcess').id });
    expect(names(last())).toEqual(['JsSampleProcess']);
    await s.handleMessage({ type: 'openCallee', calleeId: CATCH_ALL, path: [levelId(services, 'Demo_MainProcess')] });
    expect(names(last())).toEqual(['JsSampleProcess']);
  });

  it('keeps the level across a toolbar toggle, keeping the zoom', async () => {
    const { open, s, last } = await onMain();
    await open(ROUTING);
    await s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: false, hideEmptyLanes: true, highlightChanges: true } });
    expect(names(last())).toEqual(['Demo_MainProcess', 'Demo_Routing']);
    expect(last().preserveView).toBe(true);
  });
});

describe.skipIf(!REAL)('ViewerSession: scripts stay on the host when showScripts is off', () => {
  it('no level sends script text', async () => {
    const texts = ['tw.local.route = \\"low\\";', 'addValidationError'];
    for (const showScripts of [false, true]) {
      const { open, s } = await onMain(services, showScripts);
      const routing = await open(ROUTING);
      await s.handleMessage({ type: 'openCallee', calleeId: CUSTOMER_FORM, path: [levelId(services, 'Demo_MainProcess')] });
      const form = (s as unknown as { good: { render: RenderMessage } }).good.render;
      const json = JSON.stringify([routing, form]);
      for (const text of texts) expect(json.includes(text)).toBe(showScripts);
      if (!showScripts) {
        expect(nodeDetails(routing, 'Low').script).toEqual({ hidden: true });
        expect(nodeDetails(form, 'Validtate').script).toEqual({ hidden: true });
      }
    }
  });
});

describe.skipIf(!REAL)('ViewerSession: live refresh', () => {
  it('resolves the path again and stays at the deepest level that is still there', async () => {
    let current: ProcessPackage = services;
    const v = session(async () => current);
    await v.s.handleMessage({ type: 'ready' });
    await v.s.handleMessage({ type: 'selectProcess', processId: processOf(services, 'Demo_MainProcess').id });
    await v.open(CATCH_ALL);
    await v.open(GET_WEATHER);

    // Same file again: same level, same zoom.
    await v.s.reload();
    expect(names(v.last())).toEqual(['Demo_MainProcess', 'Demo_WeatherCatchAll', 'GetWeather']);
    expect(v.last().preserveView).toBe(true);
    expect(v.last().note).toBeUndefined();

    // GetWeather is gone from the file.
    const source = services.calleeDiagrams!;
    current = {
      ...services,
      calleeDiagrams: {
        name: (id) => source.name(id),
        openability: (id) => source.openability(id),
        read: (id) => (id === GET_WEATHER ? Promise.resolve(undefined) : source.read(id)),
        list: () => source.list(),
        key: (ref) => source.key(ref),
      },
    };
    await v.s.reload();
    const msg = v.last();
    expect(names(msg)).toEqual(['Demo_MainProcess', 'Demo_WeatherCatchAll']);
    expect(msg.note).toBe('GetWeather is no longer in the file; showing Demo_WeatherCatchAll');
    expect(msg.preserveView).toBe(false);
    expect(v.posted.some((m) => m.type === 'refreshError' || m.type === 'error')).toBe(false);
  });
});

describe('Bob output', () => {
  it('has one level and nothing to open', async () => {
    const bob = await readProcessPackage(await readBpmnPackage(BOB));
    const v = session(async () => bob);
    await v.s.handleMessage({ type: 'ready' });
    const msg = v.last();
    expect(msg.path).toHaveLength(1);
    expect(msg.path[0].id).toBe(bob.processes[0].id);
    expect(Object.values(msg.elements).some((e) => e.kind === 'node' && (e.openCallee || e.openUnavailable))).toBe(false);
    await v.s.handleMessage({ type: 'openCallee', calleeId: '1.x', path: [msg.path[0].id] });
    expect(v.last().path).toHaveLength(1);
  });
});
