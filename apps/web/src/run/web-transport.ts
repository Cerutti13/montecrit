// The browser side of the worker pool: a module Web Worker as a @montecrit/host Transport. Same
// structured clone as Node's worker_threads, so the CLI's tests exercise the cloning this does.

import type { Transport } from '@montecrit/host';

export function webTransport(): Transport {
  const w = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
  let closed = false;
  let onFail: (why: string, detail: string | null) => void = () => {};
  w.onerror = (e) => {
    e.preventDefault();
    if (!closed) onFail('error', e.message || null);
  };
  w.onmessageerror = () => {
    if (!closed) onFail('messageerror', null);
  };
  return {
    send(msg) {
      if (!closed) w.postMessage(msg);
    },
    onMessage(cb) {
      w.onmessage = (e) => cb(e.data);
    },
    onFailure(cb) {
      onFail = cb;
    },
    close() {
      if (closed) return;
      closed = true;
      w.terminate();
    },
  };
}

/** Default workers: one per core but one, at most 8 (docs/design/m2.md 2.6). */
export function defaultWorkers(): number {
  return Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}
