// The private guard on real Vite (docs/design/m2.md 8.3), over a temporary repo and a temporary
// home; never the real repo or ~/.montecrit. Symlinks into the home stop the server and the build;
// with them gone, /@fs/ paths into the home are 403 and repo files are served; a link planted
// under the web root after start is not served with its private text; a build never writes it.
// The private marker is assembled at runtime (critique resolution 14).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, createServer, type InlineConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { unescapeJs } from '../../../tools/check-private.ts';
import { findEscapingLinks, isServable, privateGuard } from '../vite/private-guard.ts';

const MARK = 'license: ' + 'priv' + 'ate';
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function fixture() {
  // Real paths: macOS's tmpdir sits behind a /var -> /private/var link, which Vite's own allow list would trip on.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guard-repo-')));
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'guard-home-'))), '.montecrit');
  put(home, 'packs/p/manifest.yaml', `kind: manifest\npack: p\n${MARK}\n`);
  put(repo, 'packs/ok/manifest.yaml', 'kind: manifest\npack: ok\nlicense: test\n');
  put(repo, 'apps/web/index.html', '<!doctype html><script type="module" src="./main.js"></script>');
  put(repo, 'apps/web/main.js', "const all = import.meta.glob('../../packs/**/*.yaml', { query: '?raw', import: 'default', eager: true });\ndocument.title = String(Object.keys(all).length);\n");
  return { repo, home, web: join(repo, 'apps/web') };
}

const config = (f: ReturnType<typeof fixture>, port: number): InlineConfig => ({
  root: f.web,
  configFile: false,
  logLevel: 'silent',
  plugins: [privateGuard({ repoRoot: f.repo, home: f.home })],
  server: { host: '127.0.0.1', port, strictPort: true, cors: false, fs: { strict: true, allow: [f.repo] } },
  build: { outDir: join(f.repo, 'out'), emptyOutDir: true, write: true },
});

describe('private guard', () => {
  it('finds links that leave the repo or reach the home; judges paths after resolving links', () => {
    const f = fixture();
    symlinkSync(join(f.home, 'packs/p'), join(f.repo, 'packs/link'));
    symlinkSync(join(f.home, 'packs/p'), join(f.web, 'x'));
    symlinkSync(join(f.repo, 'packs/ok'), join(f.repo, 'packs/inside'));
    const roots = ['apps/web', 'packs'].map((d) => join(f.repo, d));
    expect(findEscapingLinks(roots, f.repo, f.home)).toEqual([join(f.repo, 'apps/web/x'), join(f.repo, 'packs/link')].sort());
    expect(isServable(join(f.repo, 'packs/link/manifest.yaml'), f.repo, f.home)).toBe(false);
    expect(isServable(join(f.repo, 'packs/inside/manifest.yaml'), f.repo, f.home)).toBe(true);
    expect(isServable(join(f.home, 'packs/p/manifest.yaml'), f.repo, f.home)).toBe(false);
  });

  it('the dev server: refuses to start over an escaping link; serves repo files; 403 into the home; never serves a link planted later', { timeout: 30_000 }, async () => {
    const f = fixture();
    symlinkSync(join(f.home, 'packs/p'), join(f.repo, 'packs/link'));
    await expect(createServer(config(f, 5191))).rejects.toThrow(/private guard: symlinks that leave the repo or reach the private home: packs\/link/);
    rmSync(join(f.repo, 'packs/link'));
    const server = await createServer(config(f, 5191));
    await server.listen();
    try {
      const base = 'http://127.0.0.1:5191';
      expect((await fetch(`${base}/@fs${f.home}/packs/p/manifest.yaml?raw`)).status).toBe(403);
      expect((await fetch(`${base}/@fs${join(f.repo, 'packs/ok/manifest.yaml')}?raw`)).status).toBe(200);
      expect((await fetch(`${base}/main.js`)).status).toBe(200);
      // A link under the web root, planted after start (the startup walk can't see it).
      symlinkSync(join(f.home, 'packs/p'), join(f.web, 'x'));
      const r = await fetch(`${base}/x/manifest.yaml`);
      const body = await r.text();
      expect(r.status === 200 && body.includes(MARK)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('a build over an escaping link fails without writing it; the load hook judges files, not virtual ids', { timeout: 30_000 }, async () => {
    const f = fixture();
    symlinkSync(join(f.home, 'packs/p'), join(f.repo, 'packs/link'));
    const e = await build(config(f, 5192)).catch((x: unknown) => x as Error);
    expect(String(e)).toMatch(/private guard: symlinks that leave the repo/);
    expect(String(e)).not.toMatch(/kind: manifest/);
    const out = join(f.repo, 'out');
    const written = existsSync(out) ? readdirSync(out, { recursive: true }).map((n) => join(out, String(n))) : [];
    for (const p of written) if (!p.endsWith('/assets')) expect(existsSync(p) && readFileSync(p, 'utf8').includes(MARK)).toBe(false);
    // Without the link, the build passes and its output carries no marker.
    rmSync(join(f.repo, 'packs/link'));
    await build(config(f, 5192));
    const files = readdirSync(out, { recursive: true }).map((n) => join(out, String(n))).filter((p) => p.endsWith('.js') || p.endsWith('.html'));
    expect(files.length).toBeGreaterThan(0);
    for (const p of files) expect(readFileSync(p, 'utf8')).not.toContain(MARK);

    // A marker that reaches the bundle by another way than a .yaml load (a raw .txt import), kept
    // as a double-quoted string with \n escapes (unminified output does that): the bundle scan,
    // which also reads the text with escapes undone, stops it.
    put(f.repo, 'apps/web/data.txt', `kind: manifest\n\`ticks\`\n${MARK}\n`);
    put(f.repo, 'apps/web/main.js', "import t from './data.txt?raw';\ndocument.title = t;\n");
    const c = config(f, 5192);
    const leak = await build({ ...c, build: { ...c.build, minify: false } }).catch((x: unknown) => x as Error);
    expect(String(leak)).toMatch(/private guard: .*manifest says license/);
    const after = readdirSync(out, { recursive: true }).map((n) => join(out, String(n))).filter((p) => p.endsWith('.js'));
    for (const p of after) expect(unescapeJs(readFileSync(p, 'utf8'))).not.toContain(MARK);

    const guard = privateGuard({ repoRoot: f.repo, home: f.home }) as unknown as { load: (this: { error: (m: string) => never }, id: string) => unknown };
    const ctx = { error: (m: string): never => { throw new Error(m); } };
    expect(guard.load.call(ctx, '\0virtual:x')).toBeNull();
    expect(guard.load.call(ctx, '/@react-refresh')).toBeNull();
    expect(guard.load.call(ctx, `${join(f.repo, 'packs/ok/manifest.yaml')}?raw&import`)).toBeNull();
    expect(() => guard.load.call(ctx, `${join(f.home, 'packs/p/manifest.yaml')}?raw`)).toThrow(/refused/);
  });
});
