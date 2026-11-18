// What the render message carries for the activity details panel, and the
// showScripts setting: when it is off, no script text reaches the webview.
// The TWX cases need a local export (../localFixtures) and are skipped without it.

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { DEFAULT_VIEW_OPTIONS, type HostMessage, type NodeDetails, type RenderMessage } from '../../src/views/protocol';
import { buildRenderMessage } from '../../src/views/viewModel';
import { ViewerSession } from '../../src/views/viewerSession';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const REAL = hasLocalTwx('services');

const DECIDE_SCRIPT = 'tw.local.approved = tw.local.amount < 1000;';

let bob: ProcessPackage;
let services: ProcessPackage;

beforeAll(async () => {
  bob = await readProcessPackage(await readBpmnPackage(BOB));
  if (REAL) services = await readTwxPackage(localTwx('services'));
});

const processId = (name: string) => {
  const p = services.processes.find((x) => x.name === name);
  if (!p) throw new Error(`process "${name}" not found`);
  return p.id;
};

function nodeDetails(msg: RenderMessage, name: string): NodeDetails {
  const d = Object.values(msg.elements).find((e) => e.kind === 'node' && e.name === name);
  if (!d || d.kind !== 'node') throw new Error(`node "${name}" not in the message`);
  return d;
}

describe('render message: activity details', () => {
  it.skipIf(!REAL)('carries the script of a script task and draws it as a bpmn:ScriptTask', async () => {
    const msg = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId('DemoChildProcess'));
    const decide = nodeDetails(msg, 'Decide');
    expect(decide.bpmnKind).toBe('Script task');
    expect(decide.script).toEqual({ hidden: false, language: 'text/x-javascript', text: DECIDE_SCRIPT, lineCount: 1 });
    expect(msg.xml).toMatch(/<bpmn:scriptTask id="[^"]+" name="Decide"/);
    // The diagram XML never holds the script itself.
    expect(msg.xml).not.toContain('tw.local.approved');
  });

  it.skipIf(!REAL)('with showScripts off, sends a hidden marker and no script text anywhere in the message', async () => {
    for (const name of ['DemoChildProcess', 'MyFirstProcess', 'Demo_TrackedProcess']) {
      const msg = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId(name), { showScripts: false });
      const json = JSON.stringify(msg);
      for (const script of services.processes.flatMap((p) => p.nodes).flatMap((n) => (n.script ? [n.script.text] : []))) {
        expect(json).not.toContain(JSON.stringify(script).slice(1, -1));
      }
      const scripted = Object.values(msg.elements).filter((e) => e.kind === 'node' && e.script !== undefined);
      expect(scripted.length).toBeGreaterThan(0);
      for (const e of scripted) expect(e.kind === 'node' && e.script).toEqual({ hidden: true });
    }
  });

  it.skipIf(!REAL)('types the input mapping by the callee signature and marks unmapped parameters', async () => {
    const msg = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId('Demo_MainProcess'));
    const call = nodeDetails(msg, 'DemoChildProcess 1');
    expect(call.inputMappings).toEqual([
      { parameter: 'orderId', type: 'String', isCollection: false, value: 'tw.local.orderId', mapped: true, literal: false },
      { parameter: 'amount', type: 'Decimal', isCollection: false, mapped: false, literal: false },
    ]);
    expect(call.outputMappings).toEqual([
      { parameter: 'approved', type: 'String', isCollection: false, value: 'tw.local.approved', mapped: true, literal: false },
    ]);
    expect(nodeDetails(msg, 'Timer 2').timer).toEqual({ duration: 'tw.epv.DemoSettings.reminderMinutes', unit: 'Minutes' });
  });

  it.skipIf(!REAL)('adds the lane and performer to the assignment of a user task', async () => {
    const msg = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId('JsSampleProcess'));
    expect(nodeDetails(msg, 'CSHS1').userTask).toMatchObject({
      assignment: 'Lane',
      lane: 'All Users',
      subject: '<#= tw.local.subjectOnlyVar #>',
    });
  });

  it.skipIf(!REAL)('lists the variables of the process in the summary', async () => {
    const msg = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId('Demo_MainProcess'));
    expect(msg.process.variables).toHaveLength(8);
    expect(msg.process.variables?.[1]).toEqual({
      name: 'amount',
      type: 'Decimal',
      isCollection: false,
      defaultValue: '0.0',
      tracked: true,
    });
    const child = await buildRenderMessage(services, DEFAULT_VIEW_OPTIONS, false, 0, processId('DemoChildProcess'));
    expect(child.process.inputs?.map((i) => i.name)).toEqual(['orderId', 'amount']);
    expect(child.process.outputs?.map((o) => o.name)).toEqual(['approved']);
  });

  it('gives a Bob gateway its outgoing conditions, and nothing TWX-only', async () => {
    const msg = await buildRenderMessage(bob, DEFAULT_VIEW_OPTIONS);
    const gateways = Object.values(msg.elements).filter(
      (e): e is NodeDetails => e.kind === 'node' && e.bpmnKind.endsWith('gateway') && e.outgoing !== undefined,
    );
    expect(gateways.length).toBeGreaterThan(0);
    for (const g of gateways) {
      const flows = bob.processes[0].flows.filter((f) => f.sourceId === g.id);
      expect(g.outgoing?.map((o) => o.flowId)).toEqual(flows.map((f) => f.id));
      expect(g.outgoing?.map((o) => o.condition)).toEqual(flows.map((f) => f.condition));
      expect(g.outgoing?.map((o) => o.isDefault)).toEqual(flows.map((f) => f.isDefault));
    }
    for (const e of Object.values(msg.elements)) {
      if (e.kind !== 'node') continue;
      expect(e.script).toBeUndefined();
      expect(e.inputMappings).toBeUndefined();
      expect(e.userTask).toBeUndefined();
      expect(e.timer).toBeUndefined();
    }
    expect(msg.process.variables).toBeUndefined();
  });
});

