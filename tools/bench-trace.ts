// Loop-health counters for the smoke corpus and the class bench (docs/design/coverage.md C0, H,
// G4's "stalemate by cause", m10). A light event sink: it reads the events a fight emits and
// keeps only integers per watched unit and per round, so a run with it decides exactly as a run
// without one (the engine's counters test proves a sink changes nothing). Tooling only: it never
// touches the engine, and every count comes from the event log or the finished state.
//
// Stalemate causes (only when a fight hits the round cap). The engine's own cause decides
// (FightResult.stalemateCause, sim/state.ts stalemateCauseOf: dodge-loop for any PC still up on a
// Dodge streak, then downed-unrescued, no-damage, round-cap), so the bench and the engine agree by
// construction (stalemate-plan.md 4.3). Only downed-unrescued is split, three ways; every kind is
// still a stalemate for H:
//   downed-heals-spent    no up party member holds a heal for another creature with a use left
//   downed-fell-too-late  one does, but no such member has had a turn since a downed member's fall
//   downed-rescue-missed  an up party member with a heal use left has had a turn since a
//                         still-downed member's latest fall
// The split reads the finished GameState: pass `{ inspect: sink.inspect }` to runFight.

import type { EventSink, FightResult, GameEvent, GameState, Life, Unit } from '../packages/engine/src/index.ts';
import { healReach } from '../packages/engine/src/decide/greedy/value.ts';

/** The bench's stalemate causes: the engine's four, with downed-unrescued split three ways (stalemate-plan.md 4.3). */
export const BENCH_CAUSES = ['dodge-loop', 'downed-heals-spent', 'downed-fell-too-late', 'downed-rescue-missed', 'no-damage', 'round-cap'] as const;
export type BenchCause = (typeof BENCH_CAUSES)[number];
export type DownedKind = Extract<BenchCause, `downed-${string}`>;
/** A zero count for every cause, in BENCH_CAUSES order. */
export const noCauses = (): Record<BenchCause, number> => ({ 'dodge-loop': 0, 'downed-heals-spent': 0, 'downed-fell-too-late': 0, 'downed-rescue-missed': 0, 'no-damage': 0, 'round-cap': 0 });

/** Per watched unit, for one fight. */
export interface UnitTrace {
  /** Turns it started with HP above 0. */
  turnsUp: number;
  /** Of those, turns it took the Dodge action (an `act` of core:dodge on its turn). */
  dodges: number;
  /** Dodge flags of its up turns in order (1 = Dodged), for the streak. */
  readonly dodgeSeq: number[];
  /** Attack rolls it made (opportunity attacks included) and spells it cast. */
  attacks: number;
  casts: number;
  /** Turn decisions that were an item action (draw, stow, drop, pick up). */
  itemDecisions: number;
  /** `act` event vias it used, with counts. */
  readonly acts: Map<string, number>;
  /** `cast` events: spell via -> count, and the leveled ones. */
  readonly spells: Map<string, number>;
  leveledCasts: number;
  /** Damage it dealt per round (index = round), to anyone, and to `focus` only. */
  readonly dealt: number[];
  readonly dealtFocus: number[];
  /** First round it dealt damage to `focus` (0 = never). */
  firstFocusRound: number;
  /** Review R2: the first round of each `act` via and each `cast` spell (U's "by round 2"). */
  readonly firstActRound: Map<string, number>;
  readonly firstCastRound: Map<string, number>;
  /** Review R2: its up turns from round 2 on, and of those the ones it started with an effect from an `upVias` source on it. */
  turnsAfterR1: number;
  upTurnsAfterR1: number;
  /** Review R2, recorded for the rate rules (not read by a verdict yet): its critical hits, and its turns with at least one hit. */
  crits: number;
  hitTurns: number;
  /** Review R4: rounds in which it cast a leveled spell (index = round, 1 = yes), and its damage to `focus` from leveled spells per round. */
  readonly leveledRounds: number[];
  readonly dealtFocusLeveled: number[];
  /**
   * W1 (w1-plan.md 4.1): turns (any creature's, each counted once) on which it hit with an attack
   * roll, the denominator of the Rogue's ungated qualifying share.
   */
  hitTurnsAll: number;
  /** W1: damage to `focus` per round credited to a `shareRiders` rider (its value per use, capped by what that hit dealt). */
  readonly riderDealtFocus: number[];
}

