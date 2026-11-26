// Title screen and online lobby (host / join), drawn into the #overlay panel.

import { HostSession, ClientSession, cleanName } from './session.js';
import { normalizeCode, CODE_LEN } from './net.js';
import { esc } from './ui.js';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'hexarena.name';

function loadName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* storage unavailable */ }
}

export class Menu {
  // onPlay(session, { startHost }) is called when a game is about to begin.
  constructor(onPlay) {
    this.onPlay = onPlay;
    this.ov = $('overlay');
    this.session = null;
  }

  panel(html) {
    this.ov.dataset.mode = 'menu';
    this.ov.innerHTML = `<div class="panel menu">${html}</div>`;
    this.ov.classList.remove('hidden');
  }

  name() {
    const input = $('nameInput');
    const n = cleanName(input ? input.value : loadName(), 'Player');
    saveName(n);
    return n;
  }

  showMain(error = null, joinCode = '') {
    if (this.session) { this.session.leave?.(); this.session = null; }
    this.panel(`
      <h1>⬢ Hex Arena</h1>
      <p class="big">Draft a team, build synergies, and be the last one standing.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="field">Your name
        <input id="nameInput" maxlength="16" placeholder="Player" value="${esc(loadName())}"></label>
      <div class="btnstack">
        <button id="soloBtn" class="primary">Play solo vs 7 bots</button>
        <button id="hostBtn">Host online game</button>
      </div>
      <div class="joinrow">
        <input id="codeInput" maxlength="${CODE_LEN}" placeholder="CODE" value="${esc(joinCode)}" autocomplete="off" spellcheck="false">
        <button id="joinBtn">Join game</button>
      </div>
      <p class="muted small">Online games connect browsers directly. Bots fill any empty seats, up to 8 players.</p>`);
    const code = $('codeInput');
    code.oninput = () => { code.value = normalizeCode(code.value); };
    code.onkeydown = (e) => { if (e.key === 'Enter') $('joinBtn').click(); };
    $('soloBtn').onclick = () => this.solo();
    $('hostBtn').onclick = () => this.host();
    $('joinBtn').onclick = () => {
      const c = normalizeCode(code.value);
      if (c.length !== CODE_LEN) { code.focus(); code.classList.add('bad'); return; }
      this.join(c);
    };
    if (joinCode) $('nameInput').focus();
  }

  solo() {
    const s = new HostSession(this.name());
    this.onPlay(s, { startHost: true });
  }

  async host() {
    const name = this.name();
    const s = new HostSession(name);
    this.session = s;
    this.panel('<h2>Creating room…</h2><p class="muted">Contacting the matchmaking server.</p>');
    s.onLobby = (info) => this.renderHosting(info);
    try {
      await s.host();
    } catch (e) {
      if (this.session === s) this.showMain(e.message);
    }
  }

  inviteLink(code) {
    return `${location.origin}${location.pathname}?join=${code}`;
  }

  playerList(info) {
    const rows = info.players.map((n, i) => `<li>${i === 0 ? '👑 ' : '👤 '}${esc(n)}</li>`);
    const bots = info.max - info.players.length;
    if (bots > 0) rows.push(`<li class="muted">🤖 ${bots} bot${bots === 1 ? '' : 's'}</li>`);
    return `<ul class="players">${rows.join('')}</ul>`;
  }

  renderHosting(info) {
    if (this.session?.isHost !== true) return;
    const link = this.inviteLink(info.code);
    this.panel(`
      <h2>Room code</h2>
      <div class="code">${info.code}</div>
      <div class="joinrow"><input id="linkInput" readonly value="${esc(link)}"><button id="copyBtn">Copy link</button></div>
      <h3>Players ${info.players.length} / ${info.max}</h3>
      ${this.playerList(info)}
      <div class="btnstack">
        <button id="startHostBtn" class="primary">Start game</button>
        <button id="cancelBtn">Cancel</button>
      </div>
      <p class="muted small">Keep this tab open while you play: your browser runs the game for everyone.</p>`);
    $('copyBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Copied!'; } catch {
        $('linkInput').select();
      }
    };
    $('startHostBtn').onclick = () => {
      const s = this.session;
      this.session = null; // the game owns it now
      this.onPlay(s, { startHost: true });
    };
    $('cancelBtn').onclick = () => this.showMain();
  }

  async join(code) {
    const s = new ClientSession(this.name());
    this.session = s;
    this.panel(`<h2>Joining ${code}…</h2><p class="muted">Connecting to the host.</p>
      <div class="btnstack"><button id="cancelBtn">Cancel</button></div>`);
    $('cancelBtn').onclick = () => this.showMain();
    s.onLobby = (info) => this.renderJoined(info);
    s.onEnd = (reason) => { if (this.session === s) this.showMain(reason || 'The host closed the room.'); };
    s.onStart = () => {
      this.session = null;
      this.onPlay(s, { startHost: false });
    };
    try {
      await s.join(code);
    } catch (e) {
      if (this.session === s) this.showMain(e.message, code);
    }
  }

  renderJoined(info) {
    if (!this.session || this.session.isHost) return;
    this.panel(`
      <h2>Joined room ${info.code}</h2>
      <p class="muted">Waiting for the host to start the game…</p>
      <h3>Players ${info.players.length} / ${info.max}</h3>
      ${this.playerList(info)}
      <div class="btnstack"><button id="cancelBtn">Leave</button></div>`);
    $('cancelBtn').onclick = () => this.showMain();
  }

  // Shown when an online game ends unexpectedly.
  showMessage(title, text, onBack) {
    this.panel(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="btnstack"><button id="backBtn" class="primary">Back to menu</button></div>`);
    $('backBtn').onclick = onBack;
  }
}
