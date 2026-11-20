// Keyword search (src/search): what the index of a whole file holds for Bob
// output and the synthetic TWX export, the grouping by object, the scope
// filter, case folding, snippets and the hit limit.

import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { FlowNode, ProcessPackage } from '../../src/model/model';
import {
  findObject,
  foldCase,
  matchesSummary,
  MAX_HITS,
  search,
  SCRIPTS_NOT_SEARCHED,
  SNIPPET_CONTEXT,
  TOOLKITS_NOT_SEARCHED,
  truncatedNote,
  type SearchIndex,
  type SearchResult,
} from '../../src/search/search';
import { buildSearchIndex } from '../../src/search/searchIndex';
import { CHECK_STOCK_ID, DISCOUNT_SERVICE_ID, PRICE_SERVICE_ID, syntheticTwxPackage } from '../syntheticTwx';

const BOB_ZIP = path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process.zip');
const VALIDATE_ID = 'bpmnid-ca534cf5-ff40-5898-873c-68c5b8ff5674';
const ROUTE_GATEWAY_ID = 'bpmnid-77703ca3-6892-5eb3-99bb-7aace6e9d4d5';
const EXCEPTION_FLOW_ID = 'bpmnid-e60e39f8-8ad4-5c29-a934-8bc13a6f4a3e';
const VALID_FLOW_ID = 'bpmnid-32b1df0c-368e-5cb2-8558-f8d2ff32ce09';
const TO_VALIDATE_FLOW_ID = 'bpmnid-f634281f-4799-5e29-a45a-feb2141bb9e7';

const groupsOf = (r: SearchResult) => r.objects.flatMap((o) => o.groups);
/** "Kind | Name | where…": one line per result group. */
const heads = (r: SearchResult) => groupsOf(r).map((g) => [g.group.kind, g.group.name, ...g.group.where].join(' | '));
const objectsOf = (r: SearchResult) => r.objects.map((o) => `${o.object.label}: ${o.object.name}`);
const snippet = (h: { before: string; match: string; after: string }) => `${h.before}[${h.match}]${h.after}`;

/** A one-object index of plain texts. */
function textIndex(texts: string[]): SearchIndex {
  return {
    objects: [{ kind: 'process', label: 'Process', name: 'P', id: 'p' }],
    groups: [{ object: 0, target: { type: 'root' }, kind: 'Process', name: 'P', where: [] }],
    fields: texts.map((text) => ({ group: 0, label: 'Documentation', text })),
    scriptsOmitted: 0,
    toolkitsNotSearched: false,
  };
}

let bob: ProcessPackage;
let bobIndex: SearchIndex;

beforeAll(async () => {
  bob = await readProcessPackage(await readBpmnPackage(BOB_ZIP));
  bobIndex = await buildSearchIndex(bob, { showScripts: true });
});

describe('case folding', () => {
  it('lower-cases each unit in place and folds the Turkish I forms to "i"', () => {
    expect(foldCase('Validate ORDER')).toBe('validate order');
    expect(foldCase('İSTANBUL ılık Işık')).toBe('istanbul ilik işik');
    // Same length, so offsets in the folded text are offsets in the original.
    for (const s of ['İstanbul', 'ẞtraße', 'ǅemal', 'Ωmega']) expect(foldCase(s)).toHaveLength(s.length);
  });

  it('finds İ, I, ı and i alike, and ignores case', () => {
    const index = textIndex(['İstanbul Office', 'ISTANBUL', 'ıstanbul', 'Istanbul']);
    expect(search(index, 'istanbul').total).toBe(4);
    expect(search(index, 'İSTANBUL').total).toBe(4);
    expect(groupsOf(search(index, 'office'))[0].hits.map((h) => h.match)).toEqual(['Office']);
  });
});

