// `npm run perf`: fights per second on fixed cases, local only (never in CI: timings vary by
// machine). Each case warms up, then runs 5 reps of a fixed N and reports the median, plus
// microseconds per decision and the pathfinding cache's hit rate. Every run appends one JSON
// line to ~/.montecrit/perf.jsonl and prints the change from the previous line for each case.
// Budgets (Shane re-sized 2026-11-11 for stars-ambush's MOD-1 group, coverage.md "Session S" Perf): stars-ambush >= 90, monk-ambush >= 45 alone.
// fighter-masteries is the martial case (stars-ambush with test:sample-fighter-masteries in pc1,
// as `run --pc` seats it): the weapon-mastery rider valuations G8 caches.
// barbarian-5 is the Barbarian's case (test:sample-barbarian in pc1 the same way), budget >= 90 (Shane, W1 plan D3: re-measured after W1 at 95-96, rounded down to 10).
//
//   node tools/perf.ts [--n N] [--case NAME] [--no-record]

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readScenarioInput } from '../apps/cli/src/files.ts';
import { seatCharacters } from '../apps/cli/src/run.ts';
import { homeDir, loadKnown } from '../apps/cli/src/home.ts';
import { ENGINE_VERSION, makeDeciders, resolveScenario, runFight, type Decider, type DecisionPoint, type FightSetup, type UnitView } from '../packages/engine/src/index.ts';
import { newScratch } from '../packages/engine/src/sim/context.ts';

const ROOT = join(import.meta.dirname, '..');

/** Casts the spike zone on its first turn and places it, then plays like `base`. One per fight. */
class CastsSpikesFirst implements Decider {
  readonly name = 'spikes-first';
  private readonly base: Decider;
  private cast = false;
  private placed = false;
  constructor(base: Decider) {
    this.base = base;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const want = !this.cast && dp.k === 'turn' ? 'cast:spike-growth@2' : this.cast && !this.placed && dp.k === 'place' ? 'place:F5' : null;
    if (want) {
      for (let i = 0; i < dp.legal.n; i++) {
        if (dp.keyOf(i) !== want) continue;
        if (dp.k === 'turn') this.cast = true;
        else this.placed = true;
        return i;
      }
    }
    return this.base.decide(view, dp);
  }
}

interface Case {
  name: string;
  file: string;
  /** A character id put into seat pc1, as `run --pc pc1=ID` does. */
  pc1?: string;
  deciders: (setup: FightSetup) => Decider[];
}

const CASES: Case[] = [
  { name: 'oa-interrupts-move', file: 'scenarios/golden/oa-interrupts-move.yaml', deciders: (s) => makeDeciders(s) },
  { name: 'pull-into-spikes', file: 'scenarios/golden/pull-into-spikes.yaml', deciders: (s) => makeDeciders(s) },
  { name: 'ambush-probe', file: 'scenarios/perf/ambush-probe.yaml', deciders: (s) => makeDeciders(s) },
  {
    name: 'ambush-probe+spikes',
    file: 'scenarios/perf/ambush-probe.yaml',
    deciders: (s) => makeDeciders(s).map((d, i) => (s.seats[i]!.seat === 'pc1' ? new CastsSpikesFirst(d) : d)),
  },
  { name: 'stars-ambush', file: 'scenarios/stars-ambush.yaml', deciders: (s) => makeDeciders(s) },
  // M9 (coverage.md): the Monk's case; budget 45 alone (re-sized 2026-11-11).
  { name: 'monk-ambush', file: 'scenarios/monk-ambush.yaml', deciders: (s) => makeDeciders(s) },
  { name: 'fighter-masteries', file: 'scenarios/stars-ambush.yaml', pc1: 'test:sample-fighter-masteries', deciders: (s) => makeDeciders(s) },
  // perf/barbarian-5 (coverage.md M3 step 10; budget >= 90 after W1, plan D3): stars-ambush with the class-built
  // test:sample-barbarian (Barbarian 5, Berserker) in pc1: Rage, Reckless Attack and Frenzy (W1),
  // Greataxe with Cleave, thrown Handaxes with Vex, Extra Attack.
  { name: 'barbarian-5', file: 'scenarios/stars-ambush.yaml', pc1: 'test:sample-barbarian', deciders: (s) => makeDeciders(s) },
  // The private twin (extends the public file with the real character); skipped when absent.
  { name: 'stars-ambush (private)', file: join(homeDir(process.env), 'scenarios', 'stars-ambush.yaml'), deciders: (s) => makeDeciders(s) },
];

