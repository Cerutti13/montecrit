// The private guard (docs/design/m2.md 8.2): a Vite plugin, Node side, never bundled. Private
// content lives in ~/.montecrit and must never be served by the dev server or land in a build.
// Four layers:
//  - before serving or building, refuse any symlink in the served or globbed trees that leaves the
//    repo or reaches the private home (Vite serves and globs through symlinks);
//  - `load`: refuse any module outside the repo or inside the home, and any YAML carrying a
//    private marker;
//  - a middleware ahead of Vite's own answers 403 to any request whose file, after resolving
//    symlinks, is outside the repo or under the home: /@fs/ paths, and plain paths under the web
//    root (Vite's static serving follows a link planted there after startup; the guard test
//    caught it); and to anything naming .montecrit;
//  - `generateBundle`: scan every chunk and asset with tools/check-private.ts before anything is
//    written, and refuse the DEV hook.
// Errors name paths only, never file text.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { privateMarker } from '@montecrit/host';
import { checkText } from '../../../tools/check-private.ts';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r));
};

/** Whether a path may be served or bundled: inside the repo and not inside the home, after resolving symlinks. */
export function isServable(path: string, repoRoot: string, home: string): boolean {
  const p = real(path);
  return inside(p, real(repoRoot)) && !inside(p, real(home)) && !inside(p, home);
}

/** Symlinks under the roots whose target leaves the repo or reaches the home (node_modules, dist and .git skipped). */
export function findEscapingLinks(roots: readonly string[], repoRoot: string, home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        if (!isServable(p, repoRoot, home)) out.push(p);
      } else if (st.isDirectory()) walk(p);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  return out.sort();
}

export interface GuardOptions {
  readonly repoRoot: string;
  /** The private home (~/.montecrit, or MONTECRIT_HOME). */
  readonly home: string;
}

export function privateGuard(opts: GuardOptions): Plugin {
  const { repoRoot, home } = opts;
  const roots = ['apps/web', 'packs', 'scenarios', 'policies'].map((d) => join(repoRoot, d));
  let webRoot = join(repoRoot, 'apps/web');
  const refuseLinks = (): void => {
    const bad = findEscapingLinks(roots, repoRoot, home);
    if (bad.length) throw new Error(`private guard: symlinks that leave the repo or reach the private home: ${bad.map((p) => relative(repoRoot, p)).join(', ')}`);
  };
  return {
    name: 'montecrit-private-guard',
    enforce: 'pre',
    configResolved(config) {
      webRoot = config.root;
    },
    buildStart() {
      refuseLinks();
    },
    configureServer(server) {
      refuseLinks();
      server.middlewares.use((req, res, next) => {
        let url = req.url ?? '';
        try {
          url = decodeURIComponent(url);
        } catch {
          // Undecodable: judged as written.
        }
        const clean = url.split('?')[0]!;
        const fs = clean.indexOf('/@fs/');
        // The file this request would read: an /@fs/ path as given, any other path under the web root.
        const path = fs >= 0 ? clean.slice(fs + 4) : clean.startsWith('/@') ? null : join(webRoot, clean);
        const refused = path !== null && (fs >= 0 || existsSync(path)) && !isServable(path, repoRoot, home);
        if (url.includes('.montecrit') || refused) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        next();
      });
    },
    load(id) {
      // Virtual modules and Vite's own ids (/@react-refresh, /@vite/client) aren't files, and a
      // path that isn't a file can't leak one: only real files are judged.
      if (id.startsWith('\0') || !isAbsolute(id)) return null;
      const path = id.split('?')[0]!;
      if (!existsSync(path)) return null;
      if (!isServable(path, repoRoot, home)) this.error(`private guard: refused ${path}: outside the repo or inside the private home`);
      if (/\.ya?ml$/i.test(path)) {
        const m = privateMarker(readFileSync(path, 'utf8'));
        if (m) this.error(`private guard: refused ${relative(repoRoot, path)}: it carries ${m.what} (line ${m.line})`);
      }
      return null;
    },
    generateBundle(_out, bundle) {
      for (const [name, item] of Object.entries(bundle)) {
        const text = item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
        const found = checkText(name, text, false, { bundle: true });
        if (found.length) this.error(`private guard: ${found.map((f) => `${f.file}: ${f.why}`).join('; ')}`);
        if (text.includes('__montecrit')) this.error(`private guard: ${name} carries the dev-only hook`);
      }
    },
  };
}
