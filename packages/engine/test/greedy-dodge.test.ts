// Coverage 8'b G2, G3, G4 and the "stalemate by cause" family (docs/design/coverage.md section 2,
// M6, M7, m8, m10): non-lethal damage is credited for the foe output it removes (PC side only); the
// Dodge action counts what the time buys and, on a side with a progress weight, nothing past that
// (7.0b); the no-progress streak is fight state and decays the Dodge term. Each case is a constructed
// state named for what it checks. Content is synthetic (test: ids), compiled with the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { DEFAULT_WEIGHTS, future, type Weights } from '../src/decide/greedy/weights.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { computeReport, renderReport } from '../src/mc/report.ts';
import { mergeInto, newMerged, runChunk, type ArmSpec } from '../src/mc/runner.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { COND, noProgressTurns, quietTurnsNow, STALEMATE_CAUSES, stalemateCauseOf, stateHash, type Unit } from '../src/sim/state.ts';
import { dealDamage, kill, revive } from '../src/sim/damage.ts';

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

const PC = (cure: boolean, ac: number, caster = false, extra = false, feats: string[] = []) => `kind: pc
id: test:dg-pc
name: Dodge PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 12, con: 14, int: ${caster ? 18 : 10}, wis: 14, cha: 8 }
hpMax: 44
ac: ${ac}
armor: none
saveProficiencies: [str, con]
${extra ? 'extraAttacks: 1\n' : ''}weapons:
  - { id: longsword, name: Longsword, kind: melee, ability: str, category: martial, damage: [{ roll: 1d8 + @mod, type: slashing }] }
features: [${feats.join(', ')}]
${caster ? 'casting:\n  - { source: wizard, ability: int, list: wizard, cantrips: [srd:fire-bolt] }\n' : ''}${cure ? "slots: [4, 3]\ncasting:\n  - { source: cleric, ability: wis, list: cleric, prepared: ['srd:cure-wounds'] }\n" : ''}`;

const monster = (id: string, hp: number, ac: number, toHit: number, dmg: string, avg: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${toHit}, damage: [{ roll: '${dmg}', type: slashing, avg: ${avg} }] }
`;

const KIT: Record<string, string> = {
  'packs/test/monsters/dg-brute.yaml': monster('dg-brute', 60, 12, 6, '2d8 + 4', 13),
  // Hard to hit, hits hard, and rarely: with an ally buying the time the Dodge's term beats its own strike, with no HP moving.
  'packs/test/monsters/dg-wall.yaml': monster('dg-wall', 500, 24, 0, '6d10 + 15', 48),
  // Against a Poisoned PC (flip) or a plain one (flip-heal), its strike is worth less than a Dodge the time pays for, and more than none: what the time buys decides.
  'packs/test/monsters/dg-flip.yaml': monster('dg-flip', 60, 18, 8, '3d10 + 5', 21),
  'packs/test/monsters/dg-flip-heal.yaml': monster('dg-flip-heal', 30, 22, 8, '3d10 + 5', 21),
  // Hits for most of a PC's HP, always.
  'packs/test/monsters/dg-ko.yaml': monster('dg-ko', 60, 12, 40, '50', 50),
  'packs/test/monsters/dg-still.yaml': monster('dg-still', 60, 12, 0, '1', 1).replace('walk: 30', 'walk: 0'),
  'packs/test/monsters/dg-sniper.yaml': monster('dg-sniper', 60, 12, 5, '1d8 + 3', 8)
    .replace('walk: 30', 'walk: 0')
    .replace("{ id: claw, name: Claw, kind: melee, toHit: 5, damage: [{ roll: '1d8 + 3', type: slashing, avg: 8 }] }", "{ id: bow, name: Bow, kind: ranged, toHit: 5, range: [10, 600], damage: [{ roll: '1d8 + 3', type: piercing, avg: 8 }] }"),
  'packs/test/features/dg-bonus-dodge.yaml': `kind: feature
