// Play policies (docs/design/m1c.md 2, build step 8): compile and hash, bind to a fight, scripted
// openers on top of the greedy AI, retry and retire counts, and hold.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { bindPolicy, BUILTIN_POLICIES, compilePolicy, ScriptedDecider, type CompiledPolicy } from '../src/decide/policy.ts';
import type { DecisionPoint, Legal, UnitView } from '../src/decide/decider.ts';
import { ArraySink } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { QueryState } from '../src/sim/state.ts';
import { loadScenario } from './helpers/scenario.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT = loaded.content;
const AMBUSH = loadScenario('scenarios/stars-ambush.yaml', CONTENT);

const repoPolicy = (id: string): CompiledPolicy => {
  const c = compilePolicy(parse(readFileSync(join(ROOT, 'policies', `${id}.yaml`), 'utf8')));
  if (!c.policy) throw new Error(c.errors.join('\n'));
  return c.policy;
};
const doc = (over: Record<string, unknown>) => ({ kind: 'policy', id: 'p', name: 'P', ...over });

/** Runs a fight with the policy on the PCs; returns its log and the scripted decider's per-rule stats. */
function play(policy: CompiledPolicy, run = 0) {
  const sink = new ArraySink();
  const ds = makeDeciders(AMBUSH, [], undefined, policy);
  const r = runFight(AMBUSH, 3, run, ds, sink);
  const scripted = ds.find((d) => d instanceof ScriptedDecider) as ScriptedDecider | undefined;
  const turns = r.counters.turns[AMBUSH.seats.findIndex((s) => s.seat === 'pc1')]!;
  return { log: renderLog(sink.events, AMBUSH).join('\n'), stats: scripted ? scripted.stats.map((s) => ({ ...s })) : [], ds, turns };
}

