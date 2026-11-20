// Builds one decider per seat from a FightSetup. Seats with decider: journal answer from
// the journal; so does any seat the journal names (its scenario decider becomes its fallback),
// which lets a journal script the opening of a fight and hand back to the AI.

import type { JournalEntry } from '../replay.ts';
import type { DeciderName, FightSetup } from '../sim/setup.ts';
import { BaselineDecider } from './baseline.ts';
import { GreedyDecider } from './greedy/greedy.ts';
import type { Decider } from './decider.ts';
import { JournalCursor, JournalDecider } from './journal.ts';
import { playsSeat, policyDecider, type CompiledPolicy } from './policy.ts';
import { RandomLegalDecider } from './random-legal.ts';

export function namedDecider(name: Exclude<DeciderName, 'journal'>): Decider {
  return name === 'baseline' ? new BaselineDecider() : name === 'greedy' ? new GreedyDecider() : new RandomLegalDecider();
}

/**
 * Pass `cursor` to see afterwards how much of the journal was used (or a lenient one: see
 * JournalCursor). A `policy` plays the seats it covers (bindPolicy checks it first); a journal
 * still answers first for seats it names, falling back to the policy.
 */
export function makeDeciders(setup: FightSetup, journal: readonly JournalEntry[] = [], cursor: JournalCursor = new JournalCursor(journal), policy: CompiledPolicy | null = null): Decider[] {
  if (cursor.entries !== journal) throw new RangeError('makeDeciders: cursor is for a different journal');
  const seats = new Set(setup.seats.map((s) => s.seat));
  for (const e of journal) if (!seats.has(e.seat)) throw new RangeError(`journal names seat "${e.seat}", which isn't in scenario ${setup.scenario}`);
  const named = new Set(journal.map((e) => e.seat));
  return setup.seats.map((s, i) => {
    const own = (): Decider => (policy && playsSeat(policy, setup, i) ? policyDecider(policy) : namedDecider(s.decider === 'journal' ? (s.fallback ?? 'baseline') : s.decider));
    if (s.decider === 'journal') return new JournalDecider(cursor, s.fallback || (policy && playsSeat(policy, setup, i)) ? own() : null);
    if (named.has(s.seat)) return new JournalDecider(cursor, own());
    return own();
  });
}
