// M3 step 5b (docs/design/m3.md C8): weapons as hand items for PCs (PcSource heldWeapons), the
// Light property's extra attack, the 8 Mastery Properties and the held-item gates. Tests are
// named for the rule text they check, with its line in the SRD 5.2.1 PDF text (srd-raw.txt).
// Content is synthetic (test: ids); the weapon kinds a mastery names are SRD ids only as data.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionKind, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { describe as describeEvent } from '../src/log/render.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { boundary } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions, listReactions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { acNow } from '../src/sim/hands.ts';
import { speedOf } from '../src/sim/stats.ts';
import { COND, HAND, has, type Unit } from '../src/sim/state.ts';

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

/** The weapon library (PcSource weapon entries). STR 16 (+3), DEX 14 (+2): finesse uses STR. */
const W: Record<string, string> = {
  longsword: '{ id: longsword, name: Longsword, kind: melee, ability: str, versatile: 1d10 + @mod, mastery: sap, base: srd:longsword, damage: [{ roll: 1d8 + @mod, type: slashing }] }',
  shortsword: '{ id: shortsword, name: Shortsword, kind: melee, ability: finesse, light: true, mastery: vex, base: srd:shortsword, damage: [{ roll: 1d6 + @mod, type: piercing }] }',
  dagger: '{ id: dagger, name: Dagger, kind: melee, ability: finesse, light: true, thrownRange: [20, 60], count: 2, mastery: nick, base: srd:dagger, damage: [{ roll: 1d4 + @mod, type: piercing }] }',
  handaxe: '{ id: handaxe, name: Handaxe, kind: melee, ability: str, light: true, thrownRange: [20, 60], mastery: vex, base: srd:handaxe, damage: [{ roll: 1d6 + @mod, type: slashing }] }',
  greataxe: '{ id: greataxe, name: Greataxe, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: cleave, base: srd:greataxe, damage: [{ roll: 1d12 + @mod, type: slashing }] }',
  greatsword: '{ id: greatsword, name: Greatsword, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: graze, base: srd:greatsword, damage: [{ roll: 2d6 + @mod, type: slashing }] }',
  maul: '{ id: maul, name: Maul, kind: melee, ability: str, twoHanded: true, heavy: true, mastery: topple, base: srd:maul, damage: [{ roll: 2d6 + @mod, type: bludgeoning }] }',
  warhammer: '{ id: warhammer, name: Warhammer, kind: melee, ability: str, versatile: 1d10 + @mod, mastery: push, base: srd:warhammer, damage: [{ roll: 1d8 + @mod, type: bludgeoning }] }',
  javelin: '{ id: javelin, name: Javelin, kind: melee, ability: str, thrownRange: [30, 120], mastery: slow, base: srd:javelin, damage: [{ roll: 1d6 + @mod, type: piercing }] }',
  crossbow: '{ id: crossbow, name: Light Crossbow, kind: ranged, ability: dex, range: [80, 320], twoHanded: true, loading: true, ammunition: 3, mastery: slow, base: srd:light-crossbow, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
  daggerOne: '{ id: dagger, name: Dagger, kind: melee, ability: finesse, light: true, thrownRange: [20, 60], count: 1, base: srd:dagger, damage: [{ roll: 1d4 + @mod, type: piercing }] }',
  heavybow: '{ id: longbow, name: Longbow, kind: ranged, ability: dex, range: [150, 600], twoHanded: true, heavy: true, base: srd:longbow, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
  rapier: '{ id: rapier, name: Toppling Rapier, kind: melee, ability: finesse, mastery: topple, base: srd:rapier, damage: [{ roll: 1d8 + @mod, type: piercing }] }',
  plus: '{ id: plus, name: Plus Sword, kind: melee, ability: str, magic: test:wm-weapon-plus-2, damage: [{ roll: 1d8 + @mod, type: slashing }] }',
};

interface PcOpts {
  weapons: string[];
  hands?: [string | null, string | null];
  masteries?: string[];
  held?: boolean;
  str?: number;
  dex?: number;
  items?: string[];
  features?: string[];
}
const pcYaml = (o: PcOpts) => `kind: pc
id: test:wm-pc
name: WM Fighter
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: ${o.str ?? 16}, dex: ${o.dex ?? 14}, con: 14, int: 10, wis: 10, cha: 10 }
hpMax: 200
ac: 16
extraAttacks: 1
${o.held === false ? '' : 'heldWeapons: true\n'}${o.masteries ? `masteries: [${o.masteries.join(', ')}]\n` : ''}weapons:
${o.weapons.map((w) => `  - ${W[w]}`).join('\n')}
items: [${(o.items ?? []).join(', ')}]
hands: [${(o.hands ?? [null, null]).map((h) => h ?? 'null').join(', ')}]
features: [${(o.features ?? []).join(', ')}]
`;

