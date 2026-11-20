// The browser app's dev server and build (docs/design/m2.md 8.2). Local only: 127.0.0.1, a fixed
// port (5180; inkless-g2 has 5173), no CORS, strict file serving inside the repo, and the
// private guard (vite/private-guard.ts) in front of everything Vite serves or bundles. The dev
// server alone also serves the private home's texts to this page (vite/home-endpoint.ts).
// BASE sets the public path for a static host (GitHub Pages serves a project site under /<repo>/).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { homeEndpoint } from './vite/home-endpoint.ts';
import { privateGuard } from './vite/private-guard.ts';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const home = process.env.MONTECRIT_HOME ?? join(homedir(), '.montecrit');

export default defineConfig({
  root: webRoot,
  base: process.env.BASE ?? '/',
  publicDir: false,
  plugins: [privateGuard({ repoRoot, home }), homeEndpoint({ repoRoot, home }), react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    cors: false,
    fs: { strict: true, allow: [repoRoot], deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '**/.git/**', '**/.montecrit/**', '**/packs/private/**'] },
  },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true, cors: false },
  worker: { format: 'es' },
  // One local bundle (engine, yaml, zod, React), plus the packs' texts in a lazy chunk
  // (src/content/packs.ts, docs/design/m3.md C19) so the index chunk stays under its budget.
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
