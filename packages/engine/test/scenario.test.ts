import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { Content } from '../src/content/types.ts';
import { formatDiag, parseYaml, type SourceFile } from '../src/content/yaml.ts';
import { parseCell } from '../src/grid/cells.ts';
import { DEFAULT_FLAGS } from '../src/rules/flags.ts';
import { parseJournal, parseKnobValue, resolveScenario, type ResolveResult } from '../src/scenario/resolve.ts';
import { DEFAULT_KNOBS } from '../src/sim/setup.ts';
import { fnv1a32 } from '../src/util/hash.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function readPack(name: string): SourceFile[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    });
  return walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
}
const repoFiles = (): SourceFile[] => [...readPack('srd-5.2.1'), ...readPack('test')];
const content: Content = loadContent(repoFiles()).content!;

const TERRAIN = `  terrain:
    - '........'
    - '...#....'
    - '........'
    - '........'
    - '........'
    - '........'
`;

interface Unit {
  seat: string;
  team?: string;
  use?: string;
  at: string;
  more?: string;
}
const unitYaml = (u: Unit) =>
  `  - { seat: ${u.seat}, team: ${u.team ?? 'enemies'}, use: '${u.use ?? 'srd:goblin-warrior'}', at: ${u.at}${u.more ? `, ${u.more}` : ''} }\n`;

const scenario = (units: Unit[], extra = '', packs = '[srd-5.2.1, test]') => `kind: scenario
id: skirmish
name: Skirmish
rules: '2024'
packs: ${packs}
grid:
  w: 8
  h: 6
${TERRAIN}${extra}units:
${units.map(unitYaml).join('')}`;

