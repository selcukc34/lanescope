// Which files a viewer watches for live refresh. Pure, so it is unit-testable.
//
// The watcher covers the direct children of the opened file's directory and
// isWatchedChange() picks the relevant events. This keeps the file name out
// of the glob, so names with glob characters ("[", "{", "*") need no escaping.

import * as path from 'node:path';

export interface WatchPattern {
  /** Directory the glob is relative to (the opened file's directory). */
  base: string;
  /** Glob, relative to `base`: direct children only. */
  glob: string;
}

export function watchPatternFor(filePath: string): WatchPattern {
  return { base: path.dirname(filePath), glob: '*' };
}

/**
 * Whether a change to `changedPath` affects the viewer of `openedPath`.
 * A .zip or .twx is read on its own, so only that file counts. A .bpmn is read together
 * with the .xsd files next to it (any case), so those count too.
 */
export function isWatchedChange(openedPath: string, changedPath: string): boolean {
  if (path.dirname(changedPath) !== path.dirname(openedPath)) return false;
  if (path.basename(changedPath) === path.basename(openedPath)) return true;
  return (
    path.extname(openedPath).toLowerCase() === '.bpmn' && path.extname(changedPath).toLowerCase() === '.xsd'
  );
}
