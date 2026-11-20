// Greedy valuation of M3 step 4's primitives (docs/design/m3.md section 3, critique C6):
// conditions (COND), stats (STAT), temporary hit points (THP) and the escape check (check).
//
// One model covers conditions and stats: a change to a creature is worth what it moves two
// per-round damage figures, each built from exact per-attack odds (quick d20 odds against the
// creature's AC now, damage PMFs after its defenses) and the same reach test as exposure
// (query/threat.ts threatKind):
//   out  the damage it deals its enemies per round: its best routine at whoever it can reach
//   in   the damage its enemies deal it per round: each enemy's routine, split across the
//        creatures that enemy threatens (as exposure splits it)
// A change is valued as (out before - out after) x turns + (in after - in before) x turns:
// harm to its side, good for me on a foe, bad (x FRIENDLY) on my side or myself. Both figures
// are computed before and after on the same footing (a copy of the creature with the change),
// so a change that does nothing is worth exactly 0.
//
// Which rule effect each term counts (SRD 5.2.1 Rules Glossary, srd-raw.txt lines):
//   out  Incapacitated (Stunned, Paralyzed, Unconscious include it): no action, Bonus Action or
//        Reaction, so no attacks (33650-33660; 34374-34375, 33934-33935, 34525)
//        Disadvantage on its attack rolls: Blinded (32742-32743), Frightened while its source is
//        alive (sight is stubbed; 33475-33477), Poisoned (33946-33947), Restrained (34076-34077)
//        Speed 0: Restrained (34075), through the engine's speedNow; speed stats likewise
//        Charmed: it can't attack the charmer (32957-32958)
//        Frightened: it can't willingly move closer to the source (33478-33479), counted as
//        "can't walk up to the source at all" [U: a path that stays as far from it is ignored]
//        Prone: it rights itself first for half its Speed (34014-34016), so only its reach shrinks
//   in   Advantage on attack rolls against it: Blinded, Paralyzed (33939-33940), Restrained,
//        Stunned (34378-34379), Unconscious (34529-34530); Prone: Advantage within 5 ft, Disadvantage beyond (34017-34019)
//        Paralyzed, Unconscious: a hit from a melee attacker counts as a Critical Hit (33941-33943,
//        34533-34535, "within 5 feet": melee reach is read as within 5 ft [U for 10-ft reach])
//        stats: AC bonuses and floors (acNow), resist/vuln/immune (damagePmf), critMin on the
//        attacker (critMinOf)
// Not counted (each would only raise a value): the automatic STR/DEX save failures of
// Paralyzed and Stunned (34376-34377, 33937-33938) and Restrained's DEX save Disadvantage, except
// in the condition's own repeat save, where the odds are exact; a foe's Concentration ending
// when it's Incapacitated (33657); Blinded's failed sight checks (32740-32741); noOpportunityAttacks
// and Unarmed-strike damage-type stats; a speed bonus beyond what changes reach.
//
// Durations: a condition lasts min(horizon, its rounds) of the target's turns, discounted, and
// a turn-end repeat save makes each further turn last only with P(fail) (the save's exact odds
// with the condition on: Paralyzed auto-fails a DEX save, Restrained has Disadvantage on it).
// A condition that ends when its bearer takes damage counts DAMAGE_SPARE of both terms (my
// side's first hit ends it). Prone lasts until its next turn. A next stage on a failed repeat save
// (Sleep's Unconscious, coverage step 7.4) counts P(fail) x gamma x what that stage is worth from
// the target's next turn on [U: reviewed once, not measured]. A forced drop (dropHeld) isn't
// valued, nor Fear's forced Dash, so Fear's value is a floor.

import type { BoundEffect, CompiledMod, CompiledStat, Step } from '../../content/types.ts';
import { HOOK } from '../../content/types.ts';
import { hostile } from '../../grid/reach.ts';
import { threatKind } from '../../query/threat.ts';
import { checkSpec, saveSpec } from '../../sim/d20.ts';
import { autoCritWithin5, condImmunity, dodgeImposesDis } from '../../sim/conditions.ts';
import { speedNow } from '../../sim/damage.ts';
import { boundOf, resetFold } from '../../sim/effects.ts';
import { charmedBy } from '../../sim/stats.ts';
import { COND, has, oddsFlags, type BearerStat, type Fx, type QueryState, type Unit } from '../../sim/state.ts';
import { attackKeyOf } from '../../sim/attack.ts';
import { acNow } from '../../sim/hands.ts';
import type { ExprNode } from '../../dice/expr.ts';
import { quickOdds } from './odds.ts';
import type { VCtx } from './value.ts';

