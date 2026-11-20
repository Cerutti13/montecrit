// Coverage W1.0 (docs/design/w1-plan.md section 7, "Shapes, stubs and the inertness net"): every
// W1 schema field (P1-P11) validates and compiles into the shape the W1.1 builders read, and only
// when content uses it (C3); a qualified selfHas gate binds across features, or to -1 when the
// character lacks the feature; `augments` appends at PC compile; the two new decision kinds list
// pass first and every built-in decider declines them by default; the two new RuleFlags. The
// fixtures are synthetic stand-ins (test: ids, in memory), never the SRD items themselves.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { RK } from '../src/content/rollkeys.ts';
import { SUSTAIN, type CompiledTemplate, type Content, type Step } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { BaselineDecider } from '../src/decide/baseline.ts';
import type { DecisionKind, DecisionPoint, Legal, LegalKind, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { JournalCursor, JournalDecider } from '../src/decide/journal.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { assertImplemented, DEFAULT_FLAGS, describeFlags, FLAG_INFO, FLAG_KEYS, hashedFlags, trimLateFlags, PRE_AREA_FLAG_COUNT, PRE_E_FLAG_COUNT, PRE_W1_FLAG_COUNT } from '../src/rules/flags.ts';
import { createContext } from '../src/sim/fight.ts';
import { COND, newBudget } from '../src/sim/state.ts';
import { canonicalJson } from '../src/util/canon.ts';
import { hash64 } from '../src/util/hash.ts';
import { DUMMY, setup } from './helpers/build.ts';

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

const SRC = 'source: synthetic W1.0 fixture';
/** Synthetic stand-ins, one per W1 shape (named for the SRD item whose shape each borrows, never the item). */
const FEATURES: Record<string, string> = {
  // P1, P2, P3 (local selfHas), P4, P11 (notHeavyArmor, endConditions): a Rage-shaped form.
  'w1-surge': `kind: feature
id: test:w1-surge
name: W1 Surge
${SRC}
activate: { id: surge, name: Surge, cost: bonus, pool: w1-surge, root: surging, when: [notHeavyArmor], target: self, do: [{ endConditions: [frightened] }] }
riders:
  - { id: surge-damage, name: Surge Damage, on: hit, filter: { attack: [weapon, unarmed], ability: str }, when: [{ selfHas: surging }], auto: true, do: [{ damage: [{ roll: '2', type: weapon }] }] }
effects:
  - id: surging
    name: Surging
    duration: { until: endOfNextTurn, of: bearer }
    sustain: { by: [attackRoll, enemySave] }
    endsOn: [incapacitated]
    stats: [{ resist: [slashing] }, { noCasting: true }, { noConcentration: true }]
    grants: [{ id: extend, name: Extend, cost: bonus, laterTurns: true, to: owner, do: [{ extendSource: true }] }]
`,
  // P7: a first-attack choice whose effect names d20.attack.str (so the PC's weapon attacks get key bits).
  'w1-bold': `kind: feature
id: test:w1-bold
name: W1 Bold
${SRC}
firstAttack: { do: [{ apply: { effect: bold, to: self } }] }
effects:
  - { id: bold, name: Bold, duration: { until: startOfNextTurn, of: bearer }, mods: [{ on: [d20.attack.str], op: adv }, { on: [d20.attack], side: incoming, op: adv }] }
`,
  // P10 (firstAttack augment) with P3 (a qualified selfHas on a step's when) and P11 (endOfThisTurn).
  'w1-fury': `kind: feature
id: test:w1-fury
name: W1 Fury
${SRC}
augments: { feature: test:w1-bold, firstAttack: true, steps: [{ apply: { effect: armed, to: self, when: [{ selfHas: 'test:w1-surge#surging' }] } }] }
riders:
  - { id: fury-damage, name: Fury Damage, on: hit, oncePerTurn: ownTurn, filter: { ability: str }, when: [{ selfHas: armed }], auto: true, do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
effects:
  - { id: armed, name: Armed, duration: { until: endOfThisTurn, of: bearer } }
`,
  // P10 (activation augment): a child effect under the form's root, then endConditions.
  'w1-calm': `kind: feature
id: test:w1-calm
name: W1 Calm
${SRC}
augments: { feature: test:w1-surge, steps: [{ apply: { effect: calm, to: self } }, { endConditions: [charmed, frightened] }] }
effects:
  - { id: calm, name: Calm, immune: [charmed, frightened] }
`,
  // P5, P6, P4: a Sneak Attack-shaped rider.
  'w1-sneak': `kind: feature
id: test:w1-sneak
name: W1 Sneak
${SRC}
riders:
  - { id: sneak, name: Sneak, on: hit, oncePerTurn: global, filter: { weaponProperty: [finesse, ranged] }, when: [{ anyOf: [[rollAdv], [allyWithin5ftOfTarget, rollNotDis]] }], do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
`,
  // P10 (rider augment) with P9 (move).
  'w1-slip': `kind: feature
id: test:w1-slip
name: W1 Slip
${SRC}
augments: { feature: test:w1-sneak, rider: sneak, options: [{ id: slip, name: Slip, do: [{ damage: [{ roll: '1', type: weapon }] }, { move: { speed: half, noOpportunityAttacks: true } }] }] }
`,
  // P10 (activation augment of a target: self activation) with P9.
  'w1-wind': `kind: feature
id: test:w1-wind
name: W1 Wind
${SRC}
activate: { id: wind, name: Wind, cost: bonus, target: self, do: [{ heal: { roll: 1d10 } }] }
`,
  'w1-shift': `kind: feature
id: test:w1-shift
name: W1 Shift
${SRC}
augments: { feature: test:w1-wind, steps: [{ move: { speed: half, noOpportunityAttacks: true } }] }
`,
  // P8.
  'w1-endure': `kind: feature
id: test:w1-endure
name: W1 Endure
${SRC}
dropToOne: { pool: w1-endure }
`,
  // P11: hitTaken sees.
  'w1-duck': `kind: feature
id: test:w1-duck
name: W1 Duck
${SRC}
reaction: { window: hitTaken, reduce: halve, sees: true }
`,
  // An augment whose target the PC never has, and no effects: it must leave the template as it was.
  'w1-orphan': `kind: feature
id: test:w1-orphan
name: W1 Orphan
${SRC}
augments: { feature: test:w1-absent, steps: [{ move: { speed: half, noOpportunityAttacks: true } }] }
`,
};

/** A level-5 PC (PB 3), STR 16 / DEX 14, unarmored, with one weapon of each kind P6 tells apart. */
const pcText = (id: string, features: readonly string[]) => `kind: pc
id: test:${id}
name: ${id}
${SRC}
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }
hpMax: 40
ac: 14
armor: none
saveProficiencies: [str, con]
weapons:
  - { id: rapier, name: Rapier, kind: melee, ability: finesse, damage: [{ roll: 1d8 + @mod, type: piercing }] }
  - { id: greataxe, name: Greataxe, kind: melee, ability: str, damage: [{ roll: 1d12 + @mod, type: slashing }] }
  - { id: handaxe, name: Handaxe, kind: melee, ability: str, thrownRange: [20, 60], damage: [{ roll: 1d6 + @mod, type: slashing }] }
  - { id: dagger, name: Dagger, kind: melee, ability: finesse, thrownRange: [20, 60], damage: [{ roll: 1d4 + @mod, type: piercing }] }
  - { id: longbow, name: Longbow, kind: ranged, ability: dex, range: [150, 600], damage: [{ roll: 1d8 + @mod, type: piercing }] }
pools:
  - { id: w1-surge, name: Surge, max: 3, recharge: longRest }
  - { id: w1-endure, name: Endure, max: 1, recharge: longRest }
features: [${features.join(', ')}]
`;

const ALL = ['test:w1-surge', 'test:w1-bold', 'test:w1-fury', 'test:w1-calm', 'test:w1-sneak', 'test:w1-slip', 'test:w1-wind', 'test:w1-shift', 'test:w1-endure', 'test:w1-duck'];
const PCS: Record<string, readonly string[]> = {
  'w1-all': ALL,
  // Fury and Bold without Surge: the qualified gate binds to -1, with a warning.
  'w1-no-surge': ['test:w1-bold', 'test:w1-fury'],
  'w1-plain': [],
  'w1-orphaned': ['test:w1-orphan'],
  // Sneak alone: its rider without the augment (one option).
  'w1-sneak-only': ['test:w1-sneak'],
};

function files(): SourceFile[] {
  return [
    ...REPO,
    ...Object.entries(FEATURES).map(([n, text]) => ({ path: `packs/test/features/${n}.yaml`, text })),
    ...Object.entries(PCS).map(([n, fs]) => ({ path: `packs/test/pcs/${n}.yaml`, text: pcText(n, fs) })),
  ];
}
const LOADED: LoadResult = loadContent(files());
const C: Content = (() => {
  if (!LOADED.content) throw new Error(LOADED.errors.map(formatDiag).join('\n'));
  return LOADED.content;
})();
const tpl = (id: string): CompiledTemplate => C.get(id)!;
const feat = (t: CompiledTemplate, id: string) => t.features.find((f) => f.id === id);
const fxIdx = (t: CompiledTemplate, id: string): number => t.effects.findIndex((e) => e.id === id);
const tplHash = (t: CompiledTemplate): string => hash64(canonicalJson(t));
/** Errors of the repo plus one extra file. */
const errorsWith = (path: string, text: string): string[] => loadContent([...REPO, { path, text }]).errors.map(formatDiag);

describe('W1 shapes: each new field validates and compiles into the shape W1.1 reads (w1-plan.md P1-P11)', () => {
  const t = tpl('test:w1-all');

  it('P1: a sustained effect carries its SUSTAIN bits; extendSource compiles in its grant', () => {
    const e = t.effects[fxIdx(t, 'test:w1-surge/surging')]!;
    expect(e.sustain).toBe(SUSTAIN.attackRoll | SUSTAIN.enemySave);
    expect(e.dur).toEqual({ k: 'untilTurn', edge: 'end', of: 'bearer' });
    expect(e.grants[0]!.steps).toEqual([{ k: 'extendSource' }]);
    // Not with another duration, and extendSource only inside an effect's grant or hook.
    const bad = FEATURES['w1-surge']!.replace('id: test:w1-surge', 'id: test:w1-surge-bad').replace('duration: { until: endOfNextTurn, of: bearer }', 'duration: { rounds: 10 }');
    expect(errorsWith('packs/test/features/w1-surge-bad.yaml', bad).join('\n')).toMatch(/a sustained effect lasts until the end of its bearer's next turn/);
    const loose = `kind: feature\nid: test:w1-loose\nname: Loose\n${SRC}\nactivate: { id: go, name: Go, cost: bonus, target: self, do: [{ extendSource: true }] }\n`;
    expect(errorsWith('packs/test/features/w1-loose.yaml', loose).join('\n')).toMatch(/extendSource extends the effect whose grant or hook is running/);
  });

  it('P2: noCasting and noConcentration compile as stats', () => {
    const e = t.effects[fxIdx(t, 'test:w1-surge/surging')]!;
    expect(e.stats).toEqual([{ k: 'resist', mask: 1 << 11 }, { k: 'noCasting' }, { k: 'noConcentration' }]);
  });

  it('P4: type: weapon is an on: hit rider\'s extra part with asAttack, and an error anywhere else', () => {
    const r = t.riders!.find((x) => x.local === 'surge-damage')!;
    expect(r.opts[0]!.extra).toEqual([expect.objectContaining({ type: -1, asAttack: true })]);
    const save = `kind: feature\nid: test:w1-burn\nname: Burn\n${SRC}\nspellAbility: wis\nactivate: { id: burn, name: Burn, cost: action, do: [{ target: { range: 30, self: no } }, { save: { ability: dex, damage: [{ roll: 1d6, type: weapon }] } }] }\n`;
    expect(errorsWith('packs/test/features/w1-burn.yaml', save).join('\n')).toMatch(/type: weapon is the type of the attack a rider rides on/);
    const nested = `kind: feature\nid: test:w1-nest\nname: Nest\n${SRC}\nriders: [{ id: n, name: N, on: miss, do: [{ damage: [{ roll: '1', type: weapon }] }] }]\n`;
    expect(errorsWith('packs/test/features/w1-nest.yaml', nested).join('\n')).toMatch(/type: weapon/);
  });

  it('P5: rollAdv, rollNotDis and anyOf compile; P11: notHeavyArmor', () => {
    const r = t.riders!.find((x) => x.local === 'sneak')!;
    expect(r.when).toEqual([{ g: 'anyOf', any: [[{ g: 'rollAdv' }], [{ g: 'allyWithin5ftOfTarget' }, { g: 'rollNotDis' }]] }]);
    expect(feat(t, 'test:w1-surge')!.activate!.when).toEqual([{ g: 'notHeavyArmor' }]);
    // anyOf is one level deep and needs two lists.
    const deep = `kind: feature\nid: test:w1-deep\nname: Deep\n${SRC}\nriders: [{ id: d, name: D, on: hit, when: [{ anyOf: [[{ anyOf: [[rollAdv], [rollNotDis]] }], [rollAdv]] }], do: [{ damage: [{ roll: '1', type: fire }] }] }]\n`;
    expect(errorsWith('packs/test/features/w1-deep.yaml', deep).length).toBeGreaterThan(0);
    const one = `kind: feature\nid: test:w1-one\nname: One\n${SRC}\nriders: [{ id: d, name: D, on: hit, when: [{ anyOf: [[rollAdv]] }], do: [{ damage: [{ roll: '1', type: fire }] }] }]\n`;
    expect(errorsWith('packs/test/features/w1-one.yaml', one).length).toBeGreaterThan(0);
  });

  it('P6: weaponProperty takes a Finesse or a Ranged weapon, not a thrown Handaxe or a Greataxe (srd-raw.txt:13738-13739)', () => {
    const r = t.riders!.findIndex((x) => x.local === 'sneak');
    const takes = (local: string): boolean => t.attacks.find((a) => a.local === local)!.onHit?.includes(r) ?? false;
    expect(['rapier', 'dagger', 'dagger-thrown', 'longbow'].map(takes)).toEqual([true, true, true, true]);
    expect(['greataxe', 'handaxe', 'handaxe-thrown', 'unarmed-strike'].map(takes)).toEqual([false, false, false, false]);
  });

  it('P7: firstAttack compiles onto the feature; the key bits come only with a pattern naming an attack ability', () => {
    const bold = feat(t, 'test:w1-bold')!;
    expect(bold.firstAttack!.steps[0]).toEqual({ k: 'apply', fx: fxIdx(t, 'test:w1-bold/bold'), to: 'self' });
    // test:w1-bold's effect names d20.attack.str: the weapon attacks carry their ability and source.
    const ab = (tt: CompiledTemplate, local: string) => {
      const a = tt.attacks.find((x) => x.local === local)!;
      return [a.ab, a.src];
    };
    expect(ab(t, 'greataxe')).toEqual([0, 'weapon']);
    expect(ab(t, 'rapier')).toEqual([0, 'weapon']); // finesse: the higher, STR 16 over DEX 14
    expect(ab(t, 'longbow')).toEqual([1, 'weapon']);
    expect(t.attacks.find((x) => x.unarmed)!.ab).toBeUndefined(); // its bits come from its own flag
    // Without such a pattern: no key bits, and no firstAttack field.
    const plain = tpl('test:w1-plain');
    for (const a of plain.attacks) expect([a.ab, a.src]).toEqual([undefined, undefined]);
    expect(plain.features.some((f) => 'firstAttack' in f || 'dropToOne' in f)).toBe(false);
    expect(RK.weapon).toBe(1 << 15);
  });

  it('P8: dropToOne names its pool by res index', () => {
    expect(feat(t, 'test:w1-endure')!.dropToOne).toEqual({ pool: 9 + 1 });
  });

  it('P9: the move step; P11: endConditions, endOfThisTurn and hitTaken sees', () => {
    const wind = feat(t, 'test:w1-wind')!.activate!;
    expect(wind.steps.at(-1)).toEqual({ k: 'move', speed: 'half', noOpportunityAttacks: true });
    expect(feat(t, 'test:w1-surge')!.activate!.steps[0]).toEqual({ k: 'endConditions', bits: COND.frightened });
    expect(t.effects[fxIdx(t, 'test:w1-fury/armed')]!.dur).toEqual({ k: 'untilTurn', edge: 'end', of: 'bearer', thisTurn: true });
    expect(feat(t, 'test:w1-duck')!.hitTaken).toEqual({ reduce: 'halve', types: 0, pool: -1, sees: true });
    // move belongs in a feature.
    const sp = `kind: spell\nid: test:w1-hop\nname: Hop\n${SRC}\nlevel: 1\ncastingTime: bonus\nrange: self\ncomponents: { v: true, s: false }\nduration: instant\ndo: [{ move: { speed: half, noOpportunityAttacks: true } }]\n`;
    expect(errorsWith('packs/test/spells/w1-hop.yaml', sp).join('\n')).toMatch(/move moves the creature using a feature/);
  });
});

describe('W1 P3: a qualified selfHas binds across features, or to -1 when the character lacks the feature', () => {
  it('Fury\'s arming step binds to Surge\'s surging effect on a character with both', () => {
    const t = tpl('test:w1-all');
    const steps = feat(t, 'test:w1-bold')!.firstAttack!.steps;
    const armStep = steps[1] as Extract<Step, { k: 'apply' }>;
    expect(armStep.fx).toBe(fxIdx(t, 'test:w1-fury/armed'));
    expect(armStep.when).toEqual([{ g: 'selfHas', fx: fxIdx(t, 'test:w1-surge/surging') }]);
    expect(fxIdx(t, 'test:w1-surge/surging')).toBeGreaterThanOrEqual(0);
  });

  it('without Surge it binds to -1 and the character gets a warning naming it', () => {
    const t = tpl('test:w1-no-surge');
    const armStep = feat(t, 'test:w1-bold')!.firstAttack!.steps[1] as Extract<Step, { k: 'apply' }>;
    expect(armStep.when).toEqual([{ g: 'selfHas', fx: -1 }]);
    expect(LOADED.warnings.map(formatDiag).join('\n')).toMatch(/test:w1-fury: selfHas test:w1-surge#surging names test:w1-surge, which this character doesn't have/);
  });

  it('a qualified id naming an effect the feature doesn\'t have is an error at the character', () => {
    const bad = FEATURES['w1-fury']!.replace('id: test:w1-fury', 'id: test:w1-fury-bad').replace('test:w1-surge#surging', 'test:w1-surge#nope');
    const r = loadContent([...files(), { path: 'packs/test/features/w1-fury-bad.yaml', text: bad }, { path: 'packs/test/pcs/w1-bad.yaml', text: pcText('w1-bad', ['test:w1-surge', 'test:w1-bold', 'test:w1-fury-bad']) }]);
    expect(r.errors.map(formatDiag).join('\n')).toMatch(/test:w1-fury-bad: selfHas test:w1-surge#nope: test:w1-surge has no effect "nope"/);
  });
});

describe('W1 P10: augments append at PC compile', () => {
  const t = tpl('test:w1-all');

  it('steps go on the end of an activation, in its frame (a child of its root)', () => {
    const surge = feat(t, 'test:w1-surge')!.activate!;
    expect(surge.steps.map((s) => s.k)).toEqual(['endConditions', 'apply', 'endConditions']);
    expect(surge.steps[1]).toEqual({ k: 'apply', fx: fxIdx(t, 'test:w1-calm/calm'), to: 'self' });
    expect(surge.steps[2]).toEqual({ k: 'endConditions', bits: COND.charmed | COND.frightened });
    expect(t.effects[fxIdx(t, 'test:w1-calm/calm')]!.condImmune).toBe(COND.charmed | COND.frightened);
    expect(feat(t, 'test:w1-wind')!.activate!.steps.map((s) => s.k)).toEqual(['heal', 'move']);
  });

  it('steps go on the end of a firstAttack program', () => {
    expect(feat(t, 'test:w1-bold')!.firstAttack!.steps.map((s) => s.k)).toEqual(['apply', 'apply']);
  });

  it('options go on a rider (one rider, one decision): it becomes a choice with its own option first', () => {
    const r = t.riders!.find((x) => x.local === 'sneak')!;
    expect(r.chooses).toBe(true);
    expect(r.opts.map((o) => o.local)).toEqual(['sneak', 'slip']);
    expect(r.opts[1]!.extra).toEqual([expect.objectContaining({ asAttack: true })]);
    expect(r.opts[1]!.steps).toEqual([{ k: 'move', speed: 'half', noOpportunityAttacks: true }]);
    expect(t.riders!.filter((x) => x.local === 'sneak')).toHaveLength(1);
    const alone = tpl('test:w1-sneak-only').riders!.find((x) => x.local === 'sneak')!;
    expect([alone.chooses, alone.opts.length]).toEqual([false, 1]);
  });

  it('an augment-only feature adds no CompiledFeature of its own', () => {
    expect(feat(t, 'test:w1-calm')).toBeUndefined();
    expect(feat(t, 'test:w1-slip')).toBeUndefined();
  });

  it('an unused field leaves the template as it was: an augment whose target the character lacks changes nothing', () => {
    const orphaned = tpl('test:w1-orphaned');
    const plain = tpl('test:w1-plain');
    // The same template but for its own id and name (attack ids carry the template id).
    expect(hash64(canonicalJson(orphaned).replaceAll('w1-orphaned', 'X'))).toBe(hash64(canonicalJson(plain).replaceAll('w1-plain', 'X')));
    expect(tplHash(plain)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('augmenting what the target doesn\'t have is an error at the character', () => {
    const bad = FEATURES['w1-slip']!.replace('id: test:w1-slip', 'id: test:w1-slip-bad').replace('rider: sneak', 'rider: nope');
    const r = loadContent([...files(), { path: 'packs/test/features/w1-slip-bad.yaml', text: bad }, { path: 'packs/test/pcs/w1-bad.yaml', text: pcText('w1-bad', ['test:w1-sneak', 'test:w1-slip-bad']) }]);
    expect(r.errors.map(formatDiag).join('\n')).toMatch(/test:w1-slip-bad adds options to test:w1-sneak's rider "nope", which it doesn't have/);
    const both = FEATURES['w1-slip']!.replace('id: test:w1-slip', 'id: test:w1-slip-two').replace('rider: sneak,', 'rider: sneak, firstAttack: true,');
    expect(errorsWith('packs/test/features/w1-slip-two.yaml', both).join('\n')).toMatch(/augment one of an activation, a rider or firstAttack/);
  });
});

describe('W1 sim state: within-turn budget fields, out of stateHash', () => {
  it('a fresh budget has rolls 0 and freeFt 0', () => {
    const b = newBudget(2);
    expect([b.rolls, b.freeFt]).toEqual([0, 0]);
  });
});

describe('W1 decision kinds: firstAttack and moveTo list pass first, and every built-in decider declines by default', () => {
  const legal = (k: LegalKind, opt = -1, cell = -1): Legal => ({ k, atk: -1, target: -1, cell, ft: 0, provokes: 0, parity: 0, opt, lvl: 0, aux: 0, fx: -1, hazard: 0 });
  const dpOf = (k: DecisionKind, at = 3): DecisionPoint => {
    const items = k === 'firstAttack' ? [legal('pass'), legal('pick', 0)] : [legal('pass'), legal('move', -1, 12), legal('move', -1, 13)];
    const keys = k === 'firstAttack' ? ['pass', 'first:w1-bold'] : ['pass', 'moveTo:C2', 'moveTo:D2'];
    return { k, who: 0, at, round: 1, cause: 0, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
  };
  const KINDS: readonly DecisionKind[] = ['firstAttack', 'moveTo'];

  it('the kinds exist and a constructed point lists pass first', () => {
    for (const k of KINDS) expect(dpOf(k).keyOf(0)).toBe('pass');
  });

  it('baseline, random-legal (drawing no dice) and greedy answer pass', () => {
    const s = setup({ w: 6, h: 6, units: [{ seat: 'pc1', team: 0, tpl: DUMMY, at: 'B2' }, { seat: 'foe1', team: 1, tpl: DUMMY, at: 'E5' }] });
    const cx = createContext(s, 1, 0, [new BaselineDecider(), new BaselineDecider()], null);
    const view = cx.views[0]!;
    const noDice = { ...view, ai: { roll: () => { throw new Error('random-legal drew a die'); } } } as UnitView;
    for (const k of KINDS) {
      expect(new BaselineDecider().decide(view, dpOf(k)), k).toBe(0);
      expect(new RandomLegalDecider().decide(noDice, dpOf(k)), k).toBe(0);
      expect(new GreedyDecider().decide(view, dpOf(k)), k).toBe(0);
    }
  });

  it('a journal answers them only by naming the decision index: a bare "pass" stays for the turn', () => {
    const view = { q: { units: [{ seat: 'pc1' }] }, me: 0 } as unknown as UnitView;
    for (const k of KINDS) {
      const c = new JournalCursor([{ seat: 'pc1', key: 'pass' }]);
      expect(new JournalDecider(c, null).decide(view, dpOf(k)), k).toBe(0);
      expect(c.pos, `${k}: the entry is left for the turn`).toBe(0);
      const named = new JournalCursor([{ seat: 'pc1', key: dpOf(k).keyOf(1), at: 3 }]);
      expect(new JournalDecider(named, null).decide(view, dpOf(k)), k).toBe(1);
      expect(named.pos).toBe(1);
    }
  });
});

describe('W1 RuleFlags: freeMoveUsesMovement and frenzyRageCheck', () => {
  it('appended last, unverified, citing the text, at Shane\'s 2026-11-12 defaults, out of the scenario hash at their defaults', () => {
    expect(FLAG_KEYS.slice(-3, -1)).toEqual(['freeMoveUsesMovement', 'frenzyRageCheck']); // then step E's thrownWeaponLands
    expect(DEFAULT_FLAGS).toMatchObject({ freeMoveUsesMovement: false, frenzyRageCheck: 'declaration' });
    expect(FLAG_INFO.freeMoveUsesMovement.source).toMatch(/srd-raw\.txt:10661-10663/);
    expect(FLAG_INFO.freeMoveUsesMovement.source).toMatch(/13835-13836/);
    expect(FLAG_INFO.frenzyRageCheck.source).toMatch(/srd-raw\.txt:5173-5175/);
    for (const k of ['freeMoveUsesMovement', 'frenzyRageCheck'] as const) {
      expect(FLAG_INFO[k].verified, k).toBe(false);
      expect(k in hashedFlags(DEFAULT_FLAGS), k).toBe(false);
      expect(describeFlags(DEFAULT_FLAGS, [k])[0], k).toMatch(new RegExp(`^${k}=\\S+ \\[UNVERIFIED: `));
    }
    expect(hashedFlags({ ...DEFAULT_FLAGS, freeMoveUsesMovement: true }).freeMoveUsesMovement).toBe(true);
    // A per-flag array keeps its old length while no W1 flag was read: 41 with no later flag, 48
    // with a step 7-9+ flag (the n40 report reads swapProvokesOpportunityAttacks), 50 with a W1
    // flag (step E: not 51 until thrownWeaponLands is read, PRE_E_FLAG_COUNT).
    expect(PRE_W1_FLAG_COUNT).toBe(48);
    expect(trimLateFlags(new Uint8Array(FLAG_KEYS.length))).toHaveLength(PRE_AREA_FLAG_COUNT);
    const late = new Uint8Array(FLAG_KEYS.length);
    late[FLAG_KEYS.indexOf('swapProvokesOpportunityAttacks')] = 1;
    expect(trimLateFlags(late)).toHaveLength(PRE_W1_FLAG_COUNT);
    for (const k of ['freeMoveUsesMovement', 'frenzyRageCheck'] as const) {
      const u = new Uint8Array(FLAG_KEYS.length);
      u[FLAG_KEYS.indexOf(k)] = 1;
      expect(trimLateFlags(u), k).toHaveLength(PRE_E_FLAG_COUNT);
    }
  });

  it('frenzyRageCheck: hit isn\'t implemented, so a scenario that picks it is refused; freeMoveUsesMovement: true is allowed', () => {
    expect(() => assertImplemented({ ...DEFAULT_FLAGS, frenzyRageCheck: 'hit' })).toThrow(/frenzyRageCheck=hit isn't implemented/);
    expect(() => assertImplemented({ ...DEFAULT_FLAGS, freeMoveUsesMovement: true })).not.toThrow();
  });
});
