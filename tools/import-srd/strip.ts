// Removes art, prose and Foundry bookkeeping from a record before any mapper sees it
// (docs/design/m3.md 4.2, 4.7 points 3 and 5; research-foundry §6). Keys are deleted at
// every depth, so effects and embedded actor items lose theirs too:
//   img, tint, prototypeToken          art and token pointers (never shipped)
//   description, chatFlavor, chat      all description HTML and chat prose
//   _stats, flags, folder, ownership, _key, sort   Foundry bookkeeping
// The result is a fresh plain copy; the input is untouched. Mappers read only this copy, so
// no rules text can reach the emitted files through them.

import { isRecord } from './util.ts';

export const STRIP_KEYS: readonly string[] = ['_key', '_stats', 'chat', 'chatFlavor', 'description', 'flags', 'folder', 'img', 'ownership', 'prototypeToken', 'sort', 'tint'];

const STRIP = new Set(STRIP_KEYS);

export function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      if (STRIP.has(k)) continue;
      out[k] = strip(v[k]);
    }
    return out;
  }
  return v;
}

/** Strings that still look like prose or pointers after stripping (a mapper must not copy them). */
export function leftovers(v: unknown, path = ''): string[] {
  const out: string[] = [];
  if (typeof v === 'string') {
    if (/<[a-z][^>]*>/i.test(v) || v.includes('@UUID') || v.includes('Compendium.')) out.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => out.push(...leftovers(x, `${path}[${i}]`)));
  else if (isRecord(v)) for (const k of Object.keys(v)) out.push(...leftovers(v[k], path ? `${path}.${k}` : k));
  return out;
}
