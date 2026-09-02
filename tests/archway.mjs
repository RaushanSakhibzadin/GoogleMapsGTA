/* THE ARCHWAY THROUGH A BUILDING YOU CAN DRIVE THROUGH.
 *
 * A drivable centreline through a footprint is a tunnel, a gateway, or a block
 * built over the street. The game has known about them for a long time — those
 * buildings stop colliding, and the top-down view draws them at 45% alpha — but
 * the chase view drew a solid box, so you drove at a wall, went through it, and
 * came out the other side.
 *
 * THIS RUNS ON A REAL SESSION, and it has to. The first version of the archway
 * shipped cutting nothing anywhere, and every synthetic staging I built to check
 * it measured zero for a different reason each time — the camera framing the
 * wrong building, a road that was not the one through it, a car parked inside a
 * tower. What found the fault was a player's log: a photograph of a wall where a
 * passage should be, and 4,288 real buildings to look for it in.
 *
 * The fault was that a wall was cut if it ran within 2.5 m of the crossing
 * POINT — which is the average of the road samples inside the footprint, so it
 * sits in the middle of the building, by construction the furthest place from
 * every wall it has. On the reported block the nearest of nine walls is 2.6 m
 * away. On a fifteen-metre block it would be 7.5 and no wall could ever qualify.
 *
 * So this stands where the player stood, on the road that goes through the
 * building they photographed, and asks for the hole.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const F = new URL('./fixtures/kneza-danila/', import.meta.url);
const gz = f => gunzipSync(readFileSync(new URL(f, F))).toString();
const streets = gz('streets1.json.gz'), buildings = gz('buildings1.json.gz');
/* The centre of the streets request in that session, which is the origin every
   coordinate below is measured from. */
