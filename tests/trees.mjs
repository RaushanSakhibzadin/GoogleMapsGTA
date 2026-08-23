/* STREET TREES: where they stand, and that they stand in the same place twice.
 *
 * Belgrade's boulevards are lined with plane trees, and the city was drawn
 * without a single one. OpenStreetMap maps individual trees too sparsely to
 * build a street from — whole avenues that plainly have them carry none — so
 * these are generated, which is how they were asked for.
 *
 * Generated planting has two ways of going wrong that a screenshot will not
 * show you. It can stand where nothing can stand: in the middle of a
 * carriageway, or inside somebody's front room. And it can be generated AFRESH
 * each time, so a cell dropped and rebuilt — which happens whenever you switch
 * views, and continuously as you drive — comes back with the trees somewhere
 * else. A street that rearranges itself behind you is worse than a bare one.
 *
 * So this reads the trunk positions the cell builder actually plants, rather
 * than inferring them from pixels, and checks all three: that there are some,
 * that every one is off the tarmac and out of the buildings, and that planting
 * the same road twice gives the same trees. The pixels are checked too, because
 * a list of coordinates proves nothing about whether anything was drawn.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
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
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2500);
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(400);

/* ---- 1. the planting rules hold, over the whole loaded city ---- */
/* treesAlong is the function the cell builder calls, so asking it directly is
   asking exactly what gets built. Every drivable road in the bundled city is
   walked — thousands of trees — rather than the handful that happen to be in
   shot, because the one that lands in a wall will not be the one on screen. */
out.sites = await p.evaluate(() => {
  const sites = [], junk = [];
  for (const r of W.driveRoads) {
    if (!r.drive) continue;
    treesAlong([], r, -1e9, -1e9, 1e9, 1e9, () => {}, sites);
  }
  for (let i = 0; i < sites.length; i += 2) {
    const x = sites[i], z = sites[i + 1];
    if (onTarmac(x, z)) { if (junk.length < 6) junk.push(['on the tarmac', Math.round(x), Math.round(z)]); }
    else if (insideBuilding(x, z)) { if (junk.length < 6) junk.push(['in a building', Math.round(x), Math.round(z)]); }
  }
  return { planted: sites.length / 2, junk };
});
out.enoughTrees = out.sites.planted > 400;
out.allStandable = out.sites.junk.length === 0;

/* ---- 2. and the same road plants the same trees twice ---- */
/* Not a cached answer being handed back: nothing is remembered between builds,
   so the second pass has to reach the same positions from the coordinates
   alone. Compared to the centimetre. */
out.stable = await p.evaluate(() => {
  /* The road that plants the MOST, not the first one with a few points in it —
     the first draft picked a stub that grew a single tree, and one tree landing
     in the same place twice is not evidence of anything. */
  let r = null, most = -1;
  for (const q of W.driveRoads) {
    if (!q.drive) continue;
    const t = [];
    treesAlong([], q, -1e9, -1e9, 1e9, 1e9, () => {}, t);
    if (t.length > most) { most = t.length; r = q; }
  }
  const a = [], b = [];
  treesAlong([], r, -1e9, -1e9, 1e9, 1e9, () => {}, a);
  treesAlong([], r, -1e9, -1e9, 1e9, 1e9, () => {}, b);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return { n: a.length / 2, sameCount: a.length === b.length, worst: +worst.toFixed(4) };
});
out.deterministic = out.stable.sameCount && out.stable.n > 0 && out.stable.worst < 0.01;

/* ---- 3. and a street actually has green in it ---- */
/* Parked on the longest straight in the city, looking down it, counting
   green-dominant pixels.

   NOT AGAINST ZERO. Foliage is not the only green thing here — the parks are
   green too, and the same build with the planting deleted outright measured
   2389 green pixels on one run and 0 on the next, depending on whether a park
   happened to be in shot. The first version of this asked for more than 500 and
   passed on the 2389, which is a test that measures the parks. With the trees
   in, it counts 11460 every time. Six thousand sits clear of both. */
out.street = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  let best = null;
  for (const r of W.driveRoads) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || L > best.L) best = { L, a, b };
  }
  const { a, b } = best;
  window.__tp(a.x + (b.x - a.x) * 0.2, a.y + (b.y - a.y) * 0.2, Math.atan2(b.y - a.y, b.x - a.x));
  cam.x = P.car.x; cam.y = P.car.y;
  state = 'pause';
  for (let i = 0; i < 70; i++) window.__px3(0, 0, 1, 1);
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const px = window.__px3(0, Math.floor(h * 0.34), w, Math.floor(h * 0.5));
  let green = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 1] > px[i] + 16 && px[i + 1] > px[i + 2] + 16) green++;
  state = 'play';
  return { green, sampled: px.length / 4, straight: Math.round(best.L) };
});
out.canopyOnScreen = out.street.green > 6000;

out.errs = errs.slice(0, 3);
out.pass = out.enoughTrees && out.allStandable && out.deterministic &&
           out.canopyOnScreen && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