describe('search on Bob output', () => {
  it('groups the process and the business objects of the XSD as objects', () => {
    expect(bobIndex.objects.map((o) => `${o.label}: ${o.name}`)).toEqual(['Process: Order Delivery Process', 'Business object: OrderRequest']);
    const r = search(bobIndex, 'order');
    expect(objectsOf(r)).toEqual(['Process: Order Delivery Process', 'Business object: OrderRequest']);
    expect(r.objects[0].hitCount + r.objects[1].hitCount).toBe(r.shown);
    expect(matchesSummary(r)).toBe(`${r.shown} matches in 2 objects`);
  });

  it('"order" finds many nodes, flows, the process and the business object', () => {
    const r = search(bobIndex, 'order');
    expect(r.tooShort).toBe(false);
    expect(r.groupCount).toBe(groupsOf(r).length);
    expect(r.groupCount).toBeGreaterThan(20);
    const groups = groupsOf(r);
    expect(groups.filter((g) => g.group.target.type === 'node').length).toBeGreaterThanOrEqual(10);
    expect(groups.some((g) => g.group.target.type === 'flow')).toBe(true);
    expect(groups.some((g) => g.group.target.type === 'root')).toBe(true);
    expect(groups.find((g) => g.group.name === 'Compliance Review')!.hits.map((h) => h.label)).toContain('Input');
  });

  it('"Validate": name hits first, in diagram order: the task, then the flow named after it', () => {
    const r = search(bobIndex, 'Validate');
    expect(heads(r).slice(0, 2)).toEqual(['Task | Validate Order SF', 'Sequence flow | To Validate Order SF']);
    const [task, flow] = groupsOf(r);
    expect(task.group.target).toEqual({ type: 'node', id: VALIDATE_ID, levels: [] });
    expect(flow.group.target).toEqual({ type: 'flow', id: TO_VALIDATE_FLOW_ID, levels: [] });
    expect(task.hits[0]).toMatchObject({ label: 'Name', before: '', match: 'Validate', after: ' Order SF' });
    const firstOther = groupsOf(r).findIndex((g) => !g.hits.some((h) => h.label === 'Name'));
    expect(groupsOf(r).slice(firstOther).every((g) => !g.hits.some((h) => h.label === 'Name'))).toBe(true);
  });

  it('"EXCEPTION": the default flow of Route Order named EXCEPTION, and the condition of "Valid"', () => {
    const groups = groupsOf(search(bobIndex, 'EXCEPTION'));
    const exception = groups.find((g) => g.group.target.type === 'flow' && g.group.target.id === EXCEPTION_FLOW_ID)!;
    expect(exception.group).toMatchObject({ kind: 'Default flow', name: 'EXCEPTION' });
    const valid = groups.find((g) => g.group.target.type === 'flow' && g.group.target.id === VALID_FLOW_ID)!;
    expect(valid.hits.map((h) => [h.label, snippet(h)])).toEqual([['Condition', 'tw.local.order.route != "[EXCEPTION]"']]);
    expect(groups.some((g) => g.group.target.type === 'node' && g.group.target.id === ROUTE_GATEWAY_ID)).toBe(true);
  });

  it('"countryRegion": the field of the XSD business object, with the field to show', () => {
    const r = search(bobIndex, 'countryRegion');
    // The process names it in documentation too; the business object comes after it.
    expect(objectsOf(r)).toEqual(['Process: Order Delivery Process', 'Business object: OrderRequest']);
    const bo = r.objects[1].groups[0];
    expect(bo.group.target).toEqual({ type: 'dataType', name: 'OrderRequest' });
    expect(bo.hits).toEqual([expect.objectContaining({ label: 'Field', match: 'countryRegion', dataField: 'countryRegion' })]);
  });

  it('ignores case and surrounding white space; a query shorter than 2 characters is not searched', () => {
    expect(heads(search(bobIndex, '  ROUTE ORDER  '))).toEqual(heads(search(bobIndex, 'route order')));
    for (const q of ['', ' ', 'o', '  o  ']) expect(search(bobIndex, q)).toMatchObject({ tooShort: true, objects: [], total: 0 });
    expect(search(bobIndex, 'or').tooShort).toBe(false);
  });

  it('is a plain substring search: regular expression characters are literal', () => {
    expect(search(bobIndex, '.*').total).toBe(0);
    expect(groupsOf(search(bobIndex, '!= "')).map((g) => g.group.name)).toEqual(['Valid']);
  });

  it('builds a snippet of up to 40 characters on each side, white space collapsed, the match as written', () => {
    const doc = bob.processes[0].nodes.find((n) => n.id === ROUTE_GATEWAY_ID)!.documentation!;
    const h = groupsOf(search(bobIndex, 'four paths')).find((g) => g.group.name === 'Route Order')!.hits.find((x) => x.label === 'Documentation')!;
    const at = doc.toLowerCase().indexOf('four paths');
    expect(h.match).toBe(doc.slice(at, at + 10));
    const before = h.before.replace(/^…/, '');
    const after = h.after.replace(/…$/, '');
    expect(before.length).toBeLessThanOrEqual(SNIPPET_CONTEXT);
    expect(after.length).toBeLessThanOrEqual(SNIPPET_CONTEXT);
    expect(doc.replace(/\s+/g, ' ')).toContain(`${before}${h.match}${after}`);
    expect(h.after.endsWith('…')).toBe(at + 10 + SNIPPET_CONTEXT < doc.length);
    expect(h.before.startsWith('…')).toBe(at > SNIPPET_CONTEXT);
  });

  it('lists every occurrence in a field; matches do not overlap', () => {
    expect(groupsOf(search(textIndex(['aa aa aaa']), 'aa'))[0].hits.map(snippet)).toEqual(['[aa] aa aaa', 'aa [aa] aaa', 'aa aa [aa]a']);
  });

  it(`lists at most ${MAX_HITS} hits and says so`, () => {
    const index: SearchIndex = {
      objects: [{ kind: 'process', label: 'Process', name: 'P', id: 'p' }],
      groups: Array.from({ length: 30 }, (_, i) => ({ object: 0, target: { type: 'node' as const, id: `n${i}`, levels: [] }, kind: 'Task', name: `Task ${i}`, where: [] })),
      fields: Array.from({ length: 30 }, (_, i) => ({ group: i, label: 'Documentation', text: 'needle '.repeat(20) })),
      scriptsOmitted: 0,
      toolkitsNotSearched: false,
    };
    const r = search(index, 'needle');
    expect(r).toMatchObject({ total: 600, shown: MAX_HITS, truncated: true, groupCount: 25 });
    expect(groupsOf(r).flatMap((g) => g.hits)).toHaveLength(MAX_HITS);
    expect(truncatedNote(r)).toBe('Showing first 500 matches');
    expect(truncatedNote(search(bobIndex, 'order'))).toBeUndefined();
  });

  it('has no scripts and no toolkits to leave out', () => {
    expect(bobIndex).toMatchObject({ scriptsOmitted: 0, toolkitsNotSearched: false });
    expect(SCRIPTS_NOT_SEARCHED).toBe('Scripts were not searched because lanescope.showScripts is off.');
    expect(TOOLKITS_NOT_SEARCHED).toBe('Toolkits are not searched.');
  });
});

