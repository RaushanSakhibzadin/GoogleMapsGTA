/* Tap the radar, the game stops, the city opens.

   Checked on pixels and on the clock, not on classes: a map that opens and
   draws nothing would satisfy "the overlay is visible", and a pause that does
   not pause would satisfy "state === 'map'". So this asserts the canvas has ink
   on it, that the car has not moved a millimetre while the map was up, and that
   panning and pinching actually change what is drawn. */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const isPois = q => /amenity/.test(q) && !/highway/.test(q);

let id = 1;
const streets = () => ({ elements: [
  ...[-4, -3, -2, -1, 0, 1, 2, 3, 4].map(k => ({ type: 'way', id: id++,
    tags: { highway: k ? 'residential' : 'secondary', name: `EW ${k}` },
    geometry: [toLL(-900, k * 110), toLL(900, k * 110)] })),
  ...[-4, -3, -2, -1, 0, 1, 2, 3, 4].map(k => ({ type: 'way', id: id++,
    tags: { highway: 'residential', name: `NS ${k}` },
    geometry: [toLL(k * 110, -900), toLL(k * 110, 900)] })),
  { type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } },
] });
const arterials = () => ({ elements: [
  ...[-2, 0, 2].map(k => ({ type: 'way', id: 700000 + k + 9, tags: { highway: 'primary', name: `Radial ${k}` },
    geometry: [toLL(-9000, k * 1500), toLL(9000, k * 1500)] })),
  { type: 'node', id: 700999, lat: LAT0, lon: LON0, tags: { place: 'city', name: 'Beograd' } },
] });
const pois = () => ({ elements: [
  { type: 'node', id: 7001, ...toLL(300, -200), tags: { shop: 'car_repair', name: 'Garaza' } },
  { type: 'node', id: 7002, ...toLL(-2400, 1200), tags: { amenity: 'hospital', name: 'Bolnica' } },
] });

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill(json(arterials()));
  if (/"building"/.test(q)) return r.fulfill(json({ elements: [] }));
  if (isPois(q)) return r.fulfill(json(pois()));
  return r.fulfill(json(streets()));
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(700);

const out = {};

// get the car moving, so "the game paused" is a claim with something to prove
await p.evaluate(() => new Promise(res => {
  window.__tp(-700, 0, 0);
  const t0 = performance.now();
  const tick = () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    performance.now() - t0 < 1500 ? requestAnimationFrame(tick) : res();
  };
  requestAnimationFrame(tick);
}));
out.movingBefore = await p.evaluate(() => window.__p().spd > 5);

/* ---- the radar itself is the button ---- */
await p.tap('#mini');
await p.waitForTimeout(250);
out.stateAfterTap = await p.evaluate(() => window.__s());
out.overlayShown = await p.evaluate(() =>
  !document.getElementById('bigmap').classList.contains('hide') &&
  getComputedStyle(document.getElementById('bigmap')).display !== 'none');
out.where = await p.evaluate(() => document.getElementById('mapWhere').textContent);

/* Ink on the canvas: count pixels that are not the background. A map that opened
   and drew nothing passes every structural check going. */
const ink = () => p.evaluate(() => {
  const cv = document.getElementById('bigmapC');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  // the background is one flat colour; anything else is road, park, dot or car
  const br = d[0], bg = d[1], bb = d[2];
  let n = 0, green = 0, red = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b2 = d[i + 2];
    if (Math.abs(r - br) + Math.abs(gg - bg) + Math.abs(b2 - bb) > 24) n++;
    if (gg > 170 && r < 150 && b2 > 90 && b2 < 210) green++;
    if (r > 190 && gg < 140 && b2 > 70 && b2 < 160) red++;
  }
  return { ink: n, green, red, px: d.length / 4 };
});
out.drawn = await ink();
out.view0 = await p.evaluate(() => window.__mapView());

// the car must not move while the map is up — that is what "pauses" means
const carBefore = await p.evaluate(() => window.__p());
await p.waitForTimeout(1200);
const carAfter = await p.evaluate(() => window.__p());
out.frozen = carBefore.x === carAfter.x && carBefore.y === carAfter.y;

/* ---- panning and pinching have to change the picture ---- */
await p.evaluate(() => window.__mapPan(900, 0));
out.viewPanned = await p.evaluate(() => window.__mapView());
out.pannedDrawn = await ink();
out.panMoved = out.viewPanned.cx !== out.view0.cx;

