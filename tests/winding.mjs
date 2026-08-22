/* A BUILDING MUST NOT DEPEND ON WHICH WAY ROUND ITS OUTLINE IS LISTED.
 *
 * Reported as "some buildings look like walls", with a photograph of a block
 * that had become an open book standing in the street: two facades meeting at a
 * crease, no near wall, the far walls seen from behind.
 *
 * OpenStreetMap has no convention for the direction of a building's outline.
 * Counted on the bundled Stari grad capture: 1855 of 3502 buildings are listed
 * one way round and 1647 the other, so roughly half of every European city
 * arrives clockwise. The renderer worked out the outward normal from the
 * winding and used it for the lighting and the window grid — but the GPU decides
 * what to cull from the order the triangle's corners arrive in, and that order
 * was taken straight from the direction the outline was walked. Clockwise
 * buildings therefore got correct normals on triangles the hardware discarded,
 * and you looked into them from behind.
 *
 * IT IS ALSO WHY WINDOWS FLICKERED, which was reported in the same breath and
 * looks like a separate fault. 89% of the buildings in that capture share a wall
 * with a neighbour, coplanar to the centimetre, and a depth buffer cannot choose
 * between two surfaces at the same depth. Culling normally settles it for free —
 * of two coincident walls facing opposite ways exactly one is front-facing. But
 * an inside-out building draws the wall its neighbour also draws, both at once,
 * in two different colours with two different window phases. The pair swap as
 * the camera moves, which is a facade flickering between two buildings.
 *
 * HOW IT IS MEASURED. The same block, from the same place, with the same light,
 * rendered twice — and between the two frames nothing changes except that every
 * footprint in the world is reversed in place. Nothing about a building's
 * appearance may depend on that. It is a stronger statement than any threshold
 * on a screenshot, because the two frames should be IDENTICAL, and on the build
 * that had the fault they differ across 8.6% of the picture, against half a
 * per cent of seam here.
 *
 * Reversal alone would still pass if both directions were broken in the same
 * way, so section 2 anchors it against something absolute: a magenta post is
 * walled up inside each block, and a block you can see it through is not a
 * block.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* Both directions are present in the fixture from the start, so the first frame
   already contains one of each and the fault is on screen before anything is
   reversed. */
const ring = (x0, x1, y0, y1, rev) => {
  const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (rev) p.reverse();
  p.push(p[0]);
  return p.map(q => toLL(q[0], q[1]));
};
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Blokovska' },
    geometry: [toLL(-800, 0), toLL(800, 0)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } }
] });
/* Two tall blocks, listed opposite ways round, and a low one whose roof is below
   the driver's eye — so the roof's own facing is in the frame as well as the
   walls'.

   And inside each tall block, sealed in on all four sides and eight metres under
   its roof, a post painted a magenta that appears nowhere else in this game.
   Whether any of it reaches the screen is section 2. */
const post = (cx, cy) => ({ type: 'way', id: 7100 + cx,
  tags: { building: 'yes', height: '16', 'building:colour': '#ff00ff' },
  geometry: ring(cx - 8, cx + 8, cy - 8, cy + 8, false) });
