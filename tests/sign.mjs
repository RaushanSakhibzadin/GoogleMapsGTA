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
    geometry: ring(230, 290, -40, -80) },
  /* Two ways for a place to be somewhere you eat, and both have to reach the
     ink. 7006 is tagged on the BUILDING — a restaurant that owns its own
     premises — and 7007 is a nameless block with a cafe inside it, which is how
     most of a real high street is mapped. */
  { type: 'way', id: 7006, tags: { building: 'commercial', height: '9',
                                   amenity: 'restaurant', name: 'KOD BATE' },
    geometry: ring(300, 360, -40, -80) },
  { type: 'way', id: 7007, tags: { building: 'apartments', height: '14' },
    geometry: ring(370, 430, -40, -80) }
] };
/* The garage is one of the three things the game has gameplay for, so it comes
   down with the landmark sweep and becomes a POI. The supermarket is not, and
   rides with the BUILDINGS of the tile it stands in — which is where shopfronts
   belong, because a fascia can only be read from the street it is on, and
   because asking the sixty-kilometre sweep for every named shop turned a 145 KB
   reply into five megabytes of twelve thousand bakeries. Both have to reach a
   building, by their different routes. */
const POIS = { elements: [
  { type: 'node', id: 5001, ...toLL(110, -60), tags: { shop: 'car_repair', name: 'AUTO CENTAR' } }
] };
const SHOPS = [
  { type: 'node', id: 5002, ...toLL(180, -60), tags: { shop: 'supermarket', name: 'IDEA' } },
  // no name: must not put a blank sign on anything
  { type: 'node', id: 5003, ...toLL(250, -60), tags: { shop: 'bakery' } },
  { type: 'node', id: 5004, ...toLL(400, -60), tags: { amenity: 'cafe', name: 'KAFANA' } }
];

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
             : kind === 'buildings' ? { elements: BUILDINGS.elements.concat(SHOPS) }
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
  W.buildings.filter(b => !b.mono).map(b => ({ id: b.id, sign: b.sign || '', food: !!b.food })));
out.ownName = out.named.some(b => b.id === 7001 && b.sign === 'GRAND CASINO ADMIRAL');
out.cyrillic = out.named.some(b => b.id === 7002 && b.sign === 'Панда');
out.shopLendsItsName = out.named.some(b => b.id === 7003 && b.sign === 'AUTO CENTAR');
out.shopfrontNamesIt = out.named.some(b => b.id === 7004 && b.sign === 'IDEA');
// a shop with no name must leave the wall alone rather than sign it with ''
out.namelessStaysBlank = out.named.some(b => b.id === 7005 && b.sign === '');
/* ---- and somewhere you eat is known to be one ----
   Asked of the TAGS rather than of the name, so it works in any language: the
   Belgrade kafana and a Tokyo kissaten are both amenity=cafe and nothing in the
   game has to know either word. Both routes in — tagged on the building, and
   lent by a shopfront node inside it — and the ordinary shops must NOT be
   flagged, or every sign in the city goes yellow and the distinction is gone. */
out.eateries = out.named.filter(b => b.food).map(b => b.id).sort();
out.knowsWhereYouEat =
  out.named.some(b => b.id === 7006 && b.sign === 'KOD BATE' && b.food) &&
  out.named.some(b => b.id === 7007 && b.sign === 'KAFANA' && b.food) &&
  !out.named.some(b => (b.id === 7001 || b.id === 7004) && b.food);
/* AND THE SUPERMARKET IS NOT A LANDMARK. It exists to letter a wall; a beacon
   over every corner shop would make the radar useless and the skyline worse. */
