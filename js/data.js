// Game data: units, traits, creeps and economy tables.

export const COST_COLORS = { 1: '#9aa4b1', 2: '#3fbf6f', 3: '#3c8dff', 4: '#b45cff', 5: '#ffb52e' };

// Copies of each unit in the shared pool, by cost.
export const POOL_SIZE = { 1: 29, 2: 22, 3: 18, 4: 12, 5: 10 };

// Shop odds (%) for costs 1..5 at each player level.
export const SHOP_ODDS = {
  1: [100, 0, 0, 0, 0],
  2: [100, 0, 0, 0, 0],
  3: [75, 25, 0, 0, 0],
  4: [55, 30, 15, 0, 0],
  5: [45, 33, 20, 2, 0],
  6: [30, 40, 25, 5, 0],
  7: [19, 30, 35, 15, 1],
  8: [18, 25, 32, 22, 3],
  9: [10, 20, 25, 35, 10],
};

// XP needed to go from level N to N+1 (index = current level).
export const XP_TO_LEVEL = [0, 2, 2, 6, 10, 20, 36, 56, 80];
export const MAX_LEVEL = 9;

export const STAR_MULT = [1, 1.8, 3.24];

export const TRAITS = {
  ember:    { name: 'Ember',    icon: '🔥', breakpoints: [2, 4],    values: [20, 45],      desc: 'Ember units deal +{v}% damage.' },
  tide:     { name: 'Tide',     icon: '🌊', breakpoints: [2, 4],    values: [30, 60],      desc: 'Tide units start combat with +{v} mana.' },
  grove:    { name: 'Grove',    icon: '🌿', breakpoints: [2, 4, 6], values: [2, 3, 5],     desc: 'Grove units regenerate {v}% of their max HP each second.' },
  storm:    { name: 'Storm',    icon: '⚡', breakpoints: [2, 4],    values: [25, 60],      desc: 'Storm units gain +{v}% attack speed.' },
  void:     { name: 'Void',     icon: '🌑', breakpoints: [2, 4],    values: [35, 70],      desc: 'Void units gain +{v}% critical strike chance, and their crits deal 200% damage.' },
  guardian: { name: 'Guardian', icon: '🛡️', breakpoints: [2, 4, 6], values: [35, 80, 200], desc: 'Guardians gain +{v} armor.' },
  striker:  { name: 'Striker',  icon: '⚔️', breakpoints: [2, 4],    values: [25, 60],      desc: 'Strikers gain +{v}% attack damage.' },
  ranger:   { name: 'Ranger',   icon: '🏹', breakpoints: [2, 4],    values: [30, 65],      desc: 'Rangers have a {v}% chance to attack twice.' },
  mystic:   { name: 'Mystic',   icon: '🔮', breakpoints: [2, 4],    values: [30, 70],      desc: 'All allies gain +{v} magic resist.' },
  arcanist: { name: 'Arcanist', icon: '✨', breakpoints: [2, 4],    values: [40, 60],      desc: 'Arcanists gain +{v} ability power.' },
};

