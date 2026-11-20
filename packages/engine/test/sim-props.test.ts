// M1b property tests (docs/design/m1b.md section 8 "Property tests", critique #24): random
// small fights with real compiled content from the repo packs, random-legal deciders on every
// seat, random rule flags (every implemented option of every FLAG_INFO entry), random knobs,
// and the dice audit on (no roll address opens twice, legal keys unique in every list).
//
// The cast: pc1 is always test:sample-druid (spells, zones, concentration, the form, a held
// focus and a shield); the other seats draw from the druid, test:sample-seer (a pre-roll
// reaction), srd:goblin-warrior, srd:guard, test:sample-fighter and (coverage step 9+)
// srd:goblin-boss (Redirect Attack's swap), srd:knight (Parry) and srd:tough (Pack Tactics).
//
// Invariants are checked where the engine promises them:
// - after every event: zone index, live-effect count, resources, HP and budgets, and the weak
//   form of the concentration invariant (an effect's fxStart can precede `u.conc = id`);
// - at quiescent points (each decision, each turn's end) and on the final state: the strong
//   concentration invariant, parents and conditions (an end cascade emits fxEnd before it
//   ends the children, so those only hold between cascades);
// - per event kind: one slot per (caster, turn), one firing of a once-per-turn effect per
//   (effect, creature, turn), and no shared square at the end of a move or a turn;
// - coverage step 9+: no shared square right after a swap, and at most one Reaction per creature
//   between the starts of its own turns (opportunity attacks, pre-roll dice, Parry-style AC,
//   damage-taken and damage-reducing reactions, and Redirect Attack's swap all spend it).
//
// MONTECRIT_SLOW=1 scales every run count up.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { HOOK, type CompiledTemplate, type Content, type Id, type SpellEntry } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, LegalList, UnitView } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { Recorder, RecordingDecider } from '../src/decide/recording.ts';
import { areaCells } from '../src/grid/area.ts';
import { cellName } from '../src/grid/cells.ts';
import { HashSink, type EventSink, type GameEvent } from '../src/log/events.ts';
import type { JournalEntry } from '../src/replay.ts';
import { FLAG_INFO, FLAG_KEYS, type FlagInfo, type RuleFlags } from '../src/rules/flags.ts';
import { boundOf } from '../src/sim/effects.ts';
import { createContext, runFight, type FightResult } from '../src/sim/fight.ts';
import { ITEM, listItems, resolveItem } from '../src/sim/hands.ts';
import type { FightSetup, Knobs } from '../src/sim/setup.ts';
import { COND, HAND, has, type GameState, type QueryState } from '../src/sim/state.ts';
import { setup, type UnitSpec } from './helpers/build.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const runs = (fast: number, slow: number) => (SLOW ? slow : fast);
const TIMEOUT = SLOW ? 900_000 : 30_000;

// ---- content: the real packs, compiled ----

const ROOT = join(import.meta.dirname, '..', '..', '..');
function walk(d: string): string[] {
  return readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
}
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT: Content = loaded.content;
const tpl = (id: string): CompiledTemplate => {
  const t = CONTENT.get(id);
  if (!t) throw new Error(`missing ${id}`);
  return t;
};

const DRUID = tpl('test:sample-druid');
/** Seats after pc1 draw from this; the druid twice, so two casters (overlapping zones, same-spell potency) are common. */
/**
 * Coverage step 9+ appends the Goblin Boss (Redirect Attack: a declare-time reaction and a swap), the
 * Knight (Parry: a hit-known reaction) and the Tough (Pack Tactics: the ally-adjacent gate), so the
 * swap, Parry and the gate meet every invariant below under random play.
 */
const POOL: readonly CompiledTemplate[] = [DRUID, DRUID, tpl('test:sample-seer'), tpl('srd:goblin-warrior'), tpl('srd:guard'), tpl('test:sample-fighter'), tpl('srd:goblin-boss'), tpl('srd:knight'), tpl('srd:tough')];

/** The druid with one more spell entry appended: a V-only bonus-action heal under a fresh id. */
function druidWithExtra(castable: boolean): CompiledTemplate {
  const hw = DRUID.spells.find((e) => e.spell.id === 'srd:healing-word');
  if (!hw || hw.spell.v !== true || hw.spell.s || hw.spell.m !== 'none' || hw.spell.createsInHand) throw new Error('expected a V-only Healing Word on the druid');
  const spell = { ...hw.spell, id: 'test:extra-word' as Id, local: 'extra-word', name: 'Extra Word', sid: 9_999 };
  // Uncastable: a 4th-level spell, and the druid has slots only up to 3rd (and no free pool for it).
  const extra: SpellEntry = castable ? { ...hw, spell } : { ...hw, spell: { ...spell, level: 4 }, freePool: -1, prog: hw.prog.map((p, l) => (l >= 4 ? p : null)) };
  if (!castable && DRUID.resMax.slice(3, 9).some((n) => n > 0)) throw new Error('the druid has a 4th-level slot; pick a higher level');
  return { ...DRUID, spells: [...DRUID.spells, extra] };
}

// ---- random fights ----

