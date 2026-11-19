// Zip helpers shared by the Bob package reader and the TWX reader: entry
// name checks, an entry count check before the archive is parsed, and
// inflating with a byte budget and a CRC-32 check. Read-only; nothing is
// written to disk.
//
// Archives are opened with openZip, never with JSZip.loadAsync and
// checkCRC32: that option inflates every entry while loading, before any
// limit can be checked. Here nothing is inflated until inflate() is called,
// and inflate() checks the CRC-32 of what it read.

import * as path from 'node:path';
import JSZip from 'jszip';

/** Internals of a JSZip entry that its typings leave out. */
export interface ZipEntryInternals {
  /** The entry name as stored in the archive, before JSZip normalised it. */
  unsafeOriginalName?: string;
  _data?: { uncompressedSize?: number; crc32?: number };
}

/** JSZip's internal stream API; public but missing from its typings. */
interface InternalStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): InternalStream;
  on(event: 'error', cb: (err: Error) => void): InternalStream;
  on(event: 'end', cb: () => void): InternalStream;
  pause(): InternalStream;
  resume(): InternalStream;
}

/** Bytes that may still be inflated, shared by all entries of one archive. */
export interface Budget {
  remaining: number;
  limit: number;
}

/** Raised when inflating goes over a limit; the message is meant for users. */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

/**
 * Number of entries the end of central directory record declares, read
 * without parsing the archive; undefined when the record is not found (the
 * archive is then left to JSZip, which rejects it).
 */
export function declaredEntryCount(data: Uint8Array): number | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The record is 22 bytes plus a comment of up to 65535 bytes, at the end of the file.
  const stop = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const count = view.getUint16(i + 10, true);
    if (count !== 0xffff) return count;
    // Zip64: the locator just before the record points at the zip64 record.
    const locator = i - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) return count;
    const offset = Number(view.getBigUint64(locator + 8, true));
    if (offset + 56 > data.length || view.getUint32(offset, true) !== 0x06064b50) return count;
    return Number(view.getBigUint64(offset + 32, true));
  }
  return undefined;
}

/**
 * Parses an archive's central directory without inflating anything. Rejects
 * an archive that declares more than `maxEntries` entries before it is
 * parsed, so a huge directory is never built in memory. Throws ZipLimitError
 * for the limit; any other error means the data is not a readable zip.
 */
export async function openZip(data: Uint8Array, maxEntries: number): Promise<JSZip> {
  const declared = declaredEntryCount(data);
  if (declared !== undefined && declared > maxEntries) {
    throw new ZipLimitError(`Zip has ${declared} entries; the limit is ${maxEntries}.`);
  }
  // checkCRC32 stays off: it would inflate every entry here. inflate() checks the CRC instead.
  const zip = await JSZip.loadAsync(data, { checkCRC32: false });
  const count = Object.keys(zip.files).length;
  if (count > maxEntries) {
    throw new ZipLimitError(`Zip has ${count} entries; the limit is ${maxEntries}.`);
  }
  return zip;
}

/** The name an entry has in the archive (JSZip may have cleaned it up). */
export function originalEntryName(entry: JSZip.JSZipObject): string {
  return (entry as unknown as ZipEntryInternals).unsafeOriginalName ?? entry.name;
}

/** The uncompressed size the archive declares for an entry (it can lie). */
export function declaredSize(entry: JSZip.JSZipObject): number {
  return (entry as unknown as ZipEntryInternals)._data?.uncompressedSize ?? 0;
}

/**
 * Inflates one entry, aborting as soon as the shared budget, or the
 * per-entry limit when given, is exceeded. Declared sizes can lie, so the
 * actual inflated bytes are counted. The CRC-32 of the inflated bytes must
 * match the one the archive declares.
 */
export function inflate(entry: JSZip.JSZipObject, budget: Budget, maxEntryBytes = Infinity): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let crc = 0xffffffff;
    const expectedCrc = (entry as unknown as ZipEntryInternals)._data?.crc32;
    let done = false;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): InternalStream }).internalStream(
      'uint8array',
    );
    const fail = (err: Error) => {
      done = true;
      stream.pause();
      reject(err);
    };
    stream
      .on('data', (chunk: Uint8Array) => {
        if (done) return;
        size += chunk.length;
        budget.remaining -= chunk.length;
        if (size > maxEntryBytes) {
          fail(new ZipLimitError(`Zip entry "${entry.name}" is larger than ${maxEntryBytes} bytes when uncompressed.`));
          return;
        }
        if (budget.remaining < 0) {
          fail(new ZipLimitError(`Zip content is larger than ${budget.limit} bytes when uncompressed.`));
          return;
        }
        crc = updateCrc32(crc, chunk);
        chunks.push(chunk);
      })
      .on('error', (err: Error) => {
        if (done) return;
        done = true;
        reject(new Error(`Cannot read zip entry "${entry.name}": ${err.message}`, { cause: err }));
      })
      .on('end', () => {
        if (done) return;
        done = true;
        if (expectedCrc !== undefined && (crc ^ 0xffffffff) >>> 0 !== expectedCrc >>> 0) {
          reject(new Error(`Cannot read zip entry "${entry.name}": CRC-32 mismatch.`));
          return;
        }
        resolve(concat(chunks));
      })
      .resume();
  });
}

/** Rejects absolute paths, drive letters, ".." segments and control characters. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

/** macOS resource-fork entries (__MACOSX/, ._name) are not part of the package. */
export function isMetadataEntry(name: string): boolean {
  return name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._');
}

export function decodeText(bytes: Uint8Array): string {
  // TextDecoder strips a UTF-8 BOM by default.
  return new TextDecoder('utf-8').decode(bytes);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** One step of the zip CRC-32; start with 0xffffffff and xor the end result with it. */
function updateCrc32(crc: number, chunk: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
