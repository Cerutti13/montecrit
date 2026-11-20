// RuleFlags: every rule the 2024 text leaves ambiguous, leaves to the GM, or that we
// haven't verified yet, is a named flag instead of a silent choice. Each flag carries where
// its default came from and whether that source has been checked. Reports print every flag
// they used, with unverified ones highlighted, so no number quietly depends on a guess.
//
// Sources are SRD 5.2.1 page numbers unless they say otherwise; the checks behind them are
// written up in docs/research/m1a-rules-2024.md and docs/research/m1b-rules-2024.md. Rules the 2024 text settles outright
// (diagonals cost 5 ft, Incapacitated leaves Speed alone, who may pass through whom,
// simultaneous effects ordered by whoever's turn it is) are plain code, not flags.

export interface RuleFlags {
  /** Do a natural 20 / natural 1 auto-pass / auto-fail ability checks and saving throws? */
  natOnChecksAndSaves: 'none' | 'autoPassFail';
  /** Does a crit from an expanded range (e.g. a natural 19 with Improved Critical) always hit? */
  expandedCritAutoHits: boolean;
  /** Grid diagonals: every square 5 ft, or the DMG's optional alternating 5/10 (movement, reach and range). */
  diagonalCost: 'uniform' | 'alternate';
  /** A diagonal step past a wall corner: blocked if either orthogonal neighbour is a wall, or only if both are. */
  diagonalCorner: 'eitherBlocks' | 'bothBlock';
  /** Initiative: rolled, or the static score (10 + mod, or a stat block's listed score). */
  initiativeMode: 'roll' | 'static';
  /** Initiative ties (the GM decides; the text gives no procedure). */
  initiativeTies: 'rollOff' | 'pcsFirst' | 'monstersFirst';
  /** Identical monsters on one side share a single initiative roll. */
  groupInitiative: 'shared' | 'individual';
  /** Monster hit points: the listed number, or a roll of the dice in parentheses. */
  monsterHp: 'listed' | 'rolled';
  /** A stat-block creature at 0 HP: dies, or falls Unconscious and makes death saves like a character. */
  statBlockAtZeroHp: 'dies' | 'deathSaves';
  /** A dead creature's square: open ground, or Difficult Terrain. */
  corpseSpace: 'clear' | 'difficult';
  /** Moving between the attacks of an Attack action: always, or only for Extra Attack (not Multiattack). */
  moveBetweenAttacks: 'all' | 'extraAttackOnly';
  /** Thrown weapons in a stat block's Gear: used up as they're thrown, or never run out. */
  monsterThrownWeapons: 'gearCount' | 'unlimited';
  /** Damage soaked entirely by temp HP at 0 HP still counts as damage (a death-save failure). */
  tempHpSoakAtZeroIsDamage: boolean;
  /** Stopping mid-turn inside a passable occupied square (an ally's) to act, then moving on. */
  pauseInOccupiedSpace: boolean;
  /** Somatic components from the hand holding a focus: only for spells that also have a Material component (strict), or for any spell. */
  focusHandSomatic: 'strict' | 'lenient';
  /** A spell effect held "in your hand" (a conjured flame) occupies that hand. */
  conjuredHandEffectBlocksHand: boolean;
  /** Concentration saves when one damage event deals several types: one save on the total, or one per type. */
  concentrationSaveGrouping: 'perDamageEvent' | 'perDamageType';
  /** Damage reduced to 0 by Resistance (not Immunity, which is settled: no save). */
  concentrationSaveOnZeroDamage: 'noSave' | 'save';
  /** Where a duration in rounds or minutes ends in initiative order. */
  timedDurationExpiryPoint: 'startOfCreatorTurn' | 'endOfCreatorTurn';
  /** "Until the start/end of its next turn" when that creature is dead: its slot still passes, or the effect ends at death. */
  deadAnchorTurnBoundary: 'keepInitiativeSlot' | 'fireOnDeath';
  /** A one-use "next attack roll has Advantage" rider on a roll that already had Advantage, or also had Disadvantage. */
  nextRollRiderConsumedWhenRedundant: 'consumed' | 'notConsumed';
  /** Effects that say "a willing creature" or "a creature you can see" without saying whether the user counts. */
  selfTargetWhenTextSilent: 'allowed' | 'notAllowed';
  /** Where a circular area's point of origin sits on the grid. */
  areaOriginOnGrid: 'squareCenter' | 'gridIntersection';
  /** Which squares a circular area covers. */
  areaGridCoverage: 'atLeastHalfSquare' | 'squareCenterInside' | 'anyOverlap';
  /** Creatures caught by one moved area save together (one damage roll) or one at a time. */
  areaSaveGroupingPerEvent: 'groupByEvent' | 'perCreature';
  /** A moved area triggers on every creature it passes over, or only where it stops. */
  movedAreaTriggersAlongPath: 'sweepPath' | 'destinationOnly';
  /** A creature pushed or pulled into or through an area triggers its enter and travel effects. */
  involuntaryMovementTriggersArea: boolean;
  /** "Damage for every 5 feet it travels": a separate damage instance per 5 ft, or one per move. */
  perDistanceDamageRolls: 'perIncrement' | 'perMove';
  /** The step from inside an area to outside counts as moving within it. */
  areaExitStepCounts: boolean;
  /** Squares a pull or push may use: any square that changes the distance the right way, or only the straight line. */
  forcedMovementPath: 'eachStepCloser' | 'straightLineOnly';
  /** A forced move reaching an occupied square: stops before it, or passes through creatures (never ending in one). */
  forcedMovementObstacle: 'stopBefore' | 'passThroughCreatures';
  /** Difficult Terrain during a forced move: ignored (feet moved are feet moved), or costs double. */
  forcedMovementTerrainCost: 'ignoresTerrain' | 'terrainShortens';
  /** Losing the item that kept a spell prepared ends that spell if it's still active. */
  losingSpellSourceEndsActiveSpell: boolean;
  /** An Unconscious creature drops its shield along with everything else it holds. */
  unconsciousDropsShield: boolean;
  zoneKnowledge: 'sawCast' | 'all' | 'none';
  /** A creature using a Fly Speed passes over zones on the ground (Spike Growth's ground, Entangle's terrain) without their enter/travel effects or Difficult Terrain. */
  flyingAvoidsGroundZones: boolean;
  /** A rider's damage dice added to an attack's hit (Sneak Attack-style "extra" dice from a rider) are rolled twice on a Critical Hit. */
  riderDiceCritDouble: boolean;
  /** A reaction that reduces a hit's damage (Deflect Attacks) applies before Resistance and Vulnerability, as an "adjustment". */
  reduceBeforeResistance: boolean;
  /** How cover and line of sight are read on the grid: corner-to-corner lines, one center-to-center line, or stubbed (no cover, everyone sees everyone). */
  losMethod: 'corners' | 'centers' | 'stubbed';
  /** Creatures between an attacker (or an effect's origin) and its target give the target Half Cover. */
  creatureCover: 'on' | 'off';
  /** Another action taken while an Attack action still has attacks left: the Attack action carries on afterwards (allowed), or ends there (notAllowed). */
  splitActions: 'allowed' | 'notAllowed';
  /** A Cone or Line from a creature: its point of origin is the center of the creature's square, or the edge of it (a corner on a diagonal) toward the aim. */
  selfAreaOrigin: 'squareCenter' | 'squareEdge';
  /** Which squares an Emanation covers: every square within its distance by the grid's movement count, or a Sphere's squares around the creature's center under areaGridCoverage. */
  emanationReach: 'gridDistance' | 'radial';
  /** Casting an Emanation onto a creature counts as it entering that creature's space. */
  emanationCastTrigger: 'none' | 'onCast';
  /** Coverage step 9: the skill a Search for a hidden zone uses: the better of Perception and Survival, or Perception only. */
  searchSkill: 'best' | 'perception';
  /** Coverage step 9: a creature that takes damage from a hidden zone it hasn't recognized recognizes it then. */
  hiddenHazardRevealedByDamage: boolean;
  /** Coverage step 9: a creature that could see part of a hidden zone's area when it appeared (not all of it) counts as having seen it. */
  hiddenHazardPartialViewCountsAsSeen: boolean;
  /** Coverage step 9+: a creature that swaps places by its own Reaction (Redirect Attack) provokes Opportunity Attacks when the swap takes it out of a foe's reach. */
  swapProvokesOpportunityAttacks: boolean;
  /** W1: a feature's "move up to half your Speed" (Tactical Shift, Withdraw) spends the creature's own movement for the turn, or comes on top of it. */
  freeMoveUsesMovement: boolean;
  /** W1: Frenzy's Rage check: Rage must be active when Reckless Attack is used (declaration), or both are checked at the first Strength-based hit (hit). */
  frenzyRageCheck: 'declaration' | 'hit';
  /** Step E: where a thrown weapon lands: on the target's square, hit or miss (it can be picked up again), or nowhere (gone for the fight). */
  thrownWeaponLands: 'targetSquare' | 'gone';
}

