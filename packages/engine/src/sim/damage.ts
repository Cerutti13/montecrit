// Damage, dropping to 0 HP, death saves, and the end-of-fight check (SRD 5.2.1 p.16-18).
//
// Damage per instance: parts of the same type are summed first, then adjustments, then
// Resistance (halve, round down), then Vulnerability (double); Immunity means none; never
// below 0. Temp HP soak first. At 0 HP a PC (or a monster under statBlockAtZeroHp=deathSaves)
// falls Unconscious unless the leftover damage reaches its HP max (massive damage); a monster
// otherwise dies. Damage at 0 HP is a death-save failure, two on a critical hit, and kills
// outright if it reaches the HP max.

import { DAMAGE_TYPES, damageBit, type CompiledDamage, type Id } from '../content/types.ts';
import type { DamagePart } from '../log/events.ts';
import { DEATH_SAVE_KEY, saveKey } from '../content/rollkeys.ts';
import { payReaction, rollD20, saveSpec } from './d20.ts';
import { resolveAdvantage, type RollSpec } from '../rolls/rollspec.ts';
import { boundOf, endFx, endOnDamage, foldMods, onDeath, onIncapacitated } from './effects.ts';
import { defensesOf, speedOf } from './stats.ts';
import { countDamage, countDeath, countDrop } from './counters.ts';
import { dropHeld } from './hands.ts';
import { emit, evBase, nextSeq, releaseFold, takeFold, type Ctx } from './context.ts';
import { drain, queueTrigger, TRIG } from './triggers.ts';
import { addCond, COND, condId, has, removeCond, useFlag, type QueryState, type Unit } from './state.ts';

/** Walking speed now: Speed 0 conditions (Unconscious, and from M3 step 4 Restrained and Paralyzed), then speed stats (sim/stats.ts). */
export function speedNow(u: Unit, st: QueryState | null = null): number {
  return speedOf(st, u);
}

export interface DamageSource {
  readonly unit: number;
  readonly via: Id;
  readonly slot: number;
  /** seq of the attack (or effect) event that dealt it. */
  readonly cause: number;
  /** Named in the log when it isn't a weapon or spell attack's own damage ("from Spike Growth"). */
  readonly name?: string;
  /** The roll's purpose when it isn't 'damage' paired with an attack ('effect', 'zone'). */
  readonly purpose?: string;
  /** An opportunity attack's damage: counted apart from the same weapon's other damage. */
  readonly oa?: boolean;
  /** M3 step 5a (REACT hitTaken): a reduction target `tgt` reacted with (by v, or by half). */
  readonly cut?: Cut;
  /** M3 step 5a: receives the damage each target took from this instance (a dealtDamage rider reads it). */
  readonly out?: { dealt: number };
  /** Session S: receives, in order, each target this instance dealt damage to (more than 0 after its defenses): a spell's dealtDamage riders read it. */
  readonly dealtTo?: number[];
}

/** A damage-reducing reaction's effect on one target's damage instance. */
export interface Cut {
  readonly tgt: number;
  readonly v: number;
  readonly halve: boolean;
}

/** How much of a rolled damage instance a target takes: all, half (a successful save that halves), or none. */
export const SCALE = { none: 0, half: 1, full: 2 } as const;

/**
 * Deals one rolled damage instance to every target (one roll covers all of them), then
 * resolves the triggers it raised and checks for the end of the fight. `applies[i]` says
 * whether part i counts (an ifAdvantage rider without Advantage doesn't).
 */
export function dealDamage(cx: Ctx, src: DamageSource, parts: readonly CompiledDamage[], rolled: Int32Array, applies: (i: number) => boolean, crit: boolean, targets: readonly number[], scales?: readonly number[]): void {
  for (let i = 0; i < targets.length; i++) {
    const scale = scales ? scales[i]! : SCALE.full;
    if (scale === SCALE.none) continue; // no damage instance at all: nothing to trigger, no concentration save
    applyDamage(cx, cx.st.units[targets[i]!]!, src, parts, rolled, applies, crit, scale === SCALE.half);
  }
  drain(cx);
  checkEnd(cx);
}

