// File names and target checks for exports. Pure (no vscode), so the rules
// that keep exports away from the opened input are unit-tested.
//
// An export always goes to a new file next to the opened one, named after
// it: <source>[-<level>].<ext>, and <source>[-<level>].laid-out.bpmn for the
// BPMN. The level name is added only when a level below the chosen process
// is drawn (an opened service flow or linked process). A target that is the
// input itself, an input type (.twx, .zip, .xsd) or not of the export's type
// is refused.

import * as path from 'node:path';
import type { ExportFormat } from './protocol';

/** File extension of each export format, with the dot. */
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  bpmn: '.bpmn',
  svg: '.svg',
  png: '.png',
};

/** Labels for the save dialog's filter and the format pickers. */
export const EXPORT_LABELS: Record<ExportFormat, string> = {
  bpmn: 'BPMN with layout (.bpmn)',
  svg: 'SVG image (.svg)',
  png: 'PNG image (.png)',
};

/** Extensions of the files Lanescope reads; an export never writes one. */
const INPUT_EXTENSIONS = new Set(['.twx', '.zip', '.xsd']);

const MAX_NAME_PART = 80;
const MAX_SUFFIX = 999;

/** What an export is named after. */
export interface ExportNaming {
  /** Path of the opened file. */
  sourcePath: string;
  format: ExportFormat;
  /** Name of the drawn level, only when it is below the chosen process. */
  levelName?: string;
}

/** A name part made safe for a file name: letters, digits, '-' and '_' only. */
export function safeNamePart(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_NAME_PART)
    .replace(/[-_]+$/, '');
}

/** The opened file's name without its extension, made safe ("export" if nothing is left). */
function sourceStem(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return safeNamePart(base) || 'export';
}

/** The name before the extension and the suffix, e.g. "order-delivery-process-Price-Order". */
function exportStem(naming: ExportNaming): string {
  const level = naming.levelName !== undefined ? safeNamePart(naming.levelName) : '';
  return level ? `${sourceStem(naming.sourcePath)}-${level}` : sourceStem(naming.sourcePath);
}

/** What follows the stem and the -N suffix: ".laid-out.bpmn", ".svg" or ".png". */
function exportTail(format: ExportFormat): string {
  return format === 'bpmn' ? `.laid-out${EXPORT_EXTENSIONS.bpmn}` : EXPORT_EXTENSIONS[format];
}

/** The default file name, without a -N suffix. */
export function defaultExportName(naming: ExportNaming): string {
  return `${exportStem(naming)}${exportTail(naming.format)}`;
}

/**
 * The default path: next to the opened file, with -2, -3, … added when a file
 * of that name exists. Never the opened file itself.
 */
export async function defaultExportPath(
  naming: ExportNaming,
  exists: (filePath: string) => boolean | Promise<boolean>,
): Promise<string> {
  const dir = path.dirname(naming.sourcePath);
  const stem = exportStem(naming);
  const tail = exportTail(naming.format);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}${tail}`);
    if (samePath(candidate, naming.sourcePath)) continue;
    if (!(await exists(candidate))) return candidate;
  }
  // Every name is taken: the save dialog asks before replacing this one.
  return path.join(dir, `${stem}-${MAX_SUFFIX + 1}${tail}`);
}

export type ExportTargetCheck = { ok: true; path: string } | { ok: false; message: string };

/**
 * Checks the path picked in the save dialog. Adds the format's extension when
 * the name has none; refuses the opened file, the input types (.twx, .zip,
 * .xsd) and any other extension than the format's.
 */
export function checkExportTarget(picked: string, sourcePath: string, format: ExportFormat): ExportTargetCheck {
  const wanted = EXPORT_EXTENSIONS[format];
  let target = path.resolve(picked);
  if (path.extname(target) === '') target += wanted;
  const ext = path.extname(target).toLowerCase();
  if (samePath(target, sourcePath)) {
    return { ok: false, message: `Cannot export to ${path.basename(target)}: it is the opened file. Pick a new file.` };
  }
  if (INPUT_EXTENSIONS.has(ext)) {
    return { ok: false, message: `Cannot export to a ${ext} file: Lanescope never writes input files. Pick a ${wanted} file.` };
  }
  if (ext !== wanted) {
    return { ok: false, message: `Cannot export ${format.toUpperCase()} to a ${ext} file. Pick a ${wanted} file.` };
  }
  return { ok: true, path: target };
}

/** Same file, ignoring case (the default file systems of macOS and Windows ignore it). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).normalize('NFC').toLowerCase() === path.resolve(b).normalize('NFC').toLowerCase();
}
