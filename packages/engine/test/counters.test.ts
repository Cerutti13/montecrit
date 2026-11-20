// Per-fight counters (docs/design/m1c.md 3.6, resolution 13): they match a recount from the
// event log on every golden and on random fights, they're the same with or without a sink, and
// no damage falls outside the per-template sources.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { ArraySink, FX_END_WHYS, type ConcEndWhy, type GameEvent } from '../src/log/events.ts';
import type { JournalEntry } from '../src/replay.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { MAX_POOLS, pickFamilyNames, sourceOf, type Counters } from '../src/sim/counters.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { loadScenario } from './helpers/scenario.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT = loaded.content;
const scenario = (file: string): FightSetup => loadScenario(file, CONTENT);

/** What the counters should hold, recounted from the log alone. */
function recount(events: readonly GameEvent[], c: Counters) {
  const L = c.layout;
  const n = L.units;
  const S = L.sources.length;
  const dmgEff = new Int32Array(L.rounds * S);
  const dmgRolled = new Int32Array(L.rounds * S);
  const ffEff = new Int32Array(L.rounds * S);
  const ffRolled = new Int32Array(L.rounds * S);
  const dmgTaken = new Int32Array(n);
  const drops = new Uint8Array(n);
  const death = new Uint8Array(n);
  const slots = new Int16Array(n * 9);
  const preSlots = new Int16Array(n * 9);
  const freeCasts = new Int16Array(n);
  const poolTotal = new Int16Array(n);
  const concStart = new Int16Array(n);
  const concEnd = new Int16Array(n * FX_END_WHYS.length);
  const turns = new Uint16Array(n);
  const concTurns = new Uint16Array(n);
  const turnPicks = new Int32Array(n);
  const sidePicks = new Int32Array(n); // rider options and hitTaken reactions taken (M3 step 5a)
  const opportunity: boolean[] = [];
  const concFx: number[] = [];
  const liveConc = new Int32Array(n);
  let turnOf = -1;
  let counted = false;
  for (const e of events) {
    switch (e.k) {
      case 'attack':
        opportunity[e.seq] = e.opportunity;
        break;
      case 'damage': {
        const i = Math.min(e.round, L.rounds - 1) * S + sourceOf(L, e.src, e.via, opportunity[e.cause] === true);
        const eff = e.tempAbsorbed + e.hpBefore - e.hpAfter;
        dmgEff[i]! += eff;
        dmgRolled[i]! += e.dealt;
        dmgTaken[e.tgt]! += eff;
        if (L.setup.seats[e.src]!.team === L.setup.seats[e.tgt]!.team) {
          ffEff[i]! += eff;
          ffRolled[i]! += e.dealt;
        }
        if (e.hpBefore > 0 && e.hpAfter === 0) drops[e.tgt]!++;
        break;
      }
      case 'death':
        death[e.who] = e.why === 'zeroHp' ? 1 : e.why === 'massive' ? 2 : 3;
        break;
      case 'cast':
        if (e.free) {
          freeCasts[e.who]!++;
          poolTotal[e.who]!++;
        } else if (e.lvl > 0) slots[e.who * 9 + e.lvl - 1]!++;
        break;
      case 'precast':
        if (e.free) poolTotal[e.who]!++;
        else if (e.lvl > 0) preSlots[e.who * 9 + e.lvl - 1]!++;
        break;
      case 'res':
        // M3 step 5a: a spend of N > 1 points logs delta -N; a pool step (Uncanny Metabolism's
        // refill) logs its change and isn't a spend. No content has a negative pool step yet,
        // which this recount would read as a spend.
        poolTotal[e.who]! += e.delta === undefined ? 1 : e.delta < 0 ? -e.delta : 0;
        break;
      case 'react':
        poolTotal[e.who]!++;
        break;
      case 'fxStart':
        if (e.conc) {
          concFx[e.fx] = e.owner;
          concStart[e.owner]!++;
          liveConc[e.owner]!++;
        }
        break;
      case 'fxEnd':
        if (concFx[e.fx] !== undefined) {
          concEnd[e.owner * FX_END_WHYS.length + FX_END_WHYS.indexOf(e.why as ConcEndWhy)]!++; // a concentration instance never ends with a condition-only why
          liveConc[e.owner]!--;
        }
        break;
      case 'turnStart':
        turnOf = e.who;
        counted = false;
        break;
      case 'decided':
        if ((e.dk === 'rider' || e.dk === 'hitTaken' || e.dk === 'hitKnown' || e.dk === 'damageTaken' || e.dk === 'attackDeclared') && e.key !== 'pass') sidePicks[e.who]!++;
        if (e.dk !== 'turn' || e.who !== turnOf) break;
        turnPicks[e.who]!++;
        if (!counted) {
          counted = true;
          turns[e.who]!++;
          if (liveConc[e.who]! > 0) concTurns[e.who]!++;
        }
        break;
    }
  }
  return { dmgEff, dmgRolled, ffEff, ffRolled, dmgTaken, drops, death, slots, preSlots, freeCasts, poolTotal, concStart, concEnd, turns, concTurns, turnPicks, sidePicks };
}

