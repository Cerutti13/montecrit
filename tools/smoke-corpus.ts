// The M3 step-6 smoke corpus (docs/design/m3.md, build order step 6 and C22): 12 classes x levels
// 1, 3, 5, 6 and 10, generated deterministically from the SRD pack itself, so it follows the
// importer: a class's picks, its subclass, its spell counts and the spells on its list come from
// the data that the build would read. Since C0 (docs/design/coverage.md section 4) the species,
// background, gear, named picks and spell preferences come from the curated table in
// tools/class-picks.ts (shared with tools/bench-classes.ts); the rest is the first-legal rule.
// Every generated text is scanned for private names before it's loaded (L1, fail closed), and
// every fight carries the loop-health trace (tools/bench-trace.ts). Nothing is written to packs/: the 60 files exist in memory
// under packs/test/characters/smoke/ paths with test: ids. Each one is built, linted and run
// against a scratch scenario of SRD monsters sized to its level (not calibrated; win rates are
// for reading, not for asserting).
//
//   smokeCorpus(files, spells)     the 60 characters (two passes: the second fills casting
//                                  from the first pass's derived sheet)
//   runSmoke(files, corpus, n)     build + lint + n fights each; one row per character
//   renderSmoke(rows)              the 60-row summary

import { parse } from 'yaml';
import { buildNeeds, characterLib, type BackgroundSrc, type ClassSrc, type SpeciesSrc, type SubclassSrc } from '../apps/cli/src/character.ts';
import { formatDiag, loadContent, makeDeciders, resolveScenario, runFight, type DerivedSheet, type SourceFile } from '../packages/engine/src/index.ts';
import type { CharacterLib } from '../packages/engine/src/index.ts';
import { assertNoPrivate, COMBAT_RELEVANT, CURATED, curatedText, NON_COMBAT, PICK_CLASSES, PICK_LEVELS, THRESHOLDS, type Ability, type PickClass } from './class-picks.ts';
import { addFight, causeText, dodgeShare, itemsPerFight, neverActs, newLoopHealth, stalemateCause, TraceSink, type LoopHealth } from './bench-trace.ts';

export const SMOKE_LEVELS = PICK_LEVELS;
export const SMOKE_CLASSES = PICK_CLASSES;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

const gearOf = (cls: string) => CURATED[cls as PickClass];

/** The scratch scenario's enemies by level (SRD monsters; sized by eye to the level, not calibrated). */
export const SMOKE_ENEMIES: Readonly<Record<number, readonly string[]>> = {
  1: ['srd:goblin-warrior', 'srd:goblin-warrior'],
  3: ['srd:goblin-boss', 'srd:goblin-warrior'],
  5: ['srd:goblin-boss', 'srd:goblin-boss', 'srd:goblin-warrior', 'srd:goblin-warrior'],
  6: ['srd:knight', 'srd:goblin-warrior', 'srd:goblin-warrior'],
  10: ['srd:knight', 'srd:knight', 'srd:goblin-boss', 'srd:warrior-veteran'],
};

export interface SmokeSpell {
  readonly name: string;
  readonly level: number;
  readonly classes: readonly string[];
}

