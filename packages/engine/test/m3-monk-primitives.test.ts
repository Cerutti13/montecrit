// M3 step 5a, engine part A (docs/design/m3.md section 3 and section 5): WATK (weaponAttack and
// the feature-made Unarmed Strike), ECON (the core Dodge action, core steps, gainAction,
// reaction-cost activations), HOOKX (a feature's initiative hook on its own stream slot), POOLX
// (pool steps and activation costs in points), the Fly Speed stat, and the step-4 carry-over: a
// killing test for the walker's mid-path syncBudget call. Tests are named for the rule text they
// check, with its line in the SRD 5.2.1 PDF text (srd-raw.txt). Content is synthetic (test: ids),
// compiled from YAML with the repo packs, so the schema and compiler paths run too.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { saveKey } from '../src/content/rollkeys.ts';
import type { CompiledTemplate, Content, Step } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, Legal, UnitView } from '../src/decide/decider.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { buildAttackSpec } from '../src/sim/attack.ts';
import { resolveOption } from '../src/sim/act.ts';
import { activationOf } from '../src/sim/cast.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { saveSpec } from '../src/sim/d20.ts';
import { boundary, newModFold } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { addCond, COND, has, type Unit } from '../src/sim/state.ts';
import { newFrame, runSteps } from '../src/sim/steps.ts';
import { walkPath } from '../src/sim/walker.ts';
import { openStream, rollDie } from '../src/rng/stream.ts';
import { parseCell } from '../src/grid/cells.ts';

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

/** A synthetic Monk-shaped PC: DEX 16 (+3), PB 3, a feature-made Unarmed Strike (1d8 + DEX), Focus 6. */
const MONK = (features: string[]) => `kind: pc
id: test:lab-monk
name: Lab Monk
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: 40
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
hpMax: 45
ac: 16
armor: none
saveProficiencies: [str, dex]
weapons:
  - id: shortsword
    name: Shortsword
    kind: melee
    ability: finesse
    damage:
      - { roll: 1d6 + @mod, type: piercing }
unarmedStrike: { ability: finesse, damage: 1d8 + @mod }
pools:
  - { id: focus, name: Focus Points, max: 6, recharge: shortRest }
  - { id: metabolism, name: Uncanny Metabolism, max: 1, recharge: longRest }
  - { id: surge, name: Surge, max: 2, recharge: shortRest }
features: [${features.join(', ')}]
`;

const BRUTE = `kind: monster
id: test:lab-brute
name: Lab Brute
source: synthetic test fixture
size: medium
cr: 0
pb: 2
ac: 12
hp: { average: 300, formula: 30d10 + 135 }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - id: club
    name: Club
    kind: melee
    toHit: 30
    damage:
      - { roll: '1', type: bludgeoning, avg: 1 }
`;

