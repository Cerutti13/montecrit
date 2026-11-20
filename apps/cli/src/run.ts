// `montecrit run <scenario>`: one seeded fight, printed as a readable log with a header that
// says exactly what the numbers rest on (replay key, policies, knobs, every rule flag the
// fight read, stubs and placeholders); or, with -n N or --policy a,b,..., the Monte Carlo
// report over many fights (apps/cli/src/report.ts, docs/design/m1c.md 4-6).
//
//   --journal F       answer decisions from a journal; seats it names hand back to their AI after
//   --record F        write every decision made as a journal (replays the fight exactly)
//   --why SEQ         print the cause chain behind event #SEQ
//   --replay K[:P]    recompute a report and replay its exemplar K (closest loss, typical win, TPK, PC death)
//   --update-golden F write the log to F (only under scenarios/golden/, only SRD/test content)
//
// Exit codes: 0 ok, 1 content or scenario errors, 2 bad usage or a journal mismatch,
// 3 a journal ran out (NeedInput): append an answer from the printed keys and rerun.

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ArraySink,
  ENGINE_VERSION,
  HashSink,
  JournalCursor,
  JournalMismatch,
  NeedInput,
  Recorder,
  RecordingDecider,
  TeeSink,
  flagsUsedKeys,
  formatDiag,
  makeDeciders,
  parseFlagValue,
  parseJournal,
  parseKnobValue,
  renderLog,
  replayKey,
  resolveScenario,
  runFight,
  why,
  type FightSetup,
  type JournalEntry,
  type Knobs,
  type RuleFlags,
  type ExplainRecord,
  bindPolicy,
  type CompiledPolicy,
  CHUNK,
  DEFAULT_MAX_N,
  DEFAULT_UNTIL_CI,
  CHECKPOINT,
  MAX_RUNS,
  MIN_ADAPTIVE_N,
  validateArms,
  type ArmSpec,
  exemplars,
  type SourceFile,
  checkReplay,
  deciderLabel,
  header,
  playOne,
  reachesPrivate,
  runnerRun,
  whyChains,
  withExplain,
} from '@montecrit/engine';
import { REPO_ROOT, displayPath, isInside, isUnderRepo, readScenarioInput } from './files.ts';
import { seatPcs, type Job, type SeatPick } from '@montecrit/host';
import { defaultProcs, reportOutput, runInProcess, runInWorkers, type ReportRun, type ReportView } from './report.ts';
import { homeDir, loadPolicies, loadWithFiles, type Env, type Loaded } from './home.ts';
import type { CommandOutput } from './lint.ts';

// Moved to the engine (log/play.ts, log/header.ts) for the browser; re-exported for the CLI's tests and matrix.ts.
export { deciderLabel, header, playOne, reachesPrivate, whyChains, withExplain, type PlayedFight } from '@montecrit/engine';
import { UsageError } from './odds.ts';

export const RUN_USAGE = `usage: montecrit run <scenario.yaml> [options]

  --seed N            seed (default 42)
  --run N             run index within the seed (default 0)
  --journal F         answer decisions from journal F
  --record F          write every decision as a journal to F
  --flag K=V          override a rule flag (repeatable)
  --knob K=V          override a knob: maxRounds, attackDowned, lossCounts, downEnds (repeatable)
  --why SEQ           print the cause chain behind event #SEQ instead of the log
  --explain SEAT|all  under each turn decision of SEAT (or every seat), the greedy AI's top 3 options and their terms
  --policy A[,B,...]  play the seats a policy covers with it (built-ins: greedy, greedy-spendy, baseline, random-legal;
                      plus policies/ in the repo and ~/.montecrit/policies/). Several: compare them, the first is the reference
  --pc SEAT=CHAR      drop a character into a scenario seat (repeatable): a loaded character's id or a character
                      file (a loose file loads under a test: or private: id). The report and header mark the
                      calibration "not measured for this PC" and list the PC's partial and unimplemented content
  --json              machine-readable output
  --update-golden F   write the log to F (scenarios/golden/ only)
  --replay K[:POLICY] recompute the report (same -n, --seed, --policy, flags and knobs) and replay one of POLICY's
                      exemplar fights (default: the first policy's): closest-loss, typical-win, tpk or pc-death. Prints
                      the log and the cause chain of every PC drop, death and stabilize and of what ended the fight.
                      With a fixed -n only POLICY's fights rerun. --explain SEAT|all works here too

  Monte Carlo (a report over many fights):
  -n N                exactly N fights per policy (default: 1, or adaptive with --policy, --until-ci or --max-n)
  --until-ci H        adaptive: stop when every policy's win-rate CI is within +-H (default 0.01, about 9,600 fights at
                      a 50% win rate, 7,200 at 75%), checked every 1,000 fights from 1,000 on
  --max-n N           adaptive: stop at N fights at most (default 100,000)
  --pairs ref|all     compare each policy with the first (default), or every pair
  --verbose           every DPR histogram bin and every option picked
  --report-hash       after the report, its hash and the runs' hash (docs/design/m2.md 7.2); the browser shows the same two.
                      The report hash covers --chunk (compare like with like); the runs' hash doesn't
  --procs N           worker threads (default: the CPU count, at most 8; 1 runs in this process). Never changes the numbers
  --chunk N           fights per chunk, at most 1,000 (default 250; adaptive needs a divisor of 1,000). Never changes the numbers`;

