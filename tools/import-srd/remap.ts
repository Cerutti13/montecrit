// Foundry UUID pointers (docs/design/m3.md 4.3 last row, C5). A record that passes the
// filter can still point into the premium modules (Compendium.dnd-players-handbook.* and
// friends: 1,376 such fields at the pin). Those are remapped by _id to a record we kept
// (the ids line up, research-foundry §2 item 2), else dropped. Every remap and drop is
// logged to the import cache only (logs/remap.json), never the repo: the log names records.

export interface RemapEntry {
  /** The record holding the pointer (Foundry path). */
  readonly from: string;
  /** Where in it (a dotted path), for reading the log. */
  readonly field: string;
  readonly uuid: string;
  readonly result: 'kept' | 'remapped' | 'dropped';
}

export class RemapLog {
  readonly entries: RemapEntry[] = [];
  add(e: RemapEntry): void {
    this.entries.push(e);
  }
  /** Entries sorted by (from, field, uuid) with <. */
  sorted(): RemapEntry[] {
    const k = (e: RemapEntry) => `${e.from}\u0000${e.field}\u0000${e.uuid}`;
    return [...this.entries].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
  }
  counts(): Record<RemapEntry['result'], number> {
    const out = { kept: 0, remapped: 0, dropped: 0 };
    for (const e of this.entries) out[e.result]++;
    return out;
  }
}

const PREMIUM = /^Compendium\.(dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide)\./;
const OURS = /^Compendium\.dnd5e\.[a-z0-9]+\.Item\.([A-Za-z0-9]{16})$/;

/**
 * Resolves a UUID to the foreign id of a kept record, or undefined (dropped). `isKept` says
 * whether a foreign id survived the filter.
 */
export function resolveUuid(uuid: string, from: string, field: string, isKept: (foreignId: string) => boolean, log: RemapLog): string | undefined {
  const ours = OURS.exec(uuid);
  if (ours) {
    const ok = isKept(ours[1]!);
    log.add({ from, field, uuid, result: ok ? 'kept' : 'dropped' });
    return ok ? ours[1] : undefined;
  }
  if (PREMIUM.test(uuid)) {
    const fid = uuid.slice(uuid.lastIndexOf('.') + 1);
    const ok = /^[A-Za-z0-9]{16}$/.test(fid) && isKept(fid);
    log.add({ from, field, uuid, result: ok ? 'remapped' : 'dropped' });
    return ok ? fid : undefined;
  }
  log.add({ from, field, uuid, result: 'dropped' });
  return undefined;
}
