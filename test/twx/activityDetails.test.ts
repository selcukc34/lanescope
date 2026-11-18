// Activity details read from TWX exports: scripts, call-site data mappings,
// user task settings, timers, BPD variables and the BPD's own inputs and
// outputs. Expected values were checked against the local exports
// (../localFixtures; skipped when they are not there).

import { beforeAll, describe, expect, it } from 'vitest';
import type { FlowNode, Process, ProcessPackage } from '../../src/model/model';
import { readBpd } from '../../src/twx/bpdReader';
import { TwxResolver } from '../../src/twx/resolver';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

const REAL = hasLocalTwx('services', 'orderDelivery');

let services: ProcessPackage;
let orderDelivery: ProcessPackage;

beforeAll(async () => {
  if (!REAL) return;
  services = await readTwxPackage(localTwx('services'));
  orderDelivery = await readTwxPackage(localTwx('orderDelivery'));
});

function processOf(pkg: ProcessPackage, name: string): Process {
  const p = pkg.processes.find((x) => x.name === name);
  if (!p) throw new Error(`process "${name}" not found`);
  return p;
}

function nodeOf(p: Process, name: string): FlowNode {
  const n = p.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node "${name}" not found in ${p.name}`);
  return n;
}

describe.skipIf(!REAL)('script tasks', () => {
  it('reads the script of "Decide" in DemoChildProcess with entities decoded', () => {
    const decide = nodeOf(processOf(services, 'DemoChildProcess'), 'Decide');
    expect(decide.kind).toBe('scriptTask');
    expect(decide.originalType).toBe('scriptTask');
    expect(decide.script).toEqual({
      language: 'text/x-javascript',
      text: 'tw.local.approved = tw.local.amount < 1000;',
    });
  });

  it('reads the script of "Set Parameter" in MyFirstProcess', () => {
    const node = nodeOf(processOf(services, 'MyFirstProcess'), 'Set Parameter');
    expect(node.kind).toBe('scriptTask');
    expect(node.script?.text).toBe('tw.local.variable1 = "123";');
  });

  it('leaves out the script of a script task without one', () => {
    const init = nodeOf(processOf(services, 'MyProcess2'), 'init');
    expect(init.kind).toBe('scriptTask');
    expect(init.script).toBeUndefined();
  });
});

describe.skipIf(!REAL)('call-site data mappings', () => {
  it('maps every input and output of the DemoChildProcess call', () => {
    const call = nodeOf(processOf(services, 'Demo_MainProcess'), 'DemoChildProcess');
    expect(call.inputs.map((p) => [p.id, p.name, p.typeName])).toEqual([
      ['2007.33d901d3-f036-4fe1-b022-53f7d79b9929', 'orderId', 'String'],
      ['2007.bbf62d66-d429-463e-8b46-d1bc88f801f1', 'amount', 'Decimal'],
    ]);
    expect(call.inputMappings).toEqual([
      {
        parameterId: '2007.33d901d3-f036-4fe1-b022-53f7d79b9929',
        parameter: 'orderId',
        value: 'tw.local.orderId',
        mapped: true,
        literal: false,
      },
      {
        parameterId: '2007.bbf62d66-d429-463e-8b46-d1bc88f801f1',
        parameter: 'amount',
        value: 'tw.local.amount',
        mapped: true,
        literal: false,
      },
    ]);
    expect(call.outputMappings).toEqual([
      {
        parameterId: '2007.abb15afc-7cbb-4cc7-b7ff-0f80de4ed1f6',
        parameter: 'approved',
        value: 'tw.local.approved',
        mapped: true,
        literal: false,
      },
    ]);
  });

  it('shows amount as not mapped on "DemoChildProcess 1"', () => {
    const call = nodeOf(processOf(services, 'Demo_MainProcess'), 'DemoChildProcess 1');
    expect(call.inputMappings?.map((m) => [m.parameter, m.mapped, m.value])).toEqual([
      ['orderId', true, 'tw.local.orderId'],
      ['amount', false, undefined],
    ]);
    expect(call.outputMappings?.map((m) => [m.parameter, m.value])).toEqual([['approved', 'tw.local.approved']]);
  });

  it('reads ""text"" as a literal without its quotes, and a number in literal mode as a literal', () => {
    const routing = nodeOf(processOf(services, 'Demo_MainProcess'), 'Demo_Routing');
    expect(routing.inputMappings?.map((m) => [m.parameter, m.value, m.literal])).toEqual([
      ['amount', '10', true],
      ['region', 'EU', true],
    ]);
    const service = nodeOf(processOf(services, 'MyFirstProcess'), 'Service flow1');
    expect(service.inputMappings?.map((m) => [m.parameter, m.value, m.literal])).toEqual([
      ['input1', 'tw.local.variable1', false],
      ['input2', 'static', true],
    ]);
  });

  it('reads the empty literal """" as the empty text', () => {
    const service = nodeOf(processOf(services, 'JsSampleProcess'), 'Service flow1');
    expect(service.inputMappings?.find((m) => m.parameter === 'input2')).toMatchObject({
      value: '',
      mapped: true,
      literal: true,
    });
    // Its outputs are not mapped at all.
    expect(service.outputMappings?.map((m) => m.mapped)).toEqual([false, false, false]);
  });

  it('reads the order mapping of every call in the order delivery process, with no output mapping', () => {
    const p = processOf(orderDelivery, 'Order Delivery Process');
    const calls = p.nodes.filter((n) => n.calledElement !== undefined);
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.inputMappings).toEqual([
        { parameterId: call.inputs[0].id, parameter: 'order', value: 'tw.local.order', mapped: true, literal: false },
      ]);
      expect(call.outputMappings).toBeUndefined();
    }
  });
});

describe.skipIf(!REAL)('user task settings', () => {
  it('reads the subject of CSHS1 in JsSampleProcess', () => {
    const task = nodeOf(processOf(services, 'JsSampleProcess'), 'CSHS1');
    expect(task.userTask).toEqual({
      assignment: 'Lane',
      priority: 'Normal',
      dueDate: '1 Hours',
      subject: '<#= tw.local.subjectOnlyVar #>',
    });
  });

  it('reads the inline user tasks of the order delivery process', () => {
    const p = processOf(orderDelivery, 'Order Delivery Process');
    const tasks = p.nodes.filter((n) => n.kind === 'userTask');
    expect(tasks.map((t) => t.originalType)).toEqual(Array(3).fill('callActivity (InlineUserTask)'));
    for (const t of tasks) {
      // The priority element is empty in this export.
      expect(t.userTask).toEqual({ assignment: 'Lane', dueDate: '1 Hours' });
    }
  });

  it('does not attach user task settings to system tasks', () => {
    const service = nodeOf(processOf(services, 'Demo_MainProcess'), 'Demo_Routing');
    expect(service.kind).toBe('task');
    expect(service.userTask).toBeUndefined();
  });
});

describe.skipIf(!REAL)('timers', () => {
  it('reads the three timers of Demo_MainProcess', () => {
    const p = processOf(services, 'Demo_MainProcess');
    expect(nodeOf(p, 'Timer').timer).toEqual({ duration: '3', unit: 'Minutes' });
    expect(nodeOf(p, 'Timer 1').timer).toEqual({ duration: '2', unit: 'Days' });
    expect(nodeOf(p, 'Timer 2').timer).toEqual({ duration: 'tw.epv.DemoSettings.reminderMinutes', unit: 'Minutes' });
  });

  it('reads interrupting and repeating of a boundary timer', () => {
    const boundary = nodeOf(processOf(services, 'MyFirstProcess'), 'Boundary event 1');
    expect(boundary.timer).toEqual({ duration: '1', unit: 'Hours', interrupting: false, repeating: true });
  });

  it('leaves out timers on events without a timer definition', () => {
    const p = processOf(services, 'Demo_MainProcess');
    expect(nodeOf(p, 'Start').timer).toBeUndefined();
  });
});

describe.skipIf(!REAL)('process variables and parameters', () => {
  it('reads the eight variables of Demo_MainProcess with the default of amount and three tracked', () => {
    const p = processOf(services, 'Demo_MainProcess');
    expect(p.variables).toHaveLength(8);
    expect(p.variables?.map((v) => v.name)).toEqual([
      'orderId',
      'amount',
      'approved',
      'region',
      'latitude',
      'longitude',
      'startDate',
      'endDate',
    ]);
    expect(p.variables?.find((v) => v.name === 'amount')).toEqual({
      name: 'amount',
      typeRef: 'itm.12.536b2aa5-a30f-4eca-87fa-3a28066753ee',
      typeName: 'Decimal',
      isCollection: false,
      defaultValue: '0.0',
      tracked: true,
    });
    expect(p.variables?.filter((v) => v.defaultValue !== undefined).map((v) => v.name)).toEqual(['amount']);
    expect(p.variables?.filter((v) => v.tracked).map((v) => v.name)).toEqual(['orderId', 'amount', 'approved']);
    expect(p.variables?.find((v) => v.name === 'approved')?.typeName).toBe('Boolean');
    // The main process has no inputs or outputs of its own.
    expect(p.inputs).toBeUndefined();
    expect(p.outputs).toBeUndefined();
  });

  it('reads the inputs and outputs of DemoChildProcess from its ioSpecification', () => {
    const p = processOf(services, 'DemoChildProcess');
    expect(p.inputs?.map((i) => [i.name, i.typeName, i.isCollection])).toEqual([
      ['orderId', 'String', false],
      ['amount', 'Decimal', false],
    ]);
    expect(p.outputs?.map((o) => [o.name, o.typeName])).toEqual([['approved', 'String']]);
  });

  it('types the order delivery variable by its business object', () => {
    const p = processOf(orderDelivery, 'Order Delivery Process');
    expect(p.variables).toEqual([
      {
        name: 'order',
        typeRef: 'itm.12.b964fcb1-f000-494d-8fb1-a4e1785bb023',
        typeName: 'OrderRequest',
        isCollection: false,
        tracked: false,
      },
    ]);
  });

  it('does not count dataOutput elements inside event definitions as process outputs', () => {
    // MyFirstProcess has an error boundary event with dataOutput name="error".
    expect(processOf(services, 'MyFirstProcess').outputs).toBeUndefined();
  });

  it('reads the real exports without new warnings', () => {
    expect(services.warnings).toEqual([]);
    expect(orderDelivery.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic BPDs: forms the real exports do not have.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bpd(processBody: string): string {
  const model = `<ns15:definitions xmlns:ns15="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ns3="x3" xmlns:ns4="x4">
    <ns15:process name="P" id="25.p">${processBody}</ns15:process></ns15:definitions>`;
  return `<teamworks><bpd id="25.p" name="P"><bpmn2Data>${escape(model)}</bpmn2Data></bpd></teamworks>`;
}

const SERVICE = `<teamworks><process id="1.svc" name="Svc"><processType>12</processType>
  <processParameter name="a"><processParameterId>2055.a</processParameterId><parameterType>1</parameterType><seq>1</seq></processParameter>
  <processParameter name="b"><processParameterId>2055.b</processParameterId><parameterType>1</parameterType><seq>2</seq></processParameter>
</process></teamworks>`;

function read(processBody: string) {
  const result = readBpd(bpd(processBody), new TwxResolver(new Map([['1.svc', SERVICE]])));
  if (result.kind !== 'process') throw new Error(`not a process: ${result.kind}`);
  return result;
}

describe('synthetic BPDs', () => {
  it('keeps a script as parsed: CRLF becomes LF, nothing is trimmed', () => {
    const { process } = read(
      `<ns15:scriptTask scriptFormat="text/x-javascript" name="S" id="s"><ns15:script>  if (a &amp;&amp; b &lt; 2) {\r\n\tx = "&quot;";\r\n}\r\n</ns15:script></ns15:scriptTask>`,
    );
    expect(process.nodes[0].script).toEqual({
      language: 'text/x-javascript',
      text: '  if (a && b < 2) {\n\tx = """;\n}\n',
    });
  });

  it('reports a mapping mode it does not know and leaves that mapping out', () => {
    const { process, warnings } = read(`<ns15:callActivity calledElement="1.svc" name="Call" id="c">
      <ns15:extensionElements><ns4:activityType>ServiceTask</ns4:activityType></ns15:extensionElements>
      <ns15:dataInputAssociation><ns15:targetRef>2055.a</ns15:targetRef><ns15:assignment>
        <ns15:extensionElements><ns3:mappingMode>script</ns3:mappingMode></ns15:extensionElements>
        <ns15:from>x()</ns15:from></ns15:assignment></ns15:dataInputAssociation>
      <ns15:dataInputAssociation><ns15:targetRef>2055.b</ns15:targetRef><ns15:assignment>
        <ns15:from>tw.local.b</ns15:from></ns15:assignment></ns15:dataInputAssociation>
    </ns15:callActivity>`);
    expect(process.nodes[0].inputMappings?.map((m) => [m.parameter, m.mapped, m.value])).toEqual([
      ['a', false, undefined],
      ['b', true, 'tw.local.b'],
    ]);
    expect(warnings).toEqual([
      'BPD "P": "Call": the input mapping of parameter 2055.a has the unknown mapping mode "script" and is not shown.',
    ]);
  });

  it('reports an association without an assignment and one to a parameter the callee does not declare', () => {
    const { process, warnings } = read(`<ns15:callActivity calledElement="1.svc" name="Call" id="c">
      <ns15:extensionElements><ns4:activityType>ServiceTask</ns4:activityType></ns15:extensionElements>
      <ns15:dataInputAssociation><ns15:targetRef>2055.a</ns15:targetRef></ns15:dataInputAssociation>
      <ns15:dataInputAssociation><ns15:targetRef>2055.zzz</ns15:targetRef><ns15:assignment>
        <ns15:from>tw.local.z</ns15:from><ns15:to>tw.inputs.z</ns15:to></ns15:assignment></ns15:dataInputAssociation>
    </ns15:callActivity>`);
    expect(process.nodes[0].inputMappings).toEqual([
      { parameterId: '2055.a', parameter: 'a', mapped: false, literal: false },
      { parameterId: '2055.b', parameter: 'b', mapped: false, literal: false },
      { parameterId: '2055.zzz', parameter: 'z', value: 'tw.local.z', mapped: true, literal: false },
    ]);
    expect(warnings).toEqual([
      'BPD "P": "Call": an input mapping of an unknown form is not shown.',
      'BPD "P": "Call": the input mapping of parameter 2055.zzz names no input of the called element.',
    ]);
  });

  it('shows the mappings of a call whose callee is not in the export, without warnings', () => {
    const { process, warnings } = read(`<ns15:callActivity calledElement="1.toolkit" name="Call" id="c">
      <ns15:extensionElements><ns4:activityType>ServiceTask</ns4:activityType></ns15:extensionElements>
      <ns15:dataInputAssociation><ns15:targetRef>2055.q</ns15:targetRef><ns15:assignment>
        <ns15:from>""hello""</ns15:from><ns15:to>tw.inputs.greeting</ns15:to></ns15:assignment></ns15:dataInputAssociation>
    </ns15:callActivity>`);
    expect(process.nodes[0].inputMappings).toEqual([
      { parameterId: '2055.q', parameter: 'greeting', value: 'hello', mapped: true, literal: true },
    ]);
    expect(warnings).toEqual([]);
  });

  it('reports timer settings it does not know instead of showing them', () => {
    const { process, warnings } = read(`<ns15:intermediateCatchEvent name="T" id="t">
      <ns15:timerEventDefinition id="d"><ns15:extensionElements><ns4:timerEventSettings>
        <ns4:dateType>Custom</ns4:dateType><ns4:relativeDirection>AfterStart</ns4:relativeDirection>
        <ns4:relativeTime>5</ns4:relativeTime><ns4:relativeTimeResolution>Hours</ns4:relativeTimeResolution>
      </ns4:timerEventSettings></ns15:extensionElements></ns15:timerEventDefinition>
    </ns15:intermediateCatchEvent>`);
    expect(process.nodes[0].timer).toBeUndefined();
    expect(warnings).toEqual([
      'BPD "P": timer "T": timer settings with dateType "Custom" and relativeDirection "AfterStart" are not shown.',
    ]);
  });

  it('reports a due date of a type it does not know', () => {
    const { process, warnings } = read(`<ns15:callActivity calledElement="1.svc" name="U" id="u">
      <ns15:extensionElements><ns4:activityType>UserTask</ns4:activityType><ns4:userTaskSettings>
        <ns4:activityDueDate type="Script"><ns4:dueDate unit="Hours">x</ns4:dueDate></ns4:activityDueDate>
        <ns4:activityAssignmentType>Lane</ns4:activityAssignmentType>
      </ns4:userTaskSettings></ns15:extensionElements>
    </ns15:callActivity>`);
    expect(process.nodes[0].userTask).toEqual({ assignment: 'Lane' });
    expect(warnings).toEqual(['BPD "P": "U": the due date of type "Script" is not shown.']);
  });

  it('takes a default from the BPMN2 dataObject when the classic model has no variable', () => {
    const { process } = read(`<ns15:dataObject itemSubjectRef="itm.12.3fa0d7a0-828a-4d60-99cc-db5ed143fc2d" isCollection="true" name="n" id="v">
      <ns15:extensionElements><ns3:defaultValue useDefault="true">[1]</ns3:defaultValue><ns4:trackedField id="t" sname="n" path="."/></ns15:extensionElements>
    </ns15:dataObject>`);
    expect(process.variables).toEqual([
      {
        name: 'n',
        typeRef: 'itm.12.3fa0d7a0-828a-4d60-99cc-db5ed143fc2d',
        typeName: 'Integer',
        isCollection: true,
        defaultValue: '[1]',
        tracked: true,
      },
    ]);
  });
});
