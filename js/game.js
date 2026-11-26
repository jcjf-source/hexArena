// Game state: players, economy, shop, shared pool, rounds and bot opponents.

import {
  UNITS, POOL_SIZE, SHOP_ODDS, XP_TO_LEVEL, MAX_LEVEL, isPveRound, creepWave,
} from './data.js';
import { Combat, STEP, countTraits } from './combat.js';

export const BOARD_W = 7;
export const BOARD_H = 4;
export const BENCH_SIZE = 9;
export const SHOP_SIZE = 5;
export const REROLL_COST = 2;
export const XP_COST = 4;
const PLANNING_TIME = 30;

const BOT_NAMES = ['Ember Bot', 'Tidal Bot', 'Grove Bot', 'Storm Bot', 'Void Bot', 'Iron Bot', 'Arcane Bot'];

let UID = 1;
const makeInst = (key, star = 1) => ({ uid: UID++, key, star });
const rand = (n) => Math.floor(Math.random() * n);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sellValue(u) {
  return UNITS[u.key].cost * Math.pow(3, u.star - 1);
}

function newPlayer(id, name, isHuman) {
  return {
    id, name, isHuman,
    hp: 100, gold: 0, level: 1, xp: 0,
    board: Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null)),
    bench: Array(BENCH_SIZE).fill(null),
    shop: [], locked: false,
    streak: 0, alive: true, placement: 0, lastOpp: null,
  };
}

export class Game {
  constructor({ humanIsBot = false } = {}) {
    this.pool = {};
    for (const k in UNITS) this.pool[k] = POOL_SIZE[UNITS[k].cost];
    this.players = [newPlayer(0, 'You', !humanIsBot)];
    BOT_NAMES.forEach((n, i) => this.players.push(newPlayer(i + 1, n, false)));
    this.human = this.players[0];
    this.round = 0;
    this.phase = 'planning'; // planning | combat | results | gameover
    this.timer = 0;
    this.speed = 1;
    this.combat = null; // the human's visible combat
    this.humanMatch = null;
    this.matches = [];
    this.acc = 0;
    this.postCombat = 0;
    this.lastResult = null;
    this.onChange = () => {};
    this.onBanner = () => {};
  }

  // ------------------------------------------------------------ helpers
  get boardLocked() { return this.phase !== 'planning'; }

  alivePlayers() { return this.players.filter((p) => p.alive); }

  getAt(p, loc) {
    return loc.area === 'board' ? p.board[loc.y][loc.x] : p.bench[loc.i];
  }

  setAt(p, loc, u) {
    if (loc.area === 'board') p.board[loc.y][loc.x] = u;
    else p.bench[loc.i] = u;
  }

