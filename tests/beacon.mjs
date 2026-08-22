/* THE OBJECTIVE IS VISIBLE OUT OF THE WINDSCREEN.

   Reported from a phone, exactly: the pink and yellow things can only be seen on
   the map. And that was right — the top-down game paints a marker on the ground
   at the objective and at every landmark, and none of it survived the move to
   the chase view. The pickup existed on the radar, on the city map and on the
   screen-edge arrow, and nowhere in the world you were driving through.

   A ground marker would not have fixed it either. From a camera six metres up
   behind a car, a disc painted on the tarmac is a thin ellipse hidden behind the
   next vehicle, and it is gone entirely from more than a street away — which is
   most of the time, because a delivery is routinely a kilometre off. So the
   thing under test is a BEACON: a column of light standing where the marker is,
   tall enough to clear the roofline of the street it is in.

   THE A/B IS THE MISSION ITSELF, which is better than a debug flag: switching
   MISSION.state off is what the game does when a job is finished, so the "without"
   frame is a real state the game reaches rather than a build with a line removed.

   The world is frozen for the comparison — state = 'pause' stops update() and
   stops the loop rendering while __px3 still renders on demand — so the two
   frames differ by the objective and by nothing else.

   It runs offline on the bundled city, so there is a real street with real
   buildings in front of the camera and no network. */
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
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2200);

const dpr = await p.evaluate(() => DPR);
const W = Math.floor(900 * dpr), H = Math.floor(600 * dpr);
const grab = () => p.evaluate(a => window.__px3(0, 0, a[0], a[1]), [W, H]);
// readPixels is bottom-left origin: row 0 is the BOTTOM of the screen
const at = (x, y) => (y * W + x) * 4;

/* Eighty-five metres straight up the road the car is already pointing down, so
   the beacon is in front of the camera without steering, and far enough away
   that a building or two stands between it and the lens — which is the case that
   matters, because that is what decides how tall the column has to be. */
out.placed = await p.evaluate(() => {
  const c = P.car;
  MISSION.state = 'pickup';
  MISSION.pick = { x: c.x + Math.cos(c.h) * 85, y: c.y + Math.sin(c.h) * 85 };
  return { car: [Math.round(c.x), Math.round(c.y)],
           pick: [Math.round(MISSION.pick.x), Math.round(MISSION.pick.y)] };
});
await p.waitForTimeout(700);
await p.evaluate(() => {
  window.__keepStateB = state;
  state = 'pause';
  P.car.vx = P.car.vy = 0;
  cam.x = P.car.x; cam.y = P.car.y;
  // one cell per render while the loop is stopped, so this drains the build
  // queue as well as settling the chase camera
  for (let i = 0; i < 30; i++) window.__px3(0, 0, 1, 1);
});

/* THE PICKUP PINK IS #ff4fd8 AND THE HOSPITAL RED IS #ff4f6d — identical in red
   and green, separable only on blue, which is why the matcher keys on blue being
   high. It is drawn additively over whatever is behind it, so the test asks for
   "strongly pink" rather than for the exact value: red and blue both well up,
   green held down between them. */
/* AND ONLY WHERE THE FRAME CHANGED. The two grabs are identical apart from the
   objective, so a pink pixel that is pink in both is not the beacon — it is the
   sky. That started mattering the day the sun moved into the southern half of
   the sky, which put the dusk glow behind the objective: a purple wash that
   answers this matcher perfectly and put 881 pink pixels into the frame with the
   beacon switched OFF, against 2232 with it on. The beacon was fine; the counter
   was measuring the sunset. Subtracting the unchanged pixels leaves the additive
   column and nothing else. */
const scanPink = (px, ref) => {
  let n = 0, top = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = at(x, y);
    if (Math.abs(px[i] - ref[i]) + Math.abs(px[i + 1] - ref[i + 1]) +
        Math.abs(px[i + 2] - ref[i + 2]) <= 12) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r > 120 && b > 120 && g < r - 45 && g < b - 45) { n++; if (y > top) top = y; }
  }
  return { n, top };
};

