// The step interpreter. A spell's cast, an effect's hook, a grant and a feature activation
// are all programs of Steps (content/types.ts), bound at compile to their caster and cast
// level. A Frame carries what the steps share: who acts, the current targets, the last
// attack roll (an onHit damage step pairs with its slot), the effect just applied, and
// the effect whose hook or grant is running; if that effect ends mid-program, the program
// stops (a caster whose concentration breaks partway through their own zone's damage).
//
// Dice: an onHit damage step reuses the attack's slot under 'damage'; any other damage
// opens one roll for the whole group under the frame's purpose ('effect' for a spell,
// 'zone' for a lasting area), drawn even when every target saves (p.16); healing rolls
// under 'heal'.

import { keyName, SKILLS } from '../content/rollkeys.ts';
import { HOOK, SUSTAIN, type BoundEffect, type Id, type SpellEntry, type Step } from '../content/types.ts';
import { computeReach, distFt, forEachLabel, hostile, rebuildPath } from '../grid/reach.ts';
import { cellName } from '../grid/cells.ts';
import type { AdvState } from '../rolls/rollspec.ts';
import { coverAt, coverFromOrigin, saveCoverDegree, targetable } from './cover.ts';
import { COVER_BONUS } from '../grid/los.ts';
import { areaCellsFrom, creatureOriginPoint, NO_AIM, originPoint } from '../grid/area.ts';
import type { Purpose, Stream } from '../rng/stream.ts';
import { dealHit, resolveAttackFor, rollAttack, rollDamage } from './attack.ts';
import { askRiders, askSpellRiders, hasSpellRiders, riderExtra, riderHasExtra, runRiders } from './riders.ts';
import type { CompiledAttack } from '../content/types.ts';
import { coreAction } from './act.ts';
import { gearOk } from '../grid/reach.ts';
import { canWield, lightStackSpare } from './state.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseFold, releaseList, takeFold, takeList, type Ctx } from './context.ts';
import { checkSpec, rollD20, saveSpec } from './d20.ts';
import { endConditions, imposeCondition, programDamages } from './conditions.ts';
import { charmedBy, gatesOk } from './stats.ts';
import { dealDamage, revive, SCALE, speedNow } from './damage.ts';
import { closeRoll, drawExpr, openPaired, openRoll } from './dice.ts';
import { boundOf, endFx, ledgerMark, ledgerOk, newFx, reanchor, sustain } from './effects.ts';
import { emptyHand } from './hands.ts';
import { COND, has, HAND, markFlag, readFlag, useFlag, zoneSpares, type Expiry, type GameState, type Unit } from './state.ts';
import { applyZone, moveZone } from './zones.ts';
import { hiddenZoneHurt } from './hidden.ts';
import { forcedMove } from './forced.ts';
import { walkPath } from './walker.ts';

export interface Frame {
  readonly owner: Unit;
  /** The spell being cast; null for hooks, grants and features. */
  readonly entry: SpellEntry | null;
  readonly lvl: number;
  /** What children of `apply: parent` hang under: the concentration instance, a form's root, a zone. */
  readonly root: number;
  readonly srcItem: number;
  /** Damage not paired with an attack roll rolls under this ('effect' or 'zone'). */
  readonly purpose: Purpose;
  readonly via: Id;
  readonly name: string;
  /** The effect whose hook or grant is running: the program stops if it ends. -1 for casts. */
  readonly source: number;
  cause: number;
  targets: number[];
  anchor: number;
  /** With zone.from: the aim of the area (grid/area.ts AIMS), NO_AIM for one around the creature; `anchor` is then a square. Else undefined. */
  aim: number | undefined;
  lastFx: number;
  /** A heal step resolved on a living creature (the slot-heal rider listens for it). */
  healed: boolean;
  /** The last attack roll: slot (-1 when none), crit, Advantage. */
  slot: number;
  crit: boolean;
  hadAdv: boolean;
  /** W1 (P5): the last attack roll's resolved Advantage state, for its riders' roll-state gates ('none' when none). */
  adv: AdvState;
  /** A per-cast choice (a skill index). */
  param: number;
  /** perMove flush: draw each damage step's dice this many times into one instance. */
  repeat: number;
  /**
   * M3 step 5a (HOOKX): an open stream every unpaired roll of this program draws from, in order,
   * instead of opening its own (an initiative hook's dice sit on their own initiative slot, so
   * they never move a round's heal or damage dice). null for every other program.
   */
  stream: Stream | null;
  /** M3 step 5a (RIDER): purpose a save step rolls under ('rider' inside a rider's program, so it never shifts the target's other saves). */
  savePurpose: 'save' | 'rider' | 'reaction';
  /** The activation running this program (its local id), for a rider's grantedBy; '' otherwise. */
  grant: string;
  /** A spell attack in progress (its onHit branch): the attack, its target, and the riders chosen on the hit (pairs). */
  atk: CompiledAttack | null;
  atkTgt: number;
  riders: number[] | null;
  /** The chosen riders' extra damage is still to be joined to the branch's damage step. */
  extraDue: boolean;
}

