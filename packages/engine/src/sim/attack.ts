// Attack rolls (SRD 5.2.1 p.6-7, p.15-16 and the Prone/Unconscious conditions).
//
// buildAttackSpec is a pure query: from a position (real or hypothetical) it lists every
// advantage and disadvantage source by id, folds in effect modifiers, and returns the
// RollSpec that both the sampler and the exact odds read. rollAttack rolls it at the
// attacker's next 'attack' address; on a hit, damage rolls at the same slot under 'damage':
// every part's base dice first, then every crit extra, so a crit never moves a base die.
// Weapon attacks deal their damage here; a spell attack's damage is a step of its spell.

import { distFt, hostile } from '../grid/reach.ts';
import { attackKey } from '../content/rollkeys.ts';
import { resolveAdvantage, type AdvState, type RollSpec } from '../rolls/rollspec.ts';
import type { Stream } from '../rng/stream.ts';
import { SUSTAIN, type CompiledAttack, type CompiledDamage } from '../content/types.ts';
import type { ExprNode } from '../dice/expr.ts';
import { closeRoll, drawExpr, openPaired } from './dice.ts';
import { declaredWindow, rollD20 } from './d20.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseFold, releaseList, takeFold, takeList, type Ctx } from './context.ts';
import { foldMods, resetFold, sustain, type ModFold } from './effects.ts';
import { acNow, drawForAttack, landPiece, weaponThrown } from './hands.ts';
import { dealDamage, type DamageSource } from './damage.ts';
import { askRiders, hitTakenWindow, riderExtra, runRiders } from './riders.ts';
import { COND, has, markFlag, useFlag, type QueryState, type Unit } from './state.ts';
import { attackCondSources, autoCritWithin5 } from './conditions.ts';
import { critMinOf, unarmedTypeFor } from './stats.ts';
import { coverAgainst, seesCell } from './cover.ts';
import { COVER_BONUS } from '../grid/los.ts';
import { newFrame, runSteps } from './steps.ts';

const NO_DICE: readonly ExprNode[] = [];

/** Query: the RollSpec for `a` attacking `t` with attack `ai` from `fromCell`. Writes only adv, dis and f. */
export function buildAttackSpec(st: QueryState, a: Unit, ai: number, t: Unit, fromCell: number, adv: string[], dis: string[], f: ModFold | null = null): RollSpec {
  return buildAttackSpecFor(st, a, a.tpl.attacks[ai]!, t, fromCell, adv, dis, f);
}

/**
 * An attack's roll key. Only what the compiled attack already says goes in: the Unarmed
 * Strike is a STR attack (STR + PB to hit, docs/research/m1a-rules-2024.md) with the unarmed bit; spell attacks
 * keep the spell bit. Weapon attacks and their ability get their bits when the compiled
 * attack records them: W1 (docs/design/w1-plan.md P7) emits CompiledAttack.ab and src only on a
 * template whose content names an attack ability or source in a roll-key pattern (content/compile.ts),
 * so every other template's keys and hash are as before (critique C3). Greedy's modPerRound reads
 * the same function, so the two stay in step.
 */
export function attackKeyOf(atk: CompiledAttack, opportunity: boolean): number {
  if (atk.unarmed) return attackKey(atk.kind, atk.spell, { ability: 0, source: 'unarmed', opportunity });
  if (atk.ab !== undefined || atk.src !== undefined) return attackKey(atk.kind, atk.spell, { ability: atk.ab, source: atk.src, opportunity });
  return attackKey(atk.kind, atk.spell, opportunity ? { opportunity } : undefined);
}

/** W1 (P7): does `a` carry a feature with a firstAttack program (Reckless Attack)? */
function hasFirstAttack(a: Unit): boolean {
  for (const f of a.tpl.features) if (f.firstAttack) return true;
  return false;
}

