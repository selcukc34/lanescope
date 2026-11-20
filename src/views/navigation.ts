// Drill-down navigation through called services and linked processes: the
// path of open diagrams from the process chosen in the picker down to the
// one shown (the breadcrumb). Pure functions over level ids, free of vscode
// and DOM code, so the host and the tests share them.
//
// A level id is the BAW object id of what the level shows ("25.…" for a
// process, "1.…" for a service; a Bob process uses its own id), or "sub:"
// and the id of a sub-process for the inside of a sub-process, which
// resolves in the level above it. The first level is the process chosen in
// the picker.

/** Most levels a path holds, the root process included; a guard, not a limit users should meet. */
export const MAX_PATH_DEPTH = 20;

export type OpenResult =
  /** The callee is opened one level below the current one. */
  | { kind: 'push'; path: string[] }
  /** The callee is already open higher up in the path: back to that level. */
  | { kind: 'jump'; path: string[]; index: number }
  /** The path is as deep as allowed: nothing changes. */
  | { kind: 'limit'; path: string[] };

/**
 * Opens `id` from the last level of `path`. Loop-safe: an id already in the
 * path is not opened again, the path goes back to where it is.
 */
export function openInPath(path: readonly string[], id: string, maxDepth = MAX_PATH_DEPTH): OpenResult {
  const index = path.indexOf(id);
  if (index >= 0) return { kind: 'jump', path: path.slice(0, index + 1), index };
  if (path.length >= maxDepth) return { kind: 'limit', path: [...path] };
  return { kind: 'push', path: [...path, id] };
}

/** One level of a resolved path. */
export interface ResolvedLevel<T> {
  id: string;
  value: T;
}

export interface ResolvedPath<T> {
  levels: Array<ResolvedLevel<T>>;
  /** The first id that no longer resolves; the levels end above it. */
  missing?: string;
}

/**
 * Resolves the levels of a path in order and stops at the first one that no
 * longer exists (the file changed): the deepest level that still exists is
 * the one to show. The root must resolve; otherwise no level does. `resolve`
 * gets the level above (undefined for the root), where a sub-process lives.
 */
export async function resolvePath<T>(
  path: readonly string[],
  resolve: (id: string, depth: number, above: T | undefined) => Promise<T | undefined> | T | undefined,
): Promise<ResolvedPath<T>> {
  const levels: Array<ResolvedLevel<T>> = [];
  for (const [depth, id] of path.slice(0, MAX_PATH_DEPTH).entries()) {
    const value = await resolve(id, depth, levels[levels.length - 1]?.value);
    if (value === undefined) return { levels, missing: id };
    levels.push({ id, value });
  }
  return { levels };
}

/** Whether `prefix` is the start of `path` (or the same path). */
export function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((id, i) => path[i] === id);
}

/** A stable key for a path, e.g. for remembering the zoom of each level. */
export function pathKey(path: readonly string[]): string {
  return path.join('\u0000');
}