const KIT: Record<string, string> = {
  'packs/test/monsters/lab-brute.yaml': BRUTE,
  'packs/test/data/lab-martial-arts.yaml': feature(
    'lab-martial-arts',
    'activate: { id: bonus-strike, name: Bonus Unarmed Strike, cost: bonus, when: [unarmored, noShield], do: [{ weaponAttack: { with: unarmed } }] }\n',
  ),
  'packs/test/data/lab-focus.yaml': feature(
    'lab-focus',
    `activate:
  - { id: flurry, name: Flurry of Blows, cost: bonus, uses: { pool: focus }, do: [{ weaponAttack: { with: unarmed, count: 2 } }] }
  - { id: patient, name: Patient Defense, cost: bonus, do: [{ core: disengage }] }
  - { id: patient-focus, name: Patient Defense (Focus), cost: bonus, uses: { pool: focus }, do: [{ core: disengage }, { core: dodge }] }
  - { id: wind, name: Step of the Wind, cost: bonus, do: [{ core: dash }] }
  - { id: wind-focus, name: Step of the Wind (Focus), cost: bonus, uses: { pool: focus }, do: [{ core: disengage }, { core: dash }] }
`,
  ),
  'packs/test/data/lab-metabolism.yaml': feature(
    'lab-metabolism',
    `initiative:
  id: metabolism
  name: Uncanny Metabolism
  uses: { pool: metabolism }
  do:
    - { pool: { id: focus, delta: refill } }
    - { heal: { roll: 6 + 1d8 } }
`,
  ),
  'packs/test/data/lab-rally.yaml': feature('lab-rally', 'initiative: { id: rally, name: Rally, do: [{ heal: { roll: 1d4 } }] }\n'),
  'packs/test/data/lab-surge.yaml': feature('lab-surge', 'activate: { id: surge, name: Surge, cost: free, uses: { perTurn: 1 }, do: [{ gainAction: action }] }\n'),
  'packs/test/data/lab-costly.yaml': feature('lab-costly', 'activate: { id: costly, name: Costly Dash, cost: bonus, uses: { pool: focus, cost: 3 }, do: [{ core: dash }] }\n'),
  'packs/test/data/lab-offhand.yaml': feature('lab-offhand', 'activate: { id: offhand, name: Off-hand Strike, cost: bonus, do: [{ weaponAttack: { with: held, noAbilityToDamage: true } }] }\n'),
  'packs/test/data/lab-parry.yaml': feature('lab-parry', 'activate: { id: parry, name: Parry, cost: reaction, do: [{ core: dodge }] }\n'),
  'packs/test/data/lab-tender.yaml': feature(
    'lab-tender',
    `passive: { effects: [tender] }
effects:
  - id: tender
    name: Tender
    on: [{ when: [damaged], do: [{ apply: { effect: slowed, to: target } }] }]
  - id: slowed
    name: Slowed
    stats: [{ speed: half }]
`,
  ),
};
const ALL = ['test:lab-martial-arts', 'test:lab-focus', 'test:lab-metabolism', 'test:lab-surge', 'test:lab-costly', 'test:lab-offhand', 'test:lab-parry'];
const MONK_PATH = 'packs/test/pcs/lab-monk.yaml';

interface World {
  readonly cx: Ctx;
  readonly setup: FightSetup;
  u(seat: string): Unit;
}

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const UNITS: UnitDoc[] = [
  { seat: 'pc1', team: 'party', use: 'test:lab-monk', at: 'B2' },
  { seat: 'gob', team: 'enemies', use: 'srd:goblin-warrior', at: 'C2' },
  { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'H4' },
];

const SETUPS = new Map<string, FightSetup>();
/** One compiled setup per options (a setup is read-only; each world gets a fresh context). */
function setupOf(opts: { features?: string[]; units?: UnitDoc[]; w?: number } = {}): FightSetup {
  const key = JSON.stringify(opts);
  let s = SETUPS.get(key);
  if (!s) SETUPS.set(key, (s = buildSetup(opts)));
  return s;
}

function buildSetup(opts: { features?: string[]; units?: UnitDoc[]; w?: number }): FightSetup {
  const content = loadOk(withFiles({ ...KIT, [MONK_PATH]: MONK(opts.features ?? ALL) }));
  const doc = {
    kind: 'scenario', id: 'monk-lab', name: 'Monk lab', rules: '2024', packs: ['srd-5.2.1', 'test'],
    grid: { w: opts.w ?? 8, h: 4 }, units: opts.units ?? UNITS,
  };
  const r = resolveScenario(doc, 'monk-lab.yaml', content);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** A decider that always takes the first legal item (pass, where there is one). */
const first: Decider = { name: 'first', decide: () => 0 };

function world(opts: Parameters<typeof setupOf>[0] = {}, deciders?: Decider[], sink: ArraySink | null = null): World {
  const setup = setupOf(opts);
  const cx = createContext(setup, 1, 0, deciders ?? setup.seats.map(() => first), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, setup, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}

/** Starts `who`'s turn by hand (as sim/fight.ts takeTurn does, without asking anyone). */
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
  who.b.movedFt = 0;
  who.b.dashes = 0;
  who.b.standFt = 0;
}

function endTurn(w: World, who: Unit): void {
  boundary(w.cx, 'end', who, -1);
  w.cx.st.active = -1;
}

const options = (w: World, u: Unit): { l: Legal; key: string }[] => {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const out = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, u.idx, l) }));
  releaseList(w.cx, list);
  return out;
};
const pick = (w: World, u: Unit, key: string): Legal => {
  const o = options(w, u).find((x) => x.key === key);
  if (!o) throw new Error(`no option ${key}; have ${options(w, u).map((x) => x.key).join(', ')}`);
  return o.l;
};
const tplOf = (setup: FightSetup, id: string): CompiledTemplate => setup.seats.find((s) => s.tpl.id === id)!.tpl;