/**
 * W1 (P7): "When you make your first attack roll on your turn, you can decide to attack recklessly"
 * (Reckless Attack, srd-raw.txt:5021-5022). A firstAttack decision before the roll (pass first, then
 * one item per such feature, keyed first:<feature local>); the chosen feature's program runs on `a`
 * now, so the roll about to be built sees what it applied.
 */
function firstAttackWindow(cx: Ctx, a: Unit, atk: CompiledAttack, t: Unit, cause: number): void {
  const fs = a.tpl.features;
  const list = takeList(cx);
  pushLegal(list, 'pass');
  for (let i = 0; i < fs.length; i++) if (fs[i]!.firstAttack) pushLegal(list, 'pick').opt = i;
  const pick = ask(cx, a.idx, 'firstAttack', list, cause, (l) => (l.k === 'pass' ? 'pass' : `first:${fs[l.opt]!.local}`), undefined, { src: { via: atk.id, target: t.idx } });
  const chosen = list.items[pick]!;
  const fi = chosen.k === 'pick' ? chosen.opt : -1;
  releaseList(cx, list);
  if (fi < 0) return;
  const f = fs[fi]!;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: a.idx, via: f.id, name: f.name });
  runSteps(cx, newFrame(a, { via: f.id, name: f.name, cause: seq, targets: [a.idx] }), f.firstAttack!.steps);
}

/**
 * The same for any compiled attack, a spell's included. Position rules first (range, a
 * ranged attack with an enemy within 5 ft, Prone, Unconscious), then the effect modifiers
 * on the attacker and on the target. A melee spell attack at 30 ft is still melee: no
 * close-combat Disadvantage, and a Prone target beyond 5 ft gives Disadvantage.
 * M3 step 8: the target's cover from `fromCell` adds to the AC (+2 Half, +5 Three-Quarters,
 * srd-raw.txt:2006-2032); `cover` passes a degree already computed (-1: compute it here).
 */
export function buildAttackSpecFor(st: QueryState, a: Unit, atk: CompiledAttack, t: Unit, fromCell: number, adv: string[], dis: string[], f: ModFold | null = null, opportunity = false, cover = -1): RollSpec {
  adv.length = 0;
  dis.length = 0;
  if (f) resetFold(f);
  const d = distFt(st, fromCell, t.cell);
  if (atk.kind === 'ranged') {
    if (d > atk.normalFt) dis.push('core:long-range');
    // Any enemy within 5 ft that can see the attacker (walls block sight: sim/cover.ts) and isn't Incapacitated.
    for (const h of st.units) {
      if (h === a || !hostile(h, a) || h.life !== 'up' || has(h, COND.incapacitated)) continue;
      if (distFt(st, fromCell, h.cell) <= 5 && seesCell(st, h.cell, fromCell, null)) {
        dis.push('core:ranged-adjacent');
        break;
      }
    }
  }
  // M3 step 5b, Heavy: "Disadvantage on attack rolls with a Heavy weapon if it's a Melee weapon
  // and your Strength score isn't at least 13 or if it's a Ranged weapon and your Dexterity score
  // isn't at least 13" (srd-raw.txt:20334-20337); compile decided the score.
  if (atk.heavyDis) dis.push('core:heavy-weapon');
  if (has(t, COND.prone)) (d <= 5 ? adv : dis).push('core:target-prone');
  if (has(a, COND.prone)) dis.push('core:attacker-prone');
  if (has(t, COND.unconscious)) adv.push('core:target-unconscious');
  attackCondSources(st, a, t, adv, dis); // M3 step 4: Blinded, Frightened, Paralyzed, Poisoned, Restrained, Stunned
  foldMods(st, a, t, attackKeyOf(atk, opportunity), adv, dis, f);
  const cov = cover >= 0 ? cover : coverAgainst(st, a, fromCell, t, null);
  return {
    kind: 'attack',
    adv: resolveAdvantage(adv, dis),
    flat: atk.toHit + (f ? f.flat : 0),
    preDice: f && f.pre.length > 0 ? f.pre.slice() : NO_DICE,
    floor: f && f.floor > 0 ? f.floor : undefined,
    critMin: critMinOf(st, a, atk, t),
    dc: acNow(t, st) + COVER_BONUS[cov]!,
    autoCritOnHit: autoCritWithin5(t) && d <= 5,
  };
}

