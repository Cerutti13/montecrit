// The app shell (docs/design/m2.md 6): a tab bar (screens live in React state, nothing in the
// URL), the content chip, and the screen. Screens for later milestones show as disabled tabs.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceFile } from '@montecrit/engine';
import type { Session } from '@montecrit/host';
import { About } from './about/About.tsx';
import type { ScreenState } from './character/screen-state.ts';
import { BUNDLED, loadBundledPacks, withPacks } from './content/bundled.ts';
import { CheckScreen, INITIAL_CHECK, type CheckState } from './check/CheckScreen.tsx';
import { CompareScreen, INITIAL_COMPARE, type CompareForm } from './compare/CompareScreen.tsx';
import { useCompare } from './compare/useCompare.ts';
import { withVariants } from './compare/variant.ts';
import { catalog, scenarioEntry } from './content/catalog.ts';
import { fetchHome, withHome, type HomeState } from './content/home.ts';
import { INITIAL_ODDS, OddsScreen, type OddsState } from './odds/OddsScreen.tsx';
import { CHECK_ID, CHECK_PATH, QUICK_PATH, encounterFile, fightFile, type Encounter } from './practice/encounter.ts';
import { INITIAL_ENCOUNTER, INITIAL_PRACTICE, PracticeScreen, type PracticeState } from './practice/PracticeScreen.tsx';
import type { ExemplarKind } from './results/Results.tsx';
import { Replay } from './replay/Replay.tsx';
import { RunScreen, type LastRun } from './run/RunScreen.tsx';
import { useRuns } from './run/useRuns.ts';
import { applyTheme, loadTheme, type ThemeChoice } from './theme.ts';

// The Character screen is its own lazy chunk (m3.md section 11: the index chunk stays under 800 KB).
const CharacterScreen = lazy(() => import('./character/CharacterScreen.tsx').then((m) => ({ default: m.CharacterScreen })));

// The dev-only self-test hook (docs/design/m2.md 9.2): never in a build (the dist scan refuses its name).
if (import.meta.env.DEV) void import('./debug.ts');

export interface ReplayTarget {
  readonly last: LastRun;
  readonly arm: number;
  readonly kind: ExemplarKind;
  readonly run: number;
}

type Screen = 'run' | 'replay' | 'character' | 'odds' | 'practice' | 'check' | 'compare' | 'about';

const LATER: readonly [string, string][] = [];