const withIt = await grab();
await p.evaluate(() => { MISSION.state = 'none'; MISSION.pick = null; });
const without = await grab();
await p.evaluate(() => { state = window.__keepStateB; });

const a = scanPink(withIt, without), b = scanPink(without, withIt);
out.pink = { withObjective: a.n, without: b.n };
/* HOW HIGH IT REACHES, which is the whole design and not a detail. The column is
   depth-tested like everything else, so a building in front of it hides it —
   correct, since a light visible through a wall reads as a bug — and that means
   it only works if it is taller than the street it is standing in. Belgrade
   blocks here run twenty to thirty metres, so the top of the pink has to be well
   up the frame, not a smudge down at the vanishing point. Rows are counted from
   the bottom, so a large row number is high on the screen. */
out.reachesAboveTheRoofline = a.top > H * 0.62;
out.topRow = a.top;
out.frameH = H;
out.visible = a.n > 250 && b.n * 8 < a.n;

/* AND THE LANDMARKS, which had the same problem and get the same answer at a
   quarter of the size: a garage is a convenience rather than a destination, and
   a skyline full of beacons is worse than none. They appear within 150 m, so the
   test parks next to one rather than hunting for a frame that happens to have
   one in it.

   PARKED ON A ROAD, not simply thirty metres to the west. The first version
   dropped the car at a fixed offset and measured two lit pixels, because the
   offset landed in the middle of a block and the camera spent the whole test
   inside a wall — the beacon was drawn, correctly depth-tested, and hidden
   behind the building the lens was buried in. So the spot is searched for: rings
   outwards from the landmark, taking the first bearing that puts the car on
   actual tarmac, which is where a player would be looking at it from.

   AND WITH THE LANDMARK IN SIGHT. Tarmac alone is not a view: a road round the
   corner from the garage is a perfectly good bit of road with a block of flats
   across the line of sight, and the beacon is then correctly hidden behind it.
   That passed for as long as half the city's walls were being culled away and
   you could see through them, and started failing the moment they were not,
   which makes it the second piece of staging in this suite to have been quietly
   resting on that bug. The segment to the landmark is now walked and has to be
   clear of every footprint — stopping short of the last eight metres, because
   the garage is itself a building and the beacon stands on it. */
out.poi = await p.evaluate(() => {
  const q = window.__nearestPOI('repair');
  if (!q) return null;
  const clearTo = (x, y) => {
    const dx = q.x - x, dy = q.y - y, L = Math.hypot(dx, dy);
    for (let t = 0; t < L - 8; t += 2) {
      const px = x + dx * t / L, py = y + dy * t / L;
      if (W.buildings.some(b => px >= b.bb.x0 && px <= b.bb.x1 && py >= b.bb.y0 &&
                                py <= b.bb.y1 && pointInPoly(b.pts, px, py))) return false;
    }
    return true;
  };
  for (let r = 26; r <= 70; r += 6) {
    for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12;
      const x = q.x + Math.cos(a) * r, y = q.y + Math.sin(a) * r;
      if (!window.__onRoad(x, y) || !clearTo(x, y)) continue;
      window.__tp(x, y, Math.atan2(q.y - y, q.x - x));
      P.car.vx = P.car.vy = 0;
      return { kind: q.kind, at: [Math.round(q.x), Math.round(q.y)],
               from: [Math.round(x), Math.round(y)], stood: r };
    }
  }
  return null;             // nowhere to watch it from: not a renderer question
});
if (out.poi) {
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    window.__keepStateB = state;
    state = 'pause';
    cam.x = P.car.x; cam.y = P.car.y;
    for (let i = 0; i < 30; i++) window.__px3(0, 0, 1, 1);
  });
  const near = await grab();
  // shove the landmarks far away: the same frame with nothing to mark in it
  await p.evaluate(() => {
    window.__keepPois = W.pois.map(q => ({ q, x: q.x, y: q.y }));
    for (const q of W.pois) { q.x += 90000; q.y += 90000; }
  });
  const far = await grab();
  await p.evaluate(() => {
    for (const k of window.__keepPois) { k.q.x = k.x; k.q.y = k.y; }
    state = window.__keepStateB;
  });
  /* COUNTED AS "BRIGHTER", NOT AS "GREEN", and the first version got that wrong.

     POI_COL.repair is #48ff9e, so hunting for pixels where green leads red and
     blue sounds exact. It found none. These beacons are drawn ADDITIVELY, and
     additive light over a pale daylight road climbs towards white — the green
     channel saturates first and the other two follow it up, so the hue test that
     works perfectly on a dark frame reports nothing at all on a bright one.

     What an additive draw always does, on any background, is make pixels
     brighter. The frames are frozen and identical apart from where the landmarks
     are, so every pixel that gained luma is beacon and can be nothing else. The
     objective above keeps its hue test, because #ff4fd8 against a road has to be
     told apart from the hospital's #ff4f6d and only blue separates those two. */
  const lum = (px, i) => .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
  let lit = 0;
  for (let i = 0; i < near.length; i += 4) if (lum(near, i) > lum(far, i) + 6) lit++;
  out.poiLit = lit;
  out.landmarkVisible = lit > 120;
} else {
  out.landmarkVisible = true;      // no landmark in the bundled city: nothing to check
}

