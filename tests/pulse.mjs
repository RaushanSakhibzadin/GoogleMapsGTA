/* THE JOB PINGS ON THE MAP.
 *
 * Asked for: the mission's goal should pulsate on the map. It had a dot and an
 * emoji and neither moved, so on a city map with a hundred landmarks on it the
 * one you are actually going to looked like all the others.
 *
 * WHY THIS NEEDED A SECOND CANVAS, which is most of what this file is really
 * checking. drawBigMap walks every road in the world and is deliberately called
 * only when the map MOVES — opening, panning, pinching. An expanding ring is a
 * per-frame job, so it goes on a layer of its own above the city, and what that
 * design promises is asserted here: the ring changes every frame, the city layer
 * is not dirtied, and drawBigMap is not called once while the ping runs. The
 * last of those is counted rather than inferred from the pixels — a build that
 * redraws the whole city every frame paints the same deterministic picture and
 * comes back byte-identical, so the pixels cannot tell you.
 *
 * THE PHASE IS PASSED IN. The animation runs on the wall clock, which is right
 * for a decoration — SIMT stops while the map is open — and useless to measure
 * against, because sampling twice gets two arbitrary moments. __mapPulse takes
 * the clock, so the same frame can be asked for twice and two known-different
 * ones compared.
 *
 * Usage: node tests/pulse.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` },
               geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` },
               geometry: [toLL(x, -900), toLL(x, 900)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Ravnica' } });
  return { elements: els };
};

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const isStreets = !/"building"/.test(q) && !(/amenity/.test(q) && !/highway/.test(q));
  return r.fulfill({ contentType: 'application/json',
                     body: JSON.stringify(isStreets ? streets() : { elements: [] }) });
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1000);

const out = {};

/* A job a hundred metres up the road, which puts it on the big map and inside
   the radar's 230 m at the same time — both surfaces, one fixture. */
out.job = await p.evaluate(() => {
  window.__tp(0, 0, 0);
  P.car.vx = P.car.vy = 0;
  MISSION.state = 'pickup';
  MISSION.pick = { x: 70, y: -70 };
  return { state: MISSION.state, at: MISSION.pick, dist: Math.round(Math.hypot(70, 70)) };
});

/* ---- 1. the ring on the big map moves, and comes back round ---- */
/* Ink measured as its REACH from the marker, not as a pixel count. A count says
   "something changed" and would be satisfied by the ring flickering on and off;
   the radius is the thing that is supposed to grow, and reading it means the
   report says which way. */
const REACH = `((d, w, h, cx, cy) => {
  let n = 0, far = 0, near = 1e9;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] <= 8) continue;
    n++;
    const r = Math.hypot(x - cx, y - cy);
    if (r > far) far = r;
    if (r < near) near = r;
  }
  return { n, far: Math.round(far), near: n ? Math.round(near) : -1 };
})`;

const sample = ms => p.evaluate(([src, t]) => {
  const drew = window.__mapPulse(t);
  const cv = document.getElementById('bigmapFX');
  const g = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const s = MAPV.s * DPR;
  const cx = w / 2 + (MISSION.pick.x - MAPV.cx) * s;
  const cy = h / 2 + (MISSION.pick.y - MAPV.cy) * s;
  return { drew, ...eval(src)(g.getImageData(0, 0, w, h).data, w, h, cx, cy) };
}, [REACH, ms]);

await p.evaluate(() => { window.__openMap(); window.__mapZoom(4); });
await p.waitForTimeout(300);
out.period = await p.evaluate(() => window.__pulseMs());

const PH = [0, .12, .24, .36, .48, .6, .72, .84, .96];
out.frames = [];
for (const k of PH) out.frames.push({ k, ...(await sample(k * out.period)) });

out.drewEveryFrame = out.frames.every(f => f.drew && f.n > 40);
/* IT EXPANDS — READ OFF THE INNER EDGE, NOT THE OUTER ONE, and that is worth a
   paragraph because the obvious measurement is wrong here.
 *
 * There are two rings, half a period apart, so that there is always one on the
 * way out and one on the way in and the ping has no dead beat. That means the
 * OUTER edge of the ink is whichever ring happens to be older, and it barely
 * moves across the cycle: 91, 105, 120, 74, 88 — a sawtooth that says nothing
 * about expansion. The INNER edge is the younger ring, and it is exactly the
 * thing that is supposed to be travelling outwards.
 *
 * So: it climbs across the first half of the cycle, snaps back when the next
 * ring is born half way through, and climbs again — which is a description of
 * two rings pinging in turn and is not satisfied by anything static, anything
 * flickering, or a single ring that expands once and stops. */
const near = out.frames.map(f => f.near);
const climbs = (a, b) => near.slice(a, b).every((v, i, r) => i === 0 || v > r[i - 1]);
out.nearByPhase = near;
out.reachGrows = climbs(0, 5) && climbs(5, 9) &&
                 near[4] > near[0] * 3 && near[5] < near[4];
/* AND IT IS A CYCLE, not a one-way expansion that stops. The same phase one
   period later has to draw the same frame — which is also what proves the phase
   is being used at all rather than the clock read internally. */
out.again = await sample(out.period * 3 + .12 * out.period);
out.repeatsExactly = out.again.n === out.frames[1].n && out.again.far === out.frames[1].far;

