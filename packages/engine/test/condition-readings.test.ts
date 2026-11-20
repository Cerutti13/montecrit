// Coverage step 7.4: Unconscious as content (srd-raw.txt:34523-34535), Sleep's second stage, the
// compound condition (also, speed), dropHeld, targetAdv, and the SRD readings: Sleep, Color Spray,
// Grease, Hypnotic Pattern, Fear and Charm Person. Other fixtures are synthetic (test: ids).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { saveKey } from '../src/content/rollkeys.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeFold, takeList } from '../src/sim/context.ts';
import { autoCritWithin5 } from '../src/sim/conditions.ts';
import { saveSpec } from '../src/sim/d20.ts';
import { knockOut, revive } from '../src/sim/damage.ts';
import { endFx } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { speedOf } from '../src/sim/stats.ts';
import { COND, has, type Unit } from '../src/sim/state.ts';

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

/** A spell whose program is a target step and `steps`: no save, so the result never depends on a die. */
const SURE = (id: string, level: number, steps: string, extra = '') => `kind: spell
id: test:${id}
name: ${id}
source: synthetic test fixture
level: ${level}
castingTime: action
range: 60
components: { v: true, s: true }
duration: { minutes: 1 }
${extra}do:
  - target: { range: 60, self: no }
${steps}
`;
const TWO_STAGE = (id: string, next: string) => `kind: spell
id: test:${id}
name: ${id}
source: synthetic test fixture
level: 1
castingTime: action
range: 60
components: { v: true, s: true }
concentration: true
duration: { minutes: 1 }
area: z
effects:
  - id: z
    name: ${id}
    zone: { shape: sphere, radius: 5 }
    on:
      - when: [appear]
        do:
          - save:
              ability: wis
              onFail:
                - condition:
                    id: incapacitated
                    until: { until: endOfNextTurn, of: bearer }
                    endsOnDamage: true
                    save: { ability: wis, at: turnEnd${next} }
do: [{ apply: { effect: z, to: point } }]
`;
const CHARMY = (id: string, adv: string) => SURE(id, 1, `  - save:\n      ability: wis\n${adv}      onFail:\n        - condition: { id: charmed, until: { minutes: 1 } }`);
const FIXTURES: Record<string, string> = {
  'cr-knock': SURE('cr-knock', 1, '  - condition: { id: unconscious, until: { minutes: 1 } }'),
  'cr-knock-wake': SURE('cr-knock-wake', 1, '  - condition: { id: unconscious, until: { minutes: 1 }, endsOnDamage: true }'),
  'cr-compound': SURE('cr-compound', 1, '  - condition: { id: charmed, until: { minutes: 1 }, also: [incapacitated], speed: zero }'),
  'cr-burn': SURE('cr-burn', 1, "  - damage: [{ roll: '1', type: fire }]"),
  'cr-dexsave': SURE('cr-dexsave', 1, "  - save: { ability: dex, damage: [{ roll: '1', type: fire }] }"),
  'cr-drop': SURE('cr-drop', 1, '  - condition: { id: frightened, until: { minutes: 1 }, dropHeld: true }'),
  'cr-fright': SURE('cr-fright', 1, '  - condition: { id: frightened, until: { minutes: 1 } }'),
  'cr-one-stage': TWO_STAGE('cr-one-stage', ''),
  'cr-two-stage': TWO_STAGE('cr-two-stage', ', onFail: [{ condition: { id: unconscious, until: parent, endsOnDamage: true } }]'),
  'cr-charm-plain': CHARMY('cr-charm-plain', ''),
  'cr-charm-adv': CHARMY('cr-charm-adv', '      targetAdv: true\n'),
  'cr-brave': `kind: spell
id: test:cr-brave
name: cr-brave
source: synthetic test fixture
level: 1
castingTime: action
range: self
components: { v: true, s: true }
duration: { minutes: 1 }
effects:
  - id: brave
    name: cr-brave
    duration: { minutes: 1 }
    immune: [frightened]
do: [{ apply: { effect: brave, to: self } }]
`,
};
const SRD = ['sleep', 'color-spray', 'grease', 'hypnotic-pattern', 'fear', 'charm-person', 'faerie-fire'];
const PC = (id: string, abilities: string, prepared: readonly string[]) => `kind: pc
id: test:${id}
name: ${id}
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { ${abilities} }
hpMax: 44
ac: 14
armor: none
saveProficiencies: [int]
items:
  - { id: wand, name: Wand, kind: focus, focusFor: [wizard] }
hands: [wand, null]
slots: [9, 3, 2]
casting:
  - { source: wizard, ability: int, list: wizard, prepared: [${prepared.join(', ')}] }
`;
const EVERY = [...Object.keys(FIXTURES).map((k) => `test:${k}`), ...SRD.map((s) => `srd:${s}`)];
const MONSTER = (id: string, abilities: string, more = '', atk = "toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }]") => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 5
hp: { average: 200, formula: '200' }
speed: { walk: 30 }
initiative: { mod: 0, score: 5 }
abilities: { ${abilities} }
${more}attacks:
  - { id: claw, name: Claw, kind: melee, ${atk} }
