// M3 step 5a, content (docs/design/m3.md section 5): the imported SRD Monk, through the reviewed
// overrides in tools/import-srd/overrides/feature/{monk,warrior-of-the-open-hand}/ and
// content/character.ts's Martial Arts block, compiles to the primitives the engine parts built and
// plays them in a fight. Every test is named for the rule text it checks, with its line in the
// SRD 5.2.1 PDF text (srd-raw.txt). The character is the committed test:sample-monk (Monk 6,
// Open Hand, DEX 16, WIS 16); variants are built in memory under packs/test/characters/.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSheet, type DerivedSheet } from '../src/content/character.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider } from '../src/decide/decider.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';

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
const MONK_FILE = 'packs/test/characters/sample-monk.yaml';
const MONK_TEXT = REPO.find((f) => f.path === MONK_FILE)!.text;
const withFiles = (extra: Record<string, string>): SourceFile[] => [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
const messages = (r: LoadResult) => r.errors.map(formatDiag).join('\n');

function load(extra: Record<string, string> = {}): { content: Content; r: LoadResult } {
  const r = loadContent(withFiles(extra));
  if (!r.content) throw new Error(messages(r));
  return { content: r.content, r };
}
const BASE = load();
const MONK = BASE.content.get('test:sample-monk')!;
const sheetOf = (r: LoadResult, id: string): DerivedSheet => (r.sheets ?? []).find((s) => s.id === id)!;

/** The sample Monk with some lines of its file replaced (an in-memory variant, id test:monk-variant). */
function variant(edit: (yaml: string) => string): { tpl: CompiledTemplate; sheet: DerivedSheet; r: LoadResult } {
  const yaml = edit(MONK_TEXT).replace('id: test:sample-monk', 'id: test:monk-variant');
  const { content, r } = load({ 'packs/test/characters/monk-variant.yaml': yaml });
  return { tpl: content.get('test:monk-variant')!, sheet: sheetOf(r, 'test:monk-variant'), r };
}
const feat = (tpl: CompiledTemplate, local: string) => tpl.features.find((f) => f.local === local || f.id.endsWith(`/${local}`))!;
const atk = (tpl: CompiledTemplate, local: string) => tpl.attacks.find((a) => a.local === local)!;
/** The compiled average (floored, as stat blocks print it): 1d8 + 3 is 7, 1d6 + 3 is 6, 1d4 + 3 is 5. */
const avg = (tpl: CompiledTemplate, local: string): number => atk(tpl, local).damage.reduce((n, d) => n + d.avg, 0);
/** The res index the Flurry of Blows activation spends (Monk's Focus). */
const focusRes = (tpl: CompiledTemplate): number => feat(tpl, 'monks-focus').activate!.pool;

describe('the Monk compiles from the imported features (docs/design/m3.md section 5)', () => {
  it('Martial Arts, 11088: "You can make an Unarmed Strike as a Bonus Action", gated on unarmored and noShield', () => {
    const f = feat(MONK, 'martial-arts');
    expect(f.activate).not.toBeNull();
    expect(f.activate!.cost).toBe('bonus');
    expect(f.activate!.steps.map((s) => s.k)).toEqual(['weaponAttack']);
    expect(JSON.stringify(f.activate!.when)).toContain('unarmored');
    expect(JSON.stringify(f.activate!.when)).toContain('noShield');
  });

  it('Martial Arts die and Dexterous Attacks, 11089-11097: the Unarmed Strike is 1d8 + DEX at Monk 6, +6 to hit', () => {
    const u = atk(MONK, 'unarmed-strike');
    expect(u.toHit).toBe(6); // DEX 3 + PB 3
    expect(avg(MONK, 'unarmed-strike')).toBe(7); // 1d8 + 3
  });

  it('Monk weapons, 11075-11085, take the Martial Arts die "in place of the normal damage": the Shortsword is 1d8 + 3; the Dart (ranged) keeps 1d4 + 3', () => {
    expect(avg(MONK, 'shortsword')).toBe(7); // 1d8 + 3
    expect(avg(MONK, 'dart')).toBe(5); // 1d4 + 3
  });

  it("Monk's Focus, 11126-11137: Flurry of Blows (1 point, two Unarmed Strikes), Patient Defense and Step of the Wind with and without the point", () => {
    const f = feat(MONK, 'monks-focus');
    const acts = [f.activate!, ...(f.more ?? [])];
    expect(acts.map((a) => a.local)).toEqual(['flurry', 'patient', 'patient-focus', 'wind', 'wind-focus']);
    expect(acts.map((a) => a.cost)).toEqual(['bonus', 'bonus', 'bonus', 'bonus', 'bonus']);
    const focus = focusRes(MONK);
    expect(focus).toBeGreaterThanOrEqual(0);
    expect(acts.map((a) => a.pool === focus)).toEqual([true, false, true, false, true]);
    expect(acts.map((a) => a.steps.map((s) => (s.k === 'core' ? `core:${s.act}` : s.k)))).toEqual([
      ['weaponAttack'],
      ['core:disengage'],
      ['core:disengage', 'core:dodge'],
      ['core:dash'],
      ['core:disengage', 'core:dash'],
    ]);
  });

  it('Uncanny Metabolism, 11146-11152: an initiative hook spending its once-per-Long-Rest pool, refilling Focus and healing', () => {
    const f = feat(MONK, 'uncanny-metabolism');
    expect(f.onInit).toBeDefined();
    expect(f.onInit!.steps.map((s) => s.k)).toEqual(['pool', 'heal']);
  });

  it('Deflect Attacks, 11156-11159: a hitTaken reaction only for Bludgeoning, Piercing or Slashing damage', () => {
    const f = feat(MONK, 'deflect-attacks');
    expect(f.hitTaken).toBeDefined();
    expect(f.hitTaken!.types).not.toBe(0);
  });

  it('Stunning Strike, 11203-11205: "Once per turn when you hit ... with a Monk weapon or an Unarmed Strike", 1 Focus Point (oncePerTurn global, C1)', () => {
    const r = MONK.riders!.find((x) => x.local === 'stunning-strike')!;
    expect(r.on).toBe('hit');
    expect(r.once).toBe('global');
    expect(r.pool).toBe(focusRes(MONK));
    const idx = MONK.riders!.indexOf(r);
    expect(atk(MONK, 'unarmed-strike').onHit).toContain(idx);
    expect(atk(MONK, 'shortsword').onHit).toContain(idx); // Martial, Light, melee
    expect(atk(MONK, 'dart').onHit ?? []).not.toContain(idx); // ranged: not a Monk weapon
  });

  it('Open Hand Technique, 11312-11319: "an attack granted by your Flurry of Blows", one of Addle, Push or Topple', () => {
    const r = MONK.riders!.find((x) => x.local === 'open-hand-technique')!;
    expect(r.grantedBy).toBe('flurry');
    expect(r.once).toBeUndefined(); // "Whenever"
    expect(r.chooses).toBe(true);
    expect(r.opts.map((o) => o.local)).toEqual(['addle', 'push', 'topple']);
  });

  it('Empowered Strikes, 11214-11216: a passive force damage type on the Unarmed Strike', () => {
    const f = feat(MONK, 'empowered-strikes');
    expect(f.passive?.length).toBe(1);
  });

  it('Wholeness of Body is full on the sheet now that an activation can target its user only', () => {
    const f = BASE.r.sheets!.find((s) => s.id === 'test:sample-monk')!.features.find((x) => x.id.endsWith('/wholeness-of-body'))!;
    expect(f.fidelity).toBe('full');
    expect(f.unimplemented ?? []).not.toContain('needs engine support: self-target');
  });
});

describe('content/character.ts Martial Arts: "while you are unarmed or wielding only Monk weapons and you aren\'t wearing armor or wielding a Shield", 11087', () => {
  it('in armor the Unarmed Strike is the glossary one again (1 + STR, STR + PB) and the sheet says why', () => {
    const v = variant((y) => y.replace('armor: null', 'armor: srd:leather-armor'));
    expect(atk(v.tpl, 'unarmed-strike').toHit).toBe(3);
    expect(avg(v.tpl, 'unarmed-strike')).toBe(1);
    expect(avg(v.tpl, 'shortsword')).toBe(6); // 1d6 + 3
    expect(v.r.warnings.map(formatDiag).join('\n')).toContain('Martial Arts gives no benefits while wearing');
  });

  it('"or wielding a Shield": with a Shield in hand the Unarmed Strike is the glossary one again (1 + STR) and the sheet says why', () => {
    const v = variant((y) => y.replace('shield: false', 'shield: true').replace('hands: [shortsword, null]', 'hands: [shortsword, shield]'));
    expect(atk(v.tpl, 'unarmed-strike').toHit).toBe(3);
    expect(avg(v.tpl, 'unarmed-strike')).toBe(1);
    expect(v.r.warnings.map(formatDiag).join('\n')).toContain('Martial Arts gives no benefits while wielding a Shield');
  });

  it('a non-Monk weapon in hand turns the benefits off, and the still-offered bonus strike is listed as not modeled', () => {
    const v = variant((y) => y.replace('weapons: [srd:shortsword,', 'weapons: [srd:shortsword, srd:longsword,').replace('hands: [shortsword, null]', 'hands: [shortsword, longsword]'));
    expect(avg(v.tpl, 'unarmed-strike')).toBe(1);
    expect(v.sheet.unimplemented.some((l) => l.startsWith('Martial Arts: its Bonus Unarmed Strike is still offered'))).toBe(true);
  });

  it('a Simple Melee weapon without Finesse gets DEX and the die: a Quarterstaff (1d6) at Monk 6 is 1d8 + 3, +6 to hit', () => {
    const v = variant((y) => y.replace('weapons: [srd:shortsword,', 'weapons: [srd:quarterstaff, srd:shortsword,'));
    const q = atk(v.tpl, 'quarterstaff');
    expect(q.toHit).toBe(6);
    expect(avg(v.tpl, 'quarterstaff')).toBe(7); // 1d8 + 3
    expect(v.sheet.attacks.find((a) => a.id === 'quarterstaff')!.notes.join(' ')).toContain('DEX for attack and damage');
  });

  it('"can roll ... in place of": a weapon whose own die is larger keeps it (a Monk 1 with a 1d6 die and a Spear, 1d6: tie keeps the weapon)', () => {
    const v = variant((y) => y.replace('level: 6, subclass: srd:warrior-of-the-open-hand', 'level: 1').replace(/^picks:\n(?:  .*\n)+/m, 'picks:\n  srd:monk#skills: [acrobatics, insight]\n  srd:soldier#abilities: { asi: { dex: 2, con: 1 } }\n  srd:soldier#tools: [Gaming Set (Dice)]\n').replace('weapons: [srd:shortsword,', 'weapons: [srd:spear, srd:shortsword,'));
    expect(v.sheet.attacks.find((a) => a.id === 'spear')!.damage).toBe('1d6 + 3 piercing');
    expect(v.sheet.attacks.find((a) => a.id === 'spear')!.notes.some((n) => n.includes('in place of'))).toBe(false);
    expect(avg(v.tpl, 'unarmed-strike')).toBe(6); // 1d6 + 3 at Monk 1
  });

  it('the sheet lists every option with its cost and source, and which options spend each pool; the text is deterministic', () => {
    const s = sheetOf(BASE.r, 'test:sample-monk');
    expect(s.options.map((o) => `${o.kind}:${o.name}`)).toEqual([
      'reaction:Deflect Attacks',
      'activation:Bonus Unarmed Strike',
      'activation:Flurry of Blows',
      'activation:Patient Defense',
      'activation:Patient Defense (Focus)',
      'activation:Step of the Wind',
      'activation:Step of the Wind (Focus)',
      'rider:Stunning Strike',
      'initiative:Uncanny Metabolism',
      'rider:Open Hand Technique',
      'activation:Wholeness of Body',
    ]);
    expect(s.pools.find((p) => p.id === 'monks-focus')!.spentBy).toEqual(['Flurry of Blows', 'Patient Defense (Focus)', 'Step of the Wind (Focus)', 'Stunning Strike']);
    expect(renderSheet(s)).toBe(renderSheet(sheetOf(load().r, 'test:sample-monk')));
  });
});

describe('the Monk plays its features in a fight', () => {
  /** Takes Flurry of Blows (else attacks), uses every rider (its last option), Deflect and the initiative hook. */
  const scripted: Decider = {
    name: 'monk-script',
    decide(_v, dp) {
      const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
      if (dp.k === 'turn') {
        const want = ['use:monk/monks-focus/flurry'].map((k) => keys.indexOf(k)).find((i) => i >= 0);
        if (want !== undefined) return want;
        const a = keys.findIndex((k) => k.startsWith('attack:'));
        return a >= 0 ? a : 0;
      }
      if (dp.k === 'rider' || dp.k === 'hitTaken' || dp.k === 'pick') return keys.length - 1;
      return 0;
    },
  };
  function fight(seed: number): GameEvent[] {
    const doc = {
      kind: 'scenario',
      id: 'monk-lab',
      name: 'Monk lab',
      rules: '2024',
      packs: ['srd-5.2.1', 'test'],
      grid: { w: 6, h: 4 },
      units: [
        { seat: 'pc1', team: 'party', use: 'test:sample-monk', at: 'B2' },
        { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' },
      ],
    };
    const r = resolveScenario(doc, 'monk-lab.yaml', BASE.content, {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    const sink = new ArraySink();
    runFight({ ...r.setup, knobs: { ...r.setup.knobs, maxRounds: 3 } }, seed, 0, r.setup.seats.map(() => scripted), sink);
    return sink.events;
  }
  const names = (es: GameEvent[]) => es.filter((e): e is Extract<GameEvent, { k: 'act' }> => e.k === 'act').map((e) => e.name);

  it('Uncanny Metabolism is offered at initiative, and Flurry of Blows, Stunning Strike and Open Hand Technique fire against an adjacent target', () => {
    const all = [1, 2, 3, 4, 5].flatMap((s) => names(fight(s)));
    expect(all).toContain('Uncanny Metabolism');
    expect(all).toContain('Flurry of Blows');
    expect(all).toContain('Stunning Strike');
    expect(all.some((n) => n.startsWith('Open Hand Technique'))).toBe(true);
  });

  it('the same seed gives the same events (determinism)', () => {
    expect(JSON.stringify(fight(2))).toBe(JSON.stringify(fight(2)));
  });
});
