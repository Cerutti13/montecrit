// The committed pack files (docs/design/m3.md section 11, C19): a module of its own so Vite puts
// them in a lazy chunk, loaded by bundled.ts loadBundledPacks after the page starts. The same
// selection and private-marker check as every bundled text (select.ts bundledSet).

import { bundledSet } from './select.ts';

const raw: Record<string, string> = import.meta.glob<string>('../../../../packs/**/*.{yaml,yml}', { query: '?raw', import: 'default', eager: true });

// The premade heroes (tools/gen-heroes.ts, apps/web/heroes/): the app's own characters, one per
// class and level, loaded as test-pack characters. The CLI and the packs on disk never see them.
const heroes: Record<string, string> = import.meta.glob<string>('../../heroes/*.yaml', { query: '?raw', import: 'default', eager: true });
for (const [key, text] of Object.entries(heroes)) raw[`../../../../packs/test/characters/heroes/${key.slice(key.lastIndexOf('/') + 1)}`] = text;

export const PACKS = bundledSet(raw).packs;
