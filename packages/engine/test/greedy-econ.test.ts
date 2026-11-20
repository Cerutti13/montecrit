// Greedy valuation of M3 step 5a's primitives (docs/design/m3.md section 3, critique C6;
// decide/greedy/econ.ts): for each primitive a constructed state where greedy picks it over a
// plausible alternative, and a twin state where it correctly declines; Explain naming each new
// term; and the step-4 carry-overs (critMin in routines, foeRoutine's automatic Critical Hit).
// Rule text is cited by its line in the SRD 5.2.1 PDF text (srd-raw.txt). Content is synthetic
// (test: ids), compiled from YAML with the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionKind, DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives, runPrecasts } from '../src/sim/precast.ts';
import { COND, type Unit } from '../src/sim/state.ts';

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

const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;

/** A Monk-shaped PC: DEX 16, WIS 16, PB 3, level 6, Speed 40, Unarmed Strike 1d8 + DEX; Focus `focus` points. */
const MONK = (features: string[], focus: number, extra = '') => `${extra}kind: pc
id: test:econ-monk
name: Econ Monk
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: 40
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
hpMax: 60
ac: 16
armor: none
saveProficiencies: [str, dex]
weapons:
  - { id: shortsword, name: Shortsword, kind: melee, ability: finesse, category: martial, light: true, damage: [{ roll: 1d6 + @mod, type: piercing }] }
unarmedStrike: { ability: finesse, damage: 1d8 + @mod }
pools:
  - { id: focus, name: Focus Points, max: ${focus}, recharge: shortRest }
  - { id: surge, name: Surge, max: 1, recharge: shortRest }
  - { id: um, name: Metabolism, max: 1, recharge: longRest }
features: [${features.map((f) => `test:${f}`).join(', ')}]
`;

const monster = (id: string, hp: number, toHit: number, dmg: string, avg: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${toHit}, damage: [{ roll: '${dmg}', type: slashing, avg: ${avg} }] }
`;

const KIT: Record<string, string> = {
  'packs/test/monsters/econ-brute.yaml': monster('econ-brute', 30, 5, '2d6 + 3', 10),
  'packs/test/monsters/econ-mook.yaml': monster('econ-mook', 1, 0, '1', 1),
  'packs/test/monsters/econ-wall.yaml': monster('econ-wall', 500, 0, '1', 1),
  'packs/test/monsters/econ-four.yaml': monster('econ-four', 30, 10, '4', 4),
  'packs/test/monsters/econ-triple.yaml': monster('econ-triple', 30, 10, '2d6 + 3', 10) + 'multiattack:\n  alternatives:\n    - [{ count: 3, from: [claw] }]\n',
  'packs/test/data/e-smite.yaml': feature('e-smite', 'riders:\n  - { id: smite, name: Smite, on: hit, do: [{ damage: [{ roll: 20d2, type: radiant }] }] }\n'),
  'packs/test/data/e-focus.yaml': feature(
    'e-focus',
    `activate:
  - { id: flurry, name: Flurry of Blows, cost: bonus, uses: { pool: focus }, do: [{ weaponAttack: { with: unarmed, count: 2 } }] }
  - { id: bonus-strike, name: Bonus Unarmed Strike, cost: bonus, do: [{ weaponAttack: { with: unarmed } }] }
  - { id: patient, name: Patient Defense, cost: bonus, do: [{ core: disengage }] }
  - { id: patient-focus, name: Patient Defense (Focus), cost: bonus, uses: { pool: focus }, do: [{ core: disengage }, { core: dodge }] }
  - { id: wind, name: Step of the Wind, cost: bonus, do: [{ core: dash }] }
  - { id: wind-focus, name: Step of the Wind (Focus), cost: bonus, uses: { pool: focus }, do: [{ core: disengage }, { core: dash }] }
`,
  ),
  'packs/test/data/e-stun.yaml': feature(
    'e-stun',
    `spellAbility: wis
riders:
  - { id: stunning-strike, name: Stunning Strike, on: hit, filter: { attack: [unarmed, monkWeapon] }, oncePerTurn: global, cost: { pool: focus }, do: [{ save: { ability: con, onFail: [{ condition: { id: stunned, until: { until: startOfNextTurn, of: caster } } }] } }] }
`,
  ),
  'packs/test/data/e-topple.yaml': feature(
    'e-topple',
    `spellAbility: wis
riders:
  - { id: topple, name: Topple, on: hit, do: [{ save: { ability: dex, onFail: [{ condition: { id: prone } }] } }] }