export interface FlagInfo<T> {
  readonly default: T;
  readonly options: readonly T[];
  /** Options the engine doesn't implement yet; scenarios that pick one are rejected. */
  readonly unimplemented?: readonly T[];
  readonly source: string;
  readonly verified: boolean;
}

export const FLAG_INFO: { readonly [K in keyof RuleFlags]: FlagInfo<RuleFlags[K]> } = {
  natOnChecksAndSaves: {
    default: 'none',
    options: ['none', 'autoPassFail'],
    source: 'SRD 5.2.1 p.7 "Rolling 20 or 1" covers attack rolls only; 2024 Sage Advice (Ability Checks)',
    verified: true,
  },
  expandedCritAutoHits: {
    default: false,
    options: [false, true],
    source: 'SRD 5.2.1 p.7 and p.179 tie the auto-hit to rolling a 20; p.49 Improved Critical only says it "can score a Critical Hit"; no Sage Advice entry',
    verified: false,
  },
  diagonalCost: {
    default: 'uniform',
    options: ['uniform', 'alternate'],
    source: 'SRD 5.2.1 p.13 "Playing on a Grid": any adjacent square costs 1; alternating 5/10 is a 2024 DMG option (its use for range is unverified)',
    verified: true,
  },
  diagonalCorner: {
    default: 'eitherBlocks',
    options: ['eitherBlocks', 'bothBlock'],
    source: 'SRD 5.2.1 p.13: a diagonal can\'t cross the corner of a wall; which squares count as "the corner" is a reading',
    verified: false,
  },
  initiativeMode: {
    default: 'roll',
    options: ['roll', 'static'],
    source: 'SRD 5.2.1 p.184 "Initiative" and p.254: static initiative is a GM option',
    verified: true,
  },
  initiativeTies: {
    default: 'rollOff',
    options: ['rollOff', 'pcsFirst', 'monstersFirst'],
    source: 'SRD 5.2.1 p.13: the GM orders tied monsters and mixed ties, players order tied PCs; no procedure given (policy)',
    verified: false,
  },
  groupInitiative: {
    default: 'shared',
    options: ['shared', 'individual'],
    source: 'SRD 5.2.1 p.13: a group of identical creatures gets one roll',
    verified: true,
  },
  monsterHp: {
    default: 'listed',
    options: ['listed', 'rolled'],
    source: 'SRD 5.2.1 p.255: use the number or the dice, the GM\'s choice',
    verified: true,
  },
  statBlockAtZeroHp: {
    default: 'dies',
    options: ['dies', 'deathSaves'],
    source: 'SRD 5.2.1 p.17 "Monster Death": dies at 0 HP unless the GM treats it like a character',
    verified: true,
  },
  corpseSpace: {
    default: 'clear',
    options: ['clear', 'difficult'],
    source: 'SRD 5.2.1 p.14 and glossary "Dead" (p.180) are silent on bodies; Sage Advice silent',
    verified: false,
  },
  moveBetweenAttacks: {
    default: 'all',
    options: ['all', 'extraAttackOnly'],
    source: 'SRD 5.2.1 p.177 "Moving between Attacks" plus p.257 (Multiattack is part of the Attack action): an inference for Multiattack',
    verified: false,
  },
  monsterThrownWeapons: {
    default: 'gearCount',
    options: ['gearCount', 'unlimited'],
    source: 'SRD 5.2.1 p.255 "Gear": counts are listed; only ammunition is said to be enough',
    verified: false,
  },
  tempHpSoakAtZeroIsDamage: {
    default: true,
    options: [true, false],
    source: 'SRD 5.2.1 p.18 plus the 2024 Sage Advice Concentration answer (temp HP soak is still damage taken)',
    verified: false,
  },
  pauseInOccupiedSpace: {
    default: false,
    options: [false, true],
    unimplemented: [true],
    source: 'SRD 5.2.1 p.14: you can\'t willingly end a move in an occupied space; silent on pausing mid-turn',
    verified: false,
  },
  focusHandSomatic: {
    default: 'strict',
    options: ['strict', 'lenient'],
    source: '2024 Sage Advice SAC-SpellComponents3 and SRD 5.2.1 p.105-106: the focus hand does Somatic only for spells with a Material component; lenient is a common table ruling',
    verified: true,
  },
  conjuredHandEffectBlocksHand: {
    default: false,
    options: [false, true],
    source: 'SRD 5.2.1 p.156 Produce Flame: the flame is "in your hand"; unlike Flame Blade (p.132) it never says it needs or occupies a free hand',
    verified: false,
  },
  concentrationSaveGrouping: {
    default: 'perDamageEvent',
    options: ['perDamageEvent', 'perDamageType'],
    source: 'SRD 5.2.1 p.179 "If you take damage": the 2014 one-save-per-source sentence is gone; 2024 SAC-SpellDuration2 sums one attack',
    verified: false,
  },
  concentrationSaveOnZeroDamage: {
    default: 'noSave',
    options: ['noSave', 'save'],
    source: 'SRD 5.2.1 p.17: Immunity means no damage taken (no save, settled); Resistance halving damage to 0 is not addressed',
    verified: false,
  },
  timedDurationExpiryPoint: {
    default: 'startOfCreatorTurn',
    options: ['startOfCreatorTurn', 'endOfCreatorTurn'],
    source: 'SRD 5.2.1 p.13 and p.106 give durations in rounds and minutes but no initiative point where they end; no 2024 SAC entry',
    verified: false,
  },
  deadAnchorTurnBoundary: {
    default: 'keepInitiativeSlot',
    options: ['keepInitiativeSlot', 'fireOnDeath'],
    source: 'SRD 5.2.1 p.13 (initiative order is fixed) and p.180 Dead (effects keep running); silent on a dead creature\'s "next turn"',
    verified: false,
  },
  nextRollRiderConsumedWhenRedundant: {
    default: 'consumed',
    options: ['consumed', 'notConsumed'],
    source: 'SRD 5.2.1 p.138 "the next attack roll made against it" reads as spent on any roll; silent on rolls already at Advantage or also at Disadvantage',
    verified: false,
  },
  selfTargetWhenTextSilent: {
    default: 'allowed',
    options: ['allowed', 'notAllowed'],
    source: 'SRD 5.2.1 p.106 "Targeting Yourself" covers "a creature of your choice" only; no 2024 SAC entry',
    verified: false,
  },
  areaOriginOnGrid: {
    default: 'squareCenter',
    options: ['squareCenter', 'gridIntersection'],
    source: 'Shane\'s table ruling 2026-11-01 (areas land on a square); SRD 5.2.1 has no grid-area rule; the 2024 DMG intersection rule is known only secondhand',
    verified: false,
  },
  areaGridCoverage: {
    default: 'atLeastHalfSquare',
    options: ['atLeastHalfSquare', 'squareCenterInside', 'anyOverlap'],
    source: 'SRD 5.2.1 has no grid-area rule (p.13 covers movement and range); the 2024 DMG half-square rule is known only secondhand; 2024 SAC-Spells-CloudofDaggers1',
    verified: false,
  },
  areaSaveGroupingPerEvent: {
    default: 'groupByEvent',
    options: ['groupByEvent', 'perCreature'],
    source: 'SRD 5.2.1 p.16: one damage roll for targets that save at the same time; silent on creatures caught by one moved area',
    verified: false,
  },
  movedAreaTriggersAlongPath: {
    default: 'sweepPath',
    options: ['sweepPath', 'destinationOnly'],
    source: 'SRD 5.2.1 p.150-151 "moves into its space" has no path rule; 2024 parallels (p.132, p.201) count spaces along the way',
    verified: false,
  },
  involuntaryMovementTriggersArea: {
    default: true,
    options: [true, false],
    source: 'SRD 5.2.1 p.150-151 and p.164 say "enters" and "moves" with no "willingly"; 2024 text says "willingly" when it means it (p.138, p.145); no ruling',
    verified: false,
  },
  perDistanceDamageRolls: {
    default: 'perIncrement',
    options: ['perIncrement', 'perMove'],
    source: 'SRD 5.2.1 p.164 "damage for every 5 feet it travels" doesn\'t say whether each 5 ft is a separate damage instance',
    verified: false,
  },
  areaExitStepCounts: {
    default: false,
    options: [false, true],
    source: 'SRD 5.2.1 p.164 "moves into or within the area" is silent on the step from inside to outside',
    verified: false,
  },
  forcedMovementPath: {
    default: 'eachStepCloser',
    options: ['eachStepCloser', 'straightLineOnly'],
    source: 'No 2024 rule defines "closer" or "away" on a grid; effects whose text says "straight" still need a straight line',
    verified: false,
  },
  forcedMovementObstacle: {
    default: 'stopBefore',
    options: ['stopBefore', 'passThroughCreatures'],
    unimplemented: ['passThroughCreatures'],
    source: 'No 2024 rule for a push or pull into a wall or creature; the nearest-space rule (p.190) is specific to Teleportation',
    verified: false,
  },
  forcedMovementTerrainCost: {
    default: 'ignoresTerrain',
    options: ['ignoresTerrain', 'terrainShortens'],
    source: 'SRD 5.2.1 p.181: Difficult Terrain taxes movement a creature spends; forced moves state feet moved; no 2024 text links them',
    verified: false,
  },
  losingSpellSourceEndsActiveSpell: {
    default: false,
    options: [false, true],
    source: 'No 2024 text ends an active spell when the item that kept it prepared is lost; prepared status matters when casting',
    verified: false,
  },
  unconsciousDropsShield: {
    default: true,
    options: [true, false],
    source: 'SRD 5.2.1 p.191 Unconscious: drops whatever it\'s holding; a shield is carried in one hand; a donned shield is unruled',
    verified: false,
  },
  zoneKnowledge: {
    default: 'sawCast',
    options: ['sawCast', 'all', 'none'],
    source: 'Not a rule: which zones a creature avoids when it plans a move. sawCast (coverage step 9) = a hidden zone (SRD 5.2.1 p.164 Spike Growth, srd-raw.txt:31015-31021: camouflaged; a creature that can\'t see the area when the spell is cast must take a Search action to recognize it) only once it saw it appear or recognized it, every other zone once it has line of sight to one of its squares (or saw it appear); all = every zone; none = only zones it created. Movement cost through Difficult Terrain is physical and applies either way',
    verified: false,
  },
  flyingAvoidsGroundZones: {
    default: false,
    options: [false, true],
    unimplemented: [true],
    source:
      'SRD 5.2.1 glossary "Flying" and "Fly Speed" (srd-raw.txt:33453-33464) say a Fly Speed travels through the air and a flier falls when Incapacitated, Prone or at Fly Speed 0; "Speed" (34216-34236) lets a creature switch speeds mid-move and applies Speed changes to special speeds. Nothing says whether a flier is above a zone the text puts on the ground; the grid has no altitude, so a flier is on the ground (false) until heights exist',
    verified: false,
  },
  riderDiceCritDouble: {
    default: true,
    options: [true, false],
    source:
      'SRD 5.2.1 "Playing the Game", "Critical Hits" (srd-raw.txt:2207-2211): roll the attack\'s damage dice twice, and "if the attack involves other damage dice, such as from the Rogue\'s Sneak Attack feature, you also roll those dice twice". Sneak Attack is itself extra damage added once the hit is known, so a rider\'s damage dice on a hit are rolled twice (true); false is a house-rule what-if. Verified M3 step 5a',
    verified: true,
  },
  reduceBeforeResistance: {
    default: true,
    options: [true, false],
    source:
      'SRD 5.2.1 "Playing the Game", "Order of Application" (srd-raw.txt:2259-2266): adjustments such as bonuses, penalties or multipliers first, then Resistance, then Vulnerability; Deflect Attacks (11154-11158) "reduce the attack\'s total damage" and does not say whether that reduction is such an adjustment',
    verified: false,
  },
  losMethod: {
    default: 'corners',
    options: ['corners', 'centers', 'stubbed'],
    source:
      'SRD 5.2.1 "Cover" (srd-raw.txt:1995-2032) and its glossary entry (33044-33050) give the three degrees and say a target benefits only when the effect "originates on the opposite side of the cover", but give no grid procedure. corners = the DMG\'s corner-to-corner lines (the attacker\'s best corner to the 4 corners of the target\'s square: 1-2 blocked Half, 3 Three-Quarters, 4 Total; known only secondhand, the DMG is not SRD); centers = one line between square centers; stubbed = no cover and everyone sees everyone (the engine before M3 step 8, a what-if)',
    verified: false,
  },
  creatureCover: {
    default: 'on',
    options: ['on', 'off'],
    source: 'SRD 5.2.1 Cover table (srd-raw.txt:2006-2017): Half Cover is offered by "Another creature or an object that covers at least half of the target"; off is a what-if',
    verified: true,
  },
  splitActions: {
    default: 'allowed',
    options: ['allowed', 'notAllowed'],
    source:
      'SRD 5.2.1 "Breaking Up Your Move" (srd-raw.txt:1878-1883) lets a creature move before, after or between its actions, and "Attack [Action]" (32713-32717) lets it move between the attacks of one Attack action; neither says whether another action (Dodge after Action Surge) may come between two attacks of an unfinished Attack action. allowed = the engine before M3 step 8 (the Attack action carries on afterwards); notAllowed = taking another action ends the Attack action and its unused attacks are lost',
    verified: false,
  },
  selfAreaOrigin: {
    default: 'squareCenter',
    options: ['squareCenter', 'squareEdge'],
    source:
      "Shane's table ruling 2026-11-01 that areas land on a square (areaOriginOnGrid), carried to a creature's own areas. SRD 5.2.1 has no grid-area rule: a Cone or Line starts from \"a point of origin\" (srd-raw.txt:33029-33031, 33768-33770) and the text doesn't place it on the creature's square. squareEdge gives the book-template look at 15 ft; a Cube from a creature touches its square under both",
    verified: false,
  },
  emanationReach: {
    default: 'gridDistance',
    options: ['gridDistance', 'radial'],
    source:
      'SRD 5.2.1 "Emanation" (srd-raw.txt:33380-33386) says only that it extends in straight lines in all directions for a distance; no grid-area rule. gridDistance counts squares as p.13 "Playing on a Grid" does (a 10-ft Emanation is the 5x5 block under uniform diagonals); radial takes a Sphere\'s squares of that radius around the center of the creature\'s square',
    verified: false,
  },
  emanationCastTrigger: {
    default: 'none',
    options: ['none', 'onCast'],
    source:
      'SRD 5.2.1 Spirit Guardians (srd-raw.txt:31040-31047) lists the Emanation entering a creature\'s space, a creature entering it, and ending a turn there; it doesn\'t address the cast itself. none = casting triggers nothing; onCast = the cast counts as the Emanation entering the space of each creature in the first area',
    verified: false,
  },
  searchSkill: {
    default: 'best',
    options: ['best', 'perception'],
    source:
      'SRD 5.2.1 p.164 Spike Growth (srd-raw.txt:31015-31021; docs/research/m1b-rules-2024.md:82): a Search action and a Wisdom (Perception or Survival) check against the spell save DC; the Search action is one Wisdom check (34116-34118). best = the searcher uses whichever of the two it is better at (the plain reading of "or", UNVERIFIED); perception = Perception only (a table that ties Search to Perception)',
    verified: false,
  },
  hiddenHazardRevealedByDamage: {
    default: false,
    options: [true, false],
    source:
      'No rule text: SRD 5.2.1 p.164 (srd-raw.txt:31011-31021) says damage applies whether or not a creature recognizes the area, and says nothing on whether the damage reveals it (docs/research/m1b-rules-2024.md:82, :163 lists this flag). true = a creature hurt by a hidden zone recognizes it then; false (default, Shane 2026-11-10: the spell names Search as the way to recognize it, and true leaves greedy monsters almost never Searching) = it still needs a Search (it knows only that something hurt it)',
    verified: false,
  },
  hiddenHazardPartialViewCountsAsSeen: {
    default: true,
    options: [true, false],
    source:
      'No rule text: SRD 5.2.1 p.164 (srd-raw.txt:31016-31017) turns on whether a creature "can\'t see the area" when the spell was cast and doesn\'t say how much of it (docs/research/m1b-rules-2024.md:163 lists this flag). true = seeing any square of the area counts; false = only a creature that could see every square of it saw it',
    verified: false,
  },
  swapProvokesOpportunityAttacks: {
    default: false,
    options: [false, true],
    unimplemented: [true],
    source:
      'No rule text: Redirect Attack says only "the goblin and that ally swap places" (SRD 5.2.1 p.290, srd-raw.txt:48831-48834). The ally is moved without using its own movement, action, Bonus Action or Reaction, so it never provokes (srd-raw.txt:2091-2093, settled); the goblin moves by its own Reaction, which that exemption doesn\'t cover, but a swap isn\'t a move by its Speed and the text says nothing of Opportunity Attacks (docs/design/coverage.md critique M4). false (default) = neither provokes; true (not implemented) = the goblin provokes from foes whose reach the swap takes it out of',
    verified: false,
  },
  freeMoveUsesMovement: {
    default: false,
    options: [false, true],
    source:
      'No rule text: Tactical Shift ("you can move up to half your Speed without provoking Opportunity Attacks", SRD 5.2.1 srd-raw.txt:10661-10663) and Cunning Strike\'s Withdraw ("you move up to half your Speed without provoking Opportunity Attacks", 13835-13836) don\'t say whether that move uses the creature\'s movement for the turn (docs/design/w1-plan.md P9). false (default, Shane 2026-11-12) = it comes on top of the turn\'s movement, which stays whole; true = on the mover\'s own turn its feet come out of the turn\'s movement as a normal walk\'s do; off its turn (Withdraw on an Opportunity Attack) there is no turn\'s movement, so it spends none and is capped at half Speed [U]',
    verified: false,
  },
  frenzyRageCheck: {
    default: 'declaration',
    options: ['declaration', 'hit'],
    unimplemented: ['hit'],
    source:
      'Frenzy: "If you use Reckless Attack while your Rage is active, you deal extra damage to the first target you hit on your turn with a Strength-based attack" (SRD 5.2.1 srd-raw.txt:5173-5175) doesn\'t say whether Rage must be up when Reckless Attack is used or when the hit lands (docs/design/w1-plan.md section 3). declaration (default, Shane 2026-11-12) = Rage must be active when Reckless Attack is used, the text\'s order; hit (not implemented) = Rage and Reckless Attack are both checked at the first Strength-based hit',
    verified: false,
  },
  thrownWeaponLands: {
    default: 'targetSquare',
    options: ['targetSquare', 'gone'],
    source:
      'The Thrown property: "you can throw the weapon to make a ranged attack, and you can draw that weapon as part of the attack" (SRD 5.2.1 srd-raw.txt:20386-20391) says nothing about where the weapon lands or getting it back; a self-returning weapon says so in its block (Salamander\'s Flame Spear, 53417-53419), so by default a thrown weapon stays in the world (docs/design/stepE-plan.md R4, R5). targetSquare (default, Shane 2026-11-14) = it lands on the square of the creature it was thrown at, hit or miss, and its thrower can pick it up there with an Attack-action strike\'s equip (32707-32712); gone = it is out of the fight (a monster\'s counted gear before step E)',
    verified: false,
  },
};

