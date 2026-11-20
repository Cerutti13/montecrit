// Program valuation for the greedy AI (docs/design/m1c.md 1.6): walks a compiled Step[] for the
// deciding creature standing on a cell and returns what it's worth in EHP, without touching the
// fight. Generic over the primitives, so new spells and features need no AI code:
//   attack / save      exact odds (quick d20 odds, saveOdds) times the value of each branch
//   damage             HP removed (capped at what the target has) plus the chance it drops the
//                      target times what that's worth; allies and itself count against, x1.5
//   heal               HP restored up to the max, weighted by the danger the target is in, plus
//                      the drop chance it removes times what reversing a drop is worth;
//                      a downed PC on death saves is worth getting up
//   apply              a zone's value where it lands, an effect's riders, roll floors, slot-heal
//                      hooks and granted options: coverage 8'b G6's lasting-effect term, below
//   forced             the best path's zone damage (a pull through spikes)
//   choose             the best option; use: the granted program
//   M3 step 5a (econ.ts has the model and the rule cites):
//   weaponAttack       count x the best single strike it can make from where it stands
//                      (exact odds and damage after defenses, its granted free riders on a hit)
//   core               Dodge: the Disadvantage it puts on attacks against me until my next
//                      turn, over my exposure where I end; Dash: the strikes it brings in reach;
//                      Disengage: 0 here (the turn decision values it on a provoking move)
//   gainAction         one more Attack action's strikes
//   pool               the points gained, each at its in-fight value (econ.ts pointValue)
//   M3 step 5b (weapons.ts' masteries; the decider-side terms are in greedy.ts):
//   weaponAttack near  Cleave's second strike: only at a creature within 5 ft of the one hit
//   weaponAttack light the Light extra attack: only with a Light weapon other than the one used
//   apply (tokens)     Sap's Disadvantage and Vex's Advantage on one next roll (cond.ts tokenValue)
//   forced straight    a push's new position for the pushed creature's next turn (cond.ts placeValue,
//                      plus the pusher's strikes still to come), on top of the zones it crosses
//   Coverage 8'b G6, the lasting-effect term (docs/design/coverage.md section 2, m7): one value for
//   anything that keeps paying (a buff, a mark, an aura, a sustained effect, a zone):
//     what it does now + its per-round payoff x its expected remaining rounds
//   and the caller takes off its activation cost (castValue, useValue). Expected remaining rounds
//   is future(w, its duration, stay): `stay` is the chance per round it's still running, from the
//   existing drop-risk (pDrop) and, under concentration, concentration-break terms (VCtx.stay). It
//   REPLACES v5's two valuations of the same thing, the per-round term with its after-the-fact
//   first-round scale in castValue and a live zone's appear-plus-round in concValue, so a zone is
//   counted once: when cast by zoneValue, and while live by lastingPerRound at its per-round payoff.
//   Readers for later content plug in at `payoff`: a mod on attack rolls (cond.ts modPerRound),
//   stats, turn hooks and grants are there now; Rage, Bless and Hunter's Mark add content only.
// Heuristics are named where they enter, with their constants; the weights are in weights.ts.

import type { AdvState } from '../../rolls/rollspec.ts';
import type { BoundEffect, CompiledDamage, Step } from '../../content/types.ts';
import { HOOK } from '../../content/types.ts';
import { saveKey } from '../../content/rollkeys.ts';
import type { ExprNode } from '../../dice/expr.ts';
import { anchorLine, areaCells, areaCellsFrom, creatureOriginPoint, NO_AIM, originPoint, sizeFtOf } from '../../grid/area.ts';
import { COVER_BONUS } from '../../grid/los.ts';
import { coverAt, coverFromOrigin, losMode, saveCoverDegree, targetable } from '../../sim/cover.ts';
import { probAtLeast, type Pmf } from '../../odds/pmf.ts';
import { aimCandidates as aimQuery, areaCandidates, type AimCand, type AreaCand } from '../../query/area.ts';
import { forcedPaths, type ForcedPath } from '../../query/forced.ts';
import { expectedCapped } from '../../query/odds.ts';
import type { QueryScratch } from '../../query/scratch.ts';
import { attackKeyOf, buildAttackSpecFor } from '../../sim/attack.ts';
import { saveSpec } from '../../sim/d20.ts';
import { boundOf, ledgerOk, resetFold } from '../../sim/effects.ts';
import { gatesOk } from '../../sim/stats.ts';
import { oddsFlags, readFlag, zoneSpares, type Fx, type QueryState, type Unit } from '../../sim/state.ts';
import { speedNow } from '../../sim/damage.ts';
import { checkP, conditionValue, endCondValue, endSourceValue, isTokenMod, liveChangeValue, modPerRound, statsValue, tempHpValue, tokenValue, TERM } from './cond.ts';
import type { RiderMemo } from './cond.ts';
import { quickOdds } from './odds.ts';
import { future, type Weights } from './weights.ts';

/** Friendly fire counts this much more than the same harm to an enemy. */
const FRIENDLY = 1.5;
/** A creature that knows a zone and can leave stays in it (or re-enters) this often per round. */
const STAY_AWARE = 0.35;
/** A movable zone is re-placed on the best target each round at this fraction (moving it costs the action). */
const MOVE_SHARE = 0.5;
/** Granted options compete for their action: how often one is worth taking on a later turn. */
const GRANT_SHARE = { bonus: 0.6, action: 0.3 } as const;
/** A one-use Advantage rider is spent by one attack, worth about this share of that attack. */
const ADV_SHARE = 0.2;
/** Heals: value per HP restored, before danger. */
const HEAL_RATE = 0.8;
/** Getting a downed PC up: a flat bonus, and another at two failed death saves. */
const RESCUE = 10;
/** Chance per round that a slot-cast heal happens, for slot-heal hooks. */
const SLOT_HEAL_RATE = 0.3;
/** Coverage sets tried per zone placement (design 1.3's A). */
export const ANCHORS = 6;
/** Coverage sets tried per aimed area per square [U: 3 chosen for perf, docs/design/step7-plan.md section 7]. */
export const AIM_SETS = 3;
/**
 * Session S [U: a stand-in, not measured]: the chance a round of mine deals damage with an attack or a
 * spell, for a once-per-own-turn rider an effect switches on (selfHas) before any such attack is known.
 * Greedy v11 follow-up [U, not tuned]: measured at about 0.58 effective for a level-5 attacker and about
 * 0.2 for a level-3 caster whose damage is mostly a zone's on other creatures' turns (the rider fires
 * only on the bearer's own turn), so it runs high for casters.
 */
const SELF_RIDER_DEAL = 0.6;

