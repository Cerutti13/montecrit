// Zones on the grid: placing one, stamping it into the per-cell zone index, the triggers that
// fire on a whole group at once (it appears over creatures, it's moved onto them), moving it,
// and the per-move damage flush. The per-creature triggers (enter, travel, ending a turn in it)
// come through the trigger queue (sim/triggers.ts).
//
// Moonbeam-style zones (SRD 5.2.1 p.150-151): every trigger shares one save per creature per
// turn (the ledger). Of overlapping copies of one spell only the most potent applies (p.106),
// checked before the ledger. Creatures caught by one appearance roll one damage roll (p.16);
// creatures caught by one move do too, unless areaSaveGroupingPerEvent=perCreature.

import { hiddenWitness } from './hidden.ts';
import { seesCell } from './cover.ts';
import { HOOK } from '../content/types.ts';
import { AIMS, anchorCount, anchorDistFt, anchorLine, anchorName, anchorRangeFt, areaCells, areaCellsFrom, areaFromName, NO_AIM, parseAnchor } from '../grid/area.ts';
import type { AreaFrom } from '../content/types.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { boundOf, ledgerMark, ledgerOk, newFx, outranks, sameEffect } from './effects.ts';
import { queueTrigger, TRIG } from './triggers.ts';
import { expiryOf, newFrame, runSteps, type Frame } from './steps.ts';
import { COND, has, useFlag, zoneSpares, type Fx, type QueryState, type Unit } from './state.ts';

/** Asks `owner` for an anchor within `rangeFt` of `fromCell` (or of `fromAnchor` when moving), excluding `skip`. */
export function askPlace(cx: Ctx, owner: Unit, rangeFt: number, from: { cell: number } | { anchor: number }, skip: number, cause: number, via = '', lvl?: number): number {
  const st = cx.st;
  const list = takeList(cx);
  const n = anchorCount(st);
  for (let a = 0; a < n; a++) {
    if (a === skip) continue;
    const d = 'cell' in from ? anchorRangeFt(st, from.cell, a) : anchorDistFt(st, from.anchor, a);
    if (d <= rangeFt) pushLegal(list, 'place').cell = a;
  }
  if (list.n === 0) {
    releaseList(cx, list);
    return -1;
  }
  const i = ask(cx, owner.idx, 'place', list, cause, (l) => `place:${anchorName(st, l.cell)}`, (key) => {
    const a = key.startsWith('place:') ? parseAnchor(st, key.slice(6)) : -1;
    if (a < 0) return -1;
    let lo = 0;
    let hi = list.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = list.items[mid]!.cell;
      if (c === a) return mid;
      if (c < a) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }, { src: { via, ...(lvl !== undefined ? { lvl } : {}) } });
  const anchor = list.items[i]!.cell;
  releaseList(cx, list);
  return anchor;
}

/** Asks `owner` which way an aimed area points: the 8 aims, always in this order (grid/area.ts AIMS, a stated model limit). */
export function askAim(cx: Ctx, owner: Unit, cause: number, via: string, lvl?: number): number {
  const list = takeList(cx);
  for (let a = 0; a < AIMS.length; a++) pushLegal(list, 'place').cell = a;
  const i = ask(cx, owner.idx, 'place', list, cause, (l) => `aim:${AIMS[l.cell]!}`, undefined, { src: { via, ...(lvl !== undefined ? { lvl } : {}) } });
  const aim = list.items[i]!.cell;
  releaseList(cx, list);
  return aim;
}

/** Where a frame's area goes, before its program runs: asked of `u` for an aim or an anchor, or (around `u`) not asked at all. */
export function placeArea(cx: Ctx, u: Unit, fr: Frame, from: AreaFrom | undefined, rangeFt: number, cause: number, via: string, lvl?: number): void {
  if (from === undefined) {
    fr.anchor = askPlace(cx, u, rangeFt, { cell: u.cell }, -1, cause, via, lvl);
    return;
  }
  fr.anchor = u.cell;
  fr.aim = from === 'aim' ? askAim(cx, u, cause, via, lvl) : NO_AIM;
}

/** Units covering a set of cells (not dead), in seat order, written into `out`. */
function unitsOn(st: QueryState, cells: readonly number[], out: number[]): number[] {
  out.length = 0;
  for (const u of st.units) if (u.life !== 'dead' && cells.includes(u.cell)) out.push(u.idx);
  return out;
}

