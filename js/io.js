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
  toast(txt(themeName === 'day' ? 'toast.daylight' : 'toast.dusk'), 1100);
}

addEventListener('keydown', e => {
  if (typing(e)) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys[e.key.toLowerCase()] = 1;
  // Esc closes the map if it's open, rather than stacking a pause card behind it
  if (e.key === 'Escape') state === 'map' ? closeMap() : togglePause();
  if (e.key.toLowerCase() === 'm' && (state === 'play' || state === 'map'))
    state === 'map' ? closeMap() : openMap();
  if (e.key.toLowerCase() === 'h') SFX.horn();
  if (e.key.toLowerCase() === 'n' && state === 'play') toggleTheme();
  if (e.key.toLowerCase() === 'v' && state === 'play') setMode3D(!MODE3D);
  if (state === 'play') audioStart();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = 0; });
addEventListener('blur', () => { for (const k in keys) keys[k] = 0; });

/* THE PADS ARE READ FROM THE LIVE TOUCH LIST, not latched by paired
   touchstart/touchend, because on a phone those pairs do not reliably arrive.

   iOS cancels a touch the moment it decides the finger belongs to a system
   gesture — an edge swipe, the home indicator, a notification, the address bar.
   The old handlers treated that cancel as "thumb lifted": the throttle latched
   off with the thumb still on the glass, and no further event was ever coming
   to put it back, because a cancelled touch is gone. From the driver's seat the
   car simply stops pulling and coasts down to walking pace while the pedal is
   still held. That is the reported fault, and it stays broken until you notice
   and lift your thumb.

   Rebuilding the whole state from e.touches on every touch event makes it
   self-healing instead. A dropped touchend, a doubled touchstart, a cancel that
   takes one finger of three, a thumb sliding off the brake and onto the
   accelerator: each is just a fresh reading, and the next event corrects
   whatever the last one got wrong. It cannot resurrect a finger the browser has
   taken away — nothing can — but it no longer loses the other fingers with it,
   and re-pressing always works. */
const PADS = [['tL', 'l'], ['tR', 'r'], ['tA', 'a'], ['tB', 'b'], ['tH', 'h']];
/* Measured per layout, not per touch: touchmove runs at frame rate and
   getBoundingClientRect forces a reflow. Cleared on resize, and never trusted
   while the pads are hidden — a display:none pad measures as a zero-size box at
   the origin, which would swallow every touch in the top-left corner. */
let padBoxes = null;
const measurePads = () =>
  (padBoxes = PADS.map(([id, prop]) => ({ prop, el: $(id), r: $(id).getBoundingClientRect() })));
function padAt(x, y) {
  for (const p of padBoxes || measurePads()) {
    const r = p.r;
    if (r.width < 1) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p;
  }
  return null;
}
function syncTouches(e) {
  // measured up front: an event with no touches at all — a cancel that took the
  // last finger — would otherwise never reach padAt, and the loop below would
  // run on a null cache
  const boxes = padBoxes || measurePads();
  let ours = false;
  const next = { l: 0, r: 0, a: 0, b: 0, h: 0 };
  for (const t of e.touches) {
    const p = padAt(t.clientX, t.clientY);
    if (p) { next[p.prop] = 1; ours = true; }
  }
  // the touch being lifted has already left e.touches, so check it separately or
  // the event that releases a pad wouldn't count as ours
  for (const t of e.changedTouches) if (padAt(t.clientX, t.clientY)) ours = true;
  // a non-cancelable touch is one the browser has already committed to a gesture;
  // calling preventDefault there only earns a console warning
  if (ours && e.cancelable) e.preventDefault();
  for (const p of boxes) {
    if (touch[p.prop] === next[p.prop]) continue;
    touch[p.prop] = next[p.prop];
    p.el.classList.toggle('act', !!next[p.prop]);
  }
  return ours;
}
for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
  document.addEventListener(ev, e => {
    if (syncTouches(e) && ev === 'touchstart') audioStart();
  }, { passive: false });

