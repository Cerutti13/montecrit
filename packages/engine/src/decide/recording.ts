// RecordingDecider: wraps any decider and records each answer as a journal entry. Replaying
// the recording through JournalDecider reproduces the fight exactly, without the AI code.

import type { JournalEntry } from '../replay.ts';
import type { Decider, DecisionPoint, UnitView } from './decider.ts';

export class Recorder {
  readonly entries: JournalEntry[] = [];
}

export class RecordingDecider implements Decider {
  readonly name: string;
  private readonly inner: Decider;
  private readonly rec: Recorder;

  constructor(inner: Decider, rec: Recorder) {
    this.inner = inner;
    this.rec = rec;
    this.name = inner.name;
  }

  get lastBy(): string {
    return this.inner.lastBy ?? this.inner.name;
  }

  decide(view: UnitView, dp: DecisionPoint): number {
    const i = this.inner.decide(view, dp);
    this.rec.entries.push({ seat: view.q.units[dp.who]!.seat, key: dp.keyOf(i), at: dp.at });
    return i;
  }
}
