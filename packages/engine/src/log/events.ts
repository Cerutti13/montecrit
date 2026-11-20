// Event log. Every state change the fight makes is one event with a seq, the round, whose
// turn it was, and the seq of the event that caused it, so any line can be traced back to the
// decision behind it (`--why`). Events are built only when a sink is listening; seq advances
// either way, so a fight is identical with and without logging.

import type { Id } from '../content/types.ts';
import type { DecisionKind } from '../decide/decider.ts';
import type { ReplayKey } from '../replay.ts';
import type { AdvState } from '../rolls/rollspec.ts';
import type { RuleFlags } from '../rules/flags.ts';
import type { Outcome } from '../sim/state.ts';
import { canonicalJson } from '../util/canon.ts';
import { Hash64 } from '../util/hash.ts';

interface EvBase {
  readonly seq: number;
  readonly round: number;
  /** Unit whose turn it was, or -1. */
  readonly turnOf: number;
  /** seq of the causing event, or -1 for roots. */
  readonly cause: number;
}

export interface DamagePart {
  readonly type: string;
  readonly rolled: number;
}

export type GameEvent = EvBase &
  (
    | { readonly k: 'fightStart'; readonly key: ReplayKey }
    | { readonly k: 'initiative'; readonly who: number; readonly natural: number; readonly total: number; readonly leader: number }
    | { readonly k: 'roundStart' }
    | { readonly k: 'turnStart'; readonly who: number; readonly cell: number; readonly hp: number; readonly moveFt: number }
    | { readonly k: 'turnEnd'; readonly who: number }
    | { readonly k: 'decided'; readonly who: number; readonly at: number; readonly dk: DecisionKind; readonly key: string; readonly by: string }
    | { readonly k: 'act'; readonly who: number; readonly via: Id; readonly name: string }
    | { readonly k: 'provoke'; readonly mover: number; readonly by: number; readonly from: number; readonly to: number }
    | { readonly k: 'step'; readonly who: number; readonly from: number; readonly to: number; readonly ft: number; readonly left: number; readonly forced?: 'pull' | 'push' }
    | { readonly k: 'moveEnd'; readonly who: number; readonly cell: number; readonly why: 'arrived' | 'downed' | 'died' | 'blocked' | 'noSpeed' | 'ended' | 'displaced' | 'learned'; readonly steps: number; readonly planned: number; readonly forced?: 'pull' | 'push' }
    | {
        readonly k: 'attack'; readonly att: number; readonly tgt: number; readonly via: Id; readonly name: string; readonly slot: number;
        readonly d20: readonly [number, number]; readonly natural: number; readonly total: number; readonly ac: number;
        readonly adv: AdvState; readonly advSrc: readonly string[]; readonly disSrc: readonly string[];
        readonly hit: boolean; readonly crit: boolean; readonly opportunity: boolean;
        /** M1b, omitted when 0: dice added before the roll (a d4), dice reactors rolled into it. */
        readonly pre?: number; readonly ext?: number;
        /** M3 step 8, omitted when none: the target's cover (grid/los.ts COVER: 1 Half, 2 Three-Quarters), already in `ac`. */
        readonly cover?: number;
        /** M3 step 8'a, omitted when none: AC the target added in the hit-known window (a reaction after the hit was known), already in `ac` and `hit`. */
        readonly acUp?: number;
      }
    | {
        readonly k: 'damage'; readonly src: number; readonly tgt: number; readonly via: Id; readonly slot: number; readonly crit: boolean;
        readonly parts: readonly DamagePart[]; readonly dealt: number; readonly tempAbsorbed: number; readonly hpBefore: number; readonly hpAfter: number;
        /** M1b, omitted when absent: the source's name, the roll's purpose (not 'damage'), half on a save. */
        readonly name?: string; readonly purpose?: string; readonly half?: boolean;
      }
    | { readonly k: 'cond'; readonly who: number; readonly cond: Id; readonly on: boolean; readonly via: Id }
    /** ammo (M3 step 5b): a piece of ammunition fired, not a weapon thrown. */
    | { readonly k: 'gear'; readonly who: number; readonly item: string; readonly left: number; readonly ammo?: true }
    | { readonly k: 'down'; readonly who: number }
    | { readonly k: 'revive'; readonly who: number; readonly hp?: number }
    | { readonly k: 'stable'; readonly who: number }
    | { readonly k: 'deathSave'; readonly who: number; readonly slot: number; readonly natural: number; readonly ok: number; readonly fail: number; readonly total?: number; /** What effects added (a save bonus: Aura of Protection); undefined when 0. */ readonly mod?: number }
    | { readonly k: 'deathFail'; readonly who: number; readonly n: number; readonly fail: number }
    | { readonly k: 'death'; readonly who: number; readonly why: 'zeroHp' | 'massive' | 'deathSaves' }
    | { readonly k: 'fightEnd'; readonly outcome: Outcome; readonly flagsUsed: readonly (keyof RuleFlags)[] }
    // M1b effects. `bearer` -1 means the effect sits on no creature (a zone, a spell instance).
    | {
        readonly k: 'fxStart'; readonly fx: number; readonly via: Id; readonly name: string; readonly owner: number; readonly bearer: number;
        readonly parent: number; readonly conc: boolean;
      }
    | { readonly k: 'fxEnd'; readonly fx: number; readonly via: Id; readonly name: string; readonly owner: number; readonly bearer: number; readonly why: FxEndWhy }
    | { readonly k: 'cast'; readonly who: number; readonly via: Id; readonly name: string; readonly lvl: number; readonly free: string | null; readonly left: number }
    /** A spell already up when the fight starts (round 0, before initiative; sim/precast.ts). */
    | { readonly k: 'precast'; readonly who: number; readonly via: Id; readonly name: string; readonly lvl: number; readonly free: string | null; readonly left: number; readonly elapsed: number }
    | {
        readonly k: 'heal'; readonly src: number; readonly tgt: number; readonly via: Id; readonly name: string; readonly slot: number;
        readonly rolled: number; readonly hpBefore: number; readonly hpAfter: number;
      }
    /** M3 step 4: Temporary Hit Points granted; `before` and `after` are the temp HP (the higher is kept, p.18). */
    | { readonly k: 'tempHp'; readonly src: number; readonly tgt: number; readonly via: Id; readonly name: string; readonly slot: number; readonly rolled: number; readonly before: number; readonly after: number }
    | { readonly k: 'item'; readonly who: number; readonly item: string; readonly act: 'stow' | 'draw' | 'drop' | 'pickup' | 'don' | 'doff' | 'throw'; readonly left?: number } // left: step E, only on a monster's pickup of a thrown piece (the count it now carries)
    /** Coverage step 7.6: the 1d6 at the start of a monster's turn while a Recharge use is spent (srd-raw.txt:44017-44025). */
    | { readonly k: 'recharge'; readonly who: number; readonly via: Id; readonly name: string; readonly roll: number; readonly min: number; readonly back: boolean }
    | { readonly k: 'res'; readonly who: number; readonly pool: string; readonly left: number; /** M3 step 5a (a pool step): the change when it isn't spending one use; absent otherwise. */ readonly delta?: number }
    | { readonly k: 'react'; readonly who: number; readonly roller: number; readonly via: Id; readonly name: string; readonly slot: number; readonly v: number; readonly left: number }
    /** M3 step 5a (REACT hitTaken): `who` takes its Reaction to reduce `att`'s hit by `v` (halve: by half instead; slot -1, no die). */
    | { readonly k: 'reduce'; readonly who: number; readonly att: number; readonly via: Id; readonly name: string; readonly slot: number; readonly v: number; readonly halve?: true }
    | {
        readonly k: 'zone'; readonly fx: number; readonly via: Id; readonly name: string; readonly owner: number; readonly anchor: string;
        readonly cells: number; readonly difficult: boolean; readonly seen: readonly number[];
        /** View-only (VIEW_ONLY_KEYS): the zone's cells, in stamp order. */
        readonly area?: readonly number[];
      }
    /** Coverage step 9+: `who` (from `from`) and `with` (from `to`) swap places by `who`'s Reaction (Redirect Attack): no movement spent, no path. */
    | { readonly k: 'swap'; readonly who: number; readonly with: number; readonly from: number; readonly to: number; readonly via: Id; readonly name: string }
    /** Coverage step 9: `who` recognizes the hidden zone `fx` (a Search that met its DC, or its damage under hiddenHazardRevealedByDamage). */
    | { readonly k: 'reveal'; readonly who: number; readonly fx: number; readonly via: Id; readonly name: string; readonly how: 'search' | 'damage' }
    | {
        readonly k: 'zoneMove'; readonly fx: number; readonly via: Id; readonly name: string; readonly from: string; readonly to: string; readonly caught: readonly number[];
        /** View-only (VIEW_ONLY_KEYS): the zone's cells after the move. */
        readonly area?: readonly number[];
      }
    | {
        /** M3 step 4: purpose condSave is a condition's repeat save, check an ability check (key check.<ability>[.<skill>]). */
        readonly k: 'save'; readonly who: number; readonly via: Id; readonly name: string; readonly key: string; readonly purpose: 'save' | 'conc' | 'condSave' | 'check' | 'rider' | 'reaction';
        readonly slot: number; readonly d20: readonly [number, number]; readonly natural: number; readonly face: number; readonly pre: number; readonly ext: number;
        readonly total: number; readonly dc: number; readonly adv: AdvState; readonly advSrc: readonly string[]; readonly disSrc: readonly string[]; readonly ok: boolean;
        /** M3 step 8, omitted when none: a Dexterity save's cover from the effect's source (1 Half, 2 Three-Quarters), already in `total`. */
        readonly cover?: number;
      }
  );

