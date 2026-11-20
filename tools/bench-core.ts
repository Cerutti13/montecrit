// The class bench's pure core (docs/design/coverage.md section 6 as amended by M13, C0): the four
// scenarios, the fight task a worker runs, and the engine-exact value of each class's written
// loop. tools/bench-classes.ts drives it (workers, statistics, the report); tools/bench-worker.ts
// runs tasks on a thread. Deterministic: fixed seeds, runs 0..n-1, results merged in task order.
//
// Reads only the repo's packs and tools/import-srd/srd-index.json (never ~/.montecrit).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  damagePmf,
  formatDiag,
  loadContent,
  makeDeciders,
  resolveScenario,
  rollOdds,
  runFight,
  type CompiledAttack,
  type CompiledDamage,
  type CompiledTemplate,
  type Content,
  type Decider,
  type DecisionPoint,
  type FightSetup,
  type SourceFile,
  type Step,
  type UnitView,
} from '../packages/engine/src/index.ts';
import { createContext } from '../packages/engine/src/sim/fight.ts';
import { applyPassives } from '../packages/engine/src/sim/precast.ts';
import { critMinOf } from '../packages/engine/src/sim/stats.ts';
import type { Unit } from '../packages/engine/src/sim/state.ts';
import { smokePackFiles } from './smoke-classes.ts';
import { smokeCorpus, smokeSpells, type SmokeChar } from './smoke-corpus.ts';
import { assertNoPrivate, CORE, LEVELED_OR_DAMAGING_SPELLS, PICK_CLASSES, PICK_LEVELS, type PickClass } from './class-picks.ts';
import { stalemateCause, TraceSink, type BenchCause, type ShareRider, type UnitTrace } from './bench-trace.ts';

const ROOT = join(import.meta.dirname, '..');

export const BENCHES = ['dummy-melee', 'dummy-range', 'duel', 'party'] as const;
export type Bench = (typeof BENCHES)[number];
export type Arm = 'base' | 'removed';

/** Coverage step 7: the spells whose casts per fight the report prints, per bench row, with no threshold (step7-plan.md 7.3). */
export const REPORTED_SPELLS = ['srd:burning-hands', 'srd:thunderwave', 'srd:entangle', 'srd:faerie-fire', 'srd:lightning-bolt', 'srd:cone-of-cold', 'srd:sleep', 'srd:color-spray', 'srd:grease', 'srd:hypnotic-pattern', 'srd:fear', 'srd:charm-person', 'srd:spirit-guardians'] as const;

/** Seeds per bench (fixed; never tuned). */
export const BENCH_SEED: Readonly<Record<Bench, number>> = { 'dummy-melee': 11, 'dummy-range': 12, duel: 13, party: 14 };

/** dummy-melee AC by level band (coverage.md section 6: 13/14/15/15/16 for L1/3/5/6/10; [U] a convention). */
export const DUMMY_AC: Readonly<Record<number, number>> = { 1: 13, 3: 14, 5: 15, 6: 15, 10: 16 };

/**
 * XP Budget per Character (srd-raw.txt:35861-35944, p.202): [low, moderate] for the bench levels;
 * XP by CR (srd-raw.txt:43778-43858, p.256).
 */
export const XP_BUDGET: Readonly<Record<number, { low: number; moderate: number; cite: string }>> = {
  1: { low: 50, moderate: 75, cite: 'srd-raw.txt:35868-35872' },
  3: { low: 150, moderate: 225, cite: 'srd-raw.txt:35884-35888' },
  5: { low: 500, moderate: 750, cite: 'srd-raw.txt:35900-35904' },
  6: { low: 600, moderate: 1000, cite: 'srd-raw.txt:35908-35912' },
  10: { low: 1600, moderate: 2300, cite: 'srd-raw.txt:35940-35944' },
};
export const XP_BY_CR: Readonly<Record<string, number>> = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800 };
const CR_VALUE: Readonly<Record<string, number>> = { '0': 0, '1/8': 0.125, '1/4': 0.25, '1/2': 0.5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };

/**
 * duel: one SRD monster for one character at low difficulty (M1: the largest single monster
 * within the one-character low budget), the hand blocks where one fits, else a Medium imported
 * block with attacks and few not-modeled lines. Sanity bound (srd-raw.txt:36041-36044): CR <= level.
 */
export const DUEL_MONSTER: Readonly<Record<number, string>> = { 1: 'srd:goblin-warrior', 3: 'srd:tough', 5: 'srd:berserker', 6: 'srd:berserker', 10: 'srd:guard-captain' };

/**
 * party: a stock SRD group spending the moderate budget for four characters of the level
 * (M1, srd-raw.txt:36054-36063). L3 signed off by Shane 2026-11-09 (coverage.md, 8'b
 * build note, M13 g; `tools/measure-party-size.ts`). Win% stays a trend, not a gate.
 */
export const PARTY_GROUP: Readonly<Record<number, readonly string[]>> = {
  1: ['srd:goblin-boss', 'srd:goblin-warrior', 'srd:goblin-warrior'],
  3: ['srd:goblin-boss', 'srd:goblin-boss', 'srd:goblin-boss', 'srd:goblin-boss', 'srd:tough'], // Shane 2026-11-09 (M13 g): in budget, mid-band; knight + boss was 94% wins
  5: ['srd:warrior-veteran', 'srd:warrior-veteran', 'srd:warrior-veteran', 'srd:warrior-veteran', 'srd:goblin-boss'],
  6: ['srd:guard-captain', 'srd:guard-captain', 'srd:guard-captain', 'srd:knight'],
  10: ['srd:gladiator', 'srd:gladiator', 'srd:gladiator', 'srd:gladiator', 'srd:gladiator', 'srd:goblin-boss'],
};
export const PARTY_PROVISIONAL = false; // Shane signed off M13 g, 2026-11-09

