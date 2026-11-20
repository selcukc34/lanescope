// SECURITY.md scope 2: no script execution or network access from the
// diagram view. Covers the Content Security Policy, the webview code (text
// from the file is only ever set as text), what the host sends for files
// whose every name is HTML, the rich documentation converter, and XML
// documents with a DOCTYPE (entity expansion, external entities).

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { BpmnModdle } from 'bpmn-moddle';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { readBpmnZip } from '../../src/input/bpmnInput';
import { hasDoctype } from '../../src/input/xmlGuard';
import { readBpmn, readProcessPackage } from '../../src/bpmn/bpmnReader';
import { htmlToPlainText } from '../../src/model/plainText';
import type { ProcessPackage } from '../../src/model/model';
import { readTwxArchive } from '../../src/twx/twxReader';
import { twxToProcessPackage } from '../../src/twx/twxImport';
import { parseXml } from '../../src/twx/xml';
import { readXsd } from '../../src/xsd/xsdReader';
import { DEFAULT_VIEW_OPTIONS, type HostMessage, type RenderMessage } from '../../src/views/protocol';
import { buildRenderMessage } from '../../src/views/viewModel';
import { ViewerSession } from '../../src/views/viewerSession';
import { buildCsp, buildWebviewHtml } from '../../src/views/webviewHtml';
import { craftedBobZip, craftedBpmn, craftedTwx, craftedXsd, PAYLOAD, SERVICE_ID, INNER_SERVICE_ID, zipOf } from './crafted';

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Content Security Policy

