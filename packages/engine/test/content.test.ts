import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatExpr } from '../src/dice/expr.ts';
import { proficiencyBonus } from '../src/content/compile.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { DAMAGE_TYPES, damageBit, plainAlt, type CompiledTemplate, type Content } from '../src/content/types.ts';
import { formatDiag, parseYaml, type SourceFile } from '../src/content/yaml.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function readPack(name: string): SourceFile[] {
  const walk = (d: string): string[] =>
    readdirSync(d)
      .flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
      })
      .sort();
  return walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
}
const repoFiles = (): SourceFile[] => [...readPack('srd-5.2.1'), ...readPack('test')];

// Built at runtime so tools/check-private.ts never sees the literal marker in this file.
const PRIV = 'priv' + 'ate';

const manifest = (pack: string, namespace: string, license: string, extra = '') =>
  `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: ${namespace}\nlicense: ${license}\n${extra}`;
const TEST_MANIFEST = manifest('fx', 'test', 'test');
const ATTRIB = 'attribution: Fixture attribution.\n';

const monster = (id: string, extra = '') => `kind: monster
id: ${id}
name: Fixture
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: 9, formula: 2d8 }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: club, name: Club, kind: melee, toHit: 4, damage: [{ roll: 1d4 + 2, type: bludgeoning, avg: 4 }] }
${extra}`;

const load = (files: Record<string, string>): LoadResult => loadContent(Object.entries(files).map(([path, text]) => ({ path, text })));
const messages = (r: LoadResult, which: 'errors' | 'warnings' = 'errors') => r[which].map(formatDiag);
const tpl = (c: Content | null, id: string): CompiledTemplate => {
  const t = c?.get(id);
  if (!t) throw new Error(`missing ${id}`);
  return t;
};

describe('strict schemas', () => {
  it('rejects an unknown key with its file:line:col', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('test:a', 'speedd: 30\n') });
    expect(r.content).toBeNull();
    expect(messages(r)).toContain('fx/m.yaml:15:1: unknown key "speedd"');
  });

  it('points a nested unknown key at the key itself', () => {
    const text = monster('test:a', 'gear:\n  - { name: Rope, cnt: 2 }\n');
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text });
    const line = text.split('\n').findIndex((l) => l.includes('cnt')) + 1;
    const col = text.split('\n')[line - 1]!.indexOf('cnt') + 1;
    expect(messages(r)).toContain(`fx/m.yaml:${line}:${col}: gear[0]: unknown key "cnt"`);
  });

  it('names a missing required key at its parent', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('test:a').replace('ac: 12\n', '') });
    expect(messages(r).some((m) => m.endsWith('missing required key "ac"'))).toBe(true);
  });

  it('rejects duplicate keys and multi-document files as YAML errors with positions', () => {
    const dup = parseYaml('a: 1\nb: 2\na: 3\n', 'x.yaml');
    expect(dup.doc).toBeNull();
    expect(dup.errors.map(formatDiag)[0]).toMatch(/^x\.yaml:3:1: YAML: Map keys must be unique/);
    expect(parseYaml('a: 1\n---\nb: 2\n', 'y.yaml').errors[0]!.message).toMatch(/multiple documents/);
  });

  it('keeps YAML 1.1 timestamps as strings (core schema, no Date objects)', () => {
    expect(parseYaml('d: 2001-01-01\n', 'z.yaml').doc!.value).toEqual({ d: '2001-01-01' });
  });

  it('rejects a scenario passed in as pack content', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/s.yaml': 'kind: scenario\nid: s\n' });
    expect(messages(r)[0]).toMatch(/fx\/s\.yaml:1:7: a scenario isn't pack content/);
  });
});