export const FX_END_WHYS = ['expired', 'concentration', 'newConcentration', 'dismissed', 'replaced', 'incapacitated', 'death', 'parent', 'consumed', 'sourceLost', 'anchorDied'] as const;
/** How a concentration instance can end: counted per fight (sim/counters.ts), so this list is append-only and sized into every report's accumulators. */
export type ConcEndWhy = (typeof FX_END_WHYS)[number];
/**
 * Ends only a condition's own effect has (M3 step 4): a repeat save succeeded, an escape check
 * succeeded, its bearer took damage. Never a concentration instance, so they aren't counted and
 * FX_END_WHYS (and every report's accumulator layout) stays as it was.
 */
export const COND_END_WHYS = ['saved', 'escaped', 'damaged'] as const;
export type FxEndWhy = ConcEndWhy | (typeof COND_END_WHYS)[number];

/**
 * Event fields for viewers only (docs/design/m2.md 4.2): built only when a sink listens, from
 * values the fight already computed; never read by the engine, never printed by describe, never
 * hashed (HashSink drops them), and always reconstructible from the rules. So adding one changes
 * no log hash, no golden and no engine version.
 */
export const VIEW_ONLY_KEYS = ['area'] as const;

/** The event without its view-only fields. */
function hashable(e: GameEvent): GameEvent {
  if (!VIEW_ONLY_KEYS.some((k) => k in e)) return e;
  const copy: Record<string, unknown> = { ...e };
  for (const k of VIEW_ONLY_KEYS) delete copy[k];
  return copy as unknown as GameEvent;
}

