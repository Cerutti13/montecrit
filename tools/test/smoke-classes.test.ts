// The M3 step-6 smoke corpus (docs/design/m3.md build order step 6, C22): 12 classes x levels 1,
// 3, 5, 6, 10, generated from the SRD pack in tools/smoke-corpus.ts. Each character builds, lints
// with 0 errors and fights against a scratch scenario with no engine error, and every feature it
// carries that isn't full is in its unmodeled list. 5 fights each here; 100 under MONTECRIT_SLOW=1.
// C0: the picks come from the curated table (tools/class-picks.ts) and every fight carries the
// loop-health trace (tools/bench-trace.ts).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../../packages/engine/src/index.ts';
import { smokePackFiles, writeBaseline } from '../smoke-classes.ts';
import { combatRises, M14_C0_ANCHOR, renderSmoke, runSmoke, SMOKE_CLASSES, SMOKE_LEVELS, smokeCorpus, smokeSpells, parseSmoke, unlistedRises, type RiseReasons, type SmokeChar, type SmokeRow } from '../smoke-corpus.ts';
import { COMBAT_RELEVANT } from '../class-picks.ts';
import { NON_SRD_NAMES } from '../check-private.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const ROOT = join(import.meta.dirname, '..', '..');
const FILES = smokePackFiles(ROOT);
const SPELLS = smokeSpells(readFileSync(join(ROOT, 'tools', 'import-srd', 'srd-index.json'), 'utf8'));
const CORPUS = smokeCorpus(FILES, SPELLS);

describe('the smoke corpus is 12 classes x 5 levels, generated deterministically from the SRD pack', () => {
  it('has one character per class and level, with test: ids and in-memory test-pack paths', () => {
    expect(CORPUS).toHaveLength(60);
    const keys = CORPUS.map((c) => `${c.cls}-${c.level}`);
    expect(new Set(keys).size).toBe(60);
    for (const cls of SMOKE_CLASSES) for (const l of SMOKE_LEVELS) expect(keys).toContain(`${cls}-${l}`);
    for (const c of CORPUS) {
      expect(c.id).toBe(`test:smoke-${c.cls}-${c.level}`);
      expect(c.path).toBe(`packs/test/characters/smoke/${c.cls}-${c.level}.yaml`);
    }
  });

  it('M3 step 5b: every Weapon Mastery class picks its full count, the weapons it carries first, so no mastery line is left unmodeled', () => {
    const r = loadContent([...FILES, ...CORPUS.map((c) => ({ path: c.path, text: c.text }))]);
    for (const c of CORPUS.filter((x) => ['barbarian', 'fighter', 'paladin', 'ranger', 'rogue'].includes(x.cls))) {
      const pick = new RegExp(`srd:${c.cls}#weapon-mastery: \\[([^\\]]*)\\]`).exec(c.text);
      expect(pick, c.id).not.toBeNull();
      const tpl = r.content!.get(c.id)!;
      expect((tpl.unimplemented ?? []).filter((u) => /Weapon Mastery: \d+ of/.test(u)), c.id).toEqual([]);
      const first = pick![1]!.split(', ')[0]!;
      expect(c.text.slice(c.text.indexOf('weapons: ['))).toContain(first); // the first mastered kind is one it carries
    }
  });

  it('is the same text on a second generation', () => {
    expect(smokeCorpus(FILES, SPELLS).map((c) => c.text)).toEqual(CORPUS.map((c) => c.text));
  });

  it('names only srd: content (plus its own test: id), and takes a subclass exactly from the subclass level', () => {
    const loaded = new Set<string>();
    for (const f of FILES) for (const m of f.text.matchAll(/^id: (srd:[a-z0-9/-]+)$/gm)) loaded.add(m[1]!);
    for (const c of CORPUS) {
      const ids = [...c.text.matchAll(/\b((?:srd|test|private):[a-z0-9/-]+)/g)].map((m) => m[1]!);
      for (const id of ids) {
        if (id === c.id) continue;
        expect(id.startsWith('srd:'), `${c.id} names ${id}`).toBe(true);
        expect(loaded.has(id), `${c.id} names ${id}, which no SRD file defines`).toBe(true);
      }
      const doc = parseSmoke(c.text) as { classes: { subclass?: string }[] };
      expect(doc.classes[0]!.subclass !== undefined, c.id).toBe(c.level >= 3); // every SRD class gains its subclass at 3
    }
  });

  it('gives every character final scores between 8 and 20, its primary at least 15', () => {
    for (const c of CORPUS) {
      const doc = parseSmoke(c.text) as { abilities: Record<string, number> };
      for (const v of Object.values(doc.abilities)) expect(v >= 8 && v <= 20, c.id).toBe(true);
      expect(Math.max(...Object.values(doc.abilities))).toBeGreaterThanOrEqual(15);
    }
  });
});