function applyDamage(cx: Ctx, t: Unit, src: DamageSource, parts: readonly CompiledDamage[], rolled: Int32Array, applies: (i: number) => boolean, crit: boolean, half: boolean): void {
  if (t.life === 'dead') return;
  const st = cx.st;
  let total = 0;
  let raw = 0; // before Resistance and Vulnerability, for parts not Immune
  let typesDealt = 0;
  const byType = cx.sc.byType;
  // The template's masks, plus resist/vuln/immune stats (M3 step 4); instances don't stack (p.17).
  const def = t.stats.length === 0 ? t.tpl : defensesOf(st, t, cx.sc.defenses);
  // Sum by damage type in DAMAGE_TYPES order, then fold each type once.
  const cut = src.cut && src.cut.tgt === t.idx ? src.cut : null;
  const before0 = cut ? useFlag(st, 'reduceBeforeResistance') : false;
  let present = 0;
  for (let type = 0; type < DAMAGE_TYPES.length; type++) {
    byType[type] = 0;
    let sum = 0;
    let seen = false;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.type !== type || !applies(i)) continue;
      seen = true;
      sum += rolled[i]!;
    }
    if (!seen) continue;
    present |= 1 << type;
    let x = Math.max(0, sum);
    if (half) x = Math.floor(x / 2); // half on a save comes before Resistance (p.16)
    byType[type] = x;
  }
  // A reduction as an adjustment, before Resistance ("Order of Application", srd-raw.txt:2259-2266;
  // reduceBeforeResistance). It comes off the types in DAMAGE_TYPES order, skipping types the
  // target is immune to [U: the text doesn't split a reduction across damage types].
  if (cut && before0) cutTypes(byType, present & ~def.immune, cut); // damageBit(type) is 1 << type
  for (let type = 0; type < DAMAGE_TYPES.length; type++) {
    if (!(present & (1 << type))) continue;
    let x = byType[type]!;
    const bit = damageBit(type);
    if (def.immune & bit) x = 0;
    else {
      raw += x;
      if (def.resist & bit) x = Math.floor(x / 2);
      if (def.vuln & bit) x *= 2;
    }
    byType[type] = x;
    if (x > 0) typesDealt++;
    total += x;
  }
  if (cut && !before0) {
    // After Resistance and Vulnerability: off the total (never below 0).
    cutTypes(byType, present, cut);
    total = 0;
    typesDealt = 0;
    for (let type = 0; type < DAMAGE_TYPES.length; type++) {
      total += byType[type]!;
      if (byType[type]! > 0) typesDealt++;
    }
  }
  if (src.out) src.out.dealt = total;
  if (src.dealtTo && total > 0) src.dealtTo.push(t.idx);
  const absorbed = Math.min(t.tempHp, total);
  t.tempHp -= absorbed;
  const rest = total - absorbed;
  const before = t.hp;
  const atZero = t.life === 'down' || t.life === 'stable';
  if (!atZero) t.hp = Math.max(0, before - rest);
  // W1 (P8): "When you are reduced to 0 Hit Points but not killed outright, you can drop to 1 Hit
  // Point instead" (Relentless Endurance, srd-raw.txt:19928-19930). Killed outright for a character
  // is Massive Damage (2320-2322), the same test as below. A PC only (stat blocks: later). Taken
  // whenever it can be: within one fight with no rests, 1 HP is never worse than 0 [U: argued, not
  // measured], an AI choice written as plain code, not a rule reading. Its act and res lines follow
  // the damage event; no drop is counted and nobody is knocked out.
  const saved = t.hp === 0 && before > 0 && t.isPc && rest - before < t.hpMax ? dropToOneOf(t) : -1;
  if (saved >= 0) t.hp = 1;
  if (absorbed > 0 || t.hp !== before) st.hpTick++;
  countDamage(st.ctr, st.round, src.unit, src.via, src.oa === true, t.idx, absorbed + before - t.hp, total);

  const seq = nextSeq(cx);
  if (cx.sink) {
    const shown: DamagePart[] = [];
    for (let i = 0; i < parts.length; i++) if (applies(i)) shown.push({ type: DAMAGE_TYPES[parts[i]!.type]!, rolled: rolled[i]! });
    emit(cx, {
      ...evBase(cx, seq, src.cause), k: 'damage', src: src.unit, tgt: t.idx, via: src.via, slot: src.slot, crit, parts: shown, dealt: total, tempAbsorbed: absorbed, hpBefore: before, hpAfter: t.hp,
      ...(src.name ? { name: src.name } : {}), ...(src.purpose && src.purpose !== 'damage' ? { purpose: src.purpose } : {}), ...(half ? { half: true } : {}),
    });
  }
  if (saved >= 0) spendDropToOne(cx, t, saved, seq);
  // M3 step 4: a condition that ends when its bearer takes damage (dealt before temp HP soak it).
  if (total > 0 && st.liveFx > 0 && t.borne.length > 0) endOnDamage(cx, t, seq);
  queueTrigger(cx, TRIG.damaged, t.idx, total, src.unit, 0, seq);
  if (t.conc >= 0) queueConcSaves(cx, t, total, raw, typesDealt, seq);

  if (atZero) {
    const took = rest > 0 || (absorbed > 0 && useFlag(st, 'tempHpSoakAtZeroIsDamage'));
    if (!took) return;
    if (rest >= t.hpMax) return kill(cx, t, 'massive', seq);
    if (t.life === 'stable') t.life = 'down'; // a Stable creature that takes damage is dying again (p.18)
    const n = crit ? 2 : 1;
    t.deathFail += n;
    const s2 = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, s2, seq), k: 'deathFail', who: t.idx, n, fail: t.deathFail });
    if (t.deathFail >= 3) kill(cx, t, 'deathSaves', s2);
    return;
  }
  if (t.hp === 0 && before > 0) {
    countDrop(st.ctr, t.idx, st.round);
    if (!t.isPc && st.setup.seats[t.idx]!.atZero === null) useFlag(st, 'statBlockAtZeroHp');
    if (t.atZero === 'deathSaves') {
      if (rest - before >= t.hpMax) kill(cx, t, 'massive', seq);
      else knockOut(cx, t, seq);
    } else kill(cx, t, 'zeroHp', seq);
  }
}

