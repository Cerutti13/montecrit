// Step E, E2 (docs/design/stepE-plan.md section 4): a monster's thrown gear lands on the square of
// the creature it was thrown at (RuleFlag thrownWeaponLands, unverified: the Thrown property,
// srd-raw.txt:20386-20391, doesn't say), and the thrower picks a piece back up from its own square
// with the equip of the Attack-action strike that uses it ("Equipping a weapon includes ... picking
// it up", 32707-32712; a Multiattack's strikes are part of the Attack action, 43947-43953). Only the
// thrower picks up (a departure). The monsters are real SRD blocks; targets and the PC are synthetic.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { resetReachCache } from '../src/grid/reach.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { describe as describeEvent } from '../src/log/render.ts';
import type { RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions, listReactions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { flagsUsedKeys, stateHash, type Unit } from '../src/sim/state.ts';
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

/** A PC with held weapons: a single Javelin and a counted stack of two Daggers (M3 step 5b). */
const PC = `kind: pc
id: test:tp-pc
name: TP Thrower
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }
hpMax: 200
ac: 16
extraAttacks: 1
heldWeapons: true
weapons:
  - { id: javelin, name: Javelin, kind: melee, ability: str, thrownRange: [30, 120], base: srd:javelin, damage: [{ roll: 1d6 + @mod, type: piercing }] }
  - { id: dagger, name: Dagger, kind: melee, ability: finesse, light: true, thrownRange: [20, 60], count: 2, base: srd:dagger, damage: [{ roll: 1d4 + @mod, type: piercing }] }
items: []
hands: [null, null]
features: []
`;
const CONTENT: Content = (() => {
  const r = loadContent([...readPack('srd-5.2.1'), ...readPack('test'), { path: 'packs/test/pcs/tp-pc.yaml', text: PC }]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.content;
})();

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string; decider?: string };
const party = (seat: string, use: string, at: string): UnitDoc => ({ seat, team: 'party', use, at });
const enemy = (seat: string, use: string, at: string): UnitDoc => ({ seat, team: 'enemies', use, at });

function setupOf(units: UnitDoc[], flags: Partial<RuleFlags> = {}, extra: Record<string, unknown> = {}): FightSetup {
  const doc = { kind: 'scenario', id: 'thrown-pickup', name: 'Thrown pickup', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 5 }, units, ...extra };
  const r = resolveScenario(doc, 'thrown-pickup.yaml', CONTENT, { flags });
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Declared windows: the first react (Redirect Attack); everything else its first item. */
class Reacts implements Decider {
  readonly name = 'reacts';
  decide(_v: UnitView, dp: DecisionPoint): number {
    if (dp.k !== 'attackDeclared') return 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i).startsWith('react')) return i;
    return 0;
  }
}

interface World {
  readonly cx: Ctx;
  readonly sink: ArraySink;
  readonly setup: FightSetup;
  u(seat: string): Unit;
}
function world(setup: FightSetup, seed = 1): World {
  const sink = new ArraySink();
  const d = new Reacts();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, sink, setup, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, moveFt: 30, speedAt: 30, freeObj: 1, atkActive: false, atkLive: 0, rolls: 0, lightMask: 0, atkEquip: 0 });
  who.b.atkCounts.fill(0);
}
function keysOf(w: World, u: Unit): string[] {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, u.idx, l));
  releaseList(w.cx, list);
  return keys;
}
const attackKeys = (w: World, u: Unit) => keysOf(w, u).filter((k) => k.startsWith('attack:'));
function act(w: World, u: Unit, key: string): void {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const all = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, u.idx, l) }));
  releaseList(w.cx, list);
  const o = all.find((x) => x.key === key);
  if (!o) throw new Error(`no option ${key}; have ${all.map((x) => x.key).join(', ')}`);
  resolveOption(w.cx, u, o.l, -1);
}
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const flagsRead = (w: World) => flagsUsedKeys(w.cx.st.flagsUsed);
const SPEARS = 1; // srd:gladiator gear: [Shield, Spears x3, Studded Leather Armor]
const landedCells = (u: Unit) => [...u.landed].filter((c) => c >= 0).sort((a, b) => a - b);

