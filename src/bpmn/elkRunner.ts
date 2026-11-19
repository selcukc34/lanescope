// Runs ELK layouts in a worker thread, with a time limit.
//
// ELK's layered algorithm has no bound on its running time: on a large,
// densely cyclic graph it can run for many minutes (or overflow the stack).
// Run on the extension host thread, that would freeze every extension. In a
// worker it runs beside the host, and a layout that takes longer than the
// limit is stopped by terminating the worker; the next layout starts a new one.
//
// The worker loads elk.bundled.js: next to the extension bundle in dist/
// (esbuild.mjs copies it there), or from node_modules when run from source
// (the tests). Nothing is written; the worker only computes.

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ElkNode } from 'elkjs/lib/elk-api';

/** Longest one ELK pass may take; a 5,000-node diagram takes a few seconds. */
export const ELK_TIMEOUT_MS = 20_000;

/** Why a layout did not finish. */
export class ElkLayoutError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'stack' | 'failed',
  ) {
    super(message);
    this.name = 'ElkLayoutError';
  }
}

// Plain CommonJS run by the worker (eval), so it needs no build step of its own.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ELK = require(workerData.elkPath);
const elk = new ELK();
parentPort.on('message', ({ id, graph }) => {
  elk.layout(graph).then(
    (result) => parentPort.postMessage({ id, result }),
    (err) => parentPort.postMessage({
      id,
      error: String((err && err.message) || err),
      stack: err instanceof RangeError,
    }),
  );
});
`;

interface Job {
  /** The worker running it: when that worker stops, only its own jobs fail. */
  worker: Worker;
  resolve: (graph: ElkNode) => void;
  reject: (err: Error) => void;
}

interface Reply {
  id: number;
  result?: ElkNode;
  error?: string;
  stack?: boolean;
}

let worker: Worker | undefined;
const jobs = new Map<number, Job>();
let nextId = 1;

function elkScriptPath(): string {
  const shipped = path.join(__dirname, 'elk.bundled.js');
  return existsSync(shipped) ? shipped : require.resolve('elkjs/lib/elk.bundled.js');
}

function startWorker(): Worker {
  const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { elkPath: elkScriptPath() } });
  // An idle worker does not keep the process alive.
  w.unref();
  w.on('message', (reply: Reply) => {
    const job = jobs.get(reply.id);
    if (!job) return;
    jobs.delete(reply.id);
    if (reply.result) job.resolve(reply.result);
    else job.reject(new ElkLayoutError(reply.error ?? 'ELK failed.', reply.stack ? 'stack' : 'failed'));
  });
  const fail = (err: Error) => {
    if (worker === w) worker = undefined;
    for (const [id, job] of jobs) {
      if (job.worker !== w) continue;
      jobs.delete(id);
      job.reject(new ElkLayoutError(`The layout worker stopped: ${err.message}`, 'failed'));
    }
  };
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`exit code ${code}`)));
  return w;
}

/**
 * Lays out a graph with ELK in the worker. Rejects with ElkLayoutError when
 * ELK fails, overflows its stack, or takes longer than `timeoutMs`; a timeout
 * terminates the worker (and with it any other layout it was running).
 */
export function runElkLayout(graph: ElkNode, timeoutMs = ELK_TIMEOUT_MS): Promise<ElkNode> {
  worker ??= startWorker();
  const w = worker;
  const id = nextId++;
  return new Promise<ElkNode>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!jobs.has(id)) return;
      jobs.delete(id);
      if (worker === w) worker = undefined;
      void w.terminate();
      reject(new ElkLayoutError(`ELK did not finish within ${timeoutMs / 1000} seconds.`, 'timeout'));
    }, timeoutMs);
    // The worker's ref is what keeps the layout alive while it runs.
    w.ref();
    const done = () => {
      clearTimeout(timer);
      if (![...jobs.values()].some((j) => j.worker === w)) w.unref();
    };
    jobs.set(id, {
      worker: w,
      resolve: (g) => {
        done();
        resolve(g);
      },
      reject: (e) => {
        done();
        reject(e);
      },
    });
    w.postMessage({ id, graph });
  });
}
