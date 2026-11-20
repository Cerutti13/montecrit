// The mapper registry: one module per kind (docs/design/m3.md 4.2 map/*.ts). Species traits
// become features through species.ts mapSpeciesTrait; spells map through spell.ts, monsters
// through monster.ts and simple magic items through magic-item.ts (step 6).

import { mapArmor } from './armor.ts';
import { mapBackground } from './background.ts';
import { mapClass } from './class.ts';
import { mapFeat } from './feat.ts';
import { mapFeature } from './feature.ts';
import { mapMagicItem } from './magic-item.ts';
import { mapMonster } from './monster.ts';
import { mapSpecies, mapSpeciesTrait } from './species.ts';
import { mapSpell } from './spell.ts';
import { mapSubclass } from './subclass.ts';
import type { MapperRegistry } from './types.ts';
import { mapWeapon } from './weapon.ts';

export const MAPPERS: MapperRegistry = {
  armor: mapArmor,
  background: mapBackground,
  class: mapClass,
  feat: mapFeat,
  feature: mapFeature,
  magicItem: mapMagicItem,
  monster: mapMonster,
  species: mapSpecies,
  speciesTrait: mapSpeciesTrait,
  spell: mapSpell,
  subclass: mapSubclass,
  weapon: mapWeapon,
};

export type { MapCtx, Mapper, MapOutput, MapperRegistry } from './types.ts';
