import { Combat, STEP } from './combat.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { Menu } from './menu.js';
import { HostSession } from './session.js';
import { normalizeCode } from './net.js';

const renderer = new Renderer(document.getElementById('board'));
const overlay = document.getElementById('overlay');
let session = null;
let replay = null; // local replay of the fight this player is watching

const ui = new UI(renderer, { playAgain, backToMenu });
const menu = new Menu(play);

function play(s, { startHost }) {
  if (session && session !== s) session.leave?.();
  session = s;
  replay = null;
  overlay.classList.add('hidden');
  overlay.dataset.mode = '';
  ui.setSession(s);
  s.onEnd = (reason) => {
    if (!reason) return;
    menu.showMessage('Disconnected', reason, backToMenu);
  };
  if (startHost) s.start();
}

function playAgain() {
  play(new HostSession(session?.seats?.[0]?.name || 'You'), { startHost: true });
}

function backToMenu() {
  if (session) session.leave?.();
  location.href = location.pathname; // fresh page, drops any ?join= code
}

// Rebuild the fight locally from the host's teams + seed, and step it at the host's speed.
function syncReplay(v, dt) {
  const m = v.match;
  if (!m || (v.phase !== 'combat' && v.phase !== 'results')) { replay = null; return; }
  if (!replay || replay.round !== v.round) {
    replay = {
      round: v.round,
      flip: m.flip,
      combat: new Combat(m.teamA, m.teamB, { seed: m.seed, record: true }),
      acc: 0,
    };
  }
  const c = replay.combat;
  if (v.phase === 'combat' && !c.over) {
    replay.acc += dt * v.speed;
    while (replay.acc >= STEP && !c.over) {
      c.step(STEP);
      replay.acc -= STEP;
    }
  }
}

const params = new URLSearchParams(location.search);
// ?debug exposes the session for console poking and automated screenshots.
if (params.has('debug')) window.hexArena = { get session() { return session; } };
if (params.has('autostart')) menu.solo();
else menu.showMain(null, normalizeCode(params.get('join')));

let last = performance.now();
function advance() {
  const now = performance.now();
  // Hidden tabs tick rarely, so allow bigger steps there to keep game time honest.
  const dt = Math.min(document.hidden ? 2 : 0.1, (now - last) / 1000);
  last = now;
  if (session) {
    session.update(dt);
    if (session.view) syncReplay(session.view, dt);
  }
  return dt;
}

function frame() {
  const dt = advance();
  const v = session && session.view;
  if (v) {
    ui.replay = replay;
    renderer.draw(v, replay, dt);
    ui.tick(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Browsers pause animation frames in background tabs. The host's tab runs the
// game for everyone, so keep it ticking on a timer while hidden.
setInterval(() => { if (document.hidden) advance(); }, 250);
