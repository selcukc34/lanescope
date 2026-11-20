// The repository never holds a BAW export or anything from the developer's
// local fixtures (see CLAUDE.md, Fixtures and Git): .gitignore keeps them
// out, and this test fails when one was committed anyway (git add -f, a
// rename, a changed .gitignore). Also catches descriptions written next to
// the fixtures while testing. Skipped outside a git work tree.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');

function trackedFiles(): string[] | undefined {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter((f) => f !== '');
  } catch {
    return undefined;
  }
}

const TRACKED = trackedFiles();

describe.skipIf(TRACKED === undefined)('tracked files', () => {
  const files = TRACKED ?? [];

  it('lists the repository', () => {
    expect(files).toContain('package.json');
    expect(files).toContain('test/fixtures/bob/order-delivery-process.zip');
  });

  it('holds no .twx export, under any name or case', () => {
    expect(files.filter((f) => /\.twx(\.|$)/i.test(f))).toEqual([]);
  });

  it('holds nothing from test/fixtures/local/ or test/fixtures/twx/', () => {
    expect(files.filter((f) => /^test\/fixtures\/(local|twx)\//i.test(f))).toEqual([]);
  });

  it('holds no description written next to a fixture but Bob\'s input', () => {
    expect(files.filter((f) => /^test\/fixtures\/.*-description\.md$/i.test(f))).toEqual(['test/fixtures/bob/order-delivery-process-description.md']);
  });
});
