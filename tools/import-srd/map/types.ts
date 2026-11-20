// The mapper contract (docs/design/m3.md 4.3). One pure mapper per kind turns a filtered,
// stripped Foundry record into one or more of our items. Mappers never see description
// text (strip.ts removed it); what they learned from it at import time arrives as the closed
// list of trigger words. They write problems as templated lines (unimplemented.ts), never
// free text, and leave fidelity, unimplemented and provenance to main.ts (classify.ts and
// overrides.ts own those).

import type { ClassifyInput } from '../classify.ts';
import type { Kept, ImportKind } from '../filter.ts';
import type { FormulaCtx, FormulaResult } from '../formula.ts';
import type { SrdIndex } from '../pdf/build.ts';
import type { ItemKind } from '../overrides.ts';
import type { RemapLog } from '../remap.ts';
import type { FoundryRecord } from '../read.ts';

export interface MapCtx {
  /** The record being mapped (filter result: kind, owners that passed the gate). */
  readonly kept: Kept;
  /** The stripped record (no art, no prose, no bookkeeping). Mappers read only this. */
  readonly doc: Readonly<Record<string, unknown>>;
  /** Trigger words found in the record's description before stripping (TRIGGER_WORDS keys, sorted). */
  readonly triggers: readonly string[];
  /** The pinned Foundry commit (for provenance, already filled by main). */
  readonly commit: string;
  /** Another kept record by its Foundry id (cross references: ItemGrant, background feat...). */
  readonly lookup: (foreignId: string) => Kept | undefined;
  /** Our id for a kept record (ids.ts policy). */
  readonly idOf: (foreignId: string) => string | undefined;
  /** Foundry formula -> our expression (formula.ts), or templated lines. */
  readonly formula: (src: string | number, ctx?: FormulaCtx) => FormulaResult;
  /** Resolves a UUID field (remap.ts), logging to the cache-only remap log. */
  readonly uuid: (uuid: string, field: string) => string | undefined;
  readonly remap: RemapLog;
  /** Records that were read but dropped (quarantine), by Foundry id, for "grants a quarantined item" lines. */
  readonly dropped: (foreignId: string) => FoundryRecord | undefined;
  /** Every kept record, in path order (a class's weapon proficiencies find their weapon records by base item). */
  readonly allKept: readonly Kept[];
  /** The parsed srd-index.json behind the gate (pages, class tables, spell headers); undefined in tests that don't need it. */
  readonly pdf: SrdIndex | undefined;
  /**
   * M3 step 6: a mapper that returns null for a kept record says why (a closed reason and a
   * machine detail, never record text). main.ts counts them in the summary and writes them,
   * with the record path, to the cache log only (C5). Optional so older test contexts still work.
   */
  readonly skip?: (reason: string, detail: string) => void;
}

export interface MapOutput {
  readonly kind: ItemKind;
  /**
   * The item: kind, id, name, source and the kind's own fields, as the engine schema wants
   * them. No fidelity, unimplemented or provenance: main.ts adds those.
   */
  readonly item: Readonly<Record<string, unknown>>;
  /** Templated lines (unimplemented.ts U.*). */
  readonly unimplemented: readonly string[];
  /** The rest of the fidelity input (classify.ts). */
  readonly classify: Omit<ClassifyInput, 'unimplemented'>;
  /** The SRD 5.2.1 page, when the PDF index gave one. */
  readonly pdfPage?: number | undefined;
  /**
   * Trigger words (TRIGGER_WORDS keys) the mapper modeled from the PDF text itself (M3 step 6: a
   * turn-end repeat save read from the spell's own "At the end of each of its turns" sentence),
   * so main.ts doesn't add their trigger lines.
   */
  readonly handledTriggers?: readonly string[] | undefined;
}

/**
 * A mapper: null when the record yields no item (counted as unmapped in the summary), one
 * output, or several (a record that becomes more than one of our items).
 */
export type Mapper = (ctx: MapCtx) => MapOutput | readonly MapOutput[] | null;

/** Which import kinds each mapper handles (speciesTrait records become features). */
export type MapperRegistry = Readonly<Record<ImportKind, Mapper>>;
