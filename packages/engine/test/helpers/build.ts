// Synthetic templates and setups for simulator tests, built in code so these tests don't
// depend on the YAML loader. Everything here uses test: ids; nothing names real content.

import { diceOnly, parseExpr } from '../../src/dice/expr.ts';
import { DAMAGE_TYPES, SIZES, type AttackGroup, type BoundEffect, type CompiledAttack, type CompiledDamage, type CompiledFeature, type CompiledOption, type CompiledSpell, type CompiledTemplate, type Id, type ItemDef, type SpellEntry, type Step } from '../../src/content/types.ts';
import { parseCell, parseTerrain } from '../../src/grid/cells.ts';
import { DEFAULT_FLAGS, type RuleFlags } from '../../src/rules/flags.ts';
import { DEFAULT_KNOBS, type DeciderName, type FightSetup, type Knobs, type SeatSetup } from '../../src/sim/setup.ts';
import { fnv1a32 } from '../../src/util/hash.ts';

export interface AtkSpec {
  local: string;
  kind?: 'melee' | 'ranged';
  toHit: number;
  reach?: number;
  range?: [number, number];
  damage: ([string, string] | [string, string, 'adv'])[]; // [roll, type] or [roll, type, 'adv']
  gear?: number;
  consumesGear?: boolean;
}

export function attack(owner: string, a: AtkSpec): CompiledAttack {
  const kind = a.kind ?? 'melee';
  return {
    id: `test:${owner}/${a.local}` as Id,
    local: a.local,
    name: a.local,
    kind,
    rollKey: kind === 'melee' ? 'd20.attack.melee' : 'd20.attack.ranged',
    toHit: a.toHit,
    critMin: 20,
    reachFt: kind === 'melee' ? (a.reach ?? 5) : 0,
    normalFt: kind === 'ranged' ? a.range![0] : 0,
    longFt: kind === 'ranged' ? a.range![1] : 0,
    damage: (a.damage as [string, string, string?][]).map(([roll, type, adv]) => {
      const node = parseExpr(roll);
      return { roll: node, critExtra: diceOnly(node), type: DAMAGE_TYPES.indexOf(type as never), avg: 0, ifAdvantage: adv === 'adv' };
    }),
    gear: a.gear ?? -1,
    consumesGear: a.consumesGear ?? false,
    unarmed: false,
    spell: false,
  };
}

export function unarmed(owner: string, strMod: number, pb: number): CompiledAttack {
  return {
    id: 'core:unarmed-strike', local: 'unarmed-strike', name: 'Unarmed Strike', kind: 'melee', rollKey: 'd20.attack.melee',
    toHit: strMod + pb, critMin: 20, reachFt: 5, normalFt: 0, longFt: 0,
    damage: [{ roll: { k: 'const', v: Math.max(0, 1 + strMod) }, critExtra: null, type: DAMAGE_TYPES.indexOf('bludgeoning'), avg: Math.max(0, 1 + strMod), ifAdvantage: false }],
    gear: -1, consumesGear: false, unarmed: true, spell: false,
  };
}

const CORE_OPTIONS: CompiledOption[] = [
  { id: 'core:dash', local: 'dash', name: 'Dash', cost: 'action', core: 'core:dash' },
  { id: 'core:disengage', local: 'disengage', name: 'Disengage', cost: 'action', core: 'core:disengage' },
];

export interface TplSpec {
  id: string;
  kind?: 'monster' | 'pc';
  size?: (typeof SIZES)[number];
  ac?: number;
  hp?: number;
  hpFormula?: string;
  speed?: number;
  str?: number;
  dex?: number;
  initMod?: number;
  attacks: AtkSpec[];
  /** Multiattack alternatives by attack local id; omitted = one attack (PC: 1 + extraAttacks). */
  multi?: [number, string[]][][];
  /**
   * Step E (E1) opt-in: with `multi`, append the plain Attack action as compileMonster now does: one
   * strike with any attack (the Unarmed Strike included), as the last alternative.
   */
  plainAttack?: true;
  extraAttacks?: number;
  bonusDisengage?: boolean;
  gear?: { name: string; count: number }[];
  resist?: string[];
  vuln?: string[];
  immune?: string[];
}

