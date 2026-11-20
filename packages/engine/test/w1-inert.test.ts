// Coverage W1.0 (docs/design/w1-plan.md section 6.1, check 1): the inertness net for W1. The
// m3-foundations template hashes leave out every kind: character template and the imported monsters,
// and those are exactly what W1 changes. So this snapshot pins, from HEAD content (2026-11-12, before
// any W1 engine code): the compiled-template hash of every packs/test/characters/*.yaml character and
// every smoke-corpus character, and, for every compiled template (characters, monsters, pcs), a hash
// of sim/attack.ts attackKeyOf over each of its attacks, plain and as an opportunity attack.
//
// W1.0 and W1.1 must keep it byte-identical: every new primitive compiles into a template only when
// content uses it (C3), and P7's key bits fold in only when a template carries a pattern that names
// an attack ability or source. W1.2 regenerates the pack, rewrites this fixture
// (W1_WRITE_FIXTURE=1 npx vitest run packages/engine/test/w1-inert.test.ts) and lists every move in
// the plan's section 12; any move outside section 6.1's list means something isn't content-gated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import { formatDiag } from '../src/content/yaml.ts';
import { attackKeyOf } from '../src/sim/attack.ts';
import { canonicalJson } from '../src/util/canon.ts';
import { hash64 } from '../src/util/hash.ts';
import { smokePackFiles } from '../../../tools/smoke-classes.ts';
import { smokeCorpus, smokeSpells } from '../../../tools/smoke-corpus.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'w1-character-hashes.json');

interface Snapshot {
  /** hash64(canonicalJson(template)) per kind: character id (packs/test/characters and the smoke corpus). */
  readonly characters: Record<string, string>;
  /** hash64 of every attack's attackKeyOf (plain, then opportunity), per template id, for every template loaded. */
  readonly attackKeys: Record<string, string>;
}

const tplHash = (t: CompiledTemplate): string => hash64(canonicalJson(t));
const keysHash = (t: CompiledTemplate): string => hash64(canonicalJson(t.attacks.map((a) => [a.id, attackKeyOf(a, false), attackKeyOf(a, true)])));

function snapshot(): Snapshot {
  const files = smokePackFiles(ROOT);
  const corpus = smokeCorpus(files, smokeSpells(readFileSync(join(ROOT, 'tools', 'import-srd', 'srd-index.json'), 'utf8')));
  const all = [...files, ...corpus.map((c) => ({ path: c.path, text: c.text }))];
  const r = loadContent(all);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const characterIds = all.filter((f) => /^kind: character$/m.test(f.text)).map((f) => /^id: (\S+)$/m.exec(f.text)![1]!);
  const characters: Record<string, string> = {};
  for (const id of [...characterIds].sort()) {
    const t = r.content.get(id);
    if (!t) throw new Error(`${id} didn't compile`);
    characters[id] = tplHash(t);
  }
  const attackKeys: Record<string, string> = {};
  for (const t of r.content.templates) attackKeys[t.id] = keysHash(t);
  return { characters, attackKeys };
}

describe('W1 inertness (w1-plan.md 6.1 check 1): class-built characters and attack keys are byte-identical to HEAD', () => {
  const now = snapshot();
  if (process.env.W1_WRITE_FIXTURE) writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);

  it('the fixture exists and covers every packs/test character and the 60 smoke characters', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const snap = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Snapshot;
    expect(Object.keys(snap.characters).filter((id) => id.startsWith('test:smoke-'))).toHaveLength(60);
    for (const id of ['test:sample-barbarian', 'test:sample-kin-druid', 'test:sample-monk', 'test:sample-fighter-built']) expect(Object.hasOwn(snap.characters, id), id).toBe(true);
  });

  it('every character template hashes as in the fixture', () => {
    const snap = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Snapshot;
    expect(now.characters).toEqual(snap.characters);
  });

  it('attackKeyOf returns the fixture key for every attack of every compiled template', () => {
    const snap = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Snapshot;
    expect(now.attackKeys).toEqual(snap.attackKeys);
  });
});
