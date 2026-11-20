// Step E, E1 (docs/design/stepE-plan.md section 3): a Multiattack monster may take the plain Attack
// action instead of its Multiattack. compileMonster appends the plain alternative last (no template
// field: plainAlt), so a disarmed Gladiator can punch and an attack outside every Multiattack line
// (the Ghoul's Claw, the Treant's Hail of Bark) is legal as one strike. Tests are named for the rule
// text, with its line in the SRD 5.2.1 PDF text (srd-raw.txt). The monsters are the real SRD blocks
// (the behaviour under test is theirs); the target is the synthetic test:training-dummy.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { plainAlt, type Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { stateHash, type Unit } from '../src/sim/state.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const CONTENT: Content = (() => {
  const r = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.content;
})();

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const party = (seat: string, use: string, at: string): UnitDoc => ({ seat, team: 'party', use, at });
const enemy = (seat: string, use: string, at: string): UnitDoc => ({ seat, team: 'enemies', use, at });

function setupOf(units: UnitDoc[], grid = { w: 12, h: 5 }): FightSetup {
  const doc = { kind: 'scenario', id: 'attack-action', name: 'Attack action', rules: '2024', packs: ['srd-5.2.1', 'test'], grid, units };
  const r = resolveScenario(doc, 'attack-action.yaml', CONTENT, {});
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Every decision: its first item (pass). */
class First implements Decider {
  readonly name = 'first';
  decide(_v: UnitView, _dp: DecisionPoint): number {
    return 0;
  }
}

interface World {
  readonly cx: Ctx;
  readonly sink: ArraySink;
  u(seat: string): Unit;
}
function world(setup: FightSetup, seed = 1): World {
  const sink = new ArraySink();
  const d = new First();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, moveFt: 30, speedAt: 30, freeObj: 1, atkActive: false, atkLive: 0, rolls: 0 });
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
const SPEARS = 1; // srd:gladiator gear: [Shield, Spears x3, Studded Leather Armor]

