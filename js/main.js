"use strict";
/* VICE MAPS — The loop, the menus, and the debug hooks the headless tests drive.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 14. loop ------------------------------ */
function loop(t) {
  requestAnimationFrame(loop);
  if (state !== 'play') { lastT = t; return; }
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (dt > .25) dt = .25;              // tabbed away — don't explode
  // fixed-ish stepping keeps the physics stable on slow frames
  acc += dt;
  const step = 1 / 60;
  let guard = 0;
  const tU = performance.now();
  let steps = 0;
  while (acc >= step && guard++ < 5) { update(step); acc -= step; steps++; SIMT += step; }
  const tR = performance.now();
  render();
  // rolling averages, so a slow frame can be attributed rather than guessed at
  PERF.upd += (tR - tU - PERF.upd) * .1;
  PERF.ren += (performance.now() - tR - PERF.ren) * .1;
  PERF.steps += (steps - PERF.steps) * .1;
}
const PERF = { upd: 0, ren: 0, steps: 0 };
/* HOW MUCH TIME THE PHYSICS HAS ACTUALLY BEEN GIVEN, which is not how much has
   passed. The guard above caps the catch-up at five steps a frame — right, and
   the reason a slow frame cannot spiral — but it means that below 12 fps the
   world runs slower than the clock on the wall. The chase view in headless
   Chromium is rasterised by SwiftShader at about 8 fps, so a test that measures
   "one second" of coasting there gets about two thirds of one, and every figure
   derived from it comes out short by the same third. Exposed so a test can ask
   for a simulated second and get one. */
let SIMT = 0;

/* ------------------------------ 15. menus ------------------------------ */
function togglePause() {
  if (state === 'play') {
    state = 'pause'; $('pause').classList.remove('hide');
    $('pauseStats').innerHTML =
      `${W.name}<br>Deliveries: <b>${MISSION.done}</b> · Bank: <b>$${P.cash.toLocaleString()}</b>` +
      // still answering "why am I here?" ten minutes after the toast has gone
      (FELLBACK ? `<div class="whyHere">Couldn’t load <b>${esc(FELLBACK.asked)}</b> — ` +
                  `${esc(FELLBACK.why)}. This is the offline city.</div>` : '');
    SFX.engine(0, 0); SFX.siren(false, 0);
  } else if (state === 'pause') {
    state = 'play'; $('pause').classList.add('hide'); lastT = performance.now();
  }
}
/* Straight through to saveLog with nothing awaited in between: iOS only opens
   the share sheet from inside a real tap, and an await before share() loses the
   gesture and silently does nothing. */
/* ---- the big map: tap the radar, the game stops, the city opens ---- */
/* Its own state rather than reusing 'pause'. The loop only steps the world while
   state is 'play', so this pauses by existing — and keeping it distinct means
   Esc closes the map instead of stacking the pause card underneath it. */
function openMap() {
  if (state !== 'play') return;
  state = 'map';
  SFX.engine(0, 0); SFX.siren(false, 0);      // no engine note over a paused game
  $('mapWhere').textContent = (NAV.street || W.name || '') +
    (NAV.zone ? ' · ' + NAV.zone : '');
  $('bigmap').classList.remove('hide');
  mapFit(true);                               // keep the zoom, re-centre on the car
  drawBigMap();
}
function closeMap() {
  if (state !== 'map') return;
  $('bigmap').classList.add('hide');
  state = 'play';
  lastT = performance.now(); acc = 0;         // don't hand the physics the pause
}
$('mini').onclick = openMap;
$('mapClose').onclick = closeMap;

/* Pan and pinch. Pointer events cover mouse, pen and touch in one path, and the
   pointers are tracked in a map so a second finger arriving mid-drag becomes a
   pinch rather than a jump. */
(function mapGestures() {
  const cv = $('bigmapC');
  const live = new Map();
  let pinch0 = 0, scale0 = 0;
  const mid = () => {
    let sx = 0, sy = 0;
    for (const q of live.values()) { sx += q.x; sy += q.y; }
    return { x: sx / live.size, y: sy / live.size };
  };
  const spread = () => {
    const [a, b] = [...live.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (live.size === 2) { pinch0 = spread(); scale0 = MAPV.s; }
  });
  cv.addEventListener('pointermove', e => {
    if (!live.has(e.pointerId)) return;
    const prev = mid();
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = mid();
    // dragging moves the world under the finger, so the pixel delta is negated
    MAPV.cx -= (now.x - prev.x) / MAPV.s;
    MAPV.cy -= (now.y - prev.y) / MAPV.s;
    if (live.size === 2 && pinch0 > 8) MAPV.s = scale0 * (spread() / pinch0);
    mapClamp();
    drawBigMap();
  });
  const up = e => {
    live.delete(e.pointerId);
    if (live.size === 2) { pinch0 = spread(); scale0 = MAPV.s; }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  // and a wheel, for the desktop
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    MAPV.s *= Math.exp(-e.deltaY * .0015);
    mapClamp();
    drawBigMap();
  }, { passive: false });
})();

