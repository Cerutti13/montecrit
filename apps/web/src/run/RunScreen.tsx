// The Run screen: the run panel, then the results of the last run, then what can run.

import type { Catalog } from '../content/catalog.ts';
import type { ContentSet } from '../content/select.ts';
import { Results, type ExemplarKind } from '../results/Results.tsx';
import { RunPanel } from './RunPanel.tsx';
import type { Finished } from './session.ts';
import type { Runs } from './useRuns.ts';

export interface LastRun {
  readonly f: Finished;
  readonly wallMs: number;
}

export function RunScreen({ catalog, set, last, runs, onReplay }: { catalog: Catalog; set: ContentSet; last: LastRun | null; runs: Runs; onReplay: (arm: number, kind: ExemplarKind, run: number) => void }) {
  return (
    <>
      {catalog.contentErrors.length > 0 && <div className="banner">Content has errors: {catalog.contentErrors.join('; ')}</div>}
      {/* Remounts when the scenario list changes (the home loading), so its defaults follow. */}
      <RunPanel key={catalog.scenarios.map((s) => s.path).join('|')} catalog={catalog} set={set} runs={runs} />
      {last && <Results key={last.f.report.hash + last.wallMs} f={last.f} wallMs={last.wallMs} onReplay={onReplay} />}
      <details>
        <summary>Scenarios and policies (with the hashes the CLI prints)</summary>
        <h2>Scenarios</h2>
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Scenario</th>
              <th>Scenario hash</th>
              <th>Content hash</th>
            </tr>
          </thead>
          <tbody>
            {catalog.scenarios.map((s) => (
              <tr key={s.path}>
                <td className="mono">{s.path}</td>
                <td>{s.id ?? <span className="muted">{s.errors.join('; ')}</span>}</td>
                <td className="mono">{s.scenarioHash ?? ''}</td>
                <td className="mono">{s.contentHash ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Policies</h2>
        {catalog.policyErrors.length > 0 && <div className="banner">Policy errors: {catalog.policyErrors.join('; ')}</div>}
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {catalog.policies.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.name}</td>
                <td className="mono">{p.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
