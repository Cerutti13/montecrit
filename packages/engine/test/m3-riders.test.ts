// M3 step 5a, engine part B (docs/design/m3.md section 3, critique C1 and C12): RIDER (riders on
// a feature: filters, the C1 once-per-turn scopes, costs, choose, extra damage joined to the hit
// and doubled on a crit) and REACT hitTaken (Deflect Attacks' shape: a damage-type filter, a
// rolled reduction, the Reaction budget, before or after Resistance), plus the step-4 carry-over:
// Paralyzed auto-crits and critMin flowing through riders. Tests are named for the rule text they
// check, with its line in the SRD 5.2.1 PDF text (srd-raw.txt). Content is synthetic (test: ids).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledDamage, CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionKind, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { resolveOption } from '../src/sim/act.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { dealDamage } from '../src/sim/damage.ts';
import { boundary } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { addCond, COND, type Unit } from '../src/sim/state.ts';

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
const withFiles = (extra: Record<string, string>): SourceFile[] => [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
const messages = (r: LoadResult) => r.errors.map(formatDiag).join('\n');
function loadOk(files: readonly SourceFile[]): Content {
  const r = loadContent(files);
  if (!r.content) throw new Error(messages(r));
  return r.content;
}

const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;

/** A Monk-shaped PC: DEX 16 (+3), WIS 16 (+3), PB 3, level 6, Unarmed Strike 1d8 + DEX, Focus 20. */
const MONK = (features: string[]) => `kind: pc
id: test:rider-monk
name: Rider Monk
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: 40
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
hpMax: 200
ac: 16
armor: none
saveProficiencies: [str, dex]
weapons:
  - { id: shortsword, name: Shortsword, kind: melee, ability: finesse, category: martial, light: true, damage: [{ roll: 1d6 + @mod, type: piercing }] }
  - { id: club, name: Club, kind: melee, ability: str, category: simple, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
  - { id: longsword, name: Longsword, kind: melee, ability: str, category: martial, damage: [{ roll: 1d8 + @mod, type: slashing }] }
  - { id: dagger, name: Dagger, kind: melee, ability: finesse, damage: [{ roll: 1d4 + @mod, type: piercing }] }
  - { id: shortbow, name: Shortbow, kind: ranged, ability: dex, category: simple, range: [80, 320], damage: [{ roll: 1d6 + @mod, type: piercing }] }
unarmedStrike: { ability: finesse, damage: 1d8 + @mod }
pools:
  - { id: focus, name: Focus Points, max: 20, recharge: shortRest }
features: [${features.join(', ')}]
`;

const monster = (id: string, ac: number, hp: number, dmg: string, type: string, extra = '') => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 0
pb: 2
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }
${extra}attacks:
  - { id: hit, name: Hit, kind: melee, toHit: 30, damage: [{ roll: '${dmg}', type: ${type}, avg: 1 }] }
`;

const STUN_DO = `[{ save: { ability: con, onFail: [{ condition: { id: stunned, until: { until: startOfNextTurn, of: caster } } }] } }]`;
const KIT: Record<string, string> = {
  'packs/test/monsters/rider-brute.yaml': monster('rider-brute', 12, 300, '1', 'bludgeoning'),
  'packs/test/monsters/rider-slasher.yaml': monster('rider-slasher', 12, 300, '30', 'slashing'),
  'packs/test/monsters/rider-burner.yaml': monster('rider-burner', 12, 300, '30', 'fire'),
  'packs/test/monsters/rider-flanker.yaml': monster('rider-flanker', 12, 300, '10', 'fire').replace(
    "damage: [{ roll: '10', type: fire, avg: 1 }]",
    "damage: [{ roll: '10', type: fire, avg: 10 }, { roll: '5', type: slashing, avg: 5, ifAdvantage: true }]",
  ),
  'packs/test/monsters/rider-wall.yaml': monster('rider-wall', 40, 300, '1', 'bludgeoning'),
  'packs/test/monsters/rider-ghost.yaml': monster('rider-ghost', 12, 300, '1', 'bludgeoning', 'immune: [bludgeoning]\n'),
  'packs/test/monsters/rider-mook.yaml': monster('rider-mook', 12, 40, '1d4', 'slashing'),
  'packs/test/data/rider-focus.yaml': feature(
    'rider-focus',
    `activate:
  - { id: flurry, name: Flurry of Blows, cost: bonus, uses: { pool: focus }, do: [{ weaponAttack: { with: unarmed, count: 2 } }] }
  - { id: bonus-strike, name: Bonus Unarmed Strike, cost: bonus, do: [{ weaponAttack: { with: unarmed } }] }
