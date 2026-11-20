// The private home for the browser (docs/design/m2.md 3.4; Shane's decision 2, 2026-11-02): a
// dev-only endpoint, GET /__home, that reads ~/.montecrit (or MONTECRIT_HOME) with the CLI's own code
// and hands this app's page the texts the CLI would load. Node side, never bundled.
//  - Dev only: registered in configureServer under `apply: 'serve'`; `vite preview` and builds have
//    no /__home (404), and the app runs on repo content.
//  - Same origin only: Vite binds 127.0.0.1, refuses foreign Host headers, and runs with CORS off;
//    the handler also wants `Sec-Fetch-Site: same-origin` and answers no-store.
//  - Reads only what the CLI loads: the home packs (config.yaml's list, the characters folder),
//    home policies, top-level home scenarios. Never .env, notes, sheets or anything else. A text
//    shaped like an API key is dropped, its path reported, its text never.

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { hash64, type SourceFile } from '@montecrit/engine';
import { isInside, readYamlFiles } from '../../cli/src/files.ts';
import { loadPolicies, readKnown } from '../../cli/src/home.ts';

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{20,}/;

export interface HomeTexts {
  readonly v: 1;
  /** hash64 over every path and text: shows when the folder changed. */
  readonly digest: string;
  readonly packs: readonly SourceFile[];
  readonly scenarios: readonly SourceFile[];
  readonly policies: readonly SourceFile[];
  /** Paths and reasons only. */
  readonly errors: readonly string[];
}

/** The home folder's texts under 'home/...' paths, as the CLI would load them. */
export function readHome(home: string, repoRoot: string): HomeTexts {
  const env = { MONTECRIT_HOME: home };
  const errors: string[] = [];
  const rel = (p: string) => `home/${relative(home, p)}`;
  const keep = (files: readonly SourceFile[]): SourceFile[] =>
    files.flatMap((f) => {
      if (KEY_SHAPE.test(f.text)) {
        errors.push(`${rel(f.path)}: dropped, it holds something shaped like an API key`);
        return [];
      }
      return [{ path: rel(f.path), text: f.text }];
    });
  const known = readKnown(env, [], repoRoot);
  for (const d of known.errors) errors.push(`${d.path.startsWith(home) ? rel(d.path) : d.path}: ${d.message}`);
  const outside = known.files.filter((f) => !isInside(f.path, home) && !isInside(f.path, repoRoot));
  for (const f of outside) errors.push(`${f.path}: config.yaml names a pack outside the home folder; the browser loads only the home folder`);
  const packs = keep(known.files.filter((f) => isInside(f.path, home)));
  const pol = loadPolicies(env, repoRoot);
  const policies = keep(pol.files.filter((f) => isInside(f.path, home)));
  const scenDir = join(home, 'scenarios');
  const scen = existsSync(scenDir) ? readYamlFiles([scenDir], repoRoot) : { files: [], errors: [] };
  for (const d of scen.errors) errors.push(`${rel(d.path)}: ${d.message}`);
  const scenarios = keep(scen.files.filter((f) => relative(scenDir, f.path).split('/').length === 1));
  const all = [...packs, ...scenarios, ...policies];
  const digest = hash64(all.map((f) => `${f.path}\n${f.text}`).join('\n\u0000\n'));
  return { v: 1, digest, packs, scenarios, policies, errors };
}

export function homeEndpoint(opts: { readonly repoRoot: string; readonly home: string }): Plugin {
  return {
    name: 'montecrit-home-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__home', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (req.headers['sec-fetch-site'] !== 'same-origin') {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        if (!existsSync(opts.home)) {
          res.statusCode = 204;
          res.end();
          return;
        }
        let body: string;
        try {
          body = JSON.stringify(readHome(opts.home, opts.repoRoot));
        } catch (e) {
          res.statusCode = 500;
          res.end(`home folder unreadable: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    },
  };
}
