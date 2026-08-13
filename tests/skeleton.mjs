// The 18 km world: one wide load at the start, then nothing but scenery.
import { chromium } from 'playwright';
import { fakeOSM } from './fake.mjs';
import { fakeArterials, kindOf, bboxOf } from './wide.mjs';
import { CHROME, GAME, ROOT } from './harness.mjs';

const OUT = process.env.SHOTS || '/tmp';
const URL = GAME;
const LAT0 = 25.7825, LON0 = -80.1300;
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });

// Reject the widest box so the ladder has to step down to 9 km.
const MODE = process.argv[2] || 'normal';

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

const reqs = [];                       // every Overpass call, in order
let playing = false;                   // flipped once state === 'play'

await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Miami Beach' }])));

await p.route('**/api/interpreter', route => {
  const q = decodeURIComponent(route.request().postData() || '');
  const kind = kindOf(q), bbox = bboxOf(q);
  const halfKm = bbox ? Math.round((bbox[2] - bbox[0]) * 110540 / 2 / 100) / 10 : 0;
  reqs.push({ kind, halfKm, afterPlay: playing });

  if (kind === 'arterials') {
    // the fallback scenario: the widest box is refused, smaller ones are fine
    if (MODE === 'fallback' && halfKm > 12) return route.fulfill({ status: 504, body: 'too big' });
    return route.fulfill(json(fakeArterials(bbox)));
  }
  if (kind === 'pois') return route.fulfill(json({ elements: [] }));
  return route.fulfill(json(fakeOSM(bbox)));    // streets + buildings both
});

await p.goto(URL);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
playing = true;
await p.waitForTimeout(600);

const out = { mode: MODE };

// ---------- 1. a wide skeleton landed, and the world is that big ----------
out.world = await p.evaluate(() => {
  const c = window.__chunks();
  return { skel: c.skel, bounds: c.bounds, roads: c.roads, drive: c.drive,
           grid: c.grid, wideMap: c.wideMap, fixed: c.fixed.length,
           roadIds: c.roadIds, vbuckets: c.vbuckets, dbuckets: c.dbuckets };
});
const wantR = MODE === 'fallback' ? 18000 : 36000;
const span = out.world.bounds.x1 - out.world.bounds.x0;
out.world.halfSpanKm = Math.round(span / 2 / 100) / 10;
out.world.rightSize = Math.abs(span / 2 - wantR) < 400;

// ---------- 2. the request that was actually sent ----------
const art = reqs.filter(r => r.kind === 'arterials');
out.arterialRequests = art.map(r => r.halfKm);
out.laddered = MODE === 'fallback'
  ? art.length >= 2 && art[0].halfKm > 24 && art[art.length - 1].halfKm <= 24
  : art.length === 1 && art[0].halfKm > 34;

// ---------- 3. THE invariant: no roads are ever requested again ----------
// Drive for a while, crossing tile boundaries, and watch what goes out.
const before = reqs.length;
out.drive = await p.evaluate(async () => {
  const log = [];
  // start well outside the detailed centre, on the skeleton
  window.__tp(6000, 6000, 0);
  await new Promise(r => setTimeout(r, 400));
  for (let leg = 0; leg < 6; leg++) {
    window.__tp(6000 + leg * 1200, 6000, 0);
    await new Promise(r => setTimeout(r, 900));
    const p2 = window.__p();
    log.push({ x: Math.round(p2.x), y: Math.round(p2.y), onRoad: window.__onRoad(p2.x, p2.y) });
  }
  return log;
});
await p.waitForTimeout(3500);            // let any queued side fetches actually fire
const after = reqs.slice(before);
out.afterPlay = {
  total: after.length,
  kinds: [...new Set(after.map(r => r.kind))],
  streets: after.filter(r => r.kind === 'streets').length,
  arterials: after.filter(r => r.kind === 'arterials').length,
  buildings: after.filter(r => r.kind === 'buildings').length,
};
out.noRoadsAfterPlay = out.afterPlay.streets === 0 && out.afterPlay.arterials === 0;

// ---------- 4. it is a real, drivable place 12 km from the start ----------
out.farOut = await p.evaluate(async () => {
  window.__tp(12000, 0, 0);
  await new Promise(r => setTimeout(r, 700));
  // find tarmac and sit on it, then drive
  const before = window.__p();
  for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
  const mid = window.__p();
  const c = window.__chunks();
  return {
    placedAt: { x: Math.round(before.x), y: Math.round(before.y) },
    onRoadThere: window.__onRoad(12000, 0),
    insideFence: Math.abs(mid.x) < c.bounds.x1 && Math.abs(mid.y) < c.bounds.y1,
    traffic: mid.traffic, street: window.__nav().street, zone: window.__nav().zone,
  };
});

// ---------- 5. the radar stayed usable, and it follows ----------
out.radar = await p.evaluate(async () => {
  const a = window.__chunks();
  window.__tp(12000, 6000, 0);
  await new Promise(r => setTimeout(r, 500));
  const b = window.__chunks();
  return { scale: b.mapScale, whole: b.mapWhole,
           originMoved: a.mapOrigin.x !== b.mapOrigin.x || a.mapOrigin.y !== b.mapOrigin.y,
           origin: b.mapOrigin };
});
out.radarUsable = out.radar.scale >= 0.2;

// ---------- 6. frame rate, with the whole skeleton loaded ----------
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 2000 ? requestAnimationFrame(tick) : r(Math.round(n / 2)); };
  requestAnimationFrame(tick);
}));

await p.screenshot({ path: `${OUT}/shot-skeleton-${MODE}.png` });
// In the fallback scenario the 504s ARE the scenario — the browser logs every
// refused fetch. Anything else is a real error.
const real = errs.filter(e => !(MODE === 'fallback' && /504|Gateway/.test(e)));
out.errs = real.slice(0, 6);
out.noisyErrs = errs.length - real.length;
out.pass = out.world.rightSize && out.laddered && out.noRoadsAfterPlay &&
           out.radarUsable && out.fps >= 45 && !real.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