/** W1 (P8): tpl.features index of `t`'s first dropToOne feature whose pool has a use left; -1 for none. */
function dropToOneOf(t: Unit): number {
  const fs = t.tpl.features;
  for (let i = 0; i < fs.length; i++) {
    const d = fs[i]!.dropToOne;
    if (d && t.res[d.pool]! > 0) return i;
  }
  return -1;
}

/** W1 (P8): the drop to 1 happened: its act line (caused by the damage event `cause`), then one use of its pool. */
function spendDropToOne(cx: Ctx, t: Unit, fi: number, cause: number): void {
  const f = t.tpl.features[fi]!;
  const pool = f.dropToOne!.pool;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: t.idx, via: f.id, name: f.name });
  payReaction(cx, t, pool, 1, seq);
}

/**
 * Applies a reduction to per-type amounts: halve halves each type (round down, like Half Damage,
 * srd-raw.txt:2224-2228; per type, not the sum [U] when an attack mixes types); v comes off the
 * types in `mask` in DAMAGE_TYPES order until spent. Never below 0.
 */
function cutTypes(byType: Int32Array, mask: number, cut: Cut): void {
  let left = cut.v;
  for (let type = 0; type < DAMAGE_TYPES.length; type++) {
    if (!(mask & (1 << type))) continue;
    const x = byType[type]!;
    if (cut.halve) byType[type] = Math.floor(x / 2);
    else {
      const take = x < left ? x : left;
      byType[type] = x - take;
      left -= take;
    }
  }
}

function condEvent(cx: Ctx, t: Unit, bit: number, on: boolean, via: Id, cause: number): void {
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'cond', who: t.idx, cond: condId(bit), on, via });
}

