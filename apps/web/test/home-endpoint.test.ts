// The dev home endpoint (apps/web/vite/home-endpoint.ts; docs/design/m2.md 3.4, Shane's decision 2)
// over a synthetic home, never ~/.montecrit: it reads only what the CLI loads (a planted .env, a
// notes file and an unlisted pack never come through), drops a key-shaped text naming its path
// only, answers 200 only same-origin, 204 with no home, sends no CORS headers, and doesn't exist
// in `vite preview`. Private markers and the key shape are assembled at runtime.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, createServer, preview, type InlineConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { homeEndpoint, readHome } from '../vite/home-endpoint.ts';
import { privateGuard } from '../vite/private-guard.ts';

const PRIV = 'priv' + 'ate';
const KEY = 'sk-' + 'ant-' + 'x'.repeat(24);
const SECRET = 'do-not-serve-' + 'this-text';
const REPO = realpathSync(join(import.meta.dirname, '..', '..', '..'));
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function synthHome(): string {
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'home-ep-'))), '.montecrit');
  put(home, 'config.yaml', 'packs:\n  - packs/extra\n');
  put(home, 'packs/extra/manifest.yaml', `kind: manifest\npack: extra\nversion: '1'\nrules: '2024'\nnamespace: ${PRIV}\nlicense: ${PRIV}\n`);
  put(home, 'packs/extra/monsters/m.yaml', readFileSync(join(REPO, 'packs/srd-5.2.1/monsters/goblin-warrior.yaml'), 'utf8').replace('id: srd:goblin-warrior', `id: ${PRIV}:goblin-copy`));
  put(home, 'packs/unlisted/manifest.yaml', `kind: manifest\npack: unlisted\n# ${SECRET}\n`);
  put(home, 'policies/p.yaml', readFileSync(join(REPO, 'policies/test-volley-first.yaml'), 'utf8').replace('id: test-volley-first', 'id: home-p'));
  put(home, 'policies/leaky.yaml', `kind: policy\nid: leaky\n# ${KEY}\n`);
  put(home, 'scenarios/twin.yaml', `kind: scenario\nid: twin\nextends: stars-ambush\npacks: [+extra]\n`);
  put(home, 'scenarios/nested/deep.yaml', `kind: scenario\nid: deep\n# ${SECRET}\n`);
  put(home, '.env', `ANTHROPIC_API_KEY=${KEY}\n`);
  put(home, 'notes/sheet.yaml', `# ${SECRET}\n`);
  return home;
}

describe('home endpoint', () => {
  it('readHome: the CLI\'s home packs, policies and top-level scenarios, nothing else; a key-shaped file dropped by path', () => {
    const home = synthHome();
    const h = readHome(home, REPO);
    expect(h.packs.map((f) => f.path).sort()).toEqual(['home/packs/extra/manifest.yaml', 'home/packs/extra/monsters/m.yaml']);
    expect(h.policies.map((f) => f.path)).toEqual(['home/policies/p.yaml']);
    expect(h.scenarios.map((f) => f.path)).toEqual(['home/scenarios/twin.yaml']);
    expect(h.errors).toEqual(['home/policies/leaky.yaml: dropped, it holds something shaped like an API key']);
    const all = JSON.stringify(h);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(KEY);
    expect(h.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(readHome(home, REPO).digest).toBe(h.digest);
  });

  it('the dev server: 200 same-origin, 403 otherwise, no CORS, 204 with no home; preview has no endpoint', { timeout: 60_000 }, async () => {
    const home = synthHome();
    const web = realpathSync(mkdtempSync(join(tmpdir(), 'home-ep-web-')));
    put(web, 'index.html', '<!doctype html><script type="module" src="./main.js"></script>');
    put(web, 'main.js', 'document.title = "x";\n');
    const cfg = (h: string, port: number): InlineConfig => ({
      root: web,
      configFile: false,
      logLevel: 'silent',
      plugins: [privateGuard({ repoRoot: web, home: h }), homeEndpoint({ repoRoot: REPO, home: h })],
      server: { host: '127.0.0.1', port, strictPort: true, cors: false },
      preview: { host: '127.0.0.1', port: port + 1, strictPort: true, cors: false },
      build: { outDir: join(web, 'dist'), emptyOutDir: true },
    });
    const server = await createServer(cfg(home, 5193));
    await server.listen();
    try {
      const url = 'http://127.0.0.1:5193/__home';
      const ok = await fetch(url, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const body = (await ok.json()) as { v: number; packs: { path: string }[] };
      expect([body.v, body.packs.length]).toEqual([1, 2]);
      expect((await fetch(url)).status).toBe(403);
      expect((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://evil.example' } })).status).toBe(403);
      const cors = await fetch(url, { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://localhost:3000' } });
      expect(cors.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await server.close();
    }
    const none = await createServer(cfg(join(home, 'missing'), 5195));
    await none.listen();
    try {
      expect((await fetch('http://127.0.0.1:5195/__home', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(204);
    } finally {
      await none.close();
    }
    await build(cfg(home, 5197));
    const p = await preview(cfg(home, 5197));
    try {
      const r = await fetch('http://127.0.0.1:5198/__home', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(r.status === 200 && (await r.text()).includes('manifest')).toBe(false);
    } finally {
      await new Promise<void>((res) => p.httpServer.close(() => res()));
    }
  });
});
