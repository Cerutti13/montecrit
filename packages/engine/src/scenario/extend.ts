// `extends`: a scenario built from another by name (docs/design/m1c.md 7.3), so a private
// scenario can reuse a public layout and swap in private units without copying it. Pure: the
// CLI finds and parses the base; this merges two parsed documents, and resolveScenario then
// validates and hashes the result like any scenario.
//
// The merge takes the base's fields, then the child's id, name and description; packs written
// "+name" are added after the base's; flags and knobs merge key by key over the base's; each
// `override.units.<seat>` replaces those fields of that seat (nested values are replaced, not
// merged). Only fields the child actually writes are copied: schema defaults never overwrite
// the base.

import { ExtendingScenarioSchema } from '../content/schema.ts';

export interface ExtendResult {
  /** The merged scenario document, or null when the child is invalid. */
  readonly value: unknown;
  readonly errors: readonly string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Whether a parsed scenario document extends another. */
export function extendsName(doc: unknown): string | null {
  return isObject(doc) && typeof doc.extends === 'string' ? doc.extends : null;
}

export function extendScenario(child: unknown, base: unknown): ExtendResult {
  const parsed = ExtendingScenarioSchema.safeParse(child);
  if (!parsed.success) return { value: null, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'scenario'}: ${i.message}`) };
  if (!isObject(child) || !isObject(base)) return { value: null, errors: ['scenario: expected a mapping'] };
  if (extendsName(base) !== null) return { value: null, errors: [`extends: ${String(child.extends)} itself extends another scenario; only one level is allowed`] };
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...base, id: child.id };
  for (const k of ['name', 'description', 'reportNotes'] as const) if (child[k] !== undefined) out[k] = child[k];
  // A calibration belongs to the exact scenario measured; a child states its own or has none.
  delete out.calibrated;
  if (child.calibrated !== undefined) out.calibrated = child.calibrated;
  const packs = Array.isArray(base.packs) ? [...(base.packs as unknown[])] : [];
  for (const p of (child.packs as string[] | undefined) ?? []) if (!packs.includes(p.slice(1))) packs.push(p.slice(1));
  out.packs = packs;
  for (const k of ['flags', 'knobs'] as const) {
    if (child[k] !== undefined) out[k] = { ...(isObject(base[k]) ? base[k] : {}), ...(child[k] as Record<string, unknown>) };
  }
  const units = Array.isArray(base.units) ? (base.units as unknown[]) : [];
  const repl = isObject(child.override) && isObject(child.override.units) ? child.override.units : {};
  const seats = units.map((u) => (isObject(u) ? u.seat : undefined));
  for (const seat of Object.keys(repl).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!seats.includes(seat)) errors.push(`override.units.${seat}: ${String(child.extends)} has no seat "${seat}"`);
  }
  out.units = units.map((u) => {
    if (!isObject(u) || typeof u.seat !== 'string') return u;
    const r = repl[u.seat];
    return isObject(r) ? { ...u, ...r } : u;
  });
  return errors.length > 0 ? { value: null, errors } : { value: out, errors };
}