/** A Gladiator on B2, a training dummy (Speed 0) on `dummyAt`, the Gladiator's turn begun with `spears` Spears. */
function gladiator(spears: number, dummyAt = 'F2', flags: Partial<RuleFlags> = {}, seed = 1): { w: World; g: Unit; d: Unit } {
  const w = world(setupOf([enemy('glad', 'srd:gladiator', 'B2'), party('dummy', 'test:training-dummy', dummyAt)], flags), seed);
  const g = w.u('glad');
  expect(g.tpl.gear[SPEARS]!.name).toBe('Spears');
  g.gear[SPEARS] = spears;
  startTurn(w, g);
  return { w, g, d: w.u('dummy') };
}

describe('E2: thrown gear lands (thrownWeaponLands)', () => {
  it('a thrown piece lands on the target\'s square, hit or miss (thrownWeaponLands=targetSquare)', () => {
    expect(gladiator(3).g.landed.length).toBe(3); // one slot per Spear, derived at unit creation
    for (const want of [true, false]) {
      let found = false;
      for (let seed = 1; seed < 400 && !found; seed++) {
        const { w, g, d } = gladiator(3, 'F2', {}, seed);
        act(w, g, 'attack:spear-thrown>dummy');
        if (evs(w, 'attack')[0]!.hit !== want) continue;
        found = true;
        expect([g.gear[SPEARS], landedCells(g)], `hit ${want}`).toEqual([2, [d.cell]]);
        expect(flagsRead(w)).toContain('thrownWeaponLands');
        expect(evs(w, 'item')).toEqual([]); // no event at landing: logs without a pickup keep their bodies
      }
      expect(found, `a seed where the throw ${want ? 'hits' : 'misses'}`).toBe(true);
    }
  });

  it('after a Redirect, it lands under the creature that was attacked (the ally now on the goblin\'s square)', () => {
    const w = world(setupOf([party('glad', 'srd:gladiator', 'A2'), enemy('boss', 'srd:goblin-boss', 'E2'), enemy('ally', 'srd:goblin-warrior', 'E3')]));
    const g = w.u('glad');
    startTurn(w, g);
    act(w, g, 'attack:spear-thrown>boss');
    expect(evs(w, 'swap').length).toBe(1);
    const ally = w.u('ally');
    expect(evs(w, 'attack')[0]!.tgt).toBe(ally.idx);
    expect(landedCells(g)).toEqual([ally.cell]);
    expect(ally.cell).not.toBe(w.u('boss').cell);
  });

  it('under thrownWeaponLands=gone nothing lands, and a whole fight\'s log equals the targetSquare log up to its first pickup (E1\'s behaviour)', () => {
    const { w, g } = gladiator(3, 'F2', { thrownWeaponLands: 'gone' });
    act(w, g, 'attack:spear-thrown>dummy');
    expect([g.gear[SPEARS], landedCells(g)]).toEqual([2, []]);
    expect(flagsRead(w)).toContain('thrownWeaponLands'); // read where it decides something
    // Whole fights, baseline AI: two Gladiators against four Goblin Warriors (Spears thrown, some landing under the dead).
    const units = [enemy('g1', 'srd:gladiator', 'A2'), enemy('g2', 'srd:gladiator', 'A4'), party('w1', 'srd:goblin-warrior', 'H1'), party('w2', 'srd:goblin-warrior', 'H3'), party('w3', 'srd:goblin-warrior', 'H5'), party('w4', 'srd:goblin-warrior', 'K3')];
    let pickups = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const logOf = (f: Partial<RuleFlags>) => {
        const s = setupOf(units, f, { knobs: { maxRounds: 8 } });
        const sink = new ArraySink();
        runFight(s, seed, 0, makeDeciders(s), sink);
        return sink.events.map((e) => describeEvent(e, s));
      };
      const gone = logOf({ thrownWeaponLands: 'gone' });
      const lands = logOf({});
      expect(gone.some((l) => / picks up /.test(l)), `seed ${seed}`).toBe(false);
      const first = lands.findIndex((l) => / picks up /.test(l));
      if (first >= 0) pickups++;
      const n = first >= 0 ? first : lands.length;
      expect(gone.slice(0, n), `seed ${seed}`).toEqual(lands.slice(0, n));
    }
    void pickups; // the baseline AI never walks onto a piece here, so these logs are equal whole; the prefix rule covers fights where it does
  });

  it('under monsterThrownWeapons=unlimited nothing is counted or lands, and thrownWeaponLands isn\'t read', () => {
    const { w, g } = gladiator(3, 'F2', { monsterThrownWeapons: 'unlimited' });
    act(w, g, 'attack:spear-thrown>dummy');
    expect([g.gear[SPEARS], landedCells(g)]).toEqual([3, []]);
    expect(flagsRead(w)).not.toContain('thrownWeaponLands');
  });
});

