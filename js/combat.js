// Deterministic-step combat simulation. Independent of rendering so it can
// run headless (bot vs bot) or be visualised by the renderer via `events`.

import { UNITS, CREEPS, TRAITS, STAR_MULT } from './data.js';
import { COLS, hexDist, neighbors, cellKey } from './hex.js';

export const MAX_TIME = 40; // seconds before a fight is declared a draw
export const STEP = 1 / 30;
const MOVE_TIME = 0.38; // seconds to move one hex
// Terrain tuning (see terrain.js for the tile list).
const SPRING_HEAL = 0.07; // fraction of max HP per second
const WELL_MANA = 20; // mana per second
const COVER_REDUCTION = 0.3;
const BANNER_AS = 0.4;
const HIGH_DMG = 0.2; // ranged units on high ground also deal this much more damage
let NEXT_ID = 1;

// Small seeded PRNG so every client can replay an identical fight from a seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => Math.floor(Math.random() * 4294967296);

export function getDef(key) {
  return UNITS[key] || CREEPS[key];
}

// Counts unique units per trait (duplicates of the same unit only count once).
// bonus ({ trait: n }) adds extra count to traits that already have at least one unit (crests).
export function countTraits(units, bonus = null) {
  const seen = new Set();
  const counts = {};
  for (const u of units) {
    if (!u || seen.has(u.key)) continue;
    seen.add(u.key);
    const d = UNITS[u.key];
    if (!d) continue;
    for (const t of d.traits) counts[t] = (counts[t] || 0) + 1;
  }
  if (bonus) for (const t in bonus) if (counts[t]) counts[t] += bonus[t];
  return counts;
}

export function traitTier(key, count) {
  let tier = -1;
  TRAITS[key].breakpoints.forEach((b, i) => { if (count >= b) tier = i; });
  return tier;
}

export function activeTiers(units, bonus = null) {
  const counts = countTraits(units, bonus);
  const out = {};
  for (const k in counts) {
    const t = traitTier(k, counts[k]);
    if (t >= 0) out[k] = t;
  }
  return out;
}

function minBy(arr, f) {
  let best = null;
  let bv = Infinity;
  for (const a of arr) {
    const v = f(a);
    if (v < bv) { bv = v; best = a; }
  }
  return best;
}

const dist = (a, b) => hexDist(a.col, a.row, b.col, b.row);

function makeUnit(u, side, col, row, tiers, rng) {
  const def = getDef(u.key);
  const m = STAR_MULT[u.star - 1] * (u.scale || 1);
  const cu = {
    id: NEXT_ID++, key: u.key, def, star: u.star, scale: u.scale || 1, side,
    col, row, prevCol: col, prevRow: row, moving: false, moveT: 1,
    maxHp: def.hp * m, hp: 0, ad: def.ad * m, as: def.as, range: def.range,
    armor: def.armor, mr: def.mr,
    mana: def.mana ? def.mana[0] : 0, maxMana: def.mana ? def.mana[1] : 0,
    ap: 100, crit: 0.1, critDmg: 1.5, dmgAmp: 1, regen: 0, doubleChance: 0,
    shield: 0, shieldTime: 0, stun: 0, cd: 0.15 + rng() * 0.35,
    target: null, alive: true, ability: def.ability, dealt: 0,
    rebirth: def.passive?.type === 'rebirth' ? def.passive : null, reborn: false,
  };
  const has = (t) => def.traits.includes(t) && tiers[t] !== undefined;
  const val = (t) => TRAITS[t].values[tiers[t]];
  if (has('ember')) cu.dmgAmp += val('ember') / 100;
  if (has('tide')) cu.mana += val('tide');
  if (has('grove')) cu.regen = val('grove') / 100;
  if (has('storm')) cu.as *= 1 + val('storm') / 100;
  if (has('void')) { cu.crit += val('void') / 100; cu.critDmg = 2; }
  if (has('guardian')) cu.armor += val('guardian');
  if (has('striker')) cu.ad *= 1 + val('striker') / 100;
  if (has('ranger')) cu.doubleChance = val('ranger') / 100;
  if (has('arcanist')) cu.ap += val('arcanist');
  if (tiers.mystic !== undefined) cu.mr += TRAITS.mystic.values[tiers.mystic];
  if (def.mythic) cu.ap *= u.scale || 1; // mythic power scales its spells too
  cu.mana = Math.min(cu.mana, cu.maxMana);
  cu.hp = cu.maxHp;
  return cu;
}