describe('WATK: Martial Arts and the weaponAttack step (srd-raw.txt:11085-11098)', () => {
  it('Dexterous Attacks and the Martial Arts Die, 11089-11097: a feature-made Unarmed Strike uses DEX and its die for attack and damage', () => {
    const tpl = tplOf(setupOf(), 'test:lab-monk');
    const us = tpl.attacks.find((a) => a.unarmed)!;
    expect(us.id).toBe('core:unarmed-strike');
    expect(us.toHit).toBe(3 + 3); // DEX +3, PB 3
    expect(us.damage).toHaveLength(1);
    expect(us.damage[0]!.type).toBe(1); // still Bludgeoning
    expect(us.damage[0]!.avg).toBe(7); // floor(4.5 + 3)
    expect(us.damage[0]!.critExtra).not.toBeNull(); // the die doubles on a crit
  });

  it('without unarmedStrike the glossary rule holds, 34505-34507: STR + PB to hit, 1 + STR Bludgeoning', () => {
    const tpl = tplOf(setupOf({ units: [{ seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' }, ...UNITS.slice(1)] }), 'test:sample-fighter');
    const us = tpl.attacks.find((a) => a.unarmed)!;
    expect(us.toHit).toBe(3 + 3);
    expect(us.damage[0]!.avg).toBe(4);
  });

  it('Bonus Unarmed Strike, 11088: "You can make an Unarmed Strike as a Bonus Action", not part of the Attack action', () => {
    const sink = new ArraySink();
    const w = world({}, undefined, sink);
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-martial-arts'), -1);
    expect(pc.b.bonus).toBe(0);
    expect(pc.b.action).toBe(1);
    expect(pc.b.atkActive).toBe(false);
    const atks = sink.events.filter((e): e is Extract<GameEvent, { k: 'attack' }> => e.k === 'attack');
    expect(atks).toHaveLength(1);
    expect(atks[0]!.via).toBe('core:unarmed-strike');
    expect(atks[0]!.tgt).toBe(w.u('gob').idx); // the only creature within 5 ft
  });

  it('the Martial Arts benefits need no armor and no Shield, 11085-11087: the gate hides the bonus strike from an armored Monk', () => {
    const content = loadOk(withFiles({ ...KIT, [MONK_PATH]: MONK(ALL).replace('armor: none', 'armor: light') }));
    const r = resolveScenario({ kind: 'scenario', id: 'monk-lab', name: 'x', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 4 }, units: UNITS }, 'x.yaml', content);
    const cx = createContext(r.setup!, 1, 0, r.setup!.seats.map(() => first), null);
    const pc = cx.st.units[0]!;
    const w: World = { cx, setup: r.setup!, u: (s) => cx.st.units.find((x) => x.seat === s)! };
    startTurn(w, pc);
    expect(options(w, pc).map((o) => o.key)).not.toContain('use:lab-martial-arts');
  });

  it('Flurry of Blows, 11126-11127: "expend 1 Focus Point to make two Unarmed Strikes as a Bonus Action"', () => {
    const sink = new ArraySink();
    const w = world({}, undefined, sink);
    const pc = w.u('pc1');
    startTurn(w, pc);
    const before = pc.res[9]!;
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-focus/flurry'), -1);
    expect(pc.res[9]).toBe(before - 1);
    expect(pc.b.bonus).toBe(0);
    expect(pc.b.action).toBe(1);
    expect(sink.events.filter((e) => e.k === 'attack' && e.via === 'core:unarmed-strike')).toHaveLength(2);
  });

  it('each strike picks its own target: two creatures in reach give a target decision keyed attack:<attack>><seat>', () => {
    const seen: string[][] = [];
    const decider: Decider = {
      name: 'probe',
      decide(_view: UnitView, dp: DecisionPoint) {
        if (dp.k === 'target') seen.push(Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)));
        return 0;
      },
    };
    const units: UnitDoc[] = [UNITS[0]!, UNITS[1]!, { seat: 'gob2', team: 'enemies', use: 'srd:goblin-warrior', at: 'B3' }, UNITS[2]!];
    const setup = setupOf({ units });
    const cx = createContext(setup, 1, 0, setup.seats.map(() => decider), null, { audit: true });
    const w: World = { cx, setup, u: (s) => cx.st.units.find((x) => x.seat === s)! };
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveOption(cx, pc, pick(w, pc, 'use:lab-focus/flurry'), -1);
    expect(seen).toHaveLength(2);
    for (const keys of seen) expect(keys.sort()).toEqual(['attack:unarmed-strike>gob', 'attack:unarmed-strike>gob2']);
  });

  it('noAbilityToDamage leaves a positive ability modifier out of the damage (the Light property\'s rule, used at step 5b)', () => {
    const tpl = tplOf(setupOf(), 'test:lab-monk');
    const f = tpl.features.find((x) => x.id === 'test:lab-offhand')!;
    const s = f.activate!.steps[0] as Extract<Step, { k: 'weaponAttack' }>;
    expect(s.from.map((i) => tpl.attacks[i]!.local)).toEqual(['shortsword']); // held: its weapons, not the Unarmed Strike
    expect(tpl.attacks[s.from[0]!]!.damage[0]!.avg).toBe(6); // 1d6 + 3
    expect(s.noAbility![0]!.damage[0]!.avg).toBe(3); // 1d6
    expect(s.noAbility![0]!.toHit).toBe(tpl.attacks[s.from[0]!]!.toHit); // to-hit unchanged
  });

  it('a weaponAttack naming a weapon the character lacks is a load error', () => {
    const r = loadContent(withFiles({ ...KIT, 'packs/test/data/lab-offhand.yaml': feature('lab-offhand', 'activate: { id: offhand, name: x, cost: bonus, do: [{ weaponAttack: { with: greataxe } }] }\n'), [MONK_PATH]: MONK(ALL) }));
    expect(messages(r)).toMatch(/no attack "greataxe"/);
  });
});

describe('ECON: the Dodge action, core steps, gainAction, reaction costs', () => {
  it('Dodge is a core action every creature can take, offered last with key "dodge" (srd-raw.txt:1337-1342)', () => {
    const w = world();
    for (const seat of ['pc1', 'gob']) {
      const u = w.u(seat);
      startTurn(w, u);
      const keys = options(w, u).map((o) => o.key);
      expect(keys[keys.length - 1]).toBe('dodge');
      endTurn(w, u);
    }
  });

  it('Dodge [Action], 33371-33375: attack rolls against you have Disadvantage, and you make DEX saves with Advantage', () => {
    const w = world();
    const pc = w.u('pc1');
    const gob = w.u('gob');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'dodge'), -1);
    expect(pc.b.action).toBe(0);
    expect(has(pc, COND.dodging)).toBe(true);
    const dis: string[] = [];
    buildAttackSpec(w.cx.st, gob, 0, pc, gob.cell, [], dis);
    expect(dis).toContain('core:target-dodging');
    const adv: string[] = [];
    saveSpec(w.cx.st, pc, saveKey(1), 10, adv, [], newModFold());
    expect(adv).toContain('core:dodging');
    const advCon: string[] = [];
    saveSpec(w.cx.st, pc, saveKey(2), 10, advCon, [], newModFold());
    expect(advCon).not.toContain('core:dodging'); // DEX saves only
  });

  it('Dodge [Action], 33376: "You lose these benefits if you have the Incapacitated condition or if your Speed is 0"', () => {
    const w = world();
    const pc = w.u('pc1');
    const gob = w.u('gob');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'dodge'), -1);
    addCond(pc, COND.incapacitated, 'core:incapacitated', -1, -1, { k: 'never' });
    const dis: string[] = [];
    buildAttackSpec(w.cx.st, gob, 0, pc, gob.cell, [], dis);
    expect(dis).not.toContain('core:target-dodging');
    // Speed 0: the training dummy (walk 0) dodging gets nothing.
    const dummy = w.u('dummy');
    addCond(dummy, COND.dodging, 'core:dodge', dummy.idx, -1, { k: 'never' });
    const d2: string[] = [];
    buildAttackSpec(w.cx.st, gob, 0, dummy, dummy.cell, [], d2);
    expect(d2).not.toContain('core:target-dodging');
  });

  it('Dodge [Action], 33373: Disadvantage only "if you can see the attacker", so a Blinded dodger ("You can\'t see", 32741) keeps the Blinded Advantage against it', () => {
    const w = world();
    const pc = w.u('pc1');
    const gob = w.u('gob');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'dodge'), -1);
    addCond(pc, COND.blinded, 'core:blinded', -1, -1, { k: 'never' });
    const adv: string[] = [];
    const dis: string[] = [];
    buildAttackSpec(w.cx.st, gob, 0, pc, gob.cell, adv, dis);
    expect(adv).toContain('core:target-blinded');
    expect(dis).not.toContain('core:target-dodging');
    // Its DEX-save Advantage doesn't need sight (33374-33375): it stays.
    const sAdv: string[] = [];
    saveSpec(w.cx.st, pc, saveKey(1), 10, sAdv, [], newModFold());
    expect(sAdv).toContain('core:dodging');
  });

  it('Dodge lasts "until the start of your next turn" (33372): through other turns, gone when its own turn starts', () => {
    const w = world();
    const pc = w.u('pc1');
    const gob = w.u('gob');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'dodge'), -1);
    endTurn(w, pc);
    expect(has(pc, COND.dodging)).toBe(true);
    startTurn(w, gob);
    expect(has(pc, COND.dodging)).toBe(true);
    endTurn(w, gob);
    startTurn(w, pc);
    expect(has(pc, COND.dodging)).toBe(false);
  });

  it('property: Dodge holds from the action until the start of the dodger\'s next turn, and never past it (33372)', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        let ok = true;
        const dodgedAt = new Map<number, number>(); // unit -> turns count when it dodged
        let lastTurn = -1;
        const decider: Decider = {
          name: 'dodgy',
          decide(view, dp) {
            const st = view.q;
            const me = st.units[view.me]!;
            if (dp.k === 'turn') {
              if (st.turnIdx !== lastTurn) {
                lastTurn = st.turnIdx;
                // A turn just started: whoever's turn it is no longer dodges.
                if (has(me, COND.dodging)) ok = false;
                dodgedAt.delete(me.idx);
              }
              for (const [u, _t] of dodgedAt) if (st.units[u]!.life !== 'dead' && !has(st.units[u]!, COND.dodging)) ok = false;
              const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
              if (keys.includes('dodge') && view.ai.roll(2) === 1) {
                dodgedAt.set(me.idx, me.turns);
                return keys.indexOf('dodge');
              }
              const a = keys.findIndex((k) => k.startsWith('attack:'));
              return a >= 0 && view.ai.roll(2) === 1 ? a : 0;
            }
            return 0;
          },
        };
        const setup = setupOf({ units: [UNITS[0]!, UNITS[1]!, { seat: 'gob2', team: 'enemies', use: 'srd:goblin-warrior', at: 'D3' }] });
        runFight({ ...setup, knobs: { ...setup.knobs, maxRounds: 4 } }, seed, 0, setup.seats.map(() => decider), null);
        return ok;
      }),
      { numRuns: 40 },
    );
  });

  it('Patient Defense, 11128-11132: "expend 1 Focus Point to take both the Disengage and the Dodge actions as a Bonus Action"', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    const free = pick(w, pc, 'use:lab-focus/patient');
    resolveOption(w.cx, pc, free, -1);
    expect(has(pc, COND.disengaged)).toBe(true);
    expect(has(pc, COND.dodging)).toBe(false);
    expect([pc.b.bonus, pc.b.action, pc.res[9]]).toEqual([0, 1, 6]);
    endTurn(w, pc);
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-focus/patient-focus'), -1);
    expect(has(pc, COND.disengaged) && has(pc, COND.dodging)).toBe(true);
    expect([pc.b.bonus, pc.b.action, pc.res[9]]).toEqual([0, 1, 5]);
  });

  it('Step of the Wind, 11133-11136: the Dash action as a Bonus Action adds movement equal to your Speed', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-focus/wind'), -1);
    expect(pc.b.moveFt).toBe(80);
    expect(pc.b.dashes).toBe(1);
    expect(pc.b.action).toBe(1);
  });

  it('a feature with several activations keys each use:<feature>/<activation>; a one-activation feature keeps use:<feature>', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    const keys = options(w, pc).map((o) => o.key).filter((k) => k.startsWith('use:'));
    expect(keys).toEqual(expect.arrayContaining(['use:lab-focus/flurry', 'use:lab-focus/patient', 'use:lab-focus/patient-focus', 'use:lab-focus/wind', 'use:lab-focus/wind-focus', 'use:lab-martial-arts', 'use:lab-surge', 'use:lab-costly', 'use:lab-offhand']));
    const f = pc.tpl.features.find((x) => x.id === 'test:lab-focus')!;
    expect(activationOf(f, 0).local).toBe('flurry');
    expect(activationOf(f, 3).local).toBe('wind');
  });

  it('a reaction-cost activation is never a turn option', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(options(w, pc).map((o) => o.key)).not.toContain('use:lab-parry');
  });

  it('gainAction, Action Surge 10627-10628: "you can take one additional action": one use adds exactly one', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-surge'), -1);
    expect(pc.b.action).toBe(2);
    expect(options(w, pc).map((o) => o.key)).not.toContain('use:lab-surge'); // perTurn: once this turn
  });

  it('property: gainAction never gives more than its uses grant in one turn (once-per-turn surge: at most 2 actions)', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 12 }), (picks) => {
        const w = world();
        const pc = w.u('pc1');
        startTurn(w, pc);
        let most = pc.b.action;
        for (const p of picks) {
          const opts = options(w, pc).filter((o) => o.key !== 'pass' && !o.key.startsWith('move:'));
          if (opts.length === 0) break;
          resolveOption(w.cx, pc, opts[p % opts.length]!.l, -1);
          if (pc.b.action > most) most = pc.b.action;
        }
        return most <= 2;
      }),
      { numRuns: 60 },
    );
  });
});

