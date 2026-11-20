// Shared vocabulary for the PDF index.

export const CLASSES = [
  'barbarian',
  'bard',
  'cleric',
  'druid',
  'fighter',
  'monk',
  'paladin',
  'ranger',
  'rogue',
  'sorcerer',
  'warlock',
  'wizard',
] as const;
export type ClassId = (typeof CLASSES)[number];

export const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'] as const;

export const titleCase = (id: string): string => id[0]!.toUpperCase() + id.slice(1);

export function isClassId(s: string): s is ClassId {
  return (CLASSES as readonly string[]).includes(s);
}

/** "Path of the Berserker" -> "path-of-the-berserker"; "Monk’s Focus" -> "monks-focus". */
export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
