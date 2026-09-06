/* THE CAMERA FACES THE WAY YOU ARE GOING.
 *
 * Asked for: "make the camera always turn the side that my car moves — for
 * example when the car goes back, camera turns back". A chase camera locked to
 * the nose makes reversing blind: the screen is entirely road you have already
 * driven, and whatever you are backing into is behind the camera.
 *
 * WHAT IS MEASURED IS WHERE THE EYE IS, not what cam.h holds. The renderer puts
 * the eye on a circle around the car and looks at a point that leads it, so the
 * honest reading is the angle between the car's nose and the direction of the
 * eye from the car: zero when the camera is behind you, pi when it has come
 * round in front. A build that set cam.h and never used it would pass a check on
 * cam.h and fail this.
 *
 * AND THE DEAD BAND IS HALF THE FEATURE. One threshold chatters: shunting back
 * and forth out of a parking space crosses it several times a second and the
 * camera whips round on each crossing. Three of the six sections below are about
 * the two thresholds and the gap between them, because that is the part that
 * makes this pleasant rather than nauseating, and it is invisible in a
 * screenshot.
 *
 * Usage: node tests/camview.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME_ASIS, stubRadio, parkOnAStraight } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await stubRadio(p);
await p.goto(GAME_ASIS);
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
await parkOnAStraight(p, 120, 20);

/* ---------- 1-3. drive it, reverse it, drive it again ---------- */
/* The real loop, with the real inputs, in simulated seconds — below twelve
   frames a second this machine's world runs slower than its clock, and a
   wall-clock window would give the car a different amount of reversing to do on
   every run. */
out.drive = await p.evaluate(async () => {
  traffic.length = 0; cops.length = 0; P.wanted = 0;
  /* A build without the feature has no hook either, so it fails these sections
     rather than throwing out of them — which is what the A/B needs it to do. */
  const view = () => (window.__camView ? window.__camView()
    : { behind: 0, vf: 0, leadAhead: 0, backView: false });
  const hold = async (secs, inp) => {
    const t0 = window.__simT();
    while (window.__simT() - t0 < secs) {
      window.__setInput(inp);
      await new Promise(r => requestAnimationFrame(r));
    }
  };
  await hold(1.2, { gas: 1, brake: 0, steer: 0, hand: 0 });
  const forward = view();
  // brake from speed keeps braking, then reverses: drive() turns sustained
  // braking into reverse once the car is under way backwards
  await hold(3.5, { gas: 0, brake: 1, steer: 0, hand: 0 });
  const reversing = view();
  await hold(3.0, { gas: 1, brake: 0, steer: 0, hand: 0 });
  const again = view();
  window.__setInput(null);
  return { forward, reversing, again };
});
const D = out.drive;
/* BEHIND THE NOSE going forward, and the aim point ahead of it. Two tenths of a
   radian is eleven degrees, which is the lag settling rather than a camera
   pointing anywhere else. */
out.forwardLooksAhead = D.forward.behind < 0.2 && D.forward.vf > 5 &&
                        D.forward.leadAhead > 2;
/* AND ROUND THE FRONT going backwards. The camera ends up on the far side of the
   car from where it is travelling, which is the same relationship it has going
   forwards — and the point it aims at is now BEHIND the nose, which is the half
   that stops the eye ending up between the car and its own target. */
out.reverseLooksBack = D.reversing.behind > 2.9 && D.reversing.vf < -5 &&
                       D.reversing.leadAhead < -2 && D.reversing.backView === true;
// and it comes back, so this is a state and not a one-way trip
out.comesBack = D.again.behind < 0.2 && D.again.backView === false;

/* ---------- 4. it swings round, it does not cut across ---------- */
/* STEPPED BY HAND AT A FIXED dt rather than watched over frames. The arc takes
   about half a second and this machine renders the chase view at eight frames a
   second, so sampling the real loop would ask whether the swing is visible at
   the frame rate — which is a question about SwiftShader. Driving camera3D
   directly at 50 ms a step asks about the camera. */