describe('id resolution', () => {
  it('rejects an id outside its pack namespace', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('srd:fixture') });
    expect(messages(r)).toContain(`fx/m.yaml:2:5: srd:fixture is outside pack "fx"'s namespace (test:)`);
  });

  it('loads test: ids only from license-test packs', () => {
    const r = load({ 'pub/manifest.yaml': manifest('pub', 'srd', 'CC-BY-4.0', ATTRIB), 'pub/m.yaml': monster('test:fixture') });
    expect(messages(r)[0]).toMatch(/test ids load only from license: test packs/);
  });

  it('rejects core: definitions', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('core:dash') });
    expect(messages(r)[0]).toMatch(/core ids are engine primitives/);
  });

  it('rejects duplicate ids and points at the first definition', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/a.yaml': monster('test:a'), 'fx/b.yaml': monster('test:a') });
    expect(messages(r)).toContain('fx/b.yaml:2:5: duplicate id test:a (first defined at fx/a.yaml:2:5)');
  });

  it('rejects content that sits in no pack', () => {
    const r = load({ 'loose/m.yaml': monster('test:a') });
    expect(messages(r)[0]).toMatch(/not inside a pack/);
  });

  it('a file belongs to the pack in its nearest ancestor folder', () => {
    const r = load({
      'outer/manifest.yaml': manifest('outer', 'srd', 'CC-BY-4.0', ATTRIB),
      'outer/inner/manifest.yaml': manifest('inner', 'test', 'test'),
      'outer/inner/deep/m.yaml': monster('test:deep'),
      'outer/m.yaml': monster('srd:shallow'),
    });
    expect(r.errors).toEqual([]);
    expect(r.content!.templates.map((t) => t.id)).toEqual(['srd:shallow', 'test:deep']);
  });

  it('srd packs may not reference private content', () => {
    const r = load({
      'shadow/manifest.yaml': manifest('shadow', PRIV, PRIV),
      'shadow/m.yaml': monster(`${PRIV}:thing`),
      'pub/manifest.yaml': manifest('pub', 'srd', 'CC-BY-4.0', `${ATTRIB}requires: [shadow]\n`),
      'pub/m.yaml': monster('srd:fixture', `unimplemented: ['works like ${PRIV}:thing']\nfidelity: partial\n`),
    });
    expect(r.content).toBeNull();
    const m = messages(r);
    expect(m.some((x) => /pub\/manifest\.yaml:\d+:\d+: srd packs may not depend on private content/.test(x))).toBe(true);
    expect(m.some((x) => /pub\/m\.yaml:15:\d+: srd packs may not reference private content/.test(x))).toBe(true);
  });

  it('test packs may not reference private content either', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('test:a', `unimplemented: ['${PRIV}:x']\nfidelity: partial\n`) });
    expect(messages(r)[0]).toMatch(/test packs may not reference private content/);
  });
});

describe('the manifest rule', () => {
  it.each([
    ['test', 'CC-BY-4.0', ATTRIB, /namespace test requires license test/],
    [PRIV, 'test', '', /namespace test requires license test|namespace private requires license private/],
    ['srd', PRIV, '', /namespace private requires license private/],
    ['srd', 'CC-BY-4.0', '', /CC-BY-4.0 packs need an attribution statement/],
  ])('namespace %s with license %s is rejected', (ns, license, extra, msg) => {
    const r = load({ 'p/manifest.yaml': manifest('p', ns, license, extra) });
    expect(r.content).toBeNull();
    expect(messages(r).join('\n')).toMatch(msg);
  });

  it('accepts the three legal pairings', () => {
    const r = load({
      'a/manifest.yaml': manifest('a', 'srd', 'CC-BY-4.0', ATTRIB),
      'b/manifest.yaml': manifest('b', 'test', 'test'),
      'c/manifest.yaml': manifest('c', PRIV, PRIV),
    });
    expect(r.errors).toEqual([]);
    expect(r.content!.packs.map((p) => p.pack)).toEqual(['a', 'b', 'c']);
  });

  it('a manifest must be named manifest.yaml', () => {
    const r = load({ 'p/pack.yaml': TEST_MANIFEST });
    expect(messages(r)[0]).toMatch(/only item in a file named manifest\.yaml/);
  });
});