export function newFrame(owner: Unit, f: Partial<Frame> & Pick<Frame, 'via' | 'name' | 'cause'>): Frame {
  return {
    owner,
    entry: null,
    lvl: 0,
    root: -1,
    srcItem: -1,
    purpose: 'effect',
    source: -1,
    targets: [],
    anchor: -1,
    aim: undefined,
    lastFx: -1,
    healed: false,
    slot: -1,
    crit: false,
    hadAdv: false,
    adv: 'none',
    param: -1,
    repeat: 1,
    stream: null,
    savePurpose: 'save',
    grant: '',
    atk: null,
    atkTgt: -1,
    riders: null,
    extraDue: false,
    ...f,
  };
}

/** The stream an unpaired roll of `fr` draws from: the frame's own (an initiative hook) or a fresh one, closed by `doneRoll`. */
function frameRoll(cx: Ctx, fr: Frame, purpose: Purpose): Stream {
  return fr.stream ?? openRoll(cx.st, cx.dice, fr.owner.idx, purpose);
}
function doneRoll(cx: Ctx, fr: Frame, s: Stream): void {
  if (s !== fr.stream) closeRoll(cx.dice, s);
}

/** Runs `steps` in order. Returns false if the program stopped early (no target, its source or root ended, the fight ended). */
export function runSteps(cx: Ctx, fr: Frame, steps: readonly Step[]): boolean {
  const st = cx.st;
  for (let i = 0; i < steps.length; i++) {
    if (st.outcome) return false;
    if (fr.source >= 0 && !st.fx[fr.source]!.alive) return false;
    // A cast or activation whose root (its concentration, its form) ended mid-program stops, so no later step links a child to it.
    if (fr.root >= 0 && !st.fx[fr.root]!.alive) return false;
    if (!runStep(cx, fr, steps[i]!, steps, i)) return false;
  }
  return true;
}

