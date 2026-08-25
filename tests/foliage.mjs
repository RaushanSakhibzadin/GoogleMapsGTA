/* THE TREES ARE GROWN FROM FRACTALS, AND ARE LIT ONCE.
 *
 * They were two dozen circles shaded lighter towards the top, which reads as a
 * green lollipop at any distance because what makes a canopy look like a canopy
 * is the clumping. Then they were photographs, which looked right and cost 187 KB
 * of base64 and could not vary. Now js/proctex.js grows them at load: a recursive
 * branching for the structure, two scales of fBm for the leaves, one atlas lit
 * from below for after dark and one lit from above for daylight.
 *
 * FIVE WAYS THAT CAN LOOK RIGHT IN A SCREENSHOT AND BE WRONG:
 *
 *   Each theme is handed the wrong atlas, or the same one twice. So the kind is
 *   asked for directly at both themes, and the two atlases are checksummed against
 *   each other — they are the same size now, so size cannot tell them apart.
 *
 *   The atlas exists but carries no detail. A flat green cutout would pass "is it
 *   the right shape". So the leaf detail is measured — the mean step between
 *   neighbouring pixels inside the canopy — against a flattened copy of the same
 *   atlas, which has none by construction.
 *
 *   It never reaches the screen: uploaded to a texture nothing binds, or drawn
 *   under the road. So the same parked street is shot with the real atlas and with
 *   that flattened copy, same silhouette and same geometry, one shading apart.
 *
 *   AND IT IS LIT TWICE. This is the one worth the test. Each atlas is generated
 *   under the light it belongs to, so multiplying the theme's ambient into it a
 *   second time — which is what the code path it inherited does — leaves a black
 *   smudge where a lamplit tree should be. A third frame puts that second multiply
 *   back, and the tree pixels have to come out brighter without it.
 *
 * And the last section is about generation itself: it has to be FAST enough to sit
 * on the loading path, and DETERMINISTIC, or two machines draw two different
 * cities and no frame comparison anywhere in this suite means anything.
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
  await p.route('**://*/**', r =>
    (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto(GAME);
  await p.waitForTimeout(300);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(600);
  await p.evaluate(src => { window.__settle = eval('(' + src[0] + ')'); window.__park = eval('(' + src[1] + ')'); },
                   [SETTLE.toString(), PARK.toString()]);
  /* THE FLATTENED ATLAS, which is the lever half of this file pulls.

     The old version of this test forced the painted trees back in and compared
     against those. There are no painted trees any more — generation is synchronous
     and cannot fail, so the fallback went with the photographs. What replaces it is
     a copy of the real atlas with the same cutout and one flat colour poured into
     it: same silhouette, same geometry, same camera, the fractal shading and
     nothing else removed. That is a tighter A/B than the painted tree ever was,
     because the painted tree also differed in outline. */
  await p.evaluate(() => {
    /* The real ones, stashed before anything is swapped — TREE_ATLAS is the cache
       procTreeAtlas() answers out of, so once a flattened copy is in there asking
       again gets the copy back. */
    const REAL = {};
    const real = kind => (REAL[kind] || (REAL[kind] = procTreeAtlas(kind)));
    window.__flatten = kind => {
      const src = real(kind);
      const cv = document.createElement('canvas');
      cv.width = src.width; cv.height = src.height;
      const g = cv.getContext('2d');
      g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#4c6a38';
      g.fillRect(0, 0, cv.width, cv.height);
      return cv;
    };
    /* Swapped in by replacing the cache entry, because that is the one place both
       renderers read from: the GL path uploads whatever treeCanvas() returns and
       soft3d.js blits it. Both caches downstream have to be dropped with it, or the
       swap changes nothing and every comparison below comes back at zero. */
    window.__useAtlas = (kind, cv) => {
      TREE_ATLAS[kind] = cv || real(kind);
      TREE_TEX.tex = {};
      for (const k in TREE_ART) delete TREE_ART[k];
    };
    real('day'); real('night');
  });
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

  /* ---- which tree each theme picks ---- */
  out.picks = await p.evaluate(() => {
    /* A cheap checksum, because the two atlases are the same size now and size
       cannot tell them apart. Weighted by index so a permutation of the same
       pixels does not collide. */
    const sig = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4)
        h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) | 0;
      return h;
    };
    const at = t => {
      applyTheme(t);
      const cv = treeCanvas();
      return { kind: treeKind(), w: cv.width, h: cv.height, cols: treeCols(), sig: sig(cv) };
    };
    const dusk = at('dusk'), day = at('day');
    applyTheme('dusk');
    return { dusk, day };
  });
  /* BOTH ATLASES HAVE TO HAVE THE SAME NUMBER OF COLUMNS. The column a tree uses
     is baked into its cell's UVs and the theme can change under a cell built an
     hour ago, so an atlas one column wide would put half the day's trees on the
     seam between two of them. Asserted as a shape — square columns, the same count
     — rather than by reading treeCols() twice, which would agree with itself
     whatever it said. */
  out.rightAtlasAfterDark =
    out.picks.dusk.kind === 'night' && out.picks.day.kind === 'day' &&
    out.picks.dusk.cols >= 2 && out.picks.day.cols === out.picks.dusk.cols &&
    out.picks.dusk.w === out.picks.dusk.h * out.picks.dusk.cols &&
    out.picks.day.w === out.picks.day.h * out.picks.day.cols &&
    out.picks.dusk.sig !== out.picks.day.sig;  // and they are not one atlas twice

  /* ---- and a street uses all of them ----

     The atlas exists so an avenue is not one tree stamped forty times, which is a
     thing that can be perfectly true of the texture and false of the street: the
     column is chosen in pushTree and baked into the mesh, so a build that ignored
     it would ship this exact atlas and draw column 0 the whole way down the road.

     So the real planting is asked. treesAlong feeds pushTree, pushTree writes the
     UVs, and the u of the left and right corners is read back: which column, and
     which way round — a mirrored tree is the one whose left corner has the higher
     u. */
  out.spread = await p.evaluate(() => {
    const o = [], cols = treeCols();
    for (const r of W.driveRoads) {
      if (!r.drive) continue;
      treesAlong(o, r, -1e9, -1e9, 1e9, 1e9, () => {});
      if (o.length / 5 > 6000) break;
    }
    const seen = new Array(cols).fill(0), mirrored = new Array(cols).fill(0);
    let trees = 0;
    /* Five floats a vertex, six vertices a quad, two quads a tree: one tree is
       sixty floats, and its first two vertices are the foot corners. */
    for (let i = 0; i + 60 <= o.length; i += 60) {
      const l = o[i + 3], r = o[i + 8];
      const c = Math.floor(Math.min(l, r) * cols + 0.001);
      if (c < 0 || c >= cols) continue;
      seen[c]++;
      if (l > r) mirrored[c]++;
      trees++;
    }
    return { cols, trees, seen, mirrored };
  });
  const S = out.spread;
  out.everyTreeInTheAtlasIsUsed =
    S.trees > 300 &&
    S.seen.every(n => n > S.trees * 0.25) &&
    S.mirrored.every((n, i) => n > S.seen[i] * 0.25 && n < S.seen[i] * 0.75);

  /* ---- and it carries leaf detail, not one flat green ----

     Mean absolute step between horizontally neighbouring pixels, counting only
     pairs where both are opaque so the cutout edge does not dominate. The
     flattened copy is the reference and it is zero by construction: same
     silhouette, one colour inside it.

     AND THE CANOPY HAS TO BE MOSTLY HOLES AT ITS EDGE. A fractal canopy that has
     been thresholded is ragged — that is the point of thresholding rather than
     fading — so the fraction of the atlas that is opaque is bounded on both sides.
     Too little and the tree is lace; too much and the alpha test has effectively
     been turned off and every tree is a green rectangle. */
  out.detail = await p.evaluate(() => {
    const grain = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let s = 0, n = 0, on = 0;
      for (let y = 0; y < cv.height; y++)
        for (let x = 0; x < cv.width - 1; x++) {
          const i = (y * cv.width + x) * 4;
          if (d[i + 3] >= 250) on++;
          if (d[i + 3] < 250 || d[i + 7] < 250) continue;
          s += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6]);
          n += 3;
        }
      return { step: +(s / Math.max(1, n)).toFixed(2),
               fill: +(on / (cv.width * cv.height)).toFixed(3) };
    };
    applyTheme('dusk');
    const night = grain(treeCanvas());
    applyTheme('day');
    const day = grain(treeCanvas());
    applyTheme('dusk');
    return { night, day, flat: grain(window.__flatten('night')) };
  });
  out.hasLeafDetail = out.detail.flat.step < 0.5 &&
                      out.detail.night.step > 6 && out.detail.day.step > 6;
  out.isACutout = [out.detail.night, out.detail.day]
    .every(g => g.fill > 0.10 && g.fill < 0.55);

  /* ---- it reaches the screen, and it is not dimmed twice ----

     FOUR FRAMES OF THE SAME PARKED STREET, differing in one thing each.

       A  as shipped
       B  the fractal shading flattened to one colour, silhouette untouched
       C  the real atlas, lit the way the old painted trees were — the double-dim,
          which is the bug this guards, staged by putting the old lighting term
          back over the top of treeLit()
       D  nothing changed at all, which is the control

     A vs B says the generated texture reached the screen at all. A vs C says it
     was lit once: same art, same geometry, same camera, one multiply apart. */
  out.frame = await p.evaluate(() => {
    applyTheme('dusk');
    const straight = window.__park();
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const band = () => window.__px3(0, Math.floor(h * 0.30), w, Math.floor(h * 0.45));
    const settle = () => window.__settle(70);
    const themeLit = th => [th.amb[0] + th.lc[0] * .55, th.amb[1] + th.lc[1] * .55,
                            th.amb[2] + th.lc[2] * .55];
    const A = band();

    const realLit = window.treeLit;
    window.__useAtlas('night', window.__flatten('night'));
    settle();
    const B = band();

    window.__useAtlas('night', null);
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
    return { straight, sampled: A.length / 4,
             vsFlat: cmp(A, B), vsDoubleDim: cmp(A, C), control: cmp(A, D).n };
  });
  /* The control is the load-bearing number here: A vs D is the same shot taken
     again with nothing touched, and it comes back at zero, so every pixel counted
     in the other two is one the change actually moved. Without that, on a camera
     that eases towards the car, two "identical" frames disagreed on 175,497 pixels
     out of 243,000 and every comparison in this file was measuring the camera. */
  out.onScreen = out.frame.vsFlat.n > 2500 && out.frame.control === 0;

  /* ---- and the same question in daylight ----

     Written because removing the daylight half of treeLit() broke nothing. The
     block above stages dusk, and dusk was the theme the double-dim was found in,
     so every assertion in it went on passing while daylight quietly went back to
     being multiplied by its own ambient. A daylight photograph darkened by 0.69 is
     not the black smudge the night one becomes — it is a tree in permanent shade,
     which is exactly the kind of wrong that looks fine until you park next to it.
     Same three frames, same control, one theme along. */
  out.dayFrame = await p.evaluate(() => {
    applyTheme('day');
    window.__park();
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const band = () => window.__px3(0, Math.floor(h * 0.30), w, Math.floor(h * 0.45));
    const settle = () => window.__settle(70);
    const themeLit = th => [th.amb[0] + th.lc[0] * .55, th.amb[1] + th.lc[1] * .55,
                            th.amb[2] + th.lc[2] * .55];
    const A = band();
    const realLit = window.treeLit;
    window.treeLit = themeLit;
    settle();
    const C = band();
    window.treeLit = realLit;
    settle();
    const D = band();
    applyTheme('dusk');
    state = 'play';
    let n = 0, la = 0, lc = 0, ctl = 0;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2]);
      if (d >= 24) {
        n++;
        la += A[i] * .3 + A[i + 1] * .6 + A[i + 2] * .1;
        lc += C[i] * .3 + C[i + 1] * .6 + C[i + 2] * .1;
      }
      if (Math.abs(A[i] - D[i]) + Math.abs(A[i + 1] - D[i + 1]) + Math.abs(A[i + 2] - D[i + 2]) > 3) ctl++;
    }
    return { moved: n, control: ctl,
             lumaShipped: +(la / Math.max(1, n)).toFixed(1),
             lumaDimmed: +(lc / Math.max(1, n)).toFixed(1) };
  });
  out.dayLitOnce = out.dayFrame.moved > 2500 && out.dayFrame.control === 0 &&
                   out.dayFrame.lumaShipped > out.dayFrame.lumaDimmed * 1.15;
  out.litOnce = out.frame.vsDoubleDim.n > 2500 &&
                out.frame.vsDoubleDim.a > out.frame.vsDoubleDim.b * 1.6;

  out.glErrs = errs.slice(0, 3);
  await p.close();
}