`,
  ),
  'packs/test/data/rider-stun.yaml': feature(
    'rider-stun',
    `spellAbility: wis
riders:
  - { id: stunning-strike, name: Stunning Strike, on: hit, filter: { attack: [unarmed, monkWeapon] }, oncePerTurn: global, cost: { pool: focus }, do: ${STUN_DO} }
`,
  ),
  'packs/test/data/rider-own.yaml': feature('rider-own', 'riders:\n  - { id: own, name: Own Turn Only, on: hit, oncePerTurn: ownTurn, do: [{ tempHp: "1" }] }\n'),
  'packs/test/data/rider-per.yaml': feature('rider-per', 'riders:\n  - { id: per, name: Per Creature, on: hit, oncePerTurn: perCreature, do: [{ tempHp: "1" }] }\n'),
  'packs/test/data/rider-smite.yaml': feature('rider-smite', 'riders:\n  - { id: smite, name: Smite, on: hit, do: [{ damage: [{ roll: 20d2, type: radiant }] }] }\n'),
  'packs/test/data/rider-graze.yaml': feature('rider-graze', 'riders:\n  - { id: graze, name: Graze, on: miss, do: [{ damage: [{ roll: "2", type: force }] }] }\n'),
  'packs/test/data/rider-sap.yaml': feature('rider-sap', 'riders:\n  - { id: sap, name: Sap, on: dealtDamage, do: [{ tempHp: "1" }] }\n'),
  'packs/test/data/rider-openhand.yaml': feature(
    'rider-openhand',
    `riders:
  - id: open-hand
    name: Open Hand Technique
    on: hit
    filter: { grantedBy: flurry }
    choose:
      - { id: addle, name: Addle, do: [{ tempHp: "1" }] }
      - { id: topple, name: Topple, do: [{ condition: { id: prone } }] }
`,
  ),
  'packs/test/data/rider-monkish.yaml': feature('rider-monkish', 'riders:\n  - { id: monkish, name: Monk Weapon Only, on: hit, filter: { attack: monkWeapon }, do: [{ tempHp: "1" }] }\n'),
  'packs/test/data/rider-ranged.yaml': feature('rider-ranged', 'riders:\n  - { id: ranged, name: Ranged Only, on: hit, filter: { range: ranged, ability: dex }, do: [{ tempHp: "1" }] }\n'),
  'packs/test/data/rider-deflect.yaml': feature(
    'rider-deflect',
    'reaction: { window: hitTaken, reduce: 1d10 + @mod.dex + @classLevel, damageTypes: [bludgeoning, piercing, slashing] }\nunimplemented: [redirect (needs Total Cover, step 8)]\n',
  ),
  'packs/test/data/rider-halve.yaml': feature('rider-halve', 'reaction: { window: hitTaken, reduce: halve }\n'),
  'packs/test/data/rider-tough.yaml': feature(
    'rider-tough',
    'passive: { effects: [tough] }\neffects:\n  - { id: tough, name: Tough, stats: [{ resist: [slashing] }] }\n',
  ),
  'packs/test/data/rider-fireproof.yaml': feature(
    'rider-fireproof',
    'passive: { effects: [fireproof] }\neffects:\n  - { id: fireproof, name: Fireproof, stats: [{ immune: [fire] }] }\n',
  ),
  'packs/test/data/rider-bolt.yaml': feature(
    'rider-bolt',
    `spellAbility: wis
