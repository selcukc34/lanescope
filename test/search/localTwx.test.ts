// Keyword search on a real BAW export (test/fixtures/local/services.twx):
// mappings, the inside of called services, sub-process levels and the
// showScripts setting. Skipped when the export is not there (CI).

import { beforeAll, describe, expect, it } from 'vitest';
import type { Process, ProcessPackage } from '../../src/model/model';
import { search } from '../../src/search/search';
import { buildSearchIndex, INSIDE_SERVICE } from '../../src/search/searchIndex';
import { readTwxPackage } from '../../src/twx/twxImport';
import { hasLocalTwx, localTwx } from '../localFixtures';

/** Only script bodies of the export hold this word: the three script steps of JsLoops (JsSampleProcess). */
const SCRIPT_WORD = 'executeServiceByName';

describe.skipIf(!hasLocalTwx('services'))('search on services.twx', () => {
  let pkg: ProcessPackage;
  const processNamed = (name: string): Process => {
    const p = pkg.processes.find((x) => x.name === name);
    if (!p) throw new Error(`process "${name}" not found`);
    return p;
  };
  const indexOf = (name: string, showScripts = true) => buildSearchIndex(pkg, { processId: processNamed(name).id, showScripts });

  beforeAll(async () => {
    pkg = await readTwxPackage(localTwx('services'));
  });

  it('finds a word of a service script while showScripts is on, under the calling activity, with the step to open', () => {
    const r = search(indexOf('JsSampleProcess'), SCRIPT_WORD);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.group).toMatchObject({ kind: 'Called service', name: 'JsLoops', where: [INSIDE_SERVICE] });
    expect(g.hits.map((h) => [h.label, h.match])).toEqual([
      ['Step "Script task" · Script', SCRIPT_WORD],
      ['Step "Script task 1" · Script', SCRIPT_WORD],
      ['Step "Script task 2" · Script', SCRIPT_WORD],
    ]);
    expect(g.hits[2]).toMatchObject({ before: 'tw.system.', after: '("HelperService", {});' });
    // Each opens the service's diagram on its own step.
    expect(new Set(g.hits.map((h) => h.open?.levelId)).size).toBe(1);
    expect(g.hits[0].open?.levelId).toMatch(/^1\./);
    expect(new Set(g.hits.map((h) => h.open?.stepId)).size).toBe(3);
  });

  it('leaves every script out while showScripts is off', () => {
    const index = indexOf('JsSampleProcess', false);
    expect(search(index, SCRIPT_WORD).groups).toEqual([]);
    expect(index.scriptsOmitted).toBeGreaterThan(10);
    expect(JSON.stringify(index)).not.toContain(SCRIPT_WORD);
    // The script task of a BPD as well.
    expect(JSON.stringify(indexOf('MyFirstProcess', false))).not.toContain('tw.local.variable1 = "123"');
    expect(search(indexOf('MyFirstProcess', true), 'variable1 = "123"').groups.map((g) => g.group.name)).toEqual(['Set Parameter']);
  });

  it('finds input mappings: the parameter, the mapped expression and literals', () => {
    const r = search(indexOf('MyFirstProcess'), 'input1');
    const call = r.groups.find((g) => g.group.name === 'Service flow1' && g.group.where.length === 0)!;
    expect(call.hits.map((h) => [h.label, `${h.before}[${h.match}]${h.after}`])).toEqual([['Input mapping', '[input1] = tw.local.variable1']]);
    const literal = search(indexOf('MyFirstProcess'), 'static').groups.find((g) => g.group.name === 'Service flow1')!;
    expect(literal.hits[0]).toMatchObject({ label: 'Input mapping', match: 'static' });
  });

  it('lists a parameter the caller does not map', () => {
    const r = search(indexOf('Demo_MainProcess'), 'not mapped');
    const child = r.groups.find((g) => g.group.name === 'DemoChildProcess 1')!;
    expect(child.hits.map((h) => `${h.before}[${h.match}]`)).toEqual(['amount: [not mapped]']);
  });

  it('finds coach controls and bindings inside a called human service', () => {
    const r = search(indexOf('Demo_MainProcess'), 'customerName');
    const g = r.groups.find((x) => x.group.name === 'Enter Customer' && x.group.where.includes(INSIDE_SERVICE))!;
    expect(g.hits.map((h) => h.label)).toContain('Coach "Coach" · Binding');
    expect(g.hits.find((h) => h.label === 'Coach "Coach" · Binding')!.open?.stepId).toBeDefined();
  });

  it('finds a literal mapping and a gateway condition inside the called service', () => {
    const r = search(indexOf('Demo_MainProcess'), '"EU"');
    expect(r.groups.map((g) => [g.group.kind, g.group.name, g.group.where])).toEqual([
      ['Task', 'Demo_Routing', []],
      ['Called service', 'Demo_Routing', [INSIDE_SERVICE]],
    ]);
    expect(r.groups[0].hits.map((h) => `${h.label}: ${h.before}[${h.match}]${h.after}`)).toEqual(['Input mapping: region = ["EU"]']);
    // The condition as written has tabs; the snippet collapses them.
    expect(r.groups[1].hits.map((h) => `${h.label}: ${h.before}[${h.match}]${h.after}`)).toEqual(['Step "Region Check" · Condition to End: tw.local.region == ["EU"]']);
  });

  it('gives a node inside a sub-process its level', () => {
    const r = search(indexOf('MyFirstProcess'), 'Service flow2');
    const g = r.groups.find((x) => x.group.kind !== 'Called service' && x.group.name === 'Service flow2')!;
    expect(g.group.where).toEqual(['Sub1']);
    expect(g.group.target).toMatchObject({ type: 'node', levels: [expect.stringMatching(/^sub:/)] });
  });

  it('searches the chosen process only, and says so', () => {
    const index = indexOf('MyFirstProcess');
    expect(index.otherProcesses).toBe(true);
    expect(search(index, 'Demo_WeatherSpecific').groups).toEqual([]);
    expect(search(indexOf('Demo_MainProcess'), 'Demo_WeatherSpecific').groups.length).toBeGreaterThan(0);
  });
});
