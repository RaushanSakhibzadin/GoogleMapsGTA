/* "It crawls even on roads now."

   The off-road penalty keys off onRoad(), which reads the 8 m drivable mask.
   Before the penalty existed a hole in that mask cost nothing — off-road was
   96 km/h, near enough to on-road that you would never notice. Now every hole
   is a car that stops dead on visible tarmac.

   So: sample the mask along the centreline of every drivable road that was
   actually drawn, and report where the two disagree. Diagonal streets and a
   junction, because that is what the report showed. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const LAT0 = 44.8125, LON0 = 20.4612;                     // Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

let id = 1;
const way = (cls, name, pts) => ({ type: 'way', id: id++,
  tags: { highway: cls, name }, geometry: pts.map(([x, y]) => toLL(x, y)) });

/* A Belgrade-ish tangle: an orthogonal grid, two diagonal boulevards cutting
   across it, and a mix of classes including the ones that are NOT drivable. */
function fixture() {
  const els = [];
  for (let k = -4; k <= 4; k++) {
    els.push(way(k % 2 ? 'residential' : 'secondary', `EW ${k}`,
      [[-1500, k * 160], [1500, k * 160]]));
    els.push(way(k % 2 ? 'residential' : 'tertiary', `NS ${k}`,
      [[k * 160, -1500], [k * 160, 1500]]));
  }
  // the diagonals — the shape under the car in the screenshot
  els.push(way('primary', 'Kraljice Natalije', [[-1400, -900], [1400, 900]]));
  els.push(way('secondary', 'Kneza Milosa', [[-1400, 900], [1400, -900]]));
  els.push(way('service', 'Service lane', [[-600, 40], [600, 40]]));
  els.push(way('living_street', 'Living street', [[-600, -40], [600, -40]]));
  // drawn but deliberately NOT drivable, so the report can name them
  els.push(way('pedestrian', 'Knez Mihailova', [[-400, 80], [400, 80]]));
  els.push({ type: 'node', id: id++, lat: LAT0, lon: LON0,
    tags: { place: 'city', name: 'Beograd' } });
  return { elements: els };
}

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q) || /"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)))
    return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(fixture()));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};

/* Walk every road the game holds and ask the mask about points ON its
   centreline. A drivable road whose own centreline reads as off-road is the
   bug; a pedestrian street reading off-road is correct and is listed apart. */
out.coverage = await p.evaluate(() => {
  const roads = window.__roadList();
  const bad = [], okByCls = {}, badByCls = {};
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b2 = r.pts[i + 1];
      const len = Math.hypot(b2.x - a.x, b2.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 12));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b2.x - a.x) * t, y = a.y + (b2.y - a.y) * t;
        const on = window.__onRoad(x, y);
        const key = r.cls + (r.drive ? '' : ' (not drivable)');
        if (on) okByCls[key] = (okByCls[key] || 0) + 1;
        else {
          badByCls[key] = (badByCls[key] || 0) + 1;
          if (r.drive && bad.length < 6) bad.push({ cls: r.cls, name: r.name, x: Math.round(x), y: Math.round(y) });
        }
      }
    }
  }
  return { okByCls, badByCls, sampleHoles: bad };
});

/* And the thing the player actually feels: drive a straight line down a road
   and count the frames the game thinks you are off it. */
async function drive(label, x, y, h, secs = 8) {
  return p.evaluate(async ([label, x, y, h, secs]) => {
    window.__tp(x, y, h);
    await new Promise(r => requestAnimationFrame(r));
    const t0 = performance.now();
    let frames = 0, off = 0, best = 0, worstAfterStart = 999;
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const q = window.__p();
        frames++; if (!q.onRoad) off++;
        best = Math.max(best, q.spd);
        if (performance.now() - t0 > 2000) worstAfterStart = Math.min(worstAfterStart, q.spd);
        performance.now() - t0 < secs * 1000 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    window.__setInput(null);
    return { label, offFrames: +(off / frames * 100).toFixed(1) + '%',
             topKmh: Math.round(best * 3.6), dipKmh: Math.round(worstAfterStart * 3.6) };
  }, [label, x, y, h, secs]);
}

out.alongEW = await drive('east along a secondary', -1200, 0, 0);
out.alongNS = await drive('south along a tertiary', 0, -1200, Math.PI / 2);
// the diagonal, which is the shape in the screenshot
out.alongDiag = await drive('down the diagonal primary', -1200, -771, Math.atan2(900 * 2, 1400 * 2));

/* THE REPORTED CASE. A pedestrian street is drawn with the same kerb, casing
   and colour as any road — and OSM maps a city square as one — but it is not in
   the road network, so onRoad() says no. Standing on painted tarmac and
   crawling is what the screenshot showed. */
out.onPedestrian = await drive('along a drawn pedestrian street', -380, 80, 0, 6);
out.pedestrianDoesNotCrawl = out.onPedestrian.topKmh > 120;

/* And the other half: genuinely open ground must still be a crawl, or the fix
   has simply deleted the feature. */
out.inAField = await drive('across open ground', -1200, 600, 0, 6);
/* Judged on where it SETTLES, not on its peak. Each run is teleported straight
   from the end of the last one and keeps the speed it had, so the first second
   here is the previous scenario's momentum bleeding off — a peak of 60 km/h
   with the car sitting at 14 for the rest of the run. dipKmh is the slowest
   reading after the first two seconds, which is the number "crawls" means. */
out.fieldStillCrawls = out.inAField.dipKmh < 25;

// just off the kerb is not off-road: a metre of slack, or every clipped corner
// reads as the car breaking
out.justOffKerb = await p.evaluate(() => {
  const r = {};
  for (const d of [0, 5, 8, 12, 20, 40]) r[d + 'm'] = window.__onRoadPenalty(-1200, d);
  return r;
});

out.errs = errs.slice(0, 4);
out.pass = out.alongEW.offFrames === '0%' && out.alongNS.offFrames === '0%' &&
           out.alongDiag.offFrames === '0%' && out.alongEW.topKmh > 300 &&
           out.pedestrianDoesNotCrawl && out.fieldStillCrawls &&
           !out.justOffKerb['5m'] && !out.justOffKerb['8m'] && out.justOffKerb['40m'] &&
           !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