await p.evaluate(() => window.__mapZoom(2.5));
out.viewZoomed = await p.evaluate(() => window.__mapView());
out.zoomChanged = out.viewZoomed.s > out.view0.s;

// zooming all the way out must stop at the world, not run away forever
await p.evaluate(() => window.__mapZoom(0.00001));
out.viewMinned = await p.evaluate(() => window.__mapView());
out.zoomClamped = out.viewMinned.s > 0 && out.viewMinned.s < out.view0.s;

await p.screenshot({ path: `${OUT}/shot-bigmap.png` });

/* ---- the map's own buttons answer a FINGER ---- */
/* Reported from play: on a phone the centre-on-me button does nothing.
 *
 * It was never the button. The driving pads are not hidden when the map opens —
 * the overlay is opaque and simply covers them — so they were still laid out,
 * still full width, and still answering padAt() from behind it. ◎ sits exactly
 * on top of the accelerator, so the document touch handler read the tap as a
 * touch on the throttle and called preventDefault, and preventDefault on
 * touchstart is what stops the browser ever synthesising a click. The handler
 * never ran.
 *
 * THIS HAS TO BE A REAL TAP ON A REAL TOUCH CONTEXT, which is why it lives here
 * and not beside the other re-centre assertions in mapzoom.mjs. That file drives
 * the same button with el.click(), on a desktop page whose pads measure zero
 * wide — it invokes the handler directly and passed all the way through the
 * bug. A control that only works when the test calls it is not a control.
 *
 * The ✕ is checked in the same breath because it is the control this could have
 * broken worst — it escaped only by sitting in the gap between two pads, which
 * is luck, not design, and the next layout change could spend it. */
out.finger = await p.evaluate(() => {
  window.__openMap();
  window.__mapPan(1800, 1400);                 // dragged well off the car
  const v = window.__mapView();
  const at = id => { const b = document.getElementById(id).getBoundingClientRect();
    return { pad: (h => h ? h.prop : null)(padAt(b.x + b.width / 2, b.y + b.height / 2)) }; };
  return { lostBy: Math.round(Math.hypot(v.cx - P.car.x, v.cy - P.car.y)),
           // what the touch layer thinks is under each button while the map is up
           padUnderMe: at('mapMe').pad, padUnderClose: at('mapClose').pad };
});
await p.waitForTimeout(120);
await p.tap('#mapMe');                         // a finger, not el.click()
await p.waitForTimeout(200);
out.afterFinger = await p.evaluate(() =>
  Math.round(Math.hypot(window.__mapView().cx - P.car.x, window.__mapView().cy - P.car.y)));
/* Lost by a long way, then found. Not zero: mapClamp will not pull the edge of
   the world inside the viewport, so a car near a corner pins the centre short
   of itself. */
out.centreAnswersAFinger = out.finger.lostBy > 500 && out.afterFinger < 100;
await p.evaluate(() => window.__closeMap());
await p.waitForTimeout(150);
await p.evaluate(() => window.__openMap());
await p.waitForTimeout(150);

/* ---- and it gives the game back ---- */
await p.tap('#mapClose');
await p.waitForTimeout(250);
out.stateAfterClose = await p.evaluate(() => window.__s());
out.overlayHidden = await p.evaluate(() =>
  document.getElementById('bigmap').classList.contains('hide'));
// the physics must not be handed the paused seconds as one enormous step
out.resumedSanely = await p.evaluate(async () => {
  const a = window.__p();
  await new Promise(r => setTimeout(r, 400));
  const b = window.__p();
  return Math.hypot(b.x - a.x, b.y - a.y) < 60;
});

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

out.errs = errs.slice(0, 4);
out.pass =
  out.movingBefore && out.stateAfterTap === 'map' && out.overlayShown &&
  out.drawn.ink > out.drawn.px * .01 &&        // a real map, not an empty canvas
  out.drawn.green > 8 && out.drawn.red > 8 &&  // the landmarks are on it
  !!out.where &&
  out.frozen &&
  out.panMoved && out.pannedDrawn.ink > out.pannedDrawn.px * .005 &&
  out.zoomChanged && out.zoomClamped && out.centreAnswersAFinger &&
  out.stateAfterClose === 'play' && out.overlayHidden && out.resumedSanely &&
  out.fps >= 50 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
