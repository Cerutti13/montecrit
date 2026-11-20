// Flag-matrix goldens (docs/design/m1b.md, Critique resolutions item 9; PLAN M1c Accept: golden
// tests pass in both settings of every flag M1 uses). Every golden scenario with a journal and
// at least one seedN.log is re-run under each other value of every flag its default run read,
// and the text must match scenarios/golden/<scenario>.flag-matrix.log.
// Review any diff on purpose; regenerate with UPDATE_FLAG_MATRIX=1 npx vitest run apps/cli/test/flag-matrix.test.ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAG_INFO, type FlagInfo, type RuleFlags } from '@montecrit/engine';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/files.ts';
import { buildFlagMatrix, type FlagMatrix } from '../src/matrix.ts';

const G = join(REPO_ROOT, 'scenarios', 'golden');
// An empty private home, so the real ~/.montecrit never leaks into these tests.
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
const UPDATE = process.env.UPDATE_FLAG_MATRIX === '1';

interface Golden {
  readonly name: string;
  readonly scenario: string;
  readonly journal: string;
  readonly seeds: readonly number[];
}

/** Every scenarios/golden/<name>.yaml with a <name>.journal.yaml and at least one <name>.seedN.log. */
function discover(): Golden[] {
  const files = readdirSync(G);
  const names = files.filter((f) => f.endsWith('.yaml') && !f.endsWith('.journal.yaml')).map((f) => f.slice(0, -'.yaml'.length));
  const out: Golden[] = [];
  for (const name of names.sort()) {
    const journal = join(G, `${name}.journal.yaml`);
    if (!existsSync(journal)) continue;
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.seed(\\d+)\\.log$`);
    const seeds = files.flatMap((f) => {
      const m = re.exec(f);
      return m ? [Number(m[1])] : [];
    });
    if (seeds.length) out.push({ name, scenario: join(G, `${name}.yaml`), journal, seeds: seeds.sort((a, b) => a - b) });
  }
  return out;
}

const goldenHash = (g: Golden, seed: number): string | undefined => /^logHash (\w+)$/m.exec(readFileSync(join(G, `${g.name}.seed${seed}.log`), 'utf8'))?.[1];

/**
 * Read back from the text itself: every flag a seed's default run read needs a section that ran,
 * unless every other value of it is marked unimplemented in FLAG_INFO (then it needs those noted).
 * A crashed section is a failure too.
 */
function problems(m: FlagMatrix): string[] {
  const out: string[] = [];
  const blocks = m.text.split(/^#### seed (\d+) ####$/m);
  for (const s of m.seeds) {
    const at = blocks.findIndex((b, i) => i % 2 === 1 && Number(b) === s.seed);
    const block = at < 0 ? '' : blocks[at + 1]!;
    const heads = [...block.matchAll(/^== (\w+)=(\S+) \((.*)\) ==$/gm)].map((h) => ({ flag: h[1]!, value: h[2]!, note: h[3]! }));
    for (const h of heads) if (h.note.startsWith('crashed')) out.push(`seed ${s.seed}: ${h.flag}=${h.value} crashed (${h.note})`);
    for (const k of s.flagsUsed) {
      const mine = heads.filter((h) => h.flag === k);
      if (mine.some((h) => !h.note.startsWith('skipped') && !h.note.startsWith('crashed'))) continue;
      const info: FlagInfo<unknown> = FLAG_INFO[k as keyof RuleFlags];
      const unimplemented = (v: string) => info.unimplemented?.some((o) => String(o) === v) ?? false;
      if (mine.length > 0 && mine.every((h) => h.note.startsWith('skipped: unimplemented') && unimplemented(h.value))) continue;
      // A value the scenario itself rules out (a precast pinned to a square under gridIntersection) says why in its header.
      if (mine.length > 0 && mine.every((h) => h.note.startsWith('skipped: scenario resolution rejects it') || (h.note.startsWith('skipped: unimplemented') && unimplemented(h.value)))) continue;
      out.push(`seed ${s.seed}: ${k} was read by the default run but has no section that ran`);
    }
  }
  return out;
}

const goldens = discover();
const built = new Map<string, FlagMatrix>();
const matrixOf = (g: Golden): FlagMatrix => {
  let m = built.get(g.name);
  if (!m) built.set(g.name, (m = buildFlagMatrix({ scenarioPath: g.scenario, journalPath: g.journal, seeds: g.seeds, env })));
  return m;
};

describe(`flag-matrix goldens (review any diff on purpose; regenerate with UPDATE_FLAG_MATRIX=1)`, () => {
  it('discovers the golden scenarios', () => {
    expect(goldens.map((g) => g.name)).toEqual(expect.arrayContaining(['oa-interrupts-move', 'pull-into-spikes']));
  });

  for (const g of goldens) {
    it(`${g.name} (seed${g.seeds.length > 1 ? 's' : ''} ${g.seeds.join(', ')}) matches ${g.name}.flag-matrix.log`, () => {
      const m = matrixOf(g);
      const path = join(G, `${g.name}.flag-matrix.log`);
      if (UPDATE) writeFileSync(path, m.text);
      // The matrix starts from the golden fight itself.
      for (const s of m.seeds) expect(s.logHash, `${g.name} seed ${s.seed}: the default run isn't the golden log`).toBe(goldenHash(g, s.seed));
      expect(problems(m)).toEqual([]);
      expect(existsSync(path), `${path} is missing; generate it with UPDATE_FLAG_MATRIX=1`).toBe(true);
      expect(m.text).toBe(readFileSync(path, 'utf8'));
    });
  }

  it('the coverage check catches a read flag with no section, and a crashed section', () => {
    const m = matrixOf(goldens[0]!);
    const s = m.seeds[0]!;
    const k = s.flagsUsed.find((f) => m.text.includes(`\n== ${f}=`))!;
    const renamed = m.text.replace(new RegExp(`^== ${k}=`, 'gm'), `== x${k}=`);
    expect(problems({ ...m, text: renamed })).toContain(`seed ${s.seed}: ${k} was read by the default run but has no section that ran`);
    const crashed = m.text.replace(new RegExp(`^== ${k}=(\\S+) \\(.*\\) ==$`, 'gm'), `== ${k}=$1 (crashed: Error: boom) ==`);
    expect(problems({ ...m, text: crashed }).filter((p) => p.includes(`${k}=`) && p.includes('crashed')).length).toBeGreaterThan(0);
  });
});
