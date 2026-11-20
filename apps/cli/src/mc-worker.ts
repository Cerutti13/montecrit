// A Monte Carlo worker thread (apps/cli/src/pool-node.ts): the shared worker core
// (@montecrit/host pool/core.ts) around this thread's port. The browser's worker is the same.

import { parentPort } from 'node:worker_threads';
import { createWorkerCore, type ToWorker } from '@montecrit/host';

const core = createWorkerCore();
parentPort!.on('message', (m: ToWorker) => parentPort!.postMessage(core(m)));
