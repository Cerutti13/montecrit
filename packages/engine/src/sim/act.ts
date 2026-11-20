// Carrying out a chosen turn option.
//
// Attack action: the first strike spends the action and starts the act; each strike narrows
// which alternatives (Multiattack lines, or 1 + Extra Attack) can still hold the strikes made
// so far, in any order. The act ends when no attack can extend a live alternative, or at the
// end of the turn (unused strikes are lost). Moving between strikes is allowed
// (moveBetweenAttacks).

import type { Legal } from '../decide/decider.ts';
import { CELL, computeReach, gearOk, rebuildPath } from '../grid/reach.ts';
import { emit, evBase, nextSeq, type Ctx } from './context.ts';
import { resolveAttack } from './attack.ts';
import { resolveCast, resolveEnd, resolveUse } from './cast.ts';
import { heldHand, pickUpPiece, resolveItem } from './hands.ts';
import { speedNow } from './damage.ts';
import { allAlts, canExtend, liveAlts } from './options.ts';
import { walkPath } from './walker.ts';
import { resolveSearch } from './hidden.ts';
import { TERR } from '../grid/cells.ts';
import { addCond, COND, condId, markFlag, removeCond, useFlag, type Unit } from './state.ts';
import { plainAlt, type Id } from '../content/types.ts';

/**
 * A core action's effect (the option's or an activation's cost is paid by the caller). SRD 5.2.1
 * Rules Glossary (srd-raw.txt): Dash, "extra movement equal to your Speed" for the rest of the
 * turn (33242-33248, 1324-1326); Disengage, "your movement doesn't provoke Opportunity Attacks
 * for the rest of the turn" (1333-1334); Dodge, until the start of your next turn attack rolls
 * against you have Disadvantage and you make DEX saves with Advantage, lost while Incapacitated
 * or at Speed 0 (33369-33376; sim/conditions.ts reads it).
 */
export function coreAction(cx: Ctx, u: Unit, act: 'dash' | 'disengage' | 'dodge', via: Id, cause: number): void {
  const b = u.b;
  if (act === 'dash') {
    b.moveFt += speedNow(u, cx.st);
    b.dashes++;
    return;
  }
  if (act === 'dodge') u.dodgedTurn = u.turns; // G4's streak (M7)
  const bit = act === 'disengage' ? COND.disengaged : COND.dodging;
  // Disengage: the rest of this turn (its end). Dodge: until the start of its next turn.
  const until = act === 'disengage' ? ({ k: 'turnEnd', unit: u.idx, after: u.turns - 1 } as const) : ({ k: 'turnStart', unit: u.idx, after: u.turns } as const);
  if (addCond(u, bit, via, u.idx, cause, until)) {
    const c = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, c, cause), k: 'cond', who: u.idx, cond: condId(bit), on: true, via });
  }
}

export function resolveOption(cx: Ctx, u: Unit, l: Legal, cause: number): void {
  const b = u.b;
  if (!b.atkActive || l.k === 'attack' || l.k === 'move') return resolveNow(cx, u, l, cause);
  // M3 step 8'a, splitActions [U]: another action taken while the Attack action still has attacks
  // left (Dodge after Action Surge). Under notAllowed the Attack action ends there and its unused
  // attacks are lost (as at the end of the turn); under allowed (the engine before the flag) it
  // carries on afterwards. Read only when it decides something: an Action was spent mid-Attack.
  const before = b.action;
  resolveNow(cx, u, l, cause);
  if (b.atkActive && b.action < before && useFlag(cx.st, 'splitActions') === 'notAllowed') b.atkActive = false;
}