/** Terms the explain breakdown can switch off one at a time (VCtx.mute) to show each one's share. */
export const TERM = {
  condOut: 1, condIn: 2, stat: 4, thp: 8, escape: 16,
  // M3 step 5a (econ.ts): weapon strikes, the Dodge action, Dash and extra actions, pool points regained, free riders on hits.
  strikes: 32, dodge: 64, econ: 128, pool: 256, rider: 512,
  // M3 step 5b (weapons.ts' masteries and the Light property): a straight push's new position; the
  // next-roll tokens (Sap's Disadvantage, Vex's Advantage); the Bonus Action a Nick strike keeps.
  place: 1024, token: 2048, nick: 4096,
  // Review AI-2: a later strike of the turn at the creature the first one hit: Sap's token there is a
  // refresh (one next attack roll either way), so it adds nothing. Vex's isn't: the later strike uses
  // the first token and leaves its own. Never an explain term.
  refresh: 8192,
  // Coverage 8'b G3: non-lethal damage's progress credit.
  progress: 16384,
  // Coverage 8'b G6: a lasting effect's per-round payoff (a zone's rounds, a buff or mark on attack rolls).
  lasting: 32768,
  // Session S (repo half): an `around` step's creatures (an Emanation pulse; allies count against it),
  // the riders an effect switches on while it lasts (selfHas), and a spell's damage feeding a spellDamage rider.
  around: 65536, selfRider: 131072, spellRider: 262144,
  // Greedy v11: a pulse activation's deferral (what using it next turn instead keeps), and a pulse's
  // later rounds without the kill and progress credit (a foe drops once).
  defer: 524288, pulseLater: 1048576,
  // W1 (docs/design/w1-plan.md), each switched on only by content that carries its field: a sustained
  // effect's rounds past the first (P1) and the Bonus Action that extends one (P1); the concentration
  // a noConcentration stat ends and the casts a noCasting stat forgoes (P2); a sustained effect's
  // riders counted per expected hit (P3); Advantage on my next attack roll (P11, Steady Aim); the
  // conditions an endConditions step ends on me (P11); a move step's free move (P9).
  sustain: 2097152, extend: 4194304, noConc: 8388608, noCast: 16777216, perHit: 33554432, selfAdv: 67108864, endCond: 134217728, freeMove: 268435456,
} as const;

/** Friendly fire counts this much more than the same harm to an enemy (value.ts FRIENDLY). */
const FRIENDLY = 1.5;
/** A condition that ends when its bearer takes damage keeps this share of its value: my side's first hit ends it. */
const DAMAGE_SPARE = 0.5;
/** Temp HP: value per point, before danger (value.ts HEAL_RATE), and the bonus for getting a downed PC up (RESCUE). */
const HEAL_RATE = 0.8;
const RESCUE = 10;

/**
 * Roll modes for routineX: straight, Advantage or Disadvantage (the low two bits), OR'd with
 * `crit` when every hit is a Critical Hit. The automatic Critical Hit against a Paralyzed (or
 * Unconscious) creature depends only on the attacker being within 5 feet (srd-raw.txt:33941-33943),
 * whatever the roll mode and attack kind, as the engine applies it (sim/attack.ts autoCritOnHit).
 */
export const MODE = { none: 0, adv: 1, dis: 2, crit: 4, advCrit: 5 } as const;

const ATTACKER_DIS = COND.blinded | COND.poisoned | COND.restrained;
const TARGET_ADV = COND.blinded | COND.paralyzed | COND.restrained | COND.stunned | COND.unconscious;

/** Does `u` have a living source of fear (sight is stubbed: alive means in sight)? */
function fearAlive(st: QueryState, u: Unit): boolean {
  for (const c of u.conds) if (c.bit === COND.frightened && c.src >= 0 && st.units[c.src]!.life !== 'dead') return true;
  return false;
}

function frightenedOf(u: Unit, src: Unit): boolean {
  if (!has(u, COND.frightened)) return false;
  for (const c of u.conds) if (c.bit === COND.frightened && c.src === src.idx) return true;
  return false;
}

/** How `u` relates to `src` (the imposer): Charmed by it, Frightened of it, Disadvantage from fear. */
interface Rel {
  readonly src: Unit | null;
  readonly charm: boolean;
  readonly fear: boolean;
  readonly fearDis: boolean;
}

function relOf(st: QueryState, u: Unit, src: Unit | null, gained: number): Rel {
  const charm = src !== null && ((gained & COND.charmed) !== 0 || charmedBy(u, src));
  const fear = src !== null && ((gained & COND.frightened) !== 0 || frightenedOf(u, src));
  return { src, charm, fear, fearDis: (gained & COND.frightened) !== 0 || (has(u, COND.frightened) && fearAlive(st, u)) };
}

/** Combines Advantage and Disadvantage sources the way the engine resolves them (any of each cancel); `crit` is kept either way. */
function mode(adv: boolean, dis: boolean, crit = false): number {
  const m = adv && dis ? MODE.none : adv ? MODE.adv : dis ? MODE.dis : MODE.none;
  return crit ? m | MODE.crit : m;
}

/** Damage per round `t` deals its enemies: its best routine at whichever of them it can reach. */
function outDpr(v: VCtx, t: Unit, rel: Rel): number {
  if (t.life !== 'up' || has(t, COND.incapacitated)) return 0;
  const st = v.st;
  const dis = (t.condMask & ATTACKER_DIS) !== 0 || (has(t, COND.frightened) && rel.fearDis);
  let speed = speedNow(t);
  if (has(t, COND.prone)) speed = Math.floor(speed / 2); // it rights itself first (34014-34016)
  let best = 0;
  for (const m of st.units) {
    if (m.life !== 'up' || !hostile(t, m)) continue;
    if (rel.charm && m === rel.src) continue; // can't attack the charmer (32957-32958)
    const md = mode(false, dis);
    const r = v.routineX(t, m, md, md);
    const how = threatKind(v.dist(t.cell, m.cell), rel.fear && m === rel.src ? 0 : speed, r);
    if (!how) continue;
    const val = how === 'melee' ? r.melee : r.ranged;
    if (val > best) best = val;
  }
  return best;
}

/**
 * Damage per round `t`'s enemies deal it, each enemy's routine split across the creatures it threatens.
 * `win` (review AI-4, a Prone imposed on my turn): only what lands before `t`'s next turn, my
 * strikes still to come this turn (VCtx.laterStrikes, each a share of my routine) and the allies
 * whose turns come before its own; false: a whole round, as before.
 */