const monster = (id: string, ac: number, hp: number, size = 'medium', toHit = 0) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: ${size}
cr: 0
pb: 2
ac: ${ac}
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: hit, name: Hit, kind: melee, toHit: ${toHit}, damage: [{ roll: '1', type: bludgeoning, avg: 1 }] }
`;
const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;
const KIT: Record<string, string> = {
  'packs/test/monsters/wm-dummy.yaml': monster('wm-dummy', 1, 300),
  'packs/test/monsters/wm-wall.yaml': monster('wm-wall', 60, 300),
  'packs/test/monsters/wm-huge.yaml': monster('wm-huge', 1, 300, 'huge'),
  'packs/test/monsters/wm-frail.yaml': monster('wm-frail', 1, 1),
  'packs/test/data/wm-weapon-plus-2.yaml': feature('wm-weapon-plus-2', 'passive: { effects: [bonus] }\neffects:\n  - { id: bonus, name: Weapon +2, stats: [{ magicWeapon: 2 }] }\n'),
  'packs/test/data/wm-shield-plus-1.yaml': feature('wm-shield-plus-1', 'passive: { effects: [bonus] }\neffects:\n  - { id: bonus, name: Shield +1, stats: [{ ac: 1, when: [shieldHeld] }] }\n'),
  'packs/test/data/wm-wand.yaml': feature('wm-wand', 'passive: { effects: [bonus] }\neffects:\n  - { id: bonus, name: Wand, stats: [{ ac: 3, when: [itemHeld] }] }\n'),
};
const PC_PATH = 'packs/test/pcs/wm-pc.yaml';

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const PC: UnitDoc = { seat: 'pc1', team: 'party', use: 'test:wm-pc', at: 'B2' };
const foe = (seat: string, use: string, cell: string): UnitDoc => ({ seat, team: 'enemies', use: `test:${use}`, at: cell });

const SETUPS = new Map<string, FightSetup>();
function setupOf(pc: PcOpts, units: UnitDoc[] = [PC, foe('e1', 'wm-dummy', 'C2')]): FightSetup {
  const key = JSON.stringify([pc, units]);
  let s = SETUPS.get(key);
  if (!s) {
    const content = loadOk(withFiles({ ...KIT, [PC_PATH]: pcYaml(pc) }));
    const doc = { kind: 'scenario', id: 'wm-lab', name: 'Weapon lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 10, h: 6 }, units };
    const r = resolveScenario(doc, 'wm-lab.yaml', content, {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    SETUPS.set(key, (s = r.setup));
  }
  return s;
}
const tplOf = (pc: PcOpts): CompiledTemplate => setupOf(pc).seats.find((s) => s.tpl.id === 'test:wm-pc')!.tpl;
const pcIdx = (setup: FightSetup): number => setup.seats.findIndex((s) => s.seat === 'pc1');

/** Riders: take (last key) unless `rider` says; pulls: go on while it can; everything else the first item. */
class Scripted implements Decider {
  readonly name = 'scripted';
  readonly seen: { k: DecisionKind; keys: string[] }[] = [];
  rider: (keys: string[]) => string | null = (keys) => keys[keys.length - 1]!;
  target: (keys: string[]) => number = () => 0;
  decide(_v: UnitView, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys });
    if (dp.k === 'rider') {
      const want = this.rider(keys);
      return want === null ? 0 : keys.indexOf(want);
    }
    if (dp.k === 'pull') return keys.length > 1 ? 1 : 0;
    if (dp.k === 'target') return this.target(keys);
    return 0;
  }
  kinds(k: DecisionKind): string[][] {
    return this.seen.filter((s) => s.k === k).map((s) => s.keys);
  }
}

interface World {
  readonly cx: Ctx;
  readonly d: Scripted;
  readonly sink: ArraySink;
  u(seat: string): Unit;
}
function world(setup: FightSetup, seed = 1): World {
  const d = new Scripted();
  const sink = new ArraySink();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, d, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  who.b.reaction = 1;
  boundary(w.cx, 'start', who, -1);
  Object.assign(who.b, { action: 1, bonus: 1, moveFt: 30, speedAt: 30, freeObj: 1, atkActive: false, atkLive: 0, lightMask: 0, atkEquip: 0 });
  who.b.atkCounts.fill(0);
}
function endTurn(w: World, who: Unit): void {
  boundary(w.cx, 'end', who, -1);
  w.cx.st.active = -1;
}
function keysOf(w: World, u: Unit): string[] {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, u.idx, l));
  releaseList(w.cx, list);
  return keys;
}
function act(w: World, u: Unit, key: string): void {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const all = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, u.idx, l) }));
  releaseList(w.cx, list);
  const o = all.find((x) => x.key === key);
  if (!o) throw new Error(`no option ${key}; have ${all.map((x) => x.key).join(', ')}`);
  resolveOption(w.cx, u, o.l, -1);
}
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const atkIdx = (u: Unit, local: string): number => u.tpl.attacks.findIndex((a) => a.local === local);
const item = (u: Unit, local: string): number => u.tpl.items.findIndex((x) => x.local === local);
/** A world (fresh per seed) where `body` runs; the first seed for which `ok` holds afterwards. */
function seedWhere(setup: FightSetup, body: (w: World) => void, ok: (w: World) => boolean, max = 400): World {
  for (let s = 1; s < max; s++) {
    const w = world(setup, s);
    body(w);
    if (ok(w)) return w;
  }
  throw new Error('no seed found');
}

// ---------------------------------------------------------------------------------------------

describe('weapons as hand items (PcSource heldWeapons; C3)', () => {
  it('C3: without heldWeapons nothing new compiles (no weapon items, no item/twoHands/throws fields), so kind: pc files hash as before', () => {
    const tpl = tplOf({ weapons: ['longsword', 'dagger', 'greataxe'], held: false });
    expect(tpl.items).toEqual([]);
    for (const a of tpl.attacks) for (const k of ['item', 'twoHands', 'throws', 'loading', 'heavyDis']) expect(k in a).toBe(false);
    expect(tpl.attacks.map((a) => a.local)).toEqual(['longsword', 'dagger', 'dagger-thrown', 'greataxe', 'unarmed-strike']); // no two-handed mode
    expect(tpl.features).toEqual([]); // no masteries chosen, no Light feature without hand items
  });

  it('heldWeapons: each weapon is an item after the authored ones; hands may name a weapon; a Versatile weapon gains a two-handed mode', () => {
    const tpl = tplOf({ weapons: ['longsword', 'dagger'], items: ['{ id: pouch, name: Pouch, kind: pouch }'], hands: ['longsword', null] });
    expect(tpl.items.map((x) => [x.local, x.kind, x.light ?? false])).toEqual([['pouch', 'pouch', false], ['longsword', 'weapon', false], ['dagger', 'weapon', true]]);
    expect(tpl.startHands).toEqual([1, -1]);
    const two = tpl.attacks.find((a) => a.local === 'longsword-two-handed')!;
    expect(two.name).toBe('Longsword (two-handed)');
    expect(two.twoHands).toBe(true);
    expect(two.item).toBe(1);
  });

  it('Two-Handed, srd-raw.txt:20396-20397: "requires two hands when you attack with it" — a shield in the other hand blocks the attack', () => {
    const items = ['{ id: shield, name: Shield, kind: shield, shieldAc: 2 }'];
    const w = world(setupOf({ weapons: ['greataxe'], items, hands: ['greataxe', 'shield'] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(keysOf(w, pc)).not.toContain('attack:greataxe>e1');
    pc.hands[1] = HAND.empty;
    expect(keysOf(w, pc)).toContain('attack:greataxe>e1');
  });

  it('Versatile, srd-raw.txt:20401-20404: "deals that damage when used with two hands" — the two-handed grip only with the other hand empty, with the versatile die', () => {
    const items = ['{ id: shield, name: Shield, kind: shield, shieldAc: 2 }'];
    const setup = setupOf({ weapons: ['longsword'], items, hands: ['longsword', 'shield'] });
    const w = world(setup);
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(keysOf(w, pc)).toContain('attack:longsword>e1');
    expect(keysOf(w, pc)).not.toContain('attack:longsword-two-handed>e1');
    pc.hands[1] = HAND.empty;
    expect(keysOf(w, pc)).toContain('attack:longsword-two-handed>e1');
    const dmg = pc.tpl.attacks[atkIdx(pc, 'longsword-two-handed')]!.damage[0]!;
    expect(dmg.avg).toBe(5 + 3); // 1d10 + 3
  });

  it('Equipping, srd-raw.txt:32707-32711: "If you equip a weapon before an attack" — an Attack action strike draws a sheathed weapon, spending that strike\'s equip', () => {
    const w = world(setupOf({ weapons: ['longsword', 'handaxe'], hands: [null, null] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(keysOf(w, pc)).toContain('attack:longsword>e1');
    act(w, pc, 'attack:longsword>e1');
    const draw = evs(w, 'item')[0]!;
    expect([draw.item, draw.act]).toEqual(['Longsword', 'draw']);
    expect(w.sink.events.findIndex((e) => e.k === 'item')).toBeLessThan(w.sink.events.findIndex((e) => e.k === 'attack'));
    expect(pc.hands[0]).toBe(item(pc, 'longsword'));
    expect(pc.b.atkEquip).toBe(0); // the equip went into the draw
    expect(pc.b.freeObj).toBe(1); // the free object interaction is untouched
  });

  it('Equipping, srd-raw.txt:32707-32712: "either before or after the attack" — a strike with a weapon in hand leaves its equip for after it (a stow costs nothing else)', () => {
    const w = world(setupOf({ weapons: ['longsword', 'handaxe'], hands: ['longsword', null] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:longsword>e1');
    expect(pc.b.atkEquip).toBe(1);
    act(w, pc, 'item:stow/longsword');
    expect(pc.b.atkEquip).toBe(0);
    expect(pc.b.freeObj).toBe(1);
    expect(pc.b.action).toBe(0); // the Attack action, nothing more
  });

  it('review R2, srd-raw.txt:32704-32708: "one attack roll with a weapon or an Unarmed Strike ... You can either equip or unequip one weapon when you make an attack as part of this action" — an Unarmed Strike\'s equip stows the Maul the first strike drew', () => {
    const w = world(setupOf({ weapons: ['maul'], hands: [null, null] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:maul>e1');
    expect(pc.b.atkEquip).toBe(0); // the draw spent strike 1's equip
    act(w, pc, 'attack:unarmed-strike>e1');
    expect(pc.b.atkEquip).toBe(1); // strike 2's own equip
    act(w, pc, 'item:stow/maul');
    expect([pc.b.freeObj, pc.b.action]).toEqual([1, 0]); // neither the free object interaction nor an action
  });

  it('review INT-1, srd-raw.txt:32711: "Equipping a weapon includes drawing it from a sheath or picking it up" — an Attack action strike picks up the weapon lying in its own square; one on another square, or with no equip (an opportunity attack), is out of reach', () => {
    const w = world(setupOf({ weapons: ['longsword'], hands: [null, null] }));
    const pc = w.u('pc1');
    const ls = item(pc, 'longsword');
    pc.dropped[ls] = pc.cell; // dropped when it fell Unconscious
    const e1 = w.u('e1');
    const oa = listReactions(w.cx, pc, e1, e1.cell, takeList(w.cx));
    expect(oa.items.slice(0, oa.n).map((l) => legalKey(w.cx.st, pc.idx, l))).toEqual(['pass', 'oa:unarmed-strike']);
    releaseList(w.cx, oa);
    startTurn(w, pc);
    act(w, pc, 'attack:longsword>e1');
    const ev = evs(w, 'item')[0]!;
    expect([ev.item, ev.act]).toEqual(['Longsword', 'pickup']);
    expect(pc.dropped[ls]).toBe(-1);
    expect(pc.hands[0]).toBe(ls);
    expect([pc.b.atkEquip, pc.b.freeObj]).toEqual([0, 1]); // the strike's equip picked it up
    const w2 = world(setupOf({ weapons: ['longsword'], hands: [null, null] }));
    const p2 = w2.u('pc1');
    p2.dropped[item(p2, 'longsword')] = p2.cell + 2; // lying on another square
    startTurn(w2, p2);
    expect(keysOf(w2, p2)).not.toContain('attack:longsword>e1');
  });

  it('an opportunity attack needs the weapon in hand: no equip outside the Attack action (only the Unarmed Strike is offered when it\'s sheathed)', () => {
    const w = world(setupOf({ weapons: ['longsword'], hands: [null, null] }));
    const pc = w.u('pc1');
    const e1 = w.u('e1');
    const list = listReactions(w.cx, pc, e1, e1.cell, takeList(w.cx));
    const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, pc.idx, l));
    releaseList(w.cx, list);
    expect(keys).toEqual(['pass', 'oa:unarmed-strike']);
  });

  it('Thrown, srd-raw.txt:20387-20389: "you can draw that weapon as part of the attack" — and a single thrown weapon leaves the hand and lands by its target', () => {
    const setup = setupOf({ weapons: ['javelin'], hands: [null, null] }, [PC, foe('e1', 'wm-dummy', 'F2')]);
    const w = world(setup);
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:javelin-thrown>e1');
    expect(evs(w, 'item').map((e) => e.act)).toEqual(['draw', 'throw']);
    // The log says it once: the attack line names the throw; the item line only that the hand is empty.
    expect(evs(w, 'item').map((e) => describeEvent(e, setup))).toEqual(['pc1 draws Javelin', "pc1's hand is empty: Javelin was thrown"]);
    expect(pc.hands[0]).toBe(HAND.empty);
    expect(pc.dropped[item(pc, 'javelin')]).toBe(w.u('e1').cell);
    expect(pc.b.atkEquip).toBe(1); // a throw's draw is the Thrown property's, not the strike's equip
    expect(keysOf(w, pc).filter((k) => k.startsWith('attack:javelin'))).toEqual([]); // it lies over there now
  });

  it('property: a thrown weapon always leaves the hand, and a stack loses one each throw until none is left to draw', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (seed) => {
        const w = world(setupOf({ weapons: ['dagger'], hands: ['dagger', null] }, [PC, foe('e1', 'wm-dummy', 'F2')]), seed);
        const pc = w.u('pc1');
        startTurn(w, pc);
        resolveAttack(w.cx, pc, atkIdx(pc, 'dagger-thrown'), w.u('e1'), false, -1);
        if (pc.hands[0] !== HAND.empty || pc.gear[0] !== 1) return false;
        resolveAttack(w.cx, pc, atkIdx(pc, 'dagger-thrown'), w.u('e1'), false, -1); // drawn as part of the throw
        if (pc.hands[0] !== HAND.empty || pc.hands[1] !== HAND.empty || Number(pc.gear[0]) !== 0) return false;
        endTurn(w, pc);
        startTurn(w, pc);
        return !keysOf(w, pc).some((k) => k.startsWith('attack:dagger') || k === 'item:draw/dagger');
      }),
      { numRuns: 25 },
    );
  });

  it('Heavy, srd-raw.txt:20334-20337: "Disadvantage on attack rolls with a Heavy weapon if it\'s a Melee weapon and your Strength score isn\'t at least 13"', () => {
    expect(tplOf({ weapons: ['greataxe'], str: 12 }).attacks[0]!.heavyDis).toBe(true);
    expect('heavyDis' in tplOf({ weapons: ['greataxe'], str: 13 }).attacks[0]!).toBe(false);
    const w = world(setupOf({ weapons: ['greataxe'], str: 12, hands: ['greataxe', null] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:greataxe>e1');
    expect(evs(w, 'attack')[0]!.disSrc).toContain('core:heavy-weapon');
  });

  it('Heavy, srd-raw.txt:20334-20337: "or if it\'s a Ranged weapon and your Dexterity score isn\'t at least 13" — a Heavy Longbow checks DEX, not STR (review S2)', () => {
    expect('heavyDis' in tplOf({ weapons: ['heavybow'], str: 8, dex: 16 }).attacks[0]!).toBe(false);
    expect(tplOf({ weapons: ['heavybow'], str: 16, dex: 12 }).attacks[0]!.heavyDis).toBe(true);
  });

  it('Ammunition, srd-raw.txt:20317-20320: "Each attack expends one piece of ammunition"; Loading, 20355-20358: one shot per action, "regardless of the number of attacks"', () => {
    const w = world(setupOf({ weapons: ['crossbow'], hands: ['crossbow', null] }, [PC, foe('e1', 'wm-dummy', 'F2')]));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:crossbow>e1');
    expect(pc.gear[0]).toBe(2);
    const g = evs(w, 'gear')[0]!;
    expect(g.ammo).toBe(true);
    expect(pc.b.atkActive).toBe(true); // Extra Attack: a second strike is still possible...
    expect(keysOf(w, pc)).not.toContain('attack:crossbow>e1'); // ...but not with the Loading weapon
  });

  it('Ammunition: "you need a free hand to load a one-handed weapon" (20319-20320); none left, it can\'t fire', () => {
    const w = world(setupOf({ weapons: ['crossbow'], items: ['{ id: torch, name: Torch, kind: object }'], hands: ['crossbow', 'torch'] }, [PC, foe('e1', 'wm-dummy', 'F2')]));
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(keysOf(w, pc)).not.toContain('attack:crossbow>e1');
    pc.hands[1] = HAND.empty;
    pc.gear[0] = 0;
    expect(keysOf(w, pc)).not.toContain('attack:crossbow>e1');
  });

  it('an Unconscious creature drops what it holds (srd-raw.txt Unconscious): its weapon lies at its feet', () => {
    const setup = setupOf({ weapons: ['longsword'], hands: ['longsword', null] });
    const w = seedWhere(setup, (w) => {
      w.u('pc1').hp = 1;
      resolveAttack(w.cx, w.u('e1'), 0, w.u('pc1'), false, -1);
    }, (w) => w.u('pc1').hp === 0);
    const pc = w.u('pc1');
    expect(pc.hands[0]).toBe(HAND.empty);
    expect(pc.dropped[item(pc, 'longsword')]).toBe(pc.cell);
  });
});

describe('the Light property, srd-raw.txt:20339-20349', () => {
  const DUAL: PcOpts = { weapons: ['shortsword', 'dagger', 'longsword'], hands: ['shortsword', 'dagger'] };

  it('"When you take the Attack action on your turn and attack with a Light weapon, you can make one extra attack as a Bonus Action later on the same turn"', () => {
    const w = world(setupOf(DUAL));
    const pc = w.u('pc1');
    startTurn(w, pc);
    expect(keysOf(w, pc)).not.toContain('use:light-weapons'); // not before the Attack action
    act(w, pc, 'attack:shortsword>e1');
    expect(keysOf(w, pc)).toContain('use:light-weapons');
    act(w, pc, 'use:light-weapons');
    expect(pc.b.bonus).toBe(0);
    const extra = evs(w, 'attack')[1]!;
    expect(extra.name).toBe('Dagger'); // "a different Light weapon": the dagger, never the shortsword again
    expect(w.d.kinds('target')[0]).toEqual(['attack:dagger>e1', 'attack:dagger-thrown>e1']);
    expect(keysOf(w, pc)).not.toContain('use:light-weapons'); // one extra attack
  });

  it('"you don\'t add your ability modifier to the extra attack\'s damage unless that modifier is negative"', () => {
    const pos = tplOf(DUAL).features.find((f) => f.local === 'light-weapons')!;
    const step = pos.activate!.steps[0]!;
    if (step.k !== 'weaponAttack') throw new Error('expected weaponAttack');
    const dagger = step.noAbility!.find((a) => a.local === 'dagger')!;
    expect(dagger.damage[0]!.avg).toBe(2); // 1d4, +3 left out
    // A negative modifier stays: STR 6 (-2) with a Handaxe (STR, Light), 1d6 - 2.
    const neg = tplOf({ weapons: ['handaxe', 'shortsword'], hands: ['handaxe', 'shortsword'], str: 6 });
    const s2 = neg.features.find((f) => f.local === 'light-weapons')!.activate!.steps[0]!;
    if (s2.k !== 'weaponAttack') throw new Error('expected weaponAttack');
    expect(s2.noAbility!.find((a) => a.local === 'handaxe')!.damage[0]!.avg).toBe(1); // floor(3.5 - 2)
  });

  it('not offered after an Attack action strike with a non-Light weapon, nor on another creature\'s turn', () => {
    const w = world(setupOf({ weapons: ['shortsword', 'dagger', 'longsword'], hands: ['longsword', 'dagger'] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:longsword>e1');
    expect(keysOf(w, pc)).not.toContain('use:light-weapons');
    const w2 = world(setupOf(DUAL));
    const pc2 = w2.u('pc1');
    startTurn(w2, pc2);
    act(w2, pc2, 'attack:shortsword>e1');
    w2.cx.st.active = w2.u('e1').idx; // someone else's turn
    expect(keysOf(w2, pc2)).not.toContain('use:light-weapons');
  });

  it('only with two Light weapons: one Light weapon compiles no Light feature', () => {
    expect(tplOf({ weapons: ['shortsword', 'longsword'] }).features.some((f) => f.local === 'light-weapons')).toBe(false);
  });

  it('review R1, "That extra attack must be made with a different Light weapon" (20344-20345) and Thrown, "you can draw that weapon as part of the attack" (20387-20389): a counted stack of two Daggers is two Light weapons, and the second one is thrown', () => {
    expect(tplOf({ weapons: ['dagger'] }).features.some((f) => f.local === 'light-weapons')).toBe(true);
    expect(tplOf({ weapons: ['daggerOne'] }).features.some((f) => f.local === 'light-weapons')).toBe(false); // one dagger: no second Light weapon
    const w = world(setupOf({ weapons: ['dagger'], hands: ['dagger', null] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:dagger>e1'); // the held dagger, in melee: it stays in hand
    expect(keysOf(w, pc)).toContain('use:light-weapons');
    act(w, pc, 'use:light-weapons');
    expect(w.d.kinds('target')).toEqual([]); // only the thrown mode qualifies: never the same dagger in melee
    const extra = evs(w, 'attack')[1]!;
    expect(extra.name).toBe('Dagger (thrown)');
    expect(pc.gear[0]).toBe(1); // the second piece is gone
    const w2 = world(setupOf({ weapons: ['daggerOne'], hands: ['dagger', null] }));
    const p2 = w2.u('pc1');
    startTurn(w2, p2);
    act(w2, p2, 'attack:dagger>e1');
    expect(keysOf(w2, p2)).not.toContain('use:light-weapons');
  });

  it('Nick, srd-raw.txt:20432-20435: "you can make it as part of the Attack action instead of as a Bonus Action. You can make this extra attack only once per turn"', () => {
    const w = world(setupOf({ ...DUAL, masteries: ['srd:dagger'] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:shortsword>e1');
    const keys = keysOf(w, pc);
    expect(keys).toContain('use:light-weapons/extra-attack');
    expect(keys).toContain('use:light-weapons/nick-dagger');
    act(w, pc, 'use:light-weapons/nick-dagger');
    expect(pc.b.bonus).toBe(1); // no Bonus Action spent
    expect(evs(w, 'attack')[1]!.name).toBe('Dagger');
    expect(keysOf(w, pc).filter((k) => k.startsWith('use:light-weapons'))).toEqual([]); // once per turn, and the Light extra attack is the same one
  });

  it('Nick needs Weapon Mastery of the dagger: without it only the Bonus Action form is offered', () => {
    const w = world(setupOf({ ...DUAL, masteries: ['srd:shortsword'] }));
    const pc = w.u('pc1');
    startTurn(w, pc);
    act(w, pc, 'attack:shortsword>e1');
    expect(keysOf(w, pc).filter((k) => k.startsWith('use:light'))).toEqual(['use:light-weapons']);
  });
});

describe('Mastery Properties, srd-raw.txt:20406-20467', () => {
  it('"usable only by a character who has a feature, such as Weapon Mastery, that unlocks the property" (20408-20410): no masteries, no mastery riders', () => {
    const none = tplOf({ weapons: ['longsword', 'maul', 'greataxe'] });
    expect(none.riders).toBeUndefined();
    const some = tplOf({ weapons: ['longsword', 'maul', 'greataxe'], masteries: ['srd:maul'] });
    expect(some.riders!.map((r) => r.local)).toEqual(['topple-maul']);
    expect(some.attacks.find((a) => a.local === 'maul')!.onHit).toEqual([0]);
    expect(some.attacks.find((a) => a.local === 'longsword')!.onHit).toBeUndefined();
  });

  it('property: a mastery never fires without Weapon Mastery of the weapon used', () => {
    fc.assert(
      fc.property(fc.subarray(['srd:longsword', 'srd:maul', 'srd:greataxe', 'srd:javelin', 'srd:greatsword']), fc.integer({ min: 1, max: 1000 }), (chosen, seed) => {
        const pc: PcOpts = { weapons: ['longsword', 'maul', 'greataxe', 'javelin', 'greatsword'], hands: ['maul', null], ...(chosen.length > 0 ? { masteries: chosen } : {}) };
        const setup = setupOf(pc, [PC, foe('e1', 'wm-dummy', 'C2'), foe('e2', 'wm-dummy', 'C3')]);
        const sink = new ArraySink();
        runFight(setup, seed, 0, setup.seats.map(() => new RandomLegalDecider()), sink);
        const tpl = tplOf(pc);
        const featureOf = new Map(tpl.features.map((f) => [f.id, f]));
        for (const e of sink.events) {
          if (e.k !== 'act' || e.who !== pcIdx(setup) || !e.via.startsWith('core:mastery-')) continue;
          const weapon = e.via.slice('core:mastery-'.length);
          if (!featureOf.has(e.via) || !chosen.includes(`srd:${weapon}`)) return false;
        }
        return true;
      }),
      { numRuns: 10 },
    );
  }, 60000);

  it('Topple, 20455-20461: "a Constitution saving throw (DC 8 plus the ability modifier used to make the attack roll and your Proficiency Bonus). On a failed save, the creature has the Prone condition"', () => {
    const setup = setupOf({ weapons: ['maul'], hands: ['maul', null], masteries: ['srd:maul'] });
    const w = seedWhere(setup, (w) => {
      const pc = w.u('pc1');
      startTurn(w, pc);
      act(w, pc, 'attack:maul>e1');
    }, (w) => evs(w, 'save').some((s) => !s.ok));
    const save = evs(w, 'save')[0]!;
    expect(save.key).toBe('save.con');
    expect(save.dc).toBe(8 + 3 + 3);
    expect(w.d.kinds('rider')[0]).toEqual(['pass', 'rider:topple-maul']); // "you can force"
    expect(has(w.u('e1'), COND.prone)).toBe(true);
  });

  it('Topple, 20455-20461: "DC 8 plus the ability modifier used to make the attack roll" — a finesse weapon attacking with DEX uses DEX for the DC (review S3)', () => {
    const setup = setupOf({ weapons: ['rapier'], hands: ['rapier', null], masteries: ['srd:rapier'], str: 10, dex: 16 });
    const w = seedWhere(setup, (w) => {
      const pc = w.u('pc1');
      startTurn(w, pc);
      act(w, pc, 'attack:rapier>e1');
    }, (w) => evs(w, 'save').length > 0);
    expect(evs(w, 'save')[0]!.dc).toBe(8 + 3 + 3); // DEX +3 and PB 3; STR would make it 11
  });

  it('Push, 20437-20440: "push the creature up to 10 feet straight away from yourself if it is Large or smaller"', () => {
    const setup = setupOf({ weapons: ['warhammer'], hands: ['warhammer', null], masteries: ['srd:warhammer'] });
    const w = seedWhere(setup, (w) => {
      const pc = w.u('pc1');
      startTurn(w, pc);
      act(w, pc, 'attack:warhammer>e1');
    }, (w) => evs(w, 'attack')[0]!.hit);
    const e1 = w.u('e1');
    expect(e1.cell).toBe(4 + 1 * 10); // C2 -> E2: 10 ft straight away from B2
    const huge = setupOf({ weapons: ['warhammer'], hands: ['warhammer', null], masteries: ['srd:warhammer'] }, [PC, foe('e1', 'wm-huge', 'C2')]);
    const w2 = seedWhere(huge, (w) => {
      startTurn(w, w.u('pc1'));
      act(w, w.u('pc1'), 'attack:warhammer>e1');
    }, (w) => evs(w, 'attack')[0]!.hit);
    expect(w2.u('e1').cell).toBe(2 + 1 * 10); // Huge: not pushed
  });

  it('Sap, 20442-20446: "that creature has Disadvantage on its next attack roll before the start of your next turn" (no choice to make)', () => {
    const setup = setupOf({ weapons: ['longsword'], hands: ['longsword', null], masteries: ['srd:longsword'] });
    const w = seedWhere(setup, (w) => {
      const pc = w.u('pc1');
      startTurn(w, pc);
      act(w, pc, 'attack:longsword>e1');
    }, (w) => evs(w, 'attack')[0]!.hit);
    expect(w.d.kinds('rider')).toEqual([]); // automatic
    const pc = w.u('pc1');
    const e1 = w.u('e1');
    endTurn(w, pc);
    startTurn(w, e1);
    resolveAttack(w.cx, e1, 0, pc, false, -1);
    resolveAttack(w.cx, e1, 0, pc, false, -1);
    const [first, second] = evs(w, 'attack').slice(1);
    expect(first!.disSrc).toContain('core:mastery-longsword/sapped');
    expect(second!.disSrc).not.toContain('core:mastery-longsword/sapped'); // its next attack roll only
  });

  it('Sap ends at the start of the attacker\'s next turn, used or not', () => {
    const setup = setupOf({ weapons: ['longsword'], hands: ['longsword', null], masteries: ['srd:longsword'] });
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      act(w, w.u('pc1'), 'attack:longsword>e1');
    }, (w) => evs(w, 'attack')[0]!.hit);
    const pc = w.u('pc1');
    const e1 = w.u('e1');
    endTurn(w, pc);
    startTurn(w, pc); // e1 never attacked
    resolveAttack(w.cx, e1, 0, pc, false, -1);
    expect(evs(w, 'attack').at(-1)!.disSrc).not.toContain('core:mastery-longsword/sapped');
  });

  it('Vex, 20463-20467: "you have Advantage on your next attack roll against that creature" — yours only, once', () => {
    const units = [PC, { seat: 'pc2', team: 'party' as const, use: 'test:wm-pc', at: 'C3' }, foe('e1', 'wm-dummy', 'C2')];
    const setup = setupOf({ weapons: ['shortsword'], hands: ['shortsword', null], masteries: ['srd:shortsword'] }, units);
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      resolveAttack(w.cx, w.u('pc1'), 0, w.u('e1'), false, -1);
    }, (w) => evs(w, 'damage').length > 0);
    const VEX = 'core:mastery-shortsword/vexed';
    resolveAttack(w.cx, w.u('pc2'), 0, w.u('e1'), false, -1); // someone else: no Advantage, nothing spent
    resolveAttack(w.cx, w.u('pc1'), 0, w.u('e1'), false, -1);
    resolveAttack(w.cx, w.u('pc1'), 0, w.u('e1'), false, -1);
    const a = evs(w, 'attack');
    expect(a[1]!.advSrc).not.toContain(VEX);
    expect(a[2]!.advSrc).toContain(VEX);
  });

  it('Graze, 20424-20430: on a miss, "damage to that creature equal to the ability modifier you used", of the weapon\'s type', () => {
    const setup = setupOf({ weapons: ['greatsword'], hands: ['greatsword', null], masteries: ['srd:greatsword'] }, [PC, foe('e1', 'wm-wall', 'C2')]);
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      act(w, w.u('pc1'), 'attack:greatsword>e1');
    }, (w) => !evs(w, 'attack')[0]!.hit);
    const d = evs(w, 'damage')[0]!;
    expect(d.dealt).toBe(3);
    expect(d.via).toBe('core:mastery-greatsword');
    expect(d.parts[0]!.type).toBe('slashing');
    expect(w.d.kinds('rider')).toEqual([]);
  });

  it('Graze at an ability modifier of 0 or less does nothing: no rider compiles', () => {
    expect(tplOf({ weapons: ['greatsword'], str: 10, masteries: ['srd:greatsword'] }).riders).toBeUndefined();
  });

  it('Slow, 20448-20453: "reduce its Speed by 10 feet until the start of your next turn"; from two attackers, "the Speed reduction doesn\'t exceed 10 feet"', () => {
    const units = [PC, { seat: 'pc2', team: 'party' as const, use: 'test:wm-pc', at: 'C3' }, foe('e1', 'wm-dummy', 'C2')];
    const setup = setupOf({ weapons: ['javelin'], hands: ['javelin', null], masteries: ['srd:javelin'] }, units);
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      resolveAttack(w.cx, w.u('pc1'), 0, w.u('e1'), false, -1);
      resolveAttack(w.cx, w.u('pc2'), 0, w.u('e1'), false, -1);
    }, (w) => evs(w, 'damage').filter((d) => d.tgt === w.u('e1').idx).length === 2);
    expect(speedOf(w.cx.st, w.u('e1'))).toBe(20);
    endTurn(w, w.u('pc1'));
    startTurn(w, w.u('pc1')); // pc1's slow ends; pc2's is still on
    expect(speedOf(w.cx.st, w.u('e1'))).toBe(20);
    startTurn(w, w.u('pc2'));
    expect(speedOf(w.cx.st, w.u('e1'))).toBe(30);
  });

  it('property: Slow never stacks, whatever number of hits', () => {
    const setup = setupOf({ weapons: ['javelin'], hands: ['javelin', null], masteries: ['srd:javelin'] });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 300 }), (n, seed) => {
        const w = world(setup, seed);
        startTurn(w, w.u('pc1'));
        for (let i = 0; i < n; i++) resolveAttack(w.cx, w.u('pc1'), 0, w.u('e1'), false, -1);
        const hit = evs(w, 'damage').some((d) => d.tgt === w.u('e1').idx);
        return speedOf(w.cx.st, w.u('e1')) === (hit ? 20 : 30);
      }),
      { numRuns: 30 },
    );
  });

  it('Cleave, 20360-20367: a hit lets it attack "a second creature within 5 feet of the first that is also within your reach", the weapon\'s damage without the ability modifier', () => {
    const units = [PC, foe('e1', 'wm-dummy', 'C2'), foe('e2', 'wm-dummy', 'C3'), foe('e3', 'wm-dummy', 'A2'), foe('e4', 'wm-dummy', 'D2')];
    const setup = setupOf({ weapons: ['greataxe'], hands: ['greataxe', null], masteries: ['srd:greataxe'] }, units);
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      act(w, w.u('pc1'), 'attack:greataxe>e1');
    }, (w) => evs(w, 'attack').length === 2 && evs(w, 'attack')[1]!.hit);
    expect(w.d.kinds('rider')[0]).toEqual(['pass', 'rider:cleave-greataxe']);
    // e2 (C3) is within 5 ft of e1 and in reach; e3 (A2) is in reach but 10 ft from e1; e4 (D2) is 5 ft from e1 but out of reach.
    expect(evs(w, 'attack')[1]!.tgt).toBe(w.u('e2').idx); // the only creature that qualifies, so no target decision
    expect(w.d.kinds('target')).toEqual([]); // review S1: e3, 10 ft from e1, was never offered
    const second = evs(w, 'damage').find((d) => d.tgt === w.u('e2').idx)!;
    expect(second.parts[0]!.rolled).toBeLessThanOrEqual(12); // 1d12, no +3
    expect(w.d.kinds('rider')).toHaveLength(1); // "only once per turn": the second hit offers no Cleave
  });

  it('Cleave still has a second creature to attack when the first one died of the hit', () => {
    const units = [PC, foe('e1', 'wm-frail', 'C2'), foe('e2', 'wm-dummy', 'C3')];
    const setup = setupOf({ weapons: ['greataxe'], hands: ['greataxe', null], masteries: ['srd:greataxe'] }, units);
    const w = seedWhere(setup, (w) => {
      startTurn(w, w.u('pc1'));
      act(w, w.u('pc1'), 'attack:greataxe>e1');
    }, (w) => evs(w, 'attack')[0]!.hit);
    expect(w.u('e1').life).toBe('dead');
    expect(evs(w, 'attack')[1]!.tgt).toBe(w.u('e2').idx);
  });

  it('property: Cleave at most once per turn over random fights', () => {
    const units = [PC, foe('e1', 'wm-dummy', 'C2'), foe('e2', 'wm-dummy', 'C3'), foe('e3', 'wm-dummy', 'B3')];
    const setup = setupOf({ weapons: ['greataxe'], hands: ['greataxe', null], masteries: ['srd:greataxe'] }, units);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), (seed) => {
        const sink = new ArraySink();
        runFight(setup, seed, 0, setup.seats.map(() => new RandomLegalDecider()), sink);
        let turn = -1;
        let n = 0;
        for (const e of sink.events) {
          if (e.k === 'turnStart') {
            turn = e.seq;
            n = 0;
          }
          if (e.k === 'act' && e.name.startsWith('Cleave') && ++n > 1) return false;
        }
        void turn;
        return true;
      }),
      { numRuns: 10 },
    );
  }, 60000);
});

describe('held-item gates and magic weapons (step 6 carry-over)', () => {
  it('shieldHeld: Shield +1 adds its AC only while a Shield is in hand', () => {
    const items = ['{ id: shield, name: Shield, kind: shield, shieldAc: 2 }'];
    const w = world(setupOf({ weapons: ['longsword'], items, hands: ['longsword', 'shield'], features: ['test:wm-shield-plus-1'] }));
    const pc = w.u('pc1');
    expect(acNow(pc, w.cx.st)).toBe(16 + 2 + 1);
    pc.hands[1] = HAND.empty;
    expect(acNow(pc, w.cx.st)).toBe(16);
  });

  it('itemHeld: a feature\'s gate looks at the item whose magic names it, in either hand', () => {
    const items = ['{ id: wand, name: Wand, kind: object, magic: test:wm-wand }'];
    const w = world(setupOf({ weapons: ['longsword'], items, hands: [null, 'wand'], features: ['test:wm-wand'] }));
    const pc = w.u('pc1');
    expect(acNow(pc, w.cx.st)).toBe(16 + 3);
    pc.hands[1] = HAND.empty;
    expect(acNow(pc, w.cx.st)).toBe(16);
    const unbound = world(setupOf({ weapons: ['longsword'], features: ['test:wm-wand'] }));
    expect(acNow(unbound.u('pc1'), unbound.cx.st)).toBe(16); // no item names it: never held
  });

  it('a magic Weapon +N: "+N bonus to attack and damage rolls made with this magic weapon" folds into that weapon only', () => {
    const tpl = tplOf({ weapons: ['plus', 'longsword'], features: ['test:wm-weapon-plus-2'] });
    const plus = tpl.attacks.find((a) => a.local === 'plus')!;
    const plain = tpl.attacks.find((a) => a.local === 'longsword')!;
    expect(plus.toHit).toBe(plain.toHit + 2);
    expect(plus.damage[0]!.avg).toBe(plain.damage[0]!.avg + 2);
    const bad = loadContent(withFiles({ ...KIT, [PC_PATH]: pcYaml({ weapons: ['plus'] }) }));
    expect(messages(bad)).toMatch(/isn't among this character's features/);
  });
});

describe('determinism', () => {
  it('a fighter with every mastery and dual Light weapons: the same seed gives the same fight, with or without a sink', () => {
    const pc: PcOpts = {
      weapons: ['shortsword', 'dagger', 'greataxe', 'maul', 'warhammer', 'javelin', 'longsword', 'greatsword'],
      hands: ['shortsword', 'dagger'],
      masteries: ['srd:shortsword', 'srd:dagger', 'srd:greataxe', 'srd:maul', 'srd:warhammer', 'srd:javelin', 'srd:longsword', 'srd:greatsword'],
    };
    const setup = setupOf(pc, [PC, foe('e1', 'wm-dummy', 'C2'), foe('e2', 'wm-dummy', 'C3'), foe('e3', 'wm-frail', 'D3')]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = runFight(setup, seed, 0, setup.seats.map(() => new RandomLegalDecider()), new ArraySink(), { audit: true });
      const b = runFight(setup, seed, 0, setup.seats.map(() => new RandomLegalDecider()), null);
      expect(b.stateHash).toBe(a.stateHash);
    }
  }, 60000);
});
