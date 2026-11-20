// Coverage W1.1, builder B3 (docs/design/w1-plan.md section 7): each W1 greedy term's value in a
// constructed state, named for what it checks (Explain text is W1.2's, read from real decisions).
// The content is synthetic (test: ids, in memory), shaped like the W1 items without being them:
// a sustained form with a per-hit rider and an extend grant (Rage's shape), a first-attack choice
// (Reckless's), a gated first-attack step with an own-turn rider (Frenzy's), a roll-gated rider
// (Sneak Attack's), a self Advantage token with Speed 0 (Steady Aim's), a free move, a drop-to-1
// pool, an endConditions step. Terms that need B1's gate evaluation or B2's key bits to show their
// full effect are checked here only up to the seam (the roll state passed, a plain d20.attack mod).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { DAMAGE_TYPES, damageBit, type CompiledAttack, type CompiledDamage, type CompiledRider, type Gate, type RiderOpt, type Step } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, Legal, LegalKind, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { statsValue, TERM } from '../src/decide/greedy/cond.ts';
import { lastingPerRound, programValue, type VCtx } from '../src/decide/greedy/value.ts';
import { DEFAULT_WEIGHTS, future } from '../src/decide/greedy/weights.ts';
import { dropSafe, riderAttack, selfOnlyOption, typedExtra, w1Kit } from '../src/decide/greedy/w1.ts';
import type { AdvState } from '../src/rolls/rollspec.ts';
import { mean, type Pmf } from '../src/odds/pmf.ts';
import { damagePmf } from '../src/query/odds.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { boundOf, newFx } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { COND, type QueryState, type Unit } from '../src/sim/state.ts';

// P5's seam: the roll state greedy hands the gate check (sim/stats.ts gatesOk) for a gate list with a
// roll-state gate, recorded here; evaluation stays the real one (B1's), so this file reads either way.
const rec = vi.hoisted(() => ({ rolls: [] as (string | undefined)[] }));
vi.mock('../src/sim/stats.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/sim/stats.ts')>();
  const rollGate = (g: Gate): boolean => g.g === 'rollAdv' || g.g === 'rollNotDis' || g.g === 'anyOf';
  return {
    ...orig,
    gatesOk: (st: QueryState | null, u: Unit, when: readonly Gate[] | undefined, target: Unit | null = null, roll?: AdvState) => {
      if (when?.some(rollGate)) rec.rolls.push(roll);
      return orig.gatesOk(st, u, when, target, roll);
    },
  };
});

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

