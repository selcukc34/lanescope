// Reads Bob output from disk: a single .bpmn file, or a .zip that contains
// one .bpmn and its .xsd files. Read-only; never writes anything.

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import {
  decodeText,
  declaredSize,
  inflate as inflateEntry,
  isMetadataEntry,
  isSafeEntryName,
  openZip,
  originalEntryName,
  ZipLimitError,
  type Budget,
} from './zip';

export { isSafeEntryName };

export interface PackageLimits {
  /** Maximum total uncompressed size of all zip entries, in bytes. */
  maxUncompressedBytes: number;
  /** Maximum number of zip entries (files and directories). */
  maxEntries: number;
}

export const DEFAULT_LIMITS: PackageLimits = {
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 500,
};

export interface BpmnPackageInput {
  /** Path of the file that was opened. */
  path: string;
  format: 'bpmn' | 'zip';
  /** File name (or zip entry path) of the BPMN document. */
  bpmnFileName: string;
  bpmnText: string;
  /** XSD documents keyed by file name (or zip entry path, with forward slashes). */
  xsdFiles: Record<string, string>;
}

export class BpmnInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BpmnInputError';
  }
}

/** Reads a .bpmn or .zip file from disk. */
export async function readBpmnPackage(
  filePath: string,
  limits: Partial<PackageLimits> = {},
): Promise<BpmnPackageInput> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.zip') {
    const info = await stat(filePath);
    // A zip that is already larger than the uncompressed limit cannot be valid.
    if (info.size > lim.maxUncompressedBytes) {
      throw new BpmnInputError(`Zip file is larger than ${lim.maxUncompressedBytes} bytes.`);
    }
    return readBpmnZip(await readFile(filePath), filePath, lim);
  }
  if (ext === '.bpmn') {
    return readBpmnFile(filePath, lim);
  }
  throw new BpmnInputError(`Unsupported file type "${ext}". Expected .bpmn or .zip.`);
}

/**
 * Reads a single .bpmn file plus the .xsd files next to it (same directory,
 * not recursive), so that bpmn:import locations can be resolved.
 */
async function readBpmnFile(filePath: string, lim: PackageLimits): Promise<BpmnPackageInput> {
  // Sizes are checked before a file is read into memory (and again after, in case it grew).
  if ((await stat(filePath)).size > lim.maxUncompressedBytes) {
    throw new BpmnInputError(`BPMN file is larger than ${lim.maxUncompressedBytes} bytes.`);
  }
  const bpmnBytes = await readFile(filePath);
  let total = bpmnBytes.length;
  if (total > lim.maxUncompressedBytes) {
    throw new BpmnInputError(`BPMN file is larger than ${lim.maxUncompressedBytes} bytes.`);
  }

  const dir = path.dirname(filePath);
  const xsdNames = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.xsd'))
    .map((d) => d.name)
    .sort();
  if (xsdNames.length > lim.maxEntries) {
    throw new BpmnInputError(`Too many .xsd files next to the BPMN file (more than ${lim.maxEntries}).`);
  }

  const xsdFiles: Record<string, string> = {};
  const tooLarge = () =>
    new BpmnInputError(`BPMN and XSD files together are larger than ${lim.maxUncompressedBytes} bytes.`);
  for (const name of xsdNames) {
    const xsdPath = path.join(dir, name);
    if (total + (await stat(xsdPath)).size > lim.maxUncompressedBytes) throw tooLarge();
    const bytes = await readFile(xsdPath);
    total += bytes.length;
    if (total > lim.maxUncompressedBytes) throw tooLarge();
    xsdFiles[name] = decodeText(bytes);
  }

  return {
    path: filePath,
    format: 'bpmn',
    bpmnFileName: path.basename(filePath),
    bpmnText: decodeText(bpmnBytes),
    xsdFiles,
  };
}

/** Reads Bob output from zip bytes. Exported for tests and in-memory sources. */
export async function readBpmnZip(
  data: Uint8Array,
  sourcePath: string,
  limits: Partial<PackageLimits> = {},
): Promise<BpmnPackageInput> {
  const lim = { ...DEFAULT_LIMITS, ...limits };

  // Nothing is inflated before the entry count, the names and the declared sizes are checked.
  let zip: JSZip;
  try {
    zip = await openZip(data, lim.maxEntries);
  } catch (err) {
    if (err instanceof ZipLimitError) throw new BpmnInputError(err.message);
    throw new BpmnInputError(`Not a valid zip file: ${(err as Error).message}`, { cause: err });
  }

  const entries = Object.values(zip.files);

  let declaredTotal = 0;
  for (const entry of entries) {
    const original = originalEntryName(entry);
    if (!isSafeEntryName(original)) {
      throw new BpmnInputError(`Zip entry "${original}" has an unsafe path.`);
    }
    declaredTotal += declaredSize(entry);
  }
  if (declaredTotal > lim.maxUncompressedBytes) {
    throw new BpmnInputError(`Zip content is larger than ${lim.maxUncompressedBytes} bytes when uncompressed.`);
  }

  const relevant = entries.filter((e) => !e.dir && !isMetadataEntry(e.name));
  const bpmnEntries = relevant.filter((e) => e.name.toLowerCase().endsWith('.bpmn'));
  const xsdEntries = relevant.filter((e) => e.name.toLowerCase().endsWith('.xsd'));
  if (bpmnEntries.length === 0) {
    throw new BpmnInputError('Zip does not contain a .bpmn file.');
  }
  if (bpmnEntries.length > 1) {
    throw new BpmnInputError(
      `Zip contains ${bpmnEntries.length} .bpmn files; expected exactly one (${bpmnEntries.map((e) => e.name).join(', ')}).`,
    );
  }

  // Declared sizes can lie, so the actual inflated bytes are counted as well.
  const budget = { remaining: lim.maxUncompressedBytes, limit: lim.maxUncompressedBytes };
  const bpmnEntry = bpmnEntries[0];
  const bpmnText = decodeText(await inflate(bpmnEntry, budget));
  const xsdFiles: Record<string, string> = {};
  for (const entry of xsdEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    xsdFiles[entry.name] = decodeText(await inflate(entry, budget));
  }

  return { path: sourcePath, format: 'zip', bpmnFileName: bpmnEntry.name, bpmnText, xsdFiles };
}

/** Inflates one entry; a limit error becomes a BpmnInputError. */
async function inflate(entry: JSZip.JSZipObject, budget: Budget): Promise<Uint8Array> {
  try {
    return await inflateEntry(entry, budget);
  } catch (err) {
    if (err instanceof ZipLimitError) throw new BpmnInputError(err.message);
    throw new BpmnInputError((err as Error).message, { cause: err });
  }
}