function runStep(cx: Ctx, fr: Frame, step: Step, prog: readonly Step[], at: number): boolean {
  const st = cx.st;
  const owner = fr.owner;
  switch (step.k) {
    case 'target': {
      const list = takeList(cx);
      let shaped = false;
      // Charmed: no damaging ability targets the charmer (SRD 5.2.1 Charmed, srd-raw.txt:32957-32959).
      const charmLimit = has(owner, COND.charmed) && programDamages(prog.slice(at + 1));
      for (const u of st.units) {
        if (u.life === 'dead' || u.tpl.size > step.maxSize) continue;
        if (charmLimit && charmedBy(owner, u)) continue;
        if (step.who === 'ally' && u.team !== owner.team) continue;
        if (step.who === 'enemy' && !hostile(owner, u)) continue;
        if (u === owner) {
          if (step.self === 'no') continue;
          if (step.self === 'textSilent') {
            shaped = true;
            if (readFlag(st, 'selfTargetWhenTextSilent') === 'notAllowed') continue;
          }
        } else if (distFt(st, owner.cell, u.cell) > step.rangeFt || !targetable(st, owner.cell, u.cell, st)) continue; // a clear path: not behind Total Cover (srd-raw.txt:23778-23780)
        pushLegal(list, 'target').target = u.idx;
      }
      if (shaped) markFlag(st, 'selfTargetWhenTextSilent');
      if (list.n === 0) {
        releaseList(cx, list);
        fr.targets = [];
        return false;
      }
      const i = ask(cx, owner.idx, 'target', list, fr.cause, undefined, undefined, { src: { via: fr.via, lvl: fr.lvl } });
      fr.targets = [list.items[i]!.target];
      releaseList(cx, list);
      return true;
    }
    case 'attack': {
      const targets = fr.targets.slice();
      const cause = fr.cause;
      for (const ti0 of targets) {
        const t0 = st.units[ti0]!;
        if (t0.life === 'dead') continue;
        const r = rollAttack(cx, owner, step.atk, t0, false, cause);
        if (r.lost) continue;
        // Coverage step 9+: a declared reaction (Redirect Attack) may have put an ally in t0's place.
        const t = r.tgt;
        const ti = t.idx;
        fr.slot = r.slot;
        fr.crit = r.crit;
        fr.hadAdv = r.hadAdv;
        fr.adv = r.adv;
        fr.targets = [ti];
        fr.cause = r.seq;
        // M3 step 5a (RIDER): a spell attack's riders, asked once the hit or miss is known.
        const list = r.hit ? step.atk.onHit : step.atk.onMiss;
        let chosen: number[] | null = null;
        if (list) {
          chosen = [];
          askRiders(cx, owner, list, r.hit ? 'hit' : 'miss', t, step.atk, fr.grant, r.crit, r.seq, chosen, r.adv);
        }
        const saved = [fr.atk, fr.atkTgt, fr.riders, fr.extraDue] as const;
        fr.atk = step.atk;
        fr.atkTgt = ti;
        fr.riders = chosen;
        fr.extraDue = r.hit && chosen !== null && riderHasExtra(owner, chosen);
        const ok = runSteps(cx, fr, r.hit ? step.onHit : step.onMiss);
        if (ok && fr.extraDue && fr.slot >= 0) {
          // The branch dealt no damage of its own: the riders' extra damage is the hit's damage (a part of
          // the attack's type has none to take: W1 P4, riderExtra refuses it).
          dealHit(cx, owner, t, [], riderExtra(owner, chosen!, -1), fr.crit, fr.hadAdv, fr.slot, { unit: owner.idx, via: step.atk.id, slot: fr.slot, cause: r.seq }, step.atk.onHit, fr.grant, step.atk, chosen, fr.adv);
          fr.slot = -1;
        }
        const post = fr.riders;
        [fr.atk, fr.atkTgt, fr.riders, fr.extraDue] = saved;
        if (!ok) return false;
        if (post && post.length > 0) runRiders(cx, owner, t, post, cx.lastDecided);
      }
      fr.targets = targets;
      fr.cause = cause;
      fr.slot = -1;
      return true;
    }
    case 'damage': {
      const rolled = cx.sc.rolled;
      let slot: number;
      let crit = false;
      let purpose: Purpose;
      if (fr.slot >= 0) {
        // The attack's own damage: paired with its roll's slot, once. Any later damage step on
        // this target opens a roll of its own.
        const live0 = fr.targets.filter((t) => st.units[t]!.life !== 'dead');
        if (fr.atk && live0.length === 1 && live0[0] === fr.atkTgt) {
          // M3 step 5a: a spell attack's own damage on its target joins the riders' extra damage
          // and opens the target's hitTaken window (sim/riders.ts).
          // W1 (P4): a rider part of the attack's type takes this damage's first part's type.
          const extra = fr.extraDue && fr.riders ? riderExtra(owner, fr.riders, step.dmg.length > 0 ? step.dmg[0]!.type : -1) : null;
          fr.extraDue = false;
          const t = st.units[fr.atkTgt]!;
          dealHit(cx, owner, t, step.dmg, extra, fr.crit, fr.hadAdv, fr.slot, { unit: owner.idx, via: fr.via, slot: fr.slot, cause: fr.cause }, fr.atk.onHit, fr.grant, fr.atk, fr.riders, fr.adv);
          fr.slot = -1;
          fr.crit = false;
          return true;
        }
        const ds = openPaired(st, cx.dice, owner.idx, fr.slot, 'damage');
        rollDamage(step.dmg, fr.crit, fr.hadAdv, ds, rolled);
        closeRoll(cx.dice, ds);
        slot = fr.slot;
        crit = fr.crit;
        purpose = 'damage';
        fr.slot = -1;
        fr.crit = false;
      } else {
        const ds = frameRoll(cx, fr, fr.purpose);
        rollDamage(step.dmg, false, false, ds, rolled);
        if (fr.repeat > 1) {
          const extra = cx.sc.rolledExtra;
          for (let k = 1; k < fr.repeat; k++) {
            rollDamage(step.dmg, false, false, ds, extra);
            for (let i = 0; i < step.dmg.length; i++) rolled[i]! += extra[i]!;
          }
        }
        slot = ds.slot;
        doneRoll(cx, fr, ds);
        purpose = fr.purpose;
      }
      const live = fr.targets.filter((t) => st.units[t]!.life !== 'dead');
      // Session S: a spell's damage without an attack roll reaches its caster's spellDamage riders (crit: an attack's own).
      const reached = purpose !== 'damage' && spellDamageOf(st, fr) ? [] : null;
      if (live.length > 0) dealDamage(cx, reached ? { unit: owner.idx, via: fr.via, slot, cause: fr.cause, name: purpose === 'damage' ? undefined : fr.name, purpose, dealtTo: reached } : { unit: owner.idx, via: fr.via, slot, cause: fr.cause, name: purpose === 'damage' ? undefined : fr.name, purpose }, step.dmg, rolled, () => true, crit, live);
      // Coverage step 9: a hidden zone's own damage (its hook's frame has the zone as source).
      if (live.length > 0 && fr.purpose === 'zone' && fr.source >= 0 && st.fx[fr.source]!.hdc >= 0) hiddenZoneHurt(cx, st.fx[fr.source]!, live, fr.cause);
      if (reached && reached.length > 0) askSpellRiders(cx, owner, reached, fr.via, fr.cause);
      return true;
    }
    case 'save': {
      const group = fr.targets.filter((t) => st.units[t]!.life !== 'dead');
      const ok: boolean[] = [];
      for (const ti of group) {
        const t = st.units[ti]!;
        const fd = takeFold(cx);
        const cover = step.ability === 1 ? saveCover(st, fr, t, step.ignoresCover) : 0;
        const spec0 = saveSpec(st, t, step.key, step.dc, fd.adv, fd.dis, fd.f, step.targetAdv);
        const spec = cover > 0 ? { ...spec0, flat: spec0.flat + COVER_BONUS[cover]! } : spec0;
        const r = rollD20(cx, t, spec, step.key, fr.savePurpose, st.setup.flags, fr.cause, fd, { target: -1, via: fr.via });
        const seq = nextSeq(cx);
        if (cx.sink) {
          emit(cx, {
            ...evBase(cx, seq, fr.cause), k: 'save', who: ti, via: fr.via, name: fr.name, key: saveKeyName(step.ability), purpose: fr.savePurpose, slot: r.slot,
            d20: r.d20, natural: r.natural, face: r.face, pre: r.pre, ext: r.ext, total: r.total, dc: step.dc, adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(), ok: r.success,
            ...(cover > 0 ? { cover } : {}),
          });
        }
        releaseFold(cx, fd);
        ok.push(r.success);
      }
      // W1 (P1): forcing an enemy to save on its own turn extends the owner's sustained effect ("Force an
      // enemy to make a saving throw", srd-raw.txt:4989); sustain() itself checks the turn.
      if (st.active === owner.idx && group.some((ti) => hostile(owner, st.units[ti]!))) sustain(cx, owner, SUSTAIN.enemySave);
      if (step.dmg) {
        // One roll for the whole group, drawn even if everyone succeeded (p.16).
        const rolled = cx.sc.rolled;
        const ds = frameRoll(cx, fr, fr.purpose);
        rollDamage(step.dmg, false, false, ds, rolled);
        const slot = ds.slot;
        doneRoll(cx, fr, ds);
        const scales = ok.map((s) => (s ? (step.half ? SCALE.half : SCALE.none) : SCALE.full));
        const reached = spellDamageOf(st, fr) ? [] : null;
        dealDamage(cx, reached ? { unit: owner.idx, via: fr.via, slot, cause: fr.cause, name: fr.name, purpose: fr.purpose, dealtTo: reached } : { unit: owner.idx, via: fr.via, slot, cause: fr.cause, name: fr.name, purpose: fr.purpose }, step.dmg, rolled, () => true, false, group, scales);
        if (reached && reached.length > 0) askSpellRiders(cx, owner, reached, fr.via, fr.cause);
      }
      const failed = group.filter((_, i) => !ok[i]);
      const passed = group.filter((_, i) => ok[i]);
      const targets = fr.targets;
      // A save's riders aren't the attack's damage: they never pair with its roll or crit.
      const [slot0, crit0] = [fr.slot, fr.crit];
      fr.slot = -1;
      fr.crit = false;
      if (step.onFail.length > 0 && failed.length > 0) {
        fr.targets = failed;
        if (!runSteps(cx, fr, step.onFail)) return false;
      }
      if (step.onSuccess.length > 0 && passed.length > 0) {
        fr.targets = passed;
        if (!runSteps(cx, fr, step.onSuccess)) return false;
      }
      fr.targets = targets;
      fr.slot = slot0;
      fr.crit = crit0;
      return true;
    }
    case 'heal': {
      const s = frameRoll(cx, fr, 'heal');
      const amt = Math.max(0, drawExpr(s, step.roll));
      const slot = s.slot;
      doneRoll(cx, fr, s);
      for (const ti of fr.targets) {
        const t = st.units[ti]!;
        if (t.life === 'dead') continue;
        fr.healed = true;
        const before = t.hp;
        const after = Math.min(t.hpMax, before + amt);
        const seq = nextSeq(cx);
        if (cx.sink) emit(cx, { ...evBase(cx, seq, fr.cause), k: 'heal', src: owner.idx, tgt: ti, via: fr.via, name: fr.name, slot, rolled: amt, hpBefore: before, hpAfter: after });
        // Unconscious lasts until it regains any Hit Points (p.17): a heal of 0 leaves it down.
        if (t.life === 'down' || t.life === 'stable') {
          if (after > 0) revive(cx, t, after, seq);
        } else if (after !== before) {
          t.hp = after;
          cx.st.hpTick++;
        }
      }
      return true;
    }
    case 'apply': {
      // W1 (P3, section 3): a gated apply (Frenzy's arming step on Reckless Attack) checks its gates on
      // the program's owner as it runs. W1 content gates only Frenzy's, whose reading of when Rage is
      // checked is a flag (frenzyRageCheck: declaration = now; 'hit' is refused at scenario resolution).
      if (step.when) {
        useFlag(st, 'frenzyRageCheck');
        if (!gatesOk(st, owner, step.when, null)) return true;
      }
      const te = owner.tpl.effects[step.fx]!;
      if (te.group) endGroup(cx, owner, te.group, fr.cause);
      if (step.to === 'point') {
        if (fr.anchor < 0) return false;
        fr.lastFx = applyZone(cx, fr, step.fx, fr.anchor, fr.aim).id;
        return true;
      }
      const bearers = step.to === 'self' ? [owner.idx] : fr.targets;
      for (const bi of bearers) {
        const bearer = st.units[bi]!;
        if (bearer.life === 'dead') continue;
        const fx = newFx(cx, {
          tpl: step.fx, owner: owner.idx, bearer: bi, parent: te.dur.k === 'parent' ? fr.root : -1,
          param: fr.param, srcItem: fr.srcItem, until: expiryOf(te, owner, bearer), cause: fr.cause,
        });
        if (te.inHand) holdInHand(cx, owner, fx.id);
        fr.lastFx = fx.id;
      }
      return true;
    }
    case 'choose': {
      const list = takeList(cx);
      for (let i = 0; i < step.opts.length; i++) pushLegal(list, 'pick').opt = i;
      const i = ask(cx, owner.idx, 'pick', list, fr.cause, (l) => `pick:${step.opts[l.opt]!.local}`, undefined, { src: { via: fr.via, lvl: fr.lvl } });
      releaseList(cx, list);
      return runSteps(cx, fr, step.opts[i]!.steps);
    }
    case 'chooseSkill': {
      const list = takeList(cx);
      for (let i = 0; i < SKILLS.length; i++) pushLegal(list, 'pick').opt = i;
      fr.param = ask(cx, owner.idx, 'pick', list, fr.cause, (l) => `pick:${SKILLS[l.opt]![0]}`, undefined, { src: { via: fr.via, lvl: fr.lvl } });
      releaseList(cx, list);
      return true;
    }
    case 'use': {
      // The grant belongs to the effect the step before applied; if that didn't happen (no live bearer), skip.
      if (fr.lastFx < 0 || st.fx[fr.lastFx]!.tpl !== step.fx || !st.fx[fr.lastFx]!.alive) return true;
      const fx = st.fx[fr.lastFx]!;
      const te = boundOf(st, fx);
      const g = te.grants[step.grant]!;
      const sub = newFrame(st.units[fx.owner]!, { via: te.id, name: g.name, cause: fr.cause, source: fx.id, root: fx.id, lvl: fx.lvl, srcItem: fx.srcItem });
      return runSteps(cx, sub, g.steps);
    }
    case 'moveZone':
      if (fr.source >= 0) moveZone(cx, fr, step.ft);
      return true;
    case 'forced':
      for (const t of fr.targets) forcedMove(cx, owner, t, step, fr.cause, fr.via, fr.lvl);
      return true;
    case 'condition':
      imposeCondition(cx, fr, step);
      return true;
    case 'condSave':
      return condSave(cx, fr, step);
    case 'check':
      return abilityCheck(cx, fr, step);
    case 'endSource':
      if (fr.source >= 0) endFx(cx, fr.source, 'escaped', fr.cause);
      return true;
    case 'tempHp':
      grantTempHp(cx, fr, step);
      return true;
    case 'weaponAttack':
      weaponAttack(cx, fr, step);
      return true;
    case 'core':
      // The activation running this paid the cost (Patient Defense: one Bonus Action for both).
      coreAction(cx, owner, step.act, fr.via, fr.cause);
      return true;
    case 'gainAction':
      // One more action this turn (Action Surge's text grants exactly one per use).
      owner.b.action++;
      return true;
    case 'pool':
      poolStep(cx, fr, step);
      return true;
    case 'around': {
      // Session S: everyone in an Emanation around the owner (the zone mask and wall cut-off of
      // grid/area.ts, srd-raw.txt:33378-33386), the owner never; no decision. A downed creature is
      // a creature (its damage is a death-save failure). With nobody there the program goes on with none.
      const cells: number[] = [];
      areaCellsFrom(st, step.key, owner.cell, NO_AIM, cells, st);
      const out: number[] = [];
      for (const u of st.units) {
        if (u === owner || u.life === 'dead' || !cells.includes(u.cell)) continue;
        if (step.who === 'ally' && u.team !== owner.team) continue;
        if (step.who === 'enemy' && !hostile(owner, u)) continue;
        out.push(u.idx);
      }
      fr.targets = out;
      return true;
    }
    case 'extendSource': {
      // W1 (P1): the sustained effect whose grant is running lasts until the end of its bearer's next
      // turn again (Rage, "Take a Bonus Action to extend your Rage", srd-raw.txt:4990; "Each time the
      // Rage is extended, it lasts until the end of your next turn", 4992-4993).
      if (fr.source < 0) return true;
      const f = st.fx[fr.source]!;
      if (f.alive && f.bearer >= 0) reanchor(f, st.units[f.bearer]!);
      return true;
    }
    case 'move':
      freeMove(cx, fr);
      return true;
    case 'endConditions':
      // W1 (P11): the conditions end on the program's owner ("the condition ends on you", Mindless Rage,
      // srd-raw.txt:5183-5184); sim/conditions.ts ends the condition, not what else imposed it.
      if (owner.life !== 'dead') endConditions(cx, owner, step.bits, fr.via, fr.cause);
      return true;
  }
}

