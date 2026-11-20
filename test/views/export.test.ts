// Export of the drawn diagram: default file names and target checks, the
// webview messages (untrusted input), the BPMN the host builds (every flow
// name and lane, no script text) and the request flow with the webview.

import * as path from 'node:path';
import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import { describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { Process, ProcessPackage } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import {
  BPMN_EXPORT_COMMENT,
  checkExportTarget,
  chooseExportFolder,
  defaultExportName,
  defaultExportPath,
  EXPORT_LABELS,
  safeNamePart,
} from '../../src/views/exportFiles';
import { MAX_EXPORT_BYTES, parseWebviewMessage, type HostMessage, type RenderMessage } from '../../src/views/protocol';
import { ViewerSession, type ExportHost, type ExportRequest } from '../../src/views/viewerSession';
import { exportSvg, MAX_PNG_PIXELS, MAX_PNG_SIDE, pngScale, svgDataUrl, svgViewBox } from '../../webview/exportSvg';
import { hasLocalTwx, localTwx } from '../localFixtures';
import { BPD_ID, PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

const BOB = path.join(__dirname, '../fixtures/bob/order-delivery-process.zip');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCRIPT_TEXT = 'tw.local.total = tw.local.amount * 1.2;';

// ---------------------------------------------------------------------------
// File names and targets

describe('exportFiles', () => {
  const dir = path.join(path.sep, 'work', 'bob');
  const zip = path.join(dir, 'order-delivery-process.zip');

  it('names exports after the opened file, next to it', () => {
    expect(defaultExportName({ sourcePath: zip, format: 'bpmn' })).toBe('order-delivery-process.laid-out.bpmn');
    expect(defaultExportName({ sourcePath: zip, format: 'svg' })).toBe('order-delivery-process.svg');
    expect(defaultExportName({ sourcePath: zip, format: 'png' })).toBe('order-delivery-process.png');
    const bpmn = path.join(dir, 'order.bpmn');
    expect(defaultExportName({ sourcePath: bpmn, format: 'bpmn' })).toBe('order.laid-out.bpmn');
    expect(defaultExportName({ sourcePath: bpmn, format: 'png' })).toBe('order.png');
  });

  it('adds the level name for an opened service flow of a TWX', () => {
    const twx = path.join(dir, 'Order App - 1.0.twx');
    expect(defaultExportName({ sourcePath: twx, format: 'bpmn' })).toBe('Order-App-1-0.laid-out.bpmn');
    expect(defaultExportName({ sourcePath: twx, format: 'svg', levelName: 'Price Order (SF)' })).toBe('Order-App-1-0-Price-Order-SF.svg');
    expect(defaultExportName({ sourcePath: twx, format: 'bpmn', levelName: 'Price Order' })).toBe('Order-App-1-0-Price-Order.laid-out.bpmn');
    // A level name with nothing safe in it adds nothing.
    expect(defaultExportName({ sourcePath: twx, format: 'png', levelName: '../../' })).toBe('Order-App-1-0.png');
  });

  it('makes names safe for a file name: letters, digits, - and _', () => {
    expect(safeNamePart('Validate Order SF')).toBe('Validate-Order-SF');
    expect(safeNamePart('../etc/passwd')).toBe('etc-passwd');
    expect(safeNamePart('a\\b:c*d?"e<f>g|h')).toBe('a-b-c-d-e-f-g-h');
    expect(safeNamePart('Sipariş Onayı_2')).toBe('Sipariş-Onayı_2');
    expect(safeNamePart('<img src=x onerror=alert(1)>')).toBe('img-src-x-onerror-alert-1');
    expect(safeNamePart('...')).toBe('');
    expect(safeNamePart('x'.repeat(300))).toHaveLength(80);
  });

  it('adds -2, -3, … when a file of that name exists', async () => {
    const taken = new Set([path.join(dir, 'order-delivery-process.png'), path.join(dir, 'order-delivery-process-2.png')]);
    expect(await defaultExportPath({ sourcePath: zip, format: 'png' }, (p) => taken.has(p))).toBe(path.join(dir, 'order-delivery-process-3.png'));
    expect(await defaultExportPath({ sourcePath: zip, format: 'svg' }, async () => false)).toBe(path.join(dir, 'order-delivery-process.svg'));
    const bpmnTaken = new Set([path.join(dir, 'order-delivery-process.laid-out.bpmn')]);
    expect(await defaultExportPath({ sourcePath: zip, format: 'bpmn' }, (p) => bpmnTaken.has(p))).toBe(
      path.join(dir, 'order-delivery-process-2.laid-out.bpmn'),
    );
  });

  it('opens the save dialog in the last export folder while it exists, else next to the source', () => {
    const desktop = path.join(path.sep, 'Users', 'someone', 'Desktop');
    expect(chooseExportFolder(undefined, false, dir)).toBe(dir);
    expect(chooseExportFolder(desktop, true, dir)).toBe(desktop);
    // The last folder was deleted.
    expect(chooseExportFolder(desktop, false, dir)).toBe(dir);
  });

  it('checks for name clashes in the chosen folder, keeping the name', async () => {
    const desktop = path.join(path.sep, 'Users', 'someone', 'Desktop');
    const taken = new Set([path.join(desktop, 'order-delivery-process.svg'), path.join(dir, 'order-delivery-process-2.svg')]);
    expect(await defaultExportPath({ sourcePath: zip, format: 'svg' }, (p) => taken.has(p), desktop)).toBe(
      path.join(desktop, 'order-delivery-process-2.svg'),
    );
    expect(await defaultExportPath({ sourcePath: zip, format: 'bpmn', levelName: 'Price Order' }, () => false, desktop)).toBe(
      path.join(desktop, 'order-delivery-process-Price-Order.laid-out.bpmn'),
    );
    // The opened file is still refused when the dialog opens next to it.
    expect(checkExportTarget(zip, zip, 'png').ok).toBe(false);
  });

  it('says that the BPMN export holds no scripts', () => {
    expect(EXPORT_LABELS.bpmn).toBe('BPMN with layout, no scripts (.bpmn)');
  });

  it('never suggests the opened file itself', async () => {
    // A .bpmn named like an earlier export: the default skips it even when nothing exists.
    const source = path.join(dir, 'order.laid-out.bpmn');
    expect(await defaultExportPath({ sourcePath: source, format: 'bpmn' }, () => false)).not.toBe(source);
  });

  it('accepts a new file of the export format, adding the extension when there is none', () => {
    expect(checkExportTarget(path.join(dir, 'out.png'), zip, 'png')).toEqual({ ok: true, path: path.join(dir, 'out.png') });
    expect(checkExportTarget(path.join(dir, 'out.PNG'), zip, 'png')).toEqual({ ok: true, path: path.join(dir, 'out.PNG') });
    expect(checkExportTarget(path.join(dir, 'out'), zip, 'svg')).toEqual({ ok: true, path: path.join(dir, 'out.svg') });
    expect(checkExportTarget(path.join(dir, 'other.bpmn'), zip, 'bpmn')).toEqual({ ok: true, path: path.join(dir, 'other.bpmn') });
  });

  it('refuses the opened file, input types and other extensions', () => {
    const bpmn = path.join(dir, 'order.bpmn');
    const refused = (picked: string, source: string, format: 'bpmn' | 'svg' | 'png') => {
      const check = checkExportTarget(picked, source, format);
      expect(check.ok).toBe(false);
      return check.ok ? '' : check.message;
    };
    expect(refused(bpmn, bpmn, 'bpmn')).toMatch(/opened file/);
    // Without its extension, or in another case, it is still the opened file.
    expect(refused(path.join(dir, 'order'), bpmn, 'bpmn')).toMatch(/opened file/);
    expect(refused(path.join(dir, 'ORDER.BPMN'), bpmn, 'bpmn')).toMatch(/opened file/);
    expect(refused(path.join(dir, 'x', '..', 'order.bpmn'), bpmn, 'bpmn')).toMatch(/opened file/);
    expect(refused(zip, zip, 'png')).toMatch(/opened file|\.zip/);
    for (const ext of ['.twx', '.zip', '.xsd', '.TWX']) {
      expect(refused(path.join(dir, `out${ext}`), zip, 'png')).toMatch(/never writes input files/);
    }
    expect(refused(path.join(dir, 'out.svg'), zip, 'png')).toMatch(/Pick a \.png file/);
    expect(refused(path.join(dir, 'out.bpmn'), zip, 'svg')).toMatch(/Pick a \.svg file/);
    expect(refused(path.join(dir, 'out.png.txt'), zip, 'png')).toMatch(/Pick a \.png file/);
  });
});

// ---------------------------------------------------------------------------
// Webview messages

describe('parseWebviewMessage: export', () => {
  const expected = { requestId: 'export-3', format: 'png' as const };
  const png = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
  const pngData = png(Buffer.concat([PNG_SIGNATURE, Buffer.from('rest of the image')]));

  it('accepts an export request for the three formats only', () => {
    for (const format of ['bpmn', 'svg', 'png']) {
      expect(parseWebviewMessage({ type: 'exportRequest', format })).toEqual({ type: 'exportRequest', format });
    }
    for (const format of ['pdf', 'BPMN', '', undefined, 1, ['png'], { format: 'png' }]) {
      expect(parseWebviewMessage({ type: 'exportRequest', format })).toBeUndefined();
    }
  });

  it('accepts PNG data for the expected request, with its bytes', () => {
    const msg = parseWebviewMessage({ type: 'exportData', requestId: 'export-3', format: 'png', data: pngData }, expected);
    expect(msg?.type).toBe('exportData');
    if (msg?.type !== 'exportData') return;
    expect(Buffer.from(msg.bytes).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(Buffer.from(msg.bytes).toString('latin1', 8)).toBe('rest of the image');
  });

  it('refuses data for an old, unknown or missing request id, or another format', () => {
    const data = { type: 'exportData', format: 'png', data: pngData };
    expect(parseWebviewMessage({ ...data, requestId: 'export-2' }, expected)).toBeUndefined();
    expect(parseWebviewMessage({ ...data, requestId: 'export-30' }, expected)).toBeUndefined();
    expect(parseWebviewMessage({ ...data, requestId: undefined }, expected)).toBeUndefined();
    expect(parseWebviewMessage({ ...data, requestId: 'export-3' })).toBeUndefined();
    expect(parseWebviewMessage({ ...data, requestId: 'export-3', format: 'svg', data: '<svg/>' }, expected)).toBeUndefined();
  });

  it('refuses PNG data that is not a base64 PNG data URL', () => {
    const at = (data: unknown) => parseWebviewMessage({ type: 'exportData', requestId: 'export-3', format: 'png', data }, expected);
    expect(at(pngData.replace('image/png', 'image/svg+xml'))).toBeUndefined();
    expect(at(pngData.replace('data:', ''))).toBeUndefined();
    expect(at(`${pngData}!`)).toBeUndefined();
    expect(at(pngData.slice(0, -1))).toBeUndefined();
    expect(at('data:image/png;base64,')).toBeUndefined();
    expect(at(`data:image/png;base64,${'A'.repeat(8)} `)).toBeUndefined();
    // Not a PNG: a GIF, and plain text.
    expect(at(png(Buffer.from('GIF89a......')))).toBeUndefined();
    expect(at(png(Buffer.from('<svg onload=alert(1)>')))).toBeUndefined();
    expect(at(123)).toBeUndefined();
    expect(at({ toString: () => pngData })).toBeUndefined();
  });

  it(`refuses a PNG larger than ${MAX_EXPORT_BYTES} bytes`, () => {
    const max = Math.ceil(MAX_EXPORT_BYTES / 3) * 4;
    const tooLong = `data:image/png;base64,${'A'.repeat(max + 4)}`;
    expect(parseWebviewMessage({ type: 'exportData', requestId: 'export-3', format: 'png', data: tooLong }, expected)).toBeUndefined();
  });

  it('accepts SVG text that starts with <svg, has no script and is within the limit', () => {
    const svgExpected = { requestId: 'export-4', format: 'svg' as const };
    const at = (data: unknown) => parseWebviewMessage({ type: 'exportData', requestId: 'export-4', format: 'svg', data }, svgExpected);
    const ok = at('<svg xmlns="http://www.w3.org/2000/svg"><text>Ä</text></svg>');
    expect(ok?.type === 'exportData' && Buffer.from(ok.bytes).toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text>Ä</text></svg>');
    expect(at('<?xml version="1.0"?><svg/>')).toBeUndefined();
    expect(at(' <svg/>')).toBeUndefined();
    expect(at('<html><svg/></html>')).toBeUndefined();
    expect(at('<svg><script>alert(1)</script></svg>')).toBeUndefined();
    expect(at('<svg><SCRIPT href="x"/></svg>')).toBeUndefined();
    expect(at(`<svg>${'x'.repeat(MAX_EXPORT_BYTES)}</svg>`)).toBeUndefined();
    // Within the character limit but over it in UTF-8 bytes.
    expect(at(`<svg>${'é'.repeat(MAX_EXPORT_BYTES / 2)}</svg>`)).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The BPMN the host exports

interface Counts {
  nodes: number;
  flows: number;
  lanes: number;
}

/** Reads the export back the way another BPMN tool would (bpmn-moddle). */
async function readBack(xml: string): Promise<{ counts: Counts; flowNames: string[]; laneNames: string[]; process: ModdleElement }> {
  const { rootElement, warnings } = await BpmnModdle().fromXML(xml);
  expect(warnings).toEqual([]);
  const process = (rootElement.rootElements as ModdleElement[]).find((e) => e.$type === 'bpmn:Process')!;
  const elements = (process.flowElements ?? []) as ModdleElement[];
  const flows = elements.filter((e) => e.$type === 'bpmn:SequenceFlow');
  const lanes = ((process.laneSets ?? []) as ModdleElement[]).flatMap((s) => (s.lanes ?? []) as ModdleElement[]);
  return {
    counts: { nodes: elements.length - flows.length, flows: flows.length, lanes: lanes.length },
    flowNames: flows.map((f) => f.name as string).filter(Boolean),
    laneNames: lanes.map((l) => l.name as string),
    process,
  };
}

/** Every diagram element has its shape or edge (the export carries the layout). */
function diagramCovers(xml: string, ids: string[]): void {
  for (const id of ids) expect(xml).toMatch(new RegExp(`bpmnElement="${id}"`));
}

function session(pkg: ProcessPackage, posted: HostMessage[] = [], exporter?: ExportHost): ViewerSession {
  return new ViewerSession({ fileName: path.basename(pkg.source.path), load: async () => pkg, post: (m) => posted.push(m), exporter });
}

const lastRender = (posted: HostMessage[]) => posted.filter((m): m is RenderMessage => m.type === 'render').at(-1)!;

describe('ViewerSession.exportBpmn: Bob zip', () => {
  it('keeps every "To X" flow name and the empty Customer lane, whatever the toolbar shows', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const process = pkg.processes[0];
    const posted: HostMessage[] = [];
    const s = session(pkg, posted);
    await s.handleMessage({ type: 'ready' });
    await s.handleMessage({ type: 'setOptions', options: { hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: true } });
    // The viewer hides them…
    const shown = await readBack(lastRender(posted).xml);
    expect(shown.flowNames).not.toContain('To Validate Order SF');
    expect(shown.laneNames).not.toContain('Customer');

    // …the export keeps them.
    const { xml, levelName } = await s.exportBpmn();
    expect(levelName).toBeUndefined();
    // The note comes right after the XML declaration.
    expect(xml.split('\n').slice(0, 2)).toEqual(['<?xml version="1.0" encoding="UTF-8"?>', BPMN_EXPORT_COMMENT]);
    expect(xml.match(/<!--/g)).toHaveLength(1);
    const exported = await readBack(xml);
    expect(exported.flowNames).toContain('To Validate Order SF');
    expect(exported.flowNames).toEqual(process.flows.map((f) => f.name).filter(Boolean));
    expect(exported.laneNames).toContain('Customer');
    expect(exported.counts).toEqual({ nodes: process.nodes.length, flows: process.flows.length, lanes: process.lanes.length });
    expect(exported.counts).toEqual({ nodes: 14, flows: 14, lanes: 5 });
    diagramCovers(xml, [...process.nodes.map((n) => n.id), ...process.flows.map((f) => f.id), ...process.lanes.map((l) => l.id)]);
    // The toolbar is as the user left it.
    expect(s.currentOptions).toEqual({ hideGeneratedFlowLabels: true, hideEmptyLanes: true, highlightChanges: true });
  });

  it('keeps gateway conditions and documentation as plain text', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const s = session(pkg);
    await s.handleMessage({ type: 'ready' });
    const { xml } = await s.exportBpmn();
    const conditions = pkg.processes[0].flows.filter((f) => f.condition !== undefined);
    expect(conditions.length).toBeGreaterThan(0);
    const { process } = await readBack(xml);
    const bodies = ((process.flowElements ?? []) as ModdleElement[])
      .map((e) => (e.conditionExpression as ModdleElement | undefined)?.body)
      .filter(Boolean);
    expect(bodies).toEqual(conditions.map((f) => f.condition));
    expect((process.documentation as ModdleElement[])[0].text).toBe(pkg.processes[0].documentation);
  });

  it('throws when nothing is drawn', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    await expect(session(pkg).exportBpmn()).rejects.toThrow(/no diagram/);
  });
});

describe('ViewerSession.exportBpmn: synthetic TWX', () => {
  it('exports the BPD with safe ids: no original TWX id reaches the XML', async () => {
    const pkg = await syntheticTwxPackage();
    const process = pkg.processes[0];
    const s = session(pkg);
    await s.handleMessage({ type: 'ready' });
    const { xml, levelName } = await s.exportBpmn();
    expect(levelName).toBeUndefined();
    const back = await readBack(xml);
    expect(back.counts).toEqual({ nodes: process.nodes.length, flows: process.flows.length, lanes: process.lanes.length });
    expect(back.process.id).toBe(process.id);
    const originals = [process.originalId, ...process.nodes.map((n) => n.originalId), ...process.flows.map((f) => f.originalId)].filter(
      (id): id is string => id !== undefined,
    );
    expect(originals.length).toBeGreaterThan(3);
    for (const id of originals) expect(xml).not.toContain(`"${id}"`);
    // The gateway condition is part of the process definition.
    expect(xml).toContain('tw.local.approved == true');
  });

  it('exports an opened service flow, without the script of its script task', async () => {
    const pkg = await syntheticTwxPackage();
    const service = (await pkg.calleeDiagrams!.read(PRICE_SERVICE_ID))!.process;
    expect(service.nodes.find((n) => n.kind === 'scriptTask')?.script?.text).toBe(SCRIPT_TEXT);

    const posted: HostMessage[] = [];
    const s = session(pkg, posted);
    await s.handleMessage({ type: 'ready' });
    await s.handleMessage({ type: 'openCallee', calleeId: PRICE_SERVICE_ID, path: [BPD_ID] });
    expect(s.currentPath).toEqual([BPD_ID, PRICE_SERVICE_ID]);

    const { xml, levelName } = await s.exportBpmn();
    expect(levelName).toBe('Price Order');
    expect(xml).toContain('<bpmn:scriptTask');
    expect(xml).not.toContain(SCRIPT_TEXT);
    expect(xml).not.toMatch(/<(?:\w+:)?script[\s/>]/);
    const back = await readBack(xml);
    expect(back.process.id).toBe(service.id);
    expect(back.counts).toEqual({ nodes: service.nodes.length, flows: service.flows.length, lanes: 0 });
    // It is the level the viewer draws.
    expect((await readBack(lastRender(posted).xml)).process.id).toBe(service.id);
  });
});

// ---------------------------------------------------------------------------
// Request flow

/** An export host that records what it is asked, with a fixed answer for the save dialog (null: cancelled). */
function recorder(target: string | null = '/out/export') {
  const asked: ExportRequest[] = [];
  const written: Array<{ target: string; format: string; bytes: Uint8Array }> = [];
  const failures: string[] = [];
  const host: ExportHost = {
    chooseTarget: async (request) => {
      asked.push(request);
      return target ?? undefined;
    },
    write: async (t, format, bytes) => {
      written.push({ target: t, format, bytes });
    },
    failed: (message) => failures.push(message),
  };
  return { host, asked, written, failures };
}

describe('ViewerSession export requests', () => {
  const pngData = `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, Buffer.from('img')]).toString('base64')}`;

  it('writes the BPMN right away, without the webview', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const posted: HostMessage[] = [];
    const r = recorder('/out/a.laid-out.bpmn');
    const s = session(pkg, posted, r.host);
    await s.handleMessage({ type: 'ready' });
    const before = posted.length;
    await s.handleMessage({ type: 'exportRequest', format: 'bpmn' });
    expect(r.asked).toEqual([{ format: 'bpmn' }]);
    expect(r.written).toHaveLength(1);
    expect(r.written[0].target).toBe('/out/a.laid-out.bpmn');
    expect(Buffer.from(r.written[0].bytes).toString('utf8')).toBe((await s.exportBpmn()).xml);
    expect(posted.length).toBe(before);
    expect(r.failures).toEqual([]);
  });

  it('has the webview draw an image and accepts it only for the latest request id', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const posted: HostMessage[] = [];
    const r = recorder('/out/a.png');
    const s = session(pkg, posted, r.host);
    await s.handleMessage({ type: 'ready' });
    await s.handleMessage({ type: 'exportRequest', format: 'png' });
    await s.handleMessage({ type: 'exportRequest', format: 'png' });
    const sources = posted.filter((m) => m.type === 'exportSource');
    expect(sources).toHaveLength(2);
    const [older, latest] = sources;
    expect(latest).toMatchObject({ type: 'exportSource', format: 'png' });
    expect(latest.requestId).not.toBe(older.requestId);
    // The image is drawn from the export XML (every flow name kept).
    expect(latest.xml).toBe((await s.exportBpmn()).xml);
    expect(latest.xml).toContain('To Validate Order SF');

    await s.handleMessage({ type: 'exportData', requestId: older.requestId, format: 'png', data: pngData });
    await s.handleMessage({ type: 'exportData', requestId: 'export-999', format: 'png', data: pngData });
    await s.handleMessage({ type: 'exportData', requestId: latest.requestId, format: 'svg', data: '<svg/>' });
    expect(r.written).toEqual([]);
    await s.handleMessage({ type: 'exportData', requestId: latest.requestId, format: 'png', data: pngData });
    expect(r.written.map((w) => w.target)).toEqual(['/out/a.png']);
    // The same id is not accepted twice.
    await s.handleMessage({ type: 'exportData', requestId: latest.requestId, format: 'png', data: pngData });
    expect(r.written).toHaveLength(1);
  });

  it('passes the level name of an opened service flow to the save dialog', async () => {
    const pkg = await syntheticTwxPackage();
    const r = recorder('/out/b.svg');
    const posted: HostMessage[] = [];
    const s = session(pkg, posted, r.host);
    await s.handleMessage({ type: 'ready' });
    await s.handleMessage({ type: 'openCallee', calleeId: PRICE_SERVICE_ID, path: [BPD_ID] });
    await s.handleMessage({ type: 'exportRequest', format: 'svg' });
    expect(r.asked).toEqual([{ format: 'svg', levelName: 'Price Order' }]);
    const source = posted.find((m) => m.type === 'exportSource')!;
    expect(source.xml).not.toContain(SCRIPT_TEXT);
    await s.handleMessage({ type: 'exportData', requestId: source.requestId, format: 'svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    expect(r.written.map((w) => [w.target, w.format])).toEqual([['/out/b.svg', 'svg']]);
  });

  it('does nothing when the save dialog is cancelled, and reports a failed write', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const posted: HostMessage[] = [];
    const cancelled = recorder(null);
    const s = session(pkg, posted, cancelled.host);
    await s.handleMessage({ type: 'ready' });
    const before = posted.length;
    await s.handleMessage({ type: 'exportRequest', format: 'svg' });
    await s.handleMessage({ type: 'exportRequest', format: 'bpmn' });
    expect(posted.length).toBe(before);
    expect(cancelled.written).toEqual([]);

    const failing: ExportHost = { ...recorder().host, write: async () => Promise.reject(new Error('disk full')) };
    const failures: string[] = [];
    failing.failed = (m) => failures.push(m);
    const s2 = session(pkg, [], failing);
    await s2.handleMessage({ type: 'ready' });
    await s2.handleMessage({ type: 'exportRequest', format: 'bpmn' });
    expect(failures).toEqual(['Cannot export the diagram: disk full']);
  });

  it('exports nothing before a diagram is drawn', async () => {
    const pkg = await readProcessPackage(await readBpmnPackage(BOB));
    const r = recorder();
    const s = session(pkg, [], r.host);
    expect(await s.requestExport('png')).toBe(false);
    const broken = new ViewerSession({ fileName: 'x.bpmn', load: async () => Promise.reject(new Error('bad')), post: () => undefined, exporter: r.host });
    await broken.handleMessage({ type: 'ready' });
    expect(await broken.requestExport('bpmn')).toBe(false);
    expect(r.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Image helpers of the webview

describe('export image helpers', () => {
  const saved =
    '<?xml version="1.0" encoding="utf-8"?>\n<!-- created with bpmn-js / http://bpmn.io -->\n' +
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="-6 -6 320 200" version="1.1"><g/></svg>';

  it('drops the prolog and puts a white rectangle behind the diagram', () => {
    const svg = exportSvg(saved);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('DOCTYPE');
    expect(svg).toContain('version="1.1"><rect x="-6" y="-6" width="320" height="200" fill="#ffffff"/><g/></svg>');
    expect(svgViewBox(svg)).toEqual({ x: -6, y: -6, width: 320, height: 200 });
    // What the webview sends passes the host's check.
    const parsed = parseWebviewMessage({ type: 'exportData', requestId: 'r', format: 'svg', data: svg }, { requestId: 'r', format: 'svg' });
    expect(parsed?.type).toBe('exportData');
    expect(() => exportSvg('<div/>')).toThrow();
    expect(() => exportSvg('<svg width="1"></svg>')).toThrow();
  });

  it('scales PNGs by 2, less for large diagrams', () => {
    expect(pngScale(1000, 600)).toBe(2);
    const wide = pngScale(20000, 500);
    expect(20000 * wide).toBeLessThanOrEqual(MAX_PNG_SIDE);
    const big = pngScale(7000, 6000);
    expect(7000 * big).toBeLessThanOrEqual(MAX_PNG_SIDE);
    expect(7000 * 6000 * big * big).toBeLessThanOrEqual(MAX_PNG_PIXELS * 1.0000001);
  });

  it('loads the SVG as a data: URL (the CSP already allows data: images)', () => {
    expect(svgDataUrl('<svg a="#"/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E');
  });
});

// ---------------------------------------------------------------------------
// Real BAW exports (../localFixtures; skipped when they are not there)

describe.skipIf(!hasLocalTwx('services'))('ViewerSession.exportBpmn: local TWX export', () => {
  it('exports every BPD and the service flows it calls without any script text', async () => {
    const pkg = await readTwxPackage(localTwx('services'));
    const scripts = (p: Process) => p.nodes.flatMap((n) => (n.script?.text.trim() ? [n.script.text.trim()] : []));
    let services = 0;
    let scriptTexts = 0;
    for (const bpd of pkg.processes) {
      const posted: HostMessage[] = [];
      const s = session(pkg, posted);
      await s.handleMessage({ type: 'ready' });
      await s.handleMessage({ type: 'selectProcess', processId: bpd.id });
      const exported = await s.exportBpmn();
      // The same nodes and flows as the viewer draws; lanes may be more (empty ones are kept).
      const drawn = (await readBack(lastRender(posted).xml)).counts;
      const back = (await readBack(exported.xml)).counts;
      expect([back.nodes, back.flows]).toEqual([drawn.nodes, drawn.flows]);
      expect(back.lanes).toBeGreaterThanOrEqual(drawn.lanes);
      for (const text of scripts(bpd)) expect(exported.xml).not.toContain(text);

      const callees = [...new Set(bpd.nodes.flatMap((n) => (n.calledElement ? [n.calledElement.id] : [])))];
      for (const calleeId of callees) {
        const diagram = await pkg.calleeDiagrams?.read(calleeId);
        if (!diagram) continue;
        await s.handleMessage({ type: 'openCallee', calleeId, path: [bpd.originalId ?? bpd.id] });
        const level = await s.exportBpmn();
        expect(level.levelName).toBe(diagram.process.name || diagram.process.id);
        expect((await readBack(level.xml)).process.id).toBe(diagram.process.id);
        for (const text of scripts(diagram.process)) {
          expect(level.xml).not.toContain(text);
          scriptTexts++;
        }
        services++;
        await s.handleMessage({ type: 'openCallee', calleeId: bpd.originalId ?? bpd.id, path: [] });
      }
    }
    expect(services).toBeGreaterThan(0);
    expect(scriptTexts).toBeGreaterThan(0);
  }, 60_000);
});
