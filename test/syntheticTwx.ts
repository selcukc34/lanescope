// A small TWX export built in memory, so the TWX readers are tested without
// real exports (CI has none, see ./localFixtures). The XML is written for
// these tests in the shape the readers expect; it holds no content from a
// real export or an IBM toolkit.
//
//   BPD "Synthetic Order"   lanes Customer (height 200) and System (height 160)
//     Customer: Start -> Review Order (system task calling "Price Order")
//     System:   Review Order -> Approved? -> Done | Rejected
//   service flow "Price Order"   Start -> Compute Total (script)
//                                -> Call Discount (calls "Apply Discount")
//                                -> Has Total? -> Priced | Unpriced
//   service flow "Apply Discount"   Start -> End
//
// With `subProcess`, the BPD also holds, in the System lane:
//   sub-process "Check Stock" between Review Order and Approved?
//     Check Start -> Count Items (boundary timer "Timeout") -> Reserve Items -> Check End
//     sub-process "Reserve Items": Reserve Start -> Reserve End
//   event sub-process "On Error": Error Start -> Error End
// BAW keeps the diagram of a sub-process as an object of its own
// (25.<sub-process id>, with parentBpdId); Check Stock and On Error have one,
// Reserve Items has none (its nodes have no positions).

import JSZip from 'jszip';
import { readTwxArchive, type TwxArchive } from '../src/twx/twxReader';
import { twxToProcessPackage } from '../src/twx/twxImport';
import type { ProcessPackage } from '../src/model/model';

export const SYNTHETIC_FILE = 'synthetic.twx';
export const BPD_ID = '25.00000000-0000-4000-8000-000000000001';
export const PRICE_SERVICE_ID = '1.00000000-0000-4000-8000-000000000002';
export const DISCOUNT_SERVICE_ID = '1.00000000-0000-4000-8000-000000000003';
/** System Data Decimal, which the export does not pack. */
const DECIMAL = '12.536b2aa5-a30f-4eca-87fa-3a28066753ee';

/** Escapes text content (BAW leaves quotes as they are in element text). */
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:package buildVersion="8.6.6" fixPack="0" xmlns:p="http://example.com/synthetic/package">
  <target>
    <project id="2066.syn" name="Synthetic App" shortName="SYN" isToolkit="false" isSystem="false"/>
    <branch id="2063.syn" name="Main"/>
    <snapshot id="2064.syn" name="1.0"/>
  </target>
  <dependencies/>
  <objects>
    <object id="${BPD_ID}" name="Synthetic Order" type="bpd"/>
    <object id="${PRICE_SERVICE_ID}" name="Price Order" type="process"/>
    <object id="${DISCOUNT_SERVICE_ID}" name="Apply Discount" type="process"/>
  </objects>