/**
 * Rolls damage into `rolled`: base dice of every part, then every part's crit extra. Every
 * part's dice are drawn even when it won't count (an Advantage-only rider on a straight
 * roll), so whether it applies never moves another part's dice; it's zeroed afterwards.
 */
export function rollDamage(parts: readonly CompiledDamage[], crit: boolean, hadAdv: boolean, s: Stream, rolled: Int32Array): void {
  for (let i = 0; i < parts.length; i++) rolled[i] = drawExpr(s, parts[i]!.roll);
  if (crit) {
    for (let i = 0; i < parts.length; i++) {
      const extra = parts[i]!.critExtra;
      if (extra) rolled[i]! += drawExpr(s, extra);
    }
  }
  for (let i = 0; i < parts.length; i++) if (parts[i]!.ifAdvantage && !hadAdv) rolled[i] = 0;
}

export interface AttackRoll {
  readonly hit: boolean;
  readonly crit: boolean;
  /** The attack roll's slot: its damage pairs with it under 'damage'. */
  readonly slot: number;
  readonly hadAdv: boolean;
  /** W1 (P5): the roll's resolved Advantage state (spec.adv: Advantage and Disadvantage together cancel, srd-raw.txt:1056-1060), for the roll-state gates. */
  readonly adv: AdvState;
  /** seq of the attack event. */
  readonly seq: number;
  /** Coverage step 9+: who the attack was made against: the creature asked for, or the ally a declared reaction (Redirect Attack) put in its place. */
  readonly tgt: Unit;
  /** Coverage step 9+: the attack was never rolled: what the swap set off left its new target dead, or ended the fight. Nothing was logged or spent. */
  readonly lost?: true;
}

/**
 * One attack roll: the declare-time window (coverage step 9+, sim/d20.ts declaredWindow: its target
 * may swap an ally in), then build the spec against the target as it now is, roll it, log it, spend
 * riders and thrown gear. Damage is the caller's, on `tgt`.
 */
