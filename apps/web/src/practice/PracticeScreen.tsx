// The Practice screen (PLAN.md M5, UI screen 4): you play one seat turn by turn on the battle
// map and the AI plays everyone else. Moves and placements are clicks on the map; attacks,
// spells and features are buttons built from the engine's legal list, so there's no illegal
// move to make. Undo steps back one choice (the dice stay the same: a new fight rolls new ones).
// The quick encounter builds a fight from a few picks instead of a scenario file.

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { cellName, resolveScenario, type DecisionKind, type FightSetup } from '@montecrit/engine';
import { scenarioInput, seatPcs } from '@montecrit/host';
import type { Catalog } from '../content/catalog.ts';
import { extendable, type ContentSet } from '../content/select.ts';
import { MapSvg } from '../replay/MapSvg.tsx';
import { condMarkers } from '../replay/controller.ts';
import { CHECK_PATH, MAX_FOES, QUICK_PATH, statBlocks, type Encounter } from './encounter.ts';
import type { Status } from './describe.ts';
import { ROLL_WINDOWS, askHelp, askTitle, cellChoices, endTurn, sections, step, type Answer, type AskItem } from './play.ts';

export interface PracticeState {
  readonly scenario: string | null;
  /** A loaded character to play in place of the scenario's own PC; '' keeps the scenario's. */
  readonly pc: string;
  readonly seat: string | null;
  readonly seed: number;
  readonly answers: readonly Answer[];
  /** The fight those answers belong to; a different fight (another scenario, character, encounter or dice) starts with none. */
  readonly fight: string;
  /** Ask about reactions to other creatures' rolls (off: the AI answers those). */
  readonly askRolls: boolean;
  readonly hints: boolean;
}

export const INITIAL_PRACTICE: PracticeState = { scenario: null, pc: '', seat: null, seed: 1, answers: [], fight: '', askRolls: false, hints: true };
export const INITIAL_ENCOUNTER: Encounter = { pc: '', ally: '', foes: [{ use: 'srd:goblin-warrior', count: 3 }], surprised: false };

const NO_ANSWERS: readonly Answer[] = [];
const OUTCOMES: Readonly<Record<string, string>> = { win: 'You won', loss: 'You lost', stalemate: 'Stalemate' };

interface Built {
  readonly setup: FightSetup | null;
  readonly errors: readonly string[];
}

function buildSetup(set: ContentSet, cat: Catalog, path: string, seat: string, pc: string): Built {
  if (!cat.content) return { setup: null, errors: ['content has errors'] };
  const input = scenarioInput(extendable(set), path, 'repo/scenarios');
  if (input.errors.length) return { setup: null, errors: input.errors.map((d) => d.message) };
  let doc: unknown = input.input;
  if (pc !== '') {
    const seated = seatPcs(doc, path, [{ seat, id: pc, label: pc, file: null, pack: null }], cat.content, cat.sheets);
    if ('error' in seated) return { setup: null, errors: [seated.error] };
    doc = seated.input;
  }
  const res = resolveScenario(doc, path, cat.content);
  return res.setup ? { setup: res.setup, errors: [] } : { setup: null, errors: res.errors.map((d) => d.message) };
}

/** What you have left: the turn's budget, hit points, spell slots and pools. */
function StatusStrip({ st, turn }: { st: Status; turn: boolean }) {
  const chip = (label: string, on: boolean) => (
    <span className={on ? 'chip on' : 'chip off'} key={label} title={on ? 'available' : 'spent'}>
      {label}
    </span>
  );
  return (
    <div className="statusstrip" aria-label="What you have left">
      {turn && chip('Action', st.action > 0)}
      {turn && chip('Bonus action', st.bonus > 0)}
      {chip('Reaction', st.reaction > 0)}
      <span className="chip on">
        HP {st.hp}/{st.hpMax}
        {st.tempHp > 0 ? ` +${st.tempHp} temp` : ''}
      </span>
      {st.slots.length > 0 && <span className="chip on">Slots {st.slots.map((x) => `L${x.lvl} ${x.left}/${x.max}`).join(' · ')}</span>}
      {st.pools.map((p) => (
        <span className="chip on" key={p.name}>
          {p.name} {p.left}/{p.max}
        </span>
      ))}
      {st.conc !== '' && <span className="chip on">Concentrating: {st.conc}</span>}
    </div>
  );
}

