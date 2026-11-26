// Game state: players, economy, shop, shared pool, rounds and bot opponents.
// The Game is authoritative and runs only on the host (or in solo play).
// Clients receive per-player snapshots from viewFor() and send actions to dispatch().

import {
  UNITS, POOL_SIZE, SHOP_ODDS, XP_TO_LEVEL, MAX_LEVEL, isPveRound, creepWave,
} from './data.js';
import { Combat, countTraits, activeTiers, randomSeed } from './combat.js';
import {
  AUGMENTS, AUGMENT_ROUNDS, AUGMENT_EXTRA_TIME, has, combatMods, traitBonus, rollChoices,
} from './augments.js';

export const BOARD_W = 7;
export const BOARD_H = 4;
export const BENCH_SIZE = 9;
export const SHOP_SIZE = 5;
export const REROLL_COST = 2;
export const XP_COST = 4;
export const MAX_PLAYERS = 8;
const PLANNING_TIME = 30;
const POST_COMBAT = 1.2;
const RESULTS_TIME = 2.5;

const BOT_NAMES = ['Ember Bot', 'Tidal Bot', 'Grove Bot', 'Storm Bot', 'Void Bot', 'Iron Bot', 'Arcane Bot', 'Rune Bot'];

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

// ------------------------------------------------------------ matchmaking helpers
const BYE = -1; // stands in for "fights a ghost" when the player count is odd
const pairKey = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);

// Every way to split ids into pairs (105 for 8 players).
function perfectMatchings(ids) {
  if (!ids.length) return [[]];
  const [first, ...rest] = ids;
  const out = [];
  rest.forEach((partner, k) => {
    const remaining = rest.filter((_, x) => x !== k);
    for (const m of perfectMatchings(remaining)) out.push([[first, partner], ...m]);
  });
  return out;
}

// Can the remaining unmet pairs be split into rounds with no repeats?
function canFinish(options, met, allPairs, memo) {
  if (allPairs.every((k) => met.has(k))) return true;
  const key = [...met].sort().join(',');
  if (memo.has(key)) return memo.get(key);
  let ok = false;
  for (const m of options) {
    const keys = m.map(([i, j]) => pairKey(i, j));
    if (keys.some((k) => met.has(k))) continue;
    if (canFinish(options, new Set([...met, ...keys]), allPairs, memo)) { ok = true; break; }
  }
  memo.set(key, ok);
  return ok;
}

// ------------------------------------------------------------ pure helpers
// These work on a plain player object, so clients can use them on snapshots.

export const emptyBoard = () => Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null));

export function sellValue(u) {
  return UNITS[u.key].cost * Math.pow(3, u.star - 1);
}

export function validLoc(loc) {
  if (!loc || typeof loc !== 'object') return false;
  if (loc.area === 'bench') return Number.isInteger(loc.i) && loc.i >= 0 && loc.i < BENCH_SIZE;
  if (loc.area === 'board') {
    return Number.isInteger(loc.x) && Number.isInteger(loc.y)
      && loc.x >= 0 && loc.x < BOARD_W && loc.y >= 0 && loc.y < BOARD_H;
  }
  return false;
}

export function getAt(p, loc) {
  return loc.area === 'board' ? p.board[loc.y][loc.x] : p.bench[loc.i];
}

export function setAt(p, loc, u) {
  if (loc.area === 'board') p.board[loc.y][loc.x] = u;
  else p.bench[loc.i] = u;
}

export function boardUnits(p) {
  const out = [];
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) if (p.board[y][x]) out.push({ unit: p.board[y][x], x, y });
  }
  return out;
}

export const boardCount = (p) => boardUnits(p).length;

export function allUnits(p) {
  const out = boardUnits(p).map((b) => ({ unit: b.unit, loc: { area: 'board', x: b.x, y: b.y } }));
  p.bench.forEach((u, i) => { if (u) out.push({ unit: u, loc: { area: 'bench', i } }); });
  return out;
}

export function findCopies(p, key, star, includeBoard) {
  return allUnits(p).filter((l) => l.unit.key === key && l.unit.star === star
    && (includeBoard || l.loc.area === 'bench'));
}

// Would buying this unit fit (free slot, or it completes a 3-of-a-kind)?
export function canBuy(p, key, boardLocked) {
  if (!key || p.gold < UNITS[key].cost) return false;
  if (p.bench.includes(null)) return true;
  return findCopies(p, key, 1, !boardLocked).length >= 2;
}

