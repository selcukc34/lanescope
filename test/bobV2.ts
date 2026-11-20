// How test/fixtures/bob/order-delivery-process.v2.zip is made: Bob's
// order-delivery-process.zip with string edits that stand in for Bob
// generating the process again after a change. The file is Bob output, not a
// BAW export or customer data, so it is committed.
//
// Edits (each one must match exactly once, or this throws):
//   - user task "Manager Approval" is renamed "Manager Review" (same id);
//   - a new task "Notify Customer SF" (new ids) sits between "Auto Complete
//     Order SF" and "Order Auto Approved": the existing flow now ends at it
//     (and is named after it), a new flow leads on to the end event;
//   - "Lookup Country Info SF" is deleted: the "Valid" flow that led to it now
//     goes straight to "Determine Order Route SF", the flow out of it is gone;
//   - the condition of the AUTO_APPROVE flow changes;
//   - "Handle Exception" moves from the Operations Team lane to Order Manager;
//   - XSD: OrderRequest gains "priority" (string) and loses "countryRegion".
//
// test/diff/fixture.test.ts checks that the committed zip holds exactly what
// these edits give. To write it again (Node strips the types itself):
//   node test/bobV2.ts

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

export const BPMN_ENTRY = 'order-delivery-process.bpmn';
export const XSD_ENTRY = 'order-delivery-process.xsd';

/** Ids of what the edits add. */
export const NOTIFY_TASK_ID = 'bpmnid-7a1c3e52-9d4b-5f60-8e21-3b6d4c9f0a17';
export const NOTIFY_FLOW_ID = 'bpmnid-c2e4f6a8-1b3d-5e7f-9a0c-2d4f6b8e0a13';

/** The new AUTO_APPROVE condition, as the model reads it. */
export const AUTO_APPROVE_CONDITION_V2 = 'tw.local.order.route == "AUTO_APPROVE" && tw.local.order.amount < 5000';
const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LOOKUP_ID = 'bpmnid-2f75f6ec-8d61-5051-a66e-8991d93275c4';
const DETERMINE_ID = 'bpmnid-427f1aab-2bdc-55e4-a3c8-df633a0283bb';
const HANDLE_EXCEPTION_ID = 'bpmnid-1cd155ec-b9f0-5674-8cbc-dc437ae7f372';
const MANAGER_TASK_ID = 'bpmnid-8bb2f288-e134-5909-b32a-670be5367f60';
const ORDER_AUTO_APPROVED_ID = 'bpmnid-67f86bcf-88da-5527-8409-2ac71d8a7495';

/** Replaces the one occurrence of `from`; throws when there is none or more than one. */
function once(text: string, from: string | RegExp, to: string): string {
  const pattern = typeof from === 'string' ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(from.source, 'g');
  const hits = text.match(pattern)?.length ?? 0;
  if (hits !== 1) throw new Error(`Expected one match of ${String(from)}, found ${hits}`);
  return text.replace(pattern, () => to);
}