export interface VCtx {
  readonly st: QueryState;
  readonly qs: QueryScratch;
  readonly me: Unit;
  readonly w: Weights;
  dist(a: number, b: number): number;
  /** Damage distribution of `parts` against `t` (cached by the decider). */
  dmg(parts: readonly CompiledDamage[], t: Unit, crit: boolean, adv: boolean, half: boolean): Pmf;
  killValue(t: Unit): number;
  /** Coverage 8'b G3: what `nonLethal` expected damage on `t` is worth in foe output removed (0 off the PC side). */
  progress(t: Unit, nonLethal: number): number;
  /** Expected damage `t` could take on `cell` before its next turn. */
  threat(t: Unit, cell: number): number;
  /** How much `gain` more HP cuts `t`'s drop chance before its next turn on `cell` (the end-cost curve, `pDrop`). */
  dropCut(t: Unit, cell: number, gain: number): number;
  /** Best routine my side (other than me) could aim at `t` next: what an Advantage rider improves. */
  allyStrike(t: Unit): number;
  /** Per-round value of my current concentration (0 if none). */
  concValue(): number;
  /**
   * Coverage 8'b G6: the chance per round that what I keep running from `from` is still running: I
   * stay up (pDrop over my exposure there) and, for `conc`, keep my concentration (the break chance
   * over the saves I expect there).
   */
  stay(from: number, conc: boolean): number;
  /** Coverage 8'b G5: the one enemy among `cands` a target style narrows to from `from`, -1 when it doesn't (`ev`). */
  styleOf(from: number, cands: readonly Unit[]): number;
  /** Expected concentration saves I make per round. */
  concSaves(): number;
  /** Mean of a dice expression (cached by the decider). */
  meanOf(e: ExprNode): number;
  /** Will `u` walk toward my side (melee is its better routine, or nothing is in its normal range)? Only those cross a zone to get at someone. */
  prefersMelee(u: Unit): boolean;
  /** Per-decision cache of zone values: effect -> (anchor * 1024 + rounds) -> value. */
  readonly zoneCache: Map<BoundEffect, Map<number, number>>;
  /** Coverage step 7.2: per-decision cache of aim candidates: (shape key, the square it starts from) -> sets. */
  readonly aimCache: Map<number, readonly AimCand[]>;
  /** Per-decision cache of best pulls: (target * 65536 + square) -> [value, path]. */
  readonly pullCache: Map<number, [number, ForcedPath | null]>;
  /** G8: per-decision memo of rider valuations (cond.ts RiderMemo: a rider's stats and the Sap/Vex tokens on a creature). */
  readonly riderMemo: RiderMemo;
  /**
   * M3 step 4 (cond.ts): `a`'s Attack routine against defender `d` (its AC now, its damage
   * defenses), melee and ranged strikes rolled in the given cond.ts MODE. `d` may be a what-if
   * copy (a condition or stat added).
   */
  routineX(a: Unit, d: Unit, melee: number, ranged: number): { readonly melee: number; readonly ranged: number; readonly reachFt: number; readonly rangeFt: number };
  /** cond.ts TERM bits switched off (explain's per-term breakdown); 0 always while deciding. Caches are bypassed while any is set. */
  readonly mute: number;
  /**
   * M3 step 5a (econ.ts). The best single strike a weaponAttack step can make from `from`, its
   * free riders on a hit included (`grant`: the activation making it, for grantedBy riders).
   */
  weaponStrike(s: Extract<Step, { k: 'weaponAttack' }>, from: number, grant: string, mute: number, first: Unit | null): number;
  /** What the Dodge action is worth to me ending on `cell` (0 when it's already up or can't hold). */
  dodge(cell: number): number;
  /** What a Dash is worth now: the strikes it brings in reach that nothing else does (0 when engaged). */
  dash(): number;
  /** What one more action is worth now: a fresh Attack action's strikes from the best square. */
  extraAction(): number;
  /** What changing my pool `res` by `delta` points (already clamped) is worth: each point at its in-fight value. */
  poolGain(res: number, delta: number): number;
  /**
   * M3 step 5b. Pushing `t` straight to `cell` (Push): its new position for its next turn (cond.ts
   * placeValue) and what it does to my strikes still to come this turn.
   */
  pushPlace(t: Unit, cell: number): number;
  /** Do I have a strike left this turn after the one being valued (Vex's Advantage used now, not next turn)? */
  laterStrike(): boolean;
  /** Review AI-4: how many of my strikes are left this turn after the one being valued (the Light extra attack included). */
  laterStrikes(): number;
  /**
   * Review AI-4: valuing a weapon mastery's rider (Topple): a Prone it imposes on my turn is worth
   * the strikes that land before the target rights itself on its next turn, not a whole round.
   * Undefined everywhere else (Open Hand's Prone keeps v5's value).
   */
  readonly proneWindow?: true;
  /**
   * Session S (repo half). What rider `ri` of mine is worth on `t` if it fires now (its best option,
   * net of its pool cost; 0 when its scope, gates or pool rule it out): `ignoreSelfHas` reads its selfHas
   * gates as holding (an effect not applied yet). Undefined in a VCtx without a decision view.
   */
  riderOn?(ri: number, t: Unit, ignoreSelfHas: boolean): number;
  /** Session S: the free dealtDamage riders a spell attack `atk` carries on `t`, at `hitP` (greedy.ts freeRiders); `roll` (W1, P5): the roll's resolved Advantage state, for the roll-state gates. */
  spellAttackRiders?(atk: Extract<Step, { k: 'attack' }>['atk'], t: Unit, hitP: number, roll?: AdvState): number;
  // ---- W1 (docs/design/w1-plan.md). Set only for a template that carries a W1 field (greedy.ts, w1.ts w1Kit), so every other VCtx is as before. ----
  /** P2: what my live concentration still has in it (greedy.ts concLeft: per round x its rounds left). */
  concLeft?(): number;
  /** P2: the best cast's margin over my best non-cast option this turn (0 with no spells). */
  castMargin?(): number;
  /** P3: my expected hits per round on `t` with the attacks that carry rider `ri` (strikes x P(hit)). */
  hitsPerRound?(ri: number, t: Unit): number;
  /** P9: what a free move of half my Speed from `from` is worth: the end cost there less the best end cost among the squares it reaches (0 at best). */
  freeMove?(from: number): number;
  /** P11: Advantage on my next attack roll from `from`: my best strike with it less my best without, riders it unlocks included. */
  advGain?(from: number): number;
  /** P7: valuing a firstAttack decision: no attack roll made this turn yet, so a once-per-own-turn rider an effect switches on can still fire this turn. */
  readonly beforeFirstRoll?: true;
  /** P1 (W1.2): on my turn decision, an attack roll against an enemy is still coming this turn (my Attack action is open and an enemy is in reach from here or a destination), so it extends a sustained effect anyway. */
  rollComing?(): boolean;
  /**
   * P1 (W1 review): what starting the sustained effect whose template is `rootTpl` afresh would cost
   * me (its activation's pool use, greedy.ts activationCost); 0 when no activation of mine starts it.
   */
  restartCost?(rootTpl: number): number;
}

/** P(t fails a save) right now: the engine's own save spec (effects folded), read with quick odds; `cover` (grid/los.ts COVER) adds its bonus. */
function failP(v: VCtx, t: Unit, key: number, dc: number, cover = 0, targetAdv?: true): number {
  const qs = v.qs;
  qs.adv.length = 0;
  qs.dis.length = 0;
  resetFold(qs.fold);
  const spec = saveSpec(v.st, t, key, dc, qs.adv, qs.dis, qs.fold, targetAdv);
  return 1 - quickOdds(cover > 0 ? { ...spec, flat: spec.flat + COVER_BONUS[cover]! } : spec, oddsFlags(v.st)).pSuccess;
}

/**
 * M3 step 8: a Dexterity save's cover as sim/steps.ts saveCover gives it: from a zone's point of
 * origin (`f.origin`), else from where I cast (`f.from`) on anyone but me; a raw Total reads as
 * Three-Quarters and `ignoresCover` drops Half and Three-Quarters (saveCoverDegree).
 */
function saveCoverV(v: VCtx, f: Frame, t: Unit, ignoresCover: 'partial' | undefined): number {
  if (losMode(v.st) === 0) return 0;
  if (f.origin !== undefined && f.origin >= 0) {
    const [x4, y4, oc] = f.originAim !== undefined ? creatureOriginPoint(v.st, f.originKey!, f.origin, f.originAim) : originPoint(v.st, f.origin);
    return saveCoverDegree(coverFromOrigin(v.st, x4 / 2, y4 / 2, oc, t, null), ignoresCover);
  }
  if (t === v.me || f.srcFx >= 0) return 0;
  return saveCoverDegree(coverAt(v.st, v.me, f.from, t.cell, t, null), ignoresCover);
}