// Swap/move a unit. Pure so clients can apply it optimistically while dragging.
export function moveUnit(p, from, to, boardLocked) {
  if (!validLoc(from) || !validLoc(to)) return false;
  if (from.area === to.area && from.x === to.x && from.y === to.y && from.i === to.i) return false;
  if (boardLocked && (from.area === 'board' || to.area === 'board')) return false;
  const a = getAt(p, from);
  const b = getAt(p, to);
  if (!a) return false;
  if (to.area === 'board' && from.area === 'bench' && !b && boardCount(p) >= p.level) return false;
  setAt(p, to, a);
  setAt(p, from, b);
  return true;
}

function newPlayer(id, name, isHuman) {
  return {
    id, name, isHuman,
    hp: 100, gold: 0, level: 1, xp: 0,
    board: emptyBoard(),
    bench: Array(BENCH_SIZE).fill(null),
    shop: [], locked: false, ready: false,
    streak: 0, alive: true, placement: 0,
    augments: [], augChoices: [], freeReroll: false,
  };
}

// ------------------------------------------------------------ game
export class Game {
  // humans: [{ name }] in player-id order (host first). Empty = bot-only sim.
  constructor({ humans = [{ name: 'You' }] } = {}) {
    this.pool = {};
    for (const k in UNITS) this.pool[k] = POOL_SIZE[UNITS[k].cost];
    this.players = humans.slice(0, MAX_PLAYERS).map((h, i) => newPlayer(i, h.name, true));
    let b = 0;
    while (this.players.length < MAX_PLAYERS) {
      this.players.push(newPlayer(this.players.length, BOT_NAMES[b++], false));
    }
    this.round = 0;
    this.phase = 'planning'; // planning | combat | results | gameover
    this.timer = 0;
    this.speed = 1;
    this.matches = [];
    this.cycleMet = new Set(); // pairKeys already played in the current rotation
    this.lastMet = {}; // pairKey -> round they last fought
    this.combatClock = 0;
    this.combatDur = 0;
    this.postCombat = 0;
    this.onChange = () => {};
    this.onBanner = (_pid, _text, _kind) => {};
  }

  // ------------------------------------------------------------ helpers
  get boardLocked() { return this.phase !== 'planning'; }

  alivePlayers() { return this.players.filter((p) => p.alive); }
  aliveHumans() { return this.players.filter((p) => p.alive && p.isHuman); }

  getAt(p, loc) { return getAt(p, loc); }
  setAt(p, loc, u) { setAt(p, loc, u); }
  boardUnits(p) { return boardUnits(p); }
  boardCount(p) { return boardCount(p); }
  allUnits(p) { return allUnits(p); }
  findCopies(p, key, star, includeBoard) { return findCopies(p, key, star, includeBoard); }
  canBuy(p, key) { return canBuy(p, key, this.boardLocked); }

  xpNeeded(p) { return p.level >= MAX_LEVEL ? 0 : XP_TO_LEVEL[p.level]; }

  changed() { this.onChange(); }

  banner(p, text, kind) {
    if (p.isHuman) this.onBanner(p.id, text, kind);
  }

  // ------------------------------------------------------------ actions
  // Entry point for player input, local or remote. Returns true if state changed.
  dispatch(pid, a) {
    const p = this.players[pid];
    if (!p || !p.isHuman || !p.alive || !a || this.phase === 'gameover') return false;
    switch (a.type) {
      case 'buy': return Number.isInteger(a.i) && a.i >= 0 && a.i < p.shop.length && this.buy(p, a.i);
      case 'augment': return Number.isInteger(a.i) && this.pickAugment(p, a.i);
      case 'reroll': return this.reroll(p);
      case 'xp': return this.buyXp(p);
      case 'sell': return validLoc(a.loc) && this.sell(p, a.loc);
      case 'move': {
        const ok = moveUnit(p, a.from, a.to, this.boardLocked);
        if (ok) this.changed();
        return ok;
      }
      case 'lock': this.toggleLock(p); return true;
      case 'ready': return this.setReady(p, a.ready !== false);
      default: return false;
    }
  }

  setReady(p, ready) {
    if (this.phase !== 'planning') return false;
    if (ready && p.augChoices.length) return false; // pick an augment first
    p.ready = ready;
    this.changed();
    return true;
  }