function inDpr(v: VCtx, t: Unit, win = false): number {
  if (t.life !== 'up') return 0;
  const st = v.st;
  const adv = (t.condMask & TARGET_ADV) !== 0;
  const prone = has(t, COND.prone);
  const crit = autoCritWithin5(t);
  let total = 0;
  for (const e of st.units) {
    if (e.life !== 'up' || !hostile(e, t) || has(e, COND.incapacitated)) continue;
    if (charmedBy(e, t)) continue;
    // The Dodge action: attack rolls against it have Disadvantage while it holds (srd-raw.txt:33372-33374; sight stubbed).
    const eDis = (e.condMask & ATTACKER_DIS) !== 0 || (has(e, COND.frightened) && fearAlive(st, e)) || ((t.condMask & COND.dodging) !== 0 && dodgeImposesDis(st, t));
    const d = v.dist(e.cell, t.cell);
    // Melee strikes land from within reach (read as within 5 ft [U for 10-ft reach]); ranged ones from where it stands.
    const r = v.routineX(e, t, mode(adv || prone, eDis, crit), mode(adv, eDis || prone, crit && d <= 5));
    const speed = frightenedOf(e, t) ? 0 : speedNow(e);
    const how = threatKind(d, speed, r);
    if (!how) continue;
    if (win) {
      if (e === v.me) {
        total += (v.laterStrikes() * (how === 'melee' ? r.melee : r.ranged)) / routineStrikes(e);
        continue;
      }
      if (!actsBefore(st, e, t)) continue;
    }
    // Its attacks are split across the creatures it threatens (exposure's victims).
    let victims = 0;
    for (const o of st.units) if (o.life === 'up' && hostile(e, o) && threatKind(v.dist(e.cell, o.cell), speed, r)) victims++;
    total += (how === 'melee' ? r.melee : r.ranged) / Math.max(1, victims);
  }
  return total;
}

/** A copy of `u` with condition bits `bits` set and `cleared` removed, and stats `stats` added (for what-if reads only). */
function variant(u: Unit, bits: number, cleared: number, stats: readonly CompiledStat[]): Unit {
  const extra: BearerStat[] = stats.map((s) => ({ s, fx: -1 }));
  return { ...u, condMask: (u.condMask | bits) & ~cleared, stats: extra.length > 0 ? [...u.stats, ...extra] : u.stats };
}

/**
 * What changing `before` into `after` is worth to me: harm to its side (its lost damage plus the
 * damage it newly takes) over `turns`. `outMute`/`inMute` switch a term off (explain).
 *
 * On a foe both terms stop where it would drop, as the strike terms stop at its HP
 * (expectedCapped): the extra damage it takes counts only up to its HP plus temp HP over those
 * turns, and its lost damage only for the turns it would live through at the damage it takes now
 * (HP / damage per round, when that's fewer). So a condition on a nearly dead foe is worth
 * little, and finishing it wins. On my side neither is capped: harm to us counts in full.
 */
function changeValue(v: VCtx, before: Unit, after: Unit, src: Unit | null, gained: number, turns: number, outMute: number, inMute: number): number {
  return combineChange(v, before, changeFigures(v, before, after, src, gained, outMute, inMute), turns, outMute, inMute);
}

/** The per-round figures changeValue combines: what `before` and `after` deal (out) and take (in); a muted figure is 0 and unread. */
export interface ChangeFigures {
  readonly outB: number;
  readonly outA: number;
  readonly inB: number;
  readonly inA: number;
}

function changeFigures(v: VCtx, before: Unit, after: Unit, src: Unit | null, gained: number, outMute: number, inMute: number): ChangeFigures {
  const out = !(v.mute & outMute);
  const relB = relOf(v.st, before, src, 0);
  let inB: number;
  let outB: number;
  if (v.mute === 0 && !relB.charm && !relB.fear) {
    // Perf: `before` as it stands, neither charmed by nor frightened of the source, reads the same
    // whoever imposes the change; every condition, rider stat and push on it in this decision shares it.
    const m = v.riderMemo;
    const i = m.bUnit.indexOf(before);
    if (i >= 0) {
      inB = m.bIn[i]!;
      outB = m.bOut[i]!;
    } else {
      inB = inDpr(v, before);
      outB = outDpr(v, before, relB);
      m.bUnit.push(before);
      m.bIn.push(inB);
      m.bOut.push(outB);
    }
  } else {
    inB = inDpr(v, before);
    outB = out ? outDpr(v, before, relB) : 0;
  }
  return {
    outB,
    outA: out ? outDpr(v, after, relOf(v.st, after, src, gained)) : 0,
    inB,
    inA: !(v.mute & inMute) ? inDpr(v, after) : 0,
  };
}

/** changeValue's arithmetic over its figures for `turns` (G8: the one input that varies between calls for the same change). */
function combineChange(v: VCtx, before: Unit, f: ChangeFigures, turns: number, outMute: number, inMute: number): number {
  const foe = before.team !== v.me.team;
  const pool = before.hp + before.tempHp;
  let harm = 0;
  if (!(v.mute & outMute)) {
    const lives = foe && f.inB > 0 ? Math.min(turns, pool / f.inB) : turns;
    harm += (f.outB - f.outA) * lives;
  }
  if (!(v.mute & inMute)) harm += foe ? Math.min(pool, f.inA * turns) - Math.min(pool, f.inB * turns) : (f.inA - f.inB) * turns;
  if (foe) return harm;
  return harm > 0 ? -FRIENDLY * harm : -harm;
}

/** P(`t` succeeds a condition's repeat save) with the condition's bits on it (exact: Paralyzed auto-fails DEX, Restrained has Disadvantage). */
function repeatSaveP(v: VCtx, te: BoundEffect, t: Unit): number {
  for (const h of te.hooks) {
    if (!(h.on & HOOK.turnEnd)) continue;
    for (const s of h.steps) {
      if (s.k !== 'condSave') continue;
      const qs = v.qs;
      qs.adv.length = 0;
      qs.dis.length = 0;
      resetFold(qs.fold);
      return quickOdds(saveSpec(v.st, t, s.key, s.dc, qs.adv, qs.dis, qs.fold), oddsFlags(v.st)).pSuccess;
    }
  }
  return 0;
}

