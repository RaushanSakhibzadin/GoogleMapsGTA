/* THE NIGHT TREES ARE A PHOTOGRAPH OF A REAL ONE, AND ARE LIT ONCE.
 *
 * Everything else in this game is drawn in code. The trees were too — two dozen
 * circles, shaded lighter towards the top — and two dozen circles read as a green
 * lollipop at any distance, because what makes a canopy look like a canopy is the
 * clumping. js/foliage.js now carries a cutout of a real plane tree on a Belgrade
 * street at night, and the dusk theme uses it.
 *
 * FOUR WAYS THAT CAN LOOK RIGHT IN A SCREENSHOT AND BE WRONG:
 *
 *   The photograph is never selected, and the painted tree is still what you see
 *   after dark. So the kind is asked for directly, at both themes.
 *
 *   Something is selected but it is not a photograph. A flat green square encoded
 *   as a PNG would pass "is it 192 pixels wide". So the leaf detail is measured —
 *   the mean step between neighbouring pixels inside the canopy — and compared
 *   against the painted tree, which is flat by construction.
 *
 *   It is selected and never reaches the screen: uploaded to a texture nothing
 *   binds, or drawn under the road. So the same parked street is shot three times
 *   — as shipped, with the painted tree forced back in, and with nothing changed
 *   at all — and the pixels have to differ in the first pair and not in the
 *   second.
 *
 *   AND IT IS LIT TWICE. This is the one worth the test. The photograph was taken
 *   under a street lamp, so the light is already in its pixels; multiplying the
 *   dusk theme's ambient into it a second time — which is exactly what the code
 *   path it inherited does — leaves a black smudge where a lamplit tree should be.
 *   So a fourth frame puts that second multiply back, and the tree pixels have to
 *   come out brighter without it.
 *
 * And the last section pulls js/foliage.js off the wire entirely, because a
 * picture of a tree must never be the reason the game does not start.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });

/* Parked on the longest straight in the loaded city, looking down it, with the
   traffic cleared and the clock stopped, because two frames of the same street
   have to be comparable.

   AND THE CAMERA GIVEN TIME TO ARRIVE. It eases towards the car rather than
   snapping to it, so the seventy back-to-back renders the other tests settle with
   are seventy MILLISECONDS of easing — the camera is still visibly moving, and
   two successive frames of a parked car with the clock stopped disagreed on
   175,497 pixels out of 243,000. Winding the frame clock back 100 ms before each
   render gives each one the largest step render3D() will accept, and after two
   hundred of them successive frames are identical to the bit. Everything here is
   a difference between two frames, so that was the difference between measuring
   the trees and measuring the camera. */
const SETTLE = n => {
  for (let i = 0; i < (n || 70); i++) {
    last3 = performance.now() - 100;                  // the GL view's frame clock
    if (typeof SOFT === 'object') SOFT.last = last3;  // and the software one's
    window.__renderOnce();
  }
};
const PARK = () => {
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
  window.__settle(200);
  return Math.round(best.L);
};

async function open(opts = {}) {
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  if (opts.noWebGL) await p.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, o) {
      if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') return null;
      return real.call(this, t, o);
    };
    try { delete window.WebGL2RenderingContext; } catch (e) {}
    try { delete window.WebGLRenderingContext; } catch (e) {}
  });
  await p.route('**://*/**', r => {
    const u = r.request().url();
    if (opts.noFoliage && u.includes('js/foliage.js')) return r.abort();
    return u.startsWith('file:') ? r.continue() : r.abort();
  });
  await p.goto(GAME);
  await p.waitForTimeout(300);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(600);
  await p.evaluate(src => { window.__settle = eval('(' + src[0] + ')'); window.__park = eval('(' + src[1] + ')'); },
                   [SETTLE.toString(), PARK.toString()]);
  return { p, errs };
}

const out = {};

