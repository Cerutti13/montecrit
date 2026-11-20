import { makeDeciders } from '../../src/decide/make.ts';
import type { Decider } from '../../src/decide/decider.ts';
import { ArraySink, HashSink, TeeSink, type GameEvent } from '../../src/log/events.ts';
import { renderLog } from '../../src/log/render.ts';
import type { JournalEntry } from '../../src/replay.ts';
import { openStream, rollDie, type Purpose } from '../../src/rng/stream.ts';
import { runFight, type FightResult } from '../../src/sim/fight.ts';
import type { FightSetup } from '../../src/sim/setup.ts';
import type { GameState } from '../../src/sim/state.ts';

export interface Ran {
  result: FightResult;
  events: GameEvent[];
  log: string[];
  hash: string;
  st: GameState;
}

export function run(setup: FightSetup, seed = 1, journal: JournalEntry[] = [], deciders?: Decider[]): Ran {
  const arr = new ArraySink();
  const hs = new HashSink();
  let st: GameState | undefined;
  const result = runFight(setup, seed, 0, deciders ?? makeDeciders(setup, journal), new TeeSink(arr, hs), { audit: true, journal, inspect: (s) => (st = s) });
  return { result, events: arr.events, log: renderLog(arr.events, setup), hash: hs.hex(), st: st! };
}

/** First seed in [0, max) for which `pred` holds; throws if none. */
export function findSeed(pred: (seed: number) => boolean, max = 4000): number {
  for (let s = 0; s < max; s++) if (pred(s)) return s;
  throw new Error('no seed found');
}

/** The first d20 a roll at this address would show (no advantage). */
export function d20At(seed: number, seatKey: number, purpose: Purpose, round: number, slot: number): number {
  return rollDie(openStream(seed, 0, seatKey, purpose, round, slot), 20);
}

export const kinds = (events: GameEvent[]) => events.map((e) => e.k);
export const ofKind = <K extends GameEvent['k']>(events: GameEvent[], k: K) => events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
