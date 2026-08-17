/* THE GROUND HAS A SHAPE: grades that cost and give back speed, crests that
   launch the car, and landings that put it on its roof.

   All of it is gated on TERRAIN, which only the 3D view sets — so the first
   thing checked here is that the 2D game is still driving on a perfectly flat
   plane, because that is what forty-odd other tests in this suite are tuned
   against and it is the promise the whole design rests on.

   EVERYTHING IS MEASURED ON A ROAD, and that is not incidental. Off the tarmac
   the drag term is 1.5 rather than 0.32, which caps the car around 96 km/h and
   swamps a four-percent grade completely — the first version of this drove
   across open country and reported that uphill and downhill were identical.
   Ghost mode does not rescue it either: ghost lifts the off-road PENALTY, not
   the off-road drag. So the hill is measured where a hill is meant to be felt,
   along a real street picked for the height it gains end to end. */
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

/* ---------- 1. the 2D game is still flat ---------- */
/* If this ever fails, every speed and distance in the rest of the suite has
   quietly changed meaning. */
out.flat2D = await p.evaluate(() => {
  const s = [];
  for (let i = 0; i < 400; i++) s.push(window.__terrain((i % 20) * 340 - 3400, Math.floor(i / 20) * 340 - 3400).h);
  return { mode: window.__mode3d(), terrain: window.__body().terrain,
           nonZero: s.filter(v => v !== 0).length, samples: s.length };
});
out.twoDIsFlat = out.flat2D.terrain === false && out.flat2D.nonZero === 0;

/* ---------- 2. and the 3D world has hills, of a drivable steepness ---------- */
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  console.log(JSON.stringify({ skipped: 'no WebGL2 on this machine' }, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(800);
out.hills = await p.evaluate(() => {
  let lo = 1e9, hi = -1e9, steepest = 0;
  const g = [];
  for (let i = 0; i < 900; i++) {
    const x = (i % 30) * 220 - 3300, y = Math.floor(i / 30) * 220 - 3300;
    const t = window.__terrain(x, y);
    if (t.h < lo) lo = t.h; if (t.h > hi) hi = t.h;
    const s = Math.hypot(t.gx, t.gy);
    if (s > steepest) steepest = s;
    g.push(s);
  }
  g.sort((a, b) => a - b);
  return { lo: +lo.toFixed(1), hi: +hi.toFixed(1), range: +(hi - lo).toFixed(1),
           steepest: +steepest.toFixed(3), median: +g[Math.floor(g.length / 2)].toFixed(3) };
});
/* A range of a few tens of metres over six kilometres, and nothing you could not
   drive up. One in three would be a ski slope and would make the game unplayable
   in a way no test but this one would notice. */
out.hillsAreReal = out.hills.range > 15 && out.hills.steepest < 0.34 && out.hills.median > 0.005;

/* A STREET THAT GOES UP A HILL — not a patch of open ground that does.

   The first version of this teleported onto the steepest hillside it could find
   and drove across country, and every measurement came out flat. Off the tarmac
   the drag term is 1.5 rather than 0.32, which caps the car at about 96 km/h and
   swamps a 4% grade completely: coasting 30 m/s uphill and downhill both stopped
   after 22 metres. Ghost mode does not help, because it lifts the off-road
   PENALTY and not the off-road drag.

   So the grade is measured where a grade is meant to be felt: along a real
   street, picked for having the biggest height difference end to end. */
out.slope = await p.evaluate(() => {
  let best = null;
  for (const r of window.__roadList()) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 70) continue;
      const ha = window.__terrain(a.x, a.y).h, hb = window.__terrain(b.x, b.y).h;
      const grade = (hb - ha) / L;
      if (!best || Math.abs(grade) > Math.abs(best.grade))
        best = { grade, a, b, L, name: r.name || '' };
    }
  }
  if (!best) return null;
  // start at the LOW end, pointing up
  const up = best.grade > 0 ? best.a : best.b;
  const dn = best.grade > 0 ? best.b : best.a;
  return { x: +up.x.toFixed(0), y: +up.y.toFixed(0),
           up: +Math.atan2(dn.y - up.y, dn.x - up.x).toFixed(3),
           grade: +Math.abs(best.grade).toFixed(3), len: +best.L.toFixed(0), name: best.name };
});

/* ---------- 3. a car left on a hill rolls down it ---------- */
/* The crispest statement of the whole feature: no engine, no input, and the car
   still ends up further down the slope than it started. It cannot pass without
   gravity along the road, and it passes on nothing else. */