// mouse, for driving it on a desktop
for (const [id, prop] of PADS) {
  const el = $(id);
  el.addEventListener('mousedown', e => {
    e.preventDefault(); touch[prop] = 1; el.classList.add('act'); audioStart();
  });
}
addEventListener('mouseup', () => {
  for (const [id, prop] of PADS) { touch[prop] = 0; $(id).classList.remove('act'); }
});

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
  /* A partial override is filled in rather than passed through. `steer` goes
     straight into `c.steer += (steerIn - c.steer) * k`, so an override of
     `{ gas: 1 }` — which is the obvious thing for a test to write, and what
     several of them do — subtracts undefined and turns the steering into NaN.
     One frame later the heading, the velocity and the position are all NaN, the
     car is nowhere, and the only symptom is the engine sound throwing on a
     non-finite frequency. Cheaper to make the hook safe than to make every
     caller remember. */
  if (inputOverride)
    return { steer: 0, gas: 0, brake: 0, hand: 0, ...inputOverride };
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
  /* ONE BUS THAT EVERYTHING GOES THROUGH.

     Every sound used to connect straight to ac.destination — the engine, the
     siren, and a fresh gain node for every blip, crash and tyre squeal — so
     there was no single place to turn any of it down. A master gain in front of
     the destination costs one node for the whole session and makes the level a
     property of the graph rather than something twelve call sites have to
     remember.

     The stored level is read LAZILY rather than at load, because `store` lives
     in js/game.js and that file is evaluated after this one: touching it up here
     is a dead-zone error before the game has drawn a frame. */
  let master = null, vol = null;
  const VOL_KEY = 'vm_vol_sfx';
  function volume() {
    if (vol == null) {
      const raw = (typeof store !== 'undefined') ? store.get(VOL_KEY, null) : null;
      const n = raw == null ? NaN : parseFloat(raw);
      vol = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8;
    }
    return vol;
  }
  function setVolume(v) {
    vol = Math.max(0, Math.min(1, +v || 0));
    if (typeof store !== 'undefined') store.set(VOL_KEY, vol.toFixed(3));
    // ramped, not set: a step change in a gain is an audible click
    if (master && ac) master.gain.setTargetAtTime(vol, ac.currentTime, .02);
    return vol;
  }
  // where every source connects: the bus if there is one, the speaker if not
  const out = () => master || (ac && ac.destination);

  let gen = 0, watching = 0;

  /* iOS hands back a SUSPENDED AudioContext more often than not — opening the
     page from another app is the classic case — and it suspends again whenever
     the tab loses focus or another app takes the audio session. Resuming only at
     creation, behind an `if (started) return`, meant one bad start left the game
     silent for ever with every later tap short-circuiting past the fix. So
     resume is its own thing, and every gesture retries it. */
  function resume() {
    if (!ac) return;
    /* 'interrupted' IS A REAL STATE AND ONLY SAFARI HAS IT. A phone call, a
       timer, another app taking the audio session — the context goes to
       'interrupted' rather than 'suspended', and code that only knows the two
       standard states either ignores it or, worse, treats it as running. */
    if (ac.state !== 'running') {
      try {
        const r = ac.resume();
        if (r && r.then) r.then(watch, watch);
        else watch();
      } catch (e) { watch(); }
    } else watch();
  }

  /* AND RESUMING IS NOT THE SAME AS WORKING, which is the whole of this bug.

     Coming back from another app, Safari routinely hands back a context that
     reports `running` and is dead: every node is still connected, every gain is
     still set, currentTime does not advance and nothing reaches the speaker.
     There is nothing to resume — the context has to be thrown away and built
     again. Resuming was already here and was not enough, which is exactly what
     "sound disappears when I switch away and come back" is.

     So the clock is the test. Sample it, wait, sample it again: a context whose
     clock has stopped while the wall clock moved is not a context, it is an
     object. Half a second is long enough to be sure and short enough that the
     player reads it as the sound fading back in. */
  function watch() {
    if (!ac || watching) return;
    watching = 1;
    const t0 = ac.currentTime, mine = gen;
    setTimeout(() => {
      watching = 0;
      if (!ac || gen !== mine) return;
      if (stalled(ac.state, t0, ac.currentTime)) rebuild();
    }, 500);
  }
  /* Pure, and exported, because the alternative is a test that needs an
     operating system willing to interrupt its audio on demand. */
  function stalled(st, t0, t1) {
    return (st === 'running' || st === 'interrupted') && t1 <= t0;
  }
  function rebuild() {
    const dead = ac;
    ac = null; eng = null; engGain = null; engFilt = null;
    sirenOsc = null; sirenGain = null; master = null; started = false;
    gen++;
    try { if (dead) dead.close(); } catch (e) {}
    start();
  }

  function start() {
    if (started) { resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC(); started = true;
    master = ac.createGain();
    master.gain.value = volume();
    master.connect(ac.destination);
    /* Rebuild on the way back out of an interruption as well as on the timer:
       Safari fires this when the session is taken and again when it is handed
       back, which is earlier than any visibility event arrives. */
    try { ac.onstatechange = () => { if (ac && ac.state !== 'suspended') resume(); }; }
    catch (e) {}
    resume();
    eng = ac.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 55;
    engFilt = ac.createBiquadFilter(); engFilt.type = 'lowpass'; engFilt.frequency.value = 700;
    engGain = ac.createGain(); engGain.gain.value = 0;
    eng.connect(engFilt); engFilt.connect(engGain); engGain.connect(out());
    eng.start();

    sirenOsc = ac.createOscillator(); sirenOsc.type = 'square'; sirenOsc.frequency.value = 700;
    sirenGain = ac.createGain(); sirenGain.gain.value = 0;
    sirenOsc.connect(sirenGain); sirenGain.connect(out());
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
    o.connect(g); g.connect(out()); o.start(); o.stop(ac.currentTime + dur);
  }
  function noise(dur, vol) {
    if (!ac) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = vol || .3;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    src.connect(f); f.connect(g); g.connect(out()); src.start();
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
    src.connect(f); f.connect(g); g.connect(out()); src.start();
  }
  return {
    start, resume, engine, siren, rebuild, stalled, volume, setVolume,
    // test hook: the OS suspending us is the failure mode, so it has to be reachable
    suspend: () => ac ? ac.suspend() : Promise.resolve(),
    state: () => ({ started, gen, state: ac ? ac.state : 'none',
                    now: ac ? ac.currentTime : 0, vol: volume(),
                    bus: master ? +master.gain.value.toFixed(3) : null }),
    // v already carries the distance falloff from earshot(); under a whisper
    // there is nothing worth waking the audio graph up for
    crash: v => { if (v < .5) return; noise(.28, clamp(v / 20, .06, .45)); blip(90, .16, 'sawtooth', .06); },
    pickup: () => { blip(880, .09); setTimeout(() => blip(1320, .13), 80); },
    cash: () => { blip(660, .08); setTimeout(() => blip(990, .09), 70); setTimeout(() => blip(1480, .16), 150); },
    star: () => { blip(300, .22, 'sawtooth', .07); },
    horn: () => { blip(370, .22, 'square', .05); },
    skid: () => { screech(.85); },
    bust: () => { blip(200, .5, 'sawtooth', .08); },
    blipZone: () => { blip(520, .07, 'sine', .05); setTimeout(() => blip(780, .12, 'sine', .045), 70); },
    boom: (g = 1) => {
      if (g < .04) return;
      noise(.7, .5 * g); blip(70, .5, 'sawtooth', .1 * g);
      setTimeout(() => blip(45, .6, 'sine', .08 * g), 60);
    }
  };
})();
function audioStart() { SFX.start(); }
/* Coming back from the home screen, another app, or a phone call leaves the
   context suspended with no tap to hang a resume off. These are the events that
   actually fire on iOS when the page returns. */
