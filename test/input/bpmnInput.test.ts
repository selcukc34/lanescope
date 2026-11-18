import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { isSafeEntryName, readBpmnPackage, readBpmnZip } from '../../src/input/bpmnInput';

const BPMN = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>';

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('readBpmnZip', () => {
  it('returns the BPMN text and XSD files by entry name', async () => {
    const data = await zipOf({ 'p.bpmn': BPMN, 'a.xsd': '<schema/>', 'types/b.xsd': '<schema/>', 'readme.txt': 'x' });
    const input = await readBpmnZip(data, 'p.zip');
    expect(input.bpmnFileName).toBe('p.bpmn');
    expect(input.bpmnText).toBe(BPMN);
    expect(Object.keys(input.xsdFiles)).toEqual(['a.xsd', 'types/b.xsd']);
  });

  it('ignores macOS metadata entries', async () => {
    const data = await zipOf({ 'p.bpmn': BPMN, '__MACOSX/._p.bpmn': 'junk', '._q.bpmn': 'junk' });
    await expect(readBpmnZip(data, 'p.zip')).resolves.toMatchObject({ bpmnFileName: 'p.bpmn' });
  });

  it('requires exactly one .bpmn entry', async () => {
    await expect(readBpmnZip(await zipOf({ 'a.xsd': '' }), 'z.zip')).rejects.toThrow(/does not contain a \.bpmn/);
    await expect(readBpmnZip(await zipOf({ 'a.bpmn': BPMN, 'b.bpmn': BPMN }), 'z.zip')).rejects.toThrow(
      /2 \.bpmn files/,
    );
  });

  it('rejects more entries than the limit', async () => {
    const files: Record<string, string> = { 'p.bpmn': BPMN };
    for (let i = 0; i < 500; i++) files[`f${i}.txt`] = '';
    await expect(readBpmnZip(await zipOf(files), 'z.zip')).rejects.toThrow(/501 entries; the limit is 500/);
  });

  it('rejects content larger than the uncompressed limit', async () => {
    const big = 'a'.repeat(10_000); // compresses to a few bytes
    const data = await zipOf({ 'p.bpmn': BPMN, 'big.xsd': big });
    expect(data.length).toBeLessThan(1_000);
    await expect(readBpmnZip(data, 'z.zip', { maxUncompressedBytes: 5_000 })).rejects.toThrow(/larger than 5000 bytes/);
  });

  it('rejects path traversal entries', async () => {
    const data = await zipOf({ 'p.bpmn': BPMN, '../evil.xsd': '<schema/>' });
    await expect(readBpmnZip(data, 'z.zip')).rejects.toThrow(/unsafe path/);
  });

  it('rejects data that is not a zip', async () => {
    await expect(readBpmnZip(new TextEncoder().encode('not a zip'), 'z.zip')).rejects.toThrow(/Not a valid zip/);
  });
});

describe('isSafeEntryName', () => {
  it.each(['a.bpmn', 'dir/a.xsd', 'dir/./a.xsd', 'a..b.xsd'])('accepts %s', (name) => {
    expect(isSafeEntryName(name)).toBe(true);
  });
  it.each(['../a.xsd', 'dir/../../a.xsd', '/etc/passwd', 'C:/a.xsd', 'c:a.xsd', '..\\a.xsd', 'a\u0000.xsd', ''])(
    'rejects %j',
    (name) => {
      expect(isSafeEntryName(name)).toBe(false);
    },
  );
});

describe('readBpmnPackage', () => {
  it('rejects unsupported extensions', async () => {
    await expect(readBpmnPackage('process.twx')).rejects.toThrow(/Unsupported file type/);
  });
});