/**
 * Session S: is the damage `fr` deals now a spell's, for a spellDamage rider: the cast itself, or the
 * hook of an effect a spell created (a zone, a condition's repeat save). Never a rider's own program
 * (it has neither) or a feature's (sid -1). Checked only when the owner carries such a rider.
 */
function spellDamageOf(st: GameState, fr: Frame): boolean {
  if (!hasSpellRiders(fr.owner) || fr.purpose === 'rider') return false;
  return fr.entry !== null || (fr.source >= 0 && st.fx[fr.source]!.sid >= 0);
}

/**
 * WATK (M3 step 5a): `count` strikes with the acting creature's own attacks, each with the
 * existing resolution (to-hit, reach or range, damage, crit, riders on the attack's effects).
 * Before each strike it picks attack and target (a 'target' decision whose items are 'attack'
 * items, keyed attack:<attack>><seat>), among living hostile creatures that attack reaches, its
 * gear allows and its hands can wield, not its charmer (srd-raw.txt:32957-32958). With no legal
 * strike left, the rest are lost. These strikes aren't the Attack action (it never starts one).
 */
function weaponAttack(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'weaponAttack' }>): void {
  const st = cx.st;
  const a = fr.owner;
  const charmed = has(a, COND.charmed);
  // M3 step 5b. Light: "That extra attack must be made with a different Light weapon" (srd-raw.txt:
  // 20344-20345): not the one the Attack action used (when it used exactly one). Cleave: "a second
  // creature within 5 feet of the first that is also within your reach" (20362-20363).
  const lm = step.lightExtra ? a.b.lightMask : 0;
  const skipLight = lm !== 0 && (lm & (lm - 1)) === 0 ? lm : 0;
  const first = step.near ? (fr.targets.length > 0 ? st.units[fr.targets[0]!]! : null) : null;
  if (step.near && !first) return;
  for (let k = 0; k < step.count; k++) {
    if (st.outcome || a.life !== 'up') return;
    const list = takeList(cx);
    for (let j = 0; j < step.from.length; j++) {
      const ai = step.from[j]!;
      const atk = a.tpl.attacks[ai]!;
      if (!gearOk(st, a, atk.gear) || !canWield(a, atk)) continue;
      if (skipLight !== 0 && atk.item !== undefined && (skipLight & (1 << atk.item)) !== 0 && !lightStackSpare(a, atk)) continue;
      for (const t of st.units) {
        if (t === a || !hostile(a, t) || t.life === 'dead') continue;
        if (first && (t === first || distFt(st, first.cell, t.cell) > 5)) continue;
        if (charmed && charmedBy(a, t)) continue;
        const d = distFt(st, a.cell, t.cell);
        if (atk.kind === 'melee' ? d > atk.reachFt : d > atk.longFt) continue;
        if (!targetable(st, a.cell, t.cell, st)) continue; // M3 step 8: not behind Total Cover (srd-raw.txt:2028-2032)
        const l = pushLegal(list, 'attack');
        l.atk = ai;
        l.target = t.idx;
        l.opt = j;
      }
    }
    if (list.n === 0) {
      releaseList(cx, list);
      return;
    }
    markFlag(st, 'diagonalCost'); // reach and range were measured with it
    const i = ask(cx, a.idx, 'target', list, fr.cause, undefined, undefined, { src: { via: fr.via, lvl: fr.lvl } });
    const l = list.items[i]!;
    const atk = step.noAbility ? step.noAbility[l.opt]! : a.tpl.attacks[l.atk]!;
    const t = st.units[l.target]!;
    releaseList(cx, list);
    resolveAttackFor(cx, a, atk, t, false, cx.lastDecided, fr.grant);
  }
}