export function rollAttack(cx: Ctx, a: Unit, atk: CompiledAttack, t0: Unit, opportunity: boolean, cause: number): AttackRoll {
  const st = cx.st;
  if (st.active === a.idx) {
    // W1 (P7): the first attack roll on its own turn may open a firstAttack decision, before the
    // declare-time window and the spec. [U] A spell attack made first counts as the first roll but
    // offers no choice (a raging Barbarian can't cast). b.rolls is reset at each turn start.
    if (a.b.rolls === 0 && !opportunity && !atk.spell && hasFirstAttack(a)) firstAttackWindow(cx, a, atk, t0, cause);
    a.b.rolls++;
  }
  const t = st.watchDeclared > 0 ? declaredWindow(cx, a, t0, atk.id, cause) : t0;
  // [U] An enter hook the swap set off killed the new target or ended the fight: no roll is made.
  if (t !== t0 && (t.life === 'dead' || st.outcome)) return { hit: false, crit: false, slot: -1, hadAdv: false, adv: 'none', seq: cx.lastDecided, tgt: t, lost: true };
  const fd = takeFold(cx);
  const cover = coverAgainst(st, a, a.cell, t, st);
  const spec = buildAttackSpecFor(st, a, atk, t, a.cell, fd.adv, fd.dis, fd.f, opportunity, cover);
  if ((spec.critMin ?? 20) < 20) markFlag(st, 'expandedCritAutoHits');
  markFlag(st, 'diagonalCost'); // reach and range were measured with it
  const r = rollD20(cx, a, spec, attackKeyOf(atk, opportunity), 'attack', st.setup.flags, cause, fd, { target: t.idx, via: atk.id });
  const slot = r.slot;
  const seq = nextSeq(cx);
  if (cx.sink) {
    emit(cx, {
      ...evBase(cx, seq, cause), k: 'attack', att: a.idx, tgt: t.idx, via: atk.id, name: atk.name, slot,
      d20: r.d20, natural: r.natural, total: r.total, ac: spec.dc + (r.acUp ?? 0), adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(),
      hit: r.success, crit: r.crit, opportunity, ...(r.pre ? { pre: r.pre } : {}), ...(r.ext ? { ext: r.ext } : {}), ...(cover > 0 ? { cover } : {}), ...(r.acUp ? { acUp: r.acUp } : {}),
    });
  }
  releaseFold(cx, fd);
  // W1 (P1): an attack roll against an enemy on its own turn extends a sustained effect (Rage: "Make an
  // attack roll against an enemy", srd-raw.txt:4988); sustain() itself checks the turn. Not against an ally.
  if (st.active === a.idx && hostile(a, t)) sustain(cx, a, SUSTAIN.attackRoll);

  if (atk.consumesGear && atk.gear >= 0 && a.gear[atk.gear]! > 0) {
    const counts = a.isPc || useFlag(st, 'monsterThrownWeapons') === 'gearCount';
    if (counts) {
      a.gear[atk.gear]!--;
      const g = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, g, seq), k: 'gear', who: a.idx, item: a.tpl.gear[atk.gear]!.name, left: a.gear[atk.gear]!, ...(atk.item !== undefined && !atk.throws ? { ammo: true as const } : {}) });
      // Step E (E2): where a monster's thrown piece lands (thrownWeaponLands [U]; the Thrown
      // property, srd-raw.txt:20386-20391, doesn't say). Read only at a monster's counted landing.
      if (!a.isPc && useFlag(st, 'thrownWeaponLands') === 'targetSquare') landPiece(a, atk.gear, t.cell);
    }
  }
  return { hit: r.success, crit: r.crit, slot, hadAdv: spec.adv === 'adv', adv: spec.adv, seq, tgt: t };
}

/** A weapon (or stat-block) attack, damage included. */
export function resolveAttack(cx: Ctx, a: Unit, ai: number, t: Unit, opportunity: boolean, cause: number): void {
  resolveAttackFor(cx, a, a.tpl.attacks[ai]!, t, opportunity, cause);
}

/**
 * The same for a compiled attack outside tpl.attacks (a weaponAttack step's no-ability-modifier
 * form, M3 step 5a). `grant`: the activation that made the strike ('' for none), for riders'
 * grantedBy. Riders (sim/riders.ts) are asked when the hit or miss is known and run after the
 * damage; the target's hitTaken reaction comes between the damage roll and the damage.
 */
export function resolveAttackFor(cx: Ctx, a: Unit, atk: CompiledAttack, t0: Unit, opportunity: boolean, cause: number, grant = ''): void {
  // M3 step 5b: a held weapon is drawn as part of the attack when it isn't in hand, and a thrown
  // one leaves the hand once the attack is made, hit or miss.
  if (atk.item !== undefined) drawForAttack(cx, a, atk, cause);
  const r = rollAttack(cx, a, atk, t0, opportunity, cause);
  if (r.lost) return;
  const t = r.tgt; // coverage step 9+: a declared reaction may have put an ally in t0's place
  if (atk.throws) weaponThrown(cx, a, atk, t, r.seq);
  if (!r.hit) {
    if (atk.onMiss) {
      const chosen: number[] = [];
      askRiders(cx, a, atk.onMiss, 'miss', t, atk, grant, false, r.seq, chosen, r.adv);
      if (chosen.length > 0) runRiders(cx, a, t, chosen, cx.lastDecided);
    }
    return;
  }
  let chosen: number[] | null = null;
  if (atk.onHit) {
    chosen = [];
    askRiders(cx, a, atk.onHit, 'hit', t, atk, grant, r.crit, r.seq, chosen, r.adv);
  }
  const parts = atk.unarmed && a.stats.length > 0 ? unarmedParts(cx.st, a, t, atk.damage) : atk.damage;
  // W1 (P4): a rider part of the weapon's type takes the attack's first part's type, after an
  // Unarmed Strike's damageType stat (srd-raw.txt:13739, 5177-5178).
  const extra = chosen && chosen.length > 0 ? riderExtra(a, chosen, parts.length > 0 ? parts[0]!.type : -1) : null;
  dealHit(cx, a, t, parts, extra, r.crit, r.hadAdv, r.slot, { unit: a.idx, via: atk.id, slot: r.slot, cause: r.seq, ...(opportunity ? { oa: true } : {}) }, atk.onHit, grant, atk, chosen, r.adv);
  if (chosen && chosen.length > 0) runRiders(cx, a, t, chosen, cx.lastDecided);
}