// Team-wide modifiers from augments. y is the unit's board row (0 = front, 3 = back).
function applyMods(cu, m, y) {
  if (!m) return;
  if (m.manaCostPct && cu.maxMana) cu.maxMana = Math.max(10, Math.round(cu.maxMana * (1 + m.manaCostPct / 100)));
  if (m.hpPct) cu.maxHp *= 1 + m.hpPct / 100;
  if (m.dmgPct) cu.dmgAmp += m.dmgPct / 100;
  if (m.asPct) cu.as *= 1 + m.asPct / 100;
  if (m.armor) cu.armor += m.armor;
  if (m.mr) cu.mr += m.mr;
  if (m.ap) cu.ap += m.ap;
  if (m.critPct) cu.crit += m.critPct / 100;
  if (m.critDmgPct) cu.critDmg += m.critDmgPct / 100;
  if (m.backAsPct && y >= 2 && cu.range > 1) cu.as *= 1 + m.backAsPct / 100;
  if (m.mana && cu.maxMana) cu.mana = Math.min(cu.maxMana, cu.mana + m.mana);
  if (m.backRange && y >= 2 && cu.range > 1) cu.range += m.backRange;
  if (m.lifesteal) cu.lifesteal = m.lifesteal / 100;
  // Crests: units with the trait get +pct% max HP and damage.
  if (m.traitBoost) {
    const pct = cu.def.traits.reduce((s, t) => s + (m.traitBoost[t] || 0), 0);
    if (pct) { cu.maxHp *= 1 + pct / 100; cu.dmgAmp += pct / 100; }
  }
  cu.hp = cu.maxHp;
  if (m.frontShieldPct && y === 0) {
    cu.shield = cu.maxHp * m.frontShieldPct / 100;
    cu.shieldTime = 8;
  }
}

export class Combat {
  // teamA / teamB: arrays of { unit: {key, star, scale?}, x, y } in board coords
  // (x 0..6, y 0 = front row .. 3 = back row). Team A is drawn at the bottom.
  // tiersA / tiersB override each side's active traits ({ trait: tierIndex }).
  // modsA / modsB are team-wide augment modifiers (see applyMods).
  // terrain: [{ x, y, type }] in board coords, applied to both halves (mirrored for team B).
  constructor(teamA, teamB, {
    record = true, seed = randomSeed(), tiersA = null, tiersB = null, modsA = null, modsB = null, terrain = null,
  } = {}) {
    this.terrain = new Map();
    for (const t of terrain || []) {
      this.terrain.set(cellKey(t.x, 4 + t.y), t.type);
      this.terrain.set(cellKey(COLS - 1 - t.x, 3 - t.y), t.type);
    }
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.units = [];
    this.grid = new Map();
    this.time = 0;
    this.events = [];
    this.record = record;
    this.over = false;
    this.winner = null;
    const tA = tiersA || activeTiers(teamA.map((p) => p.unit));
    const tB = tiersB || activeTiers(teamB.map((p) => p.unit));
    for (const p of teamA) this.spawn(p.unit, 'A', p.x, 4 + p.y, tA, modsA, p.y);
    for (const p of teamB) this.spawn(p.unit, 'B', COLS - 1 - p.x, 3 - p.y, tB, modsB, p.y);
  }

