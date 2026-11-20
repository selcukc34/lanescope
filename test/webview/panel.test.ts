// The side panel's tabs (webview/panel.ts). The tests run in Node, so a tiny
// stand-in for `document` gives the panel the few DOM calls its constructor
// and tab switching make.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTabId, SidePanel, TAB_IDS, type TabId } from '../../webview/panel';

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classes = new Set<string>();
  hidden = false;

  constructor(readonly text = '') {}

  set className(value: string) {
    this.classes.clear();
    for (const c of value.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }

  get classList() {
    return {
      toggle: (name: string, on: boolean) => void (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click(): void {
    for (const l of this.listeners.get('click') ?? []) l();
  }

  find(id: string): FakeNode | undefined {
    if (this.attributes.get('id') === id) return this;
    for (const c of this.children) {
      const hit = c.find(id);
      if (hit) return hit;
    }
    return undefined;
  }
}

const g = globalThis as { document?: unknown };
let saved: unknown;

beforeAll(() => {
  saved = g.document;
  g.document = { createElement: () => new FakeNode(), createTextNode: (t: string) => new FakeNode(t) };
});

afterAll(() => {
  g.document = saved;
});

const NO_CHANGES = { reveal: () => undefined, clearComparison: () => undefined };

function panelWith(initialTab?: TabId): { panel: SidePanel; reported: TabId[]; root: FakeNode } {
  const reported: TabId[] = [];
  const panel = new SidePanel((t) => reported.push(t), () => undefined, NO_CHANGES, initialTab);
  return { panel, reported, root: panel.element as unknown as FakeNode };
}

function shownTab(root: FakeNode): string[] {
  return TAB_IDS.filter((id) => root.find(`tab-${id}`)!.classList.contains('active'));
}

describe('side panel tabs', () => {
  it('starts on Details without reporting a tab change', () => {
    const { panel, reported, root } = panelWith();
    expect(panel.activeTab).toBe('details');
    expect(shownTab(root)).toEqual(['details']);
    expect(reported).toEqual([]);
  });

  it('starts on the given tab (the one saved before the webview was rebuilt) without reporting it', () => {
    const { panel, reported, root } = panelWith('warnings');
    expect(panel.activeTab).toBe('warnings');
    expect(shownTab(root)).toEqual(['warnings']);
    expect(root.find('tab-warnings')!.getAttribute('aria-selected')).toBe('true');
    expect(root.find('tab-details')!.getAttribute('aria-selected')).toBe('false');
    expect(reported).toEqual([]);
  });

  it('reports a click on a tab and showTab calls, so they are saved', () => {
    const { panel, reported, root } = panelWith('data');
    root.find('tab-changes')!.click();
    panel.showTab('details');
    expect(reported).toEqual(['changes', 'details']);
    expect(panel.activeTab).toBe('details');
  });

  it('knows its tab ids', () => {
    for (const id of TAB_IDS) expect(isTabId(id)).toBe(true);
    for (const v of [undefined, null, '', 'Details', 'settings', 3, {}]) expect(isTabId(v)).toBe(false);
  });
});
