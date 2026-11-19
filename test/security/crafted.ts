// Hostile inputs for the security tests, built in memory. All XML here is
// written by hand for these tests; nothing is taken from a real export or an
// IBM toolkit.
//
//   craftedBpmn()   a Bob-style .bpmn whose names, lane, condition, flow name
//                   and documentation carry PAYLOAD, with a script task
//                   holding SCRIPT_MARKER
//   craftedBobZip() that .bpmn plus an .xsd whose documentation is PAYLOAD
//   craftedTwx()    a TWX: a BPD (lanes, script task, call, gateway) and the
//                   service flow it calls (script step, call step), all named
//                   with PAYLOAD, scripts holding SCRIPT_MARKER, rich (HTML)
//                   documentation RICH_DOC
//   zip helpers     building archives and patching their headers

import JSZip from 'jszip';

/** Text that would run or load something if it were ever parsed as HTML. */
export const PAYLOAD =
  `<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">j</a></textarea><svg onload=alert(4)>&amp;"'`;

/** Unique text that only ever appears inside script bodies. */
export const SCRIPT_MARKER = 'LANESCOPE_SCRIPT_MARKER_9d41c7';

/** Rich documentation as BAW stores it, with everything a sanitiser has to drop. */
export const RICH_DOC =
  '<html><head><title>T</title></head><body><style>p { color: red }</style>' +
  '<p>Visible <b>text</b><img src=x onerror="alert(1)>x"></p>' +
  '<script type="text/javascript">alert(2)</script>' +
  '<a href="javascript:alert(3)" onclick=\'alert(4)\'>link</a>' +
  '<iframe srcdoc="<script>alert(5)</script>"></iframe><!-- <script>alert(6)</script> --></body></html>';

export const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

/** A Bob-style BPMN document. `prolog` goes before the root element (e.g. a DOCTYPE). */
export function craftedBpmn(prolog = ''): string {
  const n = escAttr(PAYLOAD);
  return `<?xml version="1.0" encoding="UTF-8"?>${prolog}
<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs" targetNamespace="http://example.com/crafted" exporter="crafted" exporterVersion="1">
  <bpmn:import importType="http://www.w3.org/2001/XMLSchema" location="types.xsd" namespace="http://example.com/types"/>
  <bpmn:process id="proc" name="${n}">
    <bpmn:documentation>${escText(PAYLOAD)}</bpmn:documentation>
    <bpmn:laneSet id="ls">
      <bpmn:lane id="lane1" name="${n}">
        <bpmn:flowNodeRef>start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>script</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>gw</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>end1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>end2</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="start" name="${n}"/>
    <bpmn:scriptTask id="script" name="${n}" scriptFormat="text/x-javascript">
      <bpmn:documentation>${escText(PAYLOAD)}</bpmn:documentation>
      <bpmn:script><![CDATA[// <!DOCTYPE html> in a script is text, not a declaration
tw.local.x = "${SCRIPT_MARKER}";]]></bpmn:script>
    </bpmn:scriptTask>
    <bpmn:exclusiveGateway id="gw" name="${n}" default="f3"/>
    <bpmn:endEvent id="end1" name="${n}"/>
    <bpmn:endEvent id="end2" name="${n}"/>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="script"/>
    <bpmn:sequenceFlow id="f2" name="${n}" sourceRef="script" targetRef="gw"/>
    <bpmn:sequenceFlow id="f3" name="${n}" sourceRef="gw" targetRef="end1"/>
    <bpmn:sequenceFlow id="f4" name="${n}" sourceRef="gw" targetRef="end2">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${escText(PAYLOAD)}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;
}

export function craftedXsd(prolog = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${prolog}
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://example.com/types">
  <xs:complexType name="Order">
    <xs:annotation><xs:documentation>${escText(PAYLOAD)}</xs:documentation></xs:annotation>
    <xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence>
  </xs:complexType>
</xs:schema>`;
}

export async function craftedBobZip(): Promise<Uint8Array> {
  return zipOf({ 'crafted.bpmn': craftedBpmn(), 'types.xsd': craftedXsd() });
}

// ---------------------------------------------------------------------------
// TWX

export const BPD_ID = '25.00000000-0000-4000-8000-0000000000a1';
export const SERVICE_ID = '1.00000000-0000-4000-8000-0000000000a2';
export const INNER_SERVICE_ID = '1.00000000-0000-4000-8000-0000000000a3';

const vis = (x: number, y: number, w: number, h: number) =>
  `<extensionElements><nodeVisualInfo x="${x}" y="${y}" width="${w}" height="${h}"/></extensionElements>`;