/** What the walk carries: chosen targets, a zone anchor, a pending crit, forced choices. */
interface Frame {
  from: number;
  targets: readonly Unit[];
  crit: boolean;
  adv: boolean;
  /** A forced first target (a target decision's candidate) and a forced anchor (a place decision's). */
  target: number;
  anchor: number;
  /** For apply-to-point inside a cast: the anchors to try (the decider's candidates), and the spell's range for finding them. */
  anchors: readonly number[] | null;
  rangeFt: number;
  /** The live effect whose grant is running (an escape's endSource ends it); -1 for none. */
  srcFx: number;
  /**
   * Set when the caller multiplies this run by its rounds (a bearer hook, a zone's per-round
   * hooks, a grant used each turn): a condition step is then worth this many of the target's
   * turns per run, not its whole duration (cond.ts conditionValue). Absent: a one-shot run.
   */
  perTurn?: number;
  /** M3 step 5a: the activation running this program (its local id), for grantedBy riders; '' for none. */
  grant?: string;
  /** Its action cost: a Dash bought with the action itself leaves no action to strike with. */
  actCost?: string;
  /** M3 step 8: a zone's anchor while its appear hooks are valued (a Dexterity save's cover comes from its point of origin). */
  origin?: number;
  /** Coverage step 7.2: `origin` is a creature's square: the zone's shape and aim (NO_AIM around it). Absent: a lattice anchor. */
  originKey?: number;
  originAim?: number;
  /** Coverage 8'b G6: the program runs under concentration: the chance per round it's still running (VCtx.stay). Absent: 1. */
  stay?: number;
  /** Session S: a spell's own program (its damage feeds a spellDamage rider), until one step has counted it. */
  spell?: true;
}

/**
 * Session S: the best spellDamage rider of mine on any of `ts` (each at `pDmg(t)`, the chance this
 * step damages it), once per program: "once on each of your turns" spends it on one creature.
 */
function spellRiderBest(v: VCtx, ts: readonly Unit[], pDmg: (t: Unit) => number): number {
  const rs = v.me.tpl.riders;
  if (!rs || !v.riderOn || v.mute & TERM.spellRider) return 0;
  let best = 0;
  for (let ri = 0; ri < rs.length; ri++) {
    if (!rs[ri]!.spellDamage) continue;
    for (const t of ts) if (t.life === 'up') best = Math.max(best, pDmg(t) * v.riderOn(ri, t, false));
  }
  return best;
}

const friendly = (v: VCtx, t: Unit) => t.team === v.me.team;

/** HP-capped damage plus kill value and (coverage 8'b G3) the non-lethal part's progress credit; negative for my side. */
function harm(v: VCtx, t: Unit, parts: readonly CompiledDamage[], crit: boolean, adv: boolean, half: boolean): number {
  if (t.life === 'dead') return 0;
  const d = v.dmg(parts, t, crit, adv, half);
  if (t.life !== 'up') {
    // A downed creature: damage is a death-save failure (a crit two), not HP.
    const fails = probAtLeast(d, 1) * (crit ? 2 : 1);
    const val = (fails / Math.max(1, 3 - t.deathFail)) * v.killValue(t);
    return friendly(v, t) ? -FRIENDLY * val : val;
  }
  const cap = t.hp + t.tempHp;
  const hp = expectedCapped(d, cap);
  const drop = probAtLeast(d, cap);
  if (friendly(v, t)) return -FRIENDLY * (hp + drop * RESCUE * 2);
  return hp + drop * v.killValue(t) + (v.mute & TERM.progress ? 0 : v.progress(t, hp - drop * cap));
}

/**
 * A heal on `t`, cast from `from` (where I end my turn). A standing friend's heal is also worth the
 * drop chance it removes times what getting them back up would be worth (killValue + RESCUE), so
 * keeping someone up pays about what reversing a drop does. The drop chance is the end-cost curve
 * (`pDrop`): for me over my exposure where I end, for anyone else over the threat to them. Paying it
 * at `dropRisk` (a ranking weight) overpaid, and an exact drop chance from the foes' damage PMFs
 * did worse than the curve; docs/design/m3.md step 0 build note has the measurements.
 */
function healValue(v: VCtx, t: Unit, amount: number, from: number): number {
  if (t.life === 'dead') return 0;
  if (!friendly(v, t)) return -Math.min(amount, t.hpMax - t.hp);
  if (t.life !== 'up') return v.killValue(t) + RESCUE + (t.deathFail >= 2 ? RESCUE : 0) + HEAL_RATE * Math.min(amount, t.hpMax);
  const gain = Math.min(amount, t.hpMax - t.hp);
  if (gain <= 0) return 0;
  const e = v.threat(t, t.cell);
  const danger = Math.min(1, Math.max(0.25, e / Math.max(1, t.hp)));
  const cut = v.dropCut(t, t === v.me ? from : t.cell, gain);
  const keep = cut * (v.killValue(t) + RESCUE);
  return HEAL_RATE * gain * danger + keep;
}

function legalTargets(v: VCtx, s: Extract<Step, { k: 'target' }>, from: number): Unit[] {
  const out: Unit[] = [];
  for (const u of v.st.units) {
    if (u.life === 'dead' || u.tpl.size > s.maxSize) continue;
    if (s.who === 'ally' && u.team !== v.me.team) continue;
    if (s.who === 'enemy' && u.team === v.me.team) continue;
    if (u === v.me) {
      if (s.self === 'no' || (s.self === 'textSilent' && readFlag(v.st, 'selfTargetWhenTextSilent') === 'notAllowed')) continue;
    } else if (v.dist(from, u.cell) > s.rangeFt || !targetable(v.st, from, u.cell, null)) continue; // M3 step 8: not behind Total Cover
    out.push(u);
  }
  return out;
}

/**
 * Coverage 8'b G6: an effect's expected remaining rounds, discounted: its duration within the
 * horizon, each round after the first only if it's still running (`stay`).
 */
function rounds(v: VCtx, te: BoundEffect, parentRounds: number, stay = 1): number {
  const d = te.dur;
  // W1 (P1): a sustained effect (Rage) lasts until the end of my next turn and is extended each turn I
  // attack, force a save or spend a Bonus Action (srd-raw.txt:4985-4993), which is always open to me:
  // it counts as lasting the horizon, discounted by `stay` alone.
  const n = d.k === 'rounds' ? d.n : d.k === 'untilTurn' ? (sustained(v, te) ? parentRounds : 1) : parentRounds;
  return future(v.w, n, stay);
}

/** W1 (P1): `te` is a sustained effect, valued as one (TERM.sustain mutes it, for Explain). */
const sustained = (v: VCtx, te: BoundEffect): boolean => te.sustain !== undefined && !(v.mute & TERM.sustain);