/* ---- the WebGL card ----

   WHAT THIS IS FOR, AND WHAT IT IS NOT. The game is not broken without WebGL:
   the chase view falls back to a software renderer that draws the same street on
   the 2D canvas. What the player gets is a slower, plainer picture and no
   explanation for it, and the explanation is something they can act on — so this
   says what has happened and how to undo it, once, and can be dismissed for good.

   ON AN IPHONE THE CAUSE IS ALMOST ALWAYS LOCKDOWN MODE. That is not a guess:
   this arrived three times from the same phone with a log attached, and the log
   said probe "no", webgl1 false, and no error message at all — the constructors
   are simply not there, which is what Lockdown Mode does to WebGL on every site.
   So it is the first step rather than a footnote.

   Every browser on iOS is WebKit — Chrome, Firefox and Edge included — so the
   Safari settings govern all of them, which is why the steps say Safari whatever
   you are reading this in. */
const iOSish = () => /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1);
/* ASKED OF A THROWAWAY CANVAS. GL.fail is only set once something has tried to
   start the 3D view, and this has to answer before anyone has pressed anything. */
function hasWebGL2() {
  if (typeof WebGL2RenderingContext === 'undefined') return false;
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch (e) { return false; }
}
function glHelpSteps() {
  const ios = iOSish();
  const li = h => '<li>' + h + '</li>';
  /* KEPT SHORT ENOUGH TO FIT A PHONE. The first version ran to 693 px of card on
     a 664 px iPhone screen and 891 px on a 320-wide one, which puts GOT IT below
     the fold — a card explaining a problem that you cannot dismiss. The steps
     are the same steps; there are just fewer words between them. */
  if (!ios) {
    return '<ol>' +
      li('Turn on <b>hardware acceleration</b> in your browser’s settings.') +
      li('Update the graphics driver, then restart the browser.') +
      '</ol>';
  }
  return '<ol>' +
    li('<span class="path">Settings → Privacy &amp; Security → Lockdown Mode</span> — ' +
       'turn it off if it is on. It blocks WebGL on every site, and it is the ' +
       'usual reason for this.') +
    li('<span class="path">Settings → Safari → Advanced → Feature Flags</span> ' +
       '(<span class="path">Experimental Features</span> on older iOS).') +
    li('Find <b>WebGL</b> in the list and switch it on.') +
    li('Close the browser from the app switcher, then open it again.') +
    '</ol><p class="aside">Chrome, Firefox and Edge on iPhone all use Safari’s ' +
    'engine, so this covers them too. WebGPU in the same list is a different ' +
    'feature and does not affect this.</p>';
}
function showGLHelp(force) {
  if (!force) {
    if (hasWebGL2()) return false;
    if (store.get('vm_glhelp', '') === 'off') return false;
  }
  $('glSteps').innerHTML = glHelpSteps();
  $('glhelp').classList.remove('hide');
  return true;
}
function hideGLHelp(never) {
  $('glhelp').classList.add('hide');
  if (never) store.set('vm_glhelp', 'off');
}
$('glOk').onclick = () => hideGLHelp(false);
$('glNever').onclick = () => hideGLHelp(true);

/* ---- the radio ----
   Three buttons rather than one, because a station you do not like has to be
   one thumb away at speed. Each of them is also a user gesture, which is the
   only thing iOS will start audio from. */
$('radioP').onclick = () => { SFX.start(); radioStep(-1); };
$('radioX').onclick = () => { SFX.start(); radioStep(1); };
$('radioN').onclick = () => { SFX.start(); radioToggle(); };
/* And coming back from another app: an <audio> element is not the WebAudio
   graph and does not go through SFX, so it needs its own nudge — the browser
   pauses it on the way out and does not always start it again on the way in. */
for (const ev of ['visibilitychange', 'pageshow'])
  addEventListener(ev, () => {
    if (document.hidden || !RADIO.on) return;
    const a = RADIO.el;
    if (a && a.paused) { const q = a.play(); if (q && q.catch) q.catch(() => {}); }
  });

/* ---- the mixer ----

   Every move is a user gesture, so SFX.start() is safe to call from here — and
   on a phone it is often the FIRST gesture the player makes, which is the one
   that gets the audio context going at all.

   The game slider plays a short blip at the new level on release. You cannot set
   a level against silence, and the engine is not always running when somebody
   opens this. */
