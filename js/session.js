// Sessions sit between the screen and the game.
//  - HostSession owns the authoritative Game. It serves solo play (no peers) and
//    online games, where it also relays snapshots to and actions from clients.
//  - ClientSession mirrors the host: it receives snapshots and sends actions.
// The UI only ever reads `session.view` and calls `session.act(action)`.

import { Game, MAX_PLAYERS, moveUnit } from './game.js';
import { makeCode, openHostPeer, joinRoom } from './net.js';

const PROTOCOL = 1;
const SYNC_EVERY = 1; // seconds between unprompted snapshot refreshes

export function cleanName(s, fallback = 'Player') {
  const n = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || fallback;
}

class Session {
  constructor() {
    this.view = null;
    this.onView = () => {};
    this.onBanner = (_text, _kind) => {};
    this.onLobby = (_lobby) => {};
    this.onStart = () => {};
    this.onEnd = (_reason) => {};
  }
}

export class HostSession extends Session {
  constructor(name = 'You') {
    super();
    this.isHost = true;
    this.online = false;
    this.code = null;
    this.peer = null;
    this.game = null;
    this.seats = [{ name: cleanName(name, 'Host'), conn: null }]; // seat index = player id
    this.dirty = true;
    this.sinceSync = 0;
  }

  get multiplayer() { return this.seats.length > 1; }

  // ------------------------------------------------------------ lobby
  async host() {
    for (let tries = 0; tries < 4; tries++) {
      const code = makeCode();
      try {
        this.peer = await openHostPeer(code);
        this.code = code;
        break;
      } catch (e) {
        if (e.type !== 'unavailable-id' || tries === 3) throw e;
      }
    }
    this.online = true;
    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('error', (e) => console.warn('peer error', e));
    this.emitLobby();
  }

  lobbyInfo() {
    return { code: this.code, players: this.seats.map((s) => s.name), max: MAX_PLAYERS };
  }

  emitLobby() {
    const info = this.lobbyInfo();
    this.onLobby(info);
    this.seats.forEach((s, i) => { if (s.conn) this.send(s.conn, { t: 'lobby', ...info, you: i }); });
  }

  accept(conn) {
    conn.on('data', (msg) => this.onData(conn, msg));
    conn.on('close', () => this.onClose(conn));
    conn.on('error', () => this.onClose(conn));
  }

  send(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch (e) { console.warn('send failed', e); }
  }

  onData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (conn.seat !== undefined) return;
      let reason = null;
      if (msg.v !== PROTOCOL) reason = 'The host is running a different version. Refresh both pages.';
      else if (this.game) reason = 'That game has already started.';
      else if (this.seats.length >= MAX_PLAYERS) reason = 'That game is full.';
      if (reason) {
        this.send(conn, { t: 'reject', reason });
        setTimeout(() => conn.close(), 300);
        return;
      }
      conn.seat = this.seats.length;
      this.seats.push({ name: this.uniqueName(cleanName(msg.name)), conn });
      this.emitLobby();
    } else if (msg.t === 'act' && this.game && conn.seat !== undefined) {
      this.game.dispatch(conn.seat, msg.a);
    }
  }

  uniqueName(name) {
    const taken = new Set(this.seats.map((s) => s.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
  }

  onClose(conn) {
    const seat = conn.seat;
    if (seat === undefined || conn.closedHandled) return;
    conn.closedHandled = true;
    if (this.game) {
      this.seats[seat].conn = null;
      this.game.dropPlayer(seat);
    } else {
      this.seats.splice(seat, 1);
      this.seats.forEach((s, i) => { if (s.conn) s.conn.seat = i; });
      this.emitLobby();
    }
  }

  // ------------------------------------------------------------ game
  start() {
    this.game = new Game({ humans: this.seats.map((s) => ({ name: s.name })) });
    this.game.onChange = () => { this.dirty = true; };
    this.game.onBanner = (pid, text, kind) => {
      if (pid === 0) this.onBanner(text, kind);
      else if (this.seats[pid]?.conn) this.send(this.seats[pid].conn, { t: 'banner', text, kind });
    };
    for (const s of this.seats) if (s.conn) this.send(s.conn, { t: 'start' });
    this.game.start();
    this.flush();
    this.onStart();
  }

  flush() {
    this.dirty = false;
    this.sinceSync = 0;
    this.view = this.game.viewFor(0);
    this.seats.forEach((s, i) => { if (s.conn) this.send(s.conn, { t: 'view', v: this.game.viewFor(i) }); });
    this.onView();
  }

  update(dt) {
    if (!this.game) return;
    this.game.update(dt);
    this.sinceSync += dt;
    if (this.dirty || (this.multiplayer && this.sinceSync >= SYNC_EVERY)) this.flush();
    else if (this.view) this.view.timer = this.game.timer;
  }

  act(a) {
    if (!this.game) return;
    if (a.type === 'speed') {
      if ([1, 2, 4].includes(a.speed)) {
        this.game.speed = a.speed;
        if (this.view) this.view.speed = a.speed; // reflect at once; full snapshot follows next frame
        this.onView();
        this.dirty = true;
      }
      return;
    }
    this.game.dispatch(0, a);
  }

  leave() {
    if (this.peer) this.peer.destroy();
    this.peer = null;
  }
}

export class ClientSession extends Session {
  constructor(name) {
    super();
    this.isHost = false;
    this.online = true;
    this.multiplayer = true;
    this.name = cleanName(name);
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.ended = false;
  }

  async join(code) {
    const { peer, conn } = await joinRoom(code);
    this.peer = peer;
    this.conn = conn;
    this.code = code;
    conn.on('data', (msg) => this.onData(msg));
    conn.on('close', () => this.end('Lost connection to the host.'));
    peer.on('disconnected', () => {}); // broker loss is fine once connected
    conn.send({ t: 'hello', name: this.name, v: PROTOCOL });
  }

  onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'lobby': this.onLobby(msg); break;
      case 'reject': this.end(msg.reason); break;
      case 'start': this.onStart(); break;
      case 'view': this.view = msg.v; this.onView(); break;
      case 'banner': this.onBanner(msg.text, msg.kind); break;
      default: break;
    }
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.view?.phase === 'gameover') reason = null; // host leaving after the end is fine
    this.leave();
    this.onEnd(reason);
  }

  update(dt) {
    const v = this.view;
    if (v && (v.phase === 'planning' || v.phase === 'results')) v.timer -= dt;
  }

  act(a) {
    if (!this.conn || this.ended) return;
    const v = this.view;
    // Apply drags immediately so units don't snap back while the host confirms.
    if (a.type === 'move' && v) {
      if (moveUnit(v.me, a.from, a.to, v.phase !== 'planning')) this.onView();
    }
    if (a.type === 'ready' && v) { v.me.ready = a.ready; this.onView(); }
    try { this.conn.send({ t: 'act', a }); } catch (e) { console.warn('send failed', e); }
  }

  leave() {
    if (this.peer) this.peer.destroy();
    this.peer = null;
  }
}
