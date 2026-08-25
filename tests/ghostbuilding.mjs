/* BUILDINGS THAT ARE NOT THERE.
 *
 * Reported from Savamala with a screenshot of a lit block standing across the
 * road and "there is no building in the real world, i just checked". That
 * district is Beograd na vodi, where a city's under-construction towers cluster,
 * and the parser accepted `building` with ANY value: `building=construction`
 * came out as a solid slab, and so did `building=no`, whose entire meaning is
 * "this is not a building".
 *
 * The tags are served through a mocked Overpass, all on the same plot and all
 * large enough to survive the shed filter, so the only thing separating them is
 * the tag under test. What the world ends up holding is then asked directly —
 * pixels would not tell a missing tower from one hidden behind another.
 *
 * THE REAL ONE IS THE POINT OF THE TEST. A filter that drops everything passes
 * "the ghost is gone" perfectly, so an ordinary `building=yes` and an
 * `apartments` go out in the same reply and have to arrive.
 *
 * And the LIFECYCLE PREFIXES are checked too — `demolished:building=yes` is a
 * different key, so it never matched and needs no code, which is worth pinning
 * down rather than leaving to be rediscovered.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4530;                 // Savamala
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* A 30 m square at (x, y), which is 900 m2 — well over the 22 m2 the parser
   throws away as a shed, so nothing here is dropped for its size. */
const box = (id, x, y, tags) => ({
  type: 'way', id, tags,
  geometry: [toLL(x, y), toLL(x + 30, y), toLL(x + 30, y + 30), toLL(x, y + 30), toLL(x, y)]
});

/* Spread along a line so no two overlap: overlapping footprints would still all
   be in W.buildings, but a human reading a failure wants them apart. */
const CASES = [
  ['yes',                    { building: 'yes' },                      true],
  ['apartments',             { building: 'apartments', name: 'Blok' }, true],
  ['construction',           { building: 'construction' },             false],
  ['proposed',               { building: 'proposed' },                 false],
  ['planned',                { building: 'planned' },                  false],
  ['no',                     { building: 'no' },                       false],
  ['demolished',             { building: 'demolished' },               false],
  ['razed',                  { building: 'razed' },                    false],
  ['destroyed',              { building: 'destroyed' },                false],
  ['abandoned',              { building: 'abandoned' },                false],
  ['disused',                { building: 'disused' },                  false],
  ['CONSTRUCTION (shouting)', { building: 'CONSTRUCTION' },            false],
  ['building:part=no',       { 'building:part': 'no' },                false],
  ['building:part=yes',      { 'building:part': 'yes' },               true],
  /* Prefixed keys: these never matched `t.building` and need no code at all. */
  ['demolished:building',    { 'demolished:building': 'yes' },         false],
  ['was:building',           { 'was:building': 'apartments' },         false],
  ['razed:building',         { 'razed:building': 'house' },            false]
];

const buildings = () => ({ elements: CASES.map((c, i) => box(9000 + i, -400 + i * 60, 120, c[1])) });
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Karađorđeva' },
    geometry: [toLL(-700, 0), toLL(700, 0)] },
  { type: 'way', id: 2, tags: { highway: 'residential', name: 'Braće Krsmanović' },
    geometry: [toLL(0, -400), toLL(0, 400)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Савамала' } }
] });

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Savamala, Beograd' }])
}));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const body = /"building"/.test(q) ? buildings()
             : /motorway/.test(q) && !/residential/.test(q) ? { elements: [] }
             : /historic|tourism|amenity|shop/.test(q) ? { elements: [] }
             : streets();
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
/* The opening buildings ride in behind the wheel, so this waits for them rather
   than for the loading screen. */
await p.waitForFunction(() => W.buildings.length > 0, null, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(1500);

const out = {};
out.world = await p.evaluate(ids => {
  const have = new Set(W.buildings.map(b => b.id));
  return { total: W.buildings.length, present: ids.map(i => have.has(i)) };
}, CASES.map((_, i) => 9000 + i));

out.cases = CASES.map((c, i) => ({ tag: c[0], want: c[2], got: out.world.present[i] }));
out.wrong = out.cases.filter(c => c.want !== c.got);
out.ghostsGone = out.cases.filter(c => !c.want).every(c => !c.got);
out.realOnesKept = out.cases.filter(c => c.want).every(c => c.got);

/* AND NOTHING IS STANDING IN THE ROAD. The tags above are the mechanism; this is
   the symptom that was reported. Every drivable centreline is sampled and asked
   whether it is inside a footprint that still collides — a building the game
   would drive you into. */
out.inTheRoad = await p.evaluate(() => {
  const hits = [];
  for (const r of W.driveRoads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (let s = 0; s <= Math.ceil(L / 6); s++) {
        const t = s / Math.ceil(L / 6);
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        for (const q of W.buildings) {
          if (q.passable) continue;
          if (x < q.bb.x0 || x > q.bb.x1 || y < q.bb.y0 || y > q.bb.y1) continue;
          if (pointInPoly(q.pts, x, y) && hits.length < 5) hits.push({ id: q.id, x: Math.round(x), y: Math.round(y) });
        }
      }
    }
  }
  return hits;
});
out.roadIsClear = out.inTheRoad.length === 0;

out.errs = errs.slice(0, 3);
out.pass = out.ghostsGone && out.realOnesKept && out.roadIsClear && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
