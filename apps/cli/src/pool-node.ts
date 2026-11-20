// The Node side of the worker pool (docs/design/m2.md 2.6): a worker_threads Transport. Its
// structured clone is the browser Worker's, so the CLI exercises the same cloning the browser
// does; threads die with the process, so there is nothing to clean up on a signal.

import { Worker } from 'node:worker_threads';
import type { Transport } from '@montecrit/host';

const ENTRY = new URL('./mc-worker.ts', import.meta.url);

export function threadTransport(): Transport {
  const w = new Worker(ENTRY);
  let closed = false;
  let onFail: (why: string, detail: string | null) => void = () => {};
  w.on('error', (e: Error) => {
    if (!closed) onFail('error', e.stack ?? String(e));
  });
  w.on('messageerror', (e: unknown) => {
    if (!closed) onFail('messageerror', String(e));
  });
  w.on('exit', (code: number) => {
    if (!closed) onFail(`exit ${code}`, null);
  });
  return {
    send(msg) {
      if (!closed) w.postMessage(msg);
    },
    onMessage(cb) {
      w.on('message', cb);
    },
    onFailure(cb) {
      onFail = cb;
    },
    close() {
      if (closed) return;
      closed = true;
      void w.terminate();
    },
  };
}