describe('E2: the thrower picks its piece up with the strike\'s equip', () => {
  it('a strike of the Attack action may pick its weapon up (srd-raw.txt:32707-32712), Multiattack included (43947-43953): its own piece, from its own square, gear +1, an item pickup event with what it now carries', () => {
    const { w, g, d } = gladiator(0, 'C2');
    expect(attackKeys(w, g)).toEqual(['attack:unarmed-strike>dummy']); // nothing on its square yet
    g.landed[0] = g.cell;
    expect(attackKeys(w, g)).toEqual(['attack:spear>dummy', 'attack:spear-thrown>dummy', 'attack:unarmed-strike>dummy']);
    act(w, g, 'attack:spear>dummy');
    const ks = w.sink.events.map((e) => e.k);
    expect(ks.slice(0, 3)).toEqual(['act', 'item', 'attack']); // picked up before the roll
    expect(evs(w, 'item').map((e) => [e.act, e.item, e.left])).toEqual([['pickup', 'Spears', 1]]);
    expect(evs(w, 'act').map((e) => e.via)).toEqual(['core:multiattack']);
    expect([g.gear[SPEARS], landedCells(g)]).toEqual([1, []]); // a melee Spear isn't consumed
    expect(d.cell).not.toBe(g.cell);
  });

  it('mid-Multiattack, a monster picks up and throws a piece, then picks up a second piece from the same square for its next strike', () => {
    const { w, g, d } = gladiator(0, 'F2');
    g.landed[0] = g.cell;
    g.landed[1] = g.cell;
    act(w, g, 'attack:spear-thrown>dummy');
    act(w, g, 'attack:spear-thrown>dummy');
    expect(evs(w, 'item').map((e) => [e.act, e.left])).toEqual([['pickup', 1], ['pickup', 1]]);
    expect(evs(w, 'gear').map((e) => e.left)).toEqual([0, 0]);
    expect([g.gear[SPEARS], landedCells(g)]).toEqual([0, [d.cell, d.cell]]);
    expect(attackKeys(w, g)).toEqual([]); // the third Spear isn't on its square
  });

  it('no pickup on an opportunity attack: it isn\'t the Attack action, so it carries no equip', () => {
    const w = world(setupOf([enemy('glad', 'srd:gladiator', 'B2'), party('mover', 'test:training-dummy', 'C2')]));
    const g = w.u('glad');
    g.gear[SPEARS] = 0;
    g.landed[0] = g.cell;
    const list = listReactions(w.cx, g, w.u('mover'), w.u('mover').cell, takeList(w.cx));
    const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, g.idx, l));
    releaseList(w.cx, list);
    expect(keys).toEqual(['pass', 'oa:unarmed-strike']);
  });

  it('a piece under a creature is out of reach until it leaves or dies (srd-raw.txt:1956-1957)', () => {
    const w = world(setupOf([enemy('glad', 'srd:gladiator', 'A2'), party('dummy', 'test:training-dummy', 'C2'), party('dummy2', 'test:training-dummy', 'D2')]));
    const g = w.u('glad');
    const dummy = w.u('dummy');
    g.gear[SPEARS] = 0;
    g.landed[0] = dummy.cell;
    startTurn(w, g);
    expect(keysOf(w, g).filter((k) => k.startsWith('move:C2/'))).toEqual([]);
    dummy.life = 'dead';
    resetReachCache(w.cx.sc.reachEngine);
    const to = keysOf(w, g).find((k) => k.startsWith('move:C2/'))!;
    expect(to).toBeDefined();
    act(w, g, to);
    expect(attackKeys(w, g)).toEqual(['attack:spear>dummy2', 'attack:spear-thrown>dummy2', 'attack:unarmed-strike>dummy2']);
  });

  it('a monster standing on its own piece threatens with it (actionEV, gearReady on its own square); a piece elsewhere isn\'t counted (a written miss)', () => {
    const { w, g, d } = gladiator(0, 'C2');
    const bare = actionEV(w.cx.st, g, 16);
    g.landed[0] = d.cell; // elsewhere
    expect(actionEV(w.cx.st, g, 16)).toEqual(bare);
    g.landed[0] = g.cell; // underfoot
    const armed = actionEV(w.cx.st, g, 16);
    expect(armed.melee).toBeGreaterThan(bare.melee);
    expect([bare.rangeFt, armed.rangeFt]).toEqual([0, 20]);
  });

  it('stateHash sees a landed piece, and only while it lies there', () => {
    const { w, g } = gladiator(2);
    const h = stateHash(w.cx.st);
    g.landed[2] = 7;
    const down = stateHash(w.cx.st);
    expect(down).not.toBe(h);
    g.landed[2] = 8;
    expect(stateHash(w.cx.st)).not.toBe(down);
    g.landed[2] = -1;
    expect(stateHash(w.cx.st)).toBe(h);
  });
});

