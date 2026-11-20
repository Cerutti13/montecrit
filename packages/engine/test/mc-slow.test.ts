// The report's statistics against independent simulation (docs/design/m1c.md 8, slow suite).
// Runs only under MONTECRIT_SLOW=1 (npm run test:slow):
//   - the percentile bootstrap against the delta method at n = 10^4 (research: about 1e-3 relative);
//   - exact McNemar against 10^6 draws from its null distribution;
//   - Wilson coverage at p = 0.3, 0.5, 0.9 (n = 1,000, the first adaptive checkpoint);
//   - a Goblin Boss against an AC 15 dummy at the research's 5.85 damage per round.
// The draws here come from a test-local generator, independent of the engine's Philox streams.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { SourceFile } from '../src/content/yaml.ts';
import { ArraySink } from '../src/log/events.ts';
import { bootstrapRatios, percentileCI } from '../src/mc/boot.ts';
import { mcnemarExact, ratio, ratioDeltaSE, wilson, Z95 } from '../src/mc/stats.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { runFight } from '../src/sim/fight.ts';
import { setup } from './helpers/build.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const ROOT = join(import.meta.dirname, '..', '..', '..');

/** splitmix32: a small, well-mixed 32-bit generator for test-side draws. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}
const unit = (next: () => number) => next() / 4294967296;
const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
};

describe.runIf(SLOW)('slow: statistics against simulation', () => {
  it('the bootstrap CI of a ratio agrees with the delta method to 1e-3 of the estimate at n = 10^4', { timeout: 120_000 }, () => {
    // Fights of 1-8 rounds dealing 0-15 per round: D and R correlated, as in a real DPR series.
    const n = 10_000;
    const next = rng(20261102);
    const D = new Int32Array(n);
    const R = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = 1 + (next() % 8);
      for (let r = 0; r < R[i]!; r++) D[i]! += next() % 16;
    }
    let sd = 0;
    let sr = 0;
    for (let i = 0; i < n; i++) {
      sd += D[i]!;
      sr += R[i]!;
    }
    const est = ratio(sd, sr);
    const se = ratioDeltaSE(D, R);
    const boot = percentileCI(bootstrapRatios(42, [{ num: D, den: R }])[0]!);
    expect(Math.abs(boot.lo - (est - Z95 * se)) / est).toBeLessThan(1e-3);
    expect(Math.abs(boot.hi - (est + Z95 * se)) / est).toBeLessThan(1e-3);
  });

  it('exact McNemar matches 10^6 draws from its null distribution (b ~ Binomial(b + c, 1/2)), within 4 sigma', { timeout: 120_000 }, () => {
    const N = 1_000_000;
    for (const [b, c] of [[0, 7], [5, 5], [10, 20], [45, 62], [300, 350]] as const) {
      const m = b + c;
      const k = Math.min(b, c);
      const next = rng(m * 7919 + b);
      let extreme = 0;
      for (let s = 0; s < N; s++) {
        let x = 0;
        for (let left = m; left > 0; left -= 32) x += popcount(left >= 32 ? next() : next() & ((1 << left) - 1));
        if (Math.min(x, m - x) <= k) extreme++;
      }
      const sim = extreme / N;
      const p = mcnemarExact(b, c);
      const sigma = Math.sqrt(Math.max(p * (1 - p), 1e-12) / N);
      expect(Math.abs(p - sim), `b ${b} c ${c}: exact ${p}, simulated ${sim}`).toBeLessThanOrEqual(4 * sigma + 1e-12);
    }
  });

  it('Wilson coverage at p = 0.3, 0.5, 0.9 (n = 1,000): simulated within 3 MC standard errors of exact, exact within 1 point of 95%', { timeout: 300_000 }, () => {
    const n = 1000;
    const reps = 100_000;
    for (const p of [0.3, 0.5, 0.9]) {
      // Exact coverage: the binomial mass of every x whose interval holds p.
      let logPmf = n * Math.log(1 - p);
      let exact = 0;
      for (let x = 0; x <= n; x++) {
        const w = wilson(x, n);
        if (w.lo <= p && p <= w.hi) exact += Math.exp(logPmf);
        logPmf += Math.log((n - x) / (x + 1)) + Math.log(p / (1 - p));
      }
      const next = rng(Math.round(p * 1000));
      let covered = 0;
      for (let r = 0; r < reps; r++) {
        let x = 0;
        for (let i = 0; i < n; i++) if (unit(next) < p) x++;
        const w = wilson(x, n);
        if (w.lo <= p && p <= w.hi) covered++;
      }
      const sim = covered / reps;
      const se = Math.sqrt((exact * (1 - exact)) / reps);
      expect(Math.abs(sim - exact), `p ${p}: simulated ${sim}, exact ${exact}`).toBeLessThanOrEqual(3 * se);
      expect(Math.abs(exact - 0.95), `p ${p}: exact ${exact}`).toBeLessThan(0.01);
    }
  });

  it('a Goblin Boss against an AC 15 dummy deals 5.85 per round (two attacks at +4, 1d6+2, crits on 20)', { timeout: 300_000 }, () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((x) => (statSync(join(d, x)).isDirectory() ? walk(join(d, x)) : x.endsWith('.yaml') ? [join(d, x)] : [])).sort();
    const files: SourceFile[] = ['srd-5.2.1', 'test'].flatMap((pk) => walk(join(ROOT, 'packs', pk)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') })));
    const content = loadContent(files).content!;
    const boss = content.get('srd:goblin-boss')!;
    const dummy = { ...content.get('test:training-dummy')!, ac: 15 };
    // Neither side can drop (the dummy's swat can't dent 100,000 HP): the fight always runs to the round cap.
    const s = setup({ w: 3, h: 3, knobs: { maxRounds: 20 }, units: [{ seat: 'boss', team: 1, tpl: boss, at: 'A1', hp: 100_000, decider: 'greedy' }, { seat: 'dummy', team: 0, tpl: dummy, at: 'B1', hp: 1_000_000 }] });
    const bossIdx = s.seats.findIndex((x) => x.seat === 'boss');
    let dmg = 0;
    let dmg2 = 0;
    let turns = 0;
    for (let f = 0; f < 5000; f++) {
      const sink = new ArraySink();
      runFight(s, 7, f, makeDeciders(s, []), sink);
      let turn = -1;
      for (const e of sink.events) {
        if (e.k === 'turnStart' && e.who === bossIdx) {
          if (turn >= 0) {
            dmg += turn;
            dmg2 += turn * turn;
          }
          turn = 0;
          turns++;
        } else if (e.k === 'damage' && e.src === bossIdx) turn += e.dealt;
        else if (e.k === 'attack' && e.att === bossIdx) expect(e.tgt).not.toBe(bossIdx);
      }
      dmg += turn;
      dmg2 += turn * turn;
    }
    const mean = dmg / turns;
    const se = Math.sqrt((dmg2 / turns - mean * mean) / turns);
    expect(turns).toBe(5000 * 20);
    expect(Math.abs(mean - 5.85), `mean ${mean.toFixed(4)} per turn, se ${se.toFixed(4)}`).toBeLessThanOrEqual(4 * se);
  });
});
