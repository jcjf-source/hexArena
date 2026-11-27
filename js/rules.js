// Arena rules: one is rolled at the start of each game and applies to everyone.
//  mods:  combat modifiers for every player's units (same keys as augment mods, see applyMods)
//  econ:  interestCap, goldBonus, xpBonus, shopBonus, rerollCost, dmgPct (HP lost on a defeat)
//  arena: tiles (terrain hexes per half), shiftEvery (rounds between new layouts)
// A rule is stored as { id, trait? }; Ascendant picks a random trait to empower.

import { TRAITS } from './data.js';
import { DEFAULT_TILES, SHIFT_EVERY } from './terrain.js';

export const ASCENDANT_BOOST = 20;

export const RULES = {
  overcharged: { name: 'Overcharged',   icon: '🔋', desc: 'Abilities cost 30% less mana.', mods: { manaCostPct: -30 } },
  glass:       { name: 'Glass Arena',   icon: '💥', desc: 'All units deal 40% more damage but have 25% less HP.', mods: { dmgPct: 40, hpPct: -25 } },
  fortified:   { name: 'Fortified',     icon: '🏰', desc: 'All units gain +30 armor, +30 magic resist and +20% HP.', mods: { armor: 30, mr: 30, hpPct: 20 } },
  frenzy:      { name: 'Frenzy',        icon: '🌪️', desc: 'All units gain +30% attack speed.', mods: { asPct: 30 } },
  bloodmoon:   { name: 'Blood Moon',    icon: '🩸', desc: 'All units heal for 12% of the damage they deal.', mods: { lifesteal: 12 } },
  boom:        { name: 'Boom Economy',  icon: '💰', desc: 'Interest can reach 8 gold per round instead of 5.', econ: { interestCap: 8 } },
  bazaar:      { name: 'Grand Bazaar',  icon: '🛒', desc: 'Shops show one extra unit and rerolls cost 1 gold.', econ: { shopBonus: 1, rerollCost: 1 } },
  prodigy:     { name: 'Prodigies',     icon: '📈', desc: 'Everyone gains 2 extra XP every round.', econ: { xpBonus: 2 } },
  highstakes:  { name: 'High Stakes',   icon: '🎲', desc: 'Lost fights cost 50% more HP, but everyone gains 2 extra gold each round.', econ: { dmgPct: 50, goldBonus: 2 } },
  wild:        { name: 'Wild Arena',    icon: '🌋', desc: 'Twice as many terrain hexes.', arena: { tiles: DEFAULT_TILES * 2 } },
  shifting:    { name: 'Shifting Sands', icon: '🏜️', desc: 'The terrain changes every round.', arena: { shiftEvery: 1 } },
  ascendant:   { name: 'Ascendant',     icon: '🌟', trait: true, desc: '{trait} counts as one extra unit for everyone who fields one, and {trait} units gain +20% HP and damage.' },
};

export function rollRule(rand = Math.random) {
  const ids = Object.keys(RULES);
  const id = ids[Math.floor(rand() * ids.length)];
  if (!RULES[id].trait) return { id };
  const traits = Object.keys(TRAITS);
  return { id, trait: traits[Math.floor(rand() * traits.length)] };
}

const def = (rule) => (rule && RULES[rule.id]) || null;

export function ruleName(rule) {
  const d = def(rule);
  if (!d) return '';
  return d.trait ? `${TRAITS[rule.trait].icon} ${TRAITS[rule.trait].name} ${d.name}` : d.name;
}

export function ruleIcon(rule) { return def(rule)?.icon || ''; }

export function ruleDesc(rule) {
  const d = def(rule);
  if (!d) return '';
  return d.trait ? d.desc.replaceAll('{trait}', TRAITS[rule.trait].name) : d.desc;
}

export function ruleEcon(rule, key, fallback) {
  const v = def(rule)?.econ?.[key];
  return v === undefined ? fallback : v;
}

export function ruleArena(rule, key, fallback) {
  const v = def(rule)?.arena?.[key];
  return v === undefined ? fallback : v;
}

export const terrainTiles = (rule) => ruleArena(rule, 'tiles', DEFAULT_TILES);
export const terrainShiftEvery = (rule) => ruleArena(rule, 'shiftEvery', SHIFT_EVERY);

// Combat mods every player's team gets from the rule.
export function ruleMods(rule) {
  const d = def(rule);
  if (!d) return null;
  if (d.trait) return { traitBoost: { [rule.trait]: ASCENDANT_BOOST } };
  return d.mods || null;
}

// Extra trait counts from the rule ({ trait: n }), like a crest everyone has.
export function ruleTraitBonus(rule) {
  return def(rule)?.trait ? { [rule.trait]: 1 } : null;
}
