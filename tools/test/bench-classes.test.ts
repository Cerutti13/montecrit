// The C0 class bench and its curated tables (docs/design/coverage.md section 6 as amended by M13,
// L1, m9): tools/class-picks.ts, tools/bench-trace.ts, tools/bench-core.ts, tools/bench-classes.ts.
// The fast suite checks the tables, the sizing, the exact loop values against the hand-computed
// book-DPR table, the trace and the F toggle; the test:slow subset (MONTECRIT_SLOW=1) runs one class
// per wave at L5 on the dummies and the party bench, on worker threads, and must be the same text
// as in-process.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { NON_SRD_NAMES } from '../check-private.ts';
import { assertNoPrivate, CORE, CURATED, curatedIds, curatedText, PICK_CLASSES, PICK_LEVELS, THRESHOLDS } from '../class-picks.ts';
import { BENCH_CAUSES, causeText, dodgeStreak, downedKind, holdsHeal, noCauses, stalemateCause, TraceSink, viaFromFeature, type UnitTrace } from '../bench-trace.ts';
import { makeDeciders, runFight, STALEMATE_CAUSES, STALEMATE_DODGE_STREAK, STALEMATE_NO_DAMAGE_ROUNDS, stalemateCauseOf, type GameState, type Life } from '../../packages/engine/src/index.ts';
import { createContext } from '../../packages/engine/src/sim/fight.ts';
import { componentsOk } from '../../packages/engine/src/sim/cast.ts';
import {
  armSetup,
  attackEv,
  benchSetup,
  benchWorld,
  CountRemovable,
  coreUsedIn,
  materialSupplied,
  DUEL_MONSTER,
  crOf,
  DUMMY_AC,
  engineLoop,
  PARTY_GROUP,
  PassDecider,
  QualifyingTurns,
  removalSet,
  REPORTED_SPELLS,
  riderIndex,
  runTask,
  shareRidersFor,
  strippedContent,
  WithoutCore,
  withoutFeatures,
  XP_BUDGET,
  XP_BY_CR,
  type Bench,
  type FightRow,
  type TaskResult,
} from '../bench-core.ts';
import { bestOfTwoMean, BOOK_DPR, diceMean, evaluate, normalUpper, savageAttackerEv, pairedDiff, planTasks, QUICK, renderBench, renderSpellCasts, runInProcess, runOnWorkers, type BenchOptions, type BenchRow } from '../bench-classes.ts';
import type { PickClass } from '../class-picks.ts';
import type { CompiledRider, CompiledTemplate, Decider, DecisionPoint, UnitView } from '../../packages/engine/src/index.ts';
import { smokeSpells } from '../smoke-corpus.ts';
import { identOf } from '../import-srd/ids.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const WORLD = benchWorld();

describe('the curated pick table (coverage.md section 4) is SRD-only, typical and shared by smoke and bench', () => {
  it('has one build per class, and every id it names is defined by the SRD pack', () => {
    expect(Object.keys(CURATED).sort()).toEqual([...PICK_CLASSES].sort());
    const defined = new Set<string>();
    for (const f of WORLD.files) for (const m of f.text.matchAll(/^id: (srd:[a-z0-9/-]+)$/gm)) defined.add(m[1]!);
    for (const id of curatedIds()) {
      expect(id.startsWith('srd:'), id).toBe(true);
      expect(defined.has(id), `${id} is not defined by packs/srd-5.2.1`).toBe(true);
    }
  });

  it('puts no Archery on a Longsword build and no Agonizing Blast on a build without Eldritch Blast', () => {
    for (const c of PICK_CLASSES) {
      const b = CURATED[c];
      const melee = b.weapons.some((w) => (typeof w === 'string' ? w : w.id) === 'srd:longsword');
      const styles = Object.entries(b.prefer).filter(([k]) => k.endsWith('#fighting-style')).flatMap(([, v]) => v);
      if (melee) expect(styles, c).not.toContain('srd:archery');
      const inv = Object.entries(b.prefer).filter(([k]) => k.includes('#eldritch-invocations')).flatMap(([, v]) => v);
      if (!(b.cantrips ?? []).includes('srd:eldritch-blast')) expect(inv, c).not.toContain('srd:warlock/agonizing-blast');
    }
  });

  it('drives the smoke corpus: each character has its class build species and background, and casters prepare their preferences first', () => {
    for (const ch of WORLD.corpus) {
      const b = CURATED[ch.cls as keyof typeof CURATED];
      expect(ch.text, ch.id).toContain(`species: ${b.species}`);
      expect(ch.text, ch.id).toContain(`background: ${b.background}`);
    }
    const wiz5 = WORLD.corpus.find((c) => c.id === 'test:smoke-wizard-5')!.text;
    expect(wiz5).toContain('srd:fireball');
    expect(wiz5).toContain('srd:shatter');
    expect(wiz5).toContain('srd:fire-bolt');
    expect(WORLD.corpus.find((c) => c.id === 'test:smoke-cleric-3')!.text).toContain('srd:guiding-bolt');
    expect(WORLD.corpus.find((c) => c.id === 'test:smoke-fighter-1')!.text).toContain('srd:fighter#fighting-style: [srd:defense]');
  });

  it('every generated character loads with 0 lint errors (the corpus the bench fights)', () => {
    for (const cls of PICK_CLASSES) for (const l of PICK_LEVELS) expect(WORLD.content.get(`test:smoke-${cls}-${l}`), `${cls} ${l}`).toBeDefined();
  });
});

describe('L1: the private-name scan runs over every generated text and fails closed', () => {
  it('passes the pick table and all 60 corpus texts', () => {
    expect(() => assertNoPrivate([{ path: 'tools/class-picks.ts', text: curatedText() }], 'table')).not.toThrow();
    expect(() => assertNoPrivate(WORLD.corpus, 'corpus')).not.toThrow();
  });
  it('throws on a generated text carrying a non-SRD name, and on one at a private-named path', () => {
    const name = NON_SRD_NAMES[0]!;
    expect(() => assertNoPrivate([{ path: 'packs/test/characters/smoke/x.yaml', text: `name: ${name}\n` }], 'corpus')).toThrow(/failed closed/);
    expect(() => assertNoPrivate([{ path: `packs/test/characters/${name.toLowerCase().replace(/ /g, '-')}.yaml`, text: 'kind: character\n' }], 'corpus')).toThrow(/failed closed/);
  });
});

describe('the core-feature table and the frozen thresholds (M13 c, d, e, f)', () => {
  it('names the M13 (e) core for every class', () => {
    const labels = Object.fromEntries(PICK_CLASSES.map((c) => [c, CORE[c].core.map((x) => x.label).join(' + ')]));
    expect(labels.barbarian).toBe('Rage');
    expect(labels.fighter).toBe('Action Surge + Weapon Mastery');
    expect(labels.monk).toBe('Martial Arts bonus attack + Focus spend');
    expect(labels.paladin).toBe('Divine Smite');
    expect(labels.ranger).toBe("Hunter's Mark");
    expect(labels.rogue).toBe('Sneak Attack');
    expect(labels.warlock).toContain('Eldritch Blast');
    for (const c of ['sorcerer', 'wizard'] as const) expect(labels[c]).toBe('best damaging spell');
  });
  it('keeps the section-6 thresholds exactly as frozen', () => {
    expect(THRESHOLDS.dodgeShareMax).toBe(0.2);
    expect(THRESHOLDS.stalemateShareMax).toBe(0.05);
    expect(THRESHOLDS.neverActsMax).toBe(0);
    expect(THRESHOLDS.itemDecisionsPerFightMax).toBe(1);
    expect(THRESHOLDS.aiUtilizationMin).toBe(0.8);
    expect(THRESHOLDS.aiUtilizationFromLevel).toBe(3);
    expect(THRESHOLDS.fN).toBe(2000);
    expect(THRESHOLDS.fMinEffectPoints).toBe(5);
    expect(THRESHOLDS.fAlpha).toBe(0.05);
    expect(CORE.barbarian.uThreshold).toBe(0.8);
    expect(CORE.rogue.uThreshold).toBe(0.6);
    expect(CORE.warlock.uThreshold).toBe(0.7);
    for (const c of ['bard', 'cleric', 'druid', 'sorcerer', 'wizard'] as const) expect(CORE[c].uThreshold).toBe(0.9);
  });
  // The design docs stay in the private development repo; this cross-check runs only where they exist.
  it.skipIf(!existsSync(join(import.meta.dirname, '..', '..', 'docs', 'design', 'coverage.md')))('equals the "Frozen thresholds (C0)" section of coverage.md: every class row, its U percentage, its [U] mark and its D bench', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'design', 'coverage.md'), 'utf8');
    const sec = doc.slice(doc.indexOf('## Frozen thresholds (C0)'));
    expect(sec.length).toBeGreaterThan(100);
    for (const c of PICK_CLASSES) {
      const name = c[0]!.toUpperCase() + c.slice(1);
      const row = sec.split('\n').find((l) => l.startsWith(`| ${name} |`));
      expect(row, name).toBeDefined();
      const cells = row!.split('|').map((s) => s.trim());
      const pct = /≥ (\d+)%/.exec(cells[3]!);
      expect(Number(pct![1]) / 100, name).toBe(CORE[c].uThreshold);
      expect(cells[4]!.includes('[U]'), name).toBe(CORE[c].uSource.startsWith('[U]'));
      expect(cells[5], name).toBe(CORE[c].dBench);
    }
    expect(sec).toContain(`K = ${THRESHOLDS.noDamageRoundsK} rounds`);
    expect(sec).toContain(`streak of ≥ ${THRESHOLDS.dodgeStreak} Dodged`);
    expect(sec).toContain(`n ${String(THRESHOLDS.fN).replace(/(\d)(?=(\d{3})+$)/g, '$1,')} paired`);
  });
});

describe('bench sizing follows the SRD XP tables (M1)', () => {
  it('sizes the duel by the one-character low budget: within it, the next CR up over it, and CR <= level', () => {
    const tiers = Object.values(XP_BY_CR).sort((a, b) => a - b);
    for (const l of PICK_LEVELS) {
      const m = crOf(WORLD, DUEL_MONSTER[l]!);
      expect(m.xp, `L${l}`).toBeLessThanOrEqual(XP_BUDGET[l]!.low);
      const next = tiers.find((x) => x > m.xp)!;
      expect(next, `L${l}: a bigger single monster would still fit`).toBeGreaterThan(XP_BUDGET[l]!.low);
      expect(m.crValue, `L${l}`).toBeLessThanOrEqual(l);
    }
  });
  it('sizes the party group within the moderate budget for four characters', () => {
    for (const l of PICK_LEVELS) {
      const xp = PARTY_GROUP[l]!.reduce((a, m) => a + crOf(WORLD, m).xp, 0);
      expect(xp, `L${l}`).toBeLessThanOrEqual(4 * XP_BUDGET[l]!.moderate);
      expect(xp, `L${l}`).toBeGreaterThanOrEqual(0.9 * 4 * XP_BUDGET[l]!.moderate);
    }
  });
  it('uses the level-band dummy AC', () => {
    for (const l of PICK_LEVELS) expect(benchSetup(WORLD, 'dummy-melee', 'fighter', l).seats.find((s) => s.seat === 'dummy')!.tpl.ac).toBe(DUMMY_AC[l]);
  });
});

