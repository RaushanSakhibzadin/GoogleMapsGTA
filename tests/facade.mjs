/* THE THINGS THAT MAKE THE CHASE VIEW LOOK LIKE A STREET: a graded sky, windows
   on the walls, and wheels under the cars.

   All three are pure appearance, which is exactly why they need a test that can
   fail. None of them would stop the game working, none of them show up in a
   physics assertion, and a shader that silently stopped drawing windows would
   never be noticed by any other file in this directory — it would just quietly
   go back to looking like a diagram.

   Every measurement is an A/B inside ONE build. __noWindows and __plainCars
   suppress one feature and touch nothing else, so a difference between the two
   readings is that feature and can be nothing else; the sky's own A/B is the
   ramp itself, which is identically zero the moment the gradient goes back to
   being a clear colour. Each assertion has additionally been run against a build
   with the feature deleted outright, and every one of them failed there.

   THE WORLD IS FROZEN for every comparison. state = 'pause' stops update() and
   stops the loop rendering, while __px3 still renders on demand — so the car,
   the traffic and (after a few frames of easing) the camera are all stationary
   and two grabs differ by one flag. Without it a facade pixel swings between
   glass and plaster on half a metre of camera drift, which swamps everything
   being measured. The warm-up renders matter for a second reason: cells are
   built ONE PER FRAME, and while the loop is stopped the only thing advancing
   that queue is __px3 itself, so a frozen frame keeps changing until the queue
   has drained.

   It runs offline on the bundled city — every non-file request is aborted — so
   there are real building footprints and no network. */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
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
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  /* No WebGL2 is a legitimate answer on some machines, and the game says so and
     carries on in 2D. Reporting that as a failure would be reporting the
     environment rather than the code. */
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2200);

/* PARK IN FRONT OF THE TALLEST THING NEARBY, rather than driving for a fixed
   number of seconds and hoping. Where six seconds of acceleration ends up
   depends on the traffic it met, and this test needs a facade filling a good
   part of the frame every single run — otherwise the window measurement is
   reading whatever happened to be on screen.

   Stood off the south face by half its depth plus thirty metres and pointed at
   it, so the chase camera is looking straight down the wall. */
out.parked = await p.evaluate(() => {
  let best = null;
  for (const b of W.buildings) {
    const d = Math.hypot(b.cx - P.car.x, b.cy - P.car.y);
    // tall, and near enough that its cell is already streamed in
    if (d > 700 || b.h < 14) continue;
    const s = b.h - d * 0.012;
    if (!best || s > best.s) best = { s, b };
  }
  if (!best) return null;
  const b = best.b;
  /* AND ON THE STREET, NOT IN SOMEBODY'S LIVING ROOM. Thirty metres off the wall
     is a distance, not an address: in a real district that lands inside the
     footprint of whatever is across the road about as often as not, and a car
     inside a footprint is stood on that building's ROOF, because groundCar puts
     it on the highest surface under it. From up there the chase camera is inside
     the block behind, the car is behind a wall, and sections 3 and 4 measure an
     empty street — which is what a car parked on a fourth floor looks like, and
     read as a rendering failure rather than as the staging.

     So the stand-off is searched rather than assumed: step back a metre at a
     time until both the car and the eye fourteen metres behind it are clear of
     every footprint. Nothing else about the shot changes — it is still square on
     to the same wall, just from a spot a car could actually be in. */
  const clear = (x, y) => !W.buildings.some(q =>
    x >= q.bb.x0 && x <= q.bb.x1 && y >= q.bb.y0 && y <= q.bb.y1 && pointInPoly(q.pts, x, y));
  const base = (b.bb.y1 - b.bb.y0) * 0.5 + 30;
  let off = base;
  for (let k = 0; k < 80; k++) {
    const y = b.cy - (base + k);
    if (clear(b.cx, y) && clear(b.cx, y - 14)) { off = base + k; break; }
  }
  window.__tp(b.cx, b.cy - off, Math.PI / 2);       // +y is north-ish; face the wall
  P.car.vx = P.car.vy = 0;
  /* GHOST, AND FULL HEALTH. Even on an empty bit of road the spot can be on top
     of a taxi, and the car then spends the seconds before the first measurement
     being crushed. On the runs where that happened it was wrecked by the time
     anything was read, the death camera took over, and both the facade and the
     wheels went with it — which read as a flaky test rather than as what it
     was. */
  window.__ghost(true);
  window.__heal();
  return { h: +b.h.toFixed(1), wide: +(b.bb.x1 - b.bb.x0).toFixed(1),
           stood: +off.toFixed(1), searched: +(off - base).toFixed(1) };
});
await p.waitForTimeout(3000);
// daylight, where a window is a dark rectangle on a light wall and the sky has
// the most range in it — dusk works too, with less of everything
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(700);

