// Casting spells, using what effects grant, activating features, dismissing effects.
//
// Casting (SRD 5.2.1 p.104-106): an Action spell takes the Magic action, a Bonus Action spell
// the Bonus Action (one per turn). On a turn only one spell slot can be spent (p.105), keyed by
// turn, so a slot spent on someone else's turn counts against that turn. Cantrips and free
// casts spend no slot. Components follow the hands (sim/hands.ts): a focus covers a Material
// component, and the hand holding it makes the Somatic one only for spells that also have a
// Material component, unless focusHandSomatic=lenient. Spells prepared only while an item is
// held are offered only while it's held.
//
// The list builders are engine-side (the caller is about to ask the list), so a flag that
// changed what's offered is marked right there.

import { END, type CompiledActivation, type CompiledFeature, type SpellEntry, type Step } from '../content/types.ts';
import type { Legal, LegalList } from '../decide/decider.ts';
import { distFt, hostile } from '../grid/reach.ts';
import { targetable } from './cover.ts';
import { emit, evBase, nextSeq, pushLegal, type Ctx } from './context.ts';
import { boundOf, endConcentration, endFx, newFx } from './effects.ts';
import { heldHand } from './hands.ts';
import { endGroup, expiryOf, newFrame, runSteps } from './steps.ts';
import { drain, queueTrigger, TRIG } from './triggers.ts';
import { placeArea } from './zones.ts';
import { programDamages } from './conditions.ts';
import { charmedBy, gatesOk, noCasting } from './stats.ts';
import { countRes } from './counters.ts';
import { COND, HAND, has, markFlag, readFlag, type GameState, type QueryState, type Unit } from './state.ts';

/**
 * Whether `u` can supply this spell's components with what its hands hold right now (or with
 * `hands`, a hypothetical grip: the AI asking what picking an item up would allow). `mark`
 * records the flags that decided it.
 */
export function componentsOk(st: QueryState, u: Unit, e: SpellEntry, mark: GameState | null, hands: ArrayLike<number> = u.hands): boolean {
  const sp = e.spell;
  let free = 0;
  let focus = false;
  let pouch = false;
  for (let h = 0; h < 2; h++) {
    const i = hands[h]!;
    if (i === HAND.empty) free++;
    else if (i >= 0) {
      const item = u.tpl.items[i]!;
      if (item.kind === 'focus' && item.focusFor.includes(e.list)) focus = true;
      if (item.kind === 'pouch') pouch = true;
    }
  }
  if (sp.createsInHand && free === 0) {
    if (mark) markFlag(mark, 'conjuredHandEffectBlocksHand');
    if (readFlag(st, 'conjuredHandEffectBlocksHand')) return false;
  }
  // A pouch needs a free hand to reach into, and only a focus hand can make the gestures (p.106; SAC-SpellComponents3).
  const mOk = sp.m === 'none' || focus || (pouch && free > 0);
  let sOk = !sp.s || free > 0 || (focus && sp.m !== 'none');
  if (!sOk && focus && sp.m === 'none') {
    // A V,S spell with no Material, a focus in one hand and the other full (2024 SAC-SpellComponents3).
    if (mark) markFlag(mark, 'focusHandSomatic');
    sOk = readFlag(st, 'focusHandSomatic') === 'lenient';
  }
  return mOk && sOk;
}