export interface SmokeChar {
  readonly cls: string;
  readonly level: number;
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

const kebab = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const yamlScalar = (v: unknown): string => JSON.stringify(v);

interface Build {
  cls: ClassSrc;
  sub: SubclassSrc | undefined;
  species: SpeciesSrc;
  bg: BackgroundSrc;
  level: number;
}

/** Final scores: the standard array by class priority, the background's +2/+1, then +2 per ASI level reached (cap 20). */
function scoresOf(b: Build): { scores: Record<Ability, number>; bgAsi: Partial<Record<Ability, number>>; asis: { level: number; asi: Partial<Record<Ability, number>> }[] } {
  const pri = CURATED[b.cls.id.slice(4) as PickClass].priority;
  const scores = {} as Record<Ability, number>;
  pri.forEach((a, i) => (scores[a] = STANDARD_ARRAY[i]!));
  const bgAbilities = pri.filter((a) => (b.bg.abilities as readonly string[]).includes(a));
  const bgAsi: Partial<Record<Ability, number>> = { [bgAbilities[0]!]: 2, [bgAbilities[1]!]: 1 };
  for (const [a, n] of Object.entries(bgAsi) as [Ability, number][]) scores[a] += n;
  const asis: { level: number; asi: Partial<Record<Ability, number>> }[] = [];
  for (const l of [...b.cls.asiLevels].sort((x, y) => x - y)) {
    if (l > b.level) continue;
    const asi: Partial<Record<Ability, number>> = {};
    let left = 2;
    for (const a of pri) {
      while (left > 0 && scores[a] < 20) {
        scores[a]++;
        asi[a] = (asi[a] ?? 0) + 1;
        left--;
      }
      if (left === 0) break;
    }
    asis.push({ level: l, asi });
  }
  return { scores, bgAsi, asis };
}

const asiText = (asi: Partial<Record<Ability, number>>): string =>
  `{ asi: { ${(Object.keys(asi) as Ability[]).sort(byString).map((a) => `${a}: ${asi[a]}`).join(', ')} } }`;

/** Every pick the build needs, the first legal options taken (skills already held skipped), feats' own choices included. */
function picksOf(lib: CharacterLib, b: Build, asis: { level: number; asi: Partial<Record<Ability, number>> }[], bgAsi: Partial<Record<Ability, number>>): string[] {
  const lines: string[] = [];
  // Skills and feats already held (the background's skills and origin feat), so picks don't repeat them.
  const held = new Set<string>([...(b.bg.skills as readonly string[]), b.bg.feat]);
  const proficient = new Set<string>(b.bg.skills as readonly string[]);
  const isExp = (key: string): boolean => {
    const id = key.slice(key.indexOf('#') + 1);
    const decl = [...b.cls.choices, ...(b.sub?.choices ?? []), ...b.species.choices, ...b.bg.choices].find((ch) => ch.id === id);
    return (decl?.grants ?? (id.startsWith('expertise') ? 'expertise' : 'proficiency')) === 'expertise';
  };
  // Proficiency picks first, then Expertise (which needs the proficiency), each group in data order.
  const needs = buildNeeds(lib, b.cls, b.sub, b.species, b.bg, b.level);
  const queue = [...needs.filter((n) => !isExp(n.key)), ...needs.filter((n) => isExp(n.key))].map((n) => ({ ...n }));
  const expert = new Set<string>();
  const done = new Set<string>();
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (done.has(n.key)) continue;
    done.add(n.key);
    if (n.kind === 'asi') {
      const l = Number(n.key.slice(n.key.lastIndexOf('-') + 1));
      lines.push(`  ${n.key}: ${asiText(asis.find((x) => x.level === l)!.asi)}`);
      continue;
    }
    if (n.kind === 'abilities') {
      lines.push(`  ${n.key}: ${asiText(bgAsi)}`);
      continue;
    }
    // M3 step 5b: Weapon Mastery masters the curated kinds first, then the weapons the character
    // carries, then the first other legal kinds by id.
    const prefer = CURATED[b.cls.id.slice(4) as PickClass].prefer[n.key] ?? [];
    if (n.key.endsWith('#weapon-mastery')) {
      const carried = gearOf(b.cls.id.slice(4)).weapons.map((x) => (typeof x === 'string' ? x : x.id));
      const rank = (id: string): number => (prefer.includes(id) ? prefer.indexOf(id) : carried.includes(id) ? 100 : 200);
      const ordered = n.options.map((o, i) => ({ o, i })).sort((x, y) => rank(x.o.id) - rank(y.o.id) || x.i - y.i).map((x) => x.o);
      lines.push(`  ${n.key}: [${ordered.slice(0, n.choose).map((o) => o.id).join(', ')}]`);
      continue;
    }
    // An Expertise choice takes skills already proficient; any other choice skips what's held.
    // C0: the curated preferences for this key come first, in their order.
    const expertise = isExp(n.key);
    const fresh0 = expertise ? n.options.filter((o) => proficient.has(o.id) && !expert.has(o.id)) : n.options.filter((o) => !held.has(o.id));
    const fresh = [...prefer.flatMap((id) => fresh0.filter((o) => o.id === id)), ...fresh0.filter((o) => !prefer.includes(o.id))];
    const pool = fresh.length >= n.choose ? fresh : n.options;
    const chosen = pool.slice(0, n.choose).map((o) => o.id);
    for (const c of chosen) {
      held.add(c);
      if (expertise) expert.add(c);
      else proficient.add(c);
    }
    lines.push(`  ${n.key}: [${chosen.map((c) => (/^[a-z0-9:-]+$/.test(c) ? c : yamlScalar(c))).join(', ')}]`);
    for (const c of chosen) {
      const feat = lib.feats.get(c);
      if (!feat) continue;
      for (const ch of feat.choices) {
        const options: { id: string; name: string | null }[] = [];
        for (const k of ['skills', 'features', 'feats', 'abilities', 'tools'] as const) for (const o of ch.from[k] ?? []) options.push({ id: o, name: null });
        queue.push({ key: `${feat.id}#${ch.id}`, where: feat.name, kind: 'choice', choose: ch.choose, what: '', options });
      }
    }
  }
  return lines;
}