  boardUnits(p) {
    const out = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) if (p.board[y][x]) out.push({ unit: p.board[y][x], x, y });
    }
    return out;
  }

  boardCount(p) { return this.boardUnits(p).length; }

  allUnits(p) {
    const out = this.boardUnits(p).map((b) => ({ unit: b.unit, loc: { area: 'board', x: b.x, y: b.y } }));
    p.bench.forEach((u, i) => { if (u) out.push({ unit: u, loc: { area: 'bench', i } }); });
    return out;
  }

  xpNeeded(p) { return p.level >= MAX_LEVEL ? 0 : XP_TO_LEVEL[p.level]; }

  changed() { this.onChange(); }

  // ------------------------------------------------------------ shop & pool
  pickFromPool(level) {
    const odds = SHOP_ODDS[level];
    let roll = Math.random() * 100;
    let cost = 1;
    for (let i = 0; i < 5; i++) {
      if (roll < odds[i]) { cost = i + 1; break; }
      roll -= odds[i];
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = ((cost - 1 - attempt + 5) % 5) + 1;
      const keys = Object.keys(UNITS).filter((k) => UNITS[k].cost === c && this.pool[k] > 0);
      const total = keys.reduce((s, k) => s + this.pool[k], 0);
      if (!total) continue;
      let r = Math.random() * total;
      for (const k of keys) {
        r -= this.pool[k];
        if (r < 0) return k;
      }
      return keys[keys.length - 1];
    }
    return null;
  }

  rollShop(p) {
    p.shop = Array.from({ length: SHOP_SIZE }, () => this.pickFromPool(p.level));
  }

  returnToPool(u) {
    this.pool[u.key] += Math.pow(3, u.star - 1);
  }

  findCopies(p, key, star, includeBoard) {
    return this.allUnits(p).filter((l) => l.unit.key === key && l.unit.star === star
      && (includeBoard || l.loc.area === 'bench'));
  }

  combine(p, key) {
    let upgraded = false;
    for (let star = 1; star <= 2; star++) {
      let copies = this.findCopies(p, key, star, !this.boardLocked);
      while (copies.length >= 3) {
        const [keep, a, b] = copies;
        this.setAt(p, a.loc, null);
        this.setAt(p, b.loc, null);
        this.setAt(p, keep.loc, makeInst(key, star + 1));
        upgraded = true;
        copies = this.findCopies(p, key, star, !this.boardLocked);
      }
    }
    return upgraded;
  }

  combineAll(p) {
    for (const k of new Set(this.allUnits(p).map((l) => l.unit.key))) this.combine(p, k);
  }

  // Would buying this unit fit (free slot, or it completes a 3-of-a-kind)?
  canBuy(p, key) {
    if (!key || p.gold < UNITS[key].cost) return false;
    if (p.bench.includes(null)) return true;
    return this.findCopies(p, key, 1, !this.boardLocked).length >= 2;
  }

  buy(p, i) {
    const key = p.shop[i];
    if (!this.canBuy(p, key)) return false;
    p.gold -= UNITS[key].cost;
    this.pool[key]--;
    p.shop[i] = null;
    const unit = makeInst(key);
    const slot = p.bench.indexOf(null);
    if (slot >= 0) p.bench[slot] = unit;
    else p.bench.push(unit); // temporary 10th slot, consumed by the combine below
    const up = this.combine(p, key);
    while (p.bench.length > BENCH_SIZE) {
      const extra = p.bench.pop();
      if (extra) {
        const idx = p.bench.indexOf(null);
        if (idx >= 0) p.bench[idx] = extra;
        else { this.returnToPool(extra); p.gold += sellValue(extra); }
      }
    }
    if (p.isHuman && up) this.onBanner('★ Star up!', 'star');
    if (p.isHuman) this.changed();
    return true;
  }

  reroll(p) {
    if (p.gold < REROLL_COST) return false;
    p.gold -= REROLL_COST;
    this.rollShop(p);
    if (p.isHuman) this.changed();
    return true;
  }

  buyXp(p) {
    if (p.gold < XP_COST || p.level >= MAX_LEVEL) return false;
    p.gold -= XP_COST;
    this.addXp(p, 4);
    if (p.isHuman) this.changed();
    return true;
  }

  addXp(p, n) {
    if (p.level >= MAX_LEVEL) return;
    p.xp += n;
    while (p.level < MAX_LEVEL && p.xp >= XP_TO_LEVEL[p.level]) {
      p.xp -= XP_TO_LEVEL[p.level];
      p.level++;
    }
    if (p.level >= MAX_LEVEL) p.xp = 0;
  }

  sell(p, loc) {
    const u = this.getAt(p, loc);
    if (!u) return false;
    if (loc.area === 'board' && this.boardLocked) return false;
    p.gold += sellValue(u);
    this.returnToPool(u);
    this.setAt(p, loc, null);
    if (p.isHuman) this.changed();
    return true;
  }

  moveUnit(p, from, to) {
    if (from.area === to.area && from.x === to.x && from.y === to.y && from.i === to.i) return false;
    if (this.boardLocked && (from.area === 'board' || to.area === 'board')) return false;
    const a = this.getAt(p, from);
    const b = this.getAt(p, to);
    if (!a) return false;
    if (to.area === 'board' && from.area === 'bench' && !b && this.boardCount(p) >= p.level) return false;
    this.setAt(p, to, a);
    this.setAt(p, from, b);
    if (p.isHuman) this.changed();
    return true;
  }

  toggleLock(p) {
    p.locked = !p.locked;
    this.changed();
  }

  // Fill empty board slots from the bench (used when the timer expires).
  autoFill(p) {
    const order = [3, 2, 4, 1, 5, 0, 6];
    while (this.boardCount(p) < p.level) {
      let best = -1;
      p.bench.forEach((u, i) => {
        if (u && (best < 0 || sellValue(u) > sellValue(p.bench[best]))) best = i;
      });
      if (best < 0) return;
      const u = p.bench[best];
      const ranged = UNITS[u.key].range > 1;
      const rows = ranged ? [3, 2, 1, 0] : [0, 1, 2, 3];
      let placed = false;
      for (const y of rows) {
        for (const x of order) {
          if (!p.board[y][x]) { p.board[y][x] = u; p.bench[best] = null; placed = true; break; }
        }
        if (placed) break;
      }
      if (!placed) return;
    }
  }

  // ------------------------------------------------------------ flow
  start() {
    for (const p of this.players) {
      p.gold = 4;
      const key = this.pickFromPool(1);
      this.pool[key]--;
      p.bench[0] = makeInst(key);
    }
    this.nextRound();
  }

  income(p) {
    const interest = Math.min(5, Math.floor(p.gold / 10));
    const s = Math.abs(p.streak);
    const streak = s >= 5 ? 3 : s >= 4 ? 2 : s >= 2 ? 1 : 0;
    return 5 + interest + streak;
  }

  nextRound() {
    this.round++;
    this.phase = 'planning';
    for (const p of this.alivePlayers()) {
      if (this.round > 1) {
        p.gold += this.income(p);
        this.addXp(p, 2);
      }
      if (!p.locked || !p.shop.length) this.rollShop(p);
      this.combineAll(p);
    }
    for (const p of this.alivePlayers()) if (!p.isHuman) this.aiTurn(p);
    this.timer = PLANNING_TIME;
    this.combat = null;
    this.changed();
  }

  teamOf(p) {
    return this.boardUnits(p).map((b) => ({ unit: { key: b.unit.key, star: b.unit.star }, x: b.x, y: b.y }));
  }

  makeMatches() {
    const alive = this.alivePlayers();
    if (isPveRound(this.round)) return alive.map((p) => ({ a: p, b: null, pve: true }));
    let list = shuffle(alive.slice());
    for (let tries = 0; tries < 12; tries++) {
      let ok = true;
      for (let i = 0; i + 1 < list.length; i += 2) {
        if (list[i].lastOpp === list[i + 1].id && alive.length > 2) ok = false;
      }
      if (ok) break;
      list = shuffle(list);
    }
    const out = [];
    for (let i = 0; i + 1 < list.length; i += 2) out.push({ a: list[i], b: list[i + 1] });
    if (list.length % 2) {
      const lone = list[list.length - 1];
      const others = alive.filter((p) => p !== lone);
      out.push({ a: lone, b: others[rand(others.length)], ghost: true });
    }
    return out;
  }

  startCombat() {
    if (this.phase !== 'planning') return;
    for (const p of this.alivePlayers()) this.autoFill(p);
    this.phase = 'combat';
    this.matches = this.makeMatches();
    this.humanMatch = null;
    for (const m of this.matches) {
      const teamB = m.pve ? creepWave(this.round) : this.teamOf(m.b);
      const human = m.a === this.human || (m.b === this.human && !m.ghost);
      // Keep the human on team A (bottom of the screen).
      if (m.b === this.human && !m.ghost) {
        [m.a, m.b] = [m.b, m.a];
        m.combat = new Combat(this.teamOf(m.a), this.teamOf(m.b), { record: true });
      } else {
        m.combat = new Combat(this.teamOf(m.a), teamB, { record: human });
      }
      if (human && this.human.isHuman) this.humanMatch = m;
      else m.combat.runToEnd();
    }
    this.combat = this.humanMatch ? this.humanMatch.combat : null;
    this.acc = 0;
    this.postCombat = 1.2;
    this.changed();
    if (!this.combat) this.finishCombat();
  }

  stageDamage() {
    const r = this.round;
    if (r <= 6) return 2;
    if (r <= 12) return 4;
    if (r <= 18) return 6;
    if (r <= 24) return 9;
    return 12;
  }

  survivorDamage(combat, side) {
    return combat.survivors(side).reduce((s, u) => s + u.star, 0);
  }

  pveLoot(p) {
    const r = this.round;
    const maxCost = r < 5 ? 1 : r < 12 ? 2 : r < 20 ? 3 : 4;
    const keys = Object.keys(UNITS).filter((k) => UNITS[k].cost <= maxCost && UNITS[k].cost >= maxCost - 1 && this.pool[k] > 0);
    const slot = p.bench.indexOf(null);
    if (!keys.length || slot < 0) { p.gold += maxCost; return `+${maxCost} gold`; }
    const key = keys[rand(keys.length)];
    this.pool[key]--;
    p.bench[slot] = makeInst(key);
    this.combine(p, key);
    return `loot: ${UNITS[key].name}`;
  }

  finishCombat() {
    let humanMsg = null;
    for (const m of this.matches) {
      const c = m.combat;
      const w = c.winner;
      if (m.pve) {
        const p = m.a;
        if (w === 'A') {
          p.gold += 2;
          const loot = this.pveLoot(p);
          if (p === this.human) humanMsg = { text: `Victory! +2 gold, ${loot}`, kind: 'win' };
        } else {
          const dmg = 2 + this.survivorDamage(c, 'B');
          p.hp -= dmg;
          const kills = c.units.filter((u) => u.side === 'B' && !u.alive).length;
          p.gold += kills;
          if (p === this.human) humanMsg = { text: `Defeat... -${dmg} HP (+${kills} gold)`, kind: 'loss' };
        }
        continue;
      }
      const results = [[m.a, 'A', 'B']];
      if (!m.ghost) results.push([m.b, 'B', 'A']);
      for (const [p, mine, theirs] of results) {
        p.lastOpp = (p === m.a ? m.b : m.a).id;
        if (w === mine) {
          p.gold += 1;
          p.streak = p.streak > 0 ? p.streak + 1 : 1;
          if (p === this.human) humanMsg = { text: 'Victory! +1 gold', kind: 'win' };
        } else {
          const dmg = this.stageDamage() + this.survivorDamage(c, theirs);
          p.hp -= dmg;
          p.streak = p.streak < 0 ? p.streak - 1 : -1;
          if (p === this.human) humanMsg = { text: `${w === 'draw' ? 'Draw' : 'Defeat'}... -${dmg} HP`, kind: 'loss' };
        }
      }
    }

    // Eliminations: worse HP this round -> worse placement.
    const dead = this.alivePlayers().filter((p) => p.hp <= 0).sort((a, b) => b.hp - a.hp);
    let place = this.alivePlayers().length;
    for (const p of dead.slice().reverse()) {
      p.alive = false;
      p.placement = place--;
      for (const l of this.allUnits(p)) this.returnToPool(l.unit);
      p.board = Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null));
      p.bench = Array(BENCH_SIZE).fill(null);
    }

    this.lastResult = humanMsg;
    if (humanMsg) this.onBanner(humanMsg.text, humanMsg.kind);

    const alive = this.alivePlayers();
    if (!this.human.alive || alive.length <= 1) {
      if (alive.length === 1) alive[0].placement = 1;
      this.phase = 'gameover';
      this.changed();
      return;
    }
    this.phase = 'results';
    this.timer = 2.5;
    this.changed();
  }

  update(dt) {
    if (this.phase === 'planning') {
      this.timer -= dt;
      if (this.timer <= 0) this.startCombat();
    } else if (this.phase === 'combat' && this.combat) {
      if (!this.combat.over) {
        this.acc += dt * this.speed;
        while (this.acc >= STEP && !this.combat.over) {
          this.combat.step(STEP);
          this.acc -= STEP;
        }
      } else {
        this.postCombat -= dt;
        if (this.postCombat <= 0) this.finishCombat();
      }
    } else if (this.phase === 'results') {
      this.timer -= dt;
      if (this.timer <= 0) this.nextRound();
    }
  }

  // ------------------------------------------------------------ bots
  aiTurn(p) {
    const r = this.round;
    const targetLevel = r < 5 ? 0 : Math.min(MAX_LEVEL, Math.floor(2 + r / 3));
    let reserve = r < 6 ? 0 : r < 20 ? Math.min(50, 10 * Math.floor(r / 4)) : 0;
    if (p.hp < 35) reserve = 0;

    this.aiArrange(p);
    while (p.level < targetLevel && p.gold >= XP_COST && p.gold - XP_COST >= reserve * 0.5) this.buyXp(p);
    this.aiShop(p, reserve);
    const maxRolls = r < 6 ? 0 : p.hp < 40 ? 12 : r >= 18 ? 8 : 2;
    for (let rolls = 0; rolls < maxRolls && p.gold - REROLL_COST >= reserve; rolls++) {
      this.reroll(p);
      this.aiShop(p, reserve);
    }
    if (p.gold - XP_COST >= reserve + 10 && p.level < MAX_LEVEL) this.buyXp(p);
    this.aiArrange(p);
  }

  aiShop(p, reserve) {
    for (let i = 0; i < SHOP_SIZE; i++) {
      const key = p.shop[i];
      if (!key) continue;
      const owned = this.allUnits(p).map((l) => l.unit);
      const tc = countTraits(owned);
      const d = UNITS[key];
      const copies = owned.filter((u) => u.key === key).length;
      const traitScore = d.traits.reduce((s, t) => s + (tc[t] || 0), 0);
      const want = copies > 0 || owned.length < p.level + 2 || (traitScore >= 3 && owned.length < p.level + 5);
      if (!want) continue;
      const floor = copies > 0 ? reserve * 0.6 : reserve;
      if (p.gold - d.cost < floor) continue;
      if (!this.canBuy(p, key)) {
        this.aiTrimBench(p, 1);
        if (!this.canBuy(p, key)) continue;
      }
      this.buy(p, i);
    }
  }

  aiValue(p, u, counts) {
    const d = UNITS[u.key];
    let v = d.cost * Math.pow(3, u.star - 1);
    for (const t of d.traits) v += (counts[t] || 0) * 0.4;
    return v;
  }

  // Sell the least valuable bench units without pairs until `free` slots exist.
  aiTrimBench(p, free) {
    const counts = countTraits(this.allUnits(p).map((l) => l.unit));
    while (p.bench.filter((b) => !b).length < free) {
      let worst = -1;
      let wv = Infinity;
      p.bench.forEach((u, i) => {
        if (!u) return;
        const pairs = this.allUnits(p).filter((l) => l.unit.key === u.key && l.unit.star === u.star).length;
        const v = this.aiValue(p, u, counts) + (pairs >= 2 ? 6 : 0);
        if (v < wv) { wv = v; worst = i; }
      });
      if (worst < 0) return;
      this.sell(p, { area: 'bench', i: worst });
    }
  }

  aiArrange(p) {
    const units = this.allUnits(p).map((l) => l.unit);
    p.board = Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null));
    p.bench = Array(BENCH_SIZE).fill(null);
    const counts = countTraits(units);
    units.sort((a, b) => this.aiValue(p, b, counts) - this.aiValue(p, a, counts));
    const onBoard = units.slice(0, p.level);
    const rest = units.slice(p.level);

    const order = [3, 2, 4, 1, 5, 0, 6];
    const melee = onBoard.filter((u) => UNITS[u.key].range <= 1)
      .sort((a, b) => UNITS[b.key].armor - UNITS[a.key].armor);
    const ranged = onBoard.filter((u) => UNITS[u.key].range > 1);
    melee.forEach((u, i) => { p.board[i < 7 ? 0 : 1][order[i % 7]] = u; });
    ranged.forEach((u, i) => { p.board[i < 7 ? 3 : 2][order[i % 7]] = u; });

    rest.forEach((u, i) => {
      if (i < BENCH_SIZE) p.bench[i] = u;
      else { p.gold += sellValue(u); this.returnToPool(u); }
    });
    this.aiTrimBench(p, 2);
  }
}
