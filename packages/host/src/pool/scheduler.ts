// The worker pool's scheduler (docs/design/m2.md 2.6): one design for the CLI (Node worker
// threads) and the browser (Web Workers), behind a Transport. Tasks are (chunk k, arm a), sent
// k-major to whichever worker is idle, never more than `ahead` chunks past the merged prefix.
// Replies are buffered and merged strictly in chunk order, and the stopping rule (afterMerge, the
// engine's one copy) runs after every merge. Nothing on that path sees the worker count, a worker
// id or the order replies arrived in, so the result is the same for any number of workers
// (2.7). Clock-free and platform-free: progress carries counts; the apps time it.

import { afterMerge, mergeInto, newMerged, resolveSchedule, type ArmAcc, type ArmSpec, type ChunkResult, type FightSetup, type RunResult } from '@montecrit/engine';
import { buildArms, closureJob, type Job } from '../job.ts';
import type { FromWorker, PlayReply, ReportReply, ToWorker, WorkerOp } from './protocol.ts';

/** One worker, however it runs. close() terminates it and is idempotent. */
export interface Transport {
  send(msg: ToWorker): void;
  onMessage(cb: (msg: FromWorker) => void): void;
  /** The worker died or a message couldn't be delivered (exit, error, messageerror). */
  onFailure(cb: (why: string, detail: string | null) => void): void;
  close(): void;
}

export interface Progress {
  /** Runs per arm merged so far, and the cap. */
  readonly merged: number;
  readonly total: number;
  readonly chunksMerged: number;
  readonly inFlight: number;
  /** Arm results held until their chunk's other arms arrive. */
  readonly buffered: number;
  readonly perArm: readonly { readonly label: string; readonly win: number; readonly n: number }[];
}