out.swing = await p.evaluate(async () => {
  const c = P.car;
  const h = c.h;
  // straight, level, and going backwards hard enough to have flipped
  c.vx = -Math.cos(h) * 14; c.vy = -Math.sin(h) * 14;
  P.backView = false;                       // start it looking forward
  G3.cam.h = h;
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI;
                      while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const seen = [];
  for (let i = 0; i < 40; i++) {
    camera3D(0.05);
    seen.push(+Math.abs(wrap(G3.cam.h - h)).toFixed(3));
  }
  return { seen, end: seen[seen.length - 1],
           // how many steps it spent between the two ends: a snap spends none
           middle: seen.filter(a => a > 0.5 && a < 2.6).length,
           // and the biggest single step, which is what a snap maximises
           worstStep: +Math.max(...seen.map((a, i) => i ? Math.abs(a - seen[i - 1]) : 0)).toFixed(3) };
});
/* IT PASSES THROUGH THE MIDDLE. A camera that jumped would go from 0 to pi in
   one step and spend nothing in between; this spends several 50 ms steps there.
   The end has to actually arrive as well, or "it swings" is satisfied by a
   camera that wanders and never gets round. */
out.swingsRatherThanSnaps = out.swing.middle >= 3 && out.swing.end > 2.9 &&
                            out.swing.worstStep < 1.2;

/* ---------- 5. the dead band ---------- */
/* The three cases that matter, each stepped from a known state. A parking shunt
   lives entirely inside the band between the two thresholds, and the camera must
   sit still through all of it. */
out.band = await p.evaluate(() => {
  const c = P.car, h = c.h;
  const set = v => { c.vx = Math.cos(h) * v; c.vy = Math.sin(h) * v; };
  const step = n => { for (let i = 0; i < n; i++) camera3D(0.05); return !!P.backView; };
  const r = {};
  // a slow roll backwards is not reversing: under the ON threshold, no flip
  P.backView = false; G3.cam.h = h;
  set(-1.5); r.slowRollStaysForward = !step(20);
  // properly reversing flips it
  set(-6); r.realReverseFlips = step(20);
  // and a dab of brake mid-reverse — still moving backwards, but slowly — must
  // NOT flip it back, or a parking shunt spins the world twice a second
  set(-1.5); r.dabKeepsItRound = step(20);
  // only stopping does
  set(-0.3); r.stoppingBringsItBack = !step(20);
  return r;
});
out.deadBandHolds = out.band.slowRollStaysForward && out.band.realReverseFlips &&
                    out.band.dabKeepsItRound && out.band.stoppingBringsItBack;

/* ---------- 6. a drift is not a reverse ---------- */
/* The car in a slide is travelling sideways while pointing forwards, and a
   camera that chased the raw velocity vector would swing through the whole
   slide. The rule is the speed ALONG THE HEADING, so a pure sideways velocity —
   and even one with a little backwards in it, below the threshold — leaves it
   alone. */
out.drift = await p.evaluate(() => {
  const c = P.car, h = c.h;
  P.backView = false; G3.cam.h = h;
  // twenty metres a second straight sideways, nose still pointing up the road
  c.vx = -Math.sin(h) * 20; c.vy = Math.cos(h) * 20;
  for (let i = 0; i < 20; i++) camera3D(0.05);
  const sideways = !!P.backView;
  // and the same slide with the car drifting slightly backwards as well, which
  // is what the end of a big handbrake turn looks like
  c.vx = -Math.sin(h) * 20 - Math.cos(h) * 1.2;
  c.vy = Math.cos(h) * 20 - Math.sin(h) * 1.2;
  for (let i = 0; i < 20; i++) camera3D(0.05);
  return { sideways, slidingBack: !!P.backView };
});
out.driftDoesNotFlipIt = out.drift.sideways === false && out.drift.slidingBack === false;

out.errs = errs.slice(0, 5);
out.failing = Object.keys(out).filter(k => out[k] === false);
out.pass = out.forwardLooksAhead && out.reverseLooksBack && out.comesBack &&
           out.swingsRatherThanSnaps && out.deadBandHolds && out.driftDoesNotFlipIt &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
