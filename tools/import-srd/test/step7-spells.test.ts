// Coverage step 7.3: the first spells with a Cone, Line or Cube. AREA_READINGS is a closed allowlist
// (docs/design/step7-plan.md 1.7): three spells map directly; Thunderwave, Entangle and Faerie Fire are
// reviewed overrides; anything else stays `area-shape`, Web and Disintegrate above all. Reads the
// committed pack and srd-index.json; no cache, no network, no home dir.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildImport } from '../main.ts';
import { AREA_READINGS, SPELL_PARTS } from '../map/spell.ts';
import { indexFromTuples } from '../filter.ts';
import { loadOverrides } from '../overrides.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { parseFacts, parseStat } from '../pdf/spell-details.ts';
import { loadPins } from '../pins.ts';
import type { FoundryRecord } from '../read.ts';
import { U } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Rec = Record<string, unknown>;
const PINS = loadPins();
const pack = (local: string): Rec => parse(readFileSync(join(REPO_ROOT, 'packs/srd-5.2.1/spells', `${local}.yaml`), 'utf8')) as Rec;
const exists = (local: string): boolean => {
  try {
    pack(local);
    return true;
  } catch {
    return false;
  }
};
const area = (s: Rec): Rec => (s.effects as Rec[])[0]!;
const zone = (s: Rec): Rec => area(s).zone as Rec;
const hook = (s: Rec): Rec[] => ((area(s).on as Rec[])[0]!.do as Rec[]);
const save = (s: Rec): Rec => hook(s)[0]!.save as Rec;

/** The header facts the PDF states, by hand from srd-raw.txt. */
const HEADERS: Record<string, { level: number; range: number | 'self'; v: boolean; s: boolean; m: string; concentration: boolean; duration: unknown; page: number }> = {
  'burning-hands': { level: 1, range: 'self', v: true, s: true, m: 'none', concentration: false, duration: 'instant', page: 114 }, // 24742-24748
  'cone-of-cold': { level: 5, range: 'self', v: true, s: true, m: 'focus', concentration: false, duration: 'instant', page: 117 }, // 25142-25148
  'lightning-bolt': { level: 3, range: 'self', v: true, s: true, m: 'focus', concentration: false, duration: 'instant', page: 144 }, // 28518-28525
  thunderwave: { level: 1, range: 'self', v: true, s: true, m: 'none', concentration: false, duration: 'instant', page: 169 }, // 31621-31626
  entangle: { level: 1, range: 90, v: true, s: true, m: 'none', concentration: true, duration: { minutes: 1 }, page: 128 }, // 26542-26547
  'faerie-fire': { level: 1, range: 60, v: true, s: false, m: 'none', concentration: true, duration: { minutes: 1 }, page: 129 }, // 26688-26693
  // Coverage step 7.4.
  sleep: { level: 1, range: 60, v: true, s: true, m: 'focus', concentration: true, duration: { minutes: 1 }, page: 163 }, // 30819-30826
  'color-spray': { level: 1, range: 'self', v: true, s: true, m: 'focus', concentration: false, duration: 'instant', page: 116 }, // 25014-25021
  grease: { level: 1, range: 60, v: true, s: true, m: 'focus', concentration: false, duration: { minutes: 1 }, page: 137 }, // 27635-27642
  'hypnotic-pattern': { level: 3, range: 120, v: false, s: true, m: 'focus', concentration: true, duration: { minutes: 1 }, page: 141 }, // 28129-28135
  fear: { level: 3, range: 'self', v: true, s: true, m: 'focus', concentration: true, duration: { minutes: 1 }, page: 130 }, // 26740-26747
  'charm-person': { level: 1, range: 30, v: true, s: true, m: 'none', concentration: false, duration: { minutes: 60 }, page: 115 }, // 24858-24862
};