const mod = (score: number) => Math.floor((score - 10) / 2);
const mask = (types: string[] | undefined) => (types ?? []).reduce((m, t) => m | (1 << DAMAGE_TYPES.indexOf(t as never)), 0);

export function template(t: TplSpec): CompiledTemplate {
  const kind = t.kind ?? 'monster';
  const str = t.str ?? 10;
  const pb = 2;
  const attacks = t.attacks.map((a) => attack(t.id, a));
  attacks.push(unarmed(t.id, mod(str), pb));
  const authored = t.attacks.length;
  const all = attacks.map((_, i) => i);
  let alts: AttackGroup[][];
  if (t.multi) {
    alts = t.multi.map((alt) => alt.map(([count, locals]) => ({ count, from: locals.map((l) => attacks.findIndex((a) => a.local === l)) })));
    if (t.plainAttack) alts.push([{ count: 1, from: all }]);
  } else if (kind === 'pc') {
    alts = [[{ count: 1 + (t.extraAttacks ?? 0), from: all }]];
  } else {
    alts = [[{ count: 1, from: all }]];
  }
  void authored;
  const options = [...CORE_OPTIONS];
  if (t.bonusDisengage) options.push({ id: `test:${t.id}/nimble` as Id, local: 'nimble', name: 'Nimble (Disengage)', cost: 'bonus', core: 'core:disengage' });
  const initMod = t.initMod ?? mod(t.dex ?? 10);
  return {
    id: `test:${t.id}` as Id,
    kind,
    name: t.id,
    source: 'synthetic test fixture',
    size: SIZES.indexOf(t.size ?? 'medium'),
    ac: t.ac ?? 12,
    hpMax: t.hp ?? 10,
    hpFormula: t.hpFormula ? parseExpr(t.hpFormula) : null,
    speedFt: t.speed ?? 30,
    scores: [str, t.dex ?? 10, 10, 10, 10, 10],
    saveMod: [mod(str), mod(t.dex ?? 10), 0, 0, 0, 0],
    initMod,
    initScore: 10 + initMod,
    pb,
    attacks,
    attackAct: { name: t.multi ? 'Multiattack' : 'Attack', multi: !!t.multi, extraAttack: (t.extraAttacks ?? 0) > 0, alts },
    options,
    gear: t.gear ?? [],
    oaReachFt: Math.max(5, ...attacks.filter((a) => a.kind === 'melee').map((a) => a.reachFt)),
    resist: mask(t.resist),
    vuln: mask(t.vuln),
    immune: mask(t.immune),
    placeholder: false,
    fidelity: 'full',
    unimplemented: [],
    items: [],
    startHands: [-1, -1],
    resMax: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    effects: [],
    spells: [],
    features: [],
    pools: [],
    skillMod: new Array<number>(18).fill(0),
    flags: {},
  };
}

export interface UnitSpec {
  seat: string;
  team: 0 | 1;
  tpl: CompiledTemplate;
  at: string;
  hp?: number;
  prone?: boolean;
  surprised?: boolean;
  atZero?: 'dies' | 'deathSaves';
  decider?: DeciderName;
  fallback?: Exclude<DeciderName, 'journal'>;
}

export function setup(opts: { w: number; h: number; terrain?: string[]; units: UnitSpec[]; flags?: Partial<RuleFlags>; knobs?: Partial<Knobs>; name?: string }): FightSetup {
  const seats: SeatSetup[] = opts.units
    .map((u) => ({
      seat: u.seat,
      seatKey: fnv1a32(u.seat),
      team: u.team,
      tpl: u.tpl,
      cell: parseCell(u.at, opts.w, opts.h),
      hp: u.hp ?? null,
      prone: u.prone ?? false,
      surprised: u.surprised ?? false,
      atZero: u.atZero ?? null,
      decider: u.decider ?? 'baseline',
      fallback: u.fallback ?? null,
    }))
    .sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
  return {
    scenario: opts.name ?? 'test-scenario',
    scenarioHash: 'test',
    contentHash: 'test',
    flags: { ...DEFAULT_FLAGS, ...opts.flags },
    knobs: { ...DEFAULT_KNOBS, ...opts.knobs },
    w: opts.w,
    h: opts.h,
    terrain: parseTerrain(opts.terrain, opts.w, opts.h),
    seats,
  };
}