export function App() {
  const [screen, setScreen] = useState<Screen>('run');
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [last, setLast] = useState<LastRun | null>(null);
  const [replay, setReplay] = useState<ReplayTarget | null>(null);
  const [home, setHome] = useState<HomeState | null>(null);
  // The Character screen's pick, form and unsaved edits: kept here so a tab switch keeps them.
  const [character, setCharacter] = useState<ScreenState | null>(null);
  // The Odds screen's pick, DC and group: kept here for the same reason.
  const [odds, setOdds] = useState<OddsState>(INITIAL_ODDS);
  const [practice, setPractice] = useState<PracticeState>(INITIAL_PRACTICE);
  // The quick encounter: a fight built from a few picks, added to the content set as a scenario text.
  const [enc, setEnc] = useState<Encounter>(INITIAL_ENCOUNTER);
  // The Encounter check's party and foes: a second generated scenario, built the same way.
  const [check, setCheck] = useState<CheckState>(INITIAL_CHECK);
  const loadHome = useCallback(() => {
    // A static build (GitHub Pages) has no dev server and so no home folder: skip the request.
    if (!import.meta.env.DEV) return setHome({ k: 'none', why: 'web build' });
    setHome(null);
    void fetchHome().then(setHome);
  }, []);
  useEffect(loadHome, [loadHome]);
  // The packs come from their own lazy chunk (C19); the Run screen waits for them.
  const [packs, setPacks] = useState<readonly SourceFile[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  useEffect(() => {
    void loadBundledPacks().then(setPacks, (e: unknown) => setPacksError(e instanceof Error ? e.message : String(e)));
  }, []);
  // The Compare screen's picks and variants: kept here so a tab switch keeps them. A variant in use
  // is a character text added to the packs, so every screen can seat it.
  const [compareForm, setCompareForm] = useState<CompareForm>(INITIAL_COMPARE);
  const variants = compareForm.variants;
  const baseSet = useMemo(() => withVariants(withHome(withPacks(BUNDLED, packs ?? []), home?.k === 'loaded' ? home.home : null), variants), [home, packs, variants]);
  const baseCat = useMemo(() => (packs === null ? null : catalog(baseSet)), [baseSet, packs]);
  // The packs load once (baseCat); the quick encounter only adds one scenario entry on top.
  const quick = useMemo(() => (baseCat === null ? null : encounterFile(enc, baseCat.content)), [enc, baseCat]);
  const checkFight = useMemo(() => (baseCat === null ? null : fightFile(check.fight, baseCat.content, CHECK_PATH, CHECK_ID, 'Encounter check')), [check.fight, baseCat]);
  const made = useMemo(() => [quick?.file, checkFight?.file].filter((f): f is SourceFile => f != null), [quick, checkFight]);
  const set = useMemo(() => (made.length > 0 ? { ...baseSet, scenarios: [...baseSet.scenarios, ...made] } : baseSet), [baseSet, made]);
  const cat = useMemo(() => (baseCat === null ? null : made.length > 0 ? { ...baseCat, scenarios: [...baseCat.scenarios, ...made.map((f) => scenarioEntry(set, f, baseCat.content))] } : baseCat), [baseCat, made, set]);
  const finished = useCallback((f: LastRun['f'], wallMs: number) => setLast({ f, wallMs }), []);
  // A run's session (its workers) stays open while the Run screen shows its results or a replay
  // of one of its fights is open; it closes once neither does.
  const open = useRef(new Set<Session>());
  useEffect(() => {
    const keep = new Set<Session>([last?.f.session, replay?.last.f.session].filter((x): x is Session => x !== undefined));
    for (const s of open.current) if (!keep.has(s)) s.close();
    open.current = keep;
  }, [last, replay]);
  const runs = useRuns(finished);
  const compares = useCompare();
  const tab = (s: Screen, label: string) => (
    <button type="button" aria-current={screen === s ? 'page' : undefined} onClick={() => setScreen(s)}>
      {label}
    </button>
  );
  return (
    <>
      <header className="top">
        <span className="brand">montecrit</span>
        <nav className="tabs" aria-label="Screens">
          {tab('run', 'Run')}
          {tab('replay', 'Replay')}
          {tab('character', 'Character')}
          {tab('odds', 'Odds')}
          {tab('practice', 'Practice')}
          {tab('check', 'Encounter')}
          {tab('compare', 'Compare')}
          {tab('about', 'About')}
          {LATER.map(([label, m]) => (
            <button key={label} type="button" disabled aria-label={`${label} (coming in ${m})`} title={`Coming in ${m}`}>
              {label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <label className="muted">
          Theme{' '}
          <select
            value={theme}
            onChange={(e) => {
              const t = e.target.value as ThemeChoice;
              setTheme(t);
              applyTheme(t);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      {home?.k === 'loaded' ? (
        <div className="chipbar private">
          PRIVATE HOME LOADED · {home.home.packs.length + home.home.scenarios.length + home.home.policies.length} files · digest {home.home.digest.slice(0, 8)}{' '}
          <button type="button" onClick={loadHome}>
            Reload home
          </button>
          {home.home.errors.length > 0 && <span> · {home.home.errors.join('; ')}</span>}
        </div>
      ) : !import.meta.env.DEV ? null : (
        <div className="chipbar">
          {home === null ? 'loading the home folder...' : home.k === 'none' ? `repo content only (${home.why})` : `repo content only: ${home.msg}`}{' '}
          {home !== null && (
            <button type="button" onClick={loadHome}>
              Retry
            </button>
          )}
        </div>
      )}
      <main>
        {(screen === 'run' || screen === 'character' || screen === 'odds' || screen === 'practice' || screen === 'check' || screen === 'compare') && cat === null && <p className="note">{packsError !== null ? `The content failed to load: ${packsError}` : 'loading the content...'}</p>}
        {screen === 'run' && cat !== null && (
          <RunScreen
            catalog={cat}
            set={set}
            last={last}
            runs={runs}
            onReplay={(arm, kind, run) => {
              if (!last) return;
              setReplay({ last, arm, kind, run });
              setScreen('replay');
            }}
          />
        )}
        {screen === 'replay' && (replay ? <Replay key={`${replay.arm}-${replay.run}-${replay.last.wallMs}`} target={replay} latest={replay.last === last} /> : <p className="note">Pick an exemplar fight from a report (Run screen) to replay it here.</p>)}
        {screen === 'character' && cat !== null && (
          <Suspense fallback={<p className="note">loading the Character screen...</p>}>
            <CharacterScreen set={set} homeLoading={home === null} state={character} setState={setCharacter} />
          </Suspense>
        )}
        {screen === 'odds' && cat !== null && <OddsScreen sheets={cat.sheets} characters={cat.characters} state={odds} setState={setOdds} />}
        {screen === 'practice' && cat !== null && (
          <PracticeScreen
            catalog={cat}
            set={set}
            state={practice}
            setState={setPractice}
            enc={enc}
            setEnc={setEnc}
            encErrors={quick?.errors ?? []}
            encText={quick?.file?.text ?? null}
          />
        )}
        {screen === 'check' && cat !== null && (
          <CheckScreen
            catalog={cat}
            set={set}
            state={check}
            setState={setCheck}
            errors={checkFight?.errors ?? []}
            text={checkFight?.file?.text ?? null}
            runs={runs}
            last={last}
            onReport={() => setScreen('run')}
            onPractice={() => {
              setPractice((p) => ({ ...p, scenario: CHECK_PATH, seat: null, pc: '', answers: [] }));
              setScreen('practice');
            }}
          />
        )}
        {screen === 'compare' && cat !== null && <CompareScreen catalog={cat} set={set} form={compareForm} setForm={setCompareForm} compares={compares} />}
        {screen === 'about' && <About />}
      </main>
    </>
  );
}
