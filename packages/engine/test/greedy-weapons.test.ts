// Greedy valuation of M3 step 5b's weapon rules (docs/design/m3.md C8, critique C6;
// decide/greedy/weapons.ts): held weapons, the Light property's extra attack, Nick and the 8
// Mastery Properties. For each term a constructed state where greedy picks it and a twin where it
// correctly declines, with Explain naming the term. Rule text is cited by its line in the SRD 5.2.1
// PDF text (srd-raw.txt). Content is synthetic (test: ids); the weapon kinds a mastery names are SRD
// ids only as data.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionKind, DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { DEFAULT_WEIGHTS } from '../src/decide/greedy/weights.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { COND, type Unit } from '../src/sim/state.ts';
import { actionEV } from '../src/query/threat.ts';

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

/** PcSource weapon entries. STR 16 (+3), DEX 14 (+2). */
const W: Record<string, string> = {
  longsword: '{ id: longsword, name: Longsword, kind: melee, ability: str, mastery: sap, base: srd:longsword, damage: [{ roll: 1d8 + @mod, type: slashing }] }',
  warhammer: '{ id: warhammer, name: Warhammer, kind: melee, ability: str, mastery: push, base: srd:warhammer, damage: [{ roll: 1d8 + @mod, type: bludgeoning }] }',
  shortsword: '{ id: shortsword, name: Shortsword, kind: melee, ability: finesse, light: true, mastery: vex, base: srd:shortsword, damage: [{ roll: 1d6 + @mod, type: piercing }] }',
  scimitar: '{ id: scimitar, name: Scimitar, kind: melee, ability: finesse, light: true, mastery: nick, base: srd:scimitar, damage: [{ roll: 1d6 + @mod, type: slashing }] }',
  handaxe: '{ id: handaxe, name: Handaxe, kind: melee, ability: str, light: true, thrownRange: [20, 60], mastery: vex, base: srd:handaxe, damage: [{ roll: 1d6 + @mod, type: slashing }] }',
  greataxe: '{ id: greataxe, name: Greataxe, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: cleave, base: srd:greataxe, damage: [{ roll: 1d12 + @mod, type: slashing }] }',
  greatsword: '{ id: greatsword, name: Greatsword, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: graze, base: srd:greatsword, damage: [{ roll: 2d6 + @mod, type: slashing }] }',
  maul: '{ id: maul, name: Maul, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: topple, base: srd:maul, damage: [{ roll: 2d6 + @mod, type: bludgeoning }] }',
  quiver: '{ id: longbow, name: Longbow, kind: ranged, ability: dex, twoHanded: true, range: [150, 600], ammunition: 20, base: srd:longbow, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
  longbow: '{ id: longbow, name: Longbow, kind: ranged, ability: dex, twoHanded: true, range: [150, 600], base: srd:longbow, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
  javelin: '{ id: javelin, name: Javelin, kind: melee, ability: str, thrownRange: [30, 120], mastery: slow, base: srd:javelin, damage: [{ roll: 1d6 + @mod, type: piercing }] }',
};

interface PcOpts {
  weapons: string[];
  hands?: [string | null, string | null];
  masteries?: string[];
  held?: boolean;
  extraAttacks?: number;
  unarmed?: boolean;
  items?: string[];
  features?: string[];
  /** Raw `casting:` entries (one per line). */
  casting?: string[];
}
const pcYaml = (o: PcOpts) => `kind: pc
id: test:gw-pc
name: GW Fighter
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }
hpMax: 60
ac: 16
extraAttacks: ${o.extraAttacks ?? 1}
${o.held === false ? '' : 'heldWeapons: true\n'}${o.masteries ? `masteries: [${o.masteries.join(', ')}]\n` : ''}weapons:
${o.weapons.map((w) => `  - ${W[w]}`).join('\n')}
${o.unarmed ? 'unarmedStrike: { ability: str, damage: 1d12 + @mod }\n' : ''}items: [${(o.items ?? []).join(', ')}]
hands: [${(o.hands ?? [null, null]).map((h) => h ?? 'null').join(', ')}]
features: [${(o.features ?? []).map((f) => `test:${f}`).join(', ')}]
${o.casting ? `casting:\n${o.casting.map((c) => `  - ${c}`).join('\n')}\n` : ''}`;

