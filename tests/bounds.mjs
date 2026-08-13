/* Regression test for "city too small / buildings disappeared / areas won't load".
   Overpass returns the FULL geometry of anything touching the box it was asked
   for, so ONE overhanging way used to stretch the world to +-150 km, shrink the
   city to a speck on the radar and blow the collision mask up to millions of
   cells. The world must be sized by the tiles and the skeleton, never by geometry.

   This used to be written around a 300 km river, because water is how the bug
   first bit us. Water is gone from the game now — but the hazard was never the
   water, it was the overhang, and a motorway way runs just as far. Same test,
   same assertions, a road doing the overhanging. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const URL = GAME;
const LAT0 = 44.8125, LON0 = 20.4489;                 // Brankov Most, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = pts => pts.concat([pts[0]]).map(([x, y]) => toLL(x, y));
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const LONG = 150000;                                   // 300 km end to end, as OSM really has it

const grid = () => ({ els: (() => {
  const els = []; let id = 1;
  for (const y of [-600, -400, -200, 0, 200, 400, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Cross ${y}` }, geometry: [toLL(-800, y), toLL(800, y)] });
  for (const x of [-600, -400, -200, 0, 200, 400, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Ave ${x}` }, geometry: [toLL(x, -800), toLL(x, 800)] });
  return els;
})() });

const buildings = () => {
  const els = []; let id = 9000;
  for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) {
    const bx = i * 200 + 40, by = j * 200 + 40;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '5' },
      geometry: ring([[bx, by], [bx + 80, by], [bx + 80, by + 80], [bx, by + 80]]) });
  }
  return { elements: els };
};

// The two shapes an overhanging way arrives in: an open line (a motorway running
// out of the city) and a closed ring (a landuse or building outline drawn huge).
const overhang = mode => mode === 'line'
  ? { type: 'way', id: 500, tags: { highway: 'motorway', name: 'E75' },
      geometry: [toLL(-LONG, 60), toLL(LONG, 60)] }
  : { type: 'way', id: 501, tags: { landuse: 'industrial', name: 'Corridor' },
      geometry: ring([[-LONG, -300], [LONG, -300], [LONG, 300], [-LONG, 300]]) };

const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

async function run(browser, mode) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const msgs = [];
  p.on('pageerror', e => msgs.push('PAGEERROR ' + String(e).slice(0, 110)));
  p.on('console', m => { if (m.type() === 'error') msgs.push(m.text().slice(0, 110)); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Brankov Most' }])));
  await p.route('**/api/interpreter', r => {
    const body = decodeURIComponent(r.request().postData() || '');
    if (/amenity/.test(body) && !/highway/.test(body)) return r.fulfill(json({ elements: [] }));
    if (/"building"/.test(body)) {
      const b = buildings();
      // the ring form rides in with the scenery, where landuse is parsed
      if (mode === 'ring') b.elements.push(overhang(mode));
      return r.fulfill(json(b));
    }
    /* The skeleton gets the long motorway too — it is exactly the kind of way that
       spans a country, and the widest box is where it is most tempting to trust the
       geometry. In ring mode it gets the plain grid instead, whose ids the detailed
       centre already has: every road is deduped away and the skeleton merges
       nothing, which still has to size the world to its rectangle. */
    if (isArterials(body)) {
      const els = grid().els.slice();
      if (mode === 'line') els.push(overhang(mode));
      return r.fulfill(json({ elements: els }));
    }
    const els = grid().els.slice();
    if (mode === 'line') els.push(overhang(mode));
    return r.fulfill(json({ elements: els }));
  });
  await p.goto(URL);
  await p.waitForTimeout(200);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(7000);
  const st = await p.evaluate(() => {
    const c = window.__chunks(), w = window.__w();
    const b = c.bounds;
    return { spanKmX: +((b.x1 - b.x0) / 1000).toFixed(2), spanKmY: +((b.y1 - b.y0) / 1000).toFixed(2),
             grid: w.grid, buildings: c.buildings, roads: c.roads,
             live: c.live, failed: c.failed, skelR: c.skel && c.skel.r,
             // the overhanging way is still THERE and still drivable where it crosses
             onRoadNearby: window.__onRoad(0, 60), fps: 0 };
  });
  await p.close();
  const cells = st.grid.split('x').map(Number).reduce((a, b) => a * b, 1);
  /* The world is the skeleton's rectangle -- 18 km each way, so 36 km across --
     and NOTHING else may set it. The overhanging way in this fixture is 300 km
     long; if it ever reaches the bounds again the span jumps by an order of
     magnitude, which is precisely the bug this test exists for. The window either
     side of 36 km is deliberately tight: "sane" has to mean "the tiles and the
     skeleton decided this", not merely "smaller than catastrophe". */
  const skelKm = st.skelR ? st.skelR * 2 / 1000 : 0;
  return { mode, ...st, cells, skelKm,
    boundsSane: Math.abs(st.spanKmX - skelKm) < 0.2 && Math.abs(st.spanKmY - skelKm) < 0.2,
    longWayDidNotSetBounds: st.spanKmX < 80,
    /* 9010^2 is 81 million cells for a 72 km world -- but the mask is two bits
       a cell now, so that is 20 MB of memory, not 81. The ceiling is on CELLS,
       which is what an overhanging way would blow up. */
    gridSane: cells < 90e6,
    keptBuildings: st.buildings > 0,
    msgs };
}

const b = await chromium.launch({ executablePath: CHROME });
const out = [];
for (const mode of ['line', 'ring']) out.push(await run(b, mode));
console.log(JSON.stringify(out, null, 1));
await b.close();
