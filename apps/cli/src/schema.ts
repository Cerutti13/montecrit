// `montecrit schema [--out DIR]`: writes one JSON Schema per file kind to schemas/ (generated
// from the zod schemas; commit the output so editors can autocomplete content files).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { contentJsonSchemas } from '@montecrit/engine';
import { REPO_ROOT, displayPath } from './files.ts';
import type { CommandOutput } from './lint.ts';

export const SCHEMA_USAGE = `usage: montecrit schema [--out DIR]

  --out DIR   where to write the *.json files (default: schemas/ at the repo root)`;

/** File name -> JSON text, in a fixed order. */
export function schemaFiles(): [string, string][] {
  const schemas = contentJsonSchemas();
  return Object.keys(schemas).map((name) => [`${name}.json`, `${JSON.stringify(schemas[name], null, 2)}\n`]);
}

export function runSchema(argv: readonly string[], repoRoot: string = REPO_ROOT): CommandOutput {
  const { values } = parseArgs({ args: [...argv], options: { out: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) return { out: SCHEMA_USAGE, err: '', code: 0 };
  const dir = values.out !== undefined ? resolve(values.out) : join(repoRoot, 'schemas');
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const [name, text] of schemaFiles()) {
    const p = join(dir, name);
    writeFileSync(p, text);
    lines.push(`wrote ${displayPath(p)}`);
  }
  return { out: lines.join('\n'), err: '', code: 0 };
}