const LAT0 = 44.810177075879055, LON0 = 20.476164650458614;
/* Where the car was parked when the report was made, from the log's snapshot. */
const REPORTED = { x: 14.5, y: -31.6 };

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Кнеза Данила' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const body = /"building"/.test(q) ? buildings
             : /motorway/.test(q) && !/residential/.test(q) ? '{"elements":[]}'
             : /amenity|historic|tourism|shop/.test(q) ? '{"elements":[]}'
             : streets;
  return r.fulfill({ contentType: 'application/json', body });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForFunction(() => W.buildings.length > 100, null, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(1200);

const out = {};
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(2000);

out.shot = await p.evaluate(rep => {
  traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const gated = W.buildings.filter(b => b.passable && b.gate && b.gate.n && b.h > 5);
  const near = gated.map(b => ({ b, d: Math.hypot(b.gate.x - rep.x, b.gate.y - rep.y) }))
                    .sort((a, z) => a.d - z.d)[0];
  if (!near) return { err: 'no building with a road through it' };
  const b = near.b;

  /* BACK ALONG THE ROAD THAT GOES THROUGH IT — not merely a road near it. A
     road that passes through a building has plenty of points inside it, and a
     DIFFERENT road can easily have a point the same distance from the gate with
     a neighbouring block in between. Both mistakes were made, and both measured
     a confident zero. */
  let stand = null;
  for (const r of W.driveRoads) {
    if (!r.drive) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const u = r.pts[i], v = r.pts[i + 1];
      if (!pointInPoly(b.pts, (u.x + v.x) / 2, (u.y + v.y) / 2)) continue;
      const dx = v.x - u.x, dy = v.y - u.y, L = Math.hypot(dx, dy) || 1;
      for (const sg of [-1, 1]) {
        const sx = b.gate.x + sg * dx / L * 16, sy = b.gate.y + sg * dy / L * 16;
        if (pointInPoly(b.pts, sx, sy)) continue;      // that is indoors
        stand = { x: sx, y: sy, h: Math.atan2(-sg * dy, -sg * dx) };
        break;
      }
      if (stand) break;
    }
    if (stand) break;
  }
  if (!stand) return { err: 'no standoff on the road that crosses it' };

  window.__tp(stand.x, stand.y, stand.h);
  cam.x = P.car.x; cam.y = P.car.y;
  state = 'pause';
  /* Cells are built lazily and cached, so one built before markPassable ran
     holds no gate for ever; and the camera EASES towards the car, so
     back-to-back renders are milliseconds of easing rather than frames. */
  const settle = () => {
    dropAllCells();
    for (let i = 0; i < 320; i++) { last3 = performance.now() - 100; window.__renderOnce(); }
  };
  settle();
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const band = () => window.__px3(0, 0, w, h);
  const A = band();
  settle();                                   // nothing changed: the control
  const C = band();
  const keep = W.buildings.map(q => q.gate && q.gate.n);
  for (const q of W.buildings) if (q.gate) q.gate.n = 0;
  settle();
  const B = band();
  W.buildings.forEach((q, i) => { if (q.gate) q.gate.n = keep[i]; });
  settle();
  state = 'play';

  let moved = 0, control = 0, sy = 0, la = 0, lb = 0;
  const thr = [], wal = [];
  for (let i = 0; i < A.length; i += 4) {
    if (Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2]) > 18) control++;
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d < 18) continue;
    moved++;
    // __px3 reads bottom-up, so a large y here is HIGH on the screen
    sy += Math.floor((i / 4) / w);
    const ya = A[i] * .3 + A[i + 1] * .6 + A[i + 2] * .1;
    const yb = B[i] * .3 + B[i + 1] * .6 + B[i + 2] * .1;
    la += ya; lb += yb; thr.push(ya); wal.push(yb);
  }
  thr.sort((p, q) => p - q); wal.sort((p, q) => p - q);
  const pc = (arr, f) => arr.length ? +arr[Math.floor((arr.length - 1) * f)].toFixed(1) : 0;
  return { gated: gated.length, id: b.id, h: Math.round(b.h),
           gateFrom: Math.round(near.d), gateW: +b.gate.w.toFixed(1),
           moved, control, sampled: A.length / 4, hh: h,
           cy: moved ? +(sy / moved / h).toFixed(3) : null,
           lumaThrough: +(la / Math.max(1, moved)).toFixed(1),
           lumaWall: +(lb / Math.max(1, moved)).toFixed(1),
           brightThrough: pc(thr, .92), brightWall: pc(wal, .92),
           thrQ: [pc(thr, .1), pc(thr, .5), pc(thr, .9)],
           walQ: [pc(wal, .1), pc(wal, .5), pc(wal, .9)] };
}, REPORTED);

out.foundTheReportedGate = !out.shot.err && out.shot.gateFrom < 15 && out.shot.gated > 20;
/* AN OPENING, NOT A DEMOLITION. The upper bound is what separates a gateway
   from a shader that discards the whole wall — which would pass "something
   changed" perfectly, and is a live possibility given the condition is three
   clauses and losing any of them opens the flood. This wall fills most of a
   540,000-pixel frame; the archway moves 3,557 of it. Forty thousand sits an
   order of magnitude clear of the hole and an order clear of the wall. */
out.cutsAHole = out.shot.moved > 2500 && out.shot.moved < 40000 && out.shot.control === 0;
/* AND AT GROUND LEVEL, since a gateway is 4.2 m up a 26 m building. Measured at
   0.493 of the frame height from the bottom — barely under half, because the
   camera looks slightly down from six metres and the horizon sits near the
   middle, so a ground-level hole sixteen metres away lands just below it. The
   bar is 0.55 rather than 0.5 for that reason: half a frame is not where the
   physics puts it, and a threshold 1% away from the reading is fitted to the
   reading. The whole-wall case is caught by the count above, not by this. */