// A few stock fixtures.
export const SKIRMISHER = template({
  id: 'skirmisher', size: 'small', ac: 15, hp: 10, dex: 15, str: 8,
  attacks: [
    { local: 'blade', toHit: 4, damage: [['1d6+2', 'slashing'], ['1d4', 'slashing', 'adv']] },
    { local: 'bow', kind: 'ranged', toHit: 4, range: [80, 320], damage: [['1d6+2', 'piercing'], ['1d4', 'piercing', 'adv']] },
  ],
  bonusDisengage: true,
});
export const SENTRY = template({
  id: 'sentry', ac: 16, hp: 11, str: 13, dex: 12,
  attacks: [
    { local: 'spear', toHit: 3, damage: [['1d6+1', 'piercing']], gear: 0 },
    { local: 'spear-thrown', kind: 'ranged', toHit: 3, range: [20, 60], damage: [['1d6+1', 'piercing']], gear: 0, consumesGear: true },
  ],
  gear: [{ name: 'Spear', count: 1 }],
});
export const FIGHTER = template({
  id: 'fighter', kind: 'pc', ac: 18, hp: 44, str: 16, dex: 12, extraAttacks: 1,
  attacks: [{ local: 'longsword', toHit: 6, damage: [['1d8+3', 'slashing']] }],
});
export const DUMMY = template({ id: 'dummy', ac: 10, hp: 500, speed: 0, attacks: [{ local: 'poke', toHit: 0, damage: [['1', 'bludgeoning']] }] });
export const REACHER = template({ id: 'reacher', ac: 14, hp: 30, str: 16, attacks: [{ local: 'glaive', toHit: 5, reach: 10, damage: [['1d10+3', 'slashing']] }] });
export const ARCHER = template({ id: 'archer', ac: 13, hp: 12, dex: 16, attacks: [{ local: 'longbow', kind: 'ranged', toHit: 5, range: [150, 600], damage: [['1d8+3', 'piercing']] }] });
export const MULTI = template({
  id: 'multi', ac: 13, hp: 40, str: 16,
  attacks: [
    { local: 'claw', toHit: 5, damage: [['1d6+3', 'slashing']] },
    { local: 'bite', toHit: 5, damage: [['1d8+3', 'piercing']] },
    { local: 'tail', toHit: 5, reach: 10, damage: [['1d4+3', 'bludgeoning']] },
  ],
  multi: [[[2, ['claw', 'bite']]], [[1, ['bite']], [1, ['tail']]]],
});
export const BRUTE = template({ id: 'brute', ac: 12, hp: 40, str: 18, attacks: [{ local: 'maul', toHit: 100, damage: [['20', 'bludgeoning']] }] });
export const WARDED = template({ id: 'warded', ac: 10, hp: 100, attacks: [{ local: 'tap', toHit: 0, damage: [['1', 'bludgeoning']] }], resist: ['fire'], vuln: ['cold'], immune: ['poison'] });

/** A hand-built effect for effect-core tests (the compiler makes real ones). */
export function effect(local: string, over: Partial<BoundEffect> = {}): BoundEffect {
  return {
    id: `test:fx/${local}` as Id, local, name: local, sid: -1, lvl: 0, zone: null, dur: { k: 'parent' }, limit: 'none', endsOn: 0,
    inHand: false, group: null, mods: [], hooks: [], hookMask: 0, grants: [], interacts: false, conc: false, ...over,
  };
}

export function withEffects(t: CompiledTemplate, effects: BoundEffect[]): CompiledTemplate {
  return { ...t, effects };
}

/** A fixed damage part: [amount, type]. */
export function dmg(amount: number, type: string): CompiledDamage {
  return { roll: { k: 'const', v: amount }, critExtra: null, type: DAMAGE_TYPES.indexOf(type as never), avg: amount, ifAdvantage: false };
}

// ---- spells, by hand (the compiler builds real ones per caster and level) ----

