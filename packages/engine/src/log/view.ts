// The replay view (docs/design/m2.md 4.1): a fight's frames, built by folding its events over
// the setup, as the plan says ("the main thread builds its view by applying events"). Pure; on
// the order-sensitive lint list (no key iteration, no Map/Set). Every change the viewer shows is
// in an event payload (step.to, damage.hpAfter, cond.on, fxEnd, ...) plus the view-only `area`
// on zone events; the fold cross-checks itself against every turnStart and the fight's end, and
// lists any disagreement in `problems` rather than guessing.

import type { Life, Outcome } from '../sim/state.ts';
import type { FightSetup } from '../sim/setup.ts';
import type { GameEvent } from './events.ts';

export interface TokenView {
  readonly seat: string;
  readonly name: string;
  readonly team: 0 | 1;
  readonly pc: boolean;
  readonly cell: number;
  readonly hp: number;
  readonly hpMax: number;
  readonly life: Life;
  /** Condition ids, sorted with <. */
  readonly conds: readonly string[];
  /** Fx id of the effect it concentrates on, or -1. */
  readonly conc: number;
}

export interface ZoneView {
  readonly fx: number;
  readonly via: string;
  readonly name: string;
  readonly owner: number;
  readonly anchor: string;
  readonly cells: readonly number[];
  readonly difficult: boolean;
}

export interface ViewMarks {
  /** The active unit's cells this turn, voluntary moves only, starting where its turn began. */
  readonly trail: readonly number[];
  /** The latest forced move this turn: who, the cells it passed, pull or push. */
  readonly forced: { readonly who: number; readonly path: readonly number[]; readonly how: 'pull' | 'push' } | null;
  /** The latest attack, until the next decision or turn. */
  readonly strike: { readonly att: number; readonly tgt: number; readonly hit: boolean; readonly crit: boolean; readonly opportunity: boolean } | null;
  /** The HP change this event made (damage negative, healing positive), on this frame only. */
  readonly delta: { readonly tgt: number; readonly hp: number } | null;
}

export interface ViewFrame {
  /** ViewFrame index: frames[0] is the start, frames[i + 1] the state after events[i]. */
  readonly i: number;
  /** The event's seq (-1 for the start). */
  readonly seq: number;
  readonly round: number;
  readonly turnOf: number;
  readonly units: readonly TokenView[];
  readonly zones: readonly ZoneView[];
  /** Cells of the dead, in order of death. */
  readonly bodies: readonly number[];
  readonly marks: ViewMarks;
  readonly outcome: Outcome | null;
}

export interface ViewFrames {
  readonly frames: readonly ViewFrame[];
  /** ViewFrame indices right after each turnStart and roundStart event, in order. */
  readonly turnStarts: readonly number[];
  readonly roundStarts: readonly number[];
  /** Where the fold disagreed with the fight; empty when the view is exact. */
  readonly problems: readonly string[];
}

/** How the fight ended, per unit: what the fold must arrive at (and where rolled HP comes from). */
export interface FrameEnd {
  readonly hp: readonly number[];
  readonly hpMax: readonly number[];
  readonly life: readonly Life[];
}

const NO_MARKS: ViewMarks = { trail: [], forced: null, strike: null, delta: null };

function sortedWith(xs: readonly string[], x: string): string[] {
  if (xs.includes(x)) return xs.slice();
  const out = xs.slice();
  let i = 0;
  while (i < out.length && out[i]! < x) i++;
  out.splice(i, 0, x);
  return out;
}

/**
 * Builds every frame of a fight from its setup and events (an ArraySink's, fightStart first).
 * `end` is the fight's final HP, max HP and life per unit: it supplies rolled monster HP
 * (monsterHp=rolled rolls before any event can carry it) and is checked against the last frame.
 */