const BUILDINGS = { elements: [
  { type: 'way', id: 7001, tags: { building: 'residential', height: '24' },
    geometry: ring(-70, -30, -40, -80, false) },
  { type: 'way', id: 7002, tags: { building: 'residential', height: '24' },
    geometry: ring(30, 70, -40, -80, true) },
  { type: 'way', id: 7003, tags: { building: 'retail', height: '4' },
    geometry: ring(-14, 14, -46, -66, true) },
  post(-50, -60), post(50, -60)
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
             : (/historic/.test(q) || /amenity/.test(q)) && !/highway/.test(q) ? 'pois' : 'streets';
  const body = kind === 'streets' ? streets()
             : kind === 'buildings' ? BUILDINGS : { elements: [] };
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

/* The fixture really does contain one of each direction — asserted, because a
   fixture that quietly became all-anticlockwise would turn the whole of this
   into a test that passes on anything. */
out.setup = await p.evaluate(() => {
  const bs = W.buildings.filter(b => !b.mono);
  return { buildings: bs.length, windings: bs.map(b => windingOf(b.pts)),
           heights: bs.map(b => +b.h.toFixed(1)) };
});
out.bothDirections = out.setup.windings.includes(1) && out.setup.windings.includes(-1);

/* Both frames come from one paused evaluate. Unpausing between two shots lets
   the world run — traffic drives across the frame — and a tenth of the picture
   changes for reasons that have nothing to do with what is being measured. With
   the clock held still, two consecutive frames differ by 0.03%. */
const shot = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  // south of the blocks, looking north at them
  window.__tp(0, 70, -Math.PI / 2);
  state = 'pause';
  const settle = n => { for (let i = 0; i < n; i++) window.__px3(0, 0, 1, 1); };
  settle(60);
  const A = window.__px3(0, 0, w, h);
  /* THE ONE THING THAT CHANGES. reverse() in place, then every cached mesh is
     dropped so the geometry is rebuilt from the reversed outlines — one cell per
     frame, which is what the settle is for. */
  for (const b of W.buildings) b.pts.reverse();
  dropAllCells();
  settle(60);
  const B = window.__px3(0, 0, w, h);
  const after = W.buildings.filter(b => !b.mono).map(b => windingOf(b.pts));
  state = 'play';

  let moved = 0, big = 0;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) +
              Math.abs(A[i + 2] - B[i + 2]);
    if (d > 12) moved++;
    if (d > 90) big++;
  }

  /* THE BRICKED-UP POST. Magenta survives any amount of shading as magenta —
     the two ends of the spectrum together and almost nothing in the middle —
     which no masonry, tarmac, grass or sky in this game does. A count above
     zero means a wall that should be between the camera and that post is not
     being drawn. */
  const magenta = px => {
    let n = 0;
    for (let i = 0; i < px.length; i += 4)
      if (px[i] > 90 && px[i + 2] > 90 && px[i + 1] < 0.5 * Math.min(px[i], px[i + 2])) n++;
    return n;
  };
  const total = A.length / 4;
  return { w, h, after,
           movedPct: +(100 * moved / total).toFixed(2),
           swappedPct: +(100 * big / total).toFixed(2),
           postA: magenta(A), postB: magenta(B) };
});

/* ---- 1. reversing every outline changes nothing on screen ---- */
out.reversed = shot.after;
out.reallyReversed = String(shot.after) === String(out.setup.windings.map(v => -v));
out.diff = { movedPct: shot.movedPct, swappedPct: shot.swappedPct };
/* NOT ZERO, AND THE TWO NUMBERS ARE NOT EQUALLY INTERESTING. The roof
   triangulator walks the polygon, so a reversed outline splits the same roof
   from different corners and the pixels along the seam between a roof triangle
   and the wall top under it can land either way. That is a one-pixel line, but
   it is a long one, and how many of those pixels cross a threshold depends on
   how different a roof and a wall look — which is why moving the sun into the
   southern sky took this from 0.17 to 0.54 without anything about the geometry
   changing: the wall facing the camera became the LIT one, so the seam gained
   contrast. Measured across builds: 0.17 before the signs existed, 0.16 with
   them, 0.54 with the sun moved.

   swappedPct is the one carrying the assertion. A whole surface appearing or
   disappearing is what the fault did, and that measured 8.6% of the frame moved
   with 6.1% wholly repainted — two orders of magnitude above the seam. */
out.sameEitherWay = shot.movedPct < 1.5 && shot.swappedPct < 0.2;

/* ---- 2. and the boxes are solid, in both directions ---- */
out.post = { a: shot.postA, b: shot.postB };
out.solid = shot.postA === 0 && shot.postB === 0;

out.errs = errs.slice(0, 3);
out.pass = out.bothDirections && out.reallyReversed && out.sameEitherWay &&
           out.solid && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