const dpr = await p.evaluate(() => DPR);
const W = Math.floor(900 * dpr), H = Math.floor(600 * dpr);
const grab = () => p.evaluate(a => window.__px3(0, 0, a[0], a[1]), [W, H]);
const freeze = () => p.evaluate(() => {
  window.__keepStateF = state;
  state = 'pause';
  P.car.vx = P.car.vy = 0;
  window.__heal();
  /* PUT THE MAP CAMERA ON THE CAR BEFORE STOPPING THE CLOCK. cam.x/cam.y is the
     2D camera, it leads the car by up to twenty-six metres at speed, and it is
     eased in update() — which is exactly what pausing stops. So whatever offset
     it was carrying at the moment of the freeze is the offset it keeps for every
     frame afterwards. It is not a cosmetic detail: the chase camera LOOKS at it,
     and the range test that decides whether a car gets wheels is measured from
     it, so a stale cam points the view off the facade and puts every car in the
     scene out of wheel range at once. That is what turned a fifth of the frame
     of window pixels into three quarters of a percent and a wheel difference
     into nothing at all. */
  cam.x = P.car.x; cam.y = P.car.y;
  // one cell per render, so this is draining the build queue as much as it is
  // settling the camera; well past the point where either still moves a pixel
  for (let i = 0; i < 30; i++) window.__px3(0, 0, 1, 1);
  return { camOff: +Math.hypot(cam.x - P.car.x, cam.y - P.car.y).toFixed(2),
           hp: P.car.hp, dead: P.dead };
});
const thaw = () => p.evaluate(() => { state = window.__keepStateF; });

const lum = (px, i) => .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
// readPixels is bottom-left origin: row 0 is the BOTTOM of the screen
const at = (x, y) => (y * W + x) * 4;

/* ---------- 1. the sky is a gradient, not a colour ---------- */
/* With every building deleted, everything above the skyline is sky and nothing
   else, so the mean brightness of each row is a straight readout of the
   gradient. Where the sky ends is found rather than assumed: the sky is smooth
   to a fraction of a unit per row and the ground is a different colour
   altogether, so the largest row-to-row step in the frame IS the horizon. Using
   a fixed fraction of the screen instead would measure whatever slice of the
   ramp the camera's pitch happened to leave in it.

   Two things are then asserted, and a flat clear colour fails both:

   THE RAMP. The top of the sky must be measurably darker than the bottom of it,
   because looking up is a short path through the air and looking level is a very
   long one. That is the entire effect, and on a clearColor sky it is 0.0.

   AND IT MUST BE SMOOTH. A ramp on its own could be produced by a hard split —
   two flat colours meeting at a line, which looks worse than one colour. So no
   two neighbouring rows may differ by more than a small fraction of the whole
   ramp. That is what would catch a gradient mixed in the wrong space, or one
   whose pow() had been dropped and turned into a visible band. */
