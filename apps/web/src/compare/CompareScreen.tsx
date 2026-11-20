// The Compare screen (PLAN.md M6): two to four characters take the same seat in the same fight,
// each run on the same dice, and the screen says which does better and by how much. A variant
// here is a loaded character; two builds of one character are two character files.

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { fmt } from '@montecrit/engine';
import type { Catalog } from '../content/catalog.ts';
import type { ContentSet } from '../content/select.ts';
import { CHECK_PATH, QUICK_PATH } from '../practice/encounter.ts';
import { defaultWorkers } from '../run/web-transport.ts';
import { compileCheck, listCharacters, type Issue } from '../character/validate.ts';
import { signed } from '../odds/model.ts';
import { GREEDY, grouped } from './model.ts';
import { oddsCompare } from './odds.ts';
import { VariantEditor } from './VariantEditor.tsx';
import { MAX_VARIANTS, freeSlot, startText, variantId, variantPath, type Variant } from './variant.ts';
import type { Compares } from './useCompare.ts';

export interface CompareForm {
  readonly scenario: string | null;
  readonly seat: string | null;
  /** Up to four picks, the reference first: a character id, OWN for the fight's own character, or ''. */
  readonly picks: readonly string[];
  readonly n: number;
  /** The variants in use: copies of loaded characters with some choices changed, part of the content. */
  readonly variants: readonly Variant[];
  /** The variant being edited (not in the content until "Use this variant"). */
  readonly draft: Variant | null;
  /** The character the next variant is copied from ('' for the first on offer). */
  readonly from: string;
  /** The DC of the checks shown side by side. */
  readonly dc: number;
  /** The policy every build plays: 'greedy' for the AI's own play, or a loaded script. */
  readonly policy: string;
}

export const OWN = '(own)';
export const SLOTS = 4;
export const INITIAL_COMPARE: CompareForm = { scenario: null, seat: null, picks: [OWN, ''], n: 2000, variants: [], draft: null, from: '', dc: 15, policy: 'greedy' };
const SIZES = [500, 2000, 5000] as const;
const fightName = (path: string, id: string | null, origin: string): string => (path === QUICK_PATH ? "Practice's quick encounter" : path === CHECK_PATH ? "The Encounter tab's fight" : `${origin === 'home' ? 'PRIVATE · ' : ''}${id ?? path}`);

export interface CompareProps {
  readonly catalog: Catalog;
  readonly set: ContentSet;
  readonly form: CompareForm;
  readonly setForm: Dispatch<SetStateAction<CompareForm>>;
  readonly compares: Compares;
}