`;
const BAD = 'str: 1, dex: 1, con: 1, int: 10, wis: 1, cha: 10';
const GOOD = 'str: 30, dex: 30, con: 30, int: 10, wis: 30, cha: 10';
const MID = 'str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10';
const BRUTE = "toHit: 8, damage: [{ roll: '3d8', type: slashing, avg: 13 }]";
const ALL = {
  ...Object.fromEntries(Object.entries(FIXTURES).map(([k, v]) => [`packs/test/spells/${k}.yaml`, v])),
  'packs/test/pcs/cr-pc.yaml': PC('cr-pc', 'str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8', EVERY),
  'packs/test/pcs/cr-held.yaml': PC('cr-held', BAD, ['test:cr-brave']),
  'packs/test/pcs/cr-held-sure.yaml': PC('cr-held-sure', GOOD, ['test:cr-brave']),
  'packs/test/pcs/cr-charmer.yaml': PC('cr-charmer', 'str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8', ['test:cr-charm-plain', 'test:cr-charm-adv']),
  'packs/test/pcs/cr-sleeper.yaml': PC('cr-sleeper', 'str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8', ['test:cr-one-stage', 'test:cr-two-stage']),
  'packs/test/monsters/cr-foe.yaml': MONSTER('cr-foe', BAD),
  'packs/test/monsters/cr-brute.yaml': MONSTER('cr-brute', MID, '', BRUTE),
  'packs/test/monsters/cr-brute-bad.yaml': MONSTER('cr-brute-bad', BAD, '', BRUTE),
  'packs/test/monsters/cr-brute-no-sleep.yaml': MONSTER('cr-brute-no-sleep', BAD, 'conditionImmune: [unconscious]\n', BRUTE),
  'packs/test/monsters/cr-brute-no-charm.yaml': MONSTER('cr-brute-no-charm', BAD, 'conditionImmune: [charmed]\n', BRUTE),
  'packs/test/monsters/cr-archer.yaml': MONSTER('cr-archer', MID, '', "toHit: 8, range: [60, 60], damage: [{ roll: '3d8', type: piercing, avg: 13 }]").replace('kind: melee', 'kind: ranged').replace('walk: 30', 'walk: 0'),
  'packs/test/monsters/cr-sure.yaml': MONSTER('cr-sure', GOOD),
  'packs/test/monsters/cr-no-charm.yaml': MONSTER('cr-no-charm', BAD, 'conditionImmune: [charmed]\n'),
  'packs/test/monsters/cr-no-sleep.yaml': MONSTER('cr-no-sleep', BAD, 'conditionImmune: [unconscious]\n'),
  'packs/test/monsters/cr-fireproof.yaml': MONSTER('cr-fireproof', BAD, 'immune: [fire]\n'),
};
const LOADED = loadContent([...REPO, ...Object.entries(ALL).map(([path, text]) => ({ path, text }))]);
if (!LOADED.content) throw new Error(LOADED.errors.map(formatDiag).join('\n'));
const CONTENT = LOADED.content;

type Seat = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const pc = (at: string, seat = 'pc', use = 'cr-pc'): Seat => ({ seat, team: 'party', use: `test:${use}`, at });
const guard = (at: string, seat = 'guard'): Seat => ({ seat, team: 'party', use: 'srd:guard', at });
const foe = (at: string, seat = 'foe', use = 'cr-foe'): Seat => ({ seat, team: 'enemies', use: `test:${use}`, at });
const heldFoe = (at: string, use = 'cr-held', seat = 'foe'): Seat => ({ seat, team: 'enemies', use: `test:${use}`, at });

type Opt = { flags?: Record<string, unknown>; rounds?: number; seed?: number };
function setup(units: Seat[], o: Opt = {}) {
  const doc = { kind: 'scenario', id: 'cr', name: 'Cr', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 10 }, flags: { initiativeMode: 'static', ...o.flags }, knobs: { downEnds: false, maxRounds: o.rounds ?? 2 }, units: units.map((u) => ({ ...u, decider: 'greedy' })) };
  const r = resolveScenario(doc, 'cr.yaml', CONTENT);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Takes the next key of its script when it's legal; otherwise passes a turn, or the first item of anything else. */
class Keys implements Decider {
  readonly name = 'keys';
  private readonly queue: string[];
  constructor(queue: readonly string[] = []) {
    this.queue = [...queue];
  }
  decide(_v: unknown, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    const next = this.queue[0];
    const i = next === undefined ? -1 : keys.findIndex((k) => k === next || k.startsWith(`${next}#`) || k.startsWith(`${next}/`));
    if (i >= 0) {
      this.queue.shift();
      return i;
    }
    const pass = keys.indexOf('pass');
    return pass >= 0 ? pass : 0;
  }
}

function fight(units: Seat[], scripts: Record<string, string[]>, o: Opt = {}) {
  const s = setup(units, o);
  const ds = s.seats.map((x) => new Keys(scripts[x.seat] ?? []));
  const sink = new ArraySink();
  const res = runFight(s, o.seed ?? 1, 0, ds as unknown as Parameters<typeof runFight>[3], sink);
  const events = sink.events as GameEvent[];
  const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
  const saves = (seat: string) => events.filter((e): e is Extract<GameEvent, { k: 'save' }> => e.k === 'save' && e.who === idx(seat));
  const conds = (seat: string) => events.filter((e): e is Extract<GameEvent, { k: 'cond' }> => e.k === 'cond' && e.who === idx(seat));
  /** The conditions a fold of its `cond` events leaves on it. */
  const left = (seat: string) => {
    const on = new Set<string>();
    for (const c of conds(seat)) if (c.on) on.add(c.cond);
    else on.delete(c.cond);
    return [...on].sort();
  };
  return { s, res, events, idx, saves, conds, left };
}

/** The first seed whose fight passes `test`. */
function seeded(run: (seed: number) => ReturnType<typeof fight>, test: (f: ReturnType<typeof fight>) => boolean) {
  for (let seed = 1; seed < 600; seed++) {
    const f = run(seed);
    if (test(f)) return f;
  }
  throw new Error('no seed fits');
}

