/* THE RENDER ON THE WALLS.
 *
 * Between the windows, a facade in this game was flat colour: real footprints at
 * real heights that still read as a heap of boxes, because real render is never
 * flat — it is patched where it has been repaired, stained under every sill and
 * cracked along the line of every floor slab. js/walltex.js now carries a seamless
 * grey tile cut from a photograph of a Belgrade block, and the wall shader
 * multiplies it over whatever colour the theme gave the masonry.
 *
 * FOUR WAYS FOR THAT TO BE WRONG WHILE LOOKING PLAUSIBLE:
 *
 *   The tile does not wrap. It repeats every four metres across a fifty-metre
 *   block, so a seam is a hard line drawn twelve times down one wall — and it is
 *   invisible in the source PNG, which is where you would look. So the pixels that
 *   end up adjacent when it tiles are compared against what a step costs anywhere
 *   else in the tile.
 *
 *   It is not grey. It is a multiplier, not a picture of a wall: if it carries
 *   Belgrade's ochre then every building in Tokyo gets Belgrade's ochre.
 *
 *   It reaches nothing, or it reaches everything as a flat tint — which is what a
 *   tile sampled at one texel per surface looks like, and is exactly what happens
 *   if the facade coordinate is not plumbed through. So the frame is taken with
 *   and without, and the difference has to be SIGNED: some pixels darker and some
 *   lighter, in balance, which a tint cannot be.
 *
 *   And it is an INVALID_OPERATION. A sampler uniform defaults to texture unit 0,
 *   unit 0 holds the shadow map, and a sampler2D and a sampler2DShadow on one unit
 *   is a draw-time error in WebGL2 whether or not the shader reaches the sample.
 *   That one never shows up as a wrong pixel — it shows up as no pixels — so
 *   glGetError is asked directly, including in the state before the texture has
 *   decoded, which is the state every session starts in.
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

/* ---- 0. no GL error in the state the session STARTS in ----

   Before anything has decoded, uGrime still has to name a unit of its own. Asked
   first, on the frames the game draws while the image is still coming back. */
out.beforeDecode = await p.evaluate(() => {
  const gl = GL.gl;
  while (gl.getError() !== gl.NO_ERROR) {}
  const wasReady = GRIME.ready, wasTex = GRIME.tex;
  GRIME.ready = false; GRIME.tex = null; GRIME.asked = true;   // as if it had not landed
  for (let i = 0; i < 5; i++) window.__renderOnce();
  const err = gl.getError();
  GRIME.ready = wasReady; GRIME.tex = wasTex;
  return { err, glNoError: gl.NO_ERROR };
});
out.cleanWithoutTheTexture = out.beforeDecode.err === out.beforeDecode.glNoError;

await p.evaluate(() => applyTheme('day'));
await p.waitForFunction(() => typeof GRIME === 'object' && GRIME.ready, null, { timeout: 15000 })
       .catch(() => {});
await p.waitForTimeout(2500);

/* ---- 1. the tile wraps, and it is grey ---- */
out.tile = await p.evaluate(() => new Promise(res => {
  const im = new Image();
  im.onload = () => {
    const S = im.naturalWidth;
    const c = document.createElement('canvas');
    c.width = S; c.height = im.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, S, S).data;
    /* Grey: how far apart the three channels are, at the worst pixel and on
       average. A colour tile would carry the wall's own ochre. */
    let spread = 0, worst = 0;
    for (let i = 0; i < d.length; i += 4) {
      const s = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      spread += s; worst = Math.max(worst, s);
    }
    spread /= (d.length / 4);
    /* Wrap: the pixels that end up next to each other when it tiles, against what
       a step between neighbours costs anywhere else. */
    let seam = 0;
    for (let i = 0; i < S; i++) {
      seam += Math.abs(d[(i * S) * 4] - d[(i * S + S - 1) * 4]);
      seam += Math.abs(d[i * 4] - d[((S - 1) * S + i) * 4]);
    }
    seam /= 2 * S;
    let inner = 0, n = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S - 1; x++) {
      inner += Math.abs(d[(y * S + x) * 4] - d[(y * S + x + 1) * 4]); n++;
    }
    inner /= n;
    let mn = 255, mx = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); sum += d[i]; }
    res({ size: S, spread: +spread.toFixed(2), worst,
          seam: +seam.toFixed(2), inner: +inner.toFixed(2),
          min: mn, max: mx, mean: +(sum / (d.length / 4)).toFixed(1) });
  };
  im.src = WALL_GRIME_PNG;
}));
/* Measured: 128 px, channel spread 0 everywhere because it is written out grey,
   seam 5.29 against 3.17 for a step anywhere else, luma 87..182 about a mean of
   127.3 — a multiplier from 0.68 to 1.42 around 1.0. */
