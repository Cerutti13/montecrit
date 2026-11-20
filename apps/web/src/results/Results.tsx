// Results (docs/design/m2.md 5.2): the header strip with both hashes, outcomes and paired tables
// with CI bars, the all-pairs view (display only), DPR with its histograms, damage per round,
// concentration, the report's resources and option-pick lines, copy buttons and the exemplar
// buttons. Every number comes from the worker's report (ReportStats, ReportModel, the text);
// React computes no statistic.

import { useState } from 'react';
import { fmt, type ArmStats, type Rate, type ReportStats } from '@montecrit/engine';
import type { ReportReply } from '@montecrit/host';
import type { Finished } from '../run/session.ts';
import { reportMeta } from '../run/session.ts';
import { CiBar } from './CiBar.tsx';
import { Histogram } from './Histogram.tsx';
import { fidelityLine, fidelitySummary, seatFidelity } from './fidelity.ts';
import { LineChart } from './LineChart.tsx';

export type ExemplarKind = 'closest-loss' | 'typical-win' | 'tpk' | 'pc-death';
const KINDS: readonly [ExemplarKind, string, keyof ArmStats['exemplars']][] = [
  ['closest-loss', 'closest loss', 'closestLoss'],
  ['typical-win', 'typical win', 'typicalWin'],
  ['tpk', 'TPK', 'tpk'],
  ['pc-death', 'PC death', 'pcDeath'],
];

const rateCell = (r: Rate, what: string) => (
  <td className="num" title={`${what}: ${fmt.int(r.x)} of ${fmt.int(r.n)}; 95% Wilson ${fmt.ci(r.lo, r.hi)}`}>
    {fmt.pct(r.p)} <CiBar value={r.p} lo={r.lo} hi={r.hi} min={0} max={1} width={80} title={`${what} ${fmt.pct(r.p)} ${fmt.ci(r.lo, r.hi)}`} />
  </td>
);

