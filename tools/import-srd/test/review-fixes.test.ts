// Regression tests for the M3 step 2 review findings (docs/design/m3.md step 2 build note,
// Review): PDF species traits Foundry keeps outside trait items (F1), a class feature the PDF
// prints at two levels (F2), a subclass that grants spells only through its "<X> Spells"
// feature (F3), slot rows longer than the PDF table (F4), quarantined class grants and the
// C4 gate (LL-1), PDF stand-ins' provenance (LL-2), and generated files outside the kind
// folders (R1). Synthetic records and the committed pack; no cache, nothing under the home dir.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { classify } from '../classify.ts';
import { oursTable } from '../crosscheck.ts';
import { diffEmit, existingGenerated, itemPath } from '../emit.ts';
import { filterRecords, indexFromJson, normName } from '../filter.ts';
import { defaultId, identOf } from '../ids.ts';
import { convertFormula } from '../formula.ts';
import { pdfStubs } from '../map/class.ts';
import { mapSpecies } from '../map/species.ts';
import type { MapCtx, MapOutput } from '../map/types.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { parseRecord } from '../read.ts';
import { RemapLog } from '../remap.ts';
import { strip } from '../strip.ts';
import { U } from '../unimplemented.ts';
import { IMPORT_DIR, REPO_ROOT } from '../util.ts';
import { verifyRepo } from '../verify.ts';

const index = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const item = (kind: Parameters<typeof itemPath>[0], id: string) => parse(readFileSync(join(REPO_ROOT, itemPath(kind, id)), 'utf8')) as Record<string, unknown>;
const local = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ---- F1 -------------------------------------------------------------------------

describe('F1: every PDF species trait is carried', () => {
  const SRC = { license: 'CC-BY-4.0', book: '', rules: '2024', revision: 1, custom: '' };
  const rec = (path: string, doc: Record<string, unknown>) => parseRecord(path, stringify(doc));

  it('a PDF trait no record carries (Darkvision, in Foundry senses) becomes a narrative stub and a line', () => {
    const res = rec('packs/_source/origins24/species/traits/dwarf/res.yml', {
      _id: 'tRes000000000000',
      name: 'Dwarven Resilience',
      type: 'feat',
      system: { type: { value: 'race', subtype: '' }, source: SRC, identifier: 'dwarven-resilience', activities: {} },
    });
    const dwarf = rec('packs/_source/origins24/species/dwarf.yml', {
      _id: 'rDwarf0000000000',
      name: 'Dwarf',
      type: 'race',
      system: {
        source: SRC,
        identifier: 'dwarf',
        movement: { walk: 30 },
        senses: { darkvision: 120 },
        advancement: [
          { type: 'Size', level: 0, configuration: { sizes: ['med'] } },
          { type: 'ItemGrant', level: 0, configuration: { items: [{ uuid: `Compendium.dnd5e.origins24.Item.${res.id}`, optional: false }] } },
        ],
      },
    });
    const pdf: Partial<SrdIndex> = {
      species: [{ name: 'Dwarf', page: 84 }],
      speciesTraits: [
        { species: 'Dwarf', name: 'Darkvision', page: 84 },
        { species: 'Dwarf', name: 'Dwarven Resilience', page: 84 },
      ],
    };
    const { kept } = filterRecords([res, dwarf], indexFromJson({ classes: {}, subclasses: {}, ...pdf }));
    const byId = new Map(kept.map((k) => [k.rec.id, k]));
    const k = kept.find((x) => x.kind === 'species')!;
    const ctx = {
      kept: k,
      doc: strip(k.rec.doc),
      triggers: [],
      commit: '0'.repeat(40),
      lookup: (f: string) => byId.get(f),
      idOf: (f: string) => (byId.get(f) ? defaultId(byId.get(f)!, (x) => (byId.get(x) ? identOf(byId.get(x)!.rec.doc, byId.get(x)!.rec.name) : undefined)) : undefined),
      formula: convertFormula,
      uuid: () => undefined,
      remap: new RemapLog(),
      dropped: () => undefined,
      allKept: kept,
      pdf: pdf as SrdIndex,
    } as unknown as MapCtx;
    const out = mapSpecies(ctx) as readonly MapOutput[];
    expect(out.map((o) => o.item.id)).toEqual(['srd:dwarf', 'srd:dwarf/darkvision']);
    const sp = out[0]!;
    expect(sp.item.features).toEqual(['srd:dwarf/darkvision', 'srd:dwarf/dwarven-resilience']);
    expect(sp.unimplemented).toEqual([U.speciesTrait('darkvision')]);
    expect(classify({ ...sp.classify, unimplemented: sp.unimplemented }).fidelity).toBe('partial');
    expect(out[1]!.item).toEqual({ kind: 'feature', id: 'srd:dwarf/darkvision', name: 'Darkvision', source: 'SRD 5.2.1 p.84' });
    expect(classify({ ...out[1]!.classify, unimplemented: [] }).fidelity).toBe('narrative');
  });

  it('in the committed pack, each species carries each of its PDF traits by feature, choice or line', () => {
    for (const s of index.species) {
      const sp = item('species', `srd:${identOf({}, s.name)}`);
      const carried = new Set<string>([
        ...((sp.features as (string | { id: string })[] | undefined) ?? []).map((e) => local(typeof e === 'string' ? e : e.id)),
        ...((sp.choices as { id: string }[] | undefined) ?? []).map((c) => c.id),
        ...((sp.unimplemented as string[] | undefined) ?? []).flatMap((l) => /^(?:choice|species trait) ([a-z][a-z0-9-]*) not mapped$/.exec(l)?.[1] ?? []),
      ]);
      for (const t of index.speciesTraits.filter((x) => x.species === s.name && x.of === undefined)) {
        expect(carried.has(identOf({}, t.name.replace(/[‘’]/g, "'"))), `${s.name}: ${t.name}`).toBe(true);
      }
    }
    for (const s of ['dragonborn', 'dwarf', 'elf', 'gnome', 'orc', 'tiefling']) {
      const sp = item('species', `srd:${s}`);
      expect(sp.features, s).toContain(`srd:${s}/darkvision`);
      expect(sp.fidelity, s).toBe('partial');
    }
    expect(item('species', 'srd:dragonborn').features).toContain('srd:dragonborn/draconic-ancestry');
  });
});

