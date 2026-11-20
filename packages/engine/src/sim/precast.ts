// Spells already up when a fight starts (docs/design/m1c.md 7.4; research in
// docs/research/m1c-stats-and-encounter.md part 2, section 4). Resolved in seat order after HP is
// rolled and before initiative, rolling no dice: scenario resolution rejects a precast whose
// program would roll (an attack, a save, damage, a heal) or move anyone, then dry-runs the rest,
// so a resolved FightSetup's precasts always resolve.
//
// A precast spends its slot (counted as a precast slot) or free-cast use, starts concentration,
// and runs the spell's program with its decisions answered from the scenario. A zone it places
// fires no appear hook (Moonbeam's "when the Cylinder appears" happened before the fight), and
// only the caster and the seats in seenBy saw it appear. Durations run as if it was cast on the
// caster's turn -elapsed: the caster's turn count reads -elapsed while it resolves, so expiryOf
// and Fx.born see that turn. Action economy and the one-slot-per-turn rule don't apply ("On a
// turn", SRD 5.2.1 p.105, and a precast happens on no turn: an UNVERIFIED reading, low stakes).

import type { CompiledTemplate, Step } from '../content/types.ts';
import { anchorRangeFt, NO_AIM, parseAnchor } from '../grid/area.ts';
import { emit, evBase, nextSeq, type Ctx } from './context.ts';
import { componentsOk } from './cast.ts';
import { countRes } from './counters.ts';
import { endConcentration, endFx, newFx } from './effects.ts';
import { heldHand } from './hands.ts';
import type { PrecastSetup } from './setup.ts';
import { expiryOf, newFrame, runSteps } from './steps.ts';
import { applyZone } from './zones.ts';
import type { Unit } from './state.ts';

/** A precast that can't resolve at the start; `seat` and `index` say which one. */
export class PrecastError extends Error {
  readonly seat: number;
  readonly index: number;
  constructor(seat: number, index: number, message: string) {
    super(message);
    this.seat = seat;
    this.index = index;
  }
}

/**
 * Passive features (docs/design/m3.md 2.4): each one's effects go on its bearer at fight start,
 * in seat, feature and listed order, before any precast. They last the whole fight (duration:
 * parent with no parent never expires). A creature with no passive feature does nothing here.
 */
export function applyPassives(cx: Ctx, cause: number): void {
  for (const u of cx.st.units) {
    for (const f of u.tpl.features) {
      if (!f.passive) continue;
      for (const tpl of f.passive) {
        const te = u.tpl.effects[tpl]!;
        // An Emanation (coverage step 7.5) sits on the grid with bearer -1: on `u.borne` too it would fold through foldFrom and foldAuras.
        if (te.zone) applyZone(cx, newFrame(u, { via: te.id, name: te.name, cause }), tpl, u.cell, NO_AIM, true);
        else newFx(cx, { tpl, owner: u.idx, bearer: u.idx, parent: -1, param: -1, srcItem: -1, until: expiryOf(te, u, u), cause });
      }
    }
  }
}

export function runPrecasts(cx: Ctx, cause: number): void {
  for (const u of cx.st.units) {
    const list = cx.st.setup.seats[u.idx]!.precast;
    if (list) for (let i = 0; i < list.length; i++) precastOne(cx, u, list[i]!, i, cause);
  }
}

