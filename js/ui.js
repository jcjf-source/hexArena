// DOM UI: top bar, shop, synergies, lobby, unit info, and input handling.
// Reads the player's snapshot (session.view) and sends actions (session.act).

import { UNITS, TRAITS, COST_COLORS, XP_TO_LEVEL, MAX_LEVEL, fillTemplate, traitDesc } from './data.js';
import { countTraits, traitTier, getDef } from './combat.js';
import {
  sellValue, REROLL_COST, XP_COST, getAt, boardUnits, boardCount, allUnits, canBuy,
} from './game.js';

const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

function traitChips(def) {
  return def.traits.map((t) => `<span class="chip">${TRAITS[t].icon} ${TRAITS[t].name}</span>`).join('');
}

export function unitInfoHTML(key, star, live) {
  const def = getDef(key);
  const m = [1, 1.8, 3.24][star - 1] * (live?.scale || 1);
  const hp = live ? `${Math.ceil(live.hp)} / ${Math.round(live.maxHp)}` : Math.round(def.hp * m);
  const ad = Math.round(live ? live.ad : def.ad * m);
  const as = (live ? live.as : def.as).toFixed(2);
  const armor = Math.round(live ? live.armor : def.armor);
  const mr = Math.round(live ? live.mr : def.mr);
  const mana = def.mana ? (live ? `${Math.floor(live.mana)} / ${live.maxMana}` : `${def.mana[0]} / ${def.mana[1]}`) : '—';
  const stars = def.traits.length ? `<span class="stars s${star}">${'★'.repeat(star)}</span>` : '';
  const ab = def.ability
    ? `<div class="ability"><div class="ab-name">${def.ability.name}</div><div class="ab-desc">${fillTemplate(def.ability.desc, def.ability, star)}</div></div>`
    : '';
  const cost = def.traits.length ? `<span class="cost-tag" style="background:${COST_COLORS[def.cost]}">${def.cost}g</span>` : '';
  return `
    <div class="info-head"><span class="info-icon">${def.icon}</span>
      <div><div class="info-name">${def.name} ${stars}</div><div>${cost} ${traitChips(def)}</div></div></div>
    <div class="stats">
      <div>❤️ HP <b>${hp}</b></div><div>🔷 Mana <b>${mana}</b></div>
      <div>⚔️ AD <b>${ad}</b></div><div>⏱️ AS <b>${as}</b></div>
      <div>🛡️ Armor <b>${armor}</b></div><div>🔮 MR <b>${mr}</b></div>
      <div>🎯 Range <b>${def.range}</b></div>
    </div>${ab}`;
}

export class UI {
  constructor(renderer, handlers) {
    this.r = renderer;
    this.h = handlers; // { playAgain, backToMenu }
    this.session = null;
    this.replay = null; // { combat, flip } supplied by main each frame
    this.hoverLoc = null;
    this.liveInfo = null;
    this.bannerTimer = 0;
    this.spectating = false;
    this.bindStatic();
    this.bindCanvas();
  }

  get v() { return this.session ? this.session.view : null; }
  get locked() { return !this.v || this.v.phase !== 'planning'; }

  act(a) { if (this.session && this.v && this.v.me.alive) this.session.act(a); }

  setSession(session) {
    this.session = session;
    this.spectating = false;
    session.onView = () => this.refresh();
    session.onBanner = (text, kind) => this.banner(text, kind);
    $('speedBtn').disabled = !session.isHost;
    $('speedBtn').title = session.isHost ? 'Combat speed' : 'The host controls combat speed';
    this.refresh();
  }

  toggleReady() {
    const v = this.v;
    if (!v || v.phase !== 'planning') return;
    this.act({ type: 'ready', ready: !v.me.ready });
  }

