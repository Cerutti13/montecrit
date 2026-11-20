// Coverage 8'b G5, G6, G7 (docs/design/coverage.md section 2, M6, m7): the printed target style; the
// lasting-effect term that replaced the per-round valuation of zones and concentration effects; the
// hand configuration valued as a state, with a switch cost. Each case is a constructed state named
// for what it checks. Content is synthetic (test: ids), compiled with the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { zoneAnchors, zonePerRound, zoneValue, type VCtx } from '../src/decide/greedy/value.ts';
import { liveChangeValue, modPerRound, TERM } from '../src/decide/greedy/cond.ts';
import { HAND } from '../src/sim/state.ts';
import { DEFAULT_WEIGHTS, future, type TargetStyle, type Weights } from '../src/decide/greedy/weights.ts';
import { compilePolicy } from '../src/decide/policy.ts';
import { computeReport, renderReport } from '../src/mc/report.ts';
import { mergeInto, newMerged, runChunk, type ArmSpec } from '../src/mc/runner.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { boundOf } from '../src/sim/effects.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives, runPrecasts } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { Unit } from '../src/sim/state.ts';

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

const WEAPONS: Record<string, string> = {
  longsword: '{ id: longsword, name: Longsword, kind: melee, ability: str, base: srd:longsword, damage: [{ roll: 1d8 + @mod, type: slashing }] }',
  dagger: '{ id: dagger, name: Dagger, kind: melee, ability: str, base: srd:dagger, damage: [{ roll: 1d4 + @mod, type: piercing }] }',
  mace: '{ id: mace, name: Mace, kind: melee, ability: str, base: srd:mace, damage: [{ roll: 1d6 + @mod, type: bludgeoning }] }',
  greataxe: '{ id: greataxe, name: Greataxe, kind: melee, ability: str, twoHanded: true, base: srd:greataxe, damage: [{ roll: 1d12 + @mod, type: slashing }] }',
  longbow: '{ id: longbow, name: Longbow, kind: ranged, ability: dex, twoHanded: true, range: [150, 600], base: srd:longbow, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
};
const SHIELD = '{ id: shield, name: Shield, kind: shield, shieldAc: 2 }';
const FOCUS = '{ id: charm, name: Charm, kind: focus, focusFor: [cleric] }';

interface PcOpts {
  weapons?: string[];
  hands?: [string | null, string | null];
  items?: string[];
  features?: string[];
  cantrips?: string[];
  prepared?: string[];
  pool?: boolean;
  hp?: number;
  /** The casting entry's spells only work while this item is in hand. */
  whileHeld?: string;
}
const pcYaml = (o: PcOpts) => `kind: pc
id: test:gs-pc
name: Side PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 16, cha: 10 }
hpMax: ${o.hp ?? 60}
ac: 16
heldWeapons: true
weapons:
${(o.weapons ?? ['longsword']).map((w) => `  - ${WEAPONS[w]}`).join('\n')}
items: [${(o.items ?? []).join(', ')}]
hands: [${(o.hands ?? [null, null]).map((h) => h ?? 'null').join(', ')}]
features: [${(o.features ?? []).map((f) => `test:${f}`).join(', ')}]
${o.pool ? 'pools:\n  - { id: forms, name: Forms, max: 3, recharge: longRest }\n' : ''}${o.cantrips || o.prepared ? `slots: [4, 3]\ncasting:\n  - { source: cleric, ability: wis, list: cleric, cantrips: [${(o.cantrips ?? []).join(', ')}], prepared: [${(o.prepared ?? []).join(', ')}]${o.whileHeld ? `, whileHeld: ${o.whileHeld}` : ''} }\n` : ''}`;
const monster = (id: string, ac: number, hp: number, toHit: number, dmg: string, avg: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
pb: 2
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 8 }
attacks:
  - { id: club, name: Club, kind: melee, toHit: ${toHit}, damage: [{ roll: '${dmg}', type: bludgeoning, avg: ${avg} }] }
`;
const KIT: Record<string, string> = {
  'packs/test/monsters/gs-brute.yaml': monster('gs-brute', 12, 40, 5, '2d6 + 3', 10),
  'packs/test/monsters/gs-wimp.yaml': monster('gs-wimp', 12, 8, 1, '1d4', 2),
  'packs/test/monsters/gs-ogre.yaml': monster('gs-ogre', 12, 80, 8, '3d10 + 5', 21),
  'packs/test/monsters/gs-near.yaml': monster('gs-near', 12, 100, 1, '1d4', 2),
  'packs/test/monsters/gs-glass.yaml': monster('gs-glass', 12, 6, 8, '2d6 + 3', 10),
  // A concentration effect that only gives stats: what it is worth is the difference it is making.
  'packs/test/spells/gs-ward.yaml': `kind: spell
id: test:gs-ward
name: Ward-like Aura
source: synthetic test fixture (concentration AC buff)
level: 1
castingTime: action
range: 30
components: { v: true, s: true, m: focus }
concentration: true
duration: { minutes: 1 }
effects:
  - { id: warded, name: Warded, stats: [{ ac: 3 }] }
do:
  - target: { range: 30, who: ally, self: yes }
  - apply: { effect: warded, to: target }
`,
  // A weaponAttack form (G5's other strike path): one strike at a creature in reach.
  'packs/test/features/gs-strike.yaml': `kind: feature