/** The curated focus as an inline item, and the starting hands (review C0-BENCH-M1). */
function focusText(gear: (typeof CURATED)[PickClass]): string {
  const f = gear.focus;
  const items = f ? `, items: [{ id: ${f.id}, name: ${yamlScalar(f.name)}, kind: focus, focusFor: [${f.focusFor.join(', ')}] }]` : '';
  const hands = gear.hands ? `, hands: [${gear.hands.map((h) => h ?? 'null').join(', ')}]` : '';
  return `${items}${hands}`;
}

function charText(lib: CharacterLib, b: Build, id: string, casting: readonly { source: string; cantrips: readonly string[]; prepared: readonly string[] }[]): string {
  const { scores, bgAsi, asis } = scoresOf(b);
  const gear = gearOf(b.cls.id.slice(4));
  const picks = picksOf(lib, b, asis, bgAsi);
  const w = gear.weapons.map((x) => (typeof x === 'string' ? x : `{ id: ${x.id}, count: ${x.count} }`)).join(', ');
  return [
    '# M3 step-6 smoke corpus (tools/smoke-corpus.ts, picks from tools/class-picks.ts): generated in memory, never written to packs/.',
    'kind: character',
    `id: ${id}`,
    `name: ${yamlScalar(`Smoke ${b.cls.name} ${b.level}`)}`,
    'source: synthetic smoke fixture',
    "rules: '2024'",
    `classes: [{ class: ${b.cls.id}, level: ${b.level}${b.sub ? `, subclass: ${b.sub.id}` : ''} }]`,
    `species: ${b.species.id}`,
    ...(b.species.size.length > 1 ? [`size: ${gear.size ?? b.species.size[0]}`] : []),
    `background: ${b.bg.id}`,
    `abilities: { str: ${scores.str}, dex: ${scores.dex}, con: ${scores.con}, int: ${scores.int}, wis: ${scores.wis}, cha: ${scores.cha} }`,
    'hp: average',
    ...(picks.length > 0 ? ['picks:', ...picks] : ['picks: {}']),
    `equipment: { armor: ${gear.armor ?? 'null'}, shield: ${gear.shield}, weapons: [${w}]${focusText(gear)} }`,
    ...(casting.length > 0 ? ['casting:', ...casting.map((c) => `  - { source: ${c.source}, cantrips: [${c.cantrips.join(', ')}], prepared: [${c.prepared.join(', ')}] }`)] : []),
    '',
  ].join('\n');
}

/**
 * The 60 characters. `files` are the SRD and test pack texts; `spells` the PDF spell headers
 * (srd-index.json). `generated` is a test seam (review T4): it sees the final texts before the
 * closing L1 scan, as a later generation step would.
 * `levels` (tools/gen-heroes.ts): the levels to build, the smoke levels unless given.
 */
