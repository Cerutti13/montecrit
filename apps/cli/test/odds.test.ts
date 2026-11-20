import { describe, expect, it } from 'vitest';
import { UsageError, parseOddsArgs, runOdds } from '../src/odds.ts';

const p = (args: string) => parseOddsArgs(args.split(' '));
const out = (args: string) => runOdds(args.split(' ')).text;

describe('montecrit odds', () => {
  it('the M0 demo: +5 with Guidance vs DC 15 is 67.50%', () => {
    expect(out('--mod 5 --guidance --dc 15')).toContain('67.50%');
  });

  it('--adv and --dis together cancel to a straight roll', () => {
    expect(p('--mod 5 --dc 15 --adv --dis').spec.adv).toBe('none');
    expect(out('--mod 5 --dc 15 --adv --dis')).toContain('55.00%');
  });

  it('--bardic d6 reports the pass chance and how often the die gets spent', () => {
    const text = out('--mod 5 --dc 15 --bardic d6');
    expect(text).toContain('72.50%');
    expect(text).toMatch(/1d6 gets spent\s+45\.00%/);
  });

  it('attacks use --ac and report crits', () => {
    const text = out('--attack --mod 5 --ac 15 --crit 19');
    expect(text).toMatch(/P\(hit\)\s+55\.00%/);
    expect(text).toMatch(/P\(crit\)\s+10\.00%/);
  });

  it('--verify cross-checks against sampled rolls', () => {
    const r = runOdds('--mod 5 --guidance --dc 15 --verify 20000'.split(' '));
    expect(r.text).toMatch(/agrees within 4 sigma/);
    expect(r.agrees).toBe(true);
  });

  it('--verify on a certain success agrees instead of printing NaN', () => {
    const r = runOdds('--save --mod 2 --dc 10 --floor 10 --verify 5000'.split(' '));
    expect(r.text).toMatch(/100\.00%, z = 0\.00, agrees/);
    expect(r.agrees).toBe(true);
    const j = JSON.parse(runOdds('--mod 5 --dc 5 --json --verify 100'.split(' ')).text);
    expect(j.pSuccess).toBeLessThanOrEqual(1);
    expect(j.verify.z).toBe(0);
  });

  it('prints the rule flags it relied on, with their verified mark', () => {
    expect(out('--mod 5 --dc 15')).toMatch(/natOnChecksAndSaves=none \[verified/);
    expect(out('--attack --mod 5 --ac 15')).toMatch(/expandedCritAutoHits=false \[UNVERIFIED/);
  });

  it('--flag overrides a rule flag', () => {
    expect(p('--dc 25 --flag natOnChecksAndSaves=autoPassFail').flags.natOnChecksAndSaves).toBe('autoPassFail');
    expect(() => p('--dc 25 --flag nope=1')).toThrow(UsageError);
    expect(() => p('--dc 25 --flag natOnChecksAndSaves=maybe')).toThrow(UsageError);
    expect(() => p('--dc 25 --flag constructor=x')).toThrow(UsageError);
    expect(() => p('--dc 25 --flag toString=x')).toThrow(UsageError);
  });

  it('--json is parseable', () => {
    const j = JSON.parse(out('--mod 5 --guidance --dc 15 --json'));
    expect(j.pSuccess).toBeCloseTo(0.675, 12);
    expect(j.spec.preDice).toEqual(['1d4']);
  });

  it('negative numbers work as values', () => {
    expect(p('--mod -2 --dc 10').spec.flat).toBe(-2);
  });

  it.each([
    ['--mod 5', /need --dc/],
    ['--attack --mod 5 --dc 15', /attacks need --ac/],
    ['--mod 5 --dc 15 --ac 12', /--ac is for attacks/],
    ['--save --attack --ac 10', /pick one/],
    ['--dc 15 --crit 19', /only applies to attacks/],
    ['--dc fifteen', /whole number/],
    ['--save --guidance --dc 15', /only adds to ability checks/],
    ['--attack --guidance --ac 15', /only adds to ability checks/],
    ['--dc 15 --dice 20d20kh3', /capped/],
    ['--dc 15 --after-fail 1d4-2', /can't go negative/],
    ['--dc 15 --verify 10 --seed 9007199254740993', /up to 2\^53/],
    ['--dc 15 --verify 0', /between 1 and/],
    ['--dc 15 --verify 5000000000', /between 1 and/],
  ])('rejects %s with a usage error', (args, msg) => {
    expect(() => p(args)).toThrow(UsageError);
    expect(() => p(args)).toThrow(msg);
  });
});