const SRC = 'source: synthetic W1.1 greedy fixture';
const FEATURES: Record<string, string> = {
  // P1, P2, P3, P4: a sustained form (Rage's shape) with Resistance, noCasting/noConcentration, an extend grant and a per-hit rider.
  'w1g-rage': `kind: feature
id: test:w1g-rage
name: W1G Rage
${SRC}
activate: { id: rage, name: Rage, cost: bonus, pool: w1g-rage, root: raging, target: self, do: [{ endConditions: [frightened] }] }
riders:
  - { id: rage-damage, name: Rage Damage, on: hit, filter: { attack: [weapon, unarmed], ability: str }, when: [{ selfHas: raging }], auto: true, do: [{ damage: [{ roll: '2', type: weapon }] }] }
effects:
  - id: raging
    name: Raging
    duration: { until: endOfNextTurn, of: bearer }
    sustain: { by: [attackRoll, enemySave] }
    endsOn: [incapacitated]
    stats: [{ resist: [slashing] }, { noCasting: true }, { noConcentration: true }]
    grants: [{ id: extend, name: Extend, cost: bonus, laterTurns: true, to: owner, do: [{ extendSource: true }] }]
`,
  // P1 as the Rage override is built: the sustained root carries the extend grant and the rider; its benefits sit on a child.
  'w1g-fume': `kind: feature
id: test:w1g-fume
name: W1G Fume
${SRC}
activate: { id: fume, name: Fume, cost: bonus, root: fuming, target: self, do: [{ apply: { effect: fumes, to: self } }] }
riders:
  - { id: fume-damage, name: Fume Damage, on: hit, filter: { attack: [weapon, unarmed], ability: str }, when: [{ selfHas: fuming }], auto: true, do: [{ damage: [{ roll: '2', type: weapon }] }] }
effects:
  - id: fuming
    name: Fuming
    duration: { until: endOfNextTurn, of: bearer }
    sustain: { by: [attackRoll, enemySave] }
    grants: [{ id: extend, name: Extend, cost: bonus, laterTurns: true, to: owner, do: [{ extendSource: true }] }]
  - { id: fumes, name: Fumes, stats: [{ resist: [slashing] }, { noCasting: true }, { noConcentration: true }] }
`,
  // P1 alone: a sustained effect that only gives Resistance (its value is linear in its rounds).
  'w1g-hide': `kind: feature
id: test:w1g-hide
name: W1G Hide
${SRC}
activate: { id: hide, name: Hide, cost: bonus, root: hiding, target: self, do: [{ endConditions: [charmed] }] }
effects:
  - { id: hiding, name: Hiding, duration: { until: endOfNextTurn, of: bearer }, sustain: { by: [attackRoll] }, stats: [{ resist: [slashing] }] }
`,
  // P3: a sustained effect whose only value is a scope-less selfHas rider; and the same rider under a plain 10-round effect.
  'w1g-zeal': `kind: feature
id: test:w1g-zeal
name: W1G Zeal
${SRC}
activate: { id: zeal, name: Zeal, cost: bonus, root: zealous, target: self, do: [{ endConditions: [charmed] }] }
riders:
  - { id: zeal-damage, name: Zeal Damage, on: hit, filter: { attack: [weapon, unarmed] }, when: [{ selfHas: zealous }], auto: true, do: [{ damage: [{ roll: '2', type: weapon }] }] }
effects:
  - { id: zealous, name: Zealous, duration: { until: endOfNextTurn, of: bearer }, sustain: { by: [attackRoll] } }
`,
  'w1g-calm': `kind: feature
id: test:w1g-calm
name: W1G Calm
${SRC}
activate: { id: calm, name: Calm, cost: bonus, do: [{ apply: { effect: calmed, to: self } }] }
riders:
  - { id: calm-damage, name: Calm Damage, on: hit, filter: { attack: [weapon, unarmed] }, when: [{ selfHas: calmed }], auto: true, do: [{ damage: [{ roll: '2', type: slashing }] }] }
effects:
  - { id: calmed, name: Calmed, duration: { rounds: 10 } }
`,
  // P7: a first-attack choice on plain d20.attack (no key bits needed): Advantage on mine, and on attacks against me.
  'w1g-bold': `kind: feature
id: test:w1g-bold
name: W1G Bold
${SRC}
firstAttack: { do: [{ apply: { effect: bold, to: self } }] }
effects:
  - { id: bold, name: Bold, duration: { until: startOfNextTurn, of: bearer }, mods: [{ on: [d20.attack], op: adv }, { on: [d20.attack], side: incoming, op: adv }] }
`,
  // P7 with P3/P10's gated apply: the arming step runs only while surging is up; armed switches on an own-turn rider.
  'w1g-fury': `kind: feature
id: test:w1g-fury
name: W1G Fury
${SRC}
firstAttack: { do: [{ apply: { effect: armed, to: self, when: [{ selfHas: surging }] } }] }
riders:
  - { id: fury-damage, name: Fury Damage, on: hit, oncePerTurn: ownTurn, filter: { attack: [weapon, unarmed] }, when: [{ selfHas: armed }], auto: true, do: [{ damage: [{ roll: '5', type: weapon }] }] }
effects:
  - { id: surging, name: Surging, duration: { rounds: 10 } }
  - { id: armed, name: Armed, duration: { until: endOfThisTurn, of: bearer } }
`,
  // P5: a roll-gated rider (Sneak Attack's shape).
  'w1g-sneak': `kind: feature
id: test:w1g-sneak
name: W1G Sneak
${SRC}
riders:
  - { id: sneak, name: Sneak, on: hit, oncePerTurn: global, filter: { weaponProperty: [finesse, ranged] }, when: [{ anyOf: [[rollAdv], [allyWithin5ftOfTarget, rollNotDis]] }], do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
`,
  // P10: a rider with a self-only option (a free move) and one on the target.
  'w1g-slip': `kind: feature
id: test:w1g-slip
name: W1G Slip
${SRC}
riders:
  - id: slip
    name: Slip
    on: hit
    filter: { attack: [weapon] }
    choose:
      - { id: slip, name: Slip, do: [{ move: { speed: half, noOpportunityAttacks: true } }] }
      - { id: trip, name: Trip, do: [{ condition: { id: prone } }] }
`,
  // P11: Advantage on my next attack roll and Speed 0, both until the end of this turn (Steady Aim's shape).
  'w1g-aim': `kind: feature
id: test:w1g-aim
name: W1G Aim
${SRC}
activate: { id: aim, name: Aim, cost: bonus, target: self, do: [{ apply: { effect: aimed, to: self } }, { apply: { effect: still, to: self } }] }
effects:
  - { id: aimed, name: Aimed, duration: { until: endOfThisTurn, of: bearer }, mods: [{ on: [d20.attack], op: adv, consume: nextRoll }] }
  - { id: still, name: Still, duration: { until: endOfThisTurn, of: bearer }, stats: [{ speed: zero }] }
`,
  // P8.
  'w1g-endure': `kind: feature
id: test:w1g-endure
name: W1G Endure
${SRC}
dropToOne: { pool: w1g-endure }
`,
  // P9: a self activation with a free move appended (Tactical Shift's shape, written in place).
  'w1g-shift': `kind: feature
id: test:w1g-shift
name: W1G Shift
${SRC}
activate: { id: shift, name: Shift, cost: bonus, target: self, do: [{ move: { speed: half, noOpportunityAttacks: true } }] }
`,
};

/** A level-5 PC (PB 3): STR 16 (+3), DEX 14 (+2), AC 14, HP 40, two strikes a turn. */
const pcText = (id: string, features: readonly string[], opt: { speed?: number; cantrips?: string[] } = {}) => `kind: pc
id: test:${id}
name: ${id}
${SRC}
rules: '2024'
level: 5
size: medium
speed: ${opt.speed ?? 30}
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 16, cha: 10 }
hpMax: 40
ac: 14
armor: none
saveProficiencies: [str, con]
extraAttacks: 1
items:
  - { id: charm, name: Charm, kind: focus, focusFor: [kit] }
hands: [charm, null]
weapons:
  - { id: greataxe, name: Greataxe, kind: melee, ability: str, damage: [{ roll: 1d12 + @mod, type: slashing }] }
  - { id: rapier, name: Rapier, kind: melee, ability: finesse, damage: [{ roll: 1d8 + @mod, type: piercing }] }
  - { id: longbow, name: Longbow, kind: ranged, ability: dex, range: [150, 600], damage: [{ roll: 1d8 + @mod, type: piercing }] }
pools:
  - { id: w1g-rage, name: Rage, max: 3, recharge: longRest }
  - { id: w1g-endure, name: Endure, max: 1, recharge: longRest }
${opt.cantrips ? `casting:\n  - { source: kit, ability: wis, list: kit, cantrips: [${opt.cantrips.join(', ')}], prepared: [] }\n` : ''}features: [${features.join(', ')}]
`;

/** A monster: AC, HP, Speed, and one melee attack (to hit, flat damage); `def` adds a defenses line. */
const monster = (id: string, o: { ac?: number; hp?: number; speed?: number; toHit?: number; dmg?: number; def?: string } = {}) => `kind: monster
id: test:${id}
name: ${id}
${SRC}
size: medium
cr: 1
pb: 2
ac: ${o.ac ?? 10}
hp: { average: ${o.hp ?? 200}, formula: '${o.hp ?? 200}' }
speed: { walk: ${o.speed ?? 30} }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 1 }
${o.def ? `${o.def}\n` : ''}attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${o.toHit ?? -20}, damage: [{ roll: '${o.dmg ?? 1}', type: slashing, avg: ${o.dmg ?? 1} }] }
`;