  spawn(unit, side, col, row, tiers, mods = null, y = 0) {
    const cu = makeUnit(unit, side, col, row, tiers, this.rng);
    applyMods(cu, mods, y);
    this.units.push(cu);
    this.grid.set(cellKey(col, row), cu);
  }

  emit(e) {
    if (this.record) this.events.push(e);
  }

  enemiesOf(u) {
    return this.units.filter((e) => e.alive && e.side !== u.side);
  }

  alliesOf(u) {
    return this.units.filter((e) => e.alive && e.side === u.side);
  }

  survivors(side) {
    return this.units.filter((u) => u.alive && u.side === side);
  }

  nearestEnemy(u) {
    let best = null;
    let bd = Infinity;
    for (const e of this.units) {
      if (!e.alive || e.side === u.side) continue;
      const d = dist(u, e);
      if (d < bd || (d === bd && e.hp < best.hp)) { bd = d; best = e; }
    }
    return best;
  }

  runToEnd() {
    while (!this.over) this.step(STEP);
    return this;
  }

  step(dt) {
    if (this.over) return;
    this.time += dt;
    for (const u of this.units) if (u.alive) this.updateUnit(u, dt);
    const a = this.units.some((u) => u.alive && u.side === 'A');
    const b = this.units.some((u) => u.alive && u.side === 'B');
    if (!a || !b) {
      this.over = true;
      this.winner = a ? 'A' : b ? 'B' : 'draw';
    } else if (this.time >= MAX_TIME) {
      this.over = true;
      this.winner = 'draw';
    }
  }

  tileOf(u) {
    return this.terrain.get(cellKey(u.col, u.row));
  }

  // High ground gives ranged units +1 range.
  rangeOf(u, tile) {
    return u.range + (tile === 'high' && u.range > 1 ? 1 : 0);
  }

  updateUnit(u, dt) {
    const tile = this.terrain.size ? this.tileOf(u) : undefined;
    if (tile === 'spring' && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * SPRING_HEAL * dt);
    if (tile === 'well' && u.maxMana > 0) u.mana = Math.min(u.maxMana, u.mana + WELL_MANA * dt);
    if (u.shieldTime > 0) {
      u.shieldTime -= dt;
      if (u.shieldTime <= 0) u.shield = 0;
    }
    if (u.regen > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * u.regen * dt);

    if (u.moving) {
      u.moveT += dt / MOVE_TIME;
      if (u.moveT >= 1) { u.moveT = 1; u.moving = false; } else return;
    }
    if (u.stun > 0) { u.stun -= dt; return; }
    u.cd -= dt;

    const range = this.rangeOf(u, tile);
    if (!u.target || !u.target.alive || dist(u, u.target) > range) {
      u.target = this.nearestEnemy(u);
      if (!u.target) return;
    }

    if (dist(u, u.target) <= range) {
      if (u.maxMana > 0 && u.mana >= u.maxMana) {
        u.mana = 0;
        this.cast(u);
        u.cd = Math.max(u.cd, 0.25);
        return;
      }
      if (u.cd <= 0) {
        this.attack(u, u.target);
        u.cd = 1 / (u.as * (tile === 'banner' ? 1 + BANNER_AS : 1));
      }
    } else {
      this.moveToward(u, u.target);
    }
  }

  moveToward(u, target) {
    // BFS through free hexes for the closest cell within range of the target.
    const startKey = cellKey(u.col, u.row);
    const visited = new Set([startKey]);
    const queue = [[u.col, u.row, null]];
    let step = null;
    while (queue.length && !step) {
      const [c, r, first] = queue.shift();
      for (const [nc, nr] of neighbors(c, r)) {
        const k = cellKey(nc, nr);
        if (visited.has(k)) continue;
        visited.add(k);
        if (this.grid.has(k)) continue;
        const f = first || [nc, nr];
        if (hexDist(nc, nr, target.col, target.row) <= u.range) { step = f; break; }
        queue.push([nc, nr, f]);
      }
    }
    if (!step) {
      // Blocked: shuffle to any free neighbour that gets closer.
      const cur = dist(u, target);
      const opts = neighbors(u.col, u.row).filter(([c, r]) => !this.grid.has(cellKey(c, r))
        && hexDist(c, r, target.col, target.row) < cur);
      if (opts.length) step = opts[0];
    }
    if (!step) return;
    this.grid.delete(cellKey(u.col, u.row));
    u.prevCol = u.col; u.prevRow = u.row;
    u.col = step[0]; u.row = step[1];
    this.grid.set(cellKey(u.col, u.row), u);
    u.moving = true;
    u.moveT = 0;
  }