const FLAGS = fc.record(
  Object.fromEntries(
    FLAG_KEYS.map((k) => {
      const info: FlagInfo<unknown> = FLAG_INFO[k];
      const ok = info.options.filter((o) => !(info.unimplemented ?? []).includes(o));
      return [k, fc.constantFrom(...ok)];
    }),
  ),
) as unknown as fc.Arbitrary<RuleFlags>;

const PARAMS = fc.record({
  w: fc.integer({ min: 6, max: 10 }),
  h: fc.integer({ min: 3, max: 6 }),
  n: fc.integer({ min: 2, max: 5 }),
  picks: fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { minLength: 5, maxLength: 5 }),
  teams: fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: 5, maxLength: 5 }),
  cells: fc.array(fc.nat(59), { minLength: 5, maxLength: 5 }),
  /** Starting HP as a percentage of the max; 100 = no override. */
  hpPct: fc.array(fc.constantFrom(100, 100, 70, 40, 15), { minLength: 5, maxLength: 5 }),
  walls: fc.array(fc.nat(59), { maxLength: 5 }),
  rough: fc.array(fc.nat(59), { maxLength: 6 }),
  flags: FLAGS,
  maxRounds: fc.integer({ min: 2, max: 8 }),
  downEnds: fc.boolean(),
  attackDowned: fc.constantFrom<Knobs['attackDowned']>('never', 'ifNoOtherTarget', 'always'),
  lossCounts: fc.constantFrom<Knobs['lossCounts']>('pcs', 'party'),
  seed: fc.integer({ min: 0, max: 1_000_000 }),
});
type Params = typeof PARAMS extends fc.Arbitrary<infer T> ? T : never;

function build(p: Params, pc1: CompiledTemplate = DRUID): FightSetup {
  const cells = p.w * p.h;
  const used: number[] = [];
  const units: UnitSpec[] = [];
  for (let i = 0; i < p.n; i++) {
    let c = p.cells[i]! % cells;
    while (used.includes(c)) c = (c + 1) % cells;
    used.push(c);
    const t = i === 0 ? pc1 : POOL[p.picks[i]!]!;
    const pct = p.hpPct[i]!;
    units.push({
      seat: i === 0 ? 'pc1' : `u${i}`,
      team: i === 0 ? 0 : i === 1 ? 1 : p.teams[i]!,
      tpl: t,
      at: cellName(c, p.w),
      hp: pct >= 100 ? undefined : Math.max(1, Math.floor((t.hpMax * pct) / 100)),
      decider: 'random-legal',
    });
  }
  const terrain = Array.from({ length: p.h }, (_, y) =>
    Array.from({ length: p.w }, (_, x) => {
      const c = y * p.w + x;
      if (!used.includes(c) && p.walls.some((v) => v % cells === c)) return '#';
      return p.rough.some((v) => v % cells === c) ? ':' : '.';
    }).join(''),
  );
  return setup({ w: p.w, h: p.h, terrain, units, flags: p.flags, knobs: { maxRounds: p.maxRounds, downEnds: p.downEnds, attackDowned: p.attackDowned, lossCounts: p.lossCounts }, name: 'props' });
}

// ---- invariant checks (each returns a problem description, or null) ----

function checkZones(st: QueryState): string | null {
  const want = new Uint32Array(st.zoneMask.length);
  const cells: number[] = [];
  let live = 0;
  let diff = 0;
  let travel = 0;
  let hook = 0;
  let enter = 0;
  for (const f of st.fx) {
    if (!f.alive) continue;
    live++;
    const te = boundOf(st, f);
    if (!te.zone) {
      if (f.zbit >= 0) return `fx ${f.id} (${te.id}) holds zone slot ${f.zbit} but isn't a zone`;
      continue;
    }
    if (f.zbit < 0 || f.anchor < 0) return `live zone fx ${f.id} (${te.id}) has no slot or anchor`;
    if (st.zoneFx[f.zbit] !== f.id) return `zone slot ${f.zbit} holds ${st.zoneFx[f.zbit]}, not fx ${f.id}`;
    const bit = 1 << f.zbit;
    areaCells(st, te.zone.shapeKey, f.anchor, cells);
    for (const c of cells) want[c] = want[c]! | bit;
    if (te.zone.difficult) diff |= bit;
    for (const h of te.hooks) {
      if (h.on & HOOK.travel) travel |= bit;
      if (h.on & (HOOK.enter | HOOK.turnEndIn)) hook |= bit;
      if (h.on & HOOK.enter) enter |= bit;
    }
  }
  if (live !== st.liveFx) return `liveFx is ${st.liveFx} but ${live} effects are alive`;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id >= 0 && (!st.fx[id]?.alive || st.fx[id]!.zbit !== z)) return `zone slot ${z} names fx ${id}, which is dead or elsewhere`;
  }
  for (let c = 0; c < want.length; c++) {
    if (want[c] !== st.zoneMask[c]) return `zoneMask[${cellName(c, st.setup.w)}] is ${st.zoneMask[c]} but the live zones cover ${want[c]}`;
  }
  if ((diff | 0) !== (st.diffBits | 0)) return `diffBits ${st.diffBits} != ${diff}`;
  if ((travel | 0) !== (st.travelBits | 0)) return `travelBits ${st.travelBits} != ${travel}`;
  if ((hook | 0) !== (st.hookBits | 0)) return `hookBits ${st.hookBits} != ${hook}`;
  if ((enter | 0) !== (st.enterBits | 0)) return `enterBits ${st.enterBits} != ${enter}`;
  return null;
}