const PCS: Record<string, string> = {
  'w1g-rage': pcText('pc-w1g-rage', ['test:w1g-rage']),
  'w1g-rage-caster': pcText('pc-w1g-rage-caster', ['test:w1g-rage'], { cantrips: ['srd:sacred-flame'] }),
  'w1g-fume': pcText('pc-w1g-fume', ['test:w1g-fume']),
  'w1g-hide': pcText('pc-w1g-hide', ['test:w1g-hide']),
  'w1g-zeal': pcText('pc-w1g-zeal', ['test:w1g-zeal']),
  'w1g-calm': pcText('pc-w1g-calm', ['test:w1g-calm']),
  'w1g-bold': pcText('pc-w1g-bold', ['test:w1g-bold']),
  'w1g-fury': pcText('pc-w1g-fury', ['test:w1g-fury']),
  'w1g-sneak': pcText('pc-w1g-sneak', ['test:w1g-sneak']),
  'w1g-slip': pcText('pc-w1g-slip', ['test:w1g-slip']),
  'w1g-aim': pcText('pc-w1g-aim', ['test:w1g-aim']),
  'w1g-endure': pcText('pc-w1g-endure', ['test:w1g-endure']),
  'w1g-shift': pcText('pc-w1g-shift', ['test:w1g-shift']),
  'w1g-shift-35': pcText('pc-w1g-shift-35', ['test:w1g-shift'], { speed: 35 }),
  'w1g-shift-40': pcText('pc-w1g-shift-40', ['test:w1g-shift'], { speed: 40 }),
  'w1g-shift-5': pcText('pc-w1g-shift-5', ['test:w1g-shift'], { speed: 5 }),
  'w1g-plain': pcText('pc-w1g-plain', []),
};
const MONSTERS: Record<string, string> = {
  // Harmless and sturdy: it can't hurt anyone (to hit -20, 1 damage).
  'w1g-dummy': monster('w1g-dummy'),
  'w1g-tin': monster('w1g-tin', { def: 'resist: [slashing]' }),
  'w1g-stone': monster('w1g-stone', { def: 'resist: [bludgeoning]' }),
  'w1g-twig': monster('w1g-twig', { hp: 1 }),
  // Hits hard and often; hard to hit back (AC 25).
  'w1g-brute': monster('w1g-brute', { ac: 25, toHit: 10, dmg: 40 }),
  // Hits hard but barely walks (5 ft: it threatens 10 ft) or walks 15 (threatens 20 ft).
  'w1g-slug': monster('w1g-slug', { speed: 5, toHit: 10, dmg: 20 }),
  'w1g-crab': monster('w1g-crab', { speed: 15, toHit: 10, dmg: 20 }),
};

function files(): SourceFile[] {
  return [
    ...REPO,
    ...Object.entries(FEATURES).map(([n, text]) => ({ path: `packs/test/features/${n}.yaml`, text })),
    ...Object.entries(PCS).map(([n, text]) => ({ path: `packs/test/pcs/pc-${n}.yaml`, text })),
    ...Object.entries(MONSTERS).map(([n, text]) => ({ path: `packs/test/monsters/${n}.yaml`, text })),
  ];
}
const LOADED = loadContent(files());
const CONTENT = (() => {
  if (!LOADED.content) throw new Error(LOADED.errors.map(formatDiag).join('\n'));
  return LOADED.content;
})();

type Seat = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const PC = (use: string, at = 'D3'): Seat => ({ seat: 'pc1', team: 'party', use: `test:pc-${use}`, at });
const FOE = (use: string, at = 'E3', seat = 'foe1'): Seat => ({ seat, team: 'enemies', use: `test:${use}`, at });

/** A constructed state (no fight run), every seat greedy, and the PC's decider primed for a decision. */
function scene(units: Seat[]) {
  const doc = {
    kind: 'scenario', id: 'w1g', name: 'W1 greedy', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 6 },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'w1g.yaml', CONTENT);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  const ds = res.setup.seats.map(() => new GreedyDecider());
  const cx = createContext(res.setup, 1, 0, ds, null);
  applyPassives(cx, -1);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const pc = u('pc1');
  /** Begins `pc`'s turn (its budget fresh). */
  const begin = (patch: Partial<Unit['b']> = {}) => {
    cx.st.active = pc.idx;
    cx.st.turnIdx++;
    pc.turns++;
    Object.assign(pc.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: pc.tpl.speedFt, atkActive: false, movedFt: 0, rolls: 0, freeFt: 0, ...patch });
  };
  const d = ds[pc.idx]! as unknown as Internals;
  const view = cx.views[pc.idx]!;
  /** Primes the decider for a fresh decision (its per-decision memos cleared) and returns its valuation context. */
  const peek = (): VCtx => {
    const dp: DecisionPoint = { k: 'orderTriggers', who: pc.idx, at: 0, round: 1, cause: -1, legal: { n: 0, items: [] }, keyOf: () => '' };
    ds[pc.idx]!.decide(view, dp);
    return d.vctxFor(cx.st, pc, view);
  };
  return { cx, st: cx.st, u, pc, begin, d, view, peek, g: ds[pc.idx]! };
}