  // A remote player left: a bot takes over their seat.
  dropPlayer(pid) {
    const p = this.players[pid];
    if (!p || !p.isHuman) return;
    p.isHuman = false;
    p.ready = false;
    p.name = `${p.name} (left)`;
    if (this.phase === 'planning' && p.alive) this.aiTurn(p);
    this.checkGameOver();
    this.changed();
  }

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

  // Shop cards reserve their unit from the pool, so two players can never both
  // buy the last copy. Unbought cards go back when the shop is replaced.
  rollShop(p) {
    this.releaseShop(p);
    p.shop = Array.from({ length: this.shopSize(p) }, () => {
      const key = this.pickFromPool(p.level);
      if (key) this.pool[key]--;
      return key;
    });
  }

  releaseShop(p) {
    for (const key of p.shop) if (key) this.pool[key]++;
    p.shop = [];
  }

  returnToPool(u) {
    this.pool[u.key] += Math.pow(3, u.star - 1);
  }

  combine(p, key) {
    let upgraded = false;
    for (let star = 1; star <= 2; star++) {
      let copies = findCopies(p, key, star, !this.boardLocked);
      while (copies.length >= 3) {
        const [keep, a, b] = copies;
        setAt(p, a.loc, null);
        setAt(p, b.loc, null);
        setAt(p, keep.loc, makeInst(key, star + 1));
        upgraded = true;
        copies = findCopies(p, key, star, !this.boardLocked);
      }
    }
    return upgraded;
  }

  combineAll(p) {
    for (const k of new Set(allUnits(p).map((l) => l.unit.key))) this.combine(p, k);
  }

  buy(p, i) {
    const key = p.shop[i];
    if (!this.canBuy(p, key)) return false;
    p.gold -= UNITS[key].cost;
    p.shop[i] = null; // already taken from the pool when the shop rolled
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
    if (up) this.banner(p, '★ Star up!', 'star');
    this.changed();
    return true;
  }

  shopSize(p) {
    return SHOP_SIZE + (has(p.augments, 'recruiter') ? 1 : 0);
  }

