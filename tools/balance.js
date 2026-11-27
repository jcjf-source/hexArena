// Balance report: measures unit, trait and cost balance with headless simulations.
//
//   node tools/balance.js            full run (a few minutes)
//   node tools/balance.js --quick    smaller samples, for a fast check after a tweak
//   node tools/balance.js --json out.json   also save the raw numbers
//
// Sections:
//   1. Unit strength: random mirrored-cost team fights with traits off. Each unit's
//      win rate shows its raw power against other units of the same cost (50% = average).
//   2. Trait value: the same team fights itself with one trait switched off on one side.
//      The win rate of the side with the trait shows what each tier is worth.
//   3. Cost curve: do pricier / higher-star units beat cheaper ones by a sensible margin?
//   4. Augments: what each combat augment and crest is worth, measured like traits.
//   5. Terrain: what one terrain hex under a unit is worth, measured like augments.
//   6. Arena rules: how each combat rule changes fight pace, draws and trait values.
//   7. Full bot games: pick rate and average placement of traits, units and augments, plus
//      game length and winning boards per arena rule. This reflects how the bots play,
//      so treat it as a sanity check, not the main signal.

import fs from 'node:fs';
import { UNITS, TRAITS } from '../js/data.js';
import { Combat, activeTiers } from '../js/combat.js';
import { Game } from '../js/game.js';
import { AUGMENTS, traitBonus } from '../js/augments.js';
import { RULES, ruleTraitBonus } from '../js/rules.js';
import { TERRAIN } from '../js/terrain.js';
import { COLS, cellKey } from '../js/hex.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const N = {
  unitFights: quick ? 6000 : 40000,
  traitFights: quick ? 120 : 400,
  costFights: quick ? 120 : 400,
  ruleFights: quick ? 300 : 1500,
  games: quick ? 100 : 1000,
};

const KEYS = Object.keys(UNITS);
const byCost = {};
for (const k of KEYS) (byCost[UNITS[k].cost] ||= []).push(k);
const withTrait = (t) => KEYS.filter((k) => UNITS[k].traits.includes(t));
const rnd = (n) => Math.floor(Math.random() * n);
const pickN = (arr, n) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = (p, n) => 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / Math.max(n, 1));
const bar = (p, width = 20) => {
  // centred on 50%: left of | is below average, right is above
  const half = width / 2;
  const off = Math.max(-half, Math.min(half, Math.round((p - 0.5) * width * 2)));
  return off >= 0 ? `${' '.repeat(half)}|${'█'.repeat(off)}${' '.repeat(half - off)}` : `${' '.repeat(half + off)}${'█'.repeat(-off)}|${' '.repeat(half)}`;
};
const elapsed = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

// Board layout like the bots use: melee front row (tankiest centre), ranged back row.
function place(units) {
  const order = [3, 2, 4, 1, 5, 0, 6];
  const melee = units.filter((u) => UNITS[u.key].range <= 1).sort((a, b) => UNITS[b.key].armor - UNITS[a.key].armor);
  const ranged = units.filter((u) => UNITS[u.key].range > 1);
  const out = [];
  melee.forEach((u, i) => out.push({ unit: u, x: order[i % 7], y: i < 7 ? 0 : 1 }));
  ranged.forEach((u, i) => out.push({ unit: u, x: order[i % 7], y: i < 7 ? 3 : 2 }));
  return out;
}