/** A constructed turn: each seat's script, or the AI. */
function scene(units: Seat[], o: Opt = {}, scripts: Record<string, string[]> = {}) {
  const s = setup(units, o);
  const sink = new ArraySink();
  const ds = s.seats.map((x) => (scripts[x.seat] ? new Keys(scripts[x.seat]!) : new GreedyDecider())) as unknown as Parameters<typeof createContext>[3];
  const cx = createContext(s, o.seed ?? 1, 0, ds, sink);
  applyPassives(cx, -1);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  const cast = (who: Unit, key: string) => {
    begin(who);
    const list = listOptions(cx, who, takeList(cx));
    for (let i = 0; i < list.n; i++) {
      if (legalKey(cx.st, who.idx, list.items[i]!) !== key) continue;
      const item = copyLegal(list.items[i]!, newLegal());
      releaseList(cx, list);
      resolveOption(cx, who, item, -1);
      return;
    }
    throw new Error(`no option ${key}`);
  };
  /** The live effect `t` bears that imposes `bit`. */
  const fxOf = (t: Unit, bit: number): number => t.borne.find((id) => (cx.st.units[cx.st.fx[id]!.owner]!.tpl.effects[cx.st.fx[id]!.tpl]!.cond ?? 0) & bit)!;
  return { s, cx, u, cast, fxOf, sink, begin };
}

const bits = (u: Unit) => ({ unconscious: has(u, COND.unconscious), incapacitated: has(u, COND.incapacitated), prone: has(u, COND.prone) });
const key = (ability: number) => saveKey(ability);
const specOf = (t: ReturnType<typeof scene>, u: Unit, ability: number, targetAdv?: true) => {
  const fd = takeFold(t.cx);
  return saveSpec(t.cx.st, u, key(ability), 15, fd.adv, fd.dis, fd.f, targetAdv);
};

/**
 * The AI's first turn with `spell` as all it knows, against a foe at `at` (out of its reach by a little,
 * so the cast scores above walking): that cast's option in Explain, if it made the top 3.
 */
function firstTurn(spell: string, use: string, at = 'H3', extra: readonly Seat[] = []) {
  const loaded = loadContent([...REPO, ...Object.entries(ALL).map(([path, text]) => ({ path, text })), { path: 'packs/test/pcs/cr-one.yaml', text: PC('cr-one', 'str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8', [spell]) }]);
  if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
  const doc = { kind: 'scenario', id: 'cr', name: 'Cr', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 10 }, flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: 1 }, units: [{ seat: 'pc', team: 'party', use: 'test:cr-one', at: 'D3', decider: 'greedy' }, { seat: 'foe', team: 'enemies', use: `test:${use}`, at, decider: 'greedy' }, ...extra.map((x) => ({ ...x, decider: 'greedy' }))] };
  const r = resolveScenario(doc, 'cr.yaml', loaded.content);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  const ds = r.setup.seats.map(() => new GreedyDecider());
  const records: ExplainRecord[] = [];
  ds[r.setup.seats.findIndex((x) => x.seat === 'pc')]!.explainTo((x) => records.push(x));
  runFight(r.setup, 1, 0, ds, new ArraySink());
  const local = spell.slice(spell.indexOf(':') + 1);
  return records[0]!.top.find((o) => o.key.startsWith(`cast:${local}`));
}