function run(v: VCtx, steps: readonly Step[], i: number, f: Frame, parentRounds: number): number {
  let total = 0;
  for (; i < steps.length; i++) {
    const s = steps[i]!;
    switch (s.k) {
      case 'target': {
        const cands = legalTargets(v, s, f.from);
        if (f.target >= 0) {
          const t = cands.find((u) => u.idx === f.target);
          if (!t) return total;
          return total + run(v, steps, i + 1, { ...f, targets: [t], target: -1 }, parentRounds);
        }
        if (cands.length === 0) return total;
        const narrowed = v.w.targetStyle === 'ev' ? -1 : v.styleOf(f.from, cands); // G5: other enemies aren't candidates
        let best = -Infinity;
        for (const t of cands) if (narrowed < 0 || t.idx === narrowed || t.team === v.me.team) best = Math.max(best, run(v, steps, i + 1, { ...f, targets: [t] }, parentRounds));
        return total + best;
      }
      case 'attack': {
        for (const t of f.targets) {
          if (t.life === 'dead') continue;
          const qs = v.qs;
          const spec = buildAttackSpecFor(v.st, v.me, s.atk, t, f.from, qs.adv, qs.dis, qs.fold);
          const o = quickOdds(spec, oddsFlags(v.st));
          const [p, crit] = [o.pSuccess, o.pCrit];
          const adv = spec.adv === 'adv';
          // Session S: the branch's damage is the attack's; its riders are the attack's (below), not a spell's own.
          const fb: Frame = f.spell ? { ...f, spell: undefined } : f;
          const hit = run(v, s.onHit, 0, { ...fb, targets: [t], crit: false, adv }, parentRounds);
          const critV = crit > 0 ? run(v, s.onHit, 0, { ...fb, targets: [t], crit: true, adv }, parentRounds) : 0;
          const miss = s.onMiss.length > 0 ? run(v, s.onMiss, 0, { ...fb, targets: [t] }, parentRounds) : 0;
          total += (p - crit) * hit + crit * critV + (1 - p) * miss;
          // Session S: a spell attack's free riders (a dealtDamage rider that takes spell attacks), at P(hit).
          if (s.atk.onHit && v.spellAttackRiders && !(v.mute & TERM.spellRider)) total += v.spellAttackRiders(s.atk, t, p, spec.adv);
        }
        break;
      }
      case 'save': {
        // Session S: kept only for a spell whose damage feeds a spellDamage rider (f.spell), so other walks allocate nothing new.
        const pfs: number[] | null = f.spell && s.dmg ? [] : null;
        for (const t of f.targets) {
          if (t.life === 'dead') {
            pfs?.push(0);
            continue;
          }
          const pf = failP(v, t, s.key, s.dc, s.ability === 1 ? saveCoverV(v, f, t, s.ignoresCover) : 0, s.targetAdv);
          pfs?.push(pf);
          const fail = (s.dmg ? harm(v, t, s.dmg, false, false, false) : 0) + (s.onFail.length > 0 ? run(v, s.onFail, 0, { ...f, targets: [t] }, parentRounds) : 0);
          const pass = (s.dmg && s.half ? harm(v, t, s.dmg, false, false, true) : 0) + (s.onSuccess.length > 0 ? run(v, s.onSuccess, 0, { ...f, targets: [t] }, parentRounds) : 0);
          total += pf * fail + (1 - pf) * pass;
        }
        // Session S: a spell's save damage feeds a spellDamage rider (damage on a failure, or half on a success).
        if (pfs) {
          const ts = f.targets;
          total += spellRiderBest(v, ts, (t) => (s.half ? 1 : pfs[ts.indexOf(t)]!));
          f = { ...f, spell: undefined };
        }
        break;
      }
      case 'damage':
        for (const t of f.targets) total += harm(v, t, s.dmg, f.crit, f.adv, false);
        f = { ...f, crit: false }; // only the first damage step pairs with the attack's crit
        if (f.spell) {
          total += spellRiderBest(v, f.targets, () => 1);
          f = { ...f, spell: undefined };
        }
        break;
      case 'around': {
        // Session S: everyone in the Emanation around me where I'd be (the engine's mask and wall cut-off), me never; allies count against (harm).
        if (v.mute & TERM.around) {
          f = { ...f, targets: [] };
          break;
        }
        const cells: number[] = [];
        areaCellsFrom(v.st, s.key, f.from, NO_AIM, cells);
        const ts: Unit[] = [];
        for (const u of v.st.units) {
          if (u === v.me || u.life === 'dead' || !cells.includes(u.cell)) continue;
          if (s.who === 'ally' && u.team !== v.me.team) continue;
          if (s.who === 'enemy' && u.team === v.me.team) continue;
          ts.push(u);
        }
        f = { ...f, targets: ts };
        break;
      }
      case 'heal': {
        const amount = v.meanOf(s.roll);
        for (const t of f.targets) total += healValue(v, t, amount, f.from);
        break;
      }
      case 'apply': {
        // W1 (P3, P10): a gated apply (Frenzy's arming step) runs only if its gates hold on me now.
        if (s.when && !gatesOk(v.st, v.me, s.when, null)) break;
        const te = v.me.tpl.effects[s.fx]!;
        if (s.to === 'point') {
          if (!te.zone) break;
          if (te.zone.from === 'bearer') total += zoneValue(v, te, f.from, parentRounds, f.stay, NO_AIM);
          else if (te.zone.from === 'aim') {
            let best = 0;
            for (const c of aimCandidates(v, te, f.from)) best = Math.max(best, zoneValue(v, te, f.from, parentRounds, f.stay, c.aim));
            total += best;
          } else if (f.anchor >= 0) total += zoneValue(v, te, f.anchor, parentRounds, f.stay);
          else {
            let best = 0;
            for (const a of f.anchors ?? zoneAnchors(v, te, f.from, f.rangeFt)) best = Math.max(best, zoneValue(v, te, a, parentRounds, f.stay));
            total += best;
          }
        } else {
          const bearer = s.to === 'self' ? v.me : f.targets[0];
          if (bearer) total += effectValue(v, te, bearer, f, parentRounds);
        }
        break;
      }
      case 'use': {
        const g = v.me.tpl.effects[s.fx]!.grants[s.grant];
        if (g) total += run(v, g.steps, 0, { ...f, targets: [], target: -1 }, parentRounds);
        break;
      }
      case 'forced':
        for (const t of f.targets) total += bestPull(v, t, s, f.from)[0];
        break;
      case 'choose': {
        let best = -Infinity;
        for (const o of s.opts) best = Math.max(best, run(v, o.steps, 0, f, parentRounds));
        if (best > -Infinity) total += best;
        return total; // the engine runs the chosen option and stops there
      }
      case 'chooseSkill':
      case 'moveZone':
        break; // a skill for a check: no combat value; moving a zone is valued by moveZoneValue
      // M3 step 4 (cond.ts has the model and the rule cites).
      case 'condition':
        for (const t of f.targets) total += conditionValue(v, s, t, parentRounds, f.perTurn, f.stay);
        break;
      case 'tempHp': {
        const amount = v.meanOf(s.roll);
        for (const t of f.targets) total += tempHpValue(v, t, amount, f.from, future(v.w));
        break;
      }
      case 'check': {
        const p = checkP(v, s);
        const ok = s.onSuccess.length > 0 ? run(v, s.onSuccess, 0, f, parentRounds) : 0;
        const no = s.onFail.length > 0 ? run(v, s.onFail, 0, f, parentRounds) : 0;
        total += p * ok + (1 - p) * no;
        break;
      }
      case 'endSource':
        total += endSourceValue(v, f.srcFx);
        return total; // the source is gone: nothing after it runs under it
      // W1 (docs/design/w1-plan.md).
      case 'extendSource':
        if (!(v.mute & TERM.extend)) total += extendValue(v, f.srcFx);
        break;
      case 'endConditions':
        total += endCondValue(v, s.bits);
        break;
      case 'move':
        if (!(v.mute & TERM.freeMove) && v.freeMove) total += v.freeMove(f.from);
        break;
      case 'condSave':
        break; // a condition's own repeat save: valued in its duration (cond.ts condTurns)
      // M3 step 5a (econ.ts has the model and the rule cites).
      case 'weaponAttack':
        if (!(v.mute & TERM.strikes)) total += s.count * v.weaponStrike(s, f.from, f.grant ?? '', v.mute, s.near ? (f.targets[0] ?? null) : null);
        break;
      case 'core':
        if (s.act === 'dodge' && !(v.mute & TERM.dodge)) total += v.dodge(f.from);
        else if (s.act === 'dash' && f.actCost !== 'action' && !(v.mute & TERM.econ)) total += v.dash();
        break; // disengage: valued by the turn decision against the provoking move it allows
      case 'gainAction':
        if (!(v.mute & TERM.econ)) total += v.extraAction();
        break;
      case 'pool': {
        if (s.res < 0 || v.mute & TERM.pool) break;
        const left = v.me.res[s.res]!;
        const max = v.me.tpl.resMax[s.res]!;
        const want = s.delta === 'refill' ? max : left + s.delta;
        const after = want < 0 ? 0 : want > max ? max : want;
        if (after !== left) total += v.poolGain(s.res, after - left);
        break;
      }
    }
  }
  return total;
}

/** Value of `steps` run by `v.me` from `from`. `target`/`anchor` force the first target or the zone anchor (-1: best). */
export function programValue(v: VCtx, steps: readonly Step[], from: number, opts: { target?: number; anchor?: number; anchors?: readonly number[] | null; parentRounds?: number; rangeFt?: number; srcFx?: number; grant?: string; actCost?: string; targets?: readonly Unit[]; stay?: number; spell?: true } = {}): number {
  const f: Frame = { from, targets: opts.targets ?? [], crit: false, adv: false, target: opts.target ?? -1, anchor: opts.anchor ?? -1, anchors: opts.anchors ?? null, rangeFt: opts.rangeFt ?? 0, srcFx: opts.srcFx ?? -1 };
  if (opts.spell) f.spell = true;
  if (opts.grant !== undefined) f.grant = opts.grant;
  if (opts.actCost !== undefined) f.actCost = opts.actCost;
  if (opts.stay !== undefined) f.stay = opts.stay;
  return run(v, steps, 0, f, opts.parentRounds ?? 10);
}