/** Fixed flag order: report lines, flagsUsed indices and hashes all follow it. */
export const FLAG_KEYS: readonly (keyof RuleFlags)[] = [
  'natOnChecksAndSaves',
  'expandedCritAutoHits',
  'diagonalCost',
  'diagonalCorner',
  'initiativeMode',
  'initiativeTies',
  'groupInitiative',
  'monsterHp',
  'statBlockAtZeroHp',
  'corpseSpace',
  'moveBetweenAttacks',
  'monsterThrownWeapons',
  'tempHpSoakAtZeroIsDamage',
  'pauseInOccupiedSpace',
  'focusHandSomatic',
  'conjuredHandEffectBlocksHand',
  'concentrationSaveGrouping',
  'concentrationSaveOnZeroDamage',
  'timedDurationExpiryPoint',
  'deadAnchorTurnBoundary',
  'nextRollRiderConsumedWhenRedundant',
  'selfTargetWhenTextSilent',
  'areaOriginOnGrid',
  'areaGridCoverage',
  'areaSaveGroupingPerEvent',
  'movedAreaTriggersAlongPath',
  'involuntaryMovementTriggersArea',
  'perDistanceDamageRolls',
  'areaExitStepCounts',
  'forcedMovementPath',
  'forcedMovementObstacle',
  'forcedMovementTerrainCost',
  'losingSpellSourceEndsActiveSpell',
  'unconsciousDropsShield',
  'zoneKnowledge',
  'flyingAvoidsGroundZones',
  'riderDiceCritDouble',
  'reduceBeforeResistance',
  'losMethod',
  'creatureCover',
  'splitActions',
  'selfAreaOrigin',
  'emanationReach',
  'emanationCastTrigger',
  'searchSkill',
  'hiddenHazardRevealedByDamage',
  'hiddenHazardPartialViewCountsAsSeen',
  'swapProvokesOpportunityAttacks',
  'freeMoveUsesMovement',
  'frenzyRageCheck',
  'thrownWeaponLands',
];