/** A failed pool. `detail` keeps a crashed worker's own stack. */
export class PoolError extends Error {
  readonly detail: string | null;
  constructor(message: string, detail: string | null = null) {
    super(message);
    this.name = 'PoolError';
    this.detail = detail;
  }
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export interface RunHandle {
  readonly done: Promise<RunResult>;
  cancel(): void;
}

export interface Session {
  /** The arms as the main side built them (the replay view needs their setup). */
  readonly arms: readonly ArmSpec[];
  readonly setup: FightSetup;
  /** Runs the job once. A session runs once; calls may follow. */
  run(onProgress?: (p: Progress) => void): RunHandle;
  /** One request to a worker (a report, a played fight); not while a run is going. */
  call(op: WorkerOp): Promise<PlayReply | ReportReply>;
  close(): void;
}

/** How many chunks past the merged prefix tasks may be sent (bounds the buffer at ahead x arms results). */
export const DEFAULT_AHEAD = 16;

interface Slot {
  readonly i: number;
  readonly gen: number;
  t: Transport | null;
  ready: boolean;
  busy: { readonly k: number; readonly arm: number } | null;
  /** Rejects the spawn while it hasn't settled (a kill before ready must not leave it pending). */
  abort: ((e: Error) => void) | null;
}

interface Pending {
  readonly resolve: (v: PlayReply | ReportReply) => void;
  readonly reject: (e: Error) => void;
}

/**
 * Builds the job here (the main side needs its setup and hashes), opens `workers` transports,
 * initializes them with the job and its hashes, and waits until every one is ready. A worker
 * whose hashes differ, or that fails to build, rejects the whole session.
 */
export async function openSession(job: Job, open: (i: number) => Transport, workers: number, opts: { readonly ahead?: number } = {}): Promise<Session> {
  const built = buildArms(job);
  if (built.errors.length) throw new PoolError(built.errors.join('\n'));
  const arms = built.arms;
  const setup = built.setup!;
  const sched = resolveSchedule(arms, job.run);
  const ahead = opts.ahead ?? DEFAULT_AHEAD;
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError(`workers must be a positive integer, got ${workers}`);
  if (!Number.isInteger(ahead) || ahead < 1) throw new RangeError(`ahead must be a positive integer, got ${ahead}`);
  // Workers get the scenario's closure only (C19): the pack and policy files this run reaches.
  const wjob: Job = { ...closureJob(job, built).job, expect: { scenarioHash: setup.scenarioHash, contentHash: setup.contentHash } };
  const policyHashes = arms.map((a) => a.policy?.hash ?? null);

  const slots: Slot[] = [];
  const pending = new Map<number, Pending>();
  let gens = 0;
  let calls = 0;
  let closed = false;
  let broken: PoolError | null = null;
  // The run in progress: its chunk handler and how to fail it.
  let onChunk: ((s: Slot, msg: Extract<FromWorker, { t: 'chunk' }>) => void) | null = null;
  let failRun: ((e: Error) => void) | null = null;

  /** Closes a worker; one still starting has its spawn rejected with `why`. */
  const kill = (s: Slot, why: Error = new Cancelled()): void => {
    const t = s.t;
    s.t = null;
    s.ready = false;
    s.busy = null;
    t?.close();
    const abort = s.abort;
    s.abort = null;
    abort?.(why);
  };
  const where = (s: Slot, what: string): string => (s.busy ? `worker ${s.i} (${arms[s.busy.arm]!.label}, chunk ${s.busy.k}): ${what}` : `worker ${s.i}: ${what}`);
  /** Fails the session: every worker goes, the run and every pending call reject. */
  const fail = (e: PoolError): void => {
    if (broken || closed) return;
    broken = e;
    failRun?.(e);
    for (const s of slots) kill(s, e);
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  const spawn = (i: number): Promise<Slot> =>
    new Promise<Slot>((resolve, reject) => {
      const slot: Slot = { i, gen: ++gens, t: null, ready: false, busy: null, abort: null };
      slots.push(slot);
      let settled = false;
      slot.abort = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const bad = (e: PoolError) => {
        if (!settled) {
          kill(slot, e);
        } else fail(e);
      };
      const t = open(i);
      slot.t = t;
      t.onMessage((msg) => {
        if (slot.t !== t || msg.gen !== slot.gen) return; // an older incarnation, or a killed worker
        if (msg.t === 'ready') {
          if (msg.scenarioHash !== setup.scenarioHash || msg.contentHash !== setup.contentHash || msg.policyHashes.some((h, k) => h !== policyHashes[k])) return bad(new PoolError(where(slot, 'the scenario or content changed under the run')));
          slot.ready = true;
          if (!settled) {
            settled = true;
            slot.abort = null;
            resolve(slot);
          }
          return;
        }
        if (msg.t === 'error') return bad(new PoolError(where(slot, msg.message), msg.stack));
        if (msg.t === 'chunk') {
          if (onChunk) onChunk(slot, msg);
          return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new PoolError(where(slot, msg.error)));
      });
      t.onFailure((why, detail) => {
        if (slot.t === t) bad(new PoolError(where(slot, `stopped (${why})`), detail));
      });
      t.send({ t: 'init', gen: slot.gen, job: wjob });
    });

  const started = await Promise.allSettled(Array.from({ length: workers }, (_, i) => spawn(i)));
  const failed = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    closed = true;
    for (const s of slots) kill(s);
    throw failed.reason;
  }

  let ran = false;
  return {
    arms,
    setup,
    run(onProgress) {
      if (ran) throw new Error('a session runs once; open another');
      ran = true;
      let resolveDone: (r: RunResult) => void = () => {};
      let rejectDone: (e: Error) => void = () => {};
      const done = new Promise<RunResult>((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
      });
      if (broken || closed) {
        rejectDone(broken ?? new Cancelled());
        return { done, cancel() {} };
      }
      const m = newMerged(arms, sched.chunkSize);
      const A = arms.length;
      const chunks = Math.ceil(sched.total / sched.chunkSize);
      const count = (k: number) => Math.min(sched.total, (k + 1) * sched.chunkSize) - k * sched.chunkSize;
      const buf: ((ArmAcc | undefined)[] | undefined)[] = [];
      let nk = 0;
      let na = 0;
      let inFlight = 0;
      let buffered = 0;
      let finished = false;

      // Speculative work past the stop is discarded: the workers computing it go. The one that
      // delivered the deciding chunk is idle and stays, so a call after a normal stop reuses it;
      // only a cancel (or a failure) takes them all, and then a call respawns one.
      const stop = (): void => {
        finished = true;
        onChunk = null;
        failRun = null;
        for (const s of slots) if (s.busy) kill(s);
      };
      failRun = (e) => {
        if (finished) return;
        stop();
        rejectDone(e);
      };
      const progress = (): void => {
        onProgress?.({ merged: m.n, total: sched.total, chunksMerged: m.nextChunk, inFlight, buffered, perArm: m.arms.map((a) => ({ label: a.label, win: a.win, n: a.n })) });
      };
      const dispatch = (): void => {
        for (const s of slots) {
          if (finished || nk >= chunks || nk >= m.nextChunk + ahead) return;
          if (!s.t || !s.ready || s.busy) continue;
          // Claim the task before sending: a transport may deliver the reply inside send().
          const task = { k: nk, arm: na };
          if (++na === A) {
            na = 0;
            nk++;
          }
          s.busy = task;
          inFlight++;
          s.t.send({ t: 'task', gen: s.gen, k: task.k, arm: task.arm });
        }
      };
      onChunk = (s, msg) => {
        if (finished) return;
        if (!s.busy || s.busy.k !== msg.k || s.busy.arm !== msg.arm) return fail(new PoolError(where(s, `sent chunk ${msg.k} of arm ${msg.arm}, which it wasn't asked for`)));
        s.busy = null;
        inFlight--;
        if (msg.acc.n !== count(msg.k) || msg.acc.label !== arms[msg.arm]!.label) return fail(new PoolError(`worker ${s.i}: chunk ${msg.k} of ${arms[msg.arm]!.label} came back with ${msg.acc.n} runs of ${msg.acc.label}, expected ${count(msg.k)}`));
        (buf[msg.k] ??= [])[msg.arm] = msg.acc;
        buffered++;
        for (;;) {
          const k = m.nextChunk;
          const row = buf[k];
          if (!row || arms.some((_, a) => row[a] === undefined)) break;
          const c: ChunkResult = { chunkIdx: k, start: k * sched.chunkSize, count: count(k), arms: row as ArmAcc[] };
          buf[k] = undefined;
          buffered -= A;
          mergeInto(m, c);
          const r = afterMerge(sched, m);
          if (r) {
            stop();
            progress();
            resolveDone(r);
            return;
          }
        }
        progress();
        dispatch();
      };
      dispatch();
      return {
        done,
        cancel() {
          if (finished) return;
          stop();
          for (const s of slots) kill(s);
          rejectDone(new Cancelled());
        },
      };
    },
    async call(op) {
      if (broken) throw broken;
      if (closed) throw new Cancelled();
      if (onChunk) throw new PoolError('a run is in progress');
      const s = slots.find((x) => x.t !== null && x.ready) ?? (await spawn(slots.length));
      const id = ++calls;
      return new Promise<PlayReply | ReportReply>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        s.t!.send({ t: 'call', gen: s.gen, id, op });
      });
    },
    close() {
      if (closed) return;
      failRun?.(new Cancelled());
      closed = true;
      for (const s of slots) kill(s);
      for (const p of pending.values()) p.reject(new Cancelled());
      pending.clear();
    },
  };
}