function mixPaint() {
  const sv = Math.round(SFX.volume() * 100), rv = Math.round(radioVolume() * 100);
  $('mixSfx').value = sv; $('mixSfxN').textContent = sv;
  $('mixRadio').value = rv; $('mixRadioN').textContent = rv;
}
function mixOpen(on) {
  const open = on == null ? $('mix').classList.contains('hide') : !!on;
  if (open) mixPaint();
  $('mix').classList.toggle('hide', !open);
  $('mixBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  return open;
}
$('mixBtn').onclick = () => { SFX.start(); mixOpen(); };
$('mixDone').onclick = () => mixOpen(false);
$('mixSfx').oninput = e => {
  SFX.start();
  $('mixSfxN').textContent = Math.round(SFX.setVolume(e.target.value / 100) * 100);
};
// on release rather than on every pixel of the drag, or it is a machine gun
$('mixSfx').onchange = () => { SFX.start(); SFX.blipZone(); };
$('mixRadio').oninput = e => {
  $('mixRadioN').textContent = Math.round(radioVolume(e.target.value / 100) * 100);
};

$('logBtn').onclick = () => saveLog();
/* THE VIEW SWITCH. Both renderers are in the build and this picks one — see the
   note at the top of render3d.js. The choice is remembered, but it is NOT
   restored on load: a first WebGL context and a dozen cell builds on the same
   frame as the menu appearing is a stall on the one screen where a stall reads
   as a broken page. It is applied when play starts instead. */
$('modeBtn').onclick = () => setMode3D(!MODE3D);
$('resume').onclick = togglePause;
$('newLoc').onclick = () => {
  state = 'menu';
  endLoad();
  $('pause').classList.add('hide'); $('hud').classList.remove('on');
  $('touch').classList.remove('on'); $('big').classList.remove('on');
  $('menu').classList.remove('hide'); $('barIn').style.width = '0%';
};
$('go').onclick = () => {
  const q = $('q').value.trim();
  startGame(q || 'Ocean Drive, Miami Beach, Florida');
};
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });

/* ---- debug hooks, used by the headless smoke test ---- */
window.__s = () => state;
window.__w = () => ({ name: W.name, procedural: W.procedural, roads: W.roads.length,
  drive: W.driveRoads.length, buildings: W.buildings.length,
  parks: W.parks.length, grid: W.gw + 'x' + W.gh });
window.__p = () => ({ x: +P.car.x.toFixed(1), y: +P.car.y.toFixed(1), h: +P.car.h.toFixed(2),
  spd: +Math.hypot(P.car.vx, P.car.vy).toFixed(2), hp: +P.car.hp.toFixed(1), onRoad: P.car.road,
  wanted: +P.wanted.toFixed(2), cops: cops.length, traffic: traffic.length, peds: peds.length,
  cash: P.cash, mission: MISSION.state, dead: P.dead, colour: P.car.color });
window.__addWanted = n => addWanted(n);
// the WebGL card: whether it is up, what it says, and the ability to force it
window.__glHelp = () => ({
  shown: !$('glhelp').classList.contains('hide'),
  ios: iOSish(), webgl2: hasWebGL2(),
  text: $('glSteps').textContent,
  muted: store.get('vm_glhelp', '') === 'off'
});
window.__showGLHelp = force => showGLHelp(force);
window.__hideGLHelp = never => hideGLHelp(never);
/* WHAT HAS BEEN TAKING YOUR HEALTH, by source, since the page loaded. Reading a
   balance argument off the running game rather than off the source. */
window.__dmg = () => ({ ...DMG });
window.__dmgReset = () => { for (const k in DMG) DMG[k] = 0; };
window.__hurt = () => { P.car.hp = 0; };
window.__heal = () => { P.car.hp = 100; return P.car.hp; };
window.__tp = (x, y, h) => { P.car.x = x; P.car.y = y; if (h != null) P.car.h = h;
  P.car.vx = P.car.vy = 0; cam.x = x; cam.y = y; };
window.__m = () => ({ state: MISSION.state, done: MISSION.done, reward: MISSION.reward,
  time: +MISSION.time.toFixed(1),
  pick: MISSION.pick && { x: MISSION.pick.x, y: MISSION.pick.y },
  drop: MISSION.drop && { x: MISSION.drop.x, y: MISSION.drop.y } });
window.__bld = i => { const b = W.buildings[i]; return { cx: b.cx, cy: b.cy, bb: b.bb, roof: b.roof, wall: b.wall }; };
window.__nav = () => ({ street: NAV.street, zone: NAV.zone,
  streetShown: $('street').classList.contains('on'),
  streetTxt: $('street').textContent, zoneTxt: $('zone').textContent });
window.__theme = () => ({ name: themeName, ground: PAL.ground, lights: PAL.lights,
  places: W.places.length, namedRoads: W.roads.filter(r => r.name).length });