/** The three fixed allies; a Rogue swaps in for whichever is the class under test. */
export function partyAllies(cls: string): string[] {
  return ['fighter', 'cleric', 'wizard'].map((a) => (a === cls ? 'rogue' : a));
}

export interface BenchWorld {
  readonly files: readonly SourceFile[];
  readonly corpus: readonly SmokeChar[];
  readonly content: Content;
  /** Monster YAML cr per id (srd: monsters). */
  readonly cr: ReadonlyMap<string, string>;
}

/**
 * The repo's packs plus the curated corpus (L1-scanned), compiled once. `generated` is a test
 * seam (review T4): it sees the generated texts before the bench's own scan, as a later
 * generation step would.
 */
export function benchWorld(root: string = ROOT, generated: (c: readonly SmokeChar[]) => readonly SmokeChar[] = (c) => c): BenchWorld {
  const files = smokePackFiles(root);
  const corpus = generated(smokeCorpus(files, smokeSpells(readFileSync(join(root, 'tools', 'import-srd', 'srd-index.json'), 'utf8'))));
  assertNoPrivate(corpus, 'bench corpus');
  const r = loadContent([...files, ...corpus.map((c) => ({ path: c.path, text: c.text }))]);
  if (!r.content) throw new Error(`bench: content didn't load: ${r.errors.slice(0, 5).map(formatDiag).join('; ')}`);
  const cr = new Map<string, string>();
  for (const f of files) {
    if (!f.path.startsWith('packs/srd-5.2.1/monsters/')) continue;
    const d = parse(f.text) as { id?: string; cr?: string | number };
    if (d.id !== undefined && d.cr !== undefined) cr.set(d.id, String(d.cr));
  }
  return { files, corpus, content: r.content, cr };
}

export const charId = (cls: string, level: number): string => `test:smoke-${cls}-${level}`;

/** The scenario for one bench, class and level (public content only). */
export function benchScenario(bench: Bench, cls: string, level: number): Record<string, unknown> {
  const pc = { seat: 'pc1', team: 'party', use: charId(cls, level), decider: 'greedy' };
  const base = { kind: 'scenario', rules: '2024', packs: ['srd-5.2.1', 'test'], id: `bench-${bench}-${cls}-${level}`, name: `Bench ${bench} ${cls} ${level}` };
  switch (bench) {
    case 'dummy-melee':
      return { ...base, grid: { w: 8, h: 8 }, knobs: { maxRounds: 5, lossCounts: 'pcs' }, units: [{ ...pc, at: 'D5' }, { seat: 'dummy', team: 'enemies', use: `test:bench-dummy-ac${DUMMY_AC[level]}`, at: 'D4', decider: 'greedy' }] };
    case 'dummy-range':
      // 60 ft to the dummy and to the archer (uniform diagonals).
      return {
        ...base,
        grid: { w: 16, h: 16 },
        knobs: { maxRounds: 10, lossCounts: 'pcs' },
        units: [{ ...pc, at: 'B8' }, { seat: 'dummy', team: 'enemies', use: `test:bench-dummy-ac${DUMMY_AC[level]}`, at: 'N8', decider: 'greedy' }, { seat: 'archer', team: 'enemies', use: 'test:bench-archer', at: 'N14', decider: 'greedy' }],
      };
    case 'duel':
      return { ...base, grid: { w: 12, h: 12 }, knobs: { maxRounds: 10, lossCounts: 'pcs' }, units: [{ ...pc, at: 'F10' }, { seat: 'f1', team: 'enemies', use: DUEL_MONSTER[level], at: 'F4', decider: 'greedy' }] };
    case 'party': {
      const allies = partyAllies(cls);
      const cols = ['D', 'F', 'H', 'J'];
      const foeCols = ['B', 'D', 'F', 'H', 'J', 'L'];
      return {
        ...base,
        grid: { w: 12, h: 12 },
        // Party cap 15 (Shane, 2026-11-14, stalemate-plan.md 6 a; was 10): five more rounds settle the fights still being fought when the healing ran out. The duel stays 10 (6 b).
        knobs: { maxRounds: 15, lossCounts: 'pcs' },
        units: [
          { ...pc, at: `${cols[0]}10` },
          ...allies.map((a, i) => ({ seat: `pc${i + 2}`, team: 'party', use: charId(a, level), at: `${cols[i + 1]}10`, decider: 'greedy' })),
          ...PARTY_GROUP[level]!.map((m, i) => ({ seat: `f${i + 1}`, team: 'enemies', use: m, at: `${foeCols[i]}3`, decider: 'greedy' })),
        ],
      };
    }
  }
}

/** Plays a seat that never acts (the dummies): it always answers 'pass' when it can. */
export class PassDecider implements Decider {
  readonly name = 'bench-pass';
  decide(_view: UnitView, dp: DecisionPoint): number {
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') return i;
    return 0;
  }
}

/**
 * The F arm's in-memory toggle: the wrapped decider never sees the core feature's `use` items or
 * the core spells' `cast` items, so it plays as if the PC didn't have them (common random
 * numbers: same seats, seed and runs). Automatic riders can't be removed this way (printed). A
 * core feature that is only a rider (W1: Sneak Attack) is removed by the arm's template instead
 * (armSetup), since the greedy AI also values a rider it would be offered.
 */