/**
 * An effect that lasts until the start or end of its owner's next turn (Stunning Strike's Stunned,
 * "until the start of your next turn", srd-raw.txt:11206-11208): how many of `t`'s turns it
 * covers, 0 or 1 (review AI-4). The target's turn counts if it starts before the owner's next
 * one (the turn order from now); a target that is acting now (an opportunity attack on its own
 * turn) loses only what is left of this turn: 1 if its action is still unspent, else 0.
 */
function ownerAnchoredTurns(st: QueryState, owner: number, t: Unit): number {
  if (owner === t.idx) return 1;
  if (st.active === t.idx) return t.b.action > 0 || t.b.atkActive ? 1 : 0;
  const n = st.order.length;
  let pt = -1;
  let po = -1;
  for (let k = 0; k < n; k++) {
    if (st.order[k] === t.idx) pt = k;
    if (st.order[k] === owner) po = k;
  }
  if (pt < 0 || po < 0 || st.active < 0) return 1;
  const off = (pos: number) => (pos - st.orderPos + n) % n || n;
  return off(pt) < off(po) ? 1 : 0;
}

/** Review AI-4: does `e`'s next turn come before `t`'s (the turn order from now)? Unknown order: yes. */
function actsBefore(st: QueryState, e: Unit, t: Unit): boolean {
  const n = st.order.length;
  let pe = -1;
  let pt = -1;
  for (let k = 0; k < n; k++) {
    if (st.order[k] === e.idx) pe = k;
    if (st.order[k] === t.idx) pt = k;
  }
  if (pe < 0 || pt < 0 || st.active < 0) return true;
  const off = (pos: number) => (pos - st.orderPos + n) % n || n;
  return off(pe) < off(pt);
}

/** The target's turns a condition effect covers, discounted: min(horizon, its rounds), each further turn only if the repeat save fails. */
function condTurns(v: VCtx, te: BoundEffect, withCond: Unit, parentRounds: number, owner = v.me.idx, stay = 1): number {
  const d = te.dur;
  const n = d.k === 'rounds' ? d.n : d.k === 'untilTurn' ? (d.of === 'owner' ? ownerAnchoredTurns(v.st, owner, withCond) : 1) : parentRounds;
  const keep = 1 - repeatSaveP(v, te, withCond);
  let f = 0;
  let g = 1;
  for (let k = 0; k < Math.min(v.w.horizon, n); k++) {
    f += g;
    g *= v.w.gamma * keep * stay; // coverage 8'b G6: under concentration, only while I keep it
  }
  return te.endsOnDamage ? f * DAMAGE_SPARE : f;
}

/**
 * A condition step on `t`, imposed by me: what its rule effects are worth for as long as it lasts.
 * `perTurn` (value.ts Frame.perTurn): the caller multiplies this by its own rounds (a hook that
 * fires each turn, a zone's per-round hooks), so it's worth that many of the target's turns per
 * run instead of its whole duration, which would count each turn once per run.
 */
export function conditionValue(v: VCtx, s: Extract<Step, { k: 'condition' }>, t: Unit, parentRounds: number, perTurn?: number, stay = 1): number {
  if (t.life !== 'up') return 0;
  const immune = condImmunity(v.st, t);
  if (s.fx < 0) {
    // Prone (34010-34019): until it rights itself on its next turn.
    if (immune & s.bit || has(t, s.bit)) return 0;
    // A weapon mastery's Prone (Topple) imposed on my turn (review AI-4): the Advantage is used only
    // by the strikes that land before it stands up on its own turn (my strikes still to come, the
    // allies acting before it); what it loses itself (half its movement to stand) stays one turn.
    if (v.proneWindow && perTurn === undefined && v.st.active === v.me.idx && t.team !== v.me.team) {
      const after = variant(t, s.bit, 0, []);
      const out = changeValue({ ...v, mute: v.mute | TERM.condIn }, t, after, v.me, s.bit, 1, TERM.condOut, TERM.condIn);
      if (v.mute & TERM.condIn) return out;
      const pool = t.hp + t.tempHp;
      return out + Math.min(pool, inDpr(v, after, true)) - Math.min(pool, inDpr(v, t, true));
    }
    return changeValue(v, t, variant(t, s.bit, 0, []), v.me, s.bit, perTurn ?? 1, TERM.condOut, TERM.condIn);
  }
  // Immune to the condition itself: the engine skips the whole instance (sim/conditions.ts imposeCondition).
  if (immune & s.bit) return 0;
  const te = v.me.tpl.effects[s.fx]!;
  const bits = (te.cond ?? 0) & ~immune;
  if (bits === 0) return 0;
  // Unconscious brings Prone (34525), which a ranged attacker's Advantage cancels against.
  const addProne = s.bit === COND.unconscious && !(immune & COND.prone);
  const after = variant(t, addProne ? bits | COND.prone : bits, 0, te.stats ?? []);
  const turns = perTurn === undefined ? condTurns(v, te, after, parentRounds, v.me.idx, stay) : te.endsOnDamage ? perTurn * DAMAGE_SPARE : perTurn;
  // Perf (G8's memo): the figures read only the state, `t`, the effect and me (the source), never
  // where I stand or the rounds; every candidate aim and square values the same condition on the
  // same creature again, so they're kept per decision and combined per `turns`.
  let figs: ChangeFigures | null = null;
  if (v.mute === 0) {
    const kind = addProne ? MEMO.condProne : MEMO.cond;
    const i = memoFind(v, kind, te, t, v.me);
    if (i >= 0) figs = v.riderMemo.figs[i]!;
    else memoPut(v, kind, te, t, v.me, (figs = changeFigures(v, t, after, v.me, bits, TERM.condOut, TERM.condIn)));
  }
  const first = figs ? combineChange(v, t, figs, turns, TERM.condOut, TERM.condIn) : changeValue(v, t, after, v.me, bits, turns, TERM.condOut, TERM.condIn);
  const next = nextStage(te);
  if (!next) return first;
  // A failed repeat save brings the next stage, from the target's next turn on.
  let later = 0;
  for (const n of next) if (n.k === 'condition') later += conditionValue(v, n, t, parentRounds, perTurn, stay);
  return first + (1 - repeatSaveP(v, te, after)) * v.w.gamma * later;
}

