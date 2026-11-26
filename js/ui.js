// DOM UI: top bar, shop, synergies, lobby, unit info, and input handling.

import { UNITS, TRAITS, COST_COLORS, XP_TO_LEVEL, MAX_LEVEL, fillTemplate, traitDesc } from './data.js';
import { countTraits, traitTier, getDef } from './combat.js';
import { sellValue, REROLL_COST, XP_COST } from './game.js';

const $ = (id) => document.getElementById(id);

function traitChips(def) {
  return def.traits.map((t) => `<span class="chip">${TRAITS[t].icon} ${TRAITS[t].name}</span>`).join('');
}

function unitInfoHTML(key, star, live) {
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
    this.h = handlers; // { newGame }
    this.game = null;
    this.hoverInfo = null;
    this.hoverLoc = null;
    this.bannerTimer = 0;
    this.bindStatic();
    this.bindCanvas();
  }

  setGame(game) {
    this.game = game;
    game.onChange = () => this.refresh();
    game.onBanner = (text, kind) => this.banner(text, kind);
    this.refresh();
  }

  bindStatic() {
    $('rerollBtn').onclick = () => this.game.reroll(this.game.human);
    $('xpBtn').onclick = () => this.game.buyXp(this.game.human);
    $('lockBtn').onclick = () => this.game.toggleLock(this.game.human);
    $('readyBtn').onclick = () => this.game.startCombat();
    $('speedBtn').onclick = () => {
      const g = this.game;
      g.speed = g.speed === 1 ? 2 : g.speed === 2 ? 4 : 1;
      $('speedBtn').textContent = `${g.speed}x`;
    };
    $('shop').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.classList.contains('empty')) return;
      this.game.buy(this.game.human, Number(card.dataset.i));
    });
    $('shop').addEventListener('mouseover', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.classList.contains('empty')) return;
      const key = this.game.human.shop[Number(card.dataset.i)];
      if (key) this.showInfo(unitInfoHTML(key, 1));
    });
    $('helpBtn').onclick = () => $('help').classList.toggle('hidden');
    $('helpClose').onclick = () => $('help').classList.add('hidden');

    window.addEventListener('keydown', (e) => {
      if (!this.game || e.target.tagName === 'INPUT') return;
      const g = this.game;
      const k = e.key.toLowerCase();
      if (k === 'd') g.reroll(g.human);
      else if (k === 'f') g.buyXp(g.human);
      else if (k === 'e' && this.hoverLoc) g.sell(g.human, this.hoverLoc);
      else if (k === ' ') { e.preventDefault(); g.startCombat(); }
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
      const g = this.game;
      if (!g || g.phase === 'gameover') return;
      const pt = this.r.toLocal(e.clientX, e.clientY);
      const loc = this.locFromPick(this.r.pick(pt.x, pt.y));
      if (!loc) return;
      if (loc.area === 'board' && g.boardLocked) return;
      const unit = g.getAt(g.human, loc);
      if (!unit) return;
      if (e.button === 2) { g.sell(g.human, loc); return; }
      cv.setPointerCapture(e.pointerId);
      this.r.drag = { from: loc, unit };
      this.r.pointer = pt;
      document.body.classList.add('dragging');
      $('sellZone').textContent = `Sell for ${sellValue(unit)} gold`;
    });
    cv.addEventListener('pointermove', (e) => {
      const g = this.game;
      if (!g) return;
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
      const g = this.game;
      const drag = this.r.drag;
      if (!drag) return;
      this.r.drag = null;
      document.body.classList.remove('dragging');
      $('sellZone').classList.remove('hot');
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (over && over.closest('#shopbar')) { g.sell(g.human, drag.from); return; }
      const pt = this.r.toLocal(e.clientX, e.clientY);
      const to = this.locFromPick(this.r.pick(pt.x, pt.y));
      if (to) g.moveUnit(g.human, drag.from, to);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => { this.r.drag = null; document.body.classList.remove('dragging'); });
  }

  updateHover(pt) {
    const g = this.game;
    const pk = this.r.pick(pt.x, pt.y);
    this.hoverLoc = null;
    if (!pk) return;
    if (g.combat && pk.area === 'board') {
      const u = g.combat.units.find((x) => x.alive && x.col === pk.col && x.row === pk.row);
      if (u) this.showInfo(unitInfoHTML(u.key, u.star, u), u);
      return;
    }
    const loc = this.locFromPick(pk);
    if (!loc) return;
    const u = g.getAt(g.human, loc);
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
    const g = this.game;
    if (!g) return;
    const t = $('timer');
    if (g.phase === 'planning') t.textContent = `${Math.max(0, Math.ceil(g.timer))}s`;
    else if (g.phase === 'combat') t.textContent = g.combat ? `${Math.floor(g.combat.time)}s` : '';
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
    const g = this.game;
    if (!g) return;
    const p = g.human;
    const phaseNames = { planning: 'Planning', combat: 'Combat', results: 'Results', gameover: 'Game Over' };
    $('round').textContent = g.round;
    $('phase').textContent = phaseNames[g.phase];
    let opp = '';
    if (g.phase !== 'planning' && g.humanMatch) {
      opp = g.humanMatch.pve ? 'vs Monsters' : `vs ${g.humanMatch.b.name}${g.humanMatch.ghost ? ' (ghost)' : ''}`;
    }
    $('opponent').textContent = opp;
    $('readyBtn').disabled = g.phase !== 'planning';
    $('goldVal').textContent = p.gold;
    $('hpVal').textContent = Math.max(0, p.hp);
    $('level').textContent = p.level;
    const need = p.level >= MAX_LEVEL ? 0 : XP_TO_LEVEL[p.level];
    $('xpText').textContent = need ? `${p.xp} / ${need}` : 'MAX';
    $('xpFill').style.width = need ? `${(p.xp / need) * 100}%` : '100%';
    $('unitCap').textContent = `${g.boardCount(p)} / ${p.level}`;
    $('xpBtn').disabled = p.gold < XP_COST || p.level >= MAX_LEVEL;
    $('rerollBtn').disabled = p.gold < REROLL_COST;
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
    const g = this.game;
    const p = g.human;
    const owned = new Set(g.allUnits(p).map((l) => l.unit.key));
    $('shop').innerHTML = p.shop.map((key, i) => {
      if (!key) return '<div class="card empty"></div>';
      const d = UNITS[key];
      const cls = [`card`, `cost-${d.cost}`];
      if (owned.has(key)) cls.push('owned');
      if (!g.canBuy(p, key)) cls.push('poor');
      return `<div class="${cls.join(' ')}" data-i="${i}">
        <div class="card-icon">${d.icon}</div>
        <div class="card-body"><div class="card-name">${d.name}</div>
        <div class="card-traits">${d.traits.map((t) => `<span>${TRAITS[t].icon} ${TRAITS[t].name}</span>`).join('')}</div></div>
        <div class="card-cost">${d.cost}g</div></div>`;
    }).join('');
  }

  renderTraits() {
    const g = this.game;
    const units = g.boardUnits(g.human).map((b) => b.unit);
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
    const g = this.game;
    const oppId = g.humanMatch && !g.humanMatch.pve && g.phase !== 'planning' ? g.humanMatch.b.id : -1;
    const list = g.players.slice().sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || (a.placement - b.placement));
    $('lobby').innerHTML = list.map((p) => `
      <div class="lp ${p.isHuman ? 'me' : ''} ${p.alive ? '' : 'dead'} ${p.id === oppId ? 'opp' : ''}">
        <div class="lp-name">${p.alive ? '' : `#${p.placement} `}${p.name}<span class="lp-lvl">Lv ${p.level}</span></div>
        <div class="lp-bar"><div style="width:${Math.max(0, p.hp)}%"></div></div>
        <div class="lp-hp">${Math.max(0, p.hp)}</div>
      </div>`).join('');
  }

  renderOverlay() {
    const g = this.game;
    const ov = $('overlay');
    if (g.phase !== 'gameover') {
      if (ov.dataset.mode === 'gameover') ov.classList.add('hidden');
      return;
    }
    const place = g.human.alive ? 1 : g.human.placement;
    const suffix = place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th';
    ov.dataset.mode = 'gameover';
    ov.innerHTML = `<div class="panel">
      <h1>${place === 1 ? '🏆 Victory!' : 'Defeated'}</h1>
      <p class="big">You placed <b>${place}${suffix}</b> of 8</p>
      <p class="muted">Survived ${g.round} rounds.</p>
      <button id="againBtn" class="primary">Play again</button></div>`;
    ov.classList.remove('hidden');
    $('againBtn').onclick = () => this.h.newGame();
  }
}
