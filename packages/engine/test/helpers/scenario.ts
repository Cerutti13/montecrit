// Loads a repo scenario for engine tests, merging one that `extends` another (base looked up in
// scenarios/, as the CLI does) with the engine's own extendScenario.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Content } from '../../src/content/types.ts';
import { formatDiag } from '../../src/content/yaml.ts';
import { extendScenario, extendsName } from '../../src/scenario/extend.ts';
import { resolveScenario } from '../../src/scenario/resolve.ts';
import type { FightSetup } from '../../src/sim/setup.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

export function loadScenario(file: string, content: Content): FightSetup {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const doc = parse(text) as unknown;
  const base = extendsName(doc);
  let input: unknown = text;
  if (base !== null) {
    const merged = extendScenario(doc, parse(readFileSync(join(ROOT, 'scenarios', `${base}.yaml`), 'utf8')));
    if (merged.value === null) throw new Error(merged.errors.join('\n'));
    input = merged.value;
  }
  const res = resolveScenario(input, file, content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}
