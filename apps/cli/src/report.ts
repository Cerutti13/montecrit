// `montecrit run -n N` / `--policy a,b,...`: the Monte Carlo report (docs/design/m1c.md 4-6). Arms
// run in this process, or as (chunk, policy) tasks over a pool of worker threads (M2: the
// @montecrit/host scheduler). Either way chunks merge in order, so the report is the same text
// whatever ran it; only the wall clock differs.

import { availableParallelism } from 'node:os';
import { CHUNK, computeReport, DEFAULT_MAX_N, renderReport, runArms, type ArmSpec, type Merged, type ReportMeta, type RunResult } from '@montecrit/engine';
import { accHash, openSession, PoolError, reportHash, reportJson, type Job, type Session } from '@montecrit/host';
import { threadTransport } from './pool-node.ts';

export interface ReportView {
  readonly meta: ReportMeta;
  readonly json: boolean;
  /** --report-hash: append `report-hash <hex> (pairs ref)` and `acc-hash <hex>`. */
  readonly hash?: boolean;
}

/** A worker that failed or died. main.ts prints it as a message, not a stack; `detail` keeps a crashed worker's own stack. */
export class WorkerError extends Error {
  readonly detail: string | null;
  constructor(message: string, detail: string | null = null) {
    super(message);
    this.name = 'WorkerError';
    this.detail = detail;
  }
}

export type ReportRun = RunResult;

/** Default worker count: the machine's parallelism, at most 8 (docs/design/m2.md 2.6). It never changes the numbers. */
export function defaultProcs(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

export function runInProcess(arms: readonly ArmSpec[], job: Job, progress: ((n: number) => void) | null = null): ReportRun {
  return runArms(arms, job.seed, { ...job.run, ...(progress ? { onMerge: (m: Merged) => progress(m.n) } : {}) });
}

const asWorkerError = (e: unknown): unknown => (e instanceof PoolError ? new WorkerError(e.message, e.detail) : e);

/**
 * Runs the job on `procs` worker threads (fewer when there are fewer tasks): (chunk, policy)
 * tasks spread over every thread, merged in chunk order with the engine's stopping rule, so the
 * result equals runInProcess's bit for bit (docs/design/m2.md 2.7).
 */
export async function runInWorkers(job: Job, procs: number, progress: ((n: number) => void) | null = null): Promise<ReportRun> {
  const chunks = Math.ceil((job.run.n ?? job.run.maxN ?? DEFAULT_MAX_N) / (job.run.chunkSize ?? CHUNK));
  const workers = Math.max(1, Math.min(procs, chunks * job.arms.length));
  let session: Session;
  try {
    session = await openSession(job, () => threadTransport(), workers);
  } catch (e) {
    throw asWorkerError(e);
  }
  try {
    return await session.run(progress ? (p) => progress(p.merged) : undefined).done;
  } catch (e) {
    throw asWorkerError(e);
  } finally {
    session.close();
  }
}

export function reportOutput(arms: readonly ArmSpec[], run: ReportRun, view: ReportView): string {
  const stats = computeReport(arms, run.merged, view.meta);
  if (view.json) return reportJson(arms, run, view.meta.seed, stats);
  const text = renderReport(arms, run.merged, view.meta, stats);
  if (view.hash) text.push('', `report-hash ${reportHash(reportJson(arms, run, view.meta.seed, stats))} (pairs ref)`, `acc-hash ${accHash(arms, run, view.meta.seed)}`);
  return text.join('\n');
}