out.rolls = await p.evaluate(async s => {
  window.__tp(s.x, s.y, s.up);                    // on the road, pointing uphill, stationary
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  const h0 = window.__terrain(P.car.x, P.car.y).h;
  const x0 = P.car.x, y0 = P.car.y;
  await new Promise(r => setTimeout(r, 3500));
  const h1 = window.__terrain(P.car.x, P.car.y).h;
  return { moved: +Math.hypot(P.car.x - x0, P.car.y - y0).toFixed(1),
           dropped: +(h0 - h1).toFixed(2) };
}, out.slope);
/* Metres, not tens of them: a car with no throttle is still IN GEAR, and engine
   braking (0.9/s) is three times the rolling drag, so the terminal creep down a
   one-in-eighteen street is about half a metre a second. What makes this
   decisive is not the size of the number but that it is not zero — with no grade
   force the car never moves at all, because nothing else in drive() can start
   it from rest. */
out.rollsDownhill = out.rolls.moved > 0.25 && out.rolls.dropped > 0.008;

/* ---------- 4. coasting goes further downhill than up ---------- */
const coast = dir => p.evaluate(async a => {
  const [s, sign] = a;
  const h = s.up + (sign > 0 ? 0 : Math.PI);
  window.__tp(s.x, s.y, h);
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  // a rolling start, then nothing but drag and the hill
  P.car.vx = Math.cos(h) * 30; P.car.vy = Math.sin(h) * 30;
  const x0 = P.car.x, y0 = P.car.y;
  await new Promise(r => setTimeout(r, 3000));
  return +Math.hypot(P.car.x - x0, P.car.y - y0).toFixed(1);
}, [out.slope, dir]);
out.coastUp = await coast(1);
out.coastDown = await coast(-1);
out.fasterDownhill = out.coastDown > out.coastUp * 1.25;

/* ---------- 5. the speed ceiling lifts downhill ---------- */
/* A visible descent that leaves the speedometer pinned to exactly the same
   number reads as the slope not being modelled at all, so the clamp is raised by
   the grade. Tested by ASKING FOR IT rather than by driving to it: the steepest
   street in a real city is eighty metres long, which is not enough tarmac to
   reach three hundred and sixty on, and the first version of this measured 164
   and told me nothing.

   Set over the flat top speed and step one frame. Downhill the clamp lets it
   stand; on the level the same value is cut straight back to TOP_SPEED, and the
   difference between those two is the whole feature. */
out.ceiling = await p.evaluate(async s => {
  const run = async h => {
    window.__tp(s.x, s.y, h);
    window.__setInput({ steer: 0, gas: 1, brake: 0, hand: 0 });
    P.car.vx = Math.cos(h) * 106; P.car.vy = Math.sin(h) * 106;
    await new Promise(r => setTimeout(r, 120));
    return +(Math.hypot(P.car.vx, P.car.vy)).toFixed(1);
  };
  const down = await run(s.up + Math.PI);
  // across the slope: same street, same speed, no grade along the heading
  const across = await run(s.up + Math.PI / 2);
  return { down, across, top: TOP_SPEED };
}, out.slope);
out.liftsTheCeiling = out.ceiling.down > out.ceiling.top + 1 &&
                      out.ceiling.across <= out.ceiling.top + 0.1;

/* ---------- 6. a crest launches the car, but only if you are quick ---------- */
/* THE CONDITION IS v²·CURVATURE AGAINST GRAVITY, so this has to be done at
   speed, on tarmac, along a straight — off-road the car tops out at 96 km/h and
   no crest this terrain makes is anywhere near sharp enough at that speed.

   The straight is picked for downward curvature: the ground climbing at its
   start and falling at its end is exactly the shape that throws a car. */