describe('POOLX: pool steps and activation costs in points', () => {
  it('uses: { pool, cost: 3 } needs 3 points to be offered, and spends 3', () => {
    const w = world();
    const pc = w.u('pc1');
    startTurn(w, pc);
    pc.res[9] = 2;
    expect(options(w, pc).map((o) => o.key)).not.toContain('use:lab-costly');
    pc.res[9] = 4;
    resolveOption(w.cx, pc, pick(w, pc, 'use:lab-costly'), -1);
    expect(pc.res[9]).toBe(1);
  });

  it('refill sets a pool to its max; a change is logged as "regains"', () => {
    const sink = new ArraySink();
    const w = world({}, undefined, sink);
    const pc = w.u('pc1');
    pc.res[9] = 1;
    runSteps(w.cx, newFrame(pc, { via: 'test:x', name: 'x', cause: -1 }), [{ k: 'pool', res: 9, delta: 'refill' }]);
    expect(pc.res[9]).toBe(6);
    expect(renderLog(sink.events, w.setup).join('\n')).toMatch(/pc1 regains 5 Focus Points \(6 left\)/);
  });

  it('property: a pool never goes below 0 or above its max, whatever the changes', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.integer({ min: -9, max: 9 }).filter((n) => n !== 0), fc.constant('refill' as const)), { maxLength: 20 }), (deltas) => {
        const w = world();
        const pc = w.u('pc1');
        for (const d of deltas) {
          runSteps(w.cx, newFrame(pc, { via: 'test:x', name: 'x', cause: -1 }), [{ k: 'pool', res: 9, delta: d }] as Step[]);
          if (pc.res[9]! < 0 || pc.res[9]! > 6) return false;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('a pool step on a pool the character lacks is a load error', () => {
    const r = loadContent(withFiles({ ...KIT, 'packs/test/data/lab-costly.yaml': feature('lab-costly', 'activate: { id: c, name: c, cost: bonus, do: [{ pool: { id: ki, delta: 1 } }] }\n'), [MONK_PATH]: MONK(ALL) }));
    expect(messages(r)).toMatch(/no pool "ki"/);
  });
});

describe('HOOKX: Uncanny Metabolism at initiative (srd-raw.txt:11146-11151, C14)', () => {
  const run = (choice: 'pass' | 'metabolism', seed = 3) => {
    const sink = new ArraySink();
    const asked: string[][] = [];
    const decider: Decider = {
      name: 'script',
      decide(_v, dp) {
        if (dp.k === 'pick' && dp.round === 0) {
          const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
          asked.push(keys);
          return keys.indexOf(`pick:${choice}`);
        }
        return 0;
      },
    };
    const setup = setupOf();
    // The Monk starts down 20 HP, as after an earlier fight.
    const seats = setup.seats.map((s) => (s.seat === 'pc1' ? { ...s, hp: 25 } : s));
    const s2 = { ...setup, seats };
    let focus = -1;
    let metabolism = -1;
    let hp = -1;
    // A fight of 0 rounds: everything before round 1, initiative and its hooks included.
    const res = runFight({ ...s2, knobs: { ...s2.knobs, maxRounds: 0 } }, seed, 0, s2.seats.map(() => decider), sink, {
      audit: true,
      inspect: (st) => {
        const pc = st.units.find((u) => u.seat === 'pc1')!;
        focus = pc.res[9]!;
        metabolism = pc.res[10]!;
        hp = pc.hp;
      },
    });
    return { sink, asked, res, focus, metabolism, hp };
  };

  it('"When you roll Initiative, you can regain all expended Focus Points": an optional decision, pass first', () => {
    const r = run('pass');
    expect(r.asked).toEqual([['pick:pass', 'pick:metabolism']]);
    expect(r.metabolism).toBe(1);
    expect(r.hp).toBe(25);
  });

  it('using it heals Monk level plus the die (6 + 1d8) and spends its once-per-Long-Rest use', () => {
    const r = run('metabolism');
    expect(r.metabolism).toBe(0);
    expect(r.hp).toBeGreaterThanOrEqual(25 + 7);
    expect(r.hp).toBeLessThanOrEqual(25 + 14);
    expect(r.focus).toBe(6);
    const heal = r.sink.events.find((e) => e.k === 'heal');
    expect(heal && heal.k === 'heal' && heal.via).toBe('test:lab-metabolism');
  });

  it('its die sits on initiative slot 2: every initiative roll and tiebreak is the same whether it is used or not', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const init = (c: 'pass' | 'metabolism') => run(c, seed).sink.events.filter((e) => e.k === 'initiative');
      expect(init('metabolism')).toEqual(init('pass'));
    }
  });

  it('its die sits on its own fixed initiative slot: the first hook on slot 2, a second hook on the same creature on slot 3 (section 12: each new die on its own stream slot)', () => {
    const setup = setupOf({ features: [...ALL, 'test:lab-rally'] });
    const seats = setup.seats.map((s) => (s.seat === 'pc1' ? { ...s, hp: 20 } : s));
    const s2 = { ...setup, seats };
    const take: Decider = { name: 'take', decide: (_v, dp) => (dp.k === 'pick' && dp.round === 0 ? 1 : 0) };
    const pcSeat = setup.seats.find((s) => s.seat === 'pc1')!;
    for (const seed of [1, 2, 3, 4, 5]) {
      const sink = new ArraySink();
      // audit: opening one roll address twice throws, so two hooks sharing a slot fail here too.
      runFight({ ...s2, knobs: { ...s2.knobs, maxRounds: 0 } }, seed, 0, s2.seats.map(() => take), sink, { audit: true });
      const heals = sink.events.filter((e) => e.k === 'heal');
      expect(heals.map((e) => e.k === 'heal' && [e.via, e.slot])).toEqual([['test:lab-metabolism', 2], ['test:lab-rally', 3]]);
      // An independent draw from the same address: (seed, run 0, the seat, init, round 0, slot).
      const d8 = rollDie(openStream(seed, 0, pcSeat.seatKey, 'init', 0, 2), 8);
      const d4 = rollDie(openStream(seed, 0, pcSeat.seatKey, 'init', 0, 3), 4);
      expect(heals.map((e) => e.k === 'heal' && e.rolled)).toEqual([6 + d8, d4]);
    }
  });

  it('not offered once its use is spent', () => {
    const setup = setupOf();
    const asked: string[] = [];
    const decider: Decider = { name: 's', decide: (_v, dp) => (dp.k === 'pick' && asked.push(dp.keyOf(1)), 0) };
    const s2 = { ...setup, seats: setup.seats.map((s) => (s.seat === 'pc1' ? { ...s, tpl: { ...s.tpl, resMax: s.tpl.resMax.map((v, j) => (j === 10 ? 0 : v)) } } : s)) };
    runFight({ ...s2, knobs: { ...s2.knobs, maxRounds: 0 } }, 1, 0, s2.seats.map(() => decider), null);
    expect(asked).toEqual([]);
  });
});

