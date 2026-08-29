/* TRAFFIC THAT DRIVES INSTEAD OF DETONATING.

   Reported: "all I hear is explosions of cars that are not on the screen."
   Three separate faults behind that one sentence, and this covers all three.

   THEY NEVER BRAKED FOR EACH OTHER. updateTraffic() slowed down for the player
   and for nothing else, so every car drove at full throttle into whatever was in
   front of it. With one car in twenty-six that is the odd shunt; with daylight's
   rush hour on the same streets it is a permanent demolition derby.

   EVERY PAIR WAS HIT TWICE. The car-on-car sweep lived inside the per-car
   update, so it ran every car against every other one — sixty-five thousand
   tests a frame at 255 cars — and each pair was resolved and damaged from both
   ends.

   AND YOU COULD HEAR ALL OF IT. Crashes and explosions played at full volume
   wherever they happened, six hundred metres away or under the bonnet.

   THEN THEY DROVE IN CIRCLES. Cutting the steering gain to stop the weaving made
   it worse: a car aiming at the next node, unable to turn tightly enough, sails
   past it — and the node is then behind, so it turns back, misses from the other
   side and loops. Aiming a few car-lengths DOWN the road instead of at the node
   is what makes anything follow a path, and "are they on the road" is a question
   the drivable mask can answer directly.

   Usage: node tests/traffic.mjs [GAME=/path/to/index.html]
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CHROME, GAME, ROOT, SHOTS, stubRadio } from './harness.mjs';

const FIX = join(ROOT, 'tests', 'fixtures', 'stari-grad');
const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const gz = f => gunzipSync(readFileSync(join(FIX, f))).toString('utf8');
const rep = {};
for (const r of session.replies) if (r.elements) rep[r.kind] = { body: gz(r.file), bbox: r.bbox };
const EMPTY = readFileSync(join(FIX, 'empty.json'), 'utf8');
const b0 = rep.streets.bbox;
const LAT0 = (b0.s + b0.n) / 2, LON0 = (b0.w + b0.e) / 2;
const boxOf = q => { const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null; };
const near = (a, t) => a && Math.abs((a.s + a.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                            Math.abs((a.w + a.e) / 2 - (t.w + t.e) / 2) < 4e-3;
const br = await chromium.launch({ executablePath: CHROME });
const ctx = await br.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Stari grad' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const box = boxOf(q);
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  let body = EMPTY;
  if (kind === 'arterials') body = rep.arterials.body;
  else if (kind === 'streets' && near(box, b0)) body = rep.streets.body;
  else if (kind === 'buildings' && near(box, rep.buildings.bbox)) body = rep.buildings.body;
  return r.fulfill({ contentType: 'application/json', body });
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(1200);

const out = {};
out.gaps = await p.evaluate(() => {
  const t = window.__traf();
  return { stop: t.gapStop, see: t.gapSee, radius: t.radius };
});

/* Daylight, because that is where it went wrong: the same streets with three
   times the cars on them. Drives for half a minute and watches. */
