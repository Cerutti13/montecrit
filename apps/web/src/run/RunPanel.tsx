// The run panel (docs/design/m2.md 5.2 item 1): scenario, policies (the first is the reference),
// fixed n or adaptive, seed, workers; Run and Cancel; live progress. The run itself belongs to
// the app (useRuns) and happens in Web Workers through the shared pool; this only shows counts.
// The seat picker (docs/design/m3.md 10) puts any loaded character into a PC seat, as
// `montecrit run X --pc seat=id` does; the report then marks calibration "not measured for this PC".

import { useState } from 'react';
import { fmt, wilson } from '@montecrit/engine';
import type { Catalog } from '../content/catalog.ts';
import type { ContentSet } from '../content/select.ts';
import type { RunRequest, SeatChoice } from './session.ts';
import type { RunState, Runs } from './useRuns.ts';
import { defaultWorkers } from './web-transport.ts';

/**
 * The seat choices a run sends: only picks whose character is still loaded. A pick whose character
 * left the catalog (say, after a home reload) is dropped, so the select (which then shows
 * "Scenario's own") and the run agree, and no stale id reaches the session.
 */
export function chosenSeats(seats: readonly { readonly seat: string }[], picks: Readonly<Record<string, string>>, characters: readonly { readonly id: string }[]): SeatChoice[] {
  const loaded = new Set(characters.map((c) => c.id));
  return seats.flatMap((s) => {
    const id = picks[s.seat];
    return id !== undefined && loaded.has(id) ? [{ seat: s.seat, id }] : [];
  });
}

