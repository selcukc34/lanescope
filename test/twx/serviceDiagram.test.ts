// Service flows and client-side human services read as diagrams of their
// own (readServiceDiagram), with BAW's positions. Expected values were
// checked against the objects of the local exports (../localFixtures; skipped
// when they are not there).

import { beforeAll, describe, expect, it } from 'vitest';
import { layoutProcess } from '../../src/bpmn/layout';
import { toDiagramXml } from '../../src/bpmn/toDiagramXml';
import type { FlowNode, Process, ProcessPackage } from '../../src/model/model';
import { readPackageXml } from '../../src/twx/packageXml';
import { TwxResolver } from '../../src/twx/resolver';
import { readServiceDiagram } from '../../src/twx/serviceReader';
import { readTwxPackage } from '../../src/twx/twxImport';
import { readTwxFile } from '../../src/twx/twxReader';
import { parseXml } from '../../src/twx/xml';
import { hasLocalTwx, localTwx } from '../localFixtures';

const REAL = hasLocalTwx('services', 'orderDelivery');

const ROUTING = '1.aa781ea0-0f1c-46c8-8c92-eb9f7cbebc18';
const CATCH_ALL = '1.5acb6779-d642-48ae-980e-9ca2f18de0e4';
const ERROR_END = '1.bbc4e41c-f61a-4282-ad5a-659cd3d6d3d3';
const CUSTOMER_FORM = '1.3a787902-2ca0-485e-9ad7-3a99b262ecfd';
const GET_WEATHER = '1.0b7a1dc5-6b81-49c2-82ae-dd4e33e9647f';
const OPEN_METEO = '1.48614562-7bf3-45f0-baa9-b687ae2dfc11';
const SQL_EXECUTE = '1.8ca80af0-a727-4b90-9e04-21b32cd0c65c';

let resolver: TwxResolver;
let services: ProcessPackage;
let orderDelivery: ProcessPackage;

beforeAll(async () => {
  if (!REAL) return;
  const archive = await readTwxFile(localTwx('services'));
  resolver = new TwxResolver(archive.objects, readPackageXml(archive.packageXml!), archive.lazy);
  services = await readTwxPackage(localTwx('services'));
  orderDelivery = await readTwxPackage(localTwx('orderDelivery'));
});

function diagram(id: string, warnings?: string[]): Process {
  const p = readServiceDiagram(id, resolver, warnings);
  if (!p) throw new Error(`${id} has no diagram`);
  return p;
}