function precastOne(cx: Ctx, u: Unit, p: PrecastSetup, index: number, cause: number): void {
  const st = cx.st;
  const e = u.tpl.spells[p.entry]!;
  const sp = e.spell;
  const fail = (msg: string) => new PrecastError(u.idx, index, `${u.seat}'s precast ${sp.id}: ${msg}`);
  if (e.whileHeld >= 0 && heldHand(u, e.whileHeld) < 0) throw fail(`it needs ${u.tpl.items[e.whileHeld]!.name} in hand at the start`);
  if (!componentsOk(st, u, e, st)) throw fail("its components can't be supplied with what the caster holds at the start");
  const prog = e.prog[p.lvl];
  if (!prog) throw fail(`it can't be cast at level ${p.lvl}`);
  let left = 0;
  let freeName: string | null = null;
  if (p.free) {
    freeName = u.tpl.pools[e.freePool - 9]!.name;
    if (u.res[e.freePool]! <= 0) throw fail(`no ${freeName} uses left`);
    u.res[e.freePool]!--;
    countRes(st.ctr, u.idx, e.freePool, true);
    left = u.res[e.freePool]!;
  } else if (p.lvl > 0) {
    if (u.res[p.lvl - 1]! <= 0) throw fail(`no level ${p.lvl} slot left`);
    u.res[p.lvl - 1]!--;
    countRes(st.ctr, u.idx, p.lvl - 1, true);
    left = u.res[p.lvl - 1]!;
  }
  let anchor = -1;
  // Nothing aimed lasts, so there's no aim to carry into the fight; an Emanation is around the caster.
  if (sp.areaFrom === 'aim') throw fail('its area is aimed from the caster, and an aimed area can\'t be precast');
  if (sp.areaFrom === 'bearer') anchor = u.cell;
  else if (sp.areaShape >= 0) {
    anchor = p.at === null ? -1 : parseAnchor(st, p.at);
    if (anchor < 0) throw fail(`${p.at ?? 'no square'} isn't a place it can be centered`);
    if (anchorRangeFt(st, u.cell, anchor) > sp.rangeFt) throw fail(`${p.at} is beyond its ${sp.rangeFt}-ft range from ${u.seat}`);
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'precast', who: u.idx, via: sp.id, name: sp.name, lvl: p.lvl, free: freeName, left, elapsed: p.elapsed });
  if (sp.recast === 'replace') {
    for (let i = 0; i < st.fx.length; i++) {
      const f = st.fx[i]!;
      if (f.alive && f.owner === u.idx && f.sid === sp.sid && f.parent < 0) endFx(cx, i, 'replaced', seq);
    }
  }
  const seen = new Uint8Array(st.units.length);
  for (const s of p.seen) seen[s] = 1;
  seen[u.idx] = 1;
  const turns = u.turns;
  u.turns = -p.elapsed;
  cx.pre = {
    seen,
    answer: (k, n, keyOf) => {
      const want = k === 'target' && p.target >= 0 ? `target:${st.units[p.target]!.seat}` : k === 'pick' && p.choose !== null ? `pick:${p.choose}` : null;
      if (want === null) throw fail(`it asks for a ${k} decision the scenario doesn't answer`);
      for (let i = 0; i < n; i++) if (keyOf(i) === want) return i;
      throw fail(`${want.slice(want.indexOf(':') + 1)} isn't a legal ${k} for it at the start`);
    },
  };
  try {
    let root = -1;
    if (sp.conc) {
      endConcentration(cx, u, 'newConcentration', seq);
      const inst = e.instance[p.lvl]!;
      const fx = newFx(cx, { tpl: inst, owner: u.idx, bearer: -1, parent: -1, param: -1, srcItem: e.whileHeld, until: expiryOf(u.tpl.effects[inst]!, u, u), cause: seq });
      u.conc = fx.id;
      st.ctr.concStart[u.idx]!++;
      root = fx.id;
    }
    const fr = newFrame(u, { entry: e, lvl: p.lvl, root, srcItem: e.whileHeld, via: sp.id, name: sp.name, cause: seq });
    fr.anchor = anchor;
    if (sp.areaFrom === 'bearer') fr.aim = NO_AIM;
    if (!runSteps(cx, fr, prog)) throw fail('it had no legal target at the start');
  } finally {
    cx.pre = null;
    u.turns = turns;
  }
}

/**
 * The static half of the precast checks: a program that would roll dice or move a creature
 * (naming the step), one with nothing lasting to leave behind, and an elapsed time the effect
 * wouldn't have lasted. `choose` picks which option of a choice is checked (all when null).
 */
export function precastProgramErrors(tpl: CompiledTemplate, prog: readonly Step[], conc: number, choose: string | null, elapsed: number): string[] {
  const errors: string[] = [];
  let lasting = conc >= 0;
  const durOk = (fx: number, what: string) => {
    const d = tpl.effects[fx]!.dur;
    if (d.k === 'rounds' && elapsed >= d.n) errors.push(`elapsed ${elapsed} isn't less than ${what}'s ${d.n}-round duration`);
    if (d.k === 'untilTurn' && elapsed > 0) errors.push(`${what} lasts only until a turn boundary, so elapsed must be 0`);
  };
  if (conc >= 0) durOk(conc, 'its concentration');
  const walk = (steps: readonly Step[]) => {
    for (const s of steps) {
      switch (s.k) {
        case 'attack':
        case 'save':
        case 'damage':
        case 'heal':
          errors.push(`its ${s.k} step would roll dice before the fight; a precast rolls none`);
          break;
        case 'forced':
        case 'moveZone':
          errors.push(`its ${s.k} step would move something before the fight; set the starting squares instead`);
          break;
        case 'apply':
          lasting = true;
          durOk(s.fx, tpl.effects[s.fx]!.name);
          break;
        case 'choose':
          for (const o of s.opts) if (choose === null || o.local === choose) walk(o.steps);
          break;
        case 'use':
          walk(tpl.effects[s.fx]!.grants[s.grant]!.steps);
          break;
        case 'target':
        case 'chooseSkill':
          break;
      }
    }
  };
  walk(prog);
  if (!lasting) errors.push('it leaves nothing lasting behind, so casting it before the fight does nothing');
  return errors;
}
