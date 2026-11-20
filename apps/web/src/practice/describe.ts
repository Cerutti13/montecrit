// What a choice costs and what it does, in plain words, read from the compiled content (the
// same programs the engine runs): nothing here is hand-written rules text except the four core
// actions. A summary names only what the program says; what it can't put briefly it leaves out.

import {
  ABILITIES,
  COND,
  DAMAGE_TYPES,
  HOOK,
  SHAPE,
  formatExpr,
  shapeOf,
  sizeFtOf,
  type BoundEffect,
  type CompiledActivation,
  type CompiledAttack,
  type CompiledDamage,
  type CompiledTemplate,
  type DecisionPoint,
  type Legal,
  type Step,
  type UnitView,
} from '@montecrit/engine';

export type Cost = 'Action' | 'Bonus action' | 'Reaction' | 'Free' | '';

export interface Described {
  readonly cost: Cost;
  /** The choice without its target or level ("Scimitar", "Moonbeam"). */
  readonly name: string;
  /** One line on what it does; '' when there's nothing sure to say. */
  readonly detail: string;
  /** Attacks: the chance to hit this target, 0..1; -1 otherwise. */
  readonly pHit: number;
}

const COND_NAMES: readonly [number, string][] = Object.entries(COND).map(([name, bit]) => [bit, name.charAt(0).toUpperCase() + name.slice(1)]);
const SHAPE_NAMES: Readonly<Record<number, string>> = { [SHAPE.sphere]: 'sphere', [SHAPE.cylinder]: 'cylinder', [SHAPE.cube]: 'cube', [SHAPE.cone]: 'cone', [SHAPE.line]: 'line', [SHAPE.emanation]: 'emanation' };
const ZONE_HOOKS = HOOK.appear | HOOK.movedOnto | HOOK.enter | HOOK.travel | HOOK.turnEndIn;

const condNames = (bits: number): string[] => COND_NAMES.filter(([b]) => (bits & b) !== 0).map(([, n]) => n);
const signed = (n: number): string => (n >= 0 ? `+${n}` : String(n));

export function damageText(parts: readonly CompiledDamage[]): string {
  return parts.map((d) => `${formatExpr(d.roll)}${d.type >= 0 ? ` ${DAMAGE_TYPES[d.type]}` : ''}`).join(' + ');
}

export function shapeText(key: number): string {
  if (key < 0) return '';
  const name = SHAPE_NAMES[shapeOf(key)];
  return name ? `${sizeFtOf(key)}-ft ${name}` : '';
}

function attackText(a: CompiledAttack): string {
  const range = a.kind === 'melee' ? `reach ${a.reachFt} ft` : `range ${a.normalFt}${a.longFt > a.normalFt ? `/${a.longFt}` : ''} ft`;
  return `${signed(a.toHit)} to hit, ${damageText(a.damage) || 'no damage'}, ${range}`;
}

function effectParts(tpl: CompiledTemplate, te: BoundEffect, depth: number, out: string[]): void {
  if (te.cond) out.push(condNames(te.cond).join(', '));
  for (const s of te.stats ?? []) {
    if (s.k === 'ac') out.push(`${signed(s.n)} AC`);
    else if (s.k === 'acFloor') out.push(`AC at least ${s.n}`);
    else if (s.k === 'speed') out.push(s.mode === 'zero' ? 'Speed 0' : s.mode === 'half' ? 'Speed halved' : `${signed(s.n)} ft Speed`);
    else if (s.k === 'fly') out.push(`Fly Speed ${s.n} ft`);
    else if (s.k === 'resist') out.push('Resistance to some damage');
    else if (s.k === 'noOpportunityAttacks') out.push("your movement doesn't provoke Opportunity Attacks");
  }
  for (const m of te.mods) {
    const whose = m.side === 'incoming' ? 'rolls against the target' : "some of the target's rolls";
    if (m.op === 'adv') out.push(`Advantage on ${whose}`);
    else if (m.op === 'dis') out.push(`Disadvantage on ${whose}`);
    else if (m.op === 'preDice' && m.dice) out.push(`+${formatExpr(m.dice)} to ${whose}`);
    else if (m.op === 'flat' && m.value !== 0) out.push(`${signed(m.value)} to ${whose}`);
  }
  for (const h of te.hooks) {
    const sub: string[] = [];
    stepParts(tpl, h.steps, depth + 1, sub);
    if (sub.length === 0) continue;
    const when = (h.on & ZONE_HOOKS) !== 0 ? 'creatures in the area' : (h.on & HOOK.turnStart) !== 0 ? 'at the start of its turns' : (h.on & HOOK.turnEnd) !== 0 ? 'at the end of its turns' : (h.on & HOOK.damaged) !== 0 ? 'when it takes damage' : '';
    out.push(when ? `${when}: ${sub.join(', ')}` : sub.join(', '));
  }
  for (const g of te.grants) out.push(`later lets you ${g.name} (${g.cost === 'action' ? 'Action' : 'Bonus action'})`);
}

