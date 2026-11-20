// Results' fidelity line per seat (docs/design/m3.md 10): for each PC seat, what it uses that the
// engine doesn't model in full. The same test as the report header's notes (mc/report.ts: a
// template or spell whose fidelity isn't `full` or that lists anything unimplemented), read from
// the FightSetup this page already holds, grouped by seat instead of by content id. Pure.

import type { FightSetup } from '@montecrit/engine';

export interface FidelityItem {
  readonly id: string;
  readonly name: string;
  readonly fidelity: 'full' | 'partial' | 'narrative';
  readonly unimplemented: readonly string[];
}

export interface SeatFidelity {
  readonly seat: string;
  readonly name: string;
  /** The seat's own template first (when not full), then its spells in kit order. Empty: everything modeled. */
  readonly items: readonly FidelityItem[];
}

const short = (x: { fidelity: 'full' | 'partial' | 'narrative'; unimplemented: readonly string[] }) => x.fidelity !== 'full' || x.unimplemented.length > 0;

/** One entry per PC seat, in seat order. */
export function seatFidelity(setup: FightSetup): SeatFidelity[] {
  const out: SeatFidelity[] = [];
  for (const s of setup.seats) {
    if (s.tpl.kind !== 'pc') continue;
    const items: FidelityItem[] = [];
    if (short(s.tpl)) items.push({ id: s.tpl.id, name: s.tpl.name, fidelity: s.tpl.fidelity, unimplemented: s.tpl.unimplemented });
    for (const e of s.tpl.spells) {
      const sp = e.spell;
      if (items.some((i) => i.id === sp.id) || !short(sp)) continue;
      items.push({ id: sp.id, name: sp.name, fidelity: sp.fidelity, unimplemented: sp.unimplemented });
    }
    out.push({ seat: s.seat, name: s.tpl.name, items });
  }
  return out;
}

/** The short line Results shows for a seat: each item's name and fidelity, or that nothing is short. */
export function fidelitySummary(f: SeatFidelity): string {
  if (f.items.length === 0) return 'everything modeled in full';
  return f.items.map((i) => `${i.name} ${i.fidelity}${i.unimplemented.length ? ` (${i.unimplemented.length} unimplemented)` : ''}`).join(', ');
}

/** The full line for a seat (copy and title text): "everything modeled in full", or each item with its fidelity. */
export function fidelityLine(f: SeatFidelity): string {
  if (f.items.length === 0) return 'everything modeled in full';
  return f.items.map((i) => `${i.name} (${i.id}) ${i.fidelity}${i.unimplemented.length ? `: unimplemented ${i.unimplemented.join('; ')}` : ''}`).join(' | ');
}
