// Headless multiplayer check: several "human" seats play through dispatch()
// using only their JSON snapshots, the way remote clients do.
// Verifies that every fight replayed from a snapshot matches the host's result,
// that the host's clock waits for watched fights, and that dropped players become bots.
// Usage: node tools/nettest.js [games]
import { Game } from '../js/game.js';
import { Combat, STEP } from '../js/combat.js';
import { UNITS, POOL_SIZE } from '../js/data.js';

const games = Number(process.argv[2] || 10);
let replays = 0;
let flipped = 0;

function assert(c, msg) { if (!c) throw new Error(msg); }

// Every copy of every unit is in exactly one place: the pool, a shop, or owned.
function checkPool(game) {
  const count = { ...game.pool };
  for (const p of game.players) {
    for (const k of p.shop) if (k) count[k]++;
    for (const l of game.allUnits(p)) count[l.unit.key] += 3 ** (l.unit.star - 1);
  }
  for (const k in UNITS) {
    assert(game.pool[k] >= 0, `pool negative for ${k}`);
    assert(count[k] === POOL_SIZE[UNITS[k].cost], `${k}: ${count[k]} copies accounted for, expected ${POOL_SIZE[UNITS[k].cost]}`);
  }
}

// Simple client brain: buy what it can, then fill the board from the bench.
function clientTurn(game, pid) {
  const send = (a) => game.dispatch(pid, JSON.parse(JSON.stringify(a)));
  let v = JSON.parse(JSON.stringify(game.viewFor(pid)));
  for (let i = 0; i < v.me.shop.length; i++) if (v.me.shop[i]) send({ type: 'buy', i });
  v = game.viewFor(pid);
  for (let i = 0; i < v.me.bench.length; i++) {
    if (!v.me.bench[i]) continue;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 7; x++) {
      if (send({ type: 'move', from: { area: 'bench', i }, to: { area: 'board', x, y } })) { x = 9; y = 9; }
    }
  }
  // Junk input must be rejected, not crash.
  send({ type: 'move', from: { area: 'board', x: 99, y: -1 }, to: null });
  send({ type: 'sell', loc: { area: 'bench', i: 'x' } });
  send({ type: 'buy', i: 42 });
  send({ type: 'ready', ready: true });
}

for (let g = 0; g < games; g++) {
  const game = new Game({ humans: [{ name: 'Host' }, { name: 'A' }, { name: 'B' }, { name: 'C' }] });
  game.start();
  let guard = 0;
  while (game.phase !== 'gameover' && guard++ < 120) {
    for (const p of game.aliveHumans()) clientTurn(game, p.id);
    if (game.round === 6 && game.players[3].isHuman) game.dropPlayer(3);
    // All humans ready -> combat starts on the next update.
    game.update(0.01);
    assert(game.phase === 'combat' || game.phase === 'gameover', `expected combat, got ${game.phase}`);
    if (game.phase === 'gameover') break;

    // Each human replays its own fight from the snapshot and must match the host.
    for (const p of game.aliveHumans()) {
      const v = JSON.parse(JSON.stringify(game.viewFor(p.id)));
      assert(v.match, `player ${p.id} has no match`);
      const host = game.matchOf(p).combat;
      const c = new Combat(v.match.teamA, v.match.teamB, { seed: v.match.seed, record: true }).runToEnd();
      assert(c.winner === host.winner && Math.abs(c.time - host.time) < 1e-9,
        `replay mismatch: ${c.winner}@${c.time} vs ${host.winner}@${host.time}`);
      const hpA = c.units.map((u) => u.hp).join();
      const hpB = host.units.map((u) => u.hp).join();
      assert(hpA === hpB, 'replay unit HP mismatch');
      replays++;
      if (v.match.flip) flipped++;
    }

    // The host must not leave combat before the longest watched fight is over.
    const longest = Math.max(0, ...game.matches
      .filter((m) => m.a.isHuman || (!m.ghost && m.b && m.b.isHuman)).map((m) => m.combat.time));
    let t = 0;
    while (game.phase === 'combat' && t < 200) { game.update(STEP); t += STEP; }
    assert(t >= longest, `combat ended early (${t.toFixed(2)}s < ${longest.toFixed(2)}s)`);
    if (game.phase === 'results') while (game.phase === 'results') game.update(0.5);
    checkPool(game);
  }
  assert(game.phase === 'gameover', 'game did not finish');
  assert(!game.players[3].isHuman && game.players[3].name.endsWith('(left)'), 'dropped player not converted to bot');
  const places = game.players.map((p) => p.placement).sort((a, b) => a - b).join();
  assert(places === '1,2,3,4,5,6,7,8', `bad placements ${places}`);
  for (const k in game.pool) assert(game.pool[k] >= 0, `pool negative for ${k}`);
}

console.log(`ok: ${games} games, ${replays} fight replays matched the host (${flipped} mirrored)`);

// Fair rotation: n players (+ a ghost "bye" when odd) must each meet every
// opponent exactly once per cycle of (even n ? n-1 : n) rounds.
let t0 = Date.now();
for (const n of [8, 7, 6, 5, 4, 3, 2]) {
  for (let trial = 0; trial < 40; trial++) {
    const game = new Game({ humans: [] });
    const ids = Array.from({ length: n }, (_, i) => i);
    const cycle = n % 2 ? n : n - 1;
    for (let c = 0; c < 3; c++) {
      const seen = new Map();
      for (let r = 0; r < cycle; r++) {
        for (const [i, j] of game.pickPairs(ids)) {
          const k = i < j ? `${i}:${j}` : `${j}:${i}`;
          assert(!seen.has(k), `n=${n}: pair ${k} repeated within a cycle (round ${r + 1})`);
          seen.set(k, true);
        }
      }
      const expected = ((n % 2 ? n + 1 : n) * (n % 2 ? n : n - 1)) / 2;
      assert(seen.size === expected, `n=${n}: cycle covered ${seen.size}/${expected} pairs`);
    }
  }
}
// After an elimination mid-cycle, nobody should face someone they already met
// this cycle while an unmet opponent is still available to both of them.
for (let trial = 0; trial < 200; trial++) {
  const game = new Game({ humans: [] });
  let ids = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let r = 0; r < 3; r++) game.pickPairs(ids);
  ids = ids.filter((x) => x !== trial % 8);
  for (let r = 0; r < 3; r++) {
    const before = new Set(game.cycleMet);
    const pairs = game.pickPairs(ids);
    const repeats = pairs.filter(([i, j]) => before.has(i < j ? `${i}:${j}` : `${j}:${i}`)).length;
    assert(repeats <= 1, `after elimination: ${repeats} repeat pairings in one round`);
  }
}
console.log(`ok: rotation covers every opponent once per cycle (n = 2..8), ${Date.now() - t0}ms`);