export const DEFAULT_FLAGS: RuleFlags = {
  natOnChecksAndSaves: FLAG_INFO.natOnChecksAndSaves.default,
  expandedCritAutoHits: FLAG_INFO.expandedCritAutoHits.default,
  diagonalCost: FLAG_INFO.diagonalCost.default,
  diagonalCorner: FLAG_INFO.diagonalCorner.default,
  initiativeMode: FLAG_INFO.initiativeMode.default,
  initiativeTies: FLAG_INFO.initiativeTies.default,
  groupInitiative: FLAG_INFO.groupInitiative.default,
  monsterHp: FLAG_INFO.monsterHp.default,
  statBlockAtZeroHp: FLAG_INFO.statBlockAtZeroHp.default,
  corpseSpace: FLAG_INFO.corpseSpace.default,
  moveBetweenAttacks: FLAG_INFO.moveBetweenAttacks.default,
  monsterThrownWeapons: FLAG_INFO.monsterThrownWeapons.default,
  tempHpSoakAtZeroIsDamage: FLAG_INFO.tempHpSoakAtZeroIsDamage.default,
  pauseInOccupiedSpace: FLAG_INFO.pauseInOccupiedSpace.default,
  focusHandSomatic: FLAG_INFO.focusHandSomatic.default,
  conjuredHandEffectBlocksHand: FLAG_INFO.conjuredHandEffectBlocksHand.default,
  concentrationSaveGrouping: FLAG_INFO.concentrationSaveGrouping.default,
  concentrationSaveOnZeroDamage: FLAG_INFO.concentrationSaveOnZeroDamage.default,
  timedDurationExpiryPoint: FLAG_INFO.timedDurationExpiryPoint.default,
  deadAnchorTurnBoundary: FLAG_INFO.deadAnchorTurnBoundary.default,
  nextRollRiderConsumedWhenRedundant: FLAG_INFO.nextRollRiderConsumedWhenRedundant.default,
  selfTargetWhenTextSilent: FLAG_INFO.selfTargetWhenTextSilent.default,
  areaOriginOnGrid: FLAG_INFO.areaOriginOnGrid.default,
  areaGridCoverage: FLAG_INFO.areaGridCoverage.default,
  areaSaveGroupingPerEvent: FLAG_INFO.areaSaveGroupingPerEvent.default,
  movedAreaTriggersAlongPath: FLAG_INFO.movedAreaTriggersAlongPath.default,
  involuntaryMovementTriggersArea: FLAG_INFO.involuntaryMovementTriggersArea.default,
  perDistanceDamageRolls: FLAG_INFO.perDistanceDamageRolls.default,
  areaExitStepCounts: FLAG_INFO.areaExitStepCounts.default,
  forcedMovementPath: FLAG_INFO.forcedMovementPath.default,
  forcedMovementObstacle: FLAG_INFO.forcedMovementObstacle.default,
  forcedMovementTerrainCost: FLAG_INFO.forcedMovementTerrainCost.default,
  losingSpellSourceEndsActiveSpell: FLAG_INFO.losingSpellSourceEndsActiveSpell.default,
  unconsciousDropsShield: FLAG_INFO.unconsciousDropsShield.default,
  zoneKnowledge: FLAG_INFO.zoneKnowledge.default,
  flyingAvoidsGroundZones: FLAG_INFO.flyingAvoidsGroundZones.default,
  riderDiceCritDouble: FLAG_INFO.riderDiceCritDouble.default,
  reduceBeforeResistance: FLAG_INFO.reduceBeforeResistance.default,
  losMethod: FLAG_INFO.losMethod.default,
  creatureCover: FLAG_INFO.creatureCover.default,
  splitActions: FLAG_INFO.splitActions.default,
  selfAreaOrigin: FLAG_INFO.selfAreaOrigin.default,
  emanationReach: FLAG_INFO.emanationReach.default,
  emanationCastTrigger: FLAG_INFO.emanationCastTrigger.default,
  searchSkill: FLAG_INFO.searchSkill.default,
  hiddenHazardRevealedByDamage: FLAG_INFO.hiddenHazardRevealedByDamage.default,
  hiddenHazardPartialViewCountsAsSeen: FLAG_INFO.hiddenHazardPartialViewCountsAsSeen.default,
  swapProvokesOpportunityAttacks: FLAG_INFO.swapProvokesOpportunityAttacks.default,
  freeMoveUsesMovement: FLAG_INFO.freeMoveUsesMovement.default,
  frenzyRageCheck: FLAG_INFO.frenzyRageCheck.default,
  thrownWeaponLands: FLAG_INFO.thrownWeaponLands.default,
};