export function spell(local: string, over: Partial<CompiledSpell> = {}): CompiledSpell {
  return {
    id: `test:${local}` as Id, local, name: local, source: 'synthetic test fixture', sid: 0, level: 0, cast: 'action', v: true, s: true, m: 'none',
    conc: false, rangeFt: 30, areaShape: -1, recast: 'stack', createsInHand: false, fidelity: 'full', unimplemented: [], ...over,
  };
}

/** One spell as a caster has it; `prog` per cast level (missing levels can't be cast). */
export function entry(sp: CompiledSpell, prog: Record<number, Step[]>, over: Partial<SpellEntry> = {}): SpellEntry {
  const levels: (Step[] | null)[] = [];
  for (let l = 0; l <= 9; l++) levels.push(prog[l] ?? null);
  return { spell: sp, source: 'class', list: 'druid', ability: 4, toHit: 7, dc: 15, whileHeld: -1, freePool: -1, slotted: true, prog: levels, instance: new Array<number>(10).fill(-1), ...over };
}

export const S = {
  target: (rangeFt: number, who: 'any' | 'ally' | 'enemy' = 'enemy', self: 'yes' | 'no' | 'textSilent' = 'no', maxSize = 5): Step => ({ k: 'target', rangeFt, who, self, maxSize }),
  attack: (atk: CompiledAttack, onHit: Step[], onMiss: Step[] = []): Step => ({ k: 'attack', atk, onHit, onMiss }),
  damage: (roll: string, type: string): Step => ({ k: 'damage', dmg: [{ roll: parseExpr(roll), critExtra: diceOnly(parseExpr(roll)), type: DAMAGE_TYPES.indexOf(type as never), avg: 0, ifAdvantage: false }] }),
  heal: (roll: string): Step => ({ k: 'heal', roll: parseExpr(roll) }),
  apply: (fx: number, to: 'self' | 'target' | 'point'): Step => ({ k: 'apply', fx, to }),
  use: (fx: number, grant: number): Step => ({ k: 'use', fx, grant }),
  choose: (opts: [string, Step[]][]): Step => ({ k: 'choose', opts: opts.map(([local, steps]) => ({ local, name: local, steps })) }),
  save: (ability: number, key: number, dc: number, roll: string | null, type: string, half: boolean, onFail: Step[] = []): Step => ({
    k: 'save', ability, key, dc, half, onFail, onSuccess: [],
    dmg: roll ? [{ roll: parseExpr(roll), critExtra: null, type: DAMAGE_TYPES.indexOf(type as never), avg: 0, ifAdvantage: false }] : null,
  }),
};

/** A spell attack: bound into a program, never in tpl.attacks. A melee spell attack's reach is its range. */
export function spellAttack(local: string, kind: 'melee' | 'ranged', toHit: number, rangeFt: number, roll: string, type: string): CompiledAttack {
  const a = attack('spell', { local, kind, toHit, reach: rangeFt, range: [rangeFt, rangeFt], damage: [[roll, type]] });
  return { ...a, spell: true };
}

export function item(local: string, kind: ItemDef['kind'], over: Partial<ItemDef> = {}): ItemDef {
  return { local, name: local, kind, focusFor: kind === 'focus' ? ['druid'] : [], shieldAc: kind === 'shield' ? 2 : 0, ...over };
}

/** A PC template with spells, effects, items, hands, slots and pools. */
export function caster(over: Partial<CompiledTemplate> & { slots?: number[]; poolMax?: number[] }): CompiledTemplate {
  const base = template({ id: 'caster', kind: 'pc', ac: 13, hp: 40, dex: 14, attacks: [] });
  const slots = over.slots ?? [4, 3, 3];
  const res = [...slots, ...new Array<number>(9 - slots.length).fill(0), ...(over.poolMax ?? [])];
  const { slots: _s, poolMax: _p, ...rest } = over;
  void _s;
  void _p;
  return { ...base, resMax: res, ...rest };
}

export function feature(local: string, a: CompiledFeature['activate'], preRoll: CompiledFeature['preRoll'] = null): CompiledFeature {
  return { id: `test:${local}` as Id, local, name: local, activate: a, preRoll };
}