activate: { id: bolt, name: Bolt, cost: action, do: [{ target: { range: 60, who: enemy, self: no } }, { attack: { kind: ranged, range: 60, onHit: [{ damage: [{ roll: 1d6, type: fire }] }] } }] }
`,
  ),
  'packs/test/data/rider-spellsmite.yaml': feature('rider-spellsmite', 'riders:\n  - { id: spellsmite, name: Spell Smite, on: hit, filter: { attack: spell }, do: [{ damage: [{ roll: 1d4, type: radiant }] }, { tempHp: "1" }] }\n'),
  'packs/test/data/rider-keen.yaml': feature('rider-keen', 'passive: { effects: [keen] }\neffects:\n  - { id: keen, name: Keen, stats: [{ critMin: 2 }] }\n'),
};
const MONK_PATH = 'packs/test/pcs/rider-monk.yaml';

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const PC: UnitDoc = { seat: 'pc1', team: 'party', use: 'test:rider-monk', at: 'B2' };
const at = (seat: string, use: string, cell: string): UnitDoc => ({ seat, team: 'enemies', use: `test:${use}`, at: cell });

interface Opts {
  features: string[];
  units?: UnitDoc[];
  flags?: Partial<RuleFlags>;
}
const SETUPS = new Map<string, FightSetup>();
function setupOf(o: Opts): FightSetup {
  const key = JSON.stringify(o);
  let s = SETUPS.get(key);
  if (!s) {
    const content = loadOk(withFiles({ ...KIT, [MONK_PATH]: MONK(o.features.map((f) => `test:${f}`)) }));
    const doc = { kind: 'scenario', id: 'rider-lab', name: 'Rider lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 5 }, units: o.units ?? [PC, at('brute', 'rider-brute', 'C2')] };
    const r = resolveScenario(doc, 'rider-lab.yaml', content, o.flags ? { flags: o.flags } : {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    SETUPS.set(key, (s = r.setup));
  }
  return s;
}

/** Answers riders with `rider` (a key to take, or null to pass), hitTaken with `react`; everything else the first item. Records every decision. */
class Scripted implements Decider {
  readonly name = 'scripted';
  readonly seen: { k: DecisionKind; keys: string[]; dp: DecisionPoint }[] = [];
  rider: ((keys: string[]) => string | null) | null = (keys) => keys[keys.length - 1]!;
  react = true;
  decide(_v: UnitView, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys, dp });
    if (dp.k === 'rider') {
      const want = this.rider ? this.rider(keys) : null;
      return want === null ? 0 : keys.indexOf(want);
    }
    if (dp.k === 'hitTaken') return this.react ? 1 : 0;
    return 0;
  }
  kinds(k: DecisionKind): string[][] {
    return this.seen.filter((s) => s.k === k).map((s) => s.keys);
  }
}

interface World {
  readonly cx: Ctx;
  readonly setup: FightSetup;
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
  return { cx, setup, d, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  who.b.reaction = 1;
  boundary(w.cx, 'start', who, -1);
  who.b.action = 1;
  who.b.bonus = 1;
  who.b.moveFt = 40;
  who.b.speedAt = 40;
}
function endTurn(w: World, who: Unit): void {
  boundary(w.cx, 'end', who, -1);
  w.cx.st.active = -1;
}
const atkIdx = (u: Unit, local: string): number => u.tpl.attacks.findIndex((a) => a.local === local);
const pickOpt = (w: World, u: Unit, key: string) => {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const all = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, u.idx, l) }));
  releaseList(w.cx, list);
  const o = all.find((x) => x.key === key);
  if (!o) throw new Error(`no option ${key}; have ${all.map((x) => x.key).join(', ')}`);
  return o.l;
};
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const tplOf = (setup: FightSetup, id: string): CompiledTemplate => setup.seats.find((s) => s.tpl.id === id)!.tpl;

describe('RIDER: compile (docs/design/m3.md section 3, C3)', () => {
  it('Monk weapons, srd-raw.txt:11076-11084: "Simple Melee weapons" and "Martial Melee weapons that have the Light property"', () => {
    const tpl = tplOf(setupOf({ features: ['rider-monkish'] }), 'test:rider-monk');
    const on = (local: string) => tpl.attacks[atkIdx({ tpl } as Unit, local)]!.onHit;
    expect(on('shortsword')).toEqual([0]); // Martial, Light
    expect(on('club')).toEqual([0]); // Simple Melee
    expect(on('longsword')).toBeUndefined(); // Martial without Light
    expect(on('dagger')).toBeUndefined(); // no category given: fails closed
    expect(on('shortbow')).toBeUndefined(); // Simple, but Ranged
    expect(on('unarmed-strike')).toBeUndefined(); // an Unarmed Strike is no weapon
  });

  it('Stunning Strike\'s filter, srd-raw.txt:11201-11202: "a Monk weapon or an Unarmed Strike"; range and ability filters', () => {
    const tpl = tplOf(setupOf({ features: ['rider-stun', 'rider-ranged'] }), 'test:rider-monk');
    const on = (local: string) => tpl.attacks[atkIdx({ tpl } as Unit, local)]!.onHit;
    expect(on('unarmed-strike')).toEqual([0]);
    expect(on('shortsword')).toEqual([0]);
    expect(on('longsword')).toBeUndefined();
    expect(on('shortbow')).toEqual([1]); // ranged, DEX
    expect(tpl.riders!.map((r) => [r.local, r.once, r.pool >= 0])).toEqual([['stunning-strike', 'global', true], ['ranged', undefined, false]]);
  });

  it('C3: a PC without riders compiles no rider fields (riders, onHit and onMiss stay undefined)', () => {
    const tpl = tplOf(setupOf({ features: ['rider-focus'] }), 'test:rider-monk');
    expect(tpl.riders).toBeUndefined();
    for (const a of tpl.attacks) {
      expect('onHit' in a).toBe(false);
      expect('onMiss' in a).toBe(false);
    }
    expect(tpl.features.some((f) => 'hitTaken' in f)).toBe(false);
  });

  it('a rider has do or choose, and grantedBy must name an activation the character has', () => {
    const bad = loadContent(withFiles({ ...KIT, 'packs/test/data/rider-own.yaml': feature('rider-own', 'riders:\n  - { id: own, name: x, on: hit }\n'), [MONK_PATH]: MONK(['test:rider-own']) }));
    expect(messages(bad)).toMatch(/a rider has do or choose/);
    const orphan = loadContent(withFiles({ ...KIT, [MONK_PATH]: MONK(['test:rider-openhand']) }));
    expect(messages(orphan)).toMatch(/granted by "flurry"/);
  });
});

describe('RIDER: when it can be used (C1 scopes, srd-raw.txt:11201-11209)', () => {
  it('"you can expend 1 Focus Point to attempt a stunning strike" (11202-11203): a hit asks pass or use; using it spends 1 Focus and the target saves (CON, DC 8 + WIS + PB)', () => {
    const w = world({ features: ['rider-stun'] });
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    const focus = pc.res[9]!;
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, false, -1);
    expect(w.d.kinds('rider')).toEqual([['pass', 'rider:stunning-strike']]);
    expect(pc.res[9]).toBe(focus - 1);
    const save = evs(w, 'save')[0]!;
    expect(save.key).toBe('save.con');
    expect(save.dc).toBe(8 + 3 + 3);
    expect(save.purpose).toBe('rider'); // its own purpose: the brute's other saves never shift
    // Order: the attack, the rider decision and use, the damage, then the save.
    const order = w.sink.events.map((e) => e.k).filter((k) => ['attack', 'act', 'damage', 'save'].includes(k));
    expect(order).toEqual(['attack', 'act', 'damage', 'save']);
  });

  it('a rider that can\'t be used is never asked: no Focus left means no decision (auto-skipped)', () => {
    const w = world({ features: ['rider-stun'] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    pc.res[9] = 0;
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    expect(w.d.kinds('rider')).toEqual([]);
    expect(evs(w, 'save')).toHaveLength(0);
  });

  it('global, "Once per turn" (11201): after one use, no more on any hit that turn; offered again the next turn', () => {
    const w = world({ features: ['rider-stun', 'rider-focus'] });
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, false, -1);
    resolveOption(w.cx, pc, pickOpt(w, pc, 'use:rider-focus/flurry'), -1); // two more hits (toHit +6 vs AC 12)
    const hits = evs(w, 'attack').filter((e) => e.hit).length;
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(w.d.kinds('rider')).toHaveLength(1);
    endTurn(w, pc);
    startTurn(w, brute); // anyone's turn: a new turn
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, true, -1); // an opportunity attack on the brute's turn
    expect(w.d.kinds('rider')).toHaveLength(2); // C1: Stunning Strike works off the Monk's turn
  });

  it('global declined: passing doesn\'t use it, so the next hit that turn asks again', () => {
    const w = world({ features: ['rider-stun'] });
    w.d.rider = () => null;
    const pc = w.u('pc1');
    startTurn(w, pc);
    pc.b.atkActive = false;
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    const hits = evs(w, 'attack').filter((e) => e.hit).length;
    expect(w.d.kinds('rider')).toHaveLength(hits);
  });

  it('ownTurn (C1): at most once, and only during the bearer\'s own turn; never on an opportunity attack on another\'s turn', () => {
    const w = world({ features: ['rider-own'] });
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, brute);
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, true, -1);
    expect(w.d.kinds('rider')).toHaveLength(0);
    endTurn(w, brute);
    startTurn(w, pc);
    for (let i = 0; i < 3; i++) resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, false, -1);
    expect(w.d.kinds('rider')).toHaveLength(1);
  });

  it('perCreature (C1): at most once per creature attacked in each turn; another creature is a fresh use', () => {
    const w = world({ features: ['rider-per'], units: [PC, at('brute', 'rider-brute', 'C2'), at('brute2', 'rider-brute', 'B3')] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    for (let i = 0; i < 2; i++) resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    for (let i = 0; i < 2; i++) resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute2'), false, -1);
    const asked = w.d.seen.filter((s) => s.k === 'rider').map((s) => s.dp.src!.target);
    expect(asked).toEqual([w.u('brute').idx, w.u('brute2').idx]);
  });

  it('Open Hand Technique, srd-raw.txt:11312-11313: "an attack granted by your Flurry of Blows" (grantedBy), and choose: one of the effects', () => {
    const w = world({ features: ['rider-focus', 'rider-openhand'] });
    w.d.rider = (keys) => (keys.includes('rider:open-hand/topple') ? 'rider:open-hand/topple' : null);
    const pc = w.u('pc1');
    const brute = w.u('brute');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pickOpt(w, pc, 'use:rider-focus/bonus-strike'), -1);
    expect(w.d.kinds('rider')).toHaveLength(0); // not a Flurry strike
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), brute, false, -1); // the Attack action: not granted by Flurry
    expect(w.d.kinds('rider')).toHaveLength(0);
    pc.b.bonus = 1;
    resolveOption(w.cx, pc, pickOpt(w, pc, 'use:rider-focus/flurry'), -1);
    const asked = w.d.kinds('rider');
    expect(asked.length).toBe(evs(w, 'attack').filter((e) => e.hit && evs(w, 'attack').indexOf(e) >= 2).length);
    expect(asked[0]).toEqual(['pass', 'rider:open-hand/addle', 'rider:open-hand/topple']);
    expect(evs(w, 'act').some((e) => e.name === 'Open Hand Technique: Topple')).toBe(true);
    expect(evs(w, 'cond').some((e) => e.who === brute.idx && e.cond === 'core:prone' && e.on)).toBe(true);
  });

  it('on: miss runs only on a miss; its damage is its own instance under purpose rider', () => {
    const w = world({ features: ['rider-graze'], units: [PC, at('wall', 'rider-wall', 'C2')] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    for (let i = 0; i < 6; i++) resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('wall'), false, -1);
    const misses = evs(w, 'attack').filter((e) => !e.hit).length;
    expect(misses).toBeGreaterThan(0);
    expect(w.d.kinds('rider')).toHaveLength(misses);
    const dmg = evs(w, 'damage').filter((e) => e.purpose === 'rider');
    expect(dmg).toHaveLength(misses);
    for (const d of dmg) expect(d.parts).toEqual([{ type: 'force', rolled: 2 }]);
  });

  it('on: dealtDamage is asked after the attack\'s damage, only when the target took some (an immune target took none)', () => {
    const w = world({ features: ['rider-sap'], units: [PC, at('brute', 'rider-brute', 'C2'), at('ghost', 'rider-ghost', 'B3')] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('ghost'), false, -1); // Bludgeoning into Immunity
    expect(w.d.kinds('rider')).toHaveLength(0);
    resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    expect(w.d.kinds('rider')).toHaveLength(evs(w, 'attack')[1]!.hit ? 1 : 0);
    const ks = w.sink.events.map((e) => e.k);
    if (w.d.kinds('rider').length) expect(ks.lastIndexOf('damage')).toBeLessThan(ks.lastIndexOf('decided'));
  });
});

describe('RIDER: extra damage on a hit, "Critical Hits" (srd-raw.txt:2207-2211)', () => {
  const smiteHit = (o: Opts, setup?: (w: World) => void, seed = 3) => {
    const w = world(o, seed);
    const pc = w.u('pc1');
    startTurn(w, pc);
    setup?.(w);
    for (let i = 0; i < 20 && !evs(w, 'attack').some((e) => e.hit); i++) resolveAttack(w.cx, pc, atkIdx(pc, 'unarmed-strike'), w.u('brute'), false, -1);
    const a = evs(w, 'attack').find((e) => e.hit)!;
    const d = evs(w, 'damage').find((e) => e.slot === a.slot && e.src === pc.idx)!;
    return { a, d, w };
  };

  it('a hit rider\'s damage joins the attack\'s damage: one damage instance with both parts', () => {
    const { d } = smiteHit({ features: ['rider-smite'] });
    expect(d.parts.map((p) => p.type)).toEqual(['bludgeoning', 'radiant']);
  });

  it('"If the attack involves other damage dice ... you also roll those dice twice" (2210-2211): rider dice double on a crit (critMin 2 makes every hit one)', () => {
    const on = smiteHit({ features: ['rider-smite', 'rider-keen'] });
    expect(on.a.crit).toBe(true);
    expect(on.d.parts[1]!.rolled).toBeGreaterThanOrEqual(40); // 40d2
    expect(on.w.cx.st.flagsUsed[flagIndex('riderDiceCritDouble')]).toBe(1);
    const off = smiteHit({ features: ['rider-smite', 'rider-keen'], flags: { riderDiceCritDouble: false } });
    expect(off.a.crit).toBe(true);
    expect(off.d.parts[1]!.rolled).toBeLessThanOrEqual(40); // 20d2 only
    // The attack's own dice (and the rider's first 20d2) never move: same seed, same faces.
    expect(off.d.parts[0]!.rolled).toBe(on.d.parts[0]!.rolled);
  });

  it('a normal hit rolls the rider\'s dice once; choosing the rider never moves the attack\'s own damage dice', () => {
    const used = smiteHit({ features: ['rider-smite'] });
    expect(used.a.crit).toBe(false);
    expect(used.d.parts[1]!.rolled).toBeLessThanOrEqual(40);
    const passed = smiteHit({ features: ['rider-smite'] }, (w) => (w.d.rider = () => null));
    expect(passed.d.parts).toHaveLength(1);
    expect(passed.d.parts[0]!.rolled).toBe(used.d.parts[0]!.rolled);
  });

  it('a spell attack takes riders filtered attack: spell; their extra damage joins the spell\'s onHit damage, the rest runs after', () => {
    const w = world({ features: ['rider-bolt', 'rider-spellsmite', 'rider-keen'] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    const tpl = pc.tpl;
    expect(tpl.attacks.some((a) => a.onHit)).toBe(false); // weapon and unarmed attacks aren't spell attacks
    resolveOption(w.cx, pc, pickOpt(w, pc, 'use:rider-bolt'), -1);
    const a = evs(w, 'attack')[0]!;
    expect(a.hit).toBe(true); // critMin 2: everything but a natural 1 crits and hits
    expect(w.d.kinds('rider')).toEqual([['pass', 'rider:spellsmite']]);
    const d = evs(w, 'damage');
    expect(d).toHaveLength(1);
    expect(d[0]!.parts.map((p) => p.type)).toEqual(['fire', 'radiant']);
    expect(evs(w, 'tempHp')).toHaveLength(1);
    const ks = w.sink.events.map((e) => e.k);
    expect(ks.indexOf('damage')).toBeLessThan(ks.indexOf('tempHp'));
  });

  it('step-4 carry-over: Paralyzed, srd-raw.txt:33941-33943 ("Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you"): the auto-crit doubles rider dice too', () => {
    const { a, d } = smiteHit({ features: ['rider-smite'] }, (w) => {
      const b = w.u('brute');
      addCond(b, COND.paralyzed | COND.incapacitated, 'core:test', -1, -1, { k: 'never' });
    });
    expect(a.crit).toBe(true);
    expect(d.crit).toBe(true);
    expect(d.parts[1]!.rolled).toBeGreaterThanOrEqual(40);
  });
});

describe('REACT hitTaken: Deflect Attacks (srd-raw.txt:11154-11158, C12)', () => {
  const units = (foe: string) => [PC, at('foe', foe, 'C2'), at('foe2', foe, 'B3')];
  const hitPc = (w: World, seat = 'foe') => {
    const f = w.u(seat);
    resolveAttack(w.cx, f, 0, w.u('pc1'), false, -1);
  };

  it('"its damage includes Bludgeoning, Piercing, or Slashing damage" (11154-11155): Fire opens no window, Slashing does', () => {
    const w = world({ features: ['rider-deflect'], units: [PC, at('foe', 'rider-burner', 'C2'), at('foe2', 'rider-slasher', 'B3')] });
    startTurn(w, w.u('foe'));
    hitPc(w, 'foe');
    expect(w.d.kinds('hitTaken')).toHaveLength(0);
    hitPc(w, 'foe2');
    expect(w.d.kinds('hitTaken')).toEqual([['pass', 'react:rider-deflect']]);
  });

  it('"The reduction equals 1d10 plus your Dexterity modifier and Monk level" (11157-11158), off the attack\'s total, never below 0', () => {
    const w = world({ features: ['rider-deflect'], units: units('rider-slasher') });
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    const hp = pc.hp;
    hitPc(w);
    const r = evs(w, 'reduce')[0]!;
    expect(r.v).toBeGreaterThanOrEqual(1 + 3 + 6);
    expect(r.v).toBeLessThanOrEqual(10 + 3 + 6);
    const d = evs(w, 'damage')[0]!;
    expect(d.parts[0]!.rolled).toBe(30);
    expect(d.dealt).toBe(30 - r.v);
    expect(pc.hp).toBe(hp - (30 - r.v));
    expect(renderLog(w.sink.events, w.setup).join('\n')).toMatch(/reduces the damage by \d+ {2}\[pc1 hitTaken r0 p/);
  });

  it('"When you take a Reaction, you can\'t take another one until the start of your next turn" (1438-1439): a second hit opens no window; the next turn it\'s back', () => {
    const w = world({ features: ['rider-deflect'], units: units('rider-slasher') });
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    hitPc(w);
    hitPc(w, 'foe2');
    expect(w.d.kinds('hitTaken')).toHaveLength(1);
    expect(pc.b.reaction).toBe(0);
    endTurn(w, w.u('foe'));
    startTurn(w, pc);
    endTurn(w, pc);
    startTurn(w, w.u('foe'));
    hitPc(w);
    expect(w.d.kinds('hitTaken')).toHaveLength(2);
  });

  it('declining keeps the Reaction; an Incapacitated creature can\'t react', () => {
    const w = world({ features: ['rider-deflect'], units: units('rider-slasher') });
    w.d.react = false;
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    hitPc(w);
    expect(pc.b.reaction).toBe(1);
    expect(evs(w, 'damage')[0]!.dealt).toBe(30);
    addCond(pc, COND.incapacitated, 'core:test', -1, -1, { k: 'never' });
    w.d.react = true;
    hitPc(w, 'foe2');
    expect(w.d.kinds('hitTaken')).toHaveLength(1);
  });

  it('reduceBeforeResistance, "Order of Application" (2259-2266): reduce then halve for Resistance, or halve then reduce', () => {
    const before = world({ features: ['rider-deflect', 'rider-tough'], units: units('rider-slasher') }, 5);
    startTurn(before, before.u('foe'));
    hitPc(before);
    const v1 = evs(before, 'reduce')[0]!.v;
    expect(evs(before, 'damage')[0]!.dealt).toBe(Math.floor((30 - v1) / 2));
    const after = world({ features: ['rider-deflect', 'rider-tough'], units: units('rider-slasher'), flags: { reduceBeforeResistance: false } }, 5);
    startTurn(after, after.u('foe'));
    hitPc(after);
    const v2 = evs(after, 'reduce')[0]!.v;
    expect(v2).toBe(v1); // same seed, same die
    expect(evs(after, 'damage')[0]!.dealt).toBe(Math.max(0, 15 - v2));
  });

  it('reduce: halve halves the hit\'s damage (round down, Half Damage 2224-2228) with no die', () => {
    const w = world({ features: ['rider-halve'], units: units('rider-slasher') });
    startTurn(w, w.u('foe'));
    hitPc(w);
    expect(evs(w, 'reduce')[0]).toMatchObject({ halve: true, slot: -1 });
    expect(evs(w, 'damage')[0]!.dealt).toBe(15);
  });

  it('reduce: halve rounds down on an odd total (Half Damage, 2225-2227: "round down"): 31 -> 15', () => {
    const w = world({ features: ['rider-halve'], units: units('rider-slasher') });
    const pc = w.u('pc1');
    const parts: CompiledDamage[] = [{ roll: { k: 'const', v: 31 }, critExtra: null, type: 11, avg: 31, ifAdvantage: false }];
    const rolled = new Int32Array(4);
    rolled[0] = 31;
    dealDamage(w.cx, { unit: 1, via: 'test:x', slot: 0, cause: -1, cut: { tgt: pc.idx, v: 0, halve: true } }, parts, rolled, () => true, false, [pc.idx]);
    expect(evs(w, 'damage')[0]!.dealt).toBe(15);
  });

  it('reduceBeforeResistance: the reduction skips a type the target is immune to (Immunity, 2273-2275, already takes it to 0), so it comes off the Slashing part', () => {
    const w = world({ features: ['rider-deflect', 'rider-fireproof'], units: units('rider-slasher') });
    const pc = w.u('pc1');
    // Fire (type 3) comes before Slashing (11) in DAMAGE_TYPES order: a cut that didn't skip it would be wasted on it.
    const parts: CompiledDamage[] = [
      { roll: { k: 'const', v: 10 }, critExtra: null, type: 3, avg: 10, ifAdvantage: false },
      { roll: { k: 'const', v: 10 }, critExtra: null, type: 11, avg: 10, ifAdvantage: false },
    ];
    const rolled = new Int32Array(4);
    rolled[0] = 10;
    rolled[1] = 10;
    dealDamage(w.cx, { unit: 1, via: 'test:x', slot: 0, cause: -1, cut: { tgt: pc.idx, v: 5, halve: false } }, parts, rolled, () => true, false, [pc.idx]);
    expect(evs(w, 'damage')[0]!.dealt).toBe(5); // fire 0 (immune) + slashing 10 - 5
  });

  it('"its damage includes Bludgeoning, Piercing, or Slashing damage" (11154-11155) counts only damage the hit deals: a Slashing part that needs Advantage opens no window without it, and does with it', () => {
    const w = world({ features: ['rider-deflect'], units: [PC, at('foe', 'rider-flanker', 'C2')] });
    startTurn(w, w.u('foe'));
    hitPc(w, 'foe'); // no Advantage: only the Fire part is dealt
    expect(w.d.kinds('hitTaken')).toHaveLength(0);
    expect(evs(w, 'damage')[0]!.dealt).toBe(10);
    addCond(w.u('pc1'), COND.restrained, 'core:test', -1, -1, { k: 'never' }); // attacks against it have Advantage (34076-34077)
    hitPc(w, 'foe');
    expect(w.d.kinds('hitTaken')).toEqual([['pass', 'react:rider-deflect']]);
  });

  it('property: a reduction never makes damage negative or larger than without it', () => {
    const setups = [true, false].map((b) => ({ features: ['rider-deflect', 'rider-tough'], units: units('rider-slasher'), flags: { reduceBeforeResistance: b } }));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 40 }), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 1 }), (x, v, halve, resisted, s) => {
        const w = world(setups[s]!);
        const pc = w.u('pc1');
        const parts: CompiledDamage[] = [{ roll: { k: 'const', v: x }, critExtra: null, type: resisted ? 11 : 0, avg: x, ifAdvantage: false }];
        const rolled = new Int32Array(4);
        rolled[0] = x;
        const before = pc.hp;
        dealDamage(w.cx, { unit: 1, via: 'test:x', slot: 0, cause: -1, cut: { tgt: pc.idx, v, halve } }, parts, rolled, () => true, false, [pc.idx]);
        const cut = evs(w, 'damage')[0]!.dealt;
        const full = resisted ? Math.floor(x / 2) : x;
        return cut >= 0 && cut <= full && pc.hp === before - cut;
      }),
      { numRuns: 300 },
    );
  });
});

/** Greedy for turns, always using a rider and always reacting. */
const eager = (): Decider => {
  const g = new GreedyDecider();
  return { name: 'eager', decide: (v, dp) => (dp.k === 'rider' || dp.k === 'hitTaken' ? dp.legal.n - 1 : g.decide(v, dp)) };
};
const FIGHT: Opts = { features: ['rider-stun', 'rider-own', 'rider-per', 'rider-focus', 'rider-deflect'], units: [PC, at('m1', 'rider-mook', 'D2'), at('m2', 'rider-mook', 'D3'), at('m3', 'rider-mook', 'C4')] };
function fight(seed: number, o: Opts = FIGHT): { events: GameEvent[]; setup: FightSetup; hash: string } {
  const s = setupOf(o);
  const setup = { ...s, knobs: { ...s.knobs, maxRounds: 6 } };
  const sink = new ArraySink();
  const r = runFight(setup, seed, 0, setup.seats.map(() => eager()), sink);
  return { events: sink.events, setup, hash: r.stateHash };
}

describe('properties and determinism (whole fights)', () => {
  it('property: a rider with oncePerTurn never fires twice in its scope (global and ownTurn per turn; perCreature per turn and target)', { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const { events, setup } = fight(seed);
        const pcIdx = setup.seats.findIndex((x) => x.seat === 'pc1');
        let turn = 0;
        let lastTgt = -1;
        const count = new Map<string, number>();
        for (const e of events) {
          if (e.k === 'turnStart') turn++;
          if (e.k === 'attack') lastTgt = e.tgt;
          if (e.k !== 'act') continue;
          const key = e.name === 'Stunning Strike' ? `g/${turn}` : e.name === 'Own Turn Only' ? `o/${turn}` : e.name === 'Per Creature' ? `p/${turn}/${lastTgt}` : null;
          if (key === null) continue;
          if (e.name === 'Own Turn Only' && e.turnOf !== pcIdx) return false;
          count.set(key, (count.get(key) ?? 0) + 1);
        }
        for (const n of count.values()) if (n > 1) return false;
        return true;
      }),
      { numRuns: 25 },
    );
  });

  it('property: a reaction is never taken twice before it refreshes at the start of its owner\'s turn (Deflect and opportunity attacks share it)', { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const { events, setup } = fight(seed);
        const me = setup.seats.findIndex((x) => x.seat === 'pc1');
        let used = 0;
        let saw = 0;
        for (const e of events) {
          if (e.k === 'turnStart' && e.who === me) used = 0;
          const mine = (e.k === 'reduce' && e.who === me) || (e.k === 'attack' && e.att === me && e.opportunity);
          if (!mine) continue;
          saw++;
          if (++used > 1) return false;
        }
        return saw >= 0; // saw: how many it took (the next test checks some fights take one)
      }),
      { numRuns: 25 },
    );
  });

  it('the fights use what they test: riders fire and Deflect is taken somewhere in the first seeds', () => {
    let riders = 0;
    let reduces = 0;
    for (let s = 1; s <= 6; s++) {
      const { events } = fight(s);
      riders += events.filter((e) => e.k === 'act' && (e.name === 'Stunning Strike' || e.name === 'Per Creature')).length;
      reduces += events.filter((e) => e.k === 'reduce').length;
    }
    expect(riders).toBeGreaterThan(0);
    expect(reduces).toBeGreaterThan(0);
  });

  it('determinism: the same seed gives the same log and state hash, with riders and hitTaken live', () => {
    const a = fight(11);
    const b = fight(11);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(b.hash).toBe(a.hash);
  });
});
