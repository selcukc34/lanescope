// What the render message carries about the inside of called services: one
// entry per service, the linked process to open, and no script text at all
// when the showScripts setting is off. The TWX cases need the local exports
// (../localFixtures) and are skipped without them.

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { DEFAULT_VIEW_OPTIONS, type NodeDetails, type RenderMessage } from '../../src/views/protocol';
import { buildRenderMessage } from '../../src/views/viewModel';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const REAL = hasLocalTwx('services', 'orderDeliveryFull');

let services: ProcessPackage;
let orderDelivery: ProcessPackage;

beforeAll(async () => {
  if (!REAL) return;
  services = await readTwxPackage(localTwx('services'));
  orderDelivery = await readTwxPackage(localTwx('orderDeliveryFull'));
});

const processId = (pkg: ProcessPackage, name: string) => pkg.processes.find((p) => p.name === name)!.id;

function nodeDetails(msg: RenderMessage, name: string): NodeDetails {
  const d = Object.values(msg.elements).find((e) => e.kind === 'node' && e.name === name);
  if (!d || d.kind !== 'node') throw new Error(`node "${name}" not in the message`);
  return d;
}

const render = (pkg: ProcessPackage, name: string, showScripts = true) =>
  buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS, false, 0, processId(pkg, name), { showScripts });

describe('render message: inside called services', () => {
  it.skipIf(!REAL)('sends the steps of Demo_Routing without its start and end events', async () => {
    const msg = await render(services, 'Demo_MainProcess');
    const node = nodeDetails(msg, 'Demo_Routing');
    const inside = msg.callees[node.callee!];
    expect(inside.name).toBe('Demo_Routing');
    expect(inside.kind).toBe('Service flow');
    expect(inside.steps.map((s) => s.name)).toEqual([
      'Script task', 'Amount check', 'Low', 'Medium', 'High', 'Region Check', 'Script task 1', 'Script task 2',
    ]);
    const region = inside.steps.find((s) => s.name === 'Region Check')!;
    expect(region.conditions?.[2]).toEqual({ to: 'Script task 2', isDefault: false });
    expect(inside.inputs?.map((p) => [p.name, p.type])).toEqual([['amount', 'Decimal'], ['region', 'String']]);
  });

  it.skipIf(!REAL)('sends each service once, and only for the services drawn activities call', async () => {
    const msg = await render(services, 'Demo_MainProcess');
    const keys = Object.values(msg.elements).flatMap((e) => (e.kind === 'node' && e.callee ? [e.callee] : []));
    expect(Object.keys(msg.callees).sort()).toEqual([...new Set(keys)].sort());
    const child = nodeDetails(msg, 'DemoChildProcess');
    expect(child.callee).toBeUndefined();
  });

  it.skipIf(!REAL)('types the mapping of a call step and names the callee', async () => {
    const msg = await render(services, 'Demo_MainProcess');
    const inside = msg.callees[nodeDetails(msg, 'Demo_WeatherSpecific').callee!];
    const call = inside.steps.find((s) => s.name === 'GetWeather')!;
    expect(call.calls).toBe('GetWeather (Service flow)');
    expect(call.inputMappings?.find((m) => m.parameter === 'latitude')).toMatchObject({ type: 'Decimal', value: 'tw.local.latitude' });
    expect(call.errorBoundaries).toEqual([{ name: 'Error', catchAll: false, errorCode: '_WEATHER_TIMEOUT', to: 'End' }]);
  });

  it.skipIf(!REAL)('sends the coaches of a client-side human service', async () => {
    const msg = await render(services, 'Demo_MainProcess');
    const inside = msg.callees[nodeDetails(msg, 'Review Orders').callee!];
    expect(inside.coaches?.[0].name).toBe('Orders');
    expect(inside.coaches?.[0].controls[0]).toEqual({ id: 'Table1', label: 'Table', type: 'Table', binding: 'tw.local.orders[]' });
  });

  it.skipIf(!REAL)('points a linked process at the process to open', async () => {
    const msg = await render(services, 'Demo_MainProcess');
    expect(nodeDetails(msg, 'DemoChildProcess').openProcessId).toBe(processId(services, 'DemoChildProcess'));
    expect(nodeDetails(msg, 'Demo_Routing').openProcessId).toBeUndefined();
  });

  it.skipIf(!REAL)('with showScripts off, no script text of a called service reaches the message', async () => {
    const scripts = services.processes
      .flatMap((p) => p.nodes)
      .flatMap((n) => n.calledElement?.internals?.steps ?? [])
      .flatMap((s) => (s.script ? [s.script.text] : []));
    expect(scripts.length).toBeGreaterThan(5);
    let hidden = 0;
    for (const name of ['Demo_MainProcess', 'JsSampleProcess', 'MyFirstProcess']) {
      const msg = await render(services, name, false);
      const json = JSON.stringify(msg);
      for (const text of scripts) expect(json).not.toContain(JSON.stringify(text).slice(1, -1));
      const steps = Object.values(msg.callees).flatMap((c) => c.steps).filter((s) => s.script);
      for (const s of steps) expect(s.script).toEqual({ hidden: true });
      hidden += steps.length;
    }
    expect(hidden).toBeGreaterThan(5);
    const shown = await render(services, 'Demo_MainProcess', true);
    expect(JSON.stringify(shown)).toContain('tw.local.route = \\"low\\";');
  });

  it.skipIf(!REAL)('order-delivery-process: the service flows have no steps', async () => {
    const msg = await render(orderDelivery, 'Order Delivery Process');
    const inside = msg.callees[nodeDetails(msg, 'Validate Order SF').callee!];
    expect(inside.steps).toEqual([]);
    expect(msg.callees[nodeDetails(msg, 'Manager Approval').callee!].coaches?.map((c) => c.name)).toEqual(['Coach']);
  });

  it('Bob output has no callees', async () => {
    const bob = await readProcessPackage(await readBpmnPackage(BOB));
    const msg = await buildRenderMessage(bob, DEFAULT_VIEW_OPTIONS);
    expect(msg.callees).toEqual({});
  });
});