/** Whether a program's first target step has anyone to target (an area or a self spell always does). */
function anyTarget(st: QueryState, u: Unit, prog: readonly Step[], mark: GameState): boolean {
  const t = prog[0];
  if (!t || t.k !== 'target') return true;
  // Charmed (M3 step 4): a damaging program can't target the charmer (srd-raw.txt:32957-32959).
  const charmLimit = has(u, COND.charmed) && programDamages(prog.slice(1));
  for (const o of st.units) {
    if (o.life === 'dead' || o.tpl.size > t.maxSize) continue;
    if (charmLimit && charmedBy(u, o)) continue;
    if (t.who === 'ally' && o.team !== u.team) continue;
    if (t.who === 'enemy' && !hostile(u, o)) continue;
    if (o === u) {
      if (t.self === 'yes') return true;
      if (t.self === 'textSilent') {
        markFlag(mark, 'selfTargetWhenTextSilent'); // whether the caster counts can decide whether it's offered at all
        if (readFlag(st, 'selfTargetWhenTextSilent') === 'allowed') return true;
      }
      continue;
    }
    if (distFt(st, u.cell, o.cell) <= t.rangeFt && targetable(st, u.cell, o.cell, mark)) return true; // not behind Total Cover (srd-raw.txt:23778-23780)
  }
  return false;
}

/** Cast options, in spell-entry order: a cantrip once; a leveled spell free (if a pool has uses) then at each level it has a slot for. */
export function listCasts(cx: Ctx, u: Unit, out: LegalList): void {
  const st = cx.st;
  const spells = u.tpl.spells;
  if (spells.length === 0 || has(u, COND.incapacitated)) return;
  // W1 (P2): "you can't cast spells" (Rage, srd-raw.txt:4981). [U] A spell-derived reaction doesn't come through here; no L3-6 Barbarian has one.
  if (u.stats.length > 0 && noCasting(st, u)) return;
  for (let ei = 0; ei < spells.length; ei++) {
    const e = spells[ei]!;
    const sp = e.spell;
    if (e.whileHeld >= 0 && heldHand(u, e.whileHeld) < 0) continue;
    if (sp.cast === 'action' ? u.b.action === 0 : u.b.bonus === 0) continue;
    if (!componentsOk(st, u, e, st)) continue;
    const push = (lvl: number, free: boolean) => {
      const prog = e.prog[lvl];
      if (!prog || !anyTarget(st, u, prog, st)) return;
      const l = pushLegal(out, 'cast');
      l.opt = ei;
      l.lvl = lvl;
      l.aux = free ? 1 : 0;
    };
    if (sp.level === 0) {
      push(0, false);
      continue;
    }
    if (e.freePool >= 0 && u.res[e.freePool]! > 0) push(sp.level, true);
    if (e.slotted && u.slotTurn !== st.turnIdx) for (let lvl = sp.level; lvl <= 9; lvl++) if (u.res[lvl - 1]! > 0) push(lvl, false);
  }
}

/** Options effects grant: the owner's (move the zone, hurl the flame) and the bearer's (M3: escape). */
export function listGrants(cx: Ctx, u: Unit, out: LegalList): void {
  const st = cx.st;
  if (st.liveFx === 0 || has(u, COND.incapacitated)) return;
  for (let i = 0; i < st.fx.length; i++) {
    const fx = st.fx[i]!;
    if (!fx.alive) continue;
    const te = boundOf(st, fx);
    for (let g = 0; g < te.grants.length; g++) {
      const gr = te.grants[g]!;
      const mine = gr.to === 'owner' ? fx.owner === u.idx : fx.bearer === u.idx;
      if (!mine) continue;
      if (gr.cost === 'action' ? u.b.action === 0 : u.b.bonus === 0) continue;
      if (gr.laterTurns && fx.born >= u.turns) continue;
      if (gr.when && !gatesOk(st, u, gr.when)) continue;
      if (!anyTarget(st, u, gr.steps, st)) continue; // u acts: it's the owner, or the bearer using its grant
      const l = pushLegal(out, 'use');
      l.fx = i;
      l.opt = g;
    }
  }
}

/** Activation `aux` of feature `f` (a Legal 'use' item's aux: 0 or -1 = activate, k = more[k - 1]). */
export function activationOf(f: CompiledFeature, aux: number): CompiledActivation {
  return aux <= 0 ? f.activate! : f.more![aux - 1]!;
}