export function CompareScreen({ catalog: cat, set, form, setForm, compares }: CompareProps) {
  const runnable = cat.scenarios.filter((s) => s.scenarioHash !== null && s.pcSeats.length > 0);
  const entry = runnable.find((s) => s.path === form.scenario) ?? runnable.find((s) => s.origin === 'home') ?? runnable[0] ?? null;
  const seat = entry?.pcSeats.find((p) => p.seat === form.seat)?.seat ?? entry?.pcSeats[0]?.seat ?? null;
  const mine = new Set(form.variants.map((v) => variantId(v.base, v.n)));
  const { heroes, others } = grouped(cat.characters.filter((c) => !mine.has(c.id)));
  const made = cat.characters.filter((c) => mine.has(c.id));
  const heroIds = new Set(heroes.map((c) => c.id));
  // What a variant can copy: every character file (a hand-filled kind: pc has no build choices).
  const files = useMemo(() => listCharacters(set.packs).filter((c) => c.kind === 'character' && !c.path.includes('__compare-variant-')), [set]);
  const from = files.find((c) => c.id === form.from) ?? files.find((c) => c.origin === 'home') ?? files[0] ?? null;
  const slot = freeSlot(form.variants);
  const [refused, setRefused] = useState<readonly Issue[]>([]);
  const draft = form.draft;
  const draftBase = draft ? (files.find((c) => c.id === draft.base) ?? null) : null;
  const startVariant = () => {
    if (from === null || slot === null) return;
    const text = startText(from.text, from.id, from.name, slot);
    if (text === null) return;
    setRefused([]);
    setForm((f) => ({ ...f, draft: { n: slot, base: from.id, basePath: from.path, text } }));
  };
  const useDraft = () => {
    if (draft === null) return;
    const id = variantId(draft.base, draft.n);
    // The whole content with the variant in it: what only compiling finds. A text that doesn't compile never goes in.
    const r = compileCheck(draft.text, id, set.packs, variantPath(draft.basePath, draft.n), []);
    const bad = r.issues.filter((i) => i.severity === 'error');
    if (bad.length > 0 || r.sheet === null) {
      setRefused(bad.length > 0 ? bad : [{ severity: 'error', path: 'id', line: 0, message: `the text must keep the id ${id}` }]);
      return;
    }
    setForm((f) => {
      const ps = [...f.picks, ...Array.from({ length: SLOTS }, () => '')].slice(0, SLOTS);
      const at = ps.includes(id) ? -1 : ps.findIndex((p, i) => i > 0 && p === '');
      // The reference defaults to the character it was copied from when the picks are still untouched.
      const next = ps.map((p, i) => (i === at ? id : p));
      return { ...f, draft: null, variants: [...f.variants.filter((v) => v.n !== draft.n), draft], picks: next };
    });
  };
  const picks = [...form.picks, ...Array.from({ length: SLOTS }, () => '')].slice(0, SLOTS);
  const nameOf = (id: string): string => (id === OWN ? "the fight's own character" : (cat.characters.find((c) => c.id === id)?.name ?? id));
  const chosen = picks.filter((p) => p !== '' && (p === OWN || cat.characters.some((c) => c.id === p)));
  const problem = entry === null || seat === null ? 'no fight with a character seat is loaded' : chosen.length < 2 ? 'pick at least two to compare' : new Set(chosen).size !== chosen.length ? 'the same character is picked twice' : null;
  // Checks side by side: the chosen builds that have a derived sheet (a hand-filled kind: pc has none).
  const own = entry?.pcSeats.find((p) => p.seat === seat)?.use ?? '';
  const sheetOf = (id: string) => cat.sheets.find((x) => x.id === (id === OWN ? own : id)) ?? null;
  const sheeted = chosen.map((id) => ({ id, name: nameOf(id), sheet: sheetOf(id) })).filter((x): x is { id: string; name: string; sheet: NonNullable<ReturnType<typeof sheetOf>> } => x.sheet !== null);
  const odds = useMemo(() => oddsCompare(sheeted.map((x) => x.sheet), form.dc), [cat.sheets, chosen.join('|'), own, form.dc]);
  // How the builds are played: the AI's own choices, or one loaded policy that fixes the tactics for all of them.
  const scripts = cat.policies.filter((p) => p.id !== 'greedy' && p.id !== 'baseline' && p.id !== 'random-legal');
  const policy = scripts.find((p) => p.id === form.policy) ?? null;
  const state = compares.state;
  const running = state.k === 'running';
  const go = () => {
    if (problem !== null || entry === null || seat === null) return;
    compares.start(set, { scenario: entry.path, seat, variants: chosen.map((id) => ({ id: id === OWN ? '' : id, name: nameOf(id) })), n: form.n, seed: 42, played: policy ? { id: policy.id, name: policy.name, scripted: policy.rules.length > 0 } : GREEDY, rules: policy?.rules ?? [] }, defaultWorkers(), cat);
  };
  const res = state.k === 'done' ? state.result : null;

  return (
    <section className="compare" aria-label="Compare builds">
      <h2>Compare builds</h2>
      <p className="note">Which build does better? Put two to four characters in the same seat of the same fight. Each one plays the fight on the same dice, so the difference you see is the build, not luck.</p>
      <div className="form">
        <label>
          Fight{' '}
          <select value={entry?.path ?? ''} disabled={running} onChange={(e) => setForm((f) => ({ ...f, scenario: e.target.value, seat: null }))}>
            {runnable.length === 0 && <option value="">no fight loaded</option>}
            {runnable.map((s) => (
              <option key={s.path} value={s.path}>
                {fightName(s.path, s.id, s.origin)}
              </option>
            ))}
          </select>
        </label>
        {entry && entry.pcSeats.length > 1 && (
          <label>
            Seat{' '}
            <select value={seat ?? ''} disabled={running} onChange={(e) => setForm((f) => ({ ...f, seat: e.target.value }))}>
              {entry.pcSeats.map((p) => (
                <option key={p.seat} value={p.seat}>
                  {p.seat}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <fieldset className="encounter">
        <legend>The builds (the first is the reference)</legend>
        {picks.map((id, i) => (
          <div className="form" key={i}>
            <span className="muted">{i === 0 ? 'Reference' : `Variant ${i}`}</span>
            <select value={id} aria-label={i === 0 ? 'Reference build' : `Variant ${i}`} disabled={running} onChange={(e) => setForm((f) => ({ ...f, picks: picks.map((x, j) => (j === i ? e.target.value : x)) }))}>
              <option value="">{i < 2 ? 'pick a character...' : 'none'}</option>
              <option value={OWN}>The fight's own character</option>
              {made.length > 0 && (
                <optgroup label="Your variants">
                  {made.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.origin === 'home' ? 'PRIVATE · ' : ''}
                      {c.name}
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
              {heroes.length > 0 && (
                <optgroup label="Premade heroes">
                  {heroes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        ))}
      </fieldset>
      <fieldset className="encounter">
        <legend>Variants: change one choice and see what it does</legend>
        <p className="note">A variant is a copy of a character with a few build choices changed. It lives in this page only: nothing is written to disk, and a reload drops it.</p>
        {form.variants.map((v) => {
          const c = cat.characters.find((x) => x.id === variantId(v.base, v.n));
          return (
            <div className="form" key={v.n}>
              <span>
                {c?.origin === 'home' ? 'PRIVATE · ' : ''}
                {c?.name ?? variantId(v.base, v.n)} <span className="muted">(a copy of {nameOf(v.base)})</span>
              </span>
              <button
                type="button"
                disabled={running || draft !== null}
                onClick={() => {
                  setRefused([]);
                  setForm((f) => ({ ...f, draft: v }));
                }}
              >
                Edit
              </button>
              <button type="button" disabled={running || draft?.n === v.n} onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((x) => x.n !== v.n) }))}>
                Remove
              </button>
            </div>
          );
        })}
        {draft === null && (
          <div className="form">
            <label>
              Copy{' '}
              <select value={from?.id ?? ''} disabled={running || slot === null} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}>
                {files.length === 0 && <option value="">no character file loaded</option>}
                {files
                  .filter((c) => !heroIds.has(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.origin === 'home' ? 'PRIVATE · ' : ''}
                      {c.name}
                    </option>
                  ))}
                <optgroup label="Premade heroes">
                  {heroes
                    .filter((c) => files.some((f) => f.id === c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <button type="button" onClick={startVariant} disabled={running || from === null || slot === null}>
              Make a variant
            </button>
            {slot === null && <span className="muted">{MAX_VARIANTS} variants at most: remove one first</span>}
          </div>
        )}
        {draft !== null && (
          <VariantEditor
            packs={set.packs}
            draft={draft}
            baseName={draftBase?.name ?? draft.base}
            baseText={draftBase?.text ?? ''}
            refused={refused}
            onChange={(text) => {
              setRefused([]);
              setForm((f) => (f.draft ? { ...f, draft: { ...f.draft, text } } : f));
            }}
            onUse={useDraft}
            onCancel={() => setForm((f) => ({ ...f, draft: null }))}
          />
        )}
      </fieldset>
      <div className="form">
        <label>
          Played by{' '}
          <select value={policy?.id ?? 'greedy'} disabled={running} onChange={(e) => setForm((f) => ({ ...f, policy: e.target.value }))}>
            <option value="greedy">The AI's own best play (realistic)</option>
            {scripts.length > 0 && (
              <optgroup label="A fixed script (isolates the build)">
                {scripts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.origin === 'home' ? 'PRIVATE · ' : ''}
                    {p.name} ({p.id})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <span className="muted">
          {policy === null
            ? 'Each build plays what the AI thinks is best for it, so a build can win by playing differently.'
            : policy.rules.length > 0
              ? 'Every build follows the same script, so the difference is the build and not the tactics. A build that lacks what the script names is refused.'
              : 'Every build plays under the same policy settings.'}
        </span>
      </div>
      <div className="form">
        <label>
          Fights each{' '}
          <select value={form.n} disabled={running} onChange={(e) => setForm((f) => ({ ...f, n: Number(e.target.value) }))}>
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {fmt.int(n)}
                {n === 500 ? ' (quick look)' : n === 5000 ? ' (to see small differences)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={go} disabled={running || problem !== null}>
          Compare
        </button>
        {running && (
          <button type="button" onClick={compares.cancel}>
            Cancel
          </button>
        )}
        {problem !== null && <span className="muted">{problem}</span>}
      </div>
      {state.k === 'running' && (
        <div className="progress">
          <progress max={1} value={(state.at + (state.total > 0 ? state.merged / state.total : 0)) / state.of} /> build {state.at + 1} of {state.of}: {fmt.int(state.merged)} of {fmt.int(state.total)} fights
        </div>
      )}
      {state.k === 'error' && <div className="banner">{state.msg}</div>}
      {state.k === 'cancelled' && <p className="muted">Cancelled.</p>}

      {chosen.length >= 2 && (
        <fieldset className="encounter">
          <legend>Checks side by side</legend>
          {sheeted.length < 2 ? (
            <p className="note">Needs two builds made from character files (a hand-filled sheet has no derived skills to compare).</p>
          ) : (
            <>
              <div className="form">
                <label>
                  DC{' '}
                  <input type="number" min={1} max={30} value={form.dc} onChange={(e) => setForm((f) => ({ ...f, dc: Math.min(30, Math.max(1, Math.round(Number(e.target.value)) || 15)) }))} />
                </label>
                <span className="muted">
                  {odds.lines.length === 0 ? `Every skill check, save and ability check is the same for these builds (${odds.same}).` : `${odds.lines.length} differ; the other ${odds.same} are the same for every build. Exact chances, no dice rolled.`}
                </span>
              </div>
              {odds.lines.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Check</th>
                      {sheeted.map((x) => (
                        <th key={x.id} className="num">
                          {x.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {odds.lines.map((l) => (
                      <tr key={l.key}>
                        <td>{l.label}</td>
                        {l.ps.map((p, i) => (
                          <td key={i} className="num">
                            {fmt.pct(p)} <span className="muted">({signed(l.mods[i]!)})</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {sheeted.length < chosen.length && <p className="note">Left out: {chosen.filter((id) => !sheeted.some((x) => x.id === id)).map(nameOf).join(', ')} (a hand-filled sheet).</p>}
            </>
          )}
        </fieldset>
      )}
      {res && (
        <div className="strip verdict" role="status">
          <p className="big">{res.headline}</p>
          <table>
            <thead>
              <tr>
                <th>Build</th>
                <th className="num">Wins</th>
                <th>Against the reference</th>
                <th className="num">Someone drops</th>
                <th className="num">A character dies</th>
                <th className="num">Damage per round</th>
                <th className="num">Rounds</th>
                {res.played.scripted && <th>Script played</th>}
              </tr>
            </thead>
            <tbody>
              {res.variants.map((v, i) => {
                const p = res.pairs.find((x) => x.other === i);
                return (
                  <tr key={v.id}>
                    <td>
                      {v.name}
                      {i === 0 ? ' (reference)' : ''}
                    </td>
                    <td className="num" title={`${fmt.int(v.stats.win.x)} of ${fmt.int(v.stats.win.n)}; 95% interval ${fmt.ci(v.stats.win.lo, v.stats.win.hi)}`}>
                      {fmt.pct(v.stats.win.p)}
                    </td>
                    <td title={p ? `Same dice, fight by fight: both win ${fmt.int(p.both)}, only this one ${fmt.int(p.onlyOther)}, only the reference ${fmt.int(p.onlyRef)}, neither ${fmt.int(p.neither)}; p = ${fmt.pval(p.p)}` : undefined}>
                      {p ? (
                        <>
                          <strong>
                            {p.diff >= 0 ? '+' : '-'}
                            {Math.abs(p.diff * 100).toFixed(1)} points
                          </strong>{' '}
                          <span className="muted">
                            ({(p.lo * 100).toFixed(1)} to {(p.hi * 100).toFixed(1)}){p.clear ? '' : ', not clear'}
                          </span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="num">{fmt.pct(v.stats.pcDrop.p)}</td>
                    <td className="num">{fmt.pct(v.stats.pcDied.p)}</td>
                    <td className="num" title={`95% interval ${fmt.ci(v.stats.dprPc.lo, v.stats.dprPc.hi, 1, 2)}`}>
                      {fmt.fx(v.stats.dprPc.value, 1)}
                    </td>
                    <td className="num">{fmt.fx(v.stats.rounds.mean, 1)}</td>
                    {res.played.scripted && <td title="The share of this build's fights each scripted rule was actually played in. A low number means the script mostly didn't happen, and the AI played instead.">{(v.rules ?? []).map((r) => `${r.rule} ${fmt.pct(r.taken)}`).join(', ')}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            {res.played.id === 'greedy' ? "Played by the AI's own best play." : `Played by "${res.played.name}".`} {fmt.int(res.n)} fights each on the same dice, {(res.variants.reduce((s, v) => s + v.wallMs, 0) / 1000).toFixed(1)} s. Hover a number for its interval.
          </p>
          <details>
            <summary>How to read this</summary>
            <ul className="note">
              <li>"Against the reference" is the change in win rate, with the range the true difference very likely sits in. "Not clear" means that range includes zero: run more fights, or the builds really are close.</li>
              <li>Damage per round is the player characters' damage, so it also moves when a build keeps the character standing longer.</li>
              <li>A variant differs from its original only in what you changed, so a clear difference is that choice at work in this fight.</li>
              {res.played.scripted ? (
                <li>Every build followed the same script, and the AI played the rest. "Script played" is how often each scripted step really happened: if it's low for a build, that build mostly played the AI's way and the comparison isn't the script's.</li>
              ) : (
                <li>The AI plays every build the same sensible way. A build that needs clever play to shine is undersold here. To hold the tactics fixed instead, pick a script under "Played by".</li>
              )}
              <li>This is one fight. A build that wins here can lose elsewhere: try a couple of different fights before deciding.</li>
              <li>Features the engine doesn't model yet count for nothing; the Character tab lists them per character.</li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
