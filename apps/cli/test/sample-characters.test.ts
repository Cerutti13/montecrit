// The committed sample characters (M3 step 3; docs/design/m3.md 2.6, 5, 12 and C15):
// packs/test/characters/sample-monk.yaml and sample-fighter-built.yaml, loaded the way the CLI
// loads them. The Monk's `montecrit build` text is the section 12 build golden,
// scenarios/golden/sample-monk.build.txt (a test fixture at steps 3-4, review INT-1; it moved to
// scenarios/golden at step 5a, where section 12 adds it). Regenerate it on purpose, from the repo
// root, with
//   MONTECRIT_HOME=$(mktemp -d) npx montecrit build packs/test/characters/sample-monk.yaml > scenarios/golden/sample-monk.build.txt
// and review the diff. Every test points MONTECRIT_HOME at an empty temp folder.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/character.ts';
import { REPO_ROOT } from '../src/files.ts';
import { loadKnown } from '../src/home.ts';
import { runRun } from '../src/run.ts';

const env = () => ({ MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-samples-')) });
const MONK_FILE = 'packs/test/characters/sample-monk.yaml';
const GOLDEN = join(REPO_ROOT, 'scenarios/golden/sample-monk.build.txt');
const SKILL_NAMES = ['acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception', 'history', 'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion', 'sleight-of-hand', 'stealth', 'survival'];

// The goldens this step adds (design section 12's 4-5 row), reviewed line by line in its build
// note. Any other file under scenarios/golden that git doesn't track is an unreviewed golden
// (review INT-1). Empty this list at the next step, once these are committed.
// Coverage step 7.3: entangle-escape and faerie-fire-adv (docs/design/step7-plan.md section 6).
const REVIEWED_NEW_GOLDENS: string[] = [
  'scenarios/golden/breath-cone.flag-matrix.log',
  'scenarios/golden/breath-cone.journal.yaml',
  'scenarios/golden/breath-cone.seed60.log',
  'scenarios/golden/breath-cone.yaml',
  'scenarios/golden/aura-emanation.flag-matrix.log',
  'scenarios/golden/aura-emanation.journal.yaml',
  'scenarios/golden/aura-emanation.seed2.log',
  'scenarios/golden/aura-emanation.yaml',
  'scenarios/golden/entangle-escape.flag-matrix.log',
  'scenarios/golden/entangle-escape.journal.yaml',
  'scenarios/golden/entangle-escape.seed4.log',
  'scenarios/golden/entangle-escape.yaml',
  'scenarios/golden/faerie-fire-adv.flag-matrix.log',
  'scenarios/golden/faerie-fire-adv.journal.yaml',
  'scenarios/golden/faerie-fire-adv.seed46.log',
  'scenarios/golden/faerie-fire-adv.yaml',
  // Coverage step 9: the Search demo (coverage.md, "Step 9 build note").
  'scenarios/golden/search-reveals-spikes.flag-matrix.log',
  'scenarios/golden/search-reveals-spikes.journal.yaml',
  'scenarios/golden/search-reveals-spikes.seed5.log',
  'scenarios/golden/search-reveals-spikes.yaml',
  // Coverage step 9+: the Redirect Attack and Parry demo (coverage.md, "Step 9+ build note").
  'scenarios/golden/redirect-attack.flag-matrix.log',
  'scenarios/golden/redirect-attack.journal.yaml',
  'scenarios/golden/redirect-attack.seed2.log',
  'scenarios/golden/redirect-attack.yaml',
];

describe('no unreviewed golden (design section 12; review INT-1)', () => {
  it('scenarios/golden holds no file git doesn\'t already track, except the ones this step adds and lists', () => {
    const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'scenarios/golden'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const extra = r.stdout.split('\n').filter((x) => x !== '' && !REVIEWED_NEW_GOLDENS.includes(x));
    expect(extra).toEqual([]);
  });
});

describe('test:sample-monk (design 2.6 and 5)', () => {
  it('builds clean from the committed file, and its build text equals the fixture', () => {
    const o = runBuild([join(REPO_ROOT, MONK_FILE)], env());
    expect([o.code, o.err]).toEqual([0, '']);
    // displayPath depends on the working directory; the fixture was written from the repo root, and
    // main prints the text with one more newline.
    expect(`${o.out.replace(/^File: .*$/m, `File: ${MONK_FILE}`)}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(o.out).toContain('Character lint: 0 error(s), 0 warning(s)');
  });

  it('every number has a source and every feature a fidelity', () => {
    const o = runBuild(['test:sample-monk', '--json'], env());
    expect(o.code).toBe(0);
    const j = JSON.parse(o.out) as { sheet: { pb: N; hpMax: N; ac: N; speed: N; initiative: N; extraAttacks: N; attacks: { name: string; toHit: N; damage: string }[]; pools: { name: string; max: number; why: string }[]; saves: { why: string }[]; features: { id: string; fidelity: string }[] } };
    const s = j.sheet;
    for (const n of [s.pb, s.hpMax, s.ac, s.speed, s.initiative, s.extraAttacks, ...s.attacks.map((a) => a.toHit)]) expect(n.why.length).toBeGreaterThan(0);
    for (const p of [...s.pools, ...s.saves]) expect(p.why.length).toBeGreaterThan(0);
    expect([s.pb.value, s.hpMax.value, s.ac.value, s.speed.value, s.initiative.value, s.extraAttacks.value]).toEqual([3, 51, 16, 45, 3, 1]);
    expect(s.hpMax.why).toBe('8 (L1 max d8, p.22) + 5 x 5 (fixed d8, p.23) + 6 x 2 (CON) + 6 x 1 (Dwarven Toughness, character levels)');
    // Martial Arts (step 5a, SRD 5.2.1 p.50): the 1d8 die on the Shortsword (a Monk weapon) and the Unarmed Strike, DEX for both; the Dart is ranged, so no Monk weapon.
    expect(s.attacks.map((a) => `${a.name} ${a.toHit.value} ${a.damage}`)).toEqual(['Shortsword 6 1d8 + 3 piercing', 'Dart 6 1d4 + 3 piercing', 'Unarmed Strike 6 1d8 + 3 bludgeoning (Martial Arts, @scale.monk.die at level 6)']);
    expect(s.pools.map((p) => `${p.name} ${p.max}`)).toEqual(["Monk's Focus 6", 'Uncanny Metabolism 1', 'Wholeness of Body 3']);
    expect(s.features.length).toBe(16);
    for (const f of s.features) expect(['full', 'partial', 'narrative']).toContain(f.fidelity);
  });

  it('the sheet\'s Unarmed Strike line is the compiled attack the fight uses', () => {
    const k = loadKnown(env());
    const t = k.content!.get('test:sample-monk')!;
    const sheet = k.sheets!.find((x) => x.id === 'test:sample-monk')!;
    const u = t.attacks.find((a) => a.local === 'unarmed-strike')!;
    const line = sheet.attacks.find((a) => a.id === 'unarmed-strike')!;
    expect(line.toHit.value).toBe(u.toHit);
    // With Martial Arts the line prints the dice (1d8 + 3); the compiled average is their floored mean.
    expect(line.damage.startsWith('1d8 + 3 bludgeoning')).toBe(true);
    expect(u.damage.map((d) => d.avg)).toEqual([7]);
  });

  it('drops into stars-ambush with --pc and fights with its weapons; the report lists what is not modeled', { timeout: 60_000 }, () => {
    const o = runRun(['stars-ambush', '--pc', 'pc1=test:sample-monk', '-n', '4', '--procs', '1'], env());
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toContain('--pc pc1: test:sample-monk (character file) in place of test:sample-druid; calibration: not measured for this PC');
    expect(o.out).toMatch(/test:sample-monk partial: unimplemented .*Deflect Attacks: part deflect-redirect not modeled/);
    expect(o.out).toMatch(/pc1 Shortsword +\d/);
  });
});

interface N {
  readonly value: number;
  readonly why: string;
}

describe('test:sample-fighter-built vs the hand sheet test:sample-fighter (C15: derived numbers only)', () => {
  const k = loadKnown(env());
  const hand = k.content!.get('test:sample-fighter')!;
  const built = k.content!.get('test:sample-fighter-built')!;
  const sheet = k.sheets!.find((x) => x.id === 'test:sample-fighter-built')!;

  it('loads with no errors or warnings; the hand sheet stays a kind: pc', () => {
    expect(k.errors).toEqual([]);
    expect(k.warnings.filter((w) => w.path.includes('packs/test/characters/'))).toEqual([]);
    expect(hand.kind).toBe('pc');
    expect(k.sheets!.some((x) => x.id === 'test:sample-fighter')).toBe(false);
  });

  it('PB, HP, AC, saves, extra attacks and every weapon\'s to-hit, damage and range are equal', () => {
    expect(built.pb).toBe(hand.pb);
    expect(built.hpMax).toBe(hand.hpMax);
    expect(sheet.hpMax.why).toBe('10 (L1 max d10, p.22) + 4 x 6 (fixed d10, p.23) + 5 x 2 (CON)');
    // AC: the hand sheet states 18 with no shield item; the built template is Chain Mail 16 and a
    // held Shield (+2) that the fight adds from the hand. The sheet's total is the same 18.
    expect(sheet.ac.value).toBe(hand.ac);
    const shield = built.items.find((i) => i.kind === 'shield')!;
    expect(built.ac + shield.shieldAc).toBe(hand.ac);
    expect(built.saveMod).toEqual(hand.saveMod);
    expect(built.attackAct.alts).toEqual(hand.attackAct.alts);
    const view = (t: typeof hand) => t.attacks.map((a) => [a.local, a.toHit, a.damage, a.reachFt, a.normalFt, a.longFt]);
    expect(view(built)).toEqual(view(hand));
    expect(built.initMod).toBe(hand.initMod);
    expect(built.speedFt).toBe(hand.speedFt);
  });

  it('skills differ by exactly PB where class, background, species or feat picks grant proficiency (the hand sheet lists none)', () => {
    const differ = SKILL_NAMES.filter((_, i) => built.skillMod[i] !== hand.skillMod[i]);
    expect(differ).toEqual(['acrobatics', 'athletics', 'history', 'insight', 'intimidation', 'perception', 'stealth', 'survival']);
    for (const s of differ) {
      const i = SKILL_NAMES.indexOf(s);
      expect(built.skillMod[i]! - hand.skillMod[i]!, s).toBe(built.pb);
    }
  });
});