export function Results({ f, wallMs, onReplay }: { f: Finished; wallMs: number; onReplay: (arm: number, kind: ExemplarKind, run: number) => void }) {
  const [all, setAll] = useState<ReportReply | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState('');
  const [callError, setCallError] = useState<string | null>(null);
  const [dmgArm, setDmgArm] = useState(0);
  const [dmgTable, setDmgTable] = useState(false);
  const model = f.report.model;
  const setup = f.session.setup;
  const stats: ReportStats = showAll && all ? all.stats : f.report.stats;
  const head = f.report.text.slice(0, f.report.text.indexOf(''));
  const copy = (what: string, text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => setCopied('copy failed'),
    );
  };
  const toggleAll = async () => {
    try {
      if (!showAll && !all) setAll((await f.session.call({ op: 'report', run: f.run, meta: reportMeta(f.req, f.run, f.base, 'all') })) as ReportReply);
      setShowAll(!showAll);
      setCallError(null);
    } catch (e) {
      setCallError(`couldn't compute all pairs: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const stop = f.run.adaptive ? (f.run.hitCap ? 'adaptive, hit the cap' : `adaptive, stopped at checkpoint ${f.run.checkpoint}`) : 'fixed';
  const maxDiff = Math.max(0.05, ...stats.pairs.map((p) => Math.max(Math.abs(p.lo), Math.abs(p.hi))));
  return (
    <section className="results">
      <h2>Results</h2>
      <div className="strip mono">
        <div>
          scenario {setup.scenario} {setup.scenarioHash} | content {setup.contentHash} | seed {f.req.seed} | n {fmt.int(f.run.merged.n)} ({stop}) | chunks {f.run.merged.nextChunk}x{f.run.merged.chunkSize}
        </div>
        <div>
          policies {f.session.arms.map((a, k) => `${a.label}${a.policy ? `@${a.policy.hash}` : ''}${k === 0 ? ' [reference]' : ''}`).join(', ')} | {f.workers} workers, {(wallMs / 1000).toFixed(1)} s
        </div>
        <div>
          <strong>report-hash {f.report.hash} (pairs ref)</strong> &nbsp; <strong>acc-hash {f.report.accHash}</strong>
          {showAll && <span className="muted"> &nbsp; showing pairs all (display only)</span>}
        </div>
      </div>
      <details>
        <summary>Report header (flags, notes, calibration)</summary>
        <pre>{head.join('\n')}</pre>
      </details>
      <h2>Fidelity (PC seats)</h2>
      {seatFidelity(setup).map((sf) => (
        <div key={sf.seat} className="mono" title={fidelityLine(sf)}>
          <strong>
            {sf.seat} {sf.name}
          </strong>
          : {fidelitySummary(sf)}
          {sf.items.some((i) => i.unimplemented.length > 0) && (
            <details>
              <summary>what isn't modeled</summary>
              <ul>
                {sf.items.map((i) => (
                  <li key={i.id}>
                    {i.name} ({i.id}) {i.fidelity}
                    {i.unimplemented.length > 0 && (
                      <ul>
                        {i.unimplemented.map((u, k) => (
                          <li key={k}>{u}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
      <div className="actions">
        <button type="button" onClick={() => copy('report text', f.report.text.join('\n'))}>
          Copy report text
        </button>{' '}
        <button type="button" onClick={() => copy('JSON', f.report.json)}>
          Copy JSON
        </button>{' '}
        {copied && <span className="muted">copied {copied}</span>}
      </div>

      <h2>Outcomes (95% Wilson CIs)</h2>
      <table>
        <thead>
          <tr>
            <th>Policy</th>
            <th className="num">Win</th>
            <th className="num">Loss</th>
            <th className="num">Stalemate</th>
            <th className="num">TPK</th>
            <th className="num">PC drops</th>
            <th className="num">PC dies</th>
            <th className="num">Rounds mean (p10/p50/p90)</th>
          </tr>
        </thead>
        <tbody>
          {stats.arms.map((a) => (
            <tr key={a.label}>
              <td className="mono">{a.label}</td>
              {rateCell(a.win, 'win')}
              {rateCell(a.loss, 'loss')}
              {rateCell(a.stalemate, 'stalemate')}
              {rateCell(a.tpk, 'TPK')}
              {rateCell(a.pcDrop, 'PC drops')}
              {rateCell(a.pcDied, 'PC dies')}
              <td className="num">
                {fmt.fx(a.rounds.mean)} ({a.rounds.p10}/{a.rounds.p50}/{a.rounds.p90})
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {callError && <div className="banner">{callError}</div>}
      {stats.pairs.length > 0 && (
        <>
          <h2>
            Paired (other - reference, same runs){' '}
            {stats.arms.length > 2 && (
              <button type="button" onClick={() => void toggleAll()}>
                {showAll ? 'Compare with the reference' : 'All pairs'}
              </button>
            )}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Comparison</th>
                <th className="num">Win difference (Newcombe 95%)</th>
                <th className="num">Only other won / only ref won</th>
                <th className="num">McNemar p</th>
                <th className="num">Holm p</th>
                <th className="num">PC DPR difference (bootstrap)</th>
              </tr>
            </thead>
            <tbody>
              {stats.pairs.map((p) => (
                <tr key={`${p.ref}-${p.other}`}>
                  <td className="mono">
                    {stats.arms[p.other]!.label} - {stats.arms[p.ref]!.label}
                  </td>
                  <td className="num" title={`${fmt.pp(p.diff)} pts ${fmt.ci(p.lo, p.hi)}`}>
                    {fmt.pp(p.diff)} pts <CiBar value={p.diff} lo={p.lo} hi={p.hi} min={-maxDiff} max={maxDiff} zero width={120} title={`${fmt.pp(p.diff)} pts ${fmt.ci(p.lo, p.hi)}`} />
                  </td>
                  <td className="num">
                    {fmt.int(p.b)} / {fmt.int(p.c)}
                  </td>
                  <td className="num">{fmt.pval(p.p)}</td>
                  <td className="num">
                    {fmt.pval(p.holm)} {p.holm <= 0.05 ? <strong>SIG</strong> : <span className="muted">ns</span>}
                  </td>
                  <td className="num">
                    {p.dprDiff.value >= 0 ? '+' : ''}
                    {fmt.fx(p.dprDiff.value)} {fmt.ci(p.dprDiff.lo, p.dprDiff.hi, 1, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>DPR (effective; percentile bootstrap 95% CIs)</h2>
      <table>
        <thead>
          <tr>
            <th>Policy</th>
            <th className="num">PC</th>
            <th className="num">Party</th>
            <th className="num">PC per PC turn</th>
            <th className="num">PC per fight p10/p50/p90</th>
            <th>PC damage per round per fight</th>
          </tr>
        </thead>
        <tbody>
          {f.report.stats.arms.map((a, k) => {
            const est = (e: { value: number; lo: number; hi: number }) => `${fmt.fx(e.value)} ${fmt.ci(e.lo, e.hi, 1, 2)}`;
            const yMax = Math.max(...model.arms.flatMap((m) => m.dprBins.map((b) => b.share)));
            return (
              <tr key={a.label}>
                <td className="mono">{a.label}</td>
                <td className="num">{est(a.dprPc)}</td>
                <td className="num">{est(a.dprParty)}</td>
                <td className="num">{est(a.pcPerTurn)}</td>
                <td className="num">
                  {fmt.fx(a.dprPerFight.p10)}/{fmt.fx(a.dprPerFight.p50)}/{fmt.fx(a.dprPerFight.p90)}
                </td>
                <td>
                  <Histogram bins={model.arms[k]!.dprBins} yMax={yMax} label={a.label} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>
        Damage per round{' '}
        <select value={dmgArm} onChange={(e) => setDmgArm(Number(e.target.value))} aria-label="Policy for damage per round">
          {model.arms.map((m, k) => (
            <option key={m.label} value={k}>
              {m.label}
            </option>
          ))}
        </select>{' '}
        <button type="button" onClick={() => setDmgTable(!dmgTable)}>
          {dmgTable ? 'Chart' : 'Table'}
        </button>
      </h2>
      <p className="note">Mean per fight, effective, to the other side unless marked friendly fire; a fight that ended counts 0. Rounds to the last one at least 1% of fights reached.</p>
      {(() => {
        const m = model.arms[dmgArm]!;
        if (!dmgTable) {
          const yMax = Math.max(0.5, ...m.damage.flatMap((d) => d.perRound));
          return <LineChart rows={model.damageRows} cells={m.damage} lastRound={model.lastRound} yMax={yMax} />;
        }
        return (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                {Array.from({ length: model.lastRound }, (_, i) => (
                  <th key={i} className="num">
                    r{i + 1}
                  </th>
                ))}
                <th className="num">later</th>
                <th className="num">total</th>
                <th className="num">rolled</th>
              </tr>
            </thead>
            <tbody>
              {model.damageRows.map((row, j) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {m.damage[j]!.perRound.map((v, i) => (
                    <td key={i} className="num">
                      {fmt.fx(v)}
                    </td>
                  ))}
                  <td className="num">{fmt.fx(m.damage[j]!.later)}</td>
                  <td className="num">{fmt.fx(m.damage[j]!.total)}</td>
                  <td className="num">{fmt.fx(m.damage[j]!.rolled)}</td>
                </tr>
              ))}
              <tr>
                <td className="muted">reached</td>
                {m.reached.map((v, i) => (
                  <td key={i} className="num muted">
                    {fmt.pct(v)}
                  </td>
                ))}
                <td colSpan={3} />
              </tr>
            </tbody>
          </table>
        );
      })()}

      <h2>Concentration (PC)</h2>
      <table>
        <thead>
          <tr>
            <th>Policy</th>
            <th className="num">Uptime (bootstrap 95%)</th>
            <th className="num">Starts per fight</th>
            <th>Ends per fight, by cause</th>
          </tr>
        </thead>
        <tbody>
          {f.report.stats.arms.map((a, k) => (
            <tr key={a.label}>
              <td className="mono">{a.label}</td>
              <td className="num">
                {fmt.fx(a.uptime.value, 3)} <CiBar value={a.uptime.value} lo={a.uptime.lo} hi={a.uptime.hi} min={0} max={1} width={100} title={`uptime ${fmt.fx(a.uptime.value, 3)} ${fmt.ci(a.uptime.lo, a.uptime.hi, 1, 3)}`} />
              </td>
              <td className="num">{fmt.fx(model.arms[k]!.concStartsPerFight)}</td>
              <td>{model.arms[k]!.concEnds.map((e) => `${e.why} ${fmt.fx(e.perFight)}`).join(', ') || 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Resources and option picks</h2>
      <pre>{textSection(f.report.text, 'RESOURCES')}</pre>
      <pre>{textSection(f.report.text, 'OPTION PICKS')}</pre>

      <h2>Exemplar fights</h2>
      <table>
        <tbody>
          {f.report.stats.arms.map((a, k) => (
            <tr key={a.label}>
              <td className="mono">{a.label}</td>
              <td>
                {KINDS.map(([kind, label, key]) => {
                  const run = a.exemplars[key];
                  return (
                    <button key={kind} type="button" disabled={run < 0} aria-label={run < 0 ? `${label}: none` : `${label}, ${a.label}, run ${run}`} title={run < 0 ? `no ${label} in these runs` : `replay run ${run}`} onClick={() => onReplay(k, kind, run)} style={{ marginRight: 6 }}>
                      {label}
                      {run >= 0 ? ` (run ${run})` : ''}
                    </button>
                  );
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One section of the report text, verbatim: from its heading line to the next blank line. */
function textSection(text: readonly string[], heading: string): string {
  const at = text.findIndex((l) => l.startsWith(heading));
  if (at < 0) return '';
  const end = text.indexOf('', at);
  return text.slice(at, end < 0 ? text.length : end).join('\n');
}
