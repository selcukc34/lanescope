// Where "Lanescope: New Process Description" writes, and the checks that keep
// that write away from every existing file and input. Pure (no vscode), so
// the rules are unit-tested. The write itself (processEditorProvider) creates
// the file exclusively: it fails when the path exists, so nothing is ever
// overwritten, even when a file appears between the check and the write.

import * as path from 'node:path';
import { descriptionCandidates } from './watchPattern';

/** Extensions of the files Lanescope reads as processes; a description is never one of them. */
const INPUT_EXTENSIONS = new Set(['.bpmn', '.twx', '.zip', '.xsd']);

/** The new description of an opened file: <base>-description.md next to it. */
export function newDescriptionPath(openedPath: string): string {
  return descriptionCandidates(openedPath)[0];
}

export type DescriptionTargetCheck = { ok: true; path: string } | { ok: false; message: string };

/** A target is accepted when it is a .md file, not the opened file and not an input type. */
export function checkNewDescriptionTarget(target: string, openedPath: string): DescriptionTargetCheck {
  const resolved = path.resolve(target);
  const ext = path.extname(resolved).toLowerCase();
  if (resolved === path.resolve(openedPath) || INPUT_EXTENSIONS.has(ext)) {
    return { ok: false, message: 'A description is never written over a process file.' };
  }
  if (ext !== '.md') return { ok: false, message: 'A description is a .md file.' };
  return { ok: true, path: resolved };
}
