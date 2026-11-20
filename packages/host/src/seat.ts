// Seating characters in a scenario (docs/design/m3.md 10): `montecrit run X --pc seat=character`
// and the browser's Run panel seat picker make the same transformation here, so the two give the
// same scenario object, the same scenario hash and the same report hash. Pure: the CLI resolves
// a file argument to its id (and pack) on disk first; the browser picks a loaded id directly.

import { parseYaml, type Content, type DerivedSheet } from '@montecrit/engine';

/** One seat to fill: the character's id, or null when a file named none (then `label` names it). */
export interface SeatPick {
  readonly seat: string;
  readonly id: string | null;
  /** What the user gave, for the "no character" message when id is null or unknown. */
  readonly label: string;
  /** The file it came from, as displayed in the note (CLI only); null for an id. */
  readonly file: string | null;
  /** The pack that file belongs to, if known; otherwise the pack of the id's namespace. */
  readonly pack: string | null;
  /** A refusal found before seating (CLI: the file is not a character), reported after the seat check. */
  readonly refuse?: string;
}

/** A deep copy of parsed YAML (plain maps, arrays and scalars; keys keep their order). No structuredClone: host has no DOM or Node lib. */
function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out;
  }
  return v;
}

export type Seated = { readonly input: unknown; readonly notes: string[] } | { readonly error: string };

/**
 * Puts each picked character into its seat: `unit.use` becomes the character's id, the
 * character's pack joins the scenario's `packs` when its namespace isn't covered yet, and the
 * scenario's calibration record is dropped (it was measured with the scenario's own PC) with a
 * report note that says so: "calibration: not measured for this PC". The notes join
 * `reportNotes`, so they print on the header and the report and enter the scenario hash.
 */
export function seatPcs(input: unknown, path: string, picks: readonly SeatPick[], content: Content, sheets: readonly DerivedSheet[] | undefined): Seated {
  let doc: unknown = input;
  if (typeof input === 'string') {
    const p = parseYaml(input, path);
    if (!p.doc) return { error: `can't read scenario ${path} to seat --pc: ${p.errors.map((e) => e.message).join('; ')}` };
    doc = p.doc.value;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'the scenario is not a map' };
  const sc = copy(doc) as Record<string, unknown>;
  const units = Array.isArray(sc.units) ? (sc.units as Record<string, unknown>[]) : [];
  const packs = Array.isArray(sc.packs) ? [...(sc.packs as string[])] : [];
  const notes: string[] = [];
  for (const p of picks) {
    const unit = units.find((u) => u && typeof u === 'object' && u.seat === p.seat);
    if (!unit) return { error: `--pc: no seat "${p.seat}" in this scenario (seats: ${units.map((u) => String(u.seat)).join(', ')})` };
    if (p.refuse !== undefined) return { error: p.refuse };
    const tpl = p.id === null ? undefined : content.get(p.id);
    if (!tpl) return { error: `--pc ${p.seat}: no character ${p.id ?? p.label} is loaded (characters: ${(sheets ?? []).map((s) => s.id).join(', ') || 'none'})` };
    if (tpl.kind !== 'pc') return { error: `--pc ${p.seat}: ${tpl.id} is a ${tpl.kind}, not a character` };
    const was = String(unit.use);
    unit.use = tpl.id;
    const ns = tpl.id.slice(0, tpl.id.indexOf(':'));
    const covered = packs.some((name) => content.packs.find((x) => x.pack === name)?.namespace === ns);
    if (!covered) {
      const pack = p.pack ?? content.packs.find((x) => x.namespace === ns)?.pack;
      if (pack) packs.push(pack);
    }
    const kind = (sheets ?? []).some((s) => s.id === tpl.id) ? 'character file' : 'kind: pc';
    notes.push(`--pc ${p.seat}: ${tpl.id} (${kind}${p.file !== null ? `, ${p.file}` : ''}) in place of ${was}; calibration: not measured for this PC`);
  }
  sc.packs = packs;
  if (sc.calibrated !== undefined) {
    const cal = sc.calibrated as Record<string, unknown>;
    notes.push(`calibration: not measured for this PC; the scenario's record (win ${typeof cal.win === 'number' ? `${(cal.win * 100).toFixed(1)}%` : '?'}) was measured with the scenario's own seats`);
    delete sc.calibrated;
  } else notes.push('calibration: not measured for this PC (the scenario has no calibration record)');
  sc.reportNotes = [...(Array.isArray(sc.reportNotes) ? (sc.reportNotes as string[]) : []), ...notes];
  return { input: sc, notes };
}

/** A seat that holds a PC (its `use` names a loaded kind: pc or kind: character), in scenario order. */
export interface PcSeat {
  readonly seat: string;
  readonly use: string;
}

/** The scenario's PC seats: the seats a character can take in the Run panel. Empty when it can't be read. */
export function pcSeats(input: unknown, path: string, content: Content): PcSeat[] {
  let doc: unknown = input;
  if (typeof input === 'string') {
    const p = parseYaml(input, path);
    if (!p.doc) return [];
    doc = p.doc.value;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const units = (doc as Record<string, unknown>).units;
  if (!Array.isArray(units)) return [];
  const out: PcSeat[] = [];
  for (const u of units as unknown[]) {
    if (!u || typeof u !== 'object') continue;
    const { seat, use } = u as Record<string, unknown>;
    if (typeof seat !== 'string' || typeof use !== 'string') continue;
    if (content.get(use)?.kind === 'pc') out.push({ seat, use });
  }
  return out;
}
