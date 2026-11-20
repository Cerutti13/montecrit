// DEV only (loaded by App.tsx under import.meta.env.DEV; the dist scan refuses this hook's name):
// window.__montecrit for Claude's checks in the browser pane. Hashes and counts only, never texts.

import { hash64 } from '@montecrit/engine';
import type { ReportReply } from '@montecrit/host';
import { BUNDLED, loadBundledPacks, withPacks } from './content/bundled.ts';
import { fetchHome, withHome } from './content/home.ts';
import { buildJob, startRun, type RunRequest } from './run/session.ts';
import { webTransport } from './run/web-transport.ts';

interface SelfTest {
  readonly scenario?: string;
  readonly policies?: readonly string[];
  readonly n?: number;
  readonly chunkSize?: number;
  readonly seed?: number;
  readonly workers?: readonly number[];
  /** Also load the private home (dev server only), as the page does. */
  readonly home?: boolean;
}

async function selfTest(o: SelfTest = {}) {
  const req: RunRequest = { scenario: o.scenario ?? 'repo/scenarios/stars-ambush.yaml', policies: o.policies ?? ['greedy', 'moonbeam-first'], n: o.n ?? 40, untilCi: 0.01, chunkSize: o.chunkSize ?? 20, seed: o.seed ?? 42 };
  const h = o.home ? await fetchHome() : null;
  if (o.home && h?.k !== 'loaded') throw new Error(`no home: ${h?.k === 'none' ? h.why : h?.k === 'error' ? h.msg : '?'}`);
  const built = buildJob(withHome(withPacks(BUNDLED, await loadBundledPacks()), h?.k === 'loaded' ? h.home : null), req);
  if (!built.job) throw new Error(built.errors.join('; '));
  const out: { workers: number; used: number; reportHash: string; accHash: string; textHash: string; ms: number; fightsPerSec: number }[] = [];
  for (const w of o.workers ?? [1, 8]) {
    const t0 = performance.now();
    const f = await startRun({ ...built, job: built.job }, req, webTransport, w, () => {}).done;
    const ms = performance.now() - t0;
    out.push({ workers: w, used: f.workers, reportHash: (f.report as ReportReply).hash, accHash: f.report.accHash, textHash: hash64(f.report.text.join('\n')), ms: Math.round(ms), fightsPerSec: Math.round((f.run.merged.n * f.session.arms.length) / (ms / 1000)) });
    f.session.close();
  }
  return { req: { ...req }, runs: out, equal: out.every((r) => r.reportHash === out[0]!.reportHash && r.accHash === out[0]!.accHash) };
}

(window as unknown as { __montecrit: unknown }).__montecrit = { selfTest };
