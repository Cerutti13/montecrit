// Flag-matrix goldens (docs/design/m1b.md, Critique resolutions item 9). A golden fight is
// run as `montecrit run` runs it; then every rule flag that run marked is re-run under each of
// its other values with the same seed and journal. The journal is lenient here (matrix mode
// only): at its first mismatch every journal seat hands over to its fallback, or to the
// baseline AI when the scenario gives it none, and the section says where that happened.
//
// One text per scenario, every seed in it:
//
//   #### seed 1 ####
//   default  run 0 | journal of 1 entry: held | logHash ...
//   flags read: a, b, c
//
//   == a=other (journal diverged at @5 | journal held) ==
//   <the log lines `run` prints after the header>
//   logHash ...
//
// A value the engine doesn't implement, or one scenario resolution rejects, gets a header-only
// section saying so. A variant that throws gets one too, marked "crashed".

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  ArraySink,
  FLAG_INFO,
  HashSink,
  JournalCursor,
  JournalDecider,
  JournalMismatch,
  NeedInput,
  TeeSink,
  flagsUsedKeys,
  formatDiag,
  makeDeciders,
  namedDecider,
  parseJournal,
  renderLog,
  resolveScenario,
  runFight,
  type Decider,
  type Diag,
  type FightSetup,
  type FlagInfo,
  type JournalEntry,
  type RuleFlags,
} from '@montecrit/engine';
import { REPO_ROOT, readScenarioInput } from './files.ts';
import { loadKnown, type Env, type Loaded } from './home.ts';
import { deciderLabel } from './run.ts';

type FlagKey = keyof RuleFlags;
type Content = NonNullable<Loaded['content']>;

export interface MatrixOptions {
  readonly scenarioPath: string;
  readonly journalPath: string;
  /** Seeds to run, in order; default the journal's own. A recorded journal (with `at`) only replays at its own seed. */
  readonly seeds?: readonly number[];
  readonly env?: Env;
  readonly repoRoot?: string;
}

export type VariantStatus = 'ran' | 'unimplemented' | 'rejected' | 'crashed';

export interface MatrixVariant {
  readonly flag: FlagKey;
  readonly value: string;
  readonly status: VariantStatus;
  /** Decision index where the journal stopped matching; -1 if it held (or the variant didn't run). */
  readonly divergedAt: number;
  /** The rendered body is line-for-line the default run's. */
  readonly sameAsDefault: boolean;
}

export interface MatrixSeed {
  readonly seed: number;
  readonly run: number;
  readonly logHash: string;
  readonly flagsUsed: readonly FlagKey[];
  readonly variants: readonly MatrixVariant[];
}

export interface FlagMatrix {
  readonly scenario: string;
  readonly seeds: readonly MatrixSeed[];
  readonly text: string;
}

interface Fought {
  readonly body: string[];
  readonly logHash: string;
  readonly flagsUsed: FlagKey[];
  readonly cursor: JournalCursor;
}

/** Runs one fight and renders the lines `run` prints after its header. Lenient: matrix mode. */
function fight(setup: FightSetup, seed: number, run: number, journal: readonly JournalEntry[], lenient: boolean): Fought {
  const cursor = new JournalCursor(journal, lenient);
  let deciders: Decider[] = makeDeciders(setup, journal, cursor);
  let policy = deciderLabel(setup, journal);
  if (lenient) {
    // A journal-only seat has no fallback; in matrix mode it hands over to the baseline AI.
    deciders = deciders.map((d, i) => {
      const s = setup.seats[i]!;
      return s.decider === 'journal' && s.fallback === null ? new JournalDecider(cursor, namedDecider('baseline')) : d;
    });
    policy = policy.map((p) => (p === 'journal' ? 'journal>baseline' : p));
  }
  const arr = new ArraySink();
  const hs = new HashSink();
  const result = runFight(setup, seed, run, deciders, new TeeSink(arr, hs), { journal, policy });
  return { body: renderLog(arr.events, setup), logHash: hs.hex(), flagsUsed: flagsUsedKeys(result.flagsUsed), cursor };
}

const entries = (n: number): string => `${n} entr${n === 1 ? 'y' : 'ies'}`;

function journalNote(c: JournalCursor): string {
  if (c.divergedAt >= 0) return `journal diverged at @${c.divergedAt}`;
  const unused = c.entries.length - c.pos;
  return unused > 0 ? `journal held, ${entries(unused)} unused` : 'journal held';
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, '; ');

