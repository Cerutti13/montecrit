// Replay key: everything a fight's log is a pure function of. Rerunning the same key gives
// the same log hash. Deciders aren't part of it: a recorded fight's journal replays it
// exactly, whoever (or whatever) made the choices the first time.

export interface JournalEntry {
  readonly seat: string;
  readonly key: string;
  /** Decision index; recorded journals always carry it, hand-written ones may omit it. */
  readonly at?: number;
}

export interface ReplayKey {
  readonly engineVersion: string;
  readonly contentHash: string;
  readonly scenario: string;
  readonly scenarioHash: string;
  readonly seed: number;
  readonly run: number;
  readonly journal: readonly JournalEntry[];
  /**
   * Who decides for each seat, in seat order ('baseline', 'journal>baseline'...). Part of the
   * key: the same scenario under different policies is a different fight. Like the journal, it's
   * left out of the log hash, so a recorded fight and its journal replay hash the same.
   */
  readonly policy: readonly string[];
}