const runIn = theme => p.evaluate(async name => {
  applyTheme(name);
  /* Onto a real street first. Driving a constant turn from wherever the car
     happens to start walks it into a field, where there is no traffic and the
     count measures nothing — the longest drivable way near the centre is where
     the cars are. */
  const roads = window.__roadList().filter(r => r.drive);
  let best = null, bestLen = 0;
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (Math.hypot(a.x, a.y) > 700) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > bestLen) { bestLen = L; best = { a, b }; }
  }
  if (best) window.__tp(best.a.x, best.a.y, Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x));
  /* AND NO POLICE, held down for the whole run.
   *
   * This test is about traffic left to itself — the report behind it was cars
   * detonating unprompted and out of sight. A pursuit is a different subsystem
   * and it was quietly getting into the measurement: sixteen seconds of driving
   * at a wall of rush-hour cars earns a wanted level, and once the police are
   * allowed to hit things (they used to drive through them) three cruisers
   * shouldering their way through daylight traffic will eventually total
   * somebody. That is the intended behaviour, it is covered in crashes.mjs, and
   * counting it here read as "the traffic is detonating again" when the traffic
   * was fine.
   *
   * It was also an uncontrolled variable long before it changed anything: how
   * much heat this run happens to earn depends on how many cars the player
   * clips, which is not something the test sets. Zeroed every frame rather than
   * once, because it accrues continuously. Not clearHeat() — that is newer than
   * some of the builds this file gets pointed at, and these two lines are what
   * it does. */
  const calm = () => { P.wanted = 0; cops.length = 0; };
  calm();
  await new Promise(r => setTimeout(r, 4000));       // let the cap fill
  const w0 = window.__traf().wrecks;
  const t0 = performance.now();
  let frames = 0, samples = 0;
  let minGap = Infinity, sumSpd = 0, sumStopped = 0, maxOut = 0, sumOnScreen = 0;
  let onRoad = 0, seenCars = 0;
  /* STRAIGHTNESS. A car driving in circles covers ground without getting
     anywhere, so the telling number is how far it actually MOVED against how far
     it drove: near 1 on a road, near 0 going round and round. Tracked per car by
     id, since traffic comes and goes under it. */
  const track = new Map();
  let straightSum = 0, turnSum = 0, straightN = 0;
  await new Promise(res => {
    const tick = () => {
      /* City pace, not flat out. At 300 km/h the car crosses the whole traffic
         ring in two seconds and spends the run in ground where cars have only
         just spawned at the edge — which measures how fast the player is, not
         how much traffic there is. */
      const spd = window.__p().spd;
      window.__setInput({ gas: spd < 19 ? 1 : 0, brake: 0, steer: 0, hand: 0 });
      calm();
      frames++;
      if (frames % 12 === 0) {
        samples++;
        const cars = window.__traffic(), me = window.__p();
        // are they ON the road? the mask knows, and it is the whole complaint
        for (const c of cars) if (window.__onRoad(c.x, c.y)) onRoad++;
        seenCars += cars.length;
        const r = window.__traf().radius;
        let stopped = 0;
        for (let i = 0; i < cars.length; i++) {
          const a = cars[i];
          sumSpd += a.spd;
          if (a.spd < 1) stopped++;
          // nothing may be simulated well outside the ring
          maxOut = Math.max(maxOut, Math.hypot(a.x - me.x, a.y - me.y) - r);
          const [sx, sy] = window.__toScreen(a.x, a.y);
          if (sx > -40 && sy > -40 && sx < innerWidth + 40 && sy < innerHeight + 40) sumOnScreen++;
          // and the closest two cars ever get to each other
          for (let j = i + 1; j < cars.length; j++) {
            const b = cars[j];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d < minGap) minGap = d;
          }
        }
        sumStopped += cars.length ? stopped / cars.length : 0;
        for (const c of cars) {
          let s = track.get(c.id);
          if (!s) { track.set(c.id, { x0: c.x, y0: c.y, px: c.x, py: c.y, ph: c.h, path: 0, turn: 0 }); continue; }
          s.path += Math.hypot(c.x - s.px, c.y - s.py);
          let dh = c.h - s.ph;
          while (dh > Math.PI) dh -= 2 * Math.PI;
          while (dh < -Math.PI) dh += 2 * Math.PI;
          s.turn += Math.abs(dh);
          s.px = c.x; s.py = c.y; s.ph = c.h;
          if (s.path > 90) {                       // a good long stretch to judge on
            straightSum += Math.hypot(c.x - s.x0, c.y - s.y0) / s.path;
            turnSum += s.turn;                     // radians of wheel per 90 m
            straightN++;
            track.set(c.id, { x0: c.x, y0: c.y, px: c.x, py: c.y, ph: c.h, path: 0, turn: 0 });
          }
        }
      }
      if (performance.now() - t0 < 16000) requestAnimationFrame(tick);
      else { window.__setInput(null); res(); }
    };
    requestAnimationFrame(tick);
  });
  const el = (performance.now() - t0) / 1000;
  const cars = window.__traffic().length;
  return { secs: +el.toFixed(1), cars,
           // proof the staging held: a nonzero here invalidates the wreck count
           cops: window.__p().cops, wanted: window.__p().wanted,
           wrecks: window.__traf().wrecks - w0,
           wrecksPerMin: +((window.__traf().wrecks - w0) / el * 60).toFixed(1),
           minGap: +minGap.toFixed(2),
           avgKmh: +(sumSpd / Math.max(samples * cars, 1) * 3.6).toFixed(1),
           stoppedPct: +(sumStopped / Math.max(samples, 1) * 100).toFixed(0),
           onScreen: +(sumOnScreen / Math.max(samples, 1)).toFixed(1),
           onRoadPct: +(onRoad / Math.max(seenCars, 1) * 100).toFixed(1),
           straightness: +(straightSum / Math.max(straightN, 1)).toFixed(3), straightN,
           turnPer90m: +(turnSum / Math.max(straightN, 1)).toFixed(2),
           beyondRingM: +maxOut.toFixed(1),
           fps: Math.round(frames / el) };
}, theme);
/* The same drive twice. An absolute on-screen count measures the route and the
   map as much as the traffic — what has to hold is that daylight puts MORE cars
   in front of you than dusk does, and that neither of them detonates. */
