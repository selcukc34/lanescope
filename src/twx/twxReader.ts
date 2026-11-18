// Reads an IBM BAW .twx export from disk. A TWX is a zip archive:
//
//   META-INF/package.xml   snapshot identity, toolkit dependencies, object list
//   META-INF/metadata.xml  object tags (not read)
//   objects/<id>.xml       one file per artifact: BPDs (25.*), services (1.*),
//                          business objects (12.*), ...
//   toolkits/<id>.zip      each dependent toolkit snapshot, itself a TWX
//
// Only package.xml and the object files the viewer needs are inflated up
// front. Other object files (coach views, 64.*) and the package.xml of each
// packed toolkit are inflated on first use only, through `lazy`, under the
// same limits; nothing else of a toolkit is read.
// The input is untrusted, so the reader enforces limits on the entry count,
// the size of one entry and the total uncompressed size; entries with unsafe
// paths are skipped with a warning. Read-only.

import { readFile, stat } from 'node:fs/promises';
import JSZip from 'jszip';
import {
  decodeText,
  declaredSize,
  inflate,
  isMetadataEntry,
  isSafeEntryName,
  originalEntryName,
  ZipLimitError,
  type Budget,
} from '../input/zip';

export interface TwxLimits {
  /** Maximum size of the .twx file itself, in bytes (it is read into memory). */
  maxFileBytes: number;
  /** Maximum number of zip entries (files and directories). */
  maxEntries: number;
  /** Maximum uncompressed size of one entry that is read, in bytes. */
  maxEntryBytes: number;
  /** Maximum total uncompressed size, declared by all entries and inflated by the reader. */
  maxTotalUncompressedBytes: number;
}

/** Default limits; the file size cap exists because JSZip reads the file whole. */
export const DEFAULT_TWX_LIMITS: TwxLimits = {
  maxFileBytes: 512 * 1024 * 1024,
  maxEntries: 100_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
};

/** Object id prefixes the viewer reads: BPDs, services, business objects. */
export const READ_OBJECT_PREFIXES = ['25.', '1.', '12.'] as const;

export interface TwxArchive {
  /** Path of the file that was opened. */
  path: string;
  /** Text of META-INF/package.xml, when the archive has one. */
  packageXml?: string;
  /** Object XML by object id ("25.…"), for the prefixes in READ_OBJECT_PREFIXES. */
  objects: Map<string, string>;
  /** Entry names under toolkits/ (only their package.xml is read, on demand). */
  toolkitEntries: string[];
  /** On-demand reads; absent for archives built in memory without them. */
  lazy?: TwxLazySource;
  /** Non-fatal problems: skipped entries. */
  warnings: string[];
}

/** Parts of an archive that are read only when they are needed. */
export interface TwxLazySource {
  /** XML of an object file not read up front (e.g. a coach view, "64.…"); undefined when the archive has none. */
  readObject(id: string): Promise<string | undefined>;
  /**
   * META-INF/package.xml of every packed toolkit (toolkits/*.zip), read once
   * and cached. A toolkit that cannot be read is reported in `warnings`.
   */
  toolkitPackages(): Promise<{ packages: string[]; warnings: string[] }>;
}

export class TwxReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TwxReadError';
  }
}

/** Reads a .twx file from disk. */
export async function readTwxFile(filePath: string, limits: Partial<TwxLimits> = {}): Promise<TwxArchive> {
  const lim = { ...DEFAULT_TWX_LIMITS, ...limits };
  const info = await stat(filePath);
  if (info.size > lim.maxFileBytes) {
    throw new TwxReadError(`The TWX file is larger than ${lim.maxFileBytes} bytes.`);
  }
  return readTwxArchive(await readFile(filePath), filePath, lim);
}

const OBJECT_ENTRY = /^objects\/([0-9]+\.[A-Za-z0-9-]+)\.xml$/;