function check(setup: FightSetup, seed: number, run: number, deciders: () => ReturnType<typeof makeDeciders>, journal: readonly JournalEntry[] = []) {
  const sink = new ArraySink();
  const logged = runFight(setup, seed, run, deciders(), sink, { journal });
  const silent = runFight(setup, seed, run, deciders(), null, { journal });
  const c = logged.counters;
  const r = recount(sink.events, c);
  // M3 step 5b: an automatic rider (a mastery that is no choice: Sap, Vex, Slow, Graze) is taken
  // with no decision; its use is the rider's act line (feature id and rider name).
  for (const e of sink.events) {
    if (e.k !== 'act') continue;
    const tpl = setup.seats[e.who]!.tpl;
    if ((tpl.riders ?? []).some((x) => x.auto && tpl.features[x.feature]!.id === e.via && x.name === e.name)) r.sidePicks[e.who]!++;
  }
  const label = `${setup.scenario} run ${run}`;
  expect(silent.counters, `${label}: counters with and without a sink`).toEqual(c);
  expect([...c.dmgEff], label).toEqual([...r.dmgEff]);
  expect([...c.dmgRolled], label).toEqual([...r.dmgRolled]);
  expect([...c.ffEff], label).toEqual([...r.ffEff]);
  expect([...c.ffRolled], label).toEqual([...r.ffRolled]);
  expect([...c.dmgTaken], label).toEqual([...r.dmgTaken]);
  expect([...c.drops], label).toEqual([...r.drops]);
  expect([...c.death], label).toEqual([...r.death]);
  expect([...c.slots], label).toEqual([...r.slots]);
  expect([...c.preSlots], label).toEqual([...r.preSlots]);
  expect([...c.freeCasts], label).toEqual([...r.freeCasts]);
  const pools = Array.from({ length: c.layout.units }, (_, u) => c.pools.slice(u * MAX_POOLS, (u + 1) * MAX_POOLS).reduce((a, b) => a + b, 0));
  expect(pools, label).toEqual([...r.poolTotal]);
  expect([...c.concStart], label).toEqual([...r.concStart]);
  expect([...c.concEnd], label).toEqual([...r.concEnd]);
  expect([...c.turns], label).toEqual([...r.turns]);
  expect([...c.concTurns], label).toEqual([...r.concTurns]);
  // An Escape from someone else's effect is a turn option whose family sits past the side families (sim/counters.ts foreignOff).
  const foreign = (u: number) => (c.layout.foreignOff[u]! >= 0 ? c.picks[c.layout.pickBase[u]! + c.layout.foreignOff[u]!]! : 0);
  const picks = Array.from({ length: c.layout.units }, (_, u) => c.picks.slice(c.layout.pickBase[u], c.layout.pickBase[u]! + c.layout.turnN[u]!).reduce((a, b) => a + b, 0) + foreign(u));
  expect(picks, `${label}: every turn decision is counted in some family`).toEqual([...r.turnPicks]);
  const side = Array.from({ length: c.layout.units }, (_, u) => c.picks.slice(c.layout.pickBase[u]! + c.layout.turnN[u]!, c.layout.pickBase[u]! + c.layout.pickN[u]!).reduce((a, b) => a + b, 0) - foreign(u));
  expect(side, `${label}: every rider and hitTaken reaction taken is counted in its family`).toEqual([...r.sidePicks]);
  for (let u = 0; u < c.layout.units; u++) {
    const o = c.layout.other[u]!;
    for (let round = 0; round < c.layout.rounds; round++) expect(c.dmgEff[round * c.layout.sources.length + o], `${label}: damage outside the template's sources`).toBe(0);
  }
  return c;
}

