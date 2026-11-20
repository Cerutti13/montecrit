// The CLI's extends lookup searches three places; its error names all three (coverage.md 8'b review, integration-8).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readScenarioInput } from '../src/files.ts';

describe('extends: a base it cannot find', () => {
  it('names the repo\'s scenarios/ folder, scenarios/golden/ and next to the file', () => {
    const d = mkdtempSync(join(tmpdir(), 'extends-'));
    try {
      writeFileSync(join(d, 'a.yaml'), 'kind: scenario\nid: a\nextends: nope\n');
      const r = readScenarioInput(join(d, 'a.yaml'), d);
      expect(JSON.stringify(r.errors)).toMatch(/in the repo's scenarios\/ folder, scenarios\/golden\/ or next to this file/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