for (const ev of ['visibilitychange', 'focus', 'pageshow'])
  addEventListener(ev, () => { if (!document.hidden) SFX.resume(); });
/* AND ANY TAP ANYWHERE RETRIES IT, not just the driving pads.

   iOS will only start or resume an audio context from inside a real user
   gesture, and the events above are not gestures — a resume attempted from
   visibilitychange can be refused, silently, leaving the game muted until the
   player happens to touch one of the four pads. Somebody who came back to the
   game and pressed pause, or opened the map, or did nothing at all, stayed
   silent. Passive and on the window, so it costs nothing and cannot swallow
   anything. */
for (const ev of ['pointerdown', 'touchend', 'keydown'])
  addEventListener(ev, () => {
    SFX.start();
    /* And the same gesture starts the radio if it armed itself and was refused
       — see radioArm. Guarded because js/radio.js is loaded after this one and
       because the dial is not the sound effects: a game with the radio switched
       off must not be a game with no engine note. */
    /* And the same gesture BLESSES the radio element, so the automatic start
       that happens a few seconds later — once a city has loaded and a station
       list has come back — is allowed rather than refused. See radioPrime. */
    if (typeof radioPrime === 'function') radioPrime();
    if (typeof radioGesture === 'function') radioGesture();
  }, { passive: true });

/* ------------------------------ 8. canvas ------------------------------ */
const cv = $('game'), ctx = cv.getContext('2d');
const mini = $('mini'), mctx = mini.getContext('2d');
let VW = 0, VH = 0, DPR = 1, zoomK = 1, miniRect = null;
/* WHAT THE PHONE CAN ACTUALLY SHOW.

   innerHeight is the LAYOUT viewport, and on Chrome for Android that is the tall
   one — the height the page would have if the URL bar were hidden — reported
   whether the URL bar is showing or not. Sizing the canvas from it draws a
   hundred pixels of game below the bottom of the screen, and pinning the HUD to
   it puts the thumb pads down there with it.

   visualViewport is the part you can see. It is published to CSS as --vh so the
   layers and the pads move with it too, and it is deliberately NOT applied while
   something is focused: the on-screen keyboard shrinks the visual viewport, and
   a menu that folds in half while you are typing a city name into it is a
   different bug from the one this fixes. */
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  document.documentElement.style.setProperty('--vh', vv.height + 'px');
}

/* A canvas keeps its contents when its backing store is not touched, so this is
   the difference between a repaint and a wipe. */
function setSize(el, w, h) {
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
}