function newUnitTrace(): UnitTrace {
  return {
    turnsUp: 0, dodges: 0, dodgeSeq: [], attacks: 0, casts: 0, itemDecisions: 0, acts: new Map(), spells: new Map(), leveledCasts: 0, dealt: [], dealtFocus: [], firstFocusRound: 0,
    firstActRound: new Map(), firstCastRound: new Map(), turnsAfterR1: 0, upTurnsAfterR1: 0, crits: 0, hitTurns: 0, leveledRounds: [], dealtFocusLeveled: [],
    hitTurnsAll: 0, riderDealtFocus: [],
  };
}

/** W1: a rider whose damage to `focus` is credited (the Barbarian's Rage Damage): its `act` (via, name) and its value per use. */
export interface ShareRider {
  readonly via: string;
  readonly name: string;
  readonly value: number;
}

/**
 * Is an effect with this `fxStart` via from one of these features (W1, w1-plan.md 4.1)? An effect's
 * via is `<feature id>/<effect local>` (sim/effects.ts), so a feature id matches as the prefix
 * `<id>/`; a bare id never comes from an effect, and `srd:x/rage-damage/y` is not `srd:x/rage`.
 */
export function viaFromFeature(via: string, features: ReadonlySet<string>): boolean {
  const slash = via.lastIndexOf('/');
  for (let i = slash; i > 0; i = via.lastIndexOf('/', i - 1)) if (features.has(via.slice(0, i))) return true;
  return false;
}

/**
 * Collects a fight's loop-health trace. `watch` are the unit indices to trace (the PC side),
 * `team` each unit's team (0 party, 1 enemies, as FightSetup seats carry it), `focus` the unit whose received damage is tracked (a dummy), or -1,
 * `upVias` the features whose effects' uptime is counted on a watched unit (the Barbarian's Rage:
 * its effects' vias are `srd:barbarian/rage/<local>`), `shareRiders` the riders whose damage to
 * `focus` is credited (W1: the Rage Damage share). Call `reset()` before each fight (or make a new one).
 */
