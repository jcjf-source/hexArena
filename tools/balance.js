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
//   4. Full bot games: pick rate and average placement of traits and units on final boards.
//      This reflects how the bots play, so treat it as a sanity check, not the main signal.

import fs from 'node:fs';
import { UNITS, TRAITS } from '../js/data.js';
import { Combat, activeTiers } from '../js/combat.js';
import { Game } from '../js/game.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const N = {
  unitFights: quick ? 6000 : 40000,
  traitFights: quick ? 120 : 400,
  costFights: quick ? 120 : 400,
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
function fight(teamX, teamY, tiersX = null, tiersY = null, { seed, xIsA = Math.random() < 0.5 } = {}) {
  const opt = (tA, tB) => ({ record: false, tiersA: tA, tiersB: tB, ...(seed !== undefined ? { seed } : {}) });
  const c = xIsA
    ? new Combat(teamX, teamY, opt(tiersX, tiersY))
    : new Combat(teamY, teamX, opt(tiersY, tiersX));
  c.runToEnd();
  const sideX = xIsA ? 'A' : 'B';
  const share = (side) => {
    const us = c.units.filter((u) => u.side === side);
    return us.reduce((s, u) => s + Math.max(0, u.hp), 0) / us.reduce((s, u) => s + u.maxHp, 0);
  };
  const win = c.winner === 'draw' ? 0.5 : c.winner === sideX ? 1 : 0;
  return { win, margin: share(sideX) - share(sideX === 'A' ? 'B' : 'A') };
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
      const r = fight(x.X, scaled(x.Y, s), x.tiersX, x.tiersY, { seed: x.seed, xIsA: x.xIsA });
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
const out = { settings: N, units: {}, traits: {}, cost: [], games: {} };
const flags = [];

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
    const carriers = withTrait(t);
    const others = KEYS.filter((k) => !UNITS[k].traits.includes(t));
    TRAITS[t].breakpoints.forEach((bp, tier) => {
      if (bp > carriers.length) return;
      const r = powerRatio(() => {
        const size = Math.max(6, bp);
        const team = [...pickN(carriers, bp), ...pickN(others, size - bp)]
          .map((key) => ({ key, star: Math.random() < 0.5 ? 1 : 2 }));
        const placed = place(team);
        const on = activeTiers(team);
        on[t] = tier; // exactly this tier, even if fillers would push it higher
        const off = { ...on };
        delete off[t];
        return { X: placed, Y: placed, tiersX: on, tiersY: off };
      }, N.traitFights);
      rows.push({ t, bp, ...r });
    });
  }
  // Compare each tier with the median of traits at the same breakpoint.
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
  const medByBp = {};
  for (const bp of [2, 4]) medByBp[bp] = median(rows.filter((r) => r.bp === bp).map((r) => r.ratio - 1));
  for (const t of Object.keys(TRAITS)) {
    const mine = rows.filter((r) => r.t === t);
    const cells = mine.map((r) => `(${r.bp}) ${boost(r.ratio).padStart(5)} ${pct(r.win).padStart(6)}`).join('   ');
    const notes = [];
    for (const r of mine) {
      const v = r.ratio - 1;
      const med = medByBp[r.bp];
      if (med !== undefined && v > Math.max(med * 1.6, med + 0.08)) notes.push(`(${r.bp}) strong`);
      if (med !== undefined && v < Math.min(med * 0.6, med - 0.05)) notes.push(`(${r.bp}) weak`);
      if (med !== undefined && (v > Math.max(med * 1.6, med + 0.08) || v < Math.min(med * 0.6, med - 0.05))) {
        flags.push(`Trait ${TRAITS[t].name} (${r.bp}) is worth ${boost(r.ratio)} stats; median for (${r.bp}) traits is ${boost(1 + med)}`);
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
  console.log(`   median worth: (2) ${boost(1 + medByBp[2])}, (4) ${boost(1 + medByBp[4])}   (${elapsed(t0)})`);
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

// ------------------------------------------------------------ 4. full bot games
function botGames() {
  const t0 = Date.now();
  const traitStat = {};
  const unitStat = Object.fromEntries(KEYS.map((k) => [k, { n: 0, place: 0, top4: 0 }]));
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
    for (const p of game.players) {
      const team = (lastTeam[p.id] || []).map((s) => s.unit);
      const place = p.placement;
      boards++;
      for (const [t, tier] of Object.entries(activeTiers(team))) {
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
  console.log(`\n4. FULL BOT GAMES  (${N.games} games, final board of each player, ${elapsed(t0)})`);
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
}

const start = Date.now();
console.log(`Hex Arena balance report${quick ? ' (quick)' : ''}`);
unitStrength();
traitValue();
costCurve();
botGames();

console.log(`\nFLAGS (${flags.length})`);
console.log(flags.length ? flags.map((f) => `  - ${f}`).join('\n') : '  none');
console.log(`\ndone in ${elapsed(start)}`);
if (jsonOut) {
  out.flags = flags;
  fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  console.log(`saved ${jsonOut}`);
}