/** What a failed repeat save of this condition effect runs (Sleep's second stage), if anything. */
function nextStage(te: BoundEffect): readonly Step[] | undefined {
  for (const h of te.hooks) for (const s of h.steps) if (s.k === 'condSave' && s.onFail) return s.onFail;
  return undefined;
}

/**
 * Coverage 8'b G6: a mod on attack rolls, non-consumed, per round (a buff on its bearer's own rolls,
 * a mark on rolls against its bearer): the share of a hit it adds, at the odds of the attacker's
 * best attack it applies to against the nearest creature it could roll against, times the damage per
 * round those rolls deal (outDpr, inDpr; `ownerOnly`: my routine at it). 0 for a mod on saves or
 * checks [U: Bless's save die isn't counted; it would only raise the value], and for one that does
 * nothing to those attacks. Its gates are read as holding [U].
 */
export function modPerRound(v: VCtx, te: BoundEffect, m: CompiledMod, bearer: Unit): number {
  if (bearer.life !== 'up') return 0;
  const st = v.st;
  const incoming = m.side === 'incoming';
  const roller = incoming ? (m.ownerOnly ? v.me : nearestHostile(v, bearer)) : bearer;
  const against = incoming ? bearer : nearestHostile(v, bearer);
  if (!roller || !against) return 0;
  let toHit = -Infinity;
  for (const a of roller.tpl.attacks) if (a.toHit > toHit && m.on.some((p) => (attackKeyOf(a, false) & p.mask) === p.val)) toHit = a.toHit;
  if (toHit === -Infinity) return 0;
  const base = { kind: 'attack' as const, adv: 'none' as const, flat: toHit, preDice: [] as ExprNode[], dc: acNow(against, st) };
  const p0 = quickOdds(base, oddsFlags(st)).pSuccess;
  if (!(p0 > 0)) return 0;
  const sp = m.op === 'adv' ? { ...base, adv: 'adv' as const } : m.op === 'dis' ? { ...base, adv: 'dis' as const } : m.op === 'flat' ? { ...base, flat: toHit + m.value } : m.op === 'preDice' && m.dice ? { ...base, preDice: [m.dice] } : null;
  if (!sp) return 0;
  const share = (quickOdds(sp, oddsFlags(st)).pSuccess - p0) / p0;
  if (!incoming) return (bearer.team === v.me.team ? share : -share) * outDpr(v, bearer, relOf(st, bearer, null, 0));
  if (m.ownerOnly) return share * Math.max(v.routineX(v.me, bearer, MODE.none, MODE.none).melee, v.routineX(v.me, bearer, MODE.none, MODE.none).ranged);
  return (bearer.team === v.me.team ? -share : share) * inDpr(v, bearer);
}

function nearestHostile(v: VCtx, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const o of v.st.units) {
    if (o.life !== 'up' || !hostile(u, o)) continue;
    const d = v.dist(u.cell, o.cell);
    if (d < bd) [bd, best] = [d, o];
  }
  return best;
}

/**
 * Coverage 8'b G6: what the conditions and stats of live effect `fx` on `bearer` are doing this
 * round: the creature as it is, against it without them (held by this effect alone).
 */
export function liveChangeValue(v: VCtx, fx: Fx, te: BoundEffect, bearer: Unit): number {
  if (bearer.life !== 'up') return 0;
  let bits = te.cond ?? 0;
  for (const c of bearer.conds) if (c.until.k !== 'effect' || c.until.effect !== fx.id) bits &= ~c.bit;
  const stats = te.stats ? bearer.stats.filter((x) => x.fx !== fx.id) : bearer.stats;
  if (bits === 0 && stats === bearer.stats) return 0;
  const without: Unit = { ...bearer, condMask: bearer.condMask & ~bits, stats };
  return changeValue(v, without, bearer, fx.owner >= 0 ? v.st.units[fx.owner]! : null, bits, 1, TERM.condOut | TERM.stat, TERM.condIn | TERM.stat);
}

/** An effect's stats on `bearer` for `r` discounted rounds (its gates read as on another creature's turn). */
export function statsValue(v: VCtx, te: BoundEffect, bearer: Unit, r: number): number {
  if (!te.stats || te.stats.length === 0 || bearer.life !== 'up') return 0;
  return statsChange(v, te, bearer, r) + castStatsValue(v, te, bearer);
}

/**
 * W1 (P2): what a noConcentration or noCasting stat on me costs ("You can't maintain Concentration,
 * and you can't cast spells", srd-raw.txt:4980-4981): the concentration it ends, at what my live one
 * still has in it (VCtx.concLeft: per round x its rounds left, what replacing it costs a cast), and
 * the best cast's margin over my best non-cast option this turn (VCtx.castMargin) [U: one turn's
 * margin; later turns' casts aren't counted]. 0 for an effect without those stats, on anyone but
 * me, and in a VCtx without the W1 closures (C3). Their `when` gates are read as holding [U].
 */
