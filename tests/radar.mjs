/* Finding a repair shop.

   Reported as "I cannot find any repair shop". The log said there were 226 of
   them within the loaded world and the nearest was 543 m away, so they were
   loading fine — they were just invisible. Landmarks were baked into the
   pre-rendered map at five pixels, and the radar scales that map down to fit
   230 m across a 98 px phone display: the dot lands under two pixels.

   So this test reads the radar's own pixels. Anything softer — "the POI is in
   W.pois", "the draw call ran" — would have passed happily on the build nobody
   could find a garage in. */
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
  ...[-3, -2, -1, 0, 1, 2, 3].map(k => ({ type: 'way', id: id++,
    tags: { highway: k ? 'residential' : 'secondary', name: `EW ${k}` },
    geometry: [toLL(-900, k * 150), toLL(900, k * 150)] })),
  ...[-3, -2, -1, 0, 1, 2, 3].map(k => ({ type: 'way', id: id++,
    tags: { highway: 'residential', name: `NS ${k}` },
    geometry: [toLL(k * 150, -900), toLL(k * 150, 900)] })),
  { type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } },
] });
/* One garage close enough for a blip, one far away for the rim pointer, and a
   hospital and a police station so the colours have to be told apart. */
const NEARBY = { x: 120, y: 0 }, FAR = { x: 1500, y: -900 };
const pois = () => ({ elements: [
  { type: 'node', id: 7001, ...toLL(NEARBY.x, NEARBY.y), tags: { shop: 'car_repair', name: 'Blizu' } },
  { type: 'node', id: 7002, ...toLL(FAR.x, FAR.y), tags: { shop: 'car_repair', name: 'Daleko' } },
  { type: 'node', id: 7003, ...toLL(-140, 60), tags: { amenity: 'hospital', name: 'Bolnica' } },
  { type: 'node', id: 7004, ...toLL(60, -160), tags: { amenity: 'police', name: 'Policija' } },
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
  if (isArterials(q) || /"building"/.test(q)) return r.fulfill(json({ elements: [] }));
  if (isPois(q)) return r.fulfill(json(pois()));
  return r.fulfill(json(streets()));
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(800);

const out = {};
out.pois = await p.evaluate(() => window.__pois());
out.nearest = await p.evaluate(() => window.__nearestPOI('repair'));

/* Count pixels of a given hue on the radar canvas. The repair green is #48ff9e,
   the hospital red #ff4f6d, the police blue #3fa2ff — far enough apart that a
   loose match cannot confuse them. */
const scan = () => p.evaluate(() => {
  const cv = document.getElementById('mini');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const cx = cv.width / 2, cy = cv.height / 2, R = cv.width / 2;
  let green = 0, red = 0, blue = 0, greenRim = 0, pink = 0, pinkRim = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    const r = d[i], gg = d[i + 1], bb = d[i + 2];
    const rad = Math.hypot(x - cx, y - cy);
    if (rad > R) continue;
    if (gg > 170 && r < 150 && bb > 90 && bb < 210) {          // #48ff9e
      green++;
      if (rad > R * .72) greenRim++;                            // out at the edge
    } else if (r > 190 && gg < 140 && bb > 180) {              // #ff4fd8, the objective
      pink++;
      if (rad > R * .72) pinkRim++;
    } else if (r > 190 && gg < 140 && bb > 70 && bb < 160) red++;
    else if (bb > 190 && r < 130 && gg > 110 && gg < 200) blue++;
  }
  return { green, greenRim, red, blue, pink, pinkRim, size: cv.width };
});

// standing where the near garage, the hospital and the police station are all
// inside the radar, and the far garage is not
await p.evaluate(() => { window.__tp(0, 0, 0); });
await p.waitForTimeout(400);
out.atStart = await scan();

/* Now somewhere with NO landmark in range, so the only green left must be the
   rim pointer aimed at the far garage. */
out.awayFrom = await p.evaluate(() => { window.__tp(1500, 900, 0); return window.__nearestPOI('repair'); });
await p.waitForTimeout(400);
out.away = await scan();

// and the pointer has to move to the correct side when the car turns
const bearingAt = h => p.evaluate(async (hh) => {
  window.__tp(1500, 900, hh);
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  const cv = document.getElementById('mini');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const cx = cv.width / 2, cy = cv.height / 2, R = cv.width / 2;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (d[i + 1] > 170 && d[i] < 150 && d[i + 2] > 90 && d[i + 2] < 210 &&
        Math.hypot(x - cx, y - cy) > R * .72) { sx += x - cx; sy += y - cy; n++; }
  }
  return n ? { deg: Math.round(Math.atan2(sy, sx) * 180 / Math.PI), n } : null;
}, h);
/* The radar rotates with the car, so turning through 180° has to swing the
   pointer through 180° too. Facing north the shop sits at -148°, facing south at
   +31° — a 179° swing, which is the whole point. (The first version of this
   line asked for a difference near ZERO and called a perfect result a failure.) */
/* THE OBJECTIVE ON THE RADAR. Reported as "there is no violet arrow on the
   minimap", and that was exactly right: the blip existed, it was just never in
   range. Everything on this radar lives inside 230 m, a delivery is routinely a
   kilometre off, and the one thing the player is actually driving towards was
   the only thing with no pointer — while a repair shop, which is a suggestion,
   had one.

   The pickup pink is #ff4fd8 and the hospital red is #ff4f6d: identical in red
   and green, so the two can only be told apart on the blue channel, which is why
   the matcher keys on it. */
await p.evaluate(() => {
  window.__tp(0, 0, 0);
  MISSION.state = 'pickup';
  MISSION.pick = { x: 900, y: 240 };          // ~930 m: four times the radar's reach
});
await p.waitForTimeout(400);
out.objFar = await scan();
await p.evaluate(() => { MISSION.pick = { x: 40, y: 25 }; });   // and now well inside it
await p.waitForTimeout(400);
out.objNear = await scan();
// far: a pointer out on the rim. near: a blip, and nothing on the rim.
out.objectiveHasRimPointer = out.objFar.pinkRim > 6;
out.objectiveBlipsWhenClose = out.objNear.pink > 6 && out.objNear.pinkRim === 0;
/* BOTH POINTERS, AIMED THE SAME WAY. The two rim pointers are drawn one after
   the other and the objective goes last, so before this it simply painted over
   the garage whenever the two bearings agreed — and on a grid, the job is very
   often up the road you would take to get repaired anyway.

   This is the deterministic version of a failure that used to arrive as noise.
   radar.mjs failed about one run in eighteen, always on `away.greenRim`, which
   measured anywhere between 4 and 157 pixels depending on where that run's
   random delivery happened to land; four is the tip of a green triangle poking
   out from under a pink one. So: park the car at the origin, put the objective
   directly on top of the garage's bearing, and require both to survive. */
out.sameWay = await p.evaluate(() => {
  // the same corner the garage pointer was measured from, where nothing is in
  // blip range and both marks have to be pointers or they are not there at all
  window.__tp(1500, 900, 0);
  const rep = window.__nearestPOI('repair');
  const dx = rep.x - 1500, dy = rep.y - 900;
  const d = Math.hypot(dx, dy) || 1;
  MISSION.state = 'pickup';
  // twice as far, along the very same line out from the car
  MISSION.pick = { x: 1500 + dx / d * d * 2, y: 900 + dy / d * d * 2 };
  return { rep: { x: +rep.x.toFixed(1), y: +rep.y.toFixed(1) },
           repM: +d.toFixed(1),
           pick: { x: +MISSION.pick.x.toFixed(1), y: +MISSION.pick.y.toFixed(1) } };
});
await p.waitForTimeout(400);
out.stacked = await scan();
out.pointersDoNotHideEachOther = out.stacked.greenRim > 6 && out.stacked.pinkRim > 6;

await p.evaluate(() => { MISSION.state = 'none'; MISSION.pick = null; });
await p.waitForTimeout(200);

out.facingA = await bearingAt(-Math.PI / 2);
out.facingB = await bearingAt(Math.PI / 2);
out.swingDeg = out.facingA && out.facingB
  ? Math.abs(((out.facingA.deg - out.facingB.deg + 540) % 360) - 180) : null;
out.pointerTurnsWithTheCar = out.swingDeg != null && out.swingDeg > 140;

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

await p.screenshot({ path: `${OUT}/shot-radar.png` });
await p.locator('#mini').screenshot({ path: `${OUT}/shot-radar-mini.png` });
out.errs = errs.slice(0, 4);
out.pass =
  out.pois.length === 4 && out.nearest && out.nearest.name === 'Blizu' &&
  out.atStart.green > 6 && out.atStart.red > 4 && out.atStart.blue > 4 &&   // all three kinds visible
  out.away.greenRim > 6 &&                                                  // the rim pointer
  out.pointerTurnsWithTheCar &&
  out.objectiveHasRimPointer && out.objectiveBlipsWhenClose &&
  out.pointersDoNotHideEachOther &&
  out.fps >= 50 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
