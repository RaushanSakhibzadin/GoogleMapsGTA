/* HOW LONG BEFORE YOU ARE DRIVING.

   Three rounds of "fix the map load" and no test had ever measured the thing
   being complained about. The saved logs did: a session on a real phone was
   still on the loading screen at forty-nine seconds, and every mock in this
   suite answers instantly, so the whole suite ran green through all of it.

   So this one serves the captured session's own latencies. Timings are from
   the 13 August Belgrade log — streets back in 1.4 s, buildings in 3.6, the
   landmark sweep in 4.7 — with the skeleton at what 8.7 MB costs on the
   1.6 MB/s that log measured, and a second and a half for each tile of the
   opening ring.

   Two things have to be true, and the second is why this is not just a stopwatch:

     1. you are driving within the budget, on a road, in the city you asked for
     2. everything that was skipped to get you there still turns up afterwards

   Deferring work is only an answer if the work still happens. A load that hits
   the budget by quietly never fetching the ring or the landmarks would pass on
   the first count and fail the game.

   Usage: node tests/firstload.mjs
*/
import { chromium, devices } from 'playwright';
import { CHROME, GAME, SHOTS } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4489;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// what the captured session actually waited for, in milliseconds
const MS = { geocode: 370, streets: 1411, buildings: 3601, pois: 4693, arterials: 5400, tile: 1500 };
const BUDGET_MS = 12000;      // from pressing DRIVE to holding the wheel

const boxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};
const centreOf = b => ({ x: ((b.w + b.e) / 2 - LON0) * M_LON, y: -((b.s + b.n) / 2 - LAT0) * M_LAT });
const kindOf = q => /"building"/.test(q) ? 'buildings'
                  : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois'
                  : /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
                  : 'streets';

// a grid of streets around whatever centre was asked for, ids keyed off it
const streetsAt = (cx, cy) => {
  const tag = Math.abs(Math.round(cx / 10) * 100000 + Math.round(cy / 10));
  const els = [];
  for (const dy of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 1e9 + tag * 10 + (dy + 600) / 300,
      tags: { highway: 'residential', name: `EW ${Math.round(cy + dy)}` },
      geometry: [toLL(cx - 900, cy + dy), toLL(cx + 900, cy + dy)] });
  for (const dx of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 2e9 + tag * 10 + (dx + 600) / 300,
      tags: { highway: 'residential', name: `NS ${Math.round(cx + dx)}` },
      geometry: [toLL(cx + dx, cy - 900), toLL(cx + dx, cy + 900)] });
  els.push({ type: 'node', id: 3e9 + tag, lat: LAT0 - cy / M_LAT, lon: LON0 + cx / M_LON,
             tags: { place: 'suburb', name: 'Savski venac' } });
  return { elements: els };
};
const ARTERIALS = { elements: [
  { type: 'way', id: 90001, tags: { highway: 'motorway', name: 'E75' },
    geometry: [toLL(-55000, -20000), toLL(55000, -20000)] },
  { type: 'way', id: 90002, tags: { highway: 'trunk', name: 'Ibarska' },
    geometry: [toLL(-20000, -55000), toLL(-20000, 55000)] },
] };
const LANDMARKS = { elements: [
  { type: 'node', id: 80001, lat: LAT0 + 0.02, lon: LON0 + 0.01, tags: { shop: 'car_repair', name: 'Servis' } },
  { type: 'node', id: 80002, lat: LAT0 - 0.01, lon: LON0 + 0.02, tags: { amenity: 'hospital', name: 'Bolnica' } },
  { type: 'node', id: 80003, lat: LAT0 + 0.01, lon: LON0 - 0.02, tags: { amenity: 'police', name: 'Policija' } },
] };

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ ...devices['iPhone 13'] });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));

const asked = { streets: [], buildings: 0, pois: 0, arterials: 0 };
await p.route('**/nominatim.openstreetmap.org/**', async r => {
  await sleep(MS.geocode);
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Savski venac, Beograd' }]));
});
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = kindOf(q), box = boxOf(q);
  const c = box ? centreOf(box) : { x: 0, y: 0 };
  const tile = `${Math.round(c.x / 1800)},${Math.round(c.y / 1800)}`;
  if (kind === 'arterials') { asked.arterials++; await sleep(MS.arterials); return r.fulfill(json(ARTERIALS)); }
  if (kind === 'pois') { asked.pois++; await sleep(MS.pois); return r.fulfill(json(LANDMARKS)); }
  if (kind === 'buildings') { asked.buildings++; await sleep(MS.buildings); return r.fulfill(json({ elements: [] })); }
  // the opening tile is the one that must be quick; its neighbours are the ring
  const first = asked.streets.length === 0;
  asked.streets.push(tile);
  await sleep(first ? MS.streets : MS.tile);
  return r.fulfill(json(streetsAt(c.x, c.y)));
});

await p.goto(GAME);
await p.waitForTimeout(300);

const out = { budgetMs: BUDGET_MS, latencies: MS };
const t0 = Date.now();
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 120000 });
out.msToPlay = Date.now() - t0;

/* Driving, not merely 'play'. A loading screen that comes down over an empty
   world would hit any budget you like. */
out.atStart = await p.evaluate(async () => {
  const w = window.__w(), q = window.__p();
  window.__tp(0, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let best = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      best = Math.max(best, window.__p().spd);
      performance.now() - t0 < 2500 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  return { city: w.name, roads: w.roads, procedural: w.procedural,
           onRoad: window.__onRoad(0, 0), topKmh: Math.round(best * 3.6) };
});
out.streetsAtStart = asked.streets.length;

/* AND THE REST OF IT STILL ARRIVES. Whatever the loading screen stopped waiting
   for has to turn up behind it, or "faster" just means "less". */
await p.waitForTimeout(22000);
out.after = await p.evaluate(() => {
  const c = window.__chunks();
  return { tiles: c.loaded, roaded: c.roaded, roads: c.roads, pois: c.pois,
           skel: c.skel, wideMap: c.wideMap };
});
out.ringArrived = asked.streets.length >= 6;
out.landmarksArrived = out.after.pois > 0;
out.skeletonArrived = !!out.after.skel;
out.repair = await p.evaluate(() => window.__nearestPOI('repair'));

await p.screenshot({ path: `${SHOTS}/shot-firstload.png` });
out.errs = errs.slice(0, 5);
out.pass =
  out.msToPlay < BUDGET_MS &&
  // a real city, drivable, at the wheel
  out.atStart.procedural === false && out.atStart.roads > 0 &&
  out.atStart.onRoad === true && out.atStart.topKmh > 200 &&
  // and nothing was dropped on the floor to get there
  out.ringArrived && out.landmarksArrived && out.skeletonArrived &&
  !!out.repair && !out.errs.length;

console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
