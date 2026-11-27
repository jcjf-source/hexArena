// Procedural sound effects via Web Audio. No asset files: every sound is built
// from oscillators and a shared noise buffer, so there's nothing to download.

const MUTE_KEY = 'hexArena.muted';
const VOLUME = 0.5;

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage unavailable */ }

// Browsers only allow audio after a user gesture, so create/resume the context then.
function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    const comp = ctx.createDynamicsCompressor(); // keeps busy fights from clipping
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* storage unavailable */ }
  if (master) master.gain.setTargetAtTime(m ? 0 : VOLUME, ctx.currentTime, 0.02);
}

// ---------------------------------------------------------------- primitives
function env(g, t, vol, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

// A pitched blip; `to` slides the pitch over the note.
function tone({ freq, to = freq, type = 'sine', vol = 0.3, attack = 0.005, decay = 0.15, at = 0, detune = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(freq, t);
  if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  env(g, t, vol, attack, decay);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

// Filtered noise burst: hits, whooshes, explosions.
function noise({ freq = 1000, to = freq, q = 1, filter = 'bandpass', vol = 0.3, attack = 0.003, decay = 0.12, at = 0 }) {
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to !== freq) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = ctx.createGain();
  env(g, t, vol, attack, decay);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5);
  s.stop(t + attack + decay + 0.05);
}

const arp = (notes, step, o) => notes.forEach((f, i) => tone({ ...o, freq: f, at: (o.at || 0) + i * step }));
const jitter = (f, amt = 0.08) => f * (1 + (Math.random() - 0.5) * amt);

// ---------------------------------------------------------------- sounds
const SOUNDS = {
  click: () => tone({ freq: 900, to: 700, type: 'triangle', vol: 0.12, decay: 0.05 }),
  place: () => { tone({ freq: 220, to: 160, type: 'sine', vol: 0.25, decay: 0.08 }); noise({ freq: 1800, vol: 0.08, decay: 0.04 }); },
  buy: () => { arp([880, 1320], 0.05, { type: 'square', vol: 0.07, decay: 0.09 }); tone({ freq: 2640, type: 'sine', vol: 0.06, decay: 0.2, at: 0.08 }); },
  sell: () => { arp([1320, 990, 1320], 0.045, { type: 'triangle', vol: 0.14, decay: 0.08 }); noise({ freq: 6000, filter: 'highpass', vol: 0.05, decay: 0.12 }); },
  reroll: () => { noise({ freq: 600, to: 3500, q: 2, vol: 0.18, attack: 0.02, decay: 0.16 }); tone({ freq: 500, to: 900, type: 'triangle', vol: 0.06, decay: 0.12 }); },
  xp: () => tone({ freq: 520, to: 1040, type: 'triangle', vol: 0.15, attack: 0.01, decay: 0.18 }),
  levelup: () => arp([523, 659, 784, 1047], 0.07, { type: 'triangle', vol: 0.16, decay: 0.25 }),
  star: () => {
    arp([784, 988, 1175, 1568], 0.06, { type: 'square', vol: 0.06, decay: 0.3 });
    arp([1568, 1976, 2349], 0.08, { type: 'sine', vol: 0.08, decay: 0.4, at: 0.25 });
  },
  augment: () => { arp([392, 523, 659, 784], 0.09, { type: 'sawtooth', vol: 0.05, decay: 0.45 }); tone({ freq: 1568, type: 'sine', vol: 0.08, decay: 0.8, at: 0.36 }); },
  fight: () => {
    tone({ freq: 196, type: 'sawtooth', vol: 0.09, attack: 0.03, decay: 0.35 });
    tone({ freq: 294, type: 'sawtooth', vol: 0.07, attack: 0.03, decay: 0.45, at: 0.12 });
    noise({ freq: 120, filter: 'lowpass', vol: 0.4, decay: 0.3 });
  },
  win: () => { arp([523, 659, 784], 0.1, { type: 'triangle', vol: 0.15, decay: 0.3 }); tone({ freq: 1047, type: 'triangle', vol: 0.17, decay: 0.7, at: 0.3 }); },
  loss: () => { arp([392, 330, 262], 0.14, { type: 'triangle', vol: 0.14, decay: 0.35 }); tone({ freq: 196, type: 'sine', vol: 0.15, decay: 0.8, at: 0.42 }); },
  tick: () => tone({ freq: 1500, type: 'square', vol: 0.04, decay: 0.03 }),
  gameover: () => arp([262, 330, 392, 523, 659], 0.12, { type: 'triangle', vol: 0.14, decay: 0.6 }),

  // combat
  swing: () => noise({ freq: jitter(1400), to: 500, q: 1.5, vol: 0.07, attack: 0.01, decay: 0.07 }),
  shoot: () => tone({ freq: jitter(1200), to: 500, type: 'triangle', vol: 0.05, decay: 0.07 }),
  hit: () => { noise({ freq: jitter(900, 0.3), vol: 0.12, decay: 0.06 }); tone({ freq: jitter(140), to: 70, vol: 0.12, decay: 0.07 }); },
  crit: () => { noise({ freq: 2500, vol: 0.18, decay: 0.09 }); tone({ freq: 180, to: 60, type: 'square', vol: 0.08, decay: 0.12 }); },
  magic: () => tone({ freq: jitter(700, 0.2), to: 1400, type: 'sine', vol: 0.08, decay: 0.1 }),
  cast: () => { tone({ freq: jitter(440, 0.15), to: 1320, type: 'sawtooth', vol: 0.05, attack: 0.02, decay: 0.25 }); tone({ freq: 880, to: 1760, type: 'sine', vol: 0.06, attack: 0.02, decay: 0.3 }); },
  heal: () => arp([660, 880], 0.06, { type: 'sine', vol: 0.06, decay: 0.2 }),
  shield: () => tone({ freq: 300, to: 600, type: 'triangle', vol: 0.1, attack: 0.03, decay: 0.3, detune: 7 }),
  buff: () => arp([523, 784], 0.05, { type: 'triangle', vol: 0.07, decay: 0.18 }),
  stun: () => arp([1800, 1500, 1800], 0.04, { type: 'square', vol: 0.03, decay: 0.05 }),
  beam: () => tone({ freq: jitter(1000), to: 300, type: 'sawtooth', vol: 0.05, decay: 0.18 }),
  bolt: () => { noise({ freq: 3000, q: 0.7, vol: 0.14, decay: 0.12 }); tone({ freq: 90, type: 'square', vol: 0.05, decay: 0.1 }); },
  boom: (big) => {
    noise({ freq: big ? 900 : 1500, to: 80, filter: 'lowpass', vol: big ? 0.5 : 0.3, decay: big ? 0.6 : 0.35 });
    tone({ freq: big ? 90 : 120, to: 35, vol: big ? 0.35 : 0.2, decay: big ? 0.5 : 0.3 });
  },
  blink: () => tone({ freq: 300, to: 2000, type: 'sine', vol: 0.08, attack: 0.01, decay: 0.12 }),
  death: () => { noise({ freq: 700, to: 120, filter: 'lowpass', vol: 0.25, decay: 0.3 }); tone({ freq: jitter(260), to: 60, type: 'triangle', vol: 0.15, decay: 0.35 }); },
};

// Minimum seconds between repeats, so a 4x-speed brawl doesn't turn into static.
const GAP = { swing: 0.05, shoot: 0.05, hit: 0.045, magic: 0.06, crit: 0.06, heal: 0.12, beam: 0.06, bolt: 0.08, stun: 0.1, tick: 0.5 };
const lastPlayed = {};

export function play(name, arg) {
  if (muted || !ctx || ctx.state !== 'running') return;
  const fn = SOUNDS[name];
  if (!fn) return;
  const now = ctx.currentTime;
  if (now - (lastPlayed[name] ?? -1) < (GAP[name] ?? 0.03)) return;
  lastPlayed[name] = now;
  fn(arg);
}

// Map a combat event (see combat.js emit) to a sound.
export function combatSound(e) {
  switch (e.type) {
    case 'attack': play(e.ranged ? 'shoot' : 'swing'); break;
    case 'dmg': if (e.amount >= 1) play(e.crit ? 'crit' : e.kind === 'phys' ? 'hit' : 'magic'); break;
    case 'heal': if (e.amount >= 1) play('heal'); break;
    case 'cast': play('cast'); break;
    case 'shield': play('shield'); break;
    case 'buff': play('buff'); break;
    case 'stun': play('stun'); break;
    case 'beam': play(e.kind === 'chain' ? 'bolt' : 'beam'); break;
    case 'aoe': play('boom', e.radius >= 2); break;
    case 'blink': play('blink'); break;
    case 'death': play('death'); break;
    default: break;
  }
}