/** Pool points one use of `a` spends. */
export const poolCostOf = (a: { readonly poolCost?: number }): number => a.poolCost ?? 1;

/**
 * Feature activations, in feature order and, within one, activation order. A reaction-cost
 * activation is never a turn option (M3 step 5a: only a reaction window offers it). A pool
 * activation needs its cost in points left (POOLX).
 */
export function listFeatures(cx: Ctx, u: Unit, out: LegalList): void {
  const feats = u.tpl.features;
  if (feats.length === 0 || has(u, COND.incapacitated)) return;
  for (let fi = 0; fi < feats.length; fi++) {
    const f = feats[fi]!;
    if (!f.activate) continue;
    const n = 1 + (f.more ? f.more.length : 0);
    for (let k = 0; k < n; k++) {
      const a = k === 0 ? f.activate : f.more![k - 1]!;
      if (a.cost === 'reaction') continue;
      if (a.cost === 'action' ? u.b.action === 0 : a.cost === 'bonus' ? u.b.bonus === 0 : false) continue;
      if (a.pool >= 0 && u.res[a.pool]! < poolCostOf(a)) continue;
      if (a.perTurn && u.featTurn![fi] === cx.st.turnIdx) continue;
      if (a.when && !gatesOk(cx.st, u, a.when)) continue;
      if (!anyTarget(cx.st, u, a.steps, cx.st)) continue;
      const l = pushLegal(out, 'use'); // fx stays -1: a feature, not a grant
      l.opt = fi;
      if (f.more) l.aux = k;
    }
  }
}

/** Dismissing (no action): concentration any time (p.179), effects that end on dismissal while not Incapacitated (p.106). */
export function listEnds(cx: Ctx, u: Unit, out: LegalList): void {
  const st = cx.st;
  if (st.liveFx === 0) return;
  if (u.conc >= 0) pushLegal(out, 'end').fx = u.conc;
  if (has(u, COND.incapacitated)) return;
  for (let i = 0; i < st.fx.length; i++) {
    const fx = st.fx[i]!;
    if (fx.alive && fx.owner === u.idx && i !== u.conc && boundOf(st, fx).endsOn & END.dismiss) pushLegal(out, 'end').fx = i;
  }
}

export function resolveCast(cx: Ctx, u: Unit, l: Legal, cause: number): void {
  const st = cx.st;
  const e = u.tpl.spells[l.opt]!;
  const sp = e.spell;
  const lvl = l.lvl;
  const free = l.aux === 1;
  if (sp.cast === 'action') u.b.action--;
  else u.b.bonus--;
  let left = 0;
  let freeName: string | null = null;
  if (free) {
    u.res[e.freePool]!--;
    countRes(st.ctr, u.idx, e.freePool);
    st.ctr.freeCasts[u.idx]!++;
    left = u.res[e.freePool]!;
    freeName = u.tpl.pools[e.freePool - 9]!.name;
  } else if (lvl > 0) {
    u.res[lvl - 1]!--;
    countRes(st.ctr, u.idx, lvl - 1);
    left = u.res[lvl - 1]!;
    u.slotTurn = st.turnIdx;
  }
  componentsOk(st, u, e, st); // the hand rules decided it was castable: they count as read
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'cast', who: u.idx, via: sp.id, name: sp.name, lvl, free: freeName, left });
  if (sp.recast === 'replace') {
    for (let i = 0; i < st.fx.length; i++) {
      const f = st.fx[i]!;
      if (f.alive && f.owner === u.idx && f.sid === sp.sid && f.parent < 0) endFx(cx, i, 'replaced', seq);
    }
  }
  let root = -1;
  if (sp.conc) {
    endConcentration(cx, u, 'newConcentration', seq);
    const inst = e.instance[lvl]!;
    const fx = newFx(cx, { tpl: inst, owner: u.idx, bearer: -1, parent: -1, param: -1, srcItem: e.whileHeld, until: expiryOf(u.tpl.effects[inst]!, u, u), cause: seq });
    u.conc = fx.id;
    st.ctr.concStart[u.idx]!++;
    root = fx.id;
  }
  const fr = newFrame(u, { entry: e, lvl, root, srcItem: e.whileHeld, via: sp.id, name: sp.name, cause: seq });
  if (sp.areaShape >= 0) placeArea(cx, u, fr, sp.areaFrom, sp.rangeFt, seq, sp.id, lvl);
  runSteps(cx, fr, e.prog[lvl]!);
  if (fr.healed && !free && lvl > 0) {
    queueTrigger(cx, TRIG.slotHeal, u.idx, -1, -1, 0, seq);
    drain(cx);
  }
}

