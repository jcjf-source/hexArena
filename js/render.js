// Canvas renderer for the arena, bench, units and combat effects.

import { COLS, ROWS } from './hex.js';
import { COST_COLORS } from './data.js';
import { getDef } from './combat.js';
import { BENCH_SIZE, boardUnits } from './game.js';

const SQ3 = Math.sqrt(3);
export const R = 36;
const HW = R * SQ3;
export const W = 600;
export const H = 580;
const BOARD_LEFT = (W - 7.5 * HW) / 2 + HW / 2;
const BOARD_TOP = 20 + R;
const BENCH_Y = 528;
const SLOT = 58;
const SLOT_GAP = 4;
const BENCH_LEFT = (W - (BENCH_SIZE * SLOT + (BENCH_SIZE - 1) * SLOT_GAP)) / 2;
const UNIT_R = 23;
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';

export function cellCenter(col, row) {
  return { x: BOARD_LEFT + HW * (col + 0.5 * (row & 1)), y: BOARD_TOP + 1.5 * R * row };
}

export function benchRect(i) {
  return { x: BENCH_LEFT + i * (SLOT + SLOT_GAP), y: BENCH_Y - SLOT / 2, w: SLOT, h: SLOT };
}

function hexPath(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

const KIND_COLORS = { phys: '#ffb27a', magic: '#c58bff', chain: '#8fd3ff' };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.effects = [];
    this.lunges = new Map();
    this.flash = new Map();
    this.byId = new Map();
    this.combat = null;
    this.flip = false; // true when the viewer is team B: mirror the arena so they sit at the bottom
    this.drag = null; // { from, unit, x, y }
    this.pointer = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toLocal(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left) * W / r.width, y: (clientY - r.top) * H / r.height };
  }

  // Returns { area:'board', col, row } or { area:'bench', i } or null.
  pick(x, y) {
    for (let i = 0; i < BENCH_SIZE; i++) {
      const b = benchRect(i);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { area: 'bench', i };
    }
    let best = null;
    let bd = R * 0.95;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const c = cellCenter(col, row);
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bd) { bd = d; best = { area: 'board', col, row }; }
      }
    }
    return best;
  }

  // Combat cell -> screen position, mirrored for team B viewers.
  cc(col, row) {
    return this.flip ? cellCenter(COLS - 1 - col, ROWS - 1 - row) : cellCenter(col, row);
  }

  // Screen cell -> combat cell (the mirror is its own inverse).
  toSim(col, row) {
    return this.flip ? { col: COLS - 1 - col, row: ROWS - 1 - row } : { col, row };
  }

  get mySide() { return this.flip ? 'B' : 'A'; }

  setCombat(c, flip = false) {
    this.combat = c;
    this.flip = flip;
    this.effects = [];
    this.lunges.clear();
    this.flash.clear();
    this.byId = new Map(c ? c.units.map((u) => [u.id, u]) : []);
  }

  unitPos(u) {
    const a = this.cc(u.prevCol, u.prevRow);
    const b = this.cc(u.col, u.row);
    const t = u.moving ? u.moveT : 1;
    let x = a.x + (b.x - a.x) * t;
    let y = a.y + (b.y - a.y) * t;
    const l = this.lunges.get(u.id);
    if (l) {
      const k = Math.sin(Math.min(1, l.t / l.life) * Math.PI) * 9;
      const tg = this.byId.get(l.to);
      if (tg) {
        const p = this.cc(tg.col, tg.row);
        const d = Math.hypot(p.x - x, p.y - y) || 1;
        x += (p.x - x) / d * k;
        y += (p.y - y) / d * k;
      }
    }
    return { x, y };
  }

  processEvents() {
    const c = this.combat;
    if (!c) return;
    for (const e of c.events) {
      const u = this.byId.get(e.unit);
      switch (e.type) {
        case 'attack': {
          const from = this.byId.get(e.from);
          if (e.ranged) this.effects.push({ type: 'proj', from: this.unitPos(from), to: e.to, t: -e.delay, life: 0.18, color: from.side === this.mySide ? '#ffe28a' : '#ff9a8a' });
          else this.lunges.set(e.from, { to: e.to, t: 0, life: 0.18 });
          break;
        }
        case 'dmg': {
          const p = this.unitPos(u);
          this.effects.push({ type: 'text', x: p.x + (Math.random() - 0.5) * 18, y: p.y - 10, text: String(e.amount),
            color: e.crit ? '#ffd84a' : KIND_COLORS[e.kind] || '#fff', size: e.crit ? 17 : 13, t: 0, life: 0.7 });
          this.flash.set(e.unit, 0.12);
          break;
        }
        case 'heal': {
          if (e.amount < 1) break;
          const p = this.unitPos(u);
          this.effects.push({ type: 'text', x: p.x, y: p.y - 14, text: `+${e.amount}`, color: '#6dff8f', size: 14, t: 0, life: 0.8 });
          break;
        }
        case 'cast': {
          const p = this.unitPos(u);
          this.effects.push({ type: 'text', x: p.x, y: p.y - 40, text: e.name, color: '#9fe3ff', size: 12, t: 0, life: 1.1, bold: true });
          this.effects.push({ type: 'ring', unit: e.unit, t: 0, life: 0.4, color: '#7fd7ff' });
          break;
        }
        case 'shield':
          this.effects.push({ type: 'ring', unit: e.unit, t: 0, life: 0.6, color: '#ffffff' });
          break;
        case 'buff':
          this.effects.push({ type: 'ring', unit: e.unit, t: 0, life: 0.6, color: '#ffdd55' });
          break;
        case 'stun':
          break;
        case 'aoe': {
          const p = this.cc(e.col, e.row);
          this.effects.push({ type: 'aoe', x: p.x, y: p.y, r: (e.radius + 0.5) * HW, t: 0, life: 0.45, color: KIND_COLORS[e.kind] || '#fff' });
          break;
        }
        case 'beam': {
          const a = this.byId.get(e.from);
          this.effects.push({ type: 'beam', from: this.unitPos(a), to: e.to, t: 0, life: 0.28, color: KIND_COLORS[e.kind] || '#fff' });
          break;
        }
        case 'blink': {
          const a = this.cc(e.fromCol, e.fromRow);
          const b = this.cc(e.toCol, e.toRow);
          this.effects.push({ type: 'line', a, b, t: 0, life: 0.3, color: '#b98bff' });
          break;
        }
        case 'death': {
          const p = this.unitPos(u);
          this.effects.push({ type: 'puff', x: p.x, y: p.y, t: 0, life: 0.5 });
          break;
        }
        default:
          break;
      }
    }
    c.events.length = 0;
  }

  drawBoard(view) {
    const ctx = this.ctx;
    const locked = view.phase !== 'planning';
    const dragging = !!this.drag;
    const hov = dragging && this.pointer ? this.pick(this.pointer.x, this.pointer.y) : null;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const { x, y } = cellCenter(col, row);
        const mine = row >= 4;
        hexPath(ctx, x, y, R - 2);
        ctx.fillStyle = mine ? '#1d2a40' : '#2b1f33';
        if (dragging && mine && !locked) ctx.fillStyle = '#23365a';
        if (hov && hov.area === 'board' && hov.col === col && hov.row === row && mine && !locked) ctx.fillStyle = '#35548a';
        ctx.fill();
        ctx.strokeStyle = mine ? '#34507a' : '#4a3157';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    const midY = (cellCenter(0, 3).y + cellCenter(0, 4).y) / 2;
    ctx.moveTo(20, midY);
    ctx.lineTo(W - 20, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // bench
    for (let i = 0; i < BENCH_SIZE; i++) {
      const b = benchRect(i);
      ctx.fillStyle = hov && hov.area === 'bench' && hov.i === i ? '#35548a' : '#182233';
      ctx.strokeStyle = '#34507a';
      ctx.lineWidth = 1.5;
      roundRect(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawUnit(x, y, o) {
    const ctx = this.ctx;
    const def = getDef(o.key);
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    // body
    ctx.beginPath();
    ctx.arc(x, y, UNIT_R, 0, Math.PI * 2);
    ctx.fillStyle = o.flash ? '#5a2a2a' : o.side === 'B' ? '#2a1820' : '#141c2a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COST_COLORS[def.cost];
    ctx.stroke();
    ctx.font = `24px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, x, y + 1);

    if (o.stunned) {
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#ffe066';
      ctx.fillText('✦ ✦', x, y - UNIT_R - 2);
    }

    // bars
    if (o.hpFrac !== undefined) {
      const bw = 44;
      const bx = x - bw / 2;
      const by = y - UNIT_R - 12;
      ctx.fillStyle = '#000a';
      ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
      ctx.fillStyle = o.side === 'A' ? '#4fdc6a' : '#ff5a5a';
      ctx.fillRect(bx, by, bw * Math.max(0, o.hpFrac), 5);
      if (o.shieldFrac > 0) {
        ctx.fillStyle = '#ffffffcc';
        ctx.fillRect(bx + bw * Math.max(0, o.hpFrac), by, Math.min(bw * (1 - o.hpFrac), bw * o.shieldFrac), 5);
      }
      if (o.manaFrac !== undefined) {
        ctx.fillStyle = '#000a';
        ctx.fillRect(bx - 1, by + 6, bw + 2, 4);
        ctx.fillStyle = '#4fa8ff';
        ctx.fillRect(bx, by + 6, bw * Math.min(1, o.manaFrac), 3);
      }
    }
    // stars
    if (o.star && !o.creep) {
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = o.star === 3 ? '#ffd84a' : o.star === 2 ? '#d7e3f0' : '#c48a54';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      const s = '★'.repeat(o.star);
      ctx.strokeText(s, x, y + UNIT_R + 4);
      ctx.fillText(s, x, y + UNIT_R + 4);
    }
    ctx.restore();
  }

  drawPlanningUnits(view) {
    const p = view.me;
    const dragUid = this.drag ? this.drag.unit.uid : null;
    if (!this.combat) {
      for (const b of boardUnits(p)) {
        if (b.unit.uid === dragUid) continue;
        const c = cellCenter(b.x, 4 + b.y);
        this.drawUnit(c.x, c.y, { key: b.unit.key, star: b.unit.star, side: 'A' });
      }
    }
    p.bench.forEach((u, i) => {
      if (!u || u.uid === dragUid) return;
      const r = benchRect(i);
      this.drawUnit(r.x + r.w / 2, r.y + r.h / 2 - 3, { key: u.key, star: u.star, side: 'A' });
    });
  }

  drawCombatUnits(dt) {
    const c = this.combat;
    if (!c) return;
    const list = c.units.filter((u) => u.alive).map((u) => ({ u, p: this.unitPos(u) }));
    list.sort((a, b) => a.p.y - b.p.y);
    for (const { u, p } of list) {
      const f = this.flash.get(u.id) || 0;
      this.drawUnit(p.x, p.y, {
        key: u.key, star: u.star, side: u.side === this.mySide ? 'A' : 'B', creep: !u.def.traits.length,
        hpFrac: u.hp / u.maxHp, shieldFrac: u.shield / u.maxHp,
        manaFrac: u.maxMana ? u.mana / u.maxMana : undefined,
        stunned: u.stun > 0, flash: f > 0,
      });
      if (f > 0) this.flash.set(u.id, f - dt);
    }
    for (const [id, l] of this.lunges) {
      l.t += dt;
      if (l.t >= l.life) this.lunges.delete(id);
    }
  }

  drawEffects(dt) {
    const ctx = this.ctx;
    const keep = [];
    for (const e of this.effects) {
      e.t += dt;
      if (e.t >= e.life) continue;
      keep.push(e);
      if (e.t < 0) continue;
      const k = e.t / e.life;
      ctx.save();
      switch (e.type) {
        case 'proj': {
          const tg = this.byId.get(e.to);
          if (!tg) break;
          const to = this.unitPos(tg);
          const x = e.from.x + (to.x - e.from.x) * k;
          const y = e.from.y + (to.y - e.from.y) * k;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'beam': {
          const tg = this.byId.get(e.to);
          if (!tg) break;
          const to = this.unitPos(tg);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(e.from.x, e.from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          break;
        }
        case 'line':
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(e.a.x, e.a.y);
          ctx.lineTo(e.b.x, e.b.y);
          ctx.stroke();
          break;
        case 'aoe':
          ctx.globalAlpha = 0.55 * (1 - k);
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.5 + 0.5 * k), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'ring': {
          const u = this.byId.get(e.unit);
          if (!u || !u.alive) break;
          const p = this.unitPos(u);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, UNIT_R + 4 + k * 14, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'puff':
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = '#ccc';
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(e.x + Math.cos(a) * k * 26, e.y + Math.sin(a) * k * 26, 5 * (1 - k) + 1, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        case 'text':
          ctx.globalAlpha = 1 - k * k;
          ctx.font = `${e.bold ? 'bold ' : ''}${e.size}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = e.color;
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 3;
          ctx.strokeText(e.text, e.x, e.y - k * 22);
          ctx.fillText(e.text, e.x, e.y - k * 22);
          break;
        default:
          break;
      }
      ctx.restore();
    }
    this.effects = keep;
  }

  // view: the player's snapshot. replay: { combat, flip } for the fight being watched, or null.
  draw(view, replay, dt) {
    const ctx = this.ctx;
    const c = replay ? replay.combat : null;
    if (c !== this.combat) this.setCombat(c, replay ? replay.flip : false);
    const cdt = this.combat && !this.combat.over ? dt * view.speed : dt;
    ctx.clearRect(0, 0, W, H);
    this.drawBoard(view);
    this.processEvents();
    this.drawCombatUnits(cdt);
    this.drawPlanningUnits(view);
    this.drawEffects(cdt);

    if (view.phase === 'planning') {
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText('ENEMY SIDE', W / 2, cellCenter(0, 1).y + 4);
    }

    if (this.drag && this.pointer) {
      this.drawUnit(this.pointer.x, this.pointer.y, { key: this.drag.unit.key, star: this.drag.unit.star, side: 'A', alpha: 0.85 });
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
