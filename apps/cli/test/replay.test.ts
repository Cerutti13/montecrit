// `montecrit run ... --replay KIND[:POLICY]` (docs/design/m1c.md 6): it recomputes the report, plays
// the exemplar it names, and prints the log plus the cause chain of every PC drop, death and
// stabilize and of what ended the fight. The replay is the fight the runner counted: the same log
// as the cheap `--run R` command it prints, and (MONTECRIT_SLOW=1) the same final state hash as the
// runner's own fight for every exemplar of the full 5-policy public stars-ambush at n = 2,000.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exemplars, runArms } from '@montecrit/engine';
import { REPO_ROOT } from '../src/files.ts';
import { homedir } from 'node:os';
import { planRun, playOne, replayPath, runRun, shellWord, whyChains, type RunPlan } from '../src/run.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
const ARGS = ['stars-ambush', '-n', '40', '--policy', 'greedy,moonbeam-first', '--chunk', '20'];

const logHash = (out: string) => /^logHash ([0-9a-f]+)/m.exec(out)?.[1];

describe('--replay', () => {
  it('replays the closest loss the report names, and its printed --run command plays the same fight', { timeout: 20_000 }, () => {
    const report = runRun(ARGS, env);
    const named = /^ {2}greedy +closest loss run (\d+) /m.exec(report.out)![1];
    const o = runRun([...ARGS, '--replay', 'closest-loss'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toMatch(new RegExp(`^exemplar closest loss for greedy: run ${named} of 40 \\(enemies \\d+/\\d+ HP left after \\d+ rounds\\)$`, 'm'));
    expect(o.out).toMatch(/fight ends: loss/);
    const cheap = /without rerunning 40: montecrit run (.*)$/m.exec(o.out)![1]!;
    expect(cheap).toBe(`scenarios/stars-ambush.yaml --seed 42 --run ${named} --policy greedy`);
    const one = runRun(cheap.split(' '), env);
    expect(one.code).toBe(0);
    expect(logHash(one.out)).toBe(logHash(o.out));
  });

  it('prints a cause chain for every PC drop, death and stabilize, then what ended the fight', { timeout: 20_000 }, () => {
    for (const kind of ['closest-loss', 'typical-win', 'tpk']) {
      const o = runRun([...ARGS, '--replay', kind], env);
      expect(o.code).toBe(0);
      const log = o.out.slice(0, o.out.indexOf('\nWHY'));
      const why = o.out.slice(o.out.indexOf('\nWHY'));
      const drops = (log.match(/^ *#\d+ +pc1 drops to 0 HP/gm) ?? []).length;
      expect((why.match(/^ {2}pc1 dropped \(#\d+\):$/gm) ?? []).length).toBe(drops);
      expect((why.match(/^ {2}pc1 died \(#\d+\):$/gm) ?? []).length).toBe((log.match(/^ *#\d+ +pc1 dies/gm) ?? []).length);
      if (drops === 0) expect(why).toMatch(/^ {2}no PC dropped$/m);
      expect(why).toMatch(/^ {2}ended the fight \((win|loss) in round \d+\)/m);
      // Every chain line after the first points back at an earlier event.
      expect(why).toMatch(/^ {6}<- #\d+ /m);
    }
  });

  it('names a stabilize as what ended the fight when the last PC standing goes stable (a loss under lossCounts=pcs)', { timeout: 20_000 }, () => {
    const p = planRun(['stars-ambush', '-n', '2', '--policy', 'greedy'], env, REPO_ROOT) as RunPlan;
    const arm = p.arms[0]!;
    let found = -1;
    for (let r = 0; r < 300 && found < 0; r++) {
      const f = playOne(arm.setup, 42, r, arm.policy);
      const ends = f.events.filter((e) => e.k === 'down' || e.k === 'death' || e.k === 'stable');
      if (f.result.outcome.k === 'loss' && ends[ends.length - 1]?.k === 'stable') {
        found = r;
        const L = whyChains(f.events, arm.setup).join('\n');
        expect(L).toMatch(/^ {2}ended the fight \(loss in round \d+\): pc1 stabilized \(#\d+\), above$/m);
        expect(L).toMatch(/^ {2}pc1 stabilized \(#\d+\):$/m);
      }
    }
    expect(found, 'no fight in 300 ended on a stabilize').toBeGreaterThanOrEqual(0);
  });

  it('with a fixed -n reruns only the chosen policy: the other arms change nothing', { timeout: 20_000 }, () => {
    const both = runRun([...ARGS, '--replay', 'typical-win:moonbeam-first'], env);
    const alone = runRun(['stars-ambush', '-n', '40', '--policy', 'moonbeam-first', '--chunk', '20', '--replay', 'typical-win'], env);
    expect(both.code).toBe(0);
    expect(both.out).toMatch(/^exemplar typical win for moonbeam-first: run \d+ of 40/m);
    expect(alone.out).toBe(both.out);
    // The chunk size never changes which fight it is.
    expect(runRun([...ARGS.slice(0, -2), '--replay', 'typical-win:moonbeam-first'], env).out).toBe(both.out);
  });

  it('--explain works with --replay; a missing exemplar exits 1 with a message', { timeout: 20_000 }, () => {
    const o = runRun([...ARGS, '--replay', 'closest-loss', '--explain', 'pc1'], env);
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/^ +why: /m);
    const none = runRun(['stars-ambush', '-n', '3', '--seed', '1', '--policy', 'greedy', '--replay', 'tpk'], env);
    expect([none.code, none.out, none.err]).toEqual([1, '', 'run: no TPK in 3 fights of greedy']);
  });

  it('printed commands name the scenario as the shell will read it from this directory, quoted when needed', () => {
    const file = join(REPO_ROOT, 'scenarios', 'stars-ambush.yaml');
    expect(replayPath(file, REPO_ROOT)).toBe('scenarios/stars-ambush.yaml');
    expect(replayPath(file, join(REPO_ROOT, 'scenarios'))).toBe('./stars-ambush.yaml'); // never a bare name
    expect(replayPath(join(homedir(), '.montecrit', 'scenarios', 'stars-ambush.yaml'), '/nowhere')).toBe('~/.montecrit/scenarios/stars-ambush.yaml');
    expect(replayPath('/x/my scen/sa.yaml', '/elsewhere')).toBe("'/x/my scen/sa.yaml'");
    expect(replayPath(join(homedir(), "my dir", "it's.yaml"), '/nowhere')).toBe("~/'my dir/it'\\''s.yaml'");
    // A relative path starting with ~ or - would be read as a home directory or a flag.
    expect(replayPath('/w/~/x.yaml', '/w')).toBe('./~/x.yaml');
    expect(replayPath('/w/~bob/x.yaml', '/w')).toBe('./~bob/x.yaml');
    expect(replayPath('/w/-n/x.yaml', '/w')).toBe('./-n/x.yaml');
    expect(shellWord('~bob')).toBe("'~bob'");
    expect(shellWord('-n')).toBe("'-n'");
  });

  it('refuses what a replay cannot use', () => {
    const usage = (args: string[]) => {
      try {
        const o = runRun(args, env);
        return o.code === 0 ? '' : o.err;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(usage([...ARGS, '--replay', 'closest'])).toMatch(/--replay takes closest-loss, typical-win, tpk or pc-death/);
    expect(usage(['stars-ambush', '-n', '1', '--policy', 'greedy', '--replay', 'tpk'])).toMatch(/give the report's -n/);
    expect(usage([...ARGS, '--replay', 'tpk', '--run', '3'])).toMatch(/--replay finds its own run/);
    expect(usage([...ARGS, '--replay', 'tpk', '--json'])).toMatch(/--replay prints one fight/);
    expect(usage([...ARGS, '--replay', 'tpk:spike-first'])).toMatch(/no policy "spike-first" in this run \(greedy, moonbeam-first\)/);
    expect(usage([...ARGS, '--replay', 'tpk', '--explain', 'nobody'])).toMatch(/--explain: no seat "nobody"/);
  });

  it.runIf(SLOW)('every exemplar of the 5-policy public stars-ambush at n = 2,000 replays to the runner\'s final state hash', { timeout: 900_000 }, () => {
    const p = planRun(['stars-ambush', '-n', '2000', '--policy', 'greedy,moonbeam-first,spike-first,test-volley-first,test-steady-first'], env, REPO_ROOT) as RunPlan;
    expect(p.arms).toHaveLength(5);
    const hashes = p.arms.map(() => new Array<string>(2000));
    const r = runArms(p.arms, 42, { n: 2000, onFight: (k, i, f) => (hashes[k]![i] = f.stateHash) });
    let checked = 0;
    p.arms.forEach((arm, k) => {
      const e = exemplars(r.merged.arms[k]!);
      for (const idx of [e.closestLoss, e.typicalWin, e.tpk, e.pcDeath]) {
        if (idx < 0) continue;
        expect(playOne(arm.setup, 42, idx, arm.policy).result.stateHash, `${arm.label} run ${idx}`).toBe(hashes[k]![idx]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(15);
  });
});