export function buildFrames(setup: FightSetup, events: readonly GameEvent[], end: FrameEnd | null): ViewFrames {
  const problems: string[] = [];
  const rolled = setup.flags.monsterHp === 'rolled';
  // monsterHp=rolled: stat-block seats with no HP override and an HP formula rolled theirs
  // before any event (sim/fight.ts rollHp); the fight's end says what they rolled.
  const rolls = (u: number): boolean => {
    const s = setup.seats[u]!;
    return rolled && s.tpl.kind !== 'pc' && s.hp === null && s.tpl.hpFormula !== null;
  };
  if (end === null && setup.seats.some((_s, u) => rolls(u))) problems.push('rolled monster HP without the fight end: starting HP shows the template value');
  let units: TokenView[] = setup.seats.map((s, u) => {
    const pc = s.tpl.kind === 'pc';
    const hpMax = rolls(u) && end !== null ? end.hpMax[u]! : s.tpl.hpMax;
    return {
      seat: s.seat,
      name: s.tpl.name,
      team: s.team,
      pc,
      cell: s.cell,
      hp: s.hp ?? hpMax,
      hpMax,
      life: 'up',
      conds: s.prone ? ['core:prone'] : [],
      conc: -1,
    };
  });
  let zones: ZoneView[] = [];
  let bodies: number[] = [];
  let marks: ViewMarks = NO_MARKS;
  let outcome: Outcome | null = null;
  let round = 0;
  let turnOf = -1;
  const frames: ViewFrame[] = [{ i: 0, seq: -1, round, turnOf, units, zones, bodies, marks, outcome }];
  const turnStarts: number[] = [];
  const roundStarts: number[] = [];

  const set = (u: number, patch: Partial<TokenView>): void => {
    const next = units.slice();
    next[u] = { ...units[u]!, ...patch };
    units = next;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    round = e.round;
    turnOf = e.turnOf;
    if (marks.delta !== null) marks = { ...marks, delta: null };
    switch (e.k) {
      case 'turnStart': {
        const u = units[e.who]!;
        if (u.cell !== e.cell || u.hp !== e.hp) problems.push(`#${e.seq} ${u.seat}'s turn starts at cell ${e.cell} with ${e.hp} HP; the view has cell ${u.cell}, ${u.hp} HP`);
        marks = { trail: [e.cell], forced: null, strike: null, delta: null };
        turnStarts.push(i + 1);
        break;
      }
      case 'roundStart':
        roundStarts.push(i + 1);
        break;
      case 'decided':
        if (marks.strike !== null) marks = { ...marks, strike: null };
        break;
      case 'step':
        set(e.who, { cell: e.to });
        if (e.forced !== undefined) {
          const f = marks.forced;
          marks = { ...marks, forced: f !== null && f.who === e.who && f.how === e.forced && f.path[f.path.length - 1] === e.from ? { ...f, path: [...f.path, e.to] } : { who: e.who, path: [e.from, e.to], how: e.forced } };
        } else if (e.who === e.turnOf) {
          marks = { ...marks, trail: [...marks.trail, e.to] };
        }
        break;
      case 'swap':
        // Coverage step 9+: two creatures trade squares at once (Redirect Attack).
        if (units[e.who]!.cell !== e.from || units[e.with]!.cell !== e.to) problems.push(`#${e.seq} ${units[e.who]!.seat} swaps from cell ${e.from} with ${units[e.with]!.seat} on cell ${e.to}; the view has cells ${units[e.who]!.cell} and ${units[e.with]!.cell}`);
        set(e.who, { cell: e.to });
        set(e.with, { cell: e.from });
        break;
      case 'moveEnd':
        if (units[e.who]!.cell !== e.cell) {
          problems.push(`#${e.seq} ${units[e.who]!.seat} ends its move at cell ${e.cell}; the view has cell ${units[e.who]!.cell}`);
          set(e.who, { cell: e.cell });
        }
        break;
      case 'attack':
        marks = { ...marks, strike: { att: e.att, tgt: e.tgt, hit: e.hit, crit: e.crit, opportunity: e.opportunity } };
        break;
      case 'damage':
        if (units[e.tgt]!.hp !== e.hpBefore) problems.push(`#${e.seq} damage to ${units[e.tgt]!.seat} starts from ${e.hpBefore} HP; the view has ${units[e.tgt]!.hp}`);
        set(e.tgt, { hp: e.hpAfter });
        marks = { ...marks, delta: { tgt: e.tgt, hp: e.hpAfter - e.hpBefore } };
        break;
      case 'heal':
        if (units[e.tgt]!.hp !== e.hpBefore) problems.push(`#${e.seq} healing on ${units[e.tgt]!.seat} starts from ${e.hpBefore} HP; the view has ${units[e.tgt]!.hp}`);
        set(e.tgt, { hp: e.hpAfter });
        marks = { ...marks, delta: { tgt: e.tgt, hp: e.hpAfter - e.hpBefore } };
        break;
      case 'down':
        set(e.who, { life: 'down' });
        break;
      case 'revive':
        // The event omits hp when it's 1 (a natural 20 on a death save; sim/damage.ts revive).
        set(e.who, { life: 'up', hp: e.hp ?? 1 });
        break;
      case 'stable':
        set(e.who, { life: 'stable' });
        break;
      case 'deathFail':
        // A Stable creature that takes damage is dying again (sim/damage.ts, p.18); the engine
        // emits only this event for it.
        if (units[e.who]!.life === 'stable') set(e.who, { life: 'down' });
        break;
      case 'death':
        set(e.who, { life: 'dead' });
        bodies = [...bodies, units[e.who]!.cell];
        break;
      case 'cond': {
        const u = units[e.who]!;
        set(e.who, { conds: e.on ? sortedWith(u.conds, e.cond) : u.conds.filter((c) => c !== e.cond) });
        break;
      }
      case 'fxStart':
        if (e.conc) set(e.owner, { conc: e.fx });
        break;
      case 'fxEnd':
        for (let u = 0; u < units.length; u++) if (units[u]!.conc === e.fx) set(u, { conc: -1 });
        if (zones.some((z) => z.fx === e.fx)) zones = zones.filter((z) => z.fx !== e.fx);
        break;
      case 'zone':
        if (e.area === undefined) problems.push(`#${e.seq} zone ${e.name} carries no area (an event written without a sink's view fields)`);
        else if (e.area.length !== e.cells) problems.push(`#${e.seq} zone ${e.name}: area has ${e.area.length} cells, the event says ${e.cells}`);
        zones = [...zones.filter((z) => z.fx !== e.fx), { fx: e.fx, via: e.via, name: e.name, owner: e.owner, anchor: e.anchor, cells: e.area ?? [], difficult: e.difficult }];
        break;
      case 'zoneMove': {
        const k = zones.findIndex((z) => z.fx === e.fx);
        if (k < 0) problems.push(`#${e.seq} ${e.name} moves, but the view has no such zone`);
        else {
          if (e.area === undefined) problems.push(`#${e.seq} zone move of ${e.name} carries no area`);
          const next = zones.slice();
          next[k] = { ...zones[k]!, anchor: e.to, cells: e.area ?? zones[k]!.cells };
          zones = next;
        }
        break;
      }
      case 'fightEnd':
        outcome = e.outcome;
        break;
      default:
        break;
    }
    frames.push({ i: i + 1, seq: e.seq, round, turnOf, units, zones, bodies, marks, outcome });
  }

  if (end !== null) {
    units.forEach((u, k) => {
      if (u.hp !== end.hp[k] || u.hpMax !== end.hpMax[k] || u.life !== end.life[k]) {
        problems.push(`end: ${u.seat} has ${u.hp}/${u.hpMax} HP, ${u.life} in the view; the fight ended ${end.hp[k]}/${end.hpMax[k]} HP, ${end.life[k]}`);
      }
    });
  }
  return { frames, turnStarts, roundStarts, problems };
}