export function RunPanel({ catalog, set, runs }: { catalog: Catalog; set: ContentSet; runs: Runs }) {
  const runnable = catalog.scenarios.filter((s) => s.scenarioHash !== null);
  // Like `montecrit run stars-ambush`: the home twin first, then the repo's.
  const [scenario, setScenario] = useState(runnable.find((s) => s.path === 'home/scenarios/stars-ambush.yaml')?.path ?? runnable.find((s) => s.path === 'repo/scenarios/stars-ambush.yaml')?.path ?? runnable[0]?.path ?? '');
  const [policies, setPolicies] = useState('greedy, moonbeam-first, spike-first');
  const [mode, setMode] = useState<'fixed' | 'adaptive'>('fixed');
  const [n, setN] = useState('2000');
  const [untilCi, setUntilCi] = useState('0.01');
  const [seed, setSeed] = useState('42');
  const [workers, setWorkers] = useState(defaultWorkers());
  // Seat -> character id; a seat not here keeps the scenario's own PC. Cleared with the scenario.
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const state = runs.state;
  const seats = runnable.find((s) => s.path === scenario)?.pcSeats ?? [];
  const chosen = chosenSeats(seats, picks, catalog.characters);
  const pickOf = (seat: string) => chosen.find((c) => c.seat === seat)?.id ?? '';

  const ids = policies.split(/[\s,]+/).filter((x) => x !== '');
  const go = () => {
    // The CLI's rules: whole numbers written as digits, the seed at most 2^53 - 1.
    if (!/^\d+$/.test(seed) || Number(seed) > Number.MAX_SAFE_INTEGER) return runs.fail('the seed must be a whole number, written as digits');
    const req: RunRequest = { scenario, policies: ids, n: mode === 'fixed' ? Number(n) : null, untilCi: Number(untilCi), seed: Number(seed), ...(chosen.length > 0 ? { pcs: chosen } : {}) };
    if (mode === 'fixed' && !(/^\d+$/.test(n) && req.n! >= 2)) return runs.fail('n must be a whole number, at least 2');
    if (mode === 'adaptive' && !(req.untilCi > 0 && req.untilCi <= 0.5)) return runs.fail('the CI half-width must be above 0 and at most 0.5');
    runs.start(set, req, workers, catalog);
  };

  const running = state.k === 'running';
  return (
    <section className="runpanel">
      <h2>Run</h2>
      <div className="form">
        <label>
          Scenario{' '}
          <select
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value);
              setPicks({});
            }}
            disabled={running}
          >
            {runnable.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Policies{' '}
          <input value={policies} onChange={(e) => setPolicies(e.target.value)} disabled={running} size={40} title="Comma-separated policy ids; the first is the reference" />
        </label>
        <label>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'adaptive')} disabled={running}>
            <option value="fixed">Fixed n</option>
            <option value="adaptive">Adaptive</option>
          </select>{' '}
          {mode === 'fixed' ? <input value={n} onChange={(e) => setN(e.target.value)} disabled={running} size={7} aria-label="Runs per policy" /> : <input value={untilCi} onChange={(e) => setUntilCi(e.target.value)} disabled={running} size={5} aria-label="Win CI half-width target" />}
        </label>
        <label>
          Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} disabled={running} size={6} />
        </label>
        <label>
          Workers{' '}
          <select value={workers} onChange={(e) => setWorkers(Number(e.target.value))} disabled={running}>
            {[1, 2, 4, 8].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <button type="button" onClick={runs.cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={go} disabled={!scenario}>
            Run
          </button>
        )}
      </div>
      {seats.length > 0 && catalog.characters.length > 0 && (
        <div className="form seats">
          {seats.map((s) => (
            <label key={s.seat}>
              Seat {s.seat}{' '}
              <select
                value={pickOf(s.seat)}
                onChange={(e) => {
                  const v = e.target.value;
                  setPicks((p) => {
                    const next = { ...p };
                    if (v === '') delete next[s.seat];
                    else next[s.seat] = v;
                    return next;
                  });
                }}
                disabled={running}
                title="Any loaded character, as `montecrit run --pc seat=id`"
              >
                <option value="">Scenario's own ({s.use})</option>
                {(['repo', 'home'] as const).map((origin) => {
                  const chars = catalog.characters.filter((c) => c.origin === origin);
                  return chars.length === 0 ? null : (
                    <optgroup key={origin} label={origin === 'repo' ? 'Bundled' : 'Home'}>
                      {chars.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.id})
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          ))}
          {chosen.length > 0 && <span className="muted">Calibration: not measured for this PC.</span>}
        </div>
      )}
      <p className="muted known">Policies: {catalog.policies.map((p) => p.id).join(', ')}</p>
      {state.k === 'error' && <div className="banner">{state.msg}</div>}
      {state.k === 'cancelled' && <p className="muted">Cancelled.</p>}
      {state.k === 'running' && <ProgressView s={state} />}
    </section>
  );
}

function ProgressView({ s }: { s: Extract<RunState, { k: 'running' }> }) {
  const p = s.p;
  const arms = s.req.policies.length;
  const secs = (s.now - s.t0) / 1000;
  if (!p) return <p className="muted">Starting workers...</p>;
  const rate = secs > 0 ? (p.merged * arms) / secs : 0;
  const half = (a: { win: number; n: number }) => {
    const w = wilson(a.win, a.n);
    return (w.hi - w.lo) / 2;
  };
  const live = (
    <div className="muted">
      {p.perArm.map((a) => (
        <span key={a.label} style={{ marginRight: 16 }}>
          {a.label} {fmt.pct(a.n ? a.win / a.n : 0)} ±{fmt.pct(half(a))}
        </span>
      ))}
    </div>
  );
  if (s.req.n === null) {
    // Adaptive: it stops at the first checkpoint where every arm's win CI is within the target, so
    // progress is that half-width against the target; the cap is only a bound.
    const worst = Math.max(0, ...p.perArm.map(half));
    return (
      <div className="progress">
        <span className="num">{fmt.int(p.merged)}</span> runs per policy, {fmt.int(rate)} fights/s; widest win CI ±{fmt.pct(worst)} against the target ±{fmt.pct(s.req.untilCi)} (checked every 1,000; at most {fmt.int(p.total)})
        {live}
      </div>
    );
  }
  const frac = p.total > 0 ? p.merged / p.total : 0;
  return (
    <div className="progress">
      <progress max={1} value={frac} /> <span className="num">{fmt.int(p.merged)}</span> / {fmt.int(p.total)} runs per policy, {fmt.int(rate)} fights/s
      {rate > 0 && frac < 1 ? `, about ${fmt.int(((p.total - p.merged) * arms) / rate)} s left` : ''}
      {live}
    </div>
  );
}
