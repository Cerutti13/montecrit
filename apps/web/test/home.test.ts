// The page's side of the home (apps/web/src/content/home.ts): every answer /__home can give.
import { describe, expect, it } from 'vitest';
import { fetchHome, withHome } from '../src/content/home.ts';

const res = (status: number, body: string | null, type = 'application/json') => async () => new Response(body, { status, headers: { 'content-type': type } });

describe('fetchHome', () => {
  it('loads a home; says why there is none; reports errors', async () => {
    const home = { v: 1, digest: 'abcd1234abcd1234', packs: [{ path: 'home/packs/a/manifest.yaml', text: 'x' }], scenarios: [], policies: [], errors: [] };
    const ok = await fetchHome(res(200, JSON.stringify(home)));
    expect(ok.k === 'loaded' && ok.home.packs.length).toBe(1);
    expect(await fetchHome(res(204, null))).toEqual({ k: 'none', why: 'no private home folder' });
    expect(await fetchHome(res(404, 'not found', 'text/plain'))).toEqual({ k: 'none', why: 'no private home (dev server only)' });
    expect(await fetchHome(res(200, '<!doctype html>', 'text/html'))).toEqual({ k: 'none', why: 'no private home (dev server only)' });
    expect((await fetchHome(res(403, 'forbidden', 'text/plain'))).k).toBe('error');
    expect((await fetchHome(res(200, JSON.stringify({ ...home, v: 2 })))).k).toBe('error');
    expect((await fetchHome(async () => Promise.reject(new Error('down')))).k).toBe('error');
  });
  it('merges repo first, then home', () => {
    const repo = { packs: [{ path: 'repo/p', text: '' }], scenarios: [], policies: [{ path: 'repo/q', text: '' }] };
    const merged = withHome(repo, { digest: '', packs: [{ path: 'home/p', text: '' }], scenarios: [], policies: [{ path: 'home/q', text: '' }], errors: [] });
    expect(merged.packs.map((f) => f.path)).toEqual(['repo/p', 'home/p']);
    expect(merged.policies.map((f) => f.path)).toEqual(['repo/q', 'home/q']);
    expect(withHome(repo, null)).toBe(repo);
  });
  it('keeps the repo\'s golden bases through the merge: a bundled scenario on one still resolves once the home is in', () => {
    const repo = { packs: [], scenarios: [], policies: [], bases: [{ path: 'repo/scenarios/golden/g.yaml', text: '' }] };
    const merged = withHome(repo, { digest: '', packs: [], scenarios: [], policies: [], errors: [] });
    expect(merged.bases).toEqual(repo.bases);
  });
});