/** A grant (fx >= 0) or a feature activation (fx = -1). */
export function resolveUse(cx: Ctx, u: Unit, l: Legal, cause: number): void {
  const st = cx.st;
  if (l.fx >= 0) {
    const fx = st.fx[l.fx]!;
    const te = boundOf(st, fx);
    const g = te.grants[l.opt]!;
    if (g.cost === 'action') u.b.action--;
    else u.b.bonus--;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: te.id, name: g.name });
    // An owner's grant acts as the owner (moving its zone); a bearer's grant acts as the bearer (escaping, M3).
    const actor = g.to === 'bearer' ? u : st.units[fx.owner]!;
    const fr = newFrame(actor, { via: te.id, name: te.name, cause: seq, source: fx.id, root: fx.id, lvl: fx.lvl, srcItem: fx.srcItem, param: fx.param });
    runSteps(cx, fr, g.steps);
    return;
  }
  activate(cx, u, l.opt, l.aux, cause);
}

/** Runs activation `aux` of feature `fi` (paying its cost). Exported for a reaction window (M3 step 5a: cost reaction). */
export function activate(cx: Ctx, u: Unit, fi: number, aux: number, cause: number): void {
  const f = u.tpl.features[fi]!;
  const a = activationOf(f, aux);
  if (a.cost === 'action') u.b.action--;
  else if (a.cost === 'bonus') u.b.bonus--; // free: no action economy cost
  else if (a.cost === 'reaction') u.b.reaction = 0;
  if (a.perTurn) u.featTurn![fi] = cx.st.turnIdx;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: f.id, name: a.name });
  if (a.pool >= 0) {
    const cost = poolCostOf(a);
    u.res[a.pool]! -= cost;
    for (let k = 0; k < cost; k++) countRes(cx.st.ctr, u.idx, a.pool);
    const r = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, r, seq), k: 'res', who: u.idx, pool: u.tpl.pools[a.pool - 9]!.name, left: u.res[a.pool]!, ...(cost !== 1 ? { delta: -cost } : {}) });
  }
  let root = -1;
  if (a.root >= 0) {
    const te = u.tpl.effects[a.root]!;
    if (te.group) endGroup(cx, u, te.group, seq); // using the feature again ends the old one
    root = newFx(cx, { tpl: a.root, owner: u.idx, bearer: u.idx, parent: -1, param: -1, srcItem: -1, until: expiryOf(te, u, u), cause: seq }).id;
  }
  const fr = newFrame(u, { via: f.id, name: f.name, cause: seq, root, lastFx: root, grant: a.local, ...(a.self ? { targets: [u.idx] } : {}) });
  if (a.area) placeArea(cx, u, fr, a.area.from, a.area.rangeFt, seq, `${f.id}/${a.local}`);
  runSteps(cx, fr, a.steps);
}

export function resolveEnd(cx: Ctx, u: Unit, l: Legal, cause: number): void {
  const seq = nextSeq(cx);
  const te = boundOf(cx.st, cx.st.fx[l.fx]!);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: te.id, name: `Dismiss ${te.name}` });
  endFx(cx, l.fx, 'dismissed', seq);
}