  reroll(p) {
    if (p.freeReroll) p.freeReroll = false;
    else if (p.gold < REROLL_COST) return false;
    else p.gold -= REROLL_COST;
    this.rollShop(p);
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ augments
  pickAugment(p, i) {
    const id = p.augChoices[i];
    if (!id) return false;
    p.augChoices = [];
    p.augments.push(id);
    if (id === 'windfall') p.gold += 12;
    if (id === 'secondwind') p.hp = Math.min(100, p.hp + 25);
    if (id === 'bargain') p.freeReroll = true;
    if (id === 'recruiter') this.rollShop(p);
    if (id === 'luckyfind') {
      for (let n = 0; n < 2; n++) {
        const keys = Object.keys(UNITS).filter((k) => UNITS[k].cost === 2 && this.pool[k] > 0);
        const slot = p.bench.indexOf(null);
        if (!keys.length) break;
        if (slot < 0) { p.gold += 2; continue; }
        const key = keys[rand(keys.length)];
        this.pool[key]--;
        p.bench[slot] = makeInst(key);
        this.combine(p, key);
      }
    }
    this.banner(p, `${AUGMENTS[id].icon} ${AUGMENTS[id].name}`, 'star');
    this.changed();
    return true;
  }

  offerAugments(p) {
    const traits = new Set(allUnits(p).flatMap((l) => UNITS[l.unit.key].traits));
    p.augChoices = rollChoices(p.augments, traits);
  }

  // Bots: a crest for a trait they're building, else a combat augment, else anything.
  aiPickAugment(p) {
    if (!p.augChoices.length) return;
    const counts = countTraits(allUnits(p).map((l) => l.unit));
    const score = (id) => {
      const a = AUGMENTS[id];
      if (a.kind === 'crest') return 2 + (counts[a.crest] || 0);
      if (a.kind === 'combat') return 2.5;
      return 1 + Math.random();
    };
    let best = 0;
    p.augChoices.forEach((id, i) => { if (score(id) > score(p.augChoices[best])) best = i; });
    this.pickAugment(p, best);
  }

  // Active traits for a player's team, including crests.
  tiersFor(p, team) {
    return activeTiers(team.map((s) => s.unit), traitBonus(p.augments));
  }

  buyXp(p) {
    if (p.gold < XP_COST || p.level >= MAX_LEVEL) return false;
    p.gold -= XP_COST;
    this.addXp(p, 4);
    this.changed();
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
    const u = getAt(p, loc);
    if (!u) return false;
    if (loc.area === 'board' && this.boardLocked) return false;
    p.gold += sellValue(u);
    this.returnToPool(u);
    setAt(p, loc, null);
    this.changed();
    return true;
  }

  moveUnit(p, from, to) {
    const ok = moveUnit(p, from, to, this.boardLocked);
    if (ok) this.changed();
    return ok;
  }

  toggleLock(p) {
    p.locked = !p.locked;
    this.changed();
  }

  // Fill empty board slots from the bench (used when the timer expires).
  autoFill(p) {
    const order = [3, 2, 4, 1, 5, 0, 6];
    while (boardCount(p) < p.level) {
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
    const interest = Math.min(has(p.augments, 'richer') ? 7 : 5, Math.floor(p.gold / 10));
    const s = Math.abs(p.streak);
    const streak = s >= 5 ? 3 : s >= 4 ? 2 : s >= 2 ? 1 : 0;
    return 5 + interest + streak + (has(p.augments, 'salary') ? 2 : 0);
  }

  nextRound() {
    this.round++;
    this.phase = 'planning';
    this.matches = [];
    const augRound = AUGMENT_ROUNDS.includes(this.round);
    for (const p of this.alivePlayers()) {
      if (this.round > 1) {
        p.gold += this.income(p);
        this.addXp(p, has(p.augments, 'learner') ? 4 : 2);
      }
      if (!p.locked || !p.shop.length) this.rollShop(p);
      p.ready = false;
      p.freeReroll = has(p.augments, 'bargain');
      this.combineAll(p);
      if (augRound) this.offerAugments(p);
    }
    for (const p of this.alivePlayers()) {
      if (!p.isHuman) { this.aiPickAugment(p); this.aiTurn(p); }
    }
    this.timer = PLANNING_TIME + (augRound ? AUGMENT_EXTRA_TIME : 0);
    this.changed();
  }

  teamOf(p) {
    return boardUnits(p).map((b) => ({ unit: { key: b.unit.key, star: b.unit.star }, x: b.x, y: b.y }));
  }

  // Fair rotation: everyone faces every remaining opponent once before any
  // repeat. With an odd count, the ghost fight (BYE) is one more opponent.
  makeMatches() {
    const alive = this.alivePlayers();
    if (isPveRound(this.round)) return alive.map((p) => ({ a: p, b: null, pve: true }));
    const pairs = this.pickPairs(alive.map((p) => p.id));
    const out = [];
    for (const [i, j] of pairs) {
      if (i === BYE || j === BYE) {
        const lone = this.players[i === BYE ? j : i];
        const others = alive.filter((p) => p !== lone);
        out.push({ a: lone, b: others[rand(others.length)], ghost: true });
      } else {
        // Random side so neither player is always the mirrored one.
        const [a, b] = Math.random() < 0.5 ? [i, j] : [j, i];
        out.push({ a: this.players[a], b: this.players[b] });
      }
    }
    return out;
  }

  // Chooses this round's pairs and records them in the rotation.
  pickPairs(ids) {
    const pairs = this.choosePairs(ids);
    for (const [i, j] of pairs) {
      this.cycleMet.add(pairKey(i, j));
      this.lastMet[pairKey(i, j)] = this.round;
    }
    return pairs;
  }

  choosePairs(ids) {
    const verts = ids.length % 2 ? [...ids, BYE] : ids.slice();
    const allPairs = [];
    for (let x = 0; x < verts.length; x++) {
      for (let y = x + 1; y < verts.length; y++) allPairs.push(pairKey(verts[x], verts[y]));
    }
    // Drop pairs involving eliminated players; start a new cycle once everyone has met.
    const live = new Set(allPairs);
    for (const k of this.cycleMet) if (!live.has(k)) this.cycleMet.delete(k);
    if (allPairs.every((k) => this.cycleMet.has(k))) this.cycleMet.clear();

    const options = shuffle(perfectMatchings(verts));
    const met = this.cycleMet;
    const repeats = (m) => m.filter(([i, j]) => met.has(pairKey(i, j))).length;
    const staleness = (m) => m.reduce((s, [i, j]) => s + (this.lastMet[pairKey(i, j)] || 0), 0);

    // Fresh matchings that still leave a way to finish the cycle without repeats.
    const fresh = options.filter((m) => !repeats(m));
    if (fresh.length) {
      const unmetDeg = new Map(verts.map((v) => [v, 0]));
      for (const k of allPairs) {
        if (met.has(k)) continue;
        const [i, j] = k.split(':').map(Number);
        unmetDeg.set(i, unmetDeg.get(i) + 1);
        unmetDeg.set(j, unmetDeg.get(j) + 1);
      }
      // A full no-repeat finish only exists when every player has the same number of
      // opponents left; after an elimination that's often false, so skip the lookahead.
      const regular = new Set(unmetDeg.values()).size === 1;
      if (regular) {
        const memo = new Map();
        const ok = fresh.find((m) => canFinish(options, new Set([...met, ...m.map(([i, j]) => pairKey(i, j))]), allPairs, memo));
        if (ok) return ok;
      }
      return fresh[0];
    }
    // Otherwise fewest repeats, then the opponents met longest ago.
    options.sort((a, b) => (repeats(a) - repeats(b)) || (staleness(a) - staleness(b)));
    return options[0];
  }

  // The match a player watches: the one they fight in (not one where they are only a ghost).
  matchOf(p) {
    return this.matches.find((m) => m.a === p || (m.b === p && !m.ghost)) || null;
  }

  startCombat() {
    if (this.phase !== 'planning') return;
    for (const p of this.alivePlayers()) {
      // Anyone who ran out of time without choosing gets a random augment.
      if (p.augChoices.length) this.pickAugment(p, rand(p.augChoices.length));
      this.autoFill(p);
    }
    this.phase = 'combat';
    this.matches = this.makeMatches();
    // Every fight is resolved here, instantly. Viewers replay it from (teams, seed, augment effects).
    let longest = 0;
    for (const m of this.matches) {
      m.teamA = this.teamOf(m.a);
      m.teamB = m.pve ? creepWave(this.round) : this.teamOf(m.b);
      m.seed = randomSeed();
      m.opts = {
        seed: m.seed,
        tiersA: this.tiersFor(m.a, m.teamA),
        modsA: combatMods(m.a.augments),
        tiersB: m.pve ? null : this.tiersFor(m.b, m.teamB),
        modsB: m.pve ? null : combatMods(m.b.augments),
      };
      m.combat = new Combat(m.teamA, m.teamB, { ...m.opts, record: false }).runToEnd();
      const watched = m.a.isHuman || (!m.ghost && m.b && m.b.isHuman);
      if (watched) longest = Math.max(longest, m.combat.time);
    }
    this.combatClock = 0;
    this.combatDur = longest;
    this.postCombat = POST_COMBAT;
    this.changed();
    if (!this.aliveHumans().length) this.finishCombat();
  }

  stageDamage() {
    const r = this.round;
    if (r <= 6) return 2;
    if (r <= 12) return 4;
    if (r <= 18) return 6;
    if (r <= 24) return 9;
    return 12;
  }

  // Applies a lost fight's damage to a player; returns the damage actually taken.
  takeDamage(p, dmg) {
    if (has(p.augments, 'thickskin')) dmg = Math.ceil(dmg * 0.7);
    p.hp -= dmg;
    if (has(p.augments, 'underdog')) p.gold += 2;
    return dmg;
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
    for (const m of this.matches) {
      const c = m.combat;
      const w = c.winner;
      if (m.pve) {
        const p = m.a;
        if (w === 'A') {
          const gold = 2 + (has(p.augments, 'hunter') ? 4 : 0);
          p.gold += gold;
          const loot = this.pveLoot(p);
          this.banner(p, `Victory! +${gold} gold, ${loot}`, 'win');
        } else {
          const dmg = this.takeDamage(p, 2 + this.survivorDamage(c, 'B'));
          const kills = c.units.filter((u) => u.side === 'B' && !u.alive).length;
          p.gold += kills;
          this.banner(p, `Defeat... -${dmg} HP (+${kills} gold)`, 'loss');
        }
        continue;
      }
      const results = [[m.a, 'A', 'B']];
      if (!m.ghost) results.push([m.b, 'B', 'A']);
      for (const [p, mine, theirs] of results) {
        if (w === mine) {
          p.gold += 1;
          p.streak = p.streak > 0 ? p.streak + 1 : 1;
          this.banner(p, 'Victory! +1 gold', 'win');
        } else {
          const dmg = this.takeDamage(p, this.stageDamage() + this.survivorDamage(c, theirs));
          p.streak = p.streak < 0 ? p.streak - 1 : -1;
          this.banner(p, `${w === 'draw' ? 'Draw' : 'Defeat'}... -${dmg} HP`, 'loss');
        }
      }
    }

    // Eliminations: worse HP this round -> worse placement.
    const dead = this.alivePlayers().filter((p) => p.hp <= 0).sort((a, b) => b.hp - a.hp);
    let place = this.alivePlayers().length;
    for (const p of dead.slice().reverse()) {
      p.alive = false;
      p.placement = place--;
      for (const l of allUnits(p)) this.returnToPool(l.unit);
      this.releaseShop(p);
      p.board = emptyBoard();
      p.bench = Array(BENCH_SIZE).fill(null);
    }

    if (this.checkGameOver()) return;
    this.phase = 'results';
    this.timer = RESULTS_TIME;
    this.changed();
  }

  // Ends the game when one player is left, or every human has been knocked out.
  checkGameOver() {
    const alive = this.alivePlayers();
    const hadHumans = this.players.some((p) => p.isHuman);
    if (alive.length > 1 && !(hadHumans && !this.aliveHumans().length)) return false;
    // Rank the survivors by HP so every player gets a final placement.
    alive.sort((a, b) => b.hp - a.hp).forEach((p, i) => { p.placement = i + 1; });
    this.phase = 'gameover';
    this.changed();
    return true;
  }

  update(dt) {
    if (this.phase === 'planning') {
      this.timer -= dt;
      const humans = this.aliveHumans();
      if (this.timer <= 0 || (humans.length && humans.every((p) => p.ready))) this.startCombat();
    } else if (this.phase === 'combat') {
      if (this.combatClock < this.combatDur) {
        this.combatClock += dt * this.speed;
      } else {
        this.postCombat -= dt;
        if (this.postCombat <= 0) this.finishCombat();
      }
    } else if (this.phase === 'results') {
      this.timer -= dt;
      if (this.timer <= 0) this.nextRound();
    }
  }

  // ------------------------------------------------------------ snapshots
  // Everything one player's screen needs, as plain JSON-safe data.
  viewFor(pid) {
    const me = this.players[pid];
    const m = this.phase === 'combat' || this.phase === 'results' ? this.matchOf(me) : null;
    let match = null;
    if (m) {
      const flip = m.b === me;
      const opp = flip ? m.a : m.b;
      match = {
        seed: m.seed, teamA: m.teamA, teamB: m.teamB, opts: m.opts, flip,
        pve: !!m.pve, ghost: !!m.ghost && !flip,
        oppId: opp ? opp.id : -1, oppName: opp ? opp.name : 'Monsters',
      };
    }
    return structuredClone({
      pid,
      round: this.round,
      phase: this.phase,
      timer: this.timer,
      speed: this.speed,
      me: {
        id: me.id, name: me.name, hp: me.hp, gold: me.gold, level: me.level, xp: me.xp,
        board: me.board, bench: me.bench, shop: me.shop, locked: me.locked, ready: me.ready,
        streak: me.streak, alive: me.alive, placement: me.placement,
        augments: me.augments, augChoices: me.augChoices, freeReroll: me.freeReroll,
      },
      players: this.players.map((p) => ({
        id: p.id, name: p.name, hp: p.hp, level: p.level, alive: p.alive,
        placement: p.placement, isHuman: p.isHuman, ready: p.ready, augments: p.augments,
      })),
      match,
    });
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
    for (let i = 0; i < p.shop.length; i++) {
      const key = p.shop[i];
      if (!key) continue;
      const owned = allUnits(p).map((l) => l.unit);
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
    const counts = countTraits(allUnits(p).map((l) => l.unit));
    while (p.bench.filter((b) => !b).length < free) {
      let worst = -1;
      let wv = Infinity;
      p.bench.forEach((u, i) => {
        if (!u) return;
        const pairs = allUnits(p).filter((l) => l.unit.key === u.key && l.unit.star === u.star).length;
        const v = this.aiValue(p, u, counts) + (pairs >= 2 ? 6 : 0);
        if (v < wv) { wv = v; worst = i; }
      });
      if (worst < 0) return;
      this.sell(p, { area: 'bench', i: worst });
    }
  }

  aiArrange(p) {
    const units = allUnits(p).map((l) => l.unit);
    p.board = emptyBoard();
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