await p.evaluate(() => {
  window.__keepBF = W.buildings;
  W.buildings = [];
  W.buckets.clear();
});
await p.waitForTimeout(2000);
out.frozeSky = await freeze();
{
  const px = await grab();
  /* SKY PIXELS ONLY, ROW BY ROW. The buildings are out of the way for this
     section, but the planting is not — and once the trees grew to thirteen
     metres their crowns reached well above the horizon line, so the rows this
     samples first were part canopy. The gradient did not change; the sample
     did, and it read 153 at the horizon instead of 175 while the zenith stayed
     at 143.5 to the decimal, which is what gave it away.

     Nothing in this frame that is not sky leads on blue: not the road, not the
     masonry, and certainly not a tree. Rows that end up with too little sky in
     them are left as NaN and skipped rather than averaged from three pixels. */
  const rows = [];
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      if (px[i + 2] < px[i] + 8) continue;         // warmer than it is blue: not sky
      s += lum(px, i); n++;
    }
    rows.push(n > W * 0.5 ? s / n : NaN);
  }
  /* rows[] runs bottom to top, and the horizon is where sky starts existing at
     all — the lowest row that is more than half sky, which is a sharper answer
     than the biggest step between two averages now that the rows below it are
     NaN rather than dark. */
  let hz = 0;
  for (let y = 0; y < H; y++) if (!Number.isNaN(rows[y])) { hz = y; break; }
  /* Twelve rows clear of the horizon, not one. The skyline is antialiased and
     the terrain behind it is uneven, so the rows immediately above it are a
     blend of sky and hillside and step by several units — which is real, and
     nothing to do with the gradient being measured. */
  const first = hz + 12;
  const low = rows[first], high = rows[H - 1];
  let jump = 0;
  for (let y = first + 1; y < H; y++)
    if (!Number.isNaN(rows[y]) && !Number.isNaN(rows[y - 1]))
      jump = Math.max(jump, Math.abs(rows[y] - rows[y - 1]));
  out.sky = {
    horizonRow: hz,
    skyRows: H - first,
    atHorizon: +low.toFixed(1),
    atZenith: +high.toFixed(1),
    ramp: +(low - high).toFixed(1),
    biggestRowStep: +jump.toFixed(2)
  };
  out.skyGraded = out.sky.skyRows > 60 &&
                  out.sky.ramp > 15 &&
                  out.sky.biggestRowStep < out.sky.ramp / 8;
}
await thaw();
await p.evaluate(() => {
  W.buildings = window.__keepBF;
  W.buckets.clear();
  indexBuildings(0);
});
await p.waitForTimeout(2500);

/* ---------- 2. the walls have windows on them ---------- */
/* Two measurements, because either on its own can be satisfied by the wrong
   thing.

   HOW MUCH OF THE FRAME CHANGES says windows are drawn at all — but a shader
   that tinted every wall one shade darker would score exactly as well.

   VERTICAL EDGES say it is a GRID. A window boundary is a hard step in
   brightness between horizontally adjacent pixels; flat plaster, a gradient and
   a fog fade have none at all. The edges are counted ONLY where the two frames
   differ, which is the facade and nothing else — counting the whole frame
   instead buries the signal under roads, kerbs, lane markings and rooflines,
   and turned a ratio of twenty into a ratio of one point four.

   THE SUN'S SHADOWS ARE OFF, which is what finally makes the two bracketing
   frames identical. The shadow projection is snapped to whole texels so the
   shadow edges do not crawl while driving, and that snap is a step function: the
   chase camera's easing is converging by millionths of a metre by this point,
   but the moment one of those millionths crosses a texel boundary EVERY shadow
   edge in the frame jumps by a texel at once. It measured a quarter of a percent
   of the frame moving between two frames that were otherwise identical, all of
   it in thin lines along shadows. None of it has anything to do with windows. */
await p.evaluate(() => window.__noShadow(true));
out.frozeCity = await freeze();
{
  const withWin = await grab();
  await p.evaluate(() => window.__noWindows(true));
  const plain = await grab();
  await p.evaluate(() => window.__noWindows(false));
  const withWin2 = await grab();
  await p.evaluate(() => window.__noShadow(false));

  // the mask: pixels the windows are responsible for, with anything that moved
  // between the two bracketing frames struck out
  const mask = new Uint8Array(W * H);
  let diff = 0, moved = 0;
  for (let i = 0, k = 0; i < withWin.length; i += 4, k++) {
    if (Math.abs(lum(withWin, i) - lum(withWin2, i)) > 2) { moved++; continue; }
    if (Math.abs(lum(withWin, i) - lum(plain, i)) > 4) { mask[k] = 1; diff++; }
  }
  const maskedEdges = px => {
    let e = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) {
      const k = y * W + x;
      if (!mask[k] && !mask[k + 1]) continue;
      n++;
      if (Math.abs(lum(px, at(x + 1, y)) - lum(px, at(x, y))) > 12) e++;
    }
    return n ? +(100 * e / n).toFixed(2) : 0;
  };
  const total = withWin.length / 4;
  out.windows = {
    moved: +(100 * moved / total).toFixed(3),
    changed: +(100 * diff / total).toFixed(2),
    edgesWith: maskedEdges(withWin),
    edgesPlain: maskedEdges(plain)
  };
  /* THE RATIO CARRIES THIS, not either edge count on its own. How dense the
     edges are depends on how much of the frame the mask covers, which depends on
     how much facade the parked camera happens to see — it has been measured
     between 2 and 12 across runs. The RATIO between the same pixels with the
     windows and without them sat at 5 either way, because both numbers move
     together.

     `moved` is a guard rather than a measurement: pixels that move are struck
     out of the mask already, so a little movement cannot corrupt anything. It is
     here to catch the freeze silently not working, which reads tens of percent
     rather than tenths. It is not zero because the cell builder runs one cell
     per frame and, with a full cache, can evict and rebuild the same far cell on
     alternate frames — a handful of pixels at the horizon, and none of them on a
     wall. */
  out.hasWindows = out.windows.moved < 1 &&
                   out.windows.changed > 1.5 &&
                   out.windows.edgesWith > 1 &&
                   out.windows.edgesWith > out.windows.edgesPlain * 3;
}