function bpdBpmn2(): string {
  const n = escAttr(PAYLOAD);
  return `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="defs">
  <bpmn:process id="${BPD_ID}" name="${n}">
    <bpmn:documentation>${escText(RICH_DOC)}</bpmn:documentation>
    <bpmn:laneSet id="laneSet">
      <bpmn:lane id="lane:a" name="${n}">
        <bpmn:flowNodeRef>node:start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:script</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:call</bpmn:flowNodeRef>
        ${vis(0, 0, 900, 200)}
      </bpmn:lane>
      <bpmn:lane id="lane:b" name="${n}">
        <bpmn:flowNodeRef>node:gw</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:end1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>node:end2</bpmn:flowNodeRef>
        ${vis(0, 200, 900, 160)}
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="node:start" name="${n}">${vis(40, 80, 24, 24)}</bpmn:startEvent>
    <bpmn:scriptTask id="node:script" name="${n}" scriptFormat="text/x-javascript">
      ${vis(120, 60, 95, 70)}
      <bpmn:documentation>${escText(RICH_DOC)}</bpmn:documentation>
      <bpmn:script>tw.local.a = "${SCRIPT_MARKER}";</bpmn:script>
    </bpmn:scriptTask>
    <bpmn:callActivity id="node:call" name="${n}" calledElement="${SERVICE_ID}">
      <bpmn:extensionElements>
        <nodeVisualInfo x="280" y="60" width="95" height="70"/>
        <activityType>ServiceTask</activityType>
      </bpmn:extensionElements>
    </bpmn:callActivity>
    <bpmn:exclusiveGateway id="node:gw" name="${n}" default="flow:no">${vis(420, 60, 32, 32)}</bpmn:exclusiveGateway>
    <bpmn:endEvent id="node:end1" name="${n}">${vis(560, 20, 24, 24)}</bpmn:endEvent>
    <bpmn:endEvent id="node:end2" name="${n}">${vis(560, 100, 24, 24)}</bpmn:endEvent>
    <bpmn:sequenceFlow id="flow:1" sourceRef="node:start" targetRef="node:script"/>
    <bpmn:sequenceFlow id="flow:2" sourceRef="node:script" targetRef="node:call"/>
    <bpmn:sequenceFlow id="flow:3" sourceRef="node:call" targetRef="node:gw"/>
    <bpmn:sequenceFlow id="flow:yes" name="${n}" sourceRef="node:gw" targetRef="node:end1">
      <bpmn:conditionExpression>${escText(PAYLOAD)}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="flow:no" name="${n}" sourceRef="node:gw" targetRef="node:end2"/>
  </bpmn:process>
</bpmn:definitions>`;
}

const flowObject = (id: string, x: number, y: number) =>
  `<flowObject id="${id}"><position><location x="${x}" y="${y}"/></position></flowObject>`;

function bpdObject(prolog: string): string {
  const n = escText(PAYLOAD);
  return `<?xml version="1.0" encoding="UTF-8"?>${prolog}
<teamworks>
  <bpd id="${BPD_ID}" name="${escAttr(PAYLOAD)}">
    <bpmn2Data>${escText(bpdBpmn2())}</bpmn2Data>
    <BusinessProcessDiagram id="diagram">
      <pool id="pool">
        <name>${n}</name>
        <dimension><size w="900" h="360"/></dimension>
        <lane id="lane:a">
          <name>${n}</name>
          <height>200</height>
          ${flowObject('node:start', 40, 80)}
          ${flowObject('node:script', 120, 60)}
          ${flowObject('node:call', 280, 60)}
        </lane>
        <lane id="lane:b">
          <name>${n}</name>
          <height>160</height>
          ${flowObject('node:gw', 420, 60)}
          ${flowObject('node:end1', 560, 20)}
          ${flowObject('node:end2', 560, 100)}
        </lane>
      </pool>
    </BusinessProcessDiagram>
  </bpd>
</teamworks>`;
}

/** The service the BPD calls: a script step, a call step and a gateway, named with PAYLOAD. */
function serviceObject(): string {
  const n = escAttr(PAYLOAD);
  return `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <process id="${SERVICE_ID}" name="${n}">
    <processType>12</processType>
    <bpmn2Model>
      <ns3:definitions xmlns:ns3="${BPMN_NS}">
        <ns3:process id="svc">
          <ns3:documentation>${escText(RICH_DOC)}</ns3:documentation>
          <ns3:startEvent id="svc:start" name="${n}">${vis(40, 100, 24, 24)}</ns3:startEvent>
          <ns3:scriptTask id="svc:script" name="${n}" scriptFormat="text/x-javascript">
            ${vis(120, 80, 95, 70)}
            <ns3:script>tw.local.b = "${SCRIPT_MARKER}";</ns3:script>
          </ns3:scriptTask>
          <ns3:callActivity id="svc:call" name="${n}" calledElement="${INNER_SERVICE_ID}">
            <ns3:extensionElements>
              <nodeVisualInfo x="270" y="80" width="95" height="70"/>
              <activityType>CalledProcess</activityType>
            </ns3:extensionElements>
          </ns3:callActivity>
          <ns3:exclusiveGateway id="svc:gw" name="${n}" default="svc:f:no">${vis(420, 99, 32, 32)}</ns3:exclusiveGateway>
          <ns3:endEvent id="svc:end1" name="${n}">${vis(520, 50, 24, 24)}</ns3:endEvent>
          <ns3:endEvent id="svc:end2" name="${n}">${vis(520, 150, 24, 24)}</ns3:endEvent>
          <ns3:sequenceFlow id="svc:f:1" sourceRef="svc:start" targetRef="svc:script"/>
          <ns3:sequenceFlow id="svc:f:2" sourceRef="svc:script" targetRef="svc:call"/>
          <ns3:sequenceFlow id="svc:f:3" sourceRef="svc:call" targetRef="svc:gw"/>
          <ns3:sequenceFlow id="svc:f:yes" name="${n}" sourceRef="svc:gw" targetRef="svc:end1">
            <ns3:conditionExpression>${escText(PAYLOAD)}</ns3:conditionExpression>
          </ns3:sequenceFlow>
          <ns3:sequenceFlow id="svc:f:no" sourceRef="svc:gw" targetRef="svc:end2"/>
        </ns3:process>
      </ns3:definitions>
    </bpmn2Model>
  </process>
</teamworks>`;
}

