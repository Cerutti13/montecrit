// The Odds screen (PLAN.md M4, UI screen 3): pick a character, set a DC, and read the exact
// chance of every skill check, save and ability check at once. Help is Advantage, Guidance adds
// its d4 to skill checks, and a group check passes when at least half the members do. No dice
// are rolled here: every number is exact, from the same RollSpec the simulator samples.

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { AdvState, DerivedSheet } from '@montecrit/engine';
import type { CharacterEntry } from '../content/catalog.ts';
import { DEFAULT_OPTIONS, TYPICAL_DCS, chance, customRow, groupOdds, inTwenty, ladder, parseDice, passive, pct, rowsFor, signed, type GroupMember, type OddsOptions, type OddsRow, type RowGroup } from './model.ts';

export interface OddsState {
  /** The picked sheet's id; '' is the typed-in modifier. */
  readonly who: string | null;
  readonly customMod: number;
  readonly opts: OddsOptions;
  readonly row: string;
  readonly members: readonly GroupMember[];
}

export const INITIAL_ODDS: OddsState = { who: null, customMod: 0, opts: DEFAULT_OPTIONS, row: 'skill:perception', members: [] };

const GROUPS: readonly (readonly [RowGroup, string])[] = [
  ['skill', 'Skills'],
  ['save', 'Saving throws'],
  ['ability', 'Plain ability checks'],
];

const ROLLS: readonly (readonly [AdvState, string])[] = [
  ['none', 'Normal'],
  ['adv', 'Advantage (Help)'],
  ['dis', 'Disadvantage'],
];

