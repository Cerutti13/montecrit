// Play policies (docs/design/m1c.md 2): compile a policy document, bind it to a fight's seats,
// and play it. A scripted rule fires at the first turn decision where its condition holds and
// its directive is legal (so before any move, when it's legal where the creature stands): it
// takes that option (a cast at its level, a feature, a core option; for an attack, the base
// decider picks the target among that weapon's attacks) and lets the base decider choose
// everything else (targets, anchors, where to stand afterwards, the rest of the turn), except a
// `pick` it names. A rule that can't fire is retried on the creature's next own turns, each one
// live for the whole turn, then retired; taken/retried/retired counts per rule are kept per
// fight so a report can show a script that never ran. `hold` keeps the greedy AI from ever
// replacing that concentration (greedy bases only: a policy with another base can't hold).
//
// Identity: a compiled policy's hash covers its rules and the effective weights; a decider
// playing it is named `<id>@<8 hex>`, and that name goes into the replay key.

import { SKILLS } from '../content/rollkeys.ts';
import { PolicySchema, type PolicySource } from '../content/schema.ts';
import type { CompiledTemplate, Step } from '../content/types.ts';
import type { FightSetup } from '../sim/setup.ts';
import type { QueryState, Unit } from '../sim/state.ts';
import { canonicalJson } from '../util/canon.ts';
import { hash64 } from '../util/hash.ts';
import { BaselineDecider } from './baseline.ts';
import type { Decider, DecisionPoint, Legal, UnitView } from './decider.ts';
import { GreedyDecider } from './greedy/greedy.ts';
import { DEFAULT_WEIGHTS, type Weights } from './greedy/weights.ts';
import { RandomLegalDecider } from './random-legal.ts';

export type Directive = PolicySource['script'][number]['do'];

export interface CompiledRule {
  readonly id: string;
  readonly when: { readonly myTurn?: number; readonly round?: number; readonly concentrating?: boolean };
  readonly do: Directive;
  readonly pick: string | null;
  readonly retry: number;
}

export interface CompiledPolicy {
  readonly id: string;
  readonly name: string;
  readonly seats: 'pcs' | 'party' | readonly string[];
  readonly base: 'greedy' | 'baseline' | 'random-legal';
  readonly weights: Weights;
  readonly script: readonly CompiledRule[];
  readonly hold: readonly string[];
  /** Riders always taken when offered (M3 step 5a), with the option for a choose rider. */
  readonly riders: readonly { readonly rider: string; readonly pick?: string }[];
  /** 8 hex characters over the compiled rules and effective weights. */
  readonly hash: string;
}

/** The weights a policy may override (the schema lists the same keys and rejects any other). */
const NUMERIC_WEIGHTS = ['horizon', 'gamma', 'perFoot', 'throwAway', 'approach', 'retreatMin', 'slotPerLevel', 'freeCast', 'poolUse', 'reactMin'] as const;

/** Compiles a parsed policy document; errors name the field. */
export function compilePolicy(doc: unknown): { policy: CompiledPolicy | null; errors: string[] } {
  const r = PolicySchema.safeParse(doc);
  if (!r.success) return { policy: null, errors: r.error.issues.map((i) => `${i.path.join('.') || 'policy'}: ${i.message}`) };
  const src = r.data;
  const errors: string[] = [];
  const weights: Record<string, unknown> = { ...DEFAULT_WEIGHTS };
  for (const k of NUMERIC_WEIGHTS) if (src.weights[k] !== undefined) weights[k] = src.weights[k];
  if (src.weights.targetStyle !== undefined) weights.targetStyle = src.weights.targetStyle; // coverage 8'b G5
  const ids = src.script.map((x) => x.id);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) errors.push(`script: two rules named "${id}"`);
  });
  // Only the greedy AI knows how to hold a concentration; another base would silently ignore it.
  if (src.hold.length > 0 && src.base !== 'greedy') errors.push(`hold: only a greedy base can hold a concentration (base is ${src.base})`);
  if (errors.length) return { policy: null, errors };
  const rids = src.riders.map((x) => x.rider);
  rids.forEach((id, i) => {
    if (rids.indexOf(id) !== i) errors.push(`riders: rider "${id}" listed twice`);
  });
  if (errors.length) return { policy: null, errors };
  // riders enters the hash only when given, so every earlier policy keeps its hash and name.
  const body = { id: src.id, seats: src.seats, base: src.base, weights, script: src.script, hold: src.hold.map((h) => h.concentration), ...(src.riders.length > 0 ? { riders: src.riders } : {}) };
  const policy: CompiledPolicy = {
    id: src.id,
    name: src.name,
    seats: src.seats,
    base: src.base,
    weights: weights as unknown as Weights,
    script: src.script,
    hold: body.hold,
    riders: src.riders,
    hash: hash64(canonicalJson(body)).slice(0, 8),
  };
  return { policy, errors: [] };
}

