/* Originally: "it stuck / car almost do not move" — 14 km/h with the throttle
   down. At the time off-road settled at accel/1.5 ≈ 96 km/h, so a crawl had to
   be something actively cancelling velocity. It was the world fence; see
   fencepin.mjs, which is the regression test for it.

   Kept as a diagnostic, and its expectations have moved: off-road is now
   deliberately a crawl (~15 km/h) unless GHOST is on, so a low number in the
   off-road rows below is the intended behaviour rather than the bug. The rows
   that still matter here are `onRoad`, which must stay at the top of the clock,
   and the building rows, which must not pin the car. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8069, LON0 = 20.4735;                      // Krunski venac, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (x0, y0, x1, y1) =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLL(x, y));

let id = 1;
function fixture() {
  const els = [];
  for (const y of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: y === 0 ? 'secondary' : 'residential', name: `EW ${y}` },
      geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
      geometry: [toLL(x, -600), toLL(x, 600)] });

  // A: a big solid block in the middle of a field — the "sat in the green" case.
  els.push({ type: 'way', id: 5001, tags: { building: 'yes', 'building:levels': '4' },
    geometry: ring(-80, 40, 80, 130) });
  // B: two overlapping blocks, the classic wedge — pushed out of one, into the other
  els.push({ type: 'way', id: 5002, tags: { building: 'yes' }, geometry: ring(200, 40, 300, 130) });
  els.push({ type: 'way', id: 5003, tags: { building: 'yes' }, geometry: ring(260, 60, 360, 150) });
  // C: a long wall to drive into head-on
  els.push({ type: 'way', id: 5004, tags: { building: 'yes' }, geometry: ring(-400, -260, -100, -200) });
  els.push({ type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } });
  return { elements: els };
}
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const atCentre = r => {
  const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return true;
  return Math.abs((+m[1] + +m[3]) / 2 - LAT0) < 3e-3 && Math.abs((+m[2] + +m[4]) / 2 - LON0) < 4e-3;
};
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(atCentre(r) ? fixture() : { elements: [] }));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = { buildings: await p.evaluate(() => window.__w().buildings) };

/* Park the car somewhere, hold the throttle for `secs`, and report what it did.
   Traffic is teleported far away first so nothing else is in the picture. */
async function hold(label, x, y, h, secs = 5) {
  const r = await p.evaluate(async ([x, y, h, secs]) => {
    for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
    window.__tp(x, y, h);
    await new Promise(r => requestAnimationFrame(r));
    const x0 = window.__p().x, y0 = window.__p().y;
    const t0 = performance.now();
    let best = 0, sum = 0, n = 0;
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const q = window.__p();
        best = Math.max(best, q.spd); sum += q.spd; n++;
        performance.now() - t0 < secs * 1000 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const q = window.__p();
    window.__setInput(null);
    return { endKmh: Math.round(q.spd * 3.6), topKmh: Math.round(best * 3.6),
             meanKmh: Math.round(sum / n * 3.6),
             movedM: +Math.hypot(q.x - x0, q.y - y0).toFixed(1),
             hp: Math.round(q.hp), insideNow: window.__inside(q.x, q.y) };
  }, [x, y, h, secs]);
  return { label, ...r };
}

// control: open ground, off the road, nothing in the way
out.openGround = await hold('open field', -500, 400, 0);
// the reported case: dropped in the middle of a big solid block
out.insideBlock = await hold('deep inside a building', 0, 85, 0);
// the wedge: standing in the overlap of two buildings
out.inWedge = await hold('overlap of two buildings', 280, 95, 0);
// leaning on a wall, throttle down
out.intoWall = await hold('nose against a wall', -250, -190, Math.PI / 2);
// and the sane case, on tarmac
out.onRoad = await hold('on the road', -500, 0, 0);
// the same spots with the perk on, for comparison
await p.evaluate(() => window.__ghost(true));
out.ghostOpenGround = await hold('open field · GHOST', -500, 400, 0);
out.ghostInsideBlock = await hold('inside a building · GHOST', 0, 85, 0);
await p.evaluate(() => window.__ghost(false));

await p.screenshot({ path: `${OUT}/shot-crawl.png` });
out.errs = errs.slice(0, 5);
console.log(JSON.stringify(out, null, 1));
await b.close();