function checkUnits(st: QueryState): string | null {
  for (const u of st.units) {
    for (let i = 0; i < u.res.length; i++) {
      if (u.res[i]! < 0) return `${u.seat} res[${i}] is ${u.res[i]}`;
      if (u.res[i]! > u.tpl.resMax[i]!) return `${u.seat} res[${i}] is ${u.res[i]}, above its max ${u.tpl.resMax[i]}`;
    }
    if (u.hp < 0 || u.hp > u.hpMax) return `${u.seat} HP ${u.hp} outside 0..${u.hpMax}`;
    if (u.tempHp < 0) return `${u.seat} temp HP ${u.tempHp}`;
    const b = u.b;
    if (b.action < 0 || b.bonus < 0 || b.reaction < 0 || b.moveFt < 0 || b.freeObj < 0) return `${u.seat} budget went negative: ${JSON.stringify({ a: b.action, b: b.bonus, r: b.reaction, m: b.moveFt, f: b.freeObj })}`;
  }
  return null;
}

/** At most one live concentration effect per unit; u.conc is -1 or a live one it owns. `strong`: and it names that one. */
function checkConc(st: QueryState, strong: boolean): string | null {
  for (const u of st.units) {
    let n = 0;
    let id = -1;
    for (const f of st.fx) {
      if (f.alive && f.owner === u.idx && boundOf(st, f).conc) {
        n++;
        id = f.id;
      }
    }
    if (n > 1) return `${u.seat} has ${n} live concentration effects`;
    if (u.conc !== -1) {
      const f = st.fx[u.conc];
      if (!f || !f.alive || !boundOf(st, f).conc || f.owner !== u.idx) return `${u.seat}.conc = ${u.conc}, not a live concentration effect it owns`;
    }
    if (!strong) continue;
    if (n === 1 && u.conc !== id) return `${u.seat} owns live concentration fx ${id} but u.conc = ${u.conc}`;
    if (u.conc >= 0 && (u.life === 'dead' || has(u, COND.incapacitated))) return `${u.seat} (${u.life}, cond ${u.condMask}) still concentrates on fx ${u.conc}`;
  }
  return null;
}

/** No live effect under a dead parent; no condition tied to a dead effect. */
function checkLinks(st: QueryState): string | null {
  for (const f of st.fx) {
    if (f.alive && f.parent >= 0 && !st.fx[f.parent]!.alive) return `fx ${f.id} (${boundOf(st, f).id}) is alive but its parent fx ${f.parent} is dead`;
  }
  for (const u of st.units) {
    for (const c of u.conds) {
      if (c.until.k === 'effect' && !st.fx[c.until.effect]?.alive) return `${u.seat} keeps condition ${c.bit} (${c.via}) tied to dead fx ${c.until.effect}`;
    }
  }
  return null;
}

// ---- the watcher: an event sink that sees the live state ----

/** Watches one fight. Deciders wrapped in Spy hand it the state at the first decision. */
class Watch implements EventSink {
  st: QueryState | null = null;
  readonly label: string;
  /** Effect ids with a once-per-turn ledger (perCreature). */
  private readonly limited = new Set<string>();
  /** Own turn count (turnStart events). */
  private turn = 0;
  private readonly counts = new Map<string, number>();
  /** Coverage step 9+: Reactions each unit has taken since its own turn last started. */
  private readonly reacts: number[];
  /** Per unit: its features whose 'act' line is a Reaction taken (hitKnown, damageTaken, declared). */
  private readonly reactFeats: Set<string>[];
  /** Per unit: its last move ended on a shared square by being downed (allowed: it never chose to stop there). */
  private readonly sharedOk: boolean[];
  readonly seen = new Map<string, number>();
  ambiguous = 0;
  events = 0;

  constructor(s: FightSetup, label: string) {
    this.label = label;
    this.sharedOk = s.seats.map(() => false);
    this.reacts = s.seats.map(() => 0);
    this.reactFeats = s.seats.map((seat) => new Set(seat.tpl.features.filter((f) => f.hitKnown || f.damageTaken || f.declared).map((f) => f.id as string)));
    for (const seat of s.seats) for (const te of seat.tpl.effects) if (te.limit === 'perCreature') this.limited.add(te.id);
  }