// find a building by its exact material colour (the test payload seeds a pure-red one)
window.__chunks = () => ({ loaded: CHUNK.loaded, failed: CHUNK.failed, busy: CHUNK.busy,
  // scenery waits its turn in a serial queue, so "nothing in flight" is this
  // number and not the absence of recent requests
  side: SIDE.q.length + (SIDE.busy ? 1 : 0), preloading: CHUNK.preloading,
  evicted: CHUNK.evicted, live: W.tiles.size, maxTiles: MAX_TILES, pois: W.pois.length,
  mergeMs: CHUNK.mergeMs, mapMs: CHUNK.mapMs,
  note: CHUNK.note, tiles: [...W.tiles.entries()],
  bounds: { x0: W.minX, y0: W.minY, x1: W.maxX, y1: W.maxY },
  roads: W.roads.length, buildings: W.buildings.length, drive: W.driveRoads.length,
  grid: W.gw + 'x' + W.gh, maskBytes: W.grid ? W.grid.length : 0,
  maskBox: { x0: W.gx0, y0: W.gy0, x1: W.gx0 + W.gw * W.cell, y1: W.gy0 + W.gh * W.cell },
  maskHalf: MASK_HALF,
  skel: W.skelRect && { r: (W.skelRect.x1 - W.skelRect.x0) / 2, bundled: W.skelBundled }, wideMap: WIDE_MAP,
  fixed: [...W.fixed], roaded: ROADED.size, roadIds: W.roadIds.size,
  mapScale: +W.mapScale.toFixed(4), mapWhole: !!W.mapWhole,
  mapOrigin: { x: Math.round(W.mapOrigin.x), y: Math.round(W.mapOrigin.y) },
  vbuckets: W.vbuckets.size, dbuckets: W.dbuckets.size, lights: (W.lights || []).length });
/* The retry scheduler: what is still missing, when the next attempt is due, and
   what every attempt so far did. */
window.__retry = () => ({ wanted: retryWanted(), n: RETRY.n, busy: RETRY.busy,
  inMs: RETRY.at ? RETRY.at - Date.now() : null, delays: RETRY_DELAYS,
  city: RETRY.city && (RETRY.city.label || RETRY.city.query), log: RETRY.log,
  fellBack: FELLBACK && FELLBACK.asked });
// so a test does not have to sit through ninety seconds to see one fire
window.__retryNow = () => { RETRY.at = Date.now() - 1; return RETRY.n; };
window.__mission = () => ({ state: MISSION.state,
  pick: MISSION.pick && { x: MISSION.pick.x, y: MISSION.pick.y },
  drop: MISSION.drop && { x: MISSION.drop.x, y: MISSION.drop.y } });
window.__onRoad = (x, y) => onRoad(x, y);
// handling: hold the controls exactly, and read the slide back out
window.__setInput = o => { inputOverride = o; };
window.__touch = () => ({ ...touch });          // what the pads currently read
window.__ghost = on => { if (on != null) setGhost(on); return GHOST; };
window.__patreon = url => { wirePatreon(url); return PATREON; };
window.__roadDataHere = (x, y) => roadDataHere(x, y);
window.__roadList = () => W.roads.map(r => ({ cls: r.cls, name: r.name, drive: r.drive, w: r.w, pts: r.pts }));
window.__log = () => LOG.build();
window.__logStats = () => LOG.stats();
window.__saveLog = () => saveLog();
/* Would the off-road penalty bite at this spot? Every guard the real predicate
   has, in the same order — including roadDataHere(), which this used to omit. It
   therefore claimed a crawl on ground beyond the edge of the mask, where the car
   in fact drives away at full speed, and a hook that disagrees with the game is
   worse than no hook. */
