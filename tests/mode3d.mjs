/* THE CHASE VIEW: that it draws, that it occludes, and that the sun casts.

   Every assertion here has been run against a build with the thing it checks
   taken out — that is the house rule, and for a renderer it is the only rule
   that matters, because a renderer test written against a working build passes
   just as happily on a black screen.

   Pixels are read straight out of the WebGL back buffer through __px3, which
   renders and reads inside one task. Screenshots would work too, but a
   screenshot is a PNG this repo has no decoder for, and comparing two of them
   byte for byte cannot tell "the shadow moved" from "the fog changed".

   IT RUNS ON A SOFTWARE RASTERISER. Headless Chromium here is SwiftShader —
   ANGLE over a CPU Vulkan device — so wall-clock frame rate in this file
   measures an emulator and not the renderer: the same scene that manages 8 fps
   here is a rounding error on any GPU made this decade. What IS meaningful is
   the CPU time spent building and issuing the frame, which is ours, so that is
   what is gated. The fps number is recorded and checked only for a pulse.

   It runs offline on the bundled city — every non-file request is aborted — so
   there is a real street grid with real building footprints and no network. */
import { chromium } from 'playwright';
import { CHROME, GAME, SHOTS } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
/* The route below aborts every non-file request, which the page duly reports as
   a failed resource. That is the test's own doing, not the game's. */
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text()))
    errs.push('console: ' + m.text());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};

