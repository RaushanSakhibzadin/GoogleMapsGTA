"use strict";
/* VICE MAPS — Input, audio and the canvas. Reads the DOM, so it loads after the markup.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 6. input ------------------------------ */
const keys = {};
const touch = { l: 0, r: 0, a: 0, b: 0, h: 0 };
// While you're typing a place name the keyboard belongs to the text box — not to
// the car. Without this, space never reaches the input and "London" toggles night.
const typing = e => {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

function toggleTheme() {
  applyTheme(themeName === 'dusk' ? 'day' : 'dusk');
  $('tN').textContent = themeName === 'dusk' ? '☀' : '☾';
  toast(themeName === 'day' ? 'DAYLIGHT' : 'DUSK', 1100);
}

addEventListener('keydown', e => {
  if (typing(e)) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys[e.key.toLowerCase()] = 1;
  if (e.key === 'Escape') togglePause();
  if (e.key.toLowerCase() === 'h') SFX.horn();
  if (e.key.toLowerCase() === 'n' && state === 'play') toggleTheme();
  if (state === 'play') audioStart();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = 0; });
addEventListener('blur', () => { for (const k in keys) keys[k] = 0; });

function bindPad(el, prop) {
  const on = e => { e.preventDefault(); touch[prop] = 1; el.classList.add('act'); audioStart(); };
  const off = e => { e.preventDefault(); touch[prop] = 0; el.classList.remove('act'); };
  el.addEventListener('touchstart', on, { passive: false });
  el.addEventListener('touchend', off, { passive: false });
  el.addEventListener('touchcancel', off, { passive: false });
  el.addEventListener('mousedown', on);
  addEventListener('mouseup', off);
}
bindPad($('tL'), 'l'); bindPad($('tR'), 'r'); bindPad($('tA'), 'a'); bindPad($('tB'), 'b'); bindPad($('tH'), 'h');

// the theme button is a tap, not a hold, so it doesn't go through bindPad
let themeTap = 0;
const tapTheme = e => {
  e.preventDefault();
  const now = Date.now();
  if (now - themeTap < 400) return;    // swallow the synthetic click after a touch
  themeTap = now;
  audioStart();
  if (state === 'play') toggleTheme();
};
$('tN').addEventListener('touchstart', tapTheme, { passive: false });
$('tN').addEventListener('click', tapTheme);

/* The headless handling test drives through this rather than through synthesized
   key events: what it is measuring is how throttle, steering and the handbrake
   combine over a second or two, and that needs the inputs held exactly. */
let inputOverride = null;
function readInput() {
  if (inputOverride) return inputOverride;
  const L = keys['a'] || keys['arrowleft'] || touch.l;
  const R = keys['d'] || keys['arrowright'] || touch.r;
  const U = keys['w'] || keys['arrowup'] || touch.a;
  const D = keys['s'] || keys['arrowdown'] || touch.b;
  const H = keys[' '] || touch.h;
  return { steer: (R ? 1 : 0) - (L ? 1 : 0), gas: U ? 1 : 0, brake: D ? 1 : 0, hand: H ? 1 : 0 };
}

/* ------------------------------ 7. audio ------------------------------ */
const SFX = (() => {
  let ac = null, eng = null, engGain = null, engFilt = null, started = false;
  let sirenOsc = null, sirenGain = null, sirenT = 0;

  /* iOS hands back a SUSPENDED AudioContext more often than not — opening the
     page from another app is the classic case — and it suspends again whenever
     the tab loses focus or another app takes the audio session. Resuming only at
     creation, behind an `if (started) return`, meant one bad start left the game
     silent for ever with every later tap short-circuiting past the fix. So
     resume is its own thing, and every gesture retries it. */
  function resume() {
    if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
  }
  function start() {
    if (started) { resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC(); started = true;
    resume();
    eng = ac.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 55;
    engFilt = ac.createBiquadFilter(); engFilt.type = 'lowpass'; engFilt.frequency.value = 700;
    engGain = ac.createGain(); engGain.gain.value = 0;
    eng.connect(engFilt); engFilt.connect(engGain); engGain.connect(ac.destination);
    eng.start();

    sirenOsc = ac.createOscillator(); sirenOsc.type = 'square'; sirenOsc.frequency.value = 700;
    sirenGain = ac.createGain(); sirenGain.gain.value = 0;
    sirenOsc.connect(sirenGain); sirenGain.connect(ac.destination);
    sirenOsc.start();
  }
  function engine(rpm, load) {
    if (!ac) return;
    engGain.gain.setTargetAtTime(0.055 + load * 0.05, ac.currentTime, .08);
    eng.frequency.setTargetAtTime(48 + rpm * 150, ac.currentTime, .06);
    engFilt.frequency.setTargetAtTime(420 + rpm * 1500, ac.currentTime, .1);
  }
  function siren(active, dt) {
    if (!ac) return;
    sirenGain.gain.setTargetAtTime(active ? .035 : 0, ac.currentTime, .15);
    if (active) { sirenT += dt; sirenOsc.frequency.setTargetAtTime(sirenT % .7 < .35 ? 760 : 560, ac.currentTime, .02); }
  }
  function blip(f, dur, type, vol) {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'square'; o.frequency.value = f;
    g.gain.setValueAtTime(vol || .09, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + dur);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + dur);
  }
  function noise(dur, vol) {
    if (!ac) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = vol || .3;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start();
  }
  /* Tyre squeal: the same noise burst, but band-passed up where rubber lives and
     swept downward, which is what a scrubbing tyre sounds like as it slows. */
  function screech(dur) {
    if (!ac) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.min(1, t * 12) * (1 - t) * (1 - t);
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 5.5;
    f.frequency.setValueAtTime(1750, ac.currentTime);
    f.frequency.exponentialRampToValueAtTime(760, ac.currentTime + dur);
    const g = ac.createGain(); g.gain.value = .1;
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start();
  }
  return {
    start, resume, engine, siren,
    // test hook: the OS suspending us is the failure mode, so it has to be reachable
    suspend: () => ac ? ac.suspend() : Promise.resolve(),
    state: () => ({ started, state: ac ? ac.state : 'none', now: ac ? ac.currentTime : 0 }),
    crash: v => { noise(.28, clamp(v / 20, .06, .45)); blip(90, .16, 'sawtooth', .06); },
    pickup: () => { blip(880, .09); setTimeout(() => blip(1320, .13), 80); },
    cash: () => { blip(660, .08); setTimeout(() => blip(990, .09), 70); setTimeout(() => blip(1480, .16), 150); },
    star: () => { blip(300, .22, 'sawtooth', .07); },
    horn: () => { blip(370, .22, 'square', .05); },
    skid: () => { screech(.85); },
    bust: () => { blip(200, .5, 'sawtooth', .08); },
    blipZone: () => { blip(520, .07, 'sine', .05); setTimeout(() => blip(780, .12, 'sine', .045), 70); },
    boom: () => { noise(.7, .5); blip(70, .5, 'sawtooth', .1); setTimeout(() => blip(45, .6, 'sine', .08), 60); }
  };
})();
function audioStart() { SFX.start(); }
/* Coming back from the home screen, another app, or a phone call leaves the
   context suspended with no tap to hang a resume off. These are the events that
   actually fire on iOS when the page returns. */
for (const ev of ['visibilitychange', 'focus', 'pageshow'])
  addEventListener(ev, () => { if (!document.hidden) SFX.resume(); });

/* ------------------------------ 8. canvas ------------------------------ */
const cv = $('game'), ctx = cv.getContext('2d');
const mini = $('mini'), mctx = mini.getContext('2d');
let VW = 0, VH = 0, DPR = 1, zoomK = 1, miniRect = null;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  VW = innerWidth; VH = innerHeight;
  // a phone screen shows far less world at the same px/m, so pull the camera back
  zoomK = clamp(Math.min(VW, VH) / 760, .48, 1);
  cv.width = Math.floor(VW * DPR); cv.height = Math.floor(VH * DPR);
  cv.style.width = VW + 'px'; cv.style.height = VH + 'px';
  const mr = mini.getBoundingClientRect();
  mini.width = Math.floor(mr.width * DPR); mini.height = Math.floor(mr.height * DPR);
  miniRect = mr;                       // cached so the edge arrow can dodge the radar
}
addEventListener('resize', resize);

const cam = { x: 0, y: 0, s: 9.4, shake: 0 };

/* A glow sprite, drawn once and blitted — far cheaper than a gradient per light. */
const GLOW = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(.35, 'rgba(255,255,255,.42)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  return c;
})();
const GLOWC = new Map();
function glowFor(col) {
  let c = GLOWC.get(col);
  if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.drawImage(GLOW, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = col; g.fillRect(0, 0, 64, 64);
  GLOWC.set(col, c);
  return c;
}
