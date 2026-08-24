/* SHOPFRONTS ON THE LOW BUILDINGS, AND ONLY ON THE LOW ONES.
 *
 * Most of an old Belgrade street is two storeys with a shop under it, and the
 * facade rule drew that as a blank box with one row of windows floating on it —
 * the window grid starts 2.6 m up and leaves everything below plain, which is
 * right for a block of flats and wrong for a corner with a bakery in it. Under
 * eleven metres a wall now gets an opening nearly as wide as its bay, a painted
 * fascia board over it, and its windows lifted to 3.7 m so they sit above the
 * board rather than through it.
 *
 * WHAT CAN GO WRONG WITHOUT LOOKING WRONG:
 *
 *   Nothing is drawn, or it is drawn everywhere. The gate is `vW.z < uLowH` —
 *   the WALL's own height — and it would be very easy to write that against the
 *   fragment's height above the pavement instead, which would put a shopfront
 *   round the bottom of every tower in the city and look plausible in a
 *   screenshot taken at street level. So the frame is taken twice in two places:
 *   in front of a two-storey building, where it must change, and in front of one
 *   over twenty metres, where it must not change AT ALL.
 *
 *   It is a flat band rather than a shopfront. A single darker stripe along the
 *   ground would pass "something changed". So the changed pixels are asked for
 *   both halves of what a shopfront is: some markedly DARKER than what they
 *   replaced, which is the opening, and some markedly more COLOURED, which is
 *   the painted board.
 *
 *   And the board is every colour at once. The first version built it from three
 *   fractions of one hash — a uniform sample of RGB, which is mostly colours
 *   nobody paints a shop — and drew a parade of magenta and acid yellow. The
 *   five-colour palette replaced it, so the saturation of the changed pixels is
 *   bounded as well as required.
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
/* Daylight, because a shopfront is a thing you look at rather than a thing that
   glows, and the dusk ambient is 0.085 — a wall that dark moves by a couple of
   levels whatever you paint on it. */
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(2500);

/* Park on a road facing a building of the height class asked for, take the frame
   as shipped, again with the shopfronts switched off, and a third time with
   nothing changed at all.

   THE CAMERA HAS TO BE GIVEN TIME TO ARRIVE. It eases towards the car rather
   than snapping to it, so the seventy back-to-back renders the other tests
   settle with are seventy MILLISECONDS of easing — two "identical" frames of a
   parked car then disagree on most of the screen. Winding the frame clock back
   before each render gives every one the largest step render3D() will take, and
   the control below comes back at zero because of it. */
const shoot = tall => p.evaluate(t => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const clear = (x, y) => !W.buildings.some(q =>
    x >= q.bb.x0 && x <= q.bb.x1 && y >= q.bb.y0 && y <= q.bb.y1 && pointInPoly(q.pts, x, y));
  const set = W.buildings.filter(t ? (q => q.h > 20) : (q => q.h > 5.5 && q.h < 11));
  const score = q => set.reduce((n, o) => n + (Math.hypot(o.cx - q.cx, o.cy - q.cy) < 70 ? 1 : 0), 0);
  set.sort((a, b) => score(b) - score(a));
  let best = null;
  outer:
  for (const q of set.slice(0, 40))
    for (const r of W.driveRoads)
      for (const pt of r.pts) {
        const dx = q.cx - pt.x, dy = q.cy - pt.y, D = Math.hypot(dx, dy);
        if (D < 14 || D > 32) continue;
        if (!clear(pt.x, pt.y)) continue;
        best = { mx: pt.x, my: pt.y, h: Math.atan2(dy, dx), bh: Math.round(q.h), near: score(q) };
        break outer;
      }
  if (!best) return { err: 'nothing of that height with a road in front of it' };
  window.__tp(best.mx, best.my, best.h);
  cam.x = P.car.x; cam.y = P.car.y;
  state = 'pause';
  const settle = n => { for (let i = 0; i < (n || 80); i++) { last3 = performance.now() - 100; window.__renderOnce(); } };
  settle(220);
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const band = () => window.__px3(0, Math.floor(h * 0.12), w, Math.floor(h * 0.80));
  const A = band();
  G3.noShop = true; settle(); const B = band();
  G3.noShop = false; settle(); const C = band();
  state = 'play';

  const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx < 8 ? 0 : (mx - Math.min(r, g, b)) / mx; };
  let moved = 0, darker = 0, moreColour = 0, worstSat = 0, control = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2]) > 3) control++;
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d < 12) continue;
    moved++;
    const la = A[i] * .3 + A[i + 1] * .6 + A[i + 2] * .1;
    const lb = B[i] * .3 + B[i + 1] * .6 + B[i + 2] * .1;
    if (la < lb - 20) darker++;
    const sa = sat(A[i], A[i + 1], A[i + 2]), sb = sat(B[i], B[i + 1], B[i + 2]);
    if (sa > sb + 0.10) moreColour++;
    if (sa > worstSat) worstSat = sa;
  }
  return { facingH: best.bh, near: best.near, sampled: A.length / 4,
           moved, darker, moreColour, control, worstSat: +worstSat.toFixed(3) };
}, tall);

out.low = await shoot(false);
out.tall = await shoot(true);
out.glErr = await p.evaluate(() => {
  const gl = GL.gl;
  while (gl.getError() !== gl.NO_ERROR) {}
  for (let i = 0; i < 5; i++) window.__renderOnce();
  return gl.getError();
});

/* Measured in Palilula, standing 14–32 m off a 6 m building with 46 more of its
   size around it. The tall reading is the one worth having: it is exactly zero,
   which is what says the gate is on the wall's height and not on the fragment's. */
out.deterministic = out.low.control === 0 && out.tall.control === 0;
out.reachesLowBuildings = out.low.moved > 3000;
out.leavesTallBuildingsAlone = out.tall.moved === 0;
out.hasOpeningsAndBoards = out.low.darker > out.low.moved * 0.10 &&
                           out.low.moreColour > out.low.moved * 0.03;
out.nothingGarish = out.low.worstSat < 0.80;
out.clean = out.glErr === 0;

out.errs = errs.slice(0, 3);
out.pass = out.deterministic && out.reachesLowBuildings && out.leavesTallBuildingsAlone &&
           out.hasOpeningsAndBoards && out.nothingGarish && out.clean && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