function stamp(st: QueryState & { zoneMask: Uint32Array }, fx: Fx, cells: readonly number[]): void {
  const bit = 1 << fx.zbit;
  for (const c of cells) st.zoneMask[c] = st.zoneMask[c]! | bit;
}

function unstamp(st: QueryState & { zoneMask: Uint32Array }, fx: Fx): void {
  const bit = 1 << fx.zbit;
  const m = st.zoneMask;
  for (let c = 0; c < m.length; c++) m[c] = m[c]! & ~bit;
}

/**
 * Creates a zone effect at `anchor` (a spell's `apply: point`): stamps it, records who saw it
 * appear (everyone not Incapacitated who can see the caster, sim/cover.ts; a precast's seenBy), and runs
 * its appear hook on every creature it covers as one group (not for a precast). A zone with
 * zone.from takes a square for `anchor`, and `aim`; its squares never come from the lattice.
 * `passive` (coverage step 7.5): a feature's Emanation, up before the fight, fires nothing.
 */
export function applyZone(cx: Ctx, fr: Frame, tplIdx: number, anchor: number, aim?: number, passive = false): Fx {
  const st = cx.st;
  const owner = fr.owner;
  const te = owner.tpl.effects[tplIdx]!;
  const zone = te.zone!;
  let z = 0;
  while (z < 32 && st.zoneFx[z]! >= 0) z++;
  if (z === 32) throw new RangeError('more than 32 zones at once');
  const parented = te.dur.k === 'parent';
  const fx = newFx(cx, { tpl: tplIdx, owner: owner.idx, bearer: -1, parent: parented ? fr.root : -1, param: fr.param, srcItem: fr.srcItem, until: parented ? { k: 'never' } : expiryOf(te, owner, owner), cause: fr.cause, quiet: true });
  fx.zbit = z;
  fx.anchor = anchor;
  st.zoneFx[z] = fx.id;
  const bit = 1 << z;
  if (zone.difficult) st.diffBits |= bit;
  for (const h of te.hooks) {
    if (h.on & HOOK.travel) st.travelBits |= bit;
    if (h.on & (HOOK.enter | HOOK.turnEndIn)) st.hookBits |= bit;
    if (h.on & HOOK.enter) st.enterBits |= bit;
  }
  if (zone.from === 'bearer') {
    st.ownerAuras++;
    if (te.mods.length > 0) st.auraModBits |= bit;
  }
  const cells: number[] = [];
  if (zone.from) {
    if (aim !== undefined && aim !== NO_AIM) fx.aim = aim;
    areaCellsFrom(st, zone.shapeKey, anchor, aim ?? NO_AIM, cells, st);
  } else {
    useFlag(st, 'areaOriginOnGrid');
    useFlag(st, 'areaGridCoverage');
    areaCells(st, zone.shapeKey, anchor, cells, st);
  }
  stamp(st, fx, cells);
  const seen: number[] = [];
  for (const u of st.units) {
    // Who saw it cast: M3 step 8, a creature cut off from the caster by walls didn't (sim/cover.ts) [U: sight of the caster stands for sight of the casting].
    // Coverage step 9: for a hidden zone, sight of its area (srd-raw.txt:31016-31017; sim/hidden.ts).
    if (cx.pre ? cx.pre.seen[u.idx] === 0 : fx.hdc >= 0 ? !hiddenWitness(st, u, owner, cells) : u.life === 'dead' || has(u, COND.incapacitated) || (u !== owner && !seesCell(st, u.cell, owner.cell, st))) continue;
    fx.seen![u.idx] = 1;
    seen.push(u.idx);
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, fr.cause), k: 'zone', fx: fx.id, via: te.id, name: te.name, owner: owner.idx, anchor: zone.from ? areaFromName(st, anchor, aim ?? NO_AIM) : anchorName(st, anchor), cells: cells.length, difficult: zone.difficult, seen, area: cells.slice() });
  // A precast zone appeared before the fight: its appear hook doesn't fire at the start.
  const hi = cx.pre || passive ? -1 : te.hooks.findIndex((h) => (h.on & HOOK.appear) !== 0);
  if (hi >= 0) {
    const group = gate(st, fx, unitsOn(st, cells, []));
    if (group.length > 0) runZoneGroup(cx, fx, hi, group, seq);
  }
  // Spirit Guardians' text doesn't address the cast itself (srd-raw.txt:31040-31047): a flag.
  if (zone.from === 'bearer' && !cx.pre && !passive && fx.alive) {
    const on = te.hooks.findIndex((h) => (h.on & HOOK.movedOnto) !== 0);
    if (on >= 0 && useFlag(st, 'emanationCastTrigger') === 'onCast') fireMovedOnto(cx, fx, on, unitsOn(st, cells, []), seq);
  }
  return fx;
}

