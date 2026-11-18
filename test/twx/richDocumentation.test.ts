// BAW keeps documentation as rich text: an HTML fragment with the STYLE block
// of its editor. This test writes such a fragment into the BPD of the
// synthetic export in memory, the way BAW stores it (escaped once in the
// BPMN2 model, once more in the object XML).

import { beforeAll, describe, expect, it } from 'vitest';
import type { Process, ProcessPackage } from '../../src/model/model';
import { twxToProcessPackage } from '../../src/twx/twxImport';
import { buildRenderMessage } from '../../src/views/viewModel';
import { DEFAULT_VIEW_OPTIONS } from '../../src/views/protocol';
import { BPD_ID, syntheticTwxArchive } from '../syntheticTwx';

const RICH =
  '<HTML><HEAD>\r\n<STYLE type=text/css> p{margin:0px;}</STYLE>\r\n</HEAD>\r\n' +
  '<BODY style="FONT-SIZE: 10pt; FONT-FAMILY: arial" bgColor=#f5f5f5>\r\n' +
  '<P>Asks the customer&nbsp;for their details.</P>\r\n<P>Amount &gt; 1000 needs<BR>a manager.</P>' +
  '<UL><LI>Name</LI><LI>Address</LI></UL></BODY></HTML>';
const PLAIN = 'Asks the customer for their details.\nAmount > 1000 needs\na manager.\n• Name\n• Address';

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A BPMN2 element as it appears inside the object XML. */
const doc = escapeXml(`<ns15:documentation>${escapeXml(RICH)}</ns15:documentation>`);

let pkg: ProcessPackage;
let main: Process;

beforeAll(async () => {
  const archive = await syntheticTwxArchive();
  let xml = archive.objects.get(BPD_ID)!;
  // The activity: right after the opening tag of the "Review Order" call.
  const call = xml.indexOf('name="Review Order"');
  const tagEnd = xml.indexOf('&gt;', call) + '&gt;'.length;
  expect(call).toBeGreaterThan(0);
  xml = xml.slice(0, tagEnd) + doc + xml.slice(tagEnd);
  // The process: its documentation element.
  const plain = escapeXml('<bpmn:documentation>Reviews an order and approves or rejects it.</bpmn:documentation>');
  expect(xml).toContain(plain);
  xml = xml.replace(plain, doc);
  archive.objects.set(BPD_ID, xml);

  pkg = await twxToProcessPackage(archive);
  main = pkg.processes.find((p) => p.name === 'Synthetic Order')!;
});

describe('rich text documentation in a TWX export', () => {
  it('reads the documentation of an activity as plain text', () => {
    const node = main.nodes.find((n) => n.name === 'Review Order')!;
    expect(node.documentation).toBe(PLAIN);
  });

  it('reads the documentation of the process as plain text', () => {
    expect(main.documentation).toBe(PLAIN);
  });

  it('sends no markup to the details panel', async () => {
    const msg = await buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS, false, 0, main.id);
    const json = JSON.stringify(msg);
    expect(json).toContain(JSON.stringify(PLAIN).slice(1, -1));
    expect(json).not.toMatch(/STYLE|<P>|<BR>|&nbsp;|margin:0px/i);
  });
});