/* ---- 2. and the city underneath is neither dirtied nor redrawn ---- */
/* The reason for the second canvas, and TWO separate claims, because the
   obvious single one does not hold.
 *
 * "Sixty frames of ping leave #bigmapC byte for byte where it was" was the first
 * version of this, and it passes on the naive implementation as well — calling
 * drawBigMap every frame paints the same deterministic picture, so the pixels
 * come back identical and the check that was supposed to catch a full walk of
 * every road in the world per frame catches nothing at all. Verified against
 * that build rather than assumed.
 *
 * So the pixels answer what they can actually answer — that the ping is not
 * scribbling on the city layer — and whether the city is being REDRAWN is asked
 * of drawBigMap itself, by counting the calls. That one is exact, and it is the
 * claim the whole second-canvas design rests on. */
out.stillMap = await p.evaluate(() => {
  const cv = document.getElementById('bigmapC');
  const g = cv.getContext('2d');
  const before = g.getImageData(0, 0, cv.width, cv.height).data;
  /* A function declaration in a classic script is a writable property of the
     global object, and every call site resolves through it — so this counts the
     real calls rather than a copy nobody uses. */
  const real = window.drawBigMap;
  let calls = 0;
  window.drawBigMap = function (...a) { calls++; return real.apply(this, a); };
  for (let i = 0; i < 60; i++) window.__mapPulse(i * 17);
  window.drawBigMap = real;
  const after = g.getImageData(0, 0, cv.width, cv.height).data;
  let diff = 0;
  for (let i = 0; i < after.length; i += 4) if (after[i] !== before[i]) diff++;
  return { redraws: calls, diffPx: diff };
});
out.cityIsUntouched = out.stillMap.diffPx === 0;
out.cityIsNotRedrawn = out.stillMap.redraws === 0;

/* ---- 3. no job, no ping ---- */
/* Which is the A/B for everything above: the same code path with nothing to
   point at has to leave the layer empty, or what is being measured is the layer
   rather than the objective. */
out.noJob = await p.evaluate(([src, t]) => {
  const keep = { s: MISSION.state, p: MISSION.pick };
  MISSION.state = 'none'; MISSION.pick = null;
  const drew = window.__mapPulse(t);
  const cv = document.getElementById('bigmapFX');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  MISSION.state = keep.s; MISSION.pick = keep.p;
  return { drew, n };
}, [REACH, 200]);
out.emptyWithoutAJob = out.noJob.drew === false && out.noJob.n === 0;

/* ---- 4. the sheet does not eat the map's gestures ---- */
/* A full-screen canvas over the one the pan and pinch handlers are bound to is
   a map you cannot drag, and it would look perfectly fine in a screenshot.
   Asked of the browser's own hit test rather than of the stylesheet, because
   pointer-events is only one of several ways to get this wrong. */
out.hit = await p.evaluate(() => {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return { id: el ? el.id : null,
           fx: getComputedStyle(document.getElementById('bigmapFX')).pointerEvents };
});
out.gesturesStillReachTheMap = out.hit.id === 'bigmapC' && out.hit.fx === 'none';

/* ---- 5. the colour says which half of the job it is ---- */
/* Pink to collect, gold to deliver — the pair the arrow and the HUD already use.
   Read off the drawn ring rather than off the palette, so a ring that is drawn
   in the wrong one is caught. */
const ringHue = () => p.evaluate(() => {
  window.__mapPulse(120);
  const cv = document.getElementById('bigmapFX');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 60) continue;                 // the bright core of the ring
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), n } : null;
});
out.pickupInk = await ringHue();
await p.evaluate(() => {
  MISSION.state = 'deliver';
  MISSION.drop = { x: 70, y: -70 };
});
out.deliverInk = await ringHue();
// pink leads blue over green; gold leads green over blue. Nothing subtle about it.
out.pickupIsPink = !!out.pickupInk && out.pickupInk.b > out.pickupInk.g + 40;
out.deliverIsGold = !!out.deliverInk && out.deliverInk.g > out.deliverInk.b + 40;

/* ---- 6. and the radar pings too ---- */
/* The surface you actually look at while driving. It is redrawn every frame
   already, so there is no phase to pass in and no need for one — sampled over a
   full period of wall clock instead, which is the real thing running. */
await p.evaluate(() => { window.__closeMap(); MISSION.state = 'pickup'; MISSION.pick = { x: 70, y: -70 }; });
await p.waitForTimeout(300);
const miniInk = () => p.evaluate(() => {
  const cv = document.getElementById('mini');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  // the objective's pink, at any strength the ring fades through
  for (let i = 0; i < d.length; i += 4)
    if (d[i] > 120 && d[i + 2] > 110 && d[i + 1] < d[i] * .72) n++;
  return n;
});
const shots = [];
for (let i = 0; i < 10; i++) { shots.push(await miniInk()); await p.waitForTimeout(out.period / 8); }
out.radar = { shots, lo: Math.min(...shots), hi: Math.max(...shots) };
/* Over a full cycle the ring is at its widest and at nothing, so the pink on the
   radar has to swing. A static blip gives the same number ten times. */
out.radarPings = out.radar.hi > out.radar.lo + 20 && out.radar.lo > 0;

out.errs = errs.slice(0, 3);
out.pass = out.drewEveryFrame && out.reachGrows && out.repeatsExactly &&
           out.cityIsUntouched && out.cityIsNotRedrawn &&
           out.emptyWithoutAJob && out.gesturesStillReachTheMap &&
           out.pickupIsPink && out.deliverIsGold && out.radarPings && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
