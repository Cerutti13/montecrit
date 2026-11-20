// The Encounter check: a DM picks a party and the foes, the app plays the fight many times with
// the AI on both sides, and says how it tends to go: how often the party wins, how often someone
// drops, how long it runs. The fight is an ordinary generated scenario (practice/encounter.ts),
// so the Run tab's full report and Practice both open on the same fight.

import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { fmt, type Rate } from '@montecrit/engine';
import type { Catalog } from '../content/catalog.ts';
import type { ContentSet } from '../content/select.ts';
import { CHECK_PATH, MAX_FOES, MAX_PARTY, statBlocks, type Fight } from '../practice/encounter.ts';
import type { LastRun } from '../run/RunScreen.tsx';
import type { Runs } from '../run/useRuns.ts';
import { defaultWorkers } from '../run/web-transport.ts';
import { CUTS, verdictOf } from './verdict.ts';

export interface CheckState {
  readonly fight: Fight;
  /** Fights to play. */
  readonly n: number;
  /** The scenario text of the last check started, so a result is only shown for the fight it ran. */
  readonly ran: string | null;
}

export const FOE_GROUPS = 4;
/** A premade hero's id: one per class and level (tools/gen-heroes.ts, bundled by content/packs.ts). */
const HERO = /^test:hero-([a-z]+)-(\d+)$/;
export const heroId = (cls: string, level: number): string => `test:hero-${cls}-${level}`;
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const INITIAL_CHECK: CheckState = { fight: { party: ['fighter', 'cleric', 'rogue', 'wizard'].map((c) => heroId(c, 5)), foes: [{ use: 'srd:goblin-warrior', count: 4 }], surprised: false }, n: 1000, ran: null };
const SIZES = [200, 1000, 5000] as const;

const rateRow = (label: string, r: Rate, note = '') => (
  <tr key={label}>
    <td>{label}</td>
    <td className="num" title={`${fmt.int(r.x)} of ${fmt.int(r.n)} fights; 95% interval ${fmt.ci(r.lo, r.hi)}`}>
      {fmt.pct(r.p)}
    </td>
    <td className="muted">{note}</td>
  </tr>
);

export interface CheckProps {
  readonly catalog: Catalog;
  readonly set: ContentSet;
  readonly state: CheckState;
  readonly setState: Dispatch<SetStateAction<CheckState>>;
  readonly errors: readonly string[];
  /** The generated scenario's text, or null while the fight can't be built. */
  readonly text: string | null;
  readonly runs: Runs;
  readonly last: LastRun | null;
  readonly onReport: () => void;
  readonly onPractice: () => void;
}

