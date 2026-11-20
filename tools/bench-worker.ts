// A class-bench worker thread (tools/bench-classes.ts): builds the bench world once, then runs
// each task it's sent and posts the result back. Tasks are pure (tools/bench-core.ts runTask),
// so the merged report is the same for any number of workers.

import { parentPort } from 'node:worker_threads';
import { benchWorld, runTask, type TaskSpec } from './bench-core.ts';

const port = parentPort;
if (!port) throw new Error('bench-worker: run as a worker thread');
const world = benchWorld();
port.on('message', (m: { id: number; spec: TaskSpec } | 'stop') => {
  if (m === 'stop') {
    port.close();
    return;
  }
  port.postMessage({ id: m.id, result: runTask(world, m.spec) });
});
port.postMessage('ready');
