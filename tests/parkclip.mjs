/* THE PARK THAT IS GREEN ON THE MAP AND NOT ON THE GROUND.
 *
 * Reported from an iPad: a park showing on the radar with nothing but tarmac
 * where it should be. The cause is a single line — a park was drawn once, in
 * whichever 512 m cell contained its CENTROID, so that one spanning four cells
 * was not drawn four times.
 *
 * The flaw is that the centroid's cell may not be built. Cells are built out to
 * VIEW3 and evicted behind you, and a park big enough to notice is easily big
 * enough for its middle to lie outside that radius while its edge is under your
 * wheels. The whole park then disappears from the world, while the map — which
 * draws W.parks straight, with no cell rule — still shows it green.
 *
 * SO THE FIXTURE IS A PARK THAT IS DELIBERATELY TOO BIG. Two kilometres across,
 * with the car standing on its edge: near enough that the ground under it is
 * built and drawn, far enough that its centre is well outside the draw radius.
 * A small park in front of the car would pass on the broken build.
 *
 * WHAT IS MEASURED is green on the ground, counted in the frame, with the park
 * present and with it removed. Not the map — the map was never wrong.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* A straight road east–west for the car to stand on, and one enormous park whose
   near edge runs alongside it. */
function streets() {
  const els = [];
  let id = 1;
  els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: 'Edge Road' },
             geometry: [toLL(-1500, 0), toLL(1500, 0)] });
  for (const x of [-600, 0, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
               geometry: [toLL(x, -60), toLL(x, 900)] });
  els.push({ type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Park Edge' } });
  return { elements: els };
}
/* THE PARK. Its near edge is 40 m north of the road; it runs 2 km further north
   and 2 km wide, so its centroid sits about a kilometre away — outside VIEW3
   (760 m) — while the grass beside the car is in plain view. */
const PARK = { elements: [
  { type: 'way', id: 5001, tags: { leisure: 'park', name: 'Veliki park' },
    geometry: [toLL(-1000, -40), toLL(1000, -40), toLL(1000, -2040), toLL(-1000, -2040), toLL(-1000, -40)] }
] };

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
}));
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/historic/.test(q) || /amenity/.test(q)) && !/highway/.test(q) ? 'pois' : 'streets';
  // the park rides with the buildings request, which is where leisure/landuse arrive
  const body = kind === 'streets' ? streets()
             : kind === 'buildings' ? PARK : { elements: [] };
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2000);
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(500);

/* Stood on the road at the park's edge, facing north across it. The centroid is
   a kilometre away up the field; the grass starts forty metres in front. */
out.geometry = await p.evaluate(() => {
  const f = W.parks[0];
  if (!f) return null;
  const c = { x: (f.bb.x0 + f.bb.x1) / 2, y: (f.bb.y0 + f.bb.y1) / 2 };
  window.__tp(0, 20, -Math.PI / 2);          // facing -y, which is north here
  P.car.vx = P.car.vy = 0;
  return { parks: W.parks.length,
           bb: [Math.round(f.bb.x0), Math.round(f.bb.y0), Math.round(f.bb.x1), Math.round(f.bb.y1)],
           centroid: [Math.round(c.x), Math.round(c.y)],
           centroidDist: Math.round(Math.hypot(c.x - 0, c.y - 20)),
           view3: VIEW3, nearEdgeDist: Math.round(Math.abs(-40 - 20)) };
});
/* The fixture only means anything if the centre really is out of range and the
   edge really is in it. Asserted rather than assumed, because a change to VIEW3
   or to the fixture could quietly turn this into a test of nothing. */
out.fixtureIsTheHardCase = !!out.geometry &&
  out.geometry.centroidDist > out.geometry.view3 && out.geometry.nearEdgeDist < 120;

const greenCount = () => p.evaluate(() => {
  window.__keepStateP = state;
  state = 'pause';
  for (let i = 0; i < 40; i++) window.__px3(0, 0, 1, 1);   // one cell per frame
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const px = window.__px3(0, 0, w, h);
  state = window.__keepStateP;
  let green = 0;
  // grass: clearly more green than either of the other two channels
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 1] > 60 && px[i + 1] > px[i] * 1.18 && px[i + 1] > px[i + 2] * 1.18) green++;
  return { green, total: w * h, pct: +(100 * green / (w * h)).toFixed(2) };
});

/* BOTH FRAMES ARE TAKEN OF A SETTLED WORLD, and the "with" one was not.
   The park arrives on the buildings request, which streams tile by tile, and the
   cells are built from whatever has arrived when each one is built. Under a full
   suite one run measured the subject frame with eight of the nine parks in the
   world and the cell in front of the camera built before the ninth landed: the
   park was in neither frame and the difference came out at minus nine. So the
   world is allowed to stop changing and the geometry is rebuilt from it, which
   is exactly what the control frame below already does — the two are now the
   same procedure with one flag between them, which is the whole idea. */
const settleWorld = () => p.evaluate(async () => {
  let last = -1, still = 0, waited = 0;
  while (waited < 12000) {
    await new Promise(r => setTimeout(r, 150));
    waited += 150;
    const n = W.parks.length;
    if (n === last) { if (++still >= 4) break; } else { still = 0; last = n; }
  }
  if (typeof dropAllCells === 'function') dropAllCells();
  return { parks: last, ms: waited };
});
const waitCells = () => p.evaluate(async () => {
  let last = -1, still = 0, waited = 0;
  while (waited < 12000) {
    await new Promise(r => setTimeout(r, 120));
    waited += 120;
    const n = window.__gl3().cells;
    if (n === last && n > 0) { if (++still >= 4) break; } else { still = 0; last = n; }
  }
  return { cells: last, ms: waited };
});
out.settled = await settleWorld();
out.builtWith = await waitCells();
out.withPark = await greenCount();

/* And the same frame with the park taken out of the world, which is the only
   way to know the green being counted is the park and not the sky or a road
   marking that happens to be greenish. */
await p.evaluate(() => {
  window.__keepParks = W.parks;
  W.parks = [];
  if (typeof dropAllCells === 'function') dropAllCells();
});
/* WAIT FOR THE CELLS TO COME BACK, rather than for four hundred milliseconds.
   dropAllCells throws the geometry away and it is rebuilt ONE CELL PER FRAME —
   so how long that takes is a frame rate, not a duration. Under a full suite
   this machine renders the chase view at eight frames a second and four hundred
   milliseconds bought three cells of the sixteen in view: the frame still
   showed the old geometry, park and all, and the control came back within
   seventy pixels of the subject. The park was drawn perfectly; the comparison
   was between two pictures of it.
   Polled until the live cell count stops moving, which is the thing actually
   being waited for, with a ceiling so a build that never rebuilds fails rather
   than hangs. */
out.rebuild = await waitCells();
out.withoutPark = await greenCount();
await p.evaluate(() => {
  W.parks = window.__keepParks;
  if (typeof dropAllCells === 'function') dropAllCells();
});

out.parkIsDrawn = out.withPark.green > out.withoutPark.green + 4000;
out.greenGain = out.withPark.green - out.withoutPark.green;

out.errs = errs.slice(0, 3);
out.pass = out.fixtureIsTheHardCase && out.parkIsDrawn && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
