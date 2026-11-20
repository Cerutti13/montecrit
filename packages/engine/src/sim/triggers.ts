// Trigger queue. Triggers raised during one atomic step (a damage instance, a 5-ft step, a
// turn's start or end) queue up and resolve after it. drain() takes everything queued as one
// batch and collects the handlers it triggers in a canonical order: record order, then
// effect id, then hook index. When two or more handlers interact (they share a subject, or
// one moves creatures or zones or makes or ends effects), whoever's turn it is orders them
// (simultaneous effects, SRD 5.2.1 p.187); otherwise they run in canonical order with no
// decision. Each handler's consequences queue and drain nested, before the next handler runs.
//
// Records are 8 ints: [on, subject, a, b, flags, cause, 0, 0]. Handlers copy what they need
// out of their record, so a nested drain can reuse the queue's slots safely.
//   turnStart  -                      turnEnd  a = the cell it ends in
//   move5ft    a = from, b = to, flags = forced | increments << 1
//   enter      a = to, b = from, flags = forced
//   damaged    a = damage taken      concSave a = DC, b = the concentration fx id
//   moveEnd    flags = forced        slotHeal (the caster whose slot-cast spell healed)
//   auraMoved  subject = its owner, a = the zone's fx id, b = the caught creatures (TriggerQueue.groups)