describe('Unconscious as content (srd-raw.txt:34523-34535)', () => {
  const asleep = (over: Seat = foe('F3')) => {
    const t = scene([pc('D3'), over], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:cr-knock@1');
    return t;
  };

  it('Inert: Incapacitated and Prone too (34525-34526)', () => {
    expect(bits(asleep().u('foe'))).toEqual({ unconscious: true, incapacitated: true, prone: true });
  });

  it('Inert: it breaks Concentration (Incapacitated, 33657)', () => {
    const t = scene([pc('D3'), { seat: 'other', team: 'enemies', use: 'test:cr-pc', at: 'F3' }], {}, { pc: [], other: ['place:J6'] });
    t.cast(t.u('other'), 'cast:cr-two-stage@1');
    expect(t.u('other').conc).toBeGreaterThanOrEqual(0);
    t.cast(t.u('pc'), 'cast:cr-knock@1');
    expect(has(t.u('other'), COND.unconscious)).toBe(true);
    expect(t.u('other').conc).toBe(-1);
  });

  it('Inert: "you drop whatever you\'re holding" (34526)', () => {
    const t = asleep(heldFoe('F3'));
    const f = t.u('foe');
    expect(f.hands[0]).toBeLessThan(0);
    expect(f.dropped[0]).toBe(f.cell);
  });

  it('Speed 0, whatever a stat adds (34528)', () => {
    const t = asleep();
    expect(speedOf(t.cx.st, t.u('foe'))).toBe(0);
  });

  it('attack rolls against it have Advantage; a hit from within 5 ft is a Critical Hit, one from further isn\'t (34529-34535)', () => {
    const go = (at: string, seed: number) =>
      fight([pc('A1'), guard(at), foe('F3')], { pc: ['cast:cr-knock@1'], guard: [at === 'E3' ? 'attack:spear>foe' : 'attack:spear-thrown>foe'] }, { rounds: 1, seed });
    const attacks = (f: ReturnType<typeof fight>) => f.events.filter((e): e is Extract<GameEvent, { k: 'attack' }> => e.k === 'attack');
    const near = seeded((seed) => go('E3', seed), (f) => attacks(f)[0]?.hit === true && attacks(f)[0]?.natural! < 20);
    expect(attacks(near)[0]!.adv).toBe('adv');
    expect(attacks(near)[0]!.advSrc).toContain('core:target-unconscious');
    expect(attacks(near)[0]!.crit).toBe(true);
    const far = seeded((seed) => go('I3', seed), (f) => attacks(f)[0]?.hit === true && attacks(f)[0]?.natural! < 20);
    expect(attacks(far)[0]!.crit).toBe(false);
  });

  it('STR and DEX saves fail automatically; the others roll (34531-34532)', () => {
    const t = asleep(foe('F3', 'foe', 'cr-sure'));
    const u = t.u('foe');
    expect(specOf(t, u, 0).autoFail).toBe(true);
    expect(specOf(t, u, 1).autoFail).toBe(true);
    expect(specOf(t, u, 2).autoFail).toBeUndefined();
    expect(specOf(t, u, 4).autoFail).toBeUndefined();
    expect(autoCritWithin5(u)).toBe(true);
  });

  it('"When this condition ends, you remain Prone" (34527): its own instances end, the Prone doesn\'t', () => {
    const t = asleep();
    const u = t.u('foe');
    endFx(t.cx, t.fxOf(u, COND.unconscious), 'parent', -1);
    expect(bits(u)).toEqual({ unconscious: false, incapacitated: false, prone: true });
    expect(speedOf(t.cx.st, u)).toBe(30);
  });

  it('a creature immune to Unconscious gets none of it, no Incapacitated and no Prone', () => {
    const t = asleep(foe('F3', 'foe', 'cr-no-sleep'));
    expect(bits(t.u('foe'))).toEqual({ unconscious: false, incapacitated: false, prone: false });
    expect(t.u('foe').borne).toHaveLength(0);
  });

  it('asleep, then downed, then healed: the sleep is still there, and only the sleep', () => {
    const t = asleep();
    const u = t.u('foe');
    u.hp = 0;
    knockOut(t.cx, u, -1);
    expect(u.life).toBe('down');
    u.hp = 0;
    revive(t.cx, u, 5, -1);
    expect(u.life).toBe('up');
    expect(bits(u)).toEqual({ unconscious: true, incapacitated: true, prone: true });
    endFx(t.cx, t.fxOf(u, COND.unconscious), 'parent', -1);
    expect(bits(u)).toEqual({ unconscious: false, incapacitated: false, prone: true });
  });

  it('downed, then asleep, then the sleep ends: `core:downed` keeps its own instances', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: [], foe: [] });
    const u = t.u('foe');
    u.hp = 0;
    knockOut(t.cx, u, -1);
    t.cast(t.u('pc'), 'cast:cr-knock@1');
    endFx(t.cx, t.fxOf(u, COND.unconscious), 'parent', -1);
    expect(u.life).toBe('down');
    expect(bits(u)).toEqual({ unconscious: true, incapacitated: true, prone: true });
    revive(t.cx, u, 5, -1);
    expect(bits(u)).toEqual({ unconscious: false, incapacitated: false, prone: true });
  });

  it('asleep, then damage ends it, still Prone (endsOnDamage)', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:cr-knock-wake@1');
    const u = t.u('foe');
    expect(bits(u).unconscious).toBe(true);
    t.cast(t.u('pc'), 'cast:cr-burn@1');
    expect(bits(u)).toEqual({ unconscious: false, incapacitated: false, prone: true });
  });

  it('asleep, and damage that does nothing (0 after Immunity) leaves it asleep', () => {
    const t = scene([pc('D3'), foe('F3', 'foe', 'cr-fireproof')], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:cr-knock-wake@1');
    t.cast(t.u('pc'), 'cast:cr-burn@1');
    expect(bits(t.u('foe')).unconscious).toBe(true);
  });

  it('downed creatures\' saves and hands are as before: a drop on nothing is no event', () => {
    const f = fight([pc('D3'), foe('F3')], { pc: ['cast:cr-knock@1'] }, { rounds: 1 });
    expect(f.events.some((e) => e.k === 'item')).toBe(false);
    expect(f.left('foe')).toEqual(['core:incapacitated', 'core:prone', 'core:unconscious']);
  });

  it('the schema: Unconscious may carry until and endsOnDamage; Prone still takes none, and neither fits in `also`', () => {
    const load = (cond: string) => loadContent([...REPO, { path: 'packs/test/spells/x.yaml', text: SURE('x', 1, `  - condition: ${cond}`) }]);
    expect(load('{ id: unconscious, until: { minutes: 1 }, endsOnDamage: true }').errors).toHaveLength(0);
    expect(load('{ id: prone, dropHeld: true }').errors.length).toBeGreaterThan(0);
    expect(load('{ id: prone, speed: zero }').errors.length).toBeGreaterThan(0);
    expect(load('{ id: prone, also: [incapacitated] }').errors.length).toBeGreaterThan(0);
    expect(load('{ id: charmed, until: { minutes: 1 }, also: [prone] }').errors.length).toBeGreaterThan(0);
    expect(load('{ id: charmed, until: { minutes: 1 }, also: [unconscious] }').errors.length).toBeGreaterThan(0);
  });

  it('a next stage that lasts until: parent needs a parent to end with: a compile error, not a stage that never ends', () => {
    const r = loadContent([...REPO, { path: 'packs/test/spells/x.yaml', text: SURE('x', 1, '  - condition: { id: incapacitated, until: { rounds: 1 }, save: { ability: wis, at: turnEnd, onFail: [{ condition: { id: unconscious, until: parent } }] } }') }]);
    expect(r.errors.map(formatDiag).join('\n')).toContain('until: parent');
  });
});

