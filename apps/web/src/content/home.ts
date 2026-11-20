// The private home folder, from the dev server's /__home (docs/design/m2.md 3.4). Present only
// under `npm run web`; a build or `vite preview` has none, and the app runs on repo content.
// Nothing is cached here: no storage, nothing in a URL, nothing to the console (lint).

import type { SourceFile } from '@montecrit/engine';
import type { ContentSet } from './select.ts';

export interface HomeLoad {
  readonly digest: string;
  readonly packs: readonly SourceFile[];
  readonly scenarios: readonly SourceFile[];
  readonly policies: readonly SourceFile[];
  readonly errors: readonly string[];
}

export type HomeState = { readonly k: 'none'; readonly why: string } | { readonly k: 'loaded'; readonly home: HomeLoad } | { readonly k: 'error'; readonly msg: string };

/** 'none' when there's no home to load (no folder, or not the dev server). */
export async function fetchHome(get: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<HomeState> {
  let r: Response;
  try {
    r = await get('/__home', { cache: 'no-store', credentials: 'same-origin' });
  } catch (e) {
    return { k: 'error', msg: `couldn't reach the dev server's home endpoint: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.status === 204) return { k: 'none', why: 'no private home folder' };
  if (r.status === 404) return { k: 'none', why: 'no private home (dev server only)' };
  if (!r.ok) return { k: 'error', msg: `the home endpoint answered ${r.status}` };
  // `vite preview` and static hosts answer unknown paths with index.html: no endpoint there.
  if (!(r.headers.get('content-type') ?? '').includes('application/json')) return { k: 'none', why: 'no private home (dev server only)' };
  const body = (await r.json()) as { v: number } & HomeLoad;
  if (body.v !== 1) return { k: 'error', msg: `unknown home format v${body.v}` };
  return { k: 'loaded', home: { digest: body.digest, packs: body.packs, scenarios: body.scenarios, policies: body.policies, errors: body.errors } };
}

/** Repo content plus the home's, repo first (policy order matters: two with one id is an error). */
export function withHome(repo: ContentSet, home: HomeLoad | null): ContentSet {
  if (!home) return repo;
  return { ...repo, packs: [...repo.packs, ...home.packs], scenarios: [...repo.scenarios, ...home.scenarios], policies: [...repo.policies, ...home.policies] };
}