</p:package>`;

const vis = (x: number, y: number, width: number, height: number) =>
  `<extensionElements><nodeVisualInfo x="${x}" y="${y}" width="${width}" height="${height}"/></extensionElements>`;
const ports = (source: string, target: string) =>
  `<extensionElements><linkVisualInfo><sourcePortLocation>${source}</sourcePortLocation><targetPortLocation>${target}</targetPortLocation></linkVisualInfo></extensionElements>`;

/** The BPMN2 model of the BPD; positions are relative to the lane. */
const BPD_BPMN2 = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="defs">
  <bpmn:process id="${BPD_ID}" name="Synthetic Order">
    <bpmn:documentation>Reviews an order and approves or rejects it.</bpmn:documentation>
    <bpmn:laneSet id="laneSet">
      <bpmn:lane id="lane:customer" name="Customer">
        <bpmn:flowNodeRef>node:start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:review</bpmn:flowNodeRef>
        ${vis(0, 0, 900, 200)}
      </bpmn:lane>
      <bpmn:lane id="lane:system" name="System">
        <bpmn:flowNodeRef>node:gateway</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:done</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:rejected</bpmn:flowNodeRef>
        ${vis(0, 200, 900, 160)}
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="node:start" name="Start">${vis(60, 80, 24, 24)}</bpmn:startEvent>
    <bpmn:callActivity id="node:review" name="Review Order" calledElement="${PRICE_SERVICE_ID}">
      <bpmn:extensionElements>
        <nodeVisualInfo x="180" y="60" width="95" height="70"/>
        <activityType>ServiceTask</activityType>
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:exclusiveGateway id="node:gateway" name="Approved?" default="flow:rejected">${vis(400, 60, 32, 32)}</bpmn:exclusiveGateway>
    <bpmn:endEvent id="node:done" name="Done">${vis(560, 20, 24, 24)}</bpmn:endEvent>
    <bpmn:endEvent id="node:rejected" name="Rejected">${vis(560, 100, 24, 24)}</bpmn:endEvent>
    <bpmn:sequenceFlow id="flow:start" sourceRef="node:start" targetRef="node:review">${ports('rightCenter', 'leftCenter')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="flow:review" sourceRef="node:review" targetRef="node:gateway">${ports('bottomCenter', 'topCenter')}</bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="flow:done" name="yes" sourceRef="node:gateway" targetRef="node:done">
      ${ports('rightCenter', 'leftCenter')}
      <bpmn:conditionExpression>tw.local.approved == true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="flow:rejected" name="no" sourceRef="node:gateway" targetRef="node:rejected">${ports('bottomCenter', 'leftCenter')}</bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;

const flowObject = (id: string, x: number, y: number) =>
  `<flowObject id="${id}"><position><location x="${x}" y="${y}"/></position></flowObject>`;

/** The BPD object: the escaped BPMN2 model and the classic model (lanes, heights, positions). */
const BPD_OBJECT = `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <bpd id="${BPD_ID}" name="Synthetic Order">
    <bpmn2Data>${escapeXml(BPD_BPMN2)}</bpmn2Data>
    <BusinessProcessDiagram id="diagram">
      <pool id="pool">
        <name>Pool</name>
        <dimension><size w="900" h="360"/></dimension>
        <lane id="lane:customer">
          <name>Customer</name>
          <height>200</height>
          ${flowObject('node:start', 60, 80)}
          ${flowObject('node:review', 180, 60)}
        </lane>
        <lane id="lane:system">
          <name>System</name>
          <height>160</height>
          ${flowObject('node:gateway', 400, 60)}
          ${flowObject('node:done', 560, 20)}
          ${flowObject('node:rejected', 560, 100)}
        </lane>
      </pool>
    </BusinessProcessDiagram>
  </bpd>
</teamworks>`;

const parameter = (id: string, name: string, type: 1 | 2, seq: number) =>
  `<processParameter name="${name}"><processParameterId>${id}</processParameterId><parameterType>${type}</parameterType><classId>${DECIMAL}</classId><isArrayOf>false</isArrayOf><seq>${seq}</seq></processParameter>`;

/** A service flow with a script, a call and a gateway; positions are absolute. */
const PRICE_SERVICE = `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <process id="${PRICE_SERVICE_ID}" name="Price Order">
    <processType>12</processType>
    ${parameter('2055.amount', 'amount', 1, 1)}
    ${parameter('2055.total', 'total', 2, 2)}
    <bpmn2Model>
      <ns3:definitions xmlns:ns3="http://www.omg.org/spec/BPMN/20100524/MODEL">
        <ns3:process id="price">
          <ns3:dataObject id="var:discount" name="discount" itemSubjectRef="${DECIMAL}"/>
          <ns3:startEvent id="svc:start" name="Start">${vis(40, 100, 24, 24)}</ns3:startEvent>
          <ns3:scriptTask id="svc:script" name="Compute Total" scriptFormat="text/x-javascript">
            ${vis(120, 80, 95, 70)}
            <ns3:script>tw.local.total = tw.local.amount * 1.2;</ns3:script>
          </ns3:scriptTask>
          <ns3:callActivity id="svc:call" name="Call Discount" calledElement="${DISCOUNT_SERVICE_ID}">
            <ns3:extensionElements>
              <nodeVisualInfo x="270" y="80" width="95" height="70"/>
              <activityType>CalledProcess</activityType>
            </ns3:extensionElements>
          </ns3:callActivity>
          <ns3:exclusiveGateway id="svc:gateway" name="Has Total?" default="svc:flow:unpriced">${vis(420, 99, 32, 32)}</ns3:exclusiveGateway>
          <ns3:endEvent id="svc:priced" name="Priced">${vis(520, 50, 24, 24)}</ns3:endEvent>
          <ns3:endEvent id="svc:unpriced" name="Unpriced">${vis(520, 150, 24, 24)}</ns3:endEvent>
          <ns3:sequenceFlow id="svc:flow:start" sourceRef="svc:start" targetRef="svc:script"/>
          <ns3:sequenceFlow id="svc:flow:script" sourceRef="svc:script" targetRef="svc:call"/>
          <ns3:sequenceFlow id="svc:flow:call" sourceRef="svc:call" targetRef="svc:gateway"/>
          <ns3:sequenceFlow id="svc:flow:priced" sourceRef="svc:gateway" targetRef="svc:priced">
            <ns3:conditionExpression>tw.local.total\t&gt;\t0</ns3:conditionExpression>
          </ns3:sequenceFlow>
          <ns3:sequenceFlow id="svc:flow:unpriced" sourceRef="svc:gateway" targetRef="svc:unpriced"/>
        </ns3:process>
      </ns3:definitions>
    </bpmn2Model>
  </process>