describe('search on the synthetic TWX export', () => {
  let twx: ProcessPackage;
  let index: SearchIndex;
  beforeAll(async () => {
    twx = await syntheticTwxPackage({ subProcess: true });
    index = await buildSearchIndex(twx, { showScripts: true });
  });

  it('lists every process, every service (called or not) and every business object', () => {
    expect(index.objects.map((o) => [o.kind, o.name])).toEqual([
      ['process', 'Synthetic Order'],
      ['service', 'Apply Discount'],
      ['service', 'Price Order'],
    ]);
    const price = index.objects[findObject(index, 'service', PRICE_SERVICE_ID)!];
    const bpd = twx.processes[0].id;
    // Drawn below the activity that calls it; it calls Apply Discount.
    expect(price).toMatchObject({ label: 'Service flow', openable: true, level: { processId: bpd, below: [PRICE_SERVICE_ID] }, calls: [DISCOUNT_SERVICE_ID] });
    expect(price.calledBy).toEqual([{ via: 'process', ownerName: 'Synthetic Order', nodeId: 'node_review', name: 'Review Order', level: { processId: bpd, below: [] } }]);
    expect(index.objects[0]).toMatchObject({ kind: 'process', level: { processId: bpd, below: [] }, calls: [PRICE_SERVICE_ID] });
  });

  it('counts a step of a service as a caller: Apply Discount is called by Price Order', () => {
    const r = search(index, 'Apply Discount');
    const service = r.objects.find((o) => o.object.kind === 'service' && o.object.id === DISCOUNT_SERVICE_ID)!;
    const callStep = Object.values(r.objects.find((o) => o.object.id === PRICE_SERVICE_ID)!.groups).find((g) => g.group.name === 'Call Discount')!;
    expect(service.object.calledBy).toEqual([
      {
        via: 'service',
        ownerName: 'Price Order',
        nodeId: (callStep.group.target as { id: string }).id,
        name: 'Call Discount',
        // The step is drawn in Price Order, which opens below Review Order.
        level: { processId: twx.processes[0].id, below: [PRICE_SERVICE_ID] },
      },
    ]);
    // No process calls it: it opens on its own.
    expect(service.object.level).toEqual({ serviceId: DISCOUNT_SERVICE_ID, below: [] });
    expect(service.groups[0].hits[0]).toMatchObject({ label: 'Name', match: 'Apply Discount' });
    expect(service.groups[0].group.target).toEqual({ type: 'root' });
  });

  it('a service nothing calls has no callers and opens on its own; so do the steps it holds', async () => {
    const pkg = await syntheticTwxPackage();
    delete pkg.processes[0].nodes.find((n) => n.name === 'Review Order')!.calledElement;
    const alone = await buildSearchIndex(pkg, { showScripts: true });
    const price = alone.objects[findObject(alone, 'service', PRICE_SERVICE_ID)!];
    expect(price).toMatchObject({ calledBy: [], level: { serviceId: PRICE_SERVICE_ID, below: [] } });
    // Its step still calls Apply Discount, from where Price Order is drawn now.
    expect(alone.objects[findObject(alone, 'service', DISCOUNT_SERVICE_ID)!].calledBy!.map((c) => c.level)).toEqual([{ serviceId: PRICE_SERVICE_ID, below: [] }]);
  });

  it('lists the inside of a service once, under the service, with every caller; a caller keeps its own hits', async () => {
    const pkg = await syntheticTwxPackage({ subProcess: true });
    const bpd = pkg.processes[0];
    const review = bpd.nodes.find((n) => n.name === 'Review Order')!;
    const second: FlowNode = { ...review, id: 'node:review2', name: 'Review Again' };
    bpd.nodes.push(second);
    const twice = await buildSearchIndex(pkg, { showScripts: true });
    const r = search(twice, 'Compute Total');
    expect(objectsOf(r)).toEqual(['Service flow: Price Order']);
    expect(r.objects[0].groups.map((g) => [g.group.kind, g.group.name])).toEqual([['Script task', 'Compute Total']]);
    expect(r.objects[0].object.calledBy!.map((c) => c.name)).toEqual(['Review Order', 'Review Again']);
    // The callers' own fields (their names, what they call) stay in the process.
    const callers = search(twice, 'Price Order');
    expect(callers.objects.find((o) => o.object.kind === 'process')!.groups.map((g) => g.group.name)).toEqual(['Review Order', 'Review Again']);
  });

  it('finds a hit of another process in that process object', async () => {
    const pkg = await syntheticTwxPackage({ subProcess: true });
    const other = await syntheticTwxPackage({ otherIds: true });
    other.processes[0].name = 'Second Order';
    other.processes[0].nodes.find((n) => n.name === 'Approved?')!.name = 'Approved twice?';
    pkg.processes.push(other.processes[0]);
    const two = await buildSearchIndex(pkg, { showScripts: true });
    const shown = findObject(two, 'process', pkg.processes[0].id)!;
    const r = search(two, 'twice', { scope: 'file', shownObject: shown });
    expect(objectsOf(r)).toEqual(['Process: Second Order']);
    expect(r.objects[0].shown).toBe(false);
    expect(r.objects[0].object.id).toBe(other.processes[0].id);
    expect(r.objects[0].groups[0].group).toMatchObject({ kind: 'Exclusive gateway', name: 'Approved twice?' });
    // The shown process first, the other one after it.
    const both = search(two, 'Approved', { scope: 'file', shownObject: shown });
    expect(both.objects.map((o) => [o.object.name, o.shown])).toEqual([
      ['Synthetic Order', true],
      ['Second Order', false],
    ]);
    // "Shown process": the shown process (its sub-processes are part of it) and the services it calls, one level.
    const only = search(two, 'Approved', { scope: 'shown', shownObject: shown });
    expect(objectsOf(only)).toEqual(['Process: Synthetic Order']);
    expect(search(two, 'twice', { scope: 'shown', shownObject: shown }).objects).toEqual([]);
    expect(objectsOf(search(two, 'Compute Total', { scope: 'shown', shownObject: shown }))).toEqual(['Service flow: Price Order']);
    // Apply Discount is two levels down: not taken in.
    expect(objectsOf(search(two, 'Discount', { scope: 'shown', shownObject: shown }))).toEqual(['Service flow: Price Order']);
    // The whole file: every service, in index order (by name).
    expect(objectsOf(search(two, 'Discount', { scope: 'file', shownObject: shown }))).toEqual(['Service flow: Apply Discount', 'Service flow: Price Order']);
    // The shown object can be a service too: with the services it calls.
    const price = findObject(two, 'service', PRICE_SERVICE_ID)!;
    expect(objectsOf(search(two, 'Discount', { scope: 'shown', shownObject: price }))).toEqual(['Service flow: Price Order', 'Service flow: Apply Discount']);
  });

  it('gives a node inside a sub-process its level, and a service called from there the caller level', async () => {
    const g = groupsOf(search(index, 'Count Items')).find((x) => x.group.kind === 'Script task')!;
    expect(g.group).toMatchObject({ name: 'Count Items', where: ['Check Stock'], target: { type: 'node', levels: [`sub:${CHECK_STOCK_ID}`] } });
    const reserve = groupsOf(search(index, 'Reserve Start'))[0];
    expect(reserve.group.where).toEqual(['Check Stock', 'Reserve Items']);

    const pkg = await syntheticTwxPackage({ subProcess: true });
    const nodes = pkg.processes[0].nodes;
    nodes.find((n) => n.name === 'Review Order')!.parentId = nodes.find((n) => n.name === 'Check Stock')!.id;
    const moved = await buildSearchIndex(pkg, { showScripts: true });
    const price = moved.objects[findObject(moved, 'service', PRICE_SERVICE_ID)!];
    expect(price.calledBy![0].level).toEqual({ processId: pkg.processes[0].id, below: [`sub:${CHECK_STOCK_ID}`] });
    expect(price.level).toEqual({ processId: pkg.processes[0].id, below: [`sub:${CHECK_STOCK_ID}`, PRICE_SERVICE_ID] });
  });

  it('searches scripts only while showScripts is on', async () => {
    const off = await buildSearchIndex(twx, { showScripts: false });
    const scriptHits = (i: SearchIndex) => groupsOf(search(i, 'tw.local.')).flatMap((g) => g.hits.filter((h) => h.label === 'Script').map(() => g.group.name));
    expect([...new Set(scriptHits(index))].sort()).toEqual(['Compute Total', 'Count Items']);
    expect(scriptHits(off)).toEqual([]);
    expect(index.scriptsOmitted).toBe(0);
    expect(off.scriptsOmitted).toBe(2);
    expect(search(off, 'anything').scriptsOmitted).toBe(2);
    expect(JSON.stringify(off)).not.toContain('tw.local.count = 1');
    expect(JSON.stringify(off)).not.toContain('tw.local.amount * 1.2');
  });

  it('says that packed toolkits are not searched', async () => {
    expect(index.toolkitsNotSearched).toBe(false);
    const pkg = await syntheticTwxPackage();
    pkg.source.twx!.packedToolkits = 2;
    const withToolkits = await buildSearchIndex(pkg, { showScripts: true });
    expect(withToolkits.toolkitsNotSearched).toBe(true);
    expect(search(withToolkits, 'Order').toolkitsNotSearched).toBe(true);
  });
});