id: test:gs-strike
name: gs-strike
source: synthetic test fixture
activate: { id: lunge, name: Lunge, cost: bonus, do: [{ weaponAttack: { with: longsword } }] }
`,
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string; precast?: unknown };
const PC = (at = 'B2', extra: Partial<U> = {}): U => ({ seat: 'pc1', team: 'party', use: 'test:gs-pc', at, ...extra });
const foe = (seat: string, use: string, at: string): U => ({ seat, team: 'enemies', use: `test:${use}`, at });

function setupOf(pc: PcOpts, units: U[], flags: Record<string, unknown> = {}): FightSetup {
  const files = [...REPO, ...Object.entries({ ...KIT, 'packs/test/pcs/gs-pc.yaml': pcYaml(pc) }).map(([path, text]) => ({ path, text }))];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gside', name: 'Greedy side', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 14, h: 6 },
    flags: { initiativeMode: 'static', ...flags }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gside.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

function scene(pc: PcOpts, units: U[], w: Partial<Weights> = {}) {
  const s = setupOf(pc, units);
  const weights = { ...DEFAULT_WEIGHTS, ...w };
  const ds = s.seats.map(() => new GreedyDecider(weights));
  const cx = createContext(s, 1, 0, ds, null);
  applyPassives(cx, -1);
  runPrecasts(cx, -1);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit, patch: Partial<Unit['b']> = {}) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0, lightMask: 0, atkEquip: 0, ...patch });
  };
  const decide = (who: Unit, keep: (k: string) => boolean = () => true): { key: string; keys: string[]; rec: ExplainRecord } => {
    const list = listOptions(cx, who, takeList(cx));
    const items: Legal[] = [];
    const keys: string[] = [];
    for (let i = 0; i < list.n; i++) {
      const k = legalKey(cx.st, who.idx, list.items[i]!);
      if (!keep(k)) continue;
      keys.push(k);
      items.push(copyLegal(list.items[i]!, newLegal()));
    }
    releaseList(cx, list);
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    records.length = 0;
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return { key: keys[i]!, keys, rec: records.at(-1)! };
  };
  /** The private valuation context and helpers of `who`'s decider, primed for a decision. */
  const peek = (who: Unit) => {
    const d = ds[who.idx]! as unknown as {
      vctxFor(st: unknown, me: Unit, v: unknown): VCtx;
      castValue(v: VCtx, me: Unit, opt: number, lvl: number, free: boolean, from: number): number;
      concValue(st: unknown, me: Unit): number;
      concLeft(st: unknown, me: Unit): number;
      endCost(st: unknown, me: Unit, cell: number): number;
      concBreak(st: unknown, me: Unit): number;
      exposure(st: unknown, me: Unit, cell: number): number;
      useValue(v: VCtx, me: Unit, l: Legal, from: number): number;
      nextTurnCast(v: VCtx, me: Unit): number;
      loadoutBest(view: unknown, me: Unit, v: VCtx, hands: Int16Array): number;
      loadoutValue(view: unknown, me: Unit, v: VCtx, hands: Int16Array): number;
    };
    const list = takeList(cx);
    const dp: DecisionPoint = { k: 'orderTriggers' as DecisionPoint['k'], who: who.idx, at: 0, round: 1, cause: -1, legal: { n: 0, items: [] }, keyOf: () => '' };
    releaseList(cx, list);
    (ds[who.idx]! as GreedyDecider).decide(cx.views[who.idx]!, dp);
    return { d, st: cx.st, v: d.vctxFor(cx.st, who, cx.views[who.idx]!) };
  };
  /** What a decision over `targets` picks: a turn's sub-decision (a spell's target step, or an Attack's strike target). */
  const sub = (who: Unit, items: Legal[], src: DecisionPoint['src']) => {
    const dp: DecisionPoint = { k: 'target', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => `target:${st(items[i]!.target)}`, ...(src ? { src } : {}) };
    return dp.keyOf((ds[who.idx]! as GreedyDecider).decide(cx.views[who.idx]!, dp));
  };
  const st = (i: number) => cx.st.units[i]!.seat;
  return { cx, u, begin, decide, peek, sub, ds };
}
const top = (rec: ExplainRecord, key: string) => rec.top.find((t) => t.key === key);
const partOf = (rec: ExplainRecord, key: string, re: RegExp) => top(rec, key)?.parts.find((p) => re.test(p.term))?.ev;
const entry = (u: Unit, id: string) => u.tpl.spells.findIndex((e) => e.spell.id === id);
const zoneOf = (u: Unit, ei: number) => {
  const a = u.tpl.spells[ei]!.prog[2]!.find((s) => s.k === 'apply' && s.to === 'point');
  if (!a || a.k !== 'apply') throw new Error('no zone');
  return u.tpl.effects[a.fx]!;
};

describe('G5: the target style (M6: created here, default ev, printed under the calibration record)', () => {
  const units = [PC('B2'), foe('near', 'gs-near', 'C2'), foe('glass', 'gs-glass', 'B3'), foe('ogre', 'gs-ogre', 'A3')];
  const pick = (targetStyle: TargetStyle) => {
    const w = scene({ weapons: ['longsword'], hands: ['longsword', null] }, units, { targetStyle });
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    return w.decide(pc).key;
  };

  it("defaults to ev, today's argmax: the frail hitter a strike can drop, not the first seat nor the hardest hitter", () => {
    expect(DEFAULT_WEIGHTS.targetStyle).toBe('ev');
    expect(pick('ev')).toBe('attack:longsword>glass');
  });

  it('threat narrows to the enemy that deals me the most', () => {
    expect(pick('threat')).toBe('attack:longsword>ogre');
  });

  it('nearest narrows to the closest enemy in reach (a tie goes to the lower seat)', () => {
    const w = scene({ weapons: ['longbow'], hands: ['longbow', null] }, [PC('B2'), foe('far', 'gs-wimp', 'H2'), foe('close', 'gs-near', 'E2')], { targetStyle: 'nearest' });
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    expect(w.decide(pc).key).toBe('attack:longbow>close');
    const ev = scene({ weapons: ['longbow'], hands: ['longbow', null] }, [PC('B2'), foe('far', 'gs-wimp', 'H2'), foe('close', 'gs-near', 'E2')]);
    const p2 = ev.u('pc1');
    ev.begin(p2);
    p2.b.moveFt = 0;
    expect(ev.decide(p2).key).toBe('attack:longbow>far');
  });

  it('nearest: on a tie the lower seat, whatever the expected value says', () => {
    const units = [PC('B2'), foe('a', 'gs-near', 'E1'), foe('b', 'gs-wimp', 'E3')];
    const w = scene({ weapons: ['longbow'], hands: ['longbow', null] }, units, { targetStyle: 'nearest' });
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    expect(w.u('a').idx).toBeLessThan(w.u('b').idx);
    expect(w.decide(pc).key).toBe('attack:longbow>a');
    const ev = scene({ weapons: ['longbow'], hands: ['longbow', null] }, units);
    const p2 = ev.u('pc1');
    ev.begin(p2);
    p2.b.moveFt = 0;
    expect(ev.decide(p2).key).toBe('attack:longbow>b');
  });

  /** glass: a frail one a hit can drop, ev's pick. ogre: deals the most, threat's pick. */
  const SPREAD = [PC('B2'), foe('glass', 'gs-glass', 'B3'), foe('ogre', 'gs-ogre', 'C2')];
  const flame = { weapons: ['longsword'], hands: [null, null] as [null, null], cantrips: ['srd:sacred-flame'] };

  it('a spell\'s value narrows too: Sacred Flame under threat is worth its value at the ogre alone, not the better one at the frail foe', () => {
    const val = (targetStyle: TargetStyle) => {
      const w = scene(flame, SPREAD, { targetStyle });
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      return d.castValue(v, pc, entry(pc, 'srd:sacred-flame'), 0, false, pc.cell);
    };
    expect(val('threat')).toBeLessThan(val('ev'));
    const alone = scene(flame, [PC('B2'), foe('ogre', 'gs-ogre', 'C2')]);
    const pc = alone.u('pc1');
    alone.begin(pc);
    const { v, d } = alone.peek(pc);
    expect(val('threat')).toBeCloseTo(d.castValue(v, pc, entry(pc, 'srd:sacred-flame'), 0, false, pc.cell), 6);
  });

  it('a spell\'s target decision narrows: asked to pick between them, threat answers the ogre, ev the frail foe', () => {
    const pick = (targetStyle: TargetStyle) => {
      const w = scene(flame, SPREAD, { targetStyle });
      const pc = w.u('pc1');
      w.begin(pc);
      const items = ['glass', 'ogre'].map((seat) => Object.assign(newLegal(), { k: 'target', target: w.u(seat).idx }) as Legal);
      return w.sub(pc, items, { via: 'srd:sacred-flame', lvl: 0 });
    };
    expect(pick('ev')).toBe('target:glass');
    expect(pick('threat')).toBe('target:ogre');
  });

  it('an Attack\'s strike target narrows: the decision among strikes answers the same way', () => {
    const pick = (targetStyle: TargetStyle) => {
      const w = scene({ weapons: ['longsword'], hands: ['longsword', null] }, SPREAD, { targetStyle });
      const pc = w.u('pc1');
      w.begin(pc);
      const items = ['glass', 'ogre'].map((seat) => Object.assign(newLegal(), { k: 'attack', atk: 0, target: w.u(seat).idx }) as Legal);
      return w.sub(pc, items, undefined);
    };
    expect(pick('ev')).toBe('target:glass');
    expect(pick('threat')).toBe('target:ogre');
  });

  it('a feature\'s weaponAttack narrows: the form is worth its strike at the ogre under threat, less than at the frail foe under ev', () => {
    const val = (targetStyle: TargetStyle) => {
      const w = scene({ weapons: ['longsword'], hands: ['longsword', null], features: ['gs-strike'] }, SPREAD, { targetStyle });
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      const l = newLegal();
      Object.assign(l, { k: 'use', fx: -1, opt: pc.tpl.features.findIndex((f) => f.id === 'test:gs-strike'), aux: -1 });
      return d.useValue(v, pc, l, pc.cell);
    };
    expect(val('threat')).toBeLessThan(val('ev'));
  });

  it('standing foes come first: under nearest, a downed foe at arm\'s length gives way to a standing one farther off', () => {
    const w = scene({ weapons: ['longsword'], hands: ['longsword', null] }, [PC('B2'), foe('down', 'gs-near', 'C2'), foe('up', 'gs-near', 'E2')], { targetStyle: 'nearest' });
    const pc = w.u('pc1');
    Object.assign(w.u('down'), { hp: 0, life: 'down' });
    w.begin(pc);
    const items = ['down', 'up'].map((seat) => Object.assign(newLegal(), { k: 'target', target: w.u(seat).idx }) as Legal);
    expect(w.sub(pc, items, { via: 'srd:sacred-flame', lvl: 0 })).toBe('target:up');
  });

  it('a policy may set it, it enters the policy hash, and anything else is refused', () => {
    const base = { kind: 'policy', id: 'near-first', name: 'Near first', weights: { targetStyle: 'nearest' } };
    const p = compilePolicy(base);
    expect(p.errors).toEqual([]);
    expect(p.policy!.weights.targetStyle).toBe('nearest');
    expect(compilePolicy({ ...base, weights: {} }).policy!.hash).not.toBe(p.policy!.hash);
    expect(compilePolicy({ ...base, weights: { targetStyle: 'loudest' } }).policy).toBeNull();
  });

  it('the report prints it right under the calibration record, and names an arm that plays another', () => {
    const s = setupOf({ weapons: ['longsword'], hands: ['longsword', null] }, [PC('B2'), foe('b1', 'gs-wimp', 'C2')]);
    const near = compilePolicy({ kind: 'policy', id: 'near-first', name: 'Near first', weights: { targetStyle: 'nearest' } }).policy!;
    const arms = [{ label: 'greedy', setup: s, policy: null }, { label: 'near-first', setup: s, policy: near }] as unknown as ArmSpec[];
    const m = newMerged(arms, 2);
    mergeInto(m, runChunk(arms, 3, 0, 2, 2));
    const meta = { seed: 3, adaptive: false, hitCap: false, checkpoint: 0 } as never;
    const lines = renderReport(arms, m, meta, computeReport(arms, m, meta)).join('\n');
    expect(lines).toMatch(/calibrated: no\n?[^]*?target priority: ev, nearest \(arm near-first\)/);
  });
});

describe('G6: the lasting-effect term (m7: it replaces the per-round valuation of zones and concentration effects)', () => {
  // srd:moonbeam: 2d10 on appear, moved onto, enter and turn end (srd-raw per its pack file). Slots from the kit.
  const moon = { cantrips: [], prepared: ['srd:moonbeam'], items: [FOCUS], hands: ['charm', null] as [string, null] };
  const cast = (hp = 60) => {
    const w = scene({ ...moon, hp }, [PC('B2'), foe('b1', 'gs-brute', 'N2'), foe('b2', 'gs-brute', 'N3')]);
    const pc = w.u('pc1');
    w.begin(pc);
    return { w, pc };
  };

  it("a zone's value is counted once: what it does when it lands plus per round x expected rounds, with no second per-round term", () => {
    const { w, pc } = cast();
    const { v, d, st } = w.peek(pc);
    const ei = entry(pc, 'srd:moonbeam');
    const te = zoneOf(pc, ei);
    const anchor = w.u('b1').cell;
    const per = zonePerRound(v, te, anchor);
    const landed = zoneValue(v, te, anchor, 1, 1) - per; // one round of it: F = 1
    expect(per).toBeGreaterThan(0);
    expect(zoneValue(v, te, anchor, 10, 1)).toBeCloseTo(zoneValue(v, te, anchor, 10, 0) + per * (future(DEFAULT_WEIGHTS, 10) - 1), 9);
    expect(landed).toBeGreaterThan(0);
    // No exposure, no drop risk (the brutes can't reach B2 this round): the whole cast is the best anchor's one value, less the slot.
    expect(d.exposure(st, pc, pc.cell)).toBe(0);
    let best = 0;
    for (const a of zoneAnchors(v, te, pc.cell, pc.tpl.spells[ei]!.spell.rangeFt)) best = Math.max(best, zoneValue(v, te, a, 10, 1));
    expect(best).toBeGreaterThan(0);
    expect(d.castValue(v, pc, ei, 2, false, pc.cell)).toBeCloseTo(best - 2 * DEFAULT_WEIGHTS.slotPerLevel, 9);
  });

  it("the expected rounds come from the drop-risk and concentration-break terms: in danger the cast is worth its first round plus the rest at that chance", () => {
    const w = scene({ ...moon, hp: 25 }, [PC('B2'), foe('b1', 'gs-ogre', 'C2'), foe('b2', 'gs-brute', 'N6')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d, st } = w.peek(pc);
    const stay = v.stay(pc.cell, true);
    const up = v.stay(pc.cell, false);
    const e = d.exposure(st, pc, pc.cell);
    // Drop risk and concentration both bite: 21 expected against 25 HP is a 34% drop chance.
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(1);
    expect(d.concBreak(st, pc)).toBeGreaterThan(0);
    expect(stay).toBeCloseTo(up * Math.max(0, 1 - d.concBreak(st, pc) * Math.min(3, e / 6)), 9);
    expect(stay).toBeGreaterThan(0);
    expect(stay).toBeLessThan(up);
    const ei = entry(pc, 'srd:moonbeam');
    const te = zoneOf(pc, ei);
    const a = w.u('b1').cell;
    expect(zoneValue(v, te, a, 10, stay)).toBeCloseTo(zoneValue(v, te, a, 10, 0) + zonePerRound(v, te, a) * (future(DEFAULT_WEIGHTS, 10, stay) - 1), 9);
    expect(zoneValue(v, te, a, 10, stay)).toBeLessThan(zoneValue(v, te, a, 10, 1));
  });

  it('a live zone is read at its per-round payoff, its appear hook not again: concValue is that, and the end cost charges the break chance on what it has left', () => {
    const w = scene(moon, [PC('B2', { precast: [{ cast: 'srd:moonbeam', level: 2, at: 'E4' }] }), foe('b1', 'gs-brute', 'E4'), foe('b2', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d, st } = w.peek(pc);
    expect(pc.conc).toBeGreaterThanOrEqual(0);
    const zone = st.fx.find((x) => x.alive && x.owner === pc.idx && x.zbit >= 0)!;
    const per = zonePerRound(v, boundOf(st, zone), zone.anchor);
    expect(per).toBeGreaterThan(0);
    expect(d.concValue(st, pc)).toBeCloseTo(per, 9);
    expect(d.concLeft(st, pc)).toBeCloseTo(per * future(DEFAULT_WEIGHTS, 10), 9);
    const e = d.exposure(st, pc, pc.cell);
    const side = DEFAULT_WEIGHTS.pc;
    expect(d.endCost(st, pc, pc.cell) - side.exposure * e).toBeGreaterThanOrEqual(d.concBreak(st, pc) * Math.min(3, e / 6) * d.concLeft(st, pc) - 1e-9);
  });

  it('a buff (Bless-shaped) is worth the share of a hit it adds x the routine x its expected rounds, less the slot; Explain names the term, equal to what the lasting read adds', () => {
    const w = scene({ cantrips: [], prepared: ['test:bless-like'], items: [FOCUS], hands: ['charm', null], weapons: ['longsword'] }, [PC('B2'), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d } = w.peek(pc);
    const ei = entry(pc, 'test:bless-like');
    const val = d.castValue(v, pc, ei, 1, false, pc.cell);
    expect(val + DEFAULT_WEIGHTS.slotPerLevel).toBeGreaterThan(1);
    const off = d.castValue({ ...v, mute: TERM.lasting }, pc, ei, 1, false, pc.cell);
    expect(val).toBeGreaterThan(off);
    const r = w.decide(pc, (k) => k.startsWith('cast:bless-like') || k === 'pass');
    const key = r.rec.top.find((t) => t.key.startsWith('cast:bless-like'))!.key;
    expect(partOf(r.rec, key, /^ *lasting effect: its per-round payoff x its expected rounds left$/)).toBeCloseTo(val - off, 6);
  });

  it('a zone names the same term: a Moonbeam\'s rounds after the first, equal to what the lasting read adds', () => {
    const w = scene(moon, [PC('B2'), foe('b1', 'gs-brute', 'E2'), foe('b2', 'gs-brute', 'E3')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d } = w.peek(pc);
    const ei = entry(pc, 'srd:moonbeam');
    const val = d.castValue(v, pc, ei, 2, false, pc.cell);
    const off = d.castValue({ ...v, mute: TERM.lasting }, pc, ei, 2, false, pc.cell);
    expect(val).toBeGreaterThan(off);
    const r = w.decide(pc, (k) => k.startsWith('cast:moonbeam@2') || k === 'pass');
    const key = r.rec.top.find((t) => t.key.startsWith('cast:moonbeam'))!.key;
    expect(partOf(r.rec, key, /^ *lasting effect: its per-round payoff x its expected rounds left$/)).toBeCloseTo(val - off, 6);
  });

  it('with nobody in reach it pays nothing: the same buff when no one can be attacked is worth only minus its slot', () => {
    const w = scene({ cantrips: [], prepared: ['test:bless-like'], items: [FOCUS], hands: ['charm', null], weapons: ['longsword'] }, [PC('B2'), foe('b1', 'gs-brute', 'N6')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d } = w.peek(pc);
    expect(d.castValue(v, pc, entry(pc, 'test:bless-like'), 1, false, pc.cell)).toBeCloseTo(-DEFAULT_WEIGHTS.slotPerLevel, 9);
  });

  const kit = (spell: string) => ({ cantrips: [], prepared: [spell], items: [FOCUS], hands: ['charm', null] as [string, null], weapons: ['longsword'] });

  it('a mark is worth (p1 - p0) / p0 of my routine at the marked foe x the expected rounds, by hand: +6 at AC 12, +2 from the mark', () => {
    const w = scene(kit('test:mark-like'), [PC('B2'), foe('b1', 'gs-ogre', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { v, d } = w.peek(pc);
    const val = d.castValue(v, pc, entry(pc, 'test:mark-like'), 1, false, pc.cell);
    // Longsword 1d8 + 3, drawn this turn: 0.70 x 7.5 + 0.05 x 12 = 5.85. Hit chance 75% -> 85%.
    const share = (0.85 - 0.75) / 0.75;
    expect(val + DEFAULT_WEIGHTS.slotPerLevel).toBeCloseTo(share * 5.85 * future(DEFAULT_WEIGHTS, 10, v.stay(pc.cell, true)), 6);
  });

  it('a mark is mine alone: an ally beside the foe adds nothing to it, where a mark anyone could use would count the ally\'s routine too', () => {
    const val = (units: U[]) => {
      const w = scene(kit('test:mark-like'), units);
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      return d.castValue(v, pc, entry(pc, 'test:mark-like'), 1, false, pc.cell) - future(DEFAULT_WEIGHTS, 10, v.stay(pc.cell, true)) * (0.1 / 0.75) * 5.85;
    };
    const ally = { seat: 'pc2', team: 'party' as const, use: 'test:gs-pc', at: 'C3' };
    expect(val([PC('B2'), foe('b1', 'gs-ogre', 'C2')])).toBeCloseTo(-DEFAULT_WEIGHTS.slotPerLevel, 6);
    expect(val([PC('B2'), foe('b1', 'gs-ogre', 'C2'), ally])).toBeCloseTo(-DEFAULT_WEIGHTS.slotPerLevel, 6);
  });

  it('a mark\'s rounds read the concentration chance, though the foe bears it: a frail caster\'s mark is worth less', () => {
    const val = (hp: number) => {
      const w = scene({ ...kit('test:mark-like'), hp }, [PC('B2'), foe('b1', 'gs-ogre', 'C2')]);
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      return d.castValue(v, pc, entry(pc, 'test:mark-like'), 1, false, pc.cell);
    };
    expect(val(25)).toBeLessThan(val(300));
  });

  it('a concentration condition\'s rounds read it too: a frail caster\'s Hold Person is worth less', () => {
    const val = (hp: number) => {
      const w = scene({ ...kit('srd:hold-person'), hp }, [PC('B2'), foe('b1', 'gs-ogre', 'C2')]);
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      return d.castValue(v, pc, entry(pc, 'srd:hold-person'), 2, false, pc.cell);
    };
    expect(val(25)).toBeLessThan(val(300));
  });

  it('a mod\'s sign follows who bears it: my Boon on me is worth my share, on a foe it is a cost; an incoming Disadvantage-shaped penalty on a foe helps me and on me hurts', () => {
    const w = scene(kit('test:bless-like'), [PC('B2'), foe('b1', 'gs-ogre', 'C2')]);
    const pc = w.u('pc1');
    const f = w.u('b1');
    w.begin(pc);
    const { v } = w.peek(pc);
    const te = pc.tpl.effects.find((x) => x.mods.length > 0)!;
    const m = te.mods[0]!;
    const out = modPerRound(v, te, m, pc);
    expect(out).toBeGreaterThan(0);
    expect(modPerRound(v, te, m, f)).toBeLessThan(0);
    const { ownerOnly: _mine, ...anyone } = m;
    const inc = { ...anyone, side: 'incoming' as const };
    expect(modPerRound(v, te, inc, f)).toBeGreaterThan(0); // attacks at the foe get the die: my side's
    expect(modPerRound(v, te, inc, pc)).toBeLessThan(0); // attacks at me do
  });

  it('a live concentration buff counts: concValue reads it (G2 could not: it read only zones), my end cost charges the break chance on it, and a Dodge is bought by it', () => {
    const w = scene(kit('test:bless-like'), [PC('B2', { precast: [{ cast: 'test:bless-like', level: 1, target: 'pc1' }] }), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { d, st } = w.peek(pc);
    expect(pc.conc).toBeGreaterThanOrEqual(0);
    expect(d.concValue(st, pc)).toBeGreaterThan(0);
    expect(d.concLeft(st, pc)).toBeCloseTo(d.concValue(st, pc) * future(DEFAULT_WEIGHTS, 10), 9);
    const e = d.exposure(st, pc, pc.cell);
    expect(e).toBeGreaterThan(0);
    expect(d.endCost(st, pc, pc.cell) - DEFAULT_WEIGHTS.pc.exposure * e).toBeGreaterThanOrEqual(d.concBreak(st, pc) * Math.min(3, e / 6) * d.concLeft(st, pc) - 1e-9);
    const r = w.decide(pc, (k) => k === 'dodge' || k === 'pass');
    expect(partOf(r.rec, 'dodge', /of which bought: my concentration effect/)).toBeCloseTo(d.concLeft(st, pc), 6);
  });

  it('a live concentration effect that gives stats is worth, per round, exactly the difference it is making: no payoff on top', () => {
    const w = scene(kit('test:gs-ward'), [PC('B2', { precast: [{ cast: 'test:gs-ward', level: 1, target: 'pc1' }] }), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { d, st, v } = w.peek(pc);
    const fx = st.fx.find((x) => x.alive && x.owner === pc.idx && x.bearer === pc.idx && boundOf(st, x).stats)!;
    const live = liveChangeValue(v, fx, boundOf(st, fx), pc);
    expect(live).toBeGreaterThan(0);
    expect(d.concValue(st, pc)).toBeCloseTo(live, 9);
  });

  it('a self-buff (Rage-shaped, no concentration) is worth its stats x expected rounds, shrinking with my drop risk, net of its pool cost', () => {
    const val = (hp: number) => {
      const w = scene({ features: ['rage-like'], pool: true, hp }, [PC('B2'), foe('b1', 'gs-ogre', 'C2')]);
      const pc = w.u('pc1');
      w.begin(pc);
      const { v, d } = w.peek(pc);
      const l = newLegal();
      Object.assign(l, { k: 'use', fx: -1, opt: pc.tpl.features.findIndex((f) => f.id === 'test:rage-like'), aux: -1 });
      return { stay: v.stay(pc.cell, false), use: d.useValue(v, pc, l, pc.cell) };
    };
    const healthy = val(300);
    const frail = val(20);
    expect(healthy.stay).toBe(1);
    expect(frail.stay).toBeLessThan(1);
    expect(frail.use).toBeLessThan(healthy.use);
    expect(healthy.use).toBeGreaterThan(0);
  });
});

describe('G7: the hand configuration as a state, with a switch cost', () => {
  const cleric = (hands: [string | null, string | null], cantrips = ['srd:sacred-flame'], prepared: string[] = []): PcOpts => ({ weapons: ['mace'], items: [SHIELD, FOCUS], hands, cantrips, prepared });
  const far = [PC('B2'), foe('b1', 'gs-brute', 'H2')];

  it("the Cleric's trap: Shield and focus in hand block a V,S cantrip and the Mace; greedy stows the focus (it could never stow one) and the cantrip follows", () => {
    const w = scene(cleric(['shield', 'charm']), far);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.keys.some((k) => k.startsWith('cast:sacred-flame'))).toBe(false); // focusHandSomatic strict: no Material, no gestures from the focus hand
    expect(r.key).toBe('item:stow/charm');
    expect(partOf(r.rec, r.key, /^stowing Charm: the better strike or cast its hand unblocks/)).toBeGreaterThan(0);
    expect(partOf(r.rec, r.key, /^loadout: the switch$/)).toBe(-DEFAULT_WEIGHTS.loadoutSwitch);
  });

  it('every item row adds up to the value it was scored at (ai-logic-5): with both a use now and a gain next turn, only the better one is a part', () => {
    const w = scene(cleric(['shield', 'charm']), far);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    const row = top(r.rec, 'item:stow/charm')!;
    expect(row.parts.reduce((a, p) => a + p.ev, 0)).toBeCloseTo(row.ev, 9);
    expect(row.parts.filter((p) => /next turn|stowing/.test(p.term))).toHaveLength(1);
  });

  it('a change that buys this turn but costs next turn is net of both: the row is what it gives now plus the (negative) gain, less the switch', () => {
    const w = scene(cleric(['shield', null]), [PC('B2'), foe('b1', 'gs-brute', 'C2')], { loadoutSwitch: 0.05 });
    const pc = w.u('pc1');
    w.begin(pc, { action: 0 });
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    const row = top(r.rec, 'item:draw/mace')!;
    const now = partOf(r.rec, 'item:draw/mace', /^what Mace gives back$/)!;
    const later = partOf(r.rec, 'item:draw/mace', /^next turn's best option/)!;
    expect(now).toBeGreaterThan(0);
    expect(later).toBeLessThan(0);
    expect(row.ev).toBeCloseTo(now + later - 0.05 + partOf(r.rec, 'item:draw/mace', /^exposure here/)!, 9);
  });

  /** The Cleric's hands read through the private loadout values, primed for a decision. */
  const lo = (w: ReturnType<typeof scene>, pc: Unit) => {
    w.begin(pc);
    pc.b.moveFt = 0;
    const { d, v } = w.peek(pc);
    const view = w.cx.views[pc.idx]!;
    const ix = (id: string) => pc.tpl.items.findIndex((i) => i.local === id);
    const hands = (a: string | null, b: string | null) => Int16Array.of(a === null ? HAND.empty : ix(a), b === null ? HAND.empty : ix(b));
    return { best: (a: string | null, b: string | null) => d.loadoutBest(view, pc, v, hands(a, b)), value: (a: string | null, b: string | null) => d.loadoutValue(view, pc, v, hands(a, b)), d, v, ix };
  };

  it('a state with the weapon to draw is worth its strike less the switch; with it in hand, the strike', () => {
    const w = scene({ weapons: ['longsword'], hands: [null, null] }, [PC('B2'), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    const l = lo(w, pc);
    expect(l.best('longsword', null) - l.best(null, null)).toBeCloseTo(DEFAULT_WEIGHTS.loadoutSwitch, 9);
  });

  it('next turn\'s free interaction draws into a free hand, at a switch: Shield and a free hand are worth the focus-cast less the switch; a focus lying on another square can\'t be drawn', () => {
    const units = [PC('B2'), foe('b1', 'gs-brute', 'E4'), foe('b2', 'gs-brute', 'E5')];
    const w = scene(cleric(['shield', null], [], ['srd:moonbeam']), units);
    const pc = w.u('pc1');
    const l = lo(w, pc);
    const withFocus = l.best('shield', 'charm');
    expect(withFocus - DEFAULT_WEIGHTS.loadoutSwitch).toBeGreaterThan(l.best('shield', null));
    expect(l.value('shield', null)).toBeCloseTo(withFocus - DEFAULT_WEIGHTS.loadoutSwitch, 9);
    const gone = scene(cleric(['shield', null], [], ['srd:moonbeam']), units);
    const pg = gone.u('pc1');
    const lg = lo(gone, pg);
    (pg.dropped as unknown as Int16Array)[lg.ix('charm')] = pg.cell + 1;
    expect(lg.value('shield', null)).toBeLessThan(l.value('shield', null));
  });

  it('a state can only cast what its hands allow: a V,S cantrip with Shield and focus is out, with a hand free it is in', () => {
    const w = scene(cleric(['shield', null]), [PC('B2'), foe('b1', 'gs-brute', 'H2')]);
    const pc = w.u('pc1');
    const l = lo(w, pc);
    expect(l.best('shield', null)).toBeGreaterThan(l.best('shield', 'charm'));
  });

  it('a spell cast through a held item needs that item in the state: with the Charm a Sacred Flame is on, with empty hands only the Mace', () => {
    const w = scene({ ...cleric([null, null]), whileHeld: 'charm' }, [PC('B2'), foe('b1', 'gs-brute', 'H2')]);
    const pc = w.u('pc1');
    const l = lo(w, pc);
    expect(l.best('charm', null)).toBeGreaterThan(l.best(null, null));
  });

  it('next turn\'s spell floor counts a one-hand change: Shield and Mace in hand, nothing to cast with, but next turn\'s free interaction stows the Mace', () => {
    const w = scene({ weapons: ['mace'], items: [SHIELD, FOCUS], hands: ['shield', 'mace'], cantrips: ['srd:sacred-flame'] }, [PC('B2'), foe('b1', 'gs-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const { d, v } = w.peek(pc);
    expect(d.nextTurnCast(v, pc)).toBeGreaterThan(0);
  });

  it('a stow that would end a live spell through that item isn\'t offered: the Cleric\'s trap with a live effect on the Charm keeps the Charm', () => {
    const w = scene(cleric(['shield', 'charm'], ['srd:sacred-flame'], ['test:bless-like']), [PC('B2', { precast: [{ cast: 'test:bless-like', level: 1, target: 'pc1' }] }), foe('b1', 'gs-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.moveFt = 0;
    const charm = pc.tpl.items.findIndex((i) => i.local === 'charm');
    const free = w.decide(pc);
    expect(free.key).toBe('item:stow/charm');
    const fx = w.cx.st.fx.find((x) => x.alive && x.owner === pc.idx)!;
    (fx as { srcItem: number }).srcItem = charm;
    w.begin(pc);
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.key).not.toBe('item:stow/charm');
    expect(top(r.rec, 'item:stow/charm')).toBeUndefined();
  });

  it('drawing a focus waits for the turn it is used: with the Action spent, next turn\'s free object interaction does the same, so it is worth nothing now', () => {
    const w = scene(cleric(['shield', null], [], ['test:bless-like']), [PC('B2'), foe('b1', 'gs-brute', 'H2')]);
    const pc = w.u('pc1');
    w.begin(pc, { action: 0 });
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.keys).toContain('item:draw/charm');
    expect(r.key).not.toBe('item:draw/charm');
    expect(top(r.rec, 'item:draw/charm')).toBeUndefined();
  });

  it('hysteresis: after a cast, a Mace drawn for an opportunity attack would have to be stowed again for next turn\'s cast, so it stays sheathed', () => {
    const w = scene(cleric(['shield', null]), [PC('B2'), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc, { action: 0 });
    pc.b.moveFt = 0;
    const r = w.decide(pc);
    expect(r.keys).toContain('item:draw/mace');
    expect(r.key).toBe('pass');
  });

  it('a change the next turn cannot make is valued for that later charge: two weapons in hand, the Greataxe needs both hands, and only one hand can change next turn', () => {
    const go = (hands: [string, string | null]) => {
      const w = scene({ weapons: ['mace', 'dagger', 'greataxe'], hands }, [PC('B2'), foe('b1', 'gs-ogre', 'H2')], { loadoutSwitch: 0.1 });
      const pc = w.u('pc1');
      w.begin(pc, { action: 0 });
      pc.b.moveFt = 0;
      return w.decide(pc);
    };
    const r = go(['mace', 'dagger']);
    expect(r.key).toMatch(/^item:stow\/(mace|dagger)$/);
    const later = partOf(r.rec, r.key, /^next turn's best option in those hands over these, x gamma/)!;
    expect(later).toBeGreaterThan(0.1);
    // It is gamma x the state it reaches over the one it leaves.
    const v0 = scene({ weapons: ['mace', 'dagger', 'greataxe'], hands: ['mace', 'dagger'] }, [PC('B2'), foe('b1', 'gs-ogre', 'H2')], { loadoutSwitch: 0.1 });
    const pc0 = v0.u('pc1');
    const l0 = lo(v0, pc0);
    const stowed = r.key.endsWith('mace') ? l0.value(null, 'dagger') : l0.value('mace', null);
    expect(later).toBeCloseTo(DEFAULT_WEIGHTS.gamma * (stowed - l0.value('mace', 'dagger')), 6);
    // One hand full: next turn's free interaction clears it and the Attack action draws the Greataxe, so nothing is gained now.
    const twin = go(['mace', null]);
    expect(twin.key).not.toBe('item:stow/mace');
  });

  it('the switch cost keeps the weapon in hand when another is barely better: a drawn Longsword isn\'t worth the change from a held Mace at a high cost, and is at none', () => {
    const units = [PC('B2'), foe('b1', 'gs-brute', 'C2')];
    const go = (loadoutSwitch: number) => {
      const w = scene({ weapons: ['mace', 'longsword'], hands: ['mace', null] }, units, { loadoutSwitch });
      const pc = w.u('pc1');
      w.begin(pc);
      pc.b.moveFt = 0;
      return w.decide(pc);
    };
    expect(go(0).key).toBe('attack:longsword>b1');
    const r = go(10);
    expect(r.key).toBe('attack:mace>b1');
  });

  it('a character with nothing to change is untouched: no items, no item options, no loadout term in its Explain', () => {
    const w = scene({ weapons: ['longsword'], hands: ['longsword', null] }, [PC('B2'), foe('b1', 'gs-brute', 'C2')]);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.key).toBe('attack:longsword>b1');
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => /loadout/.test(p.term))).toBe(false);
  });
});
