// BaselineDecider: deterministic scaffolding until the M1c greedy AI. Draws no dice. Reports
// stamp it `policy: baseline`; it's a placeholder, not a tuned tactic.
//   reaction        always takes the opportunity attack
//   orderTriggers   initiative order (the first offered)
//   anything else   the first item: never casts, uses or reacts (M1b: spells run on journals);
//                   W1's firstAttack and moveTo list pass first, so it declines both
//   turn            stand if Prone; attack the weakest legal target (honoring attackDowned),
//                   preferring attacks that don't throw away a weapon; else step toward the
//                   nearest standing enemy if that gets closer (fewest provokes, least ft);
//                   else throw; else pass.

import type { Decider, DecisionPoint, UnitView } from './decider.ts';

export class BaselineDecider implements Decider {
  readonly name = 'baseline';

  decide(view: UnitView, dp: DecisionPoint): number {
    const items = dp.legal.items;
    const n = dp.legal.n;
    if (dp.k === 'reaction') {
      for (let i = 0; i < n; i++) if (items[i]!.k === 'oa') return i;
      return 0;
    }
    if (dp.k === 'orderTriggers') return 0;
    if (dp.k !== 'turn') return 0; // targets, anchors, picks, pull steps, pre-roll reactions: the first offered (pass, where there is one)

    const q = view.q;
    const me = q.units[view.me]!;
    for (let i = 0; i < n; i++) if (items[i]!.k === 'stand') return i;

    const attackDowned = q.setup.knobs.attackDowned;
    const anyUpTarget = (() => {
      for (let i = 0; i < n; i++) if (items[i]!.k === 'attack' && q.units[items[i]!.target]!.life === 'up') return true;
      return false;
    })();
    const pickAttack = (allowThrow: boolean): number => {
      let best = -1;
      let bestKey = [Infinity, Infinity, Infinity];
      for (let i = 0; i < n; i++) {
        const l = items[i]!;
        if (l.k !== 'attack') continue;
        const atk = me.tpl.attacks[l.atk]!;
        if (atk.consumesGear && !allowThrow) continue;
        const t = q.units[l.target]!;
        const down = t.life !== 'up';
        if (down && (attackDowned === 'never' || (attackDowned === 'ifNoOtherTarget' && anyUpTarget))) continue;
        const key = [down && attackDowned !== 'always' ? 1 : 0, t.hp, t.idx];
        if (key[0]! < bestKey[0]! || (key[0] === bestKey[0] && (key[1]! < bestKey[1]! || (key[1] === bestKey[1] && key[2]! < bestKey[2]!)))) {
          best = i;
          bestKey = key;
        }
      }
      return best;
    };

    const atk = pickAttack(false);
    if (atk >= 0) return atk;

    // Step toward the nearest standing enemy, if that gets closer.
    const nearest = (cell: number): number => {
      let d = Infinity;
      for (const t of q.units) {
        if (t.team === me.team || t.life !== 'up') continue;
        d = Math.min(d, view.queries.distFt(cell, t.cell));
      }
      return d;
    };
    const here = nearest(me.cell);
    let move = -1;
    let mk = [here, Infinity, Infinity, Infinity];
    for (let i = 0; i < n; i++) {
      const l = items[i]!;
      if (l.k !== 'move') continue;
      const key = [nearest(l.cell), l.provokes, l.ft, l.cell];
      let better = false;
      for (let j = 0; j < 4; j++) {
        if (key[j]! < mk[j]!) {
          better = true;
          break;
        }
        if (key[j]! > mk[j]!) break;
      }
      if (better && key[0]! < here) {
        move = i;
        mk = key;
      }
    }
    if (move >= 0) return move;

    const thrown = pickAttack(true);
    if (thrown >= 0) return thrown;
    return 0;
  }
}