function castStatsValue(v: VCtx, te: BoundEffect, bearer: Unit): number {
  if (bearer !== v.me) return 0;
  let conc = false;
  let cast = false;
  for (const s of te.stats!) {
    if (s.k === 'noConcentration') conc = true;
    else if (s.k === 'noCasting') cast = true;
  }
  let total = 0;
  if (conc && v.me.conc >= 0 && !(v.mute & TERM.noConc)) total -= v.concLeft ? v.concLeft() : 0;
  if (cast && !(v.mute & TERM.noCast)) total -= v.castMargin ? v.castMargin() : 0;
  return total;
}

/** An effect's stats as a change to `bearer`'s two per-round damage figures, for `r` rounds (statsValue's model). */
function statsChange(v: VCtx, te: BoundEffect, bearer: Unit, r: number): number {
  if (v.mute !== 0) return changeValue(v, bearer, variant(bearer, 0, 0, te.stats!), null, 0, r, TERM.stat, TERM.stat);
  // G8: the same rider's stats on the same creature come up once per candidate square and strike,
  // often with different rounds. Its figures read only the state, `bearer` and the stats (inDpr's
  // `win` is off; neither reads me), so they're kept per (effect, creature) and combined per `r`.
  let f = memoFigs(v, te, bearer);
  if (!f) {
    f = changeFigures(v, bearer, variant(bearer, 0, 0, te.stats!), null, 0, TERM.stat, TERM.stat);
    memoPut(v, MEMO.stats, te, bearer, null, f);
  }
  return combineChange(v, bearer, f, r, TERM.stat, TERM.stat);
}

/**
 * Ending the effect `fxId` that I bear (a successful escape, endSource): the condition bits it
 * gives me that no other instance holds, for the turns it would still last.
 */
export function endSourceValue(v: VCtx, fxId: number): number {
  if (fxId < 0 || v.mute & TERM.escape) return 0;
  const st = v.st;
  const fx = st.fx[fxId]!;
  if (!fx.alive || fx.bearer !== v.me.idx) return 0;
  const te = boundOf(st, fx);
  let bits = te.cond ?? 0;
  if (bits === 0) return 0;
  const me = v.me;
  for (const c of me.conds) if (c.until.k !== 'effect' || c.until.effect !== fxId) bits &= ~c.bit; // held by something else too
  if (bits === 0) return 0;
  const src = fx.owner >= 0 ? st.units[fx.owner]! : null;
  return -changeValue(v, variant(me, 0, bits, []), me, src, 0, condTurns(v, te, me, 10, fx.owner >= 0 ? fx.owner : me.idx), 0, 0);
}

/**
 * W1 (P11): an endConditions step ending conditions `bits` on me ("the condition ends on you",
 * srd-raw.txt:5183-5184): the ones I have, as endSourceValue values an escape (the same two per-round
 * damage figures with and without them, the first source's charm or fear counted), for one of my
 * turns [U: a floor; how long the condition would have lasted isn't read]. 0 when I have none of them.
 */
export function endCondValue(v: VCtx, bits: number): number {
  const me = v.me;
  if (me.life !== 'up' || v.mute & TERM.endCond) return 0;
  const held = me.condMask & bits;
  if (held === 0) return 0;
  let src: Unit | null = null;
  for (const c of me.conds) {
    if (c.bit & held && c.src >= 0) {
      src = v.st.units[c.src]!;
      break;
    }
  }
  return -changeValue(v, variant(me, 0, held, []), me, src, 0, 1, 0, 0);
}

/** W1 (P11): the names of the conditions in COND bits `bits`, for an Explain line ("Charmed, Frightened"). */
export function condNames(bits: number): string {
  const out: string[] = [];
  for (const [name, bit] of CONTENT_COND_BITS) if (bits & bit) out.push(name[0]!.toUpperCase() + name.slice(1));
  return out.length > 0 ? out.join(', ') : 'conditions';
}

/** P(I succeed an ability check) now: the engine's own check spec, read with quick odds. */
export function checkP(v: VCtx, s: Extract<Step, { k: 'check' }>): number {
  const qs = v.qs;
  qs.adv.length = 0;
  qs.dis.length = 0;
  resetFold(qs.fold);
  return quickOdds(checkSpec(v.st, v.me, s.ability, s.skills, s.dc, qs.adv, qs.dis, qs.fold).spec, oddsFlags(v.st)).pSuccess;
}

/**
 * Temporary Hit Points on `t`: valued like a heal that can't be wasted on missing HP, only on
 * what it replaces (they don't stack: the higher is kept, srd-raw.txt:2400-2404), and only up to
 * the damage it could absorb over the horizon; weighted by the same danger and drop-chance terms
 * as a heal (value.ts healValue). A creature at 0 HP isn't restored by them (2414-2416): 0.
 */
export function tempHpValue(v: VCtx, t: Unit, amount: number, from: number, horizonF: number): number {
  if (t.life !== 'up' || v.mute & TERM.thp) return 0;
  const gain0 = Math.max(0, amount - t.tempHp);
  if (gain0 <= 0) return 0;
  if (t.team !== v.me.team) return -gain0;
  const cell = t === v.me ? from : t.cell;
  const e = v.threat(t, t.cell);
  const gain = Math.min(gain0, e * horizonF);
  if (gain <= 0) return 0;
  const danger = Math.min(1, Math.max(0.25, e / Math.max(1, t.hp)));
  return HEAL_RATE * gain * danger + v.dropCut(t, cell, gain) * (v.killValue(t) + RESCUE);
}