describe('showScripts setting in the session', () => {
  it.skipIf(!REAL)('re-renders the open view without the script when the setting is turned off, and back', async () => {
    const posted: HostMessage[] = [];
    const s = new ViewerSession({ fileName: 'services.twx', load: async () => services, post: (m) => posted.push(m) });
    await s.handleMessage({ type: 'selectProcess', processId: processId('DemoChildProcess') });
    await s.handleMessage({ type: 'ready' });
    const decide = (m: HostMessage) => (m.type === 'render' ? nodeDetails(m, 'Decide').script : undefined);
    expect(decide(posted.at(-1)!)).toMatchObject({ hidden: false, text: DECIDE_SCRIPT });

    await s.updateSettings({ showScripts: false });
    const hidden = posted.at(-1)!;
    expect(hidden.type === 'render' && hidden.preserveView).toBe(true);
    expect(decide(hidden)).toEqual({ hidden: true });
    expect(JSON.stringify(hidden)).not.toContain('tw.local.amount < 1000');

    const count = posted.length;
    await s.updateSettings({ showScripts: false });
    expect(posted).toHaveLength(count); // unchanged settings: no re-render

    await s.updateSettings({ showScripts: true });
    expect(decide(posted.at(-1)!)).toMatchObject({ hidden: false, text: DECIDE_SCRIPT });
  });

  it.skipIf(!REAL)('uses the setting from the start when the viewer opens with scripts hidden', async () => {
    const posted: HostMessage[] = [];
    const s = new ViewerSession({
      fileName: 'services.twx',
      load: async () => services,
      post: (m) => posted.push(m),
      settings: { showScripts: false },
    });
    await s.handleMessage({ type: 'selectProcess', processId: processId('DemoChildProcess') });
    await s.handleMessage({ type: 'ready' });
    expect(posted.length).toBeGreaterThan(0);
    for (const m of posted) expect(JSON.stringify(m)).not.toContain('tw.local.amount < 1000');
  });
});
