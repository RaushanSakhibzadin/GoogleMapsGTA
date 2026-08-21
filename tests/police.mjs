/* A BELGRADE PATROL CAR, NOT AN AMERICAN ONE.
 *
 * Asked for, and looked up rather than invented: Serbian police vehicles are
 * WHITE, with a blue chequer band along the flank, the Cyrillic ПОЛИЦИЈА
 * wordmark, and a blue LED lightbar. The game had the white body already and
 * then put a red-and-blue bar on the roof, which is a North American convention
 * and reads as the wrong country to anybody who lives in the right one.
 *
 * WHAT IS MEASURED, and why each is measured the way it is:
 *
 *   - A BAR ON THE ROOF, BLUE AT ONE END AND RED AT THE OTHER. The livery
 *     research says a Belgrade bar is blue at both ends and that is how this was
 *     first built; blue and red is a deliberate choice on top of an otherwise
 *     accurate livery, and this asserts the choice. Both are counted only ABOVE
 *     the chequer band, so the tail lights — red on every car, and correct — do
 *     not stand in for a lightbar.
 *
 *   - BLUE ON THE FLANK, in a PATTERN. A band of blue could be one solid stripe,
 *     which is a different force's livery; the claim is a chequer. So the blue
 *     pixels along the side are counted AND the number of times the colour
 *     alternates across the length of the car is counted with them. A stripe
 *     alternates twice. A chequer alternates many times.
 *
 *   - IT IS STILL WHITE. A livery that turned the whole car blue would satisfy
 *     "has blue on it" and be wrong.
 *
 * Everything is an A/B against a civilian car standing in the same place, so
 * "blue" and "red" are always relative to a body of the same shape under the
 * same light, rather than to absolute thresholds picked by eye.
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
await p.waitForTimeout(800);

const out = {};
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2200);
/* DAYLIGHT. At dusk this whole scene is dim enough that a white car reads 124
   white pixels out of 2254 and the blue band never clears any sensible
   threshold — the first run of this measured 3 blue pixels on a car that has a
   chequer down both sides. The livery is the same geometry in both themes; the
   day theme is simply where a colour test can see it. */
await p.evaluate(() => applyTheme('day'));
await p.waitForTimeout(600);

/* ALL THREE FRAMES IN ONE FROZEN PASS.

   The first version paused, shot, and un-paused for each frame in turn. Between
   the shots the world ran — traffic spawned, the camera settled, the light moved
   — so the three frames differed EVERYWHERE, and the car's silhouette came out
   as the whole screen: [0, 69, 895, 599]. Nothing measured after that meant
   anything.

   So the world is stopped once and stays stopped, and the only thing that
   changes between the grabs is which car is standing there. */
const shots = await p.evaluate(async () => {
  const c = P.car;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  c.vx = c.vy = 0;
  traffic.length = 0; cops.length = 0; peds.length = 0;
  state = 'pause';
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const settle = () => { for (let i = 0; i < 24; i++) window.__px3(0, 0, 1, 1); };
  settle();
  const bx = c.x + Math.cos(c.h) * 17, by = c.y + Math.sin(c.h) * 17;
  const grab = k => {
    traffic.length = 0; cops.length = 0;
    if (k) {
      /* A REAR THREE-QUARTER, not broadside.

         Broadside shows the whole flank, which is what the chequer wants — but a
         lightbar's two lamps sit across the car's WIDTH, so side-on the near one
         stands directly in front of the far one and hides it. Measured that way
         the red end read 15 pixels and the blue end read 0, which says nothing
         about the bar and everything about the angle. Turned 45° both lamps are
         in view and enough of the flank is still showing to count the chequer —
         which is also roughly how a player sees a police car. */
      const car = makeCar(bx, by, c.h + Math.PI / 4, k);
      car.blink = 0;                                        // a known phase, so it repeats
      /* Yellow, not the purple the first version used — purple is mostly blue,
         so the civilian control was scoring 434 "blue" pixels on its own roof and
         the police car had to beat its own baseline. */
      if (k === 'traffic') car.color = '#e8c81e';
      /* PLACED ON THE GROUND BY HAND, because the world is paused. A fresh car
         has z undefined on purpose — groundCar reads that as "never been placed"
         and snaps it to the terrain — but groundCar runs from update(), and
         update() does not run while paused. Without this the car's eight corners
         are NaN, it draws nothing at all, and the silhouette that comes back is
         a few hundred stray pixels spread across the whole frame. */
      car.z = window.__terrain(bx, by).h;
      car.pitch = 0; car.roll = 0; car.vz = 0; car.air = false; car.flip = 0;
      (k === 'cop' ? cops : traffic).push(car);
    }
    window.__px3(0, 0, 1, 1);
    return Array.from(window.__px3(0, 0, w, h));
  };
  const empty = grab(null), cop = grab('cop'), civ = grab('traffic');
  state = 'play';
  return { w, h, empty, cop, civ };
});
const empty = { px: shots.empty, w: shots.w, h: shots.h };
const cop = { px: shots.cop, w: shots.w, h: shots.h };
const civ = { px: shots.civ, w: shots.w, h: shots.h };

/* THE TWO CARS AGAINST EACH OTHER, which is the only comparison with nothing
   else in it.

   Two approaches were tried and thrown away first. Boxes worked out from
   __project measured the road. Then a third frame with no car, subtracted, was
   supposed to give the car's silhouette — but the car's SHADOW differs from the
   empty road too, and so does every antialiased edge, so the "car" came out as a
   band the full width of the screen and the readings swung by a factor of four
   between runs of the same build.

   The police car and the civilian stand in the same place, in the same frame, in
   the same light, with the same body shape. Everything that is not the car is
   identical between them by construction. So the pixels that DIFFER are the car,
   and the pixels that are blue in one and not the other are the livery. No
   thresholds picked by eye, no coordinates converted, nothing to drift. */