function stepParts(tpl: CompiledTemplate, steps: readonly Step[], depth: number, out: string[]): void {
  if (depth > 6) return;
  for (const s of steps) {
    switch (s.k) {
      case 'target':
        if (s.rangeFt > 0) out.push(`${s.who === 'ally' ? 'an ally' : s.who === 'enemy' ? 'a foe' : 'a creature'} within ${s.rangeFt} ft`);
        break;
      case 'attack':
        out.push(`spell attack ${attackText(s.atk)}`);
        {
          // The attack's own damage is already in its text; keep only what a hit adds.
          const hit: string[] = [];
          stepParts(tpl, s.onHit, depth + 1, hit);
          const own = damageText(s.atk.damage);
          out.push(...hit.filter((x) => x !== own));
        }
        break;
      case 'save': {
        const dmg = s.dmg && s.dmg.length ? `${damageText(s.dmg)}${s.half ? ' (half on a success)' : ''}` : '';
        const fail: string[] = [];
        stepParts(tpl, s.onFail, depth + 1, fail);
        out.push(`${ABILITIES[s.ability]!.toUpperCase()} save DC ${s.dc}${dmg || fail.length ? ': ' : ''}${[dmg, fail.length ? `on a failure ${fail.join(', ')}` : ''].filter((x) => x).join('; ')}`);
        break;
      }
      case 'damage':
        out.push(damageText(s.dmg));
        break;
      case 'heal':
        out.push(`heals ${formatExpr(s.roll)}`);
        break;
      case 'tempHp':
        out.push(`${formatExpr(s.roll)} Temporary Hit Points`);
        break;
      case 'apply': {
        const te = tpl.effects[s.fx];
        if (!te) break;
        const zone = te.zone ? shapeText(te.zone.shapeKey) : '';
        const sub: string[] = [];
        effectParts(tpl, te, depth + 1, sub);
        if (zone) out.push(`${zone}${te.zone!.difficult ? ' of Difficult Terrain' : ''}`);
        out.push(...sub);
        break;
      }
      case 'condition':
        out.push(condNames(s.bit).join(', '));
        break;
      case 'forced':
        out.push(`${s.mode === 'pull' ? 'pulls' : 'pushes'} up to ${s.maxFt} ft`);
        break;
      case 'choose':
        out.push(`choose: ${s.opts.map((o) => o.name).join(' or ')}`);
        break;
      case 'weaponAttack':
        out.push(s.count === 1 ? 'one weapon attack' : `${s.count} weapon attacks`);
        break;
      case 'core':
        out.push(CORE[s.act]);
        break;
      case 'gainAction':
        out.push('one more action this turn');
        break;
      case 'around':
        out.push(`every ${s.who === 'ally' ? 'ally' : s.who === 'enemy' ? 'foe' : 'creature'} within ${s.sizeFt} ft`);
        break;
      case 'move':
        out.push('move up to half your Speed without provoking Opportunity Attacks');
        break;
      case 'check':
        out.push(`ability check DC ${s.dc}`);
        break;
      default:
        break;
    }
  }
}

const CORE = {
  dash: 'extra movement equal to your Speed this turn',
  disengage: "your movement doesn't provoke Opportunity Attacks this turn",
  dodge: 'attacks against you have Disadvantage and you have Advantage on DEX saves until the start of your next turn',
} as const;