export interface EventSink {
  emit(e: GameEvent): void;
}

/** Collects events in order. */
export class ArraySink implements EventSink {
  readonly events: GameEvent[] = [];
  emit(e: GameEvent): void {
    this.events.push(e);
  }
}

/**
 * Hashes the rules-relevant event stream. Leaves out who made each decision, and the journal
 * and policy in the replay key, so a recorded fight and its journal replay hash the same, and
 * every view-only field (VIEW_ONLY_KEYS).
 * Compare log hashes only between fights with the same full replay key, policy included.
 */
export class HashSink implements EventSink {
  private readonly h = new Hash64();
  emit(e: GameEvent): void {
    if (e.k === 'decided') {
      const { by: _by, ...rest } = e;
      this.h.update(canonicalJson(rest)).update('\n');
    } else if (e.k === 'fightStart') {
      const { journal: _journal, policy: _policy, ...key } = e.key;
      this.h.update(canonicalJson({ ...e, key })).update('\n');
    } else this.h.update(canonicalJson(hashable(e))).update('\n');
  }
  hex(): string {
    return this.h.hex();
  }
}

/** Sends every event to several sinks. */
export class TeeSink implements EventSink {
  private readonly sinks: readonly EventSink[];
  constructor(...sinks: EventSink[]) {
    this.sinks = sinks;
  }
  emit(e: GameEvent): void {
    for (const s of this.sinks) s.emit(e);
  }
}