// Fights teamX vs teamY with random side assignment. Returns { win: 1 | 0 | 0.5, margin }
// where margin is X's remaining HP share minus Y's (-1..1).
// tilesX: terrain hexes ({ x, y, type } in board coords) on X's half only. The game always
// mirrors terrain to both halves; one-sided tiles are how we measure what a tile is worth.
function fight(teamX, teamY, tiersX = null, tiersY = null, { seed, xIsA = Math.random() < 0.5, modsX = null, modsY = null, tilesX = null } = {}) {
  const opt = (tA, tB, mA, mB) => ({ record: false, tiersA: tA, tiersB: tB, modsA: mA, modsB: mB, ...(seed !== undefined ? { seed } : {}) });
  const c = xIsA
    ? new Combat(teamX, teamY, opt(tiersX, tiersY, modsX, modsY))
    : new Combat(teamY, teamX, opt(tiersY, tiersX, modsY, modsX));
  for (const t of tilesX || []) c.terrain.set(xIsA ? cellKey(t.x, 4 + t.y) : cellKey(COLS - 1 - t.x, 3 - t.y), t.type);
  c.runToEnd();
  const sideX = xIsA ? 'A' : 'B';
  const share = (side) => {
    const us = c.units.filter((u) => u.side === side);
    return us.reduce((s, u) => s + Math.max(0, u.hp), 0) / us.reduce((s, u) => s + u.maxHp, 0);
  };
  const win = c.winner === 'draw' ? 0.5 : c.winner === sideX ? 1 : 0;
  return { win, margin: share(sideX) - share(sideX === 'A' ? 'B' : 'A'), time: c.time, draw: c.winner === 'draw' };
}

// Power equivalent: how much must team Y's HP and attack damage be multiplied by to
// break even with team X? 1.30 means X is worth "+30% stats". Unlike win rate this
// doesn't saturate at 100%. Every probe reuses the same samples (teams, seeds, sides),
// so the only thing that changes between probes is the multiplier.
function powerRatio(makeSample, n) {
  const samples = Array.from({ length: n }, () => ({
    ...makeSample(), seed: Math.floor(Math.random() * 4294967296), xIsA: Math.random() < 0.5,
  }));
  const scaled = (team, s) => team.map((p) => ({ ...p, unit: { ...p.unit, scale: (p.unit.scale || 1) * s } }));
  const at = (s) => {
    let m = 0;
    let w = 0;
    for (const x of samples) {
      const r = fight(x.X, scaled(x.Y, s), x.tiersX, x.tiersY, { seed: x.seed, xIsA: x.xIsA, modsX: x.modsX, modsY: x.modsY, tilesX: x.tilesX });
      m += r.margin;
      w += r.win;
    }
    return { margin: m / n, win: w / n };
  };
  const base = at(1);
  let lo = 0.25;
  let hi = 8;
  for (let i = 0; i < 14; i++) {
    const mid = Math.sqrt(lo * hi);
    if (at(mid).margin > 0) lo = mid; else hi = mid;
  }
  return { ratio: Math.sqrt(lo * hi), win: base.win, margin: base.margin };
}
const boost = (r) => `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`;

const NO_TRAITS = {};
const out = { settings: N, units: {}, traits: {}, cost: [], games: {}, terrain: {}, rules: {} };
const flags = [];
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
let augMedian = null; // median combat augment worth, set by section 4

// A random 7-unit team with a realistic cost spread.
const TEAM_COSTS = [1, 2, 2, 3, 3, 4, 4, 5];
const randomTeam = () => Array.from({ length: 7 }, () => {
  const c = TEAM_COSTS[rnd(TEAM_COSTS.length)];
  return { key: byCost[c][rnd(byCost[c].length)], star: Math.random() < 0.5 ? 1 : 2 };
});

// One trait-value sample: a team with exactly `tier` of trait t, vs itself with t switched off.
function traitSample(t, tier, mods = null) {
  const bp = TRAITS[t].breakpoints[tier];
  const carriers = withTrait(t);
  const others = KEYS.filter((k) => !UNITS[k].traits.includes(t));
  const size = Math.max(6, bp);
  const team = [...pickN(carriers, bp), ...pickN(others, size - bp)]
    .map((key) => ({ key, star: Math.random() < 0.5 ? 1 : 2 }));
  const placed = place(team);
  const on = activeTiers(team);
  on[t] = tier; // exactly this tier, even if fillers would push it higher
  const off = { ...on };
  delete off[t];
  return { X: placed, Y: placed, tiersX: on, tiersY: off, modsX: mods, modsY: mods };
}

