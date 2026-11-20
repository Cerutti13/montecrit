// The Run panel's seat picks (apps/web/src/run/RunPanel.tsx chosenSeats): only picks whose
// character is still loaded are sent, so a pick left over from before a home reload neither
// reaches the run nor keeps the calibration note up.
import { describe, expect, it } from 'vitest';
import type { SeatChoice } from '../src/run/session.ts';

// Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX; tsc -p apps/web checks the panel.
const PANEL = '../src/run/RunPanel.tsx';
const { chosenSeats } = (await import(PANEL)) as {
  chosenSeats: (seats: readonly { seat: string }[], picks: Readonly<Record<string, string>>, characters: readonly { id: string }[]) => SeatChoice[];
};

const seats = [{ seat: 'A' }, { seat: 'B' }, { seat: 'C' }];

describe('chosenSeats', () => {
  it('keeps loaded picks in seat order', () => {
    expect(chosenSeats(seats, { C: 'mira', A: 'tobin' }, [{ id: 'tobin' }, { id: 'mira' }])).toEqual([
      { seat: 'A', id: 'tobin' },
      { seat: 'C', id: 'mira' },
    ]);
  });
  it('drops a pick whose character is no longer loaded', () => {
    expect(chosenSeats(seats, { A: 'gone', B: 'tobin' }, [{ id: 'tobin' }])).toEqual([{ seat: 'B', id: 'tobin' }]);
    expect(chosenSeats(seats, { A: 'gone' }, [])).toEqual([]);
  });
  it('ignores picks for seats the scenario does not have', () => {
    expect(chosenSeats(seats, { Z: 'tobin' }, [{ id: 'tobin' }])).toEqual([]);
  });
});