/**
 * One hit's damage on `t`: the attack's own parts (base dice, then crit dice) and then any rider
 * extra parts, all on the attack's paired damage stream, so the attack's own dice never move
 * (extra dice double on a crit under riderDiceCritDouble, "Critical Hits", srd-raw.txt:2207-2211).
 * Then the target's hitTaken window, the damage, and (when it took any) the attack's dealtDamage
 * riders, whose choices are appended to `post` (run by the caller) or run here when post is null.
 * `roll` (W1, P5): the attack roll's resolved Advantage state, for the dealtDamage riders' roll gates.
 */
export function dealHit(
  cx: Ctx, a: Unit, t: Unit, base: readonly CompiledDamage[], extra: readonly CompiledDamage[] | null, crit: boolean, hadAdv: boolean, slot: number,
  src: DamageSource, riders: readonly number[] | undefined, grant: string, atk: CompiledAttack, post: number[] | null = null, roll: AdvState = 'none',
): void {
  const st = cx.st;
  const rolled = cx.sc.rolled;
  const ds = openPaired(st, cx.dice, a.idx, slot, 'damage');
  rollDamage(base, crit, hadAdv, ds, rolled);
  let parts = base;
  if (extra) {
    let dbl = false;
    if (crit && extra.some((p) => p.critExtra !== null)) dbl = useFlag(st, 'riderDiceCritDouble');
    const ex = cx.sc.rolledExtra;
    rollDamage(extra, dbl, false, ds, ex);
    for (let j = 0; j < extra.length; j++) rolled[base.length + j] = ex[j]!;
    parts = [...base, ...extra];
  }
  closeRoll(cx.dice, ds);
  const n = base.length;
  const applies = (i: number): boolean => i >= n || !parts[i]!.ifAdvantage || hadAdv;
  const cut = st.watchHit > 0 ? hitTakenWindow(cx, a, t, atk.id, parts, rolled, applies, crit, src.cause) : null;
  const out = riders ? { dealt: 0 } : undefined;
  dealDamage(cx, { ...src, ...(cut ? { cut } : {}), ...(out ? { out } : {}) }, parts, rolled, applies, crit, [t.idx]);
  if (!riders || !out || out.dealt <= 0) return;
  const mine: number[] = post ?? [];
  askRiders(cx, a, riders, 'dealtDamage', t, atk, grant, crit, src.cause, mine, roll);
  if (!post && mine.length > 0) runRiders(cx, a, t, mine, cx.lastDecided);
}

/** An Unarmed Strike's parts with a damageType stat applied (sim/stats.ts unarmedTypeFor); the same array when nothing changes. */
function unarmedParts(st: QueryState, a: Unit, t: Unit, parts: readonly CompiledDamage[]): readonly CompiledDamage[] {
  const scratch = { resist: 0, vuln: 0, immune: 0 };
  let out: CompiledDamage[] | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const type = unarmedTypeFor(st, a, t, p.type, scratch);
    if (type === p.type) continue;
    out ??= parts.slice();
    out[i] = { ...p, type };
  }
  return out ?? parts;
}
