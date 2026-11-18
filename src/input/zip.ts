// Zip helpers shared by the Bob package reader and the TWX reader: entry
// name checks and inflating with a byte budget. Read-only; nothing is
// written to disk.

import * as path from 'node:path';
import JSZip from 'jszip';

/** Internals of a JSZip entry that its typings leave out. */
export interface ZipEntryInternals {
  /** The entry name as stored in the archive, before JSZip normalised it. */
  unsafeOriginalName?: string;
  _data?: { uncompressedSize?: number };
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
 * actual inflated bytes are counted.
 */
export function inflate(entry: JSZip.JSZipObject, budget: Budget, maxEntryBytes = Infinity): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
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