/* ================= 1. the GL view at dusk ================= */
{
  const { p, errs } = await open();
  out.switched = await p.evaluate(() => window.__setMode3d(true));
  if (!out.switched) {
    out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
    out.pass = true;
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
    process.exit(0);
  }
  await p.waitForTimeout(2500);
  /* Not fatal if it never arrives: the assertions below are what should report a
     photograph that is missing or never selected, in words, rather than this
     line throwing a timeout and taking the whole file down with it. */
  await p.waitForFunction(() => treeKind() === 'night', null, { timeout: 15000 }).catch(() => {});

  /* ---- which tree each theme picks ---- */
  out.picks = await p.evaluate(() => {
    const at = t => { applyTheme(t); return { kind: treeKind(), w: treeCanvas().width }; };
    const dusk = at('dusk'), day = at('day');
    applyTheme('dusk');
    return { dusk, day };
  });
  out.photographAfterDark = out.picks.dusk.kind === 'night' && out.picks.dusk.w === 192 &&
                            out.picks.day.kind === 'painted' && out.picks.day.w === 128;

  /* ---- and it is a photograph, not a green square ----

     Mean absolute step between horizontally neighbouring pixels, counting only
     pairs where both are opaque so the cutout edge does not dominate. The painted
     tree is filled circles: inside one there is no step at all, and the only
     detail is where two overlap. Measured: 0.74 painted, 11.88 photographed. */
  out.detail = await p.evaluate(() => {
    const grain = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let s = 0, n = 0;
      for (let y = 0; y < cv.height; y++)
        for (let x = 0; x < cv.width - 1; x++) {
          const i = (y * cv.width + x) * 4;
          if (d[i + 3] < 250 || d[i + 7] < 250) continue;
          s += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6]);
          n += 3;
        }
      return +(s / Math.max(1, n)).toFixed(2);
    };
    applyTheme('dusk');
    const night = grain(treeCanvas());
    applyTheme('day');
    const painted = grain(treeCanvas());
    applyTheme('dusk');
    return { night, painted };
  });
  out.hasLeafDetail = out.detail.night > out.detail.painted * 4 && out.detail.night > 6;

  /* ---- it reaches the screen, and it is not dimmed twice ----

     THREE FRAMES OF THE SAME PARKED STREET, differing in one thing each.

       A  as shipped
       B  the photograph taken away, so the code falls back to the painted tree
       C  the photograph kept and lit the way the painted one is — the double-dim,
          which is the bug this guards, staged by putting the old lighting term
          back over the top of treeLit()

     A vs B says the photograph reached the screen at all. A vs C says it was lit
     once: same art, same geometry, same camera, one multiply apart. */
  out.frame = await p.evaluate(() => {
    applyTheme('dusk');
    const straight = window.__park();
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const band = () => window.__px3(0, Math.floor(h * 0.30), w, Math.floor(h * 0.45));
    const settle = () => window.__settle(70);
    const themeLit = th => [th.amb[0] + th.lc[0] * .55, th.amb[1] + th.lc[1] * .55,
                            th.amb[2] + th.lc[2] * .55];
    const A = band();

    const keep = TREE_TEX.night, realLit = window.treeLit;
    TREE_TEX.night = null; TREE_TEX.tex = {};
    settle();
    const fellBack = treeKind();
    const B = band();

    TREE_TEX.night = keep; TREE_TEX.tex = {};
    window.treeLit = themeLit;
    settle();
    const C = band();
    window.treeLit = realLit;
    TREE_TEX.tex = {};
    settle();
    const D = band();                                  // nothing changed: the control
    state = 'play';

    /* Counted only where the frames disagree, which is the trees and nothing
       else. A vs D is the same shot taken again with nothing touched, and it is
       the reading that says so: it comes back at zero, so every pixel counted
       below is one the change actually moved. */
    const cmp = (X, Y) => {
      let n = 0, lx = 0, ly = 0;
      for (let i = 0; i < X.length; i += 4) {
        const d = Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]);
        if (d < 24) continue;
        n++;
        lx += X[i] * .3 + X[i + 1] * .6 + X[i + 2] * .1;
        ly += Y[i] * .3 + Y[i + 1] * .6 + Y[i + 2] * .1;
      }
      return { n, a: +(lx / Math.max(1, n)).toFixed(1), b: +(ly / Math.max(1, n)).toFixed(1) };
    };
    return { straight, fellBack, sampled: A.length / 4,
             vsPainted: cmp(A, B), vsDoubleDim: cmp(A, C), control: cmp(A, D).n };
  });
  /* Measured on the 1043 m straight in Autokomanda, twice, within 5%: 7,022
     pixels move against the painted tree and 7,327 against the double-dim, the
     latter at luma 45 where the dimmed one is 10. Four and a half times, near
     enough to the five the two lighting terms differ by; the fog closes the gap
     on the far half of the avenue. And with the fix removed the counts are not
     smaller, they are zero — the control above says these frames are identical
     to the bit when nothing changes. */
  out.onScreen = out.frame.vsPainted.n > 2500 && out.frame.fellBack === 'painted' &&
                 out.frame.control === 0;
  out.litOnce = out.frame.vsDoubleDim.n > 2500 &&
                out.frame.vsDoubleDim.a > out.frame.vsDoubleDim.b * 1.6;

  out.glErrs = errs.slice(0, 3);
  await p.close();
}