/** The decider internals these tests read (private in greedy.ts). */
interface Internals {
  vctxFor(st: QueryState, me: Unit, view: UnitView): VCtx;
  useValue(v: VCtx, me: Unit, l: Legal, from: number): number;
  endCost(st: QueryState, me: Unit, cell: number): number;
  oaDropP(st: QueryState, me: Unit, k: number): number;
  concLeft(st: QueryState, me: Unit): number;
  strikeAtk(view: UnitView, me: Unit, atk: CompiledAttack, t: Unit, from: number): number;
  riderOptValue(view: UnitView, me: Unit, r: CompiledRider, o: RiderOpt, t: Unit, atk: CompiledAttack | null, crit: boolean): number;
  riderOnValue(view: UnitView, me: Unit, ri: number, t: Unit, ignoreSelfHas: boolean): number;
  advGain(view: UnitView, me: Unit, from: number): number;
  dmgPmf(parts: readonly CompiledDamage[], t: Unit, crit: boolean, adv: boolean, half: boolean): Pmf;
  lastAdv: AdvState;
  forceAdv: boolean;
}

const legal = (k: LegalKind, o: Partial<Legal> = {}): Legal => ({ k, atk: -1, target: -1, cell: -1, ft: 0, provokes: 0, parity: 0, opt: -1, lvl: 0, aux: 0, fx: -1, hazard: 0, ...o });
const fxIdx = (u: Unit, id: string): number => {
  const i = u.tpl.effects.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`no effect ${id}`);
  return i;
};
const featIdx = (u: Unit, id: string): number => u.tpl.features.findIndex((f) => f.id === id);
const atkOf = (u: Unit, local: string): CompiledAttack => u.tpl.attacks.find((a) => a.local === local)!;
const applySelf = (fx: number): Step[] => [{ k: 'apply', fx, to: 'self' }];
/** A live effect of `u`'s template `tpl` that `u` owns and bears. */
const live = (cx: ReturnType<typeof scene>['cx'], u: Unit, tpl: number, until: Parameters<typeof newFx>[1]['until'] = { k: 'never' }) =>
  newFx(cx, { tpl, owner: u.idx, bearer: u.idx, parent: -1, param: -1, srcItem: -1, until, cause: -1 }).id;
const cellOf = (st: QueryState, name: string): number => {
  const w = st.setup.w;
  return (Number(name.slice(1)) - 1) * w + (name.charCodeAt(0) - 65);
};

describe('W1 greedy: only templates with a W1 field get the new terms (C3)', () => {
  it('w1Kit marks the W1 shapes and nothing else; dropSafe needs a live pool', () => {
    const s = scene([PC('w1g-plain'), FOE('w1g-dummy')]);
    expect(w1Kit(s.pc.tpl)).toBe(false);
    for (const id of ['w1g-rage', 'w1g-bold', 'w1g-aim', 'w1g-endure', 'w1g-shift', 'w1g-slip', 'w1g-fury']) {
      const t = scene([PC(id), FOE('w1g-dummy')]).pc.tpl;
      expect(w1Kit(t), id).toBe(true);
    }
    expect(dropSafe(s.pc)).toBe(false);
    // A VCtx without the W1 closures for a plain template.
    const v = s.peek();
    expect(v.freeMove).toBeUndefined();
    expect(v.castMargin).toBeUndefined();
  });
});

describe('W1 P1: a sustained effect (Rage, srd-raw.txt:4982-4993)', () => {
  it('counts as lasting the horizon, discounted only by P(I stay up), not one round', () => {
    const s = scene([PC('w1g-hide'), FOE('w1g-brute')]);
    const v = s.peek();
    const fx = fxIdx(s.pc, 'test:w1g-hide/hiding');
    const full = programValue(v, applySelf(fx), s.pc.cell, { parentRounds: 100 });
    const one = programValue({ ...v, mute: TERM.sustain }, applySelf(fx), s.pc.cell, { parentRounds: 100 });
    expect(one).toBeGreaterThan(0); // Resistance to the brute's slashing
    const stay = v.stay(s.pc.cell, false);
    expect(stay).toBeLessThan(1);
    expect(full / one).toBeCloseTo(future(DEFAULT_WEIGHTS, 100, stay) / future(DEFAULT_WEIGHTS, 1, 1), 9);
  });

  it('the activation counts its sustained root: the form itself is what it is for', () => {
    const s = scene([PC('w1g-hide'), FOE('w1g-brute')]);
    const v = s.peek();
    const f = featIdx(s.pc, 'test:w1g-hide');
    const use = s.d.useValue(v, s.pc, legal('use', { opt: f, aux: 0 }), s.pc.cell);
    const root = programValue(v, applySelf(fxIdx(s.pc, 'test:w1g-hide/hiding')), s.pc.cell, { parentRounds: 100 });
    expect(root).toBeGreaterThan(0);
    // endConditions: [charmed] ends nothing here; the activation costs no pool.
    expect(use).toBeCloseTo(root, 9);
  });

  it('the extend grant keeps it a round only when it would end at the end of this turn and no attack roll is made yet (4990)', () => {
    const s = scene([PC('w1g-rage'), FOE('w1g-brute')]);
    s.begin();
    s.begin(); // turn 2: Rage from turn 1 ends at the end of this turn unless extended
    const root = fxIdx(s.pc, 'test:w1g-rage/raging');
    const id = live(s.cx, s.pc, root, { k: 'turnEnd', unit: s.pc.idx, after: s.pc.turns - 1 });
    const grant = legal('use', { fx: id, opt: 0 });
    let v = s.peek();
    const keep = lastingPerRound(v, s.st.fx[id]!, boundOf(s.st, s.st.fx[id]!));
    expect(keep).toBeGreaterThan(0);
    expect(s.d.useValue(v, s.pc, grant, s.pc.cell)).toBeCloseTo(keep, 9);
    // Already extended by an attack roll this turn: nothing to keep.
    s.pc.b.rolls = 1;
    v = s.peek();
    expect(s.d.useValue(v, s.pc, grant, s.pc.cell)).toBe(0);
    s.pc.b.rolls = 0;
    // Lasting to the end of my next turn already (re-anchored this turn): nothing to keep.
    s.st.fx[id]!.until = { k: 'turnEnd', unit: s.pc.idx, after: s.pc.turns };
    v = s.peek();
    expect(s.d.useValue(v, s.pc, grant, s.pc.cell)).toBe(0);
  });
});

