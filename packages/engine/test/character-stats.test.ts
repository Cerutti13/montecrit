// M3 step 4: the derived sheet applies passive STAT effects that change sheet numbers
// (content/character.ts), with each source in the why string, and the PcSource leaves them to
// the fight so the fight adds each stat exactly once (its speed and AC equal the sheet's). Rules:
// Unarmored Movement (SRD 5.2.1 p.51, srd-raw.txt:11139-11144: +10/15/20 ft at Monk 2/6/10 "while
// you aren't wearing armor or wielding a Shield"), Defense (p.88, srd-raw.txt:20121: "While you're
// wearing Light, Medium, or Heavy armor, you gain a +1 bonus to Armor Class"), the Wood Elf (p.84,
// srd-raw.txt:19773: "Your Speed increases to 35 feet"). Characters are built in memory; the
// committed sample characters are left out (character.test.ts does the same).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DerivedSheet } from '../src/content/character.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { speedNow } from '../src/sim/damage.ts';
import { createContext } from '../src/sim/fight.ts';
import { acNow } from '../src/sim/hands.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { buildCounterLayout, pickFamilyNames } from '../src/sim/counters.ts';
import type { FightSetup } from '../src/sim/setup.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test').filter((f) => !f.path.startsWith('packs/test/characters/'))];
const CHAR = 'packs/test/characters/c.yaml';

interface Built {
  readonly r: LoadResult;
  readonly tpl: CompiledTemplate;
  readonly sheet: DerivedSheet;
  /** Speed and AC in a fight at its start, after the passive effects are applied. */
  readonly fight: { readonly speed: number; readonly ac: number };
  readonly setup: FightSetup;
}

function built(yaml: string): Built {
  const r = loadContent([...REPO, { path: CHAR, text: yaml }]);
  const id = /^id: (\S+)/m.exec(yaml)![1]!;
  const tpl = r.content?.get(id);
  const sheet = (r.sheets ?? []).find((s) => s.id === id);
  if (!r.content || !tpl || !sheet) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = { kind: 'scenario', id: 'st', name: 'ST', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 6, h: 3 }, units: [
    { seat: 'pc1', team: 'party', use: id, at: 'B2' },
    { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'E2' },
  ] };
  const s = resolveScenario(doc, 'st.yaml', r.content);
  if (!s.setup) throw new Error(s.errors.map(formatDiag).join('\n'));
  const cx = createContext(s.setup, 1, 0, makeDeciders(s.setup), null);
  applyPassives(cx, -1);
  const u = cx.st.units.find((x) => x.seat === 'pc1')!;
  return { r, tpl, sheet, fight: { speed: speedNow(u, cx.st), ac: acNow(u, cx.st) }, setup: s.setup };
}

const monk = (level: number, equipment = '{ weapons: [srd:shortsword] }', overrides = '') => `kind: character
id: test:stat-monk
name: Stat Monk
rules: '2024'
classes: [{ class: srd:monk, level: ${level}${level >= 3 ? ', subclass: srd:warrior-of-the-open-hand' : ''} }]
species: srd:dwarf
background: srd:soldier
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
picks:
  srd:monk#skills: [acrobatics, insight]
  srd:soldier#tools: [Gaming Set (Dice)]
  srd:soldier#abilities: { asi: { dex: 2, con: 1 } }
equipment: ${equipment}
${overrides}`;

const fighter = (style: string, equipment: string) => `kind: character
id: test:stat-fighter
name: Stat Fighter
rules: '2024'
classes: [{ class: srd:fighter, level: 1 }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:fighter#skills: [acrobatics, perception]
  srd:fighter#fighting-style: [${style}]
  srd:human#skillful: [insight]
  srd:human#versatile: [srd:skilled]
  srd:skilled#skills: [history, survival, stealth]
  srd:soldier#tools: [Gaming Set (Dice)]
equipment: ${equipment}
`;