/* ---------- 4. it stands down when you are standing in it ---------- */
/* Reported after being BUSTED, which is the case that makes it unavoidable: you
   are booked at the station and respawn on the kerb beside it, which is to say
   inside that station's own beacon. An additive billboard seen from the inside is
   a wash over the whole screen — the same thing the street lamps fade for, and
   for the same reason.

   WHAT IS MEASURED IS THE MEAN BRIGHTNESS OF THE ENTIRE FRAME, not the beacon.
   That is the shape of the fault: nothing is blown out, no single pixel looks
   wrong, and it reads as fog rather than as a bug — which is precisely why it
   survived three rounds of looking at screenshots. On the build without the fade
   a beacon at zero distance lifted the frame from 28.1 to 34.0, and every
   distance from there to about a hundred metres was brightened in proportion.

   The sweep also has to show the beacon still WORKS: brightest in the middle
   distance, where a column marking somewhere to drive to is worth having. A fade
   that simply turned it off everywhere would pass a near-field check on its own,
   so the far readings are what stop this being satisfied by deleting the
   feature. */
{
  const meanAt = d => p.evaluate(dd => {
    const c = P.car;
    MISSION.state = 'pickup';
    MISSION.pick = dd === null ? null
                 : { x: c.x + Math.cos(c.h) * dd, y: c.y + Math.sin(c.h) * dd };
    if (dd === null) MISSION.state = 'none';
    window.__px3(0, 0, 1, 1);
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const px = window.__px3(0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < px.length; i += 4)
      sum += .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
    return +(sum / (px.length / 4)).toFixed(2);
  }, d);

  const base = await meanAt(null);
  const sweep = {};
  for (const d of [0, 8, 20, 35, 60, 400]) sweep[d] = await meanAt(d);
  out.wash = { base, sweep };
  /* Standing on it must be indistinguishable from it not being there. A quarter
     of a luma unit is around the noise floor of a frozen frame; the fault was six,
     and it measures 0.01 with the fade in. */
  out.noWashUpClose = sweep[0] - base < 0.25;
  /* And it is still a beacon at the range you would be looking for one. This is
     the half that stops the whole thing being satisfied by deleting the feature —
     a fade that turned the column off everywhere would sail through the check
     above. The exact height of the peak depends on where in the city the car
     stopped and how much sky is behind the column, so what is asserted is that
     there is clearly something there, not how much. */
  out.stillVisibleAtRange = sweep[20] - base > 0.5;
  // fading in, not snapping on: brighter with distance across the whole near field
  out.fadesInSmoothly = sweep[0] <= sweep[8] && sweep[8] <= sweep[20];
}

out.errs = errs;
out.pass = out.visible && out.reachesAboveTheRoofline && out.landmarkVisible &&
           out.noWashUpClose && out.stillVisibleAtRange && out.fadesInSmoothly &&
           !errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