window.__onRoadPenalty = (x, y) => {
  if (onTarmac(x, y) || !roadDataHere(x, y)) return false;
  const n = nearestRoadDir(x, y);
  return !n || n.d > STRAY_TOL;
};
// paused, the loop stops drawing — this redraws the identical world on demand, so
// a test can diff two frames that differ by exactly one thing
window.__renderOnce = () => render();
// render() jitters the camera by rand() while the shake is up, so two "identical"
// frames are not identical — this stills it so a frame diff can isolate one thing
window.__calm = () => { cam.shake = 0; };
window.__slip = () => P.slip || 0;
window.__marks = () => marks.length;
// a committed 180 is the player's alone: the AI never touches the handbrake
window.__aiSpins = () => traffic.concat(cops).filter(c => c.spin).length;
// audio: is it actually running, does its clock advance, and can it come back
window.__audio = () => SFX.state();
window.__sfx = name => { SFX[name](); return true; };
window.__sfxResume = () => SFX.resume();
window.__audioSuspend = () => SFX.suspend();
window.__radio = () => ({
  status: RADIO.status, on: RADIO.on, i: RADIO.i, n: RADIO.list.length,
  name: RADIO.list[RADIO.i] ? RADIO.list[RADIO.i].name : '',
  label: radioLabel(), err: RADIO.err,
  src: RADIO.el ? RADIO.el.src : '', paused: RADIO.el ? RADIO.el.paused : null,
  list: RADIO.list.map(s => ({ name: s.name, km: s.km == null ? null : +s.km.toFixed(1) }))
});
window.__radioStep = d => radioStep(d);
window.__radioToggle = () => radioToggle();
window.__radioFind = (lat, lon, cc) => radioFind(lat, lon, cc);
window.__radioWake = () => radioWake();
/* the two levels, and the panel that sets them */
window.__mix = () => ({
  open: !$('mix').classList.contains('hide'),
  sfx: SFX.volume(), radio: radioVolume(),
  bus: SFX.state().bus, el: RADIO.el ? RADIO.el.volume : null,
  shownSfx: +$('mixSfx').value, shownRadio: +$('mixRadio').value
});
window.__mixOpen = on => mixOpen(on);
window.__mixSet = (which, v) => {
  const el = $(which === 'radio' ? 'mixRadio' : 'mixSfx');
  el.value = Math.round(v * 100);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return window.__mix();
};
// the interruption Safari hands back as a context that says "running" and is not
window.__audioStalled = (st, t0, t1) => SFX.stalled(st, t0, t1);
window.__audioRebuild = () => { SFX.rebuild(); return SFX.state(); };
// how far the camera has pulled back, and how much world that puts on screen
window.__perf = () => ({ upd: +PERF.upd.toFixed(2), ren: +PERF.ren.toFixed(2), steps: +PERF.steps.toFixed(2) });
window.__cam = () => ({ s: cam.s, viewR: Math.hypot(VW, VH) / 2 / cam.s + 60 });
window.__visRoads = () => {
  const r = Math.hypot(VW, VH) / 2 / cam.s + 60;
  return roadsIn(cam.x - r, cam.y - r, cam.x + r, cam.y + r).length;
};
window.__clearMarks = () => { marks = []; };

/* ---- the 3D view ---- */
// Switching returns false when WebGL2 isn't there, which is a legitimate answer
// on a headless box — a test that asserts on the 3D view has to skip, not fail.
window.__mode3d = () => MODE3D;
window.__setMode3d = on => setMode3D(on);
window.__gl3 = () => ({ ok: !!GL.gl, fail: GL.fail, ready: G3.ready,
                        cells: G3.cells.size, built: G3.built, drawn: G3.drawn,
                        tris: Math.round(G3.tris), view: VIEW3, cell: CELL3,
                        // the sun: is there a shadow map, and is anything casting into it
                        shadow: !!G3.sm, shadowSize: G3.sm ? G3.sm.size : 0,
                        shadowTris: Math.round(G3.shadowTris), shadowR: SHADOW_R,
                        // triangles drawn by the archway program — the one with a
                        // discard compiled into it. Against `tris`, this is how
                        // much of the city still pays for early-Z being off.
                        gateTris: G3.gateTris | 0,
                        lights: (W.lights || []).length, lit: !!PAL.lights });
// where the camera actually is, so a test can check it is behind the car and
// above the hill rather than inside it
window.__cam3 = () => ({ h: G3.cam.h, d: G3.cam.d, y: G3.cam.y,
                         eye: [G3.cam.ex, G3.cam.ey, G3.cam.ez] });
/* The one light: which way it points and where its disc is drawn. Both come off
   the same vector on purpose, so a test can assert the moon is on the side the
   shadows point away from rather than trusting that it looks right. */
window.__sun = () => {
  const th = SKY[themeName] || SKY.dusk, l = Math.hypot(th.ld[0], th.ld[1], th.ld[2]) || 1;
  const d = [th.ld[0] / l, th.ld[1] / l, th.ld[2] / l];
  const C = G3.cam, D = VIEW3 * .82;
  return { dir: d.map(v => +v.toFixed(3)), theme: themeName, r: th.orb.r,
           shadowK: th.shadowK,
           at: [C.ex + d[0] * D, C.ey + d[1] * D, C.ez + d[2] * D].map(v => +v.toFixed(1)) };
};
// the car's third dimension: height, attitude, and whether it is off the ground
window.__body = () => {
  const c = P.car;
  return { z: c.z === undefined ? null : +c.z.toFixed(2), vz: +(c.vz || 0).toFixed(2),
           pitch: +(c.pitch || 0).toFixed(3), roll: +(c.roll || 0).toFixed(3),
           air: !!c.air, flip: +(c.flip || 0).toFixed(2), climb: +(c.climb || 0).toFixed(2),
           ground: +terrainH(c.x, c.y).toFixed(2), terrain: TERRAIN };
};
window.__terrain = (x, y) => {
  const g = terrainGrad(x, y);
  return { h: +g.h.toFixed(3), gx: +g.gx.toFixed(4), gy: +g.gy.toFixed(4) };
};
// the eight corners of the car's cuboid, for checking it is where it is drawn
window.__carBox = () => carBox(P.car, []).map(v => +v.toFixed(2));

