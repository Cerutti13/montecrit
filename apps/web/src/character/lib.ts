// The character-building data for the Character screen (docs/design/m3.md 10, "Web"): the same
// CharacterLib and picks the CLI's `build` and `new character` read, from @montecrit/host
// (character-picks.ts), so the two can't drift. Re-exported here for the screen's own modules.

export { buildNeeds, byString, characterLib, masteryNeed, type BackgroundSrc, type ClassSrc, type Need, type SpeciesSrc, type SubclassSrc } from '@montecrit/host';