import { HOOK, type BoundEffect } from '../content/types.ts';
import { ask, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { concentrationSave } from './damage.ts';
import { damageTakenWindow } from './d20.ts';
import { boundOf, outrankedIn, outranks, sameEffect } from './effects.ts';
import { runEffectHook } from './steps.ts';
import { useFlag, type GameState, type Unit } from './state.ts';
import { auraMovedOnto, flushPerMove } from './zones.ts';

export const TRIG = { turnStart: 0, turnEnd: 1, move5ft: 2, enter: 3, damaged: 4, concSave: 5, moveEnd: 6, slotHeal: 7, auraMoved: 8 } as const;
export const TRIG_NAMES = ['turnStart', 'turnEnd', 'move5ft', 'enter', 'damaged', 'concSave', 'moveEnd', 'slotHeal', 'auraMoved'] as const;
export type TriggerOn = (typeof TRIG)[keyof typeof TRIG];

/** What a handler does: run an effect's hook, make a concentration save, flush per-move damage, (M3 step 8'a) offer a damageTaken reaction, or (coverage step 7.5) fire an Emanation's movedOnto hook on its group. */
export const HANDLER = { hook: 0, conc: 1, flush: 2, react: 3, aura: 4 } as const;

const RW = 8; // record width
const HW = 9; // handler width: [kind, fx, hook, subject, a, b, flags, cause, on]

export interface TriggerQueue {
  buf: Int32Array;
  head: number;
  tail: number;
  hs: Int32Array;
  htop: number;
  /** Coverage step 7.5: who each auraMoved record caught; one damage roll per move (p.16), so a record holds a group. */
  groups: number[][];
}

export function newTriggerQueue(): TriggerQueue {
  return { buf: new Int32Array(RW * 64), head: 0, tail: 0, hs: new Int32Array(HW * 64), htop: 0, groups: [] };
}

export function resetTriggerQueue(q: TriggerQueue): void {
  q.head = q.tail = q.htop = 0;
  q.groups.length = 0;
}

/** Queues a trigger, unless nothing could possibly listen (most steps and turns of most fights). */
export function queueTrigger(cx: Ctx, on: TriggerOn, subject: number, a: number, b: number, flags: number, cause: number): void {
  const st = cx.st;
  const u = st.units[subject]!;
  if (!listening(st, on, u, a, b)) return;
  const q = cx.q;
  if (q.tail + RW > q.buf.length) {
    const grown = new Int32Array(q.buf.length * 2);
    grown.set(q.buf);
    q.buf = grown;
  }
  const r = q.tail;
  q.buf[r] = on;
  q.buf[r + 1] = subject;
  q.buf[r + 2] = a;
  q.buf[r + 3] = b;
  q.buf[r + 4] = flags;
  q.buf[r + 5] = cause;
  q.tail += RW;
}

function listening(st: GameState, on: TriggerOn, u: Unit, a: number, b: number): boolean {
  switch (on) {
    case TRIG.turnStart:
      return (u.hookMask & HOOK.turnStart) !== 0;
    case TRIG.turnEnd:
      return (u.hookMask & HOOK.turnEnd) !== 0 || (a >= 0 && (st.zoneMask[a]! & st.hookBits) !== 0);
    case TRIG.damaged:
      // M3 step 8'a: a damageTaken reaction listens too (b = the creature that dealt it).
      return (u.hookMask & HOOK.damaged) !== 0 || (st.watchDamaged > 0 && a > 0 && b >= 0 && b !== u.idx && hasDamageReaction(u));
    case TRIG.move5ft:
      return ((st.zoneMask[a]! | st.zoneMask[b]!) & st.travelBits) !== 0;
    case TRIG.enter:
      return (st.zoneMask[a]! & ~st.zoneMask[b]! & st.hookBits) !== 0;
    case TRIG.moveEnd:
      return st.accPending > 0;
    case TRIG.slotHeal: {
      // An owner hook: any live effect the caster owns, wherever it sits.
      for (const f of st.fx) if (f.alive && f.owner === u.idx && boundOf(st, f).hookMask & HOOK.slotHeal) return true;
      return false;
    }
    case TRIG.concSave:
    case TRIG.auraMoved:
      return true;
  }
  return false;
}

function hasDamageReaction(u: Unit): boolean {
  const fs = u.tpl.features;
  for (let i = 0; i < fs.length; i++) if (fs[i]!.damageTaken) return true;
  return false;
}

/** Resolves everything queued. */
export function drain(cx: Ctx): void {
  const q = cx.q;
  while (q.head < q.tail) {
    const lo = q.head;
    const hi = q.tail;
    q.head = hi;
    const base = q.htop;
    for (let r = lo; r < hi; r += RW) collect(cx, r);
    const n = (q.htop - base) / HW;
    if (n >= 2 && interacting(cx, base, n)) orderHandlers(cx, base, n);
    for (let h = base; h < base + n * HW; h += HW) runHandler(cx, h);
    q.htop = base;
    if (q.head === q.tail && q.htop === 0) {
      q.head = q.tail = 0;
      q.groups.length = 0;
    }
  }
}

function pushHandler(cx: Ctx, kind: number, fx: number, hook: number, subject: number, a: number, b: number, flags: number, cause: number, on = -1): void {
  const q = cx.q;
  if (q.htop + HW > q.hs.length) {
    const grown = new Int32Array(q.hs.length * 2);
    grown.set(q.hs);
    q.hs = grown;
  }
  const h = q.htop;
  q.hs[h] = kind;
  q.hs[h + 1] = fx;
  q.hs[h + 2] = hook;
  q.hs[h + 3] = subject;
  q.hs[h + 4] = a;
  q.hs[h + 5] = b;
  q.hs[h + 6] = flags;
  q.hs[h + 7] = cause;
  q.hs[h + 8] = on;
  q.htop += HW;
}

function collect(cx: Ctx, r: number): void {
  const st = cx.st;
  const buf = cx.q.buf;
  const on = buf[r]!;
  const subject = buf[r + 1]!;
  const a = buf[r + 2]!;
  const b = buf[r + 3]!;
  const flags = buf[r + 4]!;
  const cause = buf[r + 5]!;
  const u = st.units[subject]!;
  switch (on) {
    case TRIG.turnStart:
      collectBorne(cx, u, HOOK.turnStart, a, b, flags, cause, on);
      return;
    case TRIG.turnEnd:
      if (a >= 0) collectZones(cx, u, st.zoneMask[a]! & st.hookBits, HOOK.turnEndIn, a, b, flags, cause, on);
      collectBorne(cx, u, HOOK.turnEnd, a, b, flags, cause, on);
      return;
    case TRIG.damaged:
      collectBorne(cx, u, HOOK.damaged, a, b, flags, cause, on);
      // After the effect hooks: one handler per creature damaged, offering its reaction (d20.ts damageTakenWindow).
      if (st.watchDamaged > 0 && a > 0 && b >= 0 && b !== u.idx && hasDamageReaction(u)) pushHandler(cx, HANDLER.react, -1, -1, u.idx, a, b, flags, cause, on);
      return;
    case TRIG.enter:
      collectZones(cx, u, st.zoneMask[a]! & ~st.zoneMask[b]! & st.hookBits, HOOK.enter, a, b, flags, cause, on);
      return;
    case TRIG.move5ft: {
      // A step counts in the travel zones its destination is in ("moves into or within the
      // area"); the step out of one counts only under areaExitStepCounts.
      let bits = st.zoneMask[b]! & st.travelBits;
      const left = st.zoneMask[a]! & ~st.zoneMask[b]! & st.travelBits;
      if (left !== 0 && useFlag(st, 'areaExitStepCounts')) bits |= left;
      collectZones(cx, u, bits, HOOK.travel, a, b, flags, cause, on);
      return;
    }
    case TRIG.moveEnd:
      // Ended zones too: the feet were traveled while the zone was there.
      for (const f of st.fx) if (f.acc && f.acc[subject]! > 0) pushHandler(cx, HANDLER.flush, f.id, -1, subject, a, b, flags, cause);
      return;
    case TRIG.slotHeal:
      for (const f of st.fx) {
        if (!f.alive || f.owner !== u.idx) continue;
        boundOf(st, f).hooks.forEach((h, hi) => {
          if (h.on & HOOK.slotHeal) pushHandler(cx, HANDLER.hook, f.id, hi, u.idx, a, b, flags, cause, on);
        });
      }
      return;
    case TRIG.concSave:
      pushHandler(cx, HANDLER.conc, b, -1, subject, a, b, flags, cause);
      return;
    case TRIG.auraMoved: {
      const hi = boundOf(st, st.fx[a]!).hooks.findIndex((h) => (h.on & HOOK.movedOnto) !== 0);
      pushHandler(cx, HANDLER.aura, a, hi, subject, a, b, flags, cause, on);
      return;
    }
  }
}

function collectBorne(cx: Ctx, u: Unit, hook: number, a: number, b: number, flags: number, cause: number, on: number): void {
  if (!(u.hookMask & hook)) return;
  const st = cx.st;
  for (const id of u.borne) {
    const fx = st.fx[id]!;
    if (!fx.alive || outrankedIn(st, u.borne, fx)) continue; // two copies of one rider: only the most potent fires (p.106)
    const te = boundOf(st, fx);
    te.hooks.forEach((h, hi) => {
      if (h.on & hook) pushHandler(cx, HANDLER.hook, id, hi, u.idx, a, b, flags, cause, on);
    });
  }
}

/**
 * Zone handlers for one subject, in effect-id order (zone slots are reused, so slot order
 * isn't creation order). Of overlapping copies of one spell only the most potent fires
 * (p.106); its own once-per-turn ledger is checked when it runs.
 */
function collectZones(cx: Ctx, u: Unit, bits: number, hook: number, a: number, b: number, flags: number, cause: number, on: number): void {
  if (bits === 0) return;
  const st = cx.st;
  const ids: number[] = [];
  for (let z = 0; z < 32; z++) if (bits & (1 << z)) ids.push(st.zoneFx[z]!);
  ids.sort((x, y) => x - y);
  // Potency is against every zone covering the subject's square, not only the ones this record names:
  // entering a weaker copy while standing in a stronger one doesn't fire the weaker one.
  const covering = st.zoneMask[u.cell]! | bits;
  for (const id of ids) {
    const fx = st.fx[id]!;
    if (!fx.alive) continue;
    let beaten = false;
    if (fx.sid >= 0) {
      for (let z = 0; z < 32 && !beaten; z++) {
        if (!(covering & (1 << z))) continue;
        const o = st.fx[st.zoneFx[z]!]!;
        if (o !== fx && o.alive && outranks(o, fx) && sameEffect(st, o, fx)) beaten = true;
      }
    }
    if (beaten) continue;
    const te = boundOf(st, fx);
    te.hooks.forEach((h, hi) => {
      if (h.on & hook) pushHandler(cx, HANDLER.hook, id, hi, u.idx, a, b, flags, cause, on);
    });
  }
}

function templateOf(cx: Ctx, h: number): BoundEffect | null {
  const fx = cx.q.hs[h + 1]!;
  return (cx.q.hs[h]! === HANDLER.hook || cx.q.hs[h]! === HANDLER.aura) && fx >= 0 ? boundOf(cx.st, cx.st.fx[fx]!) : null;
}

/**
 * Two handlers share a subject, or one of them can change what the others see. Two
 * concentration saves never need ordering against each other: the concentration ends if
 * either fails, whichever goes first.
 */
function interacting(cx: Ctx, base: number, n: number): boolean {
  const hs = cx.q.hs;
  for (let i = 0; i < n; i++) {
    const hi = base + i * HW;
    if (templateOf(cx, hi)?.interacts) return true;
    for (let j = i + 1; j < n; j++) {
      const hj = base + j * HW;
      if (hs[hi + 3] === hs[hj + 3] && !(hs[hi] === HANDLER.conc && hs[hj] === HANDLER.conc)) return true;
    }
  }
  return false;
}

/**
 * The active unit picks which handler runs next until one is left; rewrites the batch in
 * place. Concentration saves of one creature on one concentration are a single item (the
 * concentration ends if either fails, whatever the order), so every item has its own key.
 */
function orderHandlers(cx: Ctx, base: number, n: number): void {
  const st = cx.st;
  const hs = cx.q.hs;
  const who = st.active >= 0 ? st.active : hs[base + 3]!;
  const cause = hs[base + 7]!;
  const tmp = hs.slice(base, base + n * HW);
  // Items: lists of handler indices, the concentration saves of one (subject, concentration) grouped.
  const pending: number[][] = [];
  for (let i = 0; i < n; i++) {
    const conc = tmp[i * HW] === HANDLER.conc;
    const mate = conc ? pending.find((g) => tmp[g[0]! * HW] === HANDLER.conc && tmp[g[0]! * HW + 3] === tmp[i * HW + 3] && tmp[g[0]! * HW + 1] === tmp[i * HW + 1]) : undefined;
    if (mate) mate.push(i);
    else pending.push([i]);
  }
  let out = base;
  while (pending.length > 0) {
    let pick = 0;
    if (pending.length > 1) {
      const list = takeList(cx);
      for (const g of pending) {
        const i = g[0]!;
        const l = pushLegal(list, 'order');
        l.opt = i;
        l.aux = tmp[i * HW]!;
        l.fx = tmp[i * HW + 1]!;
        l.lvl = tmp[i * HW + 2]!;
        l.target = tmp[i * HW + 3]!;
        l.cell = tmp[i * HW + 8]!; // the trigger kind: one hook can fire from two records in one batch
      }
      pick = ask(cx, who, 'orderTriggers', list, cause);
      releaseList(cx, list);
    }
    for (const i of pending[pick]!) {
      hs.set(tmp.subarray(i * HW, i * HW + HW), out);
      out += HW;
    }
    pending.splice(pick, 1);
  }
}

function runHandler(cx: Ctx, h: number): void {
  const st = cx.st;
  const hs = cx.q.hs;
  const kind = hs[h]!;
  const fxId = hs[h + 1]!;
  const subject = st.units[hs[h + 3]!]!;
  const cause = hs[h + 7]!;
  if (kind === HANDLER.flush) return flushPerMove(cx, fxId, subject, cause); // clears the tally even when nothing is dealt
  if (subject.life === 'dead' || st.outcome) return;
  if (kind === HANDLER.conc) return concentrationSave(cx, subject, hs[h + 4]!, fxId, cause);
  if (kind === HANDLER.aura) return auraMovedOnto(cx, fxId, hs[h + 2]!, cx.q.groups[hs[h + 5]!]!, cause);
  if (kind === HANDLER.react) return damageTakenWindow(cx, subject, hs[h + 4]!, hs[h + 5]!, cause);
  const fx = st.fx[fxId]!;
  if (!fx.alive) return;
  runEffectHook(cx, fxId, hs[h + 2]!, subject, hs[h + 4]!, hs[h + 5]!, hs[h + 6]!, cause, hs[h + 8]!);
}