out.atGroundLevel = out.shot.cy !== null && out.shot.cy < 0.55;
/* AND WHAT SHOWS IN THE OPENING IS A PASSAGE.
 *
 * This used to read "brighter than the wall it replaced", on the reasoning that
 * what you see through a gateway is the lit street beyond. That was true, and it
 * was true for the wrong reason: the passage's lining was single-sided and faced
 * inward, so from outside it was not drawn at all and the opening was a clean
 * hole onto whatever lay behind the building. The moment the lining is drawn
 * from both sides — which is what "they should look good from each side" asked
 * for, and without which you see straight through a jamb from any angle off the
 * axis — the mean through the opening is dominated by shaded masonry and lands
 * BELOW the sunlit facade. Measured: 76 against 93, and even the top decile of
 * the opening is 118 against the wall's 130. A sunlit wall is brighter than the
 * inside of a tunnel, and no amount of getting the tunnel right will change that.
 *
 * So the check is on the thing that actually distinguishes an opening from a
 * repaint: RANGE. A passage has a dark lining and a lit far end, so what shows
 * in the hole spans a much wider band of brightness than the flat wall it
 * replaced. A shader that discarded the wall and showed nothing, or one that
 * tinted it, gives a narrow band. Measured on this frame the opening runs 44 to
 * 114 across its middle four fifths and the wall 45 to 128 — so the test is on
 * the SPREAD WITHIN the opening rather than on either against the other: 2.6x
 * here, and a flat surface is 1.0. */
out.throughSpread = out.shot.thrQ[0] > 0 ? +(out.shot.thrQ[2] / out.shot.thrQ[0]).toFixed(2) : 0;
out.seesThrough = out.throughSpread > 1.8 && out.shot.brightThrough > 90;


/* ---------------------------------------------------------------------------
   AND THE OPENING SURVIVES BEING DRIVEN TO.

   Reported as "holes in buildings seen only from one side of the building, on
   Safari". It was a precision fault, and it could only ever have been Safari:
   vGate carries the archway's centre in a WORLD coordinate — the same basis and
   the same range as vW.x, which is declared highp with a comment saying why —
   and vGate was left at the fragment shader's default mediump. The test in the
   shader is `abs(vW.x - vGate.x) < vGate.y` against a half width of about
   1.75 m, so comparing a millimetre-accurate value with one quantised to metres
   does not nudge the hole, it loses it. The two walls a road crosses have gate
   coordinates of opposite sign and round independently, which is why one side
   could keep its opening while the other did not.

   THIS CANNOT BE OBSERVED HERE, AND THAT IS THE POINT. Every desktop driver and
   the SwiftShader these tests rasterise on promote mediump to full float, so the
   fault is invisible on this machine no matter how the game is driven — the same
   trap that made me dismiss the `discard` overdraw problem after measuring no
   difference in headless Chromium and calling it evidence.

   Two halves, and both are needed:
     the SOURCE says highp, which is the fix and the thing that can regress;
     the ARITHMETIC says the highp is load-bearing rather than decorative.
   ------------------------------------------------------------------------ */
out.declared = await p.evaluate(() => {
  const v = typeof SH_LIT_V === 'string' ? SH_LIT_V : '';
  const f = typeof SH_LIT_F === 'function' ? SH_LIT_F(true) : '';
  return { vs: /out\s+highp\s+vec2\s+vGate/.test(v),
           fs: /in\s+highp\s+vec2\s+vGate/.test(f),
           // and vW, which is the same class of value and was already right
           vw: /out\s+highp\s+vec3\s+vW/.test(v) && /in\s+highp\s+vec3\s+vW/.test(f) };
});
out.gateIsHighp = out.declared.vs && out.declared.fs && out.declared.vw;

