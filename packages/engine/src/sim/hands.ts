// Hands and held items (SRD 5.2.1 p.10, p.105-106, p.191). Each hand holds an item
// (tpl.items index), nothing, or a conjured effect. Items matter three ways here: a held
// shield's AC, a focus standing in for Material components (and, under focusHandSomatic,
// making the Somatic ones), and spells that are prepared only while an item is held.
//
// Drawing or stowing an item uses the one free object interaction, then the Utilize action.
// Donning or doffing a shield is always the Utilize action. An Unconscious creature drops what
// it holds (p.191); whether that includes a donned shield is unconsciousDropsShield.

import type { CompiledAttack } from '../content/types.ts';
import type { LegalList } from '../decide/decider.ts';
import { emit, evBase, nextSeq, pushLegal, type Ctx } from './context.ts';
import { endFx } from './effects.ts';
import { statAc } from './stats.ts';
import { HAND, useFlag, type QueryState, type Unit } from './state.ts';

export const ITEM = { stow: 0, draw: 1, doff: 2, don: 3, pickup: 4 } as const;
export const ITEM_ACTS = ['stow', 'draw', 'doff', 'don', 'pickup'] as const;

/** Which hand holds item `item` (a tpl.items index), or -1. */
export function heldHand(u: Unit, item: number): number {
  if (item < 0) return -1;
  return u.hands[0] === item ? 0 : u.hands[1] === item ? 1 : -1;
}

export function emptyHand(u: Unit): number {
  return u.hands[0] === HAND.empty ? 0 : u.hands[1] === HAND.empty ? 1 : -1;
}

/**
 * AC right now: the template's (no shield) plus a held shield's bonus, then the bearer's AC
 * stats (M3 step 4: bonuses, then the highest floor). `st` lets ownTurn gates read whose turn
 * it is; without it they're false.
 */
export function acNow(u: Unit, st: QueryState | null = null): number {
  let ac = u.tpl.ac;
  for (let h = 0; h < 2; h++) {
    const i = u.hands[h]!;
    if (i >= 0 && u.tpl.items[i]!.kind === 'shield') ac += u.tpl.items[i]!.shieldAc;
  }
  return u.stats.length === 0 ? ac : statAc(st, u, ac);
}

/** Item options this turn, in item order: stow/doff what's held, draw/don what's carried, pick up what's at its feet. */
export function listItems(st: QueryState, u: Unit, out: LegalList): void {
  void st;
  const items = u.tpl.items;
  if (items.length === 0) return;
  const b = u.b;
  const cheap0 = b.freeObj > 0 || b.action > 0;
  const free = emptyHand(u) >= 0;
  for (let i = 0; i < items.length; i++) {
    const shield = items[i]!.kind === 'shield';
    // M3 step 5b: a weapon may also use the Attack action's unused equip (srd-raw.txt:32707-32712).
    const cheap = cheap0 || (b.atkEquip > 0 && items[i]!.kind === 'weapon');
    const held = heldHand(u, i) >= 0;
    let act = -1;
    if (held) act = shield ? (b.action > 0 ? ITEM.doff : -1) : cheap ? ITEM.stow : -1;
    // A held shield is a donned one: picking it back up is donning it, the Utilize action.
    else if (u.dropped[i]! >= 0) act = u.dropped[i] === u.cell && free && (shield ? b.action > 0 : cheap) ? ITEM.pickup : -1;
    else if (free && !stackGone(u, i)) act = shield ? (b.action > 0 ? ITEM.don : -1) : cheap ? ITEM.draw : -1;
    if (act < 0) continue;
    const l = pushLegal(out, 'item');
    l.opt = i;
    l.aux = act;
  }
}

/** M3 step 5b: a held-weapon stack with none left (every one thrown): nothing to draw. */
function stackGone(u: Unit, item: number): boolean {
  if (u.tpl.items[item]!.kind !== 'weapon') return false;
  for (const a of u.tpl.attacks) if (a.item === item && a.gear >= 0 && u.gear[a.gear]! === 0) return true;
  return false;
}

export function resolveItem(cx: Ctx, u: Unit, item: number, act: number, cause: number): void {
  const b = u.b;
  const shield = u.tpl.items[item]!.kind === 'shield';
  if (!shield && b.atkEquip > 0 && u.tpl.items[item]!.kind === 'weapon') b.atkEquip = 0; // the Attack action's equip first
  else if (shield || b.freeObj === 0) b.action--;
  else b.freeObj--;
  if (act === ITEM.stow || act === ITEM.doff) u.hands[heldHand(u, item)] = HAND.empty;
  else {
    if (act === ITEM.pickup) u.dropped[item] = -1;
    u.hands[emptyHand(u)] = item;
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'item', who: u.idx, item: u.tpl.items[item]!.name, act: ITEM_ACTS[act]! });
  if (act === ITEM.stow || act === ITEM.doff) sourceLost(cx, u, item, seq);
}