describe('W1 P1, the Rage override\'s shape: benefits on a child of the sustained root', () => {
  it('the activation is worth its child (over the horizon) plus the root (its per-hit rider)', () => {
    const s = scene([PC('w1g-fume'), FOE('w1g-brute')]);
    const v = s.peek();
    const use = s.d.useValue(v, s.pc, legal('use', { opt: featIdx(s.pc, 'test:w1g-fume'), aux: 0 }), s.pc.cell);
    const child = programValue(v, applySelf(fxIdx(s.pc, 'test:w1g-fume/fumes')), s.pc.cell, { parentRounds: 100 });
    const root = programValue(v, applySelf(fxIdx(s.pc, 'test:w1g-fume/fuming')), s.pc.cell, { parentRounds: 100 });
    expect(child).toBeGreaterThan(0);
    expect(root).toBeGreaterThan(0);
    expect(use).toBeCloseTo(child + root, 9);
  });

  it('extending keeps the root and every live child under it for a round', () => {
    const s = scene([PC('w1g-fume'), FOE('w1g-brute')]);
    s.begin();
    s.begin();
    const rootId = live(s.cx, s.pc, fxIdx(s.pc, 'test:w1g-fume/fuming'), { k: 'turnEnd', unit: s.pc.idx, after: s.pc.turns - 1 });
    const childId = newFx(s.cx, { tpl: fxIdx(s.pc, 'test:w1g-fume/fumes'), owner: s.pc.idx, bearer: s.pc.idx, parent: rootId, param: -1, srcItem: -1, until: { k: 'effect', effect: rootId }, cause: -1 }).id;
    const v = s.peek();
    const per = (id: number) => lastingPerRound(v, s.st.fx[id]!, boundOf(s.st, s.st.fx[id]!));
    expect(per(childId)).toBeGreaterThan(0);
    expect(s.d.useValue(v, s.pc, legal('use', { fx: rootId, opt: 0 }), s.pc.cell)).toBeCloseTo(per(rootId) + per(childId), 9);
  });
});

describe('W1 P2: noConcentration and noCasting (srd-raw.txt:4980-4981)', () => {
  it('cost the concentration they end and the best cast over the best other option, on me only', () => {
    const s = scene([PC('w1g-rage'), FOE('w1g-brute')]);
    const v = s.peek();
    const te = s.pc.tpl.effects[fxIdx(s.pc, 'test:w1g-rage/raging')]!;
    const vv: VCtx = { ...v, concLeft: () => 7, castMargin: () => 3 };
    s.pc.conc = 0; // concentrating (statsValue reads only conc >= 0)
    const both = statsValue(vv, te, s.pc, 1);
    const neither = statsValue({ ...vv, mute: TERM.noConc | TERM.noCast }, te, s.pc, 1);
    expect(both - neither).toBeCloseTo(-10, 9);
    s.pc.conc = -1;
    // Not concentrating: noConcentration costs nothing.
    expect(statsValue(vv, te, s.pc, 1) - statsValue({ ...vv, mute: TERM.noConc }, te, s.pc, 1)).toBeCloseTo(0, 9);
    // On another creature the stats cost me nothing (no cast of mine is lost).
    const foe = s.u('foe1');
    expect(statsValue(vv, te, foe, 1)).toBeCloseTo(statsValue({ ...vv, mute: TERM.noConc | TERM.noCast }, te, foe, 1), 9);
  });

  it('the closures: concLeft is the decider\'s; the cast margin is the best cast over my best strike from here', () => {
    // The brute is 25 ft off: no weapon reaches it, Sacred Flame does.
    const s = scene([PC('w1g-rage-caster', 'B3'), FOE('w1g-brute', 'G3')]);
    const v = s.peek();
    expect(v.concLeft!()).toBe(s.d.concLeft(s.st, s.pc));
    expect(v.castMargin!()).toBeGreaterThan(0);
    // No spells: no margin.
    const t = scene([PC('w1g-rage', 'B3'), FOE('w1g-brute', 'G3')]);
    expect(t.peek().castMargin!()).toBe(0);
  });
});

describe('W1 P3: riders a sustained effect switches on count per expected hit', () => {
  it("Rage's value counts Rage Damage per expected hit, not once (strikes x P(hit) against the floor)", () => {
    const s = scene([PC('w1g-zeal'), FOE('w1g-dummy')]);
    const v = s.peek();
    const foe = s.u('foe1');
    const ri = 0; // its one rider
    // Greataxe +6 against AC 10: 17 of 20; two strikes.
    expect(v.hitsPerRound!(ri, foe)).toBeCloseTo(2 * 0.85, 9);
    const fx = fxIdx(s.pc, 'test:w1g-zeal/zealous');
    const full = programValue(v, applySelf(fx), s.pc.cell, { parentRounds: 100 });
    const floor = programValue({ ...v, mute: TERM.perHit }, applySelf(fx), s.pc.cell, { parentRounds: 100 });
    expect(floor).toBeGreaterThan(0);
    expect(full / floor).toBeCloseTo(1.7 / 0.6, 9);
  });

  it('a selfHas rider under an effect that isn\'t sustained keeps the once-a-round floor (R3)', () => {
    const s = scene([PC('w1g-calm'), FOE('w1g-dummy')]);
    const v = s.peek();
    const fx = fxIdx(s.pc, 'test:w1g-calm/calmed');
    const full = programValue(v, applySelf(fx), s.pc.cell, { parentRounds: 100 });
    expect(full).toBeGreaterThan(0);
    expect(programValue({ ...v, mute: TERM.perHit }, applySelf(fx), s.pc.cell, { parentRounds: 100 })).toBe(full);
  });
});