/* ---------- 1. it turns on at all ---------- */
out.startsIn2D = (await p.evaluate(() => window.__mode3d())) === false;
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  /* No WebGL2 is a legitimate answer on some machines, and the game is designed
     to say so and carry on in 2D. Reporting that as a failure would be reporting
     the environment, not the code. */
  console.log(JSON.stringify({ skipped: 'no WebGL2 on this machine',
                               gl: await p.evaluate(() => window.__gl3()) }, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(1500);
out.renderer = await p.evaluate(() => {
  const g = document.createElement('canvas').getContext('webgl2');
  const d = g && g.getExtension('WEBGL_debug_renderer_info');
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
out.gl = await p.evaluate(() => window.__gl3());
out.on = await p.evaluate(() => window.__mode3d());
out.canvasShown = await p.evaluate(() => getComputedStyle(document.getElementById('gl')).display);
out.buttonSaysBack = await p.evaluate(() => document.getElementById('modeN').textContent);

/* Park where there is actually a city, and stand still. The first version of
   this picked the LONGEST road segment, which in a real street network is a
   bypass with fields on both sides — the frame was a beautifully rendered empty
   road, and "are the buildings drawn" measured 5% either way. */
out.spot = await p.evaluate(() => {
  const rs = window.__roadList().filter(r => r.pts.length > 1);
  let best = null, bestN = -1;
  for (const r of rs) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 40) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let n = 0;
    for (const q of W.buildings) if (Math.abs(q.cx - mx) < 120 && Math.abs(q.cy - my) < 120) n++;
    if (n > bestN) { bestN = n; best = [a, b]; }
  }
  if (!best) return null;
  const [a, b] = best;
  window.__tp((a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x));
  window.__calm();
  return { neighbours: bestN };
});
await p.waitForTimeout(1800);

/* ---------- 2. the frame is a picture, not a flat colour ---------- */
/* THE FAILURE THIS CATCHES is the most common one a 3D renderer has: a matrix
   subtly wrong, or geometry wound so back-face culling eats it, leaves a screen
   of clear colour and not a single error anywhere. It happened here — the ground
   grid was wound backwards and the whole terrain was invisible, with the roads
   left hanging in the sky.

   Distinct colours rather than "is it all one value", because a broken frame is
   usually clear colour plus a couple of stray triangles. */
const stats = px => {
  const seen = new Set();
  let lo = 255, hi = 0, sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    seen.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
    const L = .2126 * r + .7152 * g + .0722 * b;
    if (L < lo) lo = L; if (L > hi) hi = L;
    sum += L; n++;
  }
  return { colours: seen.size, lo: Math.round(lo), hi: Math.round(hi), mean: +(sum / n).toFixed(2) };
};
const grab = (x, y, w, h) => p.evaluate(a => window.__px3(a[0], a[1], a[2], a[3]), [x, y, w, h]);
const dpr = await p.evaluate(() => DPR);
const W = Math.floor(900 * dpr), H = Math.floor(600 * dpr);
out.frame = stats(await grab(0, 0, W, H));

/* ---------- 3. buildings stand in front of the sky ---------- */
/* COUNTING SKY OVER THE WHOLE FRAME DOES NOT WORK, and the first version of this
   test did it anyway. Fog fades distant ground to exactly the sky colour — that
   is what fog is for — so "pixels the colour of the clear" counts the far half
   of the map as sky and barely moves when the buildings go. It measured 24%
   either way.

   The TOP BAND does work. The camera looks a few degrees below level, so the top
   fifth of the frame is above the horizon and is pure sky unless something is
   standing up into it. That makes this an occlusion test rather than a "was
   anything drawn" test: a wall appears there only if it is drawn in front of the
   sky, at the right height, and survives the depth test.

   WHAT IS COUNTED IS VERTICAL EDGES, not "pixels that are not the sky colour",
   and that is because the sky stopped being a colour. It is a gradient now, with
   the sun's glow spread through it, so almost no pixel in the band matches any
   single reference value and the old measure read 73% sky-free with every
   building deleted.

   An edge is immune to all of that. A gradient is smooth in both directions —
   neighbouring pixels differ by a unit or so, glow or no glow — and a skyline is
   nothing but hard vertical steps where a roofline meets the air. So: how often
   does the luma jump between horizontally adjacent pixels. Buildings drawn
   behind the sky, or not drawn, or failing the depth test, all give the same
   answer, which is none. */
const topBandEdges = () => p.evaluate(() => {
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const band = Math.floor(h * 0.22);
  // readPixels is bottom-left origin, so this reads the TOP of the screen
  const px = window.__px3(0, h - band, w, band);
  const L = i => .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
  let edges = 0, n = 0;
  for (let y = 0; y < band; y++) for (let x = 0; x + 1 < w; x++, n++) {
    const i = (y * w + x) * 4;
    if (Math.abs(L(i + 4) - L(i)) > 12) edges++;
  }
  return +(100 * edges / n).toFixed(2);
});
out.topWithBuildings = await topBandEdges();
const withPx = await grab(0, 0, W, H);
/* The spatial hash holds INDICES into W.buildings, so emptying the list without
   clearing the hash leaves every bucket pointing past the end of it — and the
   collision loop then throws once per bucket per frame. The game never reaches
   that state (evictFarTiles clears and reindexes in the same breath); this test
   would, so it does the same thing. */
await p.evaluate(() => {
  window.__keepB3 = W.buildings;
  W.buildings = [];
  W.buckets.clear();
});
// the cell cache is keyed on the world's shape, so emptying it rebuilds
await p.waitForTimeout(1800);
out.topWithout = await topBandEdges();
const withoutPx = await grab(0, 0, W, H);
await p.evaluate(() => {
  W.buildings = window.__keepB3;
  W.buckets.clear();
  indexBuildings(0);
});
await p.waitForTimeout(1800);
{
  let diff = 0;
  for (let i = 0; i < withPx.length; i += 4)
    if (Math.abs(withPx[i] - withoutPx[i]) > 6 || Math.abs(withPx[i + 1] - withoutPx[i + 1]) > 6) diff++;
  out.buildingPixels = +(100 * diff / (withPx.length / 4)).toFixed(1);
}
out.occludes = out.topWithBuildings > 1.2 &&
               out.topWithout < out.topWithBuildings * 0.35 &&
               out.buildingPixels > 10;

/* ---------- 4. the sun casts ---------- */
/* ONE FRAME, TWICE, DIFFERING BY ONE UNIFORM. __noShadow leaves the light, the
   sun disc, the fog and the geometry exactly as they are and only stops surfaces
   asking the depth map — so anything that changes between the two readings is a
   shadow and can be nothing else. On a build with no shadow map they come out
   identical and this reads zero, which is how it was checked.

   THREE renders, not two. Each __px3 advances the clock a little — traffic
   moves, the camera eases — so a straight A/B has a noise floor, and the first
   version of this measured 1.2% of the frame getting BRIGHTER when shadows were
   switched on, which is impossible and was entirely cars driving past. The two
   shadowed frames bracket the unshadowed one, and any pixel that differs between
   them is thrown out.

   AND THE WORLD IS FROZEN FIRST, which the bracket alone stopped being enough
   for. The bracket rejects a pixel that moved, and it worked while the scene was
   flat colour: a pixel that had drifted half a metre still read almost the same.
   Facades have windows now, so half a metre of camera drift swings a wall pixel
   between glass and plaster, and a pixel that happens to land on plaster in both
   bracketing frames while the middle one caught glass sails through the filter
   as a "shadow" several shades deep. It measured 4.7% of the frame getting
   BRIGHTER with shadows switched on, which is again impossible.

   Setting state to pause stops update() and stops the loop rendering; __px3
   renders on demand regardless, so frames can still be taken. The car does not
   move, no traffic moves, and the chase camera — which eases towards a target
   that is now stationary — converges within a couple of frames, which is what
   the two warm-up renders are for. After that the three grabs genuinely differ
   by one uniform and by nothing else. */
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(600);
await p.evaluate(() => {
  window.__keepState3 = state;
  state = 'pause';
  window.__px3(0, 0, 1, 1); window.__px3(0, 0, 1, 1); window.__px3(0, 0, 1, 1);
});
const lit = await grab(0, 0, W, H);
await p.evaluate(() => window.__noShadow(true));
const unlit = await grab(0, 0, W, H);
await p.evaluate(() => window.__noShadow(false));
const lit2 = await grab(0, 0, W, H);
await p.evaluate(() => { state = window.__keepState3; });
let darker = 0, lighter = 0, drop = 0, moved = 0;
const L = (px, i) => .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
for (let i = 0; i < lit.length; i += 4) {
  const a = L(lit, i), a2 = L(lit2, i), b = L(unlit, i);
  if (Math.abs(a - a2) > 2) { moved++; continue; }        // something drove past
  if (a < b - 3) { darker++; drop += b - a; }
  else if (a > b + 3) lighter++;
}
const total = lit.length / 4;
out.shadowMoved = +(100 * moved / total).toFixed(2);
out.shadowMap = { has: out.gl.shadow, size: out.gl.shadowSize, casting: out.gl.shadowTris };
out.shadowPixels = +(100 * darker / total).toFixed(2);   // % of the frame in shadow
out.shadowBrighter = +(100 * lighter / total).toFixed(2);
out.shadowDepth = darker ? +(drop / darker).toFixed(1) : 0;
out.casts =
  out.gl.shadow &&
  out.gl.shadowTris > 100 &&        // something is actually drawn into the map
  out.shadowPixels > 1.5 &&         // and it lands on a real part of the frame
  out.shadowDepth > 8 &&            // dark enough to see
  // switching shadows ON must never brighten anything; whatever survives the
  // moved-pixel filter and got lighter is measurement error, not a shadow
  out.shadowBrighter < 0.15;

/* ---------- 5. the sun is where the light says it is ---------- */
/* The disc and the shading read the same vector, so what is worth checking is
   that the vector reaches the screen: point the camera along it and the top of
   the frame gets brighter, point away and it does not. That fails on a build
   that draws the disc at a fixed screen position, or not at all — and it failed
   honestly once already, when the light sat at 34° and the disc was permanently
   above the top edge of a camera that looked 18° down. */
out.sun = await p.evaluate(() => window.__sun());
/* THE SAME PIXELS, SKY IN BOTH FRAMES. The strip across the top of the frame is
   mostly sky and partly rooftop, and three attempts at reading it went wrong in
   the same way — by comparing quantities that geometry could move.

   Its brightest pixel meant its brightest ROOFTOP whenever one reached that
   high, and the walls that reach it facing you are the ones facing AWAY from
   the sun, which are the lit ones: facing away duly measured brighter than
   facing towards, 236 to 199, with the sun in the right place all along. Taking
   the mean of the sky-coloured pixels instead swapped one confound for another,
   because the two directions do not show the same AMOUNT of sky — 42906 pixels
   against 27477 — and the sky has a vertical gradient, so a strip with more of
   it low down averages differently. That version passed with the glow deleted
   outright, which is the definition of a test that measures nothing.

   The sky's colour depends only on how high up the screen it is, so the same
   screen position in both frames is the same sky. Comparing pixel against pixel
   where both are sky holds the gradient still and leaves the one thing that does
   change with the direction the camera points: the glow around the sun. */
/* AND IT IS DONE FROM OPEN GROUND, because "sky in both frames" is only as good
   as the sky in the frames. Wherever the drive happened to stop, a tower on one
   side and none on the other means the two strips are not comparable at all: run
   inside the suite, with the timing that gives, this came back at -55 where the
   same build alone gives +16.6. So a spot is found with no building within a
   bucket of it in any direction, and the camera is turned on the axle there. */
out.openGround = await p.evaluate(() => {
  const clear = (x, y) => {
    const cx = Math.floor(x / W.bcell), cy = Math.floor(y / W.bcell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = W.buckets.get((cx + i) + ',' + (cy + j));
      if (arr && arr.length) return false;
    }
    return true;
  };
  for (const r of W.driveRoads) for (const q of r.pts) {
    if (!clear(q.x, q.y)) continue;
    window.__tp(q.x, q.y, 0);
    P.car.vx = P.car.vy = 0;
    traffic.length = 0; cops.length = 0; peds.length = 0;
    return { x: Math.round(q.x), y: Math.round(q.y) };
  }
  return null;
});
await p.waitForTimeout(1200);
const SKY_LO = Math.floor(H * 0.80), SKY_BAND = Math.floor(H * 0.18);
const skyish = (px, i) => px[i + 2] >= px[i] - 4;   // no masonry here is blue-led
const lumAt = (px, i) => .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
const strip = () => grab(0, SKY_LO, W, SKY_BAND);
const face = turn => p.evaluate(t => {
  const s = window.__sun();
  // the sun's compass bearing; +y is south in this projection
  window.__tp(P.car.x, P.car.y, Math.atan2(s.dir[2], s.dir[0]) + t);
  G3.cam.h = P.car.h;
}, turn);
await face(0);
await p.waitForTimeout(900);
const sunward = await strip();
await face(Math.PI);
await p.waitForTimeout(900);
const away = await strip();
{
  let sum = 0, n = 0;
  for (let i = 0; i < sunward.length; i += 4) {
    if (!skyish(sunward, i) || !skyish(away, i)) continue;
    sum += lumAt(sunward, i) - lumAt(away, i);
    n++;
  }
  out.glow = { pairs: n, gap: n ? +(sum / n).toFixed(2) : 0 };
  /* Threshold set from the measurement rather than from taste. From open ground
     the whole strip is sky in both frames — 97200 pairs of it — and the glow is
     worth +47.9 levels across them. A build with the glow line deleted from the
     sky shader gives +2.0, not zero, because the chase camera's pitch follows
     the ground and the two headings do not sit at exactly the same angle. Ten
     is five times clear of that and five times under the real thing. */
  out.sunVisible = !!out.openGround && out.glow.pairs > 20000 && out.glow.gap > 10;
}

/* ---------- 6. toScreen agrees with the camera ---------- */
/* The objective arrow, and several tests, ask toScreen() where a world point
   lands. In 2D that is four multiplications and can hardly be wrong; here it is
   a projection, and a projection quietly gets the behind-the-camera case
   backwards — the arrow to a pickup two streets behind you points forwards.
   Which is why the sign of that case is checked and not only the in-frame one. */
out.project = await p.evaluate(() => {
  const c = P.car, r = 90;
  const at = a => [c.x + Math.cos(a) * r, c.y + Math.sin(a) * r];
  const S = q => window.__project(q[0], q[1]);
  return { self: S([c.x, c.y]), ahead: S(at(c.h)), behind: S(at(c.h + Math.PI)),
           left: S(at(c.h + 1.2)), right: S(at(c.h - 1.2)), vw: VW, vh: VH };
});
{
  const q = out.project;
  const onScreen = s => s[0] > 0 && s[0] < q.vw && s[1] > 0 && s[1] < q.vh;
  out.projectsSelfLow = onScreen(q.self) && q.self[1] > q.vh * 0.45;
  out.projectsAhead = onScreen(q.ahead) && q.ahead[1] < q.self[1];
  out.projectsBehindOff = !onScreen(q.behind);
  // left and right must land on opposite sides, or the arrow points the wrong way
  out.projectsSidesApart = (q.left[0] - q.vw / 2) * (q.right[0] - q.vw / 2) < 0;
}

/* ---------- 6b. and it does not jump as a target passes behind ---------- */
/* THE ARROW'S BEARING HAS TO BE CONTINUOUS, and this is the assertion the first
   version of the projection needed and did not have. Behind the eye it returned
   a position with both signs inverted against the in-front branch, so the moment
   a target crossed out of view the arrow flipped a full half turn through the
   middle of the screen. A pickup sitting near that boundary crosses it again and
   again — reported, accurately, as the arrow jumping from side to side.

   Walking a target right round the car and watching the angle drawArrow would
   compute catches it: a smooth sweep steps a couple of degrees at a time, and a
   sign flip shows up as a step of nearly 180. It also catches the other half of
   the same bug, where a target directly behind projected onto the screen CENTRE
   and the arrow vanished entirely, because a centre point has no bearing at all. */
out.sweep = await p.evaluate(() => {
  const c = P.car, R = 140, N = 720;
  const ang = [], jumps = [];
  for (let i = 0; i < N; i++) {
    const t = i / N * Math.PI * 2;
    const s = window.__project(c.x + Math.cos(t) * R, c.y + Math.sin(t) * R);
    // the direction drawArrow actually uses: from the screen centre to the target
    ang.push(Math.atan2(s[1] - VH / 2, s[0] - VW / 2));
  }
  let worst = 0;
  for (let i = 0; i < N; i++) {
    let d = ang[(i + 1) % N] - ang[i];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    d = Math.abs(d) * 180 / Math.PI;
    if (d > worst) worst = d;
    if (d > 30) jumps.push({ at: Math.round(i / N * 360), step: +d.toFixed(1) });
  }
  return { biggestStepDeg: +worst.toFixed(1), jumps: jumps.slice(0, 6) };
});
/* HALF A DEGREE A STEP, so the threshold has room on both sides. Sampled at two
   degrees the smooth case already peaked at 23.9 against a 25 limit, which is not
   a margin — the perspective divide stretches hard near the edge of view, and a
   different viewport would have pushed it over. A smooth curve's largest step
   shrinks with the sampling interval and a sign flip does not, so sampling four
   times finer separates them properly: about six degrees for the real thing
   against the ~180 a flip through the screen centre produces. */
out.arrowIsSteady = out.sweep.biggestStepDeg < 30;

/* ---------- 7. going back to 2D really does go back ---------- */
out.back = await p.evaluate(() => {
  window.__setMode3d(false);
  const b = window.__body();
  return { mode: window.__mode3d(), terrain: b.terrain, ground: b.ground,
           gl: getComputedStyle(document.getElementById('gl')).display,
           button: document.getElementById('modeN').textContent };
});
await p.waitForTimeout(500);
out.twoDRestored = out.back.mode === false && out.back.terrain === false &&
                   out.back.ground === 0 && out.back.gl === 'none' && out.back.button === '3D';

/* ---------- 8. and the cost of a frame is ours, not the rasteriser's ---------- */
await p.evaluate(() => { window.__setMode3d(true); applyTheme('dusk'); });
await p.waitForTimeout(1400);
await p.evaluate(() => window.__setInput({ gas: 1 }));
await p.waitForTimeout(4000);
out.perf = await p.evaluate(() => window.__perf());
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 2000 ? requestAnimationFrame(tick) : r(Math.round(n / 2)); };
  requestAnimationFrame(tick);
}));
out.glAfterDrive = await p.evaluate(() => window.__gl3());
await p.evaluate(() => window.__setInput(null));

