// Keyword search (src/search): what the index holds for Bob output and the
// synthetic TWX export, the case folding, snippets and the hit limit.

import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import {
  foldCase,
  MAX_HITS,
  ONLY_SHOWN_PROCESS,
  search,
  SCRIPTS_NOT_SEARCHED,
  SNIPPET_CONTEXT,
  truncatedNote,
  type SearchIndex,
  type SearchResult,
} from '../../src/search/search';
import { buildSearchIndex, INSIDE_SERVICE } from '../../src/search/searchIndex';
import { buildRenderMessage } from '../../src/views/viewModel';
import { DEFAULT_VIEW_OPTIONS } from '../../src/views/protocol';
import { CHECK_STOCK_ID, PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

const BOB_ZIP = path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process.zip');
const VALIDATE_ID = 'bpmnid-ca534cf5-ff40-5898-873c-68c5b8ff5674';
const ROUTE_GATEWAY_ID = 'bpmnid-77703ca3-6892-5eb3-99bb-7aace6e9d4d5';
const EXCEPTION_FLOW_ID = 'bpmnid-e60e39f8-8ad4-5c29-a934-8bc13a6f4a3e';
const VALID_FLOW_ID = 'bpmnid-32b1df0c-368e-5cb2-8558-f8d2ff32ce09';
const TO_VALIDATE_FLOW_ID = 'bpmnid-f634281f-4799-5e29-a45a-feb2141bb9e7';

/** "Kind Name › where": one line per result group. */
const heads = (r: SearchResult) => r.groups.map((g) => [g.group.kind, g.group.name, ...g.group.where].join(' | '));
const snippet = (h: { before: string; match: string; after: string }) => `${h.before}[${h.match}]${h.after}`;

let bob: ProcessPackage;
let bobIndex: SearchIndex;

beforeAll(async () => {
  bob = await readProcessPackage(await readBpmnPackage(BOB_ZIP));
  bobIndex = buildSearchIndex(bob, { showScripts: true });
});

describe('case folding', () => {
  it('lower-cases each unit in place and folds the Turkish I forms to "i"', () => {
    expect(foldCase('Validate ORDER')).toBe('validate order');
    expect(foldCase('İSTANBUL ılık Işık')).toBe('istanbul ilik işik');
    // Same length, so offsets in the folded text are offsets in the original.
    for (const s of ['İstanbul', 'ẞtraße', 'ǅemal', 'Ωmega']) expect(foldCase(s)).toHaveLength(s.length);
  });

  it('finds İ, I, ı and i alike, and ignores case', () => {
    const index: SearchIndex = {
      groups: [{ target: { type: 'process' }, kind: 'Process', name: 'P', where: [] }],
      fields: ['İstanbul Office', 'ISTANBUL', 'ıstanbul', 'Istanbul'].map((text) => ({ group: 0, label: 'Documentation', text })),
      scriptsOmitted: 0,
      otherProcesses: false,
    };
    expect(search(index, 'istanbul').total).toBe(4);
    expect(search(index, 'İSTANBUL').total).toBe(4);
    expect(search(index, 'office').groups[0].hits.map((h) => h.match)).toEqual(['Office']);
  });
});

describe('search on Bob output', () => {
  it('"order" finds many nodes, flows, the process and the business object', () => {
    const r = search(bobIndex, 'order');
    expect(r.tooShort).toBe(false);
    expect(r.groups.length).toBeGreaterThan(20);
    const nodes = r.groups.filter((g) => g.group.target.type === 'node');
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    expect(r.groups.some((g) => g.group.target.type === 'flow')).toBe(true);
    expect(r.groups.some((g) => g.group.target.type === 'process')).toBe(true);
    expect(r.groups.some((g) => g.group.target.type === 'dataType' && g.group.name === 'OrderRequest')).toBe(true);
    // Inputs of the activities ("order : OrderRequest") are searched too.
    expect(r.groups.find((g) => g.group.name === 'Compliance Review')!.hits.map((h) => h.label)).toContain('Input');
  });

  it('"Validate": name hits first, in diagram order: the task, then the flow named after it', () => {
    const r = search(bobIndex, 'Validate');
    expect(heads(r).slice(0, 2)).toEqual(['Task | Validate Order SF', 'Sequence flow | To Validate Order SF']);
    expect(r.groups[0].group.target).toEqual({ type: 'node', id: VALIDATE_ID, levels: [] });
    expect(r.groups[1].group.target).toEqual({ type: 'flow', id: TO_VALIDATE_FLOW_ID, levels: [] });
    expect(r.groups[0].hits[0]).toMatchObject({ label: 'Name', before: '', match: 'Validate', after: ' Order SF' });
    // Groups that only mention it elsewhere (documentation) come after every name hit.
    const firstOther = r.groups.findIndex((g) => !g.hits.some((h) => h.label === 'Name'));
    expect(r.groups.slice(firstOther).every((g) => !g.hits.some((h) => h.label === 'Name'))).toBe(true);
  });

  it('"EXCEPTION": the flow of Route Order named EXCEPTION, and the condition of "Valid"', () => {
    const r = search(bobIndex, 'EXCEPTION');
    const exception = r.groups.find((g) => g.group.target.type === 'flow' && g.group.target.id === EXCEPTION_FLOW_ID)!;
    // The gateway's default flow.
    expect(exception.group).toMatchObject({ kind: 'Default flow', name: 'EXCEPTION' });
    expect(exception.hits[0]).toMatchObject({ label: 'Name', match: 'EXCEPTION' });
    const valid = r.groups.find((g) => g.group.target.type === 'flow' && g.group.target.id === VALID_FLOW_ID)!;
    expect(valid.group.name).toBe('Valid');
    expect(valid.hits.map((h) => [h.label, snippet(h)])).toEqual([['Condition', 'tw.local.order.route != "[EXCEPTION]"']]);
    // Route Order itself is not a flow; its documentation names the paths.
    expect(r.groups.some((g) => g.group.target.type === 'node' && g.group.target.id === ROUTE_GATEWAY_ID)).toBe(true);
  });

  it('"countryRegion": the field of the business object (from the XSD)', () => {
    const r = search(bobIndex, 'countryRegion');
    const bo = r.groups.find((g) => g.group.target.type === 'dataType')!;
    expect(bo.group).toMatchObject({ kind: 'Business object', name: 'OrderRequest', target: { type: 'dataType', name: 'OrderRequest' } });
    expect(bo.hits.map((h) => [h.label, h.match])).toContainEqual(['Field', 'countryRegion']);
  });

  it('ignores case and surrounding white space', () => {
    const a = search(bobIndex, 'route order');
    const b = search(bobIndex, '  ROUTE ORDER  ');
    expect(b.query).toBe('ROUTE ORDER');
    expect(heads(b)).toEqual(heads(a));
    expect(a.total).toBeGreaterThan(0);
    expect(b.groups[0].hits[0].match).toBe('Route Order');
  });

  it('does not search a query shorter than 2 characters', () => {
    for (const q of ['', ' ', 'o', '  o  ']) {
      const r = search(bobIndex, q);
      expect(r).toMatchObject({ tooShort: true, groups: [], total: 0 });
    }
    expect(search(bobIndex, 'or').tooShort).toBe(false);
  });

  it('is a plain substring search: regular expression characters are literal', () => {
    expect(search(bobIndex, '.*').total).toBe(0);
    const r = search(bobIndex, '!= "');
    expect(r.groups.map((g) => g.group.name)).toEqual(['Valid']);
  });

  it('builds a snippet of up to 40 characters on each side, white space collapsed, the match as written', () => {
    const doc = bob.processes[0].nodes.find((n) => n.id === ROUTE_GATEWAY_ID)!.documentation!;
    const r = search(bobIndex, 'four paths');
    const h = r.groups.find((g) => g.group.name === 'Route Order')!.hits.find((x) => x.label === 'Documentation')!;
    const at = doc.toLowerCase().indexOf('four paths');
    expect(h.match).toBe(doc.slice(at, at + 'four paths'.length));
    const before = h.before.replace(/^…/, '');
    const after = h.after.replace(/…$/, '');
    expect(before.length).toBeLessThanOrEqual(SNIPPET_CONTEXT);
    expect(after.length).toBeLessThanOrEqual(SNIPPET_CONTEXT);
    expect(doc.replace(/\s+/g, ' ')).toContain(`${before}${h.match}${after}`);
    // Cut on the right only when there is more text.
    expect(h.after.endsWith('…')).toBe(at + 10 + SNIPPET_CONTEXT < doc.length);
    expect(h.before.startsWith('…')).toBe(at > SNIPPET_CONTEXT);
  });

  it('lists every occurrence in a field', () => {
    const index: SearchIndex = {
      groups: [{ target: { type: 'process' }, kind: 'Process', name: 'P', where: [] }],
      fields: [{ group: 0, label: 'Documentation', text: 'aa aa aaa' }],
      scriptsOmitted: 0,
      otherProcesses: false,
    };
    // Matches do not overlap.
    expect(search(index, 'aa').groups[0].hits.map(snippet)).toEqual(['[aa] aa aaa', 'aa [aa] aaa', 'aa aa [aa]a']);
  });

  it(`lists at most ${MAX_HITS} hits and says so`, () => {
    const index: SearchIndex = {
      groups: Array.from({ length: 30 }, (_, i) => ({ target: { type: 'node' as const, id: `n${i}`, levels: [] }, kind: 'Task', name: `Task ${i}`, where: [] })),
      fields: Array.from({ length: 30 }, (_, i) => ({ group: i, label: 'Documentation', text: 'needle '.repeat(20) })),
      scriptsOmitted: 0,
      otherProcesses: false,
    };
    const r = search(index, 'needle');
    expect(r).toMatchObject({ total: 600, shown: MAX_HITS, truncated: true });
    expect(r.groups.flatMap((g) => g.hits)).toHaveLength(MAX_HITS);
    expect(r.groups).toHaveLength(25);
    expect(truncatedNote(r)).toBe('Showing first 500 matches');
    expect(truncatedNote(search(bobIndex, 'order'))).toBeUndefined();
  });

  it('has no scripts to leave out and one process only', () => {
    expect(bobIndex.scriptsOmitted).toBe(0);
    expect(bobIndex.otherProcesses).toBe(false);
  });

  it('is sent with every render, for the chosen process', async () => {
    const render = await buildRenderMessage(bob, DEFAULT_VIEW_OPTIONS);
    expect(render.search).toEqual(bobIndex);
  });

  it('keeps the notes in one place', () => {
    expect(SCRIPTS_NOT_SEARCHED).toBe('Scripts were not searched because lanescope.showScripts is off.');
    expect(ONLY_SHOWN_PROCESS).toBe('Only the shown process is searched.');
  });
});

describe('search on the synthetic TWX export', () => {
  let twx: ProcessPackage;
  beforeAll(async () => {
    twx = await syntheticTwxPackage({ subProcess: true });
  });

  it('finds a step inside the called service, under the calling activity, with the step to open', () => {
    const r = search(buildSearchIndex(twx, { showScripts: true }), 'Compute Total');
    const inside = r.groups.find((g) => g.group.where.includes(INSIDE_SERVICE))!;
    expect(inside.group).toMatchObject({ kind: 'Called service', name: 'Review Order', where: [INSIDE_SERVICE] });
    expect(inside.group.target).toMatchObject({ type: 'node', levels: [] });
    expect(inside.hits[0]).toMatchObject({ label: 'Step', match: 'Compute Total', open: { levelId: PRICE_SERVICE_ID, stepId: 'svc:script' } });
  });

  it('finds a node inside a sub-process with its level', () => {
    const r = search(buildSearchIndex(twx, { showScripts: true }), 'Count Items');
    const g = r.groups.find((x) => x.group.kind === 'Script task')!;
    expect(g.group).toMatchObject({ name: 'Count Items', where: ['Check Stock'], target: { type: 'node', levels: [`sub:${CHECK_STOCK_ID}`] } });
    // Nested: Reserve Items is inside Check Stock.
    const reserve = search(buildSearchIndex(twx, { showScripts: true }), 'Reserve Start').groups[0];
    expect(reserve.group.where).toEqual(['Check Stock', 'Reserve Items']);
    expect((reserve.group.target as { levels: string[] }).levels).toHaveLength(2);
  });

  it('searches scripts only while showScripts is on', () => {
    const on = buildSearchIndex(twx, { showScripts: true });
    const off = buildSearchIndex(twx, { showScripts: false });
    // Script task "Count Items" (sub-process) and step "Compute Total" (inside "Price Order").
    const scriptHits = (index: SearchIndex) => search(index, 'tw.local.').groups.flatMap((g) => g.hits.filter((h) => h.label.endsWith('Script')));
    expect([...new Set(scriptHits(on).map((h) => h.label))].sort()).toEqual(['Script', 'Step "Compute Total" · Script']);
    expect(scriptHits(off)).toEqual([]);
    expect(on.scriptsOmitted).toBe(0);
    expect(off.scriptsOmitted).toBe(2);
    // No script text in the index at all.
    expect(JSON.stringify(off)).not.toContain('tw.local.count = 1');
    expect(JSON.stringify(off)).not.toContain('tw.local.amount * 1.2');
  });
});
