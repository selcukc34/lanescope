// Keyword search of a whole real BAW export (test/fixtures/local/services.twx):
// other BPDs, services called or not, services with several callers,
// mappings, sub-process levels, showScripts and packed toolkits. Skipped
// when the export is not there (CI).

import { beforeAll, describe, expect, it } from 'vitest';
import type { ProcessPackage } from '../../src/model/model';
import { findObject, search, type SearchIndex, type SearchResult } from '../../src/search/search';
import { buildSearchIndex } from '../../src/search/searchIndex';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

/** Only script bodies of the export hold this word: the three script steps of the service JsLoops. */
const SCRIPT_WORD = 'executeServiceByName';

const groupsOf = (r: SearchResult) => r.objects.flatMap((o) => o.groups);
const objectsOf = (r: SearchResult) => r.objects.map((o) => `${o.object.label}: ${o.object.name}`);
const snippet = (h: { label: string; before: string; match: string; after: string }) => `${h.label}: ${h.before}[${h.match}]${h.after}`;

describe.skipIf(!hasLocalTwx('services'))('search of the whole of services.twx', () => {
  let pkg: ProcessPackage;
  let index: SearchIndex;
  /** The search as the viewer runs it with the named process shown. */
  const shownAs = (name: string, query: string, scope: 'file' | 'shown' = 'file') => {
    const id = pkg.processes.find((p) => p.name === name)!.id;
    return search(index, query, { scope, shownObject: findObject(index, 'process', id) });
  };

  beforeAll(async () => {
    pkg = await readTwxPackage(localTwx('services'));
    index = await buildSearchIndex(pkg, { showScripts: true });
  });

  it('lists every BPD, every service and every business object of the export', () => {
    const count = (kind: string) => index.objects.filter((o) => o.kind === kind).length;
    expect(count('process')).toBe(pkg.processes.length);
    expect(count('dataType')).toBe(pkg.dataTypes.length);
    expect(count('service')).toBe(pkg.calleeDiagrams!.list().length);
    expect(count('service')).toBeGreaterThan(20);
    // Packed toolkits are not read.
    expect(index.toolkitsNotSearched).toBe(true);
  });

  it('finds a node of another BPD in that BPD, after the shown one', () => {
    const r = shownAs('Demo_MainProcess', 'Decide');
    expect(objectsOf(r)).toEqual(['Process: DemoChildProcess']);
    expect(r.objects[0].shown).toBe(false);
    expect(r.objects[0].groups[0].group).toMatchObject({ kind: 'Script task', name: 'Decide', target: { type: 'node', levels: [] } });
    expect(shownAs('Demo_MainProcess', 'Decide', 'shown').objects).toEqual([]);
  });

  it('finds a service no process calls', () => {
    const r = shownAs('Demo_MainProcess', 'Orphan');
    expect(objectsOf(r)).toEqual(['Service flow: Demo_OrphanWeather']);
    expect(r.objects[0].object).toMatchObject({ calledBy: [], openable: true });
  });

  it('lists a service with several callers once, naming every caller', () => {
    const service = index.objects.find((o) => o.kind === 'service' && o.name === 'Service flow1')!;
    expect(service.calledBy!.map((c) => `${c.name} @ ${c.processName}`)).toEqual([
      'Service flow1 @ JsSampleProcess',
      'Service flow1 @ MyFirstProcess',
      'Copy of Service flow1 @ MyFirstProcess',
    ]);
    const r = shownAs('MyFirstProcess', 'Service flow1');
    expect(r.objects.filter((o) => o.object.kind === 'service' && o.object.name === 'Service flow1')).toHaveLength(1);
  });

  it('finds a word of a service script while showScripts is on, in the service, once', async () => {
    const r = shownAs('JsSampleProcess', SCRIPT_WORD);
    expect(objectsOf(r)).toEqual(['Service flow: JsLoops']);
    expect(r.objects[0].object.calledBy!.map((c) => `${c.name} @ ${c.processName}`)).toEqual(['JsLoops @ JsSampleProcess']);
    expect(groupsOf(r).map((g) => [g.group.kind, g.group.name, g.hits.map((h) => h.label)])).toEqual([
      ['Script task', 'Script task', ['Script']],
      ['Script task', 'Script task 1', ['Script']],
      ['Script task', 'Script task 2', ['Script']],
    ]);
    expect(groupsOf(r)[2].hits[0]).toMatchObject({ before: 'tw.system.', after: '("HelperService", {});' });

    const off = await buildSearchIndex(pkg, { showScripts: false });
    expect(search(off, SCRIPT_WORD).objects).toEqual([]);
    expect(off.scriptsOmitted).toBeGreaterThan(10);
    expect(JSON.stringify(off)).not.toContain(SCRIPT_WORD);
    expect(JSON.stringify(off)).not.toContain('tw.local.variable1 = "123"');
  });

  it('finds input mappings: the parameter, the mapped expression, literals and "not mapped"', () => {
    const call = groupsOf(shownAs('MyFirstProcess', 'input1', 'shown')).find((g) => g.group.name === 'Service flow1')!;
    expect(call.hits.map(snippet)).toEqual(['Input mapping: [input1] = tw.local.variable1']);
    const child = groupsOf(shownAs('Demo_MainProcess', 'not mapped', 'shown')).find((g) => g.group.name === 'DemoChildProcess 1')!;
    expect(child.hits.map((h) => `${h.before}[${h.match}]`)).toEqual(['amount: [not mapped]']);
  });

  it('finds coach bindings and gateway conditions in the service, the caller\'s mapping in the process', () => {
    const coach = shownAs('Demo_MainProcess', 'customerName').objects.find((o) => o.object.name === 'Demo_CustomerForm')!;
    expect(coach.object.calledBy!.map((c) => c.name)).toEqual(['Enter Customer']);
    expect(coach.groups.flatMap((g) => g.hits.map((h) => h.label))).toContain('Binding');

    const r = shownAs('Demo_MainProcess', '"EU"');
    // The whole file: a script of another service compares with "EU" too.
    expect(objectsOf(r)).toEqual(['Process: Demo_MainProcess', 'Service flow: Demo_Routing', 'Service flow: JsLongScripts']);
    expect(r.objects[0].groups.flatMap((g) => g.hits.map(snippet))).toEqual(['Input mapping: region = ["EU"]']);
    expect(r.objects[1].groups.flatMap((g) => g.hits.map(snippet))).toEqual(['Condition: tw.local.region == ["EU"]']);
  });

  it('gives a node inside a sub-process its level', () => {
    const g = groupsOf(shownAs('MyFirstProcess', 'Service flow2', 'shown')).find((x) => x.group.name === 'Service flow2')!;
    expect(g.group.where).toEqual(['Sub1']);
    expect(g.group.target).toMatchObject({ type: 'node', levels: [expect.stringMatching(/^sub:/)] });
  });
});