  attack(u, t) {
    const hits = u.doubleChance && this.rng() < u.doubleChance ? 2 : 1;
    for (let i = 0; i < hits; i++) {
      const crit = this.rng() < u.crit;
      this.emit({ type: 'attack', from: u.id, to: t.id, ranged: u.range > 1, delay: i * 0.08 });
      this.damage(u, t, u.ad * (crit ? u.critDmg : 1), 'phys', crit);
    }
    if (u.maxMana > 0) u.mana = Math.min(u.maxMana, u.mana + 10);
  }

  damage(src, t, amount, kind, crit = false) {
    if (!t.alive) return;
    let pre = amount * src.dmgAmp;
    if (this.terrain.size && src.range > 1 && this.tileOf(src) === 'high') pre *= 1 + HIGH_DMG;
    const resist = kind === 'phys' ? t.armor : t.mr;
    let dealt = pre * 100 / (100 + Math.max(0, resist));
    if (this.terrain.size && this.tileOf(t) === 'cover') dealt *= 1 - COVER_REDUCTION;
    if (t.maxMana > 0) t.mana = Math.min(t.maxMana, t.mana + Math.min(pre * 0.05, 12));
    if (t.shield > 0) {
      const ab = Math.min(t.shield, dealt);
      t.shield -= ab;
      dealt -= ab;
    }
    t.hp -= dealt;
    src.dealt += dealt;
    if (src.lifesteal && src.alive) src.hp = Math.min(src.maxHp, src.hp + dealt * src.lifesteal);
    this.emit({ type: 'dmg', unit: t.id, amount: Math.round(dealt), crit, kind });
    if (t.hp <= 0 && t.rebirth && !t.reborn) {
      this.rebirth(t);
      return;
    }
    if (t.hp <= 0) {
      t.hp = 0;
      t.alive = false;
      this.grid.delete(cellKey(t.col, t.row));
      this.emit({ type: 'death', unit: t.id });
    }
  }

  // Mythic passive: revive once per fight and explode.
  rebirth(u) {
    const p = u.rebirth;
    u.reborn = true;
    u.hp = u.maxHp * p.hpPct / 100;
    u.stun = 0;
    this.emit({ type: 'rebirth', unit: u.id });
    this.emit({ type: 'aoe', col: u.col, row: u.row, radius: p.radius, kind: 'magic' });
    for (const e of this.enemiesOf(u)) if (dist(u, e) <= p.radius) this.damage(u, e, p.dmg * u.ap / 100, 'magic');
  }

  heal(u, amount) {
    if (!u || !u.alive) return;
    const real = Math.min(amount, u.maxHp - u.hp);
    u.hp += real;
    this.emit({ type: 'heal', unit: u.id, amount: Math.round(real) });
  }

  stunUnit(t, secs) {
    if (!t.alive || !secs) return;
    t.stun = Math.max(t.stun, secs);
    this.emit({ type: 'stun', unit: t.id });
  }