describe('header facts match the PDF', () => {
  const idx = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as { spells: { name: string; page: number; level: number }[]; spellDetails: { name: string; stat: { components: { m: boolean; v: boolean; s: boolean }; concentration: boolean } }[] };
  for (const [local, h] of Object.entries(HEADERS)) {
    it(local, () => {
      const s = pack(local);
      expect(s.level).toBe(h.level);
      expect(s.range).toBe(h.range);
      expect(s.components).toEqual({ v: h.v, s: h.s, m: h.m });
      expect(s.concentration ?? false).toBe(h.concentration);
      expect(s.duration).toEqual(h.duration);
      expect((s.provenance as Rec).pdfPage).toBe(h.page);
      const hdr = idx.spells.find((x) => x.name === s.name)!;
      expect([hdr.level, hdr.page]).toEqual([h.level, h.page]);
      const st = idx.spellDetails.find((x) => x.name === s.name)!.stat;
      expect([st.components.v, st.components.s, st.components.m, st.concentration]).toEqual([h.v, h.s, h.m === 'focus', h.concentration]);
    });
  }
});

describe('the programs', () => {
  it('Burning Hands: 15-foot Cone, DEX, 3d6 Fire, half; upcast 1d6 (24750-24756)', () => {
    const s = pack('burning-hands');
    expect(zone(s)).toEqual({ shape: 'cone', size: 15 });
    expect(save(s)).toMatchObject({ ability: 'dex', half: true, damage: [{ roll: '3d6', type: 'fire', upcast: '1d6' }] });
  });
  it('Cone of Cold: 60-foot Cone, CON, 8d8 Cold, half; upcast 1d8 (25149-25161)', () => {
    const s = pack('cone-of-cold');
    expect(zone(s)).toEqual({ shape: 'cone', size: 60 });
    expect(save(s)).toMatchObject({ ability: 'con', half: true, damage: [{ roll: '8d8', type: 'cold', upcast: '1d8' }] });
  });
  it('Lightning Bolt: a 100-foot-long, 5-foot-wide Line, DEX, 8d6 Lightning, half; upcast 1d6 (28526-28531)', () => {
    const s = pack('lightning-bolt');
    expect(zone(s)).toEqual({ shape: 'line', size: 100, width: 5 });
    expect(AREA_READINGS['srd:lightning-bolt']!.width).toBe(5);
    expect(save(s)).toMatchObject({ ability: 'dex', half: true, damage: [{ roll: '8d6', type: 'lightning', upcast: '1d6' }] });
  });
  it('Thunderwave: a 15-foot Cube, CON, 2d8 Thunder, half; a failure pushes exactly 10 ft; upcast 1d8 (31628-31643)', () => {
    const s = pack('thunderwave');
    expect(zone(s)).toEqual({ shape: 'cube', size: 15 });
    const sv = save(s);
    expect(sv).toMatchObject({ ability: 'con', half: true, damage: [{ roll: '2d8', type: 'thunder', upcast: '1d8' }] });
    // No line lost: the push is a step, and on a failure only.
    expect(sv.onFail).toEqual([{ forcedMove: { mode: 'push', maxFt: 10, maxSize: 'gargantuan', straight: true, exact: true } }]);
    expect(sv.onSuccess ?? []).toEqual([]);
    expect((s.unimplemented as string[]).join(' ')).not.toMatch(/push(ed)? 10 feet away from you/);
  });
  it('Entangle: a 20-foot square of Difficult Terrain, not on its creator; STR, Restrained; Athletics to escape (26549-26567)', () => {
    const s = pack('entangle');
    expect(zone(s)).toEqual({ shape: 'square', size: 20, difficult: true, affects: 'notOwner' });
    const sv = save(s);
    expect(sv.ability).toBe('str');
    expect(sv.damage).toBeUndefined();
    expect(sv.onFail).toEqual([{ condition: { id: 'restrained', escape: { check: { ability: 'str', skills: ['athletics'] }, cost: 'action' } } }]);
    expect((area(s).on as Rec[])[0]!.when).toEqual(['appear']); // "in the area when you cast the spell"
  });
  it('Faerie Fire: a 20-foot Cube, DEX; a failure bears an incoming Advantage for the duration (26695-26702)', () => {
    const s = pack('faerie-fire');
    expect(zone(s)).toEqual({ shape: 'cube', size: 20 });
    const sv = save(s);
    expect(sv.ability).toBe('dex');
    expect(sv.onFail).toEqual([{ apply: { effect: 'outlined', to: 'target' } }]);
    const eff = (s.effects as Rec[]).find((e) => e.id === 'outlined')!;
    expect(eff.mods).toEqual([{ on: ['d20.attack'], side: 'incoming', op: 'adv' }]);
    expect(eff.duration).toBe('parent');
    expect((s.unimplemented as string[]).some((l) => /Dim Light/.test(l))).toBe(true);
    expect((s.unimplemented as string[]).some((l) => /Invisible/.test(l))).toBe(true);
    expect((s.unimplemented as string[]).some((l) => /see/.test(l))).toBe(true);
    expect(s.fidelity).toBe('partial');
  });
  it('every override is reviewed, with its PDF page; none is narrative', () => {
    for (const local of ['thunderwave', 'entangle', 'faerie-fire']) {
      const s = pack(local);
      expect((s.provenance as Rec).review, local).toBe('reviewed');
      expect(s.fidelity, local).not.toBe('narrative');
      expect(loadOverrides().find((o) => o.id === `srd:${local}`)?.replace, local).toBe(true);
    }
  });
});

