// Text helpers of the side panel (webview/panelText.ts, no DOM).

import { describe, expect, it } from 'vitest';
import { catchesLabel, insideSummary, isLinkedType, stepNote } from '../../webview/panelText';

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
