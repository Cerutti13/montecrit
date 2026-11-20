// The run in progress, owned by the app (not the Run panel), so switching tabs or reloading the
// home folder (which remounts the panel) never orphans it: Cancel stays reachable, and only the
// latest run started may report. A run superseded by a newer one is cancelled, and if it still
// finishes its session is closed and its result dropped.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cancelled, type Progress } from '@montecrit/host';
import type { ContentSet } from '../content/select.ts';
import { buildJob, startRun, type Finished, type Loaded, type RunRequest } from './session.ts';
import { webTransport } from './web-transport.ts';

export type RunState =
  | { readonly k: 'idle' }
  | { readonly k: 'running'; readonly req: RunRequest; readonly p: Progress | null; readonly t0: number; readonly now: number }
  | { readonly k: 'error'; readonly msg: string }
  | { readonly k: 'cancelled' };

export interface Runs {
  readonly state: RunState;
  /** loaded: the catalog's content and sheets, so seating a character doesn't load the packs again. */
  start(set: ContentSet, req: RunRequest, workers: number, loaded?: Loaded): void;
  cancel(): void;
  fail(msg: string): void;
}

export function useRuns(onFinished: (f: Finished, wallMs: number) => void): Runs {
  const [state, setState] = useState<RunState>({ k: 'idle' });
  const active = useRef<{ cancel(): void } | null>(null);
  const gen = useRef(0);
  const latest = useRef<Progress | null>(null);
  const frame = useRef(0);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      active.current?.cancel();
    },
    [],
  );
  const start = useCallback((set: ContentSet, req: RunRequest, workers: number, loaded?: Loaded) => {
    active.current?.cancel();
    const my = ++gen.current;
    const built = buildJob(set, req, loaded);
    if (!built.job) {
      active.current = null;
      setState({ k: 'error', msg: built.errors.join('; ') });
      return;
    }
    const t0 = performance.now();
    latest.current = null;
    setState({ k: 'running', req, p: null, t0, now: t0 });
    const r = startRun({ ...built, job: built.job }, req, webTransport, workers, (p) => {
      if (gen.current !== my) return;
      latest.current = p;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setState((s) => (s.k === 'running' && gen.current === my ? { ...s, p: latest.current, now: performance.now() } : s));
      });
    });
    active.current = r;
    r.done.then(
      (f) => {
        if (gen.current !== my) {
          f.session.close();
          return;
        }
        active.current = null;
        setState({ k: 'idle' });
        finished.current(f, performance.now() - t0);
      },
      (e: unknown) => {
        if (gen.current !== my) return;
        active.current = null;
        setState(e instanceof Cancelled ? { k: 'cancelled' } : { k: 'error', msg: e instanceof Error ? e.message : String(e) });
      },
    );
  }, []);
  const cancel = useCallback(() => active.current?.cancel(), []);
  const fail = useCallback((msg: string) => setState({ k: 'error', msg }), []);
  return { state, start, cancel, fail };
}
