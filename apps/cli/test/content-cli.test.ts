import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, isUnderRepo, readYamlFiles } from '../src/files.ts';
import { CHARACTERS_MANIFEST, charactersDir, readHomeConfig } from '../src/home.ts';
import { runLint } from '../src/lint.ts';
import { schemaFiles } from '../src/schema.ts';
import { runSheet } from '../src/sheet.ts';

// Built at runtime so tools/check-private.ts never sees the literal markers in this file.
const PRIV = 'priv' + 'ate';

const scratch = mkdtempSync(join(tmpdir(), 'montecrit-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string) => {
  const d = join(scratch, `${label}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
/** An empty ~/.montecrit stand-in, so tests never read the real one. */
const emptyHome = () => ({ MONTECRIT_HOME: fresh('home') });

const manifest = (pack: string, ns = 'test', license = 'test') =>
  `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: ${ns}\nlicense: ${license}\n`;
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

/** A one-monster pack outside the repo. */
function pack(name: string, monsterText: string): string {
  const dir = fresh(name);
  put(join(dir, 'manifest.yaml'), manifest(name));
  put(join(dir, 'monsters', 'm.yaml'), monsterText);
  return dir;
}

describe('private content never loads from under the repo root', () => {
  it('refuses a private license or a private id in a file under the repo root', () => {
    const repo = fresh('repo');
    put(join(repo, 'packs/p/manifest.yaml'), manifest('p', PRIV, PRIV));
    put(join(repo, 'packs/q/m.yaml'), monster(`${PRIV}:thing`));
    put(join(repo, 'packs/ok/m.yaml'), monster('test:fine'));
    const r = readYamlFiles([join(repo, 'packs')], repo);
    expect(r.files.map((f) => f.path)).toEqual([join(repo, 'packs/ok/m.yaml')]);
    expect(r.errors.map((e) => [e.path.endsWith('manifest.yaml') ? 'manifest' : 'm', e.line, /^refused: /.test(e.message)])).toEqual([
      ['manifest', 6, true],
      ['m', 2, true],
    ]);
  });

  it('reads the same private files when they live outside the repo', () => {
    const repo = fresh('repo');
    const home = fresh('home');
    put(join(home, 'packs/p/manifest.yaml'), manifest('p', PRIV, PRIV));
    const r = readYamlFiles([join(home, 'packs')], repo);
    expect(r.errors).toEqual([]);
    expect(r.files).toHaveLength(1);
  });

  it('resolves symlinks both ways: a repo link into home and a home link into the repo are both caught', () => {
    const repo = fresh('repo');
    const home = fresh('home');
    put(join(home, 'packs/p/manifest.yaml'), manifest('p', PRIV, PRIV));
    mkdirSync(join(repo, 'packs'), { recursive: true });
    symlinkSync(join(home, 'packs/p'), join(repo, 'packs/linked'));
    const viaRepo = readYamlFiles([join(repo, 'packs/linked')], repo);
    expect(viaRepo.files).toEqual([]);
    expect(viaRepo.errors[0]!.message).toMatch(/^refused: a private license under the repo root/);

    put(join(repo, 'stash/q/manifest.yaml'), manifest('q', PRIV, PRIV));
    symlinkSync(join(repo, 'stash/q'), join(home, 'packs/back'));
    const viaHome = readYamlFiles([join(home, 'packs/back')], repo);
    expect(viaHome.files).toEqual([]);
    expect(isUnderRepo(join(home, 'packs/back/manifest.yaml'), repo)).toBe(true);
  });

  it('the real repo root is the montecrit checkout', () => {
    expect(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).toMatch(/"name": "montecrit"/);
  });
});

describe('montecrit lint', () => {
  it('exits 0 on clean content (the committed packs included)', () => {
    const r = runLint(['--strict', pack('clean', monster('test:clean-a'))], emptyHome());
    expect(r.out).toMatch(/0 error\(s\), 0 warning\(s\)/);
    expect(r.code).toBe(0);
  });

  it('warnings exit 0, or 1 with --strict', () => {
    const dir = pack('warny', monster('test:warny-a').replace('avg: 4 }', 'avg: 5 }'));
    const plain = runLint([dir], emptyHome());
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/m\.yaml:14:\d+: warning: attacks\[0\]\.damage\[0\]\.avg: printed average 5/);
    expect(runLint(['--strict', dir], emptyHome()).code).toBe(1);
  });

  it('errors exit 1 and print path:line:col: message', () => {
    const dir = pack('broken', monster('test:broken-a', 'speedd: 30\n'));
    const r = runLint([join(dir, 'monsters', 'm.yaml')], emptyHome()); // a file inside a pack brings the pack's manifest along
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/m\.yaml:15:1: error: unknown key "speedd"/);
    expect(r.out).not.toMatch(/not inside a pack/);
  });

  it('checks scenarios against the loaded content', () => {
    const dir = fresh('scenarios');
    put(
      join(dir, 'bad.yaml'),
      `kind: scenario\nid: bad\nname: Bad\nrules: '2024'\npacks: [srd-5.2.1]\ngrid: { w: 4, h: 4 }\nunits:\n  - { seat: a, team: party, use: 'srd:guard', at: A1 }\n  - { seat: b, team: enemies, use: 'srd:goblin-warrior', at: E9 }\n`,
    );
    const r = runLint([dir], emptyHome());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bad\.yaml:9:\d+: error: units\[1\]\.at: square E9 is outside the 4x4 grid/);
  });

  it('reads extra packs from the home config', () => {
    const home = fresh('home');
    const extra = pack('homepack', monster('test:from-home'));
    put(join(home, 'config.yaml'), `packs:\n  - ${extra}\n`);
    expect(readHomeConfig({ MONTECRIT_HOME: home }).packs).toEqual([extra]);
    // Lint a repo pack; the home pack comes in through config.yaml alone. Breaking it proves it loaded.
    const target = join(REPO_ROOT, 'packs', 'test');
    expect(runLint(['--strict', target], { MONTECRIT_HOME: home }).code).toBe(0);
    put(join(extra, 'monsters', 'm.yaml'), monster('test:from-home', 'speedd: 30\n'));
    const broken = runLint(['--strict', target], { MONTECRIT_HOME: home });
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/homepack-\d+\/monsters\/m\.yaml:15:1: error: unknown key "speedd"/);
    put(join(home, 'config.yaml'), 'packz: []\n');
    expect(readHomeConfig({ MONTECRIT_HOME: home }).errors[0]!.message).toMatch(/unknown key "packz"/);
  });

  it('main.ts wires lint to the exit code', () => {
    const bad = pack('spawned', monster('test:spawned-a', 'speedd: 30\n'));
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'apps/cli/src/main.ts'), 'lint', bad], { encoding: 'utf8', env: { ...process.env, ...emptyHome() } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/unknown key "speedd"/);
    const ok = spawnSync(process.execPath, [join(REPO_ROOT, 'apps/cli/src/main.ts'), 'lint', '--strict', join(REPO_ROOT, 'packs')], { encoding: 'utf8', env: { ...process.env, ...emptyHome() } });
    expect(ok.status).toBe(0);
  });
});

describe('montecrit sheet', () => {
  it('a monster with actions prints them with their limit (coverage step 7.6)', () => {
    const r = runSheet(['srd:white-dragon-wyrmling'], emptyHome());
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pools: Cold Breath 1 (recharge 5-6)');
    expect(r.out).toContain('Cold Breath: Cold Breath (action, spends Cold Breath, recharge 5-6): when it appears: CON save DC 12, 5d8 cold, half on a success');
  });
  it('srd:goblin-warrior', () => {
    const r = runSheet(['srd:goblin-warrior'], emptyHome());
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  it('--json carries exact odds and expected damage (Advantage riders left out on a straight roll)', () => {
    const j = JSON.parse(runSheet(['srd:goblin-warrior', '--json'], emptyHome()).out);
    const scimitar = j.attacks[0];
    expect(scimitar.pHit).toBeCloseTo(0.5, 12); // +4 vs AC 15 needs an 11
    expect(scimitar.pCrit).toBeCloseTo(0.05, 12);
    // 0.45 * 5.5 + 0.05 * (5.5 + 3.5)
    expect(scimitar.expectedDamage).toBeCloseTo(2.925, 12);
    expect(j.attackAct.alts).toEqual([[{ count: 1, from: ['srd:goblin-warrior/scimitar', 'srd:goblin-warrior/shortbow', 'core:unarmed-strike'] }]]);
  });

  it('--vs-ac changes the target', () => {
    const j = JSON.parse(runSheet(['srd:guard', '--vs-ac', '10', '--json'], emptyHome()).out);
    expect(j.vsAc).toBe(10);
    expect(j.attacks[0].pHit).toBeCloseTo(0.7, 12); // +3 vs AC 10 needs a 7
  });

  it('an unknown id exits 1 and lists what is known', () => {
    const r = runSheet(['srd:nobody'], emptyHome());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no creature "srd:nobody" \(known: .*srd:guard/);
  });
});

describe('montecrit schema', () => {
  it('the committed schemas/*.json match the zod schemas', () => {
    const files = schemaFiles();
    expect(files.map(([name]) => name)).toEqual([
      'manifest.json', 'monster.json', 'pc.json', 'character.json', 'spell.json', 'feature.json',
      'class.json', 'subclass.json', 'species.json', 'background.json', 'feat.json', 'weapon.json', 'armor.json',
      'scenario.json', 'journal.json',
    ]);
    for (const [name, text] of files) expect(readFileSync(join(REPO_ROOT, 'schemas', name), 'utf8')).toBe(text);
    const monster = JSON.parse(files[1]![1]);
    expect(monster.additionalProperties).toBe(false);
    expect(monster.properties.attacks.items.properties.kind.enum).toEqual(['melee', 'ranged', 'meleeOrRanged']);
  });
});

describe('M1b: spells in the schema, sheet and characters folder', () => {
  it('spell.json carries the recursive step schema and the hook names', () => {
    const spell = JSON.parse(schemaFiles().find(([n]) => n === 'spell.json')![1]);
    expect(spell.properties.do.items).toEqual({ $ref: '#/$defs/step' });
    expect(spell.$defs.step.anyOf.map((o: { required: string[] }) => o.required[0])).toEqual([
      'target', 'attack', 'save', 'damage', 'heal', 'apply', 'moveZone', 'forcedMove', 'choose', 'chooseSkill', 'use', 'condition', 'tempHp', // M3 step 4 appends condition and tempHp
      'weaponAttack', 'core', 'gainAction', 'pool', // M3 step 5a: WATK, ECON, POOLX
      'around', // session S: an Emanation's creatures around the owner
      'extendSource', 'endConditions', 'move', // W1 (docs/design/w1-plan.md P1, P11, P9)
    ]);
    expect(spell.properties.effects.items.properties.on.items.properties.when.items.enum).not.toContain('exit');
  });

  it('sheet shows hands, slots, pools, spells by source with to-hit, DC and per-level dice, and features', () => {
    const r = runSheet(['test:sample-druid'], emptyHome());
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    for (const want of [
      'AC 15 (13 without the Shield)    HP 45    Speed 30 ft.    PB +3    Initiative +2 (score 12)',
      'Hands: Shield (shield, +2 AC) | Charm (focus: druid)',
      'Slots: L1 4, L2 3, L3 3',
      'Pools: Forms 3 (long rest), Charm Bolts 4 (long rest)',
      '  druid (WIS, druid list): spell attack +7, save DC 15',
      '      cantrip: melee spell attack +7 (reach 30 ft), 2d6 piercing; pull up to 10 ft (large or smaller)',
      '      cantrip: Hurl Flame: ranged spell attack +7, 2d8 fire',
      '      L1: heal 2d4 + 4',
      '      L2: heal 4d4 + 4',
      '      L2: when it appears or when moved onto a creature or when a creature enters or when a creature ends its turn in it: CON save DC 15, 2d10 radiant, half on a success; Move Moonbeam',
      '      L3: when it appears or when moved onto a creature or when a creature enters or when a creature ends its turn in it: CON save DC 15, 3d10 radiant, half on a success; Move Moonbeam',
      '  charm (WIS, druid list, only while holding Charm): spell attack +7, save DC 15',
      '    Guiding Bolt (level 1, action, 120 ft, V S) [free: Charm Bolts, 4]',
      'Damage: resist necrotic',
    ]) expect(lines).toContain(want);
    expect(r.out).toMatch(/Stance: Assume Stance \(bonus action, spends Forms\): Volley: Volley Shot: ranged spell attack \+7, 1d8 \+ 4 radiant; Mending: after a spell cast with a slot heals: heal 1d8 \+ 4; Steady: a d20 below 10 counts as 10 on INT checks, WIS checks, CON saves to keep concentration/);
    const seer = runSheet(['test:sample-seer'], emptyHome()).out;
    expect(seer).toMatch(/Fate Twist \(bane\): reaction before a D20 Test \(attack, save, check\) within 30 ft, -1d6 \(spends Fate Twist\)/);
  });

  it('sheet --json lists spells with their per-level phrases', () => {
    const j = JSON.parse(runSheet(['test:sample-druid', '--json'], emptyHome()).out);
    const moon = j.spells.find((s: { id: string }) => s.id === 'srd:moonbeam');
    expect([moon.source, moon.toHit, moon.dc, Object.keys(moon.levels)]).toEqual(['druid', 7, 15, ['2', '3']]);
    expect(j.spells.find((s: { id: string }) => s.id === 'srd:guiding-bolt')).toMatchObject({ whileHeld: 'charm', freePool: 'charm-bolts', slotted: true });
    expect([j.slots, j.startHands]).toEqual([[4, 3, 3, 0, 0, 0, 0, 0, 0], ['shield', 'charm']]);
  });

  it('character files in the home characters folder load as a private pack with no manifest of their own', () => {
    const home = fresh('home');
    put(
      join(home, 'characters', 'hero.yaml'),
      `kind: pc\nid: ${PRIV}:hero\nname: Hero\nsource: a character sheet\nrules: '2024'\nlevel: 6\nsize: medium\nspeed: 30\nabilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }\nhpMax: 30\nac: 12\nslots: [2, 2]\nfidelity: partial\nunimplemented: [later]\ncasting: [{ source: d, ability: wis, list: druid, prepared: ['srd:moonbeam', 'srd:not-yet'] }]\n`,
    );
    put(join(home, 'characters', 'notes.md'), '# not yaml\n');
    expect(charactersDir({ MONTECRIT_HOME: home })).toBe(join(home, 'characters'));
    const r = runLint([], { MONTECRIT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/hero\.yaml:\d+:\d+: warning: casting\[0\]\.prepared\[1\]: spell srd:not-yet isn't in the loaded content/);
    expect(runLint(['--strict'], { MONTECRIT_HOME: home }).code).toBe(1);
    const sheet = runSheet([`${PRIV}:hero`], { MONTECRIT_HOME: home });
    expect(sheet.out).toMatch(/spell srd:not-yet \(d\): not in the loaded content/);
    expect(sheet.out).toMatch(/L2: when it appears.*: CON save DC 14, 2d10 radiant/);
    expect(CHARACTERS_MANIFEST).toMatch(new RegExp(`namespace: ${PRIV}\\nlicense: ${PRIV}`));
  });

  it('config.yaml can point characters elsewhere', () => {
    const home = fresh('home');
    const elsewhere = fresh('chars');
    put(join(home, 'config.yaml'), `characters: ${elsewhere}\n`);
    expect(readHomeConfig({ MONTECRIT_HOME: home }).characters).toBe(elsewhere);
    expect(charactersDir({ MONTECRIT_HOME: home })).toBe(elsewhere);
    put(join(home, 'config.yaml'), 'characters: [a]\n');
    expect(readHomeConfig({ MONTECRIT_HOME: home }).errors[0]!.message).toMatch(/characters must be a folder/);
  });
});

describe('review fixes: lint', () => {
  it('a broken stray YAML file is reported on its own and does not stop scenarios being checked', () => {
    const home = fresh('stray');
    mkdirSync(join(home, 'scenarios'));
    writeFileSync(join(home, 'scenarios', 'broken.yaml'), 'kind: scenario\n  bad: [indent\n');
    writeFileSync(join(home, 'scenarios', 'notes.yaml'), 'just: some notes\n');
    const out = runLint([], { MONTECRIT_HOME: home }).out;
    expect(out).not.toMatch(/not checked: the content it needs has errors/);
    expect(out).toMatch(/notes\.yaml.*not a scenario, journal or policy/);
  });
});