// ------------------------------------------------------------ 1. unit strength
function unitStrength() {
  const t0 = Date.now();
  const SLOTS = 6;
  const costWeights = [1, 1, 2, 2, 3, 3, 4, 5]; // slot costs, mirrored on both sides
  const stat = Object.fromEntries(KEYS.map((k) => [k, { n: 0, w: 0 }]));
  for (let f = 0; f < N.unitFights; f++) {
    const costs = Array.from({ length: SLOTS }, () => costWeights[rnd(costWeights.length)]);
    const stars = costs.map(() => (Math.random() < 0.5 ? 1 : 2));
    const make = () => costs.map((c, i) => ({ key: byCost[c][rnd(byCost[c].length)], star: stars[i] }));
    const X = make();
    const Y = make();
    const r = fight(place(X), place(Y), NO_TRAITS, NO_TRAITS);
    // Credit each slot only where the two sides differ, so a unit isn't counted against itself.
    X.forEach((u, i) => {
      if (u.key === Y[i].key) return;
      stat[u.key].n++; stat[u.key].w += r.win;
      stat[Y[i].key].n++; stat[Y[i].key].w += 1 - r.win;
    });
  }
  console.log(`\n1. UNIT STRENGTH  (traits off, ${N.unitFights} fights, ${elapsed(t0)})`);
  console.log('   Win rate when the unit replaces a same-cost unit. 50% = average for its cost.\n');
  for (const c of [1, 2, 3, 4, 5]) {
    console.log(`   ${c}-cost`);
    const rows = byCost[c].map((k) => ({ k, p: stat[k].w / stat[k].n, n: stat[k].n })).sort((a, b) => b.p - a.p);
    for (const { k, p, n } of rows) {
      const e = ci(p, n);
      let flag = '';
      if (p - e > 0.56) { flag = '◀ strong'; flags.push(`Unit ${UNITS[k].name} (${c}-cost) is strong: ${pct(p)} vs same-cost units`); }
      if (p + e < 0.44) { flag = '◀ weak'; flags.push(`Unit ${UNITS[k].name} (${c}-cost) is weak: ${pct(p)} vs same-cost units`); }
      console.log(`     ${UNITS[k].name.padEnd(14)} ${pct(p).padStart(6)} ±${(100 * e).toFixed(1).padStart(4)}  ${bar(p)} ${flag}`);
      out.units[k] = { cost: c, winRate: p, n };
    }
  }
}