out.jump = await p.evaluate(async () => {
  let run = null, bestK = 0;
  for (const r of window.__roadList()) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 120) continue;
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      // walk the segment looking for the sharpest downward bend along it
      for (let d = 20; d < L - 20; d += 8) {
        const x = a.x + ux * d, y = a.y + uy * d;
        const g0 = window.__terrain(x - ux * 20, y - uy * 20);
        const g1 = window.__terrain(x + ux * 20, y + uy * 20);
        const k = ((g1.gx * ux + g1.gy * uy) - (g0.gx * ux + g0.gy * uy)) / 40;
        if (k < bestK) { bestK = k; run = { x: x - ux * 90, y: y - uy * 90, a: Math.atan2(uy, ux) }; }
      }
    }
  }
  if (!run) return { found: false };

  const W = { air: false, maxUp: 0, landed: 0, maxRoll: 0, flips: 0 };
  let stop = false;
  const watch = () => {
    const c = P.car;
    const g = window.__terrain(c.x, c.y).h;
    if (c.air) { W.air = true; W.maxUp = Math.max(W.maxUp, c.z - g); }
    else if (W.air && !W.landed) W.landed = Math.abs(c.z - g) < .5 ? 1 : 2;
    W.maxRoll = Math.max(W.maxRoll, Math.abs(c.roll));
    if (c.flip > 0) W.flips++;
    if (!stop) requestAnimationFrame(watch);
  };
  window.__tp(run.x, run.y, run.a);
  // a running start, because reaching top speed inside one straight is not the
  // thing under test and most streets are not long enough for it
  P.car.vx = Math.cos(run.a) * 95; P.car.vy = Math.sin(run.a) * 95;
  window.__setInput({ steer: 0, gas: 1, brake: 0, hand: 0 });
  requestAnimationFrame(watch);
  await new Promise(r => setTimeout(r, 4000));
  stop = true;
  const c = P.car;
  return { found: true, curvature: +bestK.toFixed(5), air: W.air,
           maxUp: +W.maxUp.toFixed(2), landed: W.landed,
           endAir: !!c.air, endGap: +(c.z - window.__terrain(c.x, c.y).h).toFixed(2) };
});
out.launches = out.jump.found && out.jump.air && out.jump.maxUp > 0.6;
// and it comes back down onto the ground rather than hovering or sinking
out.landsOnTheGround = out.jump.landed === 1 || (!out.jump.endAir && Math.abs(out.jump.endGap) < 0.5);

/* ---------- 7. in the air, the controls roll the car ---------- */
/* Nothing else can move roll that far: on the ground it is driven straight at
   the surface's own angle, so a roll past a radian only happens off it. */
out.airRoll = await p.evaluate(async () => {
  const c = P.car;
  c.air = true; c.vz = 9; c.z = window.__terrain(c.x, c.y).h + 9;
  c.roll = 0; c.rv = 0;
  window.__setInput({ steer: 1, gas: 0, brake: 0, hand: 0 });
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 25));
    peak = Math.max(peak, Math.abs(c.roll));
  }
  return +peak.toFixed(2);
});
out.airControls = out.airRoll > 0.5;

/* ---------- 8. landed upside down, it rights itself ---------- */
out.flip = await p.evaluate(async () => {
  const c = P.car;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  // drop it in, already most of the way over
  c.air = true; c.roll = 2.6; c.rv = 0; c.vz = -6;
  c.z = window.__terrain(c.x, c.y).h + 3;
  await new Promise(r => setTimeout(r, 700));
  const onRoof = c.flip > 0;
  const rollThen = +Math.abs(c.roll).toFixed(2);
  await new Promise(r => setTimeout(r, 4200));
  // normalised: roll is an accumulator and 2π upright is upright
  const norm = a => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  return { onRoof, rollThen, flipNow: +c.flip.toFixed(2),
           rollNow: +norm(c.roll).toFixed(2), rawRoll: +c.roll.toFixed(2) };
});
out.flipsAndRecovers = out.flip.onRoof && out.flip.rollThen > 1.5 &&
                       out.flip.flipNow === 0 && out.flip.rollNow < 0.35;

/* ---------- 9. the same place always has the same hills ---------- */
/* Seeded from the city's own coordinates, so two players driving Belgrade see
   the same crest on the same street and a reload does not reshuffle the ground.
   A test that only checked "there are hills" would pass on Math.random(). */
out.sameAfterReload = await (async () => {
  const before = await p.evaluate(() =>
    [0, 1, 2, 3, 4].map(i => +window.__terrain(i * 700 - 1400, i * 430 - 900).h.toFixed(4)));
  const p2 = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await p2.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p2.goto(GAME);
  await p2.waitForTimeout(300);
  await p2.click('#go');
  await p2.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p2.waitForTimeout(500);
  await p2.evaluate(() => window.__setMode3d(true));
  await p2.waitForTimeout(500);
  const after = await p2.evaluate(() =>
    [0, 1, 2, 3, 4].map(i => +window.__terrain(i * 700 - 1400, i * 430 - 900).h.toFixed(4)));
  await p2.close();
  return { before, after, same: JSON.stringify(before) === JSON.stringify(after) };
})();

await p.evaluate(() => { window.__setInput(null); window.__setMode3d(false); });
out.errs = errs.slice(0, 5);
out.pass =
  out.twoDIsFlat &&
  out.hillsAreReal &&
  out.rollsDownhill &&
  out.fasterDownhill &&
  out.liftsTheCeiling &&
  out.launches && out.landsOnTheGround &&
  out.airControls &&
  out.flipsAndRecovers &&
  out.sameAfterReload.same &&
  !errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
