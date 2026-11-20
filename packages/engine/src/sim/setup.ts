// FightSetup: a resolved scenario, ready to run. scenario/resolve.ts builds it from a
// scenario file plus loaded Content; runFight takes it with a seed. Everything here is
// read-only and shared across every fight run from it.

import type { CompiledTemplate } from '../content/types.ts';
import type { RuleFlags } from '../rules/flags.ts';
import type { LosTable } from '../grid/los.ts';

/** Modeling choices that aren't rules readings. Printed beside the flags in every report. */
export interface Knobs {
  /** Rounds before the fight is called a stalemate. */
  readonly maxRounds: number;
  /** Whether monsters attack a creature that's at 0 HP. */
  readonly attackDowned: 'never' | 'ifNoOtherTarget' | 'always';
  /** Who has to be down for the party to lose: the PCs (PLAN) or every party member. */
  readonly lossCounts: 'pcs' | 'party';
  /** Down (0 HP) is enough for that loss; false plays out death saves until dead or stable. */
  readonly downEnds: boolean;
}

export const DEFAULT_KNOBS: Knobs = { maxRounds: 20, attackDowned: 'ifNoOtherTarget', lossCounts: 'pcs', downEnds: true };

export type DeciderName = 'baseline' | 'journal' | 'random-legal' | 'greedy';

/** A resolved precast (docs/design/m1c.md 7.4). Seat indices are positions in FightSetup.seats. */
export interface PrecastSetup {
  /** tpl.spells index. */
  readonly entry: number;
  /** Cast level (0 for a cantrip). */
  readonly lvl: number;
  /** Spends the entry's free-cast pool instead of a slot. */
  readonly free: boolean;
  /** Area origin as a square name (resolved to an anchor at fight start), or null. */
  readonly at: string | null;
  /** Target seat index, or -1. */
  readonly target: number;
  /** A choice's option (local id) or a skill, or null. */
  readonly choose: string | null;
  readonly elapsed: number;
  /** Seat indices that saw it cast. */
  readonly seen: readonly number[];
}

export interface SeatSetup {
  /** Scenario slot id ('pc1', 'gob3'). Units are ordered by seat with <. */
  readonly seat: string;
  /** fnv1a32(seat): the stream address word for this seat's dice. */
  readonly seatKey: number;
  readonly team: 0 | 1; // 0 party, 1 enemies
  readonly tpl: CompiledTemplate;
  readonly cell: number;
  /** Starting HP override; null uses the template (or rolls it under monsterHp=rolled). */
  readonly hp: number | null;
  /** Starting resources override (the template's resMax layout: slots, then pools); absent: the template's. */
  readonly res?: readonly number[];
  readonly prone: boolean;
  /** Disadvantage on initiative (the only 2024 effect of surprise). */
  readonly surprised: boolean;
  /** Spells already up at the start (sim/precast.ts), in order; absent or empty for none. */
  readonly precast?: readonly PrecastSetup[];
  /** Per-unit override of what 0 HP means; null uses kind (PC: deathSaves) and statBlockAtZeroHp. */
  readonly atZero: 'dies' | 'deathSaves' | null;
  readonly decider: DeciderName;
  /** Decider to hand over to when a journal runs out; null throws NeedInput instead. */
  readonly fallback: Exclude<DeciderName, 'journal'> | null;
}

export interface Calibration {
  readonly engine: string;
  readonly weights: string;
  readonly ai: number;
  readonly scenarioHash: string;
  readonly contentHash: string;
  readonly policy: string;
  readonly seed: number;
  readonly runs: number;
  readonly win: number;
  readonly note?: string;
}

export interface FightSetup {
  readonly scenario: string;
  /** hash64 of the resolved grid, units, effective flags and knobs. Deciders are excluded, so a recorded fight and its journal replay share it. */
  readonly scenarioHash: string;
  /** hash64 of the content the scenario reaches. */
  readonly contentHash: string;
  readonly flags: RuleFlags;
  readonly knobs: Knobs;
  readonly w: number;
  readonly h: number;
  /** TERR bits per cell. Shared, never written. */
  readonly terrain: Uint8Array;
  /**
   * M3 step 8: the terrain's cover levels and the per-pair line cache (grid/los.ts), built with
   * the setup; its pair cache fills lazily and is a pure function of the terrain. A setup made
   * without it gets one on first use (sim/cover.ts losOf). Not hashed (terrain is).
   */
  readonly los?: LosTable;
  /** Sorted by seat with <; a unit's idx is its position here. At most 55. */
  readonly seats: readonly SeatSetup[];
  /** The scenario file's calibration record (reports only; not hashed). */
  readonly calibrated?: Calibration;
  /** The scenario file's report notes (reports only; not hashed). */
  readonly reportNotes?: readonly string[];
}