/** Falls Unconscious at 0 HP: Incapacitated and Prone too, and starts death saves. */
export function knockOut(cx: Ctx, t: Unit, cause: number): void {
  t.life = 'down';
  t.deathOk = 0;
  t.deathFail = 0;
  t.b.atkActive = false;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'down', who: t.idx });
  if (addCond(t, COND.unconscious, 'core:downed', -1, seq, { k: 'never' })) condEvent(cx, t, COND.unconscious, true, 'core:downed', seq);
  if (addCond(t, COND.incapacitated, 'core:downed', -1, seq, { k: 'never' })) condEvent(cx, t, COND.incapacitated, true, 'core:downed', seq);
  if (!has(t, COND.prone)) {
    addCond(t, COND.prone, 'core:fell-prone', -1, seq, { k: 'never' });
    condEvent(cx, t, COND.prone, true, 'core:fell-prone', seq);
  }
  onIncapacitated(cx, t, seq);
  dropHeld(cx, t, seq); // Unconscious drops what it holds (p.191); other Incapacitated conditions don't
}

/**
 * Concentration saves for one damage instance (p.179): DC max(10, half the damage taken),
 * capped at 30. Damage soaked by Temporary HP counts (2024 SAC-SpellDuration2). Immune
 * damage is no damage: no save. They're queued, so a knockout from the same damage ends
 * concentration first and the save does nothing.
 */
function queueConcSaves(cx: Ctx, t: Unit, total: number, raw: number, typesDealt: number, cause: number): void {
  const st = cx.st;
  const dcOf = (dmg: number) => Math.min(30, Math.max(10, Math.floor(dmg / 2)));
  if (total === 0) {
    if (raw > 0 && useFlag(st, 'concentrationSaveOnZeroDamage') === 'save') queueTrigger(cx, TRIG.concSave, t.idx, 10, t.conc, 0, cause);
    return;
  }
  if (typesDealt >= 2 && useFlag(st, 'concentrationSaveGrouping') === 'perDamageType') {
    const byType = cx.sc.byType;
    for (let type = 0; type < DAMAGE_TYPES.length; type++) if (byType[type]! > 0) queueTrigger(cx, TRIG.concSave, t.idx, dcOf(byType[type]!), t.conc, 0, cause);
    return;
  }
  queueTrigger(cx, TRIG.concSave, t.idx, dcOf(total), t.conc, 0, cause);
}

/** A queued concentration save. Does nothing if that concentration already ended. */
export function concentrationSave(cx: Ctx, u: Unit, dc: number, concFx: number, cause: number): void {
  if (u.conc !== concFx || u.life !== 'up') return;
  const st = cx.st;
  const key = saveKey(2, true); // CON
  const fd = takeFold(cx);
  const spec = saveSpec(st, u, key, dc, fd.adv, fd.dis, fd.f);
  const r = rollD20(cx, u, spec, key, 'conc', st.setup.flags, cause, fd, { target: -1, via: boundOf(st, st.fx[concFx]!).id });
  const seq = nextSeq(cx);
  if (cx.sink) {
    const te = boundOf(st, st.fx[concFx]!);
    emit(cx, {
      ...evBase(cx, seq, cause), k: 'save', who: u.idx, via: te.id, name: te.name, key: 'save.con.concentration', purpose: 'conc', slot: r.slot,
      d20: r.d20, natural: r.natural, face: r.face, pre: r.pre, ext: r.ext, total: r.total, dc, adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(), ok: r.success,
    });
  }
  releaseFold(cx, fd);
  if (!r.success) endFx(cx, concFx, 'concentration', seq);
}

export function kill(cx: Ctx, t: Unit, why: 'zeroHp' | 'massive' | 'deathSaves', cause: number): void {
  countDeath(cx.st.ctr, t.idx, why);
  t.life = 'dead';
  if (t.hp !== 0) cx.st.hpTick++;
  t.hp = 0;
  t.b.atkActive = false;
  cx.st.corpses[t.cell]!++;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'death', who: t.idx, why });
  onDeath(cx, t, seq);
}

