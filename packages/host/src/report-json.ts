// The report as JSON, and its hashes (docs/design/m2.md 7.2). reportJson is the CLI's --json:
// path-free (no replay command, no file note), typed arrays as plain arrays. reportHash is the
// hash of those bytes at the CLI defaults (pairs ref; verbose never reaches the JSON), so it also
// covers the chunk size the JSON records: compare runs made with the same --chunk. accHash leaves
// out `stats` and `chunkSize`, so it depends only on what was run and what the runs merged to,
// whatever the worker count or chunk size: the most direct statement of "1 worker and 8 workers
// give bit-identical output".

import { ENGINE_VERSION, hash64, trimLateFlags, type ArmSpec, type ReportStats, type RunResult } from '@montecrit/engine';

/** Typed arrays as plain arrays. The two per-flag arrays keep their old length while no step 7 flag was read, so old report hashes hold. */
function plain(key: string, v: unknown): unknown {
  if ((key === 'flagsRead' || key === 'aiFlags') && v instanceof Uint8Array) return Array.from(trimLateFlags(v));
  return ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v as unknown as ArrayLike<number>) : v;
}

function value(arms: readonly ArmSpec[], run: RunResult, seed: number): Record<string, unknown> {
  const s = arms[0]!.setup;
  return {
    engine: ENGINE_VERSION,
    scenario: s.scenario,
    scenarioHash: s.scenarioHash,
    contentHash: s.contentHash,
    seed,
    n: run.merged.n,
    adaptive: run.adaptive,
    checkpoint: run.checkpoint,
    hitCap: run.hitCap,
    chunkSize: run.merged.chunkSize,
    arms: arms.map((a, k) => ({ label: a.label, policy: a.policy?.id ?? null, policyHash: a.policy?.hash ?? null, acc: run.merged.arms[k] })),
  };
}

export function reportJson(arms: readonly ArmSpec[], run: RunResult, seed: number, stats: ReportStats): string {
  return JSON.stringify({ ...value(arms, run, seed), stats }, plain, 2);
}

export function reportHash(json: string): string {
  return hash64(json);
}

export function accHash(arms: readonly ArmSpec[], run: RunResult, seed: number): string {
  const { chunkSize: _chunkSize, ...v } = value(arms, run, seed);
  return hash64(JSON.stringify(v, plain, 2));
}