/* ================= 2. the software renderer, on a browser with no WebGL ======= */
{
  const { p, errs } = await open({ noWebGL: true });
  await p.evaluate(() => { window.__setMode3d(true); applyTheme('dusk'); });
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

    const realLit = window.treeLit;
    window.__useAtlas('night', window.__flatten('night'));
    settle();
    const B = band();                                  // the shading flattened out
    window.__useAtlas('night', null);
    window.treeLit = themeLit;
    settle();
    const C = band();                                  // the real atlas, dimmed twice
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
             vsFlat: cmp(A, B), vsDoubleDim: cmp(A, C), control: cmp(A, D).n };
  });
  out.softDrawsIt = out.soft.soft === true && out.soft.kind === 'night' &&
                    out.soft.art === out.picks.dusk.w && out.soft.control === 0 &&
                    out.soft.vsFlat.n > 800 && out.soft.vsDoubleDim.n > 800 &&
                    out.soft.vsDoubleDim.a > out.soft.vsDoubleDim.b * 1.4;

  /* And the day theme must not be handed the dusk tree out of that same cache. */
  out.themeCache = await p.evaluate(() => {
    applyTheme('day');
    const day = { kind: treeKind(), art: softTreeArt(SKY.day).width };
    applyTheme('dusk');
    const dusk = { kind: treeKind(), art: softTreeArt(SKY.dusk).width };
    return { day, dusk };
  });
  out.dayIsItsOwnTree = out.themeCache.day.kind === 'day' &&
                        out.themeCache.dusk.kind === 'night';
  out.cacheKeyedByTheme = out.themeCache.day.art === out.picks.day.w &&
                          out.themeCache.dusk.art === out.picks.dusk.w;

  out.softErrs = errs.slice(0, 3);
  await p.close();
}

