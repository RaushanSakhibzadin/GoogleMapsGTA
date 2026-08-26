/* WHERE TWO CARS ACTUALLY TOUCH.
 *
 * Reported as "sometimes cars do not hit each other visually but the hit
 * happens". The contact test was a circle — the centres within (la + lb) * 0.34,
 * about 3.06 m for two ordinary cars — and a car in this game is 4.5 m long and
 * 2 m wide. One radius cannot describe that shape, and it was wrong in BOTH
 * directions at once:
 *
 *   SIDE BY SIDE two cars touch when their centres are 2.0 m apart, so a 3.06 m
 *   circle fires with a clear metre of daylight between them. That is the
 *   reported fault.
 *
 *   NOSE TO TAIL they touch at 4.5 m, so the same circle did not fire until
 *   they had driven a metre and a half into each other. Nobody reported that,
 *   because a car sinking into the back of another car reads as a crash.
 *
 * Shrinking the radius — which is what was asked for — fixes the first and makes
 * the second worse. So the test is the shape: two oriented rectangles, by the
 * separating axis theorem, which is exact for boxes.
 *
 * THE MEASUREMENTS ARE GEOMETRY, not frames. Two synthetic cars are placed at
 * known separations and asked directly, so every reading here is a fact about
 * the rule rather than about a camera — and the old circle is computed alongside
 * for every case, so "better" is a comparison rather than an assertion.
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

/* An ordinary car, 4.5 by 2.0 — the middle of the range makeCar draws from, so
   the numbers below are the ones a player meets. */
const CASES = [
  // label, b's offset from a, both headings, should they be touching
  ['side by side, a metre of daylight', 0, 2.6, 0, 0, false],
  ['side by side, mirrors almost touching', 0, 2.1, 0, 0, false],
  ['side by side, overlapping', 0, 1.8, 0, 0, true],
  ['nose to tail, a gap', 5.2, 0, 0, 0, false],
  ['nose to tail, just touching', 4.4, 0, 0, 0, true],
  ['nose to tail, well into it', 3.0, 0, 0, 0, true],
  // a car across the road in front: its length is what you hit
  ['t-boned, clear', 0, 4.0, 0, Math.PI / 2, false],
  ['t-boned, in contact', 0, 3.0, 0, Math.PI / 2, true],
  /* Corner to corner, which is where a circle is least like a rectangle. Note
     2.0 across is EXACTLY touching and therefore not overlapping — A reaches
     y = 1.0 and B starts at y = 1.0 — which is what the first version of this
     case got wrong and blamed on the code. 1.8 is a real overlap. */
  ['diagonal, clear', 3.6, 3.6, 0, 0, false],
  ['diagonal, grazing', 2.8, 2.0, 0, 0, false],
  ['diagonal, in contact', 2.8, 1.8, 0, 0, true]
];

out.cases = await p.evaluate(cases => {
  const car = (x, y, h) => ({ x, y, h, l: 4.5, w: 2.0, vx: 0, vy: 0, kind: 'traffic' });
  return cases.map(([label, dx, dy, ha, hb, want]) => {
    const a = car(0, 0, ha), b = car(dx, dy, hb);
    const hit = obbHit(a, b);
    // what the circle this replaced would have said, for the same pair
    const rr = (a.l + b.l) * 0.34;
    const circle = Math.hypot(dx, dy) <= rr;
    return { label, want, box: !!hit, circle,
             over: hit ? +hit.over.toFixed(2) : 0,
             n: hit ? [+hit.nx.toFixed(2), +hit.ny.toFixed(2)] : null };
  });
}, CASES);

out.wrong = out.cases.filter(c => c.box !== c.want).map(c => c.label);
out.matchesTheShape = out.wrong.length === 0;
/* AND THE CIRCLE HAS TO GET SOME OF THESE WRONG, or the shape test is measuring
   nothing and the old one was fine. Both directions have to appear: phantom
   contacts side by side, and missed ones nose to tail. */