interface Result {
  name: string;
  fightsPerSec: number;
  usPerDecision: number;
  decisionsPerFight: number;
  reachCallsPerFight: number;
  reachHitRate: number;
}

function measure(c: Case, setup: FightSetup, n: number): Result {
  const sc = newScratch(setup.w * setup.h);
  const fight = (run: number) => runFight(setup, 42, run, c.deciders(setup), null, { scratch: sc });
  for (let i = 0; i < 200; i++) fight(i);
  const rates: number[] = [];
  let decisions = 0;
  const calls0 = sc.reachEngine.calls;
  const hits0 = sc.reachEngine.hits;
  let ms = 0;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) decisions += fight(1000 + i).decisionSeq; // the same runs every rep
    const dt = performance.now() - t0;
    ms += dt;
    rates.push((n / dt) * 1000);
  }
  rates.sort((a, b) => a - b);
  const calls = sc.reachEngine.calls - calls0;
  return {
    name: c.name,
    fightsPerSec: Math.round(rates[2]!),
    usPerDecision: Math.round(((ms * 1000) / decisions) * 100) / 100,
    decisionsPerFight: Math.round((decisions / (5 * n)) * 10) / 10,
    reachCallsPerFight: Math.round((calls / (5 * n)) * 10) / 10,
    reachHitRate: calls > 0 ? Math.round(((sc.reachEngine.hits - hits0) / calls) * 1000) / 1000 : 0,
  };
}

function main(): void {
  const { values } = parseArgs({ options: { n: { type: 'string' }, case: { type: 'string' }, 'no-record': { type: 'boolean' } } });
  const n = values.n ? Number(values.n) : 500;
  const loaded = loadKnown(process.env);
  if (!loaded.content) throw new Error(loaded.errors.map(String).join('\n'));
  const results: Result[] = [];
  for (const c of CASES) {
    if (values.case && c.name !== values.case) continue;
    const path = c.file.startsWith('/') ? c.file : join(ROOT, c.file);
    if (!existsSync(path)) continue;
    const input = readScenarioInput(path);
    if (input.errors.length) throw new Error(`${c.file}: ${input.errors.map((d) => d.message).join('\n')}`);
    let scenario = input.input;
    if (c.pc1) {
      const seated = seatCharacters(scenario, path, [{ seat: 'pc1', target: c.pc1 }], loaded, []);
      if ('error' in seated) throw new Error(`${c.name}: ${seated.error}`);
      scenario = seated.input;
    }
    const res = resolveScenario(scenario, path, loaded.content);
    if (!res.setup) throw new Error(`${c.file}: ${res.errors.map((d) => d.message).join('\n')}`);
    const r = measure(c, res.setup, n);
    results.push(r);
  }
  const log = join(homedir(), '.montecrit', 'perf.jsonl');
  const prev = new Map<string, number>();
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      for (const r of (JSON.parse(line) as { results: Result[] }).results) prev.set(r.name, r.fightsPerSec);
    }
  }
  for (const r of results) {
    const p = prev.get(r.name);
    const delta = p ? ` (${r.fightsPerSec >= p ? '+' : ''}${Math.round(((r.fightsPerSec - p) / p) * 100)}% vs last)` : '';
    console.log(`${r.name.padEnd(22)} ${String(r.fightsPerSec).padStart(6)} fights/s${delta}  ${r.usPerDecision} us/decision  ${r.decisionsPerFight} decisions/fight  reach ${r.reachCallsPerFight}/fight, hit ${r.reachHitRate}`);
  }
  if (!values['no-record']) {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, JSON.stringify({ engine: ENGINE_VERSION, node: process.version, n, results }) + '\n');
  }
}

main();
