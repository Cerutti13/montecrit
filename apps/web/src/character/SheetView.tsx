// The derived sheet (docs/design/m3.md 10, "Web"): every number with its sources, every feature
// with its fidelity, as `montecrit build` prints it (renderSheet), laid out as tables. The CLI's
// text form sits under it for copying.

import { renderSheet, type DerivedSheet, type SheetNumber } from '@montecrit/engine';

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const ABILITY: Readonly<Record<string, string>> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

function NumRow({ label, n, sign = false }: { label: string; n: SheetNumber; sign?: boolean }) {
  const v = (x: number) => (sign ? signed(x) : String(x));
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{v(n.value)}</td>
      <td>
        {n.why}
        {n.override && (
          <div className="muted">
            override: {n.override.why} (derived {v(n.override.derived)}: {n.override.derivedWhy})
          </div>
        )}
      </td>
    </tr>
  );
}

export function SheetView({ sheet }: { sheet: DerivedSheet }) {
  const c = sheet.classes[0];
  const ranked = sheet.skills.filter((s) => s.rank !== 'none');
  return (
    <div className="sheet">
      <p>
        <strong>{sheet.name}</strong> <span className="mono">({sheet.id})</span>
        {sheet.placeholder && ' [placeholder]'}
        <br />
        {c && `${c.name} ${c.level}${c.subclass ? ` (${c.subclass.name})` : ''}, `}
        {sheet.species.name} ({sheet.size}), {sheet.background.name} · source: {sheet.source} · fidelity: <span className={`fid fid-${sheet.fidelity}`}>{sheet.fidelity}</span>
      </p>
      <table aria-label="Ability scores">
        <thead>
          <tr>
            {sheet.abilities.map((a) => (
              <th key={a.ability} scope="col" className="num">
                {ABILITY[a.ability]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {sheet.abilities.map((a) => (
              <td key={a.ability} className="num">
                {a.score} ({signed(a.mod)})
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <h3>Numbers and their sources</h3>
      <table aria-label="Derived numbers">
        <tbody>
          <NumRow label="PB" n={sheet.pb} sign />
          <NumRow label="HP max" n={sheet.hpMax} />
          <NumRow label="AC" n={sheet.ac} />
          <NumRow label="Speed" n={sheet.speed} />
          <NumRow label="Initiative" n={sheet.initiative} sign />
          <NumRow label="Extra attacks" n={sheet.extraAttacks} />
        </tbody>
      </table>
      <h3>Saves</h3>
      <table aria-label="Saving throws">
        <tbody>
          {sheet.saves.map((s) => (
            <tr key={s.ability}>
              <th scope="row">
                {ABILITY[s.ability]}
                {s.proficient ? ' (proficient)' : ''}
              </th>
              <td className="num">{signed(s.mod)}</td>
              <td>{s.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Skills (proficient or better)</h3>
      {ranked.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <table aria-label="Skills">
          <tbody>
            {ranked.map((s) => (
              <tr key={s.skill}>
                <th scope="row">
                  {s.skill}
                  {s.rank === 'expertise' ? ' (expertise)' : ''}
                </th>
                <td className="num">{signed(s.mod)}</td>
                <td>{s.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Attacks</h3>
      {sheet.attacks.length === 0 ? (
        <p className="muted">none (Unarmed Strike only)</p>
      ) : (
        <table aria-label="Attacks">
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col" className="num">
                To hit
              </th>
              <th scope="col">Damage</th>
              <th scope="col">Reach</th>
              <th scope="col">Sources and notes</th>
            </tr>
          </thead>
          <tbody>
            {sheet.attacks.map((a) => (
              <tr key={a.id}>
                <th scope="row">{a.name}</th>
                <td className="num">{signed(a.toHit.value)}</td>
                <td>{a.damage}</td>
                <td>{a.reach}</td>
                <td>
                  {a.toHit.why}
                  {a.notes.length > 0 && (
                    <ul className="tight">
                      {a.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        Spell slots: {sheet.slots.levels.length > 0 ? sheet.slots.levels.map((n, i) => `L${i + 1} ${n}`).join(', ') : 'none'} <span className="muted">({sheet.slots.why})</span>
      </p>
      {sheet.pools.length > 0 && (
        <>
          <h3>Pools</h3>
          <table aria-label="Pools">
            <tbody>
              {sheet.pools.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td className="num">{p.max}</td>
                  <td>
                    {p.why}
                    {p.spentBy.length > 0 && `; spent by ${p.spentBy.join(', ')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {sheet.options.length > 0 && (
        <>
          <h3>Options in a fight</h3>
          <table aria-label="Options in a fight">
            <tbody>
              {sheet.options.map((o, i) => (
                <tr key={`${o.name}-${i}`}>
                  <th scope="row">{o.name}</th>
                  <td>{o.kind}</td>
                  <td>
                    {o.when} <span className="muted">({o.from})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {sheet.casting.length > 0 && (
        <>
          <h3>Casting</h3>
          <ul className="tight">
            {sheet.casting.map((k) => (
              <li key={k.source}>
                <span className="mono">{k.source}</span> ({ABILITY[k.ability]}): cantrips {k.cantrips.length}
                {k.cantripsExpected !== null && `/${k.cantripsExpected}`} [{k.cantrips.join(', ')}], prepared {k.prepared.length}
                {k.preparedExpected !== null && `/${k.preparedExpected}`} [{k.prepared.join(', ')}]{k.always.length > 0 && `, always [${k.always.join(', ')}]`}
              </li>
            ))}
          </ul>
        </>
      )}
      {sheet.feats.length > 0 && (
        <>
          <h3>Feats</h3>
          <table aria-label="Feats">
            <tbody>
              {sheet.feats.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.name}</th>
                  <td className="mono">{f.id}</td>
                  <td>{f.from}</td>
                  <td>
                    <span className={`fid fid-${f.fidelity}`}>{f.fidelity}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3>Features and their fidelity</h3>
      <table aria-label="Features">
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">From</th>
            <th scope="col">Fidelity</th>
            <th scope="col">Not modeled</th>
          </tr>
        </thead>
        <tbody>
          {sheet.features.map((f) => (
            <tr key={f.id}>
              <th scope="row">
                {f.name} <span className="mono muted">{f.id}</span>
              </th>
              <td>{f.from}</td>
              <td>{f.compiled ? <span className={`fid fid-${f.fidelity}`}>{f.fidelity}</span> : <span className="fid fid-narrative">narrative (above level 10)</span>}</td>
              <td>{f.unimplemented.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.picks.length > 0 && (
        <>
          <h3>Picks</h3>
          <ul className="tight mono">
            {sheet.picks.map((p) => (
              <li key={p.key}>
                {p.key}: {p.value}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Not modeled ({sheet.unimplemented.length})</h3>
      {sheet.unimplemented.length > 0 && (
        <ul className="tight">
          {sheet.unimplemented.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>As text (montecrit build)</summary>
        <pre className="sheettext">{renderSheet(sheet)}</pre>
      </details>
    </div>
  );
}