/* WHAT THE 3D VIEW ACTUALLY PUT ON THE SCREEN.

   The WebGL canvas is created without preserveDrawingBuffer, because preserving
   it costs a full-screen copy every frame for a buffer nothing normally reads.
   That leaves the contents undefined once the frame is composited — so this
   renders and reads back inside the same task, before the browser gets a chance
   to composite anything, which is the one window where the buffer is
   guaranteed live. readPixels is bottom-left origin and device pixels, and the
   caller is expected to know that. */
window.__px3 = (x, y, w, h) => {
  render();
  const gl = GL.gl;
  if (!gl) return null;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return Array.from(buf);
};
/* Turn the sun's shadows off without turning the sun off, so a test can render
   the identical frame twice and attribute the difference to exactly one thing.
   Comparing against a whole build without shadows would also change the light
   values, the sun disc and the depth pass; this changes one uniform. */
window.__noShadow = v => { G3.noShadow = !!v; return G3.noShadow; };
/* The same trick for the other two things that were added to make the view look
   like a street rather than a diagram. Each renders the identical frame with one
   feature suppressed and nothing else touched, so a difference between the two
   readings can only be that feature. Windows go through a uniform the shader
   compares against anyway; wheels are simply not built. */
window.__noWindows = v => { G3.noWin = !!v; return G3.noWin; };
/* Force every car to the distant level of detail — the two plain boxes — however
   close it is. That is the same switch the renderer throws past ninety metres,
   so the "without" frame is a state the game genuinely reaches rather than a
   build with a line taken out. */
window.__plainCars = v => { G3.plainCars = !!v; return G3.plainCars; };
window.__project = (x, y) => toScreen(x, y).map(v => +v.toFixed(1));
window.__cfg = () => ({ streets: STREETS, buildings: BUILDINGS, pois: POIS, hedge: HEDGE, maxTries: MAX_TRIES,
  searchRadii: POI_RADII, recoverMax: RECOVER_MAX, repairCost: REPAIR_COST,
  streetsQueryTimeout: +(overpassQL(0,0,0,0,'streets').match(/timeout:(\d+)/)||[])[1],
  buildingsQueryTimeout: +(overpassQL(0,0,0,0,'buildings').match(/timeout:(\d+)/)||[])[1],
  poisQueryTimeout: +(overpassQL(0,0,0,0,'pois').match(/timeout:(\d+)/)||[])[1],
  // The streets query is the one the whole game depends on. Nothing optional may
  // ride on it: roads to drive and place names, and that is the whole list.
  streetsOuts: (overpassQL(0,0,0,0,'streets').match(/out /g) || []).length,
  streetsHasRelation: /relation/.test(overpassQL(0,0,0,0,'streets')),
  streetsClauses: (overpassQL(0,0,0,0,'streets').match(/\b(?:way|node|nwr|relation)\[/g) || []),
  // The wide skeleton. Deliberately not the full drivable set: residential lanes
  // are most of a city's ways and would make this query the one that fails.
  arterials: ARTERIALS, skeletonRadii: SKELETON_RADII, skeletonMs: SKELETON_MS,
  skeletonWait: SKELETON_WAIT,
  arterialsQueryTimeout: +(overpassQL(0,0,0,0,'arterials').match(/timeout:(\d+)/)||[])[1],
  arterialsClauses: (overpassQL(0,0,0,0,'arterials').match(/\b(?:way|node|nwr|relation)\[/g) || []),
  arterialsHasResidential: /residential|service|unclassified|living_street/.test(overpassQL(0,0,0,0,'arterials')),
  /* The widest rung asks over three concentric boxes, not one — see SKEL_NEAR.
     Reported as the real query the ladder would send, boxes and all, so a test
     can check the outer box carries only the roads that are cheap out there. */
  arterialsWide: (() => {
    const R = SKELETON_RADII[0];
    const q = overpassQL(unprojLat(R), unprojLon(-R), unprojLat(-R), unprojLon(R),
                         'arterials', { radius: R });
    const boxes = q.match(/\(([-\d.]+,){3}[-\d.]+\)/g) || [];
    const widest = `(${unprojLat(R)},${unprojLon(-R)},${unprojLat(-R)},${unprojLon(R)})`;
    // which highway classes ride on the full-radius box
    const outer = (q.match(/way\["highway"~"\^\(([^)]*)\)\$"\]\(([^)]*)\)/g) || [])
      .filter(c => c.endsWith(widest))
      .map(c => c.match(/\^\(([^)]*)\)\$/)[1]);
    return { rings: new Set(boxes).size, outerClasses: outer.join('|'), query: q };
  })(),
  mapWin: MAP_WIN, mapPx: MAP_PX, mapRedraw: MAP_REDRAW,
  slowAreaMs: SLOW_AREA_MS, ringWait: LOAD_RING_WAIT,
  loadSweepWait: LOAD_SWEEP_WAIT });