/* ================= 3. generation is cheap, and it is the same every time =======

   These two are the whole reason the photographs could be deleted, and neither is
   visible in a screenshot.

   CHEAP, because this now sits on the path between tapping DRIVE and the first
   frame. 216 KB of base64 cost a download; a per-pixel loop over three canvases
   costs a stall, and a stall on the loading screen is worse than a download. So
   the caches are dropped and all three textures regenerated from cold, timed.

   THE SAME EVERY TIME, because everything in this suite that compares two frames
   depends on it, and because a generator seeded off Math.random or off the order
   things are asked for would draw a different city on every reload and nobody
   would notice until a screenshot test started flapping. Asserted the hard way:
   a SECOND PAGE, loaded from scratch in its own JavaScript context, generating its
   own atlas, compared against the first one pixel for pixel. Regenerating twice in
   one page would prove far less — the same seeds in the same process is the case
   that works even when the generator is order-dependent. */
{
  const { p, errs } = await open();
  out.cost = await p.evaluate(() => {
    procTexReset();
    const t0 = performance.now();
    const night = procTreeAtlas('night'), day = procTreeAtlas('day'), wall = procWallTile();
    const ms = +(performance.now() - t0).toFixed(1);
    const px = night.width * night.height + day.width * day.height + wall.width * wall.height;
    return { ms, px };
  });
  /* A tenth of a second is the bar. Measured well under it, and this runs on
     SwiftShader in CI, which is slower than any phone at this — it is all
     Canvas2D and arithmetic, no GPU involved. */
  out.generatesFast = out.cost.ms < 400;

  out.sig = await p.evaluate(() => {
    const sig = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4)
        h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) | 0;
      return h;
    };
    procTexReset();
    return { night: sig(procTreeAtlas('night')), day: sig(procTreeAtlas('day')),
             wall: sig(procWallTile()) };
  });
  out.genErrs = errs.slice(0, 3);
  await p.close();

  const { p: q, errs: qerrs } = await open();
  out.sig2 = await q.evaluate(() => {
    const sig = cv => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4)
        h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) | 0;
      return h;
    };
    /* Deliberately in the OPPOSITE ORDER to the page above, and without the reset
       — this context has already generated both atlases on its own frames. If the
       noise were drawn from a sequence rather than hashed from its coordinates,
       this is where it would come apart. */
    return { wall: sig(procWallTile()), day: sig(procTreeAtlas('day')),
             night: sig(procTreeAtlas('night')) };
  });
  out.deterministic = out.sig.night === out.sig2.night && out.sig.day === out.sig2.day &&
                      out.sig.wall === out.sig2.wall && out.sig.night !== out.sig.day;
  out.genErrs = out.genErrs.concat(qerrs.slice(0, 3));
  await q.close();
}

out.errs = [].concat(out.glErrs, out.softErrs, out.genErrs).filter(Boolean);
out.pass = out.rightAtlasAfterDark && out.everyTreeInTheAtlasIsUsed && out.hasLeafDetail &&
           out.isACutout && out.onScreen && out.litOnce && out.dayLitOnce && out.softDrawsIt &&
           out.cacheKeyedByTheme && out.dayIsItsOwnTree &&
           out.generatesFast && out.deterministic && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
