// The replay controller (apps/web/src/replay/controller.ts): stepping by event, turn and round
// with clamps at both ends, play skipping `decided` frames and stopping at the end, restart.
import { describe, expect, it } from 'vitest';
import { delayFor, initial, reduce, type Tables } from '../src/replay/controller.ts';

const T: Tables = { last: 20, turnStarts: [2, 6, 11, 15], roundStarts: [1, 11], skip: Array.from({ length: 21 }, (_, i) => i === 4 || i === 5 || i === 19) };
const at = (i: number) => ({ ...initial, i });

describe('replay controller', () => {
  it('steps events with clamps', () => {
    expect(reduce(T, at(0), { t: 'stepEvent', d: -1 }).i).toBe(0);
    expect(reduce(T, at(20), { t: 'stepEvent', d: 1 }).i).toBe(20);
    expect(reduce(T, at(7), { t: 'stepEvent', d: 1 }).i).toBe(8);
  });
  it('steps turns and rounds to the next or previous mark, never staying put', () => {
    expect(reduce(T, at(6), { t: 'stepTurn', d: 1 }).i).toBe(11);
    expect(reduce(T, at(6), { t: 'stepTurn', d: -1 }).i).toBe(2);
    expect(reduce(T, at(7), { t: 'stepTurn', d: -1 }).i).toBe(6);
    expect(reduce(T, at(16), { t: 'stepTurn', d: 1 }).i).toBe(20);
    expect(reduce(T, at(1), { t: 'stepTurn', d: -1 }).i).toBe(0);
    expect(reduce(T, at(3), { t: 'stepRound', d: 1 }).i).toBe(11);
    expect(reduce(T, at(11), { t: 'stepRound', d: -1 }).i).toBe(1);
  });
  it('plays frame by frame, skipping decided frames, and stops at the end; play from the end restarts', () => {
    let s = reduce(T, at(3), { t: 'toggle' });
    expect(s.playing).toBe(true);
    s = reduce(T, s, { t: 'tick' });
    expect(s.i).toBe(6);
    s = reduce(T, at(18), { t: 'toggle' });
    s = reduce(T, s, { t: 'tick' });
    expect([s.i, s.playing]).toEqual([20, false]);
    expect(reduce(T, s, { t: 'toggle' })).toMatchObject({ i: 0, playing: true });
    expect(reduce(T, { ...at(5), playing: true }, { t: 'stepEvent', d: 1 }).playing).toBe(false);
  });
  it('seeks with clamps, selects, and times steps faster than other events', () => {
    expect(reduce(T, at(0), { t: 'seek', i: 99 }).i).toBe(20);
    expect(reduce(T, at(0), { t: 'select', seq: 42 }).selected).toBe(42);
    expect(delayFor('step', 1)).toBeLessThan(delayFor('attack', 1));
    expect(delayFor('attack', 16)).toBe(delayFor('attack', 1) / 16);
  });
});
