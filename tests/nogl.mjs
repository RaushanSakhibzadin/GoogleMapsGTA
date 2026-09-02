/* THE CHASE VIEW ON A BROWSER THAT HAS NO WEBGL.
 *
 * Reported three times from the same phone, and the log said it in the end
 * without ambiguity: probe "no", webgl1 false, no error message at all. Chrome
 * on iOS with WebGL switched off — Lockdown Mode does that. Nothing is broken
 * and there is no driver to fix; the API is not there.
 *
 * The button used to answer that with a toast and put you back in the top-down
 * game, which on such a browser means never seeing the chase view at all. Now it
 * draws the same street on the 2D canvas: a painter's algorithm over the same
 * camera, the same matrices, the same footprints and heights.
 *
 * WEBGL IS REMOVED BEFORE A LINE OF THE GAME RUNS, which is the only honest way
 * to stage this — getContext hands back null for every flavour and the two
 * constructors are deleted, so nothing in the page can find WebGL by any route.
 * A test that switched a flag would prove the flag works.
 *
 * The assertions are the three things that separate a chase view from a map:
 * there is sky at the top of the frame and ground at the bottom, the street has
 * depth, and it holds a frame rate on the machine that needs it.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.addInitScript(() => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') return null;
    return real.call(this, t, o);
  };
  try { delete window.WebGL2RenderingContext; } catch (e) {}
  try { delete window.WebGLRenderingContext; } catch (e) {}
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
/* THE WEBGL CARD IS IN THE WAY, and on this browser it is meant to be: with no
   WebGL the game now opens with a card saying so and how to turn it back on. A
   player taps GOT IT; this does the same thing, because a test that could not
   reach DRIVE would be reporting the card rather than the renderer. */
await p.evaluate(() => window.__hideGLHelp && window.__hideGLHelp(false));  // DISMISS_GL_CARD
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};
out.noWebGL = await p.evaluate(() => {
  const c = document.createElement('canvas');
  return { ctx2: !!c.getContext('webgl2'), ctx1: !!c.getContext('webgl'),
           ctor: typeof WebGL2RenderingContext };
});
out.reallyGone = !out.noWebGL.ctx2 && !out.noWebGL.ctx1 && out.noWebGL.ctor === 'undefined';

/* ---- 1. the button works anyway ---- */
out.switched = await p.evaluate(() => window.__setMode3d(true));
out.mode = await p.evaluate(() => ({
  mode3d: MODE3D, soft: SOFT3D, glReady: !!GL.gl,
  // nothing draws into the GL canvas, so it must not be switched on over the one that does
  glCanvasShown: getComputedStyle(document.getElementById('gl')).display
}));
out.fellBackToSoftware = out.switched === true && out.mode.mode3d === true &&
                         out.mode.soft === true && out.mode.glReady === false &&
                         out.mode.glCanvasShown === 'none';

/* Parked on a street with buildings down both sides, which is what a chase view
   is for and what a top-down map of the same spot looks nothing like. */
await p.evaluate(() => applyTheme('day'));
out.spot = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const clear = (x, y) => !W.buildings.some(q =>
    x >= q.bb.x0 && x <= q.bb.x1 && y >= q.bb.y0 && y <= q.bb.y1 && pointInPoly(q.pts, x, y));
  const cnt = (x, y, r) => W.buildings.reduce((n, q) =>
    n + (Math.hypot(q.cx - x, q.cy - y) < r ? 1 : 0), 0);
  let best = null;
  for (const r of W.driveRoads) {
    if (r.w < 8) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 60) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (!clear(mx, my)) continue;
      const n = cnt(mx, my, 70);
      if (!best || n > best.n) best = { n, mx, my, h: Math.atan2(b.y - a.y, b.x - a.x) };
      if (best.n > 25) break;
    }
    if (best && best.n > 25) break;
  }
  if (!best) return null;
  window.__tp(best.mx, best.my, best.h);
  cam.x = P.car.x; cam.y = P.car.y;
  for (let i = 0; i < 40; i++) window.__renderOnce();
  return { buildingsNear: best.n, tris: SOFT.tris, walls: SOFT.drawn };
});
out.drewTheStreet = !!out.spot && out.spot.walls > 60 && out.spot.tris > 200;