/** Names for explain labels: the conditions a program imposes and the stat kinds its effects give. */
export function programLabels(me: Unit, steps: readonly Step[], out: { conds: string[]; stats: string[] } = { conds: [], stats: [] }, seen: number[] = []): { conds: string[]; stats: string[] } {
  const add = (list: string[], x: string) => {
    if (!list.includes(x)) list.push(x);
  };
  for (const s of steps) {
    if (s.k === 'condition') {
      const bits = s.fx < 0 ? s.bit : (me.tpl.effects[s.fx]!.cond ?? 0);
      for (const [name, bit] of CONTENT_COND_BITS) if (bits & bit && !(bit === COND.incapacitated && bits & (COND.stunned | COND.paralyzed | COND.unconscious))) add(out.conds, name);
      if (s.fx >= 0) {
        const te = me.tpl.effects[s.fx]!;
        for (const st of te.stats ?? []) add(out.stats, st.k);
        // Its next stage (Sleep's Unconscious) is part of what the program imposes.
        const next = nextStage(te);
        if (next) programLabels(me, next, out, seen);
      }
    } else if (s.k === 'apply') {
      const te = me.tpl.effects[s.fx]!;
      for (const st of te.stats ?? []) add(out.stats, st.k);
      // Its hooks (bearer hooks, a zone's enter/turn-end/travel hooks) impose conditions too; each effect is walked once.
      if (!seen.includes(s.fx)) {
        seen.push(s.fx);
        for (const h of te.hooks) programLabels(me, h.steps, out, seen);
      }
    } else if (s.k === 'attack') {
      programLabels(me, s.onHit, out, seen);
      programLabels(me, s.onMiss, out, seen);
    } else if (s.k === 'save') {
      programLabels(me, s.onFail, out, seen);
      programLabels(me, s.onSuccess, out, seen);
    } else if (s.k === 'check') {
      programLabels(me, s.onSuccess, out, seen);
    } else if (s.k === 'choose') for (const o of s.opts) programLabels(me, o.steps, out, seen);
  }
  return out;
}

const CONTENT_COND_BITS: readonly (readonly [string, number])[] = [
  ['blinded', COND.blinded],
  ['charmed', COND.charmed],
  ['frightened', COND.frightened],
  ['incapacitated', COND.incapacitated],
  ['paralyzed', COND.paralyzed],
  ['poisoned', COND.poisoned],
  ['prone', COND.prone],
  ['restrained', COND.restrained],
  ['stunned', COND.stunned],
  ['unconscious', COND.unconscious],
];

// ---- M3 step 5b: the masteries' next-roll tokens and a straight push's new position ----

/** Strikes in `u`'s fullest Attack routine (at least 1): a routine's value over this is one strike's. */
function routineStrikes(u: Unit): number {
  let n = 1;
  for (const alt of u.tpl.attackAct.alts) {
    let k = 0;
    for (const g of alt) k += g.count;
    if (k > n) n = k;
  }
  return n;
}

/**
 * A next-roll token an effect puts on `bearer` (M3 step 5b), for one use:
 *   Sap (srd-raw.txt:20442-20446): "that creature has Disadvantage on its next attack roll before
 *     the start of your next turn" (an outgoing Disadvantage, consumed by its next roll): one of its
 *     strikes rolled with Disadvantage instead of straight, against each creature of my side it
 *     threatens (averaged: which one it attacks isn't known), if its turn comes before mine
 *     (ownerAnchoredTurns: 0 or 1 of its turns).
 *   Vex (20463-20467): "you have Advantage on your next attack roll against that creature before the
 *     end of your next turn" (an incoming Advantage only my rolls use, ownerOnly): one of my strikes
 *     at it with Advantage instead of straight, now if I have a strike left after this one
 *     (`later` 1), else on my next turn (gamma), as long as it lives.
 * A copy of the token I already put on it adds nothing (a refresh). Returns null for any other mod
 * (the caller values it as before), so content without these shapes reads exactly as it did.
 */
/** Is `m` a one-roll token tokenValue values (Sap, Vex)? Exactly when tokenValue doesn't return null (perf: payoff asks this first, W1). */
export function isTokenMod(m: CompiledMod): boolean {
  if (!m.consume || m.on.length === 0) return false;
  return (m.op === 'dis' && m.side === 'self') || (m.op === 'adv' && m.side === 'incoming' && m.ownerOnly === true);
}

export function tokenValue(v: VCtx, te: BoundEffect, m: CompiledMod, bearer: Unit, laterNow: boolean): number | null {
  if (!isTokenMod(m)) return null;
  const sap = m.op === 'dis' && m.side === 'self';
  const vex = !sap;
  if (v.mute & TERM.token || (sap && v.mute & TERM.refresh)) return 0;
  const st = v.st;
  if (bearer.life !== 'up' || bearer.team === v.me.team) return 0;
  for (const id of bearer.borne) {
    const fx = st.fx[id]!;
    if (fx.alive && fx.owner === v.me.idx && boundOf(st, fx).id === te.id) return 0;
  }
  if (vex) {
    // G8: one strike's gain from Advantage reads my unit (its hands and stats: keyed by identity) and the bearer; `laterNow` scales it after.
    let d = memoGet(v, MEMO.vex, te, bearer, v.me);
    if (d !== d) {
      const plain = v.routineX(v.me, bearer, MODE.none, MODE.none);
      const adv = v.routineX(v.me, bearer, MODE.adv, MODE.adv);
      d = memoPut(v, MEMO.vex, te, bearer, v.me, (Math.max(adv.melee, adv.ranged) - Math.max(plain.melee, plain.ranged)) / routineStrikes(v.me));
    }
    return d > 0 ? d * (laterNow ? 1 : v.w.gamma) : 0;
  }
  if (has(bearer, COND.incapacitated) || ownerAnchoredTurns(st, v.me.idx, bearer) === 0) return 0;
  // G8: Sap's value reads the state, the bearer and my side (by my index), never my unit itself.
  const hit = memoGet(v, MEMO.sap, te, bearer, null);
  return hit === hit ? hit : memoPut(v, MEMO.sap, te, bearer, null, sapValue(v, bearer));
}