describe('per-fight counters', () => {
  it('match a recount of the log on every golden', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    for (const f of readdirSync(golden).filter((x) => x.endsWith('.journal.yaml'))) {
      const doc = parse(readFileSync(join(golden, f), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
      const setup = scenario(join('scenarios', 'golden', f.replace('.journal.yaml', '.yaml')));
      check(setup, doc.seed, doc.run, () => makeDeciders(setup, doc.entries), doc.entries);
    }
  });

  it('match a recount on random-legal fights with zones, concentration, free casts and pre-roll reactions', () => {
    let damage = 0;
    let conc = 0;
    let pools = 0;
    for (const file of ['scenarios/perf/ambush-probe.yaml', 'scenarios/golden/pull-into-spikes.yaml', 'scenarios/golden/moonbeam-moved-then-turn-end.yaml', 'scenarios/golden/conc-break-cascade.yaml']) {
      const setup = scenario(file);
      for (let run = 0; run < 12; run++) {
        const c = check(setup, 3, run, () => setup.seats.map(() => new RandomLegalDecider()));
        damage += c.dmgEff.reduce((a, b) => a + b, 0);
        conc += c.concStart.reduce((a, b) => a + b, 0);
        pools += c.pools.reduce((a, b) => a + b, 0);
      }
    }
    expect([damage > 0, conc > 0, pools > 0]).toEqual([true, true, true]); // the fights exercised every kind
  });

  it('count the Monk\'s riders, Deflect Attacks and each Monk\'s Focus activation in their own families (monk-ambush)', () => {
    const setup = scenario('scenarios/monk-ambush.yaml');
    const pc = setup.seats.findIndex((x) => x.seat === 'pc1');
    const tpl = setup.seats[pc]!.tpl;
    let side = 0;
    let more = 0;
    for (let run = 0; run < 16; run++) {
      const c = check(setup, 5, run, () => makeDeciders(setup, []));
      const L = c.layout;
      side += c.picks.slice(L.pickBase[pc]! + L.turnN[pc]!, L.pickBase[pc]! + L.pickN[pc]!).reduce((x, y) => x + y, 0);
      const fi = tpl.features.findIndex((f) => f.more);
      for (let k = 0; k < tpl.features[fi]!.more!.length; k++) more += c.picks[L.pickBase[pc]! + L.moreOff[pc]![fi]! + k]!;
    }
    for (let run = 0; run < 8; run++) check(setup, 5, run, () => setup.seats.map(() => new RandomLegalDecider()));
    expect([side > 0, more > 0]).toEqual([true, true]); // greedy took riders or Deflect, and Patient Defense or Step of the Wind
  }, 30_000);

  it('count the masteries, automatic (Sap, Vex, Slow, Graze) and asked (Cleave, Push, Topple), and the Light activations in their families (mastery-sampler, greedy and random-legal)', () => {
    const setup = scenario('scenarios/golden/mastery-sampler.yaml');
    let side = 0;
    for (let run = 0; run < 12; run++) {
      for (const mk of [() => makeDeciders(setup, []), () => setup.seats.map(() => new RandomLegalDecider())]) {
        const c = check(setup, 9, run, mk);
        const L = c.layout;
        for (let u = 0; u < L.units; u++) side += c.picks.slice(L.pickBase[u]! + L.turnN[u]!, L.pickBase[u]! + L.pickN[u]!).reduce((x, y) => x + y, 0);
      }
    }
    expect(side).toBeGreaterThan(0);
  });

  it('count an Escape from another creature\'s effect in its own family, and only where such a grant exists (entangle-escape)', () => {
    const setup = scenario('scenarios/golden/entangle-escape.yaml');
    const j = parse(readFileSync(join(ROOT, 'scenarios/golden/entangle-escape.journal.yaml'), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
    const c = check(setup, j.seed, j.run, () => makeDeciders(setup, j.entries), j.entries);
    const L = c.layout;
    let escapes = 0;
    for (let u = 0; u < L.units; u++) {
      expect(L.foreignOff[u]).toBeGreaterThanOrEqual(L.turnN[u]!);
      escapes += c.picks[L.pickBase[u]! + L.foreignOff[u]!]!;
      expect(pickFamilyNames(L, u).at(-1)).toBe("Escape (another creature's effect)");
    }
    expect(escapes).toBeGreaterThan(0);
    const none = scenario('scenarios/golden/mastery-sampler.yaml');
    const c0 = check(none, 9, 0, () => makeDeciders(none, []));
    expect([...c0.layout.foreignOff].every((x) => x === -1)).toBe(true);
  });

  it('count each chosen option under its own family (the demo golden\'s script)', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    const doc = parse(readFileSync(join(golden, 'pull-into-spikes.journal.yaml'), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
    const setup = scenario('scenarios/golden/pull-into-spikes.yaml');
    const c = runFight(setup, doc.seed, doc.run, makeDeciders(setup, doc.entries), null, { journal: doc.entries }).counters;
    const L = c.layout;
    const pc = setup.seats.findIndex((x) => x.seat === 'pc1');
    const gob = setup.seats.findIndex((x) => x.seat === 'gob1');
    const fam = (u: number, f: number) => c.picks[L.pickBase[u]! + f]!;
    const spell = (id: string) => L.castOff[pc]! + setup.seats[pc]!.tpl.spells.findIndex((e) => e.spell.id === id);
    const bow = L.atkOff[gob]! + setup.seats[gob]!.tpl.attacks.findIndex((a) => a.local === 'shortbow');
    expect([fam(pc, spell('srd:spike-growth')), fam(pc, spell('test:tether')), fam(pc, 0)]).toEqual([1, 1, 1]); // cast, cast, then the one pass
    expect([fam(gob, bow), fam(gob, 0)]).toEqual([1, 1]);
  });

  it('are fresh per fight and left out of the state hash', () => {
    const setup = scenario('scenarios/golden/pull-into-spikes.yaml');
    const a = runFight(setup, 3, 0, setup.seats.map(() => new RandomLegalDecider()), null);
    const b = runFight(setup, 3, 1, setup.seats.map(() => new RandomLegalDecider()), null);
    expect(a.counters).not.toBe(b.counters);
    const again = runFight(setup, 3, 0, setup.seats.map(() => new RandomLegalDecider()), null);
    again.counters.dmgEff[0]! += 999; // only state goes into the hash
    expect(again.stateHash).toBe(a.stateHash);
  });
});
