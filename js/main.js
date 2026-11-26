import { Game } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';

const renderer = new Renderer(document.getElementById('board'));
let game = null;

const ui = new UI(renderer, { newGame });

function newGame() {
  game = new Game();
  ui.setGame(game);
  document.getElementById('overlay').classList.add('hidden');
  game.start();
}

document.getElementById('startBtn').onclick = newGame;
if (new URLSearchParams(location.search).has('autostart')) newGame();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (game) {
    game.update(dt);
    renderer.draw(game, dt);
    ui.tick(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