/** Sap's token on `bearer`: one of its strikes at Disadvantage instead of straight, averaged over the creatures of my side it threatens. */
function sapValue(v: VCtx, bearer: Unit): number {
  const st = v.st;
  let sum = 0;
  let n = 0;
  for (const u of st.units) {
    if (u.life !== 'up' || u.team !== v.me.team || !hostile(bearer, u)) continue;
    const plain = v.routineX(bearer, u, MODE.none, MODE.none);
    const how = threatKind(v.dist(bearer.cell, u.cell), speedNow(bearer), plain);
    if (!how) continue;
    const dis = v.routineX(bearer, u, MODE.dis, MODE.dis);
    sum += (how === 'melee' ? plain.melee - dis.melee : plain.ranged - dis.ranged) / routineStrikes(bearer);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Moving `t` to `cell` for its next turn (M3 step 5b, Push: "push the creature up to 10 feet
 * straight away from yourself", srd-raw.txt:20437-20440): the same two per-round damage figures as a
 * condition (what it can reach and deal from there, what my side can reach and deal to it), on a
 * copy of it standing on `cell`, for one of its turns (it can walk back after). The pusher's own
 * strikes still to come this turn are the decider's part (greedy.ts placeValue).
 */
export function placeValue(v: VCtx, t: Unit, cell: number): number {
  if (t.life !== 'up' || cell === t.cell || v.mute & TERM.place) return 0;
  return changeValue(v, t, { ...t, cell }, null, 0, 1, 0, 0);
}

// ---- G8 (docs/design/coverage.md): the rider-token cache ----

/**
 * One decision's memo of rider valuations that depend only on the decision's state and a few
 * inputs: a rider effect's stats on a creature (Slow: its per-round figures, combined per rounds
 * by statsValue) and the one-roll tokens (Sap, Vex). Every candidate square and strike values the
 * same rider on the same target again; this keeps the first result. Keys are object identities
 * (the effect, the bearer, and for Vex my unit, which may be a what-if copy with a weapon drawn),
 * the kind and my index, so a hit gives exactly what the uncached call would (perf only: the
 * proof is byte-identical goldens and report hashes). The decider empties it at every decision
 * (the state moves between decisions, never during one; greedy copies units, never edits them),
 * and explain's muted what-ifs never read or write it. Arrays, not a Map: scanned in insertion order.
 */
export interface RiderMemo {
  readonly kind: number[];
  readonly te: BoundEffect[];
  readonly bearer: Unit[];
  readonly me: (Unit | null)[];
  readonly meIdx: number[];
  readonly val: number[];
  readonly figs: (ChangeFigures | null)[];
  /** changeFigures' `before` figures per creature (identity), with no charm or fear on it from the source. */
  readonly bUnit: Unit[];
  readonly bIn: number[];
  readonly bOut: number[];
}

export function newRiderMemo(): RiderMemo {
  return { kind: [], te: [], bearer: [], me: [], meIdx: [], val: [], figs: [], bUnit: [], bIn: [], bOut: [] };
}

export function clearRiderMemo(m: RiderMemo): void {
  m.kind.length = 0;
  m.te.length = 0;
  m.bearer.length = 0;
  m.me.length = 0;
  m.meIdx.length = 0;
  m.val.length = 0;
  m.figs.length = 0;
  m.bUnit.length = 0;
  m.bIn.length = 0;
  m.bOut.length = 0;
}

const MEMO = { stats: 0, sap: 1, vex: 2, cond: 3, condProne: 4 } as const;

/** The entry's index, or -1. `me`: my unit when the value reads it, else null (my index is always keyed). */
function memoFind(v: VCtx, kind: number, te: BoundEffect, bearer: Unit, me: Unit | null): number {
  const m = v.riderMemo;
  const idx = v.me.idx;
  for (let i = 0; i < m.kind.length; i++) if (m.kind[i] === kind && m.te[i] === te && m.bearer[i] === bearer && m.me[i] === me && m.meIdx[i] === idx) return i;
  return -1;
}

/** A memoized token value, or NaN (a miss, or a muted explain what-if). */
function memoGet(v: VCtx, kind: number, te: BoundEffect, bearer: Unit, me: Unit | null): number {
  if (v.mute !== 0) return NaN;
  const i = memoFind(v, kind, te, bearer, me);
  return i < 0 ? NaN : v.riderMemo.val[i]!;
}

/** The memoized stats figures of effect `te` on `bearer`, or null. */
function memoFigs(v: VCtx, te: BoundEffect, bearer: Unit): ChangeFigures | null {
  const i = memoFind(v, MEMO.stats, te, bearer, null);
  return i < 0 ? null : v.riderMemo.figs[i]!;
}

/** Records a value (a token) or figures (stats) and returns the value; nothing under a mute. */
function memoPut(v: VCtx, kind: number, te: BoundEffect, bearer: Unit, me: Unit | null, val: number | ChangeFigures): number {
  if (v.mute !== 0) return typeof val === 'number' ? val : NaN;
  const m = v.riderMemo;
  m.kind.push(kind);
  m.te.push(te);
  m.bearer.push(bearer);
  m.me.push(me);
  m.meIdx.push(v.me.idx);
  m.val.push(typeof val === 'number' ? val : NaN);
  m.figs.push(typeof val === 'number' ? null : val);
  return typeof val === 'number' ? val : NaN;
}