export class WithoutCore implements Decider {
  readonly name: string;
  private readonly base: Decider;
  private readonly tpl: CompiledTemplate;
  private readonly features: ReadonlySet<string>;
  private readonly spells: ReadonlySet<string>;
  constructor(base: Decider, tpl: CompiledTemplate, features: ReadonlySet<string>, spells: ReadonlySet<string>) {
    this.base = base;
    this.tpl = tpl;
    this.features = features;
    this.spells = spells;
    this.name = `${base.name}-without-core`;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    if (dp.k !== 'turn') return this.base.decide(view, dp);
    const keep: number[] = [];
    for (let i = 0; i < dp.legal.n; i++) if (!removedItem(this.tpl, this.features, this.spells, dp, i)) keep.push(i);
    if (keep.length === dp.legal.n || keep.length === 0) return this.base.decide(view, dp);
    const sub: DecisionPoint = { ...dp, legal: { n: keep.length, items: keep.map((i) => dp.legal.items[i]!) }, keyOf: (j: number) => dp.keyOf(keep[j]!) };
    delete (sub as { indexOfKey?: unknown }).indexOfKey;
    return keep[this.base.decide(view, sub)]!;
  }
}

/** Is legal item `i` one the F arm removes (a `use` of a core feature, a `cast` of a core spell)? */
export function removedItem(tpl: CompiledTemplate, features: ReadonlySet<string>, spells: ReadonlySet<string>, dp: DecisionPoint, i: number): boolean {
  const l = dp.legal.items[i]!;
  if (l.k === 'use' && l.fx < 0) return features.has(tpl.features[l.opt]!.id);
  if (l.k === 'cast') return spells.has(tpl.spells[l.opt]!.spell.id);
  return false;
}

/**
 * The base arm's watch on the F arm (review C0-BENCH-M1): passes every decision through unchanged
 * and counts the turn decisions on which a removed item was legal, and (W1) the rider decisions a
 * removed rider feature was offered on (`riders`: feature ids; a rider decision's src.via is its
 * feature). Zero over the whole base arm means both arms played the same fights, so F reads n/a
 * rather than a 0.0 difference.
 */
export class CountRemovable implements Decider {
  readonly name: string;
  private readonly base: Decider;
  private readonly tpl: CompiledTemplate;
  private readonly features: ReadonlySet<string>;
  private readonly spells: ReadonlySet<string>;
  private readonly riders: ReadonlySet<string>;
  legalTurns = 0;
  constructor(base: Decider, tpl: CompiledTemplate, features: ReadonlySet<string>, spells: ReadonlySet<string>, riders: ReadonlySet<string> = new Set()) {
    this.base = base;
    this.tpl = tpl;
    this.features = features;
    this.spells = spells;
    this.riders = riders;
    this.name = base.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    if (dp.k === 'rider' && dp.src !== undefined && this.riders.has(dp.src.via)) this.legalTurns++;
    else if (dp.k === 'turn') {
      for (let i = 0; i < dp.legal.n; i++) {
        if (removedItem(this.tpl, this.features, this.spells, dp, i)) {
          this.legalTurns++;
          break;
        }
      }
    }
    return this.base.decide(view, dp);
  }
}

/**
 * W1 (w1-plan.md 4.1): the Rogue's U reader, a pass-through watch on the PC's decider. A turn
 * qualifies when one of `features`' riders is offered (a 'rider' decision whose src.via is the
 * feature: the hit met its filter and gates), on any creature's turn (st.turnIdx, so an Opportunity
 * Attack's turn is its own); each turn counts once however many hits were offered, and is taken
 * when any offer on it was answered with something other than pass. Changes no decision.
 */
export class QualifyingTurns implements Decider {
  readonly name: string;
  private readonly base: Decider;
  private readonly features: ReadonlySet<string>;
  private lastOffered = -1;
  private lastTaken = -1;
  offered = 0;
  taken = 0;
  constructor(base: Decider, features: ReadonlySet<string>) {
    this.base = base;
    this.features = features;
    this.name = base.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const r = this.base.decide(view, dp);
    if (dp.k === 'rider' && dp.src !== undefined && this.features.has(dp.src.via)) {
      const turn = view.q.turnIdx;
      if (turn !== this.lastOffered) {
        this.lastOffered = turn;
        this.offered++;
      }
      if (dp.legal.items[r]!.k !== 'pass' && turn !== this.lastTaken) {
        this.lastTaken = turn;
        this.taken++;
      }
    }
    return r;
  }
}

/**
 * Can the build supply this spell's Material component at all (review C0-BENCH-M1)? A spell with
 * m: focus needs a focus for its list or a Component Pouch among the template's items (cast.ts
 * componentsOk; srd-raw.txt:23736-23741). Hands are not read: a carried focus can be drawn.
 */
export function materialSupplied(tpl: CompiledTemplate, e: CompiledTemplate['spells'][number]): boolean {
  if (e.spell.m === 'none') return true;
  return tpl.items.some((it) => (it.kind === 'focus' && it.focusFor.includes(e.list)) || it.kind === 'pouch');
}

/**
 * What the F arm removes for a class, from what its template actually has: its best core spell is
 * the first in the core's order whose Material component the build can supply (review
 * C0-BENCH-M1), so a spell it could never cast is never "removed". W1 (w1-plan.md 4.1): a core
 * feature with no activation that carries riders (Sneak Attack) goes in `riders`; the removed arm
 * seats a template compiled without it (armSetup).
 */
