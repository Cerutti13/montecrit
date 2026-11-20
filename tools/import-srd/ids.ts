// Our ids for imported records. Default policy (mappers may refine it, main.ts checks that
// every emitted id is unique): the record's Foundry system.identifier, kebab-case, under
// srd:. Features nest under their owner: srd:<owner identifier>/<identifier>, the owner
// being the first gate-passing owner (lowest level, then name).

import type { Kept } from './filter.ts';
import { getPath } from './util.ts';

const kebab = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/['’]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The identifier of a record: system.identifier when it is a clean slug, else its name, kebab-cased. */
export function identOf(doc: Readonly<Record<string, unknown>>, name: string): string {
  const ident = getPath(doc, 'system.identifier');
  const slug = typeof ident === 'string' && ident ? kebab(ident) : '';
  return slug || kebab(name);
}

/**
 * The default srd id. `ownerIdent` gives an owner's identifier by its Foundry id (classes,
 * subclasses and species are owners).
 */
export function defaultId(k: Kept, ownerIdent: (foreignId: string) => string | undefined): string {
  const own = identOf(k.rec.doc, k.rec.name);
  if (k.kind === 'feature' || k.kind === 'speciesTrait') {
    const o = k.owners[0];
    const oi = o ? ownerIdent(o.foreignId) : undefined;
    if (!oi) throw new Error(`${k.rec.path}: a ${k.kind} needs an owner for its id`);
    return `srd:${oi}/${own}`;
  }
  return `srd:${own}`;
}