/**
 * W1 (docs/design/w1-plan.md P9): a move step's free move. "you can move up to half your Speed without
 * provoking Opportunity Attacks" (Tactical Shift, srd-raw.txt:10661-10663; Cunning Strike's Withdraw,
 * 13835-13836). Half the Speed now in 5-ft squares (a 35-ft Speed gives 15 ft); at Speed 0 (Steady Aim)
 * it's 0 and nothing is asked. A moveTo decision: pass first, then one item per square reachable within
 * that budget (keyed moveTo:<cell>; per square the route through the fewest known hazards, then the
 * shortest; whether it provokes doesn't matter). Whose movement it spends is the flag
 * freeMoveUsesMovement, read here only: false (default) = on top of the turn's movement (b.freeFt);
 * true = out of it on the mover's own turn, so no farther than the movement it has left [U: off its own
 * turn, a Withdraw on an opportunity attack, there's no turn's movement to spend, so it spends none].
 */
function freeMove(cx: Ctx, fr: Frame): void {
  const st = cx.st;
  const u = fr.owner;
  if (u.life !== 'up' || st.outcome) return;
  const half = Math.floor(speedNow(u, st) / 10) * 5;
  if (half <= 0) return;
  const own = st.active === u.idx;
  const spends = useFlag(st, 'freeMoveUsesMovement') && own;
  const budget = spends ? Math.min(half, u.b.moveFt) : half;
  if (budget <= 0) return;
  const sc = cx.sc.reachEngine;
  // A walk this one interrupts (Withdraw on an opportunity attack's hit) is still reading sc.path.
  const outer = sc.path.slice();
  computeReach(st, u, budget, sc);
  const list = takeList(cx);
  pushLegal(list, 'pass');
  forEachLabel(st, u, sc, budget, (cell, ft, provokes, parity, hazard) => {
    const last = list.n > 1 ? list.items[list.n - 1]! : null;
    if (last && last.cell === cell) {
      if (hazard < last.hazard || (hazard === last.hazard && ft < last.ft)) {
        last.ft = ft;
        last.provokes = provokes;
        last.parity = parity;
        last.hazard = hazard;
      }
      return;
    }
    const l = pushLegal(list, 'move');
    l.cell = cell;
    l.ft = ft;
    l.provokes = provokes;
    l.parity = parity;
    l.hazard = hazard;
  });
  if (list.n === 1) {
    releaseList(cx, list);
    return;
  }
  markFlag(st, 'diagonalCost'); // the routes used it
  const w = st.setup.w;
  const i = ask(cx, u.idx, 'moveTo', list, fr.cause, (l) => (l.k === 'pass' ? 'pass' : `moveTo:${cellName(l.cell, w)}`), undefined, { src: { via: fr.via } });
  const l = list.items[i]!;
  const [cell, provokes, parity, hazard] = [l.cell, l.provokes, l.parity, l.hazard];
  releaseList(cx, list);
  if (i === 0) {
    sc.path.set(outer);
    return;
  }
  computeReach(st, u, budget, sc); // the decider ran in between (its queries have their own scratch)
  const n = rebuildPath(sc, cell, provokes, parity, hazard);
  const path = sc.path.slice(0, n);
  sc.path.set(outer);
  walkPath(cx, u, path, n, 'voluntary', cx.lastDecided, 'pull', { left: budget, spends });
}