out.isGrey = out.tile.worst === 0;
out.wraps = out.tile.seam < out.tile.inner * 2.5;
out.isAMultiplier = out.tile.mean > 115 && out.tile.mean < 140 &&
                    out.tile.max - out.tile.min > 40;

/* ---- 2. it reaches the walls, and as render rather than as a tint ----

   Parked on the street with the most buildings round it, in DAYLIGHT: the whole
   point is what a lit wall looks like, and the dusk ambient is 0.085, which is a
   wall so close to black that nothing multiplied into it moves a pixel value. */
out.frame = await p.evaluate(() => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const clear = (x, y) => !W.buildings.some(q =>
    x >= q.bb.x0 && x <= q.bb.x1 && y >= q.bb.y0 && y <= q.bb.y1 && pointInPoly(q.pts, x, y));
  const cnt = (x, y, r) => W.buildings.reduce((n, q) =>
    n + (Math.hypot(q.cx - x, q.cy - y) < r ? 1 : 0), 0);
  let best = null;
  for (const r of W.driveRoads) {
    if (r.w < 8) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 50) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (!clear(mx, my)) continue;
      const n = cnt(mx, my, 70);
      if (!best || n > best.n) best = { n, mx, my, h: Math.atan2(b.y - a.y, b.x - a.x) };
      if (best.n > 25) break;
    }
    if (best && best.n > 25) break;
  }
  window.__tp(best.mx, best.my, best.h);
  cam.x = P.car.x; cam.y = P.car.y;
  state = 'pause';
  /* The camera eases towards the car rather than snapping to it, so back-to-back
     renders are seventy milliseconds of easing and two "identical" frames disagree
     on most of the screen. Winding the frame clock back gives each render the
     largest step render3D() accepts; after two hundred it has arrived, and the
     control below comes back at zero. */
  const settle = n => { for (let i = 0; i < (n || 60); i++) { last3 = performance.now() - 100; window.__renderOnce(); } };
  settle(200);
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const band = () => window.__px3(0, Math.floor(h * 0.10), w, Math.floor(h * 0.60));
  const A = band();
  G3.noGrime = true; settle(); const B = band();
  G3.noGrime = false; settle(); const C = band();
  state = 'play';

  let up = 0, down = 0, same = 0, sum = 0;
  for (let i = 0; i < A.length; i += 4) {
    const a = A[i] * .3 + A[i + 1] * .6 + A[i + 2] * .1;
    const b = B[i] * .3 + B[i + 1] * .6 + B[i + 2] * .1;
    if (Math.abs(a - b) < 2) { same++; continue; }
    if (a > b) up++; else down++;
    sum += Math.abs(a - b);
  }
  let control = 0;
  for (let i = 0; i < A.length; i += 4)
    if (Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2]) > 3) control++;
  const moved = up + down;
  return { buildingsNear: best.n, sampled: A.length / 4, moved, up, down, control,
           meanStep: +(sum / Math.max(1, moved)).toFixed(2) };
});
/* Measured on the densest street in the bundled city, with 32 buildings inside
   70 m: 61,083 pixels of the 324,000 sampled move — a fifth of the frame, which is
   about how much of it is wall — 27,044 of them lighter and 34,039 darker, at a
   mean step of 5.0 levels. The BALANCE is the assertion that matters rather than
   the count: a flat tint moves every wall pixel the same way, so one of those two
   numbers would be zero. */
out.reachesTheWalls = out.frame.moved > 8000 && out.frame.control === 0;
out.isRenderNotATint = out.frame.up > out.frame.moved * 0.2 &&
                       out.frame.down > out.frame.moved * 0.2;

/* ---- 3. and no GL error with it bound ---- */
out.glErr = await p.evaluate(() => {
  const gl = GL.gl;
  while (gl.getError() !== gl.NO_ERROR) {}
  for (let i = 0; i < 5; i++) window.__renderOnce();
  return gl.getError();
});
out.cleanWithTheTexture = out.glErr === 0;

out.errs = errs.slice(0, 3);
out.pass = out.isGrey && out.wraps && out.isAMultiplier && out.reachesTheWalls &&
           out.isRenderNotATint && out.cleanWithoutTheTexture && out.cleanWithTheTexture &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