describe('the book-DPR table (M13 a): the engine-exact loop equals the hand-computed modeled part', () => {
  for (const b of BOOK_DPR) {
    it(`${b.cls} L5 vs AC 15: engine ${b.modeled.toFixed(3)}, written ${b.written.toFixed(3)}`, () => {
      const loop = engineLoop(b.cls, benchSetup(WORLD, 'dummy-melee', b.cls, 5));
      expect(loop.total).toBeCloseTo(b.modeled, 9);
      expect(b.written).toBeGreaterThanOrEqual(b.modeled);
      expect(b.cites.length).toBeGreaterThan(0);
      for (const c of b.cites) expect(c).toMatch(/\d{3,5}/);
    });
  }
});

describe('loop-health trace and stalemate causes (G4, m10)', () => {
  it('counts the trailing Dodge streak', () => {
    expect(dodgeStreak([1, 0, 1, 1, 1])).toBe(3);
    expect(dodgeStreak([1, 1, 0])).toBe(0);
  });
  it("passes the engine's cause through (dodge-loop, no-damage, round-cap), whatever the sink's own counts say; nothing for a win", () => {
    const s = new TraceSink([0], [0, 1], -1);
    s.units.get(0)!.dodgeSeq.push(1, 1, 1);
    for (let r = 0; r <= 10; r++) s.anyDamage[r] = 5;
    const stale = { k: 'stalemate', round: 10, tpk: false } as const;
    for (const c of ['dodge-loop', 'no-damage', 'round-cap'] as const) expect(stalemateCause({ outcome: stale, life: ['up', 'up'], stalemateCause: c }, s)).toBe(c);
    expect(stalemateCause({ outcome: { k: 'win', round: 3, tpk: false }, life: ['up', 'dead'] }, s)).toBeNull();
    expect(() => stalemateCause({ outcome: stale, life: ['up', 'up'] }, s)).toThrow(/no engine cause/);
  });
  it('changes no fight: the same state hash with and without the trace sink', () => {
    const setup = benchSetup(WORLD, 'party', 'monk', 5);
    for (let run = 0; run < 3; run++) {
      const a = runFight(setup, 14, run, makeDeciders(setup), null);
      const b = runFight(setup, 14, run, makeDeciders(setup), new TraceSink([0, 1, 2, 3], setup.seats.map((s) => s.team), -1));
      expect(b.stateHash).toBe(a.stateHash);
    }
  });
  it('the pass-only dummy never deals damage', () => {
    const r = runTask(WORLD, { bench: 'dummy-melee', cls: 'fighter', level: 3, arm: 'base', from: 0, to: 10 });
    expect(r.error).toBeNull();
    const setup = benchSetup(WORLD, 'dummy-melee', 'fighter', 3);
    const pc = setup.seats.findIndex((s) => s.seat === 'pc1');
    const dummy = setup.seats.findIndex((s) => s.seat === 'dummy');
    const ds = makeDeciders(setup);
    ds[dummy] = new PassDecider();
    const res = runFight(setup, 11, 0, ds, null);
    expect(res.hp[pc]).toBe(res.hpMax[pc]);
  });
});

describe('the F arm removes exactly the core feature from the decisions (in-memory toggle, common random numbers)', () => {
  it("a Fighter without Action Surge never uses it; with it, it does; and the removal names what it can't remove", () => {
    const base = runTask(WORLD, { bench: 'party', cls: 'fighter', level: 5, arm: 'base', from: 0, to: 6 });
    const rem = runTask(WORLD, { bench: 'party', cls: 'fighter', level: 5, arm: 'removed', from: 0, to: 6 });
    const setup = benchSetup(WORLD, 'party', 'fighter', 5);
    const pc = setup.seats.findIndex((s) => s.seat === 'pc1');
    const tpl = setup.seats[pc]!.tpl;
    // Review R1: coreUsed is exactly "Action Surge was used" in the base arm (the masteries don't count).
    for (let run = 0; run < 6; run++) {
      const sink = new TraceSink([pc], setup.seats.map((s) => s.team), -1);
      runFight(setup, 14, run, makeDeciders(setup), sink);
      expect(base.rows[run]!.coreUsed, `run ${run}`).toBe((sink.units.get(pc)!.acts.get('srd:fighter/action-surge') ?? 0) > 0);
    }
    expect(base.rows.some((r) => r.coreUsed)).toBe(true);
    const rm = removalSet('fighter', tpl);
    expect([...rm.features]).toEqual(['srd:fighter/action-surge']);
    expect(rm.auto.length).toBeGreaterThan(0); // the masteries are automatic riders
    for (let run = 0; run < 6; run++) {
      const ds = makeDeciders(setup);
      ds[pc] = new WithoutCore(ds[pc]!, tpl, rm.features, rm.spells);
      const sink = new TraceSink([pc], setup.seats.map((s) => s.team), -1);
      runFight(setup, 14, run, ds, sink);
      expect(sink.units.get(pc)!.acts.get('srd:fighter/action-surge') ?? 0).toBe(0);
    }
    expect(rem.rows).toHaveLength(6);
    // Without Action Surge no fight counts, however often the masteries fire.
    expect(rem.rows.every((r) => !r.coreUsed)).toBe(true);
  });
  it('a class whose core is narrative has nothing to remove (the Paladin\'s Divine Smite, until W2)', () => {
    const tpl = benchSetup(WORLD, 'party', 'paladin', 5).seats.find((s) => s.seat === 'pc1')!.tpl;
    const rm = removalSet('paladin', tpl);
    expect(rm.features.size + rm.spells.size + rm.riders.size).toBe(0);
  });
});

describe('F statistics', () => {
  it('normalUpper matches the normal tail', () => {
    expect(normalUpper(0)).toBeCloseTo(0.5, 6);
    expect(normalUpper(1.959964)).toBeCloseTo(0.025, 5);
    expect(normalUpper(-1.959964)).toBeCloseTo(0.975, 5);
  });
  it('pairedDiff is base - removed in points with a paired SE', () => {
    const d = pairedDiff([500, 600, 700, 800], [400, 500, 650, 700]);
    expect(d.diff).toBeCloseTo(8.75, 9);
    expect(d.p).toBeLessThan(0.05);
    expect(pairedDiff([500, 500], [500, 500]).p).toBe(1);
  });
});