export class TraceSink implements EventSink {
  readonly units: Map<number, UnitTrace> = new Map();
  /** Damage dealt per round by any unit (index = round). */
  readonly anyDamage: number[] = [];
  private turnOf = -1;
  private turnDodged = false;
  private turnHit = false;
  /** Live effects from an `upVias` source: fx -> bearer. */
  private readonly upFx = new Map<number, number>();
  /** Spell vias seen cast at a level above 0 (their damage is leveled-spell damage). */
  private readonly leveledVias = new Set<string>();
  /** W1: turn starts seen (each turn's number), the last turn each watched unit hit on, and a share rider's value used on a hit whose damage is next. */
  private turnNo = 0;
  private readonly lastHitTurn = new Map<number, number>();
  private readonly pendingShare = new Map<number, number>();
  /** Stalemate split (plan 4.3), per unit: the seq of its latest `down`, and of its latest turn begun with HP above 0 (-1 = none). */
  readonly lastDown: number[] = [];
  readonly lastUpTurn: number[] = [];
  /** The finished fight's state, from runFight's `inspect` (null until a fight hands it over). */
  endState: GameState | null = null;
  /** Pass as runFight's `{ inspect }`: keeps the finished state for the downed split (behaviour-neutral: it only reads). */
  readonly inspect = (st: GameState): void => {
    this.endState = st;
  };
  readonly watch: readonly number[];
  readonly team: readonly number[];
  readonly focus: number;
  readonly upVias: ReadonlySet<string>;
  readonly shareRiders: ReadonlyMap<string, number>;
  constructor(watch: readonly number[], team: readonly number[], focus: number, upVias: readonly string[] = [], shareRiders: readonly ShareRider[] = []) {
    this.watch = watch;
    this.team = team;
    this.focus = focus;
    this.upVias = new Set(upVias);
    this.shareRiders = new Map(shareRiders.map((r) => [`${r.via}\u0000${r.name}`, r.value]));
    this.reset();
  }
  reset(): void {
    this.units.clear();
    for (const u of this.watch) this.units.set(u, newUnitTrace());
    this.anyDamage.length = 0;
    this.turnOf = -1;
    this.turnDodged = false;
    this.turnHit = false;
    this.upFx.clear();
    this.leveledVias.clear();
    this.turnNo = 0;
    this.lastHitTurn.clear();
    this.pendingShare.clear();
    this.lastDown.length = 0;
    this.lastUpTurn.length = 0;
    for (let i = 0; i < this.team.length; i++) {
      this.lastDown.push(-1);
      this.lastUpTurn.push(-1);
    }
    this.endState = null;
  }
  private closeTurn(): void {
    if (this.turnOf < 0) return;
    const t = this.units.get(this.turnOf);
    if (t) {
      t.dodgeSeq.push(this.turnDodged ? 1 : 0);
      if (this.turnDodged) t.dodges++;
      if (this.turnHit) t.hitTurns++;
    }
    this.turnOf = -1;
    this.turnDodged = false;
    this.turnHit = false;
  }
  /** A via cast at a level above 0, or a part of one ('<spell id>/<part>'). */
  private isLeveledVia(via: string): boolean {
    const slash = via.indexOf('/', 4);
    return this.leveledVias.has(via) || (slash > 0 && this.leveledVias.has(via.slice(0, slash)));
  }
  emit(e: GameEvent): void {
    switch (e.k) {
      case 'turnStart': {
        this.closeTurn();
        this.turnNo++;
        if (e.hp > 0) this.lastUpTurn[e.who] = e.seq;
        const t = this.units.get(e.who);
        if (t && e.hp > 0) {
          t.turnsUp++;
          this.turnOf = e.who;
          if (e.round >= 2) {
            t.turnsAfterR1++;
            for (const b of this.upFx.values()) {
              if (b === e.who) {
                t.upTurnsAfterR1++;
                break;
              }
            }
          }
        }
        return;
      }
      case 'fxStart':
        if (this.units.has(e.bearer) && viaFromFeature(e.via, this.upVias)) this.upFx.set(e.fx, e.bearer);
        return;
      case 'fxEnd':
        this.upFx.delete(e.fx);
        return;
      case 'turnEnd':
        if (e.who === this.turnOf) this.closeTurn();
        return;
      case 'act': {
        const t = this.units.get(e.who);
        if (!t) return;
        t.acts.set(e.via, (t.acts.get(e.via) ?? 0) + 1);
        if (!t.firstActRound.has(e.via)) t.firstActRound.set(e.via, e.round);
        if (e.via === 'core:dodge' && e.who === this.turnOf) this.turnDodged = true;
        // A leveled spell's own action on a later turn (Move Moonbeam: 'srd:moonbeam/beam') spends
        // the round on that spell, so the round isn't a cantrip round either (step 7 row review).
        if (this.isLeveledVia(e.via)) t.leveledRounds[e.round] = 1;
        // W1: a share rider used on a hit (an automatic rider's act comes after the hit, before its damage).
        if (this.shareRiders.size > 0) {
          const v = this.shareRiders.get(`${e.via}\u0000${e.name}`);
          if (v !== undefined) this.pendingShare.set(e.who, (this.pendingShare.get(e.who) ?? 0) + v);
        }
        return;
      }
      case 'attack': {
        const t = this.units.get(e.att);
        if (!t) return;
        t.attacks++;
        if (e.crit) t.crits++;
        if (e.hit && e.att === this.turnOf) this.turnHit = true;
        if (e.hit && this.lastHitTurn.get(e.att) !== this.turnNo) {
          this.lastHitTurn.set(e.att, this.turnNo);
          t.hitTurnsAll++;
        }
        return;
      }
      case 'cast': {
        const t = this.units.get(e.who);
        if (!t) return;
        t.casts++;
        t.spells.set(e.via, (t.spells.get(e.via) ?? 0) + 1);
        if (!t.firstCastRound.has(e.via)) t.firstCastRound.set(e.via, e.round);
        if (e.lvl > 0) {
          t.leveledCasts++;
          t.leveledRounds[e.round] = 1;
          this.leveledVias.add(e.via);
        }
        return;
      }
      case 'precast':
        if (e.lvl > 0) this.leveledVias.add(e.via);
        return;
      case 'decided': {
        if (e.dk !== 'turn' || !e.key.startsWith('item:')) return;
        const t = this.units.get(e.who);
        if (t) t.itemDecisions++;
        return;
      }
      case 'damage': {
        // W1: the hit's damage instance carries the share rider's extra damage (joined to the attack's).
        const share = this.pendingShare.size > 0 ? (this.pendingShare.get(e.src) ?? 0) : 0;
        if (share > 0) this.pendingShare.delete(e.src);
        if (e.dealt <= 0) return;
        this.anyDamage[e.round] = (this.anyDamage[e.round] ?? 0) + e.dealt;
        const t = this.units.get(e.src);
        if (!t) return;
        if (share > 0 && e.tgt === this.focus) t.riderDealtFocus[e.round] = (t.riderDealtFocus[e.round] ?? 0) + Math.min(share, e.dealt);
        t.dealt[e.round] = (t.dealt[e.round] ?? 0) + e.dealt;
        if (e.tgt === this.focus) {
          t.dealtFocus[e.round] = (t.dealtFocus[e.round] ?? 0) + e.dealt;
          if (t.firstFocusRound === 0) t.firstFocusRound = e.round;
          // A leveled spell's zone or sub-effect deals damage under '<spell id>/<part>' (Moonbeam's
          // beam: 'srd:moonbeam/beam'), so the spell id before the '/' counts too (second review).
          if (this.isLeveledVia(e.via)) t.dealtFocusLeveled[e.round] = (t.dealtFocusLeveled[e.round] ?? 0) + e.dealt;
        }
        return;
      }
      case 'down':
        this.lastDown[e.who] = e.seq;
        return;
      case 'fightEnd':
        this.closeTurn();
        return;
      default:
        return;
    }
  }
}