  bindStatic() {
    $('rerollBtn').onclick = () => this.act({ type: 'reroll' });
    $('xpBtn').onclick = () => this.act({ type: 'xp' });
    $('lockBtn').onclick = () => this.act({ type: 'lock' });
    $('readyBtn').onclick = () => this.toggleReady();
    $('speedBtn').onclick = () => {
      const v = this.v;
      if (!v || !this.session.isHost) return;
      this.session.act({ type: 'speed', speed: v.speed === 1 ? 2 : v.speed === 2 ? 4 : 1 });
    };
    $('shop').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.classList.contains('empty')) return;
      this.act({ type: 'buy', i: Number(card.dataset.i) });
    });
    $('shop').addEventListener('mouseover', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.classList.contains('empty') || !this.v) return;
      const key = this.v.me.shop[Number(card.dataset.i)];
      if (key) this.showInfo(unitInfoHTML(key, 1));
    });
    $('helpBtn').onclick = () => $('help').classList.toggle('hidden');
    $('helpClose').onclick = () => $('help').classList.add('hidden');

    window.addEventListener('keydown', (e) => {
      if (!this.v || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'd') this.act({ type: 'reroll' });
      else if (k === 'f') this.act({ type: 'xp' });
      else if (k === 'e' && this.hoverLoc) this.act({ type: 'sell', loc: this.hoverLoc });
      else if (k === ' ') { e.preventDefault(); this.toggleReady(); }
    });
  }

  locFromPick(pk) {
    if (!pk) return null;
    if (pk.area === 'bench') return { area: 'bench', i: pk.i };
    if (pk.row < 4) return null;
    return { area: 'board', x: pk.col, y: pk.row - 4 };
  }

  bindCanvas() {
    const cv = this.r.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      const v = this.v;
      if (!v || v.phase === 'gameover' || !v.me.alive) return;
      const pt = this.r.toLocal(e.clientX, e.clientY);
      const loc = this.locFromPick(this.r.pick(pt.x, pt.y));
      if (!loc) return;
      if (loc.area === 'board' && this.locked) return;
      const unit = getAt(v.me, loc);
      if (!unit) return;
      if (e.button === 2) { this.act({ type: 'sell', loc }); return; }
      cv.setPointerCapture(e.pointerId);
      this.r.drag = { from: loc, unit };
      this.r.pointer = pt;
      document.body.classList.add('dragging');
      $('sellZone').textContent = `Sell for ${sellValue(unit)} gold`;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.v) return;
      const pt = this.r.toLocal(e.clientX, e.clientY);
      this.r.pointer = pt;
      if (this.r.drag) {
        const over = document.elementFromPoint(e.clientX, e.clientY);
        $('sellZone').classList.toggle('hot', !!(over && over.closest('#shopbar')));
        return;
      }
      this.updateHover(pt);
    });
    cv.addEventListener('pointerleave', () => { if (!this.r.drag) this.r.pointer = null; });
    const end = (e) => {
      const drag = this.r.drag;
      if (!drag) return;
      this.r.drag = null;
      document.body.classList.remove('dragging');
      $('sellZone').classList.remove('hot');
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (over && over.closest('#shopbar')) { this.act({ type: 'sell', loc: drag.from }); return; }
      const pt = this.r.toLocal(e.clientX, e.clientY);
      const to = this.locFromPick(this.r.pick(pt.x, pt.y));
      if (to) this.act({ type: 'move', from: drag.from, to });
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => { this.r.drag = null; document.body.classList.remove('dragging'); });
  }

  updateHover(pt) {
    const v = this.v;
    const pk = this.r.pick(pt.x, pt.y);
    this.hoverLoc = null;
    if (!pk) return;
    const combat = this.replay && this.replay.combat;
    if (combat && pk.area === 'board') {
      const s = this.r.toSim(pk.col, pk.row);
      const u = combat.units.find((x) => x.alive && x.col === s.col && x.row === s.row);
      if (u) this.showInfo(unitInfoHTML(u.key, u.star, u), u);
      return;
    }
    const loc = this.locFromPick(pk);
    if (!loc) return;
    const u = getAt(v.me, loc);
    if (u) {
      this.hoverLoc = loc;
      this.showInfo(unitInfoHTML(u.key, u.star));
    }
  }

  showInfo(html, live = null) {
    this.liveInfo = live;
    $('info').innerHTML = html;
  }

  banner(text, kind = '') {
    const b = $('banner');
    b.textContent = text;
    b.className = `show ${kind}`;
    this.bannerTimer = 2.2;
  }

  // Called every frame: cheap updates only.
  tick(dt) {
    const v = this.v;
    if (!v) return;
    const t = $('timer');
    const combat = this.replay && this.replay.combat;
    if (v.phase === 'planning') t.textContent = `${Math.max(0, Math.ceil(v.timer))}s`;
    else if (v.phase === 'combat') t.textContent = combat ? `${Math.floor(combat.time)}s` : '';
    else t.textContent = '';
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) $('banner').className = '';
    }
    if (this.liveInfo && this.liveInfo.alive) {
      const u = this.liveInfo;
      $('info').innerHTML = unitInfoHTML(u.key, u.star, u);
    }
  }

  refresh() {
    const v = this.v;
    if (!v) return;
    const p = v.me;
    const phaseNames = { planning: 'Planning', combat: 'Combat', results: 'Results', gameover: 'Game Over' };
    $('round').textContent = v.round;
    $('phase').textContent = phaseNames[v.phase];
    let opp = '';
    if (v.phase !== 'planning' && v.match) {
      opp = v.match.pve ? 'vs Monsters' : `vs ${v.match.oppName}${v.match.ghost ? ' (ghost)' : ''}`;
    }
    $('opponent').textContent = opp;
    const ready = $('readyBtn');
    const solo = !this.session.multiplayer;
    const waiting = !solo && p.ready && v.phase === 'planning';
    ready.disabled = v.phase !== 'planning' || !p.alive;
    ready.textContent = waiting ? 'Waiting… ✖' : 'Ready ▶';
    ready.title = solo ? 'Start combat (Space)' : waiting ? 'Cancel ready (Space)' : 'Ready up (Space). Combat starts when everyone is ready.';
    ready.classList.toggle('waiting', waiting);
    $('speedBtn').textContent = `${v.speed}x`;
    $('goldVal').textContent = p.gold;
    $('hpVal').textContent = Math.max(0, p.hp);
    $('level').textContent = p.level;
    const need = p.level >= MAX_LEVEL ? 0 : XP_TO_LEVEL[p.level];
    $('xpText').textContent = need ? `${p.xp} / ${need}` : 'MAX';
    $('xpFill').style.width = need ? `${(p.xp / need) * 100}%` : '100%';
    $('unitCap').textContent = `${boardCount(p)} / ${p.level}`;
    $('xpBtn').disabled = !p.alive || p.gold < XP_COST || p.level >= MAX_LEVEL;
    $('rerollBtn').disabled = !p.alive || p.gold < REROLL_COST;
    $('lockBtn').textContent = p.locked ? '🔒' : '🔓';
    $('lockBtn').classList.toggle('on', p.locked);
    const streak = p.streak;
    $('streak').textContent = Math.abs(streak) >= 2 ? (streak > 0 ? `🔥${streak}` : `❄️${-streak}`) : '';

    this.renderShop();
    this.renderTraits();
    this.renderLobby();
    this.renderOverlay();
  }

  renderShop() {
    const v = this.v;
    const p = v.me;
    const owned = new Set(allUnits(p).map((l) => l.unit.key));
    $('shop').innerHTML = p.shop.map((key, i) => {
      if (!key) return '<div class="card empty"></div>';
      const d = UNITS[key];
      const cls = [`card`, `cost-${d.cost}`];
      if (owned.has(key)) cls.push('owned');
      if (!canBuy(p, key, this.locked)) cls.push('poor');
      return `<div class="${cls.join(' ')}" data-i="${i}">
        <div class="card-icon">${d.icon}</div>
        <div class="card-body"><div class="card-name">${d.name}</div>
        <div class="card-traits">${d.traits.map((t) => `<span>${TRAITS[t].icon} ${TRAITS[t].name}</span>`).join('')}</div></div>
        <div class="card-cost">${d.cost}g</div></div>`;
    }).join('');
  }

  renderTraits() {
    const units = boardUnits(this.v.me).map((b) => b.unit);
    const counts = countTraits(units);
    const rows = Object.keys(counts).map((k) => ({ k, c: counts[k], tier: traitTier(k, counts[k]) }));
    rows.sort((a, b) => (b.tier - a.tier) || (b.c - a.c));
    $('traits').innerHTML = rows.length ? rows.map(({ k, c, tier }) => {
      const t = TRAITS[k];
      const bps = t.breakpoints.map((b, i) => `<span class="${i === tier ? 'cur' : ''}">${b}</span>`).join(' › ');
      return `<div class="trait ${tier >= 0 ? `active t${tier}` : ''}" title="${traitDesc(k)}">
        <span class="ticon">${t.icon}</span>
        <div class="tmain"><div class="tname">${t.name}</div><div class="tbp">${bps}</div></div>
        <span class="tcount">${c}</span></div>`;
    }).join('') : '<div class="muted">Place units on the board to activate synergies.</div>';
  }

  renderLobby() {
    const v = this.v;
    const oppId = v.match && !v.match.pve && v.phase !== 'planning' ? v.match.oppId : -1;
    const showReady = this.session.multiplayer && v.phase === 'planning';
    const list = v.players.slice().sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || (a.placement - b.placement));
    $('lobby').innerHTML = list.map((p) => {
      const tag = p.isHuman && p.id !== v.pid && this.session.multiplayer ? '<span class="lp-tag">👤</span>' : '';
      const rdy = showReady && p.isHuman && p.alive ? `<span class="lp-ready ${p.ready ? 'on' : ''}">${p.ready ? '✔' : '…'}</span>` : '';
      return `
      <div class="lp ${p.id === v.pid ? 'me' : ''} ${p.alive ? '' : 'dead'} ${p.id === oppId ? 'opp' : ''}">
        <div class="lp-name">${p.alive ? '' : `#${p.placement} `}${tag}${esc(p.name)}${rdy}<span class="lp-lvl">Lv ${p.level}</span></div>
        <div class="lp-bar"><div style="width:${Math.max(0, p.hp)}%"></div></div>
        <div class="lp-hp">${Math.max(0, p.hp)}</div>
      </div>`;
    }).join('');
  }

  renderOverlay() {
    const v = this.v;
    const ov = $('overlay');
    const out = !v.me.alive && v.phase !== 'gameover';
    if (v.phase !== 'gameover' && !(out && !this.spectating)) {
      if (ov.dataset.mode === 'gameover' || ov.dataset.mode === 'out') ov.classList.add('hidden');
      return;
    }
    const mode = v.phase === 'gameover' ? 'gameover' : 'out';
    if (ov.dataset.mode === mode && !ov.classList.contains('hidden')) return;
    const place = v.me.placement || 1;
    const total = v.players.length;
    const mp = this.session.multiplayer;
    let html;
    if (mode === 'out') {
      html = `<h1>Defeated</h1>
        <p class="big">You placed <b>${ordinal(place)}</b> of ${total}</p>
        <p class="muted">The game continues for the other players.</p>
        <div class="btnstack"><button id="watchBtn" class="primary">Keep watching</button>
        ${this.session.isHost ? '' : '<button id="menuBtn">Leave game</button>'}</div>`;
    } else {
      const standings = v.players.slice().sort((a, b) => a.placement - b.placement)
        .map((p) => `<li class="${p.id === v.pid ? 'me' : ''}"><b>${ordinal(p.placement)}</b> ${esc(p.name)}</li>`).join('');
      html = `<h1>${place === 1 ? '🏆 Victory!' : 'Game over'}</h1>
        <p class="big">You placed <b>${ordinal(place)}</b> of ${total}</p>
        <p class="muted">Survived ${v.round} rounds.</p>
        ${mp ? `<ol class="standings">${standings}</ol>` : ''}
        <div class="btnstack">${mp ? '<button id="menuBtn" class="primary">Back to menu</button>' : '<button id="againBtn" class="primary">Play again</button>'}</div>`;
    }
    ov.dataset.mode = mode;
    ov.innerHTML = `<div class="panel">${html}</div>`;
    ov.classList.remove('hidden');
    const again = $('againBtn');
    if (again) again.onclick = () => this.h.playAgain();
    const menu = $('menuBtn');
    if (menu) menu.onclick = () => this.h.backToMenu();
    const watch = $('watchBtn');
    if (watch) watch.onclick = () => { this.spectating = true; ov.classList.add('hidden'); };
  }
}