  cast(u) {
    const ab = u.ability;
    if (!ab) return;
    const s = u.star - 1;
    const V = (x) => (Array.isArray(x) ? x[s] : x);
    const ap = u.ap / 100;
    const enemies = this.enemiesOf(u);
    const t = u.target && u.target.alive ? u.target : this.nearestEnemy(u);
    const kind = ab.dmgType || 'magic';
    this.emit({ type: 'cast', unit: u.id, name: ab.name });

    switch (ab.type) {
      case 'shield':
        u.shield += V(ab.amount) * ap;
        u.shieldTime = ab.dur || 4;
        this.emit({ type: 'shield', unit: u.id });
        break;
      case 'nuke':
        if (!t) break;
        this.emit({ type: 'beam', from: u.id, to: t.id, kind });
        this.damage(u, t, V(ab.dmg) * ap, kind);
        if (ab.stun) this.stunUnit(t, V(ab.stun));
        break;
      case 'snipe': {
        const tg = minBy(enemies, (e) => e.hp);
        if (!tg) break;
        this.emit({ type: 'beam', from: u.id, to: tg.id, kind });
        this.damage(u, tg, V(ab.dmg) * ap, kind);
        break;
      }
      case 'multishot': {
        enemies.sort((a, b) => dist(u, a) - dist(u, b));
        for (const e of enemies.slice(0, V(ab.count))) {
          this.emit({ type: 'beam', from: u.id, to: e.id, kind });
          this.damage(u, e, V(ab.dmg) * ap, kind);
        }
        break;
      }
      case 'frenzy':
        u.as *= 1 + V(ab.pct) / 100;
        this.emit({ type: 'buff', unit: u.id });
        break;
      case 'slam':
        this.emit({ type: 'aoe', col: u.col, row: u.row, radius: ab.radius, kind });
        for (const e of enemies) {
          if (dist(u, e) <= ab.radius) {
            this.damage(u, e, V(ab.dmg) * ap, kind);
            if (ab.stun) this.stunUnit(e, V(ab.stun));
          }
        }
        break;
      case 'aoe': {
        if (!t) break;
        const c = { col: t.col, row: t.row };
        this.emit({ type: 'beam', from: u.id, to: t.id, kind });
        this.emit({ type: 'aoe', col: c.col, row: c.row, radius: ab.radius, kind });
        for (const e of enemies) {
          if (dist(c, e) <= ab.radius) {
            this.damage(u, e, V(ab.dmg) * ap, kind);
            if (ab.stun) this.stunUnit(e, V(ab.stun));
          }
        }
        break;
      }
      case 'chain': {
        let cur = t;
        let prev = u;
        const hit = new Set();
        for (let i = 0; i < ab.bounces && cur; i++) {
          this.emit({ type: 'beam', from: prev.id, to: cur.id, kind: 'chain' });
          this.damage(u, cur, V(ab.dmg) * ap, kind);
          hit.add(cur);
          prev = cur;
          cur = minBy(this.enemiesOf(u).filter((e) => !hit.has(e)), (e) => dist(prev, e));
        }
        break;
      }
      case 'heal': {
        const tg = minBy(this.alliesOf(u), (a) => a.hp / a.maxHp);
        this.heal(tg, V(ab.amount) * ap);
        break;
      }
      case 'teamheal':
        for (const a of this.alliesOf(u)) this.heal(a, V(ab.amount) * ap);
        break;
      case 'dash': {
        const tg = minBy(enemies, (e) => e.hp);
        if (!tg) break;
        const spots = neighbors(tg.col, tg.row).filter(([c, r]) => !this.grid.has(cellKey(c, r)));
        if (spots.length) {
          const [c, r] = minBy(spots, ([c2, r2]) => hexDist(c2, r2, u.col, u.row));
          this.emit({ type: 'blink', unit: u.id, fromCol: u.col, fromRow: u.row, toCol: c, toRow: r });
          this.grid.delete(cellKey(u.col, u.row));
          u.col = c; u.row = r; u.prevCol = c; u.prevRow = r;
          u.moving = false; u.moveT = 1;
          this.grid.set(cellKey(c, r), u);
        }
        this.damage(u, tg, V(ab.dmg) * ap, kind);
        u.target = tg;
        break;
      }
      default:
        break;
    }
  }
}
