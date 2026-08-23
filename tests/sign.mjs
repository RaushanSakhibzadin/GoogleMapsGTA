/* THE NAME OVER THE DOOR — that it is there, that it is on the wall, and that
 * it is the right name.
 *
 * OpenStreetMap already knows what a great many of these buildings are called:
 * 329 of the 3502 in the bundled Stari grad capture carry a name of their own,
 * and the shops inside the rest carry theirs. Painting those across the facades
 * is the cheapest thing that can be done with data the game was downloading
 * anyway, and the difference between a city and a heap of boxes.
 *
 * It is also the only part of this renderer that draws TEXT, which WebGL cannot
 * do — the letters are painted with a 2D canvas into an atlas and each sign is
 * one quad reading one cell of it. That is three things that can silently go
 * wrong and produce a frame with nothing visibly missing: the atlas cell can be
 * mapped to the wrong rectangle, the quad can be built from the letters'
 * proportions incorrectly, and the name can come from the wrong building.
 *
 * So the measurements are:
 *
 *   1. A NAME PUTS PIXELS ON A WALL. The same frame, twice, with the names
 *      cleared in between and the geometry rebuilt — anything that changes is a
 *      sign and can be nothing else.
 *   2. THE LETTERS STAY ON THEIR BUILDING. Asserted as geometry rather than by
 *      eye, over every signed building in the fixture: a sign is never wider
 *      than the wall carrying it, never taller than the storey it sits under,
 *      and never below the pavement.
 *   3. A LONG NAME IS SHRUNK, NOT SQUASHED. The first version scaled the glyphs
 *      horizontally to fit the atlas cell, which turned GRAND CASINO ADMIRAL
 *      into a picket fence. A longer name must come out WIDER on the wall, not
 *      the same width with thinner letters.
 *   4. THE SHOP LENDS THE BLOCK ITS NAME, which is where most real names are.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (x0, x1, y0, y1) => {
  const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  p.push(p[0]);
  return p.map(q => toLL(q[0], q[1]));
};

const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Bulevar' },
    geometry: [toLL(-900, 0), toLL(900, 0)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } }
] });
/* A long Latin name, a short Cyrillic one — both scripts come out of the same
   font stack and a sign that only works in ASCII is no use in Belgrade — and a
   nameless block with a named shop inside it for section 4. */
const BUILDINGS = { elements: [
  { type: 'way', id: 7001, tags: { building: 'commercial', height: '18', name: 'GRAND CASINO ADMIRAL' },
    geometry: ring(-140, -50, -40, -80) },
  { type: 'way', id: 7002, tags: { building: 'retail', height: '8', name: 'Панда' },
    geometry: ring(-20, 40, -40, -70) },
  { type: 'way', id: 7003, tags: { building: 'apartments', height: '16' },
    geometry: ring(70, 150, -40, -80) },
  { type: 'way', id: 7004, tags: { building: 'apartments', height: '15' },
    geometry: ring(160, 220, -40, -80) },
  { type: 'way', id: 7005, tags: { building: 'apartments', height: '15' },
    geometry: ring(230, 290, -40, -80) }
] };
/* A garage AND a supermarket. The garage is one of the three things the game has
   gameplay for and becomes a POI; the supermarket is not, and is fetched purely
   so a facade can carry the name that is really on it — Belgrade's ground floors
   are SUPER VOK and IDEA, and a street of them with blank walls is not that
   street. Both must reach a building, by different routes. */