describe('determinism: same seed, same log, with these primitives in play', () => {
  it('a scripted Monk fight (flurries, dodges, surges, the initiative hook) replays byte for byte', () => {
    const script: Decider = {
      name: 'script',
      decide(view, dp) {
        const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
        const me = view.q.units[view.me]!;
        if (dp.k === 'pick') return keys.length - 1;
        if (dp.k !== 'turn') return view.ai.roll(dp.legal.n) - 1;
        if (me.seat !== 'pc1') {
          const a = keys.findIndex((k) => k.startsWith('attack:'));
          return a >= 0 ? a : keys.indexOf('dodge') >= 0 ? keys.indexOf('dodge') : 0;
        }
        for (const want of ['use:lab-surge', 'use:lab-focus/flurry', 'use:lab-focus/patient-focus']) if (keys.includes(want)) return keys.indexOf(want);
        const a = keys.findIndex((k) => k.startsWith('attack:'));
        if (a >= 0) return a;
        return keys.includes('dodge') ? keys.indexOf('dodge') : 0;
      },
    };
    const logOf = () => {
      const setup = setupOf();
      const sink = new ArraySink();
      runFight(setup, 11, 0, setup.seats.map(() => script), sink, { audit: true });
      return renderLog(sink.events, setup).join('\n');
    };
    const a = logOf();
    expect(a).toBe(logOf());
    expect(a).toMatch(/Flurry of Blows/);
    expect(a).toMatch(/Dodge/);
  });
});

