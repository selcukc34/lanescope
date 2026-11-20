// The description check in the viewer session: attach (found or picked),
// the one-time Trace tab switch, Clear (command and webview message), a
// description that changes on disk or cannot be read, the chosen process,
// and that the comparison, the warnings and the exports stay as they were.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBpmnPackage } from '../../src/input/bpmnInput';
import { readProcessPackage } from '../../src/bpmn/bpmnReader';
import type { ProcessPackage } from '../../src/model/model';
import { parseWebviewMessage, type HostMessage, type RenderMessage } from '../../src/views/protocol';
import { ViewerSession, type Timers } from '../../src/views/viewerSession';
import { descriptionCandidates } from '../../src/views/watchPattern';
import { V1_ZIP, V2_ZIP } from '../bobV2';

const MD_PATH = '/work/order-delivery-process-description.md';
const DESCRIPTION = readFileSync(path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process-description.md'), 'utf8');

let v1: ProcessPackage;
let v2: ProcessPackage;
beforeAll(async () => {
  v1 = await readProcessPackage(await readBpmnPackage(V1_ZIP));
  v2 = await readProcessPackage(await readBpmnPackage(V2_ZIP));
});

class ManualTimers implements Timers {
  private readonly timers = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  fire(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const cb of callbacks) cb();
  }
}

function session(content: ProcessPackage) {
  const timers = new ManualTimers();
  const posted: HostMessage[] = [];
  const files: Record<string, string | Error> = { [MD_PATH]: DESCRIPTION };
  const attached: Array<[string | undefined, boolean]> = [];
  const file = { content };
  const s = new ViewerSession({
    fileName: 'order-delivery-process.zip',
    load: async () => file.content,
    post: (m) => posted.push(m),
    timers,
    descriptions: {
      read: async (p) => {
        const text = files[p];
        if (text === undefined) throw new Error('ENOENT');
        if (text instanceof Error) throw text;
        return text;
      },
      attached: (p, byUser) => attached.push([p, byUser]),
    },
  });
  return {
    s,
    posted,
    files,
    attached,
    file,
    timers,
    last: () => posted.filter((m): m is RenderMessage => m.type === 'render').at(-1)!,
    renders: () => posted.filter((m) => m.type === 'render').length,
  };
}

async function opened(content: ProcessPackage) {
  const t = session(content);
  await t.s.start();
  await t.s.handleMessage({ type: 'ready' });
  return t;
}

