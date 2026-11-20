// Coverage W1.1, builder B2 "attacks" (docs/design/w1-plan.md section 7): the attack-side W1
// primitives end to end. P1's call sites (an attack roll or a forced save against an enemy on the
// bearer's own turn extends a sustained effect; the extendSource grant), P4 (a rider part of the
// attack's type), P5 (the roll state threaded to the rider gates), P6 (the weapon-property filter at
// the hit), P7 (the firstAttack decision and the weapon attack key bits), P9 (the move step: a free
// walk that provokes nothing, its budget and freeMoveUsesMovement), P10 (a self-only rider option
// still runs after the target dies), P11 (hitTaken sees, endOfThisTurn) and the Frenzy flag read.
// Tests are named for the rule text, with its line in the SRD 5.2.1 PDF text (srd-raw.txt). Content
// is synthetic (test: ids, shaped like the SRD items, never the items themselves).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { attackKey, RK } from '../src/content/rollkeys.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionKind, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { attackKeyOf, resolveAttack } from '../src/sim/attack.ts';
import { resolveOption } from '../src/sim/act.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { speedNow } from '../src/sim/damage.ts';
import { boundary } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { addCond, COND, type Fx, type Unit } from '../src/sim/state.ts';
import { syncBudget } from '../src/sim/walker.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test')];

const SRC = 'source: synthetic W1.1 B2 fixture';
const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\n${SRC}\n${body}`;

/** Stand-ins shaped like the SRD items (Rage, Reckless Attack, Frenzy, Sneak Attack, Cunning Strike, Second Wind, Tactical Shift, Steady Aim, Uncanny Dodge). */
const KIT: Record<string, string> = {
  'w1a-rage': feature(
    'w1a-rage',
    `activate: { id: rage, name: Rage, cost: bonus, pool: w1a-rage, root: raging, when: [notHeavyArmor], target: self, do: [{ apply: { effect: mark, to: self } }] }
riders:
  - { id: rage-damage, name: Rage Damage, on: hit, filter: { attack: [weapon, unarmed], ability: str }, when: [{ selfHas: raging }], auto: true, do: [{ damage: [{ roll: '2', type: weapon }] }] }
effects:
  - id: raging
    name: Raging
    duration: { until: endOfNextTurn, of: bearer }
    sustain: { by: [attackRoll, enemySave] }
    endsOn: [incapacitated]
    stats: [{ resist: [slashing] }]
    grants: [{ id: extend, name: Extend, cost: bonus, laterTurns: true, to: owner, do: [{ extendSource: true }] }]
  - { id: mark, name: Mark }
`,
  ),
  'w1a-bold': feature(
    'w1a-bold',
    `firstAttack: { do: [{ apply: { effect: bold, to: self } }] }
effects:
  - { id: bold, name: Bold, duration: { until: startOfNextTurn, of: bearer }, mods: [{ on: [d20.attack.str], op: adv }, { on: [d20.attack], side: incoming, op: adv }] }
`,
  ),
  'w1a-fury': feature(
    'w1a-fury',
    `augments: { feature: test:w1a-bold, firstAttack: true, steps: [{ apply: { effect: armed, to: self, when: [{ selfHas: 'test:w1a-rage#raging' }] } }] }