describe('W1 P4: rider damage of the attack\'s type', () => {
  it('takes the type of the attack it rides on (13739), one shared copy per type; with no attack the part is left out', () => {
    const s = scene([PC('w1g-zeal'), FOE('w1g-tin')]);
    const foe = s.u('foe1');
    const r = s.pc.tpl.riders![0]!;
    const extra = r.opts[0]!.extra!;
    expect(extra[0]!.asAttack).toBe(true);
    const axe = typedExtra(s.st, s.pc, foe, atkOf(s.pc, 'greataxe'), extra);
    expect(axe[0]!.type).toBe(DAMAGE_TYPES.indexOf('slashing'));
    expect(typedExtra(s.st, s.pc, foe, atkOf(s.pc, 'greataxe'), extra)).toBe(axe);
    expect(typedExtra(s.st, s.pc, foe, atkOf(s.pc, 'rapier'), extra)[0]!.type).toBe(DAMAGE_TYPES.indexOf('piercing'));
    expect(typedExtra(s.st, s.pc, foe, null, extra)).toEqual([]);
    // A part with its own type is returned as it was (every existing rider).
    const plain = scene([PC('w1g-calm'), FOE('w1g-tin')]);
    const pe = plain.pc.tpl.riders![0]!.opts[0]!.extra!;
    expect(typedExtra(plain.st, plain.pc, foe, atkOf(plain.pc, 'greataxe'), pe)).toBe(pe);
    // With no attack known, the rider's own best attack gives the type.
    expect(riderAttack(s.pc.tpl, 0)).not.toBeNull();
  });

  it('an Unarmed Strike\'s type is the one a damageType stat swaps in (5177-5178)', () => {
    const s = scene([PC('w1g-zeal'), FOE('w1g-stone')]);
    const foe = s.u('foe1');
    const extra = s.pc.tpl.riders![0]!.opts[0]!.extra!;
    const fist = s.pc.tpl.attacks.find((a) => a.unarmed)!;
    expect(typedExtra(s.st, s.pc, foe, fist, extra)[0]!.type).toBe(DAMAGE_TYPES.indexOf('bludgeoning'));
    const radiant = DAMAGE_TYPES.indexOf('radiant');
    const swapped: Unit = { ...s.pc, stats: [{ s: { k: 'damageType', type: radiant, on: 'unarmed' }, fx: -1 }] };
    expect(typedExtra(s.st, swapped, foe, fist, extra)[0]!.type).toBe(radiant);
  });

  it('a resistant target takes the typed rider damage halved, so the rider is worth less', () => {
    const tin = scene([PC('w1g-zeal'), FOE('w1g-tin')]);
    const dummy = scene([PC('w1g-zeal'), FOE('w1g-dummy')]);
    const val = (s: ReturnType<typeof scene>) => {
      s.peek();
      const r = s.pc.tpl.riders![0]!;
      return s.d.riderOptValue(s.view, s.pc, r, r.opts[0]!, s.u('foe1'), atkOf(s.pc, 'greataxe'), false);
    };
    expect(val(tin)).toBeGreaterThan(0);
    expect(val(tin)).toBeLessThan(val(dummy));
  });
});

describe('W1 P5: the roll state reaches the rider gates', () => {
  it('a strike keeps its resolved Advantage state; forced Advantage cancels against Disadvantage (1056-1060)', () => {
    const s = scene([PC('w1g-sneak'), FOE('w1g-dummy')]);
    s.peek();
    const foe = s.u('foe1');
    s.d.strikeAtk(s.view, s.pc, atkOf(s.pc, 'rapier'), foe, s.pc.cell);
    expect(s.d.lastAdv).toBe('none');
    s.d.forceAdv = true;
    s.d.strikeAtk(s.view, s.pc, atkOf(s.pc, 'rapier'), foe, s.pc.cell);
    expect(s.d.lastAdv).toBe('adv');
    // A Longbow with a hostile within 5 ft has Disadvantage: the added Advantage cancels it.
    s.d.strikeAtk(s.view, s.pc, atkOf(s.pc, 'longbow'), foe, s.pc.cell);
    expect(s.d.lastAdv).toBe('none');
    s.d.forceAdv = false;
  });

  it('freeRiders hands each strike\'s roll state to the gates; riderOnValue a straight roll', () => {
    const s = scene([PC('w1g-sneak'), FOE('w1g-dummy')]);
    s.begin(); // W1.2: advGain is 0 with no attack roll left this turn, so the Attack action is open
    s.peek();
    rec.rolls.length = 0;
    s.d.advGain(s.view, s.pc, s.pc.cell); // each strike plain, then with Advantage
    expect(rec.rolls).toContain('none');
    expect(rec.rolls).toContain('adv');
    rec.rolls.length = 0;
    s.d.riderOnValue(s.view, s.pc, 0, s.u('foe1'), false);
    expect(rec.rolls).toEqual(['none']);
  });
});

