// The inside of called services, read one level deep from TWX exports.
// Expected values were checked against the local exports (../localFixtures;
// skipped when they are not there). ./syntheticTwx.test.ts covers the reader
// without them.

import { beforeAll, describe, expect, it } from 'vitest';
import type { CalleeInternals, CalleeStep, ProcessPackage } from '../../src/model/model';
import { readPackageXml } from '../../src/twx/packageXml';
import { TwxResolver } from '../../src/twx/resolver';
import { readServiceInternals } from '../../src/twx/serviceReader';
import { readTwxPackage } from '../../src/twx/twxImport';
import { readTwxFile } from '../../src/twx/twxReader';
import { parseXml } from '../../src/twx/xml';
import { hasLocalTwx, localTwx } from '../localFixtures';

const REAL = hasLocalTwx('services', 'orderDelivery');

const GET_WEATHER = '1.0b7a1dc5-6b81-49c2-82ae-dd4e33e9647f';
const OPEN_METEO = '1.48614562-7bf3-45f0-baa9-b687ae2dfc11';
const SQL_EXECUTE = '1.8ca80af0-a727-4b90-9e04-21b32cd0c65c';
const DB_CONNECTION = '1.81a17321-aed7-4455-bf32-bb3001ef61af';

let services: ProcessPackage;
let orderDelivery: ProcessPackage;
let servicesResolver: TwxResolver;

beforeAll(async () => {
  if (!REAL) return;
  services = await readTwxPackage(localTwx('services'));
  orderDelivery = await readTwxPackage(localTwx('orderDelivery'));
  const archive = await readTwxFile(localTwx('services'));
  servicesResolver = new TwxResolver(archive.objects, readPackageXml(archive.packageXml!), archive.lazy);
});

function insideOf(pkg: ProcessPackage, processName: string, nodeName: string): CalleeInternals {
  const node = pkg.processes.find((p) => p.name === processName)?.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`node "${nodeName}" not found in ${processName}`);
  const inside = node.calledElement?.internals;
  if (!inside) throw new Error(`"${nodeName}" has no internals`);
  return inside;
}

/** Steps without the start and plain end events, as [kind, name]. */
const listed = (inside: CalleeInternals) =>
  inside.steps.filter((s) => s.kind !== 'start' && !(s.kind === 'end' && !s.eventType)).map((s) => [s.kind, s.name]);

function step(inside: CalleeInternals, name: string): CalleeStep {
  const s = inside.steps.find((x) => x.name === name);
  if (!s) throw new Error(`step "${name}" not found`);
  return s;
}

describe.skipIf(!REAL)('service flow: Demo_Routing', () => {
  it('lists the steps in flow order, breadth first from the start', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_Routing');
    expect(inside.steps[0]).toMatchObject({ kind: 'start', name: 'Start' });
    expect(listed(inside)).toEqual([
      ['script', 'Script task'],
      ['gateway', 'Amount check'],
      ['script', 'Low'],
      ['script', 'Medium'],
      ['script', 'High'],
      ['gateway', 'Region Check'],
      ['script', 'Script task 1'],
      ['script', 'Script task 2'],
    ]);
    expect(step(inside, 'Low').script).toEqual({ language: 'text/x-javascript', text: 'tw.local.route = "low";' });
  });

  it('keeps gateway conditions as written, tabs included, and marks the default', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_Routing');
    expect(step(inside, 'Amount check').conditions).toEqual([
      { to: 'Low', isDefault: true },
      { to: 'Medium', condition: 'tw.local.amount\t  >\t  100', isDefault: false },
      { to: 'High', condition: 'tw.local.amount\t  >\t  1000', isDefault: false },
    ]);
  });

  it('leaves the condition out of a flow that has no conditionExpression', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_Routing');
    expect(step(inside, 'Region Check').conditions).toEqual([
      { to: 'Script task 1', isDefault: true },
      { to: 'End', condition: 'tw.local.region\t  ==\t  "EU"', isDefault: false },
      { to: 'Script task 2', isDefault: false },
    ]);
  });

  it('reads the inputs and variables', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_Routing');
    expect(inside.inputs?.map((p) => [p.name, p.typeName])).toEqual([
      ['amount', 'Decimal'],
      ['region', 'String'],
    ]);
    expect(inside.outputs).toBeUndefined();
    expect(inside.variables?.map((v) => [v.name, v.typeName])).toEqual([['route', 'String']]);
    expect(inside.coaches).toBeUndefined();
  });
});