/** Exported for greedy.ts: HP-capped damage plus kill value of `parts` on `t` (negative for my side). */
export const harmOf = harm;
/** Exported for greedy.ts: a heal of `amount` on `t` cast from `from`. */
export const healOf = healValue;

/** Does `steps` (or a branch under it) heal? */
function heals(steps: readonly Step[], i: number): boolean {
  for (; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.k === 'heal') return true;
    if (s.k === 'attack' && (heals(s.onHit, 0) || heals(s.onMiss, 0))) return true;
    if (s.k === 'save' && (heals(s.onFail, 0) || heals(s.onSuccess, 0))) return true;
    if (s.k === 'check' && (heals(s.onSuccess, 0) || heals(s.onFail, 0))) return true;
    if (s.k === 'choose' && s.opts.some((o) => heals(o.steps, 0))) return true;
  }
  return false;
}

/**
 * Coverage 8'b, m10 (G1's rescue term): the longest range at which `steps` can heal a creature other
 * than its user (a `target` step open to allies followed by a heal), or -1 when it can't. A
 * self-only program (`target: self`, no target step) is -1: it rescues no one.
 */
export function healReach(steps: readonly Step[]): number {
  let best = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.k === 'target' && s.who !== 'enemy' && s.rangeFt > best && heals(steps, i + 1)) best = s.rangeFt;
    else if (s.k === 'choose') for (const o of s.opts) best = Math.max(best, healReach(o.steps));
  }
  return best;
}

/** Value of each option of a choose step (in option order), or null if the program has none. */
export function chooseValues(v: VCtx, steps: readonly Step[], from: number): number[] | null {
  for (const s of steps) {
    if (s.k === 'choose') return s.opts.map((o) => run(v, o.steps, 0, { from, targets: [], crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1 }, 10));
    if (s.k === 'use') {
      const g = v.me.tpl.effects[s.fx]!.grants[s.grant];
      const inner = g ? chooseValues(v, g.steps, from) : null;
      if (inner) return inner;
    }
  }
  return null;
}

// ---- effects ----

function effectValue(v: VCtx, te: BoundEffect, bearer: Unit, f: Frame, parentRounds: number): number {
  if (te.conc) return 0; // a concentration instance: its children carry the value
  // Coverage 8'b G6: an effect on me is worth nothing while I'm down, concentration or not.
  // W1 (P1): a sustained effect isn't a one-turn effect, so P(I'm up) discounts it too (its one discount: the Bonus Action extension is always open).
  const stay = f.stay ?? (bearer === v.me && (te.dur.k !== 'untilTurn' || sustained(v, te)) ? v.stay(f.from, false) : 1);
  const r = rounds(v, te, parentRounds, stay);
  return payoff(v, te, bearer, f, parentRounds, r, Math.max(0, r - 1));
}

/**
 * An effect's value over `r` rounds on `bearer`, `later` of them for a granted option (it can't be
 * used the turn it's created): its one-roll tokens and riders once, the rest per round.
 */
function payoff(v: VCtx, te: BoundEffect, bearer: Unit, f: Frame, parentRounds: number, r: number, later: number): number {
  let total = 0;
  for (const m of te.mods) {
    // M3 step 5b: a one-roll token (Sap, Vex); null for every other mod, valued below as before.
    // Perf (W1): laterStrike only for a token mod (it's pure; every other mod's tokenValue is null).
    const tok = isTokenMod(m) ? tokenValue(v, te, m, bearer, v.laterStrike()) : null;
    if (tok !== null) {
      total += tok;
      continue;
    }
    if (m.consume) {
      if (m.op === 'adv' && m.side === 'incoming' && !friendly(v, bearer)) total += ADV_SHARE * v.allyStrike(bearer);
      // W1 (P11): Advantage on my own next attack roll (Steady Aim, srd-raw.txt:13790-13791): my best strike
      // from here with it, less without, so the riders it unlocks (Sneak Attack) count. No committed content
      // has a self consumed Advantage, so nothing else reads differently.
      else if (m.op === 'adv' && m.side === 'self' && bearer === v.me && v.advGain && !(v.mute & TERM.selfAdv) && onAttacks(v.me, m)) total += v.advGain(f.from);
    } else if (m.op === 'floor') {
      if (m.side !== 'self' || bearer !== v.me) continue;
      // A floor on my concentration saves: the drop in P(fail) at the usual DC 10, per save I expect.
      const con = v.me.tpl.saveMod[2]!;
      const spec = { kind: 'save' as const, adv: 'none' as const, flat: con, preDice: [], dc: 10 };
      const without = quickOdds(spec, oddsFlags(v.st)).pSuccess;
      const withF = quickOdds({ ...spec, floor: m.value }, oddsFlags(v.st)).pSuccess;
      if (m.on.some((p) => (saveKey(2, true) & p.mask) === p.val)) total += (withF - without) * v.concSaves() * v.concValue() * r;
    } else if (!(v.mute & TERM.lasting)) total += modPerRound(v, te, m, bearer) * r; // G6: a buff or a mark on attack rolls
  }
  for (const h of te.hooks) {
    if (h.on & HOOK.slotHeal) total += Math.max(0, run(v, h.steps, 0, { ...f, targets: [], target: -1 }, parentRounds)) * SLOT_HEAL_RATE * r;
    // perTurn: a condition a turn-end hook imposes covers the bearer's next turn, one turn later (gamma); at turn start or on damage, the turn it's in.
    if (h.on & (HOOK.turnStart | HOOK.turnEnd | HOOK.damaged)) {
      const fr = { ...f, targets: [bearer], target: -1, perTurn: h.on & (HOOK.turnStart | HOOK.damaged) ? 1 : v.w.gamma };
      if (bearer === v.me && r > 1 && isPulseHook(h) && !(v.mute & TERM.pulseLater)) {
        // Greedy v11: my turn-end pulse's first round in full; its later rounds without the kill and
        // progress credit, since a foe it drops now isn't there to drop again and who stands in reach
        // later isn't known: their expected damage only [U: the same creatures in reach each round].
        // Foes only: a downed ally in reach takes a death-save failure every round, so its loss keeps
        // counting (friendly-fire harm reads killValue for the downed).
        const later = { ...v, killValue: (t: Unit) => (friendly(v, t) ? v.killValue(t) : 0), mute: v.mute | TERM.progress };
        total += run(v, h.steps, 0, fr, parentRounds) + run(later, h.steps, 0, fr, parentRounds) * (r - 1);
      } else total += run(v, h.steps, 0, fr, parentRounds) * r;
    }
  }
  // M3 step 4: the stats it gives its bearer (AC, speed, defenses), through the same damage-per-round model as conditions (cond.ts).
  if (te.stats) total += statsValue(v, te, bearer, r);
  for (const g of te.grants) {
    if (g.to !== 'owner' || g.steps.some((s) => s.k === 'moveZone')) continue;
    total += Math.max(0, run(v, g.steps, 0, { ...f, targets: [], target: -1, perTurn: 1 }, parentRounds)) * GRANT_SHARE[g.cost] * later;
  }
  if (bearer === v.me) {
    // Greedy v11: a once-per-own-turn rider can't fire again on a turn whose action is already spent
    // (the activation came after it), so this turn's round doesn't count [U: a bonus-action spell
    // attack could still trigger it; ignored, a floor].
    const sr = selfRiderValue(v, te, f.from);
    // W1 (P7): at a firstAttack decision no attack roll has been made, so this turn still counts.
    if (sr !== 0) total += sr * (v.st.active === v.me.idx && v.me.b.action === 0 && !v.beforeFirstRoll ? Math.max(0, r - 1) : r);
  }
  return total;
}