/* ---- 2. it is a view of a street, not a map of one ---- */
/* Sky at the top and ground at the bottom is the one thing a chase view always
   has and a top-down view never does, whatever city it is over. The same frame
   is then taken in the top-down view as the A/B, because "there is blue up
   there" would also pass on a bug that drew the sky over everything. */
/* "BLUE-LED" STOPPED MEANING "SKY" when the daylight soil did. It was a bone
   grey, then a sea-green, and it is a slate blue-grey now — 51/63/76, which
   leads on blue over red and over green both, so the top-down map went from
   0.00 blue to 0.30 and the A/B stopped being one.

   Brightness is the discriminator that cannot be caught up with. js/util.js
   states the constraint on the soil outright: it is the only surface in the
   frame that is never lit, shaded or textured, so it is deliberately kept dark
   and anything lighter than it would become the brightest thing on screen. Its
   own luma is therefore a ceiling no ground pixel crosses — and it is read off
   the running game rather than written down here, so the next repaint of the
   ground carries this along with it. */
const look = () => p.evaluate(() => {
  const c = document.getElementById('game');
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  const gnd = window.__theme().ground.replace('#', '');
  const gr = parseInt(gnd.slice(0, 2), 16), gg = parseInt(gnd.slice(2, 4), 16),
        gb = parseInt(gnd.slice(4, 6), 16);
  const floor = (.299 * gr + .587 * gg + .114 * gb) + 35;
  const band = (y0, y1) => {
    const d = g.getImageData(0, Math.floor(h * y0), w, Math.max(1, Math.floor(h * (y1 - y0)))).data;
    let blue = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 2] > d[i] + 14 && d[i + 2] > d[i + 1] &&
          .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2] > floor) blue++;
      n++;
    }
    return +(blue / n).toFixed(3);
  };
  return { top: band(0.02, 0.12), bottom: band(0.80, 0.95), floor: +floor.toFixed(1) };
});
out.soft = await look();
await p.evaluate(() => { window.__setMode3d(false); for (let i = 0; i < 6; i++) window.__renderOnce(); });
out.flat = await look();
/* Measured on this street: the chase view is 0.46 blue across the top strip and
   0.00 across the bottom, and the top-down map of the same spot is 0.00 at both
   ends because there is no sky in it anywhere. Not 1.00 at the top, and it
   should not be — the blocks down both sides of a real street reach into that
   strip, which is exactly what makes it a street rather than a horizon. */
out.hasSkyAndGround = out.soft.top > 0.25 && out.soft.bottom < 0.2 &&
                      out.flat.top < 0.05;

/* ---- 3. and it holds a frame rate on the machine that needs it ---- */
await p.evaluate(() => { window.__setMode3d(true); window.__setInput({ gas: 1 }); });
await p.waitForTimeout(2000);
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 3000 ? requestAnimationFrame(tick) : r(Math.round(n / 3)); };
  requestAnimationFrame(tick);
}));
out.perf = await p.evaluate(() => window.__perf());
await p.evaluate(() => window.__setInput(null));
/* Thirty, not sixty. This exists for a phone that cannot use its GPU for the
   job, and the point of comparison is the top-down game rather than the WebGL
   view — which in this container runs at 8, because SwiftShader emulates a GPU
   in software and a canvas fill does not. */
out.fastEnough = out.fps >= 30;

out.errs = errs.slice(0, 4);
out.pass = out.reallyGone && out.fellBackToSoftware && out.drewTheStreet &&
           out.hasSkyAndGround && out.fastEnough && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