const join = (parts: readonly string[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  const text = out.slice(0, 7).join(' · ');
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
};

const costOf = (c: 'action' | 'bonus' | 'free' | 'reaction'): Cost => (c === 'action' ? 'Action' : c === 'bonus' ? 'Bonus action' : c === 'reaction' ? 'Reaction' : 'Free');

function activationText(tpl: CompiledTemplate, a: CompiledActivation, left: (res: number) => number): string {
  const parts: string[] = [];
  if (a.pool >= 0) {
    const pool = tpl.pools[a.pool - 9];
    if (pool) parts.push(`uses ${a.poolCost ?? 1} ${pool.name} (${left(a.pool)} left)`);
  }
  if (a.area) parts.push(shapeText(a.area.shape));
  if (a.root >= 0 && tpl.effects[a.root]) effectParts(tpl, tpl.effects[a.root]!, 1, parts);
  stepParts(tpl, a.steps, 1, parts);
  return join(parts);
}

/** What legal item `l` of decision `dp` costs and does. */
export function describe(view: UnitView, dp: DecisionPoint, l: Legal, label: string): Described {
  const st = view.q;
  const u = st.units[dp.who]!;
  const tpl = u.tpl;
  const none = (cost: Cost, name: string, detail = ''): Described => ({ cost, name, detail, pHit: -1 });
  switch (l.k) {
    case 'attack':
    case 'oa': {
      const a = tpl.attacks[l.atk];
      if (!a) return none('', label);
      let pHit = -1;
      if (l.target >= 0) {
        try {
          pHit = view.queries.odds(u.idx, l.atk, l.target, u.cell).pSuccess;
        } catch {
          pHit = -1;
        }
      }
      const cost: Cost = l.k === 'oa' ? 'Reaction' : 'Action';
      const more = l.k === 'attack' && u.b.atkActive ? 'another strike of your Attack action' : '';
      return { cost, name: a.name, detail: join([attackText(a), more]), pHit };
    }
    case 'cast': {
      const e = tpl.spells[l.opt];
      if (!e) return none('', label);
      const sp = e.spell;
      const parts: string[] = [];
      if (sp.level === 0) parts.push('cantrip');
      else if (l.aux === 1) parts.push('free cast, no slot');
      parts.push(sp.rangeFt === 0 ? 'self' : sp.rangeFt === 5 ? 'touch' : `range ${sp.rangeFt} ft`);
      if (sp.conc) parts.push(u.conc >= 0 ? 'Concentration (ends the one you have)' : 'Concentration');
      const prog = e.prog[l.lvl];
      if (prog) stepParts(tpl, prog.filter((s) => s.k !== 'target'), 1, parts);
      return none(costOf(sp.cast), sp.name, join(parts));
    }
    case 'use': {
      if (l.fx >= 0) {
        const fx = st.fx[l.fx];
        const te = fx ? st.units[fx.owner]?.tpl.effects[fx.tpl] : undefined;
        const g = te?.grants[l.opt];
        if (!fx || !te || !g) return none('', label);
        const parts: string[] = [`from ${te.name}`];
        stepParts(st.units[fx.owner]!.tpl, g.steps, 1, parts);
        return none(costOf(g.cost), g.name, join(parts));
      }
      const f = tpl.features[l.opt];
      const a = f ? (l.aux <= 0 ? f.activate : f.more?.[l.aux - 1]) : null;
      if (!f || !a) return none('', label);
      return none(costOf(a.cost), a.name, activationText(tpl, a, (r) => u.res[r] ?? 0));
    }
    case 'option': {
      const o = tpl.options[l.opt];
      if (!o) return none('', label);
      return none(costOf(o.cost), o.name, o.core === 'core:dash' ? CORE.dash : CORE.disengage);
    }
    case 'dodge':
      return none('Action', 'Dodge', CORE.dodge);
    case 'search':
      return none('Action', 'Search', 'a Wisdom (Perception) check to find what is hidden');
    case 'stand':
      return none('', 'Stand up', 'costs half your Speed');
    case 'end': {
      const fx = st.fx[l.fx];
      const te = fx ? st.units[fx.owner]?.tpl.effects[fx.tpl] : undefined;
      return none('Free', label, te ? `stops ${te.name}` : '');
    }
    case 'pass':
      return none('', label, dp.k === 'turn' ? 'anything you have left this turn is lost' : '');
    case 'target': {
      const t = st.units[l.target];
      if (!t) return none('', label);
      return none('', label, `${t.tpl.name}, ${t.hp}/${t.hpMax} HP, ${view.queries.distFt(u.cell, t.cell)} ft away`);
    }
    case 'react': {
      const f = tpl.features[l.opt];
      return none('Reaction', f ? f.name : label);
    }
    default:
      return none('', label);
  }
}

export interface Status {
  readonly action: number;
  readonly bonus: number;
  readonly reaction: number;
  readonly moveFt: number;
  readonly hp: number;
  readonly hpMax: number;
  readonly tempHp: number;
  /** Spell slots it has any of: level, left, max. */
  readonly slots: readonly { readonly lvl: number; readonly left: number; readonly max: number }[];
  readonly pools: readonly { readonly name: string; readonly left: number; readonly max: number }[];
  /** The effect it's concentrating on, or ''. */
  readonly conc: string;
}

/** What the player's character has left right now. */
export function statusOf(view: UnitView, who: number): Status {
  const st = view.q;
  const u = st.units[who]!;
  const slots: { lvl: number; left: number; max: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const max = u.tpl.resMax[i] ?? 0;
    if (max > 0) slots.push({ lvl: i + 1, left: u.res[i] ?? 0, max });
  }
  const pools = u.tpl.pools.map((p, i) => ({ name: p.name, left: u.res[9 + i] ?? 0, max: u.tpl.resMax[9 + i] ?? 0 })).filter((p) => p.max > 0);
  const cfx = u.conc >= 0 ? st.fx[u.conc] : undefined;
  const cte = cfx ? st.units[cfx.owner]?.tpl.effects[cfx.tpl] : undefined;
  return { action: u.b.action, bonus: u.b.bonus, reaction: u.b.reaction, moveFt: u.b.moveFt, hp: u.hp, hpMax: u.hpMax, tempHp: u.tempHp, slots, pools, conc: cte ? cte.name : '' };
}