</teamworks>`;

/** The service that "Call Discount" calls: positions from the classic model only. */
const DISCOUNT_SERVICE = `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <process id="${DISCOUNT_SERVICE_ID}" name="Apply Discount">
    <processType>12</processType>
    <startPoint><layoutData x="40" y="60"/></startPoint>
    <item><processItemId>2025.disc:end</processItemId><layoutData x="200" y="60"/></item>
    <bpmn2Model>
      <definitions>
        <process id="discount">
          <startEvent id="disc:start" name="Start"/>
          <endEvent id="disc:end" name="End"/>
          <sequenceFlow id="disc:flow" sourceRef="disc:start" targetRef="disc:end"/>
        </process>
      </definitions>
    </bpmn2Model>
  </process>
</teamworks>`;

/** Ids of the sub-processes of the `subProcess` variant (UUIDs, as BAW writes them). */
export const CHECK_STOCK_ID = '00000000-0000-4000-8000-0000000000c1';
export const ON_ERROR_ID = '00000000-0000-4000-8000-0000000000c2';

const SUB_PROCESSES_BPMN2 = `
    <bpmn:subProcess id="${CHECK_STOCK_ID}" name="Check Stock">
      ${vis(480, 50, 95, 70)}
      <bpmn:startEvent id="node:check-start" name="Check Start">${vis(25, 80, 24, 24)}</bpmn:startEvent>
      <bpmn:scriptTask id="node:count" name="Count Items">
        ${vis(150, 57, 95, 70)}
        <bpmn:script>tw.local.count = 1;</bpmn:script>
      </bpmn:scriptTask>
      <bpmn:boundaryEvent id="node:timeout" name="Timeout" attachedToRef="node:count">${vis(200, 110, 24, 24)}</bpmn:boundaryEvent>
      <bpmn:subProcess id="node:reserve" name="Reserve Items">
        ${vis(320, 57, 95, 70)}
        <bpmn:startEvent id="node:reserve-start" name="Reserve Start"/>
        <bpmn:endEvent id="node:reserve-end" name="Reserve End"/>
        <bpmn:sequenceFlow id="flow:reserve" sourceRef="node:reserve-start" targetRef="node:reserve-end"/>
      </bpmn:subProcess>
      <bpmn:endEvent id="node:check-end" name="Check End">${vis(500, 80, 24, 24)}</bpmn:endEvent>
      <bpmn:sequenceFlow id="flow:check-1" sourceRef="node:check-start" targetRef="node:count"/>
      <bpmn:sequenceFlow id="flow:check-2" sourceRef="node:count" targetRef="node:reserve"/>
      <bpmn:sequenceFlow id="flow:check-3" sourceRef="node:reserve" targetRef="node:check-end"/>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="flow:check" sourceRef="${CHECK_STOCK_ID}" targetRef="node:gateway"/>
    <bpmn:subProcess id="${ON_ERROR_ID}" name="On Error" triggeredByEvent="true">
      ${vis(700, 20, 95, 70)}
      <bpmn:startEvent id="node:error-start" name="Error Start">${vis(25, 80, 24, 24)}</bpmn:startEvent>
      <bpmn:endEvent id="node:error-end" name="Error End">${vis(300, 80, 24, 24)}</bpmn:endEvent>
      <bpmn:sequenceFlow id="flow:error" sourceRef="node:error-start" targetRef="node:error-end"/>
    </bpmn:subProcess>`;

/** The diagram object BAW keeps for a sub-process: one pool, one lane, the nodes directly inside. */
const subProcessObject = (id: string, name: string, flowObjects: string) => `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <bpd id="25.${id}" name="Synthetic Order_${name}">
    <bpmn2Data isNull="true"/>
    <parentBpdId>${BPD_ID}</parentBpdId>
    <BusinessProcessDiagram id="diagram-${id}">
      <pool id="pool-${id}">
        <name>Pool</name>
        <dimension><size w="3000" h="200"/></dimension>
        <lane id="lane-${id}">
          <name>All Users</name>
          <height>200</height>
          ${flowObjects}
        </lane>
      </pool>
    </BusinessProcessDiagram>
  </bpd>