id: test:dg-bonus-dodge
name: dg-bonus-dodge
source: synthetic test fixture (Patient Defense's shape)
activate: { id: guard, name: Guard, cost: bonus, do: [{ core: dodge }] }
`,
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const pc = (at: string, seat = 'pc1'): U => ({ seat, team: 'party', use: 'test:dg-pc', at });
/** The PC's twin with an Extra Attack: its routine is twice the PC's, and buys twice the time. */
const strong = (at: string, seat = 'pc2'): U => ({ seat, team: 'party', use: 'test:dg-ally', at });
const foe =(seat: string, use: string, at: string): U => ({ seat, team: 'enemies', use: `test:${use}`, at });

interface Opt {
  cure?: boolean;
  caster?: boolean;
  ac?: number;
  w?: Weights;
  extra?: boolean;
  feats?: string[];
  terrain?: string[];
  /** Initiative order by seat (default: the units as given). */
  order?: string[];
  knobs?: Record<string, unknown>;
}

function setupOf(units: U[], o: Opt = {}): FightSetup {
  const ally = PC(false, o.ac ?? 16, false, true).replace('id: test:dg-pc', 'id: test:dg-ally').replace('name: Dodge PC', 'name: Dodge Ally');
  const files = [...REPO, ...Object.entries({ ...KIT, 'packs/test/pcs/dg-pc.yaml': PC(o.cure ?? false, o.ac ?? 16, o.caster ?? false, o.extra ?? false, o.feats ?? []), 'packs/test/pcs/dg-ally.yaml': ally }).map(([path, text]) => ({ path, text }))];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gdodge', name: 'Greedy Dodge', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 26, h: 6, ...(o.terrain ? { terrain: o.terrain } : {}) },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false, ...o.knobs },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gdodge.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

function scene(units: U[], o: Opt = {}) {
  const s = setupOf(units, o);
  const ds = s.seats.map(() => new GreedyDecider(o.w ?? DEFAULT_WEIGHTS));
  const cx = createContext(s, 1, 0, ds, null);
  applyPassives(cx, -1);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  (o.order ?? units.map((x) => x.seat)).forEach((seat, i) => (cx.st.order[i] = u(seat).idx));
  cx.st.round = 1;
  /** A fresh turn on its square: no move left, so the list is short and every option makes Explain's top 3. */
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: 0, atkActive: false, movedFt: 0 });
  };
  const decide = (who: Unit, keep: (k: string) => boolean = () => true): { key: string; rec: ExplainRecord } => {
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
    return { key: keys[i]!, rec: records.at(-1)! };
  };
  return { cx, s, u, ds, begin, decide };
}

const row = (rec: ExplainRecord, key: string) => rec.top.find((t) => t.key === key)!;
const part = (rec: ExplainRecord, key: string, re: RegExp) => row(rec, key).parts.find((p) => re.test(p.term))?.ev;
const PROGRESS = /^ *(of which )?progress: the foe output/;
const DODGE = /^Dodge: attacks against it/;
const ALLY = /of which bought: an ally/;
const CONC = /of which bought: my concentration/;
const HEAL = /of which bought: a rescue or heal/;
const PAST = /^past what the time buys: delay alone counts nothing$/;
const STALE = /^no progress/;
const EXPOSURE = /^exposure here/;
const F = future(DEFAULT_WEIGHTS);
/** No Dodge row. Read it off a decision whose list is short enough that every option makes Explain's top 3 (the `DK` filter). */
const noDodgeRow = (rec: ExplainRecord) => expect(rec.top.map((t) => t.key)).not.toContain('dodge');
/** What the Disadvantage is worth on my square before any of G2's reading: read after a decision, for the view it sets. */
const rawOf = (w: ReturnType<typeof scene>, me: Unit) => (w.ds[me.idx]! as unknown as { dodgeRaw(st: unknown, me: Unit, cell: number): number }).dodgeRaw(w.cx.st, me, me.cell);
/** Replace what the time buys, by hand: the real sources are each proved on their own scenes. */
const stubBought = (w: ReturnType<typeof scene>, me: Unit, b: { ally?: number; conc?: number; heal?: number }) => {
  const d = w.ds[me.idx]! as unknown as { dodgeAllyTurns: () => number; concLeft: () => number; dodgePendingHeal: () => number };
  if (b.ally !== undefined) d.dodgeAllyTurns = () => b.ally!;
  if (b.conc !== undefined) d.concLeft = () => b.conc!;
  if (b.heal !== undefined) d.dodgePendingHeal = () => b.heal!;
};
// +6 vs AC 12, 1d8 + 3: the PC's Longsword routine at the brute, which an ally's turn buys (G3's first case).
const SWORD_AT_BRUTE = 0.7 * 7.5 + 0.05 * 12;
// +6 vs AC 24, 1d8 + 3: 15%, 5% of it a crit, what one strike at the wall buys.
const SWORD_AT_WALL = 0.1 * 7.5 + 0.05 * 12;
// The brute against AC 16, alone on me (+6, 2d8 + 4): 55% to hit, 5% of it a crit; with Disadvantage 30.25%, 0.25% of it a crit.
const BRUTE_RAW = 0.5 * 13 + 0.05 * 22 - (0.3 * 13 + 0.0025 * 22);

describe('G3: non-lethal damage is credited for the foe output it removes (M6, m8)', () => {
  it('the credit is damage / foe HP x foe threat x future(w, rounds left), named in Explain', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    const c = part(r.rec, 'attack:longsword>b1', PROGRESS)!;
    expect(c).toBeGreaterThan(0);
    // +6 vs AC 12 (75%, 5% of it a crit), 1d8 + 3: (0.70 x 7.5) + (0.05 x 12) over 60 HP, x the brute's routine against AC 16 (+6, 2d8 + 4: 55%, 5% of it a crit) x F.
    const dmg = 0.7 * 7.5 + 0.05 * 12;
    const threat = 0.5 * 13 + 0.05 * 22;
    expect(c).toBeCloseTo((dmg / 60) * threat * F, 6);
  });

  it('the horizon is future(w, rounds left): in the last round it counts one round, not F (m8)', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')], { knobs: { maxRounds: 4 } });
    const me = w.u('pc1');
    w.begin(me);
    const early = part(w.decide(me).rec, 'attack:longsword>b1', PROGRESS)!;
    w.cx.st.round = 4;
    w.begin(me);
    const late = part(w.decide(me).rec, 'attack:longsword>b1', PROGRESS)!;
    expect(late / early).toBeCloseTo(1 / F, 6);
  });

  it('damage that drops the foe earns the kill term, not the credit: at 1 HP there is none', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')]);
    const me = w.u('pc1');
    w.u('b1').hp = 1;
    w.begin(me);
    expect(part(w.decide(me).rec, 'attack:longsword>b1', PROGRESS)).toBeUndefined();
  });

  it('a wounded foe of the same kind is worth more of it: the same damage is a larger share of what is left', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), foe('b2', 'dg-brute', 'B2'), pc('D1', 'pc2')]);
    const me = w.u('pc1');
    w.u('b2').hp = 30;
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toBe('attack:longsword>b2');
    expect(part(r.rec, 'attack:longsword>b2', PROGRESS)!).toBeGreaterThan(part(r.rec, 'attack:longsword>b1', PROGRESS)!);
  });

  it('PC side only: a monster\'s strike has no credit (side weight 0), and a PC with progress 0 has none either', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    const b = w.u('b1');
    w.begin(b);
    expect(part(w.decide(b).rec, 'attack:claw>pc1', PROGRESS)).toBeUndefined();
    const off = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], { w: { ...DEFAULT_WEIGHTS, pc: { ...DEFAULT_WEIGHTS.pc, progress: 0 } } });
    const me = off.u('pc1');
    off.begin(me);
    expect(part(off.decide(me).rec, 'attack:longsword>b1', PROGRESS)).toBeUndefined();
  });

  it('a spell\'s damage earns it too (Fire Bolt), so the credit doesn\'t tilt a caster to its weapon; Explain names it', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')], { caster: true });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me, (k) => k.startsWith('attack:fire-bolt') || k.startsWith('cast:fire-bolt') || k === 'pass');
    const key = r.rec.top.find((t) => /fire-bolt/.test(t.key))!.key;
    expect(part(r.rec, key, PROGRESS)!).toBeGreaterThan(0);
  });

  it('alone, a hit that doesn\'t drop the foe pays only if I stay up to finish it: at 3 HP the credit shrinks; with an ally up it stands', () => {
    const solo = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    const me = solo.u('pc1');
    solo.begin(me);
    const full = part(solo.decide(me).rec, 'attack:longsword>b1', PROGRESS)!;
    me.hp = 3;
    solo.begin(me);
    const low = part(solo.decide(me).rec, 'attack:longsword>b1', PROGRESS) ?? 0;
    expect(low).toBeLessThan(full / 2);
    const duo = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')]);
    const me2 = duo.u('pc1');
    me2.hp = 3;
    duo.begin(me2);
    expect(part(duo.decide(me2).rec, 'attack:longsword>b1', PROGRESS)!).toBeCloseTo(full, 6);
  });
});

describe('G2: the Dodge action counts what the time buys, and nothing past it', () => {
  const DK = (k: string) => k === 'dodge' || k === 'pass';

  it('with nothing bought and a strike in reach, the Dodge isn\'t offered, though the attacks on me are real: no row, and the PC strikes', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    const me = w.u('pc1');
    w.begin(me);
    expect(w.decide(me).key).toBe('attack:longsword>b1');
    const r = w.decide(me, DK);
    noDodgeRow(r.rec);
    expect(r.key).toBe('pass');
    expect(rawOf(w, me)).toBeCloseTo(BRUTE_RAW, 6);
  });

  it('a deliberate choice: with nothing bought and NO strike in reach the Dodge isn\'t offered either: the PC walks or acts rather than turtle, and with neither left it passes', () => {
    const noMove = scene([pc('A1'), foe('b1', 'dg-brute', 'F1')]); // 25 ft: the brute walks up
    const me = noMove.u('pc1');
    noMove.begin(me);
    const r = noMove.decide(me);
    noDodgeRow(r.rec);
    expect(r.key).toBe('pass');
    expect(rawOf(noMove, me)).toBeCloseTo(BRUTE_RAW, 6); // the Dodge it turned down was worth this much
    const walks = scene([pc('A1'), foe('b1', 'dg-brute', 'F1')]);
    const m2 = walks.u('pc1');
    walks.begin(m2);
    m2.b.moveFt = 30;
    const r2 = walks.decide(m2);
    noDodgeRow(r2.rec);
    expect(r2.key).toMatch(/^move:/);
    const acts = scene([pc('A1'), foe('b1', 'dg-brute', 'F1')], { caster: true });
    const m3 = acts.u('pc1');
    acts.begin(m3);
    const r3 = acts.decide(m3);
    noDodgeRow(r3.rec);
    expect(r3.key).toMatch(/fire-bolt/);
  });

  it('an ally\'s turn before the attacker acts buys the time, at its routine; the same ally after the attacker buys nothing, so there is no Dodge', () => {
    const units = [pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('C2', 'pc2')];
    const before = scene(units, { order: ['pc1', 'pc2', 'b1'] });
    const me = before.u('pc1');
    before.begin(me);
    const r = before.decide(me, DK);
    expect(part(r.rec, 'dodge', ALLY)).toBeCloseTo(SWORD_AT_BRUTE, 6);
    const after = scene(units, { order: ['pc1', 'b1', 'pc2'] });
    const me2 = after.u('pc1');
    after.begin(me2);
    noDodgeRow(after.decide(me2, DK).rec);
  });

  it('with two attackers, an ally between them counts for the share still to come', () => {
    const units = [pc('A1'), foe('b1', 'dg-brute', 'B1'), foe('b2', 'dg-brute', 'B2'), pc('C3', 'pc2')];
    const first = scene(units, { order: ['pc1', 'pc2', 'b1', 'b2'] });
    const m1 = first.u('pc1');
    first.begin(m1);
    const between = scene(units, { order: ['pc1', 'b1', 'pc2', 'b2'] });
    const m2 = between.u('pc1');
    between.begin(m2);
    const a = part(first.decide(m1, DK).rec, 'dodge', ALLY)!;
    const b = part(between.decide(m2, DK).rec, 'dodge', ALLY)!;
    expect(b).toBeCloseTo(a / 2, 6);
  });

  it('an ally turtling too (it Dodged last turn), or out of reach of every foe, buys nothing, so there is no Dodge; the same ally up and in reach does', () => {
    const units = [pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('C2', 'pc2')];
    const w = scene(units, { order: ['pc1', 'pc2', 'b1'] });
    const me = w.u('pc1');
    w.begin(me);
    expect(part(w.decide(me, DK).rec, 'dodge', ALLY)).toBeCloseTo(SWORD_AT_BRUTE, 6);
    w.u('pc2').dodgeRun = 1;
    w.begin(me);
    noDodgeRow(w.decide(me, DK).rec);
    const far = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('Z6', 'pc2')], { order: ['pc1', 'pc2', 'b1'] });
    const m2 = far.u('pc1');
    far.begin(m2);
    noDodgeRow(far.decide(m2, DK).rec);
  });

  it('a running concentration zone\'s remaining value buys it: zoneValue x future(w, rounds left), and with no zone up there is no Dodge', () => {
    const units = [{ seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A1' } as U, foe('b1', 'dg-brute', 'A2'), foe('b2', 'dg-brute', 'B2')];
    const w = scene(units);
    const me = w.u('pc1');
    w.begin(me);
    const list = listOptions(w.cx, me, takeList(w.cx));
    let cast: Legal | null = null;
    for (let i = 0; i < list.n; i++) if (legalKey(w.cx.st, me.idx, list.items[i]!).startsWith('cast:moonbeam')) cast = copyLegal(list.items[i]!, newLegal());
    releaseList(w.cx, list);
    expect(cast).not.toBeNull();
    noDodgeRow(w.decide(me, DK).rec);
    resolveOption(w.cx, me, cast!, -1);
    expect(me.conc).toBeGreaterThanOrEqual(0);
    w.begin(me);
    const rec = w.decide(me, DK).rec;
    const conc = part(rec, 'dodge', CONC)!;
    const raw = part(rec, 'dodge', DODGE)!;
    expect(conc).toBeGreaterThan(0);
    expect(row(rec, 'dodge').ev).toBeCloseTo(Math.min(conc, raw) + part(rec, 'dodge', EXPOSURE)!, 6);
  });

  it('a pending rescue buys it: a downed ally in reach of my Cure Wounds next turn; the twin with no slots has no Dodge', () => {
    const units = [pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')];
    const w = scene(units, { cure: true, order: ['pc1', 'b1', 'pc2'] });
    const me = w.u('pc1');
    Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
    w.begin(me);
    const rec = w.decide(me, DK).rec;
    const heal = part(rec, 'dodge', HEAL)!;
    expect(heal).toBeGreaterThan(0);
    expect(row(rec, 'dodge').ev).toBeCloseTo(Math.min(heal, part(rec, 'dodge', DODGE)!) + part(rec, 'dodge', EXPOSURE)!, 6);
    me.res.fill(0);
    w.begin(me);
    noDodgeRow(w.decide(me, DK).rec);
  });

  it('a pending heal on myself under half HP buys it, in part here: the row is what it buys, the rest gone; at full HP with nobody hurt nothing is pending and there is no Dodge', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], { cure: true });
    const me = w.u('pc1');
    w.begin(me);
    noDodgeRow(w.decide(me, DK).rec);
    me.hp = 15;
    w.begin(me);
    const rec = w.decide(me, DK).rec;
    const heal = part(rec, 'dodge', HEAL)!;
    const raw = part(rec, 'dodge', DODGE)!;
    expect(heal).toBeGreaterThan(0);
    expect(heal).toBeLessThan(raw);
    expect(part(rec, 'dodge', PAST)).toBeCloseTo(heal - raw, 6);
    expect(row(rec, 'dodge').ev).toBeCloseTo(heal + part(rec, 'dodge', EXPOSURE)!, 6);
  });

  it('what the time buys goes into the value, not only the Explain row: an ally before the attacker makes the Dodge row raw plus exposure, with no PAST line; the ally after it leaves no row at all, and the strike', () => {
    const units = [pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('C2', 'pc2')];
    const before = scene(units, { order: ['pc1', 'pc2', 'b1'] });
    const m1 = before.u('pc1');
    before.begin(m1);
    const a = before.decide(m1).rec;
    const raw = part(a, 'dodge', DODGE)!;
    expect(raw).toBeCloseTo(BRUTE_RAW / 2, 6); // the brute has two PCs to swing at
    expect(part(a, 'dodge', ALLY)!).toBeGreaterThanOrEqual(raw);
    expect(part(a, 'dodge', PAST)).toBeUndefined();
    expect(row(a, 'dodge').ev).toBeCloseTo(raw + part(a, 'dodge', EXPOSURE)!, 6);
    const after = scene(units, { order: ['pc1', 'b1', 'pc2'] });
    const m2 = after.u('pc1');
    after.begin(m2);
    const b = after.decide(m2);
    noDodgeRow(b.rec);
    expect(b.key).toBe('attack:longsword>b1');
  });

  it('bought in part: the term kept is exactly what was bought, whatever the strike given up is worth (one swing, two, or one that drops the foe)', () => {
    const go = (o: Opt, hp?: number) => {
      const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], o);
      const me = w.u('pc1');
      if (hp !== undefined) w.u('b1').hp = hp;
      w.begin(me);
      stubBought(w, me, { ally: 2.5 });
      const r = w.decide(me, (k) => DK(k) || k === 'attack:longsword>b1').rec;
      const raw = part(r, 'dodge', DODGE)!;
      expect(raw).toBeCloseTo(BRUTE_RAW, 6);
      expect(2.5).toBeLessThan(raw);
      expect(row(r, 'dodge').ev).toBeCloseTo(2.5 + part(r, 'dodge', EXPOSURE)!, 6);
      expect(part(r, 'dodge', PAST)).toBeCloseTo(2.5 - raw, 6);
      return row(r, 'attack:longsword>b1').ev;
    };
    const plain = go({});
    const twice = go({ extra: true });
    const finishing = go({}, 1);
    expect(twice).toBeGreaterThan(plain + 1); // the strikes really do differ
    expect(finishing).toBeGreaterThan(plain + 1);
  });

  it('what is bought adds up, ally + concentration + heal, every one in the kept term', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    const me = w.u('pc1');
    w.begin(me);
    stubBought(w, me, { ally: 1, conc: 0.5, heal: 0.25 });
    const r = w.decide(me, DK).rec;
    expect(part(r, 'dodge', ALLY)).toBeCloseTo(1, 6);
    expect(part(r, 'dodge', CONC)).toBeCloseTo(0.5, 6);
    expect(part(r, 'dodge', HEAL)).toBeCloseTo(0.25, 6);
    expect(part(r, 'dodge', PAST)).toBeCloseTo(1.75 - BRUTE_RAW, 6);
    expect(row(r, 'dodge').ev).toBeCloseTo(1.75 + part(r, 'dodge', EXPOSURE)!, 6);
  });

  it('concentration alone or a heal alone buys what it buys: neither needs the other sources', () => {
    for (const b of [{ conc: 1.25 }, { heal: 1.25 }]) {
      const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
      const me = w.u('pc1');
      w.begin(me);
      stubBought(w, me, b);
      const r = w.decide(me, DK).rec;
      expect(row(r, 'dodge').ev).toBeCloseTo(1.25 + part(r, 'dodge', EXPOSURE)!, 6);
    }
  });

  it('the term is the ceiling: bought exactly the term, or far past it, keeps the term, no more, with no PAST line; a heal isn\'t asked for once it\'s paid', () => {
    for (const over of [0, 10]) {
      const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], { cure: true });
      const me = w.u('pc1');
      me.hp = 15; // a heal is pending, and would show if it were read
      w.begin(me);
      w.decide(me, DK);
      const raw = rawOf(w, me);
      stubBought(w, me, { ally: raw + over });
      const r = w.decide(me, DK).rec;
      expect(part(r, 'dodge', PAST)).toBeUndefined();
      expect(part(r, 'dodge', HEAL)).toBeUndefined();
      expect(part(r, 'dodge', DODGE)).toBeCloseTo(raw, 6);
      expect(row(r, 'dodge').ev).toBeCloseTo(raw + part(r, 'dodge', EXPOSURE)!, 6);
    }
  });

  it('the decision flips on an ally before the attacker: Dodge with it, the strike without it', () => {
    const units = [pc('A1'), foe('f1', 'dg-flip', 'B1'), pc('C2', 'pc2')];
    const a = scene(units, { order: ['pc1', 'pc2', 'f1'] });
    a.u('pc1').condMask |= COND.poisoned;
    a.begin(a.u('pc1'));
    expect(a.decide(a.u('pc1')).key).toBe('dodge');
    const b = scene(units, { order: ['pc1', 'f1', 'pc2'] });
    b.u('pc1').condMask |= COND.poisoned;
    b.begin(b.u('pc1'));
    expect(b.decide(b.u('pc1')).key).toBe('attack:longsword>f1');
  });

  it('the decision flips on a pending rescue: Dodge with a slot left for the downed ally, the strike with none', () => {
    const go = (slots: boolean) => {
      const w = scene([pc('A1'), foe('f1', 'dg-flip-heal', 'B1'), pc('D1', 'pc2')], { cure: true, order: ['pc1', 'f1', 'pc2'] });
      const me = w.u('pc1');
      Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
      w.begin(me);
      if (!slots) me.res.fill(0);
      return w.decide(me, (k) => !k.startsWith('cast')).key;
    };
    expect(go(true)).toBe('dodge');
    expect(go(false)).toBe('attack:longsword>f1');
  });

  it('a pending heal: under half HP only (exactly half is no trigger), within next turn\'s walk (a downed ally beyond it, or behind a wall, is not pending), at gamma x what the heal is worth', () => {
    const self = (hp: number) => {
      const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], { cure: true });
      const me = w.u('pc1');
      me.hp = hp;
      w.begin(me);
      return w.decide(me, (k) => k === 'dodge' || k === 'pass').rec;
    };
    noDodgeRow(self(22));
    expect(part(self(21), 'dodge', HEAL)!).toBeGreaterThan(0);
    const ally = (at: string, terrain?: string[]) => {
      const w = scene([pc('A1'), foe('b1', 'dg-brute', 'A2'), pc(at, 'pc2')], { cure: true, order: ['pc1', 'b1', 'pc2'], ...(terrain ? { terrain } : {}) });
      const me = w.u('pc1');
      Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
      w.begin(me);
      return { w, me, rec: w.decide(me, (k) => k === 'dodge' || k === 'pass').rec };
    };
    const near = ally('D1');
    const peek = near.w.ds[near.me.idx]! as unknown as { vctxFor(st: unknown, me: Unit, v: unknown): unknown; castValue(v: unknown, me: Unit, opt: number, lvl: number, free: boolean, from: number): number };
    const ctx = peek.vctxFor(near.w.cx.st, near.me, near.w.cx.views[near.me.idx]!);
    expect(part(near.rec, 'dodge', HEAL)!).toBeCloseTo(DEFAULT_WEIGHTS.gamma * peek.castValue(ctx, near.me, 0, 1, false, near.w.u('pc2').cell), 6);
    noDodgeRow(ally('Z6').rec);
    noDodgeRow(ally('D1', ['..#' + '.'.repeat(23), '..#' + '.'.repeat(23), '..#' + '.'.repeat(23), '..#' + '.'.repeat(23), '..#' + '.'.repeat(23), '..#' + '.'.repeat(23)]).rec); // 15 ft in a line, no way round
  });

  it('a concentration effect that ends on a timer buys only the rounds it has left: its term falls to one round\'s worth with one turn to run', () => {
    const units = [{ seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A1' } as U, foe('b1', 'dg-brute', 'A2'), foe('b2', 'dg-brute', 'B2')];
    const w = scene(units);
    const me = w.u('pc1');
    w.begin(me);
    const list = listOptions(w.cx, me, takeList(w.cx));
    let cast: Legal | null = null;
    for (let i = 0; i < list.n; i++) if (legalKey(w.cx.st, me.idx, list.items[i]!).startsWith('cast:moonbeam')) cast = copyLegal(list.items[i]!, newLegal());
    releaseList(w.cx, list);
    resolveOption(w.cx, me, cast!, -1);
    w.begin(me);
    const fx = w.cx.st.fx[me.conc]! as { until: unknown };
    const K = (k: string) => k === 'dodge' || k === 'pass';
    fx.until = { k: 'timed', unit: me.idx, turn: me.turns + 8, when: 'end' };
    const long = part(w.decide(me, K).rec, 'dodge', CONC)!;
    w.begin(me);
    fx.until = { k: 'timed', unit: me.idx, turn: me.turns + 1, when: 'end' };
    const short = part(w.decide(me, K).rec, 'dodge', CONC)!;
    expect(short).toBeGreaterThan(0);
    expect(long / short).toBeCloseTo(future(DEFAULT_WEIGHTS, 8), 6);
  });

  it('a Dodge worth nothing isn\'t an option (ai-logic-4): no foe in reach of me, a pass, no Dodge row, and no streak after a whole fight of it', () => {
    const w = scene([pc('A1'), foe('d1', 'dg-still', 'Z6')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toBe('pass');
    expect(r.rec.top.some((t) => t.key === 'dodge')).toBe(false);
    const s = setupOf([pc('A1'), foe('d1', 'dg-still', 'B1')], { ac: 40, knobs: { maxRounds: 4 } });
    let dodged = 0;
    const ds = makeDeciders(s).map((d): Decider => ({ name: d.name, decide(view, dp) { const i = d.decide(view, dp); if (dp.keyOf(i) === 'dodge') dodged++; return i; } }));
    runFight(s, 7, 0, ds, null);
    expect(dodged).toBe(0);
  });

  it('nor is one that adds nothing though attacks are coming: already Dodging (a bonus-action Dodge this turn), exposure real, no Dodge row', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    const me = w.u('pc1');
    me.condMask |= COND.dodging;
    w.begin(me);
    const r = w.decide(me, (k) => k === 'dodge' || k === 'pass');
    expect(r.rec.top.find((t) => t.key === 'pass')!.ev).toBeLessThan(0);
    expect(r.key).toBe('pass');
    expect(r.rec.top.some((t) => t.key === 'dodge')).toBe(false);
  });

  it('a monster\'s raw Dodge stands with nothing bought, whatever the order, and a PC side with progress 0 reads the same: progress weight 0 skips what the time buys', () => {
    const rowOf = (w: ReturnType<typeof scene>, who: Unit) => {
      w.begin(who);
      const r = w.decide(who, (k) => k === 'dodge' || k === 'pass').rec;
      const d = row(r, 'dodge');
      const raw = rawOf(w, who);
      expect(raw).toBeGreaterThan(0);
      expect(part(r, 'dodge', DODGE)).toBeCloseTo(raw, 6);
      expect(d.parts.filter((p) => !/^(Dodge|exposure)/.test(p.term))).toEqual([]);
      expect(d.ev).toBeCloseTo(raw + part(r, 'dodge', EXPOSURE)!, 6);
    };
    const alone = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')]);
    rowOf(alone, alone.u('b1'));
    // An ally's turn before the attacker: on the PC side it would show as bought; here no such line is read.
    const pair = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), foe('b2', 'dg-brute', 'B2')], { order: ['b1', 'b2', 'pc1'] });
    rowOf(pair, pair.u('b1'));
    const off = scene([pc('A1'), foe('b1', 'dg-brute', 'B1')], { w: { ...DEFAULT_WEIGHTS, pc: { ...DEFAULT_WEIGHTS.pc, progress: 0 } } });
    rowOf(off, off.u('pc1'));
  });
});

describe('G4: the no-progress streak is fight state (M7), and it decays the Dodge term', () => {
  /** The PC against the wall with an ally to buy it time before the wall acts: two swings pay the whole term, one (`plain`) only part. */
  const WALL = (plain = false) => scene([pc('A1'), foe('w1', 'dg-wall', 'B1'), plain ? pc('A2', 'pc2') : strong('A2')], { ac: 20, order: ['pc1', 'pc2', 'w1'] });
  const DK = (k: string) => k === 'dodge' || k === 'pass';
  const streak = (w: ReturnType<typeof scene>, me: Unit, run: number) => {
    Object.assign(me, { dodgeRun: run, quietTurns: run, hpSeen: w.cx.st.hpTick });
    w.begin(me);
  };

  it('from N Dodges running with no HP change the term halves per turn: full at 1, half at 2, a quarter at 3; Explain names the loss, and the row carries it', () => {
    expect(DEFAULT_WEIGHTS.dodgeStaleAfter).toBe(2);
    const w = WALL();
    const me = w.u('pc1');
    const term = (run: number) => {
      streak(w, me, run);
      return w.decide(me, DK).rec;
    };
    const base = term(0);
    const raw = part(base, 'dodge', DODGE)!;
    expect(raw).toBeGreaterThan(0);
    expect(part(base, 'dodge', ALLY)).toBeCloseTo(2 * SWORD_AT_WALL, 6);
    expect(part(base, 'dodge', PAST)).toBeUndefined(); // the time pays for all of it: what decays is the term itself
    expect(part(base, 'dodge', STALE)).toBeUndefined();
    expect(part(term(1), 'dodge', STALE)).toBeUndefined();
    const half = term(2);
    expect(part(half, 'dodge', STALE)).toBeCloseTo(-raw / 2, 6);
    expect(row(half, 'dodge').ev).toBeCloseTo(raw / 2 + part(half, 'dodge', EXPOSURE)!, 6);
    const quarter = term(3);
    expect(part(quarter, 'dodge', STALE)).toBeCloseTo((-raw * 3) / 4, 6);
    expect(row(quarter, 'dodge').ev).toBeCloseTo(raw / 4 + part(quarter, 'dodge', EXPOSURE)!, 6);
  });

  it('the decay applies to what is kept, not to the raw term: bought in part, half the part bought is left at a streak of 2', () => {
    const w = WALL(true);
    const me = w.u('pc1');
    streak(w, me, 2);
    const r = w.decide(me, DK).rec;
    const raw = part(r, 'dodge', DODGE)!;
    expect(SWORD_AT_WALL).toBeLessThan(raw);
    expect(part(r, 'dodge', PAST)).toBeCloseTo(SWORD_AT_WALL - raw, 6);
    expect(part(r, 'dodge', STALE)).toBeCloseTo(-SWORD_AT_WALL / 2, 6);
    expect(row(r, 'dodge').ev).toBeCloseTo(SWORD_AT_WALL / 2 + part(r, 'dodge', EXPOSURE)!, 6);
  });

  it('the decision flips: with the ally buying more than the strike is worth the Dodge beats its strike with no streak, and the strike beats it once the term has decayed', () => {
    const w = WALL();
    const me = w.u('pc1');
    const K = (k: string) => k === 'dodge' || k === 'attack:longsword>w1';
    w.begin(me);
    const fresh = w.decide(me, K);
    expect(fresh.key).toBe('dodge');
    expect(part(fresh.rec, 'dodge', ALLY)!).toBeGreaterThan(part(fresh.rec, 'attack:longsword>w1', /^this strike/)!);
    streak(w, me, 2);
    const stale = w.decide(me, K);
    expect(stale.key).toBe('attack:longsword>w1');
    expect(part(stale.rec, 'dodge', STALE)!).toBeLessThan(0);
  });

  it('an HP change on either side since my last turn end clears it, wherever it landed', () => {
    const w = WALL();
    const me = w.u('pc1');
    Object.assign(me, { dodgeRun: 4, quietTurns: 4, hpSeen: w.cx.st.hpTick });
    const q = w.cx.views[me.idx]!.queries;
    expect([q.noProgress(me.idx), q.quietTurns(me.idx), q.dodgeRun(me.idx)]).toEqual([4, 4, 4]);
    w.cx.st.hpTick++;
    expect([noProgressTurns(w.cx.st, me), quietTurnsNow(w.cx.st, me), q.dodgeRun(me.idx)]).toEqual([0, 0, 4]);
  });

  /** A fight where seats play their `script`ed key by turn when it is legal (else pass), logging what each decision sees. */
  const scripted = (units: U[], script: Record<string, string[]>, o: Opt = {}) => {
    const s = setupOf(units, o);
    const seen: { seat: string; run: number; quiet: number; np: number; tick: number; hpSeen: number; life: string }[] = [];
    const count = new Map<string, number>();
    const ds = makeDeciders(s).map((d): Decider => ({
      name: d.name,
      decide(view, dp) {
        if (dp.k !== 'turn') return d.decide(view, dp);
        const me = view.q.units[view.me]!;
        const pl = script[me.seat];
        if (!pl) return d.decide(view, dp);
        const k = `${me.seat}/${me.turns}`;
        const n = count.get(k) ?? 0;
        count.set(k, n + 1);
        if (n === 0) seen.push({ seat: me.seat, run: view.queries.dodgeRun(view.me), quiet: view.queries.quietTurns(view.me), np: view.queries.noProgress(view.me), tick: view.q.hpTick, hpSeen: me.hpSeen, life: me.life });
        const want = n === 0 ? pl[me.turns - 1] : undefined;
        let pass = 0;
        for (let i = 0; i < dp.legal.n; i++) {
          const key = dp.keyOf(i);
          if (want && key.startsWith(want)) return i;
          if (key === 'pass') pass = i;
        }
        return pass;
      },
    }));
    runFight(s, 7, 0, ds, null);
    return seen;
  };

  it('dodgeRun counts Dodged turns running, and a turn that isn\'t a Dodge clears it', () => {
    const seen = scripted([pc('A1'), foe('w1', 'dg-wall', 'B1')], { pc1: ['dodge', 'dodge', 'attack:longsword', 'dodge'], w1: [] }, { ac: 40, knobs: { maxRounds: 5 } }).filter((x) => x.seat === 'pc1');
    expect(seen.map((x) => x.run)).toEqual([0, 1, 2, 0, 1]);
  });

  it('a turn begun down leaves dodgeRun alone: the streak it had going is still there on the foe\'s next turn', () => {
    const s = setupOf([pc('A1'), foe('k1', 'dg-ko', 'B1'), pc('Z6', 'pc2')], { knobs: { maxRounds: 4 } }); // the other PC keeps the fight going
    const seen: { run: number; life: string }[] = [];
    const ds = makeDeciders(s).map((d): Decider => ({
      name: d.name,
      decide(view, dp) {
        if (dp.k !== 'turn') return d.decide(view, dp);
        const me = view.q.units[view.me]!;
        if (me.seat === 'pc1') {
          for (let k = 0; k < dp.legal.n; k++) if (dp.keyOf(k) === 'dodge') return k;
          return d.decide(view, dp);
        }
        if (me.seat === 'pc2') return d.decide(view, dp);
        const pc = view.q.units.find((x) => x.seat === 'pc1')!;
        seen.push({ run: pc.dodgeRun, life: pc.life });
        if (pc.life === 'up' && pc.dodgeRun >= 1 && me.b.action > 0) for (let k = 0; k < dp.legal.n; k++) if (dp.keyOf(k).startsWith('attack:claw>pc1')) return k;
        for (let k = 0; k < dp.legal.n; k++) if (dp.keyOf(k) === 'pass') return k;
        return 0;
      },
    }));
    runFight(s, 7, 0, ds, null);
    const down = seen.filter((x) => x.life !== 'up');
    expect(down.length).toBeGreaterThan(1); // the foe has looked at it across at least one of its turns begun down
    for (const x of down) expect(x.run).toBeGreaterThanOrEqual(1);
  });

  it('quietTurns counts turns with no HP change, a landed hit clears it, and hpSeen keeps up so the next quiet turn counts from there', () => {
    const seen = scripted([pc('A1'), foe('b1', 'dg-still', 'B1')], { pc1: ['pass', 'pass', 'attack:longsword', 'attack:longsword', 'attack:longsword', 'pass', 'pass', 'pass'], b1: [] }, { knobs: { maxRounds: 9 } }).filter((x) => x.seat === 'pc1');
    expect(seen.slice(0, 3).map((x) => x.quiet)).toEqual([0, 1, 2]);
    const k = seen.findIndex((x, i) => i > 0 && x.tick !== seen[i - 1]!.tick);
    expect(k).toBeGreaterThan(0); // +6 at AC 12, three swings on this seed: one lands
    expect(seen[k]!.quiet).toBe(0);
    expect(seen[k]!.hpSeen).toBe(seen[k]!.tick);
    const last = seen.at(-1)!;
    const prev = seen.at(-2)!;
    expect(last.tick).toBe(prev.tick); // the passes at the end change nothing
    expect(last.quiet).toBe(prev.quiet + 1); // and count up again from the reset
  });

  /** A live streak on pc1, then `act`; every kind of HP change ends what greedy reads. */
  const clears = (act: (w: ReturnType<typeof scene>, me: Unit, f: Unit) => void, o: Opt = {}) => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('A2', 'pc2')], o);
    const me = w.u('pc1');
    Object.assign(me, { dodgeRun: 3, quietTurns: 3, hpSeen: w.cx.st.hpTick });
    expect(noProgressTurns(w.cx.st, me)).toBe(3);
    act(w, me, w.u('b1'));
    return noProgressTurns(w.cx.st, me);
  };
  const hurt = (w: ReturnType<typeof scene>, f: Unit, t: Unit, n: number) => dealDamage(w.cx, { unit: f.idx, via: 'test:dg-brute' as never, slot: -1, cause: -1 }, f.tpl.attacks[0]!.damage, Int32Array.of(n), () => true, false, [t.idx]);

  it('every HP change clears the streak: damage', () => {
    expect(clears((w, me, f) => hurt(w, f, me, 5))).toBe(0);
  });
  it('damage taken only by temporary HP is an HP change too', () => {
    expect(clears((w, me, f) => {
      me.tempHp = 10;
      hurt(w, f, me, 5);
      expect(me.hp).toBe(me.hpMax);
    })).toBe(0);
  });
  it('a kill from above 0 HP (massive damage, or a foe with no death saves)', () => {
    expect(clears((w, _me, f) => kill(w.cx, f, 'zeroHp', -1))).toBe(0);
  });
  it('a revive from 0', () => {
    expect(clears((w) => {
      const a = w.u('pc2');
      Object.assign(a, { hp: 0, life: 'down' });
      const before = w.cx.st.hpTick;
      revive(w.cx, a, 5, -1);
      expect(w.cx.st.hpTick).toBe(before + 1);
    })).toBe(0);
  });
  it('a heal through a spell', () => {
    expect(clears((w, me) => {
      const a = w.u('pc2');
      a.hp = 10;
      w.begin(me);
      const list = listOptions(w.cx, me, takeList(w.cx));
      let cast: Legal | null = null;
      for (let i = 0; i < list.n; i++) if (legalKey(w.cx.st, me.idx, list.items[i]!).startsWith('cast:cure-wounds')) cast = copyLegal(list.items[i]!, newLegal());
      releaseList(w.cx, list);
      expect(cast).not.toBeNull();
      resolveOption(w.cx, me, cast!, -1);
      expect(a.hp).toBeGreaterThan(10);
    }, { cure: true })).toBe(0);
  });

  it('a bonus-action Dodge (Patient Defense\'s shape) takes the decay too: its value falls with the streak, by the same factor', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-wall', 'B1')], { ac: 20, feats: ['test:dg-bonus-dodge'] });
    const me = w.u('pc1');
    const d = w.ds[me.idx]! as unknown as { dodgeValue(st: unknown, me: Unit, cell: number): number };
    w.begin(me);
    w.decide(me, (k) => k === 'pass');
    const fresh = d.dodgeValue(w.cx.st, me, me.cell);
    expect(fresh).toBeGreaterThan(0);
    Object.assign(me, { dodgeRun: 3, quietTurns: 3, hpSeen: w.cx.st.hpTick });
    w.begin(me);
    w.decide(me, (k) => k === 'pass');
    expect(d.dodgeValue(w.cx.st, me, me.cell)).toBeCloseTo(fresh * DEFAULT_WEIGHTS.dodgeDecay * DEFAULT_WEIGHTS.dodgeDecay, 6);
  });

  /** A run whose PC Dodges with the streak up at least 2 before it strikes, with the decisions played. */
  function flipRun() {
    const s = setupOf([pc('A1'), strong('A2'), foe('w1', 'dg-wall', 'B1')], { ac: 20, knobs: { maxRounds: 12 } }); // the ally between me and the wall buys the time: a term to decay
    for (let run = 0; run < 400; run++) {
      const entries: { seat: string; key: string; at: number }[] = [];
      const streak: number[] = [];
      const ds = makeDeciders(s).map((d): Decider => ({
        name: d.name,
        decide(view, dp) {
          const i = d.decide(view, dp);
          if (dp.k === 'turn' && view.me === 0) streak[entries.length] = view.queries.noProgress(0);
          entries.push({ seat: view.q.units[dp.who]!.seat, key: dp.keyOf(i), at: dp.at });
          return i;
        },
      }));
      const res = runFight(s, 11, run, ds, null);
      const at = streak.findIndex((x) => x >= 2);
      if (at < 0) continue;
      const flips = entries.slice(at).some((e) => e.seat === 'pc1' && e.key.startsWith('attack:'));
      if (flips) return { s, run, entries, at, res };
    }
    throw new Error('no run with a streak of 2 and a strike after it');
  }

  it('a journal resumed mid-streak decides the same as the uninterrupted fight (M7): the state, not the decider, carries it', () => {
    const f = flipRun();
    // Hand back to fresh AI deciders at the first decision with the streak at 2 or more.
    const prefix = f.entries.slice(0, f.at);
    const after: string[] = [];
    const ds = makeDeciders(f.s, prefix).map((d): Decider => ({
      name: d.name,
      decide(view, dp) {
        const i = d.decide(view, dp);
        after.push(`${view.q.units[dp.who]!.seat} ${dp.keyOf(i)} @${dp.at}`);
        return i;
      },
    }));
    const res = runFight(f.s, 11, f.run, ds, null);
    expect(after).toEqual(f.entries.map((e) => `${e.seat} ${e.key} @${e.at}`));
    expect(res.stateHash).toBe(f.res.stateHash);
    // The resumed part really does read the streak: with the Dodge never decaying it plays differently.
    const noDecay = f.s.seats.map(() => new GreedyDecider({ ...DEFAULT_WEIGHTS, dodgeStaleAfter: 1e9 }));
    const res2 = runFight(f.s, 11, f.run, noDecay, null);
    expect(res2.stateHash).not.toBe(f.res.stateHash);
  });

  it('stateHash carries a live streak (a decider reads it) and nothing else of it: no streak hashes as a state without the fields would', () => {
    const w = WALL();
    const me = w.u('pc1');
    const h0 = stateHash(w.cx.st);
    Object.assign(me, { quietTurns: 3, dodgeRun: 0, hpSeen: w.cx.st.hpTick });
    expect(stateHash(w.cx.st)).toBe(h0); // quiet but no Dodges
    Object.assign(me, { dodgeRun: 2 });
    expect(stateHash(w.cx.st)).not.toBe(h0);
    w.cx.st.hpTick++;
    expect(stateHash(w.cx.st)).toBe(h0); // an HP change cleared what a decider would read
  });
});

describe('stalemate by cause (coverage.md "Frozen thresholds", G4, m10)', () => {
  const end = (w: ReturnType<typeof scene>) => (w.cx.st.outcome = { k: 'stalemate', round: 10, tpk: false });

  it('reads the state in the frozen order: dodge-loop > downed-unrescued > no-damage > round-cap; a win has none', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')], { knobs: { maxRounds: 10 } });
    expect(stalemateCauseOf(w.cx.st)).toBeUndefined();
    w.cx.st.outcome = { k: 'win', round: 3, tpk: false };
    expect(stalemateCauseOf(w.cx.st)).toBeUndefined();
    end(w);
    expect(stalemateCauseOf(w.cx.st)).toBe('no-damage');
    const c = w.cx.st.ctr;
    const S = c.layout.sources.length;
    c.dmgRolled[7 * S] = 5;
    expect(stalemateCauseOf(w.cx.st)).toBe('no-damage'); // round 7 of 10: outside the last K = 3
    c.dmgRolled[8 * S] = 5;
    expect(stalemateCauseOf(w.cx.st)).toBe('round-cap');
    Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
    expect(stalemateCauseOf(w.cx.st)).toBe('downed-unrescued');
    w.u('pc2').life = 'stable';
    expect(stalemateCauseOf(w.cx.st)).toBe('round-cap'); // stable isn't left dying
    w.u('pc2').life = 'down';
    w.u('pc1').dodgeRun = 3;
    expect(stalemateCauseOf(w.cx.st)).toBe('dodge-loop');
  });

  it('a dodge streak left on a dead or downed PC isn\'t the cause (ai-logic-6): dead with damage still landing is round-cap; downed is downed-unrescued; a stable one falls past both', () => {
    const w = scene([pc('A1'), foe('b1', 'dg-brute', 'B1'), pc('D1', 'pc2')], { knobs: { maxRounds: 10 } });
    end(w);
    const c = w.cx.st.ctr;
    c.dmgRolled[9 * c.layout.sources.length] = 5;
    const a = w.u('pc2');
    a.dodgeRun = 4;
    Object.assign(a, { hp: 0, life: 'dead' });
    expect(stalemateCauseOf(w.cx.st)).toBe('round-cap');
    a.life = 'down';
    expect(stalemateCauseOf(w.cx.st)).toBe('downed-unrescued');
    a.life = 'stable';
    expect(stalemateCauseOf(w.cx.st)).toBe('round-cap');
    a.dodgeRun = 0;
    w.u('pc1').dodgeRun = 3;
    a.life = 'down';
    expect(stalemateCauseOf(w.cx.st)).toBe('dodge-loop'); // the PC still up and Dodging comes first
  });

  const armOf = (s: FightSetup): ArmSpec => ({ label: 'greedy', setup: s, policy: null }) as unknown as ArmSpec;
  const meta = { seed: 3, adaptive: false, hitCap: false, checkpoint: 0 } as never;
  const run = (s: FightSetup, n: number, chunk: number) => {
    const arms = [armOf(s)];
    const m = newMerged(arms, chunk);
    for (let k = 0; k * chunk < n; k++) mergeInto(m, runChunk(arms, 3, k, n, chunk));
    return { arms, m };
  };

  it('the report prints the family when a fight stalemated, and its counts survive merging in any chunk size', () => {
    const s = setupOf([pc('A1'), foe('w1', 'dg-wall', 'B1')], { ac: 20, knobs: { maxRounds: 2 } });
    const a = run(s, 12, 12);
    const b = run(s, 12, 5);
    const by = a.m.arms[0]!;
    expect(by.stalemate).toBeGreaterThan(0);
    expect(by.stalemateBy!.length).toBe(STALEMATE_CAUSES.length);
    expect(by.stalemateBy!.reduce((x, y) => x + y, 0)).toBe(by.stalemate);
    expect(b.m.arms[0]!.stalemateBy).toEqual(by.stalemateBy);
    const text = renderReport(a.arms, a.m, meta, computeReport(a.arms, a.m, meta)).join('\n');
    expect(text).toMatch(/stalemates by cause: /);
  });

  it('a report with no stalemate stays as it was: no line, no field (C3)', () => {
    const s = setupOf([pc('A1'), foe('b1', 'dg-brute', 'B1')], { knobs: { maxRounds: 20 } });
    const a = run(s, 6, 6);
    const acc = a.m.arms[0]!;
    if (acc.stalemate !== 0) throw new Error('this fight should always finish');
    expect('stalemateBy' in acc).toBe(false);
    expect(renderReport(a.arms, a.m, meta, computeReport(a.arms, a.m, meta)).join('\n')).not.toMatch(/stalemates by cause/);
  });
});