function int(v: string, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

function Bar({ p }: { p: number }) {
  return (
    <span className="oddsbar" aria-hidden="true">
      <span style={{ width: `${(p * 100).toFixed(1)}%` }} />
    </span>
  );
}

function Ladder({ row, opts }: { row: OddsRow; opts: OddsOptions }) {
  const steps = ladder(row, opts);
  const W = 16;
  const H = 90;
  return (
    <svg className="ladder" width={steps.length * W} height={H + 16} role="img" aria-label={`Chance to pass ${row.label} at each DC from 1 to 30`}>
      {steps.map((s, i) => (
        <g key={s.dc}>
          <title>{`DC ${s.dc}: ${pct(s.p)}`}</title>
          <rect x={i * W + 1} y={H - s.p * H} width={W - 2} height={Math.max(s.p * H, 0.5)} className={s.dc === opts.dc ? 'now' : undefined} />
          {s.dc % 5 === 0 && (
            <text x={i * W + W / 2} y={H + 12} textAnchor="middle" className="axis">
              {s.dc}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export interface OddsScreenProps {
  readonly sheets: readonly DerivedSheet[];
  readonly characters: readonly CharacterEntry[];
  readonly state: OddsState;
  readonly setState: Dispatch<SetStateAction<OddsState>>;
}

export function OddsScreen({ sheets, characters, state, setState }: OddsScreenProps) {
  const sorted = useMemo(() => [...sheets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)), [sheets]);
  const isHome = (id: string) => characters.find((c) => c.id === id)?.origin === 'home';
  // Until a pick is made, a home (private) character comes first: it's the one the user plays.
  const who = state.who ?? (sorted.find((s) => isHome(s.id)) ?? sorted[0])?.id ?? '';
  const sheet = sorted.find((s) => s.id === who) ?? null;
  const o = state.opts;
  const rows = useMemo(() => (sheet ? rowsFor(sheet) : [customRow(state.customMod)]), [sheet, state.customMod]);
  const picked = rows.find((r) => r.key === state.row) ?? rows[0]!;
  const extra = parseDice(o.extraDice);
  const after = parseDice(o.afterFail, true);
  const setOpts = (patch: Partial<OddsOptions>) => setState((s) => ({ ...s, opts: { ...s.opts, ...patch } }));
  const [openGroup, setOpenGroup] = useState(false);

  const pick = chance(picked, o);
  const boosted = o.adv !== 'none' || (o.guidance && picked.group === 'skill') || extra.node !== null || after.node !== null;
  const name = sheet?.name ?? 'This check';
  const perception = rows.find((r) => r.key === 'skill:perception');

  const members = state.members;
  const setMembers = (f: (m: readonly GroupMember[]) => readonly GroupMember[]) => setState((s) => ({ ...s, members: f(s.members) }));
  const patchMember = (i: number, patch: Partial<GroupMember>) => setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const group = groupOdds(members, o.dc);
  const modFor = (s: DerivedSheet) => rowsFor(s).find((r) => r.key === picked.key)?.mod ?? 0;

  return (
    <section className="odds" aria-label="Odds">
      <h2>Odds</h2>
      <p className="note">The exact chance to pass a check or save. Nothing is rolled: these are the true odds, not a sample.</p>
      <div className="form">
        <label>
          Character{' '}
          <select value={who} onChange={(e) => setState((s) => ({ ...s, who: e.target.value }))}>
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {isHome(s.id) ? 'PRIVATE · ' : ''}
                {s.name} ({s.classes.map((c) => `${c.name} ${c.level}`).join(' / ')})
              </option>
            ))}
            <option value="">No character: type a modifier</option>
          </select>
        </label>
        {sheet === null && (
          <label>
            Modifier{' '}
            <input type="number" className="short" value={state.customMod} min={-10} max={30} onChange={(e) => setState((s) => ({ ...s, customMod: int(e.target.value, -10, 30, 0) }))} />
          </label>
        )}
      </div>
      <fieldset className="oddsopts">
        <legend>The roll</legend>
        <div className="form">
          <label>
            DC <input type="number" className="short" value={o.dc} min={1} max={40} onChange={(e) => setOpts({ dc: int(e.target.value, 1, 40, o.dc) })} />
          </label>
          <span className="chips" role="group" aria-label="Typical DCs">
            {TYPICAL_DCS.map(([dc, label]) => (
              <button key={dc} type="button" aria-pressed={o.dc === dc} title={label} onClick={() => setOpts({ dc })}>
                {dc} <span className="muted">{label}</span>
              </button>
            ))}
          </span>
        </div>
        <div className="form">
          <span className="chips" role="group" aria-label="Roll">
            {ROLLS.map(([adv, label]) => (
              <button key={adv} type="button" aria-pressed={o.adv === adv} onClick={() => setOpts({ adv })}>
                {label}
              </button>
            ))}
          </span>
          <label title="Guidance adds 1d4 to an ability check that uses the chosen skill. It doesn't add to saves or to checks with no skill.">
            <input type="checkbox" checked={o.guidance} onChange={(e) => setOpts({ guidance: e.target.checked })} /> Guidance (+1d4, skill checks)
          </label>
          <label title="Dice added to every roll, such as 1d4 for Bless on a save">
            Extra dice <input className="short" value={o.extraDice} placeholder="1d4" aria-invalid={extra.error !== null} onChange={(e) => setOpts({ extraDice: e.target.value })} />
          </label>
          <label title="A die rolled only after a failure, such as a d6 of Bardic Inspiration">
            Die after a failure{' '}
            <select value={o.afterFail} onChange={(e) => setOpts({ afterFail: e.target.value })}>
              <option value="">none</option>
              {['1d6', '1d8', '1d10', '1d12'].map((d) => (
                <option key={d} value={d}>
                  {d.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {extra.error !== null && <p className="bad">Extra dice: {extra.error}</p>}
      </fieldset>

      <div className="strip oddshead" role="status" aria-live="polite">
        <div className="big">
          {pct(pick.p)} <span className="muted">{inTwenty(pick.p)}</span>
        </div>
        <div>
          {name}: {picked.label} ({signed(picked.mod)}) against DC {o.dc}
          {boosted && <span className="muted"> · {pct(pick.plain)} as a plain roll</span>}
          {after.node !== null && <span className="muted"> · the extra die gets spent {pct(pick.pAfterFailUsed)} of the time</span>}
        </div>
        {sheet !== null && perception && (
          <div className="muted">
            Passive Perception {passive(perception.mod, o.adv)}
            {o.adv !== 'none' ? ` (${o.adv === 'adv' ? '+5 with Advantage' : '-5 with Disadvantage'})` : ''}
          </div>
        )}
      </div>

      <div className="oddsgrid">
        <div>
          {GROUPS.map(([g, title]) => {
            const list = rows.filter((r) => r.group === g);
            if (list.length === 0) return null;
            return (
              <table key={g} className="oddstable">
                <thead>
                  <tr>
                    <th>{sheet ? title : 'Check'}</th>
                    <th className="num">Mod</th>
                    <th>Chance at DC {o.dc}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const c = chance(r, o);
                    return (
                      <tr key={r.key} className={r.key === picked.key ? 'activerow' : undefined}>
                        <td>
                          <button type="button" className="linkish" aria-pressed={r.key === picked.key} title={r.why || undefined} onClick={() => setState((s) => ({ ...s, row: r.key }))}>
                            {r.label}
                          </button>{' '}
                          {r.ability !== '' && g === 'skill' && <span className="muted">{r.ability}</span>}
                          {r.rank !== '' && <span className="rank"> {r.rank}</span>}
                        </td>
                        <td className="num">{signed(r.mod)}</td>
                        <td className="chancecell">
                          <Bar p={c.p} />
                          <span className="num">{pct(c.p)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })}
        </div>
        <div>
          <h3>{picked.label} at every DC</h3>
          <Ladder row={picked} opts={o} />
          <table className="dctable">
            <tbody>
              {TYPICAL_DCS.map(([dc, label]) => (
                <tr key={dc} className={dc === o.dc ? 'activerow' : undefined}>
                  <td>
                    DC {dc} <span className="muted">{label}</span>
                  </td>
                  <td className="num">{pct(chance(picked, o, dc).p)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Group check</h3>
          <p className="note">
            Everyone rolls {picked.label} against DC {o.dc}; the group passes when at least half do. Group checks are a DM's tool, so confirm your table uses them.
          </p>
          <div className="form">
            <label>
              Add{' '}
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '') return;
                  const s = sorted.find((x) => x.id === v);
                  setMembers((ms) => [...ms, s ? { name: s.name, mod: modFor(s), adv: 'none', guidance: false } : { name: `Member ${ms.length + 1}`, mod: 0, adv: 'none', guidance: false }]);
                  setOpenGroup(true);
                }}
              >
                <option value="">a member...</option>
                {sorted.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({signed(modFor(s))})
                  </option>
                ))}
                <option value="custom">Someone else (type a modifier)</option>
              </select>
            </label>
            {members.length > 0 && (
              <button type="button" onClick={() => setMembers(() => [])}>
                Clear
              </button>
            )}
          </div>
          {group !== null && (openGroup || members.length > 0) && (
            <>
              <table className="grouptable">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Mod</th>
                    <th>Roll</th>
                    <th>Guidance</th>
                    <th className="num">Passes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={i}>
                      <td>
                        <input value={m.name} aria-label={`Member ${i + 1} name`} onChange={(e) => patchMember(i, { name: e.target.value })} />
                      </td>
                      <td>
                        <input type="number" className="short" value={m.mod} min={-10} max={30} aria-label={`${m.name} modifier`} onChange={(e) => patchMember(i, { mod: int(e.target.value, -10, 30, m.mod) })} />
                      </td>
                      <td>
                        <select value={m.adv} aria-label={`${m.name} roll`} onChange={(e) => patchMember(i, { adv: e.target.value as AdvState })}>
                          {ROLLS.map(([adv, label]) => (
                            <option key={adv} value={adv}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={m.guidance} aria-label={`${m.name} has Guidance`} onChange={(e) => patchMember(i, { guidance: e.target.checked })} />
                      </td>
                      <td className="num">{pct(group.each[i] ?? 0)}</td>
                      <td>
                        <button type="button" aria-label={`Remove ${m.name}`} onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="groupresult">
                <strong>The group passes {pct(group.group.pPass)}</strong> of the time <span className="muted">(needs {group.group.need} of {members.length})</span>
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