describe('the walker re-derives its budget mid-path when Speed changes (step-4 carry-over, walker.ts syncBudget)', () => {
  it('halved partway through a move (srd-raw.txt:1852-1862: the move deducts from your Speed), the rest of the path is cut short', () => {
    // The Monk (Speed 40, tender: damage halves its Speed) walks 5 squares away from a Brute,
    // whose Opportunity Attack (+30, 1 damage) lands before the first step: after that step
    // the Speed is 20 with 5 ft moved, so 15 ft are left: 3 more squares, then the path stops.
    const units: UnitDoc[] = [
      { seat: 'pc1', team: 'party', use: 'test:lab-monk', at: 'B2' },
      { seat: 'brute', team: 'enemies', use: 'test:lab-brute', at: 'A2' },
    ];
    const oa: Decider = { name: 'oa', decide: (_v, dp) => Math.max(0, Array.from({ length: dp.legal.n }, (_, i) => dp.legal.items[i]!.k).indexOf('oa')) };
    let hits = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const setup = setupOf({ features: ['test:lab-tender'], units, w: 10 });
      const sink = new ArraySink();
      const cx = createContext(setup, seed, 0, setup.seats.map(() => oa), sink, { audit: true });
      applyPassives(cx, -1);
      cx.st.order.forEach((_, i) => (cx.st.order[i] = i)); // no initiative rolled: seat order
      const w: World = { cx, setup, u: (s) => cx.st.units.find((x) => x.seat === s)! };
      const pc = w.u('pc1');
      startTurn(w, pc);
      const path = Int32Array.from(['C2', 'D2', 'E2', 'F2', 'G2'].map((c) => parseCell(c, setup.w, setup.h)));
      walkPath(cx, pc, path, path.length, 'voluntary', -1);
      const end = sink.events.find((e) => e.k === 'moveEnd')!;
      const hit = sink.events.some((e) => e.k === 'attack' && e.hit);
      if (hit) {
        hits++;
        expect(end.k === 'moveEnd' && [end.steps, end.why]).toEqual([4, 'blocked']);
        expect(pc.b.moveFt).toBe(0);
      } else expect(end.k === 'moveEnd' && [end.steps, end.why]).toEqual([5, 'arrived']);
    }
    expect(hits).toBeGreaterThan(0);
  });
});