/** Reads a TWX from bytes. Exported for tests and in-memory sources. */
export async function readTwxArchive(
  data: Uint8Array,
  sourcePath: string,
  limits: Partial<TwxLimits> = {},
): Promise<TwxArchive> {
  const lim = { ...DEFAULT_TWX_LIMITS, ...limits };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: true });
  } catch {
    // The low-level message is not useful to users.
    throw new TwxReadError('The file is not a valid TWX/zip archive: it is truncated or corrupt.');
  }

  const entries = Object.values(zip.files);
  if (entries.length === 0) throw new TwxReadError('The file is not a valid TWX/zip archive: it is empty.');
  if (entries.length > lim.maxEntries) {
    throw new TwxReadError(`The TWX archive has ${entries.length} entries; the limit is ${lim.maxEntries}.`);
  }
  const declaredTotal = entries.reduce((n, e) => n + declaredSize(e), 0);
  if (declaredTotal > lim.maxTotalUncompressedBytes) {
    throw new TwxReadError(
      `The TWX archive is larger than ${lim.maxTotalUncompressedBytes} bytes when uncompressed.`,
    );
  }

  const warnings: string[] = [];
  const budget: Budget = { remaining: lim.maxTotalUncompressedBytes, limit: lim.maxTotalUncompressedBytes };
  const read = async (entry: JSZip.JSZipObject): Promise<string> => {
    try {
      return decodeText(await inflate(entry, budget, lim.maxEntryBytes));
    } catch (err) {
      // A limit stops the whole read; so does a corrupt entry.
      if (err instanceof ZipLimitError) throw new TwxReadError(err.message);
      throw new TwxReadError('The file is not a valid TWX/zip archive: it is truncated or corrupt.', { cause: err });
    }
  };

  let packageXml: string | undefined;
  const objects = new Map<string, string>();
  const toolkitEntries: string[] = [];
  const lazyObjects = new Map<string, JSZip.JSZipObject>();
  const toolkitZips: Array<{ name: string; entry: JSZip.JSZipObject }> = [];

  for (const entry of entries) {
    if (entry.dir) continue;
    const original = originalEntryName(entry);
    const name = original.replace(/\\/g, '/');
    if (!isSafeEntryName(original) || name.includes('..')) {
      warnings.push(`Skipped an archive entry with an unsafe path: ${JSON.stringify(original)}.`);
      continue;
    }
    if (isMetadataEntry(name)) continue;

    if (name.toLowerCase() === 'meta-inf/package.xml') {
      packageXml = await read(entry);
      continue;
    }
    if (name.startsWith('toolkits/')) {
      if (/\.(zip|twx)$/i.test(name)) {
        toolkitEntries.push(name);
        toolkitZips.push({ name, entry });
      }
      continue;
    }
    const m = OBJECT_ENTRY.exec(name);
    if (m && READ_OBJECT_PREFIXES.some((p) => m[1].startsWith(p))) {
      objects.set(m[1], await read(entry));
    } else if (m) {
      lazyObjects.set(m[1], entry);
    }
    // Everything else (other objects, files/, metadata.xml) is not needed.
  }

  const hasObjects = entries.some((e) => !e.dir && originalEntryName(e).startsWith('objects/'));
  if (packageXml === undefined && !hasObjects) {
    throw new TwxReadError('No META-INF/package.xml and no objects found. Is this a TWX export?');
  }
  if (packageXml === undefined) {
    warnings.push('META-INF/package.xml is missing; the app name and its toolkits are unknown.');
  }

  let toolkits: Promise<{ packages: string[]; warnings: string[] }> | undefined;
  const lazy: TwxLazySource = {
    async readObject(id) {
      const entry = lazyObjects.get(id);
      return entry ? read(entry) : undefined;
    },
    toolkitPackages() {
      toolkits ??= readToolkitPackages(
        toolkitZips.sort((a, b) => a.name.localeCompare(b.name)),
        budget,
        lim,
      );
      return toolkits;
    },
  };

  return { path: sourcePath, packageXml, objects, toolkitEntries: toolkitEntries.sort(), lazy, warnings };
}

/** package.xml of each packed toolkit, under the archive's limits. A toolkit that fails is skipped with a warning. */
async function readToolkitPackages(
  zips: Array<{ name: string; entry: JSZip.JSZipObject }>,
  budget: Budget,
  lim: TwxLimits,
): Promise<{ packages: string[]; warnings: string[] }> {
  const packages: string[] = [];
  const warnings: string[] = [];
  for (const { name, entry } of zips) {
    const fail = (why: string) => warnings.push(`The packed toolkit ${name} could not be read (${why}); names from it are not shown.`);
    try {
      const inner = await JSZip.loadAsync(await inflate(entry, budget, lim.maxEntryBytes), { checkCRC32: true });
      const entries = Object.values(inner.files);
      if (entries.length > lim.maxEntries) {
        fail(`more than ${lim.maxEntries} entries`);
        continue;
      }
      const pkg = entries.find((e) => !e.dir && originalEntryName(e).replace(/\\/g, '/').toLowerCase() === 'meta-inf/package.xml');
      if (!pkg) {
        fail('no META-INF/package.xml');
        continue;
      }
      packages.push(decodeText(await inflate(pkg, budget, lim.maxEntryBytes)));
    } catch (err) {
      fail(err instanceof ZipLimitError ? err.message.replace(/\.$/, '') : 'not a valid zip archive');
    }
  }
  return { packages, warnings };
}