function EncounterPanel({ cat, enc, setEnc, errors, text }: { cat: Catalog; enc: Encounter; setEnc: Dispatch<SetStateAction<Encounter>>; errors: readonly string[]; text: string | null }) {
  const blocks = useMemo(() => statBlocks(cat.content), [cat.content]);
  const foes = [...enc.foes, ...Array.from({ length: Math.max(0, 3 - enc.foes.length) }, () => ({ use: '', count: 1 }))].slice(0, 3);
  const setFoe = (i: number, patch: Partial<Encounter['foes'][number]>) => setEnc((e) => ({ ...e, foes: foes.map((g, j) => (j === i ? { ...g, ...patch } : g)) }));
  const download = () => {
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quick-encounter.yaml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <fieldset className="encounter">
      <legend>Quick encounter</legend>
      <div className="form">
        <label>
          You play{' '}
          <select value={enc.pc} onChange={(e) => setEnc((x) => ({ ...x, pc: e.target.value }))}>
            <option value="">pick a character...</option>
            {cat.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.origin === 'home' ? 'PRIVATE · ' : ''}
                {c.name} ({c.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Ally{' '}
          <select value={enc.ally} onChange={(e) => setEnc((x) => ({ ...x, ally: e.target.value }))}>
            <option value="">none</option>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label title="Surprise gives the party Disadvantage on initiative">
          <input type="checkbox" checked={enc.surprised} onChange={(e) => setEnc((x) => ({ ...x, surprised: e.target.checked }))} /> The party is surprised
        </label>
      </div>
      {foes.map((g, i) => (
        <div className="form" key={i}>
          <label>
            {i === 0 ? 'Against' : 'and'}{' '}
            <input type="number" className="short" min={1} max={MAX_FOES} value={g.count} aria-label={`Foe group ${i + 1} count`} onChange={(e) => setFoe(i, { count: Math.min(MAX_FOES, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
          </label>
          <select value={g.use} aria-label={`Foe group ${i + 1}`} onChange={(e) => setFoe(i, { use: e.target.value })}>
            <option value="">{i === 0 ? 'pick a foe...' : 'nothing else'}</option>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      {enc.pc !== '' && errors.length > 0 && <p className="bad">{errors.join('; ')}</p>}
      {text !== null && (
        <p className="note">
          Ready: it's in the scenario list here and on the Run tab as "{QUICK_PATH}".{' '}
          <button type="button" onClick={download}>
            Download as a scenario file
          </button>
        </p>
      )}
    </fieldset>
  );
}

export interface PracticeProps {
  readonly catalog: Catalog;
  readonly set: ContentSet;
  readonly state: PracticeState;
  readonly setState: Dispatch<SetStateAction<PracticeState>>;
  readonly enc: Encounter;
  readonly setEnc: Dispatch<SetStateAction<Encounter>>;
  readonly encErrors: readonly string[];
  readonly encText: string | null;
}

export function PracticeScreen({ catalog: cat, set, state, setState, enc, setEnc, encErrors, encText }: PracticeProps) {
  const runnable = cat.scenarios.filter((s) => s.errors.length === 0 && s.pcSeats.length > 0);
  const path = runnable.find((s) => s.path === state.scenario)?.path ?? (runnable.find((s) => s.path === QUICK_PATH) ?? runnable.find((s) => s.origin === 'home') ?? runnable[0])?.path ?? null;
  const entry = runnable.find((s) => s.path === path) ?? null;
  const seat = entry?.pcSeats.find((p) => p.seat === state.seat)?.seat ?? entry?.pcSeats[0]?.seat ?? null;
  const built = useMemo(() => (path !== null && seat !== null ? buildSetup(set, cat, path, seat, state.pc) : { setup: null, errors: [] }), [set, cat, path, seat, state.pc]);
  const setup = built.setup;
  const seatIdx = setup ? setup.seats.findIndex((s) => s.seat === seat) : -1;
  const auto: readonly DecisionKind[] = state.askRolls ? [] : ROLL_WINDOWS;
  const key = `${path}|${seat}|${state.pc}|${state.seed}|${state.askRolls}|${setup?.scenarioHash ?? ''}`;
  const answers = state.fight === key ? state.answers : NO_ANSWERS;
  const now = useMemo(() => (setup && seatIdx >= 0 ? step(setup, { seed: state.seed, seat: seatIdx, auto }, answers) : null), [setup, seatIdx, state.seed, answers, state.askRolls]);

  // Playback: after a choice, the events it caused play out before the next prompt shows.
  const last = now ? now.view.frames.length - 1 : 0;
  const [cursor, setCursor] = useState(last);
  const seenKey = useRef('');
  const seenLast = useRef(0);
  useEffect(() => {
    if (!now) return;
    // A new fight, or an undo, jumps; a choice plays forward from where the map was.
    const from = seenKey.current === key && seenLast.current <= last ? seenLast.current : last;
    seenKey.current = key;
    seenLast.current = last;
    setCursor(from);
  }, [now, key, last]);
  useEffect(() => {
    if (!now || cursor >= last) return;
    const delay = Math.max(12, Math.min(110, Math.round(2500 / Math.max(1, last - cursor))));
    const t = window.setTimeout(() => setCursor((c) => Math.min(last, c + 1)), delay);
    return () => window.clearTimeout(t);
  }, [now, cursor, last]);
  const playing = cursor < last;

  const zoneStyle = useMemo(() => {
    const m = new Map<number, number>();
    const names = new Map<number, string>();
    for (const e of now?.events ?? []) {
      if (e.k === 'zone' && !m.has(e.fx)) m.set(e.fx, m.size);
      if (e.k === 'fxStart') names.set(e.fx, e.name);
    }
    return { m, names };
  }, [now]);

  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [cursor, now]);

  const restart = (patch: Partial<PracticeState>) => setState((s) => ({ ...s, ...patch, answers: [] }));
  const ask = now && !playing ? now.ask : null;
  const choose = (it: AskItem) => {
    if (!ask) return;
    setState((s) => ({ ...s, fight: key, answers: [...answers, { at: ask.at, key: it.key }] }));
  };
  const cells = ask && setup ? cellChoices(ask, setup.w) : [];
  const suggest = ask && ask.suggest >= 0 ? ask.items[ask.suggest]! : null;
  // An area being placed: the squares it would cover from the square under the pointer, or from the AI's pick until one is.
  const [hover, setHover] = useState<number | null>(null);
  const shown = ask ? (ask.items.find((it) => it.area && it.cell === hover) ?? (suggest?.area ? suggest : (ask.items.find((it) => it.area) ?? null))) : null;
  const targets = new Map<number, AskItem>();
  if (ask && ask.kind === 'target') for (const it of ask.items) if (it.target >= 0) targets.set(it.target, it);
  const frame = now ? now.view.frames[Math.min(cursor, last)]! : null;
  const seatName = (u: number): string => setup?.seats[u]?.seat ?? '?';
  const cell = setup ? Math.max(28, Math.min(46, Math.floor(600 / setup.w))) : 40;

  return (
    <section className="practice" aria-label="Practice">
      <h2>Practice</h2>
      <p className="note">Play one character turn by turn; the AI plays everyone else. Click a highlighted square to move there, or use the buttons to attack, cast and end your turn.</p>
      <div className="form">
        <label>
          Fight{' '}
          <select value={path ?? ''} onChange={(e) => restart({ scenario: e.target.value, seat: null, pc: '' })}>
            {runnable.length === 0 && <option value="">no scenario loaded</option>}
            {runnable.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path === QUICK_PATH ? 'Quick encounter (below)' : s.path === CHECK_PATH ? 'The Encounter tab\'s fight' : `${s.origin === 'home' ? 'PRIVATE · ' : ''}${s.id ?? s.path}`}
              </option>
            ))}
          </select>
        </label>
        {entry && entry.pcSeats.length > 1 && (
          <label>
            Your seat{' '}
            <select value={seat ?? ''} onChange={(e) => restart({ seat: e.target.value })}>
              {entry.pcSeats.map((p) => (
                <option key={p.seat} value={p.seat}>
                  {p.seat}
                </option>
              ))}
            </select>
          </label>
        )}
        {path !== QUICK_PATH && (
          <label>
            Play as{' '}
            <select value={state.pc} onChange={(e) => restart({ pc: e.target.value })}>
              <option value="">the scenario's own character</option>
              {cat.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.origin === 'home' ? 'PRIVATE · ' : ''}
                  {c.name} ({c.id})
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" onClick={() => restart({ seed: state.seed + 1 })} title="A new fight with new dice">
          New fight
        </button>
        <button type="button" onClick={() => restart({})} disabled={answers.length === 0} title="The same fight and dice, from the top">
          Restart
        </button>
        <span className="muted">dice #{state.seed}</span>
      </div>
      <div className="form">
        <label title="Off: the AI answers the reaction windows that open at other creatures' rolls. On: you're asked every time, which is a lot of prompts.">
          <input type="checkbox" checked={state.askRolls} onChange={(e) => setState((s) => ({ ...s, askRolls: e.target.checked, answers: [] }))} /> Ask me about reactions to every roll
        </label>
        <label>
          <input type="checkbox" checked={state.hints} onChange={(e) => setState((s) => ({ ...s, hints: e.target.checked }))} /> Show what the AI would do
        </label>
      </div>
      <details open={path === QUICK_PATH || runnable.length === 0}>
        <summary>Build a quick encounter (no scenario file needed)</summary>
        <EncounterPanel cat={cat} enc={enc} setEnc={setEnc} errors={encErrors} text={encText} />
      </details>
      {built.errors.length > 0 && <div className="banner">This fight can't start: {built.errors.join('; ')}</div>}
      {now?.error && <div className="banner">The fight stopped: {now.error}</div>}

      {setup && now && frame && (
        <div className="practicegrid">
          <div>
            <MapSvg
              setup={setup}
              frame={frame}
              zoneStyle={zoneStyle.m}
              fxName={zoneStyle.names}
              cell={cell}
              cells={cells.map((c) => ({ ...c, hint: state.hints && suggest !== null && suggest.cell === c.cell }))}
              onCell={(c) => {
                const pick = cells.find((x) => x.cell === c);
                const it = pick && ask?.items[pick.i];
                if (it) choose(it);
              }}
              onCellHover={setHover}
              {...(shown?.area ? { preview: shown.area } : {})}
              pickable={new Set(targets.keys())}
              onToken={(u) => {
                const it = targets.get(u);
                if (it) choose(it);
              }}
            />
            <table className="side">
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Name</th>
                  <th className="num">HP</th>
                  <th>State</th>
                  <th>Conditions</th>
                </tr>
              </thead>
              <tbody>
                {frame.units.map((u, i) => (
                  <tr key={u.seat} className={i === frame.turnOf ? 'activerow' : undefined}>
                    <td className="mono" style={{ color: `var(--team${u.team})` }}>
                      {u.seat}
                      {i === seatIdx ? ' (you)' : ''}
                    </td>
                    <td>{u.name}</td>
                    <td className="num">
                      {u.hp}/{u.hpMax}
                    </td>
                    <td>{u.life}</td>
                    <td>
                      {condMarkers(u.conds, u.conc, u.conc >= 0 ? zoneStyle.names.get(u.conc) : undefined)
                        .map((m) => m.name)
                        .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="strip turnpanel" role="status" aria-live="polite">
              {playing && (
                <p>
                  Round {frame.round}: playing out what happened...{' '}
                  <button type="button" onClick={() => setCursor(last)}>
                    Skip
                  </button>
                </p>
              )}
              {!playing && now.outcome && (
                <p className="big">
                  {OUTCOMES[now.outcome.k] ?? now.outcome.k} in round {now.outcome.round}.{' '}
                  <button type="button" onClick={() => restart({ seed: state.seed + 1 })}>
                    Play again
                  </button>
                </p>
              )}
              {ask && (
                <>
                  <h3>
                    Round {ask.round} · {askTitle(ask)}
                  </h3>
                  {askHelp(ask) !== '' && <p className="note">{askHelp(ask)}</p>}
                  <StatusStrip st={ask.status} turn={ask.kind === 'turn'} />
                  {state.hints && suggest && (
                    <div className="hintcard">
                      <div>
                        <span className="muted">The AI would </span>
                        <strong>{suggest.cell >= 0 ? `${suggest.k === 'move' ? 'move to' : 'pick'} ${suggest.label}` : suggest.label}</strong>
                        {suggest.detail !== '' && <div className="optdetail">{suggest.detail}</div>}
                      </div>
                      <button type="button" onClick={() => choose(suggest)}>
                        Do that
                      </button>
                    </div>
                  )}
                  {cells.length > 0 && (
                    <div className="optsec">
                      <h4>{ask.kind === 'turn' ? `Move · ${ask.status.moveFt} ft left` : 'On the map'}</h4>
                      <p className="optdetail">
                        Click one of the {cells.length} highlighted squares{ask.kind === 'turn' ? ' to walk there' : ''}.{cells.some((c) => c.risky) ? ' Orange squares provoke an Opportunity Attack or cross a hazard.' : ''}
                      </p>
                      {shown?.area && (
                        <p className="optdetail" role="status">
                          The shaded squares are the area for <strong>{ask.aim ? shown.label.toLowerCase() : cellName(shown.cell, setup!.w)}</strong>
                          {shown.cell !== hover ? ' (the suggested spot; point at another square to see it)' : ''}: it catches {shown.caught && shown.caught.length > 0 ? shown.caught.map((s) => (s === ask.seat ? `${s} (you)` : s)).join(', ') : 'no one'}.
                        </p>
                      )}
                    </div>
                  )}
                  {sections(ask, seatName).map((sec) => (
                    <div className="optsec" key={sec.title}>
                      <h4>{sec.title}</h4>
                      {sec.rows.map((row) => {
                        const hinted = state.hints && row.variants.some((v) => v.it.i === ask.suggest);
                        const single = row.variants.length === 1 && row.variants[0]!.tag === '';
                        return (
                          <div className={hinted ? 'opt hinted' : 'opt'} key={`${row.name}|${row.variants[0]!.it.i}`}>
                            <div className="optmain">
                              {single ? (
                                <button type="button" onClick={() => choose(row.variants[0]!.it)}>
                                  {row.name}
                                </button>
                              ) : (
                                <>
                                  <strong>{row.name}</strong>
                                  {row.variants.map((v) => (
                                    <button key={v.it.i} type="button" className={state.hints && v.it.i === ask.suggest ? 'suggested' : undefined} title={v.it.detail} onClick={() => choose(v.it)}>
                                      {v.tag}
                                    </button>
                                  ))}
                                </>
                              )}
                            </div>
                            {row.detail !== '' && <div className="optdetail">{row.detail}</div>}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {endTurn(ask) && (
                    <p>
                      <button type="button" className={state.hints && endTurn(ask)!.i === ask.suggest ? 'endturn suggested' : 'endturn'} onClick={() => choose(endTurn(ask)!)}>
                        End turn
                      </button>
                    </p>
                  )}
                </>
              )}
              <p>
                <button type="button" onClick={() => setState((s) => ({ ...s, fight: key, answers: answers.slice(0, -1) }))} disabled={answers.length === 0 || playing} title="Take back your last choice. The dice stay the same.">
                  Undo
                </button>{' '}
                <span className="muted">{answers.length} choice{answers.length === 1 ? '' : 's'} so far</span>
              </p>
            </div>
            <div className="log mono practicelog" ref={log}>
              {now.lines.slice(0, Math.max(0, cursor - 1)).map((l, j) => (
                <div key={j} className="logline">
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