function fail(lines: string[], code = 1): CommandOutput {
  return { out: '', err: lines.join('\n'), code };
}

/** Whether a journal written to `target` lands inside the repo, by real path (symlinks, case-insensitive file systems). */
function recordsIntoRepo(target: string, repoRoot: string): boolean {
  const realDir = (p: string): string => {
    let d = p;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    return realpathSync.native(d);
  };
  const root = realpathSync.native(repoRoot);
  return isInside(target, repoRoot) || isInside(realDir(dirname(target)), root) || realDir(dirname(target)).toLowerCase().startsWith(root.toLowerCase() + '/');
}

/** A recorded journal as YAML. Strings are JSON-quoted, which YAML reads back verbatim (a seat named "null" stays a string). */
export function journalYaml(setup: FightSetup, seed: number, run: number, entries: readonly JournalEntry[]): string {
  const q = (v: string) => JSON.stringify(v);
  const lines = [
    'kind: journal',
    `scenario: ${q(setup.scenario)}`,
    `seed: ${seed}`,
    `run: ${run}`,
    `engine: ${q(ENGINE_VERSION)}`,
    `contentHash: ${q(setup.contentHash)}`,
    `scenarioHash: ${q(setup.scenarioHash)}`,
    entries.length ? 'entries:' : 'entries: []',
    ...entries.map((e) => `  - { seat: ${q(e.seat)}, key: ${q(e.key)}${e.at === undefined ? '' : `, at: ${e.at}`} }`),
  ];
  return lines.join('\n') + '\n';
}

const MAX_RUN = 0xffffffff;