/**
 * Session S (C6): what effect `te` on me is worth per round through the riders it switches on (a
 * selfHas gate naming it): each such rider's best option on the nearest living hostile, at the
 * stand-in chance SELF_RIDER_DEAL that my round deals damage with an attack or a spell [U]. Riders
 * with a once-per-turn scope fire at most once a round; one without a scope is counted once a round too
 * [U: a floor]. 0 with no such rider, so nothing else reads differently.
 * W1 (P3): under a sustained effect (Rage), a rider with no once-per-turn scope (Rage Damage) counts my
 * expected hits per round on that creature (strikes x P(hit), VCtx.hitsPerRound) instead of the floor.
 * Gated on te.sustain, so no existing selfHas rider reads differently (R3).
 */
function selfRiderValue(v: VCtx, te: BoundEffect, from: number): number {
  const rs = v.me.tpl.riders;
  if (!rs || !v.riderOn || v.mute & TERM.selfRider) return 0;
  const fx = v.me.tpl.effects.indexOf(te);
  let near: Unit | null = null;
  let nd = Infinity;
  let total = 0;
  for (let ri = 0; ri < rs.length; ri++) {
    const when = rs[ri]!.when;
    if (!when || !when.some((g) => g.g === 'selfHas' && g.fx === fx)) continue;
    if (near === null) {
      for (const u of v.st.units) {
        if (u.life !== 'up' || u.team === v.me.team) continue;
        const d = v.dist(from, u.cell);
        if (d < nd) [nd, near] = [d, u];
      }
      if (near === null) return 0;
    }
    const perHit = te.sustain !== undefined && rs[ri]!.once === undefined && v.hitsPerRound && !(v.mute & TERM.perHit);
    total += (perHit ? v.hitsPerRound!(ri, near) : SELF_RIDER_DEAL) * v.riderOn(ri, near, true);
  }
  return total;
}

/**
 * W1 (P1): using an extendSource grant on the live sustained effect `fxId` (Rage's Bonus Action
 * extension, srd-raw.txt:4990): what it keeps for a round (lastingPerRound) when the effect would end
 * at the end of this turn (anchored to my turns, until.after < my turns), I've made no attack roll
 * yet this turn and none is coming (W1.2: an Attack action still open with an enemy in reach; either
 * roll would extend it anyway, so the Bonus Action buys nothing); else 0. What it keeps is the effect and everything
 * live under it (its children end with it: Rage's benefits sit on a child of the sustained root), each
 * at lastingPerRound, as concValue reads a concentration's; at least what a fresh start would cost
 * (VCtx.restartCost) before the fight's last round.
 */
function extendValue(v: VCtx, fxId: number): number {
  if (fxId < 0) return 0;
  const st = v.st;
  const fx = st.fx[fxId]!;
  if (!fx.alive || fx.bearer !== v.me.idx) return 0;
  const u = fx.until;
  if (u.k !== 'turnEnd' || u.unit !== v.me.idx || !(u.after < v.me.turns) || v.me.b.rolls > 0 || v.rollComing?.()) return 0;
  let keep = lastingPerRound(v, fx, boundOf(st, fx));
  for (const c of st.fx) {
    if (!c.alive || c.id === fxId) continue;
    let p = c.parent;
    while (p >= 0 && p !== fxId) p = st.fx[p]!.parent;
    if (p === fxId) keep += lastingPerRound(v, c, boundOf(st, c));
  }
  // W1 review: out of reach, what it keeps this round is about 0, but letting it lapse means paying a
  // fresh use to start it again when I next engage (4990: the Bonus Action keeps it for that). So it's
  // worth at least that use, unless this is the fight's last round (no later turn needs it).
  if (v.restartCost && st.round < st.setup.knobs.maxRounds) keep = Math.max(keep, v.restartCost(fx.tpl));
  return Math.max(0, keep);
}

/** W1 (P11): does mod `m` apply to one of `me`'s attack rolls (its pattern matches an attack's roll key)? */
function onAttacks(me: Unit, m: BoundEffect['mods'][number]): boolean {
  for (const a of me.tpl.attacks) {
    const key = attackKeyOf(a, false);
    for (const p of m.on) if ((key & p.mask) === p.val) return true;
  }
  return false;
}

const isPulseHook = (h: BoundEffect['hooks'][number]): boolean => (h.on & HOOK.turnEnd) !== 0 && h.steps.some((x) => x.k === 'around');

/** Greedy v11: effect `te` has a turn-end Emanation pulse (a turnEnd hook with an `around` step). */
export function hasPulse(te: BoundEffect): boolean {
  return (te.hookMask & HOOK.turnEnd) !== 0 && te.hooks.some(isPulseHook);
}

/** Greedy v11: `me` owns and bears a live effect with a turn-end Emanation pulse. */
export function livePulse(st: QueryState, me: Unit): boolean {
  if (!(me.hookMask & HOOK.turnEnd)) return false;
  for (const id of me.borne) {
    const fx = st.fx[id]!;
    if (fx.alive && fx.owner === me.idx && hasPulse(boundOf(st, fx))) return true;
  }
  return false;
}

/** Greedy v11: `steps` (a choice's options included) apply an effect of `effects` that has a turn-end pulse. */
export function appliesPulse(steps: readonly Step[], effects: readonly BoundEffect[]): boolean {
  for (const s of steps) {
    if (s.k === 'apply' && effects[s.fx] && hasPulse(effects[s.fx]!)) return true;
    if (s.k === 'choose' && s.opts.some((o) => appliesPulse(o.steps, effects))) return true;
  }
  return false;
}

/**
 * Session S: what my live effects' turn-end Emanation pulses (a turnEnd hook with an `around` step)
 * do if my turn ends on `cell`: the greedy move term that walks a pulse onto foes and off allies. 0
 * with none, so nothing else reads differently.
 */
export function pulseValue(v: VCtx, cell: number): number {
  const st = v.st;
  if (!(v.me.hookMask & HOOK.turnEnd)) return 0;
  let total = 0;
  for (const id of v.me.borne) {
    const fx = st.fx[id]!;
    if (!fx.alive || fx.owner !== v.me.idx) continue;
    const te = boundOf(st, fx);
    if (!hasPulse(te)) continue;
    for (const h of te.hooks) {
      if (!isPulseHook(h)) continue;
      total += run(v, h.steps, 0, { from: cell, targets: [v.me], crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1, perTurn: v.w.gamma }, 1);
    }
  }
  return total;
}

/**
 * Coverage 8'b G6 (m7): what a live effect of my concentration is worth per round, read where it is
 * now: a zone at its per-round payoff (its appear hooks have fired), anything else through `payoff`
 * for one round, with the conditions and stats it gives measured as the difference it's making.
 */
export function lastingPerRound(v: VCtx, fx: Fx, te: BoundEffect): number {
  if (te.conc) return 0;
  if (te.zone) return fx.anchor >= 0 ? zonePerRound(v, te, fx.anchor, te.zone.from ? (fx.aim ?? NO_AIM) : undefined) : 0;
  if (fx.bearer < 0) return 0;
  const bearer = v.st.units[fx.bearer]!;
  if (bearer.life === 'dead') return 0;
  const f: Frame = { from: v.me.cell, targets: [], crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1 };
  return payoff(v, te.stats ? { ...te, stats: undefined } : te, bearer, f, 1, 1, 1) + liveChangeValue(v, fx, te, bearer);
}

// ---- zones ----

/** A zone's `bit` hooks on `t`. `perTurn` (Frame.perTurn) when the caller multiplies it by the zone's rounds. */
function zoneHookValue(v: VCtx, te: BoundEffect, bit: number, t: Unit, from: number, perTurn?: number, owner: Unit = v.me): number {
  const affects = te.zone?.affects;
  if (affects !== undefined && zoneSpares(affects, owner, t)) return 0;
  let total = 0;
  for (const h of te.hooks) if (h.on & bit) total += run(v, h.steps, 0, { from, targets: [t], crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1, perTurn }, 10);
  return total;
}