/**
 * Coverage step 7.5: the owner took a step, so the Emanations around it go with it (srd-raw.txt:33383-33384).
 * Called right after the square changes, voluntary or forced, before the step's other triggers:
 * the mover's own `enter` reads the new mask. Each creature the area newly covers is caught
 * (31041-31043, "enters a creature's space"); the owner never is, in or out of its own area.
 */
export function moveAuras(cx: Ctx, u: Unit, cause: number): void {
  const st = cx.st;
  let ids: number[] | null = null;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id >= 0 && st.fx[id]!.owner === u.idx && boundOf(st, st.fx[id]!).zone!.from === 'bearer') (ids ??= []).push(id);
  }
  if (!ids) return;
  ids.sort((a, b) => a - b);
  for (const id of ids) moveAura(cx, st.fx[id]!, u, cause);
}

function moveAura(cx: Ctx, fx: Fx, u: Unit, cause: number): void {
  const st = cx.st;
  const te = boundOf(st, fx);
  const key = te.zone!.shapeKey;
  const bit = 1 << fx.zbit;
  const m = st.zoneMask;
  const a0 = fx.anchor;
  const cells: number[] = [];
  areaCellsFrom(st, key, a0, NO_AIM, cells);
  const caught: number[] = [];
  const before: number[] = [];
  for (const o of st.units) if (o !== u && o.life !== 'dead' && m[o.cell]! & bit) before.push(o.idx);
  for (const c of cells) m[c] = m[c]! & ~bit;
  areaCellsFrom(st, key, u.cell, NO_AIM, cells, st);
  stamp(st, fx, cells);
  fx.anchor = u.cell;
  for (const o of st.units) if (o !== u && o.life !== 'dead' && m[o.cell]! & bit && !before.includes(o.idx)) caught.push(o.idx);
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'zoneMove', fx: fx.id, via: te.id, name: te.name, from: areaFromName(st, a0, NO_AIM), to: areaFromName(st, u.cell, NO_AIM), caught: caught.slice(), area: cells.slice() });
  if (caught.length === 0 || !(te.hookMask & HOOK.movedOnto)) return;
  cx.q.groups.push(caught);
  queueTrigger(cx, TRIG.auraMoved, u.idx, fx.id, cx.q.groups.length - 1, 0, seq);
}

/** A queued auraMoved's handler: whoever it caught and is still under it. */
export function auraMovedOnto(cx: Ctx, fxId: number, hook: number, caught: readonly number[], cause: number): void {
  const st = cx.st;
  const fx = st.fx[fxId]!;
  if (!fx.alive) return;
  const bit = 1 << fx.zbit;
  fireMovedOnto(cx, fx, hook, caught.filter((ui) => st.units[ui]!.life !== 'dead' && st.zoneMask[st.units[ui]!.cell]! & bit), cause);
}

/** Fires a zone's movedOnto hook on those caught, past gate(): one group, one damage roll, unless areaSaveGroupingPerEvent=perCreature. */
function fireMovedOnto(cx: Ctx, fx: Fx, hook: number, caught: number[], cause: number): void {
  const st = cx.st;
  const group = gate(st, fx, caught);
  if (group.length === 0) return;
  if (group.length >= 2 && useFlag(st, 'areaSaveGroupingPerEvent') === 'perCreature') {
    for (const u of group) if (fx.alive) runZoneGroup(cx, fx, hook, [u], cause);
  } else runZoneGroup(cx, fx, hook, group, cause);
}

/**
 * Keeps the creatures this zone may fire on now: not covered by a more potent copy of the
 * same spell (p.106), not spared by its `affects`, and not already hit by it this turn (once per
 * turn); marks the ledger.
 */