const monster = (id: string, ac: number, hp: number, speed = 30, toHit = 5) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: ${speed} }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${toHit}, damage: [{ roll: '2d6 + 3', type: slashing, avg: 10 }] }
`;
const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;
const KIT: Record<string, string> = {
  'packs/test/monsters/gw-brute.yaml': monster('gw-brute', 12, 40),
  'packs/test/monsters/gw-wall.yaml': monster('gw-wall', 25, 300),
  'packs/test/monsters/gw-soft.yaml': monster('gw-soft', 5, 300),
  'packs/test/monsters/gw-frail.yaml': monster('gw-frail', 10, 1),
  'packs/test/monsters/gw-slug.yaml': monster('gw-slug', 12, 40, 5),
  'packs/test/data/gw-triple.yaml': feature('gw-triple', 'activate: { id: triple, name: Triple Strike, cost: bonus, do: [{ weaponAttack: { with: held, count: 3 } }] }\n'),
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number };
const PC = (at = 'B2'): U => ({ seat: 'pc1', team: 'party', use: 'test:gw-pc', at });
const foe = (seat: string, use: string, at: string): U => ({ seat, team: 'enemies', use: `test:${use}`, at });

function scene(pc: PcOpts, units: U[]) {
  const files = [...REPO, ...Object.entries({ ...KIT, 'packs/test/pcs/gw-pc.yaml': pcYaml(pc) }).map(([path, text]) => ({ path, text }))];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gwpn', name: 'Greedy weapons', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 6 },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gwpn.yaml', r.content);
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
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0, lightMask: 0, atkEquip: 0 });
  };
  /** As if the Attack action were done with the weapon item `local` (it opened the Light extra attack). */
  const attacked = (who: Unit, local: string) => {
    const it = who.tpl.items.findIndex((x) => x.local === local);
    Object.assign(who.b, { action: 0, atkActive: false, lightMask: 1 << it });
  };
  const decide = (who: Unit): { key: string; keys: string[]; rec: ExplainRecord } => {
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
    return { key: keys[i]!, keys, rec: records.at(-1)! };
  };
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
  return { cx, u, begin, attacked, decide, ask };
}
const top = (rec: ExplainRecord, key: string) => rec.top.find((t) => t.key === key);
const partOf = (rec: ExplainRecord, key: string, re: RegExp) => top(rec, key)?.parts.find((p) => re.test(p.term))?.ev;

/** A rider decision on a hit by `atkLocal` on `t`: pass, or the mastery rider `local`. */
function riderAsk(w: ReturnType<typeof scene>, pc: Unit, t: Unit, local: string, atkLocal: string) {
  const ri = pc.tpl.riders!.findIndex((r) => r.local === local);
  const f = pc.tpl.features[pc.tpl.riders![ri]!.feature]!;
  const rows = [
    { key: 'pass', fill: (l: Legal) => { l.k = 'pass'; } },
    { key: `rider:${local}`, fill: (l: Legal) => { l.k = 'pick'; l.opt = 0; l.aux = ri; } },
  ];
  const via = pc.tpl.attacks.find((a) => a.local === atkLocal)!.id;
  return w.ask(pc, 'rider', rows, { src: { via: f.id, target: t.idx }, hit: { attacker: pc.idx, target: t.idx, via, crit: false, total: -1, types: 0 } });
}

describe('masteries inside a strike\'s value (Mastery Properties, srd-raw.txt:20406-20410)', () => {
  it('Graze (20424-20430): against AC 25 greedy swings the Greatsword (its STR damage on a miss) over an equal Maul without a mastery, and Explain names Graze', () => {
    const w = scene({ weapons: ['greatsword', 'maul'], masteries: ['srd:greatsword'] }, [PC(), foe('e1', 'gw-wall', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toMatch(/^attack:greatsword>/);
    expect(partOf(r.rec, r.key, /Graze.*P\(miss\)/)).toBeGreaterThan(2);
  });

  it('Graze declines to matter where misses are rare: against AC 5 it is worth under a sixth of its AC 25 value', () => {
    const val = (foeId: string) => {
      const w = scene({ weapons: ['greatsword', 'maul'], masteries: ['srd:greatsword'] }, [PC(), foe('e1', foeId, 'C2')]);
      const pc = w.u('pc1');
      w.begin(pc);
      const r = w.decide(pc);
      const k = r.keys.find((x) => x.startsWith('attack:greatsword>'))!;
      return partOf(r.rec, k, /Graze/) ?? 0;
    };
    expect(val('gw-soft')).toBeLessThan(val('gw-wall') / 6);
  });

  it('Sap (20442-20446): greedy picks the Longsword (the brute\'s next attack at Disadvantage) over an equal Warhammer without a mastery; on an Incapacitated brute Sap adds nothing', () => {
    const w = scene({ weapons: ['warhammer', 'longsword'], masteries: ['srd:longsword'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toMatch(/^attack:longsword>/);
    expect(partOf(r.rec, r.key, /^ +of which Sap/)).toBeGreaterThan(0.3);
    w.u('e1').condMask |= COND.incapacitated;
    const r2 = w.decide(pc);
    const k = r2.keys.find((x) => x.startsWith('attack:longsword>'))!;
    expect(partOf(r2.rec, k, /Sap/)).toBeUndefined();
  });

  it('Vex (20463-20467): one of my strikes at Advantage; with a strike still to come it counts now, on the last strike only next turn (x gamma)', () => {
    const w = scene({ weapons: ['shortsword'], masteries: ['srd:shortsword'], hands: ['shortsword', null] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    const k = r.keys.find((x) => x.startsWith('attack:shortsword>'))!;
    const two = partOf(r.rec, k, /Vex/)!;
    expect(two).toBeGreaterThan(0);
    // The Attack action's first strike made: its last one.
    pc.b.atkActive = true;
    pc.b.atkLive = 1;
    pc.b.atkCounts[pc.tpl.attacks.findIndex((a) => a.local === 'shortsword')]! = 1;
    const r2 = w.decide(pc);
    const last = partOf(r2.rec, r2.keys.find((x) => x.startsWith('attack:shortsword>'))!, /Vex/)!;
    expect(last).toBeCloseTo(two * DEFAULT_WEIGHTS.gamma, 6);
  });

  it('review AI-3, Vex (20463-20467) before the Light extra attack (20339-20345): on the Attack action\'s last strike with the Scimitar\'s extra attack still to come, Vex\'s Advantage is used this turn (full value); with the Bonus Action spent only next turn (x gamma)', () => {
    const w = scene({ weapons: ['shortsword', 'scimitar'], masteries: ['srd:shortsword'], hands: ['shortsword', 'scimitar'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    strikesMade(pc, 'scimitar', 1);
    pc.b.lightMask = 1 << pc.tpl.items.findIndex((x) => x.local === 'scimitar');
    const vex = () => {
      const r = w.decide(pc);
      return partOf(r.rec, r.keys.find((x) => x.startsWith('attack:shortsword>'))!, /Vex/)!;
    };
    const open = vex();
    pc.b.bonus = 0;
    const spent = vex();
    expect(spent).toBeGreaterThan(0);
    expect(open).toBeCloseTo(spent / DEFAULT_WEIGHTS.gamma, 6);
  });

  it('Slow (20448-20453): a javelin thrown at a brute 30 ft away is worth its Speed cut (it can no longer reach me); next to me the same cut is worth nothing', () => {
    const far = scene({ weapons: ['javelin'], masteries: ['srd:javelin'] }, [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
    const pc = far.u('pc1');
    far.begin(pc);
    pc.b.moveFt = 0;
    const r = far.decide(pc);
    const k = r.keys.find((x) => x.startsWith('attack:javelin-thrown>'))!;
    expect(r.key).toBe(k);
    expect(partOf(r.rec, k, /Slow/)).toBeGreaterThan(1);
    const near = scene({ weapons: ['javelin'], masteries: ['srd:javelin'] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const p2 = near.u('pc1');
    near.begin(p2);
    const r2 = near.decide(p2);
    expect(partOf(r2.rec, r2.keys.find((x) => x.startsWith('attack:javelin>'))!, /Slow/)).toBeUndefined();
  });
});

describe('masteries asked as rider decisions (Cleave, Push, Topple)', () => {
  it('Cleave (20360-20367): with a second creature within 5 ft of the one hit greedy cleaves; with none it passes', () => {
    const w = scene({ weapons: ['greataxe'], masteries: ['srd:greataxe'], hands: ['greataxe', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2'), foe('e2', 'gw-brute', 'C3')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = riderAsk(w, pc, w.u('e1'), 'cleave-greataxe', 'greataxe');
    expect(r.key).toBe('rider:cleave-greataxe');
    expect(top(r.rec!, 'rider:cleave-greataxe')!.parts[0]!.term).toBe('Cleave (Greataxe): its effect, P(effect) x value');
    const lone = scene({ weapons: ['greataxe'], masteries: ['srd:greataxe'], hands: ['greataxe', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2'), foe('e2', 'gw-brute', 'J5')]);
    const p2 = lone.u('pc1');
    lone.begin(p2);
    expect(riderAsk(lone, p2, lone.u('e1'), 'cleave-greataxe', 'greataxe').key).toBe('pass');
  });

  it('Cleave\'s target choice: the second strike goes to the 1-HP creature it drops, not the healthy one', () => {
    const w = scene({ weapons: ['greataxe'], masteries: ['srd:greataxe'], hands: ['greataxe', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2'), foe('e2', 'gw-brute', 'C3'), foe('e3', 'gw-frail', 'C1')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const ai = pc.tpl.attacks.findIndex((a) => a.local === 'greataxe');
    const mk = (t: Unit) => ({ key: `atk@${t.seat}`, fill: (l: Legal) => { l.k = 'attack'; l.atk = ai; l.opt = 0; l.target = t.idx; } });
    const r = w.ask(pc, 'target', [mk(w.u('e2')), mk(w.u('e3'))], { src: { via: pc.tpl.features[pc.tpl.riders![0]!.feature]!.id } });
    expect(r.key).toBe('atk@e3');
  });

  it('review AI-2, Cleave "only once per turn" (20366-20367): the turn decision counts it on the first strike, not again in the Attack action\'s later strike', () => {
    const w = scene({ weapons: ['greataxe'], masteries: ['srd:greataxe'], hands: ['greataxe', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2'), foe('e2', 'gw-brute', 'C3')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    const k = r.keys.find((x) => x === 'attack:greataxe>e1')!;
    const first = partOf(r.rec, k, /^this strike$/)!;
    const cleave = partOf(r.rec, k, /^ +of which Cleave/)!;
    expect(cleave).toBeGreaterThan(1);
    expect(partOf(r.rec, k, /^1 more strike\(s\)$/)!).toBeCloseTo(first - cleave, 6);
  });

  it('review AI-2, Sap (20442-20446) on a later strike at the same creature only refreshes its token: the later strike is worth the plain one, while a first strike counts Sap; Vex (20463-20467) is no refresh (the later strike spends the first token and leaves its own), so it counts again', () => {
    const w = scene({ weapons: ['longsword'], masteries: ['srd:longsword'], hands: ['longsword', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    const k = 'attack:longsword>e1';
    const sap = partOf(r.rec, k, /^ +of which Sap/)!;
    expect(sap).toBeGreaterThan(0.3);
    expect(partOf(r.rec, k, /^1 more strike\(s\)$/)!).toBeCloseTo(partOf(r.rec, k, /^this strike$/)! - sap, 6);
    const v = scene({ weapons: ['shortsword'], masteries: ['srd:shortsword'], hands: ['shortsword', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const p2 = v.u('pc1');
    v.begin(p2);
    const r2 = v.decide(p2);
    const k2 = 'attack:shortsword>e1';
    expect(partOf(r2.rec, k2, /^ +of which Vex/)!).toBeGreaterThan(0);
    expect(partOf(r2.rec, k2, /^1 more strike\(s\)$/)!).toBeCloseTo(partOf(r2.rec, k2, /^this strike$/)!, 6);
  });

  it('Push (20437-20440): a 5-ft-Speed brute pushed 10 ft can\'t reach me next turn, so greedy pushes on its last strike; a 30-ft brute walks back, and pushing it away from my next strike is passed', () => {
    const slow = scene({ weapons: ['warhammer'], masteries: ['srd:warhammer'], hands: ['warhammer', null] }, [PC('B2'), foe('e1', 'gw-slug', 'C2')]);
    const pc = slow.u('pc1');
    slow.begin(pc);
    pc.b.action = 0;
    pc.b.atkActive = true;
    pc.b.atkLive = 1;
    pc.b.atkCounts[pc.tpl.attacks.findIndex((a) => a.local === 'warhammer')]! = 2; // the last strike
    expect(riderAsk(slow, pc, slow.u('e1'), 'push-warhammer', 'warhammer').key).toBe('rider:push-warhammer');
    const fast = scene({ weapons: ['warhammer'], masteries: ['srd:warhammer'], hands: ['warhammer', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const p2 = fast.u('pc1');
    fast.begin(p2);
    p2.b.action = 0;
    p2.b.atkActive = true;
    p2.b.atkLive = 1;
    p2.b.atkCounts[p2.tpl.attacks.findIndex((a) => a.local === 'warhammer')]! = 1; // one strike still to come
    expect(riderAsk(fast, p2, fast.u('e1'), 'push-warhammer', 'warhammer').key).toBe('pass');
  });

  it('Topple (20455-20461): a healthy brute is knocked Prone on the first strike (the second gets the Advantage); one already Prone is not', () => {
    const w = scene({ weapons: ['maul'], masteries: ['srd:maul'], hands: ['maul', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    strikesMade(pc, 'maul', 1);
    expect(riderAsk(w, pc, w.u('e1'), 'topple-maul', 'maul').key).toBe('rider:topple-maul');
    w.u('e1').condMask |= COND.prone;
    expect(riderAsk(w, pc, w.u('e1'), 'topple-maul', 'maul').key).toBe('pass');
  });

  it('review AI-4, Prone (srd-raw.txt:34010-34019) ends when the creature rights itself on its turn: Topple on the first of two strikes is worth more than on the last, where a lone PC has no strike left to use the Advantage', () => {
    const w = scene({ weapons: ['maul'], masteries: ['srd:maul'], hands: ['maul', null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const val = (made: number) => {
      strikesMade(pc, 'maul', made);
      const r = riderAsk(w, pc, w.u('e1'), 'topple-maul', 'maul');
      return top(r.rec!, 'rider:topple-maul')?.ev ?? 0;
    };
    const first = val(1);
    const last = val(2);
    expect(first).toBeGreaterThan(1);
    expect(last).toBeLessThan(first / 4);
  });
});

/** As if `made` strikes of the Attack action were made with weapon `local` (the next decision is a rider's or a later strike's). */
function strikesMade(pc: Unit, local: string, made: number): void {
  Object.assign(pc.b, { action: 0, atkActive: true, atkLive: 1 });
  pc.b.atkCounts.fill(0);
  pc.b.atkCounts[pc.tpl.attacks.findIndex((a) => a.local === local)]! = made;
}

describe('the Light property\'s extra attack (srd-raw.txt:20339-20349) and Nick (20432-20435)', () => {
  it('after the Attack action with the Shortsword, greedy makes the extra attack with the Scimitar; with a better bonus action (three strikes) it takes that instead', () => {
    const w = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', 'scimitar'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    w.attacked(pc, 'shortsword');
    const r = w.decide(pc);
    expect(r.key).toMatch(/light-weapons/);
    expect(partOf(r.rec, r.key, /^weapon strikes$/)).toBeGreaterThan(0);
    const w2 = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', 'scimitar'], features: ['gw-triple'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const p2 = w2.u('pc1');
    w2.begin(p2);
    w2.attacked(p2, 'shortsword');
    expect(w2.decide(p2).key).toMatch(/gw-triple/);
  });

  it('Nick keeps the Bonus Action: with another bonus action worth taking greedy makes the Nick strike first, and Explain names it; with none the term is absent', () => {
    const w = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', 'scimitar'], masteries: ['srd:scimitar'], features: ['gw-triple'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    w.attacked(pc, 'shortsword');
    const r = w.decide(pc);
    expect(r.key).toMatch(/nick-scimitar$/);
    expect(partOf(r.rec, r.key, /^Nick: keeps the Bonus Action/)).toBeGreaterThan(0);
    const w2 = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', 'scimitar'], masteries: ['srd:scimitar'] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const p2 = w2.u('pc1');
    w2.begin(p2);
    w2.attacked(p2, 'shortsword');
    const r2 = w2.decide(p2);
    const nick = r2.keys.find((k) => k.endsWith('nick-scimitar'))!;
    expect(partOf(r2.rec, nick, /Nick/)).toBeUndefined();
  });

  it('the Light opener: on its one strike greedy attacks with the Shortsword (opening the Scimitar\'s extra attack) over a stronger Unarmed Strike; with the Bonus Action spent it strikes unarmed', () => {
    const w = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', 'scimitar'], unarmed: true, extraAttacks: 0 }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toMatch(/^attack:(shortsword|scimitar)>/);
    expect(partOf(r.rec, r.key, /^Light: opens the extra attack/)).toBeGreaterThan(0);
    pc.b.bonus = 0;
    expect(w.decide(pc).key).toMatch(/^attack:unarmed/);
  });
});

describe('held weapons: drawing, switching, throwing (Equipping and Unequipping Weapons, srd-raw.txt:32707-32712)', () => {
  it('an Attack-action strike draws its weapon: with the Longsword sheathed and a brute 15 ft away greedy closes in to strike with it; with both hands full only its Unarmed Strike counts', () => {
    const w = scene({ weapons: ['longsword'] }, [PC('B2'), foe('e1', 'gw-brute', 'E2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toMatch(/^move:/);
    const sword = top(r.rec, r.key)!.parts[0]!.ev;
    expect(sword).toBeGreaterThan(0);
    const items = ['{ id: shield, name: Shield, kind: shield, shieldAc: 2 }', '{ id: orb, name: Orb, kind: focus, focusFor: [wizard] }'];
    const full = scene({ weapons: ['longsword'], items, hands: ['shield', 'orb'] }, [PC('B2'), foe('e1', 'gw-brute', 'E2')]);
    const p2 = full.u('pc1');
    full.begin(p2);
    const r2 = full.decide(p2);
    const fist = r2.key.startsWith('move:') ? top(r2.rec, r2.key)!.parts[0]!.ev : 0;
    expect(fist).toBeLessThan(sword - 1);
  });

  it('review INT-1, "Equipping a weapon includes drawing it from a sheath or picking it up" (srd-raw.txt:32711): a Longsword at its feet is picked up by the strike next to the brute, but a move away leaves it there, so a strike from another square is valued without it', () => {
    const near = scene({ weapons: ['longsword'], hands: [null, null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = near.u('pc1');
    near.begin(pc);
    pc.dropped[pc.tpl.items.findIndex((x) => x.local === 'longsword')] = pc.cell;
    expect(near.decide(pc).key).toBe('attack:longsword>e1');
    const moveValue = (dropped: boolean) => {
      const w = scene({ weapons: ['longsword'], hands: [null, null] }, [PC('B2'), foe('e1', 'gw-brute', 'F2')]);
      const p = w.u('pc1');
      w.begin(p);
      if (dropped) p.dropped[p.tpl.items.findIndex((x) => x.local === 'longsword')] = p.cell;
      const r = w.decide(p);
      expect(r.key).toMatch(/^move:/);
      return partOf(r.rec, r.key, /strike\(s\) from there/)!;
    };
    const sheathed = moveValue(false);
    const left = moveValue(true);
    expect(left).toBeGreaterThan(0); // the Unarmed Strike
    expect(left).toBeLessThan(sheathed - 2);
  });

  it('drawing a second Light weapon after the Attack action is worth its extra attack; with the Bonus Action spent it is not drawn', () => {
    const w = scene({ weapons: ['shortsword', 'scimitar'], hands: ['shortsword', null] }, [PC(), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    w.attacked(pc, 'shortsword');
    const r = w.decide(pc);
    expect(r.key).toMatch(/^item:.*scimitar/);
    expect(partOf(r.rec, r.key, /gives back/)).toBeGreaterThan(0);
    pc.b.bonus = 0;
    expect(w.decide(pc).key).not.toMatch(/^item:/);
  });

  it('Thrown (20387-20389): a single held Handaxe thrown leaves the hand, so its strike costs throwAway; without held weapons it costs nothing', () => {
    const val = (held: boolean) => {
      const w = scene({ weapons: ['handaxe'], held, hands: held ? ['handaxe', null] : [null, null] }, [PC('B2'), foe('e1', 'gw-brute', 'E2')]);
      const pc = w.u('pc1');
      w.begin(pc);
      pc.b.moveFt = 0;
      const r = w.decide(pc);
      return partOf(r.rec, r.keys.find((k) => k.startsWith('attack:handaxe-thrown>'))!, /^this strike$/)!;
    };
    expect(val(false) - val(true)).toBeCloseTo(DEFAULT_WEIGHTS.throwAway, 6);
  });
});

describe('stowing a weapon that blocks a better strike (M3 step 5b integration; Two-Handed, srd-raw.txt:20392-20393; equipping and unequipping, 32707-32712)', () => {
  it('holding a Longbow and a drawn Shortsword with the brute 30 ft away, greedy stows the Shortsword (its free object interaction) so the bow can shoot, and Explain names the stow', () => {
    const w = scene({ weapons: ['longbow', 'shortsword'], hands: ['longbow', 'shortsword'] }, [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.keys).not.toContain('attack:longbow>e1'); // "A Two-Handed weapon requires two hands when you attack with it"
    expect(r.key).toBe('item:stow/shortsword');
    expect(partOf(r.rec, r.key, /^stowing Shortsword: the better strike or cast its hand unblocks$/)).toBeGreaterThan(1);
  });

  it('review AI-1: with the free object interaction spent, a stow would take the Action and gain no shot this turn (next turn\'s free interaction does it at no cost), so greedy doesn\'t stow; with no time bought it doesn\'t Dodge either (coverage 7.0b, deliberate), and with no move left it passes', () => {
    const w = scene({ weapons: ['longbow', 'shortsword'], hands: ['longbow', 'shortsword'] }, [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    pc.b.freeObj = 0;
    const r = w.decide(pc);
    expect(r.keys).toContain('item:stow/shortsword');
    expect(r.keys).toContain('dodge');
    expect(r.key).toBe('pass');
    expect(top(r.rec, 'item:stow/shortsword')).toBeUndefined();
    expect(top(r.rec, 'dodge')).toBeUndefined();
  });

  it('declines when the hand blocks nothing better: next to the brute the Shortsword beats the bow (Disadvantage within 5 ft), so the stow is never offered a value', () => {
    const w = scene({ weapons: ['longbow', 'shortsword'], hands: ['longbow', 'shortsword'] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toMatch(/^attack:shortsword>e1$/);
    expect(top(r.rec, 'item:stow/shortsword')).toBeUndefined();
  });

  it('Somatic (srd-raw.txt:23719-23724): with a Longsword and a Shield in hand and the brute 30 ft away, greedy stows the sword so its hand can cast Fire Bolt; with a hand already free it never stows', () => {
    const opts = (hands: [string | null, string | null]): PcOpts => ({ weapons: ['longsword'], items: ['{ id: shield, name: Shield, kind: shield, shieldAc: 2 }'], hands, casting: ['{ source: wizard, ability: int, list: wizard, cantrips: [srd:fire-bolt] }'] });
    const w = scene(opts(['longsword', 'shield']), [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.keys).not.toContain('cast:fire-bolt>e1'); // V, S: no hand free
    expect(r.key).toBe('item:stow/longsword');
    expect(partOf(r.rec, r.key, /^stowing Longsword: the better strike or cast its hand unblocks$/)).toBeGreaterThan(1);
    const free = scene(opts(['longsword', null]), [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
    const p2 = free.u('pc1');
    free.begin(p2);
    p2.b.moveFt = 0;
    const r2 = free.decide(p2);
    expect(r2.key).not.toBe('item:stow/longsword');
    expect(top(r2.rec, 'item:stow/longsword')).toBeUndefined();
  });

  it('a sheathed Maul still threatens: the Attack action\'s strike may draw it (srd-raw.txt:32707-32712), so actionEV (exposure, threat) counts its melee routine with both hands empty, and none with both hands full', () => {
    const w = scene({ weapons: ['maul', 'shortsword', 'scimitar'], hands: [null, null] }, [PC('B2'), foe('e1', 'gw-brute', 'C2')]);
    const pc = w.u('pc1');
    const sheathed = actionEV(w.cx.st, pc, 12).melee;
    expect(sheathed).toBeGreaterThan(9); // 2 x (P(hit) x 2d6 + 3) against AC 12
    pc.hands[0] = pc.tpl.items.findIndex((x) => x.local === 'shortsword');
    pc.hands[1] = pc.tpl.items.findIndex((x) => x.local === 'scimitar');
    const full = actionEV(w.cx.st, pc, 12).melee;
    expect(full).toBeGreaterThan(0); // the held Light pair
    expect(full).toBeLessThan(sheathed); // the Maul needs both hands
  });

  it('Ammunition (srd-raw.txt:20312-20320): "Each attack expends one piece of ammunition"; a counted arrow is fired, not thrown, so the Longbow\'s strike costs nothing more with 20 counted pieces than uncounted (throwAway is for a weapon that leaves the hand)', () => {
    const val = (w: string) => {
      const s = scene({ weapons: [w], hands: ['longbow', null] }, [PC('B2'), foe('e1', 'gw-brute', 'H2')]);
      const pc = s.u('pc1');
      s.begin(pc);
      pc.b.moveFt = 0;
      const r = s.decide(pc);
      expect(r.key).toBe('attack:longbow>e1');
      return partOf(r.rec, r.key, /^this strike$/)!;
    };
    expect(val('quiver')).toBeCloseTo(val('longbow'), 9);
  });
});