/** A Gladiator on B2 next to a training dummy on C2, its Spears set to `spears`. */
function gladiator(spears: number): { w: World; g: Unit } {
  const w = world(setupOf([enemy('glad', 'srd:gladiator', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
  const g = w.u('glad');
  expect(g.tpl.gear[SPEARS]!.name).toBe('Spears');
  g.gear[SPEARS] = spears;
  startTurn(w, g);
  return { w, g };
}

describe('E1: the Attack action for Multiattack monsters', () => {
  it('a Multiattack monster may take the Attack action instead: one attack with a weapon or an Unarmed Strike (srd-raw.txt:43908-43910, 32705-32706)', () => {
    // Disarmed: its Multiattack (three Spear attacks) can't be filled, but the Attack action's punch can.
    const bare = gladiator(0);
    expect(attackKeys(bare.w, bare.g)).toEqual(['attack:unarmed-strike>dummy']);
    // Armed: before the first strike both are on offer.
    const armed = gladiator(3);
    expect(attackKeys(armed.w, armed.g)).toEqual(['attack:spear>dummy', 'attack:spear-thrown>dummy', 'attack:unarmed-strike>dummy']);
  });

  it("the Attack action's one strike ends the action; a Multiattack routine is unchanged after its first strike", () => {
    const punch = gladiator(3);
    act(punch.w, punch.g, 'attack:unarmed-strike>dummy');
    expect([punch.g.b.atkActive, punch.g.b.action]).toEqual([false, 0]);
    expect(attackKeys(punch.w, punch.g)).toEqual([]);

    const routine = gladiator(3);
    act(routine.w, routine.g, 'attack:spear>dummy');
    expect(routine.g.b.atkActive).toBe(true);
    expect(attackKeys(routine.w, routine.g)).toEqual(['attack:spear>dummy', 'attack:spear-thrown>dummy']); // no punch mid-Multiattack
    act(routine.w, routine.g, 'attack:spear>dummy');
    act(routine.w, routine.g, 'attack:spear>dummy');
    expect([routine.g.b.atkActive, evs(routine.w, 'attack').length]).toEqual([false, 3]);
  });

  it('an attack outside the Multiattack is its own action (srd-raw.txt:43416-43417): the Ghoul\'s Claw and the Treant\'s Hail of Bark, one strike each', () => {
    // The Ghoul's Multiattack is "two Bite attacks" (48503); its Claw is legal alone, before any Bite.
    const gw = world(setupOf([enemy('ghoul', 'srd:ghoul', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
    const ghoul = gw.u('ghoul');
    startTurn(gw, ghoul);
    expect(attackKeys(gw, ghoul)).toEqual(['attack:bite>dummy', 'attack:claw>dummy', 'attack:unarmed-strike>dummy']);
    act(gw, ghoul, 'attack:claw>dummy');
    expect([ghoul.b.atkActive, attackKeys(gw, ghoul)]).toEqual([false, []]);
    // After a Bite, only the second Bite fits.
    const gw2 = world(setupOf([enemy('ghoul', 'srd:ghoul', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
    const g2 = gw2.u('ghoul');
    startTurn(gw2, g2);
    act(gw2, g2, 'attack:bite>dummy');
    expect(attackKeys(gw2, g2)).toEqual(['attack:bite>dummy']);

    // The Treant's Hail of Bark (range 180) from 50 ft: the Multiattack is two Slams, so the bark is one strike.
    const tw = world(setupOf([enemy('treant', 'srd:treant', 'A2'), party('dummy', 'test:training-dummy', 'K2')]));
    const treant = tw.u('treant');
    startTurn(tw, treant);
    expect(attackKeys(tw, treant)).toEqual(['attack:hail-of-bark>dummy']);
    act(tw, treant, 'attack:hail-of-bark>dummy');
    expect([treant.b.atkActive, evs(tw, 'attack').length]).toEqual([false, 1]);
  });

  it('the log names the action taken: a punch is "Attack", a Spear routine "Multiattack"', () => {
    const punch = gladiator(0);
    act(punch.w, punch.g, 'attack:unarmed-strike>dummy');
    expect(evs(punch.w, 'act').map((e) => [e.via, e.name])).toEqual([['core:attack', 'Attack']]);
    const routine = gladiator(3);
    act(routine.w, routine.g, 'attack:spear>dummy');
    expect(evs(routine.w, 'act').map((e) => [e.via, e.name])).toEqual([['core:multiattack', 'Multiattack']]);
    // An attack outside every Multiattack line is the Attack action too.
    const gw = world(setupOf([enemy('ghoul', 'srd:ghoul', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
    startTurn(gw, gw.u('ghoul'));
    act(gw, gw.u('ghoul'), 'attack:claw>dummy');
    expect(evs(gw, 'act').map((e) => [e.via, e.name])).toEqual([['core:attack', 'Attack']]);
    // A plain monster's Attack action reads as before.
    const pw = world(setupOf([enemy('guard', 'srd:guard', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
    startTurn(pw, pw.u('guard'));
    act(pw, pw.u('guard'), 'attack:spear>dummy');
    expect(evs(pw, 'act').map((e) => [e.via, e.name])).toEqual([['core:attack', 'Attack']]);
  });

  it('known miss: a Gladiator with 1 Spear that throws it is logged as Multiattack (the Multiattack line is still live after the strike)', () => {
    const one = gladiator(1);
    act(one.w, one.g, 'attack:spear-thrown>dummy');
    expect(evs(one.w, 'act').map((e) => [e.via, e.name])).toEqual([['core:multiattack', 'Multiattack']]);
    // It is the only strike it can make (the Multiattack stays open, empty, until the turn ends, as at HEAD).
    expect(attackKeys(one.w, one.g)).toEqual([]);
  });

  it('inertness: only Multiattack templates gain the plain alternative (last, one strike from every attack); every other template keeps its one alternative', () => {
    let multi = 0;
    for (const t of CONTENT.templates) {
      const act = t.attackAct;
      if (!act.multi) {
        expect(plainAlt(act), t.id).toBe(-1);
        expect(act.alts.length, t.id).toBe(1);
        continue;
      }
      multi++;
      expect(act.alts[plainAlt(act)], t.id).toEqual([{ count: 1, from: t.attacks.map((_, i) => i) }]);
      expect(act.alts.length, t.id).toBeGreaterThanOrEqual(2);
      expect(act.alts.length, `${t.id}: alternatives fit the atkLive bitmask`).toBeLessThan(31);
    }
    expect(multi).toBeGreaterThan(160); // 167 SRD Multiattack monsters plus the test beast (census)
  });

  it('inertness: a unit with nothing landed hashes as before (a Guard with its Spear in hand; no ld key)', () => {
    const w = world(setupOf([enemy('guard', 'srd:guard', 'B2'), party('dummy', 'test:training-dummy', 'C2')]));
    const guard = w.u('guard');
    expect(guard.landed.length).toBe(1); // one slot for its one Spear
    const h = stateHash(w.cx.st);
    // The same state with no landing slots at all (the engine before step E) hashes the same.
    const before = { ...w.cx.st, units: w.cx.st.units.map((u) => ({ ...u, landed: new Int16Array(0), landGear: new Uint8Array(0) })) };
    expect(stateHash(before)).toBe(h);
  });
});