// ---- F2 -------------------------------------------------------------------------

describe('F2: class features keyed on (level, name)', () => {
  const owner = parseRecord('packs/_source/classes24/barbarian/barbarian.yml', stringify({ _id: 'cBarb00000000000', name: 'Barbarian', type: 'class', system: { identifier: 'barbarian' } }));

  it('a described row whose name a grant has at another level lists that grant at the row level too', () => {
    const rows = [
      { level: 13, name: 'Improved Brutal Strike', page: 30, described: true },
      { level: 17, name: 'Improved Brutal Strike', page: 30, described: true },
      { level: 9, name: 'Brutal Strike', page: 30, described: true },
    ];
    const s = pdfStubs(owner, rows, [{ level: 13, name: 'Improved Brutal Strike', id: 'srd:barbarian/improved-brutal-strike' }], () => false);
    expect(s.entries).toEqual([
      { level: 17, id: 'srd:barbarian/improved-brutal-strike' },
      { level: 9, id: 'srd:barbarian/brutal-strike' },
    ]);
    expect(s.outputs.map((o) => o.item.id)).toEqual(['srd:barbarian/brutal-strike']);
  });

  it('in the committed pack, every described PDF class row is in class.features at its level', () => {
    const missing: string[] = [];
    for (const [cls, c] of Object.entries(index.classes)) {
      const doc = item('class', `srd:${cls}`);
      const feats = doc.features as Record<string, string[]>;
      for (const f of c.features) {
        if (f.described === false || f.name === 'Ability Score Improvement' || f.name === `${c.name} Subclass`) continue;
        const names = (feats[String(f.level)] ?? []).map((id) => normName(String(item('feature', id).name)));
        if (!names.includes(normName(f.name))) missing.push(`${cls} ${f.level} ${f.name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---- F3 -------------------------------------------------------------------------

describe('F3: subclasses with a "<Subclass> Spells" feature', () => {
  it('carry the grants-spells line (Circle of the Land included) and are not full', () => {
    const want = ['circle-of-the-land', 'draconic-sorcery', 'fiend-patron', 'life-domain', 'oath-of-devotion'];
    const got = Object.keys(index.subclasses).filter((k) => ((item('subclass', `srd:${k}`).unimplemented as string[] | undefined) ?? []).includes(U.spellGrants()));
    expect(got.sort()).toEqual(want);
    expect(item('subclass', 'srd:circle-of-the-land').fidelity).toBe('partial');
    expect((item('subclass', 'srd:evoker').unimplemented as string[] | undefined) ?? []).not.toContain(U.spellGrants()); // Sculpt Spells is not a spell grant
  });
});

// ---- F4 -------------------------------------------------------------------------

describe('F4: slot rows past the PDF columns', () => {
  const cls = (id: string) => item('class', `srd:${id}`);
  const withRow = (doc: Record<string, unknown>, level: string, f: (row: number[]) => number[]) => {
    const d = structuredClone(doc) as { scale: { slots: { at: Record<string, number[]> } } };
    d.scale.slots.at[level] = f(d.scale.slots.at[level]!);
    return d;
  };

  it('the committed rows pass', () => {
    for (const c of ['wizard', 'paladin', 'warlock']) expect(() => oursTable(cls(c), c, index)).not.toThrow();
  });

  it('fails on an extra entry in a full caster, a half caster or Pact Magic row', () => {
    expect(() => oursTable(withRow(cls('wizard'), '20', (r) => [...r, 3]), 'wizard', index)).toThrow(/wizard slots row at level 20 has 10 entries, the PDF table has 9/);
    expect(() => oursTable(withRow(cls('paladin'), '19', (r) => [...r, 0, 1]), 'paladin', index)).toThrow(/paladin slots row at level 19 has \d+ entries, the PDF table has 5/);
    expect(() => oursTable(withRow(cls('warlock'), '11', (r) => [...r, 0]), 'warlock', index)).toThrow(/warlock slots row at level 11 has 6 entries, the PDF table has 5/);
  });
});

// ---- LL-1, LL-2 -----------------------------------------------------------------

describe('LL-1 and LL-2: the Monk Unarmed Strike stand-in', () => {
  it('is not a Monk level-1 feature (the PDF Monk table has no such row)', () => {
    expect((item('class', 'srd:monk').features as Record<string, string[]>)['1']).toEqual(['srd:monk/martial-arts', 'srd:monk/unarmored-defense']);
  });

  it('has PDF provenance, naming the quarantined Foundry record only as the one it replaces', () => {
    const p = item('feature', 'srd:monk/unarmed-strike').provenance as Record<string, unknown>;
    expect(p.source).toBe('srd-pdf');
    expect(p.review).toBe('hand');
    expect(p.pdfPage).toBe(190);
    expect(p.path).toBeUndefined();
    expect((p.replaces as Record<string, unknown>).path).toBe('packs/_source/classes24/monk/class-features/unarmed-strike.yml');
  });
});

// ---- R1 -------------------------------------------------------------------------

describe('R1: generated files anywhere in the pack are the importer\'s', () => {
  function copy(): string {
    const root = mkdtempSync(join(tmpdir(), 'montecrit-r1-test-'));
    temps.push(root);
    mkdirSync(join(root, 'tools/import-srd'), { recursive: true });
    for (const f of ['pins.json', 'srd-index.json', 'review.json']) cpSync(join(IMPORT_DIR, f), join(root, 'tools/import-srd', f));
    cpSync(join(IMPORT_DIR, 'overrides'), join(root, 'tools/import-srd/overrides'), { recursive: true });
    cpSync(PACK, join(root, 'packs/srd-5.2.1'), { recursive: true });
    return root;
  }
  const dagger = readFileSync(join(PACK, 'weapons/dagger.yaml'), 'utf8');

  it('a GENERATED file outside the kind folders, or ending in .yml, is stale for --check and fails verify', () => {
    const plan = new Map(existingGenerated().map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), 'utf8')]));
    const root = copy();
    expect(diffEmit(plan, root)).toEqual({ added: [], changed: [], stale: [] });
    mkdirSync(join(root, 'packs/srd-5.2.1/extra'), { recursive: true });
    writeFileSync(join(root, 'packs/srd-5.2.1/extra/dagger-two.yaml'), dagger.replace('id: srd:dagger', 'id: srd:dagger-two'));
    writeFileSync(join(root, 'packs/srd-5.2.1/weapons/zzz.yml'), dagger);
    expect(existingGenerated(root)).toEqual(expect.arrayContaining(['packs/srd-5.2.1/extra/dagger-two.yaml', 'packs/srd-5.2.1/weapons/zzz.yml']));
    expect(diffEmit(plan, root).stale).toEqual(['packs/srd-5.2.1/extra/dagger-two.yaml', 'packs/srd-5.2.1/weapons/zzz.yml']);
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/extra\/dagger-two\.yaml: srd:dagger-two belongs at packs\/srd-5\.2\.1\/weapons\/dagger-two\.yaml/);
    expect(p).toMatch(/weapons\/zzz\.yml: srd:dagger belongs at packs\/srd-5\.2\.1\/weapons\/dagger\.yaml/);
    expect(p).toMatch(/output hash differs/);
  });
});
