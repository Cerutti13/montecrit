// A run in the browser (docs/design/m2.md 2, 5): the job built from the content set's texts (the
// same Job the CLI's worker threads get), run on the shared pool over Web Workers, then the
// report computed in a worker. The replay command and file note are the ones the CLI prints when
// run from the repo root, so the report text can match the CLI's. A seat given a character is
// seated by @montecrit/host's seatPcs, the transformation `montecrit run X --pc seat=id` makes, so the
// two give the same scenario and report hashes.

import { CHUNK, DEFAULT_MAX_N, loadContent, type Content, type DerivedSheet, type ReportMeta, type RunResult } from '@montecrit/engine';
import { Cancelled, openSession, policiesFrom, scenarioInput, seatPcs, type Job, type Progress, type ReportReply, type RunHandle, type Session, type Transport } from '@montecrit/host';
import { extendable, type ContentSet } from '../content/select.ts';

export interface RunRequest {
  /** A path in the content set ('repo/scenarios/x.yaml', later 'home/scenarios/x.yaml'). */
  readonly scenario: string;
  /** Policy ids; the first is the reference. */
  readonly policies: readonly string[];
  /** Exactly n runs per policy, or null for the adaptive rule. */
  readonly n: number | null;
  readonly untilCi: number;
  readonly maxN?: number;
  readonly chunkSize?: number;
  readonly seed: number;
  /** Seats given a loaded character in place of the scenario's own PC (`--pc seat=id`), in scenario order. */
  readonly pcs?: readonly SeatChoice[];
}

export interface SeatChoice {
  readonly seat: string;
  /** A loaded character's id. */
  readonly id: string;
}

/** Loaded content and its derived sheets (the catalog's), so seating needn't load the packs again. */
export interface Loaded {
  readonly content: Content | null;
  readonly sheets: readonly DerivedSheet[];
}

export interface BuiltJob {
  readonly job: Job | null;
  /** The scenario it extends, if any. */
  readonly base: string | null;
  readonly errors: readonly string[];
}

export function buildJob(set: ContentSet, req: RunRequest, loaded?: Loaded): BuiltJob {
  const input = scenarioInput(extendable(set), req.scenario, 'repo/scenarios');
  if (input.errors.length) return { job: null, base: null, errors: input.errors.map((d) => d.message) };
  let scenario: unknown = input.input;
  if (req.pcs && req.pcs.length > 0) {
    const l = loaded ?? (() => {
      const r = loadContent(set.packs);
      return { content: r.content, sheets: r.sheets ?? [] };
    })();
    if (!l.content) return { job: null, base: input.base, errors: ['content has errors'] };
    if (new Set(req.pcs.map((p) => p.seat)).size !== req.pcs.length) return { job: null, base: input.base, errors: ['a seat is given two characters'] };
    const seated = seatPcs(input.input, req.scenario, req.pcs.map((p) => ({ seat: p.seat, id: p.id, label: p.id, file: null, pack: null })), l.content, l.sheets);
    if ('error' in seated) return { job: null, base: input.base, errors: [seated.error] };
    scenario = seated.input;
  }
  const pol = policiesFrom(set.policies);
  if (pol.errors.length) return { job: null, base: null, errors: pol.errors.map((d) => `${d.path}: ${d.message}`) };
  if (req.policies.length === 0) return { job: null, base: null, errors: ['give at least one policy'] };
  const missing = req.policies.filter((id) => !pol.byId.has(id));
  if (missing.length) return { job: null, base: null, errors: [`no policy ${missing.join(', ')}`] };
  if (new Set(req.policies).size !== req.policies.length) return { job: null, base: null, errors: ['a policy is listed twice'] };
  const chunkSize = req.chunkSize ?? CHUNK;
  return {
    base: input.base,
    errors: [],
    job: {
      v: 1,
      packs: set.packs,
      scenario: { input: scenario, path: req.scenario },
      policies: set.policies,
      flags: {},
      knobs: {},
      arms: req.policies.map((id) => ({ label: id, policy: id, hash: pol.byId.get(id)!.hash })),
      seed: req.seed,
      run: req.n !== null ? { n: req.n, chunkSize } : { untilCi: req.untilCi, maxN: req.maxN ?? DEFAULT_MAX_N, chunkSize },
      expect: null,
    },
  };
}

/** A content-set path as the CLI prints it from the repo root. */
export function cliPath(p: string): string {
  return p.startsWith('repo/') ? p.slice(5) : p.startsWith('home/') ? `~/.montecrit/${p.slice(5)}` : p;
}

export function reportMeta(req: RunRequest, run: RunResult, base: string | null, pairs: 'ref' | 'all'): ReportMeta {
  const note = req.scenario.startsWith('home/') || base !== null ? `scenario file: ${cliPath(req.scenario)}${base !== null ? ` (extends ${cliPath(base)})` : ''}` : null;
  // The CLI prints --pc after --seed; an id never needs shell quoting (lowercase, digits, ':' and '-').
  const pcs = (req.pcs ?? []).map((p) => ` --pc ${p.seat}=${p.id}`).join('');
  return { seed: req.seed, replay: `montecrit run ${cliPath(req.scenario)} --seed ${req.seed}${pcs}`, fileNote: note, adaptive: req.n === null, checkpoint: run.checkpoint, hitCap: run.hitCap, untilCi: req.untilCi, pairs, verbose: false };
}

export interface Finished {
  readonly req: RunRequest;
  readonly base: string | null;
  /** Kept open for report and replay calls; the owner closes it. */
  readonly session: Session;
  readonly run: RunResult;
  readonly report: ReportReply;
  readonly meta: ReportMeta;
  readonly workers: number;
}

/** Workers actually used: no more than there are tasks. */
export function workerCount(job: Job, wanted: number): number {
  const chunks = Math.ceil((job.run.n ?? job.run.maxN ?? DEFAULT_MAX_N) / (job.run.chunkSize ?? CHUNK));
  return Math.max(1, Math.min(wanted, chunks * job.arms.length));
}

export function startRun(built: BuiltJob & { job: Job }, req: RunRequest, open: () => Transport, wanted: number, onProgress: (p: Progress) => void): { cancel(): void; readonly done: Promise<Finished> } {
  let cancelled = false;
  let handle: RunHandle | null = null;
  let session: Session | null = null;
  const workers = workerCount(built.job, wanted);
  const done = (async (): Promise<Finished> => {
    session = await openSession(built.job, open, workers);
    if (cancelled) throw new Cancelled();
    handle = session.run(onProgress);
    const run = await handle.done;
    // Cancel counts until the report is in: the runs may have merged while the bootstrap still computes.
    if (cancelled) throw new Cancelled();
    const meta = reportMeta(req, run, built.base, 'ref');
    const report = (await session.call({ op: 'report', run, meta })) as ReportReply;
    if (cancelled) throw new Cancelled();
    return { req, base: built.base, session, run, report, meta, workers };
  })();
  done.catch(() => (session as Session | null)?.close());
  return {
    cancel() {
      cancelled = true;
      handle?.cancel();
    },
    done,
  };
}
