// Group checks (M4): every member rolls on their own, and the group passes when at least half
// of them do. The members' chances differ, so the count of passes is Poisson-binomial; a small
// DP over the members gives it exactly.

export interface GroupOdds {
  /** Chance that at least `need` members pass. */
  readonly pPass: number;
  /** Passes the group needs: half the members, rounded up. */
  readonly need: number;
  /** count[k] is the chance that exactly k members pass. */
  readonly count: readonly number[];
}

export function groupCheckOdds(ps: readonly number[]): GroupOdds {
  if (ps.length === 0) throw new RangeError('a group check needs at least one member');
  for (const p of ps) {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`a member's chance must be between 0 and 1, got ${p}`);
  }
  let count: number[] = [1];
  for (const p of ps) {
    const next = new Array<number>(count.length + 1).fill(0);
    for (let k = 0; k < count.length; k++) {
      next[k]! += count[k]! * (1 - p);
      next[k + 1]! += count[k]! * p;
    }
    count = next;
  }
  const need = Math.ceil(ps.length / 2);
  let pPass = 0;
  for (let k = need; k < count.length; k++) pPass += count[k]!;
  return { pPass: Math.min(1, pPass), need, count };
}