describe(`every smoke character builds, lints with 0 errors and fights ${SLOW ? 100 : 5} times with no engine error`, () => {
  const n = SLOW ? 100 : 5;
  let rows: SmokeRow[] = [];
  it('runs the whole corpus', () => {
    rows = runSmoke(FILES, CORPUS, n);
    expect(rows).toHaveLength(60);
    for (const r of rows) {
      expect(r.lintErrors, r.id).toEqual([]);
      expect(r.engineErrors, r.id).toEqual([]);
      expect(r.fights, r.id).toBe(n);
      expect(r.wins + r.losses + r.stalemates, r.id).toBe(n);
      expect(r.hp, r.id).toBeGreaterThan(0);
      expect(r.ac, r.id).toBeGreaterThanOrEqual(10);
    }
  }, SLOW ? 600_000 : 120_000);

  it('lists every feature that is not full among its unmodeled lines, and the summary prints them all', () => {
    const r = loadContent([...FILES, ...CORPUS.map((c) => ({ path: c.path, text: c.text }))]);
    const sheets = new Map((r.sheets ?? []).map((s) => [s.id, s]));
    for (const c of CORPUS) {
      const s = sheets.get(c.id)!;
      for (const f of s.features) {
        if (f.fidelity === 'full') continue;
        expect(s.unimplemented.some((u) => u.startsWith(`${f.name}:`)), `${c.id}: ${f.name} (${f.fidelity}) is not in its unmodeled list`).toBe(true);
      }
    }
    if (rows.length === 0) rows = runSmoke(FILES, CORPUS, 1);
    const text = renderSmoke(rows, n);
    for (const row of rows) for (const u of row.unimplemented) expect(text).toContain(`  - ${u}`);
    expect(text.split('\n').filter((l) => /^[a-z]+ +\d+  /.test(l))).toHaveLength(60);
  });

  it('C0: prints loop health per character (Dodge share, item decisions, whether it acts, stalemates by cause) and the H summary', () => {
    if (rows.length === 0) rows = runSmoke(FILES, CORPUS, 1);
    for (const r of rows) {
      expect(r.health.fights, r.id).toBe(r.fights);
      expect(r.health.dodges, r.id).toBeLessThanOrEqual(r.health.turnsUp);
      const causes = Object.values(r.health.stalemates).reduce((a, b) => a + b, 0);
      expect(causes, r.id).toBe(r.stalemates); // every round-cap fight gets exactly one cause
    }
    const text = renderSmoke(rows, n);
    expect(text).toContain('stalemates by cause');
    expect(text).toMatch(/^loop health \(H, thresholds frozen/m);
    expect(text).toMatch(/never attack or cast: \d+/);
  });

  it('M14: combat-relevant unmodeled feature ids per character only fall against the committed baseline, and every feature below full is classified', () => {
    if (rows.length === 0) rows = runSmoke(FILES, CORPUS, 1);
    const base = JSON.parse(readFileSync(join(ROOT, 'tools', 'test', 'smoke-combat-unmodeled.baseline.json'), 'utf8')) as Record<string, string[]>;
    expect(Object.keys(base).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const r of rows) {
      expect(r.unclassified, `${r.id}: add these to COMBAT_RELEVANT or NON_COMBAT in tools/class-picks.ts`).toEqual([]);
    }
    const reasons = JSON.parse(readFileSync(join(ROOT, 'tools', 'test', 'smoke-combat-unmodeled.rises.json'), 'utf8')) as RiseReasons;
    expect(unlistedRises(combatRises(rows, base), reasons), 'new combat-relevant unmodeled ids (M14: may only fall unless a reason is listed in smoke-combat-unmodeled.rises.json)').toEqual([]);
  });

  it('M14: the baseline never holds more ids than the C0 anchor (410) plus the listed rises, and every listed rise names a corpus character, a combat-relevant id and a reason', () => {
    const base = JSON.parse(readFileSync(join(ROOT, 'tools', 'test', 'smoke-combat-unmodeled.baseline.json'), 'utf8')) as Record<string, string[]>;
    const reasons = JSON.parse(readFileSync(join(ROOT, 'tools', 'test', 'smoke-combat-unmodeled.rises.json'), 'utf8')) as RiseReasons;
    const listed = Object.entries(reasons).flatMap(([ch, m]) => Object.entries(m).map(([id, why]) => ({ ch, id, why })));
    for (const l of listed) {
      expect(CORPUS.map((c) => c.id), l.ch).toContain(l.ch);
      expect(COMBAT_RELEVANT, l.id).toContain(l.id);
      expect(l.why.trim().length, `${l.ch} ${l.id}: empty reason`).toBeGreaterThan(0);
    }
    const total = Object.values(base).reduce((a, v) => a + v.length, 0);
    expect(total).toBeLessThanOrEqual(M14_C0_ANCHOR + listed.length);
  });

  it('M14: a rise is caught unless its reason is listed, and a fall is never a rise', () => {
    const row = (id: string, ids: string[]) => ({ id, combatUnmodeled: ids }) as unknown as SmokeRow;
    const base = { 'test:smoke-rogue-5': ['srd:rogue/sneak-attack'] };
    expect(combatRises([row('test:smoke-rogue-5', [])], base)).toEqual([]);
    const rises = combatRises([row('test:smoke-rogue-5', ['srd:rogue/sneak-attack', 'srd:rogue/uncanny-dodge'])], base);
    expect(rises).toEqual(['test:smoke-rogue-5 srd:rogue/uncanny-dodge']);
    expect(unlistedRises(rises, {})).toEqual(rises);
    expect(unlistedRises(rises, { 'test:smoke-rogue-5': { 'srd:rogue/uncanny-dodge': '  ' } })).toEqual(rises);
    expect(unlistedRises(rises, { 'test:smoke-rogue-5': { 'srd:rogue/uncanny-dodge': 'W1 split the override into two ids' } })).toEqual([]);
  });

  it('C0 review T2: combatUnmodeled is recomputed from the sheets (features below full, combat-relevant), anchored, and equals the baseline (a fall is re-recorded with --write-baseline)', () => {
    if (rows.length === 0) rows = runSmoke(FILES, CORPUS, 1);
    const r = loadContent([...FILES, ...CORPUS.map((c) => ({ path: c.path, text: c.text }))]);
    const sheets = new Map((r.sheets ?? []).map((s) => [s.id, s]));
    for (const row of rows) {
      const sh = sheets.get(row.id)!;
      const want = [...new Set([...sh.features, ...sh.feats].filter((f) => f.fidelity !== 'full').map((f) => f.id))].filter((id) => COMBAT_RELEVANT.includes(id)).sort();
      expect(row.combatUnmodeled, row.id).toEqual(want);
    }
    const by = new Map(rows.map((x) => [x.id, x.combatUnmodeled]));
    // Review R2: narrative feats are gated (Savage Attacker from the Soldier, Archery, Alert).
    expect(by.get('test:smoke-barbarian-1')).toContain('srd:savage-attacker');
    expect(by.get('test:smoke-ranger-5')).toContain('srd:archery');
    expect(by.get('test:smoke-fighter-1')).toContain('srd:alert');
    // Review R3: features that add spells to the castable kit are combat-relevant.
    expect(by.get('test:smoke-paladin-5')).toContain('srd:paladin/faithful-steed');
    expect(by.get('test:smoke-bard-6')).toContain('srd:college-of-lore/magical-discoveries');
    expect(by.get('test:smoke-bard-10')).toContain('srd:bard/magical-secrets');
    // W1: Rage and Sneak Attack are full; these stay below full on the same rows (Stone's Endurance, D2; Cunning Strike's Poison and Trip).
    expect(by.get('test:smoke-barbarian-1')).toContain('srd:goliath/stones-endurance');
    expect(by.get('test:smoke-rogue-5')).toContain('srd:rogue/cunning-strike');
    expect(by.get('test:smoke-paladin-5')).toContain('srd:paladin/paladins-smite');
    const base = JSON.parse(readFileSync(join(ROOT, 'tools', 'test', 'smoke-combat-unmodeled.baseline.json'), 'utf8')) as Record<string, string[]>;
    for (const row of rows) expect(row.combatUnmodeled, `${row.id}: rerun node tools/smoke-classes.ts --write-baseline if this fell`).toEqual(base[row.id]);
  });

  it('C0 review T8: --write-baseline (writeBaseline) refuses an unlisted rise and leaves the file untouched; with a listed reason it writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'montecrit-m14-'));
    const base = '{\n "test:smoke-rogue-5": [\n  "srd:rogue/sneak-attack"\n ]\n}\n';
    writeFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), base);
    writeFileSync(join(dir, 'smoke-combat-unmodeled.rises.json'), '{}\n');
    const rose = [{ id: 'test:smoke-rogue-5', combatUnmodeled: ['srd:rogue/sneak-attack', 'srd:rogue/uncanny-dodge'] }] as unknown as SmokeRow[];
    expect(() => writeBaseline(rose, dir)).toThrow(/M14: combat-relevant unmodeled ids rose with no listed reason.*test:smoke-rogue-5 srd:rogue\/uncanny-dodge/);
    expect(readFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), 'utf8')).toBe(base);
    writeFileSync(join(dir, 'smoke-combat-unmodeled.rises.json'), JSON.stringify({ 'test:smoke-rogue-5': { 'srd:rogue/uncanny-dodge': 'test reason' } }));
    writeBaseline(rose, dir);
    expect(JSON.parse(readFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), 'utf8'))).toEqual({ 'test:smoke-rogue-5': ['srd:rogue/sneak-attack', 'srd:rogue/uncanny-dodge'] });
    // A fall needs no reason, and an unchanged rewrite is byte-identical.
    writeFileSync(join(dir, 'smoke-combat-unmodeled.rises.json'), '{}\n');
    writeFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), base);
    writeBaseline([{ id: 'test:smoke-rogue-5', combatUnmodeled: ['srd:rogue/sneak-attack'] }] as unknown as SmokeRow[], dir);
    expect(readFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), 'utf8')).toBe(base);
  });

  it('C0 review T4: runSmoke and smokeCorpus fail closed on a private name in a generated text', () => {
    const name = NON_SRD_NAMES[0]!;
    const taint = (cs: readonly SmokeChar[]): SmokeChar[] => cs.map((c) => (c.id === 'test:smoke-fighter-1' ? { ...c, text: `${c.text}# ${name}\n` } : c));
    expect(() => runSmoke(FILES, taint(CORPUS).filter((c) => c.id === 'test:smoke-fighter-1'), 1)).toThrow(/smoke corpus: private-content scan failed closed/);
    expect(() => smokeCorpus(FILES, SPELLS, taint)).toThrow(/smoke corpus: private-content scan failed closed/);
  });
});
