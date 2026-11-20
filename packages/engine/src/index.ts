export * from './rng/philox.ts';
export * from './rng/stream.ts';
export * from './odds/pmf.ts';
export * from './odds/group.ts';
export * from './dice/expr.ts';
export * from './rolls/rollspec.ts';
export * from './rules/flags.ts';
// content
export * from './content/types.ts';
export {
  ID_PATTERN,
  KEBAB,
  PACK_NAME,
  CONTENT_SCHEMAS,
  CharacterSchema,
  OVERRIDABLE,
  PICK_KEY,
  FlagsSchema,
  IdSchema,
  JournalSchema,
  KnobsSchema,
  ManifestSchema,
  MonsterSchema,
  PcSchema,
  ScenarioSchema,
  contentJsonSchemas,
  type CharacterSource,
  type JournalFile,
  type ManifestSource,
  type MonsterSource,
  type PcSource,
  type ScenarioSource,
} from './content/schema.ts';
export { compareDiags, formatDiag, parseYaml, peekKind, type Diag, type SourceDoc, type SourceFile, type YamlPath } from './content/yaml.ts';
export { closureHash, loadContent, type LoadResult } from './content/load.ts';
export { contentClosure, idsIn } from './content/closure.ts';
export {
  MODELED_MAX_LEVEL,
  expandCharacter,
  hitPoints,
  lintCharacter,
  renderSheet,
  sheetJson,
  WEAPON_MASTERY,
  type CharIssue,
  type CharacterExpansion,
  type CharacterLib,
  type DerivedSheet,
  type SheetAttack,
  type SheetFeature,
  type SheetNumber,
} from './content/character.ts';
export { CORE_OPTIONS, abilityMod, exprMean, floorMean, proficiencyBonus, unarmedStrike, weaponMod } from './content/compile.ts';
export { pbForCr } from './content/lint.ts';
export { SKILLS, keyName, type KeyPattern } from './content/rollkeys.ts';
export {
  KNOB_KEYS,
  parseJournal,
  parseKnobValue,
  resolveScenario,
  type ResolveResult,
  type ScenarioOverrides,
} from './scenario/resolve.ts';
export { extendScenario, extendsName, type ExtendResult } from './scenario/extend.ts';
// sim
export * from './version.ts';
export * from './replay.ts';
export * from './util/canon.ts';
export * from './util/hash.ts';
export * from './grid/cells.ts';
export { distFt, INF } from './grid/reach.ts';
export * from './sim/setup.ts';
export { COND, flagsUsedKeys, noProgressTurns, quietTurnsNow, STALEMATE_CAUSES, STALEMATE_DODGE_STREAK, STALEMATE_NO_DAMAGE_ROUNDS, stalemateCauseOf, stateHash, type GameState, type Life, type Outcome, type QueryState, type StalemateCause, type Unit } from './sim/state.ts';
export { createContext, replayKey, runFight, type FightOptions, type FightResult } from './sim/fight.ts';
export * from './decide/decider.ts';
export { BaselineDecider } from './decide/baseline.ts';
export { GreedyDecider, type ExplainPart, type ExplainRecord } from './decide/greedy/greedy.ts';
export { DEFAULT_WEIGHTS, type Weights } from './decide/greedy/weights.ts';
export { JournalCursor, JournalDecider, keysOf } from './decide/journal.ts';
export { RandomLegalDecider } from './decide/random-legal.ts';
export { Recorder, RecordingDecider } from './decide/recording.ts';
export { makeDeciders, namedDecider } from './decide/make.ts';
export { BUILTIN_POLICIES, bindPolicy, compilePolicy, playsSeat, policyDecider, ScriptedDecider, type CompiledPolicy, type RuleStats } from './decide/policy.ts';
export * from './log/events.ts';
export { damagePmf, expectedCapped, saveOdds } from './query/odds.ts';
export { forcedPaths, type ForcedPath } from './query/forced.ts';
export { areaCandidates, type AreaCand } from './query/area.ts';
export { SHAPE, areaCells, areaCellsFrom, shapeOf, sizeFtOf, widthFtOf } from './grid/area.ts';
export { actionEV, attackEV, threatAt, type ActionEV } from './query/threat.ts';
export { newQueryScratch, type QueryScratch } from './query/scratch.ts';
export { describe as describeEvent, renderLog, why } from './log/render.ts';
export { header } from './log/header.ts';
export { buildFrames, type FrameEnd, type TokenView, type ViewFrame, type ViewFrames, type ViewMarks, type ZoneView } from './log/view.ts';
export { deciderLabel, playOne, reachesPrivate, whyChains, withExplain, type PlayedFight } from './log/play.ts';
export { checkReplay, PER_RUN_FIELDS, runnerRun } from './mc/exemplar.ts';
export { DPR_BINS, dprBin, holm, mcnemarExact, nearestRank, newcombePaired, P_FLOOR, ratio, ratioDeltaSE, wilson, Z95, type Interval, type PairedDiff } from './mc/stats.ts';
export { BOOT_B, bootstrapRatios, diffReps, percentileCI, type RatioSeries } from './mc/boot.ts';
export {
  afterMerge,
  CHECKPOINT,
  CHUNK,
  DEATH_CAUSES,
  DEFAULT_MAX_N,
  DEFAULT_UNTIL_CI,
  exemplars,
  MAX_RUNS,
  maxWinHalfWidth,
  MIN_ADAPTIVE_N,
  mergeInto,
  newMerged,
  OUT,
  pairCounts,
  resolveSchedule,
  runArms,
  runChunk,
  validateArms,
  type ArmAcc,
  type ArmSpec,
  type ChunkResult,
  type Exemplars,
  type Merged,
  type OnFight,
  type RunOptions,
  type RunResult,
  type RunSchedule,
} from './mc/runner.ts';
export { computeReport, fmt, renderReport, type ArmStats, type Estimate, type PairStats, type Rate, type ReportMeta, type ReportStats } from './mc/report.ts';
export { reportModel, type ArmModel, type DamageCells, type DamageRow, type DprBin, type ReportModel } from './mc/model.ts';