/** POOLX (M3 step 5a): a pool change, clamped to [0, max]; logged as a res event with the change. */
function poolStep(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'pool' }>): void {
  if (step.res < 0) return;
  const u = fr.owner;
  const max = u.tpl.resMax[step.res]!;
  const before = u.res[step.res]!;
  const want = step.delta === 'refill' ? max : before + step.delta;
  const after = want < 0 ? 0 : want > max ? max : want;
  u.res[step.res] = after;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, fr.cause), k: 'res', who: u.idx, pool: u.tpl.pools[step.res - 9]!.name, left: after, delta: after - before });
}

/**
 * A condition's repeat save at the end of its bearer's turn (the bearer is the hook's subject):
 * a success ends the condition's effect. Rolled under its own purpose, condSave, so it never
 * shifts the bearer's other saves. A failure runs its next stage (Sleep's Unconscious), if any,
 * under the first stage's parent: this hook's frame has the first stage as its root, which
 * expires at the boundary right after this hook (sim/fight.ts endTurn), and the cascade would end
 * the next stage with it.
 */
function condSave(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'condSave' }>): boolean {
  const st = cx.st;
  for (const ti of fr.targets) {
    const t = st.units[ti]!;
    if (t.life === 'dead' || fr.source < 0 || !st.fx[fr.source]!.alive) continue;
    const fd = takeFold(cx);
    const spec = saveSpec(st, t, step.key, step.dc, fd.adv, fd.dis, fd.f);
    const r = rollD20(cx, t, spec, step.key, 'condSave', st.setup.flags, fr.cause, fd, { target: -1, via: fr.via });
    const seq = nextSeq(cx);
    if (cx.sink) {
      emit(cx, {
        ...evBase(cx, seq, fr.cause), k: 'save', who: ti, via: fr.via, name: fr.name, key: saveKeyName(step.ability), purpose: 'condSave', slot: r.slot,
        d20: r.d20, natural: r.natural, face: r.face, pre: r.pre, ext: r.ext, total: r.total, dc: step.dc, adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(), ok: r.success,
      });
    }
    releaseFold(cx, fd);
    if (r.success) endFx(cx, fr.source, 'saved', seq);
    else if (step.onFail) {
      const next = newFrame(fr.owner, { via: fr.via, name: fr.name, cause: seq, source: fr.source, root: st.fx[fr.source]!.parent, lvl: fr.lvl, srcItem: fr.srcItem, purpose: fr.purpose, targets: [ti], param: fr.param });
      if (!runSteps(cx, next, step.onFail)) return false;
    }
  }
  return true;
}