export function removalSet(cls: PickClass, tpl: CompiledTemplate): { features: Set<string>; spells: Set<string>; riders: Set<string>; auto: string[]; what: string[] } {
  const features = new Set<string>();
  const spells = new Set<string>();
  const riders = new Set<string>();
  const auto: string[] = [];
  const what: string[] = [];
  for (const c of CORE[cls].core) {
    for (const f of c.features) {
      const fi = tpl.features.findIndex((x) => x.id === f);
      if (fi < 0) continue;
      const x = tpl.features[fi]!;
      if (x.activate !== null || x.more !== undefined) {
        features.add(f);
        what.push(c.label);
      } else if ((tpl.riders ?? []).some((r) => r.feature === fi)) {
        riders.add(f);
        what.push(c.label);
      }
    }
    if (c.spells.includes('*')) {
      for (const e of tpl.spells) spells.add(e.spell.id);
      if (tpl.spells.length > 0) what.push('every spell');
    } else {
      const best = c.spells.find((s) => tpl.spells.some((e) => e.spell.id === s && materialSupplied(tpl, e)));
      if (best) {
        spells.add(best);
        what.push(best.slice(4));
      }
    }
    for (const a of c.autoActs) if (tpl.features.some((x) => x.id === a)) auto.push(a);
  }
  return { features, spells, riders, auto, what };
}

/**
 * The pack files with these feature ids taken out of every class, subclass, species and feat
 * feature list (W1: the rider F arm), so a character expands without them exactly as it would if
 * the class didn't grant them. A file that names none is passed through untouched.
 */
export function withoutFeatures(files: readonly SourceFile[], drop: ReadonlySet<string>): SourceFile[] {
  return files.map((f) => {
    if (!f.path.startsWith('packs/') || ![...drop].some((id) => f.text.includes(id))) return f;
    const d = parse(f.text) as Record<string, unknown> | null;
    if (!d || !['class', 'subclass', 'species', 'feat'].includes(String(d.kind))) return f;
    const keep = (x: unknown): boolean => !drop.has(typeof x === 'string' ? x : ((x as { id?: string } | null)?.id ?? ''));
    let changed = false;
    if (Array.isArray(d.features)) {
      const next = d.features.filter(keep);
      changed ||= next.length !== d.features.length;
      d.features = next;
    } else if (d.features && typeof d.features === 'object') {
      const byLevel = d.features as Record<string, unknown[]>;
      for (const lvl of Object.keys(byLevel)) {
        const next = byLevel[lvl]!.filter(keep);
        changed ||= next.length !== byLevel[lvl]!.length;
        if (next.length > 0) byLevel[lvl] = next;
        else delete byLevel[lvl];
      }
    }
    return changed ? { path: f.path, text: stringify(d) } : f;
  });
}

const strippedCache = new WeakMap<BenchWorld, Map<string, Content>>();

