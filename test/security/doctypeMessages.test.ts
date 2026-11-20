// What the user is told when a document is rejected for its DOCTYPE: the
// object or file is named (never its content), a file with nothing left to
// show fails with that reason, and a file that still opens lists what was
// skipped in the Warnings tab. All inputs are built in memory.

import { describe, expect, it } from 'vitest';
import { readBpmnZip, type BpmnPackageInput } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import { readTwxArchive } from '../../src/twx/twxReader';
import { twxToProcessPackage } from '../../src/twx/twxImport';
import { BPD_ID, craftedBpmn, craftedTwx, craftedXsd, zipOf } from './crafted';

const DOCTYPE = '<!DOCTYPE root [<!ENTITY secret "SECRET_ENTITY_TEXT">]>';
/** A second BPD object of the export, rejected for its DOCTYPE. */
const REJECTED_BPD = `<?xml version="1.0"?>${DOCTYPE}<teamworks><bpd id="x" name="SECRET_BPD_TEXT"/></teamworks>`;
const OPEN_ERROR = /^Lanescope could not open this file: .+ contains? a DOCTYPE declaration, which is rejected for security reasons \(XML entity expansion\)\. Export the process again without a DOCTYPE\.$/;

const twx = async (options: Parameters<typeof craftedTwx>[0]) =>
  twxToProcessPackage(await readTwxArchive(await craftedTwx(options), 'crafted.twx'));

/** The error message of a rejected promise. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the read to fail');
}

describe('TWX objects with a DOCTYPE', () => {
  it('an export whose only BPD has one fails with that reason, not "no BPD found"', async () => {
    const message = await failure(twx({ bpdProlog: DOCTYPE }));
    expect(message).toMatch(OPEN_ERROR);
    expect(message).toContain(`(objects/${BPD_ID}.xml) contains a DOCTYPE`);
    expect(message).not.toContain('business process definition');
    expect(message).not.toContain('SECRET_ENTITY_TEXT');
  });

  it('names the first rejected BPD and counts the others', async () => {
    const message = await failure(twx({ bpdProlog: DOCTYPE, extra: { 'objects/25.rejected.xml': REJECTED_BPD } }));
    expect(message).toMatch(OPEN_ERROR);
    expect(message).toMatch(/: .+ and 1 more contain a DOCTYPE declaration/);
  });

  it('an export with another readable BPD opens, with one warning that lists what was skipped', async () => {
    const pkg = await twx({ extra: { 'objects/25.rejected.xml': REJECTED_BPD } });
    expect(pkg.processes).toHaveLength(1);
    const doctype = pkg.warnings.filter((w) => w.includes('DOCTYPE'));
    expect(doctype).toEqual([
      '1 object was skipped because it contains a DOCTYPE declaration (rejected for security reasons): objects/25.rejected.xml.',
    ]);
    expect(pkg.warnings.join('\n')).not.toMatch(/SECRET_(ENTITY|BPD)_TEXT/);
  });

  it('a rejected service or business object is listed too', async () => {
    const pkg = await twx({ extra: { 'objects/12.rejected.xml': `${DOCTYPE}<teamworks/>`, 'objects/25.rejected.xml': REJECTED_BPD } });
    const [warning] = pkg.warnings.filter((w) => w.includes('DOCTYPE'));
    expect(warning).toBe(
      '2 objects were skipped because they contain a DOCTYPE declaration (rejected for security reasons): objects/25.rejected.xml, objects/12.rejected.xml.',
    );
  });
});

describe('Bob output with a DOCTYPE', () => {
  const bpmnFile = (bpmnText: string): BpmnPackageInput => ({
    path: '/work/order.bpmn',
    format: 'bpmn',
    bpmnFileName: 'order.bpmn',
    bpmnText,
    xsdFiles: {},
  });

  it('a .bpmn file with one fails with that reason, naming the file', async () => {
    const message = await failure(readProcessPackage(bpmnFile(craftedBpmn(DOCTYPE))));
    expect(message).toMatch(OPEN_ERROR);
    expect(message).toContain(': order.bpmn contains a DOCTYPE');
    expect(message).not.toContain('SECRET_ENTITY_TEXT');
  });

  it('a .bpmn inside a zip with one fails with that reason, naming the entry path', async () => {
    const zip = await zipOf({ 'models/order.bpmn': craftedBpmn(DOCTYPE), 'models/types.xsd': craftedXsd() });
    const message = await failure(readProcessPackage(await readBpmnZip(zip, 'order.zip')));
    expect(message).toMatch(OPEN_ERROR);
    expect(message).toContain(': models/order.bpmn contains a DOCTYPE');
  });

  it('an .xsd inside a zip with one is skipped: the process opens, with a warning', async () => {
    const zip = await zipOf({ 'order.bpmn': craftedBpmn(), 'types.xsd': craftedXsd(DOCTYPE), 'more.xsd': craftedXsd(DOCTYPE) });
    const pkg = await readProcessPackage(await readBpmnZip(zip, 'order.zip'));
    expect(pkg.processes.length).toBeGreaterThan(0);
    expect(pkg.dataTypes).toEqual([]);
    expect(pkg.warnings).toContain(
      '2 XSD files were skipped because they contain a DOCTYPE declaration (rejected for security reasons); business objects from them are not shown: more.xsd, types.xsd.',
    );
  });
});