await p.screenshot({ path: `${SHOTS}/shot-3d.png` });
out.errs = errs.slice(0, 5);
out.pass =
  out.startsIn2D && out.on === true &&
  out.canvasShown === 'block' && out.buttonSaysBack === '2D' &&
  /* A frame that failed to draw the world is clear colour and a couple of stray
     triangles. A working dusk frame quantises to a few hundred distinct colours
     and a daylight one to several thousand; the floor is set for the dark case. */
  out.frame.colours > 150 && out.frame.hi - out.frame.lo > 60 &&
  out.occludes &&
  out.casts &&
  out.sunVisible &&
  out.projectsSelfLow && out.projectsAhead && out.projectsBehindOff && out.projectsSidesApart &&
  out.arrowIsSteady &&
  out.twoDRestored &&
  /* The gate is CPU time per frame — building cell geometry, walking the traffic,
     filling the streams, issuing the draws. That is the part this code owns and
     the part a regression shows up in. Wall-clock fps on SwiftShader is the
     rasteriser's business; it is checked only for a pulse, to catch a hang. */
  out.perf.ren < 8 && out.perf.upd < 6 &&
  out.fps >= 5 &&
  // cells must be getting recycled rather than accumulating for ever
  out.glAfterDrive.cells <= 44 &&
  !errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
