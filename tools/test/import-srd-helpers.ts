// Tiny synthetic Foundry-shaped records for the importer tests. Every name here is either an
// ordinary SRD name or made up; no real record is read.

import { stringify } from 'yaml';
import { parseRecord, type FoundryRecord } from '../import-srd/read.ts';
import { parsePins, type Pins } from '../import-srd/pins.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMMIT = '87e94dbd9f930135e0694cd7e7d49f210603cd2c';

export const SRC = { license: 'CC-BY-4.0', book: '', rules: '2024', revision: 1, custom: '' };

let n = 0;
/** A 16-character Foundry-style id. */
export const fid = (stem: string): string => `${stem}${'0'.repeat(16)}`.slice(0, 16);

export function rec(path: string, doc: Record<string, unknown>): FoundryRecord {
  n++;
  return parseRecord(path, stringify({ _id: fid(`syn${n}`), ...doc }));
}

export const grant = (level: number, ids: readonly string[], pack = 'classes24') => ({
  type: 'ItemGrant',
  level,
  configuration: { items: ids.map((id) => ({ uuid: `Compendium.dnd5e.${pack}.Item.${id}`, optional: false })) },
});

export function klass(name: string, ident: string, grants: readonly unknown[], extra: Record<string, unknown> = {}): FoundryRecord {
  return rec(`packs/_source/classes24/${ident}/${ident}.yml`, {
    _id: fid(`cls${ident}`),
    name,
    type: 'class',
    img: 'icons/x.webp',
    system: { identifier: ident, source: SRC, description: { value: '<p>prose</p>' }, advancement: grants, ...extra },
  });
}

export function feature(name: string, cls: string, id: string, extra: Record<string, unknown> = {}, source: Record<string, unknown> = SRC): FoundryRecord {
  return rec(`packs/_source/classes24/${cls}/class-features/${id.toLowerCase()}.yml`, {
    _id: id,
    name,
    type: 'feat',
    system: { type: { value: 'class', subtype: '' }, source, identifier: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: { value: '<p>x</p>' }, ...extra },
  });
}

export function weapon(name: string, extra: Record<string, unknown> = {}, source: Record<string, unknown> = SRC): FoundryRecord {
  return rec(`packs/_source/equipment24/weapons/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yml`, {
    name,
    type: 'weapon',
    img: 'systems/dnd5e/icons/x.webp',
    system: { type: { value: 'martialM' }, source, damage: { base: { number: 1, denomination: 8 } }, ...extra },
  });
}

export function testPins(): Pins {
  return parsePins(readFileSync(join(import.meta.dirname, '..', 'import-srd', 'pins.json'), 'utf8'));
}