const at = (s, x, y) => ((y * s.w) + x) * 4;
const isRed  = (r, g, bl) => r > 120 && r > g * 2.0 && r > bl * 2.0;
const isBlue = (r, g, bl) => bl > 70 && bl > r * 1.5 && bl > g * 1.25;
const isWhite = (r, g, bl) => r > 120 && Math.abs(r - g) < 30 && Math.abs(g - bl) < 40;
const px = (s, x, y) => { const i = at(s, x, y); return [s.px[i], s.px[i + 1], s.px[i + 2]]; };

const W = shots.w, H = shots.h;
const diff = new Uint8Array(W * H);
let dn = 0, y0 = H, y1 = -1, x0 = W, x1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const a = px(cop, x, y), b = px(civ, x, y);
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 30) continue;
  diff[y * W + x] = 1; dn++;
  if (y < y0) y0 = y; if (y > y1) y1 = y;
  if (x < x0) x0 = x; if (x > x1) x1 = x;
}
out.car = { pixels: dn, box: [x0, y0, x1, y1], height: y1 - y0 };
// the two cars must both be on screen and a decent size, or nothing else means anything
out.carsVisible = dn > 800 && (y1 - y0) > 20;

/* Blue that is on the police car and NOT on the civilian, and the same for red.
   A red lightbar would show up in redOnly; tail lights are on both cars and
   cancel. */
let blueOnly = 0, redOnly = 0, whiteCop = 0;
const blueRow = new Int32Array(H), redRow = new Int32Array(H);
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
  if (!diff[y * W + x]) continue;
  const a = px(cop, x, y), b = px(civ, x, y);
  if (isBlue(a[0], a[1], a[2]) && !isBlue(b[0], b[1], b[2])) { blueOnly++; blueRow[y]++; }
  if (isRed(a[0], a[1], a[2]) && !isRed(b[0], b[1], b[2])) { redOnly++; redRow[y]++; }
  if (isWhite(a[0], a[1], a[2])) whiteCop++;
}
out.livery = { blueOnly, redOnly, whiteCop };

/* ---- 1. a blue chequer along the side ---- */
out.hasBlueFlank = blueOnly > 120;
/* HOW MANY TIMES IT ALTERNATES along the car. A solid stripe crosses from paint
   to blue and back once — two transitions. Seven columns of chequer cross many
   more. Measured on the row carrying the most blue, so it lands on the band. */
let bestY = y0, bestN = -1;
for (let y = y0; y <= y1; y++) if (blueRow[y] > bestN) { bestN = blueRow[y]; bestY = y; }

/* ---- 2. a bar ABOVE the band, blue at one end and red at the other ---- */
/* MEASURED AGAINST THE BAND, not against the silhouette's bounding box.

   The box is not the car: it comes out the full width of the frame, so a
   fraction of its height picks out sky rather than roof, and "the highest blue,
   as a fraction of the box" read the same 0.22 whether the bar was drawn or not.
   The band, on the other hand, is a thing this test has already located exactly —
   it is the row carrying the most blue. A lightbar is what sits clearly ABOVE
   that, and nothing else on the car does. readPixels is bottom-left origin, so
   above means a larger y.

   RED ABOVE THE BAND IS NOW REQUIRED, where an earlier version of this file
   forbade it. That is not a measurement changing its mind: the livery research
   says a Belgrade bar is blue at both ends, the game was asked for blue and red,
   and this asserts what the game is meant to do. What the red check still buys
   is that it is red UP THERE and not down at the tail lights — those are on both
   cars and cancel in the difference. */
let blueAbove = 0, redAbove = 0;
for (let y = bestY + 10; y <= y1; y++) { blueAbove += blueRow[y]; redAbove += redRow[y]; }
out.bar = { bandRow: bestY, blueAboveBand: blueAbove, redAboveBand: redAbove };
/* Ten, against a measured twenty to thirty and a flat zero on a build with no
   livery. The bar is a few pixels tall at this range — 0.1 m of lamp at 17 m —
   so the count is small by nature and the room has to come from the gap to zero
   rather than from the size of the number. */
out.hasBlueLight = blueAbove > 10;
/* THE RED CHECK DOES NOT DISCRIMINATE ON ITS OWN, and that is worth writing
   down rather than leaving for someone to discover. On a build with no livery
   there is no band to find, so bandRow collapses to the bottom of the car and
   the tail lights end up "above" it — the removed-livery run reads 26 red
   pixels and passes this line. It is here to assert the game does what it was
   asked to do; the blue and the chequer are what would catch the livery being
   lost, and both read exactly zero there. */
out.hasRedLight = redAbove > 10;
let flips = 0, was = false;
for (let x = x0; x <= x1; x++) {
  const on = !!diff[bestY * W + x] &&
             isBlue(...px(cop, x, bestY)) && !isBlue(...px(civ, x, bestY));
  if (on !== was) flips++;
  was = on;
}
out.runs = { row: bestY, blueInRow: bestN, flips };
/* FOUR, not six. A solid stripe crosses paint-to-blue and back exactly twice,
   and a build with no livery at all reads zero — so anything above two is the
   claim. Six is what a seven-column chequer shows head-on and it drops to six or
   fewer at the 45° this is shot from, because the flank is foreshortened; a
   threshold of six was sitting exactly on the measurement. */
out.isChequered = flips >= 4;

/* ---- 3. and it is still a white car ---- */
out.stillWhite = whiteCop > blueOnly * 1.5;

out.errs = errs.slice(0, 3);
out.pass = out.carsVisible && out.hasBlueLight && out.hasRedLight && out.hasBlueFlank &&
           out.isChequered && out.stillWhite && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