describe('W1 P7: the firstAttack decision (Reckless Attack, srd-raw.txt:5021-5022, 5028-5029)', () => {
  const dpOf = (s: ReturnType<typeof scene>, feature: string): DecisionPoint => {
    const items = [legal('pass'), legal('pick', { opt: featIdx(s.pc, feature) })];
    const keys = ['pass', `first:${feature}`];
    return { k: 'firstAttack', who: s.pc.idx, at: 5, round: 1, cause: -1, legal: { n: 2, items }, keyOf: (i) => keys[i]! };
  };

  it('takes it when my Advantage is worth more than theirs, with its Explain row', () => {
    const s = scene([PC('w1g-bold'), FOE('w1g-dummy')]);
    s.begin({ atkActive: true, action: 0 });
    const recs: ExplainRecord[] = [];
    s.g.explainTo((r) => recs.push(r));
    expect(s.g.decide(s.view, dpOf(s, 'test:w1g-bold'))).toBe(1);
    const row = recs.at(-1)!.top.find((t) => t.key === 'first:test:w1g-bold')!;
    expect(row.ev).toBeGreaterThan(0);
    expect(row.parts[0]!.term).toMatch(/^W1G Bold: my Advantage \+\d+\.\d\d, theirs -\d+\.\d\d$/);
  });

  it('greedy declines it when the incoming damage outweighs the gain', () => {
    const s = scene([PC('w1g-bold'), FOE('w1g-brute')]);
    s.begin({ atkActive: true, action: 0 });
    expect(s.g.decide(s.view, dpOf(s, 'test:w1g-bold'))).toBe(0);
  });

  it('a gated step runs only while its gate holds; this turn still counts its own-turn rider before the first roll', () => {
    const s = scene([PC('w1g-fury'), FOE('w1g-dummy')]);
    s.begin({ atkActive: true, action: 0 }); // the Attack action is under way, no roll made yet
    const dp = dpOf(s, 'test:w1g-fury');
    expect(s.g.decide(s.view, dp)).toBe(0); // not surging: the arming step doesn't run
    live(s.cx, s.pc, fxIdx(s.pc, 'test:w1g-fury/surging'));
    expect(s.g.decide(s.view, dp)).toBe(1);
    // The same program valued as any other walk on a turn whose action is spent: this turn wouldn't count.
    const v = s.peek();
    const steps = s.pc.tpl.features[featIdx(s.pc, 'test:w1g-fury')]!.firstAttack!.steps;
    expect(programValue(v, steps, s.pc.cell, { targets: [s.pc], parentRounds: 100 })).toBe(0);
    expect(programValue({ ...v, beforeFirstRoll: true }, steps, s.pc.cell, { targets: [s.pc], parentRounds: 100 })).toBeGreaterThan(0);
  });
});

describe('W1 P8: a live drop-to-1 pool (srd-raw.txt:19928-19931)', () => {
  it('treats my own next drop as not happening: no drop risk in the end cost, no opportunity-attack drop', () => {
    const s = scene([PC('w1g-endure'), FOE('w1g-brute')]);
    const pool = s.pc.tpl.features.find((f) => f.dropToOne)!.dropToOne!.pool;
    s.peek();
    expect(dropSafe(s.pc)).toBe(true);
    const safe = s.d.endCost(s.st, s.pc, s.pc.cell);
    expect(s.d.oaDropP(s.st, s.pc, 1)).toBe(0);
    expect(s.peek().stay(s.pc.cell, false)).toBe(1);
    s.pc.res[pool] = 0;
    const v = s.peek();
    expect(dropSafe(s.pc)).toBe(false);
    expect(s.d.endCost(s.st, s.pc, s.pc.cell)).toBeGreaterThan(safe);
    expect(s.d.oaDropP(s.st, s.pc, 1)).toBeGreaterThan(0);
    expect(v.stay(s.pc.cell, false)).toBeLessThan(1);
  });
});

