// W1 (docs/design/w1-plan.md) greedy helpers that read only a template or a unit: the rider damage
// part typed as the attack (P4), the drop-to-1 pool (P8), and which W1 terms a template can need at
// all, so a VCtx for any other template carries none of their closures (perf; C3: inert).

import type { CompiledAttack, CompiledDamage, CompiledRider, CompiledTemplate, Step } from '../../content/types.ts';
import { unarmedTypeFor } from '../../sim/stats.ts';
import type { QueryState, Unit } from '../../sim/state.ts';

/** Per extra-parts array (content is immutable): the copy with its asAttack parts typed, by damage type index. */
const TYPED = new WeakMap<readonly CompiledDamage[], (readonly CompiledDamage[] | undefined)[]>();
const NO_TYPED = new WeakMap<readonly CompiledDamage[], readonly CompiledDamage[]>();

/**
 * P4: `parts` (a rider's extra damage) with each asAttack part given the type of `atk`'s first part,
 * after unarmedTypeFor for an Unarmed Strike (sim/attack.ts unarmedParts: a damageType stat may swap
 * it; Frenzy's "the same type as the weapon or Unarmed Strike used", srd-raw.txt:5177-5178; Sneak
 * Attack's "the same as the weapon's type", 13739). The same array when no part is asAttack, so
 * every existing rider reads exactly as before; one shared copy per (array, type), so a PMF cache
 * keyed by the array stays warm. With no attack to read a type from, the asAttack parts are left
 * out (worth nothing) rather than typed -1.
 */
export function typedExtra(st: QueryState, me: Unit, t: Unit, atk: CompiledAttack | null, parts: readonly CompiledDamage[]): readonly CompiledDamage[] {
  let any = false;
  for (const p of parts) if (p.asAttack) any = true;
  if (!any) return parts;
  const first = atk?.damage[0];
  if (!first) {
    let out = NO_TYPED.get(parts);
    if (!out) NO_TYPED.set(parts, (out = parts.filter((p) => !p.asAttack)));
    return out;
  }
  const type = atk!.unarmed ? unarmedTypeFor(st, me, t, first.type, { resist: 0, vuln: 0, immune: 0 }) : first.type;
  let byType = TYPED.get(parts);
  if (!byType) TYPED.set(parts, (byType = []));
  let out = byType[type];
  if (!out) byType[type] = out = parts.map((p) => (p.asAttack ? { ...p, type } : p));
  return out;
}

/** P4: the attack a rider's damage reads its type from when no attack is known (valuing the effect that switches it on): my best-to-hit attack that carries rider `ri` on a hit, else my first. */
export function riderAttack(tpl: CompiledTemplate, ri: number): CompiledAttack | null {
  let best: CompiledAttack | null = null;
  for (const a of tpl.attacks) if (a.onHit?.includes(ri) && (!best || a.toHit > best.toHit)) best = a;
  return best ?? tpl.attacks[0] ?? null;
}

/** P10: a rider option whose every step acts on the attacker only (a free move, a self apply): it still runs after the target dies (sim/riders.ts runRiders). */
export function selfOnlyOption(o: CompiledRider['opts'][number]): boolean {
  if (o.steps.length === 0) return false;
  for (const s of o.steps) if (!(s.k === 'move' || s.k === 'endConditions' || (s.k === 'apply' && s.to === 'self'))) return false;
  return true;
}

const DROP_POOL = new WeakMap<CompiledTemplate, number>();

/**
 * P8: `u` has a live drop-to-1 pool (Relentless Endurance, srd-raw.txt:19928-19931): its own next drop
 * to 0 doesn't happen (it drops to 1 instead; massive damage aside, which the drop-risk terms don't
 * model). False for every template without a dropToOne feature.
 */
export function dropSafe(u: Unit): boolean {
  // Perf: the end-cost terms ask this for the same template over and over; one entry answers without a lookup.
  if (u.tpl === lastTpl) return lastPool >= 0 && u.res[lastPool]! > 0;
  let p = DROP_POOL.get(u.tpl);
  lastTpl = u.tpl;
  if (p === undefined) {
    p = -1;
    for (const f of u.tpl.features) if (f.dropToOne) p = f.dropToOne.pool;
    DROP_POOL.set(u.tpl, p);
  }
  lastPool = p;
  return p >= 0 && u.res[p]! > 0;
}
let lastTpl: CompiledTemplate | null = null;
let lastPool = -1;

const KIT = new WeakMap<CompiledTemplate, boolean>();

function stepsHaveW1(steps: readonly Step[]): boolean {
  for (const s of steps) {
    if (s.k === 'move' || s.k === 'endConditions' || s.k === 'extendSource') return true;
    if (s.k === 'apply' && s.when) return true;
    if (s.k === 'attack' && (stepsHaveW1(s.onHit) || stepsHaveW1(s.onMiss))) return true;
    if (s.k === 'save' && (stepsHaveW1(s.onFail) || stepsHaveW1(s.onSuccess))) return true;
    if (s.k === 'check' && (stepsHaveW1(s.onSuccess) || stepsHaveW1(s.onFail))) return true;
    if (s.k === 'choose' && s.opts.some((o) => stepsHaveW1(o.steps))) return true;
  }
  return false;
}

/**
 * Does `tpl` carry any W1 field a greedy term reads (a sustained effect, noCasting/noConcentration,
 * a self consumed Advantage, a firstAttack or dropToOne feature, a move/endConditions/extendSource
 * step, a gated apply)? Only then does its VCtx get the W1 closures; every other template's VCtx is
 * built as before.
 */
export function w1Kit(tpl: CompiledTemplate): boolean {
  let k = KIT.get(tpl);
  if (k !== undefined) return k;
  k = false;
  for (const e of tpl.effects) {
    if (e.sustain !== undefined) k = true;
    for (const s of e.stats ?? []) if (s.k === 'noCasting' || s.k === 'noConcentration') k = true;
    for (const m of e.mods) if (m.consume && m.op === 'adv' && m.side === 'self') k = true;
    for (const h of e.hooks) if (stepsHaveW1(h.steps)) k = true;
    for (const g of e.grants) if (stepsHaveW1(g.steps)) k = true;
  }
  for (const f of tpl.features) {
    if (f.firstAttack || f.dropToOne) k = true;
    for (const a of f.activate ? [f.activate, ...(f.more ?? [])] : []) if (stepsHaveW1(a.steps)) k = true;
  }
  for (const r of tpl.riders ?? []) for (const o of r.opts) if (stepsHaveW1(o.steps)) k = true;
  KIT.set(tpl, k);
  return k;
}
