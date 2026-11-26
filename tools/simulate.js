// Headless smoke test: plays full 8-bot games using the real game logic.
// Usage: node tools/simulate.js [games]
import { Game } from '../js/game.js';
import { UNITS } from '../js/data.js';

const games = Number(process.argv[2] || 20);
const roundsPlayed = [];
const winsByTrait = {};

for (let g = 0; g < games; g++) {
  const game = new Game({ humans: [] });
  game.start();
  let guard = 0;
  while (game.phase !== 'gameover' && guard++ < 80) {
    game.startCombat();
    if (game.phase === 'results') game.nextRound();
  }
  const winner = game.players.find((p) => p.placement === 1);
  roundsPlayed.push(game.round);
  for (const b of game.boardUnits(winner)) {
    for (const t of UNITS[b.unit.key].traits) winsByTrait[t] = (winsByTrait[t] || 0) + 1;
  }
  // Pool sanity: never negative.
  for (const k in game.pool) if (game.pool[k] < 0) throw new Error(`pool negative for ${k}`);
}

const avg = roundsPlayed.reduce((a, b) => a + b, 0) / roundsPlayed.length;
console.log(`games: ${games}, avg rounds: ${avg.toFixed(1)}, min ${Math.min(...roundsPlayed)}, max ${Math.max(...roundsPlayed)}`);
console.log('trait appearances on winning boards:', winsByTrait);