out.dusk = await runIn('dusk');
out.run = await runIn('day');

/* And the sound, through the wiring rather than through the formula. Asking
   earshot() what it returns proves nothing about whether anything USES it, and
   "I hear explosions from cars that are not on the screen" is a complaint about
   the calls, not the maths. So the two sound functions are wrapped, real
   explosions are set off at known distances, and what comes out is the gain the
   game actually asked for. */
out.sound = await p.evaluate(async () => {
  const heard = [];
  const realBoom = SFX.boom, realCrash = SFX.crash;
  SFX.boom = (g = 1) => { heard.push(+g.toFixed(3)); };
  SFX.crash = v => { heard.push(+(v / 20).toFixed(3)); };
  const me = window.__p();
  const at = async d => {
    heard.length = 0;
    window.__explodeAt(me.x + d, me.y);
    await new Promise(r => requestAnimationFrame(r));
    return heard.length ? Math.max(...heard) : 0;
  };
  const r = { onTheBonnet: await at(3), halfAScreen: await at(60),
              justOffScreen: await at(240), twoBlocks: await at(700) };
  SFX.boom = realBoom; SFX.crash = realCrash;
  return r;
});
/* RUSH HOUR, WHERE THE FAULT ACTUALLY LIVED.
 *
 * The wreck count above was a guard in name only, and measuring it said so. The
 * report was "all I hear is explosions", at the daylight cap — 255 cars on the
 * same streets. This fixture's daylight run stages 25 to 75, and at that density
 * the fault does not appear: with the look-ahead braking torn out completely,
 * so that every car drives at full throttle into whatever is in front of it,
 * the run still comes back with zero wrecks. The threshold could not fail.
 *
 * At the cap it separates cleanly — 0 against 48.7 per minute for the same
 * build with the braking removed — so the count is taken here, where a
 * regression has somewhere to show itself.
 *
 * Last, because it leaves 160-odd cars on the road, and because the runs above
 * are about how traffic DRIVES, which is a different question from whether it
 * survives its own rush hour. */
