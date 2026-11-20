// A browser engine worker: the shared worker core (@montecrit/host pool/core.ts) around this
// worker's port. The CLI's worker thread (apps/cli/src/mc-worker.ts) is the same three lines.

import { createWorkerCore, type ToWorker } from '@montecrit/host';

const core = createWorkerCore();
self.onmessage = (e: MessageEvent<ToWorker>) => self.postMessage(core(e.data));