/** Squares of this zone a melee-minded creature would cross per round heading for my side (straight line, its speed at most). */
function crossings(v: VCtx, cells: readonly number[], t: Unit): number {
  let goal = -1;
  let gd = Infinity;
  for (const u of v.st.units) {
    if (u.life !== 'up' || u.team === t.team) continue;
    const d = v.dist(t.cell, u.cell);
    if (d < gd) {
      gd = d;
      goal = u.cell;
    }
  }
  if (goal < 0) return 0;
  const w = v.st.setup.w;
  let x = t.cell % w;
  let y = Math.floor(t.cell / w);
  const gx = goal % w;
  const gy = Math.floor(goal / w);
  let n = 0;
  for (let k = 0; k < Math.floor(speedNow(t) / 5) && (x !== gx || y !== gy); k++) {
    x += Math.sign(gx - x);
    y += Math.sign(gy - y);
    if (cells.includes(y * w + x)) n++;
  }
  return n;
}

/** The squares of `te`'s zone at `anchor`: the lattice's (`aim` undefined), or from the creature's square `anchor`. */
function zoneCells(st: QueryState, te: BoundEffect, anchor: number, aim: number | undefined, out: number[]): void {
  if (aim === undefined) areaCells(st, te.zone!.shapeKey, anchor, out);
  else areaCellsFrom(st, te.zone!.shapeKey, anchor, aim, out);
}

/**
 * What a zone is worth landing at `anchor`: its appear hooks on whoever's there now, plus (coverage
 * 8'b G6) its per-round payoff x its expected remaining rounds. Both figures are cached per decision;
 * `stay` varies by the square I'd cast from, so it's applied to them on the way out. `aim`: a zone
 * with zone.from, whose `anchor` is a square; undefined for a lattice zone, whose keys are as ever.
 */
export function zoneValue(v: VCtx, te: BoundEffect, anchor: number, parentRounds: number, stay = 1, aim?: number): number {
  const r = rounds(v, te, parentRounds, stay);
  if (v.mute) return zoneAppear(v, te, anchor, parentRounds, aim) + (v.mute & TERM.lasting ? 0 : zonePerRound(v, te, anchor, aim) * r); // an explain what-if: never through (or into) the cache
  let cache = v.zoneCache.get(te);
  if (!cache) v.zoneCache.set(te, (cache = new Map()));
  const place = aim === undefined ? anchor : anchor + (aim + 2) * 1048576; // NO_AIM is -1; squares and anchors are far under 2^20
  const key = place * 1024 + Math.min(1023, parentRounds);
  let a = cache.get(2 * key);
  if (a === undefined) cache.set(2 * key, (a = zoneAppear(v, te, anchor, parentRounds, aim)));
  let p = cache.get(-1 - place);
  if (p === undefined) cache.set(-1 - place, (p = zonePerRound(v, te, anchor, aim)));
  return a + p * r;
}

/** Its appear hooks on whoever's under it at `anchor` (once, when it lands). */
function zoneAppear(v: VCtx, te: BoundEffect, anchor: number, parentRounds: number, aim?: number): number {
  const st = v.st;
  const cells: number[] = [];
  zoneCells(st, te, anchor, aim, cells);
  const on: Unit[] = [];
  const affects = te.zone!.affects;
  for (const u of st.units) if (u.life !== 'dead' && cells.includes(u.cell) && (affects === undefined || !zoneSpares(affects, v.me, u))) on.push(u);
  let appear = 0;
  for (const h of te.hooks) if (h.on & HOOK.appear) appear += run(v, h.steps, 0, { from: v.me.cell, targets: on, crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1, origin: anchor, ...(aim !== undefined ? { originKey: te.zone!.shapeKey, originAim: aim } : {}) }, parentRounds);
  // emanationCastTrigger=onCast: the cast fires the movedOnto hook on each creature in the first area.
  if (te.zone!.from === 'bearer' && te.hookMask & HOOK.movedOnto && readFlag(st, 'emanationCastTrigger') === 'onCast') {
    for (const h of te.hooks) if (h.on & HOOK.movedOnto) appear += run(v, h.steps, 0, { from: v.me.cell, targets: on, crit: false, adv: false, target: -1, anchor: -1, anchors: null, rangeFt: 0, srcFx: -1, origin: anchor, originKey: te.zone!.shapeKey, originAim: NO_AIM }, parentRounds);
  }
  return appear;
}

/** Coverage 8'b G6: what a zone at `anchor` pays per round: who stays in it, who it's moved onto, who walks through it. */
export function zonePerRound(v: VCtx, te: BoundEffect, anchor: number, aim?: number): number {
  const st = v.st;
  const cells: number[] = [];
  zoneCells(st, te, anchor, aim, cells);
  let perRound = 0;
  if (te.hookMask & (HOOK.enter | HOOK.turnEndIn)) {
    let stay = 0;
    let bestOne = 0;
    for (const u of st.units) if (u.life === 'up' && cells.includes(u.cell)) stay += zoneHookValue(v, te, HOOK.turnEndIn, u, v.me.cell, 1) * (u.tpl.speedFt > 0 ? STAY_AWARE : 1);
    if (te.grants.some((g) => g.steps.some((s) => s.k === 'moveZone'))) {
      for (const u of st.units) if (u.life === 'up' && u.team !== v.me.team) bestOne = Math.max(bestOne, zoneHookValue(v, te, HOOK.movedOnto | HOOK.turnEndIn, u, v.me.cell, 1) * MOVE_SHARE);
    }
    perRound += Math.max(stay, bestOne);
  }
  if (te.hookMask & HOOK.travel) {
    for (const u of st.units) {
      if (u.life !== 'up' || u.tpl.speedFt === 0 || !v.prefersMelee(u)) continue;
      const n = crossings(v, cells, u);
      if (n > 0) perRound += n * zoneHookValue(v, te, HOOK.travel, u, v.me.cell, 1) * (u.team === v.me.team ? STAY_AWARE : 1);
    }
  }
  // Coverage step 7.5 (C6) [U: value reviewed once]: an Emanation goes with me, so a foe in walking reach of it counts (I walk it onto them, or they walk in), which is what makes casting before walking worth it at the default emanationCastTrigger=none.
  if (te.zone!.from === 'bearer' && te.hookMask & (HOOK.movedOnto | HOOK.turnEndIn)) {
    const size = sizeFtOf(te.zone!.shapeKey);
    for (const u of st.units) {
      if (u.life !== 'up' || u.team === v.me.team || cells.includes(u.cell)) continue;
      const reach = Math.max(speedNow(v.me), v.prefersMelee(u) ? speedNow(u) : 0) + size;
      if (v.dist(anchor, u.cell) <= reach) perRound += zoneHookValue(v, te, HOOK.movedOnto | HOOK.turnEndIn, u, v.me.cell, 1) * MOVE_SHARE;
    }
  }
  return perRound;
}

/**
 * Anchors worth trying for a zone placed from `from` within `rangeFt`: one per distinct set of
 * creatures it would cover, plus (for zones creatures pay to cross) the squares between each
 * hostile and the nearest of my side. A short list, so planning stays cheap.
 */
export function zoneAnchors(v: VCtx, te: BoundEffect, from: number, rangeFt: number): number[] {
  if (te.zone!.from === 'bearer') return [from]; // around me, a square, wherever I cast it from
  const st = v.st;
  const out: AreaCand[] = [];
  areaCandidates(st, v.me, te.zone!.shapeKey, rangeFt, from, out, te.zone!.affects);
  // The best few coverage sets: most enemies, fewest allies (design 1.3: A = 6).
  const list = out
    .filter((c) => c.nEnemies > 0)
    .sort((a, b) => b.nEnemies - 2 * b.nAllies - (a.nEnemies - 2 * a.nAllies) || a.anchor - b.anchor)
    .slice(0, ANCHORS)
    .map((c) => c.anchor);
  if (te.hookMask & HOOK.travel && readFlag(st, 'areaOriginOnGrid') === 'squareCenter') {
    const w = st.setup.w;
    for (const e of st.units) {
      if (e.life !== 'up' || e.team === v.me.team) continue;
      let goal = -1;
      let gd = Infinity;
      for (const u of st.units) if (u.life === 'up' && u.team === v.me.team && v.dist(e.cell, u.cell) < gd) [gd, goal] = [v.dist(e.cell, u.cell), u.cell];
      if (goal < 0) continue;
      const mid = Math.floor((Math.floor(e.cell / w) + Math.floor(goal / w)) / 2) * w + Math.floor(((e.cell % w) + (goal % w)) / 2);
      if (v.dist(from, mid) <= rangeFt && !list.includes(mid)) list.push(mid);
      if (list.length >= 2 * ANCHORS) break;
    }
  }
  return list.sort((a, b) => a - b);
}

