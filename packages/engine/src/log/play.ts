// Playing one fight with a log attached, exactly as the runner plays it, and the text that goes
// with it: decider labels, explain records under their decisions, and the cause chains of the
// moments that matter. Moved from apps/cli/src/run.ts (docs/design/m2.md 1) so the CLI's
// --replay and the browser's replay viewer share one copy. Not on the simulation path: a log
// is attached, and the Maps and Sets here only index finished output.

import { makeDeciders } from '../decide/make.ts';
import { playsSeat, policyDecider, type CompiledPolicy } from '../decide/policy.ts';
import type { ExplainRecord } from '../decide/greedy/greedy.ts';
import type { JournalEntry } from '../replay.ts';
import { runFight, type FightResult } from '../sim/fight.ts';
import type { FightSetup } from '../sim/setup.ts';
import { ArraySink, HashSink, TeeSink, type GameEvent } from './events.ts';
import { why } from './render.ts';

const sign = (x: number) => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));

/** Each explain record under its decision's log line (the one ending "@AT]"). */
export function withExplain(lines: readonly string[], records: readonly ExplainRecord[]): string[] {
  if (records.length === 0) return [...lines];
  const byAt = new Map(records.map((r) => [r.at, r]));
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    const m = / @(\d+)\]$/.exec(line);
    const r = m ? byAt.get(Number(m[1])) : undefined;
    if (!r) continue;
    const pad = ' '.repeat(line.indexOf(line.trimStart().split(' ')[1]!) + 4);
    out.push(`${pad}why: ${r.note || `best of ${r.scored} scored`}`);
    for (const t of r.top) out.push(`${pad}  ${t.key === r.chosen ? '>' : ' '} ${t.key}  ${sign(t.ev)}${t.parts.length ? ` = ${t.parts.map((p) => `${p.term} ${sign(p.ev)}`).join(', ')}` : ''}`);
  }
  return out;
}

/** Whether any seat's template, spells or features are private content. */
export function reachesPrivate(setup: FightSetup): boolean {
  const priv = (id: string) => id.startsWith('private:');
  return setup.seats.some((s) => priv(s.tpl.id) || s.tpl.spells.some((e) => priv(e.spell.id)) || s.tpl.features.some((f) => priv(f.id)));
}

export function deciderLabel(setup: FightSetup, journal: readonly JournalEntry[], policy: CompiledPolicy | null = null): string[] {
  const named = new Set(journal.map((e) => e.seat));
  return setup.seats.map((s, i) => {
    const own = policy && playsSeat(policy, setup, i) ? policyDecider(policy).name : s.decider === 'journal' ? s.fallback : s.decider;
    if (s.decider === 'journal') return own ? `journal>${own}` : 'journal';
    return named.has(s.seat) ? `journal>${own}` : own!;
  });
}

/** One fight played exactly as the runner plays run `run` (same deciders), with a log attached. */
export interface PlayedFight {
  readonly result: FightResult;
  readonly events: GameEvent[];
  readonly logHash: string;
  readonly explained: ExplainRecord[];
  readonly policy: string[];
}

export function playOne(setup: FightSetup, seed: number, run: number, played: CompiledPolicy | null, explain: string | null = null): PlayedFight {
  const policy = deciderLabel(setup, [], played);
  const deciders = makeDeciders(setup, [], undefined, played);
  const explained: ExplainRecord[] = [];
  if (explain !== null) {
    deciders.forEach((d, i) => {
      if (explain === 'all' || setup.seats[i]!.seat === explain) d.explainTo?.((r) => explained.push(r as ExplainRecord));
    });
  }
  const arr = new ArraySink();
  const hs = new HashSink();
  const result = runFight(setup, seed, run, deciders, new TeeSink(arr, hs), { policy });
  return { result, events: arr.events, logHash: hs.hex(), explained, policy };
}

/** The cause chain of every PC drop, death and stabilize, then of what ended the fight: the last drop, death or stabilize (a stable PC can end it as a loss). */
export function whyChains(events: readonly GameEvent[], setup: FightSetup): string[] {
  const seat = (u: number) => setup.seats[u]!.seat;
  const chain = (seq: number) => why(events, setup, seq).split('\n').map((l) => `    ${l}`);
  const L = ['WHY (each chain runs from the event back to its first cause)'];
  let pcEvents = 0;
  for (const e of events) {
    if (e.k !== 'down' && e.k !== 'death' && e.k !== 'stable') continue;
    if (setup.seats[e.who]!.tpl.kind !== 'pc') continue;
    pcEvents++;
    L.push(`  ${seat(e.who)} ${e.k === 'down' ? 'dropped' : e.k === 'death' ? 'died' : 'stabilized'} (#${e.seq}):`, ...chain(e.seq));
  }
  if (pcEvents === 0) L.push('  no PC dropped');
  const end = events[events.length - 1];
  if (end?.k !== 'fightEnd') return L;
  if (end.outcome.k === 'stalemate') {
    L.push(`  the fight ended in a stalemate at the round cap (${setup.knobs.maxRounds})`);
    return L;
  }
  let last: GameEvent | undefined;
  for (const e of events) if (e.k === 'down' || e.k === 'death' || e.k === 'stable') last = e;
  if (last && (last.k === 'down' || last.k === 'death' || last.k === 'stable')) {
    const pc = setup.seats[last.who]!.tpl.kind === 'pc';
    const did = last.k === 'down' ? 'dropped' : last.k === 'death' ? 'died' : 'stabilized';
    L.push(`  ended the fight (${end.outcome.k} in round ${end.outcome.round}): ${seat(last.who)} ${did} (#${last.seq})${pc ? ', above' : ':'}`);
    if (!pc) L.push(...chain(last.seq));
  } else {
    L.push(`  ended the fight (${end.outcome.k} in round ${end.outcome.round})`);
  }
  return L;
}