describe('E2: PCs (the flag now decides where a single thrown weapon lands)', () => {
  const pcWorld = (flags: Partial<RuleFlags> = {}) => {
    const w = world(setupOf([party('pc1', 'test:tp-pc', 'B2'), enemy('e1', 'test:training-dummy', 'F2')], flags));
    const pc = w.u('pc1');
    startTurn(w, pc);
    return { w, pc, item: (local: string) => pc.tpl.items.findIndex((x) => x.local === local), atk: (local: string) => pc.tpl.attacks.findIndex((a) => a.local === local) };
  };

  it("a PC's single thrown weapon still lands at the target (the flag now reads it), and is gone under thrownWeaponLands=gone", () => {
    const at = pcWorld();
    act(at.w, at.pc, 'attack:javelin-thrown>e1');
    expect(at.pc.dropped[at.item('javelin')]).toBe(at.w.u('e1').cell);
    expect(flagsRead(at.w)).toContain('thrownWeaponLands');
    expect(at.pc.landed.length).toBe(0); // PCs get no landing slots

    const gone = pcWorld({ thrownWeaponLands: 'gone' });
    act(gone.w, gone.pc, 'attack:javelin-thrown>e1');
    expect(gone.pc.dropped[gone.item('javelin')]).toBe(-1);
    expect(flagsRead(gone.w)).toContain('thrownWeaponLands');
  });

  it('a counted-stack throw reads no thrownWeaponLands (pc1\'s Daggers vanish as before, m3.md:731)', () => {
    const s = pcWorld();
    resolveAttack(s.w.cx, s.pc, s.atk('dagger-thrown'), s.w.u('e1'), false, -1);
    expect(s.pc.gear[0]).toBe(1);
    expect(s.pc.dropped[s.item('dagger')]).toBe(-1);
    expect(flagsRead(s.w)).not.toContain('thrownWeaponLands');
  });
});