describe('policies', () => {
  it('compile with a stable hash over the rules and effective weights; unknown weights and duplicate rules are errors', () => {
    const a = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:moonbeam' } }] }));
    const b = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:moonbeam' } }] }));
    const c = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:moonbeam' } }], weights: { slotPerLevel: 1 } }));
    expect(a.policy!.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(b.policy!.hash).toBe(a.policy!.hash);
    expect(c.policy!.hash).not.toBe(a.policy!.hash);
    expect(c.policy!.weights.slotPerLevel).toBe(1);
    expect(compilePolicy(doc({ weights: { boldness: 2 } })).errors.join()).toMatch(/weights/);
    expect(compilePolicy(doc({ script: [{ id: 'x', do: { use: 'test:stance' } }, { id: 'x', do: { use: 'test:stance' } }] })).errors).toEqual(['script: two rules named "x"']);
    expect(BUILTIN_POLICIES.map((p) => p.id)).toEqual(['greedy', 'greedy-spendy', 'baseline', 'random-legal']);
  });

  it('bind to a fight: they must play some seat, and every seat they play must have their spells and features', () => {
    expect(bindPolicy(repoPolicy('moonbeam-first'), AMBUSH)).toEqual([]);
    const bad = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:guiding-bolt' } }, { id: 'nope', do: { cast: 'srd:fireball' } }], hold: [{ concentration: 'srd:entangle' }] })).policy!;
    expect(bindPolicy(bad, AMBUSH)).toEqual([
      'policy p: rule nope: pc1 (test:sample-druid) has no spell srd:fireball',
      'policy p: hold: pc1 (test:sample-druid) has no spell srd:entangle',
    ]);
    expect(bindPolicy(compilePolicy(doc({ seats: ['nobody'] })).policy!, AMBUSH)[0]).toMatch(/plays no seat/);
  });

  it('a pick must name a choice its directive opens; a pick on a directive with no choice is an error', () => {
    const typo = compilePolicy(doc({ script: [{ id: 'form', do: { use: 'test:stance' }, pick: 'stedy' }] })).policy!;
    expect(bindPolicy(typo, AMBUSH)).toEqual(['policy p: rule form: pick "stedy" isn\'t one of feature test:stance\'s choices (volley, mending, steady)']);
    const none = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:moonbeam' }, pick: 'volley' }] })).policy!;
    expect(bindPolicy(none, AMBUSH)).toEqual(['policy p: rule open: pick "volley", but spell srd:moonbeam offers no choice']);
    expect(bindPolicy(repoPolicy('test-steady-first'), AMBUSH)).toEqual([]);
  });

  it('a pick answers the first choice its directive asks, so a choice nested inside an option is not one it can name', () => {
    const nest = { k: 'choose', opts: [{ local: 'outer', name: 'Outer', steps: [{ k: 'choose', opts: [{ local: 'inner', name: 'Inner', steps: [] }] }] }] };
    const tpl = { id: 'test:nested', kind: 'pc', spells: [], attacks: [], options: [], features: [{ id: 'test:nest', activate: { steps: [nest] } }] };
    const s = { scenario: 'nested', seats: [{ seat: 'pc1', team: 0, tpl }] } as unknown as FightSetup;
    const p = (pick: string) => compilePolicy(doc({ script: [{ id: 'r', do: { use: 'test:nest' }, pick }] })).policy!;
    expect(bindPolicy(p('outer'), s)).toEqual([]);
    expect(bindPolicy(p('inner'), s)).toEqual(['policy p: rule r: pick "inner" isn\'t one of feature test:nest\'s choices (outer)']);
  });

  it('an attack directive respects attackDowned: with only a downed target, it does not fire unless the knob allows it', () => {
    const run = (attackDowned: string) => {
      const me = { turns: 1, conc: -1, tpl: { spells: [], features: [], attacks: [{ local: 'scimitar' }], options: [] } };
      const st = { round: 1, setup: { knobs: { attackDowned } }, units: [me, { life: 'down' }] } as unknown as QueryState;
      const items = [{ k: 'pass' } as Legal, { k: 'attack', atk: 0, target: 1 } as Legal];
      const dp: DecisionPoint = { k: 'turn', who: 0, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => items[i]!.k };
      const sd = new ScriptedDecider(compilePolicy(doc({ base: 'baseline', script: [{ id: 'slash', do: { attack: 'scimitar' } }] })).policy!);
      const raw = sd as unknown as { reset(q: QueryState): void; fire(v: UnitView, d: DecisionPoint): number };
      raw.reset(st);
      return raw.fire({ q: st, me: 0 } as unknown as UnitView, dp);
    };
    expect(run('never')).toBe(-1);
    expect(run('ifNoOtherTarget')).toBe(1); // no standing target to attack instead
    expect(run('always')).toBe(1);
  });

  it('M3 step 5a riders: stun-first takes Stunning Strike whenever it is offered, a pick names a choose rider\'s option, and riders are checked against the seat', () => {
    const MONK = loadScenario('scenarios/monk-ambush.yaml', CONTENT);
    const stun = repoPolicy('stun-first');
    expect(bindPolicy(stun, MONK)).toEqual([]);
    expect(bindPolicy(stun, AMBUSH)).toEqual(['policy stun-first: riders: pc1 (test:sample-druid) has no rider stunning-strike']);
    expect(bindPolicy(compilePolicy(doc({ riders: [{ rider: 'open-hand-technique', pick: 'shove' }] })).policy!, MONK)).toEqual(['policy p: riders: pick "shove" isn\'t one of rider open-hand-technique\'s options (addle, push, topple)']);
    expect(bindPolicy(compilePolicy(doc({ riders: [{ rider: 'stunning-strike', pick: 'x' }] })).policy!, MONK)[0]).toMatch(/it has no choice/);
    expect(compilePolicy(doc({ riders: [{ rider: 'a' }, { rider: 'a' }] })).errors).toEqual(['riders: rider "a" listed twice']);
    // The riders field enters the hash only when given: a policy without one keeps its old hash.
    expect(compilePolicy(doc({ riders: [] })).policy!.hash).toBe(compilePolicy(doc({})).policy!.hash);
    expect(compilePolicy(doc({ riders: [{ rider: 'stunning-strike' }] })).policy!.hash).not.toBe(compilePolicy(doc({})).policy!.hash);
    // A rider decision, by keys: pass first, then the rider's items.
    const rider = (keys: string[]): DecisionPoint => ({ k: 'rider', legal: { n: keys.length, items: keys.map((k) => ({ k: k === 'pass' ? 'pass' : 'pick' }) as unknown as Legal) }, keyOf: (i: number) => keys[i]! }) as unknown as DecisionPoint;
    const view = { q: {} as QueryState, me: 0 } as unknown as UnitView;
    const take = (pol: CompiledPolicy, keys: string[]) => new ScriptedDecider(pol).decide(view, rider(keys));
    expect(take(stun, ['pass', 'rider:stunning-strike'])).toBe(1);
    const topple = compilePolicy(doc({ riders: [{ rider: 'open-hand-technique', pick: 'topple' }] })).policy!;
    expect(take(topple, ['pass', 'rider:open-hand-technique/addle', 'rider:open-hand-technique/push', 'rider:open-hand-technique/topple'])).toBe(3);
    // In real fights: every rider decision that offers Stunning Strike takes it.
    let offered = 0;
    for (let run = 0; run < 12; run++) {
      const ds = makeDeciders(MONK, [], undefined, stun);
      const pc = MONK.seats.findIndex((x) => x.seat === 'pc1');
      const inner = ds[pc]!;
      const spy = { name: inner.name, decide: (v: UnitView, dp: DecisionPoint) => {
        const i = inner.decide(v, dp);
        if (dp.k === 'rider') for (let j = 0; j < dp.legal.n; j++) if (dp.keyOf(j) === 'rider:stunning-strike') {
          offered++;
          expect(dp.keyOf(i)).toBe('rider:stunning-strike');
        }
        return i;
      } };
      ds[pc] = spy as typeof inner;
      runFight(MONK, 3, run, ds, null);
    }
    expect(offered).toBeGreaterThan(5);
  });

  it('hold needs a greedy base (baseline and random-legal would ignore it)', () => {
    expect(compilePolicy(doc({ base: 'random-legal', hold: [{ concentration: 'srd:moonbeam' }] })).errors).toEqual(['hold: only a greedy base can hold a concentration (base is random-legal)']);
    expect(compilePolicy(doc({ base: 'greedy', hold: [{ concentration: 'srd:moonbeam' }] })).errors).toEqual([]);
  });

  it('an attack directive takes that weapon, and the base decider picks the target: the AC 10 dummy, not the AC 18 knight listed first', () => {
    const r = resolveScenario(
      {
        kind: 'scenario', id: 'punch', name: 'Punch', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 6, h: 4 }, flags: { initiativeMode: 'static' },
        units: [
          { seat: 'hero', team: 'party', use: 'srd:goblin-boss', at: 'C2', decider: 'greedy' },
          { seat: 'd1', team: 'enemies', use: 'srd:knight', at: 'B2', decider: 'greedy' },
          { seat: 'd2', team: 'enemies', use: 'test:training-dummy', at: 'D2', hp: 30, decider: 'greedy' },
        ],
      },
      'punch.yaml',
      CONTENT,
    );
    const s = r.setup!;
    const slash = compilePolicy(doc({ seats: ['hero'], script: [{ id: 'slash', do: { attack: 'scimitar' } }] })).policy!;
    expect(bindPolicy(slash, s)).toEqual([]);
    const sink = new ArraySink();
    runFight(s, 1, 0, makeDeciders(s, [], undefined, slash), sink);
    expect(/hero chooses (attack:\S+)/.exec(renderLog(sink.events, s).join('\n'))![1]).toBe('attack:scimitar>d2');
  });

  it('a rule out of retries stays live for the rest of its last turn (it may become legal after a move), then retires', () => {
    const policy = compilePolicy(doc({ script: [{ id: 'open', do: { cast: 'srd:moonbeam' }, retry: 0 }] })).policy!;
    const me = { turns: 1, conc: -1, tpl: { spells: [{ spell: { id: 'srd:moonbeam' } }], features: [], attacks: [], options: [] } };
    const st = { round: 1, units: [me] } as unknown as QueryState;
    const view = { q: st, me: 0 } as unknown as UnitView;
    const dp = (castable: boolean): DecisionPoint => {
      const items = [{ k: 'pass' } as Legal, ...(castable ? [{ k: 'cast', opt: 0, lvl: 2, aux: 0 } as Legal] : [])];
      return { k: 'turn', who: 0, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => items[i]!.k };
    };
    const fire = (sd: ScriptedDecider, castable: boolean) => (sd as unknown as { reset(q: QueryState): void; fire(v: UnitView, d: DecisionPoint): number }).fire(view, dp(castable));
    const raw = (sd: ScriptedDecider) => sd as unknown as { reset(q: QueryState): void };
    // Not legal at the turn's first look, legal after a move: it fires, and isn't counted as retired.
    const a = new ScriptedDecider(policy);
    raw(a).reset(st);
    me.turns = 1;
    expect(fire(a, false)).toBe(-1);
    expect(a.stats[0]).toEqual({ rule: 'open', taken: 0, retried: 0, retired: 1 });
    expect(fire(a, true)).toBe(1);
    expect(a.stats[0]).toEqual({ rule: 'open', taken: 1, retried: 0, retired: 0 });
    // Never legal that turn: retired, and still retired when it becomes legal on the next turn.
    const b = new ScriptedDecider(policy);
    raw(b).reset(st);
    me.turns = 1;
    expect(fire(b, false)).toBe(-1);
    me.turns = 2;
    expect(fire(b, true)).toBe(-1);
    expect(b.stats[0]).toEqual({ rule: 'open', taken: 0, retried: 0, retired: 1 });
  });

  it('a scripted opener fires on the PC\'s first turn, its name carries the hash, and the greedy AI plays the rest', () => {
    const p = repoPolicy('moonbeam-first');
    const { log, stats, ds } = play(p);
    const pc = AMBUSH.seats.findIndex((s) => s.seat === 'pc1');
    expect(ds[pc]!.name).toBe(`moonbeam-first@${p.hash}`);
    const first = /pc1 chooses (cast|use|attack|opt)\S*/.exec(log)![0];
    expect(first).toBe('pc1 chooses cast:moonbeam@2');
    expect(stats).toEqual([{ rule: 'open', taken: 1, retried: 0, retired: 0 }]);
    expect(ds.filter((d) => d.name === 'greedy')).toHaveLength(AMBUSH.seats.length - 1); // everyone else plays their scenario decider
  });

  it('a rule\'s pick decides the choice its directive opens', () => {
    for (const opt of ['volley', 'steady']) {
      const { log } = play(repoPolicy(`test-${opt}-first`));
      expect(/pc1 chooses pick:(\w+)/.exec(log)![1]).toBe(opt);
    }
  });

  it('a directive that never becomes legal is retried, then retired, and the report can see it', () => {
    const never = compilePolicy(doc({ script: [{ id: 'ninth', do: { cast: 'srd:moonbeam', level: 9 }, retry: 2 }] })).policy!;
    let sawRetire = false;
    for (let run = 0; run < 10; run++) {
      const { stats, turns } = play(never, run);
      // Tried on its first turn, retried on its second and third (retry: 2), then given up (turns it took up, so it could act).
      expect(stats, `run ${run}, ${turns} turns`).toEqual([{ rule: 'ninth', taken: 0, retried: Math.max(0, Math.min(turns, 3) - 1), retired: turns >= 3 ? 1 : 0 }]);
      sawRetire ||= turns >= 3;
    }
    expect(sawRetire).toBe(true);
  });

  it('hold: the greedy AI never trades away the held concentration while it lasts', () => {
    for (let run = 0; run < 8; run++) {
      const { log } = play(repoPolicy('moonbeam-first'), run);
      expect(log, `run ${run}`).not.toMatch(/Moonbeam \(pc1\) ends \(concentrating on something else\)/);
    }
  });

  it('a policy\'s per-fight stats reset when the decider is reused for another fight', () => {
    const p = repoPolicy('moonbeam-first');
    const ds = makeDeciders(AMBUSH, [], undefined, p);
    runFight(AMBUSH, 3, 0, ds, null);
    runFight(AMBUSH, 3, 1, ds, null);
    const s = (ds.find((d) => d instanceof ScriptedDecider) as ScriptedDecider).stats;
    expect(s[0]!.taken).toBe(1);
  });
});