export function bpmnV2(v1: string): string {
  let s = v1;
  // Rename, same id.
  s = once(s, `<bpmn:userTask id="${MANAGER_TASK_ID}" name="Manager Approval">`, `<bpmn:userTask id="${MANAGER_TASK_ID}" name="Manager Review">`);

  // Delete "Lookup Country Info SF": its lane ref, the task, the flow out of it; "Valid" goes on to the route task.
  s = once(s, `        <bpmn:flowNodeRef>${LOOKUP_ID}</bpmn:flowNodeRef>\n`, '');
  s = once(s, new RegExp(`    <bpmn:task id="${LOOKUP_ID}"[\\s\\S]*?</bpmn:task>\\n`), '');
  s = once(s, / {4}<bpmn:sequenceFlow id="bpmnid-55557c35-a312-5272-83c7-9915529f1ad2"[^\n]*\n/, '');
  s = once(s, `name="Valid" sourceRef="bpmnid-0d14a4e7-bdfa-51a6-8cc6-67fc7e1720a4" targetRef="${LOOKUP_ID}"`, `name="Valid" sourceRef="bpmnid-0d14a4e7-bdfa-51a6-8cc6-67fc7e1720a4" targetRef="${DETERMINE_ID}"`);

  // New task between "Auto Complete Order SF" and "Order Auto Approved".
  s = once(
    s,
    `        <bpmn:flowNodeRef>${ORDER_AUTO_APPROVED_ID}</bpmn:flowNodeRef>\n`,
    `        <bpmn:flowNodeRef>${NOTIFY_TASK_ID}</bpmn:flowNodeRef>\n        <bpmn:flowNodeRef>${ORDER_AUTO_APPROVED_ID}</bpmn:flowNodeRef>\n`,
  );
  s = once(
    s,
    `    <bpmn:userTask id="${MANAGER_TASK_ID}"`,
    `    <bpmn:task id="${NOTIFY_TASK_ID}" name="Notify Customer SF" implementation="##unspecified" icp:serviceType="ServiceFlow">
      <bpmn:documentation>Sends the customer a confirmation that the order was completed automatically.</bpmn:documentation>
    </bpmn:task>
    <bpmn:userTask id="${MANAGER_TASK_ID}"`,
  );
  s = once(
    s,
    `name="To Order Auto Approved" sourceRef="bpmnid-5465527d-0510-5a5c-927a-0c51e08f6f41" targetRef="${ORDER_AUTO_APPROVED_ID}"/>`,
    `name="To Notify Customer SF" sourceRef="bpmnid-5465527d-0510-5a5c-927a-0c51e08f6f41" targetRef="${NOTIFY_TASK_ID}"/>
    <bpmn:sequenceFlow id="${NOTIFY_FLOW_ID}" name="To Order Auto Approved" sourceRef="${NOTIFY_TASK_ID}" targetRef="${ORDER_AUTO_APPROVED_ID}"/>`,
  );

  // Condition of AUTO_APPROVE.
  s = once(s, '>tw.local.order.route == "AUTO_APPROVE"</bpmn:conditionExpression>', `>${escapeXml(AUTO_APPROVE_CONDITION_V2)}</bpmn:conditionExpression>`);

  // "Handle Exception" moves to the Order Manager lane.
  s = once(s, `      <bpmn:lane id="bpmnid-fa56d999-2ae2-5bc2-aaed-ab7c5666dc09" name="Operations Team">
        <bpmn:flowNodeRef>${HANDLE_EXCEPTION_ID}</bpmn:flowNodeRef>
      </bpmn:lane>`, '      <bpmn:lane id="bpmnid-fa56d999-2ae2-5bc2-aaed-ab7c5666dc09" name="Operations Team"/>');
  s = once(
    s,
    '        <bpmn:flowNodeRef>bpmnid-8bb2f288-e134-5909-b32a-670be5367f60</bpmn:flowNodeRef>\n',
    `        <bpmn:flowNodeRef>bpmnid-8bb2f288-e134-5909-b32a-670be5367f60</bpmn:flowNodeRef>\n        <bpmn:flowNodeRef>${HANDLE_EXCEPTION_ID}</bpmn:flowNodeRef>\n`,
  );
  return s;
}

export function xsdV2(v1: string): string {
  let s = v1;
  s = once(s, '      <element name="countryRegion" type="string" minOccurs="0"/>\n', '');
  s = once(
    s,
    '      <element name="route" type="string" minOccurs="0"/>\n',
    '      <element name="route" type="string" minOccurs="0"/>\n      <element name="priority" type="string" minOccurs="0"/>\n',
  );
  return s;
}

/** The two entries of the v2 zip, from the entries of the v1 zip. */
export async function orderDeliveryV2(v1Zip: Uint8Array): Promise<{ bpmn: string; xsd: string }> {
  const zip = await JSZip.loadAsync(v1Zip);
  const bpmn = await zip.file(BPMN_ENTRY)?.async('string');
  const xsd = await zip.file(XSD_ENTRY)?.async('string');
  if (bpmn === undefined || xsd === undefined) throw new Error('The v1 zip does not hold the expected entries');
  return { bpmn: bpmnV2(bpmn), xsd: xsdV2(xsd) };
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bob');
export const V1_ZIP = path.join(FIXTURES, 'order-delivery-process.zip');
export const V2_ZIP = path.join(FIXTURES, 'order-delivery-process.v2.zip');

async function writeV2(): Promise<void> {
  const { bpmn, xsd } = await orderDeliveryV2(readFileSync(V1_ZIP));
  const zip = new JSZip();
  // A fixed date keeps the zip the same byte for byte when it is written again.
  const date = new Date(Date.UTC(2026, 10, 20, 12, 0, 0));
  zip.file(BPMN_ENTRY, bpmn, { date });
  zip.file(XSD_ENTRY, xsd, { date });
  writeFileSync(V2_ZIP, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  console.log(`Wrote ${V2_ZIP}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void writeV2();
}