function node(p: Process, name: string): FlowNode {
  const n = p.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node "${name}" not in ${p.name}`);
  return n;
}

const nameOf = (p: Process, id: string) => p.nodes.find((n) => n.id === id)?.name;

describe.skipIf(!REAL)('service flow Demo_Routing', () => {
  it('has the ten nodes, no lanes, and is marked as a service flow', () => {
    const p = diagram(ROUTING);
    expect(p.name).toBe('Demo_Routing');
    expect(p.originalId ?? p.id).toBe(ROUTING);
    expect(p.source).toEqual({ kind: 'serviceFlow', processType: '12' });
    expect(p.lanes).toEqual([]);
    expect(p.nodes).toHaveLength(10);
    expect(p.nodes.map((n) => [n.name, n.kind])).toEqual([
      ['Start', 'startEvent'],
      ['Script task', 'scriptTask'],
      ['Amount check', 'exclusiveGateway'],
      ['Low', 'scriptTask'],
      ['Medium', 'scriptTask'],
      ['High', 'scriptTask'],
      ['Region Check', 'exclusiveGateway'],
      ['Script task 1', 'scriptTask'],
      ['End', 'endEvent'],
      ['Script task 2', 'scriptTask'],
    ]);
  });

  it('takes positions and sizes from nodeVisualInfo, and the layout keeps them', async () => {
    const p = diagram(ROUTING);
    expect(node(p, 'Start').bounds).toEqual({ x: 25, y: 80, width: 24, height: 24 });
    expect(node(p, 'Script task').bounds).toEqual({ x: 79, y: 57, width: 95, height: 70 });
    expect(node(p, 'Amount check').bounds).toEqual({ x: 268, y: 76, width: 32, height: 32 });
    expect(node(p, 'End').bounds).toEqual({ x: 820, y: 80, width: 24, height: 24 });
    const lay = await layoutProcess(p);
    expect(lay.warnings).toEqual([]);
    expect(lay.lanes).toEqual([]);
    expect(lay.shapes.get(node(p, 'Amount check').id)).toEqual({ x: 268, y: 76, width: 32, height: 32 });
  });

  it('marks "To Low" as the default of Amount check and keeps Region Check\'s unconditioned flow without a condition', () => {
    const p = diagram(ROUTING);
    const out = (gateway: string) => p.flows.filter((f) => f.sourceId === node(p, gateway).id);
    expect(out('Amount check').map((f) => [nameOf(p, f.targetId), f.isDefault, f.condition])).toEqual([
      ['Low', true, undefined],
      ['Medium', false, 'tw.local.amount\t  >\t  100'],
      ['High', false, 'tw.local.amount\t  >\t  1000'],
    ]);
    const toScript2 = out('Region Check').find((f) => nameOf(p, f.targetId) === 'Script task 2')!;
    expect(toScript2.condition).toBeUndefined();
    expect(toScript2.isDefault).toBe(false);
    expect(toScript2.sourcePort).toBeDefined();
  });

  it('keeps the scripts, inputs and variables', () => {
    const p = diagram(ROUTING);
    expect(node(p, 'Low').script).toEqual({ language: 'text/x-javascript', text: 'tw.local.route = "low";' });
    expect(p.inputs?.map((i) => [i.name, i.typeName])).toEqual([
      ['amount', 'Decimal'],
      ['region', 'String'],
    ]);
    expect(p.variables?.map((v) => v.name)).toEqual(['route']);
  });

  it('is drawn without lanes, in one pool', async () => {
    const { xml, warnings } = await toDiagramXml(diagram(ROUTING));
    expect(warnings).toEqual([]);
    expect(xml).toContain('bpmn:participant');
    expect(xml).not.toContain('bpmn:lane ');
  });
});

describe.skipIf(!REAL)('error boundaries and error end events', () => {
  it('Demo_WeatherCatchAll: a catch-all boundary attached to the GetWeather call', () => {
    const p = diagram(CATCH_ALL);
    const call = node(p, 'GetWeather');
    expect(call.kind).toBe('callActivity');
    expect(call.calledElement).toMatchObject({ id: GET_WEATHER, name: 'GetWeather', kind: 'Service flow' });
    expect(call.calledElement?.internals?.steps.some((s) => s.kind === 'rest')).toBe(true);
    expect(call.inputMappings?.find((m) => m.parameter === 'latitude')).toMatchObject({ value: 'tw.local.latitude', mapped: true });

    const boundary = p.nodes.find((n) => n.originalType === 'boundaryEvent')!;
    expect(boundary).toMatchObject({ name: 'Error', kind: 'intermediateEvent', attachedToId: call.id, errorEvent: { catchAll: true } });
    expect(boundary.bounds).toEqual({ x: 366, y: 115, width: 24, height: 24 });
    const out = p.flows.filter((f) => f.sourceId === boundary.id).map((f) => nameOf(p, f.targetId));
    expect(out).toEqual(['Error']);
    expect(p.nodes.filter((n) => n.name === 'Error').map((n) => n.kind)).toEqual(['scriptTask', 'intermediateEvent']);
  });

  it('Demo_WeatherErrorEnd: the error end event is an end event with the error marker', async () => {
    const p = diagram(ERROR_END);
    const end = node(p, 'End event');
    expect(end).toMatchObject({ kind: 'endEvent', eventType: 'Error', errorEvent: {} });
    const boundary = p.nodes.find((n) => n.originalType === 'boundaryEvent')!;
    expect(boundary.errorEvent).toEqual({ catchAll: false, errorCode: '_WEATHER_FAILED' });
    expect(p.flows.filter((f) => f.sourceId === boundary.id).map((f) => nameOf(p, f.targetId))).toEqual(['End event']);
    const { xml } = await toDiagramXml(p);
    expect(xml.match(/bpmn:errorEventDefinition/g)).toHaveLength(2);
  });

  it('GetWeather: the REST step is a service task bound to the external service', () => {
    const rest = node(diagram(GET_WEATHER), 'Open-Meteo Historical Weather API');
    expect(rest.kind).toBe('serviceTask');
    expect(rest.restOperation).toEqual({ service: 'Open-Meteo Historical Weather API', serviceId: OPEN_METEO, operation: 'getArchive' });
    expect(rest.inputMappings?.map((m) => m.parameter)).toEqual(['latitude', 'longitude', 'start_date', 'end_date', 'hourly']);
  });

  it('Demo_DoubleCall service: the SQL step names the toolkit service it cannot resolve', () => {
    const db = readServiceDiagram('1.81a17321-aed7-4455-bf32-bb3001ef61af', resolver)!;
    const sql = node(db, 'SQL Execute Statement');
    expect(sql.calledElement).toEqual({ id: SQL_EXECUTE });
  });
});

describe.skipIf(!REAL)('client-side human service Demo_CustomerForm', () => {
  it('draws the coach as a user task with its controls, and Stay on page as an event', () => {
    const p = diagram(CUSTOMER_FORM);
    expect(p.source).toEqual({ kind: 'humanService', processType: '10' });
    const coach = node(p, 'Coach');
    expect(coach).toMatchObject({ kind: 'userTask', originalType: 'formTask' });
    expect(coach.bounds).toEqual({ x: 350, y: 177, width: 95, height: 70 });
    expect(coach.coach?.controls.map((c) => [c.label, c.binding])).toEqual([
      ['Customer Name', 'tw.local.customerName'],
      ['Age', 'tw.local.age'],
      ['Birth Date', 'tw.local.birthDate'],
      ['Segment', 'tw.local.segment'],
      ['Single select', undefined],
      ['OK', undefined],
    ]);
    expect(node(p, 'Stay on page')).toMatchObject({ kind: 'intermediateEvent', originalType: 'intermediateThrowEvent', eventType: 'Stay on page' });
    expect(p.nodes.every((n) => n.bounds !== undefined)).toBe(true);
    expect(p.variables?.map((v) => v.name)).toContain('customerName');
  });
});

describe.skipIf(!REAL)('order-delivery-process', () => {
  it('an empty service flow is Start → End and can be drawn', async () => {
    const call = orderDelivery.processes.flatMap((p) => p.nodes).find((n) => n.name === 'Validate Order SF')!;
    const read = await orderDelivery.calleeDiagrams!.read(call.calledElement!.id);
    const p = read!.process;
    expect(p.nodes.map((n) => n.kind)).toEqual(['startEvent', 'endEvent']);
    expect(p.flows).toHaveLength(1);
    const { xml, warnings } = await toDiagramXml(p);
    expect(warnings).toEqual([]);
    expect(xml).toContain('bpmn:startEvent');
    expect(read!.warnings).toEqual([]);
  });
});

describe.skipIf(!REAL)('the package reads service diagrams on demand', () => {
  it('says which calls open and why the others do not', () => {
    const source = services.calleeDiagrams!;
    expect(source.openability(ROUTING)).toEqual({ openable: true });
    expect(source.openability(CUSTOMER_FORM)).toEqual({ openable: true });
    expect(source.openability(SQL_EXECUTE)).toEqual({ openable: false, reason: 'Not in this export' });
    expect(source.openability(OPEN_METEO)).toEqual({ openable: false, reason: 'External service' });
    expect(source.name(ROUTING)).toBe('Demo_Routing');
  });

  it('reads a diagram once and names the control types of its coaches', async () => {
    const first = await services.calleeDiagrams!.read(CUSTOMER_FORM);
    expect(await services.calleeDiagrams!.read(CUSTOMER_FORM)).toBe(first);
    const coach = first!.process.nodes.find((n) => n.coach)!.coach!;
    expect(coach.controls.map((c) => c.type)).toEqual(['Text', 'Integer', 'Date Time Picker', 'Text', 'Single Select', 'Button']);
    expect(await services.calleeDiagrams!.read(SQL_EXECUTE)).toBeUndefined();
    expect(await services.calleeDiagrams!.read(OPEN_METEO)).toBeUndefined();
  });
});

describe('shapes not seen in a real export', () => {
  const service = (body: string, classic = '') =>
    parseXml(`<teamworks><process id="1.s" name="S"><processType>12</processType>${classic}<bpmn2Model>
      <ns16:definitions xmlns:ns16="http://www.omg.org/spec/BPMN/20100524/MODEL"><ns16:process id="1.s">
      <ns16:startEvent id="a" name="Start"/>${body}</ns16:process></ns16:definitions></bpmn2Model></process></teamworks>`);
  const inMemory = (root: ReturnType<typeof parseXml>) => {
    const r = new TwxResolver(new Map());
    r.object = (id: string) => (id === '1.s' ? root : undefined);
    return r;
  };

  it('draws an unknown step as kind "unknown" and warns', () => {
    const warnings: string[] = [];
    const r = inMemory(service(`<ns16:sequenceFlow id="f1" sourceRef="a" targetRef="p"/><ns16:parallelGateway id="p" name="Fork"/>`));
    const p = readServiceDiagram('1.s', r, warnings)!;
    expect(p.nodes.map((n) => [n.name, n.kind, n.originalType])).toEqual([
      ['Start', 'startEvent', 'startEvent'],
      ['Fork', 'unknown', 'parallelGateway'],
    ]);
    expect(warnings).toEqual(['Service "S": unsupported step <parallelGateway> "Fork" read as kind "unknown".']);
  });

  it('falls back to the classic item/layoutData positions, then to the layout', async () => {
    const classic = `<item><processItemId>2025.e</processItemId><layoutData x="300" y="80"/></item>
      <startPoint><layoutData x="20" y="90"/></startPoint>`;
    const r = inMemory(service(`<ns16:sequenceFlow id="f1" sourceRef="a" targetRef="e"/><ns16:endEvent id="e" name="End"/>`, classic));
    const p = readServiceDiagram('1.s', r)!;
    expect(p.nodes.map((n) => n.bounds)).toEqual([
      { x: 20, y: 90, width: 36, height: 36 },
      { x: 300, y: 80, width: 36, height: 36 },
    ]);
    const none = readServiceDiagram('1.s', inMemory(service(`<ns16:endEvent id="e" name="End"/>`)))!;
    expect(none.nodes.every((n) => n.bounds === undefined)).toBe(true);
    const lay = await layoutProcess(none);
    expect(lay.shapes.size).toBe(2);
  });

  it.skipIf(!REAL)('is undefined for objects that are not a service flow or human service', () => {
    expect(readServiceDiagram(OPEN_METEO, resolver)).toBeUndefined();
    expect(readServiceDiagram(SQL_EXECUTE, resolver)).toBeUndefined();
    expect(readServiceDiagram('25.x', resolver)).toBeUndefined();
  });
});
