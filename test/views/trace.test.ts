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
import { NO_STEPS_NOTICE, ViewerSession, type Timers } from '../../src/views/viewerSession';
import { checkNewDescriptionTarget, newDescriptionPath } from '../../src/views/descriptionFiles';
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
  const commands: string[] = [];
  const status = { exists: false };
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
      pick: () => commands.push('pick'),
      create: () => commands.push('create'),
      exists: async () => (commands.push('exists'), status.exists),
    },
  });
  return {
    s,
    posted,
    files,
    attached,
    commands,
    status,
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
    expect(trace.summary).toBe('24 of 24 checkable items found (19 exact, 5 near) · 0 missing · 17 unchecked · 1 extra');
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
    expect(t.last().trace?.summary).toMatch(/^24 of 24 checkable items found/);
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
    t.files[MD_PATH] = `## Main process steps\n${'- x\n'.repeat(300_000)}`;
    await t.s.setDescription(MD_PATH);
    expect(t.last().trace?.error).toMatch(/larger than 1 MB/);
  });

  it('a description without any section of the format: one notice, no rows, no error', async () => {
    const t = await opened(v1);
    t.files[MD_PATH] = '# Orders\n\nThe customer orders and we deliver.\n\n## Notes\n\nNothing else.\n';
    await t.s.setDescription(MD_PATH);
    expect(t.last().trace).toEqual({
      fileName: 'order-delivery-process-description.md',
      summary: '',
      counts: { matched: 0, near: 0, missing: 0, unchecked: 0, extra: 0, checkable: 0 },
      rows: [],
      notChecked: ['Notes'],
      notice: 'No checkable sections found in order-delivery-process-description.md. Lanescope reads the Lanescope description format, see the README.',
    });
  });

  it('a description without Main process steps says so above its rows', async () => {
    const t = await opened(v1);
    t.files[MD_PATH] = '## Business object\n\nOrderRequest:\n\n- orderId\n';
    await t.s.setDescription(MD_PATH);
    expect(t.last().trace).toMatchObject({ summary: '1 of 1 checkable items found (1 exact, 0 near) · 0 missing · 0 unchecked · 10 extra', notice: NO_STEPS_NOTICE });
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

  it('accepts the description messages from the webview only without a payload', () => {
    for (const type of ['clearDescription', 'checkDescription', 'newDescription', 'descriptionStatus']) {
      expect(parseWebviewMessage({ type })).toEqual({ type });
      expect(parseWebviewMessage({ type, path: '/etc/passwd' })).toBeUndefined();
    }
  });

  it('answers the Trace menu whether the description it opens is there', async () => {
    const t = await opened(v1);
    await t.s.handleMessage({ type: 'descriptionStatus' });
    t.status.exists = true;
    await t.s.handleMessage({ type: 'descriptionStatus' });
    expect(t.posted.filter((m) => m.type === 'descriptionStatus')).toEqual([
      { type: 'descriptionStatus', exists: false },
      { type: 'descriptionStatus', exists: true },
    ]);
    expect(t.commands).toEqual(['exists', 'exists']);
  });

  it('hands the Trace button and menu to the host, which runs the commands for this viewer', async () => {
    const t = await opened(v1);
    const before = t.renders();
    await t.s.handleMessage({ type: 'checkDescription' });
    await t.s.handleMessage({ type: 'newDescription' });
    expect(t.commands).toEqual(['pick', 'create']);
    // The session itself reads or writes nothing for them.
    expect(t.renders()).toBe(before);
    expect(t.s.descriptionPath).toBeUndefined();
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

describe('new description target', () => {
  it('is <base>-description.md next to the opened file', () => {
    expect(newDescriptionPath('/work/order-delivery-process.zip')).toBe(path.join('/work', 'order-delivery-process-description.md'));
    expect(newDescriptionPath('/work/app.twx')).toBe(path.join('/work', 'app-description.md'));
  });

  it('is never the opened file or an input type, and always a .md file', () => {
    expect(checkNewDescriptionTarget('/work/a-description.md', '/work/a.zip')).toEqual({ ok: true, path: path.resolve('/work/a-description.md') });
    for (const bad of ['/work/a.zip', '/work/b.bpmn', '/work/b.twx', '/work/b.xsd', '/work/b.BPMN']) {
      expect(checkNewDescriptionTarget(bad, '/work/a.zip').ok).toBe(false);
    }
    expect(checkNewDescriptionTarget('/work/a.txt', '/work/a.zip')).toEqual({ ok: false, message: 'A description is a .md file.' });
  });
});