`,
  ),
  'packs/test/data/e-deflect.yaml': feature('e-deflect', 'reaction: { window: hitTaken, reduce: 1d10 + @mod.dex + @classLevel, damageTypes: [bludgeoning, piercing, slashing] }\n'),
  'packs/test/data/e-deflect3.yaml': feature('e-deflect3', 'reaction: { window: hitTaken, reduce: 1d10 + @mod.dex + @classLevel, damageTypes: [bludgeoning, piercing, slashing], pool: focus, points: 3 }\n'),
  'packs/test/data/e-surge.yaml': feature('e-surge', 'activate: { id: surge, name: Surge, cost: free, uses: { pool: surge }, do: [{ gainAction: action }] }\n'),
  'packs/test/data/e-metabolism.yaml': feature(
    'e-metabolism',
    `initiative: { id: metabolism, name: Metabolism, uses: { pool: um }, do: [{ pool: { id: focus, delta: refill } }, { heal: { roll: '6 + 1d8' } }] }
`,
  ),
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number; precast?: unknown[] };
const PC_AT = (at = 'B2', hp?: number): U => ({ seat: 'pc1', team: 'party', use: 'test:econ-monk', at, ...(hp !== undefined ? { hp } : {}) });
const foe = (seat: string, use: string, at: string, hp?: number): U => ({ seat, team: 'enemies', use: `test:${use}`, at, ...(hp !== undefined ? { hp } : {}) });

/** A fight where pc1 (the Monk shape) has `features`; every seat greedy, with an explain sink. */
function scene(features: string[], units: U[], focus = 6, w = 12, flags: Record<string, unknown> = {}, pcExtra = '') {
  const files = [...REPO, ...Object.entries({ ...KIT, 'packs/test/pcs/econ-monk.yaml': MONK(features, focus, pcExtra) }).map(([path, text]) => ({ path, text }))];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gecon', name: 'Greedy econ', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w, h: 6 },
    flags: { initiativeMode: 'static', ...flags }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gecon.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  const s = res.setup;
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, null);
  applyPassives(cx, -1);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  /** Greedy's turn choice for `who`: its key and explain record. */
  const decide = (who: Unit): { key: string; rec: ExplainRecord } => {
    const list = listOptions(cx, who, takeList(cx));
    const items: Legal[] = [];
    const keys: string[] = [];
    for (let i = 0; i < list.n; i++) {
      keys.push(legalKey(cx.st, who.idx, list.items[i]!));
      items.push(copyLegal(list.items[i]!, newLegal()));
    }
    releaseList(cx, list);
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    records.length = 0;
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return { key: keys[i]!, rec: records.at(-1)! };
  };
  /** Asks `who` a non-turn decision with these items (each: its key and how to fill the Legal). */
  const ask = (who: Unit, k: DecisionKind, rows: { key: string; fill: (l: Legal) => void }[], extra: Partial<DecisionPoint> = {}): { key: string; rec: ExplainRecord | undefined } => {
    const items = rows.map((r) => {
      const l = newLegal();
      r.fill(l);
      return l;
    });
    const dp: DecisionPoint = { k, who: who.idx, at: 7, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => rows[i]!.key, ...extra };
    records.length = 0;
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return { key: rows[i]!.key, rec: records.at(-1) };
  };
  return { cx, s, u, ds, begin, decide, ask };
}
const part = (rec: ExplainRecord, key: string, term: string) => rec.top.find((t) => t.key === key)?.parts.find((p) => p.term === term)?.ev;
const focusOf = (u: Unit) => u.tpl.pools.findIndex((p) => p.local === 'focus') + 9;

describe('WATK: a feature\'s strikes are valued like the Attack action\'s (Flurry of Blows, srd-raw.txt:11126-11127)', () => {
  it('after the Attack action, greedy spends a Focus Point on Flurry of Blows rather than the free bonus strike, and Explain names the terms', () => {
    const w = scene(['e-focus'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.action = 0;
    const r = w.decide(pc);
    expect(r.key).toMatch(/\/flurry$/);
    expect(part(r.rec, r.key, 'weapon strikes')).toBeGreaterThan(0);
    expect(part(r.rec, r.key, 'Focus Points spent: what else it could buy')).toBeLessThan(0);
  });

  it('a free rider on its hits (Prone on a failed save, 34010-34019) adds to the strikes\' value, and Explain names it', () => {
    const w = scene(['e-focus', 'e-topple'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.action = 0;
    const r = w.decide(pc);
    expect(r.key).toMatch(/\/flurry$/);
    expect(part(r.rec, r.key, 'riders on its hits')).toBeGreaterThan(0);
  });

  it('declines Flurry when its second strike buys nothing: a 1-HP foe with no one else in reach takes the free strike', () => {
    const w = scene(['e-focus'], [PC_AT(), foe('m1', 'econ-mook', 'C2')], 1);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.action = 0;
    expect(w.decide(pc).key).toMatch(/\/bonus-strike$/);
  });
});

describe('ECON: Dodge, Dash, Disengage and an extra action as options with their values', () => {
  const MOB = [foe('b1', 'econ-brute', 'C2'), foe('b2', 'econ-brute', 'C3'), foe('b3', 'econ-brute', 'B3')];

  /** At 12 HP among the three brutes, with three allies acting before them: out of the brutes' reach (so they take none of the attacks) and each with a foe in its own. */
  const lowWithAllies = () => {
    const units: U[] = [PC_AT('B2', 12), ...['K2', 'K3', 'K4'].map((at, i): U => ({ seat: `pc${i + 2}`, team: 'party', use: 'test:econ-monk', at })), ...MOB];
    const w = scene([], units);
    units.forEach((x, i) => (w.cx.st.order[i] = w.u(x.seat).idx));
    return w;
  };

  it('Dodge (33369-33376): at 12 HP among three brutes, with allies acting before them to buy the time, greedy Dodges instead of attacking; alone nothing is bought, no Dodge row, and it Disengages out; at 60 HP next to one brute it attacks', () => {
    const low = lowWithAllies();
    const pc = low.u('pc1');
    low.begin(pc);
    const r = low.decide(pc);
    expect(r.key).toBe('dodge');
    expect(part(r.rec, 'dodge', 'Dodge: attacks against it have Disadvantage')).toBeGreaterThan(0);
    const alone = scene([], [PC_AT('B2', 12), ...MOB]);
    const pc1 = alone.u('pc1');
    alone.begin(pc1);
    const a = alone.decide(pc1);
    expect(a.key).toBe('opt:disengage');
    expect(a.rec.top.map((t) => t.key)).not.toContain('dodge');
    const high = scene([], [PC_AT('B2'), MOB[0]!]);
    const pc2 = high.u('pc1');
    high.begin(pc2);
    expect(high.decide(pc2).key).toMatch(/^attack:/);
  });

  it('Dodge is worth nothing once it is up: dodging, greedy attacks (its exposure already has the Disadvantage), in the scene where it would otherwise Dodge', () => {
    const w = lowWithAllies();
    const pc = w.u('pc1');
    w.begin(pc);
    expect(w.decide(pc).key).toBe('dodge');
    w.begin(pc);
    pc.condMask |= COND.dodging;
    pc.conds.push({ bit: COND.dodging, via: 'core:dodge', src: pc.idx, cause: -1, until: { k: 'never' } });
    pc.b.action = 1;
    const r = w.decide(pc);
    expect(r.key).not.toBe('dodge');
  });

  it('Patient Defense with a Focus Point (11128-11132): after attacking, at 12 HP greedy takes Disengage and Dodge as its bonus action; at 60 HP it Flurries', () => {
    const low = scene(['e-focus'], [PC_AT('B2', 12), ...MOB]);
    const pc = low.u('pc1');
    low.begin(pc);
    pc.b.action = 0;
    expect(low.decide(pc).key).toMatch(/\/patient-focus$/);
    const high = scene(['e-focus'], [PC_AT('B2'), ...MOB]);
    const pc2 = high.u('pc1');
    high.begin(pc2);
    pc2.b.action = 0;
    expect(high.decide(pc2).key).toMatch(/\/flurry$/);
  });

  it('Disengage first (33363-33366) values Patient Defense\'s Dodge where the move ends: retreating out of every foe\'s reach, greedy does not spend a Focus Point on a Dodge worth nothing there, and Explain names the terms', () => {
    const w = scene(['e-focus'], [PC_AT('B2', 12), foe('b1', 'econ-brute', 'A1'), foe('b2', 'econ-brute', 'A2'), foe('b3', 'econ-brute', 'A3')], 6, 16);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.rec.note).toBe('the best move provokes: Disengage first');
    expect(r.key).not.toMatch(/patient-focus/);
    const top = r.rec.top.find((t) => t.key === r.key)!;
    expect(top.parts.map((p) => p.term)).toContain('the move it frees of opportunity attacks, net of its risk and exposure there');
    // Without its action, the choice is between the two Patient Defenses: the free one.
    const w2 = scene(['e-focus'], [PC_AT('B2', 12), foe('b1', 'econ-brute', 'A1'), foe('b2', 'econ-brute', 'A2'), foe('b3', 'econ-brute', 'A3')], 6, 16);
    const pc2 = w2.u('pc1');
    w2.begin(pc2);
    pc2.b.action = 0;
    const r2 = w2.decide(pc2);
    expect(r2.rec.note).toBe('the best move provokes: Disengage first');
    expect(r2.key).toMatch(/\/patient$/);
    expect(r2.rec.top.find((t) => t.key === r2.key)!.parts.map((p) => p.term)).toContain('what else it does there, net of its cost');
  });

  it('Step of the Wind (11133-11134, Dash 33240-33246): a foe 70 ft away is out of reach until greedy Dashes as a bonus action; next to it, greedy does not Dash', () => {
    // Coverage 8'b G1: against a brute, a PC now prefers to close in out of its reach for next turn
    // (exposure-aware) over charging in with a bonus Dash; against a harmless foe the Dash's strikes
    // this turn win (greedy-approach.test.ts has the brute case).
    const far = scene(['e-focus'], [PC_AT('A1'), foe('b1', 'econ-wall', 'O1')], 6, 16);
    const pc = far.u('pc1');
    far.begin(pc);
    const r = far.decide(pc);
    expect(r.key).toMatch(/\/wind$/);
    expect(part(r.rec, r.key, 'Dash or extra action: the strikes it brings')).toBeGreaterThan(0);
    const near = scene(['e-focus'], [PC_AT('A1'), foe('b1', 'econ-brute', 'B1')], 6, 16);
    const pc2 = near.u('pc1');
    near.begin(pc2);
    expect(near.decide(pc2).key).not.toMatch(/wind/);
  });

  it('one more action (gainAction): with its action spent next to a foe greedy uses it; with no foe in reach it keeps it', () => {
    const w = scene(['e-surge'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.action = 0;
    expect(w.decide(pc).key).toMatch(/surge/);
    const far = scene(['e-surge'], [PC_AT('A1'), foe('b1', 'econ-brute', 'L6')]);
    const pc2 = far.u('pc1');
    far.begin(pc2);
    pc2.b.action = 0;
    expect(far.decide(pc2).key).not.toMatch(/surge/);
  });
});

describe('HOOKX and POOLX: the initiative hook (Uncanny Metabolism\'s shape, 11146-11152)', () => {
  const HOOK_ROWS = [
    { key: 'pick:pass', fill: (l: Legal) => { l.k = 'pick'; l.opt = 0; } },
    { key: 'pick:metabolism', fill: (l: Legal) => { l.k = 'pick'; l.opt = 1; } },
  ];
  it('with Focus spent and HP missing greedy uses it (holding it buys nothing: Initiative comes once a fight)', () => {
    const w = scene(['e-focus', 'e-metabolism'], [PC_AT('B2', 30), foe('b1', 'econ-brute', 'J5')]);
    const pc = w.u('pc1');
    pc.res[focusOf(pc)] = 1;
    const r = w.ask(pc, 'pick', HOOK_ROWS, { round: 0, src: { via: 'test:e-metabolism' } });
    expect(r.key).toBe('pick:metabolism');
    expect(r.rec!.top.find((t) => t.key === 'pick:metabolism')!.parts[0]!.ev).toBeGreaterThan(0);
  });
  it('at full Focus and HP it would restore nothing, so greedy passes', () => {
    const w = scene(['e-focus', 'e-metabolism'], [PC_AT('B2'), foe('b1', 'econ-brute', 'J5')]);
    const pc = w.u('pc1');
    expect(w.ask(pc, 'pick', HOOK_ROWS, { round: 0, src: { via: 'test:e-metabolism' } }).key).toBe('pick:pass');
  });
});

describe('RIDER: P(effect) x its value against the points it costs (Stunning Strike, 11201-11208)', () => {
  const riderRows = (ri = 0) => [
    { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
    { key: 'rider:stunning-strike', fill: (l: Legal) => { l.k = 'pick'; l.opt = 0; l.aux = ri; } },
  ];
  const hitOn = (pc: Unit, t: Unit) => ({ src: { via: 'test:e-stun', target: t.idx }, hit: { attacker: pc.idx, target: t.idx, via: pc.tpl.attacks.find((a) => a.unarmed)!.id, crit: false, total: -1, types: 0 } });

  it('greedy stuns a healthy brute it just hit, and Explain names the effect and the Focus cost', () => {
    const w = scene(['e-focus', 'e-stun'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.ask(pc, 'rider', riderRows(), hitOn(pc, w.u('b1')));
    expect(r.key).toBe('rider:stunning-strike');
    const top = r.rec!.top.find((t) => t.key === 'rider:stunning-strike')!;
    expect(top.parts.map((p) => p.term)).toEqual(['Stunning Strike: its effect, P(effect) x value', 'Focus Points spent: what else it could buy']);
  });

  it('on a brute already Stunned the rider adds about nothing, so greedy keeps the point', () => {
    const w = scene(['e-focus', 'e-stun'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    const b = w.u('b1');
    w.begin(pc);
    b.condMask |= COND.stunned | COND.incapacitated;
    expect(w.ask(pc, 'rider', riderRows(), hitOn(pc, b)).key).toBe('pass');
  });

  it('"until the start of your next turn" (11206-11207): an opportunity attack hit on the brute\'s own turn, its action spent, stuns it for no turn of its own, so greedy keeps the point', () => {
    const w = scene(['e-focus', 'e-stun'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    const b = w.u('b1');
    w.begin(b);
    b.b.action = 0;
    const r = w.ask(pc, 'rider', riderRows(), hitOn(pc, b));
    expect(r.key).toBe('pass');
    // With its action still unspent the Stunned costs it this turn's action: worth the point.
    b.b.action = 1;
    expect(w.ask(pc, 'rider', riderRows(), hitOn(pc, b)).key).toBe('rider:stunning-strike');
  });

  it('on a brute the hit itself will almost surely drop (1 HP), greedy keeps the point', () => {
    const w = scene(['e-focus', 'e-stun'], [PC_AT(), foe('b1', 'econ-brute', 'C2', 1)]);
    const pc = w.u('pc1');
    w.begin(pc);
    expect(w.ask(pc, 'rider', riderRows(), hitOn(pc, w.u('b1'))).key).toBe('pass');
  });

  it('a free rider is taken when it does something (Prone, 34010-34019) and passed when it would not (already Prone)', () => {
    const rows = [
      { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
      { key: 'rider:topple', fill: (l: Legal) => { l.k = 'pick'; l.opt = 0; l.aux = 0; } },
    ];
    const w = scene(['e-topple'], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    const b = w.u('b1');
    w.begin(pc);
    const hit = { src: { via: 'test:e-topple', target: b.idx }, hit: { attacker: pc.idx, target: b.idx, via: pc.tpl.attacks[0]!.id, crit: false, total: -1, types: 0 } };
    expect(w.ask(pc, 'rider', rows, hit).key).toBe('rider:topple');
    b.condMask |= COND.prone;
    expect(w.ask(pc, 'rider', rows, hit).key).toBe('pass');
  });
});

describe('RIDER dice on a Critical Hit (riderDiceCritDouble, srd-raw.txt:2207-2211)', () => {
  const rows = [
    { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
    { key: 'rider:smite', fill: (l: Legal) => { l.k = 'pick'; l.opt = 0; l.aux = 0; } },
  ];
  const value = (flag: boolean) => {
    const w = scene(['e-smite'], [PC_AT(), foe('b1', 'econ-wall', 'C2')], 6, 12, { riderDiceCritDouble: flag });
    const pc = w.u('pc1');
    const b = w.u('b1');
    w.begin(pc);
    const hit = { src: { via: 'test:e-smite', target: b.idx }, hit: { attacker: pc.idx, target: b.idx, via: pc.tpl.attacks.find((a) => a.unarmed)!.id, crit: true, total: -1, types: 0 } };
    const r = w.ask(pc, 'rider', rows, hit);
    expect(r.key).toBe('rider:smite');
    return r.rec!.top.find((t) => t.key === 'rider:smite')!.parts[0]!.ev;
  };
  it('on a crit, with the flag on the rider\'s 20d2 is rolled twice (mean 60); with it off, once (mean 30): a 500-HP target, so nothing is capped', () => {
    expect(value(true)).toBeCloseTo(60, 6);
    expect(value(false)).toBeCloseTo(30, 6);
  });
});

describe('REACT hitTaken: Deflect Attacks from the rolled damage and the reduction\'s exact PMF (11154-11158)', () => {
  const rows = [
    { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
    { key: 'react:e-deflect', fill: (l: Legal) => { l.k = 'react'; l.opt = 0; } },
  ];
  const hit = (a: Unit, t: Unit, total: number) => ({ src: { via: 'claw', target: a.idx }, hit: { attacker: a.idx, target: t.idx, via: a.tpl.attacks[0]!.id, crit: false, total, types: 1 } });

  it('a 30-damage hit at 25 HP: greedy reacts (it stops most of the damage and the drop), and Explain names both terms', () => {
    const w = scene(['e-deflect'], [PC_AT('B2', 25), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    const r = w.ask(pc, 'hitTaken', rows, hit(w.u('b1'), pc, 30));
    expect(r.key).toBe('react:e-deflect');
    const terms = r.rec!.top.find((t) => t.key === 'react:e-deflect')!.parts.map((p) => p.term);
    expect(terms).toContain('damage it stops, E[min(rolled, reduction)]');
    expect(terms).toContain('the drop it prevents');
  });

  it('one Reaction stops one hit (1438-1439): a 4-damage hit with four more flat-4 attackers to come is deflected, since no later hit can save more', () => {
    const w = scene(['e-deflect'], [PC_AT('B2'), foe('b1', 'econ-four', 'C2'), foe('b2', 'econ-four', 'C3'), foe('b3', 'econ-four', 'B3'), foe('b4', 'econ-four', 'A3'), foe('b5', 'econ-four', 'A2')]);
    const pc = w.u('pc1');
    const st = w.cx.st;
    for (let k = 0; k < st.order.length; k++) st.order[k] = k; // pc1 acts first, then b1..b5
    const b1 = w.u('b1');
    w.begin(b1);
    st.orderPos = st.order.indexOf(b1.idx);
    Object.assign(b1.b, { action: 0, atkActive: true, atkLive: 1 }); // its one claw made (sim/act.ts)
    b1.b.atkCounts[0] = 1;
    const r = w.ask(pc, 'hitTaken', rows, hit(w.u('b1'), pc, 4));
    expect(r.key).toBe('react:e-deflect');
    const parts = r.rec!.top.find((t) => t.key === 'react:e-deflect')!.parts;
    const stops = parts.find((p) => p.term.startsWith('damage it stops'))!.ev;
    const kept = -parts.find((p) => p.term.startsWith('Reaction kept'))!.ev;
    expect(kept).toBeLessThan(stops); // E[best later saving] <= 4 x P(some later hit lands) < 4
  });

  it('the attacker\'s own strikes still to come count: the first claw of three (Multiattack) rolled low is passed, to keep the Reaction for the next ones', () => {
    const w = scene(['e-deflect'], [PC_AT('B2'), foe('b1', 'econ-triple', 'C2')]);
    const pc = w.u('pc1');
    const b = w.u('b1');
    w.begin(b);
    // As sim/act.ts leaves it after the first strike: the Attack action started, one claw made.
    b.b.action = 0;
    b.b.atkActive = true;
    b.b.atkCounts[0] = 1;
    b.b.atkLive = 1;
    expect(w.ask(pc, 'hitTaken', rows, hit(b, pc, 5)).key).toBe('pass');
    // The last claw: nothing of its own left to come, so the hit is deflected.
    b.b.atkCounts[0] = 3;
    expect(w.ask(pc, 'hitTaken', rows, hit(b, pc, 5)).key).toBe('react:e-deflect');
  });

  // Each of its terms decides somewhere, and the row's value is the sum of its Explain parts.
  const laterBrutes = (w: ReturnType<typeof scene>) => {
    const st = w.cx.st;
    for (let k = 0; k < st.order.length; k++) st.order[k] = k; // pc1 first, then b1, b2, b3
    const b1 = w.u('b1');
    w.begin(b1);
    st.orderPos = st.order.indexOf(b1.idx);
    Object.assign(b1.b, { action: 0, atkActive: true, atkLive: 1 });
    b1.b.atkCounts[0] = 1;
  };
  const row = (r: { rec: ExplainRecord | undefined }) => r.rec!.top.find((t) => t.key === 'react:e-deflect' || t.key === 'react:e-deflect3')!;
  const sumOk = (t: ExplainRecord['top'][number]) => expect(t.parts.reduce((n, p) => n + p.ev, 0)).toBeCloseTo(t.ev, 9);

  it('the drop it prevents decides: a 5-damage hit at 3 HP with two brutes still to come is deflected; at 30 HP the same hit is passed (the Reaction is kept for them)', () => {
    const units = (hp: number) => [PC_AT('B2', hp), foe('b1', 'econ-brute', 'C2'), foe('b2', 'econ-brute', 'C3'), foe('b3', 'econ-brute', 'B3')];
    const low = scene(['e-deflect'], units(3));
    laterBrutes(low);
    const r = low.ask(low.u('pc1'), 'hitTaken', rows, hit(low.u('b1'), low.u('pc1'), 5));
    expect(r.key).toBe('react:e-deflect');
    const t = row(r);
    const ev = (term: string) => t.parts.find((p) => p.term.startsWith(term))!.ev;
    expect(ev('damage it stops')).toBeCloseTo(5, 9); // R >= 1 + 3 + 6: it always stops all 5
    expect(ev('the drop it prevents')).toBeGreaterThan(0);
    expect(ev('damage it stops') + ev('Reaction kept')).toBeLessThan(0); // without the drop term it would pass
    sumOk(t);
    const high = scene(['e-deflect'], units(30));
    laterBrutes(high);
    expect(high.ask(high.u('pc1'), 'hitTaken', rows, hit(high.u('b1'), high.u('pc1'), 5)).key).toBe('pass');
  });

  it('concentration kept decides (Concentration, 32993-32994: damage forces a save): a 3-damage hit on a concentrating PC is deflected to 0; not concentrating, it is passed', () => {
    // Coverage 8'b G6 (m7): a live zone counts its per-round payoff only, no appear hook again, so this needs a level 3 Moonbeam.
    const extra = "slots: [4, 3, 2]\ncasting: [{ source: x, ability: wis, list: druid, prepared: ['srd:moonbeam'] }]\nitems: [{ id: charm, name: Charm, kind: focus, focusFor: [druid] }]\nhands: [charm, null]\n";
    const at = (pre: boolean) => {
      const pc = { ...PC_AT('B2'), ...(pre ? { precast: [{ cast: 'srd:moonbeam', level: 3, at: 'E4' }] } : {}) };
      const w = scene(['e-deflect'], [pc, foe('b1', 'econ-brute', 'C2'), foe('b2', 'econ-brute', 'E4'), foe('b3', 'econ-brute', 'E5'), foe('b4', 'econ-brute', 'F4')], 6, 12, {}, extra);
      runPrecasts(w.cx, -1);
      laterBrutes(w);
      return { w, r: w.ask(w.u('pc1'), 'hitTaken', rows, hit(w.u('b1'), w.u('pc1'), 3)) };
    };
    const c = at(true);
    expect(c.w.u('pc1').conc).toBeGreaterThanOrEqual(0);
    expect(c.r.key).toBe('react:e-deflect');
    const t = row(c.r);
    const ev = (term: string) => t.parts.find((p) => p.term.startsWith(term))?.ev ?? 0;
    expect(ev('concentration kept')).toBeGreaterThan(0);
    expect(ev('damage it stops') + ev('Reaction kept')).toBeLessThan(0);
    sumOk(t);
    expect(at(false).r.key).toBe('pass');
  });

  it('the points it costs decide: a 10-damage hit is deflected for free, but not for 3 of 3 Focus Points that could buy strikes', () => {
    const free = scene(['e-deflect'], [PC_AT('B2'), foe('b1', 'econ-brute', 'C2')], 3);
    laterBrutes(free);
    expect(free.ask(free.u('pc1'), 'hitTaken', rows, hit(free.u('b1'), free.u('pc1'), 10)).key).toBe('react:e-deflect');
    const paid = scene(['e-deflect3', 'e-focus'], [PC_AT('B2'), foe('b1', 'econ-brute', 'C2')], 3);
    laterBrutes(paid);
    const prow = [rows[0]!, { key: 'react:e-deflect3', fill: (l: Legal) => { l.k = 'react'; l.opt = 0; } }];
    const r = paid.ask(paid.u('pc1'), 'hitTaken', prow, hit(paid.u('b1'), paid.u('pc1'), 10));
    expect(r.key).toBe('pass');
    const t = row(r);
    expect(t.parts.find((p) => p.term.startsWith('points spent'))!.ev).toBeLessThan(0);
    expect(t.parts.filter((p) => !p.term.startsWith('points spent')).reduce((n, p) => n + p.ev, 0)).toBeGreaterThan(0); // without the cost it would react
    sumOk(t);
  });

  it('keeping the Reaction for Deflect (econ.ts DEFLECT_KEEP): among three brutes greedy lets a 1-HP mook go rather than spend it on an opportunity attack, takes that attack without Deflect, and takes one that likely drops a brute', () => {
    const oaRows = (t: Unit) => [
      { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
      { key: 'oa:shortsword', fill: (l: Legal) => { l.k = 'oa'; l.atk = 0; l.target = t.idx; } },
    ];
    const mob = [foe('b1', 'econ-brute', 'A1'), foe('b2', 'econ-brute', 'A2'), foe('b3', 'econ-brute', 'A3')];
    const keep = scene(['e-deflect'], [PC_AT('B2'), ...mob, foe('m1', 'econ-mook', 'C2')]);
    const m1 = keep.u('m1');
    keep.begin(m1);
    expect(keep.ask(keep.u('pc1'), 'reaction', oaRows(m1)).key).toBe('pass');
    const none = scene([], [PC_AT('B2'), ...mob, foe('m1', 'econ-mook', 'C2')]);
    const m2 = none.u('m1');
    none.begin(m2);
    expect(none.ask(none.u('pc1'), 'reaction', oaRows(m2)).key).toBe('oa:shortsword');
    const strong = scene(['e-deflect'], [PC_AT('B2'), ...mob, foe('b4', 'econ-brute', 'C2', 3)]);
    const b4 = strong.u('b4');
    strong.begin(b4);
    expect(strong.ask(strong.u('pc1'), 'reaction', oaRows(b4)).key).toBe('oa:shortsword');
  });

  it('a 1-damage hit next to a foe it could make an opportunity attack against: greedy keeps the Reaction', () => {
    const w = scene(['e-deflect'], [PC_AT('B2'), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    expect(w.ask(pc, 'hitTaken', rows, hit(w.u('b1'), pc, 1)).key).toBe('pass');
  });
});

describe('step-4 carry-overs', () => {
  it('attackEVExact honors critMin on the attacker (Improved Critical\'s shape): a routine with critMin 19 is worth more than with 20', () => {
    const w = scene([], [PC_AT(), foe('b1', 'econ-brute', 'C2')]);
    const pc = w.u('pc1');
    const d = w.ds[pc.idx]! as unknown as { routine(st: unknown, u: Unit, ac: number): { melee: number }; decide: GreedyDecider['decide'] };
    w.begin(pc);
    w.decide(pc); // binds the decider to this fight
    const plain = d.routine(w.cx.st, pc, 12).melee;
    const pc19: Unit = { ...pc, stats: [{ s: { k: 'critMin', n: 19 }, fx: -1 }] };
    const keen = d.routine(w.cx.st, { ...pc19, idx: pc.idx + 50 }, 12).melee;
    expect(keen).toBeGreaterThan(plain);
  });

  it('foeRoutine counts the automatic Critical Hit on a Paralyzed creature (33941-33943): a heal goes to the Paralyzed ally over an equally hurt Restrained one', () => {
    const files = REPO;
    const r = loadContent(files);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    const doc = {
      kind: 'scenario', id: 'gcrit', name: 'Greedy crit', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 10, h: 6 },
      flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
      units: [
        { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A5', decider: 'greedy' },
        { seat: 'b', team: 'party', use: 'srd:warrior-veteran', at: 'C2', hp: 40, decider: 'greedy' },
        { seat: 'a', team: 'party', use: 'srd:warrior-veteran', at: 'G2', hp: 40, decider: 'greedy' },
        { seat: 'g1', team: 'enemies', use: 'srd:goblin-warrior', at: 'C1', decider: 'greedy' },
        { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: 'G1', decider: 'greedy' },
      ],
    };
    const res = resolveScenario(doc, 'gcrit.yaml', r.content);
    if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
    const ds = res.setup.seats.map(() => new GreedyDecider());
    const cx = createContext(res.setup, 1, 0, ds, null);
    const u = (seat: string) => cx.st.units.find((x) => x.seat === seat)!;
    const [pc, a, b] = [u('pc1'), u('a'), u('b')];
    a.condMask |= COND.paralyzed | COND.incapacitated;
    b.condMask |= COND.restrained;
    const items = [b, a].map((t) => {
      const l = newLegal();
      l.k = 'target';
      l.target = t.idx;
      return l;
    });
    const dp: DecisionPoint = { k: 'target', who: pc.idx, at: 0, round: 1, cause: -1, legal: { n: 2, items }, keyOf: (i) => `target:${[b, a][i]!.seat}`, src: { via: 'srd:healing-word' } };
    const got = ds[pc.idx]!.decide(cx.views[pc.idx]!, dp);
    expect(got).toBe(1);
  });
});