function resize() {
  syncViewport();
  DPR = Math.min(devicePixelRatio || 1, 2);
  /* Measured off the canvas rather than read off the window, so CSS stays the one
     place the visible size is decided and this cannot disagree with it. Which
     means this must NOT then write an inline width and height back onto it: doing
     that overrides the stylesheet, so the next resize measures the size this one
     just set, and the canvas latches to whatever the viewport happened to be the
     first time and never follows a rotation again. Only the backing store is set
     here; the element's size is the stylesheet's business. */
  const box = cv.getBoundingClientRect();
  VW = Math.round(box.width) || innerWidth;
  VH = Math.round(box.height) || innerHeight;
  // a phone screen shows far less world at the same px/m, so pull the camera back
  zoomK = clamp(Math.min(VW, VH) / 760, .48, 1);
  /* ONLY WHEN IT HAS ACTUALLY CHANGED. Assigning canvas.width CLEARS the canvas,
     and it does so whether or not the number is different — so a resize() that
     measures the same size as last time still blanks the frame.

     That was survivable when resize() ran once per event. It stopped being
     survivable when the settle was added: four more calls after every viewport
     event, and on a phone visualViewport fires continuously while the URL bar
     slides, so the game and the radar were being wiped dozens of times over an
     animation and repainted on the following frame each time. It showed up first
     as a flaky pixel test — the radar read a colour class as absent because the
     minimap had just been cleared and not yet redrawn — which is exactly what a
     player would see as a flicker. */
  setSize(cv, Math.floor(VW * DPR), Math.floor(VH * DPR));
  // and the WebGL canvas behind it, if the 3D view has ever been switched on.
  // Guarded by typeof for the same reason `state` is below: this file loads
  // before the one that declares it.
  if (typeof resize3D === 'function') resize3D();
  const mr = mini.getBoundingClientRect();
  setSize(mini, Math.floor(mr.width * DPR), Math.floor(mr.height * DPR));
  miniRect = mr;                       // cached so the edge arrow can dodge the radar
  // the pads move with the layout, and this is also the call that runs right
  // after the touch UI is first shown — before that they measure as nothing
  padBoxes = null;
  /* The big map is drawn only when it moves, so a rotation while it is open
     would otherwise leave it stretched across the new viewport until touched.

     Guarded, because this file is loaded BEFORE game.js and `state` is a let
     declared there — so until that script has run the binding does not exist at
     all. That used to be unreachable: a window resize cannot fire before the
     page has finished parsing. Adding the visualViewport listeners made it
     reachable, because the visual viewport settles while the document is still
     loading, and on a machine slow enough to stretch the gap between two script
     tags it fires in it. It showed up as `state is not defined` from a suite run
     under load, and never once on an idle machine. */
  if (typeof state !== 'undefined' && state === 'map') { mapClamp(); drawBigMap(); }
}
/* AND AGAIN ONCE IT HAS STOPPED MOVING.

   A viewport change on a phone is an ANIMATION, and the events arrive during it,
   not after. The last one can easily carry a height that was true for a fraction
   of a second and is wrong by the time anybody looks — and since nothing fires
   afterwards, that wrong value is the one the layout keeps.

   Reported as the game filling the top two thirds of the screen with a band of
   background under it, and the numbers say exactly which animation did it: the
   phone reported a 699 px window and the layout was sitting at about 482. The
   difference is 217 px, which is an iPhone keyboard. Typing a place name into
   the menu opens it; pressing DRIVE blurs the field and it starts sliding away;
   a visualViewport resize fires while it is still half on screen, and by then
   the input is no longer focused so the guard in syncViewport lets the value
   through. The keyboard finishes closing in silence and the game stays squashed
   for the rest of the session.

   So every viewport event is followed by a few more measurements spread over the
   next second. They are idempotent and cost a getBoundingClientRect each, the
   timers are replaced rather than stacked, and after any animation the LAST word
   belongs to a measurement taken when nothing was moving. */
let settleTs = [];
function resizeSettle() {
  for (const t of settleTs) clearTimeout(t);
  settleTs = [90, 260, 550, 900].map(ms => setTimeout(resize, ms));
}
function resizeNow() { resize(); resizeSettle(); }
addEventListener('resize', resizeNow);
addEventListener('orientationchange', resizeNow);
/* The blur itself, as well. The keyboard starts closing the moment the field
   loses focus, and this is the one case where we know an animation has begun
   without being told its height. */
addEventListener('focusout', resizeSettle, true);
/* The URL bar slides away as you scroll and back as you stop, and neither fires
   a window resize on Android — the visual viewport is the only thing that
   reports it. */
if (window.visualViewport) {
  visualViewport.addEventListener('resize', resizeNow);
  visualViewport.addEventListener('scroll', resizeNow);
}

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