describe('Unarmored Movement on the sheet: "Your speed increases by 10 feet ... as shown on the Monk Features table" (p.51)', () => {
  it('+10 at Monk 2, +15 at Monk 6, +20 at Monk 10 (the table column), named in the why; the fight\'s speed is the sheet\'s', () => {
    for (const [lv, ft] of [[2, 40], [6, 45], [10, 50]] as const) {
      const b = built(monk(lv));
      expect(b.sheet.speed.value).toBe(ft);
      expect(b.sheet.speed.why).toBe(`30 (Dwarf) + ${ft - 30} (Unarmored Movement: @scale.monk.unarmored-movement at level ${lv}, while unarmored and noShield)`);
      expect(b.tpl.speedFt).toBe(30); // the fight adds the stat: never twice
      expect(b.fight.speed).toBe(ft);
    }
  });

  it('a passive feature is never an option: the report\'s "options never chosen" leaves Unarmored Movement out', () => {
    const b = built(monk(6));
    const pc = b.setup.seats.findIndex((x) => x.seat === 'pc1');
    expect(b.tpl.features.some((f) => f.name === 'Unarmored Movement' && !f.activate)).toBe(true);
    expect(pickFamilyNames(buildCounterLayout(b.setup), pc)).not.toContain('Unarmored Movement');
  });

  it('a Monk 1 hasn\'t gained it: 30', () => {
    const b = built(monk(1));
    expect([b.sheet.speed.value, b.fight.speed]).toEqual([30, 30]);
  });

  it('"while you aren\'t wearing armor": in leather armor it isn\'t counted, and the why says so', () => {
    const b = built(monk(6, '{ armor: srd:leather-armor, weapons: [srd:shortsword] }'));
    expect(b.sheet.speed.value).toBe(30);
    expect(b.sheet.speed.why).toBe('30 (Dwarf); not counted: Unarmored Movement: +15 ft, while unarmored and noShield (not unarmored in this build)');
    expect(b.tpl.armor).toBe('light');
    expect(b.fight.speed).toBe(30);
  });

  it('"or wielding a Shield": with a shield in hand it isn\'t counted, on the sheet or in the fight', () => {
    const b = built(monk(6, '{ shield: true, hands: [shortsword, shield], weapons: [srd:shortsword] }'));
    expect(b.sheet.speed.value).toBe(30);
    expect(b.sheet.speed.why).toContain('(not noShield in this build)');
    // The Monk has no Shield training: the shield adds no AC but is still a shield in hand, so the
    // fight's noShield gate (sim/stats.ts holdsShield) sees it (step 4 integration fix).
    const sh = b.tpl.items.find((it) => it.local === 'shield')!;
    expect([sh.kind, sh.shieldAc]).toEqual(['shield', 0]);
    expect(b.fight.speed).toBe(30);
    expect(b.fight.ac).toBe(b.sheet.ac.value);
  });

  it('an override is the final number: the template keeps it less the stat, so the fight still equals it', () => {
    const b = built(monk(6, '{ weapons: [srd:shortsword] }', "overrides: { speed: { value: 50, why: 'house rule' } }"));
    expect(b.sheet.speed.value).toBe(50);
    expect(b.sheet.speed.override?.derived).toBe(45);
    expect(b.tpl.speedFt).toBe(35);
    expect(b.fight.speed).toBe(50);
  });

  it('the character says what it wears: armor none for an unarmored build (both armor gates read it; unknown would fail closed)', () => {
    expect(built(monk(6)).tpl.armor).toBe('none');
  });
});

describe('Defense on the sheet: "While you\'re wearing Light, Medium, or Heavy armor, you gain a +1 bonus to Armor Class" (p.88)', () => {
  it('in chain mail with a shield: 16 + 2 + 1, the +1 named; the template keeps 16 and the fight shows 19', () => {
    const b = built(fighter('srd:defense', '{ armor: srd:chain-mail, shield: true, weapons: [srd:longsword] }'));
    expect(b.sheet.ac.value).toBe(19);
    expect(b.sheet.ac.why).toBe('16 (Chain Mail, heavy) + 2 (Shield, held) + 1 (Defense, while armored)');
    expect(b.tpl.ac).toBe(16);
    expect(b.tpl.armor).toBe('heavy');
    expect(b.fight.ac).toBe(19);
  });

  it('wearing no armor it isn\'t counted: 10 + DEX, and the why says so', () => {
    const b = built(fighter('srd:defense', '{ weapons: [srd:longsword] }'));
    expect(b.sheet.ac.value).toBe(12);
    expect(b.sheet.ac.why).toBe('10 + 2 (DEX, unarmored); not counted: Defense: +1, while armored (not armored in this build)');
    expect(b.fight.ac).toBe(12);
  });

  it('another fighting style adds nothing; the Defense feat and its feature are listed full', () => {
    const gwf = built(fighter('srd:great-weapon-fighting', '{ armor: srd:chain-mail, weapons: [srd:longsword] }'));
    expect(gwf.sheet.ac.value).toBe(16);
    const def = built(fighter('srd:defense', '{ armor: srd:chain-mail, weapons: [srd:longsword] }'));
    expect(def.sheet.feats.find((f) => f.id === 'srd:defense')?.fidelity).toBe('full');
    expect(def.sheet.features.find((f) => f.id === 'srd:defense/defense')).toMatchObject({ fidelity: 'full', from: 'Defense' });
    expect(def.sheet.unimplemented.some((l) => /ac\.bonus/.test(l))).toBe(false);
  });
});

describe('the sheet lists each feature\'s step-4 fidelity', () => {
  it('a Monk 6 lists Unarmored Movement full (it was narrative until step 4) and Dwarven Resilience\'s missing save Advantage', () => {
    const b = built(monk(6));
    expect(b.sheet.features.find((f) => f.id === 'srd:monk/unarmored-movement')?.fidelity).toBe('full');
    expect(b.sheet.unimplemented).toContain('Dwarven Resilience: advantage on saves against the poisoned condition not modeled');
  });
});