const BASE: Unit[] = [
  { seat: 'gob2', at: 'F2' },
  { seat: 'ally1', team: 'party', use: 'srd:guard', at: 'B3' },
  { seat: 'gob10', at: 'F4' },
  { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B4' },
];

const resolve = (text: string, c: Content = content, overrides = {}): ResolveResult => resolveScenario(text, 'sc.yaml', c, overrides);
const errs = (r: ResolveResult) => r.errors.map(formatDiag);

describe('scenario resolution', () => {
  it('orders units by seat with <, and seatKey is fnv1a32(seat)', () => {
    const r = resolve(scenario(BASE));
    expect(errs(r)).toEqual([]);
    const s = r.setup!;
    expect(s.seats.map((x) => x.seat)).toEqual(['ally1', 'gob10', 'gob2', 'pc1']); // '1' < '2', not numeric order
    for (const seat of s.seats) expect(seat.seatKey).toBe(fnv1a32(seat.seat));
    expect(s.seats.map((x) => [x.team, x.tpl.id, x.cell])).toEqual([
      [0, 'srd:guard', parseCell('B3', 8, 6)],
      [1, 'srd:goblin-warrior', parseCell('F4', 8, 6)],
      [1, 'srd:goblin-warrior', parseCell('F2', 8, 6)],
      [0, 'test:sample-fighter', parseCell('B4', 8, 6)],
    ]);
    expect(s.seats[0]).toMatchObject({ hp: null, prone: false, surprised: false, atZero: null, decider: 'baseline', fallback: null });
    expect([s.scenario, s.w, s.h, s.terrain[parseCell('D2', 8, 6)]]).toEqual(['skirmish', 8, 6, 1]);
  });

  it('rejects two seats whose stream keys collide', () => {
    expect(fnv1a32('u2wzx')).toBe(fnv1a32('ud6cd'));
    const r = resolve(scenario([{ seat: 'u2wzx', at: 'A1' }, { seat: 'ud6cd', at: 'A2' }]));
    expect(r.setup).toBeNull();
    expect(errs(r)[0]).toMatch(/seats "u2wzx" and "ud6cd" hash to the same stream key/);
  });

  it('rejects a seat used twice', () => {
    const r = resolve(scenario([{ seat: 'gob1', at: 'A1' }, { seat: 'gob1', at: 'A2' }]));
    expect(errs(r)[0]).toMatch(/sc\.yaml:18:13: units\[1\]\.seat: seat "gob1" is used twice/);
  });

  it('per-unit fields resolve: hp, prone, surprised, atZero, decider, fallback', () => {
    const units: Unit[] = [
      { seat: 'a', at: 'A1', more: 'hp: 4, prone: true, surprised: true, atZero: deathSaves, decider: journal, fallback: random-legal' },
      { seat: 'b', team: 'party', use: 'srd:guard', at: 'A3' },
    ];
    const s = resolve(scenario(units)).setup!;
    expect(s.seats[0]).toMatchObject({ hp: 4, prone: true, surprised: true, atZero: 'deathSaves', decider: 'journal', fallback: 'random-legal' });
  });
});

describe('cells', () => {
  it('rejects a square outside the grid, at the unit\'s position', () => {
    const text = scenario([{ seat: 'a', at: 'J2' }, { seat: 'b', at: 'A1' }]);
    const line = text.split('\n').findIndex((l) => l.includes('J2')) + 1;
    expect(errs(resolve(text))).toEqual([`sc.yaml:${line}:${text.split('\n')[line - 1]!.indexOf('J2') + 1}: units[0].at: square J2 is outside the 8x6 grid`]);
  });

  it('rejects a wall square and a square two units share', () => {
    const r = resolve(scenario([{ seat: 'a', at: 'D2' }, { seat: 'b', at: 'A1' }, { seat: 'c', at: 'A1' }]));
    const m = errs(r).join('\n');
    expect(m).toMatch(/units\[0\]\.at: D2 is a wall/);
    expect(m).toMatch(/units\[2\]\.at: A1 is already taken by b/);
  });

  it('rejects malformed terrain', () => {
    const text = scenario(BASE).replace("    - '...#....'\n", "    - '...#...'\n");
    expect(errs(resolve(text))[0]).toMatch(/grid\.terrain: terrain row 2 has 7 squares/);
  });
});

describe('use', () => {
  it('must resolve, must not be core:, and must come from a listed pack', () => {
    const m = errs(
      resolve(
        scenario([
          { seat: 'a', use: 'core:dash', at: 'A1' },
          { seat: 'b', use: 'srd:no-such-thing', at: 'A2' },
        ]),
      ),
    ).join('\n');
    expect(m).toMatch(/units\[0\]\.use: core:dash is an engine primitive/);
    expect(m).toMatch(/units\[1\]\.use: no creature srd:no-such-thing/);
    const onlyTest = errs(resolve(scenario(BASE, '', '[test]'))).join('\n');
    expect(onlyTest).toMatch(/srd:goblin-warrior isn't from any of this scenario's packs \(test\)/);
    expect(errs(resolve(scenario(BASE, '', '[srd-5.2.1, nope]')))[0]).toMatch(/pack "nope" isn't loaded/);
  });
});

describe('flags and knobs', () => {
  it('effective flags are defaults, then the scenario, then overrides', () => {
    const r = resolve(scenario(BASE, 'flags: { initiativeMode: static }\n'), content, { flags: { monsterHp: 'rolled' } });
    expect(r.setup!.flags).toEqual({ ...DEFAULT_FLAGS, initiativeMode: 'static', monsterHp: 'rolled' });
  });

  it('rejects unimplemented flag values from the file and from overrides', () => {
    const text = scenario(BASE, 'flags: { pauseInOccupiedSpace: true }\n');
    const r = resolve(text);
    expect(r.setup).toBeNull();
    expect(errs(r)[0]).toMatch(/sc\.yaml:\d+:\d+: flags\.pauseInOccupiedSpace: flag pauseInOccupiedSpace=true isn't implemented yet/);
    const o = resolve(scenario(BASE), content, { flags: { pauseInOccupiedSpace: true } });
    expect(errs(o)[0]).toMatch(/override: flag pauseInOccupiedSpace=true isn't implemented yet/);
  });

  it('rejects an unknown flag or an option the flag does not have', () => {
    expect(errs(resolve(scenario(BASE, 'flags: { nope: true }\n')))[0]).toMatch(/flags: unknown key "nope"/);
    expect(errs(resolve(scenario(BASE, 'flags: { monsterHp: average }\n')))[0]).toMatch(/flags\.monsterHp/);
    expect(errs(resolve(scenario(BASE), content, { flags: { monsterHp: 'average' } }))[0]).toMatch(/override: flag monsterHp must be one of listed, rolled/);
  });

  it('knob defaults apply when the block is missing or partial', () => {
    expect(resolve(scenario(BASE)).setup!.knobs).toEqual(DEFAULT_KNOBS);
    expect(resolve(scenario(BASE, 'knobs: { maxRounds: 5 }\n')).setup!.knobs).toEqual({ ...DEFAULT_KNOBS, maxRounds: 5 });
    const o = resolve(scenario(BASE, 'knobs: { lossCounts: party }\n'), content, { knobs: { downEnds: false } });
    expect(o.setup!.knobs).toEqual({ ...DEFAULT_KNOBS, lossCounts: 'party', downEnds: false });
    expect(errs(resolve(scenario(BASE), content, { knobs: { maxRounds: 0 } }))[0]).toMatch(/override: knob maxRounds/);
  });

  it('parseKnobValue parses --knob overrides', () => {
    expect(parseKnobValue('maxRounds', '7')).toEqual({ maxRounds: 7 });
    expect(parseKnobValue('downEnds', 'false')).toEqual({ downEnds: false });
    expect(parseKnobValue('attackDowned', 'always')).toEqual({ attackDowned: 'always' });
    expect(() => parseKnobValue('attackDowned', 'sometimes')).toThrow(RangeError);
    expect(() => parseKnobValue('nope', '1')).toThrow(/unknown knob/);
  });
});

describe('hashes', () => {
  const hashOf = (text: string, c: Content = content) => resolve(text, c).setup!.scenarioHash;

  it('scenarioHash ignores deciders and fallbacks', () => {
    const plain = hashOf(scenario(BASE));
    const withDeciders = scenario(BASE.map((u, i) => (i === 0 ? { ...u, more: 'decider: journal, fallback: baseline' } : { ...u, more: 'decider: random-legal' })));
    expect(hashOf(withDeciders)).toBe(plain);
    expect(plain).toMatch(/^[0-9a-f]{16}$/);
  });

  it('scenarioHash ignores unit order in the file but not the fight itself', () => {
    const plain = hashOf(scenario(BASE));
    expect(hashOf(scenario([...BASE].reverse()))).toBe(plain);
    expect(hashOf(scenario(BASE.map((u) => (u.seat === 'gob2' ? { ...u, at: 'G2' } : u))))).not.toBe(plain);
    expect(hashOf(scenario(BASE, 'flags: { initiativeMode: static }\n'))).not.toBe(plain);
    expect(hashOf(scenario(BASE, 'knobs: { maxRounds: 5 }\n'))).not.toBe(plain);
    expect(resolve(scenario(BASE), content, { flags: { corpseSpace: 'difficult' } }).setup!.scenarioHash).not.toBe(plain);
  });

  it('contentHash covers only the templates the scenario uses', () => {
    const base = resolve(scenario(BASE)).setup!;
    const extra = { path: 'packs/test/monsters/extra.yaml', text: readFileSync(join(ROOT, 'packs/test/monsters/sniper.yaml'), 'utf8').replace('test:sniper', 'test:extra') };
    const more = loadContent([...repoFiles(), extra]).content!;
    expect(more.hash).not.toBe(content.hash);
    expect(resolve(scenario(BASE), more).setup!.contentHash).toBe(base.contentHash);
    const edited = loadContent(repoFiles().map((f) => (f.path.endsWith('guard.yaml') ? { ...f, text: f.text.replace('ac: 16', 'ac: 17') } : f))).content!;
    expect(resolve(scenario(BASE), edited).setup!.contentHash).not.toBe(base.contentHash);
  });

  it('an already-parsed object resolves to the same setup as its YAML text', () => {
    const text = scenario(BASE);
    const fromText = resolve(text).setup!;
    const fromObject = resolveScenario(parseYaml(text, 'x').doc!.value, 'sc.yaml', content).setup!;
    expect(fromObject.scenarioHash).toBe(fromText.scenarioHash);
    expect(fromObject.seats.map((s) => s.seat)).toEqual(fromText.seats.map((s) => s.seat));
  });
});

describe('journals', () => {
  const journal = `kind: journal
scenario: skirmish
seed: 7
engine: '0.1.0'
contentHash: 0123456789abcdef
entries:
  - { seat: pc1, key: 'move:F3', at: 0 }
  - { seat: gob2, key: 'attack:scimitar' }
`;

  it('parses entries {seat, key, at?}', () => {
    const r = parseJournal(journal, 'j.yaml');
    expect(r.errors).toEqual([]);
    expect(r.journal).toMatchObject({ scenario: 'skirmish', seed: 7, run: 0, entries: [{ seat: 'pc1', key: 'move:F3', at: 0 }, { seat: 'gob2', key: 'attack:scimitar' }] });
  });

  it('rejects unknown and missing keys with positions', () => {
    const r = parseJournal(journal.replace('seed: 7\n', '').replace("at: 0 }", 'at: 0, why: x }'), 'j.yaml');
    expect(r.journal).toBeNull();
    const m = r.errors.map(formatDiag).join('\n');
    expect(m).toMatch(/j\.yaml:1:1: missing required key "seed"/);
    expect(m).toMatch(/j\.yaml:6:\d+: entries\[0\]: unknown key "why"/);
  });
});