// Ability types: shield, nuke, snipe, multishot, frenzy, slam, aoe, chain, heal, teamheal, dash.
// Array values are per star level [1★, 2★, 3★]. Damage/heal/shield scale with ability power.
export const UNITS = {
  // ---------- 1 cost ----------
  cinderpup: { name: 'Cinderpup', icon: '🦊', cost: 1, traits: ['ember', 'guardian'],
    hp: 650, ad: 50, as: 0.6, range: 1, armor: 40, mr: 30, mana: [30, 80],
    ability: { name: 'Ember Ward', type: 'shield', amount: [200, 320, 520], dur: 4, desc: 'Gains a {amount} shield for 4s.' } },
  brookling: { name: 'Brookling', icon: '🐸', cost: 1, traits: ['tide', 'arcanist'],
    hp: 450, ad: 40, as: 0.65, range: 3, armor: 15, mr: 15, mana: [0, 60],
    ability: { name: 'Bubble Burst', type: 'nuke', dmg: [240, 360, 540], desc: 'Blasts its target for {dmg} magic damage.' } },
  thornling: { name: 'Thornling', icon: '🌵', cost: 1, traits: ['grove', 'ranger'],
    hp: 450, ad: 50, as: 0.7, range: 4, armor: 15, mr: 15, mana: [0, 70],
    ability: { name: 'Needle Spray', type: 'multishot', count: [3, 3, 4], dmg: [120, 180, 280], desc: 'Fires needles at the {count} nearest enemies for {dmg} magic damage.' } },
  sparkit: { name: 'Sparkit', icon: '🐹', cost: 1, traits: ['storm', 'striker'],
    hp: 620, ad: 55, as: 0.85, range: 1, armor: 25, mr: 20, mana: [0, 50],
    ability: { name: 'Overcharge', type: 'frenzy', pct: [55, 75, 110], desc: 'Permanently gains +{pct}% attack speed.' } },
  gloomling: { name: 'Gloomling', icon: '👻', cost: 1, traits: ['void', 'mystic'],
    hp: 550, ad: 50, as: 0.65, range: 1, armor: 25, mr: 30, mana: [20, 70],
    ability: { name: 'Dread Touch', type: 'nuke', dmg: [150, 220, 350], stun: [1.5, 1.75, 2], desc: 'Deals {dmg} magic damage and stuns its target for {stun}s.' } },
  mossback: { name: 'Mossback', icon: '🐢', cost: 1, traits: ['grove', 'guardian'],
    hp: 700, ad: 45, as: 0.55, range: 1, armor: 45, mr: 25, mana: [40, 100],
    ability: { name: 'Shell Quake', type: 'slam', radius: 1, dmg: [100, 150, 250], stun: [0.75, 1, 1.25], desc: 'Slams the ground, dealing {dmg} magic damage to adjacent enemies and stunning them for {stun}s.' } },

  // ---------- 2 cost ----------
  ashblade: { name: 'Ashblade', icon: '🗡️', cost: 2, traits: ['ember', 'striker'],
    hp: 650, ad: 65, as: 0.7, range: 1, armor: 30, mr: 25, mana: [0, 60],
    ability: { name: 'Searing Cut', type: 'nuke', dmg: [250, 375, 600], dmgType: 'phys', desc: 'Slashes its target for {dmg} physical damage.' } },
  reefwarden: { name: 'Reefwarden', icon: '🦀', cost: 2, traits: ['tide', 'guardian'],
    hp: 800, ad: 55, as: 0.6, range: 1, armor: 50, mr: 35, mana: [40, 100],
    ability: { name: 'Riptide Slam', type: 'slam', radius: 1, dmg: [150, 225, 350], stun: [0.75, 0.75, 1], desc: 'Deals {dmg} magic damage to adjacent enemies and stuns them for {stun}s.' } },
  galehawk: { name: 'Galehawk', icon: '🦅', cost: 2, traits: ['storm', 'ranger'],
    hp: 550, ad: 60, as: 0.75, range: 4, armor: 20, mr: 20, mana: [0, 70],
    ability: { name: 'Feather Volley', type: 'multishot', count: [4, 4, 5], dmg: [100, 150, 240], desc: 'Strikes the {count} nearest enemies for {dmg} magic damage.' } },
  hexweaver: { name: 'Hexweaver', icon: '🕷️', cost: 2, traits: ['void', 'arcanist'],
    hp: 500, ad: 45, as: 0.65, range: 3, armor: 20, mr: 20, mana: [20, 80],
    ability: { name: 'Hex Chain', type: 'chain', bounces: 4, dmg: [180, 270, 420], desc: 'Hurls a curse that bounces between 4 enemies, dealing {dmg} magic damage each.' } },
  willowsage: { name: 'Willowsage', icon: '🦉', cost: 2, traits: ['grove', 'mystic'],
    hp: 600, ad: 40, as: 0.6, range: 3, armor: 25, mr: 30, mana: [30, 80],
    ability: { name: 'Mending Bloom', type: 'heal', amount: [290, 430, 690], desc: 'Heals the most wounded ally for {amount}.' } },

  // ---------- 3 cost ----------
  pyromancer: { name: 'Pyromancer', icon: '🧙', cost: 3, traits: ['ember', 'arcanist'],
    hp: 650, ad: 50, as: 0.7, range: 3, armor: 25, mr: 25, mana: [20, 80],
    ability: { name: 'Fireball', type: 'aoe', radius: 1, dmg: [345, 520, 860], desc: 'Launches a fireball dealing {dmg} magic damage to the target and enemies around it.' } },
  tidecaller: { name: 'Tidecaller', icon: '🧜', cost: 3, traits: ['tide', 'mystic'],
    hp: 700, ad: 50, as: 0.65, range: 3, armor: 30, mr: 35, mana: [30, 90],
    ability: { name: 'Crashing Wave', type: 'aoe', radius: 1, dmg: [270, 400, 650], stun: [1, 1, 1.25], desc: 'Summons a wave around the target dealing {dmg} magic damage and stunning for {stun}s.' } },
  thunderfist: { name: 'Thunderfist', icon: '🦍', cost: 3, traits: ['storm', 'guardian'],
    hp: 950, ad: 70, as: 0.65, range: 1, armor: 55, mr: 40, mana: [50, 100],
    ability: { name: 'Thunderclap', type: 'slam', radius: 1, dmg: [200, 300, 500], stun: [1, 1, 1.5], desc: 'Deals {dmg} magic damage to adjacent enemies and stuns them for {stun}s.' } },
  shadeblade: { name: 'Shadeblade', icon: '🥷', cost: 3, traits: ['void', 'striker'],
    hp: 850, ad: 80, as: 0.8, range: 1, armor: 30, mr: 25, mana: [0, 60],
    ability: { name: 'Shadow Step', type: 'dash', dmg: [400, 600, 1000], dmgType: 'phys', desc: 'Teleports to the weakest enemy and strikes for {dmg} physical damage.' } },
  briarshot: { name: 'Briarshot', icon: '🦌', cost: 3, traits: ['grove', 'ranger'],
    hp: 650, ad: 70, as: 0.75, range: 4, armor: 25, mr: 25, mana: [0, 60],
    ability: { name: 'Thorn Snipe', type: 'snipe', dmg: [350, 525, 850], dmgType: 'phys', desc: 'Snipes the lowest-health enemy for {dmg} physical damage.' } },

  // ---------- 4 cost ----------
  magmalord: { name: 'Magmalord', icon: '👹', cost: 4, traits: ['ember', 'guardian'],
    hp: 1100, ad: 80, as: 0.65, range: 1, armor: 60, mr: 45, mana: [60, 120],
    ability: { name: 'Eruption', type: 'slam', radius: 2, dmg: [300, 450, 1200], stun: [1, 1.5, 2.5], desc: 'Erupts, dealing {dmg} magic damage to enemies within 2 hexes and stunning them for {stun}s.' } },
  leviathan: { name: 'Leviathan', icon: '🐋', cost: 4, traits: ['tide', 'striker'],
    hp: 1000, ad: 95, as: 0.75, range: 1, armor: 45, mr: 35, mana: [0, 70],
    ability: { name: 'Tail Crash', type: 'aoe', radius: 1, dmg: [350, 525, 1300], dmgType: 'phys', desc: 'Crashes down on its target, dealing {dmg} physical damage to it and nearby enemies.' } },
  stormcaller: { name: 'Stormcaller', icon: '🌩️', cost: 4, traits: ['storm', 'arcanist'],
    hp: 750, ad: 55, as: 0.75, range: 4, armor: 25, mr: 30, mana: [30, 90],
    ability: { name: 'Chain Lightning', type: 'chain', bounces: 6, dmg: [300, 450, 1100], desc: 'Lightning arcs between 6 enemies, dealing {dmg} magic damage each.' } },
  nullwalker: { name: 'Nullwalker', icon: '👁️', cost: 4, traits: ['void', 'ranger'],
    hp: 800, ad: 90, as: 0.8, range: 4, armor: 30, mr: 30, mana: [0, 80],
    ability: { name: 'Null Ray', type: 'snipe', dmg: [600, 900, 2200], desc: 'Fires a ray at the lowest-health enemy dealing {dmg} magic damage.' } },
  elderoak: { name: 'Elderoak', icon: '🌳', cost: 4, traits: ['grove', 'mystic'],
    hp: 1000, ad: 60, as: 0.6, range: 2, armor: 45, mr: 50, mana: [40, 90],
    ability: { name: 'Sap of Life', type: 'teamheal', amount: [300, 450, 1100], desc: 'Heals all allies for {amount}.' } },

  // ---------- 5 cost ----------
  pyrewyrm: { name: 'Pyrewyrm', icon: '🐲', cost: 5, traits: ['ember', 'mystic'],
    hp: 1100, ad: 80, as: 0.75, range: 3, armor: 40, mr: 40, mana: [40, 110],
    ability: { name: 'Meteor', type: 'aoe', radius: 2, dmg: [575, 860, 3450], desc: 'Calls a meteor dealing {dmg} magic damage to enemies within 2 hexes of the target.' } },
  colossus: { name: 'Gaia Colossus', icon: '🗿', cost: 5, traits: ['grove', 'guardian'],
    hp: 1400, ad: 90, as: 0.6, range: 1, armor: 75, mr: 60, mana: [80, 150],
    ability: { name: 'Worldbreaker', type: 'slam', radius: 2, dmg: [400, 600, 3000], stun: [1.75, 2.25, 6], desc: 'Shatters the earth, dealing {dmg} magic damage within 2 hexes and stunning for {stun}s.' } },
  abyssqueen: { name: 'Abyss Queen', icon: '🦑', cost: 5, traits: ['void', 'arcanist'],
    hp: 950, ad: 60, as: 0.75, range: 4, armor: 30, mr: 40, mana: [50, 120],
    ability: { name: 'Abyssal Tide', type: 'aoe', radius: 2, dmg: [630, 950, 4000], stun: [1, 1, 2], desc: 'Engulfs the target area, dealing {dmg} magic damage within 2 hexes and stunning for {stun}s.' } },
  djinn: { name: 'Tempest Djinn', icon: '🧞', cost: 5, traits: ['storm', 'striker'],
    hp: 1350, ad: 110, as: 0.85, range: 1, armor: 50, mr: 40, mana: [0, 80],
    ability: { name: 'Cyclone Strike', type: 'dash', dmg: [800, 1200, 3500], dmgType: 'phys', desc: 'Blinks to the weakest enemy and strikes for {dmg} physical damage.' } },
  kraken: { name: 'Kraken', icon: '🐙', cost: 5, traits: ['tide', 'ranger'],
    hp: 1100, ad: 95, as: 0.8, range: 4, armor: 35, mr: 35, mana: [0, 90],
    ability: { name: 'Ink Barrage', type: 'multishot', count: [6, 6, 10], dmg: [350, 525, 2000], desc: 'Fires at the {count} nearest enemies for {dmg} magic damage.' } },
};