describe.skipIf(!REAL)('service flow: calls', () => {
  it('Demo_DoubleCall: two calls of the same service, named but not followed', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_DoubleCall');
    expect(listed(inside)).toEqual([
      ['call', 'Service flowDB Connection'],
      ['call', 'Service flowDB Connection 1'],
    ]);
    for (const s of inside.steps.filter((x) => x.kind === 'call')) {
      expect(s).toMatchObject({ calledId: DB_CONNECTION, calledName: 'Service flowDB Connection', calledKind: 'Service flow' });
    }
  });

  it('Service flowDB Connection: the SQL step with its mapped values, callee not in the export', () => {
    const inside = insideOf(services, 'MyFirstProcess', 'Service flowDB Connection');
    expect(listed(inside)).toEqual([['call', 'SQL Execute Statement']]);
    const sql = step(inside, 'SQL Execute Statement');
    expect(sql.calledId).toBe(SQL_EXECUTE);
    expect(sql.calledName).toBeUndefined();
    expect(sql.inputMappings?.map((m) => m.value)).toEqual(['"SELECT SYSDATE FROM DUAL"', '"jdbc/MigAppDB"', '1', '"XMLElement"']);
    expect(sql.outputMappings).toEqual([
      { parameterId: '2055.21cdb854-d222-4fc8-b991-17aef09de0c4', parameter: '2055.21cdb854-d222-4fc8-b991-17aef09de0c4', value: 'tw.local.dbResult', mapped: true, literal: false },
    ]);
    expect(inside.variables?.map((v) => [v.name, v.typeName])).toEqual([['dbResult', 'XMLElement']]);
  });

  it('GetWeather (read through the resolver): a REST step bound to the external service', () => {
    const inside = servicesResolver.internals(GET_WEATHER)!;
    expect(listed(inside)).toEqual([['rest', 'Open-Meteo Historical Weather API']]);
    const rest = step(inside, 'Open-Meteo Historical Weather API');
    expect(rest.restOperation).toEqual({ service: 'Open-Meteo Historical Weather API', serviceId: OPEN_METEO, operation: 'getArchive' });
    expect(rest.inputMappings?.map((m) => [m.parameter, m.value])).toEqual([
      ['latitude', 'tw.local.latitude'],
      ['longitude', 'tw.local.longitude'],
      ['start_date', 'tw.local.start_date'],
      ['end_date', 'tw.local.end_date'],
      ['hourly', '"temperature_2m"'],
    ]);
    expect(rest.outputMappings?.map((m) => [m.parameter, m.value])).toEqual([['getArchive', 'tw.local.getArchive']]);
    expect(inside.inputs?.map((p) => p.name)).toEqual(['end_date', 'latitude', 'longitude', 'start_date']);
    expect(inside.variables?.map((v) => v.name)).toEqual(['getArchive', 'hourly']);
  });

  it('reads a service once, however often it is asked for', () => {
    expect(servicesResolver.internals(GET_WEATHER)).toBe(servicesResolver.internals(`/${GET_WEATHER}`));
    expect(servicesResolver.internals('25.missing')).toBeUndefined();
    expect(servicesResolver.internals(OPEN_METEO)).toBeUndefined(); // an external service has no steps to read
  });
});