/**
 * Flags as scenario hashes see them (scenario/resolve.ts). M3 step 8: under losMethod=stubbed the
 * engine is the pre-step-8 one bit for bit (sim/cover.ts), so both LOS flags are left out and
 * every scenario keeps the hash it had before they existed.
 */
export function hashedFlags(f: RuleFlags): Partial<RuleFlags> {
  // M3 step 8'a, step 7: a flag whose default is the engine before it existed is left out at that default.
  const base: Partial<RuleFlags> = { ...f };
  if (f.splitActions === FLAG_INFO.splitActions.default) delete base.splitActions;
  if (f.selfAreaOrigin === FLAG_INFO.selfAreaOrigin.default) delete base.selfAreaOrigin;
  if (f.emanationReach === FLAG_INFO.emanationReach.default) delete base.emanationReach;
  if (f.emanationCastTrigger === FLAG_INFO.emanationCastTrigger.default) delete base.emanationCastTrigger;
  // Coverage step 9: the same for the hidden-zone flags.
  if (f.searchSkill === FLAG_INFO.searchSkill.default) delete base.searchSkill;
  if (f.hiddenHazardRevealedByDamage === FLAG_INFO.hiddenHazardRevealedByDamage.default) delete base.hiddenHazardRevealedByDamage;
  if (f.hiddenHazardPartialViewCountsAsSeen === FLAG_INFO.hiddenHazardPartialViewCountsAsSeen.default) delete base.hiddenHazardPartialViewCountsAsSeen;
  // Coverage step 9+: the same for the swap flag.
  if (f.swapProvokesOpportunityAttacks === FLAG_INFO.swapProvokesOpportunityAttacks.default) delete base.swapProvokesOpportunityAttacks;
  // W1: the same for the free-move and Frenzy flags.
  if (f.freeMoveUsesMovement === FLAG_INFO.freeMoveUsesMovement.default) delete base.freeMoveUsesMovement;
  if (f.frenzyRageCheck === FLAG_INFO.frenzyRageCheck.default) delete base.frenzyRageCheck;
  // Step E: the same for thrownWeaponLands (its default is what PCs already did; monsters' landings are new state, hashed only while a piece is down).
  if (f.thrownWeaponLands === FLAG_INFO.thrownWeaponLands.default) delete base.thrownWeaponLands;
  if (f.losMethod !== 'stubbed') return base;
  const { losMethod: _m, creatureCover: _c, ...rest } = base;
  return rest;
}