</teamworks>`;

const CHECK_STOCK_OBJECT = subProcessObject(
  CHECK_STOCK_ID,
  'Check Stock',
  `${flowObject('node:check-start', 25, 80)}
          <flowObject id="node:count"><position><location x="150" y="57"/></position><attachedEvent id="node:timeout"/></flowObject>
          ${flowObject('node:reserve', 320, 57)}
          ${flowObject('node:check-end', 500, 80)}`,
);

const ON_ERROR_OBJECT = subProcessObject(ON_ERROR_ID, 'On Error', `${flowObject('node:error-start', 25, 80)}
          ${flowObject('node:error-end', 300, 80)}`);

/** The BPD with the sub-processes: Check Stock goes between Review Order and Approved?. */
function withSubProcesses(bpdObject: string): string {
  const bpmn2 = BPD_BPMN2.replace('sourceRef="node:review" targetRef="node:gateway"', `sourceRef="node:review" targetRef="${CHECK_STOCK_ID}"`)
    .replace('<bpmn:flowNodeRef>node:gateway</bpmn:flowNodeRef>', `<bpmn:flowNodeRef>${CHECK_STOCK_ID}</bpmn:flowNodeRef><bpmn:flowNodeRef>${ON_ERROR_ID}</bpmn:flowNodeRef><bpmn:flowNodeRef>node:gateway</bpmn:flowNodeRef>`)
    .replace('  </bpmn:process>', `${SUB_PROCESSES_BPMN2}\n  </bpmn:process>`);
  return bpdObject
    .replace(escapeXml(BPD_BPMN2), escapeXml(bpmn2))
    .replace(`${flowObject('node:gateway', 400, 60)}`, `${flowObject(CHECK_STOCK_ID, 480, 50)}${flowObject(ON_ERROR_ID, 700, 20)}${flowObject('node:gateway', 400, 60)}`);
}

/** Id of the BPD in the variant with other ids. */
export const OTHER_BPD_ID = '25.00000000-0000-4000-8000-0000000000b2';

export interface SyntheticOptions {
  /**
   * The same BPD with every BPD, node, flow and lane id changed, as BAW may
   * give it in another export: the comparison must pair it by names.
   */
  otherIds?: boolean;
  /** The BPD with a sub-process (with a nested one) and an event sub-process, and their diagram objects. */
  subProcess?: boolean;
}

const withOtherIds = (xml: string) => xml.replaceAll(BPD_ID, OTHER_BPD_ID).replace(/\b(node|flow|lane):/g, '$1-b2:');

/** The export as zip bytes. */
export async function syntheticTwxBytes(options: SyntheticOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const bpdId = options.otherIds ? OTHER_BPD_ID : BPD_ID;
  zip.file('META-INF/package.xml', options.otherIds ? withOtherIds(PACKAGE_XML) : PACKAGE_XML);
  const bpd = options.subProcess ? withSubProcesses(BPD_OBJECT) : BPD_OBJECT;
  zip.file(`objects/${bpdId}.xml`, options.otherIds ? withOtherIds(bpd) : bpd);
  if (options.subProcess) {
    zip.file(`objects/25.${CHECK_STOCK_ID}.xml`, CHECK_STOCK_OBJECT);
    zip.file(`objects/25.${ON_ERROR_ID}.xml`, ON_ERROR_OBJECT);
  }
  zip.file(`objects/${PRICE_SERVICE_ID}.xml`, PRICE_SERVICE);
  zip.file(`objects/${DISCOUNT_SERVICE_ID}.xml`, DISCOUNT_SERVICE);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function syntheticTwxArchive(options: SyntheticOptions = {}): Promise<TwxArchive> {
  return readTwxArchive(await syntheticTwxBytes(options), SYNTHETIC_FILE);
}

export async function syntheticTwxPackage(options: SyntheticOptions = {}): Promise<ProcessPackage> {
  return twxToProcessPackage(await syntheticTwxArchive(options));
}