/** The built-in policies: the plain deciders, and greedy that spends resources freely (a sensitivity arm, design 1.4). */
export const BUILTIN_POLICIES: readonly CompiledPolicy[] = [
  { id: 'greedy', name: 'Greedy', seats: 'pcs', base: 'greedy', weights: {} },
  { id: 'greedy-spendy', name: 'Greedy, resources nearly free', seats: 'pcs', base: 'greedy', weights: { slotPerLevel: 0.01, freeCast: 0.01, poolUse: 0.01 } },
  { id: 'baseline', name: 'Baseline', seats: 'pcs', base: 'baseline', weights: {} },
  { id: 'random-legal', name: 'Random legal', seats: 'pcs', base: 'random-legal', weights: {} },
].map((p) => {
  const c = compilePolicy({ kind: 'policy', ...p });
  if (!c.policy) throw new Error(`built-in policy ${p.id}: ${c.errors.join('; ')}`);
  return c.policy;
});

/** Does the policy play this seat? */
export function playsSeat(policy: CompiledPolicy, setup: FightSetup, seat: number): boolean {
  const s = setup.seats[seat]!;
  if (policy.seats === 'pcs') return s.tpl.kind === 'pc';
  if (policy.seats === 'party') return s.team === 0;
  return policy.seats.includes(s.seat);
}

function describe(d: Directive): string {
  return 'cast' in d ? `spell ${d.cast}` : 'use' in d ? `feature ${d.use}` : 'attack' in d ? `attack ${d.attack}` : `option ${d.option}`;
}

function directiveIn(t: CompiledTemplate, d: Directive): boolean {
  if ('cast' in d) return t.spells.some((e) => e.spell.id === d.cast);
  if ('use' in d) return t.features.some((f) => f.id === d.use && f.activate !== null);
  if ('attack' in d) return t.attacks.some((a) => a.local === d.attack);
  return t.options.some((o) => o.id === d.option);
}

/**
 * The pick names a rule's `pick` can answer: the options of the first choice the directive's
 * program asks (a `choose` or a skill choice, possibly inside an attack's or save's branches),
 * at any level. A pick answers only that first choice, so a choice nested inside an option
 * isn't one it can name.
 */
function pickNames(t: CompiledTemplate, d: Directive): string[] {
  const out: string[] = [];
  const walk = (steps: readonly Step[]): void => {
    for (const s of steps) {
      if (s.k === 'choose') {
        for (const o of s.opts) if (!out.includes(o.local)) out.push(o.local);
      } else if (s.k === 'chooseSkill') {
        for (const [name] of SKILLS) if (!out.includes(name)) out.push(name);
      } else if (s.k === 'attack') {
        walk(s.onHit);
        walk(s.onMiss);
      } else if (s.k === 'save') {
        walk(s.onFail);
        walk(s.onSuccess);
      }
    }
  };
  if ('cast' in d) for (const e of t.spells) if (e.spell.id === d.cast) for (const p of e.prog) if (p) walk(p);
  if ('use' in d) for (const f of t.features) if (f.id === d.use && f.activate) walk(f.activate.steps);
  return out;
}

/** Checks a policy against a fight: it plays at least one seat, and every seat it plays has every directive, pick and held spell. */
export function bindPolicy(policy: CompiledPolicy, setup: FightSetup): string[] {
  const errors: string[] = [];
  const seats = setup.seats.map((_, i) => i).filter((i) => playsSeat(policy, setup, i));
  if (seats.length === 0) errors.push(`policy ${policy.id}: plays no seat of ${setup.scenario} (seats: ${JSON.stringify(policy.seats)})`);
  if (Array.isArray(policy.seats)) for (const s of policy.seats) if (!setup.seats.some((x) => x.seat === s)) errors.push(`policy ${policy.id}: no seat "${s}" in ${setup.scenario}`);
  for (const i of seats) {
    const t = setup.seats[i]!.tpl;
    for (const r of policy.script) {
      if (!directiveIn(t, r.do)) {
        errors.push(`policy ${policy.id}: rule ${r.id}: ${setup.seats[i]!.seat} (${t.id}) has no ${describe(r.do)}`);
        continue;
      }
      if (r.pick === null) continue;
      // A pick nothing asks for would silently fall back to the base decider's choice.
      const names = pickNames(t, r.do);
      if (names.length === 0) errors.push(`policy ${policy.id}: rule ${r.id}: pick "${r.pick}", but ${describe(r.do)} offers no choice`);
      else if (!names.includes(r.pick)) errors.push(`policy ${policy.id}: rule ${r.id}: pick "${r.pick}" isn't one of ${describe(r.do)}'s choices (${names.join(', ')})`);
    }
    for (const rr of policy.riders) {
      const r = (t.riders ?? []).find((x) => x.local === rr.rider);
      if (!r) errors.push(`policy ${policy.id}: riders: ${setup.seats[i]!.seat} (${t.id}) has no rider ${rr.rider}`);
      else if (rr.pick !== undefined && !r.opts.some((o) => r.chooses && o.local === rr.pick)) errors.push(`policy ${policy.id}: riders: pick "${rr.pick}" isn't one of rider ${rr.rider}'s options (${r.chooses ? r.opts.map((o) => o.local).join(', ') : 'it has no choice'})`);
    }
    for (const h of policy.hold) if (!t.spells.some((e) => e.spell.id === h)) errors.push(`policy ${policy.id}: hold: ${setup.seats[i]!.seat} (${t.id}) has no spell ${h}`);
  }
  return errors;
}