  private fail(e: GameEvent | null, msg: string): never {
    throw new Error(`${this.label}: ${msg}${e ? ` (at event #${e.seq} ${e.k}, round ${e.round}, turn ${this.turn})` : ' (final state)'}`);
  }

  private tally(k: string): void {
    this.seen.set(k, (this.seen.get(k) ?? 0) + 1);
  }

  private bump(e: GameEvent, key: string, max: number, what: string): void {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n > max) this.fail(e, `${what} ${n} times`);
  }

  private quiescent(e: GameEvent | null, st: QueryState): void {
    const p = checkConc(st, true) ?? checkLinks(st);
    if (p) this.fail(e, p);
  }

  private shared(e: GameEvent | null, st: QueryState): void {
    const us = st.units;
    for (let i = 0; i < us.length; i++) {
      for (let j = i + 1; j < us.length; j++) {
        const a = us[i]!;
        const b = us[j]!;
        if (a.life === 'dead' || b.life === 'dead' || a.cell !== b.cell) continue;
        if (!this.sharedOk[i] && !this.sharedOk[j]) this.fail(e, `${a.seat} (${a.life}) and ${b.seat} (${b.life}) share ${cellName(a.cell, st.setup.w)}`);
      }
    }
  }

  /**
   * Which live effect a once-per-turn save or damage event came from: the only live copy of
   * that effect (of that owner, when known). A caster has one live copy at a time (it's
   * concentration), but a recast can replace it mid-turn, so events are keyed by effect id,
   * never by owner. Two casters' copies up at once fall back to the ledger (which one just
   * fired on this creature), or count as ambiguous.
   */
  private firing(st: QueryState, via: string, owner: number, who: number): number {
    const live: number[] = [];
    for (const f of st.fx) if (f.alive && (owner < 0 || f.owner === owner) && boundOf(st, f).id === via) live.push(f.id);
    if (live.length === 1) return live[0]!;
    const hit = live.filter((id) => st.fx[id]!.hit?.[who] === st.turnIdx);
    if (hit.length === 1) return hit[0]!;
    this.ambiguous++;
    return -1;
  }

  /** Coverage step 9+: one more Reaction taken by `who`; at most one between the starts of its own turns. */
  private reacted(e: GameEvent, who: number): void {
    this.tally('reaction');
    if (++this.reacts[who]! > 1) this.fail(e, `unit ${who} took ${this.reacts[who]} Reactions since its turn started`);
  }

  emit(e: GameEvent): void {
    this.events++;
    this.tally(e.k);
    if (e.k === 'turnStart') {
      this.turn++;
      this.reacts[e.who] = 0;
    }
    if (e.k === 'attack' && e.opportunity) this.reacted(e, e.att);
    if (e.k === 'react' || e.k === 'reduce') this.reacted(e, e.who);
    if (e.k === 'act' && this.reactFeats[e.who]!.has(e.via)) {
      this.reacted(e, e.who);
      this.tally(`act:${e.name}`);
    }
    const st = this.st;
    if (st) {
      if (e.k === 'item' && e.act === 'pickup' && st.units[e.who]!.tpl.items.some((i) => i.name === e.item && i.kind === 'shield')) this.tally('item:pickup-shield');
      const p = checkZones(st) ?? checkUnits(st) ?? checkConc(st, false);
      if (p) this.fail(e, p);
    }
    switch (e.k) {
      case 'turnStart':
        if (st && st.turnIdx !== this.turn) this.fail(e, `turnIdx ${st.turnIdx} but ${this.turn} turns started`);
        return;
      case 'cast':
        this.tally(`cast:${e.via}`);
        if (e.lvl > 0 && e.free === null) this.bump(e, `slot|${e.who}|${this.turn}`, 1, `unit ${e.who} spent a spell slot this turn`);
        return;
      case 'save':
        this.tally(`save:${e.purpose}`);
        if (e.purpose === 'save' && this.limited.has(e.via) && st) {
          const fx = this.firing(st, e.via, -1, e.who);
          if (fx >= 0) this.bump(e, `save|${fx}|${e.who}|${this.turn}`, 1, `unit ${e.who} saved against once-per-turn fx ${fx} (${e.via})`);
        }
        return;
      case 'damage':
        this.tally(`damage:${e.via}`);
        if (e.purpose === 'zone' && this.limited.has(e.via) && st) {
          const fx = this.firing(st, e.via, e.src, e.tgt);
          if (fx >= 0) this.bump(e, `dmg|${fx}|${e.tgt}|${this.turn}`, 1, `unit ${e.tgt} took damage from once-per-turn fx ${fx} (${e.via})`);
        }
        return;
      case 'step':
        if (e.forced) this.tally('step:forced');
        return;
      case 'fxEnd':
        this.tally(`fxEnd:${e.why}`);
        return;
      case 'moveEnd': {
        if (!st) return;
        const u = st.units[e.who]!;
        if (u.cell !== e.cell) this.fail(e, `moveEnd says ${cellName(e.cell, st.setup.w)} but ${u.seat} is on ${cellName(u.cell, st.setup.w)}`);
        if (u.life === 'dead') {
          this.sharedOk[e.who] = false;
          return;
        }
        const others = st.units.filter((o) => o !== u && o.life !== 'dead' && o.cell === u.cell);
        // A walk refused on its first step never left its square: it ends no move anywhere new.
        const exempt = e.why === 'downed' || e.why === 'died' || e.why === 'ended' || e.steps === 0;
        if (others.length > 0 && !exempt) {
          this.fail(e, `${u.seat}'s ${e.forced ?? 'voluntary'} move ended (${e.why}) on ${cellName(u.cell, st.setup.w)}, shared with ${others.map((o) => `${o.seat} (${o.life})`).join(', ')}`);
        }
        this.sharedOk[e.who] = others.length > 0;
        return;
      }
      case 'decided':
        if (st) this.quiescent(e, st);
        return;
      case 'turnEnd':
        if (!st) return;
        this.quiescent(e, st);
        this.shared(e, st);
        return;
      case 'swap':
        // Coverage step 9+: two creatures trade squares; no one else stands on either.
        if (!st) return;
        if (st.units[e.who]!.cell !== e.to || st.units[e.with]!.cell !== e.from) this.fail(e, `swap event ${e.from}<->${e.to} doesn't match the units' cells`);
        this.shared(e, st);
        return;
    }
  }

  finish(st: QueryState): void {
    this.st = st;
    const p = checkZones(st) ?? checkUnits(st) ?? checkConc(st, true) ?? checkLinks(st);
    if (p) this.fail(null, p);
    this.shared(null, st);
  }
}

/** Hands the watcher the live state, then lets the wrapped decider answer. */
class Spy implements Decider {
  readonly name: string;
  private readonly inner: Decider;
  private readonly watch: Watch;
  constructor(inner: Decider, watch: Watch) {
    this.inner = inner;
    this.watch = watch;
    this.name = inner.name;
  }
  get lastBy(): string {
    return this.inner.lastBy ?? this.inner.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    this.watch.st = view.q;
    return this.inner.decide(view, dp);
  }
}

/** Calls every query many times per decision, on arguments drawn from the legal list and at random; then answers like RandomLegalDecider. */
class Nosy implements Decider {
  readonly name = 'random-legal';
  private readonly inner = new RandomLegalDecider();
  private readonly reps: number;
  private x: number;
  constructor(reps: number, salt: number) {
    this.reps = reps;
    this.x = (salt * 2654435761 + 1) >>> 0;
  }
  /** Test-side LCG: never touches the fight's dice. */
  private rand(n: number): number {
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0;
    return this.x % n;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const q = view.queries;
    const us = view.q.units;
    const cells = view.q.setup.w * view.q.setup.h;
    const me = us[dp.who]!;
    const probe = (a: number, t: number, from: number) => {
      q.distFt(from, us[t]!.cell);
      const atks = us[a]!.tpl.attacks.length;
      if (a === t || atks === 0) return;
      const ai = this.rand(atks);
      q.attackSpec(a, ai, t, from);
      q.odds(a, ai, t, from);
    };
    for (let r = 0; r < this.reps; r++) {
      for (let i = 0; i < dp.legal.n; i++) {
        const l = dp.legal.items[i]!;
        const from = (l.k === 'move' || l.k === 'pull') && l.cell >= 0 ? l.cell : me.cell;
        q.distFt(me.cell, from);
        probe(dp.who, l.target >= 0 ? l.target : this.rand(us.length), from);
        if (l.target >= 0) probe(l.target, dp.who, us[l.target]!.cell);
      }
      for (const a of us) for (const t of us) probe(a.idx, t.idx, this.rand(4) === 0 ? this.rand(cells) : a.cell);
    }
    return this.inner.decide(view, dp);
  }
}

// ---- runners ----

function watched(s: FightSetup, seed: number, wrap: (d: Decider) => Decider = (d) => d): Watch {
  const watch = new Watch(s, `seed ${seed}`);
  runFight(s, seed, 0, makeDeciders(s).map((d) => new Spy(wrap(d), watch)), watch, { audit: true, inspect: (st) => watch.finish(st) });
  return watch;
}

function hashed(s: FightSetup, seed: number, ds?: Decider[]): { r: FightResult; h: string } {
  const h = new HashSink();
  const r = runFight(s, seed, 0, ds ?? makeDeciders(s), h, { audit: true });
  return { r, h: h.hex() };
}

function record(s: FightSetup, seed: number): { r: FightResult; h: string; journal: JournalEntry[] } {
  const rec = new Recorder();
  const { r, h } = hashed(s, seed, makeDeciders(s).map((d) => new RecordingDecider(d, rec)));
  return { r, h, journal: rec.entries };
}

/** The same fight with every seat answering only from `journal` (no fallback). */
function replay(s: FightSetup, seed: number, journal: JournalEntry[], wrap: (d: Decider) => Decider = (d) => d): { r: FightResult; h: string } {
  const js: FightSetup = { ...s, seats: s.seats.map((x) => ({ ...x, decider: 'journal', fallback: null })) };
  return hashed(js, seed, makeDeciders(js, journal).map(wrap));
}

/** Runs `before` on the live state just before the wrapped decider answers decision `at`. */
class Saboteur implements Decider {
  readonly name: string;
  private readonly inner: Decider;
  private readonly at: number;
  private readonly before: (st: GameState, dp: DecisionPoint) => void;
  constructor(inner: Decider, at: number, before: (st: GameState, dp: DecisionPoint) => void) {
    this.inner = inner;
    this.at = at;
    this.before = before;
    this.name = inner.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    if (dp.at === this.at) this.before(view.q as GameState, dp);
    return this.inner.decide(view, dp);
  }
}

/** Counts the decisions whose legal list offers a key starting with `prefix`, then lets the wrapped decider answer. */
class Peek implements Decider {
  readonly name: string;
  private readonly inner: Decider;
  private readonly prefix: string;
  hits = 0;
  constructor(inner: Decider, prefix: string) {
    this.inner = inner;
    this.prefix = prefix;
    this.name = inner.name;
  }
  get lastBy(): string {
    return this.inner.lastBy ?? this.inner.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    for (let i = 0; i < dp.legal.n; i++) {
      if (dp.keyOf(i).startsWith(this.prefix)) {
        this.hits++;
        break;
      }
    }
    return this.inner.decide(view, dp);
  }
}

// ---- the properties ----

describe('M1b properties of random fights (real content, random-legal deciders, random flags, dice audit on)', () => {
  it('invariants hold after every event: concentration, effect links, zone index, resources, slots, once-per-turn, HP, shared squares', { timeout: TIMEOUT }, () => {
    fc.assert(
      fc.property(PARAMS, (p) => {
        watched(build(p), p.seed);
      }),
      { numRuns: runs(300, 3000) },
    );
  });

  it('the generator reaches the effect paths (casts, zones, concentration saves, pulls, reactions, the form)', { timeout: TIMEOUT }, () => {
    const seen = new Map<string, number>();
    let ambiguous = 0;
    fc.assert(
      fc.property(PARAMS, (p) => {
        const w = watched(build(p), p.seed);
        for (const [k, n] of w.seen) seen.set(k, (seen.get(k) ?? 0) + n);
        ambiguous += w.ambiguous;
      }),
      { numRuns: 120, seed: 1101 },
    );
    const n = (k: string) => seen.get(k) ?? 0;
    expect(n('cast:srd:moonbeam')).toBeGreaterThan(10);
    expect(n('cast:srd:spike-growth')).toBeGreaterThan(10);
    expect(n('cast:srd:healing-word')).toBeGreaterThan(5);
    expect(n('cast:test:tether')).toBeGreaterThan(5);
    expect(n('zone')).toBeGreaterThan(20);
    expect(n('zoneMove')).toBeGreaterThan(0);
    expect(n('save:save')).toBeGreaterThan(10);
    expect(n('save:conc')).toBeGreaterThan(5);
    expect(n('step:forced')).toBeGreaterThan(0);
    expect(n('react')).toBeGreaterThan(0);
    // Coverage step 9+: the swap, Parry and Pack Tactics' Advantage are reached too.
    expect(n('swap')).toBeGreaterThan(0);
    expect(n('act:Parry')).toBeGreaterThan(0);
    expect(n('fxEnd:newConcentration') + n('fxEnd:concentration')).toBeGreaterThan(0);
    expect(n('fxEnd:parent')).toBeGreaterThan(0);
    // Two druids with a once-per-turn zone each up at once can't be told apart from a save event; keep that rare.
    expect(ambiguous).toBeLessThan(Math.max(5, n('save:save') / 10));
  });

  it('the same replay key gives the same log hash; logging on or off gives the same final state', { timeout: TIMEOUT }, () => {
    fc.assert(
      fc.property(PARAMS, (p) => {
        const s = build(p);
        const a = hashed(s, p.seed);
        const b = hashed(s, p.seed);
        expect(b.h).toBe(a.h);
        const silent = runFight(s, p.seed, 0, makeDeciders(s), null, { audit: true });
        expect(silent.stateHash).toBe(a.r.stateHash);
        expect(silent.seq).toBe(a.r.seq);
      }),
      { numRuns: runs(60, 1000) },
    );
  });

  it('a recorded journal replays identically', { timeout: TIMEOUT }, () => {
    fc.assert(
      fc.property(PARAMS, (p) => {
        const s = build(p);
        const a = record(s, p.seed);
        const b = replay(s, p.seed, a.journal);
        expect(b.h).toBe(a.h);
        expect(b.r.stateHash).toBe(a.r.stateHash);
      }),
      { numRuns: runs(60, 1000) },
    );
  });

  it("a decider that calls every query many times per decision gives the same log hash as one that calls none", { timeout: TIMEOUT }, () => {
    fc.assert(
      fc.property(PARAMS, (p) => {
        const s = build(p);
        const plain = hashed(s, p.seed);
        const nosy = hashed(s, p.seed, s.seats.map((_, i) => new Nosy(SLOW ? 20 : 3, p.seed + i)));
        expect(nosy.h).toBe(plain.h);
        expect(nosy.r.flagsUsed).toEqual(plain.r.flagsUsed);
      }),
      { numRuns: runs(30, 400) },
    );
  });

  it('common random numbers: a spell pc1 can never cast (a 4th-level entry, no 4th-level slot) changes nothing', { timeout: TIMEOUT }, () => {
    const variant = druidWithExtra(false);
    fc.assert(
      fc.property(PARAMS, (p) => {
        const a = hashed(build(p), p.seed);
        const b = hashed(build(p, variant), p.seed);
        expect(b.h).toBe(a.h);
        expect(b.r.stateHash).toBe(a.r.stateHash);
      }),
      { numRuns: runs(40, 500) },
    );
  });

  it('common random numbers: a spell pc1 is offered but never casts changes no die (the base fight\'s journal replayed on the variant)', { timeout: TIMEOUT }, () => {
    const variant = druidWithExtra(true);
    let offered = 0;
    fc.assert(
      fc.property(PARAMS, (p) => {
        const a = record(build(p), p.seed);
        const peeks: Peek[] = [];
        const b = replay(build(p, variant), p.seed, a.journal, (d) => {
          const k = new Peek(d, 'cast:extra-word@');
          peeks.push(k);
          return k;
        });
        expect(b.h).toBe(a.h);
        expect(b.r.stateHash).toBe(a.r.stateHash);
        offered += peeks.reduce((n, k) => n + k.hits, 0);
      }),
      { numRuns: runs(40, 500) },
    );
    expect(offered).toBeGreaterThan(10);
  });

  it('the watcher sees the live state and flags a corrupted one (keeps the properties from passing vacuously)', { timeout: TIMEOUT }, () => {
    const s = setup({
      w: 8, h: 4, flags: { initiativeMode: 'static' },
      units: [
        { seat: 'pc1', team: 0, tpl: DRUID, at: 'A1', decider: 'random-legal' },
        { seat: 'u1', team: 1, tpl: POOL[3]!, at: 'H4', decider: 'random-legal' },
        { seat: 'u2', team: 1, tpl: POOL[4]!, at: 'H1', decider: 'random-legal' },
      ],
    });
    const cases: [string, (st: GameState, dp: DecisionPoint) => void, RegExp][] = [
      ['zone index', (st) => (st.zoneMask[3] = st.zoneMask[3]! ^ (1 << 9)), /zoneMask\[D1\]/],
      ['live count', (st) => st.liveFx++, /liveFx is 1 but 0/],
      ['resources', (st) => (st.units[0]!.res[0] = -1), /pc1 res\[0\] is -1/],
      ['HP', (st) => (st.units[0]!.hp = st.units[0]!.hpMax + 1), /pc1 HP 46 outside/],
      ['concentration', (st) => (st.units[0]!.conc = 77), /pc1\.conc = 77/],
      [
        'shared square',
        (st, dp) => {
          const [a, b] = st.units.filter((u) => u.idx !== dp.who);
          b!.cell = a!.cell;
        },
        /share [A-H][1-4]/,
      ],
    ];
    for (const [what, sabotage, msg] of cases) {
      expect(() => watched(s, 5, (d) => new Saboteur(d, 0, sabotage)), what).toThrow(msg);
    }
    expect(() => watched(s, 5)).not.toThrow();
  });
});

// ---- engine bugs these properties found, kept as regressions ----

describe('regressions found by these properties', () => {
  // Picking up a dropped shield was offered with only the free object interaction left, but a
  // shield in hand is a donned shield (the Utilize action): with the Action spent it went to
  // -1, and every Action check is `action === 0`, so the creature got unlimited Actions that
  // turn. Found by the budget invariant (seed 362176: a druid downed by its ally's Spike Growth
  // drops its shield, is healed, Dashes, picks the shield up, then casts four times).
  it('picking up a dropped shield needs the Action, and never drives a budget negative', () => {
    const s = setup({ w: 4, h: 1, units: [{ seat: 'pc1', team: 0, tpl: DRUID, at: 'A1' }, { seat: 'u1', team: 1, tpl: tpl('srd:goblin-warrior'), at: 'D1' }] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null, { audit: true });
    const u = cx.st.units[0]!;
    const shield = u.tpl.items.findIndex((i) => i.kind === 'shield');
    const hand = u.hands[0] === shield ? 0 : 1;
    expect(u.hands[hand]).toBe(shield);
    u.hands[hand] = HAND.empty; // dropped at its feet (as when it fell Unconscious)
    u.dropped[shield] = u.cell;
    u.b.action = 0; // spent (a Dash)
    u.b.freeObj = 1;
    const list: LegalList = { n: 0, items: [] };
    listItems(cx.st, u, list);
    const offered = list.items.slice(0, list.n).find((l) => l.opt === shield && l.aux === ITEM.pickup);
    expect(offered).toBeUndefined(); // no Action left: not offered
    if (offered) resolveItem(cx, u, shield, ITEM.pickup, -1);
    expect(u.b.action).toBeGreaterThanOrEqual(0);
    expect(u.b.freeObj).toBeGreaterThanOrEqual(0);
  });

  // A voluntary walk that stops on learning of a hidden zone (coverage step 9) stopped on an
  // ally's square it was passing through, so two creatures shared it. Found by the shared-squares
  // invariant under test:slow (fast-check seed 1144546046, shrunk); the walk now stops on the
  // first free square of its path.
  it('a walk that learns of a hidden zone never stops on an occupied square', () => {
    const p = {"w":6,"h":3,"n":3,"picks":[0,2,0,0,0],"teams":[0,0,1,0,0],"cells":[10,0,0,0,0],"hpPct":[100,100,100,100,100],"walls":[3,50,26],"rough":[],"flags":{"natOnChecksAndSaves":"none","expandedCritAutoHits":false,"diagonalCost":"uniform","diagonalCorner":"bothBlock","initiativeMode":"roll","initiativeTies":"rollOff","groupInitiative":"shared","monsterHp":"listed","statBlockAtZeroHp":"dies","corpseSpace":"clear","moveBetweenAttacks":"all","monsterThrownWeapons":"gearCount","tempHpSoakAtZeroIsDamage":true,"pauseInOccupiedSpace":false,"focusHandSomatic":"strict","conjuredHandEffectBlocksHand":false,"concentrationSaveGrouping":"perDamageEvent","concentrationSaveOnZeroDamage":"noSave","timedDurationExpiryPoint":"startOfCreatorTurn","deadAnchorTurnBoundary":"keepInitiativeSlot","nextRollRiderConsumedWhenRedundant":"consumed","selfTargetWhenTextSilent":"notAllowed","areaOriginOnGrid":"squareCenter","areaGridCoverage":"atLeastHalfSquare","areaSaveGroupingPerEvent":"groupByEvent","movedAreaTriggersAlongPath":"sweepPath","involuntaryMovementTriggersArea":true,"perDistanceDamageRolls":"perIncrement","areaExitStepCounts":false,"forcedMovementPath":"eachStepCloser","forcedMovementObstacle":"stopBefore","forcedMovementTerrainCost":"ignoresTerrain","losingSpellSourceEndsActiveSpell":true,"unconsciousDropsShield":true,"zoneKnowledge":"sawCast","flyingAvoidsGroundZones":false,"riderDiceCritDouble":true,"reduceBeforeResistance":true,"losMethod":"centers","creatureCover":"on","splitActions":"allowed","selfAreaOrigin":"squareCenter","emanationReach":"gridDistance","emanationCastTrigger":"none","searchSkill":"best","hiddenHazardRevealedByDamage":true,"hiddenHazardPartialViewCountsAsSeen":false,"swapProvokesOpportunityAttacks":false,"freeMoveUsesMovement":false,"frenzyRageCheck":"declaration","thrownWeaponLands":"targetSquare"},"maxRounds":6,"downEnds":false,"attackDowned":"never","lossCounts":"pcs","seed":155054} as Params;
    expect(() => watched(build(p), p.seed)).not.toThrow();
  });

  // The same walk planned without the camouflaged Difficult Terrain it doesn't know of, ran out of
  // movement on an ally's square partway (fast-check seed 314648915, shrunk); it now steps into an
  // occupied square only if the true cost still reaches a free square beyond it.
  it('a walk planned without a hidden zone never runs out of movement on an occupied square', () => {
    const p = {"w":10,"h":5,"n":3,"picks":[0,0,0,0,0],"teams":[0,0,0,0,0],"cells":[30,56,30,0,0],"hpPct":[100,100,100,100,100],"walls":[43,26],"rough":[22,56,16],"flags":{"natOnChecksAndSaves":"none","expandedCritAutoHits":false,"diagonalCost":"alternate","diagonalCorner":"bothBlock","initiativeMode":"static","initiativeTies":"rollOff","groupInitiative":"shared","monsterHp":"listed","statBlockAtZeroHp":"dies","corpseSpace":"clear","moveBetweenAttacks":"all","monsterThrownWeapons":"gearCount","tempHpSoakAtZeroIsDamage":true,"pauseInOccupiedSpace":false,"focusHandSomatic":"strict","conjuredHandEffectBlocksHand":false,"concentrationSaveGrouping":"perDamageEvent","concentrationSaveOnZeroDamage":"noSave","timedDurationExpiryPoint":"startOfCreatorTurn","deadAnchorTurnBoundary":"keepInitiativeSlot","nextRollRiderConsumedWhenRedundant":"consumed","selfTargetWhenTextSilent":"notAllowed","areaOriginOnGrid":"squareCenter","areaGridCoverage":"squareCenterInside","areaSaveGroupingPerEvent":"groupByEvent","movedAreaTriggersAlongPath":"sweepPath","involuntaryMovementTriggersArea":true,"perDistanceDamageRolls":"perMove","areaExitStepCounts":false,"forcedMovementPath":"eachStepCloser","forcedMovementObstacle":"stopBefore","forcedMovementTerrainCost":"ignoresTerrain","losingSpellSourceEndsActiveSpell":false,"unconsciousDropsShield":true,"zoneKnowledge":"sawCast","flyingAvoidsGroundZones":false,"riderDiceCritDouble":true,"reduceBeforeResistance":true,"losMethod":"centers","creatureCover":"on","splitActions":"allowed","selfAreaOrigin":"squareCenter","emanationReach":"gridDistance","emanationCastTrigger":"none","searchSkill":"best","hiddenHazardRevealedByDamage":true,"hiddenHazardPartialViewCountsAsSeen":false,"swapProvokesOpportunityAttacks":false,"freeMoveUsesMovement":false,"frenzyRageCheck":"declaration","thrownWeaponLands":"targetSquare"},"maxRounds":2,"downEnds":false,"attackDowned":"never","lossCounts":"pcs","seed":827447} as Params;
    expect(() => watched(build(p), p.seed)).not.toThrow();
  });
});