function gate(st: QueryState, fx: Fx, units: number[]): number[] {
  const out: number[] = [];
  const affects = boundOf(st, fx).zone!.affects;
  for (const ui of units) {
    const u = st.units[ui]!;
    if (affects !== undefined && zoneSpares(affects, st.units[fx.owner]!, u)) continue;
    let beaten = false;
    if (fx.sid >= 0) {
      for (let z = 0; z < 32 && !beaten; z++) {
        const id = st.zoneFx[z]!;
        if (id < 0 || id === fx.id) continue;
        const o = st.fx[id]!;
        if (outranks(o, fx) && st.zoneMask[u.cell]! & (1 << o.zbit) && sameEffect(st, o, fx)) beaten = true;
      }
    }
    if (beaten || !ledgerOk(st, fx, ui)) continue;
    ledgerMark(st, fx, ui);
    out.push(ui);
  }
  return out;
}

function runZoneGroup(cx: Ctx, fx: Fx, hook: number, group: number[], cause: number): void {
  const st = cx.st;
  const te = boundOf(st, fx);
  const fr = newFrame(st.units[fx.owner]!, { via: te.id, name: te.name, cause, source: fx.id, root: fx.id, lvl: fx.lvl, srcItem: fx.srcItem, purpose: 'zone', targets: group, param: fx.param });
  runSteps(cx, fr, te.hooks[hook]!.steps);
}

/**
 * Moves the frame's zone up to `ft` (a Magic action on later turns; its range doesn't limit
 * it, p.105). Creatures it moves into save once each; whether creatures it passes over on the
 * way count too is movedAreaTriggersAlongPath.
 */
export function moveZone(cx: Ctx, fr: Frame, ft: number): void {
  const st = cx.st;
  const fx = st.fx[fr.source]!;
  const te = boundOf(st, fx);
  const key = te.zone!.shapeKey;
  const a0 = fx.anchor;
  const a1 = askPlace(cx, fr.owner, ft, { anchor: a0 }, a0, fr.cause, fr.via, fr.lvl);
  if (a1 < 0) return;
  const cells: number[] = [];
  const before = unitsOn(st, (areaCells(st, key, a0, cells), cells), []);
  unstamp(st, fx);
  areaCells(st, key, a1, cells);
  stamp(st, fx, cells);
  fx.anchor = a1;
  useFlag(st, 'areaOriginOnGrid');
  useFlag(st, 'areaGridCoverage');
  const dest = unitsOn(st, cells, []).filter((u) => !before.includes(u));
  let caught = dest;
  const line = anchorLine(st, a0, a1);
  if (line.length > 2) {
    // First contact along the line, ties in seat order.
    const sweep: number[] = [];
    const tmp: number[] = [];
    for (let i = 1; i < line.length; i++) {
      areaCells(st, key, line[i]!, tmp);
      for (const u of unitsOn(st, tmp, [])) if (!before.includes(u) && !sweep.includes(u)) sweep.push(u);
    }
    const same = sweep.length === dest.length && sweep.every((u) => dest.includes(u));
    if (!same) caught = useFlag(st, 'movedAreaTriggersAlongPath') === 'sweepPath' ? sweep : dest;
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, fr.cause), k: 'zoneMove', fx: fx.id, via: te.id, name: te.name, from: anchorName(st, a0), to: anchorName(st, a1), caught: caught.slice(), area: cells.slice() });
  const hi = te.hooks.findIndex((h) => (h.on & HOOK.movedOnto) !== 0);
  if (hi < 0) return;
  fireMovedOnto(cx, fx, hi, caught, seq);
}

/**
 * perDistanceDamageRolls=perMove: one damage instance for every 5-ft increment a move
 * accumulated, dealt even if the zone ended mid-move (the creature traveled those feet while
 * it was there). A zone that's gone runs its hook unanchored: no source to stop it, no root
 * to link children to.
 */
export function flushPerMove(cx: Ctx, fxId: number, subject: Unit, cause: number): void {
  const st = cx.st;
  const fx = st.fx[fxId]!;
  const n = fx.acc![subject.idx]!;
  fx.acc![subject.idx] = 0;
  if (n === 0) return;
  st.accPending--;
  if (subject.life === 'dead' || st.outcome) return;
  const te = boundOf(st, fx);
  const hi = te.hooks.findIndex((h) => (h.on & HOOK.travel) !== 0);
  const anchor = fx.alive ? fxId : -1;
  const fr = newFrame(st.units[fx.owner]!, { via: te.id, name: te.name, cause, source: anchor, root: anchor, lvl: fx.lvl, srcItem: fx.srcItem, purpose: 'zone', targets: [subject.idx], repeat: n });
  runSteps(cx, fr, te.hooks[hi]!.steps);
}