describe('CSP of the webview', () => {
  const SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';
  const directives = new Map(
    buildCsp(SOURCE, 'N0NCE')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .map(([name, ...values]) => [name, values] as const),
  );

  it("denies everything by default (so no connect-src, frame-src, media-src or object-src: they fall back to 'none')", () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
    for (const name of ['connect-src', 'frame-src', 'child-src', 'worker-src', 'media-src', 'object-src', 'manifest-src']) {
      expect(directives.has(name)).toBe(false);
    }
  });

  it('runs only the script with the nonce: no inline code, no eval, no host', () => {
    expect(directives.get('script-src')).toEqual(["'nonce-N0NCE'"]);
  });

  it('loads styles, fonts and images from the extension only (images also as data: URIs)', () => {
    expect(directives.get('style-src')).toEqual([SOURCE]);
    expect(directives.get('font-src')).toEqual([SOURCE]);
    expect(directives.get('img-src')).toEqual([SOURCE, 'data:']);
  });

  it('closes the directives that do not fall back to default-src', () => {
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it("never allows 'unsafe-inline', 'unsafe-eval', wildcards or plain schemes", () => {
    const values = [...directives.values()].flat();
    expect(values.filter((v) => /unsafe|^\*$|^https?:$|^blob:$|^filesystem:$/.test(v))).toEqual([]);
  });

  it('has one script tag, external and with the nonce, and escapes the title', () => {
    const html = buildWebviewHtml({ cspSource: SOURCE, scriptUri: `${SOURCE}/main.js`, styleUri: `${SOURCE}/main.css`, nonce: 'N0NCE', title: PAYLOAD });
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="N0NCE" src="${SOURCE}/main.js"></script>`);
    expect(html).not.toContain('<img');
    expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt;');
  });

  it('gives the webview scripts and only its own bundle folder; no command URIs', () => {
    const provider = readFileSync(path.join(ROOT, 'src/views/processEditorProvider.ts'), 'utf8');
    expect(provider).toContain("const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');");
    expect(provider).toContain('webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };');
    expect(provider).not.toMatch(/enableCommandUris|enableForms|portMapping/);
  });
});

// ---------------------------------------------------------------------------
// Webview code

function webviewCode(): Array<{ file: string; text: string }> {
  return readdirSync(path.join(ROOT, 'webview'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(path.join(ROOT, 'webview', f), 'utf8') }));
}

describe('webview code', () => {
  it('has no HTML sink and no dynamic code', () => {
    const sinks = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|createContextualFragment|DOMParser|srcdoc|setTimeout\s*\(\s*['"`]|\.on[a-z]+\s*=/;
    const found = webviewCode().flatMap(({ file, text }) =>
      text.split('\n').flatMap((line, i) => (sinks.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('never sets a URL attribute (href, src, xlink:href, action) or an event handler attribute', () => {
    const found = webviewCode().flatMap(({ file, text }) =>
      text.split('\n').flatMap((line, i) =>
        /\b(href|src|action|formaction|xlink:href)\b\s*[:=]|setAttribute\(\s*['"`](on|href|src)/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
      ),
    );
    // The one exception: the PNG export loads the export SVG, as a data: URL, into an image that is never shown.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^exportImage\.ts:\d+: image\.src = svgDataUrl\(svg\);$/);
    const exportSvg = readFileSync(path.join(ROOT, 'webview/exportSvg.ts'), 'utf8');
    expect(exportSvg).toContain('return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;');
  });

  it('creates elements with text nodes only (the h() helper)', () => {
    const dom = readFileSync(path.join(ROOT, 'webview/dom.ts'), 'utf8');
    expect(dom).toContain("el.append(typeof child === 'string' ? document.createTextNode(child) : child);");
  });
});

// ---------------------------------------------------------------------------
// What the host sends for a file whose every name is HTML

/** The message without the diagram XML: every field there is shown with textContent. */
function panelData(msg: RenderMessage): string {
  return JSON.stringify({ ...msg, xml: '' });
}

/** Every string anywhere in a value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Names in the diagram XML, read back the way bpmn-js reads them (bpmn-moddle). */
async function diagramNames(xml: string): Promise<string[]> {
  const { rootElement, warnings } = await BpmnModdle().fromXML(xml);
  expect(warnings).toEqual([]);
  const process = (rootElement.rootElements as Array<Record<string, unknown>>).find((e) => e.$type === 'bpmn:Process')!;
  const lanes = ((process.laneSets as Array<{ lanes: Array<{ name?: string }> }>) ?? []).flatMap((s) => s.lanes);
  const flowElements = process.flowElements as Array<{ name?: string; conditionExpression?: { body?: string } }>;
  return [
    String(process.name),
    ...lanes.map((l) => String(l.name)),
    ...flowElements.flatMap((e) => [e.name, e.conditionExpression?.body]).filter((s): s is string => s !== undefined),
  ];
}

function expectPlain(msg: RenderMessage): void {
  // The payload arrives as the very text the file holds: not escaped, not decoded, not turned into markup.
  const all = strings({ ...msg, xml: '' });
  expect(all).toContain(PAYLOAD);
  expect(panelData(msg)).not.toContain('&lt;');
  // The diagram XML is well formed: the payload is escaped in it, and nothing in it is markup that came from the file.
  expect(msg.xml).not.toMatch(/<img|<script|<svg|<\/textarea|<a /);
}

describe('names, documentation, conditions, lanes and XSD text reach the webview as plain text', () => {
  it('Bob .zip: every field and the diagram carry the payload as text', async () => {
    const pkg = await readProcessPackage(await readBpmnZip(await craftedBobZip(), 'crafted.zip'));
    expect(pkg.warnings).toEqual([]);
    const msg = await buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS);
    expectPlain(msg);
    expect(msg.process.name).toBe(PAYLOAD);
    const nodes = Object.values(msg.elements).filter((e) => e.kind === 'node');
    expect(nodes.map((n) => n.name)).toEqual(Array(nodes.length).fill(PAYLOAD));
    expect(Object.values(msg.elements).find((e) => e.kind === 'lane')?.name).toBe(PAYLOAD);
    const conditional = Object.values(msg.elements).find((e) => e.kind === 'flow' && e.condition !== undefined);
    expect(conditional).toMatchObject({ name: PAYLOAD, condition: PAYLOAD });
    expect(msg.dataTypes[0].documentation).toBe(PAYLOAD);
    for (const name of await diagramNames(msg.xml)) expect(name).toBe(PAYLOAD);
  });

  it('Bob documentation that looks like HTML is turned into text without tags', async () => {
    const pkg = await readProcessPackage(await readBpmnZip(await craftedBobZip(), 'crafted.zip'));
    const msg = await buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS);
    const doc = Object.values(msg.elements).find((e) => e.kind === 'node' && e.documentation !== undefined);
    expect(doc?.kind === 'node' && doc.documentation).toBe('j&"\'');
    expect(msg.process.documentation).toBe('j&"\'');
  });

  it('TWX: the process, its service diagram and the service called from it carry the payload as text', async () => {
    const pkg = await twxToProcessPackage(await readTwxArchive(await craftedTwx(), 'crafted.twx'));
    const messages = await sessionMessages(pkg, [
      { type: 'openCallee', calleeId: SERVICE_ID, path: [] },
      { type: 'openCallee', calleeId: INNER_SERVICE_ID, path: [] },
    ]);
    const renders = messages.filter((m): m is RenderMessage => m.type === 'render');
    expect(renders.map((r) => r.path.length)).toEqual([1, 2, 3]);
    for (const msg of renders) {
      expectPlain(msg);
      for (const name of await diagramNames(msg.xml)) expect(name).toBe(PAYLOAD);
    }
    const [bpd] = renders;
    expect(bpd.process.name).toBe(PAYLOAD);
    expect(bpd.process.app).toBe(`${PAYLOAD} / ${PAYLOAD}`);
    const callee = Object.values(bpd.callees)[0];
    expect(callee.name).toBe(PAYLOAD);
    expect(callee.steps.map((s) => s.name)).toContain(PAYLOAD);
    expect(callee.steps.find((s) => s.kind === 'gateway')?.conditions?.[0].condition).toBe(PAYLOAD);
  });

  it('TWX rich documentation is plain text: no tag, attribute, script, style or comment is left', async () => {
    const pkg = await twxToProcessPackage(await readTwxArchive(await craftedTwx(), 'crafted.twx'));
    const msg = await buildRenderMessage(pkg, DEFAULT_VIEW_OPTIONS);
    const docs = [
      msg.process.documentation,
      ...Object.values(msg.elements).flatMap((e) => (e.kind === 'node' && e.documentation ? [e.documentation] : [])),
    ];
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc).toBe('Visible text\nlink');
    }
  });

  /** The messages a viewer posts: the first render, then one per action. */
  async function sessionMessages(pkg: ProcessPackage, actions: unknown[]): Promise<HostMessage[]> {
    const posted: HostMessage[] = [];
    const session = new ViewerSession({ fileName: 'crafted.twx', load: async () => pkg, post: (m) => posted.push(m) });
    await session.handleMessage({ type: 'ready' });
    for (const action of actions) {
      const last = posted.filter((m): m is RenderMessage => m.type === 'render').at(-1)!;
      const a = action as { type: string; calleeId: string; path: string[] };
      await session.handleMessage({ ...a, path: last.path.map((l) => l.id) });
    }
    return posted;
  }
});

describe('htmlToPlainText leaves no markup', () => {
  /** A complete tag or comment: what a browser would parse as markup. */
  const MARKUP = /<[a-z!/?][^<>]*>/i;

  it.each([
    ['event handler', '<p>a<img src=x onerror=alert(1)>b</p>', 'ab'],
    ['quoted ">" in an attribute', '<p>a<img src=x onerror="alert(1)>x">b</p>', 'ab'],
    ['single-quoted attribute', "<p>a<a href='javascript:alert(1)' title='>'>b</a></p>", 'ab'],
    ['script and style bodies', '<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>', 'a\nb'],
    ['unclosed script', '<p>a</p><script>alert(1)', 'a'],
    ['upper-case tags', '<P>a<SCRIPT>alert(1)</SCRIPT>b</P>', 'ab'],
    ['comment holding a script', '<p>a<!-- <script>alert(1)</script> -->b</p>', 'ab'],
    ['nested tag names', '<p>a<scr<script>ipt>alert(1)</script>b</p>', 'a<scrb'],
    ['iframe with srcdoc', '<div>a<iframe srcdoc="<script>alert(1)</script>"></iframe>b</div>', 'ab'],
    ['svg', '<p>a<svg onload=alert(1)><circle/></svg>b</p>', 'ab'],
    ['processing instruction and doctype', '<!DOCTYPE html><?xml-stylesheet href="x"?><p>ab</p>', 'ab'],
  ])('%s', (_name, html, text) => {
    const out = htmlToPlainText(html);
    expect(out).toBe(text);
    expect(out).not.toMatch(MARKUP);
  });

  it('keeps text the author escaped as text: it is shown with textContent, never parsed', () => {
    // "&lt;b&gt;" is what an author typed to show "<b>": the result is a plain string.
    expect(htmlToPlainText('<p>use &lt;b&gt; for bold</p>')).toBe('use <b> for bold');
  });
});

// ---------------------------------------------------------------------------
// XML with a DOCTYPE

/** Ten levels of ten entities each: 10^10 characters if expanded. */
const BILLION_LAUGHS = (() => {
  const entities = ['<!ENTITY e0 "ha">'];
  for (let i = 1; i <= 10; i++) entities.push(`<!ENTITY e${i} "${`&e${i - 1};`.repeat(10)}">`);
  return `<!DOCTYPE root [${entities.join('')}]>`;
})();
const XXE = '<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY % remote SYSTEM "http://127.0.0.1:9/x.dtd"> %remote;]>';
const EXTERNAL_DTD = '<!DOCTYPE root SYSTEM "http://127.0.0.1:9/x.dtd">';

describe.each([
  ['billion laughs', BILLION_LAUGHS],
  ['external entities', XXE],
  ['external DTD', EXTERNAL_DTD],
])('XML with a DOCTYPE (%s) is rejected', (_name, doctype) => {
  it('as .bpmn, before bpmn-moddle parses it', async () => {
    await expect(readBpmn(craftedBpmn(doctype))).rejects.toThrow('Invalid BPMN: XML documents with a DOCTYPE are not accepted.');
  });

  it('as .xsd: the schema is skipped with a warning', async () => {
    expect(() => readXsd(craftedXsd(doctype))).toThrow('DOCTYPE');
    const zip = await zipOf({ 'crafted.bpmn': craftedBpmn(), 'types.xsd': craftedXsd(doctype) });
    const pkg = await readProcessPackage(await readBpmnZip(zip, 'crafted.zip'));
    expect(pkg.dataTypes).toEqual([]);
    expect(pkg.warnings).toContain(
      '1 XSD file was skipped because it contains a DOCTYPE declaration (rejected for security reasons); business objects from it are not shown: types.xsd.',
    );
  });

  it('as a TWX object: the BPD is not read', async () => {
    expect(() => parseXml(`${doctype}<root/>`)).toThrow('DOCTYPE');
    // The export's only BPD is the one with the DOCTYPE: nothing is left to show.
    const archive = await readTwxArchive(await craftedTwx({ bpdProlog: doctype }), 'crafted.twx');
    await expect(twxToProcessPackage(archive)).rejects.toThrow(/^Lanescope could not open this file: .* contains a DOCTYPE declaration/);
  });
});

describe('DOCTYPE detection', () => {
  it('finds a DOCTYPE in any case and after a declaration or comment', () => {
    expect(hasDoctype('<?xml version="1.0"?><!-- x --><!doctype r><r/>')).toBe(true);
    expect(hasDoctype('<r/><!DocType r>')).toBe(true);
  });

  it('ignores "<!DOCTYPE" inside CDATA sections and comments (script text, notes)', async () => {
    expect(hasDoctype('<r><![CDATA[ "<!DOCTYPE html>" ]]><!-- <!DOCTYPE x> --></r>')).toBe(false);
    // The crafted .bpmn has one in a script's CDATA: it is read.
    const result = await readBpmn(craftedBpmn());
    expect(result.processes).toHaveLength(1);
  });

  it('does not stop at a CDATA section that hides the end of another', () => {
    expect(hasDoctype('<r><![CDATA[ x ]]></r><!DOCTYPE r [<!ENTITY a "b">]>')).toBe(true);
  });
});

describe('the parsers do not expand entities on their own either (second line of defence)', () => {
  it('bpmn-moddle keeps an entity reference from an internal subset as text', async () => {
    const xml = `${BILLION_LAUGHS}<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><bpmn:process id="p" name="&e10;"/></bpmn:definitions>`;
    const { rootElement } = await BpmnModdle().fromXML(xml);
    const name = String((rootElement.rootElements as Array<{ name?: string }>)[0].name);
    expect(name.length).toBeLessThan(100);
  });

  it('fast-xml-parser (as the BPMN raw scan and the XSD reader use it) does not expand nested entities', () => {
    const doc = new XMLParser({ ignoreAttributes: false }).parse(`${BILLION_LAUGHS}<r a="&e10;">&e10;</r>`) as unknown;
    expect(JSON.stringify(doc).length).toBeLessThan(1_000);
  });
});
