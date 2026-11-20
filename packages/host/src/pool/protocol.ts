// The worker protocol (docs/design/m2.md 2.4): four message kinds in, five out, plain data only,
// so they cross Node worker_threads and browser Workers by structured clone alike. `gen` ties a
// reply to the worker incarnation that was asked; a reply from an older one is dropped. Content
// never crosses (it holds a private Map); a worker rebuilds it from the job's texts.

import type { ArmAcc, ExplainRecord, GameEvent, Life, Outcome, ReportMeta, ReportModel, ReportStats, RunResult } from '@montecrit/engine';
import type { Job } from '../job.ts';

export type WorkerOp =
  | { readonly op: 'report'; readonly run: RunResult; readonly meta: ReportMeta }
  | { readonly op: 'play'; readonly arm: number; readonly run: number; readonly explain: string | null; readonly fileNotes: readonly string[] };
// M4 adds { op: 'odds' }; M5 adds { op: 'practice' } (NeedInput as a reply value). The envelope stays.

export type ToWorker =
  | { readonly t: 'init'; readonly gen: number; readonly job: Job }
  | { readonly t: 'task'; readonly gen: number; readonly k: number; readonly arm: number }
  | { readonly t: 'call'; readonly gen: number; readonly id: number; readonly op: WorkerOp };

/** A played fight's end, plain (a FightResult's counters reach the setup, which holds closures). */
export interface PlayedEnd {
  readonly outcome: Outcome;
  readonly hp: readonly number[];
  readonly hpMax: readonly number[];
  readonly life: readonly Life[];
  readonly stateHash: string;
}

export interface PlayReply {
  readonly events: GameEvent[];
  readonly end: PlayedEnd;
  readonly logHash: string;
  readonly explained: readonly ExplainRecord[];
  /** Per seat: the decider that played it. */
  readonly policy: readonly string[];
  /** The one-fight header (log/header.ts), built from the fight's own flags. */
  readonly header: readonly string[];
  /** The same run through the runner's path, for checkReplay. */
  readonly oneRun: ArmAcc;
  readonly oneRunStateHash: string;
}

export interface ReportReply {
  readonly stats: ReportStats;
  readonly model: ReportModel;
  readonly text: readonly string[];
  readonly json: string;
  /** reportHash of `json`: the binding one only at pairs ref. */
  readonly hash: string;
  readonly accHash: string;
}

export type FromWorker =
  | { readonly t: 'ready'; readonly gen: number; readonly scenarioHash: string; readonly contentHash: string; readonly policyHashes: readonly (string | null)[] }
  | { readonly t: 'chunk'; readonly gen: number; readonly k: number; readonly arm: number; readonly acc: ArmAcc }
  | { readonly t: 'res'; readonly gen: number; readonly id: number; readonly ok: true; readonly value: PlayReply | ReportReply }
  | { readonly t: 'res'; readonly gen: number; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly t: 'error'; readonly gen: number; readonly message: string; readonly stack: string | null };