/** Regains HP from 0: Unconscious (and the Incapacitated it brought) ends; Prone stays. */
export function revive(cx: Ctx, t: Unit, hp: number, cause: number): void {
  if (t.hp !== hp) cx.st.hpTick++;
  t.hp = hp;
  t.life = 'up';
  t.deathOk = 0;
  t.deathFail = 0;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'revive', who: t.idx, ...(hp !== 1 ? { hp } : {}) });
  if (removeCond(t, COND.unconscious, 'core:downed')) condEvent(cx, t, COND.unconscious, false, 'core:downed', seq);
  if (removeCond(t, COND.incapacitated, 'core:downed')) condEvent(cx, t, COND.incapacitated, false, 'core:downed', seq);
}

/**
 * Start-of-turn death save: a d20 with no ability modifier, 10+ succeeds. A 1 is two failures, a 20
 * regains 1 HP. Three successes: Stable (both counts reset). Three failures: dead.
 * A death save is a saving throw, so what an effect adds to saves applies (key d20.save.death):
 * Aura of Protection's "bonus to saving throws" (srd-raw.txt:11997-11998). With no live effect the
 * spec is the bare d20, as ever (foldMods returns at once).
 * Returns true if the creature came back up.
 */
export function deathSave(cx: Ctx, u: Unit, cause: number): boolean {
  const st = cx.st;
  const fd = takeFold(cx);
  foldMods(st, u, null, DEATH_SAVE_KEY, fd.adv, fd.dis, fd.f);
  const spec: RollSpec = fd.adv.length + fd.dis.length + fd.f.flat + fd.f.pre.length + fd.f.floor === 0
    ? { kind: 'save', adv: 'none', flat: 0, preDice: [], dc: 10 }
    : { kind: 'save', adv: resolveAdvantage(fd.adv, fd.dis), flat: fd.f.flat, preDice: fd.f.pre.slice(), floor: fd.f.floor > 0 ? fd.f.floor : undefined, dc: 10 };
  const r = rollD20(cx, u, spec, DEATH_SAVE_KEY, 'death', cx.deathFlags, cause, fd, { target: -1, via: 'core:death-save' });
  releaseFold(cx, fd);
  const mod = r.total - r.natural - r.ext;
  const slot = r.slot;
  if (r.natural === 20) {
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'deathSave', who: u.idx, slot, natural: 20, ok: u.deathOk, fail: u.deathFail });
    revive(cx, u, 1, seq);
    return true;
  }
  if (r.natural === 1) u.deathFail += 2;
  else if (r.total >= 10) u.deathOk++;
  else u.deathFail++;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'deathSave', who: u.idx, slot, natural: r.natural, ok: u.deathOk, fail: u.deathFail, ...(r.ext || mod ? { total: r.total } : {}), ...(mod ? { mod } : {}) });
  if (u.deathFail >= 3) kill(cx, u, 'deathSaves', seq);
  else if (u.deathOk >= 3) {
    u.life = 'stable';
    u.deathOk = 0;
    u.deathFail = 0;
    const s2 = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, s2, seq), k: 'stable', who: u.idx });
  }
  return false;
}

/**
 * Win: no enemy is up. Loss: the counted party members (PCs by default) are all down, or with
 * downEnds=false all dead or stable. Checked after every damage instance and every turn.
 */
export function checkEnd(cx: Ctx): void {
  const st = cx.st;
  if (st.outcome) return;
  const { lossCounts, downEnds } = st.setup.knobs;
  let enemyUp = false;
  let counted = 0;
  let countedOut = 0;
  let partyAll = 0;
  let partyOut = 0;
  let partyDead = 0;
  for (const u of st.units) {
    if (u.team === 1) {
      if (u.life === 'up') enemyUp = true;
      continue;
    }
    const out = downEnds ? u.life !== 'up' : u.life === 'dead' || u.life === 'stable';
    partyAll++;
    if (out) partyOut++;
    if (u.life === 'dead') partyDead++;
    if (lossCounts === 'party' || u.isPc) {
      counted++;
      if (out) countedOut++;
    }
  }
  const tpk = partyAll > 0 && partyDead === partyAll;
  if (!enemyUp) st.outcome = { k: 'win', round: st.round, tpk };
  else if (partyAll > 0 && (counted > 0 ? countedOut === counted : partyOut === partyAll)) st.outcome = { k: 'loss', round: st.round, tpk };
}
