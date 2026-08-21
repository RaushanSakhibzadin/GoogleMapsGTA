/* TRAFFIC KEEPS RIGHT.
 *
 * Reported as "the cars move by the centre of the roads". They did: every way in
 * this world is a centreline and traffic followed it exactly, so two cars going
 * opposite ways along one street occupied the same metre of tarmac and drove
 * through each other, and a busy street looked like single file down the middle.
 *
 * WHAT IS MEASURED IS THE SIGNED DISTANCE from the centreline to each car, in the
 * car's own frame: positive to its right, negative to its left. That one number
 * says everything the feature claims. It is computed here from the road geometry
 * rather than read out of the game, so it cannot agree with the code by
 * construction — the test finds the nearest point on the nearest drivable way by
 * projecting onto every segment, exactly as a person with a map would.
 *
 * AND THE SIGN IS THE WHOLE POINT, which is why "how far from the centre" is not
 * enough on its own. Cars wander a metre or two either way while cornering, so an
 * unsigned average would look healthy on a build that simply drove badly. A build
 * that follows the centreline reads a signed mean of about zero with cars on both
 * sides; keeping right reads a clear positive mean with nearly every car on the
 * same side of the line.
 *
 * Verified against a build with the offset removed, twice: signed mean 0.26 and
 * 0.01 m, MEDIAN 0.00 and 0.05, with 45.7% and 65.3% of cars to the right. With
 * the offset: mean 2.39 and 2.61, median 2.17 and 2.06, 85.2% and 93.5%.
 *
 * The median is the assertion that carries this. The percentage swings by twenty
 * points between runs of the same build — cars cut corners to one side or the
 * other depending on which junctions the sample caught — while the median sits
 * at zero without the offset and at two metres with it, every time.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
// long enough for the spawn ring to fill and every car to have settled into a lane
await p.waitForTimeout(9000);

const out = {};

/* Every car, and where it sits relative to the tarmac it is on. All of the
   geometry is done in the page because that is where the road list lives, but
   none of it uses the game's own lane code — it projects onto segments from
   scratch. */
const measure = () => p.evaluate(() => {
  const roads = window.__roadList().filter(r => r.drive && r.pts.length > 1);
  const near = (x, y) => {
    let best = null, bd = Infinity;
    for (const r of roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const ex = b.x - a.x, ey = b.y - a.y;
        const L2 = ex * ex + ey * ey;
        if (L2 < 1e-9) continue;
        // project the car onto this segment, clamped to its ends
        let u = ((x - a.x) * ex + (y - a.y) * ey) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = a.x + ex * u, py = a.y + ey * u;
        const d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 < bd) { bd = d2; best = { px, py, w: r.w, cls: r.cls }; }
      }
    }
    return best ? { ...best, d: Math.sqrt(bd) } : null;
  };
  const rows = [];
  for (const t of traffic) {
    const n = near(t.x, t.y);
    if (!n || n.d > 12) continue;           // not on a road we can identify
    /* Signed by the car's own heading: (-sin h, cos h) is a quarter turn to the
       right in this coordinate system, where +y is south. */
    const rx = -Math.sin(t.h), ry = Math.cos(t.h);
    rows.push({ side: +((t.x - n.px) * rx + (t.y - n.py) * ry).toFixed(2),
                d: +n.d.toFixed(2), w: n.w, cls: n.cls,
                spd: +Math.hypot(t.vx, t.vy).toFixed(1) });
  }
  return rows;
});

/* Sampled a few times over several seconds rather than once. A single frame
   catches whatever happens to be mid-junction; the feature is a claim about
   where cars sit while driving, so it is asked repeatedly and pooled. */
const rows = [];
for (let i = 0; i < 4; i++) {
  rows.push(...await measure());
  await p.waitForTimeout(1800);
}
// only cars actually under way — a stationary car in a queue may be anywhere
const moving = rows.filter(r => r.spd > 2);
const sides = moving.map(r => r.side);
const mean = sides.reduce((a, b) => a + b, 0) / (sides.length || 1);
const right = sides.filter(s => s > 0).length;
const sorted = sides.slice().sort((a, b) => a - b);

out.samples = rows.length;
out.moving = moving.length;
out.signedMean = +mean.toFixed(2);
out.medianSide = sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(2) : null;
out.pctRight = +(100 * right / (sides.length || 1)).toFixed(1);
out.byClass = {};
for (const r of moving) {
  const k = r.cls + '(' + r.w + 'm)';
  (out.byClass[k] = out.byClass[k] || []).push(r.side);
}
for (const k in out.byClass) {
  const v = out.byClass[k];
  out.byClass[k] = { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) };
}

/* Enough cars under way for any of this to mean anything. */
out.enough = out.moving >= 12;
/* A clear positive mean. The narrowest street this offsets is 1.2 m and the
   widest 3.5, so anything above 1 m is decisively off the centreline and on the
   correct side of it; a centre-following build reads about zero. */
out.keepsRight = out.signedMean > 1 && out.medianSide > 1;
/* And it is not an average of two crowds. Cars cornering and turning at
   junctions legitimately cross the line for a moment, so this is not 100. The
   threshold has more air under it than the numbers suggest it needs, because
   this figure is the noisy one — the centre-following build measured 45.7% on
   one run and 65.3% on the next, so it is a supporting witness and the median
   above is the assertion. */
out.nearlyAllOnOneSide = out.pctRight > 80;
/* STILL ON THE TARMAC — asked of the population, not of every last car.

   The offset must not push traffic off its own road, since off-road is a heavy
   speed penalty and would strand the city. But "every car, always" is not a
   property this game has and never was: cars cut corners and swing wide across
   junctions, and the worst single overhang measures 5.41 m on a build with NO
   lane offset at all against 5.63 m with it. An every() assertion therefore
   fails on both builds and discriminates nothing — it says the traffic AI takes
   liberties at junctions, which is true and is not what this file is about.

   So what is asserted is that the ordinary car is inside its own carriageway,
   and the bar is set where it passes on BOTH builds — 77.6% without the offset
   and 87.0% with it. That is deliberate and worth being plain about: this is a
   safety guard, not evidence. It exists to fail if the offset is ever widened to
   something that throws traffic off the road, and it says nothing either way
   about which side of the line the cars are on. */
const inLane = moving.filter(r => r.d <= r.w * 0.5 + 1.5).length;
out.pctInCarriageway = +(100 * inLane / (moving.length || 1)).toFixed(1);
out.worstOverhang = +Math.max(...moving.map(r => r.d - r.w * 0.5)).toFixed(2);
out.onTheRoad = out.pctInCarriageway > 70;

out.errs = errs.slice(0, 3);
out.pass = out.enough && out.keepsRight && out.nearlyAllOnOneSide &&
           out.onTheRoad && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