describe('the allowlist is closed', () => {
  it('names exactly the three spells that map directly', () => {
    expect(Object.keys(AREA_READINGS).sort()).toEqual(['srd:burning-hands', 'srd:cone-of-cold', 'srd:lightning-bolt']);
  });
  it('Web and Disintegrate are not emitted (the burn clause and a misread "10-foot-Cube portion", 32232-32235 and 26076)', () => {
    expect(exists('web')).toBe(false);
    expect(exists('disintegrate')).toBe(false);
    expect(SPELL_PARTS['srd:web']).toBeUndefined();
  });

  const fSpell = (name: string, tpl: Rec, range: Rec = { units: 'self' }): FoundryRecord => {
    const doc: Rec = {
      _id: `test${name.replace(/\W/g, '')}`.slice(0, 16), name, type: 'spell', effects: [],
      system: {
        source: { license: 'CC-BY-4.0', book: '', rules: '2024' }, activation: { type: 'action', value: null }, range, duration: { value: '', units: 'inst' },
        target: { affects: { count: '', type: 'creature' }, template: tpl }, properties: ['vocal', 'somatic'], level: 1, school: 'evo',
        activities: { a: { type: 'save', activation: { type: 'action', override: false }, range: { override: false }, target: { override: false }, duration: { override: false }, effects: [], save: { ability: ['dex'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [{ number: 3, denomination: 6, bonus: '', types: ['fire'], custom: { enabled: false, formula: '' }, scaling: { mode: 'whole', number: 1 } }] } } },
      },
    };
    return { pack: 'spells24', path: `packs/_source/spells24/test/${name.toLowerCase().replace(/\W+/g, '-')}.yml`, sha256: 'a'.repeat(64), id: doc._id as string, name, type: 'spell', doc };
  };
  const stat = 'Casting Time: Action Range: Self Components: V, S Duration: Instantaneous';
  const run = (name: string, tpl: Rec, body: string) => {
    const header = { name, level: 1, school: 'Evocation', classes: ['wizard'], page: 200 };
    const detail = { name, page: 200, stat: parseStat(stat), facts: parseFacts(body) };
    const out = buildImport({
      records: [fSpell(name, tpl)], index: indexFromTuples({ spell: [[name]] }), overrides: [], pins: PINS, srdIndexSha256: 'b'.repeat(64), scope: ['spell'],
      pdfIndex: { spells: [header], spellDetails: [detail], classes: {}, subclasses: {} } as unknown as SrdIndex,
    });
    const items = [...out.plan].filter(([p]) => p.includes('/spells/')).map(([, t]) => parse(t) as Rec);
    return { items, skips: out.skips };
  };
  const body = (shape: string) => `Each creature in a ${shape} makes a Dexterity saving throw, taking 3d6 Fire damage on a failed save or half as much damage on a successful one.\nUsing a Higher-Level Spell Slot. The damage increases by 1d6 for each spell slot level above 1.`;

  it('an unlisted Cone stays area-shape, naming the skip', () => {
    const r = run('Some Other Cone', { type: 'cone', size: '15', units: 'ft' }, body('15-foot Cone'));
    expect(r.items).toEqual([]);
    expect(JSON.stringify(r.skips)).toContain('area-shape');
  });
  it('an unlisted Cube stays area-shape', () => {
    const r = run('Some Cube', { type: 'cube', size: '10', units: 'ft' }, body('10-foot Cube'));
    expect(r.items).toEqual([]);
    expect(JSON.stringify(r.skips)).toContain('area-shape');
  });
  it('a listed spell whose text reads another size or shape stays out', () => {
    for (const shape of ['20-foot Cone', '15-foot Cube']) {
      const r = run('Burning Hands', { type: 'cone', size: '15', units: 'ft' }, body(shape));
      expect(r.items, shape).toEqual([]);
    }
  });
  it('a listed Line whose Foundry width differs from the reading is pdf-text-disagrees', () => {
    const r = run('Lightning Bolt', { type: 'line', size: '100', width: '10', units: 'ft' }, body('100-foot-long, 5-foot-wide Line'));
    expect(r.items).toEqual([]);
    expect(JSON.stringify(r.skips)).toContain('pdf-text-disagrees');
  });
  it('the reading emits the listed spell from a synthetic record, with its width', () => {
    const r = run('Lightning Bolt', { type: 'line', size: '100', width: '5', units: 'ft' }, body('100-foot-long, 5-foot-wide Line'));
    expect(r.items).toHaveLength(1);
    expect(zone(r.items[0]!)).toEqual({ shape: 'line', size: 100, width: 5 });
  });
  it('the lines the readings add are closed tokens', () => {
    expect(SPELL_PARTS['srd:burning-hands']).toEqual(['ignites-flammable-objects']);
    expect(pack('burning-hands').unimplemented).toContain(U.part('ignites-flammable-objects'));
    expect(pack('cone-of-cold').unimplemented).toContain(U.part('frozen-statue'));
  });
});

describe('coverage step 7.4: the condition readings', () => {
  const stepsOf = (s: Rec): string => JSON.stringify(s);
  const monster = (local: string): Rec => parse(readFileSync(join(REPO_ROOT, 'packs/srd-5.2.1/monsters', `${local}.yaml`), 'utf8')) as Rec;

  it('Sleep: a 5-foot radius, foes, WIS twice, and Unconscious only on the second failure, both ending on damage', () => {
    const s = pack('sleep');
    expect(zone(s)).toMatchObject({ shape: 'sphere', radius: 5, affects: 'foes' });
    expect(save(s).ability).toBe('wis');
    const first = ((save(s).onFail as Rec[])[0]!.condition as Rec);
    expect(first).toMatchObject({ id: 'incapacitated', until: { until: 'endOfNextTurn', of: 'bearer' }, endsOnDamage: true });
    const repeat = first.save as Rec;
    expect(repeat).toMatchObject({ ability: 'wis', at: 'turnEnd' });
    expect((repeat.onFail as Rec[])[0]!.condition).toMatchObject({ id: 'unconscious', until: 'parent', endsOnDamage: true });
    expect(s.fidelity).toBe('partial');
    expect(stepsOf(s)).toContain('shake');
  });

  it('Sleep\'s lines say what the engine does: the choice is read as every foe, and an Unconscious immunity spares only the second stage', () => {
    const lines = pack('sleep').unimplemented as string[];
    expect(lines).not.toContain(U.part('creatures-of-your-choice'));
    expect(lines.some((l) => l.startsWith('creatures of your choice: read as every foe'))).toBe(true);
    const imm = lines.find((l) => l.includes('Immunity to Exhaustion'))!;
    expect(imm).toContain('not modeled');
    expect(imm).toContain('still Incapacitated by the first');
    expect(imm).not.toContain('only a listed Unconscious immunity is read');
  });

  it('Color Spray: a 15-foot Cone, CON, Blinded to the end of the caster\'s next turn, and a zone that lasts that long', () => {
    const s = pack('color-spray');
    expect(zone(s)).toMatchObject({ shape: 'cone', size: 15 });
    expect(area(s).duration).toEqual({ until: 'endOfNextTurn', of: 'caster' });
    expect(save(s).ability).toBe('con');
    expect((save(s).onFail as Rec[])[0]!.condition).toMatchObject({ id: 'blinded', until: { until: 'endOfNextTurn', of: 'caster' } });
    expect(s.fidelity).toBe('full');
  });

  it('Grease: a 10-foot square, Difficult Terrain, DEX or Prone on appear, enter and turn end', () => {
    const s = pack('grease');
    expect(zone(s)).toMatchObject({ shape: 'square', size: 10, difficult: true });
    expect((area(s).on as Rec[])[0]!.when).toEqual(['appear', 'enter', 'turnEndIn']);
    expect(save(s).ability).toBe('dex');
    expect((save(s).onFail as Rec[])[0]!.condition).toMatchObject({ id: 'prone' });
    expect(s.fidelity).toBe('full');
    expect(stepsOf(s)).not.toContain('lammable'); // the text says Nonflammable (27643)
  });

  it('Hypnotic Pattern: a 30-foot Cube on everyone, WIS, one compound instance ending on damage', () => {
    const s = pack('hypnotic-pattern');
    expect(zone(s)).toMatchObject({ shape: 'cube', size: 30 });
    expect(zone(s).affects).toBeUndefined();
    expect((save(s).onFail as Rec[])[0]!.condition).toMatchObject({ id: 'charmed', also: ['incapacitated'], speed: 'zero', endsOnDamage: true });
    expect(save(s).onFail).toHaveLength(1);
  });

  it('Fear: a 30-foot Cone, WIS, Frightened with the drop; the Dash and the repeat save are lines, not silence', () => {
    const s = pack('fear');
    expect(zone(s)).toMatchObject({ shape: 'cone', size: 30 });
    expect((save(s).onFail as Rec[])[0]!.condition).toMatchObject({ id: 'frightened', dropHeld: true });
    expect(stepsOf(s)).toContain('Dash');
    expect(stepsOf(s)).toContain('line of sight');
  });

  it('Charm Person: WIS with the step\'s Advantage, Charmed for an hour or until damaged; the Humanoid limit and upcast are lines', () => {
    const s = pack('charm-person');
    const step = (s.do as Rec[])[1]!.save as Rec;
    expect(step).toMatchObject({ ability: 'wis', targetAdv: true });
    expect((step.onFail as Rec[])[0]!.condition).toMatchObject({ id: 'charmed', until: { minutes: 60 }, endsOnDamage: true });
    expect(stepsOf(s)).toContain('Humanoid');
    expect(stepsOf(s)).toContain('additional target');
  });

  it('the 11 stat blocks that list it read Unconscious as an immunity, and lose the line', () => {
    for (const m of ['air-elemental', 'death-dog', 'earth-elemental', 'ettin', 'fire-elemental', 'hydra', 'shadow', 'specter', 'water-elemental', 'will-o-wisp', 'wraith']) {
      const r = monster(m);
      expect(r.conditionImmune as string[], m).toContain('unconscious');
      expect(JSON.stringify(r.unimplemented ?? []), m).not.toContain('condition immunity unconscious');
    }
  });
});
