// Augments: one pick from three at set rounds, lasting the whole game.
// kind: 'econ' (handled by game.js hooks), 'combat' (mods applied to the team in every
// fight, see applyMods in combat.js) or 'crest' (+1 to a trait the player already has).

import { TRAITS } from './data.js';

export const AUGMENT_ROUNDS = [3, 10, 17, 24];
export const AUGMENT_EXTRA_TIME = 10; // extra planning seconds on augment rounds
export const CHOICES = 3;

export const AUGMENTS = {
  // ---------- economy ----------
  richer:     { kind: 'econ', name: 'Rich Get Richer', icon: '💰', desc: 'Interest can reach 7 gold per round instead of 5.' },
  windfall:   { kind: 'econ', name: 'Windfall',        icon: '🪙', desc: 'Gain 12 gold now.' },
  salary:     { kind: 'econ', name: 'Steady Paycheck', icon: '💵', desc: 'Gain 2 extra gold every round.' },
  learner:    { kind: 'econ', name: 'Fast Learner',    icon: '📚', desc: 'Gain 2 extra XP every round.' },
  bargain:    { kind: 'econ', name: 'Bargain Hunter',  icon: '🎟️', desc: 'Your first reroll each round is free.' },
  recruiter:  { kind: 'econ', name: 'Recruiter',       icon: '📜', desc: 'Your shop shows 6 units instead of 5.' },
  hunter:     { kind: 'econ', name: 'Monster Hunter',  icon: '🪓', desc: 'Gain 4 extra gold whenever you beat a monster round.' },
  luckyfind:  { kind: 'econ', name: 'Lucky Find',      icon: '🎁', desc: 'Get two random 2-cost units now.' },
  underdog:   { kind: 'econ', name: 'Underdog',        icon: '🐕', desc: 'Gain 2 gold whenever you lose a fight.' },
  secondwind: { kind: 'econ', name: 'Second Wind',     icon: '💖', desc: 'Heal 25 HP now (up to 100).' },
  thickskin:  { kind: 'econ', name: 'Thick Skin',      icon: '🦏', desc: 'Take 30% less damage when you lose a fight.' },

  // ---------- combat ----------
  bulwark:    { kind: 'combat', name: 'Bulwark',       icon: '🧱', desc: 'Front-row units start each fight with a shield worth 25% of their max HP for 8s.', mods: { frontShieldPct: 25 } },
  glass:      { kind: 'combat', name: 'Glass Cannon',  icon: '💥', desc: 'Your units deal 40% more damage but have 15% less HP.', mods: { dmgPct: 40, hpPct: -15 } },
  ironskin:   { kind: 'combat', name: 'Iron Skin',     icon: '⛓️', desc: 'Your units gain +20 armor and +20 magic resist.', mods: { armor: 20, mr: 20 } },
  quickdraw:  { kind: 'combat', name: 'Quickdraw',     icon: '🎯', desc: 'Your units gain +20% attack speed.', mods: { asPct: 20 } },
  overflow:   { kind: 'combat', name: 'Mana Overflow', icon: '💧', desc: 'Your units start each fight with +25 mana.', mods: { mana: 25 } },
  longshot:   { kind: 'combat', name: 'Long Shot',     icon: '🔭', desc: 'Ranged units in your back two rows gain +1 range and +20% attack speed.', mods: { backRange: 1, backAsPct: 20 } },
  vampiric:   { kind: 'combat', name: 'Vampiric',      icon: '🩸', desc: 'Your units heal for 15% of the damage they deal.', mods: { lifesteal: 15 } },
  spellsurge: { kind: 'combat', name: 'Spell Surge',   icon: '🌀', desc: 'Your units gain +20 ability power.', mods: { ap: 20 } },
  keeneye:    { kind: 'combat', name: 'Keen Eye',      icon: '👓', desc: 'Your units gain +30% critical strike chance and +30% critical strike damage.', mods: { critPct: 30, critDmgPct: 30 } },
  growth:     { kind: 'combat', name: 'Giant Growth',  icon: '🍄', desc: 'Your units gain +15% max HP.', mods: { hpPct: 15 } },
};

// One crest per trait: +1 to the trait's count, and its units get a little stronger.
export const CREST_BOOST = 10;
for (const t of Object.keys(TRAITS)) {
  AUGMENTS[`crest_${t}`] = {
    kind: 'crest', crest: t, name: `${TRAITS[t].name} Crest`, icon: TRAITS[t].icon,
    desc: `Counts as one extra ${TRAITS[t].name} unit (if you have at least one on the board), and your ${TRAITS[t].name} units gain +${CREST_BOOST}% HP and damage.`,
    mods: { traitBoost: { [t]: CREST_BOOST } },
  };
}

export const has = (ids, id) => !!ids && ids.includes(id);

// Combined combat modifiers for a player's augments (numbers add up).
export function combatMods(ids) {
  return mergeMods(...(ids || []).map((id) => AUGMENTS[id]?.mods));
}

// Adds mod objects together (null entries are skipped). Returns null if empty.
export function mergeMods(...list) {
  const out = {};
  for (const m of list) {
    if (!m) continue;
    for (const k in m) {
      if (k === 'traitBoost') {
        out.traitBoost ||= {};
        for (const t in m.traitBoost) out.traitBoost[t] = (out.traitBoost[t] || 0) + m.traitBoost[t];
      } else {
        out[k] = (out[k] || 0) + m[k];
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

// Extra trait counts from crests: { trait: n }. `extra` (e.g. the arena rule's) is added on top.
export function traitBonus(ids, extra = null) {
  const out = { ...(extra || {}) };
  for (const id of ids || []) {
    const t = AUGMENTS[id]?.crest;
    if (t) out[t] = (out[t] || 0) + 1;
  }
  return Object.keys(out).length ? out : null;
}

// Three distinct augments the player doesn't own. Crests only for traits they have,
// and at most one crest per offer so there's always a real choice.
export function rollChoices(owned, ownedTraits, rand = Math.random) {
  const pool = Object.keys(AUGMENTS).filter((id) => !owned.includes(id)
    && (AUGMENTS[id].kind !== 'crest' || ownedTraits.has(AUGMENTS[id].crest)));
  const out = [];
  let crests = 0;
  while (out.length < CHOICES && pool.length) {
    const id = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    if (AUGMENTS[id].kind === 'crest') {
      if (crests) continue;
      crests++;
    }
    out.push(id);
  }
  return out;
}