/**
 * M3 step 5b: a held weapon not in hand is drawn into an empty hand as part of its attack (an
 * Attack action's strike, srd-raw.txt:32707-32711, or a throw, 20387-20389; canWield allowed it).
 * One lying in the attacker's square is picked up instead ("Equipping a weapon includes drawing
 * it from a sheath or picking it up", 32711; only an Attack action's strike, canWield; review
 * INT-1). Returns whether it drew or picked up.
 */
export function drawForAttack(cx: Ctx, u: Unit, atk: CompiledAttack, cause: number): boolean {
  const it = atk.item;
  if (it === undefined || heldHand(u, it) >= 0) return false;
  const h = emptyHand(u);
  if (h < 0) return false;
  const pickup = u.dropped[it]! >= 0;
  if (pickup) u.dropped[it] = -1;
  u.hands[h] = it;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'item', who: u.idx, item: u.tpl.items[it]!.name, act: pickup ? 'pickup' : 'draw' });
  return true;
}

/**
 * Step E (E2), thrownWeaponLands=targetSquare: a monster's thrown piece of counted gear lands on
 * the square of the creature it was thrown at, hit or miss (the post-Redirect target). Called
 * after the gear count went down, so a free slot always exists (slots = the starting count).
 * No event: logs without a pickup keep their bodies.
 */
export function landPiece(u: Unit, gear: number, cell: number): void {
  for (let i = 0; i < u.landed.length; i++) {
    if (u.landGear[i] === gear && u.landed[i]! < 0) {
      u.landed[i] = cell;
      return;
    }
  }
}

/**
 * Step E (E2): an Attack-action strike picks one of the unit's own landed pieces of `gear` up off
 * its own square with the strike's equip (srd-raw.txt:32707-32712, 43947-43953): gear +1, the slot
 * cleared, an `item` pickup event carrying the count now carried (`left`). Only the thrower picks
 * its pieces up (a departure: R9 doesn't say who may). Returns whether a piece was there.
 */
export function pickUpPiece(cx: Ctx, u: Unit, gear: number, cause: number): boolean {
  for (let i = 0; i < u.landed.length; i++) {
    if (u.landGear[i] !== gear || u.landed[i] !== u.cell) continue;
    u.landed[i] = -1;
    u.gear[gear]!++;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'item', who: u.idx, item: u.tpl.gear[gear]!.name, act: 'pickup', left: u.gear[gear]! });
    return true;
  }
  return false;
}

/**
 * M3 step 5b: a thrown held weapon leaves the hand once the attack is made. A counted stack keeps
 * the rest carried (the gear count already went down); a single weapon lands at the target's
 * square (step E: thrownWeaponLands, read only here for PCs; `gone` loses it), where it can be
 * picked up.
 */
export function weaponThrown(cx: Ctx, u: Unit, atk: CompiledAttack, t: Unit, cause: number): void {
  const it = atk.item;
  if (it === undefined || !atk.throws) return;
  const h = heldHand(u, it);
  if (h < 0) return;
  u.hands[h] = HAND.empty;
  if (atk.gear < 0 && useFlag(cx.st, 'thrownWeaponLands') === 'targetSquare') u.dropped[it] = t.cell;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'item', who: u.idx, item: u.tpl.items[it]!.name, act: 'throw' });
}

/** Unconscious: drop everything held, a shield only under unconsciousDropsShield. */
export function dropHeld(cx: Ctx, u: Unit, cause: number): void {
  for (let h = 0; h < 2; h++) {
    const i = u.hands[h]!;
    if (i < 0) continue;
    if (u.tpl.items[i]!.kind === 'shield' && !useFlag(cx.st, 'unconsciousDropsShield')) continue;
    u.hands[h] = HAND.empty;
    u.dropped[i] = u.cell;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'item', who: u.idx, item: u.tpl.items[i]!.name, act: 'drop' });
    sourceLost(cx, u, i, seq);
  }
}

/** An item that kept spells prepared left the hand: under losingSpellSourceEndsActiveSpell, their live effects end. */
function sourceLost(cx: Ctx, u: Unit, item: number, cause: number): void {
  const st = cx.st;
  let read = false;
  let ends = false;
  for (let i = 0; i < st.fx.length; i++) {
    const f = st.fx[i]!;
    if (!f.alive || f.owner !== u.idx || f.srcItem !== item || f.parent >= 0) continue;
    if (!read) {
      ends = useFlag(st, 'losingSpellSourceEndsActiveSpell');
      read = true;
    }
    if (ends) endFx(cx, i, 'sourceLost', cause);
  }
}
