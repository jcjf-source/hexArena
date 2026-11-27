// Arena terrain: special hexes that buff whichever unit stands on them.
// A layout is a list of { x, y, type } in board coordinates (x 0..6, y 0 = front row),
// the same for every player's half. Combat mirrors it onto the enemy half through the
// arena's centre, so both sides always get the same terrain and the layout looks
// identical whichever side a viewer sits on.

import { mulberry32 } from './combat.js';

export const TERRAIN = {
  spring: { name: 'Healing Spring', icon: '💧', color: '#4fe0a0', desc: 'A unit standing here heals 4% of its max HP each second.' },
  high:   { name: 'High Ground',    icon: '⛰️', color: '#d8b46a', desc: 'A ranged unit standing here gains +1 range.' },
  cover:  { name: 'Cover',          icon: '🪨', color: '#9fb3c8', desc: 'A unit standing here takes 20% less damage.' },
  well:   { name: 'Mana Well',      icon: '💠', color: '#6aa8ff', desc: 'A unit standing here gains 8 mana each second.' },
  banner: { name: 'War Banner',     icon: '🚩', color: '#ff7a5a', desc: 'A unit standing here gains +25% attack speed.' },
};

export const DEFAULT_TILES = 3; // per half
export const SHIFT_EVERY = 6; // rounds between new layouts

// A seeded layout: `count` distinct hexes, at most two of any one type.
export function makeTerrain(seed, count = DEFAULT_TILES) {
  const rng = mulberry32(seed);
  const cells = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 7; x++) cells.push({ x, y });
  const types = Object.keys(TERRAIN);
  const used = {};
  const out = [];
  while (out.length < count && cells.length) {
    const cell = cells.splice(Math.floor(rng() * cells.length), 1)[0];
    let type = types[Math.floor(rng() * types.length)];
    for (let tries = 0; (used[type] || 0) >= 2 && tries < 10; tries++) type = types[Math.floor(rng() * types.length)];
    used[type] = (used[type] || 0) + 1;
    out.push({ ...cell, type });
  }
  return out;
}

export function terrainAt(terrain, x, y) {
  const t = terrain && terrain.find((c) => c.x === x && c.y === y);
  return t ? t.type : null;
}
