// The comparison in progress, owned by the app like a run (run/useRuns.ts), so a tab switch
// doesn't orphan it. The variants run one after another, each an ordinary run of the same fight
// with that character seated (`--pc seat=id`), the same seed and the same number of fights. A
// variant's session closes as soon as its numbers are read.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cancelled } from '@montecrit/host';
import type { ContentSet } from '../content/select.ts';
import { buildJob, startRun, type Loaded, type RunRequest } from '../run/session.ts';
import { webTransport } from '../run/web-transport.ts';
import { compare, ruleUse, type Comparison, type Played, type VariantResult } from './model.ts';

export interface CompareRequest {
  readonly scenario: string;
  readonly seat: string;
  /** Characters to compare, the reference first; '' is the scenario's own character. */
  readonly variants: readonly { readonly id: string; readonly name: string }[];
  readonly n: number;
  readonly seed: number;
  /** The policy every build plays, with its scripted rule ids. */
  readonly played: Played;
  readonly rules: readonly string[];
}

export type CompareState =
  | { readonly k: 'idle' }
  | { readonly k: 'running'; readonly at: number; readonly of: number; readonly merged: number; readonly total: number }
  | { readonly k: 'done'; readonly req: CompareRequest; readonly result: Comparison }
  | { readonly k: 'error'; readonly msg: string }
  | { readonly k: 'cancelled' };

export interface Compares {
  readonly state: CompareState;
  start(set: ContentSet, req: CompareRequest, workers: number, loaded: Loaded): void;
  cancel(): void;
}

export function useCompare(): Compares {
  const [state, setState] = useState<CompareState>({ k: 'idle' });
  const active = useRef<{ cancel(): void } | null>(null);
  const gen = useRef(0);
  useEffect(() => () => active.current?.cancel(), []);
  const start = useCallback((set: ContentSet, req: CompareRequest, workers: number, loaded: Loaded) => {
    active.current?.cancel();
    const my = ++gen.current;
    let cancelled = false;
    let current: { cancel(): void } | null = null;
    active.current = {
      cancel() {
        cancelled = true;
        current?.cancel();
      },
    };
    setState({ k: 'running', at: 0, of: req.variants.length, merged: 0, total: req.n });
    void (async () => {
      const out: VariantResult[] = [];
      for (let i = 0; i < req.variants.length; i++) {
        const v = req.variants[i]!;
        const run: RunRequest = { scenario: req.scenario, policies: [req.played.id], n: req.n, untilCi: 0.01, seed: req.seed, ...(v.id !== '' ? { pcs: [{ seat: req.seat, id: v.id }] } : {}) };
        const built = buildJob(set, run, loaded);
        if (!built.job) throw new Error(`${v.name}: ${built.errors.join('; ')}`);
        const t0 = performance.now();
        const r = startRun({ ...built, job: built.job }, run, webTransport, workers, (p) => {
          if (gen.current === my) setState({ k: 'running', at: i, of: req.variants.length, merged: p.merged, total: p.total });
        });
        current = r;
        // A fight or a script that names something this build doesn't have is refused when the run opens.
        const f = await r.done.catch((e: unknown) => {
          throw e instanceof Cancelled ? e : new Error(`${v.name} can't be run here: ${e instanceof Error ? e.message : String(e)}`);
        });
        f.session.close();
        if (cancelled) throw new Cancelled();
        out.push({ id: v.id, name: v.name, stats: f.report.stats.arms[0]!, acc: f.run.merged.arms[0]!, wallMs: performance.now() - t0, ...(req.rules.length > 0 ? { rules: ruleUse(req.rules, f.run.merged.arms[0]!.script, f.run.merged.arms[0]!.n) } : {}) });
      }
      return compare(out, req.played);
    })().then(
      (result) => {
        if (gen.current === my) setState({ k: 'done', req, result });
      },
      (e: unknown) => {
        if (gen.current === my) setState(e instanceof Cancelled ? { k: 'cancelled' } : { k: 'error', msg: e instanceof Error ? e.message : String(e) });
      },
    );
  }, []);
  const cancel = useCallback(() => active.current?.cancel(), []);
  return { state, start, cancel };
}