/** Builds the flag matrix for one golden scenario. Throws if the scenario, content, journal or default run is broken. */
export function buildFlagMatrix(opts: MatrixOptions): FlagMatrix {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const show = (p: string) => relative(repoRoot, p);
  const diags = (ds: readonly Diag[]) => ds.map((d) => formatDiag({ ...d, path: show(d.path) })).join('\n');

  const read = readScenarioInput(opts.scenarioPath, repoRoot); // a scenario that extends another is merged with its base
  if (read.errors.length) throw new Error(`flag matrix: can't read ${show(opts.scenarioPath)}\n${diags(read.errors)}`);
  const { input: scenarioText, path: scenarioPath } = read;
  const loaded = loadKnown(env, repoRoot);
  if (!loaded.content) throw new Error(`flag matrix: content has errors\n${diags(loaded.errors)}`);
  const content: Content = loaded.content;
  const resolveWith = (flags: Partial<RuleFlags>) => resolveScenario(scenarioText, scenarioPath, content, { flags });

  const base = resolveWith({});
  if (!base.setup) throw new Error(`flag matrix: ${show(opts.scenarioPath)} doesn't resolve\n${diags(base.errors)}`);
  const pj = parseJournal(readFileSync(opts.journalPath, 'utf8'), opts.journalPath);
  if (!pj.journal) throw new Error(`flag matrix: bad journal ${show(opts.journalPath)}\n${diags(pj.errors)}`);
  const j = pj.journal;
  if (j.scenario !== base.setup.scenario) throw new Error(`flag matrix: ${show(opts.journalPath)} is for scenario ${j.scenario}, not ${base.setup.scenario}`);
  const journal: JournalEntry[] = j.entries.map((e) => (e.at === undefined ? { seat: e.seat, key: e.key } : { seat: e.seat, key: e.key, at: e.at }));
  const recorded = journal.some((e) => e.at !== undefined);
  const seeds = opts.seeds ?? [j.seed];
  const run = j.run;

  const lines: string[] = [
    `# Flag matrix for ${show(opts.scenarioPath)} with ${show(opts.journalPath)} (docs/design/m1b.md, Critique resolutions item 9).`,
    '# Every rule flag the default run read, re-run under each of its other values: same seed, same journal.',
    '# Matrix mode only: at the journal\'s first mismatch every journal seat hands over to its fallback (baseline if none).',
    '# Regenerate: UPDATE_FLAG_MATRIX=1 npx vitest run apps/cli/test/flag-matrix.test.ts',
  ];
  const out: MatrixSeed[] = [];

  for (const seed of seeds) {
    if (recorded && seed !== j.seed) throw new Error(`flag matrix: ${show(opts.journalPath)} was recorded at seed ${j.seed}; it can't script seed ${seed}`);
    let def: Fought;
    try {
      def = fight(base.setup, seed, run, journal, false);
    } catch (e) {
      if (e instanceof NeedInput || e instanceof JournalMismatch) throw new Error(`flag matrix: the default run of ${show(opts.scenarioPath)} at seed ${seed} doesn't replay its journal: ${e.message}`);
      throw e;
    }
    lines.push('', `#### seed ${seed} ####`, `default  run ${run} | journal of ${entries(journal.length)}: ${journalNote(def.cursor).replace(/^journal /, '')} | logHash ${def.logHash}`, `flags read: ${def.flagsUsed.join(', ') || '(none)'}`);
    const defBody = def.body.join('\n');
    const variants: MatrixVariant[] = [];
    for (const k of def.flagsUsed) {
      const info: FlagInfo<unknown> = FLAG_INFO[k];
      const current = base.setup.flags[k];
      for (const opt of info.options) {
        if (opt === current) continue;
        const value = String(opt);
        const head = (note: string) => `== ${k}=${value} (${note}) ==`;
        if (info.unimplemented?.includes(opt)) {
          lines.push('', head('skipped: unimplemented in FLAG_INFO'));
          variants.push({ flag: k, value, status: 'unimplemented', divergedAt: -1, sameAsDefault: false });
          continue;
        }
        const res = resolveWith({ [k]: opt } as Partial<RuleFlags>);
        if (!res.setup) {
          lines.push('', head(`skipped: scenario resolution rejects it: ${oneLine(diags(res.errors))}`));
          variants.push({ flag: k, value, status: 'rejected', divergedAt: -1, sameAsDefault: false });
          continue;
        }
        let v: Fought;
        try {
          v = fight(res.setup, seed, run, journal, true);
        } catch (e) {
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          lines.push('', head(`crashed: ${oneLine(msg)}`));
          variants.push({ flag: k, value, status: 'crashed', divergedAt: -1, sameAsDefault: false });
          continue;
        }
        const same = v.body.join('\n') === defBody;
        lines.push('', head(`${journalNote(v.cursor)}${same ? '; log identical to default' : ''}`));
        const added = v.flagsUsed.filter((f) => !def.flagsUsed.includes(f));
        const dropped = def.flagsUsed.filter((f) => !v.flagsUsed.includes(f));
        if (added.length || dropped.length) lines.push(`flags read vs default: ${[...added.map((f) => `+${f}`), ...dropped.map((f) => `-${f}`)].join(' ')}`);
        lines.push(...v.body, `logHash ${v.logHash}`);
        variants.push({ flag: k, value, status: 'ran', divergedAt: v.cursor.divergedAt, sameAsDefault: same });
      }
    }
    out.push({ seed, run, logHash: def.logHash, flagsUsed: def.flagsUsed, variants });
  }
  return { scenario: base.setup.scenario, seeds: out, text: lines.join('\n') + '\n' };
}