function resolveNow(cx: Ctx, u: Unit, l: Legal, cause: number): void {
  const st = cx.st;
  const b = u.b;
  switch (l.k) {
    case 'attack': {
      const act = u.tpl.attackAct;
      const first = !b.atkActive;
      if (first) {
        b.action--;
        b.atkActive = true;
        b.atkCounts.fill(0);
        b.atkLive = allAlts(u);
      }
      b.atkCounts[l.atk]!++;
      b.atkLive = liveAlts(act.alts, b.atkCounts, b.atkLive);
      if (first) {
        // Step E (E1): a strike only the plain alternative holds (a punch, or an attack outside
        // every Multiattack line) is the Attack action, not the Multiattack (srd-raw.txt:32705-32706).
        const seq = nextSeq(cx);
        const plain = act.multi && b.atkLive === 1 << plainAlt(act);
        if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: act.multi && !plain ? 'core:multiattack' : 'core:attack', name: plain ? 'Attack' : act.name });
      }
      // Step E (E2): a monster's thrown piece lying on its own square is picked up by this strike's
      // own equip ("Equipping a weapon includes ... picking it up", 32707-32712; a Multiattack's
      // strikes are part of the Attack action, 43947-43953), before the roll.
      const atkE = u.tpl.attacks[l.atk]!;
      if (!u.isPc && atkE.gear >= 0 && !gearOk(st, u, atkE.gear)) pickUpPiece(cx, u, atkE.gear, cause);
      // M3 step 5b, held weapons: the strike's one equip ("either equip or unequip one weapon when
      // you make an attack as part of this action ... either before or after the attack",
      // srd-raw.txt:32707-32712) is spent drawing (or picking up, 32711) its weapon, else left for
      // after it; a throw's draw is the Thrown property's own, but picking a thrown weapon up off
      // the ground is not drawing it. Every strike of the action has its own equip, an Unarmed
      // Strike's included ("one attack roll with a weapon or an Unarmed Strike", 32704; review R2).
      // A Light weapon's strike opens the Light extra attack.
      const atk = u.tpl.attacks[l.atk]!;
      if (atk.item !== undefined) {
        const away = heldHand(u, atk.item) < 0;
        const drew = away && (!atk.throws || u.dropped[atk.item]! >= 0);
        b.atkEquip = drew ? 0 : 1;
        if (u.tpl.items[atk.item]!.light) b.lightMask |= 1 << atk.item;
      } else if (u.tpl.items.length > 0) b.atkEquip = 1;
      resolveAttack(cx, u, l.atk, st.units[l.target]!, false, cause);
      if (u.life !== 'up') b.atkActive = false;
      else {
        let more = false;
        for (let ai = 0; ai < u.tpl.attacks.length && !more; ai++) more = canExtend(u, ai, cx.sc.counts);
        if (!more) b.atkActive = false;
      }
      return;
    }
    case 'move': {
      if (b.atkActive && u.tpl.attackAct.multi && useFlag(st, 'moveBetweenAttacks') === 'extraAttackOnly') b.atkActive = false;
      markFlag(st, 'diagonalCost'); // the route and every reach check used it
      if (st.setup.terrain.some((t) => (t & TERR.wall) !== 0)) markFlag(st, 'diagonalCorner');
      const sc = cx.sc.reachEngine;
      computeReach(st, u, b.moveFt, sc);
      const n = rebuildPath(sc, l.cell, l.provokes, l.parity, l.hazard);
      for (let i = 0; i < n - 1; i++) {
        // The route passes through an occupied square it can't stop in.
        if (sc.info[sc.path[i]!]! & CELL.occupied) {
          useFlag(st, 'pauseInOccupiedSpace');
          break;
        }
      }
      walkPath(cx, u, sc.path, n, 'voluntary', cause);
      return;
    }
    case 'option': {
      const o = u.tpl.options[l.opt]!;
      if (o.cost === 'action') b.action--;
      else b.bonus--;
      const seq = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: o.id, name: o.name });
      coreAction(cx, u, o.core === 'core:dash' ? 'dash' : 'disengage', o.id, seq);
      return;
    }
    case 'dodge': {
      // The core Dodge action (M3 step 5a): any creature that can take an action can take it.
      b.action--;
      const seq = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: 'core:dodge', name: 'Dodge' });
      coreAction(cx, u, 'dodge', 'core:dodge', seq);
      return;
    }
    case 'search':
      resolveSearch(cx, u, cause); // coverage step 9 (sim/hidden.ts)
      return;
    case 'stand': {
      const cost = Math.floor(speedNow(u, cx.st) / 2);
      b.moveFt -= cost;
      b.standFt += cost;
      const seq = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: 'core:stand', name: 'Stand up' });
      if (removeCond(u, COND.prone)) {
        const c = nextSeq(cx);
        if (cx.sink) emit(cx, { ...evBase(cx, c, seq), k: 'cond', who: u.idx, cond: condId(COND.prone), on: false, via: 'core:stand' });
      }
      return;
    }
    case 'cast':
      return resolveCast(cx, u, l, cause);
    case 'use':
      return resolveUse(cx, u, l, cause);
    case 'end':
      return resolveEnd(cx, u, l, cause);
    case 'item':
      return resolveItem(cx, u, l.opt, l.aux, cause);
    default:
      throw new Error(`can't resolve a ${l.k} as a turn option`);
  }
}