const POIS = { elements: [
  { type: 'node', id: 5001, ...toLL(110, -60), tags: { shop: 'car_repair', name: 'AUTO CENTAR' } },
  { type: 'node', id: 5002, ...toLL(180, -60), tags: { shop: 'supermarket', name: 'IDEA' } },
  // no name: must not put a blank sign on anything
  { type: 'node', id: 5003, ...toLL(250, -60), tags: { shop: 'bakery' } }
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
             : (/historic/.test(q) || /amenity/.test(q) || /shop/.test(q)) && !/highway/.test(q) ? 'pois'
             : 'streets';
  const body = kind === 'streets' ? streets()
             : kind === 'buildings' ? BUILDINGS
             : kind === 'pois' ? POIS : { elements: [] };
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

/* ---- 4. the shop lends the block its name ---- */
/* Read first, because it is a fact about the world rather than about a frame,
   and because it is also this test's proof that the fixture arrived intact. */
out.named = await p.evaluate(() =>
  W.buildings.filter(b => !b.mono).map(b => ({ id: b.id, sign: b.sign || '' })));
out.ownName = out.named.some(b => b.id === 7001 && b.sign === 'GRAND CASINO ADMIRAL');
out.cyrillic = out.named.some(b => b.id === 7002 && b.sign === 'Панда');
out.shopLendsItsName = out.named.some(b => b.id === 7003 && b.sign === 'AUTO CENTAR');
out.shopfrontNamesIt = out.named.some(b => b.id === 7004 && b.sign === 'IDEA');
// a shop with no name must leave the wall alone rather than sign it with ''
out.namelessStaysBlank = out.named.some(b => b.id === 7005 && b.sign === '');
/* AND THE SUPERMARKET IS NOT A LANDMARK. It exists to letter a wall; a beacon
   over every corner shop would make the radar useless and the skyline worse. */
out.shopsAreNotPois = await p.evaluate(() =>
  W.pois.filter(q => /IDEA|bakery/i.test(q.name || '')).length === 0 &&
  W.pois.length === 1 && W.shops.length === 1);

/* ---- 1. the names put pixels on the walls ---- */
/* Both frames from one paused evaluate, and the only thing that changes between
   them is the names. Nothing else in the scene has moved, so every pixel that
   differs is lettering. */
const shot = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const settle = n => { for (let i = 0; i < n; i++) window.__px3(0, 0, 1, 1); };
  window.__tp(0, 90, -Math.PI / 2);
  state = 'pause';
  settle(60);
  const A = window.__px3(0, 0, w, h);
  const keep = W.buildings.map(b => b.sign);
  for (const b of W.buildings) b.sign = '';
  dropAllCells();
  settle(60);
  const B = window.__px3(0, 0, w, h);
  W.buildings.forEach((b, i) => { b.sign = keep[i]; });
  dropAllCells();
  settle(60);
  state = 'play';
  let lit = 0;
  for (let i = 0; i < A.length; i += 4) {
    // the glyphs are white on a dark rim, so a sign pixel is one that got
    // markedly brighter or markedly darker than the bare wall behind it
    const d = (A[i] + A[i + 1] + A[i + 2]) - (B[i] + B[i + 1] + B[i + 2]);
    if (Math.abs(d) > 90) lit++;
  }
  return { w, h, lit };
});
out.sign = shot;
out.signsAreDrawn = shot.lit > 400;

/* ---- 2. and they stay on the building ---- */
/* Geometry, not pixels: signQuad is the same function the cell builder uses, so
   asking it directly is asking exactly what was drawn — and it can be asked
   about every signed building at once rather than the two that happen to be
   pointing at the camera. */
out.fit = await p.evaluate(() => {
  const bad = [];
  let checked = 0;
  for (const b of W.buildings) {
    if (!b.sign) continue;
    let base = Infinity;
    for (const q of b.pts) base = Math.min(base, terrainH(q.x, q.y));
    base -= 1;
    const foot = base + 1, top = terrainH(b.cx, b.cy) + b.h;
    const q = signQuad(b, b.pts, windingOf(b.pts), top, foot);
    if (!q) continue;
    checked++;
    const across = Math.hypot(q.R.x - q.L.x, q.R.z - q.L.z);
    if (across > q.wall * 0.801) bad.push([b.sign, 'wider than its wall', +across.toFixed(1), +q.wall.toFixed(1)]);
    if (q.y1 > top + 0.01) bad.push([b.sign, 'above the roof', +q.y1.toFixed(1), +top.toFixed(1)]);
    if (q.y0 < foot) bad.push([b.sign, 'below the pavement', +q.y0.toFixed(1), +foot.toFixed(1)]);
    if (q.h > (top - foot) * 0.35) bad.push([b.sign, 'taller than the facade allows', +q.h.toFixed(1)]);
  }
  return { checked, bad };
});
out.staysOnTheWall = out.fit.checked >= 3 && out.fit.bad.length === 0;

/* ---- 3. a long name is shrunk, not squashed ---- */
/* Two names on the same wall, one five times the length of the other. If the
   glyphs are being condensed to fit a fixed cell, both come out the same width
   and the long one is unreadable; if they are being set at a smaller size, the
   long one is wider and both are the same shape of letter. Ten per cent per
   extra character is far below what condensing would give (zero) and far below
   what proportional setting gives, so it separates the two without pinning the
   test to a font. */
out.shape = await p.evaluate(() => {
  const b = W.buildings.find(q => q.id === 7001);
  const top = terrainH(b.cx, b.cy) + b.h, foot = terrainH(b.cx, b.cy);
  const wide = n => {
    b.sign = n;
    const q = signQuad(b, b.pts, windingOf(b.pts), top, foot);
    return q ? +(q.w / q.h).toFixed(2) : null;
  };
  const short = wide('IDEA'), long = wide('GRAND CASINO ADMIRAL');
  b.sign = 'GRAND CASINO ADMIRAL';
  return { short, long };
});
out.longNamesGetWider = out.shape.short > 0 && out.shape.long > out.shape.short * 2;

out.errs = errs.slice(0, 3);
out.pass = out.ownName && out.cyrillic && out.shopLendsItsName &&
           out.shopfrontNamesIt && out.namelessStaysBlank && out.shopsAreNotPois &&
           out.signsAreDrawn && out.staysOnTheWall && out.longNamesGetWider &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
