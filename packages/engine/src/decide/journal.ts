// JournalDecider: answers from a recorded or hand-written list of choices, by stable key.
// One cursor walks the journal in order across every journal seat. Each entry must name the
// deciding seat, match the decision index when it carries one, and match a legal key; any
// mismatch throws. When the journal runs out, a seat hands over to its fallback, or the
// fight stops with NeedInput listing the legal keys, so a caller can append an answer and
// rerun from the seed (play by rerun). A lenient cursor (flag-matrix goldens: the same
// journal under another flag value) stops at its first mismatch instead of throwing, and
// every journal seat hands over to its fallback from there.

import type { JournalEntry } from '../replay.ts';
import { JournalMismatch, NeedInput, type Decider, type DecisionPoint, type UnitView } from './decider.ts';

export class JournalCursor {
  readonly entries: readonly JournalEntry[];
  readonly lenient: boolean;
  pos = 0;
  /** Lenient only: the decision index where the journal stopped matching, or -1. */
  divergedAt = -1;
  constructor(entries: readonly JournalEntry[], lenient = false) {
    this.entries = entries;
    this.lenient = lenient;
  }
  get exhausted(): boolean {
    return this.pos >= this.entries.length;
  }
}

export class JournalDecider implements Decider {
  readonly name = 'journal';
  private readonly cursor: JournalCursor;
  private readonly fallback: Decider | null;
  lastBy = 'journal';

  constructor(cursor: JournalCursor, fallback: Decider | null) {
    this.cursor = cursor;
    this.fallback = fallback;
  }

  explainTo(sink: ((r: unknown) => void) | null): void {
    this.fallback?.explainTo?.(sink); // the journal itself has nothing to explain
  }

  decide(view: UnitView, dp: DecisionPoint): number {
    const seat = view.q.units[dp.who]!.seat;
    const c = this.cursor;
    this.lastBy = 'journal';
    if (c.exhausted) {
      if (this.fallback) {
        const i = this.fallback.decide(view, dp);
        this.lastBy = this.fallback.lastBy ?? this.fallback.name;
        return i;
      }
      throw new NeedInput(seat, dp.k, dp.at, keysOf(dp, view));
    }
    const e = c.entries[c.pos]!;
    // W1 (P7, P9): firstAttack and moveTo are optional choices whose 'pass' a turn's bare "pass" would
    // also match, so, like a pre-roll window, a journal answers them only by naming their decision index.
    if ((dp.k === 'preRoll' || dp.k === 'firstAttack' || dp.k === 'moveTo') && !answersPreRoll(e, seat, dp)) {
      // A pre-roll window opens at almost every d20 test near the reactor; a journal answers
      // only the ones it names by `at`, and the rest go to the seat's fallback, or pass (item 0).
      if (!this.fallback) return 0;
      const i = this.fallback.decide(view, dp);
      this.lastBy = this.fallback.lastBy ?? this.fallback.name;
      return i;
    }
    const where = `journal entry ${c.pos} (${e.seat} ${e.key}${e.at === undefined ? '' : ` @${e.at}`})`;
    const matches = e.seat === seat && (e.at === undefined || e.at === dp.at) && keyIndex(dp, e.key) >= 0;
    if (!matches && c.lenient) {
      c.divergedAt = dp.at;
      c.pos = c.entries.length;
      return this.decide(view, dp);
    }
    if (e.seat !== seat) throw new JournalMismatch(`${where} is for ${e.seat}, but ${seat} is deciding (${dp.k} @${dp.at})`);
    if (e.at !== undefined && e.at !== dp.at) throw new JournalMismatch(`${where}: the engine is at decision @${dp.at}`);
    const i = keyIndex(dp, e.key);
    if (i >= 0) {
      c.pos++;
      return i;
    }
    throw new JournalMismatch(`${where} isn't legal now; legal: ${keysOf(dp).join(', ')}`);
  }
}

/** A journal answers a pre-roll window (and W1's firstAttack and moveTo) only by naming its decision index: a bare "pass" means a turn. */
function answersPreRoll(e: JournalEntry, seat: string, dp: DecisionPoint): boolean {
  return e.seat === seat && e.at === dp.at && keyIndex(dp, e.key) >= 0;
}

/** Index of the legal item with this key, or -1 (place lists answer by binary search). */
function keyIndex(dp: DecisionPoint, key: string): number {
  if (dp.indexOfKey) return dp.indexOfKey(key);
  for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i) === key) return i;
  return -1;
}

export function keysOf(dp: DecisionPoint, view?: UnitView): string[] {
  const keys: string[] = [];
  // An area placement can offer thousands of anchors: name the count, the anchors under each
  // creature (square-centered areas), and the range's ends.
  if (dp.k === 'place' && dp.legal.n > 12) {
    const under: string[] = [];
    if (view) {
      for (const u of view.q.units) {
        if (u.life === 'dead') continue;
        for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.cell === u.cell) under.push(`${dp.keyOf(i)} (${u.seat})`);
      }
    }
    return [`${dp.legal.n} anchors${under.length ? `; under creatures: ${under.join(', ')}` : ''}; from ${dp.keyOf(0)} to ${dp.keyOf(dp.legal.n - 1)}`];
  }
  for (let i = 0; i < dp.legal.n; i++) keys.push(dp.keyOf(i));
  return keys;
}