/** FLAG_KEYS before M3 step 8: a flagsUsed array whose later entries are all 0 hashes as this prefix (sim/state.ts stateHash), so old hashes hold. */
export const LEGACY_FLAG_COUNT = 38;

/** FLAG_KEYS before coverage step 7. */
export const PRE_AREA_FLAG_COUNT = 41;

/** FLAG_KEYS before W1 (freeMoveUsesMovement, frenzyRageCheck). */
export const PRE_W1_FLAG_COUNT = 48;

/** FLAG_KEYS before step E (thrownWeaponLands). */
export const PRE_E_FLAG_COUNT = 50;

/**
 * A per-flag array as hashed or written to a report: its PRE_AREA_FLAG_COUNT prefix while no
 * later flag was read, so a fight or report that touches no step 7 shape keeps its old hash; and
 * (W1) its PRE_W1_FLAG_COUNT prefix while no W1 flag was read, so one that read a step 7 to 9+
 * flag but no W1 one keeps its old hash too.
 */
export function trimLateFlags(used: Uint8Array): Uint8Array {
  // Step E: its PRE_E_FLAG_COUNT prefix while thrownWeaponLands wasn't read.
  for (let i = PRE_E_FLAG_COUNT; i < used.length; i++) if (used[i] !== 0) return used;
  for (let i = PRE_W1_FLAG_COUNT; i < PRE_E_FLAG_COUNT && i < used.length; i++) if (used[i] !== 0) return used.subarray(0, PRE_E_FLAG_COUNT);
  for (let i = PRE_AREA_FLAG_COUNT; i < PRE_W1_FLAG_COUNT && i < used.length; i++) if (used[i] !== 0) return used.subarray(0, PRE_W1_FLAG_COUNT);
  return used.subarray(0, PRE_AREA_FLAG_COUNT);
}