describe.skipIf(!REAL)('service flow: error boundaries', () => {
  it('Demo_WeatherCatchAll: a catch-all boundary leading to the script "Error"', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_WeatherCatchAll');
    expect(listed(inside)).toEqual([
      ['call', 'GetWeather'],
      ['script', 'Error'],
    ]);
    const call = step(inside, 'GetWeather');
    expect(call).toMatchObject({ calledId: GET_WEATHER, calledName: 'GetWeather', calledKind: 'Service flow' });
    expect(call.errorBoundaries).toEqual([{ id: '63400c4b-284a-4986-8f2e-b27272807c1b', name: 'Error', catchAll: true, to: 'Error' }]);
    expect(call.inputMappings?.filter((m) => m.mapped).map((m) => [m.parameter, m.value])).toEqual([
      ['end_date', 'tw.local.endDate'],
      ['latitude', 'tw.local.latitude'],
      ['longitude', 'tw.local.longitude'],
      ['start_date', 'tw.local.startDate'],
    ]);
  });

  it('Demo_WeatherSpecific: a boundary for _WEATHER_TIMEOUT', () => {
    const call = step(insideOf(services, 'Demo_MainProcess', 'Demo_WeatherSpecific'), 'GetWeather');
    expect(call.errorBoundaries).toEqual([expect.objectContaining({ name: 'Error', catchAll: false, errorCode: '_WEATHER_TIMEOUT', to: 'End' })]);
  });

  it('Demo_WeatherErrorEnd: a boundary for _WEATHER_FAILED leading to an error end event', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Demo_WeatherErrorEnd');
    expect(step(inside, 'GetWeather').errorBoundaries).toEqual([
      expect.objectContaining({ catchAll: false, errorCode: '_WEATHER_FAILED', to: 'End event' }),
    ]);
    expect(step(inside, 'End event')).toMatchObject({ kind: 'end', eventType: 'Error' });
    expect(listed(inside)).toEqual([
      ['call', 'GetWeather'],
      ['end', 'End event'],
    ]);
  });
});

describe.skipIf(!REAL)('client-side human services', () => {
  it('Enter Customer (Demo_CustomerForm): flow, Stay on page and the coach controls', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Enter Customer');
    expect(listed(inside)).toEqual([
      ['coach', 'Coach'],
      ['script', 'Validtate'],
      ['gateway', 'isError'],
      ['event', 'Stay on page'],
    ]);
    expect(step(inside, 'Stay on page').eventType).toBe('Stay on page');
    expect(inside.coaches).toHaveLength(1);
    expect(inside.coaches![0].name).toBe('Coach');
    expect(inside.coaches![0].controls.map((c) => [c.label, c.binding])).toEqual([
      ['Customer Name', 'tw.local.customerName'],
      ['Age', 'tw.local.age'],
      ['Birth Date', 'tw.local.birthDate'],
      ['Segment', 'tw.local.segment'],
      ['Single select', undefined],
      ['OK', undefined],
    ]);
  });

  it('names control types from the packed UI Toolkit (opened on demand)', () => {
    const controls = insideOf(services, 'Demo_MainProcess', 'Enter Customer').coaches![0].controls;
    expect(controls.map((c) => c.type)).toEqual(['Text', 'Integer', 'Date Time Picker', 'Text', 'Single Select', 'Button']);
    expect(controls[0]).toMatchObject({ id: 'customerName1', viewRef: '64.5663dd71-ff18-4d33-bea0-468d0b869816' });
  });

  it('Review Orders (Demo_OrderList): scripts before the coach, nested controls in document order', () => {
    const inside = insideOf(services, 'Demo_MainProcess', 'Review Orders');
    expect(listed(inside)).toEqual([
      ['script', 'Init orders'],
      ['script', 'Load orders safely'],
      ['coach', 'Orders'],
    ]);
    const coach = inside.coaches![0];
    expect(coach.name).toBe('Orders');
    expect(coach.controls.map((c) => [c.label, c.type, c.binding])).toEqual([
      ['Table', 'Table', 'tw.local.orders[]'],
      ['Table 2', 'Table', 'tw.local.orders[]'],
      ['Modal section', 'Modal Section', undefined],
      ['Table 3', 'Table', 'tw.local.orders[]'],
      ['Table 4', 'Table', 'tw.local.orders[]'],
      ['Error Message', 'Output Text', 'tw.local.errorDetail'],
      ['Friendly Error Message', 'Output Text', 'tw.local.friendlyMessage'],
      ['OK', 'Button', undefined],
    ]);
  });

  it('Migrate - Inline user task: the generated UI with its coach and Postpone Task', () => {
    const inside = insideOf(services, 'JsSampleProcess', 'Migrate - Inline user task');
    expect(listed(inside)).toEqual([
      ['coach', 'Coach'],
      ['event', 'Postpone Task'],
    ]);
    expect(inside.coaches![0].controls).toEqual([
      expect.objectContaining({ id: 'Inline_User_Task_Template', label: 'Inline User Task Template', type: 'Default Inline User Task Template' }),
    ]);
  });

  it('a linked process has no internals', () => {
    const node = services.processes.find((p) => p.name === 'Demo_MainProcess')!.nodes.find((n) => n.name === 'DemoChildProcess')!;
    expect(node.calledElement?.id.startsWith('25.')).toBe(true);
    expect(node.calledElement?.internals).toBeUndefined();
  });
});

