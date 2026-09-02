/* THE TAG IS ACTUALLY ON THE WALL.
 *
 * casino.mjs checks that spraying a building claims it — b.turf, the count, the
 * colour on the map. None of that says a single pixel of paint was drawn, and
 * the thing that draws it is a fragment shader reading a seed packed into the
 * fraction of one float. That float has been re-packed twice: once to carry the
 * archway's burial depth in its whole part, and once again to move the seed
 * clear of both ends of the unit interval, because vTag is INTERPOLATED and a
 * wall carrying a flat 2.0 arrives at the shader as 1.9999998 as often as
 * 2.0000002 — fract() of the first is a seed of almost one on a wall nobody
 * ever sprayed. That mistake shipped, in the other branch reading the same
 * float: every building sunk half a metre into its terrain was drawn as flat
 * unlit paint for two commits, and nothing in this directory said so except
 * facade.mjs's edge count, which nobody had looked at.
 *
 * So: both directions, on the pixels.
 *   1. A SPRAYED WALL HAS INK ON IT, and the seed is what shapes it.
 *   2. AN UNSPRAYED WALL HAS NONE — the tag comes off again when the building
 *      is released, leaving the frame it started as.
 *
 * WHAT THIS FILE CANNOT SEE, and where to look instead. The fixture below is
 * flat ground, so every wall's burial is zero and vTag is exactly the seed:
 * the packing bug cannot express itself here at all, and this file passes
 * identically on a build carrying it. Measured, not assumed — both builds
 * report an ink band of 29 rows. The test that DOES catch it is facade.mjs,
 * which runs on the bundled city where the terrain is real and walls are sunk
 * 0.4 to 1.5 m: there the buggy build paints them flat and unlit and tags them
 * all over, and its window-edge ratio falls from 3.5 to 2.8. Which is the same
 * lesson the monument crash taught this suite — a synthetic fixture is flat,
 * square and zero in every field that a real city varies, and the bugs live in
 * exactly those fields.
 *
 * Usage: node tests/graffiti.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const W = 900, H = 600;
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (cx, cy, hw, hh) =>
  [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh], [cx - hw, cy - hh]]
    .map(([x, y]) => toLL(x, y));

/* One long block on the north side of a straight street, and the camera parked
   square on to it. Nothing else is in the shot, so every pixel that changes is
   that wall. */
const BLOCK = { cx: 0, cy: 60, hw: 90, hh: 18 };
function fixture() {
  const els = []; let id = 1;
  for (const y of [0, 240]) els.push({ type: 'way', id: id++,
    tags: { highway: 'secondary', name: 'Ulica ' + y }, geometry: [toLL(-500, y), toLL(500, y)] });
  for (const x of [-400, 400]) els.push({ type: 'way', id: id++,
    tags: { highway: 'residential', name: 'Ave ' + x }, geometry: [toLL(x, -200), toLL(x, 400)] });
  els.push({ type: 'way', id: 5001,
    tags: { building: 'yes', 'building:levels': '6' },
    geometry: ring(BLOCK.cx, BLOCK.cy, BLOCK.hw, BLOCK.hh) });
  els.push({ type: 'node', id: 9001, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } });
  return { elements: els };
}

const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const atCentre = r => {
  const m = decodeURIComponent(r.request().postData() || '')
    .match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return true;
  return Math.abs((+m[1] + +m[3]) / 2 - LAT0) < 3e-3 && Math.abs((+m[2] + +m[4]) / 2 - LON0) < 4e-3;
};