export interface RuleStats {
  readonly rule: string;
  taken: number;
  retried: number;
  retired: number;
}

/** The base decider a policy names, with its weights and holds. */
export function baseDecider(policy: CompiledPolicy): Decider {
  if (policy.base === 'baseline') return new BaselineDecider();
  if (policy.base === 'random-legal') return new RandomLegalDecider();
  const g = new GreedyDecider(policy.weights, policy.id === 'greedy' ? 'greedy' : `${policy.id}@${policy.hash}`);
  g.hold = policy.hold;
  return g;
}

/** Plays a policy with scripted rules on top of its base decider. */
export class ScriptedDecider implements Decider {
  readonly name: string;
  readonly policy: CompiledPolicy;
  readonly base: Decider;
  private state: QueryState | null = null;
  private retired: boolean[] = [];
  private tried: number[] = [];
  private tries: number[] = [];
  /** The own turn a rule's tries ran out on: live through that turn, retired after it (Infinity: tries left). */
  private lastTurn: number[] = [];
  /** A pick the last fired rule names, for the program it started. */
  private pendingPick: { via: string; pick: string } | null = null;
  /** Per fight. */
  readonly stats: RuleStats[];

  constructor(policy: CompiledPolicy) {
    this.policy = policy;
    this.base = baseDecider(policy);
    this.name = `${policy.id}@${policy.hash}`;
    this.stats = policy.script.map((r) => ({ rule: r.id, taken: 0, retried: 0, retired: 0 }));
  }

  explainTo(sink: ((r: unknown) => void) | null): void {
    this.base.explainTo?.(sink);
  }

  private reset(st: QueryState): void {
    this.state = st;
    const n = this.policy.script.length;
    this.retired = new Array<boolean>(n).fill(false);
    this.tried = new Array<number>(n).fill(-1);
    this.tries = new Array<number>(n).fill(0);
    this.lastTurn = new Array<number>(n).fill(Infinity);
    this.pendingPick = null;
    for (const s of this.stats) s.taken = s.retried = s.retired = 0;
  }