out.shopsAreNotPois = await p.evaluate(() =>
  W.pois.filter(q => /IDEA|KAFANA|bakery/i.test(q.name || '')).length === 0 &&
  // the garage, and nothing else, is a landmark
  W.pois.length === 1 &&
  // the two NAMED shopfronts — the supermarket and the cafe. The nameless
  // bakery is not one: a blank sign is worse than no sign.
  W.shops.length === 2);

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
  /* PER CHANNEL, NOT THE SUM OF THE THREE.

     This summed R+G+B and asked for a change of 90, on the stated reasoning
     that the glyphs are white on a dark rim so a sign pixel is one that got
     markedly brighter or darker than the wall behind it. That reasoning died
     with the white glyphs: the daylight ink is now a mid blue, which against a
     wall of roughly its own brightness moves the sum by almost nothing while
     moving the blue channel by a great deal. The test would have gone on
     passing on the strength of the rim alone, and would have reported a city
     with no lettering in it as a city with lettering.

     The distance between two colours is the measurement that does not care
     which colour the ink is. */
  let lit = 0, inkR = 0, inkG = 0, inkB = 0, n = 0;
  for (let i = 0; i < A.length; i += 4) {
    const dr = A[i] - B[i], dg = A[i + 1] - B[i + 1], db = A[i + 2] - B[i + 2];
    if (Math.hypot(dr, dg, db) < 55) continue;
    lit++;
    /* The ink, read off the pixels that got BRIGHTER in blue — the glyph faces
       rather than the black rim around them, which moves every channel down. */
    if (db > 20) { inkR += A[i]; inkG += A[i + 1]; inkB += A[i + 2]; n++; }
  }
  return { w, h, lit, glyphs: n,
           ink: n ? [inkR / n, inkG / n, inkB / n].map(v => Math.round(v)) : null };
});
out.sign = shot;
out.signsAreDrawn = shot.lit > 400;
/* AND THE DAYLIGHT INK IS BLUE. Everything above is satisfied by lettering of
   any colour, including the white this replaced, so without this the change the
   player asked for is untested. Asserted as a relationship between the channels
   rather than against a number, because the wall colour underneath and the fog
   both shift the absolute values. */
out.blueByDay = !!shot.ink && shot.glyphs > 100 &&
                shot.ink[2] > shot.ink[0] * 1.5 && shot.ink[2] > shot.ink[1] * 1.2;

/* ---- 1c. and a restaurant's name is yellow ----

   A SECOND CAMERA, because the one above is parked in front of the ordinary
   blocks and the two eateries are two hundred metres along the street from
   them. Same A/B — the frame with the names and the frame without — and the
   glyph pixels picked out by COLOUR DISTANCE, the same ink-agnostic rule section
   1 uses. Picking them by a rise in luma was the first attempt and it quietly
   favoured one answer: yellow is a bright ink and blue is a dark one, so a fixed
   luma rise found 297 yellow pixels and only 36 blue ones, and the blue reading
   fell under its own count bar. A rule that finds more of the colour it was
   tuned for is not a rule, it is the conclusion.

   Asserted as a relationship between channels rather than against numbers: the
   wall behind, the sun on it and the fog all move the absolute values, and none
   of them can turn blue letters yellow. */
out.foodShot = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const settle = n => { for (let i = 0; i < n; i++) window.__px3(0, 0, 1, 1); };
  const read = () => {
    window.__tp(365, 40, -Math.PI / 2);
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
    let r = 0, g = 0, bl = 0, n = 0;
    for (let i = 0; i < A.length; i += 4) {
      const dr = A[i] - B[i], dg = A[i + 1] - B[i + 1], db = A[i + 2] - B[i + 2];
      if (Math.hypot(dr, dg, db) < 55) continue;
      r += A[i]; g += A[i + 1]; bl += A[i + 2]; n++;
    }
    return { n, ink: n ? [r / n, g / n, bl / n].map(v => Math.round(v)) : null };
  };
  state = 'pause';
  const food = read();
  /* AND THE SAME CAMERA WITH THE FLAG TAKEN AWAY, which is the A/B that makes
     this mean anything: without it a yellow reading could be the afternoon sun
     on a cream wall rather than the ink. Same buildings, same names, same
     frame — one boolean apart. */
  const keepFood = W.buildings.map(b => b.food);
  for (const b of W.buildings) b.food = false;
  dropAllCells();
  const plain = read();
  W.buildings.forEach((b, i) => { b.food = keepFood[i]; });
  dropAllCells();
  settle(60);
  state = 'play';
  return { food, plain };
});
out.foodIsYellow =
  out.foodShot.food.n > 100 && out.foodShot.plain.n > 100 &&
  // yellow: red and green well clear of blue
  out.foodShot.food.ink[0] > out.foodShot.food.ink[2] * 1.4 &&
  out.foodShot.food.ink[1] > out.foodShot.food.ink[2] * 1.3 &&
  // and the very same signs without the flag are the ordinary blue
  out.foodShot.plain.ink[2] > out.foodShot.plain.ink[0] * 1.4;

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
           out.signsAreDrawn && out.blueByDay && out.knowsWhereYouEat && out.foodIsYellow && out.staysOnTheWall && out.longNamesGetWider &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