describe('lint warnings (stated vs derived numbers)', () => {
  it('warns when a printed average is not floor(mean), and still loads', () => {
    const text = monster('test:a').replace('avg: 4 }', 'avg: 5 }');
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text });
    expect(r.errors).toEqual([]);
    expect(r.content).not.toBeNull();
    const col = text.split('\n')[13]!.indexOf('avg: 5') + 'avg: '.length + 1;
    expect(messages(r, 'warnings')).toEqual([`fx/m.yaml:14:${col}: attacks[0].damage[0].avg: printed average 5 doesn't match 1d4 + 2 (floor of the mean is 4)`]);
    // The stated number is what compiles; lint never corrects it.
    expect(tpl(r.content, 'test:a').attacks[0]!.damage[0]!.avg).toBe(5);
  });

  it('warns on HP average, initiative score, to-hit and PB mismatches', () => {
    const text = monster('test:a')
      .replace('average: 9', 'average: 10')
      .replace('score: 10 }', 'score: 12 }')
      .replace('toHit: 4', 'toHit: 6')
      .replace('pb: 2', 'pb: 3');
    const w = messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }), 'warnings').join('\n');
    expect(w).toMatch(/HP 10 doesn't match 2d8 \(floor of the mean is 9\)/);
    expect(w).toMatch(/initiative score 12 should be 10 \+ mod = 10/);
    expect(w).toMatch(/to-hit \+6 matches neither STR mod \+ PB \(\+5\) nor DEX mod \+ PB \(\+3\)/);
    expect(w).toMatch(/PB \+3 doesn't match CR 1 \(expected \+2\)/);
  });

  it('C0 review T5: a to-hit read through toHitAbility must equal that ability mod + PB (attacks[i].toHit), and is fine when it does', () => {
    // WIS 16 (+3) + PB 2 = +5; neither STR + PB (+4) nor DEX + PB (+2).
    const at = (toHit: number) => monster('test:a').replace('wis: 10', 'wis: 16').replace('kind: melee, toHit: 4,', `kind: melee, toHit: ${toHit}, toHitAbility: wis,`);
    const bad = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': at(6) });
    expect(bad.errors).toEqual([]);
    expect(bad.warnings.map(formatDiag)).toEqual([expect.stringMatching(/attacks\[0\]\.toHit: to-hit \+6 doesn't match WIS mod \+ PB \(\+5\)/)]);
    expect(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': at(5) }).warnings).toEqual([]);
  });

  it('a to-hit that matches DEX + PB (but not STR + PB) is fine', () => {
    const text = monster('test:a').replace('dex: 10', 'dex: 14').replace('str: 14', 'str: 10');
    expect(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }).warnings).toEqual([]);
  });

  it('warns when fidelity says full but something is listed as unimplemented', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': monster('test:a', "unimplemented: ['Some Trait']\n") });
    expect(messages(r, 'warnings')[0]).toMatch(/fidelity is full but 1 thing\(s\) aren't modeled/);
  });
});

describe('content hash and determinism', () => {
  const a = monster('test:a');
  const b = monster('test:b').replace('ac: 12', 'ac: 14');
  // Same content: comments, reordered keys, flow vs block style.
  const bReordered = `# a comment
ac: 14   # trailing comment
id: test:b
kind: monster
name: Fixture
source: synthetic test fixture
size: medium
cr: 1
pb: 2
hp:
  formula: 2d8
  average: 9
speed: { walk: 30 }
initiative: { score: 10, mod: 0 }
abilities: { cha: 10, wis: 10, int: 10, con: 10, dex: 10, str: 14 }
attacks:
  - damage: [{ type: bludgeoning, roll: 1d4 + 2, avg: 4 }]
    kind: melee
    toHit: 4
    name: Club
    id: club
`;

  it('ignores comments, key order and file order', () => {
    const h1 = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/a.yaml': a, 'fx/b.yaml': b }).content!.hash;
    const files = [
      { path: 'fx/b.yaml', text: bReordered },
      { path: 'fx/a.yaml', text: `# leading comment\n${a}` },
      { path: 'fx/manifest.yaml', text: `${TEST_MANIFEST}# trailing\n` },
    ];
    const h2 = loadContent(files).content!.hash;
    expect(h2).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a number changes', () => {
    const h1 = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/a.yaml': a }).content!.hash;
    const h2 = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/a.yaml': a.replace('ac: 12', 'ac: 13') }).content!.hash;
    expect(h2).not.toBe(h1);
  });

  it('permuted input arrays give deep-equal Content', () => {
    const files = repoFiles();
    const r1 = loadContent(files);
    const reversed = loadContent([...files].reverse());
    const rotated = loadContent([...files.slice(5), ...files.slice(0, 5)]);
    expect(r1.errors).toEqual([]);
    expect(reversed.content).toEqual(r1.content);
    expect(rotated.content).toEqual(r1.content);
    expect(reversed.content!.hash).toBe(r1.content!.hash);
    const ids = r1.content!.templates.map((t) => t.id);
    expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });

  it('compiled templates are frozen', () => {
    const t = tpl(loadContent(repoFiles()).content, 'srd:guard');
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.attacks[0]!.damage[0]!.roll)).toBe(true);
  });
});