/** The trailing run of Dodged turns. */
export function dodgeStreak(seq: readonly number[]): number {
  let n = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i] === 1; i--) n++;
  return n;
}

/**
 * Does `u` hold a heal for another creature with a use left (stalemate-plan.md 4.3)? A spell or
 * feature activation whose program can heal someone else (`healReach >= 0`, value.ts), with a
 * cantrip, a free use, a slot of its level or above, or its pool cost left. Gates, hands and
 * components aren't read: this asks what is left, not what is legal now.
 */
export function holdsHeal(u: Pick<Unit, 'tpl' | 'res'>): boolean {
  const res = u.res;
  for (const e of u.tpl.spells) {
    const lv = e.spell.level;
    const prog = e.prog[lv] ?? e.prog.find((p) => p);
    if (!prog || healReach(prog) < 0) continue;
    if (lv === 0) return true;
    if (e.freePool >= 0 && res[e.freePool]! > 0) return true;
    if (e.slotted) for (let l = lv; l <= 9; l++) if (res[l - 1]! > 0) return true;
  }
  for (const f of u.tpl.features) {
    if (!f.activate) continue;
    for (const a of [f.activate, ...(f.more ?? [])]) {
      if (healReach(a.steps) < 0) continue;
      if (a.pool < 0 || res[a.pool]! >= (a.poolCost ?? 1)) return true;
    }
  }
  return false;
}