window.__pal = () => PAL;
// traffic: how many are alive, how many have died, and how big the ring is
window.__traf = () => ({ cars: traffic.length, cap: trafficCap(), wrecks: WRECKS,
  radius: +trafficR().toFixed(1), gapStop: GAP_STOP, gapSee: GAP_SEE });
window.__trafficCap = n => { TRAFFIC_SET = n | 0; return trafficCap(); };
// what every crash and explosion is scaled by, so a test can ask it directly
window.__earshot = (x, y) => earshot(x, y);
// the objective yellow the canvas actually draws with, so a test can hold the
// stylesheet and the stars against it rather than against a literal
window.__gold = () => GOLD;
window.__playerColour = c => { P.car.color = c; };                       // live palette, so tests can stain the ground
window.__toScreen = (x, y) => toScreen(x, y);
window.__traffic = () => traffic.map(t => ({ id: t.id, x: t.x, y: t.y, h: t.h,
  spd: Math.hypot(t.vx, t.vy), road: t.road_ ? t.road_.pts.length : 0, idx: t.idx, dir: t.dir }));
window.__cars = () => ({
  traffic: traffic.map(t => ({ id: t.id, x: +t.x.toFixed(1), y: +t.y.toFixed(1), hp: +t.hp.toFixed(1),
                               spd: +Math.hypot(t.vx, t.vy).toFixed(2), dead: !!t.dead })),
  cops: cops.map(k => ({ id: k.id, x: +k.x.toFixed(1), y: +k.y.toFixed(1), hp: +k.hp.toFixed(1), dead: !!k.dead })),
  blasts: blasts.length, parts: parts.length, playerHp: +P.car.hp.toFixed(1)
});
window.__setCarHp = (list, i, hp) => {
  const a = list === 'cops' ? cops : traffic;
  if (!a[i]) return false; a[i].hp = hp; return true;
};
// identity survives the array shuffling that wrecks and respawns cause
window.__hpById = (id, hp) => {
  for (const a of [traffic, cops]) for (const c of a) if (c.id === id) { c.hp = hp; return true; }
  return false;
};
window.__putCop = (i, x, y, h, vx, vy) => {
  const k = cops[i]; if (!k) return false;
  k.x = x; k.y = y; k.h = h; k.vx = vx || 0; k.vy = vy || 0; return true;
};
window.__explodeAt = (x, y) => explode(x, y);
window.__parts = () => ({ parts: parts.length, blasts: blasts.length, shake: cam.shake });
/* wasted() is a plain global function, so a test can sit in front of it and count
   the calls — which is the only way to see the recursion the P.dead ordering in
   wasted() exists to prevent. Pass null to put the real one back. */
let WASTED_REAL = null;
window.__countWasted = fn => {
  if (!WASTED_REAL) WASTED_REAL = wasted;
  window.wasted = fn ? function (...a) { fn(); return WASTED_REAL.apply(null, a); } : WASTED_REAL;
  return true;
};
window.__putTraffic = (i, x, y, h, col, vx, vy) => {
  const t = traffic[i]; if (!t) return false;
  t.x = x; t.y = y; t.h = h; t.vx = vx || 0; t.vy = vy || 0;
  if (col) t.color = col;
  return true;
};
// which tiles have any scenery in them yet, by the buildings' own coordinates
window.__bldTiles = () => {
  const s = new Set();
  for (const b of W.buildings) s.add(tileOf(b.cx, b.cy).join(','));
  return [...s].sort();
};
window.__pois = () => W.pois.map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), kind: p.kind, name: p.name }));
// what the network layer has learned about each mirror this session
window.__mirrors = () => OVERPASS.map(u => ({ host: new URL(u).hostname, miss: MIRROR_MISS.get(u) || 0,
  // how much longer this host asked to be left alone, in ms; 0 when it hasn't
  parkedFor: Math.max(0, (MIRROR_UNTIL.get(u) || 0) - Date.now()) }));
