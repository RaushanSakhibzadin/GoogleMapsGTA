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
  while (acc >= step && guard++ < 5) { update(step); acc -= step; steps++; }
  const tR = performance.now();
  render();
  // rolling averages, so a slow frame can be attributed rather than guessed at
  PERF.upd += (tR - tU - PERF.upd) * .1;
  PERF.ren += (performance.now() - tR - PERF.ren) * .1;
  PERF.steps += (steps - PERF.steps) * .1;
}
const PERF = { upd: 0, ren: 0, steps: 0 };

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
  mapFit();
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

$('logBtn').onclick = () => saveLog();
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
  evicted: CHUNK.evicted, live: W.tiles.size, maxTiles: MAX_TILES, pois: W.pois.length,
  mergeMs: CHUNK.mergeMs, mapMs: CHUNK.mapMs,
  note: CHUNK.note, tiles: [...W.tiles.entries()],
  bounds: { x0: W.minX, y0: W.minY, x1: W.maxX, y1: W.maxY },
  roads: W.roads.length, buildings: W.buildings.length, drive: W.driveRoads.length,
  grid: W.gw + 'x' + W.gh,
  skel: W.skelRect && { r: (W.skelRect.x1 - W.skelRect.x0) / 2 }, sceneryOnly: SCENERY_ONLY,
  fixed: [...W.fixed], roadIds: W.roadIds.size,
  mapScale: +W.mapScale.toFixed(4), mapWhole: !!W.mapWhole,
  mapOrigin: { x: Math.round(W.mapOrigin.x), y: Math.round(W.mapOrigin.y) },
  vbuckets: W.vbuckets.size, dbuckets: W.dbuckets.size, lights: (W.lights || []).length });
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
window.__roadList = () => W.roads.map(r => ({ cls: r.cls, name: r.name, drive: r.drive, pts: r.pts }));
window.__log = () => LOG.build();
window.__logStats = () => LOG.stats();
window.__saveLog = () => saveLog();
// would the off-road penalty bite at this spot? the tolerance included
window.__onRoadPenalty = (x, y) => {
  if (onTarmac(x, y)) return false;
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
// how far the camera has pulled back, and how much world that puts on screen
window.__perf = () => ({ upd: +PERF.upd.toFixed(2), ren: +PERF.ren.toFixed(2), steps: +PERF.steps.toFixed(2) });
window.__cam = () => ({ s: cam.s, viewR: Math.hypot(VW, VH) / 2 / cam.s + 60 });
window.__visRoads = () => {
  const r = Math.hypot(VW, VH) / 2 / cam.s + 60;
  return roadsIn(cam.x - r, cam.y - r, cam.x + r, cam.y + r).length;
};
window.__clearMarks = () => { marks = []; };
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
  mapWin: MAP_WIN, mapPx: MAP_PX, mapRedraw: MAP_REDRAW,
  slowAreaMs: SLOW_AREA_MS, ringWait: LOAD_RING_WAIT,
  loadSweepWait: LOAD_SWEEP_WAIT });
window.__pal = () => PAL;
window.__playerColour = c => { P.car.color = c; };                       // live palette, so tests can stain the ground
window.__toScreen = (x, y) => toScreen(x, y);
window.__traffic = () => traffic.map(t => ({ x: t.x, y: t.y, h: t.h,
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
window.__pois = () => W.pois.map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), kind: p.kind, name: p.name }));
// what the network layer has learned about each mirror this session
window.__mirrors = () => OVERPASS.map(u => ({ host: new URL(u).hostname, miss: MIRROR_MISS.get(u) || 0 }));
window.__nearestPOI = kind => {
  const p = nearestPOI(kind, P.car.x, P.car.y);
  return p && { x: +p.x.toFixed(1), y: +p.y.toFixed(1), kind: p.kind, name: p.name,
                d: +dist(p.x, p.y, P.car.x, P.car.y).toFixed(1) };
};
window.__mini = () => ({ w: mini.width, h: mini.height, dpr: DPR });
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