describe('the bench report is deterministic', () => {
  const tiny: BenchOptions = { ...QUICK, classes: ['monk'], levels: [3], n: { 'dummy-melee': 4, 'dummy-range': 4, duel: 4, party: 6 }, benches: ['dummy-melee', 'dummy-range', 'duel', 'party'], fLevels: [3], partyWOnly: 6, chunk: 3 };
  it('prints the same text twice in-process, and on two worker threads', async () => {
    const a = renderBench(WORLD, tiny, evaluate(WORLD, tiny, runInProcess(WORLD, planTasks(tiny))));
    const b = renderBench(WORLD, tiny, evaluate(WORLD, tiny, runInProcess(WORLD, planTasks(tiny))));
    expect(b).toBe(a);
    const c = renderBench(WORLD, tiny, evaluate(WORLD, tiny, await runOnWorkers(planTasks(tiny), 2)));
    expect(c).toBe(a);
    expect(a).toMatch(/^monk +3 +(pass|FAIL)/m);
    for (const m of ['H', 'U', 'D', 'F', 'W']) expect(a).toContain(`  ${m}`);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// C0 review: the measures (R1-R4), the tables (rules R1, R2) and the verdicts (T1, T3, T4).

const trace = (o: Partial<Pick<UnitTrace, 'acts' | 'spells' | 'leveledCasts' | 'firstActRound' | 'firstCastRound'>> = {}) => ({
  acts: new Map<string, number>(),
  spells: new Map<string, number>(),
  leveledCasts: 0,
  firstActRound: new Map<string, number>(),
  firstCastRound: new Map<string, number>(),
  ...o,
});
const tplOf = (cls: PickClass, level: number, bench: Bench = 'party') => benchSetup(WORLD, bench, cls, level).seats.find((s) => s.seat === 'pc1')!.tpl;

describe('review R1, R2: U reads only the frozen rule\'s feature, in the frozen rule\'s form', () => {
  it('the Fighter counts Action Surge only; a Weapon Mastery rider alone is not a use', () => {
    const tpl = tplOf('fighter', 3);
    expect(coreUsedIn('fighter', tpl, trace({ acts: new Map([['core:mastery-longsword', 3]]), firstActRound: new Map([['core:mastery-longsword', 1]]) }))).toBe(false);
    expect(coreUsedIn('fighter', tpl, trace({ acts: new Map([['srd:fighter/action-surge', 1]]), firstActRound: new Map([['srd:fighter/action-surge', 4]]) }))).toBe(true);
  });
  it('the L1 Fighter has no Action Surge (srd-raw.txt:10624), so its U row is n/a, not a pass, whatever the trace says', () => {
    expect(tplOf('fighter', 1).features.some((f) => f.id === 'srd:fighter/action-surge')).toBe(false);
    const o = opts(['fighter'], [1], ['party']);
    const [r] = evaluate(WORLD, o, [res('party', 'fighter', 1, 'base', Array.from({ length: 20 }, () => row({ coreUsed: true })))]);
    expect([r!.U.pass, r!.U.value]).toEqual([null, 'n/a']);
    expect(r!.U.reason).toContain('srd-raw.txt:10624');
  });
  it('Hunter\'s Mark counts only when first cast by round 2', () => {
    const tpl = tplOf('ranger', 5);
    expect(coreUsedIn('ranger', tpl, trace({ spells: new Map([['srd:hunters-mark', 1]]), firstCastRound: new Map([['srd:hunters-mark', 2]]) }))).toBe(true);
    expect(coreUsedIn('ranger', tpl, trace({ spells: new Map([['srd:hunters-mark', 1]]), firstCastRound: new Map([['srd:hunters-mark', 3]]) }))).toBe(false);
  });
  it('every rate rule is read as a rate or reads n/a: no class with a per-round, per-turn or per-crit rule is read per fight', () => {
    expect(CORE.barbarian.uRead).toBe('uptimeAfterRound1');
    // W1: the Rogue's per-turn rule is read per qualifying turn (QualifyingTurns), never per fight.
    expect(CORE.rogue.uRead).toBe('perQualifyingTurn');
    expect(coreUsedIn('rogue', tplOf('rogue', 5), trace({ acts: new Map([['srd:rogue/sneak-attack', 9]]), firstActRound: new Map([['srd:rogue/sneak-attack', 1]]) }))).toBe(false);
    for (const c of ['paladin', 'warlock'] as const) {
      expect(CORE[c].uRead, c).toBe('unmeasured');
      expect(coreUsedIn(c, tplOf(c, 5), trace({ acts: new Map(CORE[c].uIds.map((id) => [id, 9])), spells: new Map(CORE[c].uIds.map((id) => [id, 9])), firstActRound: new Map(CORE[c].uIds.map((id) => [id, 1])), firstCastRound: new Map(CORE[c].uIds.map((id) => [id, 1])) })), c).toBe(false);
    }
    // Rage once in a fight is not "Rage up >= 80% of rounds after round 1".
    expect(coreUsedIn('barbarian', tplOf('barbarian', 5), trace({ acts: new Map([['srd:barbarian/rage', 1]]), firstActRound: new Map([['srd:barbarian/rage', 10]]) }))).toBe(false);
  });
});

describe('review R3: the Monk\'s loop Flurries only in the window rounds its Focus Points pay for', () => {
  const ev = (level: number) => {
    const setup = benchSetup(WORLD, 'dummy-melee', 'monk', level);
    const tpl = setup.seats.find((s) => s.seat === 'pc1')!.tpl;
    return attackEv(tpl.attacks.find((a) => a.unarmed)!, DUMMY_AC[level]!, setup);
  };
  it('L3 (3 Focus Points, 1 spent in round 1): 2 of 4 window rounds Flurry, the other 2 the Martial Arts strike', () => {
    const loop = engineLoop('monk', benchSetup(WORLD, 'dummy-melee', 'monk', 3));
    expect(loop.parts.map((p) => p.count)).toEqual([1, 1, 0.5]);
    expect(loop.note).toContain('in 2 of 4 window rounds');
    const strikes = loop.parts.reduce((a, p) => a + p.count, 0);
    expect(strikes).toBe(2.5); // one Attack + (2 x 2 + 2 x 1) / 4 bonus strikes; was 3
    expect(ev(3)).toBeGreaterThan(0);
  });
  it('L5 and up: every window round Flurries (the book-DPR row)', () => {
    for (const l of [5, 6, 10]) expect(engineLoop('monk', benchSetup(WORLD, 'dummy-melee', 'monk', l)).note, `L${l}`).toContain('in 4 of 4 window rounds');
  });
});

describe('review rules R1: every id the core table names exists', () => {
  it('core features are SRD pack features, automatic riders are features some curated template carries, U ids are pack features or SRD spells (a not-emitted one only on a notModeled core)', () => {
    const defined = new Set<string>();
    for (const f of WORLD.files) for (const m of f.text.matchAll(/^id: (srd:[a-z0-9/-]+)$/gm)) defined.add(m[1]!);
    const pdfSpells = new Set(smokeSpells(readFileSync(join(import.meta.dirname, '..', 'import-srd', 'srd-index.json'), 'utf8')).map((x) => `srd:${identOf({}, x.name)}`));
    expect(pdfSpells.has('srd:hunters-mark')).toBe(true);
    const tplFeatures = new Set<string>();
    for (const c of PICK_CLASSES) for (const l of PICK_LEVELS) for (const f of WORLD.content.get(`test:smoke-${c}-${l}`)!.features) tplFeatures.add(f.id);
    for (const c of PICK_CLASSES) {
      for (const k of CORE[c].core) {
        for (const f of k.features) expect(defined.has(f), `${c}: ${f}`).toBe(true);
        for (const s of k.spells) if (s !== '*') expect(defined.has(s) || (k.notModeled !== undefined && pdfSpells.has(s)), `${c}: ${s}`).toBe(true);
        for (const a of k.autoActs) expect(tplFeatures.has(a), `${c}: ${a}`).toBe(true);
      }
      const named = CORE[c].core.flatMap((k) => [...k.features, ...k.spells]);
      for (const id of CORE[c].uIds) if (!id.startsWith('*')) expect(named, `${c}: U reads ${id}, which no core entry names`).toContain(id);
    }
  });
});

describe('review rules R2: no curated build wears armor and takes Armor of Shadows', () => {
  it('Mage Armor needs no armor (srd-raw.txt:28619-28621), so a build with armor never picks it, and no warlock text carries it', () => {
    for (const c of PICK_CLASSES) {
      const b = CURATED[c];
      const inv = Object.values(b.prefer).flat();
      if (b.armor) expect(inv, c).not.toContain('srd:warlock/armor-of-shadows');
    }
    for (const ch of WORLD.corpus.filter((x) => x.cls === 'warlock')) {
      expect(ch.text, ch.id).toContain('armor: srd:leather-armor');
      expect(ch.text, ch.id).not.toContain('srd:warlock/armor-of-shadows');
      expect(ch.text, ch.id).toContain('srd:warlock/eldritch-mind');
    }
  });
});

const row = (o: Partial<FightRow> = {}): FightRow => ({
  outcome: 'win', cause: null, turnsUp: 10, dodges: 0, attacks: 5, casts: 0, spellCasts: [], items: 0, coreUsed: true, turnsAfterR1: 9, upTurnsAfterR1: 0, crits: 0, hitTurns: 3,
  cantripRounds: 4, cantripRoundDmg: 0, dummyDmg2to5: 0, firstDamageRound: 1, foeHpRemovedPermille: 500, pcDamage: 0, rounds: 3, coreLegalTurns: 5,
  qualTurns: 0, qualTaken: 0, hitTurnsAll: 0, shareDmg2to5: 0, ...o,
});
const res = (bench: Bench, cls: PickClass, level: number, arm: 'base' | 'removed', rows: FightRow[]): TaskResult => ({ spec: { bench, cls, level, arm, from: 0, to: rows.length }, rows, error: null });
const opts = (classes: PickClass[], levels: number[], benches: Bench[]): BenchOptions => ({ classes, levels, benches, n: { 'dummy-melee': 100, 'dummy-range': 100, duel: 100, party: 100 }, f: true, fLevels: levels, partyWOnly: 100, chunk: 100 });
const times = (n: number, f: (i: number) => FightRow): FightRow[] => Array.from({ length: n }, (_, i) => f(i));
const one = (o: BenchOptions, rs: TaskResult[]): BenchRow => evaluate(WORLD, o, rs)[0]!;

describe('review T1: evaluate() turns synthetic fight rows into the frozen verdicts', () => {
  it('H: a Dodge share of 19% passes and 21% fails', () => {
    const o = opts(['fighter'], [3], ['dummy-melee']);
    expect(one(o, [res('dummy-melee', 'fighter', 3, 'base', [row({ turnsUp: 100, dodges: 19 })])]).H.pass).toBe(true);
    const r = one(o, [res('dummy-melee', 'fighter', 3, 'base', [row({ turnsUp: 100, dodges: 21 })])]);
    expect(r.H.pass).toBe(false);
    expect(r.H.reason).toContain('Dodge 21.0% of turns on dummy-melee');
  });
  it('H: 6% stalemates fail on party, 5% pass; on dummy-melee 6% is fine', () => {
    const stale = (k: number) => times(100, (i) => row(i < k ? { outcome: 'stalemate', cause: 'round-cap' } : {}));
    expect(one(opts(['fighter'], [3], ['party']), [res('party', 'fighter', 3, 'base', stale(6))]).H.pass).toBe(false);
    expect(one(opts(['fighter'], [3], ['party']), [res('party', 'fighter', 3, 'base', stale(5))]).H.pass).toBe(true);
    expect(one(opts(['fighter'], [3], ['dummy-melee']), [res('dummy-melee', 'fighter', 3, 'base', stale(6))]).H.pass).toBe(true);
  });
  it('H: 1.01 item decisions per fight fail, 1.00 pass; never acting fails', () => {
    const items = (n: number) => times(100, (i) => row({ items: i === 0 ? n - 99 : 1 }));
    const o = opts(['fighter'], [3], ['dummy-melee']);
    expect(one(o, [res('dummy-melee', 'fighter', 3, 'base', items(101))]).H.pass).toBe(false);
    expect(one(o, [res('dummy-melee', 'fighter', 3, 'base', items(100))]).H.pass).toBe(true);
    expect(one(o, [res('dummy-melee', 'fighter', 3, 'base', [row({ attacks: 0, casts: 0 })])]).H.reason).toContain('never attacks or casts');
  });
  it('U: a core-use rate just under the threshold fails and at it passes (Fighter L3, 90%)', () => {
    const o = opts(['fighter'], [3], ['party']);
    const u = (k: number) => one(o, [res('party', 'fighter', 3, 'base', times(100, (i) => row({ coreUsed: i < k })))]).U;
    expect([u(89).pass, u(89).value]).toEqual([false, '89.0%']);
    expect([u(90).pass, u(90).value]).toEqual([true, '90.0%']);
  });
  it('D: the exact ratio sim / loop with sim = damage / fights / 4, gated from L3, reported at L1', () => {
    for (const [level, gated] of [[3, true], [1, false]] as const) {
      const loop = engineLoop('fighter', benchSetup(WORLD, 'dummy-melee', 'fighter', level)).total;
      const o = opts(['fighter'], [level], ['dummy-melee']);
      // Two fights; their sum over 2 fights x 4 rounds is 0.79 and 0.81 of the loop.
      for (const [f, pass] of [[0.79, false], [0.81, true]] as const) {
        const dmg = f * loop * 8;
        const r = one(o, [res('dummy-melee', 'fighter', level, 'base', [row({ dummyDmg2to5: dmg / 2 }), row({ dummyDmg2to5: dmg / 2 })])]);
        expect(r.D.value, `L${level} ${f}`).toBe(f.toFixed(2));
        expect(r.D.reason).toContain(`sim DPR ${(dmg / 2 / 4).toFixed(2)}`);
        expect(r.D.pass, `L${level} ${f}`).toBe(gated ? pass : null);
      }
    }
  });
  it('F: needs both Holm p < 0.05 and +5 points; one family per level', () => {
    // n 50 pairs. a: diff exactly 4 points (p 0); b: 6 points but noisy (p about 0.33); c: 10 points (p 0).
    const pairs = (cls: PickClass, level: number, d: (i: number) => number) => [
      res('party', cls, level, 'base', times(50, () => row({ foeHpRemovedPermille: 600 }))),
      res('party', cls, level, 'removed', times(50, (i) => row({ foeHpRemovedPermille: 600 - d(i) }))),
    ];
    const o = opts(['fighter', 'monk', 'wizard'], [3], ['party']);
    const rows = evaluate(WORLD, o, [...pairs('fighter', 3, () => 40), ...pairs('monk', 3, (i) => (i % 2 ? 1000 : -880)), ...pairs('wizard', 3, () => 100)]);
    const by = Object.fromEntries(rows.map((r) => [r.cls, r]));
    expect([by.fighter!.fDiff, by.fighter!.F.pass]).toEqual([4, false]);
    expect(by.monk!.fDiff).toBeCloseTo(6, 9);
    expect(by.monk!.fP!).toBeGreaterThan(0.05);
    expect(by.monk!.F.pass).toBe(false);
    expect([by.wizard!.fDiff, by.wizard!.F.pass]).toEqual([10, true]);
    // Two levels, one class each, raw p in (0.025, 0.05): passes per level, would fail as one family of 2.
    const mid = (i: number) => 60 + (i % 2 ? 226 : -226);
    const p = pairedDiff(Array.from({ length: 50 }, () => 600), Array.from({ length: 50 }, (_, i) => 600 - mid(i))).p;
    expect(p).toBeGreaterThan(0.025);
    expect(p).toBeLessThan(0.05);
    const two = evaluate(WORLD, opts(['fighter'], [3, 5], ['party']), [...pairs('fighter', 3, mid), ...pairs('fighter', 5, mid)]);
    for (const r of two) {
      expect(r.F.pass, `L${r.level}`).toBe(true);
      expect(r.F.reason).toContain(`over 1 classes at L${r.level}`);
    }
  });
  it('W: FLAG only below half the class median, and only at L1-5', () => {
    const wins = [0.9, 0.8, 0.6, 0.5, 0.29];
    const classes: PickClass[] = ['fighter', 'monk', 'wizard', 'cleric', 'rogue'];
    for (const level of [3, 6]) {
      const rows = evaluate(WORLD, opts(classes, [level], ['party']), classes.map((c, i) => res('party', c, level, 'base', times(100, (k) => row({ outcome: k < wins[i]! * 100 ? 'win' : 'loss' })))));
      const flagged = rows.filter((r) => r.W.reason.includes('FLAG')).map((r) => r.cls);
      expect(flagged, `L${level}`).toEqual(level <= 5 ? ['rogue'] : []);
      expect(rows.find((r) => r.cls === 'rogue')!.W.pass).toBeNull();
    }
  });
});

describe('review R4: a cantrip loop is read on the cantrip rounds, so slot spells can\'t carry D', () => {
  const o = opts(['sorcerer'], [5], ['dummy-range']);
  const loop = engineLoop('sorcerer', benchSetup(WORLD, 'dummy-range', 'sorcerer', 5));
  it('the sorcerer\'s loop is a cantrip', () => expect(loop.kind).toBe('cantrip'));
  it('big leveled damage in 2 of 4 rounds and nothing in the cantrip rounds is D 0, not a pass', () => {
    const r = one(o, [res('dummy-range', 'sorcerer', 5, 'base', times(10, () => row({ dummyDmg2to5: 100, cantripRounds: 2, cantripRoundDmg: 0 })))]);
    expect([r.D.pass, r.D.value]).toEqual([false, '0.00']);
    expect(r.D.reason).toContain('cantrip reading: 20 of 40 window rounds');
  });
  it('the cantrip rounds\' damage over the cantrip rounds, against the cantrip loop', () => {
    const r = one(o, [res('dummy-range', 'sorcerer', 5, 'base', times(10, () => row({ dummyDmg2to5: 100, cantripRounds: 2, cantripRoundDmg: 2 * loop.total })))]);
    expect([r.D.pass, r.D.value]).toEqual([true, '1.00']);
  });
  it('no cantrip round at all reads FAIL n/a from L3', () => {
    const r = one(o, [res('dummy-range', 'sorcerer', 5, 'base', times(10, () => row({ dummyDmg2to5: 100, cantripRounds: 0 })))]);
    expect([r.D.pass, r.D.value]).toEqual([false, 'n/a']);
  });
  it('the trace leaves leveled-spell damage and leveled-cast rounds out of the cantrip reading', () => {
    const r = runTask(WORLD, { bench: 'dummy-range', cls: 'sorcerer', level: 5, arm: 'base', from: 0, to: 10 });
    expect(r.error).toBeNull();
    for (const f of r.rows) {
      expect(f.cantripRounds).toBeLessThanOrEqual(4);
      expect(f.cantripRoundDmg).toBeLessThanOrEqual(f.dummyDmg2to5);
    }
    expect(r.rows.some((f) => f.cantripRounds < 4)).toBe(true); // it does cast leveled spells in the window
  });
});

describe('review T3: TraceSink counts what the frozen H and U gates read, from events', () => {
  const base = (k: string, round: number, o: Record<string, unknown>) => ({ k, seq: 0, round, turnOf: -1, cause: -1, ...o }) as never;
  it('item decisions, Dodges on its own turn, attacks, crits, hit turns, casts, first rounds, uptime and leveled damage', () => {
    const s = new TraceSink([0], [0, 1], 1, ['srd:barbarian/rage']);
    const ev = [
      base('turnStart', 1, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('decided', 1, { who: 0, at: 0, dk: 'turn', key: 'item:draw:srd:longsword', by: 'greedy' }),
      base('decided', 1, { who: 0, at: 0, dk: 'turn', key: 'attack:x', by: 'greedy' }),
      base('act', 1, { who: 0, via: 'srd:barbarian/rage', name: 'Rage' }),
      base('fxStart', 1, { fx: 7, via: 'srd:barbarian/rage/raging', name: 'Rage', owner: 0, bearer: 0, parent: -1, conc: false }),
      base('attack', 1, { att: 0, tgt: 1, hit: true, crit: true }),
      base('turnEnd', 1, { who: 0 }),
      base('turnStart', 1, { who: 1, cell: 0, hp: 10, moveFt: 30 }),
      base('act', 1, { who: 0, via: 'core:dodge', name: 'Dodge' }), // not its turn: not a Dodged turn
      base('turnEnd', 1, { who: 1 }),
      base('turnStart', 2, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('act', 2, { who: 0, via: 'core:dodge', name: 'Dodge' }),
      base('cast', 2, { who: 0, via: 'srd:shatter', name: 'Shatter', lvl: 2, free: null, left: 1 }),
      base('damage', 2, { src: 0, tgt: 1, via: 'srd:shatter', dealt: 7 }),
      base('damage', 2, { src: 0, tgt: 1, via: 'srd:fire-bolt', dealt: 3 }),
      base('turnEnd', 2, { who: 0 }),
      base('fxEnd', 2, { fx: 7, via: 'srd:barbarian/rage/raging', name: 'Rage', owner: 0, bearer: 0, why: 'expired' }),
      base('turnStart', 3, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('attack', 3, { att: 0, tgt: 1, hit: false, crit: false }),
      base('fightEnd', 3, { outcome: { k: 'stalemate', round: 3, tpk: false }, flagsUsed: [] }),
    ];
    for (const e of ev) s.emit(e);
    const t = s.units.get(0)!;
    expect(t.itemDecisions).toBe(1);
    expect([t.turnsUp, t.dodges, t.dodgeSeq]).toEqual([3, 1, [0, 1, 0]]);
    expect([t.attacks, t.crits, t.hitTurns]).toEqual([2, 1, 1]);
    expect([t.casts, t.leveledCasts, t.firstCastRound.get('srd:shatter'), t.firstActRound.get('srd:barbarian/rage')]).toEqual([1, 1, 2, 1]);
    expect([t.turnsAfterR1, t.upTurnsAfterR1]).toEqual([2, 1]); // round 2 started raging, round 3 didn't
    expect([t.dealtFocus[2], t.dealtFocusLeveled[2], t.leveledRounds[2]]).toEqual([10, 7, 1]);
  });
});

describe('review T4: the bench and smoke pipelines themselves fail closed on a private name in a generated text', () => {
  const name = NON_SRD_NAMES[0]!;
  const taint = <T extends { id: string; text: string }>(cs: readonly T[]): T[] => cs.map((c) => (c.id === 'test:smoke-fighter-1' ? { ...c, text: `${c.text}# ${name}\n` } : c));
  it('benchWorld throws', () => {
    expect(() => benchWorld(undefined, taint)).toThrow(/bench corpus: private-content scan failed closed/);
  });
});

// ---------------------------------------------------------------------------------------------
// C0 review, second round: C0-BENCH-M1 (casters' focus), R1 (Savage Attacker in the book DPR),
// C0-T1..T7 (verdict and trace boundaries). R2, R3 and T8 are in smoke-classes.test.ts.

describe('review C0-BENCH-M1: every curated caster carries its PDF kit focus, so its Material core spells are castable', () => {
  it('each full caster (and the cleric, paladin and ranger) carries a focus for its own list, cited', () => {
    for (const c of ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'] as const) {
      const f = CURATED[c].focus;
      expect(f, c).toBeDefined();
      expect(f!.focusFor, c).toEqual([c]);
      expect(f!.cite, c).toMatch(/srd-raw\.txt:\d+/);
      const tpl = tplOf(c, 5);
      expect(tpl.items.some((it) => it.kind === 'focus' && it.focusFor.includes(c)), c).toBe(true);
    }
  });
  it('the wizard, sorcerer and druid start holding the focus with a hand free: Fireball and Moonbeam (m: focus) and their Somatic cantrips are castable at fight start, and the F arm removes the core spell', () => {
    for (const [cls, level, spell] of [['wizard', 5, 'srd:fireball'], ['sorcerer', 5, 'srd:fireball'], ['druid', 5, 'srd:moonbeam'], ['wizard', 3, 'srd:shatter']] as const) {
      const setup = benchSetup(WORLD, 'party', cls, level);
      const pc = setup.seats.findIndex((s) => s.seat === 'pc1');
      const tpl = setup.seats[pc]!.tpl;
      const e = tpl.spells.find((x) => x.spell.id === spell)!;
      expect(e.spell.m, spell).toBe('focus');
      const cx = createContext(setup, 0, 0, makeDeciders(setup), null);
      expect(componentsOk(cx.st, cx.st.units[pc]!, e, null), `${cls} ${level} ${spell}`).toBe(true);
      expect([...removalSet(cls, tpl).spells], `${cls} ${level}`).toEqual([spell]);
      // ... and with a hand free, the Somatic-only cantrips stay castable too (a focus hand makes
      // Somatic components only for a Material spell: focusHandSomatic strict).
      const cantrip = tpl.spells.find((x) => x.spell.id === (cls === 'druid' ? 'srd:produce-flame' : 'srd:fire-bolt'))!;
      expect([cantrip.spell.s, cantrip.spell.m], cantrip.spell.id).toEqual([true, 'none']);
      expect(componentsOk(cx.st, cx.st.units[pc]!, cantrip, null), `${cls} ${level} ${cantrip.spell.id}`).toBe(true);
    }
  });
  it('removalSet picks the best core spell the build can supply: without a focus or pouch the wizard\'s is Fire Bolt, not Fireball', () => {
    const tpl = tplOf('wizard', 5);
    const bare = { ...tpl, items: tpl.items.filter((it) => it.kind !== 'focus') };
    expect(materialSupplied(bare, tpl.spells.find((x) => x.spell.id === 'srd:fireball')!)).toBe(false);
    expect(materialSupplied(bare, tpl.spells.find((x) => x.spell.id === 'srd:fire-bolt')!)).toBe(true);
    expect([...removalSet('wizard', bare).spells]).toEqual(['srd:fire-bolt']);
    expect([...removalSet('wizard', tpl).spells]).toEqual(['srd:fireball']);
  });
  it('the base arm counts the turns a removed item was legal (Fireball for the L5 sorcerer), and the count changes no fight', () => {
    const r = runTask(WORLD, { bench: 'party', cls: 'sorcerer', level: 5, arm: 'base', from: 0, to: 4 });
    expect(r.error).toBeNull();
    expect(r.rows.reduce((a, f) => a + f.coreLegalTurns, 0)).toBeGreaterThan(0);
    const setup = benchSetup(WORLD, 'party', 'sorcerer', 5);
    const pc = setup.seats.findIndex((s) => s.seat === 'pc1');
    const tpl = setup.seats[pc]!.tpl;
    const rm = removalSet('sorcerer', tpl);
    for (let run = 0; run < 3; run++) {
      const a = runFight(setup, 14, run, makeDeciders(setup), null);
      const ds = makeDeciders(setup);
      const c = new CountRemovable(ds[pc]!, tpl, rm.features, rm.spells);
      ds[pc] = c;
      expect(runFight(setup, 14, run, ds, null).stateHash, `run ${run}`).toBe(a.stateHash);
    }
  });
  it('F reads FAIL n/a "core never legal" when no base-arm turn offered the removed item, and leaves the Holm family', () => {
    const pairs = (cls: PickClass, legal: number) => [
      res('party', cls, 5, 'base', times(50, () => row({ foeHpRemovedPermille: 600, coreLegalTurns: legal }))),
      res('party', cls, 5, 'removed', times(50, () => row({ foeHpRemovedPermille: 500 }))),
    ];
    const rows = evaluate(WORLD, opts(['wizard', 'sorcerer'], [5], ['party']), [...pairs('wizard', 0), ...pairs('sorcerer', 1)]);
    const wiz = rows.find((r) => r.cls === 'wizard')!;
    expect([wiz.F.pass, wiz.F.value]).toEqual([false, 'n/a']);
    expect(wiz.F.reason).toContain('core never legal: removed fireball was never a legal choice in 50 base-arm party fights');
    const sor = rows.find((r) => r.cls === 'sorcerer')!;
    expect(sor.F.pass).toBe(true);
    expect(sor.F.reason).toContain('over 1 classes at L5');
  });
});

describe('review R1: the book DPR carries Savage Attacker for the Soldier builds (srd-raw.txt:19494, 20063-20069)', () => {
  it('E[best of two] is exact: 1d8 5.8125, 1d12 1222/144, 2d8 against E[2d8] 9', () => {
    expect(bestOfTwoMean(1, 8)).toBeCloseTo(5.8125, 12);
    expect(bestOfTwoMean(1, 12)).toBeCloseTo(1222 / 144, 12);
    expect(diceMean(2, 8)).toBeCloseTo(9, 12);
    expect(bestOfTwoMean(2, 8)).toBeGreaterThan(9);
  });
  it('the Fighter row is its modeled loop plus Savage Attacker on the first hit of two (19-20 crits): written - modeled = 1.35 x (0.55 x 1.3125 + 0.10 x (E[best of two 2d8] - 9))', () => {
    const f = BOOK_DPR.find((b) => b.cls === 'fighter')!;
    expect(f.written - f.modeled).toBeCloseTo(1.35 * (0.55 * 1.3125 + 0.1 * (bestOfTwoMean(2, 8) - 9)), 9);
    expect(f.written - f.modeled).toBeCloseTo(savageAttackerEv(8, 2, 2), 12);
    expect(f.gap).toBe('Savage Attacker (narrative feat)');
  });
  it('the Barbarian row\'s gap is Savage Attacker alone since W1 (Greataxe 1d12, crit on 20); Rage Damage is in the modeled part: +2 on each of two hits at 13/20', () => {
    const b = BOOK_DPR.find((x) => x.cls === 'barbarian')!;
    expect(b.written - b.modeled).toBeCloseTo(1.35 * (0.6 * (1222 / 144 - 6.5) + 0.05 * (bestOfTwoMean(2, 12) - 13)), 9);
    expect(b.modeled - 2 * ((12 / 20) * (6.5 + 4) + (1 / 20) * (13 + 4))).toBeCloseTo(2 * (13 / 20) * 2, 12);
    expect(b.gap).toBe('Savage Attacker (narrative feat)');
  });
  it('the Rogue row is modeled whole since W1: Steady Aim\'s Advantage on the Rapier with 3d6 Sneak Attack, a crit doubling both dice', () => {
    const r = BOOK_DPR.find((x) => x.cls === 'rogue')!;
    expect(r.modeled).toBe(r.written);
    expect(r.gap).toBe('none');
    // Advantage at +7 vs AC 15: miss on both of 1-7, crit on either 20.
    expect(r.modeled).toBeCloseTo((1 - 0.35 ** 2 - (1 - 0.95 ** 2)) * 19 + (1 - 0.95 ** 2) * 34, 12);
  });
  it('every row whose curated build takes the Soldier background names Savage Attacker in its gap and cites it', () => {
    for (const b of BOOK_DPR) {
      if (CURATED[b.cls].background !== 'srd:soldier') continue;
      expect(b.gap, b.cls).toContain('Savage Attacker');
      expect(b.cites.join(' '), b.cls).toContain('20063-20069');
    }
  });
});

describe('second review, found while re-baselining: a leveled spell\'s zone damage stays out of the cantrip reading', () => {
  const base = (k: string, round: number, o: Record<string, unknown>) => ({ k, seq: 0, round, turnOf: -1, cause: -1, ...o }) as never;
  it('Moonbeam cast at level 2, then its beam (via srd:moonbeam/beam) on later rounds, counts as leveled damage; a cantrip never does', () => {
    const s = new TraceSink([0], [0, 1], 1);
    for (const e of [
      base('turnStart', 1, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('cast', 1, { who: 0, via: 'srd:moonbeam', name: 'Moonbeam', lvl: 2, free: null, left: 1 }),
      base('turnEnd', 1, { who: 0 }),
      base('turnStart', 2, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('damage', 2, { src: 0, tgt: 1, via: 'srd:moonbeam/beam', dealt: 11 }),
      base('damage', 2, { src: 0, tgt: 1, via: 'srd:starry-wisp', dealt: 4 }),
      base('turnEnd', 2, { who: 0 }),
    ]) s.emit(e);
    const t = s.units.get(0)!;
    expect([t.dealtFocus[2], t.dealtFocusLeveled[2], t.leveledRounds[2]]).toEqual([15, 11, undefined]);
  });
});

describe('step 7 row review: a round spent on a leveled spell\'s own action is not a cantrip round', () => {
  const base = (k: string, round: number, o: Record<string, unknown>) => ({ k, seq: 0, round, turnOf: -1, cause: -1, ...o }) as never;
  it('Move Moonbeam (act via srd:moonbeam/beam) after a level 2 cast marks the round leveled; a cantrip-only round stays unmarked', () => {
    const s = new TraceSink([0], [0, 1], 1);
    for (const e of [
      base('turnStart', 1, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('cast', 1, { who: 0, via: 'srd:moonbeam', name: 'Moonbeam', lvl: 2, free: null, left: 1 }),
      base('turnEnd', 1, { who: 0 }),
      base('turnStart', 2, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('act', 2, { who: 0, via: 'srd:moonbeam/beam', name: 'Move Moonbeam' }),
      base('damage', 2, { src: 0, tgt: 1, via: 'srd:moonbeam/beam', dealt: 11 }),
      base('turnEnd', 2, { who: 0 }),
      base('turnStart', 3, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
      base('act', 3, { who: 0, via: 'srd:produce-flame/hurl', name: 'Hurl Flame' }),
      base('damage', 3, { src: 0, tgt: 1, via: 'srd:produce-flame/hurl', dealt: 4 }),
      base('turnEnd', 3, { who: 0 }),
    ]) s.emit(e);
    const t = s.units.get(0)!;
    expect([t.leveledRounds[2], t.dealtFocusLeveled[2]]).toEqual([1, 11]);
    expect([t.leveledRounds[3], t.dealtFocus[3], t.dealtFocusLeveled[3]]).toEqual([undefined, 4, undefined]);
  });
});

describe('review C0-T1..T7: the verdict and trace boundaries', () => {
  it('T1: Holm across a family of 2 at one level fails two raw p in (0.025, 0.05) that would each pass alone, and prints the adjusted p', () => {
    const mid = (i: number) => 60 + (i % 2 ? 226 : -226);
    const pairs = (cls: PickClass) => [
      res('party', cls, 3, 'base', times(50, () => row({ foeHpRemovedPermille: 600 }))),
      res('party', cls, 3, 'removed', times(50, (i) => row({ foeHpRemovedPermille: 600 - mid(i) }))),
    ];
    const p = pairedDiff(Array.from({ length: 50 }, () => 600), Array.from({ length: 50 }, (_, i) => 600 - mid(i))).p;
    expect(p).toBeGreaterThan(0.025);
    expect(p).toBeLessThan(0.05);
    const rows = evaluate(WORLD, opts(['fighter', 'monk'], [3], ['party']), [...pairs('fighter'), ...pairs('monk')]);
    for (const r of rows) {
      expect(r.fP, r.cls).toBeCloseTo(p, 12);
      expect(r.F.pass, r.cls).toBe(false);
      expect(r.F.reason, r.cls).toContain(`Holm p ${(2 * p).toPrecision(3)} over 2 classes at L3`);
    }
  });
  it('T7: a diff of exactly +5 points (zero variance) passes F; +4.9 does not', () => {
    const pairs = (cls: PickClass, d: number) => [
      res('party', cls, 3, 'base', times(50, () => row({ foeHpRemovedPermille: 600 }))),
      res('party', cls, 3, 'removed', times(50, () => row({ foeHpRemovedPermille: 600 - d }))),
    ];
    const [a] = evaluate(WORLD, opts(['fighter'], [3], ['party']), pairs('fighter', 50));
    expect([a!.fDiff, a!.F.pass]).toEqual([5, true]);
    const [b] = evaluate(WORLD, opts(['fighter'], [3], ['party']), pairs('fighter', 49));
    expect(b!.F.pass).toBe(false);
  });
  it("T2 (stalemate-plan.md 4.3): a Dodge streak of 3 on a downed pc1 with no PC up and Dodging is the engine's downed-unrescued, not a dodge-loop", () => {
    const { st, sink, pc1, cleric, engineRes } = splitScene();
    Object.assign(st.units[pc1]!, { hp: 0, life: 'down', dodgeRun: 3 });
    sink.units.get(pc1)!.dodgeSeq.push(1, 1, 1);
    st.units[cleric]!.res.fill(0);
    sink.inspect(st);
    expect(stalemateCauseOf(st)).toBe('downed-unrescued');
    expect(stalemateCause(engineRes(), sink)).toBe('downed-heals-spent');
  });
  it("the engine's stalemate family and the bench's read the same frozen numbers, and the bench's cause is the engine's (downed kinds folded back) on fights that end at the cap", () => {
    expect(STALEMATE_DODGE_STREAK).toBe(THRESHOLDS.dodgeStreak);
    expect(STALEMATE_NO_DAMAGE_ROUNDS).toBe(THRESHOLDS.noDamageRoundsK);
    const fold = (c: string | null) => (c?.startsWith('downed-') ? 'downed-unrescued' : c);
    let stale = 0;
    for (const [bench, cls, rounds] of [['duel', 'fighter', 3], ['party', 'wizard', 4]] as const) {
      const setup = benchSetup(WORLD, bench, cls, 3);
      const capped = { ...setup, knobs: { ...setup.knobs, maxRounds: rounds } };
      const team = capped.seats.map((x) => x.team);
      const pc = capped.seats.findIndex((x) => x.seat === 'pc1');
      for (let run = 0; run < 30; run++) {
        const sink = new TraceSink([pc], team, -1);
        const res = runFight(capped, 5, run, makeDeciders(capped), sink, { inspect: sink.inspect });
        if (res.outcome.k !== 'stalemate') continue;
        stale++;
        expect(fold(stalemateCause(res, sink))).toBe(res.stalemateCause);
      }
    }
    expect(stale).toBeGreaterThan(0);
  });
  it("T3: the no-damage window is the engine's (the last K = 3 rounds of dmgRolled; greedy-dodge.test.ts pins it), not the sink's damage count", () => {
    expect(THRESHOLDS.noDamageRoundsK).toBe(3);
    const s = new TraceSink([0], [0, 1], -1);
    s.anyDamage[10] = 5; // the sink saw damage in the last round, the engine says none was rolled
    expect(stalemateCause({ outcome: { k: 'stalemate', round: 10, tpk: false }, life: ['up', 'up'], stalemateCause: 'no-damage' }, s)).toBe('no-damage');
  });
  it('T4: a caster\'s fight with only a leveled non-damaging spell (Shield of Faith) counts for U; with nothing cast it does not', () => {
    const tpl = tplOf('cleric', 5);
    expect(coreUsedIn('cleric', tpl, trace({ leveledCasts: 1, spells: new Map([['srd:shield-of-faith', 1]]) }))).toBe(true);
    expect(coreUsedIn('cleric', tpl, trace({}))).toBe(false);
  });
  it('T5: with both duel and party run, U reads the party bench', () => {
    const o = opts(['fighter'], [3], ['duel', 'party']);
    const r = one(o, [res('duel', 'fighter', 3, 'base', times(100, (i) => row({ coreUsed: i < 50 }))), res('party', 'fighter', 3, 'base', times(100, (i) => row({ coreUsed: i < 95 })))]);
    expect([r.U.pass, r.U.value]).toEqual([true, '95.0%']);
    expect(r.U.reason).toContain('of party fights');
  });
  it('T6: with an even number of classes the W median is the mean of the two middle rates', () => {
    const wins = [0.9, 0.8, 0.3, 0.2];
    const classes: PickClass[] = ['fighter', 'monk', 'wizard', 'cleric'];
    const rows = evaluate(WORLD, opts(classes, [3], ['party']), classes.map((c, i) => res('party', c, 3, 'base', times(100, (k) => row({ outcome: k < wins[i]! * 100 ? 'win' : 'loss' })))));
    expect(rows.filter((r) => r.W.reason.includes('FLAG')).map((r) => r.cls)).toEqual(['cleric']);
    expect(rows.find((r) => r.cls === 'cleric')!.W.reason).toContain('class median (55.0%)');
  });
});

/** A party fight's state at the cap (fighter L5: pc1 fighter, rogue, cleric, wizard vs the L5 group), with a trace sink. */
function splitScene() {
  const setup = benchSetup(WORLD, 'party', 'fighter', 5);
  const team = setup.seats.map((x) => x.team);
  const pc1 = setup.seats.findIndex((x) => x.seat === 'pc1');
  const cleric = setup.seats.findIndex((x) => x.team === 0 && x.tpl.id.includes('cleric'));
  const wizard = setup.seats.findIndex((x) => x.team === 0 && x.tpl.id.includes('wizard'));
  const st: GameState = createContext(setup, 14, 0, makeDeciders(setup), null).st;
  st.outcome = { k: 'stalemate', round: 10, tpk: false };
  const sink = new TraceSink([pc1], team, -1);
  const engineRes = () => ({ outcome: st.outcome!, life: st.units.map((u) => u.life), stalemateCause: stalemateCauseOf(st) });
  const ev = (k: 'turnStart' | 'down', who: number, seq: number, hp = 20) => sink.emit({ k, who, seq, round: 9, turnOf: who, cause: -1, cell: 0, hp, moveFt: 30 } as never);
  return { setup, team, pc1, cleric, wizard, st, sink, engineRes, ev };
}

describe("stalemate causes: the engine's, with downed-unrescued split three ways (stalemate-plan.md 4.3)", () => {
  it('the cause list is the engine\'s four with downed-unrescued replaced by its three kinds, and every zero record has them all', () => {
    expect(BENCH_CAUSES.filter((c) => !c.startsWith('downed-'))).toEqual(STALEMATE_CAUSES.filter((c) => c !== 'downed-unrescued'));
    expect(BENCH_CAUSES.filter((c) => c.startsWith('downed-'))).toEqual(['downed-heals-spent', 'downed-fell-too-late', 'downed-rescue-missed']);
    expect(Object.keys(noCauses())).toEqual([...BENCH_CAUSES]);
  });
  it("the bench's stalemate cause is the engine's: a downed pc1 with no streak, and another PC up on a Dodge streak, is a dodge-loop (the watched-seat rule said downed-unrescued)", () => {
    const { st, sink, pc1, wizard, engineRes } = splitScene();
    Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
    sink.units.get(pc1)!.dodgeSeq.push(1, 0);
    st.units[wizard]!.dodgeRun = 3;
    sink.inspect(st);
    expect(stalemateCauseOf(st)).toBe('dodge-loop');
    expect(stalemateCause(engineRes(), sink)).toBe('dodge-loop');
    // ... and with a streak on the downed pc1 as well (the plan's case), still the engine's dodge-loop.
    sink.units.get(pc1)!.dodgeSeq.push(1, 1, 1);
    expect(stalemateCause(engineRes(), sink)).toBe('dodge-loop');
  });
  it('holdsHeal: the cleric with slots holds a heal for others, and with only a higher slot left (upcast); spent, it holds none; Second Wind (self only) is not one', () => {
    const { st, cleric, pc1 } = splitScene();
    const c = st.units[cleric]!;
    expect(holdsHeal(c)).toBe(true);
    const lvl1 = c.tpl.spells.filter((e) => e.spell.level === 1 && e.slotted).length;
    expect(lvl1).toBeGreaterThan(0);
    expect(c.res[1]).toBeGreaterThan(0);
    c.res[0] = 0;
    expect(holdsHeal(c)).toBe(true); // a level 2 slot still casts Cure Wounds
    c.res.fill(0);
    expect(holdsHeal(c)).toBe(false);
    expect(st.units[pc1]!.tpl.features.some((f) => f.activate?.self)).toBe(true);
    expect(holdsHeal(st.units[pc1]!)).toBe(false);
  });
  it('downed splits into heals spent, fell too late and rescue missed, one case each (a healer with a heal left and no turn since the fall fell too late, not a miss)', () => {
    // Heals spent: the cleric is up but has no use left (and has had turns since the fall).
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('down', pc1, 100);
      ev('turnStart', cleric, 110);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      st.units[cleric]!.res.fill(0);
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-heals-spent');
    }
    // Heals spent: the only healer is down too.
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('turnStart', cleric, 90);
      ev('down', pc1, 100);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      Object.assign(st.units[cleric]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-heals-spent');
    }
    // Fell too late: the cleric holds a heal but its last turn began before the fall.
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('turnStart', cleric, 90);
      ev('down', pc1, 100);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-fell-too-late');
    }
    // Rescue missed: the cleric holds a heal and had a turn after the fall.
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('turnStart', cleric, 90);
      ev('down', pc1, 100);
      ev('turnStart', cleric, 110);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-rescue-missed');
    }
  });
  it("only a turn begun up counts, and only since the downed member's latest fall", () => {
    // The cleric's turn after the fall began at 0 HP (it was down then, revived since): fell too late.
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('turnStart', cleric, 90);
      ev('down', pc1, 100);
      ev('turnStart', cleric, 110, 0);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-fell-too-late');
    }
    // pc1 fell, the cleric had a turn, pc1 was revived and fell again: only the latest fall counts.
    {
      const { st, sink, pc1, cleric, engineRes, ev } = splitScene();
      ev('down', pc1, 100);
      ev('turnStart', cleric, 110);
      ev('down', pc1, 120);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-fell-too-late');
    }
    // Two down: the cleric had a turn after the first one's fall but not the second's: a rescue was missed.
    {
      const { st, sink, pc1, cleric, wizard, engineRes, ev } = splitScene();
      ev('down', pc1, 100);
      ev('turnStart', cleric, 110);
      ev('down', wizard, 120);
      Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
      Object.assign(st.units[wizard]!, { hp: 0, life: 'down' });
      sink.inspect(st);
      expect(stalemateCause(engineRes(), sink)).toBe('downed-rescue-missed');
    }
    // A stable member isn't downed-unrescued (the engine's rule), so no split.
    expect(downedKind(['up', 'stable'] as Life[], [0, 0], [-1, 5], [9, -1], () => true)).toBe('downed-fell-too-late');
  });
  it('the downed split needs the finished state: a fight run without { inspect: sink.inspect } throws, never guesses', () => {
    const { st, sink, pc1, engineRes } = splitScene();
    Object.assign(st.units[pc1]!, { hp: 0, life: 'down' });
    expect(() => stalemateCause(engineRes(), sink)).toThrow(/inspect/);
  });
  it('H counts every kind as stalemates: 6 of 100 party fights of any one downed kind fail H, 5 pass', () => {
    for (const kind of ['downed-heals-spent', 'downed-fell-too-late', 'downed-rescue-missed'] as const) {
      for (const [k, pass] of [[6, false], [5, true]] as const) {
        const o = opts(['fighter'], [3], ['party']);
        const r = one(o, [res('party', 'fighter', 3, 'base', times(100, (i) => row(i < k ? { outcome: 'stalemate', cause: kind, rounds: 15 } : {}))), res('party', 'fighter', 3, 'removed', times(100, () => row()))]);
        expect(r.H.pass, `${kind} ${k}`).toBe(pass);
        expect(r.perBench.party!.stalemates, kind).toBe(k);
        expect(r.perBench.party!.causes[kind], kind).toBe(k);
        if (!pass) expect(r.H.reason, kind).toContain(`${kind} ${k}`);
      }
    }
    expect(causeText({ ...noCauses(), 'downed-rescue-missed': 2, 'round-cap': 1 })).toBe('downed-rescue-missed 2, round-cap 1');
  });
  it('every other bench metric is unchanged: the run with the end-state hook decides exactly as without it, and each row\'s outcome and rounds are the fight\'s; runTask hands the hook over (a downed stalemate gets its kind, not an error)', () => {
    const setup = benchSetup(WORLD, 'party', 'cleric', 5);
    const r = runTask(WORLD, { bench: 'party', cls: 'cleric', level: 5, arm: 'base', from: 0, to: 12 });
    expect(r.error).toBeNull();
    expect(r.rows.some((x) => x.cause?.startsWith('downed-')), 'cleric 5 party runs 0-11 hold a downed stalemate (run 2 at HEAD); pick another range if the AI moves it').toBe(true);
    for (let run = 0; run < 12; run++) {
      const plain = runFight(setup, 14, run, makeDeciders(setup), null);
      const sink = new TraceSink([0, 1, 2, 3], setup.seats.map((x) => x.team), -1);
      const hooked = runFight(setup, 14, run, makeDeciders(setup), sink, { inspect: sink.inspect });
      expect(hooked.stateHash, `run ${run}`).toBe(plain.stateHash);
      expect(sink.endState, `run ${run}`).not.toBeNull();
      expect([r.rows[run]!.outcome, r.rows[run]!.rounds], `run ${run}`).toEqual([plain.outcome.k, plain.outcome.round]);
    }
  });
  it('the bench caps the party at 15 rounds and leaves the duel and the range dummy at 10, the melee dummy at 5 (stalemate-plan.md 6 a, b)', () => {
    expect(benchSetup(WORLD, 'party', 'fighter', 5).knobs.maxRounds).toBe(15);
    expect(benchSetup(WORLD, 'duel', 'fighter', 5).knobs.maxRounds).toBe(10);
    expect(benchSetup(WORLD, 'dummy-range', 'fighter', 5).knobs.maxRounds).toBe(10);
    expect(benchSetup(WORLD, 'dummy-melee', 'fighter', 5).knobs.maxRounds).toBe(5);
  });
});

describe("coverage 8'b G7 on the curated kits", () => {
  const WORLD_G7 = benchWorld(join(import.meta.dirname, '..', '..'));
  const attacksOf = (bench: Bench, cls: string, level: number, n: number) => {
    const setup = benchSetup(WORLD_G7, bench, cls, level);
    const pc = setup.seats.findIndex((s) => s.tpl.id.includes(`smoke-${cls}`));
    const keys = new Map<string, number>();
    const sink = { emit: (e: { k: string; dk?: string; who?: number; key?: string }) => {
      if (e.k === 'decided' && e.dk === 'turn' && e.who === pc && e.key) keys.set(e.key.replace(/>.*/, ''), (keys.get(e.key.replace(/>.*/, '')) ?? 0) + 1);
    } };
    for (let run = 0; run < n; run++) runFight(setup, 11, run, makeDeciders(setup), sink as never);
    return keys;
  };

  it('the Barbarian at L1 and L3 keeps swinging its Greataxe at a dummy in reach: no Handaxes over it, and no stow-and-draw each turn (C0 carried: it dealt 5.6 against 6.0 DPR)', () => {
    for (const level of [1, 3]) {
      const k = attacksOf('dummy-melee', 'barbarian', level, 4);
      expect(k.get('attack:greataxe'), `L${level}`).toBeGreaterThan(0);
      expect(k.get('attack:handaxe') ?? 0, `L${level}`).toBe(0);
      expect(k.get('item:stow/handaxe') ?? 0, `L${level}`).toBe(0);
    }
  });
});

describe.skipIf(!SLOW)('test:slow subset (m9): one class per wave at L5, dummies and party, on workers, <= 60 s', () => {
  it('runs with no errors and prints every row', async () => {
    const t0 = performance.now();
    const rows = evaluate(WORLD, QUICK, await runOnWorkers(planTasks(QUICK), 8));
    const secs = (performance.now() - t0) / 1000;
    expect(rows).toHaveLength(QUICK.classes.length);
    for (const r of rows) expect(r.errors, `${r.cls} ${r.level}`).toEqual([]);
    const text = renderBench(WORLD, QUICK, rows);
    for (const c of QUICK.classes) expect(text).toMatch(new RegExp(`^${c} +5 `, 'm'));
    expect(secs).toBeLessThan(60); // coverage.md m9 / accept-list amendment: the test:slow subset <= 60 s (about 27 s measured at load average 66)
  }, 300_000);
});

describe('coverage step 7.3: the curated area picks and the per-spell cast count', () => {
  it('the reviewed picks are in CURATED.prepared, behind the CORE spells and heals', () => {
    const want: Partial<Record<PickClass, string[]>> = {
      bard: ['srd:thunderwave'],
      druid: ['srd:thunderwave', 'srd:entangle'],
      ranger: ['srd:entangle'],
      sorcerer: ['srd:burning-hands', 'srd:thunderwave'],
      wizard: ['srd:burning-hands', 'srd:thunderwave'],
    };
    const kept = ['srd:healing-word', 'srd:cure-wounds', 'srd:moonbeam', 'srd:fireball', 'srd:shatter'];
    for (const cls of PICK_CLASSES) {
      const list = CURATED[cls].prepared ?? [];
      for (const id of ['srd:burning-hands', 'srd:thunderwave', 'srd:entangle']) expect(list.includes(id), `${cls} ${id}`).toBe(want[cls]?.includes(id) ?? false);
      for (const id of want[cls] ?? []) for (const k of kept) if (list.includes(k)) expect(list.indexOf(k), `${cls}: ${k} ahead of ${id}`).toBeLessThan(list.indexOf(id));
    }
  });
  it('the core table names no area pick', () => {
    expect(JSON.stringify(CORE)).not.toMatch(/burning-hands|thunderwave|entangle|faerie-fire|lightning-bolt|cone-of-cold/);
  });
  it('a bench row counts casts per reported spell, and the report lists a holder', () => {
    const tiny: BenchOptions = { classes: ['sorcerer'], levels: [1], benches: ['dummy-melee'], n: { 'dummy-melee': 6, 'dummy-range': 0, duel: 0, party: 0 }, f: false, fLevels: [], partyWOnly: 0, chunk: 6 };
    const results = runInProcess(WORLD, planTasks(tiny));
    const rows = results.flatMap((r) => r.rows);
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.spellCasts).toHaveLength(REPORTED_SPELLS.length);
    expect(rows.reduce((s, r) => s + r.spellCasts.reduce((a, b) => a + b, 0), 0)).toBeGreaterThan(0);
    const text = renderSpellCasts(WORLD, tiny, evaluate(WORLD, tiny, results));
    expect(text.join('\n')).toMatch(/sorcerer 1 dummy-melee: burning-hands \d+\.\d\d, sleep \d+\.\d\d/);
  });
});

// ---------------------------------------------------------------------------------------------
// Coverage W1 (docs/design/w1-plan.md section 4.1): the Rogue's U reader, the Barbarian's uptime by
// effect prefix, the rider F arm and the Rage Damage share, on synthetic traces and decisions.

describe('W1 4.1: the Rogue U reader counts qualifying turns (offered), deduped per turn, Opportunity Attack turns included', () => {
  /** A decider that answers from a script, and the decision points the engine would ask. */
  const scripted = (answers: number[]): Decider => ({ name: 'scripted', decide: () => answers.shift()! });
  const view = (turnIdx: number) => ({ me: 0, q: { turnIdx } }) as unknown as UnitView;
  const riderDp = (via: string): DecisionPoint =>
    ({ k: 'rider', who: 0, at: 0, round: 1, cause: -1, legal: { n: 2, items: [{ k: 'pass' }, { k: 'pick' }] }, keyOf: () => '', src: { via, target: 1 } }) as unknown as DecisionPoint;
  const SA = 'srd:rogue/sneak-attack';

  it('two offers on one turn count once, and the turn is taken if either was; a pass-only turn is offered, not taken; another feature\'s rider and a turn decision never count', () => {
    const q = new QualifyingTurns(scripted([0, 1, 0, 1, 1, 0]), new Set([SA]));
    expect(q.decide(view(4), riderDp(SA))).toBe(0); // turn 4: passed ...
    expect(q.decide(view(4), riderDp(SA))).toBe(1); // ... then taken on its second hit: one turn, taken
    expect(q.decide(view(5), riderDp(SA))).toBe(0); // turn 5: offered, passed
    expect(q.decide(view(6), riderDp('srd:monk/stunning-strike'))).toBe(1); // another feature's rider
    expect(q.decide(view(6), { ...riderDp(SA), k: 'turn' } as DecisionPoint)).toBe(1); // not a rider decision
    expect(q.decide(view(9), riderDp(SA))).toBe(0);
    expect([q.offered, q.taken]).toEqual([3, 1]);
  });

  it('an offer on another creature\'s turn (an Opportunity Attack: global, once in each turn) is its own qualifying turn', () => {
    const q = new QualifyingTurns(scripted([1, 1, 1]), new Set([SA]));
    q.decide(view(7), riderDp(SA)); // the Rogue's own turn
    q.decide(view(8), riderDp(SA)); // an Opportunity Attack on the next creature's turn
    q.decide(view(8), riderDp(SA)); // a second offer on that same turn can't count twice
    expect([q.offered, q.taken]).toEqual([2, 2]);
  });

  it('U is taken over offered at the frozen 60%: 59 of 100 fails, 60 passes; the reason prints the ungated share of hit turns that qualified', () => {
    const o = opts(['rogue'], [5], ['party']);
    const u = (taken: number) => one(o, [res('party', 'rogue', 5, 'base', times(10, () => row({ qualTurns: 10, qualTaken: 0, hitTurnsAll: 16 })).map((r, i) => ({ ...r, qualTaken: i < Math.floor(taken / 10) ? 10 : i === Math.floor(taken / 10) ? taken % 10 : 0 })))]).U;
    expect([u(59).pass, u(59).value]).toEqual([false, '59.0%']);
    expect([u(60).pass, u(60).value]).toEqual([true, '60.0%']);
    expect(u(60).reason).toContain('of 100 party turns it was offered on (taken on 60)');
    expect(u(60).reason).toContain('qualifying turns 100 of 160 hit turns (62.5%');
  });

  it('no qualifying turn at all reads FAIL n/a, never a pass', () => {
    const r = one(opts(['rogue'], [5], ['party']), [res('party', 'rogue', 5, 'base', times(20, () => row({ qualTurns: 0, qualTaken: 0, hitTurnsAll: 7 })))]);
    expect([r.U.pass, r.U.value]).toEqual([false, 'n/a']);
    expect(r.U.reason).toContain('no qualifying turn in 20 party fights');
  });

  it('the Rogue\'s core is modeled now (no notModeled), so it has an F arm, and the trace rows fold qualTurns, qualTaken and hitTurnsAll', () => {
    expect(CORE.rogue.core.every((c) => c.notModeled === undefined)).toBe(true);
    expect(CORE.barbarian.core.every((c) => c.notModeled === undefined)).toBe(true);
    expect(CORE.cleric.core.some((c) => c.notModeled !== undefined)).toBe(true); // Divine Spark waits for W1b
  });
});

describe('W1 4.1: the Barbarian\'s uptime matches its effects by the `<feature id>/` prefix', () => {
  const ev = (k: string, round: number, o: Record<string, unknown>) => ({ k, seq: 0, round, turnOf: -1, cause: -1, ...o }) as never;
  it('an effect of the feature (srd:barbarian/rage/raging) counts; the bare id, a sibling id sharing the text and another bearer don\'t', () => {
    const up = new Set(['srd:barbarian/rage']);
    expect(viaFromFeature('srd:barbarian/rage/raging', up)).toBe(true);
    expect(viaFromFeature('srd:barbarian/rage/rage-benefits', up)).toBe(true);
    expect(viaFromFeature('srd:barbarian/rage', up)).toBe(false);
    expect(viaFromFeature('srd:barbarian/rage-x/raging', up)).toBe(false);
    expect(viaFromFeature('srd:path-of-the-berserker/mindless-rage/mindless', up)).toBe(false);
    const run = (via: string, bearer: number) => {
      const s = new TraceSink([0], [0, 1], -1, ['srd:barbarian/rage']);
      for (const e of [
        ev('turnStart', 1, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
        ev('fxStart', 1, { fx: 3, via, name: 'Rage', owner: 0, bearer, parent: -1, conc: false }),
        ev('turnEnd', 1, { who: 0 }),
        ev('turnStart', 2, { who: 0, cell: 0, hp: 10, moveFt: 30 }),
        ev('turnEnd', 2, { who: 0 }),
      ]) s.emit(e);
      const t = s.units.get(0)!;
      return [t.turnsAfterR1, t.upTurnsAfterR1];
    };
    expect(run('srd:barbarian/rage/raging', 0)).toEqual([1, 1]);
    expect(run('srd:barbarian/rage', 0)).toEqual([1, 0]);
    expect(run('srd:barbarian/rage/raging', 1)).toEqual([1, 0]);
  });
});

describe('W1 4.1: the Rage Damage share of the dummy damage (reported, ungated)', () => {
  const ev = (k: string, round: number, o: Record<string, unknown>) => ({ k, seq: 0, round, turnOf: -1, cause: -1, ...o }) as never;
  it('credits the rider\'s value on the hit it rode (capped by what that hit dealt), never the Rage activation\'s act, nor a hit on another creature', () => {
    const s = new TraceSink([0], [0, 1, 1], 1, [], [{ via: 'srd:barbarian/rage', name: 'Rage Damage', value: 2 }]);
    for (const e of [
      ev('turnStart', 2, { who: 0, cell: 0, hp: 30, moveFt: 30 }),
      ev('act', 2, { who: 0, via: 'srd:barbarian/rage', name: 'Rage' }), // the activation: not the rider
      ev('attack', 2, { att: 0, tgt: 1, hit: true, crit: false }),
      ev('act', 2, { who: 0, via: 'srd:barbarian/rage', name: 'Rage Damage' }),
      ev('damage', 2, { src: 0, tgt: 1, via: 'srd:greataxe', dealt: 11 }),
      ev('attack', 2, { att: 0, tgt: 1, hit: false, crit: false }),
      ev('turnEnd', 2, { who: 0 }),
      ev('turnStart', 3, { who: 0, cell: 0, hp: 30, moveFt: 30 }),
      ev('attack', 3, { att: 0, tgt: 2, hit: true, crit: false }),
      ev('act', 3, { who: 0, via: 'srd:barbarian/rage', name: 'Rage Damage' }),
      ev('damage', 3, { src: 0, tgt: 2, via: 'srd:handaxe', dealt: 6 }), // another creature: not the dummy
      ev('attack', 3, { att: 0, tgt: 1, hit: true, crit: false }),
      ev('damage', 3, { src: 0, tgt: 1, via: 'srd:handaxe', dealt: 5 }), // no rider on this hit: the earlier one was spent
      ev('attack', 3, { att: 0, tgt: 1, hit: true, crit: false }),
      ev('act', 3, { who: 0, via: 'srd:barbarian/rage', name: 'Rage Damage' }),
      ev('damage', 3, { src: 0, tgt: 1, via: 'srd:handaxe', dealt: 1 }), // dealt less than the bonus: capped
      ev('turnEnd', 3, { who: 0 }),
    ]) s.emit(e);
    const t = s.units.get(0)!;
    expect([t.riderDealtFocus[2], t.riderDealtFocus[3]]).toEqual([2, 1]);
    expect([t.dealtFocus[2], t.dealtFocus[3]]).toEqual([11, 6]);
    expect(t.hitTurnsAll).toBe(2); // two turns with hits, however many hits
  });

  it('the D reason prints the share over rounds 2-5 for the Barbarian only, and says U carries the Rage check', () => {
    const loop = engineLoop('barbarian', benchSetup(WORLD, 'dummy-melee', 'barbarian', 5)).total;
    const r = one(opts(['barbarian'], [5], ['dummy-melee']), [res('dummy-melee', 'barbarian', 5, 'base', times(4, () => row({ dummyDmg2to5: loop * 4, shareDmg2to5: loop }))) ]);
    expect(r.D.reason).toContain('Rage Damage share of the dummy damage rounds 2-5: 25.0% (reported; U, not D, carries the Rage check)');
    const f = one(opts(['fighter'], [5], ['dummy-melee']), [res('dummy-melee', 'fighter', 5, 'base', times(4, () => row({ dummyDmg2to5: 40, shareDmg2to5: 10 })))]);
    expect(f.D.reason).not.toContain('share of the dummy damage');
  });

  it('shareRidersFor reads the rider\'s act name and value from the template, and gives nothing without it', () => {
    const tpl = tplOf('fighter', 5, 'dummy-melee');
    const fi = tpl.features.findIndex((f) => f.id === 'srd:fighter/second-wind');
    expect(fi).toBeGreaterThanOrEqual(0);
    expect(shareRidersFor('barbarian', tpl)).toEqual([]); // no Rage on a Fighter
    const flat = { roll: { k: 'const', v: 3 }, critExtra: null, type: -1, avg: 3, ifAdvantage: false, asAttack: true } as const;
    const rider: CompiledRider = { local: 'rage-damage', name: 'Rage Damage', feature: fi, on: 'hit', pool: -1, chooses: false, opts: [{ local: 'rage-damage', name: 'Rage Damage', extra: [flat as never], steps: [] }], auto: true };
    const fake = { ...tpl, features: tpl.features.map((f, i) => (i === fi ? { ...f, id: 'srd:barbarian/rage' } : f)), riders: [rider] } as CompiledTemplate;
    expect(riderIndex(fake, 'srd:barbarian/rage', 'rage-damage')).toBe(0);
    expect(shareRidersFor('barbarian', fake)).toEqual([{ via: 'srd:barbarian/rage', name: 'Rage Damage', value: 3 }]);
  });
});

describe('W1 4.1: the rider F arm seats a template compiled without the feature', () => {
  it('withoutFeatures drops the id from class levels (removing an emptied level), species and feat lists, and leaves every other file the same object', () => {
    const files = [
      { path: 'packs/x/classes/c.yaml', text: 'kind: class\nid: srd:c\nfeatures:\n  "1": [srd:c/a, srd:c/b]\n  "2": [srd:c/b]\n' },
      { path: 'packs/x/species/s.yaml', text: 'kind: species\nid: srd:s\nfeatures:\n  - srd:c/b\n  - { id: srd:s/t, level: 5 }\n' },
      { path: 'packs/x/features/c/b.yaml', text: 'kind: feature\nid: srd:c/b\n' }, // a feature file names itself: untouched
      { path: 'packs/x/classes/d.yaml', text: 'kind: class\nid: srd:d\nfeatures:\n  "1": [srd:d/a]\n' },
    ];
    const out = withoutFeatures(files, new Set(['srd:c/b']));
    expect(parse(out[0]!.text)).toEqual({ kind: 'class', id: 'srd:c', features: { 1: ['srd:c/a'] } });
    expect(parse(out[1]!.text)).toEqual({ kind: 'species', id: 'srd:s', features: [{ id: 'srd:s/t', level: 5 }] });
    expect(out[2]).toBe(files[2]);
    expect(out[3]).toBe(files[3]);
  });

  it('a template compiled without a feature lacks it and keeps everything else (the Fighter 5 without Second Wind; after W1.2, Tactical Shift\'s augment then finds no target and does nothing)', () => {
    const drop = new Set(['srd:fighter/second-wind']);
    const base = WORLD.content.get('test:smoke-fighter-5')!;
    const without = strippedContent(WORLD, drop).get('test:smoke-fighter-5')!;
    expect(base.features.some((f) => f.id === 'srd:fighter/second-wind')).toBe(true);
    expect(without.features.some((f) => f.id === 'srd:fighter/second-wind')).toBe(false);
    expect(without.features.map((f) => f.id)).toEqual(base.features.map((f) => f.id).filter((id) => id !== 'srd:fighter/second-wind'));
    expect([without.hpMax, without.ac, without.attacks.map((a) => a.id), without.riders?.length]).toEqual([base.hpMax, base.ac, base.attacks.map((a) => a.id), base.riders?.length]);
    expect(strippedContent(WORLD, drop)).toBe(strippedContent(WORLD, new Set(['srd:fighter/second-wind']))); // loaded once
  });

  it('removalSet puts a feature that is only riders in `riders` (a synthetic rider on the Rogue\'s feature), and an activation feature in `features`', () => {
    const tpl = tplOf('rogue', 5);
    const others = tpl.features.filter((f) => f.id !== 'srd:rogue/sneak-attack');
    const fi = others.length;
    const rider: CompiledRider = { local: 'sneak-attack', name: 'Sneak Attack', feature: fi, on: 'hit', pool: -1, chooses: false, opts: [{ local: 'sneak-attack', name: 'Sneak Attack', steps: [] }] };
    const sneak = { ...others[0]!, id: 'srd:rogue/sneak-attack', activate: null, more: undefined };
    const fake = { ...tpl, features: [...others, sneak], riders: [...(tpl.riders ?? []).filter((r) => tpl.features[r.feature]!.id !== 'srd:rogue/sneak-attack'), rider] } as CompiledTemplate;
    const rm = removalSet('rogue', fake);
    expect([[...rm.features], [...rm.riders], rm.what]).toEqual([[], ['srd:rogue/sneak-attack'], ['Sneak Attack']]);
    expect([...removalSet('fighter', tplOf('fighter', 5)).riders]).toEqual([]);
  });

  it('the base arm counts each offer of a removed rider (CountRemovable), and only a rider decision of that feature', () => {
    const tpl = tplOf('rogue', 5);
    const c = new CountRemovable({ name: 'x', decide: () => 0 }, tpl, new Set(), new Set(), new Set(['srd:rogue/sneak-attack']));
    const dp = (via: string, k = 'rider') => ({ k, src: { via }, legal: { n: 1, items: [{ k: 'pass' }] } }) as unknown as DecisionPoint;
    c.decide({} as UnitView, dp('srd:rogue/sneak-attack'));
    c.decide({} as UnitView, dp('srd:rogue/sneak-attack'));
    c.decide({} as UnitView, dp('core:mastery-rapier'));
    expect(c.legalTurns).toBe(2);
  });

  it('armSetup: the base arm and a decision-filter arm fight in the bench setup itself', () => {
    expect(armSetup(WORLD, 'party', 'fighter', 5, 'base')).toBe(benchSetup(WORLD, 'party', 'fighter', 5));
    expect(armSetup(WORLD, 'party', 'fighter', 5, 'removed')).toBe(benchSetup(WORLD, 'party', 'fighter', 5));
  });
});

// W1 review (finding 8): runTask's wiring of the W1 readers, on the real WORLD. Each test fails on
// its mutant of tools/bench-core.ts: armSetup returning the bench setup for a rider arm (line
// `if (rm.riders.size === 0) return setup;` forced), runTask seating benchSetup instead of
// armSetup, the QualifyingTurns wrapper dropped, CountRemovable without watch.riders, and the
// Rage Damage share rider list forced empty.
describe('W1 4.1: runTask wires the rider F arm, the Rogue U reader, the rider legal count and the Rage Damage share', () => {
  const SA = 'srd:rogue/sneak-attack';
  const sum = (rows: readonly FightRow[], k: 'qualTurns' | 'qualTaken' | 'coreLegalTurns' | 'shareDmg2to5') => rows.reduce((a, r) => a + r[k], 0);
  let base: TaskResult;
  let rem: TaskResult;
  beforeAll(() => {
    base = runTask(WORLD, { bench: 'party', cls: 'rogue', level: 5, arm: 'base', from: 0, to: 20 });
    rem = runTask(WORLD, { bench: 'party', cls: 'rogue', level: 5, arm: 'removed', from: 0, to: 20 });
  });

  it('the Rogue 5 base party arm counts qualifying turns (QualifyingTurns) and the rider\'s legal turns (CountRemovable with watch.riders)', () => {
    expect([base.error, base.rows.length]).toEqual([null, 20]);
    expect(sum(base.rows, 'qualTurns')).toBeGreaterThan(0);
    expect(sum(base.rows, 'qualTaken')).toBeGreaterThan(0);
    expect(sum(base.rows, 'coreLegalTurns')).toBeGreaterThan(0);
    // Every offer the reader saw was a legal Sneak Attack decision the counter saw too.
    expect(sum(base.rows, 'coreLegalTurns')).toBeGreaterThanOrEqual(sum(base.rows, 'qualTurns'));
  });

  it('armSetup\'s removed arm seats pc1 compiled without Sneak Attack (feature and rider), in the same seat, other seats untouched', () => {
    const b = armSetup(WORLD, 'party', 'rogue', 5, 'base');
    const r = armSetup(WORLD, 'party', 'rogue', 5, 'removed');
    expect(r).not.toBe(b);
    const pc = r.seats.findIndex((s) => s.seat === 'pc1');
    expect(pc).toBe(b.seats.findIndex((s) => s.seat === 'pc1'));
    const tb = b.seats[pc]!.tpl;
    const tr = r.seats[pc]!.tpl;
    expect(tb.features.some((f) => f.id === SA)).toBe(true);
    expect(riderIndex(tb, SA, 'sneak-attack') >= 0 || (tb.riders ?? []).some((x) => tb.features[x.feature]?.id === SA)).toBe(true);
    expect(tr.features.some((f) => f.id === SA)).toBe(false);
    expect((tr.riders ?? []).some((x) => tr.features[x.feature]?.id === SA)).toBe(false);
    for (let i = 0; i < r.seats.length; i++) if (i !== pc) expect(r.seats[i]).toBe(b.seats[i]);
  });

  it('runTask\'s removed arm fights in that setup: no Sneak Attack is ever offered, and the fights differ from the base arm\'s', () => {
    expect([rem.error, rem.rows.length]).toEqual([null, 20]);
    expect(sum(rem.rows, 'qualTurns')).toBe(0);
    const foe = (rows: readonly FightRow[]) => rows.map((x) => [x.foeHpRemovedPermille, x.pcDamage, x.rounds, x.outcome].join('/'));
    expect(foe(rem.rows)).not.toEqual(foe(base.rows));
    expect(rem.rows.reduce((a, x) => a + x.pcDamage, 0)).toBeLessThan(base.rows.reduce((a, x) => a + x.pcDamage, 0));
  });

  it('the Barbarian 5 on dummy-melee credits Rage Damage to the share (shareRidersFor wired into the sink)', () => {
    const r = runTask(WORLD, { bench: 'dummy-melee', cls: 'barbarian', level: 5, arm: 'base', from: 0, to: 4 });
    expect(r.error).toBeNull();
    expect(sum(r.rows, 'shareDmg2to5')).toBeGreaterThan(0);
    expect(sum(r.rows, 'shareDmg2to5')).toBeLessThan(r.rows.reduce((a, x) => a + x.dummyDmg2to5, 0));
  });
});