// Neutral monsters for PvE rounds.
export const CREEPS = {
  slime:    { name: 'Slime',            icon: '🟢', cost: 1, traits: [], hp: 280,  ad: 28,  as: 0.6, range: 1, armor: 10, mr: 10, mana: null, ability: null },
  wolf:     { name: 'Dire Wolf',        icon: '🐺', cost: 2, traits: [], hp: 520,  ad: 50,  as: 0.8, range: 1, armor: 20, mr: 20, mana: null, ability: null },
  golem:    { name: 'Stone Golem',      icon: '🪨', cost: 3, traits: [], hp: 1400, ad: 70,  as: 0.5, range: 1, armor: 60, mr: 30, mana: null, ability: null },
  drake:    { name: 'Drake',            icon: '🐉', cost: 4, traits: [], hp: 2200, ad: 110, as: 0.7, range: 2, armor: 50, mr: 50, mana: null, ability: null },
  behemoth: { name: 'Ancient Behemoth', icon: '🦖', cost: 5, traits: [], hp: 5000, ad: 180, as: 0.6, range: 1, armor: 80, mr: 80, mana: null, ability: null },
};

export function isPveRound(round) {
  return round <= 3 || (round >= 9 && (round - 9) % 6 === 0);
}

// Creep layouts, in the same (x, y) board coordinates players use (y=0 is the front row).
export function creepWave(round) {
  const W = (key, x, y, star = 1, scale = 1) => ({ unit: { key, star, scale }, x, y });
  if (round === 1) return [W('slime', 2, 0), W('slime', 4, 0)];
  if (round === 2) return [W('slime', 1, 0), W('slime', 3, 0), W('slime', 5, 0)];
  if (round === 3) return [W('wolf', 2, 0), W('wolf', 4, 0), W('slime', 3, 1)];
  const tier = Math.floor((round - 9) / 6);
  if (tier === 0) return [W('wolf', 1, 0, 2), W('wolf', 5, 0, 2), W('golem', 3, 0), W('wolf', 3, 2)];
  if (tier === 1) return [W('golem', 2, 0, 2), W('golem', 4, 0, 2), W('wolf', 1, 1, 2), W('wolf', 5, 1, 2), W('drake', 3, 3)];
  if (tier === 2) return [W('golem', 2, 0, 2), W('golem', 4, 0, 2), W('drake', 1, 3, 2), W('drake', 5, 3, 2), W('wolf', 3, 1, 3)];
  const s = 1 + (tier - 3) * 0.5;
  return [W('behemoth', 3, 0, 1, s), W('drake', 1, 3, 2, s), W('drake', 5, 3, 2, s), W('golem', 2, 1, 2, s), W('golem', 4, 1, 2, s)];
}

export function fillTemplate(text, obj, star) {
  return text.replace(/\{(\w+)\}/g, (_, k) => {
    const v = obj[k];
    if (!Array.isArray(v)) return String(v);
    if (star) return `<b>${v[star - 1]}</b>`;
    return v.join('/');
  });
}

export function traitDesc(key) {
  const t = TRAITS[key];
  return t.desc.replace('{v}', t.values.join('/'));
}