/** An ability check by the acting creature (fr.owner: the bearer, for an escape), under purpose check. */
function abilityCheck(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'check' }>): boolean {
  const st = cx.st;
  const u = fr.owner;
  const fd = takeFold(cx);
  const { spec, key } = checkSpec(st, u, step.ability, step.skills, step.dc, fd.adv, fd.dis, fd.f);
  const r = rollD20(cx, u, spec, key, 'check', st.setup.flags, fr.cause, fd, { target: -1, via: fr.via });
  const seq = nextSeq(cx);
  if (cx.sink) {
    emit(cx, {
      ...evBase(cx, seq, fr.cause), k: 'save', who: u.idx, via: fr.via, name: fr.name, key: keyName(key), purpose: 'check', slot: r.slot,
      d20: r.d20, natural: r.natural, face: r.face, pre: r.pre, ext: r.ext, total: r.total, dc: step.dc, adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(), ok: r.success,
    });
  }
  releaseFold(cx, fd);
  const cause = fr.cause;
  fr.cause = seq;
  const ok = runSteps(cx, fr, r.success ? step.onSuccess : step.onFail);
  fr.cause = cause;
  return ok;
}

/**
 * Temporary Hit Points (SRD 5.2.1 p.18, srd-raw.txt:2376-2414): one roll for the group, under
 * its own purpose (they aren't healing, so the slot-heal hook never hears of them and a heal's
 * dice never move). They don't stack: each target keeps the higher of what it has and the new
 * amount (choosing the larger buffer). A creature at 0 HP can receive them; they don't wake it.
 */
function grantTempHp(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'tempHp' }>): void {
  const st = cx.st;
  const s = frameRoll(cx, fr, 'tempHp');
  const amt = Math.max(0, drawExpr(s, step.roll));
  const slot = s.slot;
  doneRoll(cx, fr, s);
  for (const ti of fr.targets) {
    const t = st.units[ti]!;
    if (t.life === 'dead') continue;
    const before = t.tempHp;
    if (amt > before) t.tempHp = amt;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, fr.cause), k: 'tempHp', src: fr.owner.idx, tgt: ti, via: fr.via, name: fr.name, slot, rolled: amt, before, after: t.tempHp });
  }
}

