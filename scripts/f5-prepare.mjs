// npm run f5:prepare: fresh copies of the committed Bob fixtures for manual
// (F5) testing, so the committed fixture folders are never touched.
//
// Deletes test/fixtures/local/f5/ and creates it again, then copies the
// .zip, .bpmn and .md files of test/fixtures/bob/ into it and lists them.
// It writes nowhere else: the target must resolve to exactly that folder
// inside this repository, and nothing is followed through a symbolic link.
// test/fixtures/local/ is ignored by git, so nothing copied can be committed.

import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE = path.join(ROOT, 'test', 'fixtures', 'bob');
const LOCAL = path.join(ROOT, 'test', 'fixtures', 'local');
const TARGET = path.join(LOCAL, 'f5');
const EXTENSIONS = new Set(['.zip', '.bpmn', '.md']);

function fail(message) {
  console.error(`f5:prepare: ${message}`);
  process.exit(1);
}

/** A path is a real folder (not a link) when it exists. */
function checkNotLink(p) {
  try {
    if (lstatSync(p).isSymbolicLink()) fail(`${path.relative(ROOT, p)} is a symbolic link; refusing to write through it.`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// The one folder this script may delete and write: test/fixtures/local/f5 inside the repository.
const relative = path.relative(ROOT, TARGET);
if (relative !== path.join('test', 'fixtures', 'local', 'f5') || relative.startsWith('..') || path.isAbsolute(relative)) {
  fail(`unexpected target ${TARGET}`);
}
for (const p of [path.join(ROOT, 'test'), path.join(ROOT, 'test', 'fixtures'), LOCAL, TARGET]) checkNotLink(p);

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
if (realpathSync(TARGET) !== TARGET) fail(`${relative} does not resolve to itself; refusing to write.`);

const copied = [];
for (const entry of readdirSync(SOURCE, { withFileTypes: true })) {
  if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
  copyFileSync(path.join(SOURCE, entry.name), path.join(TARGET, entry.name));
  copied.push(entry.name);
}
copied.sort();

console.log(`f5:prepare: ${copied.length} files copied to ${relative}${path.sep}`);
for (const name of copied) console.log(`  ${path.join(relative, name)}`);
console.log('Open these copies in the Extension Development Host; edit or write next to them freely.');