/** The service the service's call step calls: one more script, one level further down. */
function innerServiceObject(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<teamworks>
  <process id="${INNER_SERVICE_ID}" name="${escAttr(PAYLOAD)}">
    <processType>12</processType>
    <bpmn2Model>
      <ns3:definitions xmlns:ns3="${BPMN_NS}">
        <ns3:process id="inner">
          <ns3:startEvent id="in:start" name="${escAttr(PAYLOAD)}">${vis(40, 100, 24, 24)}</ns3:startEvent>
          <ns3:scriptTask id="in:script" name="${escAttr(PAYLOAD)}" scriptFormat="text/x-javascript">
            ${vis(120, 80, 95, 70)}
            <ns3:script>tw.local.c = "${SCRIPT_MARKER}";</ns3:script>
          </ns3:scriptTask>
          <ns3:endEvent id="in:end" name="${escAttr(PAYLOAD)}">${vis(300, 100, 24, 24)}</ns3:endEvent>
          <ns3:sequenceFlow id="in:f:1" sourceRef="in:start" targetRef="in:script"/>
          <ns3:sequenceFlow id="in:f:2" sourceRef="in:script" targetRef="in:end"/>
        </ns3:process>
      </ns3:definitions>
    </bpmn2Model>
  </process>
</teamworks>`;
}

function packageXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:package buildVersion="8.6.6" xmlns:p="http://example.com/crafted/package">
  <target>
    <project id="2066.crafted" name="${escAttr(PAYLOAD)}" shortName="CR" isToolkit="false" isSystem="false"/>
    <branch id="2063.crafted" name="Main"/>
    <snapshot id="2064.crafted" name="${escAttr(PAYLOAD)}"/>
  </target>
  <dependencies/>
  <objects>
    <object id="${BPD_ID}" name="${escAttr(PAYLOAD)}" type="bpd"/>
    <object id="${SERVICE_ID}" name="${escAttr(PAYLOAD)}" type="process"/>
    <object id="${INNER_SERVICE_ID}" name="${escAttr(PAYLOAD)}" type="process"/>
  </objects>
</p:package>`;
}

export interface CraftedTwxOptions {
  /** Goes before the root element of the BPD object (e.g. a DOCTYPE). */
  bpdProlog?: string;
  /** Extra entries, by name. */
  extra?: Record<string, string | Uint8Array>;
}

export async function craftedTwx(options: CraftedTwxOptions = {}): Promise<Uint8Array> {
  return zipOf({
    'META-INF/package.xml': packageXml(),
    [`objects/${BPD_ID}.xml`]: bpdObject(options.bpdProlog ?? ''),
    [`objects/${SERVICE_ID}.xml`]: serviceObject(),
    [`objects/${INNER_SERVICE_ID}.xml`]: innerServiceObject(),
    ...options.extra,
  });
}

// ---------------------------------------------------------------------------
// Zip helpers

export async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** Bytes that deflate to almost nothing: `size` zero bytes. */
export const zeros = (size: number) => new Uint8Array(size);

/**
 * Rewrites, in the central directory and the local header of the entry
 * `name`, its declared uncompressed size and/or its CRC-32. Archives can
 * lie about both; the readers must not trust them.
 */
export function patchEntry(data: Uint8Array, name: string, patch: { size?: number; crc32?: number }): Uint8Array {
  const out = new Uint8Array(data);
  const view = new DataView(out.buffer);
  const encoded = new TextEncoder().encode(name);
  let patched = false;
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    const entryName = out.subarray(i + 46, i + 46 + nameLength);
    if (entryName.length !== encoded.length || !entryName.every((b, k) => b === encoded[k])) continue;
    const local = view.getUint32(i + 42, true);
    if (patch.crc32 !== undefined) {
      view.setUint32(i + 16, patch.crc32 >>> 0, true);
      view.setUint32(local + 14, patch.crc32 >>> 0, true);
    }
    if (patch.size !== undefined) {
      view.setUint32(i + 24, patch.size, true);
      view.setUint32(local + 22, patch.size, true);
    }
    patched = true;
  }
  if (!patched) throw new Error(`entry ${name} not found`);
  return out;
}