export function smokeCorpus(files: readonly SourceFile[], spells: readonly SmokeSpell[], generated: (c: SmokeChar[]) => SmokeChar[] = (c) => c, levels: readonly number[] = SMOKE_LEVELS): SmokeChar[] {
  const lib = characterLib(files);
  const spellIds = new Set([...lib.kinds].filter(([, k]) => k === 'spell').map(([id]) => id));
  const builds: { b: Build; id: string; path: string }[] = [];
  SMOKE_CLASSES.forEach((c, ci) => {
    const cls = lib.classes.get(`srd:${c}`);
    if (!cls) throw new Error(`smoke corpus: no class srd:${c} is loaded`);
    // SRD subclasses only: packs/test may carry synthetic subclasses of an SRD class (session S's test:sample-path).
    const subs = [...lib.subclasses.values()].filter((s) => s.parent === cls.id && s.id.startsWith('srd:')).sort((x, y) => byString(x.id, y.id));
    const cur = CURATED[c];
    const species = lib.species.get(cur.species);
    const bg = lib.backgrounds.get(cur.background);
    if (!species || !bg) throw new Error(`smoke corpus: the curated ${c} build names ${cur.species} / ${cur.background}, which the SRD pack doesn't define`);
    levels.forEach((level, li) => {
      const sub = level >= cls.subclassLevel ? subs[(ci + li) % Math.max(1, subs.length)] : undefined;
      const b: Build = { cls, sub, species, bg, level };
      const id = `test:smoke-${c}-${level}`;
      builds.push({ b, id, path: `packs/test/characters/smoke/${c}-${level}.yaml` });
    });
  });
  // Pass 1: no casting, to read each sheet's cantrip and prepared counts and its slot levels.
  assertNoPrivate([{ path: 'tools/class-picks.ts', text: curatedText() }], 'smoke corpus pick table');
  const first = builds.map((x) => ({ path: x.path, text: charText(lib, x.b, x.id, []) }));
  assertNoPrivate(first, 'smoke corpus (pass 1)');
  const r1 = loadContent([...files, ...first]);
  const sheets = new Map((r1.sheets ?? []).map((s) => [s.id, s]));
  const out = generated(builds.map((x) => {
    const sheet = sheets.get(x.id);
    if (!sheet) throw new Error(`smoke corpus: ${x.id} did not expand: ${r1.errors.filter((d) => d.path === x.path).map(formatDiag).join('; ')}`);
    const maxLevel = Math.max(1, sheet.slots.levels.length);
    const casting = sheet.casting.map((cs) => {
      const listOf = (cs.source.startsWith('srd:') ? cs.source.slice(4) : cs.source).split('/')[0]!;
      const on = spells
        .filter((s) => s.classes.includes(listOf))
        .map((s) => ({ id: `srd:${kebab(s.name)}`, level: s.level }))
        .filter((s) => spellIds.has(s.id) && !cs.always.includes(s.id));
      // C0: the curated preferences first (those this list and level can take), then the old rule:
      // cantrips by id, prepared spells highest level first, then by id.
      const cur = CURATED[x.b.cls.id.slice(4) as PickClass];
      const ranked = <T extends { id: string }>(xs: readonly T[], prefs: readonly string[] | undefined): T[] => [
        ...(prefs ?? []).flatMap((id) => xs.filter((s) => s.id === id)),
        ...xs.filter((s) => !(prefs ?? []).includes(s.id)),
      ];
      const cantrips = ranked(on.filter((s) => s.level === 0).sort((p, q) => byString(p.id, q.id)), cur.cantrips)
        .slice(0, cs.cantripsExpected ?? 0)
        .map((s) => s.id)
        .sort(byString);
      const prepared = ranked(on.filter((s) => s.level >= 1 && s.level <= maxLevel).sort((p, q) => q.level - p.level || byString(p.id, q.id)), cur.prepared)
        .slice(0, cs.preparedExpected ?? 0)
        .map((s) => s.id)
        .sort(byString);
      return { source: cs.source, cantrips, prepared };
    });
    return { cls: x.b.cls.id.slice(4), level: x.b.level, id: x.id, path: x.path, text: charText(lib, x.b, x.id, casting) };
  }));
  assertNoPrivate(out, 'smoke corpus');
  return out;
}

export interface SmokeRow {
  readonly cls: string;
  readonly level: number;
  readonly id: string;
  readonly subclass: string | null;
  readonly species: string;
  readonly background: string;
  readonly hp: number;
  readonly ac: number;
  readonly fidelity: { readonly full: number; readonly partial: number; readonly narrative: number };
  readonly lintErrors: readonly string[];
  readonly lintWarnings: number;
  readonly fights: number;
  readonly wins: number;
  readonly losses: number;
  readonly stalemates: number;
  readonly engineErrors: readonly string[];
  readonly unimplemented: readonly string[];
  /** C0: loop health over its fights (tools/bench-trace.ts). */
  readonly health: LoopHealth;
  /** M14: its features and feats below full that are combat-relevant (COMBAT_RELEVANT), sorted; and any in neither closed list. */
  readonly combatUnmodeled: readonly string[];
  readonly unclassified: readonly string[];
}