/* ---- THE ARITHMETIC, OVER THE REAL GATES IN THIS CITY ----

   NOT A PIXEL TEST, AND THAT IS A FINDING RATHER THAN A SHORTCUT. I wrote one
   first: patch the shader to round vGate through packHalf2x16 — genuine half
   precision on any driver, including the SwiftShader these tests rasterise on —
   swap it in for one frame, and compare. It came back at zero pixels, twice,
   and the reason is instructive. The building this camera is parked in front of
   has a gate coordinate of about 30, where the fp16 grid at driving distance is
   16 wide: the opening shifts 1.8 m inside its own 7 m width and nothing leaves
   the wall. One camera in front of one building cannot see this fault. Tuning
   that test until it agreed would have been fitting the instrument to the
   answer.

   So the measurement is the whole capture instead: every wall a road actually
   crosses, its gate coordinate taken through the same intersection the cell
   builder uses, rounded to the grid a half-precision varying lands on at the
   magnitudes a 36 km world reaches, and compared against the opening's own half
   width. No GPU is involved and none is needed — the fault is arithmetic.

   It also explains the report exactly. The two walls a road crosses sit on
   opposite sides of the building, so their gate coordinates have opposite signs
   — 743821435's are +30.19 and −21.22 — and they land on different points of
   the grid. At 16 km they round by 1.81 m and 2.78 m respectively. One side's
   opening can survive a rounding that destroys the other's, which is "holes seen
   only from one side of the building". */
out.arith = await p.evaluate(() => {
  // the value a half-precision varying would hold: 11 significant bits
  const f16 = x => {
    const s = Math.sign(x), a = Math.abs(x);
    if (a === 0) return 0;
    const step = Math.pow(2, Math.floor(Math.log2(a)) - 10);
    return s * Math.round(a / step) * step;
  };
  const rows = [];
  for (const b of W.buildings) {
    if (!(b.passable && b.gate && b.gate.n && b.h > 5)) continue;
    const g = b.gate, fp = b.pts;
    const mine = [];
    for (let i = 0; i < fp.length - 1; i++) {
      const ax = fp[i].x, az = fp[i].y;
      const ex = fp[i + 1].x - ax, ez = fp[i + 1].y - az;
      const L = Math.hypot(ex, ez) || 1;
      const nx = ez / L, nz = -ex / L;
      const den = ex * g.uy - ez * g.ux;
      if (Math.abs(den) < 1e-6) continue;
      const t = ((g.x - ax) * g.uy - (g.y - az) * g.ux) / den;
      if (t < 0 || t > 1) continue;
      const px = ax + ex * t, pz = az + ez * t;
      const pr = px * g.ux + pz * g.uy;
      if (!(pr > g.pmin - 4 && pr < g.pmax + 4)) continue;
      mine.push(px * -nz + pz * nx);
    }
    if (mine.length) rows.push({ id: b.id, w: g.w, gc: mine });
  }
  /* Driving distances. The world is 36 km across, so a gate coordinate reaches
     ±18000; these are the magnitudes on the way there. */
  const out2 = { walls: 0, lost: 0, apart: 0, worst: 0, examples: [] };
  for (const r of rows) {
    for (const k of [2048, 8192, 16384]) {
      const errs = r.gc.map(v => Math.abs((f16(v + k) - k) - v));
      out2.walls += errs.length;
      for (const e of errs) {
        if (e > r.w) out2.lost++;
        if (e > out2.worst) out2.worst = +e.toFixed(2);
      }
      // the two sides of one building, rounding by different amounts
      if (errs.length > 1 && Math.abs(errs[0] - errs[1]) > 0.5) {
        out2.apart++;
        if (out2.examples.length < 3)
          out2.examples.push({ id: r.id, km: k / 1000, w: r.w,
                               gc: r.gc.map(v => +v.toFixed(2)),
                               err: errs.map(v => +v.toFixed(2)) });
      }
    }
  }
  return out2;
});
/* Openings wider than the rounding survive; openings narrower than it do not.
   Both have to appear, or the fixture is not exercising the range — and the
   sides of a building have to disagree, because that disagreement is the bug as
   it was reported. */
out.halfPrecisionLosesHoles = out.arith.walls > 40 && out.arith.lost > 0 &&
                              out.arith.worst > 3;
out.andTheTwoSidesDisagree = out.arith.apart > 0;

out.errs = errs.slice(0, 3);
out.pass = out.foundTheReportedGate && out.cutsAHole && out.atGroundLevel &&
           out.seesThrough && out.gateIsHighp &&
           out.halfPrecisionLosesHoles && out.andTheTwoSidesDisagree &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
