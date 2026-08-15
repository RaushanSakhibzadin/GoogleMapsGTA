import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const URL = GAME;
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* `node longdrive.mjs nofallback-off` refuses the wide skeleton, so the drive runs
   on the OLD streaming path — road tiles streaming in and being recycled behind
   you. That branch still exists for when no skeleton lands, and it evicts roads
   rather than just scenery, so it needs its own long drive. */
const REFUSE_SKELETON = process.argv[2] === 'no-skeleton';
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
function cityFor(s, w, n, e) {
  const projX = lon => (lon - LON0) * M_LON, projY = lat => -(lat - LAT0) * M_LAT;
  const x0 = projX(w), x1 = projX(e), y0 = projY(n), y1 = projY(s);
  const els = []; let id = Math.floor(Math.random() * 1e6);
  /* Snapped to absolute multiples of 180 m, NOT laid out from the corner of
     whatever box was asked for: relative to the box the lanes shift every time
     the box changes size, and this test drives east along y=0. When the skeleton
     request grew from a 72 km box to a 200 km one the nearest east-west road
     moved out from under the car, which it then spent the whole run correctly
     crawling beside. The world does not move when the request does, and neither
     should the fixture. */
  const snap = v => Math.ceil(v / 180) * 180;
  for (let x = snap(x0); x <= x1; x += 180)
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Av ${Math.round(x)}` }, geometry: [toLL(x, y0), toLL(x, y1)] });
  for (let y = snap(y0); y <= y1; y += 180)
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `St ${Math.round(y)}` }, geometry: [toLL(x0, y), toLL(x1, y)] });
  return { elements: els };
}
const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
const warns = [], errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { const t = m.type(); if (t === 'warning') warns.push(m.text()); else if (t === 'error') errs.push(m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }]) }));
await p.route('**/api/interpreter', async route => {
  const body = decodeURIComponent(route.request().postData() || '');
  const m = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (/amenity/.test(body) && !/highway/.test(body)) { await sleep(1500); return route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }); }
  if (isArterials(body) && REFUSE_SKELETON) return route.fulfill({ status: 504, contentType: 'text/plain', body: 'too big' });
  await sleep(400);
  if (/"building"/.test(body)) return route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' });
  const [, s, w, n, e] = m.map(Number);
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(cityFor(s, w, n, e)) });
});
await p.goto(URL);
await p.waitForTimeout(250);
await p.click('#go');
/* 90 s, not 40. In no-skeleton mode every mirror answers 504 and the ladder
   works through three rungs under a 55 s shared deadline before giving up — the
   game starting slowly is the point of that mode, not a fault. */
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.keyboard.down('w');
/* Drives until the tile budget is genuinely exceeded, not for a fixed twelve
   samples. Recycling only starts once more tiles have been loaded than the cap
   allows, so a run that happens to stop at eighteen never exercises the one
   thing this test exists for — and with no pass assertion it reported that as
   success. Bounded so a broken build still finishes. */
const samples = [];
for (let i = 0; i < 22; i++) {
  await p.waitForTimeout(12000);
  samples.push(await p.evaluate(() => {
    const c = window.__chunks(), q = window.__p();
    return { loaded: c.loaded, live: c.live, evicted: c.evicted, failed: c.failed,
             roads: c.roads, buildings: c.buildings, pois: c.pois,
             x: Math.round(q.x), y: Math.round(q.y), spd: Math.round(q.spd) };
  }));
  const c = samples[samples.length - 1];
  if (i >= 11 && c.evicted > 0 && c.loaded > 20) break;
}
await p.keyboard.up('w');
const fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

const last = samples[samples.length - 1], maxTiles = await p.evaluate(() => window.__chunks().maxTiles);
const dist = s => Math.hypot(s.x, s.y);
const skel = await p.evaluate(() => ({ skel: window.__chunks().skel, wideMap: window.__chunks().wideMap }));
const out = {
  mode: REFUSE_SKELETON ? 'no-skeleton' : 'skeleton', ...skel,
  // the refusal has to actually take effect, or this run silently retests the other path
  modeAsExpected: REFUSE_SKELETON ? (skel.skel === null && skel.wideMap === false)
                                  : (skel.skel !== null && skel.wideMap === true),
  samples, fps, maxTiles,
  // the bug: the world stopped growing and fence() pinned the car at the edge
  stillMoving: last.spd > 5,
  /* THE FURTHEST IT GOT, not where it happened to be at the end. Four minutes
     flat out into unstreamed ground gets the car wasted sooner or later, and a
     respawn puts it back at the start point — so end-versus-sample-3 was really
     measuring how long ago the last respawn was. Every build tested does it: one
     reset at sample 5 passed, the same reset at sample 10 failed, and the code
     under test was identical. What this is actually asking is whether the world
     kept growing enough for the car to keep going, and the high-water mark
     answers that without caring when it last died. */
  keptTravelling: Math.max(...samples.map(dist)) > dist(samples[3]) + 1500,
  tilesPastTheOldCap: last.loaded > maxTiles,
  budgetHeld: samples.every(s => s.live <= maxTiles),
  recycled: last.evicted > 0,
  // eviction has to bound the arrays, not just the tile count
  roadsBounded: Math.max(...samples.map(s => s.roads)) < samples[3].roads * 3,
  /* AND WITH A WIDE MAP IT MUST NOT TAKE THE ROADS WITH IT. Recycling a district
     gives back its scenery; its streets stay, because un-marking a road from the
     drivable mask cannot be done cell by cell and the only correct alternative is
     to clear the mask and re-mark every road in the world — which at skeleton
     scale would run on nearly every tile load, for ever. So in skeleton mode
     the road count only ever goes up, even across the evictions this run causes.
     In no-skeleton mode the streets ARE the world and they go with their tile,
     which is why that mode is exempt. */
  roadsSurviveEviction: REFUSE_SKELETON ||
    samples.every((s, i) => i === 0 || s.roads >= samples[i - 1].roads),
  landmarksSurvive: last.pois >= samples[3].pois,
  failed: last.failed,
  warnCount: warns.length, warns: warns.slice(0, 8), errs,
};
/* This never had one, so its exit code meant "the script ran" and every flag
   below had to be read by eye — which is how two of them sat at false through a
   whole suite run without anything noticing.

   The 504s are not faults: no-skeleton mode serves them itself, to every mirror,
   which is the whole definition of that mode. Counting the fixture as a failure
   is how the first version of this assertion failed a run in which every single
   thing it cared about was true. */
const realErrs = errs.filter(e => !/504|Gateway Timeout/.test(e));
out.pass = out.modeAsExpected && out.stillMoving && out.keptTravelling &&
           out.tilesPastTheOldCap && out.budgetHeld && out.recycled &&
           out.roadsBounded && out.roadsSurviveEviction && out.landmarksSurvive &&
           out.failed === 0 && out.fps >= 45 && realErrs.length === 0;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
