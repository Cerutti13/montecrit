// Coverage step 9+: two creatures swap places (Redirect Attack: "The goblin chooses a Small or
// Medium ally within 5 feet of itself. The goblin and that ally swap places", srd-raw.txt:48831-48834).
//
// What a swap is, and what it isn't:
// - Neither creature moves by its Speed: no movement is spent, no path is walked, no square is
//   passed through, so nothing that counts feet traveled fires (Spike Growth's "for every 5 feet it
//   travels", a perDistanceDamageRolls zone) [U: the text gives no distance and no route].
// - Opportunity Attacks: the ally is moved "without using your movement, action, Bonus Action, or
//   Reaction" and so never provokes (srd-raw.txt:2091-2093); the creature that swaps by its own
//   Reaction provokes nothing either, under the swapProvokesOpportunityAttacks flag (default false,
//   verified false: the text says nothing of it, docs/design/coverage.md critique M4).
// - Zones: each creature enters the square it lands on, so a zone's enter hooks fire for it as for
//   any creature that enters the area. The ally's entry is involuntary (the forced bit), so
//   involuntaryMovementTriggersArea decides it exactly as for a pull or push; the swapping creature
//   chose it and enters as a voluntary mover does [U: no rule names a swap]. Auras a creature carries
//   move with it (moveAuras), as on a step.

import type { Id } from '../content/types.ts';
import { canReactAgainst, distFt, oaReach } from '../grid/reach.ts';
import { emit, evBase, nextSeq, type Ctx } from './context.ts';
import { drain, queueTrigger, TRIG } from './triggers.ts';
import { moveAuras } from './zones.ts';
import { useFlag, type Unit } from './state.ts';

/** `g` swaps places with `o` (by `via`, `g`'s Reaction); returns the swap event's seq. */
export function swapPlaces(cx: Ctx, g: Unit, o: Unit, via: Id, name: string, cause: number): number {
  const st = cx.st;
  const from = g.cell;
  const to = o.cell;
  // The flag decides something only when the swap takes `g` out of a foe's reach.
  for (const r of st.units) {
    if (!canReactAgainst(st, r, g)) continue;
    const reach = oaReach(st, r);
    if (distFt(st, r.cell, from) <= reach && distFt(st, r.cell, to) > reach) {
      useFlag(st, 'swapProvokesOpportunityAttacks'); // default false; true is refused at scenario resolution (unimplemented)
      break;
    }
  }
  g.cell = to;
  o.cell = from;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'swap', who: g.idx, with: o.idx, from, to, via, name });
  if (st.ownerAuras !== 0) {
    moveAuras(cx, g, seq);
    moveAuras(cx, o, seq);
  }
  queueTrigger(cx, TRIG.enter, g.idx, to, from, 0, seq);
  queueTrigger(cx, TRIG.enter, o.idx, from, to, 1, seq);
  drain(cx);
  return seq;
}