window.__nearestPOI = kind => {
  const p = nearestPOI(kind, P.car.x, P.car.y);
  return p && { x: +p.x.toFixed(1), y: +p.y.toFixed(1), kind: p.kind, name: p.name,
                d: +dist(p.x, p.y, P.car.x, P.car.y).toFixed(1) };
};
window.__mini = () => ({ w: mini.width, h: mini.height, dpr: DPR });
/* ---- the build that will not go away ----

   index.html is the ONE file that cannot carry a version in its URL, because its
   URL is the site. Everything it loads is stamped with a content hash, so a
   cached index and a fresh script can never be mixed — but a wholly cached index
   serves a wholly cached build, every part of it agreeing with every other, and
   nothing in the page has any way to know.

   THREE SESSION LOGS IN A ROW came back from the same phone running the previous
   day's build, hours after a deploy, reporting bugs that were already fixed. It
   is not someone forgetting to reload: iOS restores a suspended tab from the
   back-forward cache without revalidating anything, so a tab left open for a day
   is a day-old game, and pulling to refresh is not something anyone thinks to do
   to a game.

   So the page asks. version.txt is one line written by tools/stamp.mjs beside
   the stamps it writes into the HTML, fetched no-store with a cache-buster,
   compared against the hash the running page was built with.

   WHEN IT DIFFERS, WHAT HAPPENS DEPENDS ON WHETHER ANYONE IS DRIVING. On the
   menu it reloads, which is invisible and is what the player would have done.
   Mid-game it says so and leaves them alone — reloading out from under someone
   two minutes into a delivery to give them a better tunnel is not a trade worth
   making. And it is checked when the tab comes BACK, because that is the moment
   the stale one has been sitting longest and the moment iOS hands it over
   without asking the server anything. */
function checkBuild() {
  if (!window.BUILD || location.protocol === 'file:') return;
  const now = Date.now();
  if (now - checkBuild.last < 30000) return;      // twice a minute at the very most
  checkBuild.last = now;
  fetch('version.txt?t=' + now, { cache: 'no-store' })
    .then(r => (r.ok ? r.text() : null))
    .then(v => {
      v = (v || '').trim();
      if (!/^[0-9a-f]{6,12}$/.test(v) || v === window.BUILD) return;
      if (state === 'menu' || state === 'dead') location.reload();
      else if (typeof toast === 'function') toast('A NEWER VERSION IS OUT\nRELOAD WHEN YOU LIKE', 4200);
    })
    .catch(() => {});                             // offline is not an update
}
checkBuild.last = 0;
window.addEventListener('pageshow', e => { if (e.persisted) checkBuild(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });
checkBuild();

window.__checkBuild = () => checkBuild();
window.__simT = () => SIMT;                 // simulated seconds, monotonic
window.__openMap = () => { openMap(); return state; };
window.__closeMap = () => { closeMap(); return state; };
window.__edge = () => ({ cd: +(P.edgeCd || 0).toFixed(2), hits: P.edgeHits || 0 });
window.__clearEdge = () => { P.edgeCd = 0; P.edgeHits = 0; };
window.__mapView = () => ({ cx: +MAPV.cx.toFixed(1), cy: +MAPV.cy.toFixed(1), s: +MAPV.s.toFixed(5) });
window.__mapPan = (dx, dy) => { MAPV.cx += dx; MAPV.cy += dy; mapClamp(); drawBigMap(); };
window.__mapZoom = k => { MAPV.s *= k; mapClamp(); drawBigMap(); };
window.__missingKinds = () => missingKinds();
window.__wideSearch = () => widenLandmarkSearch();
window.__sweepLandmarks = () => sweepLandmarks();
window.__sweep = () => ({ sweptTo: W.sweptTo, sweeping: W.sweeping, radii: POI_RADII });
window.__copSpeed = () => cops[0] ? Math.hypot(cops[0].vx, cops[0].vy) : null;
window.__bustT = () => P.bustT;
window.__recover = kind => { const r = recoverPoint(kind); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1) }; };
window.__cash = () => P.cash;
window.__setCash = n => { P.cash = n; store.set('vm_cash', n); };
window.__spawn = () => ({ x: +P.spawn.x.toFixed(1), y: +P.spawn.y.toFixed(1) });
window.__passable = () => W.buildings.filter(b => b.passable).length;
window.__newMission = () => newMission();
window.__byColour = (r, g, b_) => {
  const b = W.buildings.find(x => x.mWall[0] === r && x.mWall[1] === g && x.mWall[2] === b_);
  return b ? { roof: b.roof, wall: b.wall, mRoof: b.mRoof, mWall: b.mWall } : null;
};
window.__inside = (x, y) => W.buildings.some(b => pointInPoly(b.pts, x, y));
// null when no building covers the point, else whether you can drive through it
window.__passableAt = (x, y) => {
  const b = W.buildings.find(q => pointInPoly(q.pts, x, y));
  return b ? !!b.passable : null;
};

resize();
/* AND THE CARD, IF THIS BROWSER HAS NO WEBGL AT ALL.

   On the menu rather than after DRIVE, because the whole point is that it is
   fixable before you play — and one frame late rather than inline, so a card is
   never the first thing painted on a page that is still laying itself out. */
setTimeout(() => { try { showGLHelp(false); } catch (e) {} }, 0);