describe('Sleep\'s second stage (srd-raw.txt:30828-30834)', () => {
  const sleep = (seed: number, scripts: Record<string, string[]> = {}, rounds = 1, units: Seat[] = [pc('D3'), foe('F3')]) => fight(units, { pc: ['cast:sleep@1', 'place:F3'], ...scripts }, { rounds, seed });
  const failedTwice = (f: ReturnType<typeof fight>) => f.saves('foe').length >= 2 && !f.saves('foe')[0]!.ok && !f.saves('foe')[1]!.ok;

  it('a failed first save: Incapacitated, not yet Unconscious, until its turn ends', () => {
    const f = seeded((seed) => sleep(seed), failedTwice);
    const seqOf = (cond: string) => f.conds('foe').find((c) => c.cond === cond && c.on)!.seq;
    const second = f.saves('foe')[1]!;
    expect(seqOf('core:incapacitated')).toBeLessThan(second.seq);
    expect(seqOf('core:unconscious')).toBeGreaterThan(second.seq);
  });

  it('a second failure: Unconscious and Prone, and still asleep after the first stage expires', () => {
    const f = seeded((seed) => sleep(seed), failedTwice);
    expect(f.saves('foe')[1]!.purpose).toBe('condSave');
    expect(f.left('foe')).toEqual(['core:incapacitated', 'core:prone', 'core:unconscious']);
    const expired = f.events.find((e) => e.k === 'fxEnd' && (e as { why?: string }).why === 'expired' && (e as { bearer?: number }).bearer === f.idx('foe'));
    expect(expired).toBeDefined();
    // Nothing went off when the first stage expired: the second stage holds Incapacitated too.
    expect(f.conds('foe').filter((c) => !c.on)).toHaveLength(0);
  });

  it('a second success: awake when its turn ends, no Unconscious, no Prone', () => {
    const f = seeded((seed) => sleep(seed), (x) => x.saves('foe').length >= 2 && !x.saves('foe')[0]!.ok && x.saves('foe')[1]!.ok);
    expect(f.left('foe')).toEqual([]);
    expect(f.conds('foe').some((c) => c.cond === 'core:unconscious')).toBe(false);
    expect(f.conds('foe').some((c) => c.cond === 'core:prone')).toBe(false);
  });

  it('a first success: nothing at all, and no repeat save', () => {
    const f = seeded((seed) => sleep(seed, {}, 1, [pc('D3'), foe('F3', 'foe', 'cr-sure')]), (x) => x.saves('foe')[0]?.ok === true);
    expect(f.saves('foe')).toHaveLength(1);
    expect(f.conds('foe')).toHaveLength(0);
  });

  it('it ends with the Concentration: Unconscious and Incapacitated off, Prone stays', () => {
    const f = seeded((seed) => fight([pc('D3'), foe('F3')], { pc: ['cast:sleep@1', 'place:F3', 'cast:faerie-fire@1', 'place:M8'] }, { rounds: 2, seed }), failedTwice);
    const off = f.conds('foe').filter((c) => !c.on).map((c) => c.cond).sort();
    expect(off).toEqual(['core:incapacitated', 'core:unconscious']);
    expect(f.left('foe')).toEqual(['core:prone']);
  });

  it('it ends on damage at either stage (30833-30834)', () => {
    // The first stage: damage on the caster's own turn isn't possible with one action, so a Guard deals it before the foe's turn.
    const units = [pc('D3'), guard('E3'), foe('F3')];
    const f1 = seeded((seed) => fight(units, { pc: ['cast:sleep@1', 'place:F3'], guard: ['attack:spear>foe'] }, { rounds: 1, seed }), (x) => x.saves('foe')[0]?.ok === false && x.events.some((e) => e.k === 'damage' && (e as { tgt?: number }).tgt === x.idx('foe') && (e as { dealt?: number }).dealt! > 0));
    expect(f1.saves('foe')).toHaveLength(1);
    expect(f1.left('foe')).toEqual([]);
    // The second stage: a round later, the Guard's hit wakes it; Prone stays.
    const f2 = seeded((seed) => fight(units, { pc: ['cast:sleep@1', 'place:F3'], guard: ['pass', 'attack:spear>foe'] }, { rounds: 2, seed }), (x) => failedTwice(x) && x.events.some((e) => e.k === 'damage' && (e as { tgt?: number }).tgt === x.idx('foe') && (e as { dealt?: number }).dealt! > 0));
    expect(f2.left('foe')).toEqual(['core:prone']);
  });

  it('a creature immune to Unconscious stays Incapacitated for the first stage only', () => {
    const f = seeded((seed) => sleep(seed, {}, 1, [pc('D3'), foe('F3', 'foe', 'cr-no-sleep')]), failedTwice);
    expect(f.conds('foe').some((c) => c.cond === 'core:unconscious')).toBe(false);
    expect(f.left('foe')).toEqual([]);
  });

  it('the repeat save is on its own stream: a next stage shifts no die, its own or any later roll', () => {
    const go = (spell: string, seed: number) => fight([pc('D3'), foe('F3')], { pc: [`cast:${spell}@1`, 'place:F3', 'cast:cr-dexsave@1'] }, { rounds: 2, seed });
    let compared = 0;
    for (let seed = 1; seed < 60; seed++) {
      const a = go('cr-one-stage', seed).saves('foe');
      const b = go('cr-two-stage', seed).saves('foe');
      if (a.length < 2 || a[0]!.ok || a[1]!.ok) continue; // both fail the repeat: one has a next stage, one doesn't
      compared++;
      expect(b[1]!.purpose).toBe('condSave');
      expect(b[1]!.d20).toEqual(a[1]!.d20);
      expect(b[1]!.slot).toBe(a[1]!.slot);
      // The later DEX save: rolled at Automatic failure under Unconscious, so compare its dice only.
      expect(b[2]!.d20).toEqual(a[2]!.d20);
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('`foes`: an ally under a wider Sleep makes no save and the foe does (anyOverlap covers its neighbors)', () => {
    const f = fight([pc('A1'), pc('F3', 'ally'), foe('G3')], { pc: ['cast:sleep@1', 'place:G3'] }, { rounds: 1, flags: { areaGridCoverage: 'anyOverlap' } });
    const z = f.events.find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>;
    expect(z.cells).toBeGreaterThan(1);
    expect(f.saves('ally')).toHaveLength(0);
    expect(f.saves('foe').length).toBeGreaterThan(0);
  });

  it('at the default flags it covers one square, per the build note', () => {
    const f = sleep(1);
    expect((f.events.find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>).cells).toBe(1);
  });
});

describe('Color Spray (srd-raw.txt:25014-25027)', () => {
  it('Blinded until the end of the caster\'s next turn: through its own next turn, off as that turn ends', () => {
    const f = seeded((seed) => fight([pc('D3'), foe('F3')], { pc: ['cast:color-spray@1', 'aim:E'] }, { rounds: 2, seed }), (x) => x.saves('foe')[0]?.ok === false);
    const on = f.conds('foe').find((c) => c.cond === 'core:blinded' && c.on)!;
    const off = f.conds('foe').find((c) => c.cond === 'core:blinded' && !c.on)!;
    const pcTurns = f.events.filter((e) => e.k === 'turnStart' && (e as { who?: number }).who === f.idx('pc'));
    expect(pcTurns).toHaveLength(2);
    expect(off.seq).toBeGreaterThan(pcTurns[1]!.seq);
    const pcEnd = f.events.filter((e) => e.k === 'turnEnd' && (e as { who?: number }).who === f.idx('pc'))[1]!;
    expect(off.seq).toBeLessThan(pcEnd.seq);
    expect(on.seq).toBeLessThan(pcTurns[1]!.seq);
    expect(f.saves('foe')[0]!.key).toContain('con');
  });

  it('a 15-foot Cone: only what stands in it', () => {
    const f = fight([pc('D3'), foe('F3'), foe('D8', 'far')], { pc: ['cast:color-spray@1', 'aim:E'] }, { rounds: 1 });
    expect(f.saves('foe').length).toBe(1);
    expect(f.saves('far')).toHaveLength(0);
  });
});

describe('Grease (srd-raw.txt:27635-27648)', () => {
  const dexSaves = (f: ReturnType<typeof fight>, seat: string) => f.saves(seat).filter((s) => s.key.includes('dex'));

  it('when it appears: a DEX save or Prone; the square is Difficult Terrain', () => {
    const f = seeded((seed) => fight([pc('D3'), foe('F3')], { pc: ['cast:grease@1', 'place:F3'] }, { rounds: 1, seed }), (x) => x.saves('foe')[0]?.ok === false);
    expect((f.events.find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>).difficult).toBe(true);
    expect(f.conds('foe').some((c) => c.cond === 'core:prone' && c.on)).toBe(true);
  });

  it('a creature that ends its turn there saves again; one that\'s outside doesn\'t save', () => {
    const f = fight([pc('D3'), foe('F3'), foe('L8', 'far')], { pc: ['cast:grease@1', 'place:F3'] }, { rounds: 1 });
    expect(dexSaves(f, 'foe')).toHaveLength(2);
    expect(dexSaves(f, 'far')).toHaveLength(0);
  });

  it('a creature that enters it saves', () => {
    const f = fight([pc('D3'), foe('I3')], { pc: ['cast:grease@1', 'place:F3'], foe: ['move:G3'] }, { rounds: 1 });
    const n = dexSaves(f, 'foe').length;
    expect(n).toBeGreaterThan(0);
  });

  it('a Prone from it lasts until the creature rights itself: the spell\'s end doesn\'t touch it', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: ['place:F3'], foe: [] });
    t.cast(t.u('pc'), 'cast:grease@1');
    const u = t.u('foe');
    expect(has(u, COND.prone)).toBe(true); // seed 1: DEX 1 against DC 15
    for (const id of [...t.cx.st.fx.keys()]) endFx(t.cx, id, 'parent', -1);
    expect(has(u, COND.prone)).toBe(true);
  });
});