/** Index of each flag in FLAG_KEYS, for flagsUsed arrays. */
const FLAG_IDX: Readonly<Record<string, number>> = Object.fromEntries(FLAG_KEYS.map((k, i) => [k, i]));

export function flagIndex(key: keyof RuleFlags): number {
  const i = FLAG_IDX[key];
  if (i === undefined) throw new RangeError(`unknown rule flag ${key}`);
  return i;
}

/** Parses one KEY=VALUE override against FLAG_INFO; throws with the allowed values. */
export function parseFlagValue(key: string, raw: string): Partial<RuleFlags> {
  if (!Object.hasOwn(FLAG_INFO, key)) throw new RangeError(`unknown rule flag "${key}" (known: ${FLAG_KEYS.join(', ')})`);
  const k = key as keyof RuleFlags;
  const info: FlagInfo<unknown> = FLAG_INFO[k];
  const value = info.options.find((o) => String(o) === raw);
  if (value === undefined) throw new RangeError(`flag ${k} must be one of ${info.options.join(', ')}`);
  return { [k]: value } as Partial<RuleFlags>;
}

/** Throws if any flag is set to an option the engine doesn't implement yet. */
export function assertImplemented(flags: RuleFlags): void {
  for (const k of FLAG_KEYS) {
    const info: FlagInfo<unknown> = FLAG_INFO[k];
    if (info.unimplemented?.includes(flags[k])) throw new RangeError(`flag ${k}=${String(flags[k])} isn't implemented yet`);
  }
}

/** One line per flag, for report headers. Unverified flags are marked. */
export function describeFlags(flags: RuleFlags, used?: readonly (keyof RuleFlags)[]): string[] {
  const keys = used ?? FLAG_KEYS;
  return keys.map((k) => {
    const info = FLAG_INFO[k];
    const mark = info.verified ? 'verified' : 'UNVERIFIED';
    return `${k}=${String(flags[k])} [${mark}: ${info.source}]`;
  });
}
