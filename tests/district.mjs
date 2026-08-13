/* "PLS LOOK WHY NO ROADS."

   A screenshot from Репиште, a residential district of Belgrade: buildings drawn
   all around the car, not one street between them, the car stopped on what the
   game considered open ground. The saved log said exactly what had happened —
   seventeen Overpass replies, and after the first forty seconds every single one
   of them was `buildings`. Streets were requested for three tiles and then never
   again, while scenery kept streaming for seven.

   That was deliberate, and wrong. Once an arterial skeleton landed the streamer
   switched to scenery only, on the reasoning that the skeleton was the road
   network and there was nothing left to ask for. But the skeleton is arterials —
   motorway, trunk, primary, secondary — because residential lanes are most of a
   city's ways and asking for them over a 200 km box is a query no server will
   answer. Residential lanes are also every street in the district you live in.
   One tile out of the detailed opening ring and the skeleton has nothing to say.

   So: drive out to a district the opening ring never covered, and see whether it
   arrives with streets in it. The skeleton here is one motorway 80 km away, so
   nothing it contains can mark the ground under the car — if the car ends up on
   a road out there, a streamed tile is what put it there.

   Usage: node tests/district.mjs
*/
import { chromium } from 'playwright';
import { CHROME, GAME, SHOTS } from './harness.mjs';

const LAT0 = 44.7726, LON0 = 20.4137;                 // Репиште, Beograd
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const boxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};
// world metres of a bbox centre, which is the tile it belongs to
const centreOf = b => ({ x: ((b.w + b.e) / 2 - LON0) * M_LON, y: -((b.s + b.n) / 2 - LAT0) * M_LAT });

const kindOf = q => /building/.test(q) ? 'buildings'
                  : /amenity/.test(q) ? 'pois'
                  : /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
                  : 'streets';

/* Every tile is the same little grid of residential streets, drawn around
   whatever centre was asked for, with ids derived from that centre so the
   duplicate filter keeps them apart. A road runs exactly through the middle,
   which is where the car gets put. */
const streetsAt = (cx, cy) => {
  const tag = Math.round(cx / 10) * 100000 + Math.round(cy / 10);
  const els = [];
  for (const dy of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 1e9 + Math.abs(tag) * 10 + (dy + 600) / 300,
      tags: { highway: 'residential', name: `EW ${Math.round(cy + dy)}` },
      geometry: [toLL(cx - 900, cy + dy), toLL(cx + 900, cy + dy)] });
  for (const dx of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 2e9 + Math.abs(tag) * 10 + (dx + 600) / 300,
      tags: { highway: 'residential', name: `NS ${Math.round(cx + dx)}` },
      geometry: [toLL(cx + dx, cy - 900), toLL(cx + dx, cy + 900)] });
  return { elements: els };
};

/* The skeleton: one motorway, 80 km north, running east-west. Far enough that it
   cannot mark a single cell anywhere the car will be, so "the car is on a road"
   can only ever mean a streamed street. */
const SKEL = { elements: [
  { type: 'way', id: 90001, tags: { highway: 'motorway', name: 'E75' },
    geometry: [toLL(-150000, -80000), toLL(150000, -80000)] },
  { type: 'node', id: 90002, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Репиште' } }
] };

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));

// what was asked for, and where — the log's own evidence, reproduced
const asked = { streets: [], buildings: [], arterials: 0 };
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Репиште' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = kindOf(q), box = boxOf(q);
  const c = box ? centreOf(box) : { x: 0, y: 0 };
  const tile = `${Math.round(c.x / 1800)},${Math.round(c.y / 1800)}`;
  if (kind === 'arterials') { asked.arterials++; return r.fulfill(json(SKEL)); }
  if (kind === 'pois') return r.fulfill(json({ elements: [] }));
  if (kind === 'buildings') { asked.buildings.push(tile); return r.fulfill(json({ elements: [] })); }
  asked.streets.push(tile);
  return r.fulfill(json(streetsAt(c.x, c.y)));
});

await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(500);

const out = {};
out.skeleton = await p.evaluate(() => window.__chunks().skel);
out.wideMap = await p.evaluate(() => window.__chunks().wideMap);
out.openingTiles = asked.streets.length;

/* OUT TO THE DISTRICT. Tile (0,3) is 5.4 km south — four tiles past the far edge
   of the opening 3x3 ring, so nothing about it was loaded before play started.
   The car is parked at its exact centre, which is a crossroads in the fixture. */
const FAR = { x: 0, y: 5400 };
await p.evaluate(f => window.__tp(f.x, f.y, 0), FAR);

// the streamer takes one tile at a time on a cooldown, so give it room
const t0 = Date.now();
let onRoad = false;
while (Date.now() - t0 < 45000) {
  onRoad = await p.evaluate(f => window.__onRoad(f.x, f.y), FAR);
  if (onRoad) break;
  await p.waitForTimeout(500);
}
out.waitedSecs = +((Date.now() - t0) / 1000).toFixed(1);
out.onRoadOutThere = onRoad;
out.streetsAskedFor = asked.streets;
out.buildingsAskedFor = asked.buildings;
// tiles whose streets have landed, which is the number the report was about
out.roadedTiles = await p.evaluate(() => window.__chunks().roaded);

/* And it has to be DRIVABLE, not merely drawn. Hold the throttle down at the
   crossroads: on a road that is most of the top speed, off it the off-road
   penalty pins the car at walking pace, which is exactly what the screenshot
   showed at 0 km/h. */
out.drive = await p.evaluate(async f => {
  window.__tp(f.x, f.y, 0);
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let best = 0, offFrames = 0, n = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p();
      best = Math.max(best, q.spd);
      if (!q.onRoad) offFrames++;
      n++;
      performance.now() - t0 < 5000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  return { topKmh: Math.round(best * 3.6), offPct: Math.round(offFrames / n * 100) };
}, FAR);

/* Driving back off again must not take the street with it. Reported, not
   asserted: the tile budget is not exceeded over a hop this short, so nothing is
   actually recycled here and a pass would mean nothing. The real version of this
   is roadsSurviveEviction in longdrive.mjs, which drives until the budget
   genuinely overflows and then checks the road count never falls. */
await p.evaluate(() => window.__tp(0, 25000, 0));
await p.waitForTimeout(9000);
out.evicted = await p.evaluate(() => window.__chunks().evicted);
out.stillOnRoadAfterHop = await p.evaluate(f => window.__onRoad(f.x, f.y), FAR);

await p.screenshot({ path: `${SHOTS}/shot-district.png` });
out.errs = errs.slice(0, 5);

out.pass =
  // the skeleton landed, so this is the case that was broken
  !!out.skeleton && out.wideMap === true &&
  // the district arrived with streets in it
  out.onRoadOutThere === true &&
  // asked for, by name, rather than inferred from the mask
  out.streetsAskedFor.includes('0,3') &&
  // and it is a road you can drive, not a line drawn on the ground
  out.drive.topKmh > 200 && out.drive.offPct < 10 &&
  !out.errs.length;

console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