/* ================= 2. the software renderer, on a browser with no WebGL ======= */
{
  const { p, errs } = await open({ noWebGL: true });
  /* The decode is kicked off by the first tree the renderer asks for, so there is
     always a frame or two of painted trees before it lands — 30 KB out of a data:
     URI, but an <img> is asynchronous however local it is. Waited for here rather
     than papered over, because a fixed timeout would eventually flake and because
     the fallback those first frames use is the subject of the last section. */
  await p.evaluate(() => { window.__setMode3d(true); applyTheme('dusk'); });
  await p.waitForFunction(() => treeKind() === 'night', null, { timeout: 15000 }).catch(() => {});
  out.soft = await p.evaluate(() => {
    applyTheme('dusk');
    const straight = window.__park();
    const c = document.getElementById('game'), g = c.getContext('2d');
    const w = c.width, h = c.height;
    const band = () => g.getImageData(0, Math.floor(h * 0.30), w, Math.floor(h * 0.45)).data;
    /* The tinted copy is cached per theme, so it has to be dropped between the
       three frames — a stale entry would make them identical and prove nothing. */
    const settle = () => {
      for (const k in TREE_ART) delete TREE_ART[k];
      window.__settle(70);
    };
    const themeLit = th => [th.amb[0] + th.lc[0] * .55, th.amb[1] + th.lc[1] * .55,
                            th.amb[2] + th.lc[2] * .55];
    const A = band();

    const keep = TREE_TEX.night, realLit = window.treeLit;
    TREE_TEX.night = null;
    settle();
    const B = band();                                  // the painted tree
    TREE_TEX.night = keep;
    window.treeLit = themeLit;
    settle();
    const C = band();                                  // the photograph, dimmed twice
    window.treeLit = realLit;
    settle();
    const D = band();                                  // the control, as above
    state = 'play';

    const cmp = (X, Y) => {
      let n = 0, lx = 0, ly = 0;
      for (let i = 0; i < X.length; i += 4) {
        const d = Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]);
        if (d < 24) continue;
        n++;
        lx += X[i] * .3 + X[i + 1] * .6 + X[i + 2] * .1;
        ly += Y[i] * .3 + Y[i + 1] * .6 + Y[i + 2] * .1;
      }
      return { n, a: +(lx / Math.max(1, n)).toFixed(1), b: +(ly / Math.max(1, n)).toFixed(1) };
    };
    return { soft: SOFT3D, kind: treeKind(), art: softTreeArt(SKY.dusk).width, straight,
             vsPainted: cmp(A, B), vsDoubleDim: cmp(A, C), control: cmp(A, D).n };
  });
  out.softDrawsIt = out.soft.soft === true && out.soft.kind === 'night' &&
                    out.soft.art === 192 && out.soft.control === 0 && out.soft.vsPainted.n > 800 &&
                    out.soft.vsDoubleDim.n > 800 &&
                    out.soft.vsDoubleDim.a > out.soft.vsDoubleDim.b * 1.4;

  /* And the day theme must not be handed the dusk tree out of that same cache. */
  out.themeCache = await p.evaluate(() => {
    applyTheme('day');
    const day = { kind: treeKind(), art: softTreeArt(SKY.day).width };
    applyTheme('dusk');
    const dusk = { kind: treeKind(), art: softTreeArt(SKY.dusk).width };
    return { day, dusk };
  });
  out.cacheKeyedByTheme = out.themeCache.day.art === 128 && out.themeCache.dusk.art === 192;

  out.softErrs = errs.slice(0, 3);
  await p.close();
}

/* ================= 3. and without js/foliage.js at all ================= */
/* It is one generated file carrying one picture. If it 404s, is blocked, or is
   simply not in a cache that has the rest of the build, the game has to start and
   the trees have to be there — painted, as they were. It is deliberately not in
   index.html's integrity check for the same reason: that check blocks the DRIVE
   button, which is the right answer for a file whose absence is a crash and the
   wrong one for a file whose absence is plainer foliage. */
{
  const { p, errs } = await open({ noFoliage: true });
  out.without = await p.evaluate(() => {
    const on = window.__setMode3d(true);
    applyTheme('dusk');
    const straight = window.__park();
    const has = typeof TREE_NIGHT_PNG;
    const cv = treeCanvas();
    state = 'play';
    return { on, has, kind: treeKind(), w: cv ? cv.width : null, straight,
             boot: window.__boot ? window.__boot.ok : null };
  });
  out.paintedWithoutIt = out.without.has === 'undefined' && out.without.kind === 'painted' &&
                         out.without.w === 128 && out.without.boot === true;
  out.withoutErrs = errs.filter(e => !/foliage/.test(e)).slice(0, 3);
  await p.close();
}

out.errs = [].concat(out.glErrs, out.softErrs, out.withoutErrs).filter(Boolean);
out.pass = out.photographAfterDark && out.hasLeafDetail && out.onScreen && out.litOnce &&
           out.softDrawsIt && out.cacheKeyedByTheme && out.paintedWithoutIt && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