describe('W1 P9: the free move (Tactical Shift 10661-10663, Withdraw 13835-13836)', () => {
  it('is worth the end cost it takes off: half Speed, out of a slow foe\'s reach', () => {
    const s = scene([PC('w1g-shift'), FOE('w1g-slug')]); // the slug threatens 10 ft; 15 ft west gets out
    const v = s.peek();
    const here = s.d.endCost(s.st, s.pc, s.pc.cell);
    expect(here).toBeGreaterThan(0);
    expect(v.freeMove!(s.pc.cell)).toBeCloseTo(here, 9);
    // The activation that carries it.
    const use = s.d.useValue(v, s.pc, legal('use', { opt: featIdx(s.pc, 'test:w1g-shift'), aux: 0 }), s.pc.cell);
    expect(use).toBeCloseTo(here, 9);
  });

  it('half of a 35-ft Speed is 15 ft (rounded down to 5 ft); half of 5 ft is none', () => {
    // The crab threatens 20 ft: from 5 ft off, 15 ft of free move leaves me at 20 ft (still in reach), 20 ft gets out.
    const s35 = scene([PC('w1g-shift-35', 'F3'), FOE('w1g-crab', 'G3')]);
    expect(s35.peek().freeMove!(s35.pc.cell)).toBe(0);
    const s40 = scene([PC('w1g-shift-40', 'F3'), FOE('w1g-crab', 'G3')]);
    expect(s40.peek().freeMove!(s40.pc.cell)).toBeGreaterThan(0);
    const s5 = scene([PC('w1g-shift-5'), FOE('w1g-slug')]);
    expect(s5.peek().freeMove!(s5.pc.cell)).toBe(0);
  });

  it('the moveTo decision leaves reach when no strike is left, and stays to strike', () => {
    const s = scene([PC('w1g-shift'), FOE('w1g-slug')]);
    s.begin({ action: 0, atkActive: false });
    const cells = ['C3', 'A3']; // 5 ft (still in reach) and 15 ft west
    const items = [legal('pass'), ...cells.map((c, k) => legal('move', { cell: cellOf(s.st, c), ft: 5 + 10 * k }))];
    const keys = ['pass', ...cells.map((c) => `moveTo:${c}`)];
    const dp: DecisionPoint = { k: 'moveTo', who: s.pc.idx, at: 7, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    const recs: ExplainRecord[] = [];
    s.g.explainTo((r) => recs.push(r));
    expect(keys[s.g.decide(s.view, dp)]).toBe('moveTo:A3');
    expect(recs.at(-1)!.top[0]!.parts[0]!.term).toMatch(/^free move to A3: -\d+\.\d\d exposure/);
    // A harmless foe in reach and my Attack action to come: stay and strike.
    const t = scene([PC('w1g-shift'), FOE('w1g-dummy')]);
    t.begin();
    const items2 = [legal('pass'), legal('move', { cell: cellOf(t.st, 'A3'), ft: 15 })];
    const dp2: DecisionPoint = { ...dp, who: t.pc.idx, legal: { n: 2, items: items2 }, keyOf: (i) => ['pass', 'moveTo:A3'][i]! };
    expect(t.g.decide(t.view, dp2)).toBe(0);
  });
});

describe('W1 P10: a rider option that acts on me alone outlives its target (13817)', () => {
  it('Withdraw-like: the free move counts in full after a killing hit; an option on the target doesn\'t', () => {
    const s = scene([PC('w1g-slip'), FOE('w1g-twig'), FOE('w1g-slug', 'D4', 'foe2')]);
    const v = s.peek();
    const r = s.pc.tpl.riders![0]!;
    const twig = s.u('foe1');
    const [slip, trip] = [r.opts.find((o) => o.local === 'slip')!, r.opts.find((o) => o.local === 'trip')!];
    expect(selfOnlyOption(slip)).toBe(true);
    expect(selfOnlyOption(trip)).toBe(false);
    const axe = atkOf(s.pc, 'greataxe'); // it always drops a 1-HP twig
    const move = v.freeMove!(s.pc.cell);
    expect(move).toBeGreaterThan(0);
    expect(s.d.riderOptValue(s.view, s.pc, r, slip, twig, axe, false)).toBeCloseTo(move, 9);
    expect(s.d.riderOptValue(s.view, s.pc, r, trip, twig, axe, false)).toBe(0);
  });
});

describe('W1 P11', () => {
  it('endConditions: ending Frightened on me is worth what it costs me; nothing when I\'m not (5183-5184)', () => {
    const s = scene([PC('w1g-rage'), FOE('w1g-dummy')]);
    const steps: Step[] = [{ k: 'endConditions', bits: COND.frightened | COND.charmed }];
    let v = s.peek();
    expect(programValue(v, steps, s.pc.cell)).toBe(0);
    s.pc.condMask |= COND.frightened;
    (s.pc.conds as unknown as object[]).push({ bit: COND.frightened, via: 'test:fear', src: s.u('foe1').idx, cause: -1, until: { k: 'never' } });
    v = s.peek();
    const val = programValue(v, steps, s.pc.cell);
    expect(val).toBeGreaterThan(0);
    expect(programValue({ ...v, mute: TERM.endCond }, steps, s.pc.cell)).toBe(0);
  });

  it('a self Advantage token on my next attack roll is worth my best strike\'s gain with it (13790-13791)', () => {
    const s = scene([PC('w1g-aim', 'B3'), FOE('w1g-dummy', 'H3')]); // 30 ft: the Longbow
    s.begin();
    const v = s.peek();
    const gain = v.advGain!(s.pc.cell);
    expect(gain).toBeGreaterThan(0);
    const aimed = applySelf(fxIdx(s.pc, 'test:w1g-aim/aimed'));
    expect(programValue(v, aimed, s.pc.cell)).toBeCloseTo(gain, 9);
    expect(programValue({ ...v, mute: TERM.selfAdv }, aimed, s.pc.cell)).toBe(0);
  });

  it('an endOfThisTurn effect counts one round', () => {
    const s = scene([PC('w1g-aim'), FOE('w1g-brute')]);
    const te = s.pc.tpl.effects[fxIdx(s.pc, 'test:w1g-aim/still')]!;
    expect(te.dur).toEqual({ k: 'untilTurn', edge: 'end', of: 'bearer', thisTurn: true });
    const v = s.peek();
    // Speed 0 on me for one round against a foe already in reach: it changes neither figure.
    expect(programValue(v, applySelf(fxIdx(s.pc, 'test:w1g-aim/still')), s.pc.cell)).toBeCloseTo(0, 9);
  });
});

describe('W1 review: a defender\'s live defense stats are read now, not from the per-fight template cache', () => {
  /** Primes decider `g` for a fresh decision on the PC's view (its per-decision memos cleared). */
  const prime = (s: ReturnType<typeof scene>, g: GreedyDecider) =>
    g.decide(s.view, { k: 'orderTriggers', who: s.pc.idx, at: 0, round: 1, cause: -1, legal: { n: 0, items: [] }, keyOf: () => '' });
  const slashing = DAMAGE_TYPES.indexOf('slashing');
  const resisting = (u: Unit) => ((u as { stats: Unit['stats'] }).stats = [{ s: { k: 'resist', mask: damageBit(slashing) }, fx: -1 }]);
  const plainStats = (u: Unit) => ((u as { stats: Unit['stats'] }).stats = []);

  it('strikeAtk: a target that gains Resistance mid-fight (Rage) is valued resisted, and unresisted again after, as a fresh decider values it', () => {
    const s = scene([PC('w1g-plain'), FOE('w1g-dummy')]);
    s.begin();
    const foe = s.u('foe1');
    const axe = atkOf(s.pc, 'greataxe'); // slashing
    const value = (g: GreedyDecider) => {
      prime(s, g);
      return (g as unknown as Internals).strikeAtk(s.view, s.pc, axe, foe, s.pc.cell);
    };
    const before = value(s.g);
    resisting(foe);
    const during = value(s.g);
    expect(during).toBeLessThan(before);
    expect(during).toBe(value(new GreedyDecider()));
    plainStats(foe);
    expect(value(s.g)).toBe(before);
    // The reverse order: a decider whose first look came while it resisted.
    const g = new GreedyDecider();
    resisting(foe);
    expect(value(g)).toBe(during);
    plainStats(foe);
    expect(value(g)).toBe(before);
  });

  it('dmgPmf (a program\'s damage, VCtx.dmg): the same, halved damage included', () => {
    const s = scene([PC('w1g-plain'), FOE('w1g-dummy')]);
    s.begin();
    const foe = s.u('foe1');
    const parts = atkOf(s.pc, 'greataxe').damage;
    for (const half of [false, true]) {
      const g = new GreedyDecider();
      prime(s, g);
      const d = g as unknown as Internals;
      plainStats(foe);
      const plain = mean(d.dmgPmf(parts, foe, false, false, half));
      resisting(foe);
      const resisted = mean(d.dmgPmf(parts, foe, false, false, half));
      expect(resisted).toBeCloseTo(mean(damagePmf(parts, foe, false, false, half)), 12);
      expect(resisted).toBeLessThan(plain);
      plainStats(foe);
      expect(mean(d.dmgPmf(parts, foe, false, false, half))).toBe(plain);
    }
  });
});