riders:
  - { id: fury-damage, name: Fury Damage, on: hit, oncePerTurn: ownTurn, filter: { ability: str }, when: [{ selfHas: armed }], auto: true, do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
effects:
  - { id: armed, name: Armed, duration: { until: endOfThisTurn, of: bearer } }
`,
  ),
  'w1a-calm': feature(
    'w1a-calm',
    `augments: { feature: test:w1a-rage, steps: [{ apply: { effect: calm, to: self } }, { endConditions: [charmed, frightened] }] }
effects:
  - { id: calm, name: Calm, immune: [charmed, frightened] }
`,
  ),
  'w1a-glow': feature('w1a-glow', 'passive: { effects: [glow] }\neffects:\n  - { id: glow, name: Glow, stats: [{ damageType: force, on: unarmed }] }\n'),
  'w1a-glare': feature(
    'w1a-glare',
    `spellAbility: wis
activate: { id: glare, name: Glare, cost: action, do: [{ target: { range: 30, who: enemy, self: no } }, { save: { ability: wis } }] }
`,
  ),
  'w1a-sneak': feature(
    'w1a-sneak',
    `riders:
  - { id: sneak, name: Sneak, on: hit, oncePerTurn: global, filter: { weaponProperty: [finesse, ranged] }, when: [{ anyOf: [[rollAdv], [allyWithin5ftOfTarget, rollNotDis]] }], do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
`,
  ),
  'w1a-slip': feature(
    'w1a-slip',
    `augments: { feature: test:w1a-sneak, rider: sneak, options: [{ id: slip, name: Slip, do: [{ damage: [{ roll: '1', type: weapon }] }, { move: { speed: half, noOpportunityAttacks: true } }] }] }
`,
  ),
  'w1a-steady': feature(
    'w1a-steady',
    `activate: { id: steady, name: Steady, cost: bonus, when: [hasntMoved], target: self, do: [{ apply: { effect: aim, to: self } }, { apply: { effect: still, to: self } }] }
effects:
  - { id: aim, name: Aim, duration: { until: endOfThisTurn, of: bearer }, mods: [{ on: [d20.attack], op: adv, consume: nextRoll }] }
  - { id: still, name: Still, duration: { until: endOfThisTurn, of: bearer }, stats: [{ speed: zero }] }
`,
  ),
  'w1a-wind': feature('w1a-wind', "activate: { id: wind, name: Wind, cost: bonus, target: self, do: [{ heal: { roll: '1' } }] }\n"),
  'w1a-shift': feature('w1a-shift', 'augments: { feature: test:w1a-wind, steps: [{ move: { speed: half, noOpportunityAttacks: true } }] }\n'),
  'w1a-slow': feature(
    'w1a-slow',
    `activate: { id: slow, name: Slow, cost: action, target: self, do: [{ apply: { effect: slowed, to: self } }] }
effects:
  - { id: slowed, name: Slowed, duration: { until: endOfNextTurn, of: bearer }, stats: [{ speed: half }] }
`,
  ),
  'w1a-duck': feature('w1a-duck', 'reaction: { window: hitTaken, reduce: halve, sees: true }\n'),
};

/** A level-5 PC (PB 3), STR 16 (+3) / DEX 18 (+4), unarmored: a Rapier is a DEX attack, a Greataxe a STR one. */
const PC = (features: readonly string[], speed: number) => `kind: pc
id: test:w1a-pc
name: W1a PC
${SRC}
rules: '2024'
level: 5
size: medium
speed: ${speed}
abilities: { str: 16, dex: 18, con: 14, int: 10, wis: 14, cha: 10 }
hpMax: 200
ac: 14
armor: none
saveProficiencies: [str, con]
weapons:
  - { id: rapier, name: Rapier, kind: melee, ability: finesse, damage: [{ roll: 1d8 + @mod, type: piercing }] }
  - { id: greataxe, name: Greataxe, kind: melee, ability: str, damage: [{ roll: 1d12 + @mod, type: slashing }] }
  - { id: handaxe, name: Handaxe, kind: melee, ability: str, thrownRange: [20, 60], damage: [{ roll: 1d6 + @mod, type: slashing }] }
  - { id: longbow, name: Longbow, kind: ranged, ability: dex, range: [150, 600], damage: [{ roll: 1d8 + @mod, type: piercing }] }
pools:
  - { id: w1a-rage, name: Rage, max: 3, recharge: longRest }
features: [${features.map((f) => `test:${f}`).join(', ')}]
`;

const monster = (id: string, ac: number, hp: number, extra = '') => `kind: monster
id: test:${id}
name: ${id}
${SRC}
size: medium
cr: 0
pb: 2
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 1, cha: 10 }
${extra}attacks:
  - { id: hit, name: Hit, kind: melee, toHit: 30, damage: [{ roll: '1', type: bludgeoning, avg: 1 }] }
`;
const MONSTERS: Record<string, string> = {
  'w1a-brute': monster('w1a-brute', 5, 300),
  'w1a-hide': monster('w1a-hide', 5, 300, 'resist: [piercing]\n'),
  'w1a-thick': monster('w1a-thick', 5, 300, 'resist: [bludgeoning]\n'),
  'w1a-mook': monster('w1a-mook', 5, 1),
  'w1a-pal': monster('w1a-pal', 5, 300),
};

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const ME: UnitDoc = { seat: 'pc1', team: 'party', use: 'test:w1a-pc', at: 'B2' };
const foe = (seat: string, kind: string, cell: string): UnitDoc => ({ seat, team: 'enemies', use: `test:${kind}`, at: cell });
const pal = (cell: string): UnitDoc => ({ seat: 'pal', team: 'party', use: 'test:w1a-pal', at: cell });

interface Opts {
  features: string[];
  units?: UnitDoc[];
  flags?: Partial<RuleFlags>;
  speed?: number;
}
const SETUPS = new Map<string, FightSetup>();
function setupOf(o: Opts): FightSetup {
  const key = JSON.stringify(o);
  let s = SETUPS.get(key);
  if (!s) {
    const files: SourceFile[] = [
      ...REPO,
      ...Object.entries(KIT).map(([n, text]) => ({ path: `packs/test/features/${n}.yaml`, text })),
      ...Object.entries(MONSTERS).map(([n, text]) => ({ path: `packs/test/monsters/${n}.yaml`, text })),
      { path: 'packs/test/pcs/w1a-pc.yaml', text: PC(o.features, o.speed ?? 30) },
    ];
    const r0 = loadContent(files);
    if (!r0.content) throw new Error(r0.errors.map(formatDiag).join('\n'));
    const content: Content = r0.content;
    const doc = { kind: 'scenario', id: 'w1a-lab', name: 'W1 attack lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 6 }, units: o.units ?? [ME, foe('brute', 'w1a-brute', 'C2')] };
    const r = resolveScenario(doc, 'w1a-lab.yaml', content, o.flags ? { flags: o.flags } : {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    SETUPS.set(key, (s = r.setup));
  }
  return s;
}

/** Scripted answers: riders by key (or pass), firstAttack take/pass, moveTo by key (or pass), hitTaken react; else the first item. */
class Scripted implements Decider {
  readonly name = 'scripted';
  readonly seen: { k: DecisionKind; keys: string[]; dp: DecisionPoint; who: number }[] = [];
  rider: ((keys: string[]) => string | null) | null = (keys) => keys[keys.length - 1]!;
  first = false;
  moveTo: string | null = null;
  react = true;
  oa = false;
  decide(_v: UnitView, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys, dp, who: dp.who });
    if (dp.k === 'rider') {
      const want = this.rider ? this.rider(keys) : null;
      return want === null ? 0 : keys.indexOf(want);
    }
    if (dp.k === 'firstAttack') return this.first ? 1 : 0;
    if (dp.k === 'moveTo') {
      if (this.moveTo === null) return 0;
      const i = keys.indexOf(this.moveTo);
      if (i < 0) throw new Error(`no ${this.moveTo} among ${keys.join(', ')}`);
      return i;
    }
    if (dp.k === 'hitTaken') return this.react ? 1 : 0;
    if (dp.k === 'reaction') return this.oa && dp.legal.n > 1 ? 1 : 0;
    return 0;
  }
  kinds(k: DecisionKind): string[][] {
    return this.seen.filter((s) => s.k === k).map((s) => s.keys);
  }
}

interface World {
  readonly cx: Ctx;
  readonly d: Scripted;
  readonly sink: ArraySink;
  u(seat: string): Unit;
}
function world(o: Opts, seed = 1): World {
  const setup = setupOf(o);
  const d = new Scripted();
  const sink = new ArraySink();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, d, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
/** A turn start as sim/fight.ts runs it, as far as these tests need (resetBudget's fields, W1's included). */
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  boundary(w.cx, 'start', who, -1);
  const b = who.b;
  b.action = 1;
  b.bonus = 1;
  b.reaction = 1;
  b.moveFt = speedNow(who, st);
  b.speedAt = b.moveFt;
  b.dashes = 0;
  b.standFt = 0;
  b.diagParity = 0;
  b.movedFt = 0;
  b.atkActive = false;
  b.rolls = 0;
  b.freeFt = 0;
}
function endTurn(w: World, who: Unit): void {
  boundary(w.cx, 'end', who, -1);
  w.cx.st.active = -1;
}
const atkIdx = (u: Unit, local: string): number => {
  const i = u.tpl.attacks.findIndex((a) => a.local === local);
  if (i < 0) throw new Error(`no attack ${local}`);
  return i;
};
const keysOf = (w: World, u: Unit): string[] => {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, u.idx, l));
  releaseList(w.cx, list);
  return keys;
};
const use = (w: World, u: Unit, key: string): void => {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const all = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, u.idx, l) }));
  releaseList(w.cx, list);
  const o = all.find((x) => x.key === key);
  if (!o) throw new Error(`no option ${key}; have ${all.map((x) => x.key).join(', ')}`);
  resolveOption(w.cx, u, o.l, -1);
};
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const liveFx = (w: World, id: string): Fx | undefined =>
  w.cx.st.fx.find((f) => f.alive && w.cx.st.units[f.owner]!.tpl.effects[f.tpl]!.id === id);
const flagRead = (w: World, k: keyof RuleFlags): boolean => w.cx.st.flagsUsed[flagIndex(k)] === 1;
/** The first seed (from 1) whose world, after `act`, satisfies `ok`; the world is returned. */
function seeded(o: Opts, act: (w: World) => void, ok: (w: World) => boolean, max = 60): World {
  for (let seed = 1; seed <= max; seed++) {
    const w = world(o, seed);
    act(w);
    if (ok(w)) return w;
  }
  throw new Error('no seed found');
}
const lastHit = (w: World): boolean => evs(w, 'attack').at(-1)?.hit === true;
const tplOf = (o: Opts): CompiledTemplate => setupOf(o).seats.find((s) => s.tpl.id === 'test:w1a-pc')!.tpl;

const RAGE: Opts = { features: ['w1a-rage', 'w1a-glare'], units: [ME, foe('brute', 'w1a-brute', 'C2'), pal('A2')] };

describe('P1 Rage end to end: "If your Rage is still active on your next turn, you can extend the Rage" (srd-raw.txt:4985-4993)', () => {
  /** Rage on turn 1, then turn 2 begins: the effect is due to end at the end of turn 2 unless extended. */
  function raged(o: Opts = RAGE): { w: World; pc: Unit; brute: Unit } {
    const w = world(o);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    use(w, pc, 'use:w1a-rage');
    const f = liveFx(w, 'test:w1a-rage/raging')!;
    expect(f.until).toEqual({ k: 'turnEnd', unit: pc.idx, after: 1 }); // "until the end of your next turn" (4982-4983)
    endTurn(w, pc);
    startTurn(w, brute);
    endTurn(w, brute);
    startTurn(w, pc);
    return { w, pc, brute };
  }
  const survivesTurn2 = (w: World, pc: Unit): boolean => {
    endTurn(w, pc);
    return liveFx(w, 'test:w1a-rage/raging') !== undefined;
  };

  it('without an extension it ends at the end of your next turn (4982-4983)', () => {
    const { w, pc } = raged();
    expect(survivesTurn2(w, pc)).toBe(false);
  });

  it('an attack roll against an enemy on your next turn extends it (4988), hit or miss', () => {
    const { w, pc, brute } = raged();
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    expect(liveFx(w, 'test:w1a-rage/raging')!.until).toEqual({ k: 'turnEnd', unit: pc.idx, after: 2 });
    expect(survivesTurn2(w, pc)).toBe(true);
  });

  it('an attack roll against an ally doesn\'t extend it (4988)', () => {
    const { w, pc } = raged();
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), w.u('pal'), false, -1);
    expect(evs(w, 'attack')).toHaveLength(1);
    expect(survivesTurn2(w, pc)).toBe(false);
  });

  it('forcing an enemy to save extends it (4989)', () => {
    const { w, pc } = raged();
    use(w, pc, 'use:w1a-glare');
    expect(evs(w, 'save')).toHaveLength(1);
    expect(survivesTurn2(w, pc)).toBe(true);
  });

  it('a Bonus Action extends it (4990)', () => {
    const { w, pc } = raged();
    expect(keysOf(w, pc)).toContain('use:pc1/raging/extend');
    use(w, pc, 'use:pc1/raging/extend');
    expect(pc.b.bonus).toBe(0);
    expect(survivesTurn2(w, pc)).toBe(true);
    // Extended once, it lasts one more round only: without another extension it ends at the end of turn 3.
    startTurn(w, pc);
    endTurn(w, pc);
    expect(liveFx(w, 'test:w1a-rage/raging')).toBeUndefined();
  });

  it('the Bonus Action extension isn\'t offered on the turn Rage starts (4985)', () => {
    const w = world(RAGE);
    const pc = w.u('pc1');
    startTurn(w, pc);
    use(w, pc, 'use:w1a-rage');
    pc.b.bonus = 1; // even with a Bonus Action left
    expect(keysOf(w, pc).filter((k) => k.endsWith('/extend'))).toEqual([]);
  });

  it('an opportunity attack on another creature\'s turn doesn\'t extend it (4985-4986)', () => {
    const w = world(RAGE);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    use(w, pc, 'use:w1a-rage');
    endTurn(w, pc);
    startTurn(w, brute);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, true, -1);
    expect(liveFx(w, 'test:w1a-rage/raging')!.until).toEqual({ k: 'turnEnd', unit: pc.idx, after: 1 });
    endTurn(w, brute);
    startTurn(w, pc);
    endTurn(w, pc);
    expect(liveFx(w, 'test:w1a-rage/raging')).toBeUndefined();
  });
});

describe('P7 Reckless Attack: "When you make your first attack roll on your turn, you can decide to attack recklessly" (srd-raw.txt:5021-5029)', () => {
  const BOLD: Opts = { features: ['w1a-bold'] };

  it('Reckless Attack is offered only before the first attack roll on your turn (5021-5022)', () => {
    const w = world(BOLD);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    expect(w.d.kinds('firstAttack')).toEqual([['pass', 'first:w1a-bold']]);
    const dp = w.d.seen.find((s) => s.k === 'firstAttack')!.dp;
    expect(dp.src).toEqual({ via: pc.tpl.attacks[atkIdx(pc, 'greataxe')]!.id, target: brute.idx });
    // Declined (pass first, so a decider that answers 0 declines): nothing applied.
    expect(liveFx(w, 'test:w1a-bold/bold')).toBeUndefined();
    // Not on another creature's turn (an opportunity attack), nor before a turn's first roll made off it.
    endTurn(w, pc);
    startTurn(w, brute);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, true, -1);
    expect(w.d.kinds('firstAttack')).toHaveLength(1);
    endTurn(w, brute);
    startTurn(w, pc); // a new turn: offered again
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    expect(w.d.kinds('firstAttack')).toHaveLength(2);
  });

  it('a template without a firstAttack feature is never asked', () => {
    const w = world({ features: [] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), w.u('brute'), false, -1);
    expect(w.d.kinds('firstAttack')).toEqual([]);
    expect(pc.b.rolls).toBe(1);
  });

  it('it gives Advantage on attack rolls using Strength, not Dexterity ones (5022)', () => {
    const w = world(BOLD);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    w.d.first = true;
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), brute, false, -1); // finesse at DEX 18 over STR 16: a DEX attack
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, false, -1); // an Unarmed Strike uses STR
    expect(evs(w, 'attack').map((e) => e.adv)).toEqual(['adv', 'none', 'adv']);
    // The act line names the feature, after its decision.
    expect(evs(w, 'act').map((e) => e.via)).toContain('test:w1a-bold');
  });

  it('attack rolls against you have Advantage until the start of your next turn (5022, 5028-5029)', () => {
    const w = world(BOLD);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    w.d.first = true;
    w.d.react = false;
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), brute, false, -1);
    endTurn(w, pc);
    startTurn(w, brute);
    resolveAttack(w.cx, brute, 0, pc, false, -1);
    endTurn(w, brute);
    startTurn(w, pc);
    endTurn(w, pc);
    startTurn(w, brute);
    resolveAttack(w.cx, brute, 0, pc, false, -1);
    expect(evs(w, 'attack').filter((e) => e.att === brute.idx).map((e) => e.adv)).toEqual(['adv', 'none']);
  });

  it('key bits: a weapon attack\'s key names its ability and the weapon source only on a template whose content names one; the rest keep their keys (C3)', () => {
    const t = tplOf(BOLD);
    const ax = t.attacks.find((a) => a.local === 'greataxe')!;
    expect(attackKeyOf(ax, false)).toBe(attackKey('melee', false, { ability: 0, source: 'weapon' }));
    expect(attackKeyOf(ax, true) & RK.opportunity).toBe(RK.opportunity);
    expect(attackKeyOf(t.attacks.find((a) => a.local === 'longbow')!, false)).toBe(attackKey('ranged', false, { ability: 1, source: 'weapon' }));
    const plain = tplOf({ features: [] });
    for (const a of plain.attacks) {
      expect(attackKeyOf(a, false), a.local).toBe(a.unarmed ? attackKey('melee', false, { ability: 0, source: 'unarmed' }) : attackKey(a.kind, a.spell));
      expect(attackKeyOf(a, true), a.local).toBe(a.unarmed ? attackKey('melee', false, { ability: 0, source: 'unarmed', opportunity: true }) : attackKey(a.kind, a.spell, { opportunity: true }));
    }
  });
});

describe('Frenzy (P3 gated apply, P4, P11): "If you use Reckless Attack while your Rage is active" (srd-raw.txt:5173-5178)', () => {
  const FURY: Opts = { features: ['w1a-rage', 'w1a-bold', 'w1a-fury', 'w1a-glow'] };
  // A Bludgeoning-resistant target, so the damageType stat swaps the Unarmed Strike to Force (sim/stats.ts unarmedTypeFor).
  const THICK: Opts = { ...FURY, units: [ME, foe('brute', 'w1a-thick', 'C2')] };

  it('Frenzy\'s damage has a swapped Unarmed Strike type (5177-5178); armed when Reckless is used while raging (frenzyRageCheck: declaration)', () => {
    const w = seeded(
      THICK,
      (w) => {
        const pc = w.u('pc1');
        w.d.first = true;
        startTurn(w, pc);
        use(w, pc, 'use:w1a-rage');
        resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    expect(flagRead(w, 'frenzyRageCheck')).toBe(true);
    expect(liveFx(w, 'test:w1a-fury/armed')).toBeDefined();
    const dmg = evs(w, 'damage').at(-1)!;
    // The strike (force, by the damageType stat), Rage Damage and Frenzy's d6: every part the strike's type.
    expect(dmg.parts.map((p) => p.type)).toEqual(['force', 'force', 'force']);
    expect(dmg.dealt).toBe(dmg.parts.reduce((s, p) => s + p.rolled, 0)); // none of it resisted
    // The armed effect lasts until the end of this turn (P11 endOfThisTurn).
    endTurn(w, w.u('pc1'));
    expect(liveFx(w, 'test:w1a-fury/armed')).toBeUndefined();
  });

  it('not armed when Rage starts after Reckless Attack is declared (declaration)', () => {
    const w = seeded(
      FURY,
      (w) => {
        const pc = w.u('pc1');
        w.d.first = true;
        startTurn(w, pc);
        resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), w.u('brute'), false, -1);
        use(w, pc, 'use:w1a-rage');
        resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    expect(flagRead(w, 'frenzyRageCheck')).toBe(true);
    expect(liveFx(w, 'test:w1a-fury/armed')).toBeUndefined();
    // The second hit: the axe and Rage Damage (slashing, the weapon's type), no Frenzy part.
    expect(evs(w, 'damage').at(-1)!.parts.map((p) => p.type)).toEqual(['slashing', 'slashing']);
  });

  it('a fight with no Frenzy never reads frenzyRageCheck', () => {
    const w = world({ features: ['w1a-rage', 'w1a-bold'] });
    const pc = w.u('pc1');
    w.d.first = true;
    startTurn(w, pc);
    use(w, pc, 'use:w1a-rage');
    resolveAttack(w.cx, pc, atkIdx(pc, 'greataxe'), w.u('brute'), false, -1);
    expect(flagRead(w, 'frenzyRageCheck')).toBe(false);
  });
});

describe('P4-P6 Sneak Attack: "a creature you hit with an attack roll if you have Advantage on the roll and the attack uses a Finesse or a Ranged weapon" (srd-raw.txt:13737-13743)', () => {
  const SNEAK: Opts = { features: ['w1a-sneak'] };
  const WITH_PAL: Opts = { features: ['w1a-sneak'], units: [ME, foe('brute', 'w1a-brute', 'C2'), pal('D2')] };
  /** A rapier hit on the brute from B2 after `setup`; the rider decisions seen. */
  const offered = (o: Opts, setup: (w: World) => void, weapon = 'rapier'): { w: World; asked: boolean } => {
    const w = seeded(
      o,
      (w) => {
        const pc = w.u('pc1');
        w.d.rider = () => null;
        startTurn(w, pc);
        setup(w);
        resolveAttack(w.cx, pc, atkIdx(pc, weapon), w.u('brute'), false, -1);
      },
      lastHit,
    );
    return { w, asked: w.d.kinds('rider').some((k) => k.includes('rider:sneak')) };
  };
  const prone = (u: Unit) => addCond(u, COND.prone, 'test:x', -1, -1, { k: 'never' });

  it('Sneak Attack with Advantage (13738)', () => {
    const { w, asked } = offered(SNEAK, (w) => prone(w.u('brute')));
    expect(evs(w, 'attack').at(-1)!.adv).toBe('adv');
    expect(asked).toBe(true);
  });

  it('not without Advantage and no ally near the target', () => {
    expect(offered(SNEAK, () => {}).asked).toBe(false);
  });

  it('without Advantage when an ally is within 5 feet of the target (13741-13742)', () => {
    const { w, asked } = offered(WITH_PAL, () => {});
    expect(evs(w, 'attack').at(-1)!.adv).toBe('none');
    expect(asked).toBe(true);
  });

  it('not when that ally is Incapacitated (13742)', () => {
    expect(offered(WITH_PAL, (w) => addCond(w.u('pal'), COND.incapacitated, 'test:x', -1, -1, { k: 'never' })).asked).toBe(false);
  });

  it('not with Disadvantage, even with the ally (13743)', () => {
    const { w, asked } = offered(WITH_PAL, (w) => prone(w.u('pc1')));
    expect(evs(w, 'attack').at(-1)!.adv).toBe('dis');
    expect(asked).toBe(false);
  });

  it('Advantage and Disadvantage cancel, so the ally clause applies (1056-1060)', () => {
    const both = (w: World) => {
      prone(w.u('pc1'));
      prone(w.u('brute'));
    };
    const r1 = offered(WITH_PAL, both);
    expect(evs(r1.w, 'attack').at(-1)!.adv).toBe('none');
    expect(r1.asked).toBe(true);
    expect(offered(SNEAK, both).asked).toBe(false);
  });

  it('Sneak Attack with a Finesse weapon, not with a Greataxe (13738-13739)', () => {
    expect(offered(SNEAK, (w) => prone(w.u('brute')), 'rapier').asked).toBe(true);
    expect(offered(SNEAK, (w) => prone(w.u('brute')), 'greataxe').asked).toBe(false);
  });

  it('a thrown Handaxe isn\'t a Ranged weapon (13739): its hit offers no Sneak Attack; a Longbow\'s does', () => {
    // At 15 ft, an ally next to the target (the ally clause), no Advantage or Disadvantage either way.
    const o: Opts = { features: ['w1a-sneak'], units: [ME, foe('brute', 'w1a-brute', 'E2'), pal('F2')] };
    const shot = (weapon: string) =>
      seeded(
        o,
        (w) => {
          const pc = w.u('pc1');
          w.d.rider = () => null;
          startTurn(w, pc);
          resolveAttack(w.cx, pc, atkIdx(pc, weapon), w.u('brute'), false, -1);
        },
        lastHit,
      );
    const axe = shot('handaxe-thrown');
    expect(evs(axe, 'attack').at(-1)!.adv).toBe('none');
    expect(axe.d.kinds('rider')).toEqual([]);
    const bow = shot('longbow');
    expect(evs(bow, 'attack').at(-1)!.adv).toBe('none');
    expect(bow.d.kinds('rider')).toEqual([['pass', 'rider:sneak']]);
  });

  it('Sneak Attack\'s damage has the weapon\'s type (13739), checked against a Piercing-resistant target', () => {
    const o: Opts = { features: ['w1a-sneak'], units: [ME, foe('brute', 'w1a-hide', 'C2')] };
    const w = seeded(
      o,
      (w) => {
        const pc = w.u('pc1');
        startTurn(w, pc);
        prone(w.u('brute'));
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), w.u('brute'), false, -1);
      },
      (w) => lastHit(w) && !evs(w, 'attack').at(-1)!.crit,
    );
    expect(w.d.kinds('rider')).toEqual([['pass', 'rider:sneak']]);
    const dmg = evs(w, 'damage').at(-1)!;
    expect(dmg.parts.map((p) => p.type)).toEqual(['piercing', 'piercing']);
    const total = dmg.parts.reduce((s, p) => s + p.rolled, 0);
    expect(dmg.dealt).toBe(Math.floor(total / 2)); // the rider's part is resisted too
  });

  it('Sneak Attack on an opportunity attack on another creature\'s turn, once per turn (global)', () => {
    const w = seeded(
      WITH_PAL,
      (w) => {
        const pc = w.u('pc1');
        const brute = w.u('brute');
        startTurn(w, brute);
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), brute, true, -1);
      },
      lastHit,
    );
    const pc = w.u('pc1');
    const brute = w.u('brute');
    expect(w.d.kinds('rider')).toEqual([['pass', 'rider:sneak']]); // taken (the scripted decider takes the last key)
    // A second hit the same turn: not offered.
    let more = 0;
    for (let k = 0; k < 6 && more < 1; k++) {
      resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), brute, true, -1);
      if (lastHit(w)) more++;
    }
    expect(more).toBe(1);
    expect(w.d.kinds('rider')).toHaveLength(1);
    // The pc's own turn is a new turn: offered again.
    endTurn(w, brute);
    startTurn(w, pc);
    for (let k = 0; k < 6 && w.d.kinds('rider').length < 2; k++) resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), brute, false, -1);
    expect(w.d.kinds('rider')).toHaveLength(2);
  });
});

describe('P9 the free move: "move up to half your Speed without provoking Opportunity Attacks" (srd-raw.txt:10661-10663, 13835-13836)', () => {
  const SHIFT: Opts = { features: ['w1a-wind', 'w1a-shift', 'w1a-slow'] };
  const provokes = (w: World) => evs(w, 'provoke').length;

  it('Tactical Shift: after a Bonus Action Second Wind, move half Speed without provoking (10661-10663)', () => {
    const w = world(SHIFT);
    const pc = w.u('pc1');
    w.d.moveTo = 'moveTo:B5';
    startTurn(w, pc);
    use(w, pc, 'use:w1a-wind');
    const asks = w.d.seen.filter((s) => s.k === 'moveTo');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.keys[0]).toBe('pass');
    // Every square offered is within 15 ft (half of 30), and the heal came first.
    const dp = asks[0]!.dp;
    const fts = Array.from({ length: dp.legal.n - 1 }, (_, i) => dp.legal.items[i + 1]!.ft);
    expect(Math.max(...fts)).toBe(15);
    expect(evs(w, 'heal')).toHaveLength(1);
    expect(pc.cell).toBe(4 * 8 + 1); // B5 on the 8-wide grid
    expect(provokes(w)).toBe(0); // it left the brute's reach (B3 to B4) without a provoke window
    expect(flagRead(w, 'freeMoveUsesMovement')).toBe(true);
  });

  it('a free move leaves normal movement whole', () => {
    const w = world(SHIFT);
    const pc = w.u('pc1');
    w.d.moveTo = 'moveTo:B5';
    startTurn(w, pc);
    use(w, pc, 'use:w1a-wind');
    expect([pc.b.moveFt, pc.b.movedFt, pc.b.freeFt]).toEqual([30, 0, 15]);
    // The turn's own moves still reach 30 ft.
    expect(keysOf(w, pc).filter((k) => k.startsWith('move:')).length).toBeGreaterThan(0);
    expect(evs(w, 'step').at(-1)!.left).toBe(30);
  });

  it('a free move leaves normal movement whole after a mid-turn Speed change', () => {
    const w = world(SHIFT);
    const pc = w.u('pc1');
    w.d.moveTo = 'moveTo:B4';
    startTurn(w, pc);
    use(w, pc, 'use:w1a-wind');
    use(w, pc, 'use:w1a-slow'); // Speed 15 from here
    syncBudget(w.cx.st, pc);
    expect(pc.b.moveFt).toBe(15);
  });

  it('under freeMoveUsesMovement=true, a free move spends normal movement', () => {
    const w = world({ ...SHIFT, flags: { freeMoveUsesMovement: true } });
    const pc = w.u('pc1');
    w.d.moveTo = 'moveTo:B4';
    startTurn(w, pc);
    use(w, pc, 'use:w1a-wind');
    expect([pc.b.moveFt, pc.b.movedFt, pc.b.freeFt]).toEqual([20, 10, 0]);
    expect(provokes(w)).toBe(0);
    use(w, pc, 'use:w1a-slow');
    syncBudget(w.cx.st, pc);
    expect(pc.b.moveFt).toBe(5); // 15 less the 10 it spent
  });

  it('under freeMoveUsesMovement=true it goes no farther than the movement left', () => {
    const w = world({ ...SHIFT, flags: { freeMoveUsesMovement: true } });
    const pc = w.u('pc1');
    startTurn(w, pc);
    pc.b.moveFt = 5;
    use(w, pc, 'use:w1a-wind');
    const dp = w.d.seen.find((s) => s.k === 'moveTo')!.dp;
    expect(Math.max(...Array.from({ length: dp.legal.n - 1 }, (_, i) => dp.legal.items[i + 1]!.ft))).toBe(5);
  });

  it('half of a 35-ft Speed is 15 ft', () => {
    const w = world({ ...SHIFT, speed: 35 });
    const pc = w.u('pc1');
    startTurn(w, pc);
    use(w, pc, 'use:w1a-wind');
    const dp = w.d.seen.find((s) => s.k === 'moveTo')!.dp;
    expect(Math.max(...Array.from({ length: dp.legal.n - 1 }, (_, i) => dp.legal.items[i + 1]!.ft))).toBe(15);
  });

  it('a fight with no free move never reads freeMoveUsesMovement', () => {
    const w = world(SHIFT);
    const pc = w.u('pc1');
    startTurn(w, pc);
    use(w, pc, 'use:w1a-slow');
    expect(flagRead(w, 'freeMoveUsesMovement')).toBe(false);
  });
});

describe('P10 Cunning Strike shapes on Sneak Attack (srd-raw.txt:13811-13817, 13835-13836)', () => {
  const STRIKE: Opts = { features: ['w1a-sneak', 'w1a-slip', 'w1a-steady'] };
  const prone = (u: Unit) => addCond(u, COND.prone, 'test:x', -1, -1, { k: 'never' });

  it('the augment\'s option joins Sneak Attack\'s one decision (13811-13816)', () => {
    const w = seeded(
      STRIKE,
      (w) => {
        const pc = w.u('pc1');
        w.d.rider = () => null;
        startTurn(w, pc);
        prone(w.u('brute'));
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    expect(w.d.kinds('rider')).toEqual([['pass', 'rider:sneak/sneak', 'rider:sneak/slip']]);
  });

  it('Withdraw moves immediately after the attack (13835-13836), provoking nothing', () => {
    const w = seeded(
      STRIKE,
      (w) => {
        const pc = w.u('pc1');
        w.d.rider = (keys) => (keys.includes('rider:sneak/slip') ? 'rider:sneak/slip' : null);
        w.d.moveTo = 'moveTo:B5';
        startTurn(w, pc);
        prone(w.u('brute'));
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    const ks = w.sink.events.map((e) => e.k).filter((k) => ['attack', 'damage', 'step', 'provoke'].includes(k));
    expect(ks).toEqual(['attack', 'damage', 'step', 'step', 'step']);
    expect(w.u('pc1').cell).toBe(4 * 8 + 1);
    // The forgone die: the option's own extra damage replaced Sneak's (a constant 1 of the weapon's type here).
    expect(evs(w, 'damage').at(-1)!.parts.map((p) => p.type)).toEqual(['piercing', 'piercing']);
    expect(evs(w, 'damage').at(-1)!.parts[1]!.rolled).toBe(1);
  });

  it('Withdraw still moves after a killing Sneak Attack (13817, 13835)', () => {
    const o: Opts = { features: ['w1a-sneak', 'w1a-slip'], units: [ME, foe('brute', 'w1a-mook', 'C2'), foe('other', 'w1a-brute', 'H6')] };
    const w = seeded(
      o,
      (w) => {
        const pc = w.u('pc1');
        w.d.rider = (keys) => (keys.includes('rider:sneak/slip') ? 'rider:sneak/slip' : null);
        w.d.moveTo = 'moveTo:B5';
        startTurn(w, pc);
        prone(w.u('brute'));
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    expect(w.u('brute').life).toBe('dead');
    expect(w.d.kinds('moveTo')).toHaveLength(1);
    expect(w.u('pc1').cell).toBe(4 * 8 + 1);
  });

  it('Withdraw on an opportunity attack mid-walk: the free move is its own, and the walk it interrupted goes on along its path', () => {
    // The brute walks B3 -> B6 out of the pc's reach (every route provokes); the pc's opportunity
    // attack hits with Sneak Attack (an ally next to the brute) and Withdraws three squares to E2 on the
    // brute's turn; the brute's walk then finishes on its own path (the free move's route is its own).
    const o: Opts = { features: ['w1a-sneak', 'w1a-slip'], units: [ME, foe('brute', 'w1a-brute', 'B3'), pal('C3')] };
    const w = seeded(
      o,
      (w) => {
        const brute = w.u('brute');
        w.d.oa = true;
        w.d.rider = (keys) => (keys.includes('rider:sneak/slip') ? 'rider:sneak/slip' : null);
        w.d.moveTo = 'moveTo:E2';
        w.cx.st.order.set(w.cx.st.units.map((u) => u.idx)); // initiative order (the reaction poll walks it)
        startTurn(w, brute);
        w.u('pal').b.reaction = 0; // only the pc reacts
        const key = keysOf(w, brute).find((k) => k.startsWith('move:B6/p1'));
        if (!key) throw new Error(`no provoking move to B6: ${keysOf(w, brute).join(' ')}`);
        use(w, brute, key);
      },
      (w) => evs(w, 'attack').some((e) => e.opportunity && e.hit),
    );
    expect(w.d.kinds('moveTo')).toHaveLength(1);
    expect(w.u('pc1').cell).toBe(1 * 8 + 4); // E2
    expect(w.u('pc1').b.freeFt).toBe(15); // off its own turn the move spends no movement (freeMoveUsesMovement=false)
    const brute = w.u('brute');
    expect(brute.cell).toBe(5 * 8 + 1); // B6
    expect(evs(w, 'moveEnd').filter((e) => e.who === brute.idx).map((e) => [e.why, e.steps])).toEqual([['arrived', 3]]);
  });

  it('Steady Aim then Withdraw: no movement (13793-13794); its Speed 0 lasts until the end of the current turn', () => {
    const w = seeded(
      STRIKE,
      (w) => {
        const pc = w.u('pc1');
        w.d.rider = (keys) => (keys.includes('rider:sneak/slip') ? 'rider:sneak/slip' : null);
        w.d.moveTo = 'moveTo:B5';
        startTurn(w, pc);
        use(w, pc, 'use:w1a-steady');
        resolveAttack(w.cx, pc, atkIdx(pc, 'rapier'), w.u('brute'), false, -1);
      },
      lastHit,
    );
    const pc = w.u('pc1');
    expect(evs(w, 'attack').at(-1)!.adv).toBe('adv'); // Steady Aim's Advantage unlocked the rider
    expect(w.d.kinds('rider')[0]).toContain('rider:sneak/slip');
    expect(w.d.kinds('moveTo')).toEqual([]);
    expect(pc.cell).toBe(1 * 8 + 1); // still on B2
    expect(liveFx(w, 'test:w1a-steady/still')!.until).toEqual({ k: 'turnEnd', unit: pc.idx, after: pc.turns - 1 });
    endTurn(w, pc);
    expect(liveFx(w, 'test:w1a-steady/still')).toBeUndefined();
  });
});

describe('P11 the endConditions step on an augmented activation (Mindless Rage\'s shape, srd-raw.txt:5182-5184)', () => {
  it('entering the form ends Frightened on its user; the step runs in the activation\'s program', () => {
    const w = world({ features: ['w1a-rage', 'w1a-calm'] });
    const pc = w.u('pc1');
    addCond(pc, COND.frightened, 'test:x', -1, -1, { k: 'never' });
    startTurn(w, pc);
    use(w, pc, 'use:w1a-rage');
    expect(pc.condMask & COND.frightened).toBe(0);
    expect(evs(w, 'cond').filter((e) => !e.on).map((e) => e.cond)).toEqual(['core:frightened']);
    expect(liveFx(w, 'test:w1a-calm/calm')).toBeDefined();
  });
});

describe('P11 hitTaken sees: "When an attacker that you can see hits you with an attack roll" (srd-raw.txt:13840-13841)', () => {
  it('Uncanny Dodge only against an attacker you can see (13840-13841)', () => {
    const o: Opts = { features: ['w1a-duck'] };
    const w = world(o);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, brute);
    for (let k = 0; k < 6 && w.d.kinds('hitTaken').length === 0; k++) resolveAttack(w.cx, brute, 0, pc, false, -1);
    expect(w.d.kinds('hitTaken')).toEqual([['pass', 'react:w1a-duck']]);
    endTurn(w, brute);
    const w2 = world(o);
    const pc2 = w2.u('pc1');
    addCond(pc2, COND.blinded, 'test:x', -1, -1, { k: 'never' });
    startTurn(w2, w2.u('brute'));
    for (let k = 0; k < 6; k++) resolveAttack(w2.cx, w2.u('brute'), 0, pc2, false, -1);
    expect(evs(w2, 'attack').some((e) => e.hit)).toBe(true);
    expect(w2.d.kinds('hitTaken')).toEqual([]);
  });
});

describe('the turn loop resets the W1 budget fields each turn (sim/fight.ts resetBudget)', () => {
  /** pc1: records the keys of each turn's first decision; on round 1 uses the action Wind (and its free move), later turns strike with the greataxe, then pass. */
  class Loop implements Decider {
    readonly name = 'loop';
    readonly firsts: string[][] = [];
    readonly firstAsks: number[] = [];
    turn = -1;
    used = false;
    decide(v: UnitView, dp: DecisionPoint): number {
      const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
      void v;
      if (dp.k === 'firstAttack') {
        this.firstAsks.push(dp.round);
        return 0;
      }
      if (dp.k === 'moveTo') return 1;
      if (dp.k !== 'turn') return 0;
      if (dp.round !== this.turn) {
        this.turn = dp.round;
        this.used = false;
        this.firsts.push(keys);
      }
      if (dp.round === 1 && !this.used && keys.includes('use:w1a-wind')) {
        this.used = true;
        return keys.indexOf('use:w1a-wind');
      }
      const a = keys.findIndex((k) => k.startsWith('attack:greataxe>'));
      return a >= 0 ? a : 0;
    }
  }

  it('a firstAttack choice is offered on each of its turns, and a free move doesn\'t count as moving on the next turn', async () => {
    const { runFight } = await import('../src/sim/fight.ts');
    const { BaselineDecider } = await import('../src/decide/baseline.ts');
    const kit = { ...KIT, 'w1a-wind': KIT['w1a-wind']!.replace('cost: bonus', 'cost: action') };
    const files: SourceFile[] = [
      ...REPO,
      ...Object.entries(kit).map(([n, text]) => ({ path: `packs/test/features/${n}.yaml`, text })),
      ...Object.entries(MONSTERS).map(([n, text]) => ({ path: `packs/test/monsters/${n}.yaml`, text })),
      { path: 'packs/test/pcs/w1a-pc.yaml', text: PC(['w1a-bold', 'w1a-wind', 'w1a-shift', 'w1a-steady'], 30) },
    ];
    const r0 = loadContent(files);
    if (!r0.content) throw new Error(r0.errors.map(formatDiag).join('\n'));
    const doc = { kind: 'scenario', id: 'w1a-loop', name: 'W1 loop', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 6 }, units: [ME, foe('brute', 'w1a-brute', 'C2')] };
    const r = resolveScenario(doc, 'w1a-loop.yaml', r0.content);
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    const loop = new Loop();
    const ds = r.setup.seats.map((s) => (s.seat === 'pc1' ? loop : new BaselineDecider()));
    runFight(r.setup, 3, 0, ds, null, { audit: true });
    expect(loop.firsts.length).toBeGreaterThanOrEqual(3);
    // Steady Aim (hasntMoved) is open at the start of every turn: last turn's free move was reset.
    for (const keys of loop.firsts) expect(keys).toContain('use:w1a-steady');
    // One firstAttack decision per turn on which it struck (the free move after Wind leaves it in reach or not; it asks at most once a round).
    expect(new Set(loop.firstAsks).size).toBe(loop.firstAsks.length);
    expect(loop.firstAsks.length).toBeGreaterThanOrEqual(2);
    expect(loop.firstAsks).not.toContain(1); // round 1 spent its action on Wind
  });
});