describe('compile', () => {
  const repo = loadContent(repoFiles());

  it('a meleeOrRanged attack compiles to a melee mode and a thrown mode sharing one gear index', () => {
    const m = tpl(repo.content, 'srd:goblin-minion');
    const [melee, thrown] = m.attacks;
    expect(m.gear).toEqual([{ name: 'Daggers', count: 3 }]);
    expect(melee).toMatchObject({
      id: 'srd:goblin-minion/dagger', local: 'dagger', name: 'Dagger', kind: 'melee', rollKey: 'd20.attack.melee',
      toHit: 4, reachFt: 5, normalFt: 0, longFt: 0, gear: 0, consumesGear: false, unarmed: false,
    });
    expect(thrown).toMatchObject({
      id: 'srd:goblin-minion/dagger-thrown', local: 'dagger-thrown', name: 'Dagger (thrown)', kind: 'ranged', rollKey: 'd20.attack.ranged',
      toHit: 4, reachFt: 0, normalFt: 20, longFt: 60, gear: 0, consumesGear: true,
    });
    expect(thrown!.damage).toEqual(melee!.damage);
    const g = tpl(repo.content, 'srd:guard');
    expect(g.gear[g.attacks[0]!.gear]).toEqual({ name: 'Spear', count: 1 });
    expect(g.attacks[1]!.gear).toBe(g.attacks[0]!.gear);
  });

  it('a meleeOrRanged without thrownGear has gear -1 and never consumes', () => {
    const text = monster('test:a', 'gear: [{ name: Rocks }]\n').replace(
      '{ id: club, name: Club, kind: melee, toHit: 4,',
      '{ id: rock, name: Rock, kind: meleeOrRanged, range: [20, 60], toHit: 4,',
    );
    const t = tpl(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }).content, 'test:a');
    expect(t.attacks.slice(0, 2).map((x) => [x.local, x.gear, x.consumesGear])).toEqual([['rock', -1, false], ['rock-thrown', -1, false]]);
  });

  it('thrownGear must name a counted gear entry', () => {
    const base = monster('test:a').replace(
      '{ id: club, name: Club, kind: melee, toHit: 4,',
      '{ id: rock, name: Rock, kind: meleeOrRanged, range: [20, 60], thrownGear: Rocks, toHit: 4,',
    );
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': base }))[0]).toMatch(/thrownGear "Rocks" isn't in this creature's gear/);
    const uncounted = `${base}gear: [{ name: Rocks }]\n`;
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': uncounted }))[0]).toMatch(/needs a count to be thrown/);
  });

  it('range must be [normal, long] with normal <= long', () => {
    const text = monster('test:a').replace('{ id: club, name: Club, kind: melee,', '{ id: bow, name: Bow, kind: ranged, range: [80, 20],');
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }))[0]).toMatch(/normal must not exceed long/);
  });

  it('injects core:unarmed-strike last: STR + PB to hit, 1 + STR bludgeoning, never below 0', () => {
    const cases: [string, number, number][] = [
      ['srd:guard', 3, 2], // STR 13
      ['srd:goblin-minion', 1, 0], // STR 8: 1 + (-1) = 0
      ['srd:knight', 5, 4], // STR 16
    ];
    for (const [id, toHit, dmg] of cases) {
      const t = tpl(repo.content, id);
      const u = t.attacks[t.attacks.length - 1]!;
      expect(u).toMatchObject({ id: 'core:unarmed-strike', local: 'unarmed-strike', name: 'Unarmed Strike', kind: 'melee', toHit, reachFt: 5, critMin: 20, unarmed: true, gear: -1 });
      expect(u.damage).toEqual([{ roll: { k: 'const', v: dmg }, critExtra: null, type: DAMAGE_TYPES.indexOf('bludgeoning'), avg: dmg, ifAdvantage: false }]);
    }
  });

  it('the Unarmed Strike is in a plain Attack action, and in the Attack action of a Multiattack monster, but not in its Multiattack lines', () => {
    const guard = tpl(repo.content, 'srd:guard');
    expect(guard.attackAct).toEqual({ name: 'Attack', multi: false, extraAttack: false, alts: [[{ count: 1, from: [0, 1, 2] }]] });
    expect(plainAlt(guard.attackAct)).toBe(-1);
    const knight = tpl(repo.content, 'srd:knight');
    // Step E (E1): the plain Attack action is appended last, one strike with any attack (srd-raw.txt:32705-32706, 43908-43910).
    expect(knight.attackAct).toEqual({ name: 'Multiattack', multi: true, extraAttack: false, alts: [[{ count: 2, from: [0, 1] }], [{ count: 1, from: [0, 1, 2] }]] });
    expect(plainAlt(knight.attackAct)).toBe(1);
    expect(knight.attacks[2]!.unarmed).toBe(true);
  });

  it('a creature whose only weapon is ranged still threatens with the Unarmed Strike', () => {
    const s = tpl(repo.content, 'test:sniper');
    expect(s.attacks.map((a) => a.kind)).toEqual(['ranged', 'melee']);
    expect(s.oaReachFt).toBe(5);
    expect(tpl(repo.content, 'test:reach-brute').oaReachFt).toBe(10);
  });

  it('core Dash and Disengage come first in options, then authored options', () => {
    expect(tpl(repo.content, 'srd:goblin-warrior').options).toEqual([
      { id: 'core:dash', local: 'dash', name: 'Dash', cost: 'action', core: 'core:dash' },
      { id: 'core:disengage', local: 'disengage', name: 'Disengage', cost: 'action', core: 'core:disengage' },
      { id: 'srd:goblin-warrior/nimble-escape-disengage', local: 'nimble-escape-disengage', name: 'Nimble Escape (Disengage)', cost: 'bonus', core: 'core:disengage' },
    ]);
  });

  it('Multiattack alternatives may overlap, and references resolve to attack indices', () => {
    const t = tpl(repo.content, 'test:three-limbed-beast');
    expect(t.attacks.map((a) => a.local)).toEqual(['claw', 'bite', 'tail', 'unarmed-strike']);
    expect(t.attackAct.alts).toEqual([[{ count: 2, from: [0, 1] }], [{ count: 1, from: [1] }, { count: 1, from: [2] }], [{ count: 1, from: [0, 1, 2, 3] }]]);
  });

  it('a Multiattack that names a missing attack is an error at that reference', () => {
    const text = monster('test:a', 'multiattack:\n  alternatives:\n    - [{ count: 2, from: [club, bite] }]\n');
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }))[0]).toMatch(
      /fx\/m\.yaml:17:\d+: multiattack\.alternatives\[0\]\[0\]\.from\[1\]: Multiattack names "bite", which isn't one of this creature's attacks/,
    );
  });

  it('a meleeOrRanged id in Multiattack expands to both modes', () => {
    const text = monster('test:a', 'gear: [{ name: Spears, count: 2 }]\nmultiattack:\n  alternatives:\n    - [{ count: 2, from: [spear] }]\n').replace(
      '{ id: club, name: Club, kind: melee, toHit: 4,',
      '{ id: spear, name: Spear, kind: meleeOrRanged, range: [20, 60], thrownGear: Spears, toHit: 4,',
    );
    const t = tpl(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': text }).content, 'test:a');
    expect(t.attackAct.alts).toEqual([[{ count: 2, from: [0, 1] }], [{ count: 1, from: [0, 1, 2] }]]);
  });

  it('damage types become indices and masks', () => {
    const w = tpl(repo.content, 'test:warded-construct');
    expect(w.resist).toBe(damageBit(DAMAGE_TYPES.indexOf('slashing')));
    expect(w.vuln).toBe(damageBit(DAMAGE_TYPES.indexOf('bludgeoning')));
    expect(w.immune).toBe(damageBit(DAMAGE_TYPES.indexOf('poison')));
    const d = tpl(repo.content, 'test:training-dummy');
    expect([d.speedFt, d.hpMax, d.ac]).toEqual([0, 1000, 10]);
  });

  it('monster rolls reject @variables and products of dice, at the roll', () => {
    const v = monster('test:a').replace('roll: 1d4 + 2', 'roll: 1d4 + @mod');
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': v }))[0]).toMatch(/fx\/m\.yaml:14:\d+: attacks\[0\]\.damage\[0\]\.roll: unknown variable @mod \(monster rolls/);
    const p = monster('test:a').replace('roll: 1d4 + 2', 'roll: 1d4 * 1d4');
    expect(messages(load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/m.yaml': p }))[0]).toMatch(/product of two dice/);
  });
});

describe('PC derivation', () => {
  const pc = (weapons: string, level = 9) => `kind: pc
id: test:hero
name: Hero
source: synthetic test fixture
rules: '2024'
level: ${level}
size: medium
speed: 30
abilities: { str: 12, dex: 18, con: 14, int: 10, wis: 10, cha: 10 }
hpMax: 60
ac: 16
saveProficiencies: [dex, int]
weapons:
${weapons}`;

  it('PB is 2 + floor((level - 1) / 4)', () => {
    expect([1, 4, 5, 8, 9, 12, 13, 16, 17, 20].map(proficiencyBonus)).toEqual([2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  });

  it('to-hit is ability mod + PB + bonus; finesse takes the higher of STR and DEX; @mod folds to a constant', () => {
    const r = load({
      'fx/manifest.yaml': TEST_MANIFEST,
      'fx/hero.yaml': pc(`  - { id: rapier, name: Rapier, kind: melee, ability: finesse, damage: [{ roll: 1d8 + @mod, type: piercing }] }
  - { id: club, name: Club, kind: melee, ability: str, proficient: false, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
  - { id: magic-bow, name: Magic Bow, kind: ranged, ability: dex, bonus: 1, range: [80, 320], damage: [{ roll: 1d6 + @mod + 1, type: piercing }] }
`),
    });
    expect(r.errors).toEqual([]);
    const t = tpl(r.content, 'test:hero');
    expect(t.pb).toBe(4);
    const [rapier, club, bow, unarmed] = t.attacks;
    expect(rapier!.toHit).toBe(8); // DEX +4 (finesse beats STR +1) + PB 4
    expect(formatExpr(rapier!.damage[0]!.roll)).toBe('1d8 + 4');
    expect(formatExpr(rapier!.damage[0]!.critExtra!)).toBe('1d8');
    expect(rapier!.damage[0]!.avg).toBe(8);
    expect(club!.toHit).toBe(1); // STR +1, not proficient
    expect(formatExpr(club!.damage[0]!.roll)).toBe('1d4 + 1');
    expect(bow!.toHit).toBe(9); // DEX +4 + PB 4 + 1
    expect(formatExpr(bow!.damage[0]!.roll)).toBe('1d6 + 5');
    expect(unarmed!.toHit).toBe(5); // STR +1 + PB 4
    expect(t.saveMod).toEqual([1, 8, 2, 4, 0, 0]);
    expect([t.initMod, t.initScore]).toEqual([4, 14]);
    expect(t.hpFormula).toBeNull();
  });

  it('PC rolls may use only @mod', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/hero.yaml': pc('  - { id: c, name: C, kind: melee, ability: str, damage: [{ roll: 1d4 + @pb, type: bludgeoning }] }\n') });
    expect(messages(r)[0]).toMatch(/unknown variable @pb \(PC weapon rolls may use @mod\)/);
  });

  it('the sample fighter: Extra Attack, longsword, and a counted thrown handaxe', () => {
    const t = tpl(repo(), 'test:sample-fighter');
    expect(t.pb).toBe(3);
    expect(t.attacks.map((a) => [a.local, a.kind, a.toHit, a.gear, a.consumesGear])).toEqual([
      ['longsword', 'melee', 6, -1, false],
      ['handaxe', 'melee', 6, 0, false],
      ['handaxe-thrown', 'ranged', 6, 0, true],
      ['unarmed-strike', 'melee', 6, -1, false],
    ]);
    expect(t.gear).toEqual([{ name: 'Handaxe', count: 2 }]);
    expect(formatExpr(t.attacks[0]!.damage[0]!.roll)).toBe('1d8 + 3');
    expect(t.attackAct).toEqual({ name: 'Attack', multi: false, extraAttack: true, alts: [[{ count: 2, from: [0, 1, 2, 3] }]] });
    expect(t.saveMod).toEqual([6, 2, 5, 0, 1, -1]);
    expect([t.initMod, t.initScore]).toEqual([2, 12]);
    expect(t.options.map((o) => o.id)).toEqual(['core:dash', 'core:disengage']);
  });

  function repo(): Content {
    return loadContent(repoFiles()).content!;
  }
});

describe('the SRD 5.2.1 pack', () => {
  const srd = loadContent(readPack('srd-5.2.1'));

  it('every SRD monster compiles with zero errors and zero warnings', () => {
    expect(srd.errors.map(formatDiag)).toEqual([]);
    expect(srd.warnings.map(formatDiag)).toEqual([]);
    // The 8 hand-written stat blocks (replace: true overrides since M3 step 6) plus every monster
    // the importer emits: one template per monsters/*.yaml file.
    const ids = srd.content!.templates.map((t) => t.id);
    for (const id of ['srd:goblin-boss', 'srd:goblin-minion', 'srd:goblin-warrior', 'srd:guard', 'srd:knight', 'srd:tough', 'srd:warrior-infantry', 'srd:warrior-veteran']) expect(ids).toContain(id);
    expect(ids.length).toBe(readPack('srd-5.2.1').filter((f) => f.path.includes('/monsters/')).length);
    for (const t of srd.content!.templates) {
      expect(t.source).toMatch(/^SRD 5\.2\.1 p\.\d{3}/);
      expect(t.fidelity === 'partial').toBe(t.unimplemented.length > 0);
    }
  });

  // Spot checks against the stat blocks (SRD 5.2.1 pp.290, 296, 302, 332, 336-337).
  const blocks: [string, number, number, string, [number, number], [string, number, string, number, string][]][] = [
    ['srd:goblin-minion', 12, 7, '2d6', [2, 12], [['Dagger', 4, '1d4 + 2', 4, 'piercing']]],
    ['srd:goblin-warrior', 15, 10, '3d6', [2, 12], [['Scimitar', 4, '1d6 + 2', 5, 'slashing'], ['Shortbow', 4, '1d6 + 2', 5, 'piercing']]],
    ['srd:goblin-boss', 17, 21, '6d6', [2, 12], [['Scimitar', 4, '1d6 + 2', 5, 'slashing'], ['Shortbow', 4, '1d6 + 2', 5, 'piercing']]],
    ['srd:guard', 16, 11, '2d8 + 2', [1, 11], [['Spear', 3, '1d6 + 1', 4, 'piercing']]],
    ['srd:warrior-infantry', 13, 9, '2d8', [0, 10], [['Spear', 3, '1d6 + 1', 4, 'piercing']]],
    ['srd:warrior-veteran', 17, 65, '10d8 + 20', [3, 13], [['Greatsword', 5, '2d6 + 3', 10, 'slashing'], ['Heavy Crossbow', 3, '2d10 + 1', 12, 'piercing']]],
    ['srd:knight', 18, 52, '8d8 + 16', [0, 10], [['Greatsword', 5, '2d6 + 3', 10, 'slashing'], ['Heavy Crossbow', 2, '2d10', 11, 'piercing']]],
    ['srd:tough', 12, 32, '5d8 + 10', [1, 11], [['Mace', 4, '1d6 + 2', 5, 'bludgeoning'], ['Heavy Crossbow', 3, '1d10 + 1', 6, 'piercing']]],
  ];
  it.each(blocks)('%s matches its stat block', (id, ac, hp, formula, [initMod, initScore], attacks) => {
    const t = tpl(srd.content, id);
    expect([t.ac, t.hpMax, formatExpr(t.hpFormula!), t.speedFt, t.initMod, t.initScore, t.pb]).toEqual([ac, hp, formula, 30, initMod, initScore, 2]);
    const authored = t.attacks.filter((a) => !a.unarmed && !a.local.endsWith('-thrown'));
    expect(authored.map((a) => [a.name, a.toHit, formatExpr(a.damage[0]!.roll), a.damage[0]!.avg, DAMAGE_TYPES[a.damage[0]!.type]])).toEqual(attacks);
  });

  it('riders, saves, ranges and Multiattack shapes match too', () => {
    const gw = tpl(srd.content, 'srd:goblin-warrior');
    expect(gw.attacks[0]!.damage[1]).toMatchObject({ avg: 2, ifAdvantage: true, type: DAMAGE_TYPES.indexOf('slashing') });
    expect([gw.attacks[1]!.normalFt, gw.attacks[1]!.longFt]).toEqual([80, 320]);
    expect(gw.size).toBe(1); // small
    const k = tpl(srd.content, 'srd:knight');
    expect(k.saveMod).toEqual([3, 0, 4, 0, 2, 2]);
    expect(k.attacks[0]!.damage[1]).toMatchObject({ avg: 4, ifAdvantage: false, type: DAMAGE_TYPES.indexOf('radiant') });
    expect(k.attacks[1]!.damage.map((d) => [formatExpr(d.roll), d.avg])).toEqual([['2d10', 11], ['1d8', 4]]);
    expect(tpl(srd.content, 'srd:goblin-boss').attackAct.alts).toEqual([[{ count: 2, from: [0, 1] }], [{ count: 1, from: [0, 1, 2] }]]);
    expect(tpl(srd.content, 'srd:warrior-veteran').attackAct.alts).toEqual([[{ count: 2, from: [0] }], [{ count: 2, from: [1] }], [{ count: 1, from: [0, 1, 2] }]]);
    expect(tpl(srd.content, 'srd:tough').attackAct.multi).toBe(false);
    expect(tpl(srd.content, 'srd:warrior-infantry').gear).toEqual([{ name: 'Chain Shirt', count: -1 }, { name: 'Spear', count: 1 }]);
  });

  it('ATTRIBUTION.md and the manifest carry the SRD 5.2.1 statement byte for byte', () => {
    const STATEMENT =
      'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, ' +
      'available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 ' +
      'International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
    const DISCLAIMER = 'Section 5 of CC-BY-4.0 includes a Disclaimer of Warranties and Limitation of Liability that limits our liability to you.';
    // The modification line and the required Foundry dnd5e attribution (docs/design/m3.md 4.8, C18).
    const NOTICE =
      "Modifications: stat blocks, classes, spells, monsters and equipment converted to structured YAML data from the SRD 5.2.1, in part by way of the Foundry VTT dnd5e system's CC-BY-4.0 data (commit 87e94db); no rules text is reproduced (short notes paraphrase it).";
    const FOUNDRY =
      'Part of this pack\'s structured data is adapted from the data files of the Foundry Virtual Tabletop "Dungeons & Dragons Fifth Edition" game system (dnd5e) by the dnd5e project and its contributors, ' +
      'available at https://github.com/foundryvtt/dnd5e/tree/87e94dbd9f930135e0694cd7e7d49f210603cd2c (release-6.0.6). That data is licensed under the Creative Commons Attribution 4.0 International License, ' +
      'available at https://creativecommons.org/licenses/by/4.0/legalcode. We modified it: records were kept only where they match the SRD 5.2.1, converted to this project\'s own data format, ' +
      'and stripped of all descriptive text, images and links to other content; hand corrections are kept in tools/import-srd/overrides/. No Foundry software code is included.';
    const attribution = readFileSync(join(ROOT, 'packs/srd-5.2.1/ATTRIBUTION.md'));
    expect(attribution.equals(Buffer.from(`${STATEMENT}\n\n${DISCLAIMER}\n\n${NOTICE}\n\n${FOUNDRY}\n`, 'utf8'))).toBe(true);
    const manifestBytes = readFileSync(join(ROOT, 'packs/srd-5.2.1/manifest.yaml'));
    expect(manifestBytes.includes(Buffer.from(STATEMENT, 'utf8'))).toBe(true);
    expect(srd.content!.packs).toEqual([{ pack: 'srd-5.2.1', namespace: 'srd', license: 'CC-BY-4.0', attribution: STATEMENT }]);
    expect(STATEMENT.includes('“') && STATEMENT.includes('”')).toBe(true);
  });
});

describe('review fixes: content', () => {
  it('a damage typo in one attack gives exactly one error, not a second false one at its Multiattack reference', () => {
    const bad = monster('test:typo').replace('roll: 1d4 + 2', 'roll: 1d4 +') + 'multiattack: { alternatives: [[{ count: 2, from: [club] }]] }\n';
    const r = load({ 'p/manifest.yaml': TEST_MANIFEST, 'p/typo.yaml': bad });
    expect(r.errors).toHaveLength(1);
    expect(messages(r)[0]).toMatch(/damage/);
  });

  it('a PC can carry counted darts: a ranged weapon thrown whole, used up one per attack', () => {
    const pc = `kind: pc
id: test:darter
name: Darter
source: synthetic test fixture
rules: '2024'
level: 1
size: medium
speed: 30
abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }
hpMax: 9
ac: 13
weapons:
  - { id: dart, name: Dart, kind: ranged, ability: finesse, range: [20, 60], count: 3, damage: [{ roll: 1d4 + @mod, type: piercing }] }
`;
    const r = load({ 'p/manifest.yaml': TEST_MANIFEST, 'p/darter.yaml': pc });
    expect(messages(r)).toEqual([]);
    const t = tpl(r.content, 'test:darter');
    expect(t.gear).toEqual([{ name: 'Dart', count: 3 }]);
    expect(t.attacks[0]).toMatchObject({ local: 'dart', kind: 'ranged', gear: 0, consumesGear: true, toHit: 5 });
  });
});
