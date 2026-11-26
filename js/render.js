// Canvas renderer for the arena, bench, units and combat effects.
// The static board is pre-rendered to an offscreen layer; units, particles and
// floating text are drawn on top each frame.

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
const NUM_FONT = '"Chakra Petch", system-ui, sans-serif';
const MAX_PARTICLES = 500;

// Body tint per origin trait (a unit's first trait).
const TRAIT_COLORS = {
  ember: '#ff7a3d', tide: '#38b6ff', grove: '#4cc76a', storm: '#ffd23f', void: '#9a5cff',
  guardian: '#9fb3c8', striker: '#ff5a5a', ranger: '#8fd36b', mystic: '#d07aff', arcanist: '#5fe8ff',
};
const KIND_COLORS = { phys: '#ffb27a', magic: '#c58bff', chain: '#8fd3ff' };
const STAR_COLORS = { 1: '#c48a54', 2: '#d7e3f0', 3: '#ffd84a' };

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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Mixes a '#rrggbb' colour towards black (k < 0) or white (k > 0).
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const unitColor = (def) => (def.traits.length ? TRAIT_COLORS[def.traits[0]] : '#8a7f72');
const easeOut = (k) => 1 - (1 - k) * (1 - k);

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.effects = [];
    this.particles = [];
    this.lunges = new Map();
    this.flash = new Map();
    this.hits = new Map();
    this.byId = new Map();
    this.combat = null;
    this.flip = false; // true when the viewer is team B: mirror the arena so they sit at the bottom
    this.drag = null;
    this.pointer = null;
    this.time = 0;
    this.shake = 0;
    this.seenUnits = null; // uid -> star, to celebrate star-ups
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildBoardLayer();
  }

  // ------------------------------------------------------------ static board layer
  buildBoardLayer() {
    const layer = document.createElement('canvas');
    layer.width = W * this.dpr;
    layer.height = H * this.dpr;
    const ctx = layer.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Arena floor: a soft glow behind each half.
    const top = cellCenter(0, 0).y - R;
    const mid = (cellCenter(0, 3).y + cellCenter(0, 4).y) / 2;
    const bottom = cellCenter(0, 7).y + R;
    const glow = (y0, y1, color) => {
      const cy = (y0 + y1) / 2;
      const g = ctx.createRadialGradient(W / 2, cy, 10, W / 2, cy, 300);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y0 - 20, W, y1 - y0 + 40);
    };
    glow(top, mid, 'rgba(120,40,90,0.22)');
    glow(mid, bottom, 'rgba(40,90,170,0.24)');

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const { x, y } = cellCenter(col, row);
        const mine = row >= 4;
        // drop shadow
        hexPath(ctx, x, y + 3, R - 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        // face, lit from the top
        hexPath(ctx, x, y, R - 2);
        const g = ctx.createLinearGradient(x, y - R, x, y + R);
        if (mine) { g.addColorStop(0, '#26395a'); g.addColorStop(1, '#16213a'); } else { g.addColorStop(0, '#3a2542'); g.addColorStop(1, '#21162b'); }
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = mine ? '#3b5d8f' : '#5a3768';
        ctx.stroke();
        // inner rim highlight
        hexPath(ctx, x, y, R - 5);
        ctx.lineWidth = 1;
        ctx.strokeStyle = mine ? 'rgba(140,190,255,0.10)' : 'rgba(255,150,220,0.08)';
        ctx.stroke();
      }
    }
    // centre line
    const lg = ctx.createLinearGradient(20, 0, W - 20, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = lg;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(20, mid);
    ctx.lineTo(W - 20, mid);
    ctx.stroke();
    ctx.setLineDash([]);

    // bench tray and slots
    const b0 = benchRect(0);
    const b1 = benchRect(BENCH_SIZE - 1);
    roundRect(ctx, b0.x - 6, b0.y - 6, b1.x + b1.w - b0.x + 12, SLOT + 12, 13);
    ctx.fillStyle = 'rgba(8,12,20,0.65)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,110,160,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let i = 0; i < BENCH_SIZE; i++) {
      const b = benchRect(i);
      roundRect(ctx, b.x, b.y, b.w, b.h, 9);
      const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      g.addColorStop(0, '#111a2a');
      g.addColorStop(1, '#1a2740');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#2f4870';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    this.boardLayer = layer;
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
    this.particles = [];
    this.lunges.clear();
    this.flash.clear();
    this.hits.clear();
    this.byId = new Map(c ? c.units.map((u) => [u.id, u]) : []);
  }

  unitPos(u) {
    const a = this.cc(u.prevCol, u.prevRow);
    const b = this.cc(u.col, u.row);
    const t = u.moving ? easeOut(u.moveT) : 1;
    let x = a.x + (b.x - a.x) * t;
    let y = a.y + (b.y - a.y) * t;
    const l = this.lunges.get(u.id);
    if (l) {
      const k = Math.sin(Math.min(1, l.t / l.life) * Math.PI) * 10;
      const tg = this.byId.get(l.to);
      if (tg) {
        const p = this.cc(tg.col, tg.row);
        const d = Math.hypot(p.x - x, p.y - y) || 1;
        x += (p.x - x) / d * k;
        y += (p.y - y) / d * k;
      }
    }
    const h = this.hits.get(u.id);
    if (h) { // jolt when hit
      x += Math.sin(h.t * 90) * 2.2 * (h.t / 0.16);
      y += Math.cos(h.t * 70) * 1.2 * (h.t / 0.16);
    }
    return { x, y };
  }

  // ------------------------------------------------------------ particles
  burst(x, y, { n = 10, color = '#fff', speed = 90, life = 0.5, size = 2.5, gravity = 0, spread = Math.PI * 2, angle = 0, up = 0 } = {}) {
    for (let i = 0; i < n && this.particles.length < MAX_PARTICLES; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - up, t: 0,
        life: life * (0.6 + Math.random() * 0.6), size: size * (0.6 + Math.random() * 0.8), color, gravity,
      });
    }
  }

  addShake(s) { this.shake = Math.min(10, Math.max(this.shake, s)); }

  processEvents() {
    const c = this.combat;
    if (!c) return;
    for (const e of c.events) {
      const u = this.byId.get(e.unit);
      switch (e.type) {
        case 'attack': {
          const from = this.byId.get(e.from);
          const mine = from.side === this.mySide;
          if (e.ranged) {
            this.effects.push({ type: 'proj', from: this.unitPos(from), to: e.to, t: -e.delay, life: 0.2, trail: [],
              color: mine ? '#ffe28a' : '#ff9a8a' });
          } else {
            this.lunges.set(e.from, { to: e.to, t: 0, life: 0.2 });
            this.effects.push({ type: 'slash', unit: e.to, t: -0.08, life: 0.18, rot: Math.random() * Math.PI * 2,
              color: mine ? '#fff3c4' : '#ffc4c4' });
          }
          break;
        }
        case 'dmg': {
          const p = this.unitPos(u);
          const col = e.crit ? '#ffd84a' : KIND_COLORS[e.kind] || '#fff';
          if (e.amount >= 1) { // fully shielded hits show no number
            this.effects.push({ type: 'text', x: p.x + (Math.random() - 0.5) * 22, y: p.y - 14, text: e.crit ? `${e.amount}!` : String(e.amount),
              color: col, size: e.crit ? 19 : 13, t: 0, life: 0.75, pop: true });
          }
          this.flash.set(e.unit, 0.1);
          this.hits.set(e.unit, { t: 0.16 });
          this.burst(p.x, p.y, { n: e.crit ? 8 : 4, color: col, speed: e.crit ? 140 : 90, life: 0.3, size: 2 });
          break;
        }
        case 'heal': {
          if (e.amount < 1) break;
          const p = this.unitPos(u);
          this.effects.push({ type: 'text', x: p.x, y: p.y - 16, text: `+${e.amount}`, color: '#6dff8f', size: 14, t: 0, life: 0.85, pop: true });
          this.burst(p.x, p.y + 6, { n: 6, color: '#6dff8f', speed: 25, up: 45, life: 0.8, size: 2.5, spread: 1.2, angle: -Math.PI / 2 });
          break;
        }
        case 'cast': {
          const p = this.unitPos(u);
          const col = unitColor(u.def);
          this.effects.push({ type: 'text', x: p.x, y: p.y - 44, text: e.name, color: '#bfeaff', size: 12, t: 0, life: 1.1, bold: true });
          this.effects.push({ type: 'ring', unit: e.unit, t: 0, life: 0.45, color: col, width: 3 });
          this.burst(p.x, p.y, { n: 12, color: col, speed: 70, life: 0.55, size: 2.5, up: 20 });
          break;
        }
        case 'shield':
          this.effects.push({ type: 'bubble', unit: e.unit, t: 0, life: 0.9 });
          break;
        case 'buff': {
          const p = this.unitPos(u);
          this.effects.push({ type: 'ring', unit: e.unit, t: 0, life: 0.6, color: '#ffdd55', width: 3 });
          this.burst(p.x, p.y + 10, { n: 8, color: '#ffdd55', speed: 20, up: 60, life: 0.7, size: 2, spread: 1, angle: -Math.PI / 2 });
          break;
        }
        case 'stun': {
          const p = this.unitPos(u);
          this.burst(p.x, p.y - UNIT_R, { n: 5, color: '#ffe066', speed: 50, life: 0.4, size: 2 });
          break;
        }
        case 'aoe': {
          const p = this.cc(e.col, e.row);
          const col = KIND_COLORS[e.kind] || '#fff';
          const r = (e.radius + 0.5) * HW;
          this.effects.push({ type: 'shock', x: p.x, y: p.y, r, t: 0, life: 0.5, color: col });
          this.burst(p.x, p.y, { n: 14 + e.radius * 10, color: col, speed: r * 2.2, life: 0.55, size: 3, gravity: 120 });
          this.addShake(e.radius >= 2 ? 7 : 3);
          break;
        }
        case 'beam': {
          const a = this.byId.get(e.from);
          const col = KIND_COLORS[e.kind] || '#fff';
          this.effects.push({ type: e.kind === 'chain' ? 'bolt' : 'beam', from: this.unitPos(a), to: e.to, t: 0, life: 0.3, color: col });
          const tg = this.byId.get(e.to);
          if (tg) { const p = this.unitPos(tg); this.burst(p.x, p.y, { n: 6, color: col, speed: 110, life: 0.3, size: 2 }); }
          break;
        }
        case 'blink': {
          const a = this.cc(e.fromCol, e.fromRow);
          const b = this.cc(e.toCol, e.toRow);
          this.effects.push({ type: 'afterimage', a, b, key: u?.key, t: 0, life: 0.35 });
          this.burst(a.x, a.y, { n: 10, color: '#b98bff', speed: 80, life: 0.4, size: 2.5 });
          this.burst(b.x, b.y, { n: 10, color: '#b98bff', speed: 80, life: 0.4, size: 2.5 });
          break;
        }
        case 'death': {
          const p = this.unitPos(u);
          const col = unitColor(u.def);
          this.burst(p.x, p.y, { n: 22, color: col, speed: 130, life: 0.7, size: 3, gravity: 160 });
          this.burst(p.x, p.y, { n: 8, color: '#ffffff', speed: 60, life: 0.4, size: 2 });
          this.effects.push({ type: 'shock', x: p.x, y: p.y, r: UNIT_R * 1.8, t: 0, life: 0.35, color: col });
          this.addShake(2);
          break;
        }
        default:
          break;
      }
    }
    c.events.length = 0;
  }

  // ------------------------------------------------------------ board
  drawBoard(view) {
    const ctx = this.ctx;
    ctx.drawImage(this.boardLayer, 0, 0, W, H);
    const locked = view.phase !== 'planning';
    const dragging = !!this.drag;
    const hov = dragging && this.pointer ? this.pick(this.pointer.x, this.pointer.y) : null;
    if (dragging && !locked) {
      // Light up the drop zone, brightest on the hovered hex.
      for (let row = 4; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const { x, y } = cellCenter(col, row);
          const isHov = hov && hov.area === 'board' && hov.col === col && hov.row === row;
          hexPath(ctx, x, y, R - 3);
          ctx.fillStyle = isHov ? 'rgba(110,170,255,0.35)' : 'rgba(80,140,255,0.08)';
          ctx.fill();
          if (isHov) { ctx.strokeStyle = '#8fc0ff'; ctx.lineWidth = 2; ctx.stroke(); }
        }
      }
    }
    if (hov && hov.area === 'bench') {
      const b = benchRect(hov.i);
      roundRect(ctx, b.x, b.y, b.w, b.h, 9);
      ctx.fillStyle = 'rgba(110,170,255,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#8fc0ff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ units
  // o: { key, star, side ('A' = mine), creep, hpFrac, shieldFrac, maxHp, manaFrac, stunned, flash, alpha, bob, lift }
  drawUnit(x, y, o) {
    const ctx = this.ctx;
    const def = getDef(o.key);
    const tint = unitColor(def);
    const bob = o.bob ? Math.sin(this.time * 2.2 + o.bob) * 1.6 : 0;
    const lift = o.lift || 0;
    const cy = y + bob - lift;
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;

    // ground shadow
    ctx.beginPath();
    ctx.ellipse(x, y + UNIT_R * 0.82, UNIT_R * 0.85, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${0.38 - lift * 0.02})`;
    ctx.fill();

    // star glow
    if (o.star >= 2 && !o.creep) {
      ctx.shadowColor = o.star === 3 ? 'rgba(255,210,70,0.9)' : 'rgba(190,220,255,0.7)';
      ctx.shadowBlur = o.star === 3 ? 16 + Math.sin(this.time * 4) * 4 : 10;
    }
    // body, tinted by origin trait
    ctx.beginPath();
    ctx.arc(x, cy, UNIT_R, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(x - 7, cy - 9, 2, x, cy, UNIT_R);
    g.addColorStop(0, shade(tint, o.side === 'B' ? -0.15 : 0.05));
    g.addColorStop(0.55, shade(tint, -0.55));
    g.addColorStop(1, o.side === 'B' ? '#2a0f18' : '#0c1424');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    // cost rim
    ctx.lineWidth = 3;
    ctx.strokeStyle = o.creep ? '#6b6157' : COST_COLORS[def.cost];
    ctx.stroke();
    // enemy halo
    if (o.side === 'B') {
      ctx.beginPath();
      ctx.arc(x, cy, UNIT_R + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,90,90,0.55)';
      ctx.stroke();
    }
    // glossy highlight
    ctx.beginPath();
    ctx.ellipse(x - 5, cy - 11, 11, 6, -0.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
    // icon
    ctx.font = `24px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff'; // colour emoji inherit the fill's alpha, so it must be opaque
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillText(def.icon, x, cy + 1);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = 'transparent';
    // hit flash
    if (o.flash > 0) {
      ctx.beginPath();
      ctx.arc(x, cy, UNIT_R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.35, o.flash * 3)})`;
      ctx.fill();
    }
    // stunned: stars circling the head
    if (o.stunned) {
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = '#ffe066';
      for (let i = 0; i < 3; i++) {
        const a = this.time * 5 + (i * Math.PI * 2) / 3;
        ctx.fillText('✦', x + Math.cos(a) * 14, cy - UNIT_R - 4 + Math.sin(a) * 4);
      }
    }

    // HP / shield / mana bars
    if (o.hpFrac !== undefined) {
      const bw = 46;
      const bx = x - bw / 2;
      const by = cy - UNIT_R - 13;
      roundRect(ctx, bx - 1.5, by - 1.5, bw + 3, 12, 3);
      ctx.fillStyle = 'rgba(5,8,14,0.85)';
      ctx.fill();
      const hp = Math.max(0, Math.min(1, o.hpFrac));
      if (hp > 0) {
        const hg = ctx.createLinearGradient(0, by, 0, by + 6);
        if (o.side === 'A') { hg.addColorStop(0, '#7dffa0'); hg.addColorStop(1, '#25b552'); } else { hg.addColorStop(0, '#ff8a8a'); hg.addColorStop(1, '#d13434'); }
        ctx.fillStyle = hg;
        ctx.fillRect(bx, by, bw * hp, 6);
      }
      if (o.shieldFrac > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(bx + bw * hp, by, Math.min(bw * (1 - hp), bw * o.shieldFrac), 6);
      }
      if (o.maxHp) { // a tick every 300 HP shows how tanky a unit is at a glance
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        for (let v = 300; v < o.maxHp; v += 300) ctx.fillRect(bx + (bw * v) / o.maxHp, by, 1, 6);
      }
      if (o.manaFrac !== undefined) {
        const m = Math.min(1, o.manaFrac);
        ctx.fillStyle = m >= 1 ? '#bfeaff' : '#4fa8ff';
        ctx.fillRect(bx, by + 7.5, bw * m, 2.5);
      }
    }
    // stars
    if (o.star && !o.creep) {
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = STAR_COLORS[o.star];
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = 3;
      const s = '★'.repeat(o.star);
      ctx.strokeText(s, x, cy + UNIT_R + 4);
      ctx.fillText(s, x, cy + UNIT_R + 4);
    }
    ctx.restore();
  }

  // Sparkle burst when a 2★ or 3★ unit appears (a star-up).
  checkStarUps(p) {
    const now = new Map();
    const at = new Map();
    for (const b of boardUnits(p)) { now.set(b.unit.uid, b.unit.star); at.set(b.unit.uid, cellCenter(b.x, 4 + b.y)); }
    p.bench.forEach((u, i) => {
      if (!u) return;
      const r = benchRect(i);
      now.set(u.uid, u.star);
      at.set(u.uid, { x: r.x + r.w / 2, y: r.y + r.h / 2 - 3 });
    });
    if (this.seenUnits) {
      for (const [uid, star] of now) {
        if (star >= 2 && !this.seenUnits.has(uid)) {
          const { x, y } = at.get(uid);
          const col = star === 3 ? '#ffd84a' : '#d7e3f0';
          this.burst(x, y, { n: star === 3 ? 40 : 24, color: col, speed: 150, life: 0.9, size: 3, gravity: 60 });
          this.effects.push({ type: 'shock', x, y, r: 60, t: 0, life: 0.5, color: col });
        }
      }
    }
    this.seenUnits = now;
  }

  drawPlanningUnits(view) {
    const p = view.me;
    this.checkStarUps(p);
    const dragUid = this.drag ? this.drag.unit.uid : null;
    if (!this.combat) {
      for (const b of boardUnits(p)) {
        if (b.unit.uid === dragUid) continue;
        const c = cellCenter(b.x, 4 + b.y);
        this.drawUnit(c.x, c.y, { key: b.unit.key, star: b.unit.star, side: 'A', bob: b.unit.uid });
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
        hpFrac: u.hp / u.maxHp, shieldFrac: u.shield / u.maxHp, maxHp: u.maxHp,
        manaFrac: u.maxMana ? u.mana / u.maxMana : undefined,
        stunned: u.stun > 0, flash: f, bob: u.moving ? 0 : u.id,
      });
      if (f > 0) this.flash.set(u.id, f - dt);
    }
    for (const [id, l] of this.lunges) {
      l.t += dt;
      if (l.t >= l.life) this.lunges.delete(id);
    }
    for (const [id, h] of this.hits) {
      h.t -= dt;
      if (h.t <= 0) this.hits.delete(id);
    }
  }

  // ------------------------------------------------------------ effects
  drawParticles(dt) {
    const ctx = this.ctx;
    const keep = [];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.t += dt;
      if (p.t >= p.life) continue;
      keep.push(p);
      p.vy += p.gravity * dt;
      p.vx *= 1 - 2.5 * dt;
      p.vy *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.t / p.life;
      ctx.globalAlpha = k;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.particles = keep;
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
          e.trail.push({ x, y });
          if (e.trail.length > 6) e.trail.shift();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = e.color;
          e.trail.forEach((p, i) => {
            ctx.globalAlpha = ((i + 1) / e.trail.length) * 0.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2 + i * 0.4, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.globalAlpha = 1;
          ctx.shadowColor = e.color;
          ctx.shadowBlur = 10;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'slash': {
          const u = this.byId.get(e.unit);
          if (!u || !u.alive) break;
          const p = this.unitPos(u);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 3 * (1 - k) + 1;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(p.x, p.y, UNIT_R * 0.9, e.rot, e.rot + 1.6 * easeOut(k));
          ctx.stroke();
          break;
        }
        case 'beam': {
          const tg = this.byId.get(e.to);
          if (!tg) break;
          const to = this.unitPos(tg);
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';
          ctx.globalAlpha = 0.5 * (1 - k);
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 10 * (1 - k * 0.5);
          ctx.beginPath(); ctx.moveTo(e.from.x, e.from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(e.from.x, e.from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
          break;
        }
        case 'bolt': { // jagged lightning, re-rolled every frame
          const tg = this.byId.get(e.to);
          if (!tg) break;
          const to = this.unitPos(tg);
          const pts = [e.from];
          for (let i = 1; i < 6; i++) {
            const t = i / 6;
            pts.push({ x: e.from.x + (to.x - e.from.x) * t + (Math.random() - 0.5) * 14, y: e.from.y + (to.y - e.from.y) * t + (Math.random() - 0.5) * 14 });
          }
          pts.push(to);
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineJoin = 'round';
          for (const [w, a, col] of [[7, 0.35, e.color], [2, 1, '#ffffff']]) {
            ctx.globalAlpha = a * (1 - k);
            ctx.strokeStyle = col;
            ctx.lineWidth = w;
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.stroke();
          }
          break;
        }
        case 'afterimage':
          if (!e.key) break;
          for (let i = 0; i < 4; i++) {
            const t = i / 4;
            this.drawUnit(e.a.x + (e.b.x - e.a.x) * t, e.a.y + (e.b.y - e.a.y) * t, { key: e.key, side: 'A', alpha: (1 - k) * (0.12 + t * 0.2) });
          }
          break;
        case 'shock': {
          const r = e.r * (0.3 + 0.7 * easeOut(k));
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.25 * (1 - k);
          ctx.fillStyle = e.color;
          ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.9 * (1 - k);
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 4 * (1 - k) + 1;
          ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'ring': {
          const u = this.byId.get(e.unit);
          if (!u || !u.alive) break;
          const p = this.unitPos(u);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = e.width || 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, UNIT_R + 4 + easeOut(k) * 16, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'bubble': {
          const u = this.byId.get(e.unit);
          if (!u || !u.alive) break;
          const p = this.unitPos(u);
          const g = ctx.createRadialGradient(p.x, p.y, UNIT_R * 0.6, p.x, p.y, UNIT_R + 8);
          g.addColorStop(0, 'rgba(200,230,255,0)');
          g.addColorStop(1, `rgba(200,230,255,${0.55 * (1 - k)})`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x, p.y, UNIT_R + 8, 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'text': {
          const pop = e.pop ? 1 + 0.45 * Math.max(0, 1 - k * 7) : 1;
          ctx.globalAlpha = 1 - k * k;
          ctx.font = `700 ${Math.round(e.size * pop)}px ${NUM_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillStyle = e.color;
          ctx.strokeStyle = 'rgba(0,0,0,0.9)';
          ctx.lineWidth = 3.5;
          ctx.lineJoin = 'round';
          ctx.strokeText(e.text, e.x, e.y - easeOut(k) * 24);
          ctx.fillText(e.text, e.x, e.y - easeOut(k) * 24);
          break;
        }
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
    this.time += dt;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.002, dt);
    } else this.shake = 0;
    this.drawBoard(view);
    this.processEvents();
    this.drawCombatUnits(cdt);
    this.drawPlanningUnits(view);
    this.drawEffects(cdt);
    this.drawParticles(cdt);
    ctx.restore();

    if (view.phase === 'planning') {
      ctx.font = `700 12px ${NUM_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,200,230,0.28)';
      ctx.fillText('ENEMY SIDE', W / 2, cellCenter(0, 1).y + 4);
    }

    if (this.drag && this.pointer) {
      this.drawUnit(this.pointer.x, this.pointer.y, { key: this.drag.unit.key, star: this.drag.unit.star, side: 'A', alpha: 0.92, lift: 6 });
    }
  }
}
