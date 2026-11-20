// Fidelity (docs/design/m3.md 2.7, C7). Mechanical and per item; the importer decides, an
// override can raise it only with provenance.review: reviewed and a pdfPage (overrides.ts).
//
//   narrative  nothing maps to a step (or the feature is out of combat): loads, shows on
//              the sheet, deciders are never offered it
//   partial    something maps and at least one unimplemented line was written
//   full       zero lines, no Open5e disagreement, PDF header agreement where there is a
//              header, and either a data item (class, species, weapon...), a bucket-A shape
//              (instant attack, save, damage or heal) or a reviewed override
//
// The invariant "partial <=> at least one line" is kept by adding a review line when an
// item would otherwise be held back with none: nothing with a duration, and no reaction or
// special activation, is promoted to full by the importer alone (C7).

import { normalizeLines, U } from './unimplemented.ts';

export type Fidelity = 'full' | 'partial' | 'narrative';

export interface ClassifyInput {
  /** At least one program or data field maps (a narrative item has none). */
  readonly maps: boolean;
  /** Plain data (class, subclass, species, background, feat, weapon, armor) or a program shape. */
  readonly shape: 'data' | 'bucketA' | 'other';
  /** The lines the mappers wrote. */
  readonly unimplemented: readonly string[];
  readonly hasDuration: boolean;
  /** The activation, when the item has one (reaction and special never auto-promote). */
  readonly activation?: string | undefined;
  readonly open5e?: 'agree' | 'disagree' | 'missing' | undefined;
  /** For spells and features with a PDF header: does it agree on level, time, range, components, duration, concentration (C7)? */
  readonly pdfHeaderAgrees?: boolean | undefined;
  /**
   * C7: the bucket-A shape came from the importer's own reading of the record (the spell
   * mapper), not from a review against the text, so it never promotes to full by itself.
   */
  readonly heuristicShape?: boolean | undefined;
}

export interface Classified {
  readonly fidelity: Fidelity;
  readonly unimplemented: readonly string[];
}

export function classify(x: ClassifyInput): Classified {
  const lines = [...x.unimplemented];
  if (!x.maps) return { fidelity: 'narrative', unimplemented: normalizeLines(lines) };
  if (x.open5e === 'disagree') lines.push(U.open5eDisagrees());
  if (x.shape !== 'data') {
    if (x.hasDuration) lines.push(U.durationReview());
    if (x.activation === 'reaction' || x.activation === 'special') lines.push(U.activationReview(x.activation));
    if (x.shape !== 'bucketA') lines.push(U.shapeReview());
    else if (x.heuristicShape) lines.push(U.bucketHeuristic());
    if (x.pdfHeaderAgrees === false) lines.push(U.pdfHeaderDisagrees());
  }
  const out = normalizeLines(lines);
  return { fidelity: out.length ? 'partial' : 'full', unimplemented: out };
}

const RANK: Readonly<Record<Fidelity, number>> = { narrative: 0, partial: 1, full: 2 };

/** True when `to` is a higher fidelity than `from` (an override doing this needs review: reviewed and a pdfPage). */
export const raises = (from: Fidelity, to: Fidelity): boolean => RANK[to] > RANK[from];
