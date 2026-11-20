// The comparison on real BAW exports (../localFixtures); skipped when they
// are not under test/fixtures/local/. The counts of the cross-format
// comparison are logged, not fixed: they depend on how BAW imported the app.

import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import { diffProcess, matchProcess } from '../../src/diff/diff';
import type { ProcessPackage } from '../../src/model/model';
import { readTwxPackage } from '../../src/twx/twxImport';
import { V1_ZIP } from '../bobV2';
import { hasLocalTwx, localTwx } from '../localFixtures';

const REAL = hasLocalTwx('orderDelivery', 'orderDeliveryFull');

let bob: ProcessPackage;
let twx: ProcessPackage;
let twxFull: ProcessPackage;

beforeAll(async () => {
  if (!REAL) return;
  bob = await readProcessPackage(await readBpmnPackage(V1_ZIP));
  twx = await readTwxPackage(localTwx('orderDelivery'));
  twxFull = await readTwxPackage(localTwx('orderDeliveryFull'));
});

describe.skipIf(!REAL)('comparison of real exports', () => {
  it('finds no change between the export with and without its toolkits', () => {
    for (const p of twxFull.processes) {
      const base = matchProcess(twx, p, twxFull);
      expect(base, p.name).toBeDefined();
      const d = diffProcess(base!, p, twx.dataTypes, twxFull.dataTypes);
      expect(d.counts, p.name).toEqual({ added: 0, removed: 0, changed: 0 });
    }
  });

  it('compares Bob output with its BAW import (other ids, other format) without errors', () => {
    const current = twx.processes[0];
    const base = matchProcess(bob, current, twx);
    expect(base).toBe(bob.processes[0]);
    const d = diffProcess(base!, current, bob.dataTypes, twx.dataTypes);
    expect(d.nodeMatches.byId + d.nodeMatches.byName + d.nodeMatches.byNeighbors).toBeGreaterThan(0);
    // Reported, not fixed: see the PR for what these numbers mean.
    console.log(
      JSON.stringify(
        {
          nodes: { bob: base!.nodes.length, twx: current.nodes.length },
          flows: { bob: base!.flows.length, twx: current.flows.length },
          lanes: { bob: base!.lanes.length, twx: current.lanes.length },
          nodeMatches: d.nodeMatches,
          counts: d.counts,
          added: d.added.map((e) => e.label),
          removed: d.removed.map((e) => e.label),
          changed: d.changed.map((e) => `${e.label}: ${e.changes.join(' | ')}`),
        },
        null,
        2,
      ),
    );
  });
});