/** The scratch scenario for one character: the PC alone (greedy) against its level's group (greedy). */
export function smokeScenario(c: SmokeChar): Record<string, unknown> {
  const enemies = SMOKE_ENEMIES[c.level]!;
  const cols = 'BDFHJ';
  return {
    kind: 'scenario',
    id: `smoke-${c.cls}-${c.level}`,
    name: `Smoke ${c.cls} ${c.level}`,
    rules: '2024',
    packs: ['srd-5.2.1', 'test'],
    grid: { w: 10, h: 10 },
    knobs: { maxRounds: 10, lossCounts: 'pcs' },
    units: [
      { seat: 'pc1', team: 'party', use: c.id, at: 'E8', decider: 'greedy' },
      ...enemies.map((m, i) => ({ seat: `foe${i + 1}`, team: 'enemies', use: m, at: `${cols[i]}2`, decider: 'greedy' })),
    ],
  };
}

/** Builds, lints and fights every character; `n` fights each at seed 6, runs 0..n-1. */
export function runSmoke(files: readonly SourceFile[], corpus: readonly SmokeChar[], n: number): SmokeRow[] {
  assertNoPrivate(corpus, 'smoke corpus');
  const r = loadContent([...files, ...corpus.map((c) => ({ path: c.path, text: c.text }))]);
  const sheets = new Map<string, DerivedSheet>((r.sheets ?? []).map((s) => [s.id, s]));
  return corpus.map((c): SmokeRow => {
    const sheet = sheets.get(c.id);
    const lintErrors = r.errors.filter((d) => d.path === c.path).map(formatDiag);
    const lintWarnings = r.warnings.filter((d) => d.path === c.path).length;
    const fid = { full: 0, partial: 0, narrative: 0 };
    // M14 counts features and feats below full (review R2: a narrative feat such as Savage Attacker
    // changes damage, so it is gated and classified like a feature).
    const notFull = [...new Set([...(sheet?.features ?? []), ...(sheet?.feats ?? [])].filter((f) => f.fidelity !== 'full').map((f) => f.id))].sort(byString);
    for (const f of sheet?.features ?? []) if (f.fidelity === 'full' || f.fidelity === 'partial' || f.fidelity === 'narrative') fid[f.fidelity]++;
    const engineErrors: string[] = [];
    let wins = 0;
    let losses = 0;
    let stalemates = 0;
    let fights = 0;
    const health = newLoopHealth();
    if (r.content && sheet) {
      const s = resolveScenario(smokeScenario(c), `smoke-${c.cls}-${c.level}.yaml`, r.content);
      if (!s.setup) engineErrors.push(`scenario: ${s.errors.map(formatDiag).join('; ')}`);
      else {
        const setup = s.setup;
        const pc = setup.seats.findIndex((x) => x.seat === 'pc1');
        const sink = new TraceSink([pc], setup.seats.map((x) => x.team), -1);
        for (let run = 0; run < n; run++) {
          try {
            sink.reset();
            const res = runFight(setup, 6, run, makeDeciders(setup), sink, { inspect: sink.inspect });
            addFight(health, sink.units.get(pc)!, stalemateCause(res, sink));
            fights++;
            if (res.outcome.k === 'win') wins++;
            else if (res.outcome.k === 'loss') losses++;
            else stalemates++;
          } catch (e) {
            engineErrors.push(`run ${run}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    return {
      cls: c.cls,
      level: c.level,
      id: c.id,
      subclass: sheet?.classes[0]?.subclass?.id ?? null,
      species: sheet?.species.id ?? '?',
      background: sheet?.background.id ?? '?',
      hp: sheet?.hpMax.value ?? 0,
      ac: sheet?.ac.value ?? 0,
      fidelity: fid,
      lintErrors,
      lintWarnings,
      fights,
      wins,
      losses,
      stalemates,
      engineErrors,
      unimplemented: [...(sheet?.unimplemented ?? [])],
      health,
      combatUnmodeled: notFull.filter((id) => COMBAT_RELEVANT.includes(id)),
      unclassified: notFull.filter((id) => !COMBAT_RELEVANT.includes(id) && !NON_COMBAT.includes(id)),
    };
  });
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);

/** The 60-row summary, then each character's unmodeled list. */
export function renderSmoke(rows: readonly SmokeRow[], n: number): string {
  const out: string[] = [];
  out.push(`smoke-classes: ${rows.length} characters (12 classes x levels ${SMOKE_LEVELS.join(', ')}), ${n} fight(s) each, seed 6, the PC alone (greedy) vs its level's SRD group (greedy), maxRounds 10`);
  out.push(`enemies: ${SMOKE_LEVELS.map((l) => `L${l} ${SMOKE_ENEMIES[l]!.map((m) => m.slice(4)).join('+')}`).join('; ')} (not calibrated)`);
  out.push('');
  out.push(`${pad('class', 10)} ${padL('lvl', 3)}  ${pad('subclass', 28)} ${pad('species', 16)} ${pad('background', 15)} ${padL('HP', 3)} ${padL('AC', 3)}  ${pad('full/part/narr', 14)} ${padL('lint', 6)} ${padL('win%', 6)} ${padL('W/L/S', 11)} ${padL('err', 3)} ${padL('unmod', 5)} ${padL('dodge%', 6)} ${padL('items/f', 7)} ${padL('acts', 4)}  stalemates by cause`);
  for (const r of rows) {
    const win = r.fights > 0 ? ((100 * r.wins) / r.fights).toFixed(1) : '-';
    out.push(
      `${pad(r.cls, 10)} ${padL(r.level, 3)}  ${pad(r.subclass ?? '-', 28)} ${pad(r.species, 16)} ${pad(r.background, 15)} ${padL(r.hp, 3)} ${padL(r.ac, 3)}  ${pad(`${r.fidelity.full}/${r.fidelity.partial}/${r.fidelity.narrative}`, 14)} ${padL(`${r.lintErrors.length}e${r.lintWarnings}w`, 6)} ${padL(win, 6)} ${padL(`${r.wins}/${r.losses}/${r.stalemates}`, 11)} ${padL(r.engineErrors.length, 3)} ${padL(r.unimplemented.length, 5)} ${padL((100 * dodgeShare(r.health)).toFixed(1), 6)} ${padL(itemsPerFight(r.health).toFixed(2), 7)} ${padL(neverActs(r.health) ? 'NO' : 'yes', 4)}  ${causeText(r.health.stalemates)}`,
    );
  }
  out.push('');
  out.push(loopHealthSummary(rows));
  const cu = rows.reduce((a, r) => a + r.combatUnmodeled.length, 0);
  const raw = rows.reduce((a, r) => a + r.unimplemented.length, 0);
  const uncl = [...new Set(rows.flatMap((r) => r.unclassified))].sort(byString);
  out.push(`combat-relevant unmodeled feature ids (M14 gate: per character, may only fall against tools/test/smoke-combat-unmodeled.baseline.json): ${cu}; raw unmodeled lines (reported): ${raw}${uncl.length ? `; UNCLASSIFIED (add to a closed list in tools/class-picks.ts): ${uncl.join(', ')}` : ''}`);
  const tot = rows.reduce((a, r) => ({ fights: a.fights + r.fights, errs: a.errs + r.engineErrors.length, lint: a.lint + r.lintErrors.length }), { fights: 0, errs: 0, lint: 0 });
  out.push('');
  out.push(`total: ${tot.fights} fights, ${tot.errs} engine error(s), ${tot.lint} lint error(s)`);
  for (const r of rows) for (const e of [...r.lintErrors, ...r.engineErrors]) out.push(`  ${r.id}: ${e}`);
  out.push('');
  out.push('Not modeled, per character (the compiled template\'s unimplemented list):');
  for (const r of rows) {
    out.push(`${r.id} (${r.unimplemented.length}):`);
    for (const u of r.unimplemented) out.push(`  - ${u}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Solo-smoke loop health against the frozen H thresholds (coverage.md section 6 H, M13 f: the
 * Dodge gate applies to L1-5 only; L10 is reported). Solo smoke isn't a bench, so its stalemate
 * share is reported, not gated.
 */
export function loopHealthSummary(rows: readonly SmokeRow[]): string {
  const sum = newLoopHealth();
  const gated = newLoopHealth();
  for (const r of rows) {
    for (const h of r.level <= 5 ? [sum, gated] : [sum]) {
      h.fights += r.health.fights;
      h.turnsUp += r.health.turnsUp;
      h.dodges += r.health.dodges;
      h.attacks += r.health.attacks;
      h.casts += r.health.casts;
      h.itemDecisions += r.health.itemDecisions;
      for (const k of Object.keys(h.stalemates) as (keyof LoopHealth['stalemates'])[]) h.stalemates[k] += r.health.stalemates[k];
    }
  }
  const never = rows.filter((r) => neverActs(r.health)).map((r) => r.id.replace('test:smoke-', ''));
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const ok = (b: boolean) => (b ? 'pass' : 'FAIL');
  const stale = rows.reduce((a, r) => a + r.stalemates, 0);
  const lines = [
    `loop health (H, thresholds frozen in tools/class-picks.ts): Dodge ${pct(dodgeShare(sum))} of PC turns overall; L1-5 ${pct(dodgeShare(gated))} (max ${pct(THRESHOLDS.dodgeShareMax)}): ${ok(dodgeShare(gated) <= THRESHOLDS.dodgeShareMax)}`,
    `  never attack or cast: ${never.length} (max ${THRESHOLDS.neverActsMax}): ${ok(never.length <= THRESHOLDS.neverActsMax)}${never.length ? ` (${never.join(', ')})` : ''}`,
    `  item decisions per fight: ${itemsPerFight(sum).toFixed(2)} (max ${THRESHOLDS.itemDecisionsPerFightMax}): ${ok(itemsPerFight(sum) <= THRESHOLDS.itemDecisionsPerFightMax)}`,
    `  stalemates (reported for solo smoke): ${stale} of ${sum.fights}; by cause: ${causeText(sum.stalemates)} (no-damage = none in the last ${THRESHOLDS.noDamageRoundsK} rounds; dodge-loop = a streak of ${THRESHOLDS.dodgeStreak}+)`,
  ];
  return lines.join('\n');
}

/** M14's baseline: combat-relevant unmodeled feature ids per fixed character, as JSON text. */
export function combatBaseline(rows: readonly SmokeRow[]): string {
  const o: Record<string, readonly string[]> = {};
  for (const r of [...rows].sort((a, b) => byString(a.id, b.id))) o[r.id] = r.combatUnmodeled;
  return `${JSON.stringify(o, null, 1)}\n`;
}

/**
 * M14's anchor: the baseline's total id count as re-recorded after C0 (coverage.md, C0 build note):
 * 329 after the first review; 410 after the second (+81: narrative feats gated, review R2, +75;
 * three features that add spells reclassified combat-relevant, review R3, +6).
 */
export const M14_C0_ANCHOR = 410;

/** M14's listed reasons: `{ characterId: { featureId: reason } }`, one entry per allowed rise. */
export type RiseReasons = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Combat-relevant unmodeled ids a row carries that `base` doesn't, as "characterId featureId", sorted. */
export function combatRises(rows: readonly SmokeRow[], base: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const r of rows) for (const id of r.combatUnmodeled) if (!(base[r.id] ?? []).includes(id)) out.push(`${r.id} ${id}`);
  return out.sort(byString);
}

/** The rises with no non-empty listed reason (M14: ids may only fall unless a reason is listed). */
export function unlistedRises(rises: readonly string[], reasons: RiseReasons): string[] {
  return rises.filter((k) => {
    const [ch, id] = k.split(' ') as [string, string];
    return !((reasons[ch]?.[id] ?? '').trim().length > 0);
  });
}

/** The PDF spell headers from the committed index (name, level, class lists: C2). */
export function smokeSpells(indexText: string): SmokeSpell[] {
  const idx = JSON.parse(indexText) as { spells: SmokeSpell[] };
  return idx.spells.map((s) => ({ name: s.name, level: s.level, classes: [...s.classes] }));
}

/** Parses a corpus file back (tests). */
export function parseSmoke(text: string): Record<string, unknown> {
  return parse(text) as Record<string, unknown>;
}
