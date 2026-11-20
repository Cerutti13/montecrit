// The bundled committed content (apps/web/src/content/select.ts): glob keys become repo paths,
// the CLI's selection rules apply, and a text with a private marker stops the app.
import { describe, expect, it } from 'vitest';
import { bundledSet, extendable, repoPath } from '../src/content/select.ts';

const PRIV = 'priv' + 'ate';

describe('bundledSet', () => {
  it('normalizes keys, keeps packs with a manifest, top-level scenarios and policies, all under repo/', () => {
    const set = bundledSet({
      '../../../../packs/a/manifest.yaml': 'kind: manifest\n',
      '../../../../packs/a/m/x.yaml': 'kind: monster\n',
      '../../../../packs/b/x.yaml': 'kind: monster\n',
      '../../../../scenarios/s.yaml': 'kind: scenario\n',
      '../../../../policies/deep/p.yaml': 'kind: policy\n',
    });
    expect(repoPath('../../../../packs/a/x.yaml')).toBe('packs/a/x.yaml');
    expect(set.packs.map((f) => f.path)).toEqual(['repo/packs/a/m/x.yaml', 'repo/packs/a/manifest.yaml']);
    expect(set.scenarios.map((f) => f.path)).toEqual(['repo/scenarios/s.yaml']);
    expect(set.policies.map((f) => f.path)).toEqual(['repo/policies/deep/p.yaml']);
  });
  it('keeps a golden base out of the list to run, and scans it for a private marker too', () => {
    const set = bundledSet({ '../../../../scenarios/s.yaml': 'kind: scenario\n' }, { '../../../../scenarios/golden/g.yaml': 'kind: scenario\n' });
    expect(set.scenarios.map((f) => f.path)).toEqual(['repo/scenarios/s.yaml']);
    expect(set.bases!.map((f) => f.path)).toEqual(['repo/scenarios/golden/g.yaml']);
    expect(extendable(set).map((f) => f.path)).toEqual(['repo/scenarios/s.yaml', 'repo/scenarios/golden/g.yaml']);
    expect(() => bundledSet({}, { '../../../../scenarios/golden/g.yaml': `kind: scenario\nlicense: ${PRIV}\n` })).toThrow(/^bundled scenarios\/golden\/g\.yaml carries/);
  });
  it('throws on a private marker, naming the path only', () => {
    expect(() => bundledSet({ '../../../../packs/a/manifest.yaml': `kind: manifest\nlicense: ${PRIV}\n` })).toThrow(/^bundled packs\/a\/manifest\.yaml carries a private license \(line 2\)/);
  });
});