describe.skipIf(!REAL)('order-delivery-process (no toolkits packed)', () => {
  it('the called service flows have nothing between start and end', () => {
    for (const name of ['Validate Order SF', 'Lookup Country Info SF', 'Determine Order Route SF', 'Auto Complete Order SF']) {
      const inside = insideOf(orderDelivery, 'Order Delivery Process', name);
      expect(listed(inside)).toEqual([]);
      expect(inside.steps.map((s) => s.kind)).toEqual(['start', 'end']);
    }
  });

  it('the generated UI of each user task has one coach "Coach"; its type stays empty without the toolkit', () => {
    for (const name of ['Manager Approval', 'Compliance Review', 'Handle Exception']) {
      const inside = insideOf(orderDelivery, 'Order Delivery Process', name);
      expect(inside.coaches?.map((c) => c.name)).toEqual(['Coach']);
      expect(inside.coaches![0].controls.every((c) => c.type === undefined)).toBe(true);
    }
  });

  it('reads without new warnings', () => {
    expect(orderDelivery.warnings.filter((w) => w.startsWith('Service '))).toEqual([]);
    expect(services.warnings.filter((w) => w.startsWith('Service ') || /toolkit/i.test(w))).toEqual([]);
  });
});

describe('shapes not seen in a real export', () => {
  const service = (body: string) =>
    parseXml(`<teamworks><process id="1.s" name="S"><processType>12</processType><bpmn2Model>
      <ns16:definitions xmlns:ns16="http://www.omg.org/spec/BPMN/20100524/MODEL"><ns16:process id="1.s">
      <ns16:startEvent id="a" name="Start"/>${body}</ns16:process></ns16:definitions></bpmn2Model></process></teamworks>`);

  it('reads an unknown step as "unknown" and warns once', () => {
    const resolver = new TwxResolver(new Map());
    const body = `<ns16:sequenceFlow id="f1" sourceRef="a" targetRef="p"/><ns16:parallelGateway id="p" name="Fork"/>`;
    const inside = readServiceInternals(service(body), resolver)!;
    readServiceInternals(service(body), resolver);
    expect(inside.steps.map((s) => [s.kind, s.name, s.originalType])).toEqual([
      ['start', 'Start', 'startEvent'],
      ['unknown', 'Fork', 'parallelGateway'],
    ]);
    expect(resolver.warnings).toEqual(['Service "S": unsupported step <parallelGateway> "Fork" read as kind "unknown".']);
  });

  it('puts steps no flow reaches last, in document order, and reads CRLF scripts as LF', () => {
    const resolver = new TwxResolver(new Map());
    const inside = readServiceInternals(
      service(`<ns16:scriptTask id="x" name="Orphan"><ns16:script>a();\r\nb();</ns16:script></ns16:scriptTask>
        <ns16:sequenceFlow id="f1" sourceRef="a" targetRef="e"/><ns16:endEvent id="e" name="End"/>`),
      resolver,
    )!;
    expect(inside.steps.map((s) => s.name)).toEqual(['Start', 'End', 'Orphan']);
    expect(step(inside, 'Orphan').script).toEqual({ text: 'a();\nb();' });
  });

  it('reads a timer boundary as an unknown step', () => {
    const resolver = new TwxResolver(new Map());
    const inside = readServiceInternals(
      service(`<ns16:scriptTask id="x" name="Work"/><ns16:boundaryEvent id="b" name="Late" attachedToRef="x"><ns16:timerEventDefinition/></ns16:boundaryEvent>`),
      resolver,
    )!;
    expect(step(inside, 'Late').kind).toBe('unknown');
    expect(step(inside, 'Work').errorBoundaries).toBeUndefined();
    expect(resolver.warnings).toHaveLength(1);
  });
});
