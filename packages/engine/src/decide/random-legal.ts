// RandomLegalDecider: picks a legal option with this seat's 'ai' dice, for property tests
// and smoke fights. Two stages so the few attack options aren't drowned by hundreds of move
// labels: first a kind (pass weighted lower), then an item of that kind.

import type { Decider, DecisionPoint, LegalKind, UnitView } from './decider.ts';

// Append only: a kind's position decides which d-roll picks it, so M1a fights keep their choices.
const KINDS: readonly LegalKind[] = ['pass', 'attack', 'move', 'option', 'stand', 'oa', 'order', 'cast', 'use', 'end', 'item', 'target', 'place', 'pick', 'pull', 'react'];
const WEIGHT: Readonly<Record<LegalKind, number>> = {
  pass: 1, attack: 4, move: 3, option: 1, stand: 2, oa: 4, order: 1,
  cast: 4, use: 3, end: 1, item: 1, target: 1, place: 1, pick: 1, pull: 1, react: 2,
  dodge: 1, // not in KINDS (append-only): it's never picked yet, so no random fight moves (M3 step 5a)
  search: 1, // the same for the Search action (coverage step 9)
};

export class RandomLegalDecider implements Decider {
  readonly name = 'random-legal';

  decide(view: UnitView, dp: DecisionPoint): number {
    // W1 (P7, P9): the optional first-attack and free-move choices pass, with no AI dice drawn, so
    // random fights with those features keep every later roll where it was.
    if (dp.k === 'firstAttack' || dp.k === 'moveTo') return 0;
    const items = dp.legal.items;
    const n = dp.legal.n;
    const counts = KINDS.map((k) => {
      let c = 0;
      for (let i = 0; i < n; i++) if (items[i]!.k === k) c++;
      return c;
    });
    let total = 0;
    KINDS.forEach((k, j) => (total += counts[j]! > 0 ? WEIGHT[k] : 0));
    let r = view.ai.roll(total) - 1;
    let kind: LegalKind = 'pass';
    for (let j = 0; j < KINDS.length; j++) {
      if (counts[j] === 0) continue;
      const w = WEIGHT[KINDS[j]!];
      if (r < w) {
        kind = KINDS[j]!;
        break;
      }
      r -= w;
    }
    const pick = view.ai.roll(counts[KINDS.indexOf(kind)]!) - 1;
    let seen = 0;
    for (let i = 0; i < n; i++) {
      if (items[i]!.k !== kind) continue;
      if (seen === pick) return i;
      seen++;
    }
    return 0;
  }
}