/** A shell word: as is when plain (and not starting with ~ or -, which the shell or a parser would read), else single-quoted. */
export function shellWord(w: string): string {
  if (/^[A-Za-z0-9_./:=,@+%][A-Za-z0-9_./~:=,@+%-]*$/.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

/**
 * A scenario path for a printed command, as the shell will read it from this directory:
 * relative to it when the file is under it (./name when it sits right here), ~/... under
 * home, else absolute; never a bare name (name lookup could find another file), and quoted
 * when it needs to be.
 */
export function replayPath(path: string, cwd: string = process.cwd()): string {
  if (isInside(path, cwd)) {
    // ./ when it sits right here (a bare name could be looked up elsewhere) or starts with ~ or -.
    const rel = relative(cwd, path);
    return shellWord(rel.includes('/') && !/^[~-]/.test(rel) ? rel : `./${rel}`);
  }
  const home = homedir();
  // ~/ stays outside any quotes, so the shell still expands it.
  return isInside(path, home) ? `~/${shellWord(relative(home, path))}` : shellWord(path);
}

/** A report run, planned but not run: runRun runs it here, runRunAsync in worker processes. */
export interface RunPlan {
  readonly arms: ArmSpec[];
  /** The run as plain data (texts, not paths): what worker threads rebuild it from. */
  readonly job: Job;
  readonly view: ReportView;
  readonly procs: number | null;
  readonly warnings: string[];
  /** --replay: which exemplar of which arm to play once the runs are in. */
  readonly replay: ReplayPlan | null;
}

export type ReplayKind = 'closest-loss' | 'typical-win' | 'tpk' | 'pc-death';

export interface ReplayPlan {
  readonly kind: ReplayKind;
  /** Index into RunPlan.arms. */
  readonly arm: number;
  readonly explain: string | null;
  readonly fileNotes: readonly string[];
}

const isPlan = (p: CommandOutput | RunPlan): p is RunPlan => 'job' in p;

function withRun(p: RunPlan, run: ReportRun): CommandOutput {
  if (p.replay) return replayOutput(p, p.replay, run);
  return { out: reportOutput(p.arms, run, { ...p.view, meta: { ...p.view.meta, checkpoint: run.checkpoint, hitCap: run.hitCap } }), err: p.warnings.join('\n'), code: 0 };
}

const REPLAY_NAME: Record<ReplayKind, string> = { 'closest-loss': 'closest loss', 'typical-win': 'typical win', tpk: 'TPK', 'pc-death': 'PC death' };

/** --replay: picks the exemplar from the recomputed runs, plays it with a log, and checks it is the fight the runner counted. */
function replayOutput(p: RunPlan, r: ReplayPlan, run: ReportRun): CommandOutput {
  const arm = p.arms[r.arm]!;
  const acc = run.merged.arms[r.arm]!;
  const ex = exemplars(acc);
  const idx = r.kind === 'closest-loss' ? ex.closestLoss : r.kind === 'typical-win' ? ex.typicalWin : r.kind === 'tpk' ? ex.tpk : ex.pcDeath;
  const what = REPLAY_NAME[r.kind];
  if (idx < 0) return { out: '', err: [...p.warnings, `run: no ${what} in ${acc.n} fights of ${arm.label}`].join('\n'), code: 1 };
  const seed = p.view.meta.seed;
  const f = playOne(arm.setup, seed, idx, arm.policy, r.explain);
  const o = f.result.outcome;
  const R = o.k === 'stalemate' ? arm.setup.knobs.maxRounds : o.round;
  // The replay must be the fight the runner counted (same final state, same per-run record); a
  // mismatch is a determinism bug.
  const copy = runnerRun(arm, seed, idx);
  const bad = checkReplay(acc, idx, copy.acc, copy.stateHash, f.result.stateHash);
  if (bad !== null) throw new Error(`replay of ${arm.label} run ${idx} is not the fight the runner counted: ${bad}`);
  const detail =
    r.kind === 'closest-loss' ? `enemies ${acc.foeHpLeft[idx]}/${acc.foeHpMax[idx]} HP left after ${R} rounds`
    : r.kind === 'typical-win' ? `won in ${R} rounds with PC HP ${acc.pcHpEnd[idx]}, the run nearest the median win`
    : r.kind === 'tpk' ? `the first TPK, ${o.k} after ${R} rounds`
    : `the first fight a PC died, ${o.k} after ${R} rounds`;
  const pol = arm.policy ? ` --policy ${arm.policy.id}` : '';
  const castIds = f.events.flatMap((e) => (e.k === 'cast' ? [e.via] : []));
  const out = [
    `exemplar ${what} for ${arm.label}: run ${idx} of ${acc.n} (${detail})`,
    `         the same fight without rerunning ${acc.n}: ${p.view.meta.replay} --run ${idx}${pol}`,
    '',
    ...header(arm.setup, seed, idx, [], f.policy, f.result.flagsUsed, castIds, r.fileNotes),
    '',
    ...withExplain(renderLog(f.events, arm.setup), f.explained),
    `logHash ${f.logHash} | stateHash ${f.result.stateHash}`,
    '',
    ...whyChains(f.events, arm.setup),
  ];
  return { out: out.join('\n'), err: p.warnings.join('\n'), code: 0 };
}

/** `montecrit run`, every arm in this process (tests, and --procs 1). */
export function runRun(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const p = planRun(argv, env, repoRoot);
  return isPlan(p) ? withRun(p, runInProcess(p.arms, p.job)) : p;
}

/** `montecrit run` from the command line: a report runs on worker threads (--procs, default min(8, cores)); --procs 1 runs here. */
export async function runRunAsync(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): Promise<CommandOutput> {
  const p = planRun(argv, env, repoRoot);
  if (!isPlan(p)) return p;
  const procs = p.procs ?? defaultProcs();
  const tty = process.stderr.isTTY === true;
  const progress = tty ? (n: number) => process.stderr.write(`\r${n} fights per policy`) : null;
  try {
    const run = procs <= 1 ? runInProcess(p.arms, p.job, progress) : await runInWorkers(p.job, procs, progress);
    return withRun(p, run);
  } finally {
    if (tty) process.stderr.write('\r\x1b[K');
  }
}

/**
 * --pc: puts each named character into its seat. The scenario's calibration record is dropped
 * (it was measured with the scenario's own PC) and a report note says so; the character's pack
 * joins the scenario's packs when its namespace isn't covered yet. The header and report already
 * list every seat's partial and unimplemented content.
 */
export function seatCharacters(
  input: unknown,
  path: string,
  pcs: readonly { seat: string; target: string }[],
  loaded: Loaded,
  targets: readonly { path: string; id: string | null; kind: string | null; pack: string | null }[],
): { input: unknown; notes: string[] } | { error: string } {
  // The file side (which file, which id, is it a character) is resolved here; the seating itself is
  // @montecrit/host's seatPcs, the same transformation the browser's seat picker makes.
  const picks: SeatPick[] = pcs.map((p) => {
    const t = existsSync(resolve(p.target)) ? targets.find((x) => x.path === resolve(p.target)) : undefined;
    const refuse = t && t.kind !== 'character' && t.kind !== 'pc' ? `--pc ${p.seat}: ${displayPath(t.path)} is ${t.kind ? `a kind: ${t.kind}` : 'not a content item'}, not a character` : undefined;
    return { seat: p.seat, id: t ? t.id : p.target, label: p.target, file: t ? displayPath(t.path) : null, pack: t?.pack ?? null, ...(refuse !== undefined ? { refuse } : {}) };
  });
  return seatPcs(input, path, picks, loaded.content!, loaded.sheets);
}

export function planRun(argv: readonly string[], env: Env, repoRoot: string): CommandOutput | RunPlan {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      seed: { type: 'string' },
      run: { type: 'string' },
      journal: { type: 'string' },
      record: { type: 'string' },
      flag: { type: 'string', multiple: true },
      knob: { type: 'string', multiple: true },
      why: { type: 'string' },
      explain: { type: 'string' },
      policy: { type: 'string' },
      json: { type: 'boolean' },
      'report-hash': { type: 'boolean' },
      'until-ci': { type: 'string' },
      'max-n': { type: 'string' },
      pairs: { type: 'string' },
      verbose: { type: 'boolean' },
      procs: { type: 'string' },
      chunk: { type: 'string' },
      'update-golden': { type: 'string' },
      replay: { type: 'string' },
      n: { type: 'string', short: 'n' },
      pc: { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { out: RUN_USAGE, err: '', code: 0 };
  if (positionals.length !== 1) throw new UsageError('run takes exactly one scenario file');

  // Every argument is checked before anything runs or is written.
  const int = (name: string, raw: string | undefined, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw) || Number(raw) > max) throw new UsageError(`--${name} needs a whole number from 0 to ${max}, got "${raw}"`);
    return Number(raw);
  };
  const seedArg = int('seed', values.seed);
  const runArg = int('run', values.run, MAX_RUN);
  const whySeq = int('why', values.why);
  const golden = values['update-golden'];
  const nArg = int('n', values.n, MAX_RUNS);
  if (nArg === 0) throw new UsageError('-n needs at least 1 fight');
  const policyIds = values.policy === undefined ? [] : values.policy.split(',').map((p) => p.trim());
  if (policyIds.some((p) => p === '')) throw new UsageError(`--policy: an empty id in "${values.policy}"`);
  policyIds.forEach((p, i) => {
    if (policyIds.indexOf(p) !== i) throw new UsageError(`--policy lists ${p} twice`);
  });
  let replayArg: { kind: ReplayKind; arm: string | null } | null = null;
  if (values.replay !== undefined) {
    const m = /^(closest-loss|typical-win|tpk|pc-death)(?::(.+))?$/.exec(values.replay);
    if (!m) throw new UsageError(`--replay takes closest-loss, typical-win, tpk or pc-death, optionally :POLICY, got "${values.replay}"`);
    replayArg = { kind: m[1] as ReplayKind, arm: m[2] ?? null };
    if (nArg === 1) throw new UsageError('--replay picks a fight out of a report: give the report\'s -n (more than 1), or drop -n for an adaptive run');
    if (runArg !== undefined || values.journal !== undefined || values.record !== undefined || whySeq !== undefined || golden !== undefined) {
      throw new UsageError('--replay finds its own run; drop --run, --journal, --record, --why and --update-golden');
    }
    if (values.json || values.pairs !== undefined || values.verbose) throw new UsageError('--json, --pairs and --verbose shape a report; --replay prints one fight');
  }
  // --explain is a one-fight flag, except under --replay (which plays one fight in the end).
  const oneFight = runArg !== undefined || values.journal !== undefined || values.record !== undefined || whySeq !== undefined || (values.explain !== undefined && !replayArg) || golden !== undefined;
  // Without -n, a policy list or an adaptive target asks for the adaptive report (design 4.3, resolution 12).
  const report = replayArg !== null || (nArg !== undefined ? nArg > 1 : (policyIds.length > 0 || values['until-ci'] !== undefined || values['max-n'] !== undefined) && !oneFight);
  const mcFlags = (['until-ci', 'max-n', 'pairs', 'verbose', 'procs', 'chunk', 'report-hash'] as const).filter((k) => values[k] !== undefined);
  if (report && oneFight) throw new UsageError('--run, --journal, --record, --why, --explain and --update-golden are for one fight; drop -n (or give -n 1)');
  if (!report && policyIds.length > 1) {
    const forced = [runArg !== undefined && '--run', values.journal !== undefined && '--journal', values.record !== undefined && '--record', whySeq !== undefined && '--why', values.explain !== undefined && '--explain', golden !== undefined && '--update-golden'].filter((x): x is string => x !== false);
    throw new UsageError(
      forced.length > 0
        ? `${forced.join(', ')} ${forced.length > 1 ? 'are' : 'is'} for one fight, and one fight plays one policy: give one --policy, or drop ${forced.join(' and ')}${nArg === 1 ? ' and -n 1' : ''} to compare several`
        : 'one fight plays one policy; to compare several, give -n N or drop -n for an adaptive run',
    );
  }
  if (!report && mcFlags.length) throw new UsageError(`--${mcFlags[0]} is for a Monte Carlo report (-n N, or --policy without -n)`);
  if (report && nArg !== undefined && (values['until-ci'] !== undefined || values['max-n'] !== undefined)) throw new UsageError('--until-ci and --max-n are for an adaptive run; drop -n');
  let untilCi = DEFAULT_UNTIL_CI;
  if (values['until-ci'] !== undefined) {
    untilCi = Number(values['until-ci']);
    if (!/^0?\.\d+$/.test(values['until-ci']) || !(untilCi > 0 && untilCi <= 0.5)) throw new UsageError(`--until-ci needs a half-width like 0.01 (above 0, at most 0.5), got "${values['until-ci']}"`);
  }
  const maxN = int('max-n', values['max-n'], MAX_RUNS) ?? DEFAULT_MAX_N;
  if (maxN < MIN_ADAPTIVE_N) throw new UsageError(`--max-n needs at least ${MIN_ADAPTIVE_N} (the first checkpoint)`);
  const pairs = values.pairs ?? 'ref';
  if (pairs !== 'ref' && pairs !== 'all') throw new UsageError(`--pairs takes ref or all, got "${pairs}"`);
  // The hash is defined at the CLI defaults (docs/design/m2.md 7.2), so there is never a second, non-comparable one.
  if (values['report-hash'] && (pairs !== 'ref' || values.json || replayArg)) throw new UsageError('--report-hash hashes the default report: drop --pairs all, --json and --replay');
  const procs = int('procs', values.procs, 256);
  if (procs === 0) throw new UsageError('--procs needs at least 1');
  // At most the checkpoint spacing (an adaptive run needs a divisor of 1,000); it also bounds the
  // pool's buffer at ahead x arms chunks.
  const chunkSize = int('chunk', values.chunk, CHECKPOINT) ?? CHUNK;
  if (chunkSize === 0) throw new UsageError('--chunk needs at least 1');
  if (golden !== undefined && (values.json || whySeq !== undefined)) throw new UsageError('--update-golden writes the text log; drop --json and --why');
  const pcArgs = (values.pc ?? []).map((kv) => {
    const m = /^([^=]+)=(.+)$/.exec(kv);
    if (!m) throw new UsageError(`--pc needs SEAT=CHARACTER (an id or a file), got "${kv}"`);
    return { seat: m[1]!, target: m[2]! };
  });
  pcArgs.forEach((p, i) => {
    if (pcArgs.findIndex((q) => q.seat === p.seat) !== i) throw new UsageError(`--pc names seat ${p.seat} twice`);
  });
  if (golden !== undefined && pcArgs.length > 0) throw new UsageError('--update-golden writes a golden for the scenario as written; drop --pc');

  let flags: Partial<RuleFlags> = {};
  for (const kv of values.flag ?? []) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(kv);
    if (!m) throw new UsageError(`--flag needs KEY=VALUE, got "${kv}"`);
    try {
      flags = { ...flags, ...parseFlagValue(m[1]!, m[2]!) };
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  let knobs: Partial<Knobs> = {};
  for (const kv of values.knob ?? []) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(kv);
    if (!m) throw new UsageError(`--knob needs KEY=VALUE, got "${kv}"`);
    try {
      knobs = { ...knobs, ...parseKnobValue(m[1]!, m[2]!) };
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }

  // A bare name (no path, no such file) is looked up in ~/.montecrit/scenarios/, then the repo's scenarios/.
  const arg = positionals[0]!;
  const byName = !existsSync(resolve(arg)) && /^[a-z0-9][a-z0-9-]*$/.test(arg) ? [join(homeDir(env), 'scenarios', `${arg}.yaml`), join(repoRoot, 'scenarios', `${arg}.yaml`)].find((p) => existsSync(p)) : undefined;
  const scenarioPath = byName ?? resolve(arg);
  const journalPath = values.journal === undefined ? undefined : resolve(values.journal);
  if (golden !== undefined) {
    const target = resolve(golden);
    const goldenDir = join(repoRoot, 'scenarios', 'golden');
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
    if (!/\.log$/.test(target)) return fail(['run: --update-golden writes a .log file'], 2);
    if (!existsSync(goldenDir) || !isInside(real(scenarioPath), realpathSync(goldenDir)) || !isInside(real(dirname(target)), realpathSync(goldenDir))) {
      return fail(['run: --update-golden only writes logs for scenarios under scenarios/golden/, into that folder'], 2);
    }
    if ([scenarioPath, journalPath].some((p) => p !== undefined && (p === target || real(p) === real(target)))) return fail(['run: --update-golden would overwrite its own input'], 2);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) return fail(['run: --update-golden won\'t write through a symlink'], 2);
  }

  const read = readScenarioInput(scenarioPath, repoRoot);
  if (read.errors.length) return fail([...read.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })), `run: can't read scenario ${positionals[0]}`]);
  const fileNotes: string[] = !isUnderRepo(scenarioPath, repoRoot) || read.base ? [`scenario file: ${displayPath(scenarioPath)}${read.base ? ` (extends ${displayPath(read.base)})` : ''}`] : [];
  const pcFiles = pcArgs.filter((p) => existsSync(resolve(p.target)));
  const { loaded, targets } = loadWithFiles(pcFiles.map((p) => p.target), env, repoRoot);
  if (!loaded.content) return fail([...loaded.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })), 'run: content has errors; run montecrit lint']);
  const scenarioNote = fileNotes[0] ?? null;
  let input = read.input;
  if (pcArgs.length > 0) {
    const seated = seatCharacters(read.input, read.path, pcArgs, loaded, targets);
    if ('error' in seated) return fail([`run: ${seated.error}`], 2);
    input = seated.input;
    fileNotes.push(...seated.notes);
  }
  const res = resolveScenario(input, read.path, loaded.content, { flags, knobs });
  if (!res.setup) return fail(res.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })));
  const setup = res.setup;
  // A golden log or recorded journal names what the fight reached; private content never goes into the repo.
  if (reachesPrivate(setup)) {
    if (golden !== undefined) return fail(['run: this fight uses private content; --update-golden would write it into the repo'], 2);
    if (values.record && recordsIntoRepo(resolve(values.record), repoRoot)) return fail(['run: this fight uses private content; --record it to a path outside the repo (e.g. ~/.montecrit/)'], 2);
  }

  const warnings: string[] = res.warnings.map((d) => formatDiag({ ...d, path: displayPath(d.path) }));
  if (report) {
    let arms: ArmSpec[] = [{ label: 'scenario', setup, policy: null }];
    let policyFiles: readonly SourceFile[] = [];
    if (policyIds.length) {
      const all = loadPolicies(env, repoRoot);
      policyFiles = all.files;
      if (all.errors.length) return fail([...all.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })), 'run: policies have errors; run montecrit lint']);
      const missing = policyIds.filter((id) => !all.byId.has(id));
      if (missing.length) return fail([`run: no policy ${missing.map((m) => `"${m}"`).join(', ')} (known: ${[...all.byId.keys()].sort().join(', ')})`], 2);
      arms = policyIds.map((id) => ({ label: id, setup, policy: all.byId.get(id)! }));
    }
    const bad = validateArms(arms);
    if (bad.length) return fail(bad.map((m) => `run: ${m}`), 2);
    let replayPlan: ReplayPlan | null = null;
    if (replayArg) {
      const pick = replayArg;
      const idx = pick.arm === null ? 0 : arms.findIndex((a) => a.label === pick.arm);
      if (idx < 0) return fail([`run: --replay: no policy "${pick.arm}" in this run (${arms.map((a) => a.label).join(', ')})`], 2);
      const want = values.explain;
      if (want !== undefined && want !== 'all' && !setup.seats.some((s) => s.seat === want)) return fail([`run: --explain: no seat "${want}" (seats: ${setup.seats.map((s) => s.seat).join(', ')}, or all)`], 2);
      // A fixed -n needs only the chosen arm: its exemplars depend on its own fights alone.
      // Adaptive stopping looks at every arm, so all of them rerun.
      if (nArg !== undefined) arms = [arms[idx]!];
      replayPlan = { kind: pick.kind, arm: nArg !== undefined ? 0 : idx, explain: want ?? null, fileNotes };
    }
    const seed = seedArg ?? 42;
    if (nArg === undefined && chunkSize > 0 && 1000 % chunkSize !== 0) throw new UsageError(`--chunk: an adaptive run needs a chunk size that divides 1,000, got ${chunkSize}`);
    const job: Job = {
      v: 1,
      packs: loaded.files,
      scenario: { input, path: read.path },
      policies: policyFiles,
      flags,
      knobs,
      arms: arms.map((a) => ({ label: a.label, policy: a.policy?.id ?? null, hash: a.policy?.hash ?? null })),
      seed,
      run: nArg !== undefined ? { n: nArg, chunkSize } : { untilCi, maxN, chunkSize },
      expect: { scenarioHash: setup.scenarioHash, contentHash: setup.contentHash },
    };
    const overrides = [
      ...pcArgs.map((p) => `--pc ${shellWord(`${p.seat}=${existsSync(resolve(p.target)) ? replayPath(resolve(p.target)) : p.target}`)}`),
      ...Object.keys(flags).sort().map((k) => `--flag ${k}=${String(flags[k as keyof RuleFlags])}`),
      ...Object.keys(knobs).sort().map((k) => `--knob ${k}=${String(knobs[k as keyof Knobs])}`),
    ];
    const replay = ['montecrit run', replayPath(read.path), `--seed ${seed}`, ...overrides].join(' ');
    const meta = { seed, replay, fileNote: scenarioNote, adaptive: nArg === undefined, checkpoint: null, hitCap: false, untilCi, pairs, verbose: values.verbose === true } as const;
    return { arms, job, view: { meta, json: values.json === true, hash: values['report-hash'] === true }, procs: procs ?? null, warnings, replay: replayPlan };
  }
  let journal: JournalEntry[] = [];
  let seed = seedArg ?? 42;
  let runIdx = runArg ?? 0;
  if (journalPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(journalPath, 'utf8');
    } catch (e) {
      return fail([`run: can't read journal ${values.journal}: ${(e as Error).message}`], 2);
    }
    const pj = parseJournal(text, journalPath);
    if (!pj.journal) return fail(pj.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })), 2);
    const j = pj.journal;
    if (j.scenario !== setup.scenario) return fail([`run: journal is for scenario ${j.scenario}, not ${setup.scenario}`], 2);
    journal = j.entries.map((e) => (e.at === undefined ? { seat: e.seat, key: e.key } : { seat: e.seat, key: e.key, at: e.at }));
    // A recorded journal (decision indices) only makes sense at the seed and run it came from;
    // a hand-written one (keys only) can script any seed.
    const recorded = journal.some((e) => e.at !== undefined);
    seed = seedArg ?? j.seed;
    runIdx = runArg ?? j.run;
    if (recorded && (seed !== j.seed || runIdx !== j.run)) {
      return fail([`run: this journal was recorded at seed ${j.seed} run ${j.run}; drop --seed/--run to replay it, or strip its "at" fields to script another seed`], 2);
    }
    // Keys and decision indices catch real drift; version and hash changes are warnings.
    if (j.engine !== ENGINE_VERSION) warnings.push(`warning: journal recorded on engine ${j.engine}, this is ${ENGINE_VERSION}`);
    if (j.contentHash !== setup.contentHash) warnings.push('warning: content changed since the journal was recorded');
    if (j.scenarioHash !== undefined && j.scenarioHash !== setup.scenarioHash) warnings.push('warning: the scenario, flags or knobs differ from when the journal was recorded');
  }

  let played: CompiledPolicy | null = null;
  if (values.policy !== undefined) {
    const all = loadPolicies(env, repoRoot);
    if (all.errors.length) return fail([...all.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) })), 'run: policies have errors; run montecrit lint']);
    played = all.byId.get(values.policy) ?? null;
    if (!played) return fail([`run: no policy "${values.policy}" (known: ${[...all.byId.keys()].sort().join(', ')})`], 2);
    const bad = bindPolicy(played, setup);
    if (bad.length) return fail(bad.map((m) => `run: ${m}`), 2);
  }
  const policy = deciderLabel(setup, journal, played);
  const cursor = new JournalCursor(journal);
  const rec = new Recorder();
  let deciders;
  try {
    deciders = makeDeciders(setup, journal, cursor, played);
  } catch (e) {
    return fail([`run: ${(e as Error).message}`], 2);
  }
  const explained: ExplainRecord[] = [];
  if (values.explain !== undefined) {
    const want = values.explain;
    if (want !== 'all' && !setup.seats.some((s) => s.seat === want)) return fail([`run: --explain: no seat "${want}" (seats: ${setup.seats.map((s) => s.seat).join(', ')}, or all)`], 2);
    deciders.forEach((d, i) => {
      if (want === 'all' || setup.seats[i]!.seat === want) d.explainTo?.((r) => explained.push(r as ExplainRecord));
    });
  }
  if (values.record) deciders = deciders.map((d) => new RecordingDecider(d, rec));
  const arr = new ArraySink();
  const hs = new HashSink();
  let result;
  try {
    result = runFight(setup, seed, runIdx, deciders, new TeeSink(arr, hs), { journal, policy });
  } catch (e) {
    if (e instanceof NeedInput) {
      return { out: '', err: [`needs input: ${e.seat} (${e.kind} @${e.at})`, ...e.keys.map((k) => `  ${k}`), `append { seat: ${e.seat}, key: <one of the above>, at: ${e.at} } to the journal and rerun`].join('\n'), code: 3 };
    }
    if (e instanceof JournalMismatch) return fail([`run: ${e.message}`], 2);
    throw e;
  }
  if (cursor.pos < journal.length) warnings.push(`warning: ${journal.length - cursor.pos} journal entr${journal.length - cursor.pos === 1 ? 'y was' : 'ies were'} never used (the fight ended first)`);

  let out: string;
  if (whySeq !== undefined) {
    try {
      out = why(arr.events, setup, whySeq);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  } else if (values.json) {
    const key = replayKey(setup, seed, runIdx, journal, policy);
    out = JSON.stringify({ key, outcome: result.outcome, logHash: hs.hex(), flagsUsed: flagsUsedKeys(result.flagsUsed), events: arr.events }, null, 2);
  } else {
    const castIds = arr.events.flatMap((e) => (e.k === 'cast' ? [e.via] : []));
    out = [...header(setup, seed, runIdx, journal, policy, result.flagsUsed, castIds, fileNotes), '', ...withExplain(renderLog(arr.events, setup), explained), `logHash ${hs.hex()}`].join('\n');
  }

  const write = (path: string, text: string): string | null => {
    try {
      writeFileSync(path, text);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  if (values.record) {
    const err = write(resolve(values.record), journalYaml(setup, seed, runIdx, rec.entries));
    if (err) return fail([`run: can't write journal ${values.record}: ${err}`], 2);
  }
  if (golden !== undefined) {
    const err = write(resolve(golden), out + '\n');
    if (err) return fail([`run: can't write ${golden}: ${err}`], 2);
  }
  return { out, err: warnings.join('\n'), code: 0 };
}