describe('Hypnotic Pattern (srd-raw.txt:28129-28144): the compound condition', () => {
  const cast = ['place:F3'];
  const under = (use = 'cr-foe') => {
    const t = scene([pc('D3'), foe('F3', 'foe', use)], {}, { pc: cast, foe: [] });
    t.cast(t.u('pc'), 'cast:hypnotic-pattern@3');
    return t;
  };

  it('a failure: Charmed, Incapacitated and Speed 0, and they all end when it takes damage', () => {
    const t = under();
    const u = t.u('foe');
    expect(has(u, COND.charmed)).toBe(true);
    expect(has(u, COND.incapacitated)).toBe(true);
    expect(speedOf(t.cx.st, u)).toBe(0);
    t.cast(t.u('pc'), 'cast:cr-burn@1');
    expect(has(u, COND.charmed)).toBe(false);
    expect(has(u, COND.incapacitated)).toBe(false);
    expect(speedOf(t.cx.st, u)).toBe(30);
  });

  it('damage that comes to 0 (Immunity) doesn\'t end it', () => {
    const t = under('cr-fireproof');
    t.cast(t.u('pc'), 'cast:cr-burn@1');
    expect(has(t.u('foe'), COND.charmed)).toBe(true);
    expect(speedOf(t.cx.st, t.u('foe'))).toBe(0);
  });

  it('a Charmed-immune stat block gets neither Charmed nor Incapacitated nor Speed 0', () => {
    const t = under('cr-no-charm');
    const u = t.u('foe');
    expect(has(u, COND.charmed)).toBe(false);
    expect(has(u, COND.incapacitated)).toBe(false);
    expect(speedOf(t.cx.st, u)).toBe(30);
    expect(u.stats).toHaveLength(0);
    expect(u.borne).toHaveLength(0);
  });

  it('the same for a synthetic compound with no save at all', () => {
    const t = scene([pc('D3'), foe('F3', 'foe', 'cr-no-charm')], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:cr-compound@1');
    expect(t.u('foe').condMask).toBe(0);
    expect(speedOf(t.cx.st, t.u('foe'))).toBe(30);
  });

  it('Incapacitated ends the charmed creature\'s Concentration, the same as any other Incapacitated', () => {
    const t = scene([pc('D3'), { seat: 'other', team: 'enemies', use: 'test:cr-pc', at: 'F3' }], {}, { pc: [], other: ['place:J6'] });
    t.cast(t.u('other'), 'cast:cr-two-stage@1');
    expect(t.u('other').conc).toBeGreaterThanOrEqual(0);
    t.cast(t.u('pc'), 'cast:cr-compound@1');
    expect(t.u('other').conc).toBe(-1);
  });

  it('it can catch the caster\'s own side: no `affects`', () => {
    const f = fight([pc('A1'), pc('F3', 'ally'), foe('G3')], { pc: ['cast:hypnotic-pattern@3', 'place:G3'] }, { rounds: 1 });
    expect(f.saves('ally').length).toBeGreaterThan(0);
    expect(f.saves('foe').length).toBeGreaterThan(0);
  });
});

describe('Fear (srd-raw.txt:26740-26756): dropHeld', () => {
  const under = (use: string, seed = 1, first?: (t: ReturnType<typeof scene>) => void) => {
    const t = scene([pc('D3'), heldFoe('F3', use)], { seed }, { pc: ['aim:E'], foe: [] });
    first?.(t);
    t.cast(t.u('pc'), 'cast:fear@3');
    return t;
  };
  const wand = (u: Unit) => u.hands[0]!;

  it('a failed save: Frightened, and it drops what it holds', () => {
    const t = under('cr-held');
    const u = t.u('foe');
    expect(has(u, COND.frightened)).toBe(true);
    expect(wand(u)).toBeLessThan(0);
    expect(u.dropped[0]).toBe(u.cell);
  });

  it('a successful save: nothing dropped', () => {
    let seed = 1;
    let t = under('cr-held-sure', seed);
    while (has(t.u('foe'), COND.frightened)) t = under('cr-held-sure', ++seed);
    expect(wand(t.u('foe'))).toBe(0);
  });

  it('a creature immune to Frightened drops nothing either', () => {
    const t = under('cr-held', 1, (x) => x.cast(x.u('foe'), 'cast:cr-brave@1'));
    const u = t.u('foe');
    expect(has(u, COND.frightened)).toBe(false);
    expect(wand(u)).toBe(0);
  });

  it('without dropHeld, Frightened alone drops nothing', () => {
    const t = scene([pc('D3'), heldFoe('F3')], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:cr-fright@1');
    expect(has(t.u('foe'), COND.frightened)).toBe(true);
    expect(wand(t.u('foe'))).toBe(0);
    t.cast(t.u('pc'), 'cast:cr-drop@1');
    expect(wand(t.u('foe'))).toBeLessThan(0);
  });
});

describe('Charm Person (srd-raw.txt:24862-24870): targetAdv', () => {
  it('the save rolls with Advantage, and the log names why', () => {
    const f = fight([pc('D3'), foe('F3')], { pc: ['cast:charm-person@1'] }, { rounds: 1 });
    const s = f.saves('foe')[0]!;
    expect(s.adv).toBe('adv');
    expect(s.advSrc).toContain('core:save-advantage');
    expect(s.d20).toHaveLength(2);
  });

  it('Advantage counts as a source: a condition\'s Disadvantage cancels it, as any other', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: [], foe: [] });
    expect(specOf(t, t.u('foe'), 4).adv).toBe('none');
    expect(specOf(t, t.u('foe'), 4, true).adv).toBe('adv');
  });

  it('Charmed ends on damage and blocks attacks on the charmer only', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: [], foe: [] });
    t.cast(t.u('pc'), 'cast:charm-person@1');
    const u = t.u('foe');
    expect(has(u, COND.charmed)).toBe(true); // seed 1
    expect(has(u, COND.incapacitated)).toBe(false);
    t.cast(t.u('pc'), 'cast:cr-burn@1');
    expect(has(u, COND.charmed)).toBe(false);
  });

  it('the AI\'s odds read the same Advantage: the same program with targetAdv is worth less, by what P(fail) says', () => {
    const plain = firstTurn('test:cr-charm-plain', 'cr-brute')!;
    const adv = firstTurn('test:cr-charm-adv', 'cr-brute')!;
    const net = (o: typeof plain) => o.parts.find((p) => p.term.startsWith('program value'))!.ev;
    const lost = (o: typeof plain) => o.parts.find((p) => p.term.includes('charmed'))!.ev;
    expect(net(adv)).toBeLessThan(net(plain));
    // WIS 10 (+0) against DC 15: fails 14/20 straight, (14/20)^2 with Advantage.
    expect(lost(adv) / lost(plain)).toBeCloseTo(0.7, 1);
  });
});