export function CheckScreen({ catalog: cat, set, state, setState, errors, text, runs, last, onReport, onPractice }: CheckProps) {
  const blocks = useMemo(() => statBlocks(cat.content), [cat.content]);
  const fight = state.fight;
  const party = [...fight.party, ...Array.from({ length: Math.max(0, MAX_PARTY - fight.party.length) }, () => '')].slice(0, MAX_PARTY);
  const foes = [...fight.foes, ...Array.from({ length: Math.max(0, FOE_GROUPS - fight.foes.length) }, () => ({ use: '', count: 1 }))].slice(0, FOE_GROUPS);
  const setFight = (patch: Partial<Fight>) => setState((s) => ({ ...s, fight: { ...s.fight, ...patch } }));
  // The premade heroes on offer: their classes, and the levels each comes in.
  const heroes = useMemo(() => {
    const classes: string[] = [];
    const levels = new Set<number>();
    for (const c of cat.characters) {
      const m = HERO.exec(c.id);
      if (!m) continue;
      if (!classes.includes(m[1]!)) classes.push(m[1]!);
      levels.add(Number(m[2]));
    }
    return { classes, levels: [...levels].sort((a, b) => a - b) };
  }, [cat.characters]);
  const others = cat.characters.filter((c) => !HERO.test(c.id));
  // One level for every premade hero in the party: the first one's, or 5.
  const level = Number(fight.party.map((id) => HERO.exec(id)?.[2]).find((x) => x !== undefined) ?? 5);
  const setLevel = (l: number) => setFight({ party: fight.party.map((id) => { const m = HERO.exec(id); return m ? heroId(m[1]!, l) : id; }) });
  const slotValue = (id: string): string => { const m = HERO.exec(id); return m ? `hero:${m[1]}` : id; };
  const slotId = (v: string): string => (v.startsWith('hero:') ? heroId(v.slice(5), level) : v);
  const hasPc = fight.party.some((id) => id !== '' && cat.content?.get(id)?.kind === 'pc');
  const picked = fight.party.filter((x) => x !== '').length;

  const running = runs.state.k === 'running' && runs.state.req.scenario === CHECK_PATH;
  const go = () => {
    if (text === null) return;
    setState((s) => ({ ...s, ran: text }));
    runs.start(set, { scenario: CHECK_PATH, policies: ['greedy'], n: state.n, untilCi: 0.01, seed: 42 }, defaultWorkers(), cat);
  };
  const result = !running && last && last.f.req.scenario === CHECK_PATH && last.f.report.stats.arms[0] ? last : null;
  const fresh = result !== null && state.ran === text;
  const v = result ? verdictOf(result.f.report.stats.arms[0]!, hasPc) : null;

  return (
    <section className="check" aria-label="Encounter check">
      <h2>Encounter check</h2>
      <p className="note">Is this fight too strong? Pick the party and the foes. The app plays the fight many times with the AI running both sides and tells you how it tends to go.</p>
      {cat.contentErrors.length > 0 && <div className="banner">Content has errors: {cat.contentErrors.join('; ')}</div>}
      <div className="checkgrid">
        <fieldset className="encounter">
          <legend>The party ({picked} of {MAX_PARTY})</legend>
          {party.map((id, i) => (
            <div className="form" key={i}>
              <select value={slotValue(id)} aria-label={`Party member ${i + 1}`} disabled={running} onChange={(e) => setFight({ party: party.map((x, j) => (j === i ? slotId(e.target.value) : x)) })}>
                <option value="">{i === 0 ? 'pick a party member...' : 'empty'}</option>
                {heroes.classes.length > 0 && (
                  <optgroup label={`Premade heroes (level ${level})`}>
                    {heroes.classes.map((c) => (
                      <option key={c} value={`hero:${c}`}>
                        {title(c)}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Other characters">
                  {others.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.origin === 'home' ? 'PRIVATE · ' : ''}
                      {c.name} ({c.id})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Stat blocks (as allies)">
                  {blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          ))}
          {heroes.levels.length > 0 && (
            <div className="form">
              <label title="Every premade hero in the party is this level">
                Hero level{' '}
                <select value={level} disabled={running} onChange={(e) => setLevel(Number(e.target.value))}>
                  {heroes.levels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <label title="Surprise gives the party Disadvantage on initiative">
            <input type="checkbox" checked={fight.surprised} disabled={running} onChange={(e) => setFight({ surprised: e.target.checked })} /> The party is surprised
          </label>
        </fieldset>
        <fieldset className="encounter">
          <legend>The foes (up to {MAX_FOES})</legend>
          {foes.map((g, i) => (
            <div className="form" key={i}>
              <input type="number" className="short" min={1} max={MAX_FOES} value={g.count} disabled={running} aria-label={`Foe group ${i + 1} count`} onChange={(e) => setFight({ foes: foes.map((x, j) => (j === i ? { ...x, count: Math.min(MAX_FOES, Math.max(1, Math.round(Number(e.target.value) || 1))) } : x)) })} />
              <select value={g.use} aria-label={`Foe group ${i + 1}`} disabled={running} onChange={(e) => setFight({ foes: foes.map((x, j) => (j === i ? { ...x, use: e.target.value } : x)) })}>
                <option value="">{i === 0 ? 'pick a foe...' : 'nothing else'}</option>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </fieldset>
      </div>
      <div className="form">
        <label>
          Fights to play{' '}
          <select value={state.n} disabled={running} onChange={(e) => setState((s) => ({ ...s, n: Number(e.target.value) }))}>
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {fmt.int(n)}
                {n === 200 ? ' (quick look)' : n === 5000 ? ' (tighter numbers)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" onClick={go} disabled={running || text === null}>
          Check this fight
        </button>
        {running && (
          <button type="button" onClick={runs.cancel}>
            Cancel
          </button>
        )}
        {picked > 0 && errors.length > 0 && <span className="bad">{errors.join('; ')}</span>}
      </div>
      {running && runs.state.k === 'running' && (
        <div className="progress">
          <progress max={1} value={runs.state.p && runs.state.p.total > 0 ? runs.state.p.merged / runs.state.p.total : 0} /> {runs.state.p ? `${fmt.int(runs.state.p.merged)} of ${fmt.int(runs.state.p.total)} fights` : 'starting...'}
        </div>
      )}
      {runs.state.k === 'error' && <div className="banner">{runs.state.msg}</div>}
      {runs.state.k === 'cancelled' && <p className="muted">Cancelled.</p>}

      {v && result && (
        <div className={`strip verdict ${v.difficulty.toLowerCase()}`} role="status">
          {!fresh && <p className="bad">The fight has changed since this result. Check it again.</p>}
          <p className="big">
            {v.difficulty}: {v.why}.
          </p>
          <table>
            <tbody>
              {rateRow('The party wins', v.win)}
              {rateRow('The party loses', v.loss, hasPc ? 'every character down or dead' : 'every party member down or dead')}
              {v.stalemate.x > 0 && rateRow('No winner', v.stalemate, 'still going after 20 rounds, or nobody can hurt anybody')}
              {v.pcDrop && rateRow('Someone drops to 0 HP', v.pcDrop, 'at least one character, at any point')}
              {v.pcDied && rateRow('A character dies', v.pcDied)}
              {v.wiped && rateRow('Total party kill', v.wiped)}
              {v.allyDied.map((a) => rateRow(`${a.seat} dies`, a.rate, 'a stat block on the party side'))}
              <tr>
                <td>Length</td>
                <td className="num">{v.rounds.p50} rounds</td>
                <td className="muted">
                  usually {v.rounds.p10} to {v.rounds.p90}
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            <button type="button" onClick={onReport}>
              Open the full report
            </button>{' '}
            {hasPc && (
              <button type="button" onClick={onPractice}>
                Play this fight yourself
              </button>
            )}{' '}
            <span className="muted">
              {fmt.int(v.n)} fights in {(result.wallMs / 1000).toFixed(1)} s
            </span>
          </p>
          <details>
            <summary>How to read this</summary>
            <ul className="note">
              <li>
                The difficulty word is this tool's own reading, not the rulebook's encounter budget: Deadly under {fmt.pct(CUTS.deadlyWin)} wins; Dangerous under {fmt.pct(CUTS.dangerousWin)} wins or a death in {fmt.pct(CUTS.dangerousDied)} of fights; Hard under {fmt.pct(CUTS.hardWin)} wins or someone dropping in {fmt.pct(CUTS.hardDrop)};
                Moderate when someone drops in {fmt.pct(CUTS.moderateDrop)}; otherwise Easy.
              </li>
              <li>The AI plays every creature. It plays sensibly, not brilliantly, so a sharp table will do better than this and a careless one worse.</li>
              <li>Everyone starts fresh: full HP, every spell slot and feature. A party that's already been through two fights is weaker than this.</li>
              <li>The map is an open 12 by 12 room with the two sides about 25 ft apart. No walls, cover or terrain.</li>
              <li>The premade heroes are one typical build per class (standard array, sensible spells and gear), not optimized ones.</li>
              <li>Parts of some characters and monsters aren't modeled yet; the full report lists them.</li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