/* ---------- 3. the cars have wheels ---------- */
/* The player's car is dead centre and a few metres away, so it is always in the
   frame and always inside the range wheels are built for.

   SHADOWS OFF FOR THIS ONE. Wheels change the dynamic batch, the dynamic batch
   is what the sun draws into the depth map, and a body lifted off the tarmac
   throws its shadow from a different silhouette — so with shadows on, most of
   the pixels that change are road several metres away rather than the car, and
   they change in both directions. Switching the sun's shadows off leaves the
   difference as the car itself.

   WHAT IS COUNTED IS NEAR-BLACK PIXELS, not a brightness average. The first
   version averaged the luma of everything that changed and expected it to fall,
   on the reasoning that paint is brighter than tyre — and it rose, because
   lifting the body also exposes the ROAD under the sill, and in daylight this
   city's road is paler than most of its cars. A tyre is (0.06, 0.06, 0.07)
   before lighting and nothing else in a daylit frame with the shadows off comes
   anywhere near it, so counting how many of the changed pixels are that dark
   asks the question directly: is there something black down there now. */
{
  /* AND THE STREET IS CLEARED FIRST, because __plainCars strips the detail off
     EVERY car and the question is about this one. Parked close to the wall there
     was nothing else in shot and the count without wheels was reliably zero;
     from further back the road comes into view, and eight hundred near-black
     pixels of other people's tyres turned a clean 8:1 margin into 896 against
     805. The frame is frozen, so nothing respawns — and both frames are taken
     with the same empty street, which is the whole point of the subtraction. */
  await p.evaluate(() => { traffic.length = 0; cops.length = 0; peds.length = 0; });
  /* AND THE CAR IS PAINTED A COLOUR THAT IS NOT ALREADY BLACK. The measurement
     counts near-black pixels and calls them tyres, which holds while the paint
     is bright and falls apart on the runs where the lottery hands out a dark
     navy: the PLAIN box then reads as 1656 near-black pixels of its own against
     934 for the wheels, and the ratio inverts. Section 4 already forces a colour
     for the same kind of reason — a red car cannot be asked about its brake
     lights. */
  await p.evaluate(() => window.__playerColour('#22c0c8'));
  await p.evaluate(() => window.__noShadow(true));
  await p.evaluate(() => { for (let i = 0; i < 4; i++) window.__px3(0, 0, 1, 1); });
  const withWh = await grab();
  await p.evaluate(() => window.__plainCars(true));
  const none = await grab();
  await p.evaluate(() => { window.__plainCars(false); window.__noShadow(false); });

  /* NEAR-BLACK AND NEUTRAL. Dark alone is not a tyre: the shaded side of the
     plain box is dark too, and on a cyan car it averages (10, 31, 41) — under
     the luma threshold and nothing like black. It put 1418 pixels into the
     "without" count against 825 for the wheels and inverted the ratio. A tyre is
     (0.06, 0.06, 0.07) before lighting, so it stays grey whatever falls on it,
     and the paint on this car cannot: requiring the three channels to sit within
     twelve of each other separates them without caring what colour the car is. */
  const tyre = (px, i) => {
    const r = px[i], g2 = px[i + 1], b2 = px[i + 2];
    return Math.max(r, g2, b2) < 34 && Math.max(r, g2, b2) - Math.min(r, g2, b2) < 12;
  };
  let n = 0, darkWith = 0, darkNone = 0;
  for (let i = 0; i < withWh.length; i += 4) {
    const a = lum(withWh, i), b = lum(none, i);
    if (Math.abs(a - b) <= 6) continue;
    n++;
    if (tyre(withWh, i)) darkWith++;
    if (tyre(none, i)) darkNone++;
  }
  const total = withWh.length / 4;
  out.wheels = {
    changed: +(100 * n / total).toFixed(3),
    blackWith: darkWith,
    blackWithout: darkNone
  };
  /* A FEW HUNDRED PIXELS IS THE WHOLE SIGNAL, and that is not a weakness of the
     measurement — it is what a car looks like from behind. The chase camera sits
     on the car's own axis, so the near side of each wheel is hidden by the wheel
     in front of it and the far side by the body: what is left in view is the
     couple of centimetres each one stands proud of the sill, plus the strip of
     road now visible under a body that has come up off it. Between 66 and 149
     near-black pixels across runs, depending on how much traffic happened to be
     inside wheel range.

     So the assertion is about BLACKNESS rather than area. With the sun's shadows
     off, in daylight, nothing else in this frame is under 30 — the count without
     wheels has been exactly zero every time — and a build that drew the wheels
     in the wrong place, or in the wrong colour, or not at all, cannot produce
     it. */
  out.hasWheels = out.wheels.changed > 0.02 &&
                  darkWith > 40 &&
                  darkWith > darkNone * 8;
}

