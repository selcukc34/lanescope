// Text helpers of the side panel (webview/panelText.ts, no DOM).

import { describe, expect, it } from 'vitest';
import { catchesLabel, insideSummary, isLinkedType, stepNote, changesTabTitle, clockTime, comparedWithText, NOTHING_TO_COMPARE, changeGroups } from '../../webview/panelText';
import type { DiffEntry } from '../../src/diff/diff';

describe('panel text', () => {
  it('links a type only when the Data tab has it: System Data types stay plain text', () => {
    const known = new Set(['OrderRequest', 'Customer']);
    expect(isLinkedType('OrderRequest', known)).toBe(true);
    for (const t of ['String', 'Decimal', 'Integer', 'Boolean', 'Date', 'XMLElement', 'NameValuePair']) {
      expect(isLinkedType(t, known)).toBe(false);
    }
    expect(isLinkedType(undefined, known)).toBe(false);
    expect(isLinkedType('itm.12.unknown', known)).toBe(false);
  });

  it('summarises a called service', () => {
    expect(insideSummary({ name: 'S', kind: 'Service flow', steps: [] })).toBe('Service flow · 0 steps');
    expect(insideSummary({ name: 'S', steps: [{ name: 'a', kind: 'script' }] })).toBe('1 step');
  });

  it('says what an error boundary catches', () => {
    expect(catchesLabel({ name: 'Error', catchAll: true })).toBe('catches: all');
    expect(catchesLabel({ name: 'Error', catchAll: false, errorCode: '_WEATHER_TIMEOUT' })).toBe('catches: _WEATHER_TIMEOUT');
    expect(catchesLabel({ name: 'Error', catchAll: false })).toBe('');
  });

  it('shows the event type only when the name does not already say it', () => {
    expect(stepNote({ name: 'Stay on page', kind: 'event', eventType: 'Stay on page' })).toBeUndefined();
    expect(stepNote({ name: 'End event', kind: 'end', eventType: 'Error' })).toBe('Error');
    expect(stepNote({ name: 'Low', kind: 'script' })).toBeUndefined();
  });
});

describe('Changes tab text', () => {
  const at = new Date(2026, 10, 20, 14, 32, 5).getTime();

  it('names the base: a file, or the previous version with the time it was read', () => {
    expect(comparedWithText({ baseKind: 'file', baseLabel: 'order-delivery-process.v2.zip', loadedAt: at })).toBe('Changes from order-delivery-process.v2.zip to the shown file');
    expect(comparedWithText({ baseKind: 'previous', baseLabel: 'order.zip', loadedAt: at })).toBe('Compared with the previous version (loaded 14:32)');
    expect(clockTime(new Date(2026, 0, 2, 9, 5).getTime())).toBe('09:05');
  });

  it('counts added, removed and changed entries in the tab title', () => {
    expect(changesTabTitle(undefined)).toBe('Changes');
    expect(changesTabTitle({ counts: { added: 2, removed: 2, changed: 6 } })).toBe('Changes (10)');
    expect(changesTabTitle({ counts: { added: 0, removed: 0, changed: 0 } })).toBe('Changes (0)');
    expect(changesTabTitle({ counts: { added: 0, removed: 0, changed: 0 }, note: 'Comparison covers processes only.' })).toBe('Changes');
    expect(NOTHING_TO_COMPARE).toMatch(/^Nothing to compare yet\. /);
  });
});

describe('Changes tab rows', () => {
  const entry = (elementType: DiffEntry['elementType'], label: string, ids: { currentId?: string; baseId?: string }, changes: string[] = []): DiffEntry => ({
    elementType,
    label,
    changes,
    ...ids,
  });
  const diff = {
    added: [entry('node', 'Task "New"', { currentId: 'n1' }), entry('flow', 'Flow "Hidden"', { currentId: 'hidden' }), entry('dataType', 'Business object "Added"', { currentId: 'Added' })],
    changed: [
      entry('process', 'Process "P"', { currentId: 'p', baseId: 'p' }, ['Name: "A" → "B"']),
      entry('lane', 'Lane "L"', { currentId: 'l1', baseId: 'l0' }, ['Name: "K" → "L"']),
      entry('flow', 'Flow "F"', { currentId: 'f1', baseId: 'f1' }, ['Target: "A" → "B"']),
      entry('dataType', 'Business object "Order"', { currentId: 'Order', baseId: 'Order' }, ['Field removed: x']),
    ],
    removed: [entry('node', 'Task "Old"', { baseId: 'n1' }), entry('dataType', 'Business object "Gone"', { baseId: 'Gone' })],
  };
  // n1 is in both versions' id space on purpose: a removed row never links, whatever its id.
  const drawn = { n1: {}, l1: {}, f1: {}, p: {}, Added: {}, Order: {} };

  it('links only added and changed nodes, flows and lanes that are drawn, by their current id', () => {
    const g = changeGroups(diff, drawn);
    expect(g.added.map((r) => [r.label, r.revealId])).toEqual([
      ['Task "New"', 'n1'],
      ['Flow "Hidden"', undefined],
    ]);
    expect(g.changed.map((r) => [r.label, r.revealId])).toEqual([
      ['Process "P"', undefined],
      ['Lane "L"', 'l1'],
      ['Flow "F"', 'f1'],
    ]);
    expect(g.removed.map((r) => [r.label, r.revealId])).toEqual([['Task "Old"', undefined]]);
    expect(g.businessObjects.map((r) => [r.status, r.label, r.revealId])).toEqual([
      ['added', 'Business object "Added"', undefined],
      ['changed', 'Business object "Order"', undefined],
      ['removed', 'Business object "Gone"', undefined],
    ]);
    expect(g.changed[2].changes).toEqual(['Target: "A" → "B"']);
  });

  it('does not take an inherited property for a drawn element', () => {
    expect(changeGroups({ added: [entry('node', 'Task "x"', { currentId: 'toString' })], changed: [], removed: [] }, {}).added[0].revealId).toBeUndefined();
  });
});