describe('description check in the session', () => {
  it('sends no trace while no description is attached', async () => {
    const t = await opened(v1);
    expect(t.last().trace).toBeUndefined();
  });

  it('a found description: the check comes with the render, without switching tabs', async () => {
    const t = await opened(v1);
    await t.s.setDescription(MD_PATH);
    const trace = t.last().trace!;
    expect(trace.fileName).toBe('order-delivery-process-description.md');
    expect(trace.summary).toBe('19 of 41 matched · 5 near · 0 missing · 17 unchecked · 1 extra');
    expect(trace.rows).toHaveLength(42);
    expect(t.last().showTrace).toBeUndefined();
    expect(t.last().preserveView).toBe(true);
    expect(t.attached).toEqual([[MD_PATH, false]]);
    expect(t.s.descriptionPath).toBe(MD_PATH);
  });

  it('a description attached before the first render is in that render', async () => {
    const t = session(v1);
    void t.s.start();
    await t.s.setDescription(MD_PATH);
    await t.s.handleMessage({ type: 'ready' });
    expect(t.renders()).toBe(1);
    expect(t.last().trace?.summary).toMatch(/^19 of 41 matched/);
  });

  it('a picked description shows the Trace tab once; a reloaded webview gets the render without the flag', async () => {
    const t = await opened(v1);
    await t.s.setDescription(MD_PATH, true);
    expect(t.last().showTrace).toBe(true);
    expect(t.attached).toEqual([[MD_PATH, true]]);
    await t.s.handleMessage({ type: 'ready' });
    expect(t.last().showTrace).toBeUndefined();
    expect(t.last().trace).toBeDefined();
  });

  it('checks the process shown now: v2 renames a task and drops one', async () => {
    const t = await opened(v2);
    await t.s.setDescription(MD_PATH);
    const rows = t.last().trace!.rows;
    expect(rows.find((r) => r.text === 'Lookup Country Info')?.status).toBe('missing');
    expect(rows.find((r) => r.text === 'Manager Approval' && r.kind === 'step')?.status).toBe('missing');
    expect(rows.filter((r) => r.status === 'extra').map((r) => r.text)).toEqual(['priority', 'Validation Passed?', 'Notify Customer SF', 'Manager Review']);
  });

  it('runs again when the process changes on disk, and the comparison is not touched', async () => {
    const t = await opened(v1);
    await t.s.setDescription(MD_PATH);
    t.file.content = v2;
    t.s.fileChanged();
    t.timers.fire();
    await t.s.idle;
    expect(t.last().trace!.counts.missing).toBeGreaterThan(0);
    expect(t.last().diff?.counts).toEqual({ added: 2, removed: 2, changed: 6 });
  });

  it('runs again when the description changes on disk, after the quiet period', async () => {
    const t = await opened(v1);
    await t.s.setDescription(MD_PATH);
    t.files[MD_PATH] = DESCRIPTION.replace('9. Handle Exception', '9. Handle Exception\n10. Ship Order');
    t.s.descriptionChanged();
    t.s.descriptionChanged();
    const before = t.renders();
    t.timers.fire();
    await new Promise((r) => setTimeout(r, 0));
    await t.s.idle;
    expect(t.renders()).toBe(before + 1);
    expect(t.last().trace!.rows.find((r) => r.text === 'Ship Order')?.status).toBe('missing');
  });

  it('keeps a description that cannot be read attached, with its error, and picks up the fix', async () => {
    const t = await opened(v1);
    t.files[MD_PATH] = new Error('EACCES');
    await t.s.setDescription(MD_PATH);
    expect(t.last().trace).toMatchObject({ fileName: 'order-delivery-process-description.md', error: 'Cannot read order-delivery-process-description.md: EACCES', rows: [] });
    t.files[MD_PATH] = DESCRIPTION;
    t.s.descriptionChanged();
    t.timers.fire();
    await new Promise((r) => setTimeout(r, 0));
    await t.s.idle;
    expect(t.last().trace?.error).toBeUndefined();
    expect(t.last().trace?.rows).toHaveLength(42);
  });

  it('reports a description larger than 1 MB as an error', async () => {
    const t = await opened(v1);
    t.files[MD_PATH] = `## Steps\n${'- x\n'.repeat(300_000)}`;
    await t.s.setDescription(MD_PATH);
    expect(t.last().trace?.error).toMatch(/larger than 1 MB/);
  });

  it('Clear from the webview removes the check and tells the host', async () => {
    const t = await opened(v1);
    await t.s.setDescription(MD_PATH);
    await t.s.handleMessage({ type: 'clearDescription' });
    expect(t.last().trace).toBeUndefined();
    expect(t.attached.at(-1)).toEqual([undefined, true]);
    expect(t.s.descriptionPath).toBeUndefined();
    // Nothing to clear: no render.
    const before = t.renders();
    await t.s.clearDescription();
    expect(t.renders()).toBe(before);
  });

  it('leaves the warnings and the BPMN export as they are', async () => {
    const t = await opened(v1);
    const warnings = t.last().warnings;
    const exported = await t.s.exportBpmn();
    await t.s.setDescription(MD_PATH);
    expect(t.last().warnings).toEqual(warnings);
    expect(await t.s.exportBpmn()).toEqual(exported);
    expect(t.last().xml).not.toContain('Validate Order SF ✓');
  });

  it('accepts clearDescription from the webview only without a payload', () => {
    expect(parseWebviewMessage({ type: 'clearDescription' })).toEqual({ type: 'clearDescription' });
    expect(parseWebviewMessage({ type: 'clearDescription', path: '/etc/passwd' })).toBeUndefined();
  });
});

describe('descriptionCandidates', () => {
  it('tries <base>-description.md, then <base>.md, next to the opened file', () => {
    expect(descriptionCandidates('/work/order-delivery-process.zip')).toEqual([
      path.join('/work', 'order-delivery-process-description.md'),
      path.join('/work', 'order-delivery-process.md'),
    ]);
    expect(descriptionCandidates('/work/app.twx')).toEqual([path.join('/work', 'app-description.md'), path.join('/work', 'app.md')]);
  });
});
