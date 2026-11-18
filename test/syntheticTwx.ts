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

/** The export as zip bytes. */
export async function syntheticTwxBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('META-INF/package.xml', PACKAGE_XML);
  zip.file(`objects/${BPD_ID}.xml`, BPD_OBJECT);
  zip.file(`objects/${PRICE_SERVICE_ID}.xml`, PRICE_SERVICE);
  zip.file(`objects/${DISCOUNT_SERVICE_ID}.xml`, DISCOUNT_SERVICE);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function syntheticTwxArchive(): Promise<TwxArchive> {
  return readTwxArchive(await syntheticTwxBytes(), SYNTHETIC_FILE);
}

export async function syntheticTwxPackage(): Promise<ProcessPackage> {
  return twxToProcessPackage(await syntheticTwxArchive());
}
