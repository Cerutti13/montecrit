// The extends lookup searches three places; its error names all three (coverage.md 8'b review, integration-8).
import { describe, expect, it } from 'vitest';
import { scenarioInput } from '../src/sources.ts';

describe('extends: a base it cannot find', () => {
  it('names the repo\'s scenarios/ folder, scenarios/golden/ and next to the file', () => {
    const r = scenarioInput([{ path: 'repo/scenarios/a.yaml', text: 'kind: scenario\nid: a\nextends: nope\n' }], 'repo/scenarios/a.yaml', 'repo/scenarios');
    expect(JSON.stringify(r.errors)).toMatch(/in the repo's scenarios\/ folder, scenarios\/golden\/ or next to this file/);
  });
});