const ABBR = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * M3 step 8: the cover a Dexterity save gets from its effect's source (+2 Half, +5
 * Three-Quarters, srd-raw.txt:2006-2032; cover counts when the effect "originates on the
 * opposite side", 1999-2000). The source is a zone's point of origin (an area, glossary "Area of
 * Effect", 32672-32677), else, for a cast, activation or rider with no source effect, the
 * owner's square. An effect's hook on its bearer or a grant has no source point: no cover [U].
 * A raw Total reads as Three-Quarters and `ignoresCover` (Sacred Flame) drops Half and
 * Three-Quarters (sim/cover.ts saveCoverDegree; 8'a review R1, R2). Exported for the greedy
 * AI's save odds.
 */
export function saveCover(st: GameState, fr: Frame, t: Unit, ignoresCover?: 'partial'): number {
  if (st.setup.flags.losMethod === 'stubbed') return 0;
  if (fr.source >= 0) {
    const fx = st.fx[fr.source]!;
    if (fr.purpose !== 'zone' || fx.anchor < 0) return 0;
    const z = boundOf(st, fx).zone!;
    const [x4, y4, oc] = z.from ? creatureOriginPoint(st, z.shapeKey, fx.anchor, fx.aim ?? NO_AIM) : originPoint(st, fx.anchor);
    return saveCoverDegree(coverFromOrigin(st, x4 / 2, y4 / 2, oc, t, st), ignoresCover);
  }
  if (t === fr.owner) return 0;
  return saveCoverDegree(coverAt(st, fr.owner, fr.owner.cell, t.cell, t, st), ignoresCover);
}
function saveKeyName(ability: number): string {
  return `save.${ABBR[ability] ?? ''}`;
}

/** An effect's expiry when its owner creates it on `bearer`. */
export function expiryOf(te: BoundEffect, owner: Unit, bearer: Unit): Expiry {
  const d = te.dur;
  if (d.k === 'rounds') return { k: 'timed', unit: owner.idx, turn: owner.turns + d.n };
  if (d.k === 'untilTurn') {
    const anchor = d.of === 'owner' ? owner : bearer;
    // W1 (P11): endOfThisTurn, "until the end of the current turn" (Steady Aim, srd-raw.txt:13793-13794),
    // as Disengage's "this turn" (sim/act.ts): the boundary of the anchor's turn now under way.
    return { k: d.edge === 'start' ? 'turnStart' : 'turnEnd', unit: anchor.idx, after: d.thisTurn ? anchor.turns - 1 : anchor.turns };
  }
  return { k: 'never' };
}

/** Using a feature or spell again ends the owner's live effects in its group (re-activating a form). */
export function endGroup(cx: Ctx, owner: Unit, group: string, cause: number): void {
  const st = cx.st;
  for (let i = 0; i < st.fx.length; i++) {
    const f = st.fx[i]!;
    if (f.alive && f.owner === owner.idx && boundOf(st, f).group === group) endFx(cx, i, 'replaced', cause);
  }
}

/** A conjured effect "in your hand" fills an empty hand only under conjuredHandEffectBlocksHand. */
function holdInHand(cx: Ctx, owner: Unit, fxId: number): void {
  if (!useFlag(cx.st, 'conjuredHandEffectBlocksHand')) return;
  const h = emptyHand(owner);
  if (h < 0) return;
  owner.hands[h] = HAND.conjured;
  cx.st.fx[fxId]!.hand = h;
}

/**
 * Runs hook `hook` of effect `fxId` on one subject (a queued trigger's handler). A limited
 * effect fires once per creature per turn. A hook raised by a forced move fires only under
 * involuntaryMovementTriggersArea. A subject that has moved off the square the trigger
 * was raised for is skipped (an earlier handler in the same batch moved it).
 */
export function runEffectHook(cx: Ctx, fxId: number, hook: number, subject: Unit, a: number, b: number, flags: number, cause: number, on: number): void {
  const st = cx.st;
  const fx = st.fx[fxId]!;
  const te = boundOf(st, fx);
  const h = te.hooks[hook]!;
  const zoneHook = (h.on & (HOOK.enter | HOOK.travel | HOOK.turnEndIn)) !== 0 && te.zone !== null;
  if (zoneHook) {
    const expected = on === 2 ? b : a; // move5ft: the step's destination; enter and turnEnd: the cell in the record
    if (subject.cell !== expected) return;
    if (flags & 1 && !useFlag(st, 'involuntaryMovementTriggersArea')) return;
    const affects = te.zone!.affects;
    if (affects !== undefined && zoneSpares(affects, st.units[fx.owner]!, subject)) return;
  }
  if (te.limit === 'perCreature') {
    if (!ledgerOk(st, fx, subject.idx)) return;
    ledgerMark(st, fx, subject.idx);
  }
  const fr = newFrame(st.units[fx.owner]!, {
    via: te.id, name: te.name, cause, source: fxId, root: fxId, lvl: fx.lvl, srcItem: fx.srcItem,
    purpose: te.zone ? 'zone' : 'effect', targets: [subject.idx], param: fx.param,
  });
  if (h.on & HOOK.travel && on === 2) {
    const incr = flags >> 1;
    if (useFlag(st, 'perDistanceDamageRolls') === 'perMove') {
      if (fx.acc![subject.idx] === 0) st.accPending++;
      fx.acc![subject.idx]! += incr;
      return;
    }
    for (let k = 0; k < incr; k++) if (!runSteps(cx, fr, h.steps)) return;
    return;
  }
  runSteps(cx, fr, h.steps);
}
