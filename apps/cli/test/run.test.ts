// `montecrit run`: the M1a demo as golden logs, plus the play-by-rerun exit codes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/files.ts';
import { runLint } from '../src/lint.ts';
import { runRun } from '../src/run.ts';

const G = join(REPO_ROOT, 'scenarios', 'golden');
const SCEN = join(G, 'oa-interrupts-move.yaml');
const JOURNAL = join(G, 'oa-interrupts-move.journal.yaml');
// An empty private home, so the real ~/.montecrit never leaks into these tests.
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };

describe('montecrit run golden logs (review any diff on purpose; regenerate with --update-golden)', () => {
  for (const seed of [1, 2]) {
    it(`oa-interrupts-move, seed ${seed}, matches its golden log`, () => {
      const o = runRun([SCEN, '--seed', String(seed), '--journal', JOURNAL], env);
      expect(o.code).toBe(0);
      expect(o.err).toBe('');
      expect(o.out + '\n').toBe(readFileSync(join(G, `oa-interrupts-move.seed${seed}.log`), 'utf8'));
    });
  }

  it('M1b demo: pull-into-spikes, seed 21, matches its golden log', () => {
    const scen = join(G, 'pull-into-spikes.yaml');
    const o = runRun([scen, '--journal', join(G, 'pull-into-spikes.journal.yaml')], env);
    expect(o.code).toBe(0);
    expect(o.err).toBe('');
    expect(o.out + '\n').toBe(readFileSync(join(G, 'pull-into-spikes.seed21.log'), 'utf8'));
    // The pull is forced movement through Spike Growth: 2d4 per 5 ft traveled, no opportunity attacks.
    expect(o.out).toMatch(/gob1 is pulled H1 -> G1 \(5 ft, forced\)\n.*gob1 takes \d+ \(\d+ piercing\) from Spike Growth/);
    expect(o.out).toMatch(/gob1 is pulled G1 -> F1 \(5 ft, forced\)/);
    expect(o.out).not.toMatch(/leaves .* reach/);
  });

  it('run --json shows each zone event\'s cells as view-only `area` (docs/design/m2.md 4.2); the text log does not', () => {
    const scen = join(G, 'pull-into-spikes.yaml');
    const o = runRun([scen, '--journal', join(G, 'pull-into-spikes.journal.yaml'), '--json'], env);
    expect(o.code).toBe(0);
    const zones = (JSON.parse(o.out) as { events: { k: string; cells?: number; area?: number[] }[] }).events.filter((e) => e.k === 'zone');
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) expect(z.area).toHaveLength(z.cells!);
    expect(readFileSync(join(G, 'pull-into-spikes.seed21.log'), 'utf8')).not.toMatch(/"area"|area: \[/);
  });

  for (const [name, seed] of [['moonbeam-moved-then-turn-end', 1], ['conc-break-cascade', 3], ['stars-ambush-greedy', 42], ['precast-spikes', 1], ['low-hp-self-heal', 42], ['monk-stunning-strike', 30], ['monk-deflect', 30], ['mastery-sampler', 254], ['cover-archer', 3], ['redirect-attack', 2]] as const) {
    it(`${name}, seed ${seed}, matches its golden log`, () => {
      const o = runRun([join(G, `${name}.yaml`), '--journal', join(G, `${name}.journal.yaml`)], env);
      expect([o.code, o.err]).toEqual([0, '']);
      expect(o.out + '\n').toBe(readFileSync(join(G, `${name}.seed${seed}.log`), 'utf8'));
    });
  }

  it('M3 step 0 demo: at 3 HP next to two foes, --explain ranks the self-heal first and it targets itself', () => {
    const scen = join(G, 'low-hp-self-heal.yaml');
    const o = runRun([scen, '--journal', join(G, 'low-hp-self-heal.journal.yaml'), '--explain', 'pc1'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toMatch(/pc1 chooses cast:healing-word@\d+  \[greedy @0\]\n    why: [^\n]*\n      > cast:healing-word@/);
    expect(o.out).toMatch(/pc1 chooses target:pc1/);
  });

  it('Stunning Strike: "once per turn" when you hit, the CON save, and Stunned "until the start of your next turn" (srd-raw.txt:11201-11210)', () => {
    const scen = join(G, 'monk-stunning-strike.yaml');
    const journal = join(G, 'monk-stunning-strike.journal.yaml');
    const out = runRun([scen, '--journal', journal], env).out;
    const lines = out.split('\n');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    // Round 1: two Unarmed Strike hits; only the first is offered the rider (one decision there).
    const r1 = lines.slice(at(/== round 1 ==/), at(/== round 2 ==/));
    expect(r1.filter((l) => /pc1 Unarmed Strike -> boss1: .* hit/.test(l))).toHaveLength(2);
    expect(r1.filter((l) => /pc1 chooses (rider:|pass  \[journal @[23]\])/.test(l))).toEqual([expect.stringContaining('rider:stunning-strike')]);
    expect(out).toMatch(/pc1 spends Monk's Focus \(5 left\)/);
    expect(out).toMatch(/boss1 CON save vs Stunning Strike: d20 4 \+0 = 4 vs DC 14, fail/); // 8 + WIS 3 + PB 3
    expect(out).toMatch(/Stunned on boss1\n.*boss1 is Incapacitated/);
    // The Stunned Boss's turn: Incapacitated, it takes no action (the journal's pass was legal; no attack was).
    expect(out).toMatch(/boss1's turn \(D3, 7 HP, 30 ft\) \[Goblin Boss\]\n.*boss1 chooses pass/);
    // Stunned ends as the Monk's next turn starts, not at the Boss's own turn.
    expect(out).toMatch(/== round 2 ==\n.*Stunned on boss1 ends \(expired\)\n.*\n.*\n.*pc1's turn/);
    // A new turn: the Shortsword (a Monk weapon) hit is offered Stunning Strike again (and passes).
    expect(out).toMatch(/pc1 Shortsword -> boss1: d20 13 \+6 = 19 vs AC 17, hit .*\n.*pc1 chooses pass  \[journal @12\]/);
    const why = runRun([scen, '--journal', journal, '--why', '19'], env).out;
    expect(why).toMatch(/#19 boss1 is Stunned[^\n]*\n  <- #13 pc1: Stunning Strike\n  <- #12 pc1 chooses rider:stunning-strike/);
  });

  it('Deflect Attacks: a Reaction when a hit\'s damage includes Bludgeoning, Piercing or Slashing, reduced by 1d10 + DEX + Monk level (srd-raw.txt:11154-11158)', () => {
    const out = runRun([join(G, 'monk-deflect.yaml'), '--journal', join(G, 'monk-deflect.journal.yaml')], env).out;
    expect(out.match(/pc1 reacts to gob1's hit: Deflect Attacks reduces the damage by (\d+)/g)).toEqual(['pc1 reacts to gob1\'s hit: Deflect Attacks reduces the damage by 12', 'pc1 reacts to gob1\'s hit: Deflect Attacks reduces the damage by 14']);
    expect(out).toMatch(/pc1 takes 0 \(8 slashing\), HP 51 -> 51/);
    // Fire only: no hitTaken decision, the damage lands in full.
    expect(out).toMatch(/caster Hurl Flame -> pc1: [^\n]* hit [^\n]*\n\s+#\d+\s+pc1 takes 9 \(9 fire\), HP 51 -> 42/);
    // Round 2: Reaction spent on gob1's hit, so gob2's Piercing crit offers nothing.
    expect(out).toMatch(/gob2 Shortbow -> pc1: [^\n]* CRITICAL HIT [^\n]*\n\s+#\d+\s+pc1 takes 5 \(5 piercing, crit\)/);
  });

  it('mastery-sampler: the 8 Mastery Properties (srd-raw.txt:20406-20467) and the Light property\'s extra attack (20339-20349), each line as its rule text says', () => {
    const scen = join(G, 'mastery-sampler.yaml');
    const journal = join(G, 'mastery-sampler.journal.yaml');
    const out = runRun([scen, '--journal', journal], env).out;
    const once = (re: RegExp) => expect(out.match(new RegExp(re.source, 'g')) ?? []).toHaveLength(1);
    // Sap: "that creature has Disadvantage on its next attack roll before the start of your next turn".
    expect(out).toMatch(/pc2 Mace -> ogre2: [^\n]* hit [^\n]*\n[^\n]*pc2: Sap \(Mace\)/);
    expect(out).toMatch(/Sapped on ogre2 ends \(used\)\n[^\n]*ogre2 Greatclub -> pc2: d20 18\/7 dis -> 7 \(-mastery-mace\/sapped\)/);
    // Push: "up to 10 feet straight away from yourself if it is Large or smaller" (an Ogre is Large).
    expect(out).toMatch(/ogre2 is pushed G5 -> H5 \(5 ft, forced\)\n[^\n]*ogre2 is pushed H5 -> I5 \(5 ft, forced\)\n[^\n]*ogre2's forced move ends at I5/);
    // Cleave: a second creature within 5 feet of the first and in reach; no ability modifier (2d12 on the crit, no +3).
    expect(out).toMatch(/pc2: Cleave \(Greataxe\)\n[^\n]*ogre3 takes 10 [^\n]*\n[^\n]*pc2 Greataxe -> ogre4: [^\n]*CRITICAL HIT[^\n]*\n[^\n]*ogre4 takes 13 \(13 slashing, crit\)/);
    // Graze: on a miss, damage equal to the attack's ability modifier (STR 3), the weapon's type.
    expect(out).toMatch(/pc2 Greatsword -> ogre3: d20 1 \+6 = 7 vs AC 11, miss[^\n]*\n[^\n]*pc2: Graze \(Greatsword\)\n[^\n]*ogre3 takes 3 \(3 slashing\) from Graze \(Greatsword\)/);
    // Vex: Advantage on your next attack roll against that creature; Nick: the Light extra attack as part of the Attack action.
    expect(out).toMatch(/pc1: Nick \(Scimitar\)\n[^\n]*Vexed on ogre1 ends \(used\)\n[^\n]*pc1 Scimitar -> ogre1: d20 10\/13 adv -> 13 \(\+mastery-shortsword\/vexed\)/);
    expect(out).toMatch(/pc1 Scimitar -> ogre1: d20 10\/13 [^\n]*\n[^\n]*ogre1 takes 3 \(3 slashing\), HP 59 -> 56/); // no ability modifier
    // Thrown: drawn as part of the attack; the Javelin leaves the hand. Slow: Speed -10 until the start of your next turn.
    expect(out).toMatch(/pc1 draws Javelin\n[^\n]*pc1 Javelin \(thrown\) -> ogre1: d20 20\/9 dis -> 9 \(-ranged-adjacent\)/);
    expect(out).toMatch(/pc1: Slow \(Javelin\)\n[^\n]*Slowed on ogre1/);
    expect(out).toMatch(/ogre1's turn \(C2, 39 HP, 30 ft\) \[Ogre\]/);
    expect(out).toMatch(/Slowed on ogre1 ends \(expired\)\n[^\n]*pc1's turn \(B2/);
    // Topple: CON save at DC 8 + STR 3 + PB 3; Prone on a failure.
    expect(out).toMatch(/ogre1 CON save vs Topple \(Maul\): d20 4 \+3 = 7 vs DC 14, fail[^\n]*\n[^\n]*ogre1 is Prone \(mastery-maul\)/);
    // Light as a Bonus Action, with no ability modifier (1d6 = 5 here, not 5 + 3).
    expect(out).toMatch(/pc1: Light extra attack\n[^\n]*pc1 chooses attack:shortsword>ogre1[^\n]*\n[^\n]*pc1 Shortsword -> ogre1: [^\n]*hit[^\n]*\n[^\n]*ogre1 takes 5 \(5 piercing\), HP 29 -> 24/);
    for (const m of [/pc2: Sap/, /pc2: Push/, /pc2: Cleave/, /pc2: Graze/, /pc1: Topple/, /pc1: Nick/, /pc1: Light extra attack/, /pc1: Slow/]) once(m);
    // An automatic rider (no decision) is caused by its trigger, like an asked one: Sapped <- Sap <- the hit.
    const why = runRun([scen, '--journal', journal, '--why', '18'], env).out;
    expect(why).toMatch(/#18 Sapped on ogre2\n  <- #16 pc2: Sap \(Mace\)\n  <- #15 pc2 Mace -> ogre2: [^\n]* hit/);
  });

  it('Moonbeam moved onto a creature saves once that turn, and again when the creature ends its own turn in it', () => {
    const out = runRun([join(G, 'moonbeam-moved-then-turn-end.yaml'), '--journal', join(G, 'moonbeam-moved-then-turn-end.journal.yaml')], env).out;
    expect(out).toMatch(/Moonbeam moves A7 -> H3; caught knight\n.*knight CON save vs Moonbeam/);
    expect(out.match(/knight CON save vs Moonbeam/g)).toHaveLength(2);
  });

  it('a broken concentration ends the spell, then its zone, then the marks the zone put on creatures', () => {
    const out = runRun([join(G, 'conc-break-cascade.yaml'), '--journal', join(G, 'conc-break-cascade.journal.yaml')], env).out;
    expect(out).toMatch(/breaks[^\n]*\n[^\n]*Concentration Ward \(pc1\) ends \(concentration broken\)\n[^\n]*Ward ends \(its source ended\)\n[^\n]*on gob1 ends[^\n]*\n[^\n]*on gob2 ends/);
  });

  it('seed 1: the opportunity attack drops gob1 before it leaves D1', () => {
    const out = runRun([SCEN, '--seed', '1', '--journal', JOURNAL], env).out;
    expect(out).toMatch(/gob1 leaves ally1's reach D1 -> E2/);
    expect(out).toMatch(/gob1's move ends at D1: died, 2 of 4 steps/);
    expect(out).not.toMatch(/gob1 steps D1 -> E2/);
  });

  it('seed 2: gob1 survives the opportunity attack and finishes its move', () => {
    expect(runRun([SCEN, '--seed', '2', '--journal', JOURNAL], env).out).toMatch(/gob1's move ends at F3$/m);
  });

  it('--why walks a line back to the decision behind it', () => {
    const o = runRun([SCEN, '--seed', '1', '--journal', JOURNAL, '--why', '13'], env);
    expect(o.out.split('\n').map((l) => l.trim().replace(/^<- /, '').split(' ')[0])).toEqual(['#13', '#12', '#11', '#10', '#7', '#6']);
  });
});

describe('montecrit run exit codes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'montecrit-run-'));

  it('the header says when pre-roll reactions skip initiative, and that ending an effect waits for your own turn', () => {
    const p = join(tmp, 'seer.yaml');
    const units = "units:\n  - { seat: seer1, team: party, use: 'test:sample-seer', at: A1 }\n  - { seat: gob1, team: enemies, use: 'srd:goblin-warrior', at: H1 }\n";
    writeFileSync(p, readFileSync(join(G, 'pull-into-spikes.yaml'), 'utf8').replace(/units:[\s\S]*$/, units));
    const o = runRun([p, '--seed', '1'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    const head = o.out.split('\n\n')[0]!;
    expect(head).toMatch(/initiative rolls: pre-roll reactions are not offered on them/);
    expect(head).toMatch(/ending concentration or dismissing an effect: offered only on your own turn/);
    const plain = runRun([SCEN, '--seed', '1', '--journal', JOURNAL], env).out.split('\n\n')[0]!;
    expect(plain).not.toMatch(/pre-roll|dismissing/);
  });

  it('a bare name runs ~/.montecrit/scenarios/<name>.yaml first, and a scenario there can extend a repo one', () => {
    const home = mkdtempSync(join(tmpdir(), 'montecrit-ext-'));
    mkdirSync(join(home, 'scenarios'));
    writeFileSync(join(home, 'scenarios', 'stars-ambush.yaml'), "kind: scenario\nid: stars-ambush-mine\nextends: stars-ambush\nknobs: { maxRounds: 1 }\noverride:\n  units:\n    gob1: { at: A1 }\n");
    const o = runRun(['stars-ambush', '--seed', '3'], { MONTECRIT_HOME: home });
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toMatch(/scenario stars-ambush-mine /);
    expect(o.out).toMatch(/notes    scenario file: .*stars-ambush\.yaml \(extends scenarios\/stars-ambush\.yaml\)/);
    expect(o.out).toMatch(/fight ends: stalemate in round 1/);
    const plain = runRun(['stars-ambush', '--seed', '3'], env); // an empty home: the repo's file, no file note
    expect(plain.out).toMatch(/scenario stars-ambush /);
    expect(plain.out).not.toMatch(/scenario file:/);
  });

  it('--explain prints the greedy AI\'s top options under each of that seat\'s turn decisions', () => {
    const o = runRun([join(G, 'stars-ambush-greedy.yaml'), '--journal', join(G, 'stars-ambush-greedy.journal.yaml'), '--explain', 'pc1'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toMatch(/pc1 chooses cast:\S+ +\[greedy @\d+\]\n +why: best of \d+ scored\n +> cast:\S+ +[-+]\d+\.\d\d = program value/);
    expect(o.out.match(/why:/g)!.length).toBe(o.out.match(/pc1 chooses (?!target|place|pick|pull)\S+ +\[greedy/g)!.length); // pc1's turn decisions only
    expect(runRun([join(G, 'stars-ambush-greedy.yaml'), '--explain', 'nobody'], env).err).toMatch(/no seat "nobody"/);
  });

  it('--policy plays the seats it covers, names itself with its hash, and refuses an unknown or unbindable one', () => {
    const o = runRun(['stars-ambush', '--policy', 'moonbeam-first', '--seed', '3', '-n', '1'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    expect(o.out).toMatch(/^policy .*pc1 moonbeam-first@[0-9a-f]{8}$/m);
    expect(o.out).toMatch(/pc1 chooses cast:moonbeam@2 +\[moonbeam-first@[0-9a-f]{8} @\d+\]/);
    expect(runRun(['stars-ambush', '--policy', 'no-such'], env).err).toMatch(/no policy "no-such" \(known: .*greedy-spendy/);
    const home = mkdtempSync(join(tmpdir(), 'montecrit-pol-'));
    mkdirSync(join(home, 'policies'));
    writeFileSync(join(home, 'policies', 'fireball-first.yaml'), "kind: policy\nid: fireball-first\nname: Fireball first\nscript:\n  - { id: open, do: { cast: 'srd:fireball' } }\n");
    expect(runRun(['stars-ambush', '--policy', 'fireball-first'], { MONTECRIT_HOME: home }).err).toMatch(/rule open: pc1 \(test:sample-druid\) has no spell srd:fireball/);
    writeFileSync(join(home, 'policies', 'broken.yaml'), 'kind: policy\nid: broken\nname: Broken\nweights: { boldness: 3 }\n');
    const lint = runLint([], { MONTECRIT_HOME: home });
    expect(lint.code).toBe(1);
    expect(lint.out).toMatch(/broken\.yaml.*weights/);
  });

  it('a journal that runs out stops with the legal keys and exit 3', () => {
    const text = readFileSync(SCEN, 'utf8').replace("use: 'srd:goblin-warrior', at: B2, hp: 4 }", "use: 'srd:goblin-warrior', at: B2, hp: 4, decider: journal }");
    const p = join(tmp, 'needs.yaml');
    writeFileSync(p, text);
    const o = runRun([p, '--seed', '1'], env);
    expect(o.code).toBe(3);
    expect(o.err).toMatch(/needs input: gob1 \(turn @0\)/);
    expect(o.err).toMatch(/move:F3\/p1/);
  });

  it('a journal entry that isn\'t legal is a mismatch, exit 2', () => {
    const p = join(tmp, 'bad.journal.yaml');
    writeFileSync(p, readFileSync(JOURNAL, 'utf8').replace('move:F3/p1', 'move:F3/p0'));
    const o = runRun([SCEN, '--seed', '1', '--journal', p], env);
    expect(o.code).toBe(2);
    expect(o.err).toMatch(/isn't legal now/);
  });

  const hash = (s: string) => /logHash (\w+)/.exec(s)![1];

  it('--record writes a journal that replays the fight exactly, at its own seed by default', () => {
    const rec = join(tmp, 'rec.yaml');
    const a = runRun([SCEN, '--seed', '7', '--record', rec], env);
    const entries = readFileSync(rec, 'utf8').split('\n').filter((l) => l.trim().startsWith('- {'));
    expect(entries.length).toBeGreaterThan(3);
    const b = runRun([SCEN, '--journal', rec], env); // no --seed: the journal's
    expect(b.err).toBe('');
    expect(hash(b.out)).toBe(hash(a.out));
  });

  it('a recorded journal refuses a different seed; a changed scenario or extra knob is a warning', () => {
    const rec = join(tmp, 'rec2.yaml');
    runRun([SCEN, '--seed', '9', '--record', rec], env);
    expect(runRun([SCEN, '--journal', rec, '--seed', '10'], env).code).toBe(2);
    const k = runRun([SCEN, '--journal', rec, '--knob', 'maxRounds=19'], env);
    expect(k.err).toMatch(/scenario, flags or knobs differ/);
  });

  it('seats are quoted in recorded journals, so odd names read back', () => {
    const p = join(tmp, 'odd.yaml');
    writeFileSync(p, readFileSync(SCEN, 'utf8').replace('seat: gob2', 'seat: "null"'));
    const rec = join(tmp, 'odd.journal.yaml');
    const a = runRun([p, '--seed', '4', '--record', rec], env);
    expect(a.code).toBe(0);
    expect(hash(runRun([p, '--journal', rec], env).out)).toBe(hash(a.out));
  });

  it('bad paths are usage errors (exit 2), and nothing is written on a failed run', () => {
    expect(runRun([SCEN, '--journal', join(tmp, 'missing.yaml')], env).code).toBe(2);
    expect(runRun([SCEN, '--record', join(tmp, 'no', 'such', 'dir.yaml')], env).code).toBe(2);
    expect(() => runRun([SCEN, '--run', '4294967296'], env)).toThrow(/--run/);
    expect(() => runRun([SCEN, '--json', '--update-golden', join(G, 'x.log')], env)).toThrow(/update-golden/);
  });

  it('--update-golden never overwrites its own scenario or journal, and only writes .log files', () => {
    expect(runRun([SCEN, '--journal', JOURNAL, '--update-golden', SCEN], env).code).toBe(2);
    expect(runRun([SCEN, '--journal', JOURNAL, '--update-golden', JOURNAL], env).code).toBe(2);
    expect(readFileSync(SCEN, 'utf8')).toMatch(/^# M1a demo/);
  });

  it('-n > 1 needs an AI on every seat: a journal-only seat is refused, not half-run', () => {
    const p = join(tmp, 'journal-seat.yaml');
    writeFileSync(p, readFileSync(SCEN, 'utf8').replace("use: 'srd:goblin-warrior', at: B2, hp: 4 }", "use: 'srd:goblin-warrior', at: B2, hp: 4, decider: journal }"));
    const o = runRun([p, '-n', '10'], env);
    expect(o.code).toBe(2);
    expect(o.err).toMatch(/is decider journal with no fallback; Monte Carlo runs have no journal/);
  });
});

describe('private content never reaches the repo through run', () => {
  // A throwaway private pack in a temp home. The namespace is assembled at run time so this
  // file itself carries no private id for check-private to flag.
  const NS = ['pri', 'vate'].join('');
  const home = mkdtempSync(join(tmpdir(), 'montecrit-priv-'));
  mkdirSync(join(home, 'packs', 'p'), { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'packs:\n  - packs/p\n');
  writeFileSync(join(home, 'packs', 'p', 'manifest.yaml'), `kind: manifest\npack: p\nversion: '1'\nrules: '2024'\nnamespace: ${NS}\nlicense: ${NS}\n`);
  writeFileSync(
    join(home, 'packs', 'p', 'brute.yaml'),
    readFileSync(join(REPO_ROOT, 'packs', 'test', 'monsters', 'reach-brute.yaml'), 'utf8').replace('id: test:reach-brute', `id: ${NS}:brute`),
  );
  const scen = join(home, 'scene.yaml');
  writeFileSync(scen, `kind: scenario\nid: priv-scene\nname: Private scene\nrules: '2024'\npacks: [test, p]\ngrid: { w: 6, h: 2 }\nunits:\n  - { seat: a, team: party, use: '${NS}:brute', at: A1 }\n  - { seat: b, team: enemies, use: 'test:reach-brute', at: F1 }\n`);
  const penv = { MONTECRIT_HOME: home };

  it('--record into the repo refuses a fight that uses private content; outside the repo it works', () => {
    const inside = join(REPO_ROOT, 'scenarios', 'priv-test.journal.yaml');
    const o = runRun([scen, '--record', inside], penv);
    expect(o.code).toBe(2);
    expect(o.err).toMatch(/private content/);
    expect(existsSync(inside)).toBe(false);
    const outside = join(home, 'rec.journal.yaml');
    expect(runRun([scen, '--record', outside], penv).code).toBe(0);
    expect(existsSync(outside)).toBe(true);
  });
});