// ------------------------------------------------------------ 2. trait value
function traitValue() {
  const t0 = Date.now();
  console.log(`\n2. TRAIT VALUE  (power equivalent, ${N.traitFights} mirror fights per tier)`);
  console.log('   The same team fights itself with the trait switched off on one side. "Worth" is how much');
  console.log('   extra HP and attack damage the trait-less side needs to break even. Win% is at no boost.\n');
  const rows = [];
  for (const t of Object.keys(TRAITS)) {
    TRAITS[t].breakpoints.forEach((bp, tier) => {
      if (bp > withTrait(t).length) return;
      const r = powerRatio(() => traitSample(t, tier), N.traitFights);
      rows.push({ t, bp, ...r });
    });
  }
  // Compare each tier with the median of traits at the same breakpoint.
  // Expected worth for a tier of any size: a power-law curve (worth = a * size^b) fitted
  // through every trait's tiers. Bigger tiers cost more units, so they should be worth more;
  // this lets a lone 3- or 5-unit tier be judged against the rest.
  const pts = rows.filter((r) => r.ratio - 1 > 0.005).map((r) => [Math.log(r.bp), Math.log(r.ratio - 1)]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const expected = (bp) => Math.exp(my + slope * (Math.log(bp) - mx));
  for (const t of Object.keys(TRAITS)) {
    const mine = rows.filter((r) => r.t === t);
    const cells = mine.map((r) => `(${r.bp}) ${boost(r.ratio).padStart(5)} ${pct(r.win).padStart(6)}`).join('   ');
    const notes = [];
    for (const r of mine) {
      const v = r.ratio - 1;
      const e = expected(r.bp);
      const strong = v > Math.max(e * 1.6, e + 0.08);
      const weak = v < Math.min(e * 0.6, e - 0.05);
      if (strong) notes.push(`(${r.bp}) strong`);
      if (weak) notes.push(`(${r.bp}) weak`);
      if (strong || weak) {
        flags.push(`Trait ${TRAITS[t].name} (${r.bp}) is worth ${boost(r.ratio)} stats; a typical ${r.bp}-unit tier is about ${boost(1 + e)}`);
      }
    }
    // A higher tier should be clearly better than the one below it.
    for (let i = 1; i < mine.length; i++) {
      const gain = (mine[i].ratio - 1) / Math.max(0.01, mine[i - 1].ratio - 1);
      if (gain < 1.3) {
        notes.push(`(${mine[i].bp}) barely beats (${mine[i - 1].bp})`);
        flags.push(`Trait ${TRAITS[t].name}: (${mine[i].bp}) is worth ${boost(mine[i].ratio)}, barely more than (${mine[i - 1].bp}) at ${boost(mine[i - 1].ratio)}`);
      }
    }
    console.log(`   ${(TRAITS[t].icon + ' ' + TRAITS[t].name).padEnd(13)} ${cells.padEnd(52)} ${notes.length ? '◀ ' + notes.join(', ') : ''}`);
    out.traits[t] = mine.map(({ bp, ratio, win }) => ({ breakpoint: bp, worth: ratio - 1, winRate: win }));
  }
  const sizes = [...new Set(rows.map((r) => r.bp))].sort((a, b) => a - b);
  console.log(`   typical worth by tier size: ${sizes.map((bp) => `(${bp}) ${boost(1 + expected(bp))}`).join(', ')}   (${elapsed(t0)})`);
}

// ------------------------------------------------------------ 3. cost curve
function costCurve() {
  const t0 = Date.now();
  console.log(`\n3. COST CURVE  (power equivalent, 5 v 5, traits off, ${N.costFights} fights each)`);
  console.log('   How much stronger the LEFT team is, as the stat boost the right team needs to break even.');
  console.log('   Each cost step should be a clear upgrade (roughly +25% to +60%). A 2★ copy is meant to be');
  console.log('   at least as good as a 1★ one cost up, so its row should be at or above +0%.\n');
  const team = (cost, star) => place(pickN(byCost[cost], 5).map((key) => ({ key, star })));
  const tests = [];
  for (let c = 1; c <= 4; c++) {
    tests.push({ label: `${c + 1}-cost 1★ vs ${c}-cost 1★`, a: [c + 1, 1], b: [c, 1], lo: 1.15, hi: 1.8 });
    tests.push({ label: `${c}-cost 2★ vs ${c + 1}-cost 1★`, a: [c, 2], b: [c + 1, 1], lo: 0.95, hi: 2.6 });
  }
  for (const tst of tests) {
    const r = powerRatio(() => ({ X: team(...tst.a), Y: team(...tst.b), tiersX: NO_TRAITS, tiersY: NO_TRAITS }), N.costFights);
    let flag = '';
    if (r.ratio < tst.lo) { flag = '◀ too small'; flags.push(`Cost curve: ${tst.label} is only ${boost(r.ratio)}`); }
    if (r.ratio > tst.hi) { flag = '◀ too big'; flags.push(`Cost curve: ${tst.label} is ${boost(r.ratio)}`); }
    console.log(`   ${tst.label.padEnd(26)} ${boost(r.ratio).padStart(6)}   win ${pct(r.win).padStart(6)}  ${flag}`);
    out.cost.push({ test: tst.label, worth: r.ratio - 1, winRate: r.win });
  }
  console.log(`   (${elapsed(t0)})`);
}

// ------------------------------------------------------------ 4. augments
// Combat augments: a random team with the augment vs the same team without it.
// Crests: a realistic team holding some of the trait, with vs without the crest.
// Economy augments can't be measured by a fight; the bot games show how they do.
function augmentValue() {
  const t0 = Date.now();
  console.log(`\n4. AUGMENTS  (power equivalent, ${N.traitFights} mirror fights each)\n`);
  const rows = [];
  for (const id of Object.keys(AUGMENTS).filter((k) => AUGMENTS[k].kind === 'combat')) {
    const mods = AUGMENTS[id].mods;
    const r = powerRatio(() => {
      const team = randomTeam();
      const placed = place(team);
      const tiers = activeTiers(team);
      return { X: placed, Y: placed, tiersX: tiers, tiersY: tiers, modsX: mods };
    }, N.traitFights);
    rows.push({ id, ...r });
  }
  const med = median(rows.map((r) => r.ratio - 1));
  augMedian = med;
  console.log('   Combat augments');
  for (const r of rows.sort((a, b) => b.ratio - a.ratio)) {
    const v = r.ratio - 1;
    let flag = '';
    if (v > med * 1.6 && v > med + 0.05) { flag = '◀ strong'; flags.push(`Augment ${AUGMENTS[r.id].name} is worth ${boost(r.ratio)}; median combat augment is ${boost(1 + med)}`); }
    if (v < med * 0.6 && v < med - 0.04) { flag = '◀ weak'; flags.push(`Augment ${AUGMENTS[r.id].name} is worth ${boost(r.ratio)}; median combat augment is ${boost(1 + med)}`); }
    console.log(`     ${(AUGMENTS[r.id].icon + ' ' + AUGMENTS[r.id].name).padEnd(18)} ${boost(r.ratio).padStart(5)}  ${flag}`);
    out.augments = out.augments || {};
    out.augments[r.id] = { worth: v };
  }
  console.log(`     median ${boost(1 + med)}`);

  console.log('\n   Crests (7-unit teams holding 1-4 units of the trait, with vs without the crest)');
  for (const t of Object.keys(TRAITS)) {
    const carriers = withTrait(t);
    const others = KEYS.filter((k) => !UNITS[k].traits.includes(t));
    const mods = AUGMENTS[`crest_${t}`].mods || null;
    const r = powerRatio(() => {
      const k = 1 + rnd(Math.min(4, carriers.length));
      const team = [...pickN(carriers, k), ...pickN(others, 7 - k)]
        .map((key) => ({ key, star: Math.random() < 0.5 ? 1 : 2 }));
      const placed = place(team);
      return { X: placed, Y: placed, tiersX: activeTiers(team, { [t]: 1 }), tiersY: activeTiers(team), modsX: mods };
    }, N.traitFights);
    const v = r.ratio - 1;
    let flag = '';
    if (v > med * 1.6 && v > med + 0.05) { flag = '◀ strong'; flags.push(`${TRAITS[t].name} Crest is worth ${boost(r.ratio)}; median combat augment is ${boost(1 + med)}`); }
    if (v < med * 0.6 && v < med - 0.04) { flag = '◀ weak'; flags.push(`${TRAITS[t].name} Crest is worth ${boost(r.ratio)}; median combat augment is ${boost(1 + med)}`); }
    console.log(`     ${(TRAITS[t].icon + ' ' + TRAITS[t].name + ' Crest').padEnd(18)} ${boost(r.ratio).padStart(5)}  ${flag}`);
    out.augments = out.augments || {};
    out.augments[`crest_${t}`] = { worth: v };
  }
  console.log(`   (${elapsed(t0)})`);
}

// ------------------------------------------------------------ 5. terrain
// A random team with one tile under one of its units (a ranged unit for High Ground,
// which only helps them) vs the same team with no tile. Units can walk off the tile,
// as they do in real fights, so front-line tiles are worth less than back-line ones.
function terrainValue() {
  const t0 = Date.now();
  console.log(`\n5. TERRAIN  (power equivalent, one tile under one unit, ${N.traitFights} mirror fights each)`);
  console.log('   Compare with the median combat augment, which buffs the whole team every fight.\n');
  const rows = [];
  for (const type of Object.keys(TERRAIN)) {
    const r = powerRatio(() => {
      const team = randomTeam();
      const placed = place(team);
      const tiers = activeTiers(team);
      const fits = type === 'high' ? placed.filter((p) => UNITS[p.unit.key].range > 1) : placed;
      const pool = fits.length ? fits : placed;
      const host = pool[rnd(pool.length)];
      return { X: placed, Y: placed, tiersX: tiers, tiersY: tiers, tilesX: [{ x: host.x, y: host.y, type }] };
    }, N.traitFights);
    rows.push({ type, ...r });
  }
  const med = median(rows.map((r) => r.ratio - 1));
  for (const r of rows.sort((a, b) => b.ratio - a.ratio)) {
    const d = TERRAIN[r.type];
    const v = r.ratio - 1;
    let flag = '';
    if (v < 0.01) { flag = '◀ barely matters'; flags.push(`Terrain ${d.name} is worth only ${boost(r.ratio)}`); }
    else if (v > med * 2 && v > med + 0.04) { flag = '◀ strong'; flags.push(`Terrain ${d.name} is worth ${boost(r.ratio)}; median tile is ${boost(1 + med)}`); }
    if (augMedian !== null && v > augMedian) { flag += ' ◀ beats an augment'; flags.push(`Terrain ${d.name} (${boost(r.ratio)}) is worth more than a median combat augment (${boost(1 + augMedian)})`); }
    console.log(`   ${(d.icon + ' ' + d.name).padEnd(18)} ${boost(r.ratio).padStart(5)}   win ${pct(r.win).padStart(6)}  ${flag}`);
    out.terrain[r.type] = { worth: v, winRate: r.win };
  }
  console.log(`   median tile ${boost(1 + med)}${augMedian !== null ? `, median combat augment ${boost(1 + augMedian)}` : ''}   (${elapsed(t0)})`);
}

// ------------------------------------------------------------ 6. arena rules
// Combat rules apply to everyone, so the question isn't "how strong" but "what changes":
// fight pace, draws (fights that hit the time limit), and which traits gain or lose value.
function ruleValue() {
  const t0 = Date.now();
  const combatRules = Object.keys(RULES).filter((id) => RULES[id].mods);
  const traits = Object.keys(TRAITS);
  console.log(`\n6. ARENA RULES  (${N.ruleFights} random fights for pace, ${N.traitFights} mirror fights per trait)`);
  console.log('   Pace: random 7-unit teams with traits on, rule applied to both sides.');
  console.log("   Trait columns: worth of each trait's first tier with no rule, then the change in points");
  console.log('   under each rule (* = a big shift). Economy and terrain rules are covered in section 7.\n');
  const pace = (mods) => {
    let time = 0;
    let draws = 0;
    for (let i = 0; i < N.ruleFights; i++) {
      const X = randomTeam();
      const Y = randomTeam();
      const r = fight(place(X), place(Y), activeTiers(X), activeTiers(Y), { modsX: mods, modsY: mods });
      time += r.time;
      draws += r.draw ? 1 : 0;
    }
    return { time: time / N.ruleFights, draws: draws / N.ruleFights };
  };
  const worths = (mods) => Object.fromEntries(traits.map((t) => [t, powerRatio(() => traitSample(t, 0, mods), N.traitFights).ratio - 1]));
  const base = { ...pace(null), worth: worths(null) };
  const head = traits.map((t) => TRAITS[t].name.slice(0, 6).padStart(7)).join('');
  console.log(`   ${'Rule'.padEnd(18)} fight   draws ${head}`);
  console.log(`   ${'(no rule)'.padEnd(18)} ${base.time.toFixed(1).padStart(4)}s ${pct(base.draws).padStart(6)} ${traits.map((t) => boost(1 + base.worth[t]).padStart(7)).join('')}`);
  out.rules.none = base;
  for (const id of combatRules) {
    const mods = RULES[id].mods;
    const r = { ...pace(mods), worth: worths(mods) };
    const cells = traits.map((t) => {
      const b = base.worth[t];
      const d = r.worth[t] - b;
      const big = Math.abs(d) >= 0.08 && Math.abs(d) >= Math.abs(b) * 0.5;
      if (big) flags.push(`Rule ${RULES[id].name} moves ${TRAITS[t].name} (${TRAITS[t].breakpoints[0]}) from ${boost(1 + b)} to ${boost(1 + r.worth[t])}`);
      return `${d >= 0 ? '+' : ''}${Math.round(d * 100)}${big ? '*' : ' '}`.padStart(7);
    }).join('');
    let flag = '';
    if (r.draws > Math.max(0.1, base.draws * 3)) { flag = '◀ many draws'; flags.push(`Rule ${RULES[id].name}: ${pct(r.draws)} of fights hit the time limit (no rule: ${pct(base.draws)})`); }
    console.log(`   ${(RULES[id].icon + ' ' + RULES[id].name).padEnd(18)} ${r.time.toFixed(1).padStart(4)}s ${pct(r.draws).padStart(6)} ${cells}  ${flag}`);
    out.rules[id] = r;
  }
  console.log('   Ascendant acts like a free crest for everyone (section 4) with +20% instead of +15%.');
  console.log(`   (${elapsed(t0)})`);
}

// ------------------------------------------------------------ 7. full bot games
function botGames() {
  const t0 = Date.now();
  const traitStat = {};
  const unitStat = Object.fromEntries(KEYS.map((k) => [k, { n: 0, place: 0, top4: 0 }]));
  const augStat = Object.fromEntries(Object.keys(AUGMENTS).map((k) => [k, { n: 0, place: 0, top4: 0 }]));
  const ruleStat = {};
  let boards = 0;
  for (let g = 0; g < N.games; g++) {
    const game = new Game({ humans: [] });
    game.start();
    const lastTeam = {};
    let guard = 0;
    while (game.phase !== 'gameover' && guard++ < 80) {
      game.startCombat(); // resolves instantly with no humans
      for (const m of game.matches) {
        lastTeam[m.a.id] = m.teamA;
        if (!m.pve && !m.ghost) lastTeam[m.b.id] = m.teamB;
      }
      if (game.phase === 'results') game.nextRound();
    }
    const winner = game.players.find((p) => p.placement === 1);
    const rs = (ruleStat[game.rule.id] ||= { games: 0, rounds: 0, level: 0, stars: 0 });
    rs.games++;
    rs.rounds += game.round;
    rs.level += winner.level;
    rs.stars += (lastTeam[winner.id] || []).reduce((s, u) => s + u.unit.star, 0);
    for (const p of game.players) {
      const team = (lastTeam[p.id] || []).map((s) => s.unit);
      const place = p.placement;
      boards++;
      for (const id of p.augments) {
        const s = augStat[id];
        s.n++; s.place += place; s.top4 += place <= 4 ? 1 : 0;
      }
      for (const [t, tier] of Object.entries(activeTiers(team, traitBonus(p.augments, ruleTraitBonus(game.rule))))) {
        const key = `${t}:${tier}`;
        const s = (traitStat[key] ||= { n: 0, place: 0, top4: 0 });
        s.n++; s.place += place; s.top4 += place <= 4 ? 1 : 0;
      }
      for (const k of new Set(team.map((u) => u.key))) {
        const s = unitStat[k];
        s.n++; s.place += place; s.top4 += place <= 4 ? 1 : 0;
      }
    }
  }
  console.log(`\n7. FULL BOT GAMES  (${N.games} games, final board of each player, ${elapsed(t0)})`);
  console.log('   Avg placement: 1 = best, 8 = worst, 4.5 = average. Biased by how the bots build and by');
  console.log('   expensive units only appearing on boards that survived long, so use it as a sanity check.\n');
  console.log('   Trait (tier)        played   avg place   top 4');
  const trows = Object.entries(traitStat).map(([key, s]) => {
    const [t, tier] = key.split(':');
    return { t, bp: TRAITS[t].breakpoints[tier], n: s.n, avg: s.place / s.n, top4: s.top4 / s.n };
  }).sort((a, b) => a.avg - b.avg);
  for (const r of trows) {
    console.log(`   ${(TRAITS[r.t].name + ` (${r.bp})`).padEnd(18)} ${pct(r.n / boards).padStart(7)}   ${r.avg.toFixed(2).padStart(9)}   ${pct(r.top4).padStart(6)}`);
    out.games[`trait:${r.t}:${r.bp}`] = { playRate: r.n / boards, avgPlacement: r.avg, top4: r.top4 };
  }
  console.log('\n   Unit                played   avg place   top 4');
  const urows = KEYS.map((k) => ({ k, ...unitStat[k] })).filter((r) => r.n)
    .map((r) => ({ ...r, avg: r.place / r.n, top4r: r.top4 / r.n })).sort((a, b) => a.avg - b.avg);
  for (const r of urows) {
    console.log(`   ${`${UNITS[r.k].name} (${UNITS[r.k].cost})`.padEnd(18)} ${pct(r.n / boards).padStart(7)}   ${r.avg.toFixed(2).padStart(9)}   ${pct(r.top4r).padStart(6)}`);
    out.games[`unit:${r.k}`] = { playRate: r.n / boards, avgPlacement: r.avg, top4: r.top4r };
  }
  const unplayed = KEYS.filter((k) => !unitStat[k].n);
  if (unplayed.length) console.log(`   never on a final board: ${unplayed.map((k) => UNITS[k].name).join(', ')}`);

  console.log('\n   Augment (bots\' picks)      picked   avg place   top 4');
  const arows = Object.keys(AUGMENTS).map((id) => ({ id, ...augStat[id] })).filter((r) => r.n >= 10)
    .map((r) => ({ ...r, avg: r.place / r.n, top4r: r.top4 / r.n })).sort((a, b) => a.avg - b.avg);
  for (const r of arows) {
    const a = AUGMENTS[r.id];
    console.log(`   ${`${a.icon} ${a.name}`.padEnd(26)} ${String(r.n).padStart(6)}   ${r.avg.toFixed(2).padStart(9)}   ${pct(r.top4r).padStart(6)}`);
    out.games[`augment:${r.id}`] = { picks: r.n, avgPlacement: r.avg, top4: r.top4r };
  }
  console.log('   (Picked early or late changes what an augment is worth, and bots favour crests and');
  console.log('    combat augments, so economy augments get fewer, more random picks.)');

  console.log('\n   Arena rule (random per game)   games   rounds   winner level   winner stars');
  const all = Object.values(ruleStat).reduce((a, s) => ({ games: a.games + s.games, rounds: a.rounds + s.rounds }), { games: 0, rounds: 0 });
  const avgRounds = all.rounds / all.games;
  const rrows = Object.entries(ruleStat).map(([id, s]) => ({ id, ...s })).sort((a, b) => (a.rounds / a.games) - (b.rounds / b.games));
  for (const r of rrows) {
    const rounds = r.rounds / r.games;
    let flag = '';
    if (r.games >= 30 && Math.abs(rounds - avgRounds) > avgRounds * 0.15) {
      flag = rounds < avgRounds ? '◀ short games' : '◀ long games';
      flags.push(`Rule ${RULES[r.id].name}: games last ${rounds.toFixed(1)} rounds on average (all rules: ${avgRounds.toFixed(1)})`);
    }
    console.log(`   ${(RULES[r.id].icon + ' ' + RULES[r.id].name).padEnd(30)} ${String(r.games).padStart(5)}   ${rounds.toFixed(1).padStart(6)}   ${(r.level / r.games).toFixed(1).padStart(12)}   ${(r.stars / r.games).toFixed(1).padStart(12)}  ${flag}`);
    out.games[`rule:${r.id}`] = { games: r.games, avgRounds: rounds, winnerLevel: r.level / r.games, winnerStars: r.stars / r.games };
  }
  console.log(`   all rules: ${avgRounds.toFixed(1)} rounds${quick ? '. Few games per rule in --quick, so these are rough.' : ''}`);
}

const start = Date.now();
console.log(`Hex Arena balance report${quick ? ' (quick)' : ''}`);
unitStrength();
traitValue();
costCurve();
augmentValue();
terrainValue();
ruleValue();
botGames();

console.log(`\nFLAGS (${flags.length})`);
console.log(flags.length ? flags.map((f) => `  - ${f}`).join('\n') : '  none');
console.log(`\ndone in ${elapsed(start)}`);
if (jsonOut) {
  out.flags = flags;
  fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  console.log(`saved ${jsonOut}`);
}