  decide(view: UnitView, dp: DecisionPoint): number {
    if (view.q !== this.state) this.reset(view.q);
    if (dp.k === 'turn') {
      const i = this.fire(view, dp);
      if (i >= 0) return i;
    } else if (dp.k === 'rider' && this.policy.riders.length > 0) {
      const i = this.takeRider(view, dp);
      if (i >= 0) return i;
    } else if (dp.k === 'pick' && this.pendingPick && dp.src?.via === this.pendingPick.via) {
      const want = `pick:${this.pendingPick.pick}`;
      this.pendingPick = null;
      for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i) === want) return i;
    }
    // Everything else (W1's firstAttack and moveTo included) is the base decider's, which declines those by default (pass is item 0).
    return this.base.decide(view, dp);
  }

  /** A listed rider's item in a rider decision (its named option, or the base decider's pick among its options), or -1. */
  private takeRider(view: UnitView, dp: DecisionPoint): number {
    for (const rr of this.policy.riders) {
      const exact = rr.pick !== undefined ? `rider:${rr.rider}/${rr.pick}` : `rider:${rr.rider}`;
      const idx: number[] = [];
      for (let i = 0; i < dp.legal.n; i++) {
        const k = dp.keyOf(i);
        if (k === exact || (rr.pick === undefined && k.startsWith(`${exact}/`))) idx.push(i);
      }
      if (idx.length === 1) return idx[0]!;
      if (idx.length > 1) {
        const sub: DecisionPoint = { ...dp, legal: { n: idx.length, items: idx.map((i) => dp.legal.items[i]!) }, keyOf: (j) => dp.keyOf(idx[j]!), indexOfKey: undefined };
        const j = this.base.decide(view, sub);
        return idx[j >= 0 && j < idx.length ? j : 0]!;
      }
    }
    return -1;
  }

  /** From its Nth own turn (or round N) on, so a rule that can't fire yet keeps its retries. */
  private holds(me: Unit, st: QueryState, w: CompiledRule['when']): boolean {
    if (w.myTurn !== undefined && me.turns < w.myTurn) return false;
    if (w.round !== undefined && st.round < w.round) return false;
    if (w.concentrating !== undefined && w.concentrating !== me.conc >= 0) return false;
    return true;
  }

  /** The first live rule whose condition holds: its directive's index, or -1 (and the retry count moves on). */
  private fire(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    for (let r = 0; r < this.policy.script.length; r++) {
      if (this.retired[r]) continue;
      if (me.turns > this.lastTurn[r]!) {
        this.retired[r] = true; // its last allowed turn is over (counted as retired then)
        continue;
      }
      const rule = this.policy.script[r]!;
      if (!this.holds(me, st, rule.when)) continue;
      const i = this.find(view, me, dp, rule.do);
      if (i >= 0) {
        if (this.lastTurn[r] !== Infinity) this.stats[r]!.retired--; // it fired on its last allowed turn after all
        this.retired[r] = true;
        this.stats[r]!.taken++;
        const l = dp.legal.items[i]!;
        const via = l.k === 'cast' ? me.tpl.spells[l.opt]!.spell.id : l.k === 'use' && l.fx < 0 ? me.tpl.features[l.opt]!.id : '';
        this.pendingPick = rule.pick && via ? { via, pick: rule.pick } : null;
        return i;
      }
      if (this.tried[r] !== me.turns) {
        // Not legal at this turn's first look: one more try used. Out of tries, this turn is its
        // last: it stays live until the turn ends (it may become legal after a move), then retires.
        this.tried[r] = me.turns;
        this.tries[r]!++;
        if (this.tries[r]! > 1) this.stats[r]!.retried++;
        if (this.tries[r]! > rule.retry) {
          this.lastTurn[r] = me.turns;
          this.stats[r]!.retired++;
        }
      }
      return -1; // the first live rule whose condition holds decides whether anything fires
    }
    return -1;
  }

  /**
   * The legal item a directive names: a cast at the lowest (or given) level, preferring a free
   * cast at the same level; for an attack, the base decider's choice among that weapon's attacks
   * (each target is its own item, so the base picks the target).
   */
  private find(view: UnitView, me: Unit, dp: DecisionPoint, d: Directive): number {
    if ('attack' in d) {
      const idx: number[] = [];
      // attackDowned holds for scripts too: a downed target only when the knob allows it.
      const st = view.q;
      const k = st.setup.knobs.attackDowned;
      let upTarget = false;
      for (let i = 0; i < dp.legal.n; i++) {
        const l = dp.legal.items[i]!;
        if (l.k === 'attack' && st.units[l.target]!.life === 'up') upTarget = true;
      }
      for (let i = 0; i < dp.legal.n; i++) {
        const l = dp.legal.items[i]!;
        if (l.k !== 'attack' || me.tpl.attacks[l.atk]!.local !== d.attack) continue;
        const life = st.units[l.target]!.life;
        if (life === 'dead' || (life !== 'up' && !(k === 'always' || (k === 'ifNoOtherTarget' && !upTarget)))) continue;
        idx.push(i);
      }
      if (idx.length <= 1) return idx.length === 1 ? idx[0]! : -1;
      const sub: DecisionPoint = { ...dp, legal: { n: idx.length, items: idx.map((i) => dp.legal.items[i]!) }, keyOf: (j) => dp.keyOf(idx[j]!), indexOfKey: undefined };
      const j = this.base.decide(view, sub);
      return idx[j >= 0 && j < idx.length ? j : 0]!;
    }
    let best = -1;
    let bestLvl = Infinity;
    for (let i = 0; i < dp.legal.n; i++) {
      const l: Legal = dp.legal.items[i]!;
      if ('cast' in d) {
        if (l.k !== 'cast' || me.tpl.spells[l.opt]!.spell.id !== d.cast) continue;
        if (d.level !== 'lowest' && l.lvl !== d.level) continue;
        const rank = l.lvl * 2 + (l.aux === 1 ? 0 : 1);
        if (rank < bestLvl) [bestLvl, best] = [rank, i];
      } else if ('use' in d) {
        if (l.k === 'use' && l.fx < 0 && me.tpl.features[l.opt]!.id === d.use) return i;
      } else if (l.k === 'option' && me.tpl.options[l.opt]!.id === d.option) return i;
    }
    return best;
  }
}

/** A decider for a policy: its scripted decider, or just its base when it has no script. */
export function policyDecider(policy: CompiledPolicy): Decider {
  return policy.script.length > 0 || policy.riders.length > 0 ? new ScriptedDecider(policy) : baseDecider(policy);
}