out.rush = await p.evaluate(async () => {
  applyTheme('day');
  window.__trafficCap(255);
  /* NOT teleported first, though every other section here is. Moving the car
     culls the ring and respawns it around the new spot, and six seconds only
     bought 46 cars back — half of what simply staying put gives. Density is the
     entire point of this section, so it starts from wherever the daylight run
     finished, which is already full. */
  const calm = () => { P.wanted = 0; cops.length = 0; };
  calm();
  await new Promise(r => setTimeout(r, 8000));            // let the cap fill
  const w0 = window.__traf().wrecks, t0 = performance.now();
  let frames = 0;
  await new Promise(res => {
    const tick = () => {
      const spd = window.__p().spd;
      window.__setInput({ gas: spd < 19 ? 1 : 0, brake: 0, steer: 0, hand: 0 });
      calm(); frames++;
      /* Longer than the runs above. What has to separate here is a RATE, and a
         single wreck in sixteen seconds is already 3.7 a minute — so whether a
         broken build fails comes down to whether it happened to total one car
         inside a short window. Twenty-four seconds gives it room to. */
      if (performance.now() - t0 < 24000) requestAnimationFrame(tick);
      else { window.__setInput(null); res(); }
    };
    requestAnimationFrame(tick);
  });
  const el = (performance.now() - t0) / 1000;
  return { cars: window.__traf().cars, cops: window.__p().cops,
           wrecks: window.__traf().wrecks - w0,
           wrecksPerMin: +((window.__traf().wrecks - w0) / el * 60).toFixed(1),
           fps: Math.round(frames / el) };
});

// what you can see you can hear; what you cannot, you cannot
out.quietOffScreen = out.sound.onTheBonnet > .9 && out.sound.halfAScreen > .2 &&
                     out.sound.justOffScreen < .05 && out.sound.twoBlocks === 0;

out.errs = errs.slice(0, 4);
out.pass =
  /* THE REPORTED FAULT: cars are not blowing each other up any more. Measured
     at the daylight cap, which is the only density where it ever did — see the
     rush-hour section. The two runs above are held to it as well, but it is
     out.rush that can actually fail. */
  out.rush.wrecksPerMin < 2 && out.rush.cars > 120 &&
  out.run.wrecksPerMin < 2 &&
  // and every one of them was traffic on its own, not a pursuit through it
  out.run.cops === 0 && out.dusk.cops === 0 && out.rush.cops === 0 &&
  // they keep a gap rather than driving through one another
  /* Never interpenetrating. carsCollide separates to (a.l+b.l)*0.34, which for
     the smallest pair of cars is about 2 m, so this is "the resolver is doing
     its job", not an arbitrary distance. */
  out.run.minGap > 1.9 &&
  // and they are still driving, not parked in a queue
  out.run.avgKmh > 6 && out.run.stoppedPct < 60 &&
  // ON the roads, in both themes — driving in circles across open ground was
  // the report, and this is the number that says it is not happening
  out.run.onRoadPct > 88 && out.dusk.onRoadPct > 88 &&
  /* And they GET somewhere: over 90 m of driving, the distance actually covered
     is most of the distance driven, and the wheel does not wind through more
     than a couple of radians doing it. A car going round in circles scores near
     zero on the first and four or five on the second, however much tarmac it
     manages to stay on.

     Honest about what these are: a guard, not a reproduction. Chasing the next
     node instead of a look-ahead point measures 0.77/3.22 against 0.82/2.22
     here — the right direction and consistent across runs, but this fixture's
     short dense city-centre segments do not produce the dramatic circling that
     was reported, so the thresholds sit where gross looping fails rather than
     where the two builds happen to differ. */
  out.run.straightness > .6 && out.dusk.straightness > .6 &&
  out.run.turnPer90m < 3.6 && out.dusk.turnPer90m < 3.6 &&
  // nothing lives more than a whisker outside the ring
  out.run.beyondRingM < 25 &&
  // daylight is busier than dusk, and neither is empty
  out.run.onScreen > out.dusk.onScreen && out.dusk.onScreen > 0 &&
  out.dusk.wrecksPerMin < 2 &&
  out.quietOffScreen && out.run.fps >= 45 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