/**
 * Which kind of downed-unrescued (plan 4.3), from the end: `life` and `team` per unit (party =
 * team 0, as the engine reads it), each unit's latest fall and latest up turn (event seqs, -1 =
 * none), and `heals(i)` = unit i holds a heal with a use left. Rescue missed: some up party member
 * that heals had a turn after a still-downed member's latest fall. Fell too late: such a healer is
 * up, but none had a turn since. Heals spent: no up party member holds a heal.
 */
export function downedKind(life: readonly Life[], team: readonly number[], lastDown: readonly number[], lastUpTurn: readonly number[], heals: (i: number) => boolean): DownedKind {
  let healer = false;
  for (let h = 0; h < life.length; h++) {
    if (team[h] !== 0 || life[h] !== 'up' || !heals(h)) continue;
    healer = true;
    for (let d = 0; d < life.length; d++) if (team[d] === 0 && life[d] === 'down' && lastUpTurn[h]! > lastDown[d]!) return 'downed-rescue-missed';
  }
  return healer ? 'downed-fell-too-late' : 'downed-heals-spent';
}

/**
 * Why a fight that hit the round cap didn't end (null for a win or a loss): the engine's cause
 * (`res.stalemateCause`), with downed-unrescued split by `downedKind` on the state `sink.inspect`
 * kept. Throws if a downed split is needed and the fight wasn't run with `{ inspect: sink.inspect }`.
 */
export function stalemateCause(res: Pick<FightResult, 'outcome' | 'life' | 'stalemateCause'>, sink: TraceSink): BenchCause | null {
  if (res.outcome.k !== 'stalemate') return null;
  const c = res.stalemateCause;
  if (c === undefined) throw new Error('a stalemate with no engine cause (FightResult.stalemateCause)');
  if (c !== 'downed-unrescued') return c;
  const st = sink.endState;
  if (!st) throw new Error("the downed split needs the finished state: run the fight with { inspect: sink.inspect }");
  return downedKind(res.life, sink.team, sink.lastDown, sink.lastUpTurn, (i) => holdsHeal(st.units[i]!));
}

/** Loop health summed over a character's fights. */
export interface LoopHealth {
  fights: number;
  turnsUp: number;
  dodges: number;
  attacks: number;
  casts: number;
  itemDecisions: number;
  stalemates: Record<BenchCause, number>;
}

export function newLoopHealth(): LoopHealth {
  return { fights: 0, turnsUp: 0, dodges: 0, attacks: 0, casts: 0, itemDecisions: 0, stalemates: noCauses() };
}

/** Folds one fight's trace of unit `u` (and its stalemate cause) into `h`. */
export function addFight(h: LoopHealth, t: UnitTrace, cause: BenchCause | null): void {
  h.fights++;
  h.turnsUp += t.turnsUp;
  h.dodges += t.dodges;
  h.attacks += t.attacks;
  h.casts += t.casts;
  h.itemDecisions += t.itemDecisions;
  if (cause) h.stalemates[cause]++;
}

export const dodgeShare = (h: LoopHealth): number => (h.turnsUp > 0 ? h.dodges / h.turnsUp : 0);
export const neverActs = (h: LoopHealth): boolean => h.fights > 0 && h.attacks + h.casts === 0;
export const itemsPerFight = (h: LoopHealth): number => (h.fights > 0 ? h.itemDecisions / h.fights : 0);
export const causeText = (s: Record<BenchCause, number>): string => BENCH_CAUSES.filter((c) => s[c] > 0).map((c) => `${c} ${s[c]}`).join(', ') || '-';
