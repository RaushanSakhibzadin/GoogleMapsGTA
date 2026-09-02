/* THE TWO CANS, AND THE PAINT ON THE BIG MAP.
 *
 * Both asked for together and both about the same feature seen from two ends:
 * spraying a wall, and being able to see which walls you have sprayed.
 *
 *   THE CANS. One button in each bottom corner instead of one in the top centre,
 *   bigger and round. They are the same button twice — whichever hand is free
 *   presses it — so the thing worth asserting is that BOTH of them work, not
 *   just that two exist. A second button that looks right and does nothing is
 *   exactly the failure a pair invites, and it is invisible in a screenshot.
 *
 *   THE MAP. The radar has shown painted walls since the feature landed and the
 *   big map showed none at all. Measured in PIXELS OF THE MAP'S OWN CANVAS
 *   rather than by trusting the draw call: count how much of the map is in a
 *   team's colour with nothing painted, paint a district, and count again. That
 *   is the only reading that says the buildings reached the screen.
 *
 * Usage: node tests/turfui.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text()))
    errs.push('console: ' + m.text());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
const IDS = ['sprayBtn', 'sprayBtnR'];

/* ---------- 1. neither can is up until there is a side to spray for ---------- */
out.before = await p.evaluate(ids => ids.map(id => {
  const el = document.getElementById(id);
  return { id, exists: !!el, on: !!el && el.classList.contains('on'),
           shown: !!el && getComputedStyle(el).display !== 'none' };
}), IDS);
out.hiddenUntilYouPlay = out.before.every(b => b.exists && !b.on && !b.shown);

/* ---------- 2. and then both of them are, and both are a thumb ---------- */
out.geo = await p.evaluate(ids => {
  TURF.team = 'red'; TURF.bets = 2; TURF.picks.red = 2;
  syncTurfUI();
  const vw = innerWidth, vh = innerHeight;
  return { vw, vh, cans: ids.map(id => {
    const el = document.getElementById(id);
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { id, on: el.classList.contains('on'), team: el.dataset.team || null,
             x: Math.round(b.left), y: Math.round(b.top),
             w: Math.round(b.width), h: Math.round(b.height),
             radius: cs.borderRadius, display: cs.display,
             fromBottom: Math.round(vh - b.bottom) };
  }) };
}, IDS);
const C = out.geo.cans;
/* ROUND is width equal to height with a radius of half of it — a "round" button
   that is 84 by 40 with a 50% radius is a lozenge, and 50% on its own does not
   say which. BIGGER is against the 44 point tap target every other button in
   this game is built to; these are the ones pressed with a thumb while parked,
   and they were 38 points tall as a rounded rectangle in the top centre. */
out.bothAreRoundAndBig = C.length === 2 && C.every(c =>
  c.on && c.display !== 'none' && c.w >= 56 && Math.abs(c.w - c.h) <= 1 &&
  /50%|9999px/.test(c.radius));
/* ONE IN EACH BOTTOM CORNER. Asked for as "one on the left, the other on the
   right" and "closer to the bottom": each is in its own half of the screen, and
   both are in the bottom quarter of it. */
out.oneEachSide = C.length === 2 &&
  C[0].x + C[0].w / 2 < out.geo.vw * 0.35 &&
  C[1].x + C[1].w / 2 > out.geo.vw * 0.65 &&
  C.every(c => c.y > out.geo.vh * 0.72);
// and they carry the side you are on, which is what the rim is for
out.bothCarryTheTeam = C.every(c => c.team === 'red');

/* ---------- 3. and BOTH of them spray ---------- */
/* Tapped for real rather than calling sprayPaint twice: what is being checked
   is that the second button is wired to anything at all. Parked at a wall by
   hand first, because a can pressed in open ground correctly does nothing. */
out.taps = [];
for (const id of IDS) {
  const before = await p.evaluate(() => window.__turf().owned.red + window.__turf().owned.black);
  const parked = await p.evaluate(() => {
    const b = W.buildings.find(q => !q.turf && q.pts && q.pts.length > 2 &&
                                    Math.hypot(q.cx - P.car.x, q.cy - P.car.y) < 400);
    if (!b) return false;
    window.__tp(b.cx, b.cy, 0);            // inside it: comfortably inside SPRAY_RANGE
    P.car.vx = P.car.vy = 0;
    return true;
  });
  await p.waitForTimeout(250);
  await p.tap('#' + id);
  await p.waitForTimeout(350);
  const after = await p.evaluate(() => window.__turf().owned.red + window.__turf().owned.black);
  out.taps.push({ id, parked, before, after, painted: after > before });
}
out.bothSpray = out.taps.length === 2 && out.taps.every(t => t.painted);

/* ---------- 4. and the paint is on the big map ---------- */
/* THE MAP'S OWN PIXELS, before and after. Zoomed in on the district being
   painted, because at the opening fit the whole city is on screen and one
   building is a quarter of a pixel — which is true of the feature as well and
   is not what is being asked about. */
const TEAM_PX = `() => {
  const cv = document.getElementById('bigmapC');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let red = 0, black = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // the two map fills, within a few levels: #d0263a and #26262f
    if (Math.abs(r - 208) < 12 && Math.abs(g - 38) < 12 && Math.abs(b - 58) < 12) red++;
    if (Math.abs(r - 38) < 6 && Math.abs(g - 38) < 6 && Math.abs(b - 47) < 6) black++;
  }
  return { red, black, of: d.length / 4 };
}`;
out.map = await p.evaluate(async src => {
  const count = eval('(' + src + ')');
  // clear whatever the taps above painted, so "before" really is a clean map
  for (const b of W.buildings) if (b.turf) { b.turf = null; b.tag = null; b.tagSeed = null; resolveColours([b]); }
  prerenderMap();
  openMap();
  const zoom = () => { MAPV.cx = P.car.x; MAPV.cy = P.car.y; MAPV.s = 1.6; mapClamp(); drawBigMap(); };
  zoom();
  await new Promise(r => setTimeout(r, 200));
  const before = count();
  const near = W.buildings
    .filter(q => Math.hypot(q.cx - P.car.x, q.cy - P.car.y) < 220 && q.pts && q.pts.length > 2)
    .slice(0, 30);
  near.forEach((q, i) => claimBuilding(q, i % 3 ? 'red' : 'black'));
  zoom();
  await new Promise(r => setTimeout(r, 200));
  const after = count();
  closeMap();
  return { painted: near.length, before, after };
}, TEAM_PX);
/* A THIRTIETH OF A PERCENT is about two thousand pixels of a 390×664 phone at
   DPR 3, which is thirty city blocks at this zoom — and "before" is zero by
   construction, because nothing else on the map is either of these two colours.
   The gap between the two is the whole assertion; the threshold only has to sit
   somewhere inside it. */
const pct = n => n / out.map.after.of * 100;
out.paintShowsOnTheMap = out.map.painted > 5 &&
  pct(out.map.before.red + out.map.before.black) < 0.005 &&
  pct(out.map.after.red) > 0.03 && pct(out.map.after.black) > 0.01;

out.errs = errs.slice(0, 5);
out.pass = out.hiddenUntilYouPlay && out.bothAreRoundAndBig && out.oneEachSide &&
           out.bothCarryTheTeam && out.bothSpray && out.paintShowsOnTheMap && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
