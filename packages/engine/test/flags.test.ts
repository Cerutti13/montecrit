// The RuleFlags table: every flag has a default, a source and a verified bit, and the
// defaults are the ones the rules write-ups settled on.
import { describe, expect, it } from 'vitest';
import { assertImplemented, DEFAULT_FLAGS, describeFlags, FLAG_INFO, FLAG_KEYS, flagIndex, hashedFlags, parseFlagValue, PRE_AREA_FLAG_COUNT, PRE_E_FLAG_COUNT, trimLateFlags, type RuleFlags } from '../src/rules/flags.ts';
import { createContext } from '../src/sim/fight.ts';
import { flagsUsedKeys, stateHash } from '../src/sim/state.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { DUMMY, setup } from './helpers/build.ts';

describe('the flag table', () => {
  it('lists 51 flags, each once, with its default among its options', () => {
    // W1 appended freeMoveUsesMovement and frenzyRageCheck (test/w1-shapes.test.ts); step E thrownWeaponLands.
    expect(FLAG_KEYS).toHaveLength(51);
    expect(new Set(FLAG_KEYS).size).toBe(51);
    for (const k of FLAG_KEYS) {
      const info = FLAG_INFO[k] as (typeof FLAG_INFO)[keyof RuleFlags];
      expect((info.options as readonly unknown[]).includes(info.default), k).toBe(true);
      expect(DEFAULT_FLAGS[k], k).toBe(info.default);
      expect(info.source.length, k).toBeGreaterThan(20);
      expect((info.unimplemented as readonly unknown[] | undefined)?.includes(info.default) ?? false, `${k}: its default must be implemented`).toBe(false);
      expect(flagIndex(k)).toBe(FLAG_KEYS.indexOf(k));
    }
  });

  it('M3 step 5a flags: each with the question it answers and its PDF lines; riderDiceCritDouble verified by the Sneak Attack example (2210-2211)', () => {
    expect(FLAG_KEYS.slice(35, 38)).toEqual(['flyingAvoidsGroundZones', 'riderDiceCritDouble', 'reduceBeforeResistance']);
    for (const k of ['flyingAvoidsGroundZones', 'riderDiceCritDouble', 'reduceBeforeResistance'] as const) {
      expect(FLAG_INFO[k].verified, k).toBe(k === 'riderDiceCritDouble');
      expect(FLAG_INFO[k].source, k).toMatch(/srd-raw\.txt:\d+-\d+/);
    }
    // No altitude on the grid: a flier is on the ground until heights exist.
    expect(FLAG_INFO.flyingAvoidsGroundZones.unimplemented).toEqual([true]);
    expect(() => assertImplemented({ ...DEFAULT_FLAGS, flyingAvoidsGroundZones: true })).toThrow(/isn't implemented/);
    // "Critical Hits": other damage dice involved in the attack are rolled twice (2210-2211).
    expect(DEFAULT_FLAGS.riderDiceCritDouble).toBe(true);
    // "Order of Application": adjustments first, then Resistance, then Vulnerability (2261-2264).
    expect(DEFAULT_FLAGS.reduceBeforeResistance).toBe(true);
  });

  it('W1: freeMoveUsesMovement\'s true option says what freeMove does: out of the movement only on the mover\'s own turn; off its turn (Withdraw on an OA) it spends none, capped at half Speed [U]', () => {
    const src = FLAG_INFO.freeMoveUsesMovement.source;
    const t = src.slice(src.indexOf('true ='));
    expect(t).toMatch(/^true = on the mover's own turn its feet come out of the turn's movement/);
    expect(t).toMatch(/off its turn \(Withdraw on an Opportunity Attack\) there is no turn's movement, so it spends none and is capped at half Speed \[U\]/);
    expect(describeFlags({ ...DEFAULT_FLAGS, freeMoveUsesMovement: true }, ['freeMoveUsesMovement'])[0]).toContain('spends none');
  });

  it("M3 step 8'a: splitActions [U] defaults to the engine before it (allowed), unverified, cites 1878-1883 and 32713-32717, and stays out of the scenario hash at its default", () => {
    expect(FLAG_KEYS[40]).toBe('splitActions');
    expect(FLAG_INFO.splitActions).toMatchObject({ default: 'allowed', options: ['allowed', 'notAllowed'], verified: false });
    expect(FLAG_INFO.splitActions.source).toMatch(/srd-raw\.txt:1878-1883/);
    expect(FLAG_INFO.splitActions.source).toMatch(/32713-32717/);
    expect('splitActions' in hashedFlags(DEFAULT_FLAGS)).toBe(false);
    expect(hashedFlags({ ...DEFAULT_FLAGS, splitActions: 'notAllowed' }).splitActions).toBe('notAllowed');
    expect(describeFlags(DEFAULT_FLAGS, ['splitActions'])[0]).toMatch(/^splitActions=allowed \[UNVERIFIED: /);
  });

  describe('coverage step 7: selfAreaOrigin, emanationReach and emanationCastTrigger', () => {
    const LATE = ['selfAreaOrigin', 'emanationReach', 'emanationCastTrigger'] as const;
    const OTHER = { selfAreaOrigin: 'squareEdge', emanationReach: 'radial', emanationCastTrigger: 'onCast' } as const;

    it('appended after every earlier flag, unverified, each citing the text that leaves it open', () => {
      expect(PRE_AREA_FLAG_COUNT).toBe(41);
      expect(FLAG_KEYS.slice(PRE_AREA_FLAG_COUNT, PRE_AREA_FLAG_COUNT + 3)).toEqual([...LATE]);
      expect(DEFAULT_FLAGS).toMatchObject({ selfAreaOrigin: 'squareCenter', emanationReach: 'gridDistance', emanationCastTrigger: 'none' });
      for (const k of LATE) {
        expect(FLAG_INFO[k].verified, k).toBe(false);
        expect(FLAG_INFO[k].source, k).toMatch(/srd-raw\.txt:\d+-\d+/);
      }
    });

    it('each stays out of the scenario hash at its default and goes in at any other value', () => {
      for (const k of LATE) {
        expect(k in hashedFlags(DEFAULT_FLAGS), k).toBe(false);
        expect(hashedFlags({ ...DEFAULT_FLAGS, [k]: OTHER[k] })[k], k).toBe(OTHER[k]);
      }
      expect(Object.keys(hashedFlags(DEFAULT_FLAGS)).sort()).toEqual(FLAG_KEYS.slice(0, PRE_AREA_FLAG_COUNT).filter((k) => k !== 'splitActions').sort());
      // Coverage step 9's three flags (below) stay out at their defaults too.
      // hashedFlags leaves its argument alone.
      const f = { ...DEFAULT_FLAGS };
      hashedFlags(f);
      expect(f).toEqual(DEFAULT_FLAGS);
    });

    it('onCast is built (7.5), like the other two', () => {
      expect(() => assertImplemented({ ...DEFAULT_FLAGS, emanationCastTrigger: 'onCast' })).not.toThrow();
      expect(() => assertImplemented({ ...DEFAULT_FLAGS, selfAreaOrigin: 'squareEdge', emanationReach: 'radial' })).not.toThrow();
    });

    it('a per-flag array keeps its old length while no step 7 flag was read', () => {
      const used = new Uint8Array(FLAG_KEYS.length);
      expect(trimLateFlags(used)).toHaveLength(41);
      used[flagIndex('splitActions')] = 1;
      expect(trimLateFlags(used)).toHaveLength(41);
      for (const k of LATE) {
        const u = new Uint8Array(FLAG_KEYS.length);
        u[flagIndex(k)] = 1;
        // W1: its pre-W1 length (48) while no W1 flag was read (test/w1-shapes.test.ts).
        expect(trimLateFlags(u), k).toHaveLength(48);
      }
    });

    it('stateHash is as it was at 38 and at 41 flags, and moves only when a step 7 flag was read', () => {
      const s = setup({ w: 4, h: 4, units: [{ seat: 'a', team: 0, tpl: DUMMY, at: 'A1' }, { seat: 'b', team: 1, tpl: DUMMY, at: 'D4' }] });
      const st = createContext(s, 1, 0, makeDeciders(s), null).st;
      const withUsed = (used: Uint8Array) => stateHash({ ...st, flagsUsed: used });
      const at = (n: number, read: (keyof RuleFlags)[] = []) => {
        const u = new Uint8Array(n);
        for (const k of read) u[flagIndex(k)] = 1;
        return u;
      };
      expect(withUsed(at(44))).toBe(withUsed(at(38)));
      expect(withUsed(at(44, ['losMethod']))).toBe(withUsed(at(41, ['losMethod'])));
      expect(withUsed(at(44, ['selfAreaOrigin']))).not.toBe(withUsed(at(44)));
      expect(flagsUsedKeys(at(44, ['emanationReach']))).toEqual(['emanationReach']);
    });
  });

  it('M1b defaults match docs/research/m1b-rules-2024.md', () => {
    expect(DEFAULT_FLAGS).toMatchObject({
      focusHandSomatic: 'strict',
      conjuredHandEffectBlocksHand: false,
      concentrationSaveGrouping: 'perDamageEvent',
      concentrationSaveOnZeroDamage: 'noSave',
      timedDurationExpiryPoint: 'startOfCreatorTurn',
      deadAnchorTurnBoundary: 'keepInitiativeSlot',
      nextRollRiderConsumedWhenRedundant: 'consumed',
      selfTargetWhenTextSilent: 'allowed',
      areaOriginOnGrid: 'squareCenter',
      areaGridCoverage: 'atLeastHalfSquare',
      areaSaveGroupingPerEvent: 'groupByEvent',
      movedAreaTriggersAlongPath: 'sweepPath',
      involuntaryMovementTriggersArea: true,
      perDistanceDamageRolls: 'perIncrement',
      areaExitStepCounts: false,
      forcedMovementPath: 'eachStepCloser',
      forcedMovementObstacle: 'stopBefore',
      forcedMovementTerrainCost: 'ignoresTerrain',
      losingSpellSourceEndsActiveSpell: false,
      unconsciousDropsShield: true,
    });
    // Only the somatic-hand rule is settled by a 2024 primary source.
    expect(FLAG_INFO.focusHandSomatic.verified).toBe(true);
    expect(FLAG_INFO.areaOriginOnGrid.verified).toBe(false);
  });

  it('options not built yet are rejected, and parse with their real types', () => {
    expect(() => assertImplemented({ ...DEFAULT_FLAGS, ...parseFlagValue('pauseInOccupiedSpace', 'true') })).toThrow(/isn't implemented/);
    expect(parseFlagValue('involuntaryMovementTriggersArea', 'false')).toEqual({ involuntaryMovementTriggersArea: false });
    expect(describeFlags(DEFAULT_FLAGS, ['areaOriginOnGrid'])[0]).toMatch(/^areaOriginOnGrid=squareCenter \[UNVERIFIED: Shane's table ruling/);
  });
  describe('coverage step 9: searchSkill, hiddenHazardRevealedByDamage, hiddenHazardPartialViewCountsAsSeen', () => {
    const NINE = ['searchSkill', 'hiddenHazardRevealedByDamage', 'hiddenHazardPartialViewCountsAsSeen'] as const;
    const OTHER = { searchSkill: 'perception', hiddenHazardRevealedByDamage: true, hiddenHazardPartialViewCountsAsSeen: false } as const;
    it('appended last, unverified, each citing the text (or saying there is none), out of the scenario hash at its default', () => {
      expect(FLAG_KEYS.slice(-7, -4)).toEqual([...NINE]); // then step 9+'s, W1's two and step E's
      expect(DEFAULT_FLAGS).toMatchObject({ searchSkill: 'best', hiddenHazardRevealedByDamage: false, hiddenHazardPartialViewCountsAsSeen: true });
      for (const k of NINE) {
        expect(FLAG_INFO[k].verified, k).toBe(false);
        expect(FLAG_INFO[k].source, k).toMatch(/srd-raw\.txt:\d+-\d+/);
        expect(k in hashedFlags(DEFAULT_FLAGS), k).toBe(false);
        expect(hashedFlags({ ...DEFAULT_FLAGS, [k]: OTHER[k] })[k], k).toBe(OTHER[k]);
        expect(describeFlags(DEFAULT_FLAGS, [k])[0], k).toMatch(new RegExp(`^${k}=\\S+ \\[UNVERIFIED: `));
      }
      expect(() => assertImplemented({ ...DEFAULT_FLAGS, ...OTHER })).not.toThrow();
    });
    it('a per-flag array that read none of them keeps its old length', () => {
      const used = new Uint8Array(FLAG_KEYS.length);
      expect(trimLateFlags(used)).toHaveLength(PRE_AREA_FLAG_COUNT);
    });
  });

  describe('coverage step 9+: swapProvokesOpportunityAttacks (Redirect Attack\'s swap; the text is silent, critique M4)', () => {
    it('appended last, unverified, citing the swap text and the Opportunity Attack exemption, default false, true not implemented, out of the scenario hash at its default', () => {
      expect(FLAG_KEYS.at(-4)).toBe('swapProvokesOpportunityAttacks'); // then W1's two and step E's
      const f = FLAG_INFO.swapProvokesOpportunityAttacks;
      expect([f.default, f.verified, f.unimplemented]).toEqual([false, false, [true]]);
      expect(f.source).toMatch(/srd-raw\.txt:48831-48834/);
      expect(f.source).toMatch(/srd-raw\.txt:2091-2093/);
      expect('swapProvokesOpportunityAttacks' in hashedFlags(DEFAULT_FLAGS)).toBe(false);
      expect(() => assertImplemented({ ...DEFAULT_FLAGS, swapProvokesOpportunityAttacks: true })).toThrow();
      expect(describeFlags(DEFAULT_FLAGS, ['swapProvokesOpportunityAttacks'])[0]).toMatch(/^swapProvokesOpportunityAttacks=false \[UNVERIFIED: /);
    });
  });
});

describe('step E: thrownWeaponLands (where a thrown weapon lands; the Thrown property is silent)', () => {
  it('appended last, unverified, citing the Thrown property and the self-returning Flame Spear, default targetSquare, out of the scenario hash at its default', () => {
    expect(FLAG_KEYS.at(-1)).toBe('thrownWeaponLands');
    const f = FLAG_INFO.thrownWeaponLands;
    expect([f.default, f.verified, f.unimplemented, f.options]).toEqual(['targetSquare', false, undefined, ['targetSquare', 'gone']]);
    expect(f.source).toMatch(/srd-raw\.txt:20386-20391/);
    expect(f.source).toMatch(/53417-53419/);
    expect('thrownWeaponLands' in hashedFlags(DEFAULT_FLAGS)).toBe(false);
    expect(hashedFlags({ ...DEFAULT_FLAGS, thrownWeaponLands: 'gone' }).thrownWeaponLands).toBe('gone');
    expect(() => assertImplemented({ ...DEFAULT_FLAGS, thrownWeaponLands: 'gone' })).not.toThrow();
    expect(describeFlags(DEFAULT_FLAGS, ['thrownWeaponLands'])[0]).toMatch(/^thrownWeaponLands=targetSquare \[UNVERIFIED: /);
  });

  it('the trim tiers: 41 with no later flag read, 48 with a step 7 to 9+ flag, 50 with a W1 flag, 51 only once thrownWeaponLands was read', () => {
    expect(PRE_E_FLAG_COUNT).toBe(50);
    const read = (k: keyof RuleFlags | null) => {
      const u = new Uint8Array(FLAG_KEYS.length);
      if (k) u[flagIndex(k)] = 1;
      return trimLateFlags(u).length;
    };
    expect([read(null), read('swapProvokesOpportunityAttacks'), read('frenzyRageCheck'), read('thrownWeaponLands')]).toEqual([41, 48, 50, 51]);
  });
});