/* ---------- 4. the car has both its tail lights ---------- */
/* A REGRESSION TEST FOR A BUG THAT ALREADY HAPPENED, and one that is invisible
   in a wide shot and obvious the moment anybody looks at the car they are
   driving.

   The lamps are built as a mirrored pair, so the right-hand one's two z values
   arrive in the opposite order to the left's — which reverses that quad's
   winding on its own, and back-face culling then removed exactly one lamp of
   each pair while the other looked perfect. Counting red pixels would not have
   caught it: there were plenty, all on one side.

   So the count is per SIDE of the car, and both sides have to have some and
   neither may be wildly bigger than the other. The player's paint is forced to
   a colour with no red in it first, because a red car would answer this
   question for itself.

   AND ONLY PIXELS THAT BELONG TO THE CAR ARE COUNTED. Scanning the whole frame
   for red was fine while a tower block filled it and there was nothing else to
   see; from a hundred metres back the street comes into view, and one brick
   gable on the near side put 779 red pixels left of the car against 153 right
   and failed a pair of lamps that were both there. The car's own pixels are
   exactly the ones that change when __plainCars strips the detail off it, which
   section 3 already relies on — a brick wall is identical in both frames and
   subtracts itself. */
await p.evaluate(() => {
  window.__playerColour('#22c0c8');
  window.__noShadow(true);
  for (let i = 0; i < 4; i++) window.__px3(0, 0, 1, 1);
});
{
  const px = await grab();
  await p.evaluate(() => window.__plainCars(true));
  const plain = await grab();
  await p.evaluate(() => window.__plainCars(false));
  const mid = await p.evaluate(() => window.__project(P.car.x, P.car.y)[0] * DPR);
  let left = 0, right = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = at(x, y);
    if (Math.abs(lum(px, i) - lum(plain, i)) <= 6) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r > 95 && r > g + 55 && r > b + 55) (x < mid ? left++ : right++);
  }
  out.tailLights = { left, right, splitAt: Math.round(mid) };
  out.bothTailLights = left > 8 && right > 8 &&
                       Math.max(left, right) < Math.min(left, right) * 4;
}
await p.evaluate(() => window.__noShadow(false));
await thaw();

/* ---------- 5. none of it broke the frame ---------- */
/* A shader that fails to compile throws, and a shader that compiles to nonsense
   does not — so the frame gets checked for a pulse the way mode3d does it: a
   dead renderer is one colour, and this one is a city. */
await p.waitForTimeout(500);
{
  const px = await grab();
  const seen = new Set();
  let lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    seen.add((px[i] >> 3) * 1024 + (px[i + 1] >> 3) * 32 + (px[i + 2] >> 3));
    const L = lum(px, i);
    if (L < lo) lo = L; if (L > hi) hi = L;
  }
  out.frame = { colours: seen.size, lo: Math.round(lo), hi: Math.round(hi) };
  out.frameAlive = seen.size > 60 && hi - lo > 60;
}

out.errs = errs;
out.pass = !!out.parked && out.skyGraded && out.hasWindows && out.hasWheels &&
           out.bothTailLights && out.frameAlive && !errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