/** The world's content with these features taken out (withoutFeatures), loaded once per world and feature set. */
export function strippedContent(world: BenchWorld, drop: ReadonlySet<string>): Content {
  const key = [...drop].sort().join(',');
  let m = strippedCache.get(world);
  if (!m) strippedCache.set(world, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const r = loadContent([...withoutFeatures(world.files, drop), ...world.corpus.map((c) => ({ path: c.path, text: c.text }))]);
  if (!r.content) throw new Error(`bench: content without ${key} didn't load: ${r.errors.slice(0, 5).map(formatDiag).join('; ')}`);
  m.set(key, r.content);
  return r.content;
}

const armCache = new Map<string, FightSetup>();

/**
 * The setup an arm fights in. The base arm, and a removed arm that only filters decisions, use the
 * bench's setup. A removed arm with rider features (W1, w1-plan.md 4.1: Sneak Attack) seats pc1's
 * template compiled without them, in the same seat (common random numbers: seats are slots, the
 * seed and runs are the same), so neither the rider nor any greedy term for it exists in that arm.
 */
export function armSetup(world: BenchWorld, bench: Bench, cls: PickClass, level: number, arm: Arm): FightSetup {
  const setup = benchSetup(world, bench, cls, level);
  if (arm === 'base') return setup;
  const pc = setup.seats.findIndex((x) => x.seat === 'pc1');
  const rm = removalSet(cls, setup.seats[pc]!.tpl);
  if (rm.riders.size === 0) return setup;
  const key = `${bench}/${cls}/${level}/${[...rm.riders].sort().join(',')}`;
  const hit = armCache.get(key);
  if (hit) return hit;
  const tpl = strippedContent(world, rm.riders).get(charId(cls, level));
  if (!tpl) throw new Error(`bench ${key}: ${charId(cls, level)} didn't compile without ${[...rm.riders].join(', ')}`);
  const out: FightSetup = { ...setup, seats: setup.seats.map((x, i) => (i === pc ? { ...x, tpl } : x)) };
  armCache.set(key, out);
  return out;
}

/** tpl.riders index of the rider `local` of feature `featureId`, or -1. */
export function riderIndex(tpl: CompiledTemplate, featureId: string, local: string): number {
  const rs = tpl.riders ?? [];
  for (let i = 0; i < rs.length; i++) if (rs[i]!.local === local && tpl.features[rs[i]!.feature]?.id === featureId) return i;
  return -1;
}

/** A rider option's extra damage parts with `type: weapon` (asAttack, type -1 until a hit) resolved to the attack's type, as sim/riders.ts does. */
export function extraFor(extra: readonly CompiledDamage[], atk: CompiledAttack): CompiledDamage[] {
  const type = atk.damage[0]?.type ?? 0;
  return extra.map((d) => (d.asAttack ? { ...d, type } : d));
}

/**
 * W1: the trace's share riders for a class (CORE[cls].dShare): the rider's act (via, name) and its
 * value per use, the mean of its first option's extra damage (Rage Damage is a flat number, so
 * exact; never a Critical Hit's doubled dice, since it has none). [] when the template lacks it.
 */
export function shareRidersFor(cls: PickClass, tpl: CompiledTemplate): ShareRider[] {
  const s = CORE[cls].dShare;
  if (!s) return [];
  const ri = riderIndex(tpl, s.feature, s.rider);
  if (ri < 0) return [];
  const r = tpl.riders![ri]!;
  const extra = (r.opts[0]?.extra ?? []).map((d) => (d.asAttack ? { ...d, type: 0 } : d));
  return [{ via: s.feature, name: r.chooses ? `${r.name}: ${r.opts[0]!.name}` : r.name, value: mean(extra, false) }];
}

/** True when a cast of this spell entry deals damage at level 0 (a damaging cantrip). */
export function damagingCantrip(tpl: CompiledTemplate, spellId: string): boolean {
  const e = tpl.spells.find((s) => s.spell.id === spellId);
  if (!e || e.spell.level !== 0) return false;
  return dealsDamage(e.prog[0] ?? []);
}

function dealsDamage(steps: readonly Step[]): boolean {
  for (const s of steps) {
    if (s.k === 'damage') return true;
    if (s.k === 'save' && s.dmg !== null && s.dmg.length > 0) return true;
    if (s.k === 'attack' && (s.atk.damage.length > 0 || dealsDamage(s.onHit))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// One task: n fights of one (bench, class, level, arm), with per-fight numbers.

export interface TaskSpec {
  readonly bench: Bench;
  readonly cls: PickClass;
  readonly level: number;
  readonly arm: Arm;
  readonly from: number;
  readonly to: number;
}

export interface FightRow {
  readonly outcome: 'win' | 'loss' | 'stalemate';
  readonly cause: BenchCause | null;
  readonly turnsUp: number;
  readonly dodges: number;
  readonly attacks: number;
  readonly casts: number;
  /** Casts of each of REPORTED_SPELLS, in its order. */
  readonly spellCasts: readonly number[];
  readonly items: number;
  /** The fight counts for U under its class's reading (CORE[cls].uRead: perFight or byRound2; false for the others). */
  readonly coreUsed: boolean;
  /** uptimeAfterRound1: the PC's up turns from round 2 on, and those it started with the core effect on it. */
  readonly turnsAfterR1: number;
  readonly upTurnsAfterR1: number;
  /** Recorded for the rate rules (not read by a verdict yet, review R2): the PC's crits and turns with a hit. */
  readonly crits: number;
  readonly hitTurns: number;
  /**
   * dummy benches, the casters' D reading (review R4): of rounds 2-5, the rounds the PC cast no
   * leveled spell, and its damage to the dummy in those rounds from anything but a leveled spell.
   */
  readonly cantripRounds: number;
  readonly cantripRoundDmg: number;
  /** dummy benches: PC damage to the dummy in rounds 2-5, and the first round it landed (0 = never). */
  readonly dummyDmg2to5: number;
  readonly firstDamageRound: number;
  /** duel and party: HP the foes lost (x1000 of their total), and PC damage dealt. */
  readonly foeHpRemovedPermille: number;
  readonly pcDamage: number;
  readonly rounds: number;
  /** party, base arm of a class with an F arm: turn decisions on which a removed item was legal (review C0-BENCH-M1). */
  readonly coreLegalTurns: number;
  /** W1, uRead perQualifyingTurn: turns its U rider was offered, and of those the ones it was taken (QualifyingTurns). */
  readonly qualTurns: number;
  readonly qualTaken: number;
  /** W1: turns (any creature's) on which the PC hit with an attack roll, the qualifying share's denominator. */
  readonly hitTurnsAll: number;
  /** W1, dummy benches: the PC's damage to the dummy in rounds 2-5 credited to CORE[cls].dShare's rider (Rage Damage). */
  readonly shareDmg2to5: number;
}

export interface TaskResult {
  readonly spec: TaskSpec;
  readonly rows: readonly FightRow[];
  readonly error: string | null;
}

const setupCache = new Map<string, FightSetup>();

export function benchSetup(world: BenchWorld, bench: Bench, cls: string, level: number): FightSetup {
  const key = `${bench}/${cls}/${level}`;
  const hit = setupCache.get(key);
  if (hit) return hit;
  const s = resolveScenario(benchScenario(bench, cls, level), `bench-${bench}-${cls}-${level}.yaml`, world.content);
  if (!s.setup) throw new Error(`bench ${key}: ${s.errors.map(formatDiag).join('; ')}`);
  setupCache.set(key, s.setup);
  return s.setup;
}

/**
 * Does this fight count for U under the class's reading (CORE[cls].uRead)? Only `uIds` count:
 * the Fighter's Weapon Mastery riders are reported, never a use of Action Surge (review R1).
 * perFight: any use in the fight; byRound2: first used in round 1 or 2 (review R2); the uptime,
 * per-qualifying-turn (W1) and unmeasured readings are not per fight, so false here.
 */
export function coreUsedIn(cls: PickClass, tpl: CompiledTemplate, t: Pick<UnitTrace, 'acts' | 'spells' | 'leveledCasts' | 'firstActRound' | 'firstCastRound'>): boolean {
  const entry = CORE[cls];
  if (entry.uRead === 'uptimeAfterRound1' || entry.uRead === 'perQualifyingTurn' || entry.uRead === 'unmeasured') return false;
  if (entry.uIds.includes(LEVELED_OR_DAMAGING_SPELLS)) {
    if (entry.uRead !== 'perFight') throw new Error(`${cls}: the casters' rule is read per fight`);
    if (t.leveledCasts > 0) return true;
    for (const [id] of t.spells) if (damagingCantrip(tpl, id)) return true;
    return false;
  }
  for (const id of entry.uIds) {
    const first = Math.min(t.firstActRound.get(id) ?? Infinity, t.firstCastRound.get(id) ?? Infinity);
    if (first === Infinity) continue;
    if (entry.uRead === 'perFight' || first <= 2) return true;
  }
  return false;
}

/** Is any of the U ids on this sheet (a feature it has, a spell it can cast)? */
export function hasUFeature(cls: PickClass, tpl: CompiledTemplate): boolean {
  const ids = CORE[cls].uIds;
  if (ids.includes(LEVELED_OR_DAMAGING_SPELLS)) return tpl.spells.length > 0;
  return ids.some((id) => tpl.features.some((f) => f.id === id) || tpl.spells.some((e) => e.spell.id === id));
}

export function runTask(world: BenchWorld, spec: TaskSpec): TaskResult {
  const rows: FightRow[] = [];
  try {
    const setup = armSetup(world, spec.bench, spec.cls, spec.level, spec.arm);
    const pc = setup.seats.findIndex((x) => x.seat === 'pc1');
    const tpl = setup.seats[pc]!.tpl;
    const dummy = setup.seats.findIndex((x) => x.seat === 'dummy');
    const team = setup.seats.map((x) => x.team);
    const entry = CORE[spec.cls];
    const sink = new TraceSink([pc], team, dummy, entry.uRead === 'uptimeAfterRound1' ? entry.uIds : [], dummy >= 0 ? shareRidersFor(spec.cls, tpl) : []);
    const rm = spec.arm === 'removed' ? removalSet(spec.cls, tpl) : null;
    const watch = spec.arm === 'base' && spec.bench === 'party' ? removalSet(spec.cls, tpl) : null;
    const qualIds = entry.uRead === 'perQualifyingTurn' ? new Set(entry.uIds) : null;
    const foes = setup.seats.map((x, i) => (x.team !== 0 ? i : -1)).filter((i) => i >= 0 && setup.seats[i]!.seat !== 'archer' && setup.seats[i]!.seat !== 'dummy');
    for (let run = spec.from; run < spec.to; run++) {
      const ds = makeDeciders(setup);
      if (dummy >= 0) ds[dummy] = new PassDecider();
      if (rm) ds[pc] = new WithoutCore(ds[pc]!, tpl, rm.features, rm.spells);
      const counter = watch ? new CountRemovable(ds[pc]!, tpl, watch.features, watch.spells, watch.riders) : null;
      if (counter) ds[pc] = counter;
      const qual = qualIds ? new QualifyingTurns(ds[pc]!, qualIds) : null;
      if (qual) ds[pc] = qual;
      sink.reset();
      const res = runFight(setup, BENCH_SEED[spec.bench], run, ds, sink, { inspect: sink.inspect });
      const t = sink.units.get(pc)!;
      let removed = 0;
      let total = 0;
      for (const f of foes) {
        total += res.hpMax[f]!;
        removed += res.hpMax[f]! - Math.max(0, res.hp[f]!);
      }
      let d25 = 0;
      let cRounds = 0;
      let cDmg = 0;
      let share25 = 0;
      for (let r = 2; r <= 5; r++) {
        d25 += t.dealtFocus[r] ?? 0;
        share25 += t.riderDealtFocus[r] ?? 0;
        if (t.leveledRounds[r]) continue;
        cRounds++;
        cDmg += (t.dealtFocus[r] ?? 0) - (t.dealtFocusLeveled[r] ?? 0);
      }
      let dealt = 0;
      for (const v of t.dealt) dealt += v ?? 0;
      rows.push({
        outcome: res.outcome.k,
        cause: stalemateCause(res, sink),
        turnsUp: t.turnsUp,
        dodges: t.dodges,
        attacks: t.attacks,
        casts: t.casts,
        spellCasts: REPORTED_SPELLS.map((id) => t.spells.get(id) ?? 0),
        items: t.itemDecisions,
        coreUsed: coreUsedIn(spec.cls, tpl, t),
        turnsAfterR1: t.turnsAfterR1,
        upTurnsAfterR1: t.upTurnsAfterR1,
        crits: t.crits,
        hitTurns: t.hitTurns,
        cantripRounds: dummy >= 0 ? cRounds : 0,
        cantripRoundDmg: dummy >= 0 ? cDmg : 0,
        dummyDmg2to5: d25,
        firstDamageRound: t.firstFocusRound,
        foeHpRemovedPermille: total > 0 ? Math.round((1000 * removed) / total) : 0,
        pcDamage: dealt,
        rounds: res.outcome.round,
        coreLegalTurns: counter ? counter.legalTurns : 0,
        qualTurns: qual ? qual.offered : 0,
        qualTaken: qual ? qual.taken : 0,
        hitTurnsAll: t.hitTurnsAll,
        shareDmg2to5: share25,
      });
    }
    return { spec, rows, error: null };
  } catch (e) {
    return { spec, rows, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// The engine-exact value of the written loop (D's denominator; M13 a).

export interface LoopPart {
  readonly what: string;
  readonly count: number;
  readonly ev: number;
}

const mean = (parts: readonly CompiledDamage[], crit: boolean): number => {
  const p = damagePmf(parts, null, crit, false);
  let s = 0;
  for (let i = 0; i < p.p.length; i++) s += (p.min + i) * p.p[i]!;
  return s;
};

/**
 * Expected damage of one attack against AC `ac`: hits and crits from rollOdds (the crit range from
 * the attacker's stats, as sim/attack.ts reads it: Improved Critical), damage from damagePmf (no defenses).
 * W1: `more.adv` rolls it with Advantage (cancelled by a Heavy weapon's Disadvantage, srd-raw.txt:
 * 1056-1060), and `more.extra` joins a hit rider's extra damage to the attack's own (rolled twice on
 * a Critical Hit, as sim/riders.ts does), with `type: weapon` parts resolved to the attack's type.
 */
export function attackEv(atk: CompiledAttack, ac: number, setup: FightSetup, me: Unit | null = null, more: { readonly adv?: boolean; readonly extra?: readonly CompiledDamage[] } = {}): number {
  const critMin = me ? critMinOf(null, me, atk, null) : atk.critMin;
  const adv = more.adv ? (atk.heavyDis ? 'none' : 'adv') : atk.heavyDis ? 'dis' : 'none';
  const o = rollOdds({ kind: 'attack', adv, flat: atk.toHit, preDice: [], critMin, dc: ac }, setup.flags);
  const parts = more.extra && more.extra.length > 0 ? [...atk.damage, ...extraFor(more.extra, atk)] : atk.damage;
  return (o.pSuccess - o.pCrit) * mean(parts, false) + o.pCrit * mean(parts, true);
}

/** Expected damage of a save-for-damage step against a creature with save modifier `mod`. */
function saveEv(dmg: readonly CompiledDamage[], half: boolean, dc: number, mod: number, setup: FightSetup): number {
  const o = rollOdds({ kind: 'save', adv: 'none', flat: mod, preDice: [], dc }, setup.flags);
  const full = damagePmf(dmg, null, false, false);
  const halfP = damagePmf(dmg, null, false, false, true);
  let f = 0;
  for (let i = 0; i < full.p.length; i++) f += (full.min + i) * full.p[i]!;
  let h = 0;
  for (let i = 0; i < halfP.p.length; i++) h += (halfP.min + i) * halfP.p[i]!;
  return (1 - o.pSuccess) * f + o.pSuccess * (half ? h : 0);
}

function stepsEv(steps: readonly Step[], target: CompiledTemplate, setup: FightSetup, me: Unit): number {
  let v = 0;
  for (const s of steps) {
    if (s.k === 'attack') v += attackEv(s.atk, target.ac, setup, me);
    else if (s.k === 'save' && s.dmg) v += saveEv(s.dmg, s.half, s.dc, target.saveMod[s.ability]!, setup);
    else if (s.k === 'damage') v += mean(s.dmg, false);
  }
  return v;
}

/** D's window: rounds 2-5 (M13 a). */
export const D_WINDOW_ROUNDS = 4;

/**
 * The class's written loop per round against the dummy, valued exactly. Weapon classes: the
 * Attack action (two attacks with Extra Attack) with the best weapon of the bench's kind, plus
 * the Monk's Bonus Action: Flurry of Blows' Unarmed Strikes in the window rounds its Focus Points
 * pay for, the Martial Arts bonus Unarmed Strike in the rest (review R3). Casters (`kind`
 * 'cantrip'): the best damaging cantrip, read against the cantrip rounds only (review R4).
 * W1 (w1-plan.md 4.1): the Barbarian's loop is raging, Reckless Attack off (the book loop), so each
 * hit adds the engine's Rage Damage rider; the Rogue's is Steady Aim's Advantage (once it has Steady
 * Aim, Rogue 3) on its weapon attack with Sneak Attack on the hit. Each rider counts only when the
 * template carries it and the weapon's onHit lists it. Savage Attacker (a narrative feat) stays in
 * the book-DPR table's gap. [U] Light-property extra attacks and leveled spells are left out of the
 * sustained loop.
 */
export function engineLoop(cls: PickClass, setup: FightSetup): { parts: LoopPart[]; total: number; note: string; kind: 'weapon' | 'cantrip' | 'none' } {
  const pcIdx = setup.seats.findIndex((x) => x.seat === 'pc1');
  const pc = setup.seats[pcIdx]!.tpl;
  const target = setup.seats.find((x) => x.seat === 'dummy')!.tpl;
  // The PC as a unit at fight start (its passive stats applied), for the crit range.
  const cx = createContext(setup, 0, 0, makeDeciders(setup), null);
  applyPassives(cx, -1);
  const me = cx.st.units[pcIdx]!;
  const parts: LoopPart[] = [];
  let loopKind: 'weapon' | 'cantrip' | 'none' = 'none';
  const kind = CORE[cls].dBench === 'dummy-melee' ? 'melee' : 'ranged';
  const weapons = pc.attacks.filter((a) => a.kind === kind && !a.unarmed && !a.spell);
  const cantrips = pc.spells.filter((e) => e.spell.level === 0 && e.prog[0]);
  if (weapons.length > 0 && (kind === 'melee' || cantrips.length === 0 || cls === 'ranger')) {
    // W1: the Rogue with Steady Aim attacks with Advantage and Sneak Attack where the weapon takes it.
    const sneak = cls === 'rogue' ? riderIndex(pc, 'srd:rogue/sneak-attack', 'sneak-attack') : -1;
    const aim = cls === 'rogue' && pc.features.some((f) => f.id === 'srd:rogue/steady-aim' && f.activate !== null);
    const aimed = (a: CompiledAttack): boolean => aim && sneak >= 0 && (a.onHit ?? []).includes(sneak);
    const evOf = (a: CompiledAttack): number => (aimed(a) ? attackEv(a, target.ac, setup, me, { adv: true, extra: pc.riders![sneak]!.opts[0]!.extra ?? [] }) : attackEv(a, target.ac, setup, me));
    const best = weapons.map((a) => ({ a, ev: evOf(a) })).sort((x, y) => y.ev - x.ev || (x.a.local < y.a.local ? -1 : 1))[0]!;
    const n = pc.attackAct.extraAttack ? 2 : 1;
    loopKind = 'weapon';
    parts.push({ what: `${best.a.name} x${n} (Attack action${aimed(best.a) ? ', Advantage from Steady Aim, Sneak Attack on the hit' : ''})`, count: n, ev: best.ev });
    // W1: raging, every hit with a Strength weapon attack adds the Rage Damage rider.
    const rage = cls === 'barbarian' ? riderIndex(pc, 'srd:barbarian/rage', 'rage-damage') : -1;
    if (rage >= 0 && (best.a.onHit ?? []).includes(rage)) {
      const extra = pc.riders![rage]!.opts[0]!.extra ?? [];
      parts.push({ what: `Rage Damage on each hit, raging (x${n})`, count: n, ev: attackEv(best.a, target.ac, setup, me, { extra }) - best.ev });
    }
    const ma = pc.features.find((f) => f.id === 'srd:monk/martial-arts' && f.activate);
    if (ma) {
      const from = ma.activate!.steps.flatMap((s) => (s.k === 'weaponAttack' ? s.from : []));
      const evs = from.map((i) => attackEv(pc.attacks[i]!, target.ac, setup, me));
      // With Focus (the Monk's core: Martial Arts plus Focus spend), the Bonus Action is Flurry of
      // Blows' two Unarmed Strikes instead of one, for 1 Focus Point (srd-raw.txt:11126-11127).
      // Focus Points equal the Monk level and come back only on a rest (11111-11115, 11120-11122), so the
      // written loop Flurries every turn from round 1 while points last: of the 4 window rounds,
      // min(4, points - 1) are Flurry rounds (L3: 2 of 4; L5 and up: all 4), the rest the
      // Martial Arts bonus strike (review R3; [U] Uncanny Metabolism's regain on Initiative
      // restores nothing at fight start, and no Focus goes to Patient Defense or Stunning Strike).
      const focus = pc.features.find((f) => f.id === 'srd:monk/monks-focus');
      const flurry = [...(focus?.activate ? [focus.activate] : []), ...(focus?.more ?? [])].find((a) => a.local === 'flurry');
      const n = flurry ? flurry.steps.reduce((k, s) => (s.k === 'weaponAttack' ? k + s.count : k), 0) : 1;
      if (evs.length > 0) {
        const ev = Math.max(...evs);
        if (!flurry) parts.push({ what: 'Martial Arts bonus Unarmed Strike', count: 1, ev });
        else {
          const points = flurry.pool >= 0 ? pc.resMax[flurry.pool]! : 0;
          const uses = Math.floor(points / (flurry.poolCost ?? 1));
          const fr = Math.max(0, Math.min(D_WINDOW_ROUNDS, uses - 1));
          if (fr > 0) parts.push({ what: `Flurry of Blows Unarmed Strike x${n} (Focus) in ${fr} of ${D_WINDOW_ROUNDS} window rounds`, count: (Math.max(1, n) * fr) / D_WINDOW_ROUNDS, ev });
          if (fr < D_WINDOW_ROUNDS) parts.push({ what: `Martial Arts bonus Unarmed Strike in ${D_WINDOW_ROUNDS - fr} of ${D_WINDOW_ROUNDS} window rounds (Focus spent)`, count: (D_WINDOW_ROUNDS - fr) / D_WINDOW_ROUNDS, ev });
        }
      }
    }
  } else if (cantrips.length > 0) {
    const best = cantrips.map((e) => ({ e, ev: stepsEv(e.prog[0]!, target, setup, me) })).sort((x, y) => y.ev - x.ev || (x.e.spell.id < y.e.spell.id ? -1 : 1))[0]!;
    if (best.ev > 0) {
      loopKind = 'cantrip';
      parts.push({ what: `${best.e.spell.name} (cantrip, Action)`, count: 1, ev: best.ev });
    }
  }
  const total = parts.reduce((a, p) => a + p.count * p.ev, 0);
  return { parts, total, kind: loopKind, note: parts.map((p) => `${p.what} ${p.ev.toFixed(3)} each`).join(' + ') || 'no damaging loop' };
}

/** Monster CR and XP for the printed sizing. */
export function crOf(world: BenchWorld, id: string): { cr: string; xp: number; crValue: number } {
  const cr = world.cr.get(id) ?? '?';
  return { cr, xp: XP_BY_CR[cr] ?? NaN, crValue: CR_VALUE[cr] ?? NaN };
}

export const ALL_CLASSES = PICK_CLASSES;
export const ALL_LEVELS = PICK_LEVELS;