const br = await chromium.launch({ executablePath: CHROME });
const p = await br.newPage({ viewport: { width: W, height: H } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
await p.route('**/api/interpreter', r => r.fulfill(json(atCentre(r) ? fixture() : { elements: [] })));
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await br.close();
  process.exit(0);
}
await p.waitForTimeout(2200);

/* Parked on the street south of the block, facing it, and FROZEN — the same
   trick facade.mjs uses: update() stops, __px3 still renders on demand, so two
   grabs differ by exactly the flag that was changed between them. */
out.parked = await p.evaluate(B => {
  window.__tp(B.cx, B.cy - (B.hh + 26), Math.PI / 2);
  P.car.vx = P.car.vy = 0;
  return true;
}, BLOCK);
await p.waitForTimeout(2500);
await p.evaluate(() => { window.__noShadow(true); window.__keepG = state; state = 'pause'; window.__calm(); });
await p.evaluate(() => { for (let i = 0; i < 40; i++) window.__px3(0, 0, 1, 1); });

const grab = () => p.evaluate(a => Array.from(window.__px3(0, 0, a[0], a[1])), [W, H]);

/* ---------- 1. an unsprayed city takes the paint branch nowhere ---------- */
/* Two grabs of the same untouched frame, to establish what "identical" costs
   here before anything is compared against it. */
const clean1 = await grab();
const clean2 = await grab();
let drift = 0;
for (let i = 0; i < clean1.length; i += 4)
  if (Math.abs(clean1[i] - clean2[i]) + Math.abs(clean1[i + 1] - clean2[i + 1]) +
      Math.abs(clean1[i + 2] - clean2[i + 2]) > 12) drift++;
out.frameDrift = +(100 * drift / (W * H)).toFixed(3);

/* ---------- 2. spray it, and look ---------- */
/* THE SEED IS THE A/B, NOT THE CLAIM. Claiming a building repaints the whole
   thing in its team's colour, so "sprayed against not sprayed" is a 38% frame
   difference with the letters lost somewhere inside it. Held at the same team,
   the same colour and the same camera, and given two different seeds, the only
   thing that can differ is the pattern of ink — and a shader that had stopped
   reading the seed would give zero, which is the failure this is for. */
const paintWith = seed => p.evaluate(s => {
  const b = W.buildings.find(q => Math.abs(q.cy - 60) < 40 && q.h > 8);
  if (!b) return null;
  b.turf = 'black';
  if (!b.tag) b.tag = makeTag();
  b.tagSeed = s;
  resolveColours([b]);
  dirtyCellAt(b.cx, b.cy);
  return { turf: b.turf, seed: b.tagSeed, h: +b.h.toFixed(1) };
}, seed);

out.claimed = await paintWith(0.17);
await p.evaluate(() => { for (let i = 0; i < 24; i++) window.__px3(0, 0, 1, 1); });
const seedA = await grab();
// how much of the frame the claim itself moved, so the ink below is read against
// something rather than in the abstract
let recol = 0;
for (let i = 0; i < clean1.length; i += 4)
  if (Math.abs(clean1[i] - seedA[i]) + Math.abs(clean1[i + 1] - seedA[i + 1]) +
      Math.abs(clean1[i + 2] - seedA[i + 2]) > 12) recol++;
out.recolour = +(100 * recol / (W * H)).toFixed(2);

await paintWith(0.81);
await p.evaluate(() => { for (let i = 0; i < 24; i++) window.__px3(0, 0, 1, 1); });
const seedB = await grab();

/* WHERE THE LETTERS CHANGED, and how high up the frame. Rows are counted from
   the bottom, which is the end the shader measures its band from.
 *
   NOT THE OUTERMOST PIXEL AT EITHER END. That was the first version and it is
   not a measurement of anything: min and max are decided by a single stray
   pixel, and a cell rebuilt between the two grabs leaves a handful of them
   along the wall's antialiased edges — which read the band as 187 rows on runs
   where the ink was in the same 29 it always is. The band is taken as the rows
   that actually hold ink, a twentieth of the busiest row or more, which is the
   same number every run and still collapses to nothing if the ink does. */
let n = 0;
const rows = new Array(H).fill(0);
for (let i = 0, k = 0; i < seedA.length; i += 4, k++) {
  const d = Math.abs(seedA[i] - seedB[i]) + Math.abs(seedA[i + 1] - seedB[i + 1]) +
            Math.abs(seedA[i + 2] - seedB[i + 2]);
  if (d <= 12) continue;
  n++;
  rows[H - 1 - ((k / W) | 0)]++;            // rows from the bottom of the frame
}
const peak = Math.max(...rows), floorN = Math.max(1, peak * 0.05);
const busy = rows.map((c, y) => [y, c]).filter(r => r[1] >= floorN).map(r => r[0]);
out.ink = { px: n, pct: +(100 * n / (W * H)).toFixed(3), peakRow: rows.indexOf(peak),
            lowestRow: busy.length ? busy[0] : null,
            highestRow: busy.length ? busy[busy.length - 1] : null,
            strays: n - rows.filter((c, y) => busy.includes(y)).reduce((a, c) => a + c, 0),
            band: busy.length ? busy[busy.length - 1] - busy[0] : null };
/* THE PAINT IS THERE, AND IT IS A BAND ACROSS THE GROUND FLOOR.
   The first half is easy: two hundredths of a percent is a hundred pixels, and
   zero is what a shader that stopped reading the seed gives.
   THE BAND SAYS IT IS GROUND-FLOOR GRAFFITI RATHER THAN A REPAINT. The shader
   works between 0.4 and 2.7 m up the wall, which from this parking spot is 29
   rows of the frame; the ceiling is 90, three times that, so it fails on ink
   smeared up the facade and not on the shot being framed a little differently. */
out.tagIsOnTheWall = out.ink.pct > 0.02 && out.recolour > 5 &&
                     out.ink.band != null && out.ink.band < 90;

out.released = await p.evaluate(() => {
  const b = W.buildings.find(q => Math.abs(q.cy - 60) < 40 && q.h > 8);
  b.turf = null; b.tag = null; b.tagSeed = null;
  resolveColours([b]);
  dirtyCellAt(b.cx, b.cy);
  return true;
});
await p.evaluate(() => { for (let i = 0; i < 24; i++) window.__px3(0, 0, 1, 1); });
const back = await grab();

/* ---------- 3. and putting it back leaves no trace ---------- */
/* The release above is the other half of the A/B: with the tag gone the frame
   must return to the one taken before it was ever sprayed. If it does not, the
   paint branch is being taken on a wall with no tag on it — which is exactly
   the bug that shipped, and this is the assertion that would have caught it. */
let residue = 0;
for (let i = 0; i < clean1.length; i += 4)
  if (Math.abs(clean1[i] - back[i]) + Math.abs(clean1[i + 1] - back[i + 1]) +
      Math.abs(clean1[i + 2] - back[i + 2]) > 12) residue++;
out.residue = { px: residue, pct: +(100 * residue / (W * H)).toFixed(3),
                vsInk: +(residue / Math.max(out.ink.px, 1)).toFixed(3) };
/* MEASURED AGAINST THE INK, not against a round number. What is left over after
   the tag comes off is a few hundred pixels of antialiasing along the wall's
   own edges, which move by a texel when the cell is rebuilt; what would fail is
   the paint still being on the wall, and that is fifteen thousand pixels. A
   ratio says which of the two this is, and it says it whatever the shot happens
   to frame. Failure looks like 1.0, not like 0.02. */
out.cleanWallStaysClean = out.residue.vsInk < 0.15;

out.errs = errs.slice(0, 5);
out.pass = out.tagIsOnTheWall && out.cleanWallStaysClean && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