out.circleWrong = out.cases.filter(c => c.circle !== c.want).map(c => c.label);
out.circlePhantom = out.cases.some(c => c.circle && !c.want);
out.circleMissed = out.cases.some(c => !c.circle && c.want);
out.betterThanTheCircle = out.circleWrong.length >= 3 &&
                          out.circlePhantom && out.circleMissed;

/* ---- the push comes out the right way ----

   A circle's normal always points from one centre to the other, so a car clipped
   down its flank was shoved diagonally away from the middle of the other car
   rather than sideways. Two cars overlapping side by side must separate ACROSS,
   and two nose to tail must separate ALONG. */
out.normals = await p.evaluate(() => {
  const car = (x, y, h) => ({ x, y, h, l: 4.5, w: 2.0, vx: 0, vy: 0, kind: 'traffic' });
  const flank = obbHit(car(0, 0, 0), car(0.4, 1.8, 0));   // alongside, slightly ahead
  const tail = obbHit(car(0, 0, 0), car(4.0, 0.3, 0));    // behind, slightly over
  return { flank: [+flank.nx.toFixed(2), +flank.ny.toFixed(2)],
           tail: [+tail.nx.toFixed(2), +tail.ny.toFixed(2)] };
});
// the cars face +x, so across is y and along is x
out.pushesTheRightWay = Math.abs(out.normals.flank[1]) > 0.9 &&
                        Math.abs(out.normals.tail[0]) > 0.9;

/* ---- and it still resolves an impact ----

   The geometry is only half of it: carsCollide has to separate the pair, take
   the closing speed out of them, and report it — the number the damage and the
   wanted level are both scaled from. */
out.impact = await p.evaluate(() => {
  const car = (x, y, h, vx, kind) => ({ x, y, h, l: 4.5, w: 2.0, vx, vy: 0, kind });
  const a = car(0, 0, 0, 20, 'player'), b = car(4.2, 0, 0, 0, 'traffic');
  const gap0 = b.x - a.x;
  const rel = carsCollide(a, b);
  return { rel: +rel.toFixed(2), gap: +(b.x - a.x).toFixed(2), gap0,
           // the heavier player keeps more of its speed; both must move
           av: +a.vx.toFixed(2), bv: +b.vx.toFixed(2) };
});
out.resolvesTheImpact = out.impact.rel > 15 && out.impact.gap > out.impact.gap0 &&
                        out.impact.bv > out.impact.av && out.impact.av < 20;

/* ---- and nothing collides with something the length of a street away ----
   The broad-phase reject has to be wide enough for a diagonal contact and no
   wider; a reject that is too tight is a missed collision nobody can see. */
out.reach = await p.evaluate(() => {
  const car = (x, y, h) => ({ x, y, h, l: 4.5, w: 2.0, vx: 0, vy: 0, kind: 'traffic' });
  // the widest real contact there is: two cars corner to corner, at an angle
  let far = 0;
  for (let deg = 0; deg < 180; deg += 5) {
    const h = deg * Math.PI / 180;
    for (let d = 6; d > 0; d -= 0.05) {
      const b = car(Math.cos(h) * d, Math.sin(h) * d, h);
      if (obbHit(car(0, 0, 0), b)) { far = Math.max(far, d); break; }
    }
  }
  // what carsCollide rejects beyond: the two half-diagonals added together,
  // which for two identical cars is one car's full diagonal
  const rejectAt = Math.hypot(4.5, 2.0);
  return { widestContact: +far.toFixed(2), rejectAt: +rejectAt.toFixed(2) };
});
out.rejectIsWideEnough = out.reach.widestContact <= out.reach.rejectAt;

out.errs = errs.slice(0, 3);
out.pass = out.matchesTheShape && out.betterThanTheCircle && out.pushesTheRightWay &&
           out.resolvesTheImpact && out.rejectIsWideEnough && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