describe('greedy on the readings', () => {
  it('the second stage adds what its save and the Unconscious are worth, and nothing against an immune creature', () => {
    const net = (o: NonNullable<ReturnType<typeof firstTurn>> | undefined) => o?.parts.find((p) => p.term.startsWith('program value'))?.ev ?? -Infinity;
    const one = firstTurn('test:cr-one-stage', 'cr-brute-bad');
    const two = firstTurn('test:cr-two-stage', 'cr-brute-bad');
    expect(net(two)).toBeGreaterThan(net(one));
    // Explain names both stages.
    expect(two!.parts.some((p) => p.term.includes('incapacitated') && p.term.includes('unconscious'))).toBe(true);
    expect(net(firstTurn('test:cr-two-stage', 'cr-brute-no-sleep'))).toBeCloseTo(net(firstTurn('test:cr-one-stage', 'cr-brute-no-sleep')), 6);
  });

  it('the second stage counts only with P(the repeat save fails): WIS 10 fails it 14/20, WIS 1 19/20', () => {
    const lost = (spell: string, use: string) => firstTurn(spell, use)!.parts.find((p) => p.term.includes('its lost actions'))!.ev;
    const share = (use: string) => (lost('test:cr-two-stage', use) - lost('test:cr-one-stage', use)) / lost('test:cr-one-stage', use);
    expect(share('cr-brute') / share('cr-brute-bad')).toBeCloseTo(14 / 19, 1);
  });

  it('Unconscious brings Advantage and Prone: a far archer\'s roll is straight (they cancel), so it adds nothing to the attacks-against-it term', () => {
    const term = (extra: readonly Seat[]) => firstTurn('test:cr-knock', 'cr-brute-bad', 'H3', extra)!.parts.find((p) => p.term.includes('attacks against it'))?.ev ?? 0;
    const melee = guard('G3');
    const alone = term([melee]);
    const withArcher = term([melee, { seat: 'archer', team: 'party', use: 'test:cr-archer', at: 'H9' }]);
    expect(alone).toBeGreaterThan(0);
    expect(withArcher).toBeCloseTo(alone, 3);
  });

  it('Sleep itself reads its second stage in Explain', () => {
    expect(firstTurn('srd:sleep', 'cr-brute-bad')!.parts.some((p) => p.term.includes('unconscious'))).toBe(true);
  });

  it('a Charmed-immune creature isn\'t worth Hypnotic Pattern: the value reads the instance as skipped', () => {
    const net = (use: string) => firstTurn('srd:hypnotic-pattern', use)?.parts.find((p) => p.term.startsWith('program value'))?.ev ?? -Infinity;
    expect(net('cr-brute-bad')).toBeGreaterThan(0);
    expect(net('cr-brute-no-charm')).toBeLessThanOrEqual(0);
  });

  it('Hypnotic Pattern\'s compound shows in Explain', () => {
    expect(firstTurn('srd:hypnotic-pattern', 'cr-brute-bad')!.parts.some((p) => p.term.includes('charmed+incapacitated'))).toBe(true);
  });

  it('a creature asleep and up is hit with Advantage in a foe\'s routine; a downed one reads as it did', () => {
    const t = scene([pc('D3'), foe('E3')], {}, { pc: [], foe: [] });
    const g = new GreedyDecider() as unknown as { foeRoutine(st: unknown, u: Unit, d: Unit, ac: number): { melee: number } };
    const before = g.foeRoutine(t.cx.st, t.u('foe'), t.u('pc'), t.u('pc').tpl.ac);
    const target = t.u('pc');
    const asleep: Unit = { ...target, condMask: target.condMask | COND.unconscious | COND.incapacitated | COND.prone };
    const up = g.foeRoutine(t.cx.st, t.u('foe'), asleep, target.tpl.ac);
    expect(up.melee).toBeGreaterThan(before.melee);
    const down: Unit = { ...asleep, life: 'down' };
    expect(g.foeRoutine(t.cx.st, t.u('foe'), down, target.tpl.ac).melee).toBe(before.melee);
  });

  // Grease: greedy didn't take it on this map (the Prone is worth one short turn, under its slot cost); the fight must still run clean [U: how often it's cast, read from the bench].
  for (const [spell, lvl, want] of [['sleep', 1, 1], ['color-spray', 1, 1], ['grease', 1, 0], ['hypnotic-pattern', 3, 1], ['fear', 3, 1], ['charm-person', 1, 1]] as const) {
    it(`greedy ${want ? 'casts' : 'may pass'} ${spell} when it's all it knows, and the fight runs clean`, () => {
      const pcText = PC('cr-one', 'str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8', [`srd:${spell}`]);
      const loaded = loadContent([...REPO, { path: 'packs/test/pcs/cr-one.yaml', text: pcText }, { path: 'packs/test/monsters/cr-brute.yaml', text: ALL['packs/test/monsters/cr-brute.yaml'] }]);
      if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
      const doc = { kind: 'scenario', id: 'cr', name: 'Cr', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 10 }, flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: 4 }, units: [{ seat: 'pc', team: 'party', use: 'test:cr-one', at: 'D3', decider: 'greedy' }, { seat: 'foe', team: 'enemies', use: 'test:cr-brute', at: 'H3', decider: 'greedy' }, { seat: 'foe2', team: 'enemies', use: 'test:cr-brute', at: 'H4', decider: 'greedy' }] };
      const r = resolveScenario(doc, 'cr.yaml', loaded.content);
      if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
      let casts = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const sink = new ArraySink();
        runFight(r.setup, seed, 0, r.setup.seats.map(() => new GreedyDecider()), sink);
        casts += (sink.events as GameEvent[]).filter((e) => e.k === 'cast' && (e as { lvl?: number }).lvl! >= lvl).length;
      }
      expect(casts).toBeGreaterThanOrEqual(want);
    });
  }
});