/**
 * Coverage step 7.2: the aims worth trying for an aimed area cast from `from`: one per distinct set
 * of creatures it would cover (query/area.ts), best first as zoneAnchors sorts them (most enemies,
 * fewest allies), at most AIM_SETS. Empty past the distance exit. Cached per decision. A cast and its
 * valuation both read this, so a cast does what it was valued for.
 */
export function aimCandidates(v: VCtx, te: BoundEffect, from: number): readonly AimCand[] {
  const shape = te.zone!.shapeKey;
  const affects = te.zone!.affects;
  const key = (shape * 65536 + from) * 4 + (affects === undefined ? 0 : affects === 'notOwner' ? 1 : affects === 'foes' ? 2 : 3);
  const hit = v.aimCache.get(key);
  if (hit) return hit;
  const out: AimCand[] = [];
  aimQuery(v.st, v.me, shape, from, out, affects);
  const list = out
    .filter((c) => c.nEnemies > 0)
    .sort((a, b) => b.nEnemies - 2 * b.nAllies - (a.nEnemies - 2 * a.nAllies) || a.aim - b.aim)
    .slice(0, AIM_SETS);
  v.aimCache.set(key, list);
  return list;
}

/** Units (not dead) covered by a zone shape at `anchor`, in seat order. */
function unitsUnder(st: QueryState, shapeKey: number, anchor: number, cells: number[]): Unit[] {
  areaCells(st, shapeKey, anchor, cells);
  return st.units.filter((u) => u.life !== 'dead' && cells.includes(u.cell));
}

/**
 * Who moving my zone to `anchor` would catch, decided exactly as sim/zones.ts moveZone decides
 * it: the creatures newly covered at the destination, or, when the straight line passes others
 * and movedAreaTriggersAlongPath is sweepPath, every creature it first touches on the way.
 * Creatures already inside aren't caught.
 */
function caughtByMove(v: VCtx, fx: { readonly anchor: number }, te: BoundEffect, anchor: number): Unit[] {
  const st = v.st;
  const key = te.zone!.shapeKey;
  const tmp: number[] = [];
  const before = unitsUnder(st, key, fx.anchor, tmp);
  const dest = unitsUnder(st, key, anchor, tmp).filter((u) => !before.includes(u));
  const line = anchorLine(st, fx.anchor, anchor);
  if (line.length <= 2) return dest;
  const sweep: Unit[] = [];
  for (let i = 1; i < line.length; i++) for (const u of unitsUnder(st, key, line[i]!, tmp)) if (!before.includes(u) && !sweep.includes(u)) sweep.push(u);
  if (sweep.length === dest.length && sweep.every((u) => dest.includes(u))) return dest;
  return readFlag(st, 'movedAreaTriggersAlongPath') === 'sweepPath' ? sweep : dest;
}

/** Value of moving my live zone `fx` to `anchor`: its moved-onto hook on everyone the move catches (allies count against it). */
export function moveZoneAnchorValue(v: VCtx, fxId: number, anchor: number): number {
  const fx = v.st.fx[fxId]!;
  const te = boundOf(v.st, fx);
  let total = 0;
  for (const u of caughtByMove(v, fx, te, anchor)) total += zoneHookValue(v, te, HOOK.movedOnto, u, v.me.cell);
  return total;
}

/**
 * Coverage step 7.5 review: what walking to `cell` drags my live Emanations onto (sim/zones.ts moveAura
 * re-stamps them on each step): each one's moved-onto hook on every creature newly covered there and
 * not yet hit by it this turn (the ledger, srd-raw.txt:31047); an ally it doesn't spare counts against
 * it (zoneHookValue). The destination only, a floor: a path that catches others on the way isn't
 * counted [U]. 0 with no live Emanation of mine, so nothing else reads differently.
 */
export function auraDragValue(v: VCtx, cell: number): number {
  const st = v.st;
  if (st.ownerAuras === 0) return 0;
  let total = 0;
  const there: number[] = [];
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id < 0) continue;
    const fx = st.fx[id]!;
    if (fx.owner !== v.me.idx) continue;
    const te = boundOf(st, fx);
    if (te.zone!.from !== 'bearer' || !(te.hookMask & HOOK.movedOnto)) continue;
    const bit = 1 << fx.zbit;
    areaCellsFrom(st, te.zone!.shapeKey, cell, NO_AIM, there);
    for (const u of st.units) {
      if (u === v.me || u.life === 'dead' || st.zoneMask[u.cell]! & bit || !there.includes(u.cell) || !ledgerOk(st, fx, u.idx)) continue;
      total += zoneHookValue(v, te, HOOK.movedOnto, u, cell);
    }
  }
  return total;
}

/** What my zone is doing where it is: its moved-onto hook on whoever it covers now (what a move gives up). */
export function zoneHoldValue(v: VCtx, fxId: number): number {
  const fx = v.st.fx[fxId]!;
  const te = boundOf(v.st, fx);
  let total = 0;
  for (const u of unitsUnder(v.st, te.zone!.shapeKey, fx.anchor, [])) total += zoneHookValue(v, te, HOOK.movedOnto, u, v.me.cell);
  return total;
}

// ---- forced movement ----

/** The best path to move `t` along (and its value): zone damage it takes on the way, through zones it enters or travels in. */
export function bestPull(v: VCtx, t: Unit, s: Extract<Step, { k: 'forced' }>, from: number): [number, ForcedPath | null] {
  if (v.mute) return bestPullExact(v, t, s, from); // an explain what-if: never through (or into) the cache
  const key = t.idx * 65536 + from;
  const hit = v.pullCache.get(key);
  if (hit) return hit;
  const r = bestPullExact(v, t, s, from);
  v.pullCache.set(key, r);
  return r;
}

function bestPullExact(v: VCtx, t: Unit, s: Extract<Step, { k: 'forced' }>, from: number): [number, ForcedPath | null] {
  const st = v.st;
  const zones = readFlag(st, 'involuntaryMovementTriggersArea');
  if (!zones && !s.straight) return [0, null];
  const paths: ForcedPath[] = [];
  forcedPaths(st, v.qs, v.me, from, t, s, paths);
  // Under exact there's no stopping, so a push that hurts is still what the spell does.
  let best = s.exact && paths.length > 0 ? -Infinity : 0;
  let bestPath: ForcedPath | null = null;
  for (const p of paths) {
    // M3 step 5b: a straight push (Push) is also worth where it leaves the creature. Other forced
    // moves keep their zone-only value (greedy v5) [U: generalizing it would move Open Hand's pushes].
    let val = s.straight && p.cells.length > 0 ? v.pushPlace(t, p.cells[p.cells.length - 1]!) : 0;
    if (!zones) {
      if (val > best) [best, bestPath] = [val, p];
      continue;
    }
    let prev = st.zoneMask[t.cell]!;
    const entered: number[] = [];
    for (const c of p.cells) {
      const here = st.zoneMask[c]!;
      for (let z = 0; z < 32; z++) {
        const bit = 1 << z;
        if (!(here & bit)) continue;
        const zfx = st.fx[st.zoneFx[z]!]!;
        const te = boundOf(st, zfx);
        const owner = st.units[zfx.owner]!;
        if (te.hookMask & HOOK.travel) val += zoneHookValue(v, te, HOOK.travel, t, from, undefined, owner);
        if (te.hookMask & HOOK.enter && !(prev & bit) && !entered.includes(z)) {
          entered.push(z);
          val += zoneHookValue(v, te, HOOK.enter, t, from, undefined, owner);
        }
      }
      prev = here;
    }
    if (val > best) {
      best = val;
      bestPath = p;
    }
  }
  return [best, bestPath];
}
