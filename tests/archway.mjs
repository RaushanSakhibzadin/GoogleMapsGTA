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
  for (let i = 0; i < A.length; i += 4) {
    if (Math.abs(A[i] - C[i]) + Math.abs(A[i + 1] - C[i + 1]) + Math.abs(A[i + 2] - C[i + 2]) > 18) control++;
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d < 18) continue;
    moved++;
    // __px3 reads bottom-up, so a large y here is HIGH on the screen
    sy += Math.floor((i / 4) / w);
    la += A[i] * .3 + A[i + 1] * .6 + A[i + 2] * .1;
    lb += B[i] * .3 + B[i + 1] * .6 + B[i + 2] * .1;
  }
  return { gated: gated.length, id: b.id, h: Math.round(b.h),
           gateFrom: Math.round(near.d), gateW: +b.gate.w.toFixed(1),
           moved, control, sampled: A.length / 4, hh: h,
           cy: moved ? +(sy / moved / h).toFixed(3) : null,
           lumaThrough: +(la / Math.max(1, moved)).toFixed(1),
           lumaWall: +(lb / Math.max(1, moved)).toFixed(1) };
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
/* And you can see THROUGH it: what shows in the opening is the lit street on
   the far side, which is brighter than the shaded wall it replaced. */
out.seesThrough = out.shot.lumaThrough > out.shot.lumaWall * 1.15;

out.errs = errs.slice(0, 3);
out.pass = out.foundTheReportedGate && out.cutsAHole && out.atGroundLevel &&
           out.seesThrough && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
