/* "Car get stuck here for some reason": nose to tail with a civilian at 2 km/h,
   throttle down, going nowhere. carsCollide was symmetric, so pushing a stopped
   car you gained accel*dt a frame and handed 0.78 of the closing speed straight
   back — an equilibrium at walking pace that never resolves. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio, parkOnAStraight } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8125, LON0 = 20.4489;                      // Savski venac, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
// one long straight road, so nothing but the other car can be in the way
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Kneza Milosa' },
    geometry: [toLL(-900, 0), toLL(900, 0)] },
  { type: 'way', id: 2, tags: { highway: 'residential', name: 'Cross' },
    geometry: [toLL(0, -900), toLL(0, 900)] },
  { type: 'node', id: 9, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Savski venac' } },
] });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

/* EVERY WINDOW HERE IS SIMULATED SECONDS. All three are behaviour over time —
   how far a shove carries, how many nudges the wedge escape gets, how hard a
   head-on lands — and the loop caps the physics at five steps a frame, so below
   twelve frames a second the world runs slower than the clock. Five wall-clock
   seconds then buy four of world and the escape gets three nudges instead of
   four: measured at exactly 2.5 m against a floor of 2.5, on a build where
   nothing about the escape had changed. */
const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Savski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)) || isArterials(q))
    return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(500);

const out = {};

// the screenshot exactly: one star, a civilian pinned directly ahead, throttle down
async function shove(wanted) {
  /* ON A STRAIGHT THE WORLD ACTUALLY HAS, not at a coordinate typed in here.
   *
   * This teleported to (-200, 0) "facing east along the road" and measured how
   * far east the car got. That was two assumptions about the bundled city, and
   * the second one was already known to be shaky: the comment below records a
   * 74 m run against 200-296 on the others, blamed on traffic and fixed by
   * trimming it. The number came back — 74.2 m, the same spot — once buildings
   * started stopping cars properly, because what is 74 m east of that point is a
   * wall the car used to squeeze past.
   *
   * The road picks the line now, and the distance is measured along it. */
  const spot = await parkOnAStraight(p, 120, 10);
  return p.evaluate(async ([w, sp]) => {
    window.__addWanted(w - window.__p().wanted);
    const h = P.car.h, ux = Math.cos(h), uy = Math.sin(h);
    const x0 = P.car.x, y0 = P.car.y;
    /* AND NOBODY ELSE ON THE ROAD. What is being measured is how far the car
       gets once it is past the ONE vehicle pinning it — and the street has live
       traffic on it. That was a fair enough hazard while everything on it was a
       hatchback to be shoved aside; with one in ten an eleven-tonne bus it is a
       wall. The rest of the traffic is not part of the question. */
    /* THE BLOCKER IS BUILT, NOT BORROWED. This reached into traffic slot zero,
       which assumes there is one — and right after a teleport there need not be,
       so it threw on four runs in six reading `.id` of undefined. It also had to
       normalise whatever it found, because one in ten of the traffic is an
       eleven-tonne bus and a bus you cannot shove aside is the mass model
       working rather than the escape failing (measured: 50 m of progress against
       296 with a car there, on runs of the same build).
       Making the car here settles both: it is always present and it is always a
       hatchback, which is what the report was about — one pinning you at a
       junction. */
    traffic.length = 0;
    /* IN CONTACT and at rest, which is the reported state. Contact radius is
       (la+lb)*0.34, about 3 m between centres — parking the car 9 m back just
       lets it get a run-up and ram its way through, which never reproduced. */
    const blk = makeCar(x0 + ux * 2.6, y0 + uy * 2.6, h, 'traffic');
    blk.l = 4.5; blk.w = 2.0; blk.bh = 1.45; blk.mass = 1; blk.maxSpeed = 15;
    blk.hp = 100; blk.livery = null;
    traffic.push(blk);
    await new Promise(r => requestAnimationFrame(r));
    const t0 = window.__simT();
    let best = 0, wall = false;
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const q = window.__p();
        best = Math.max(best, q.spd);
        // whether a building was what stopped it, which is the one thing that
        // makes this report the escape failing when the staging failed
        if (P.car.wall) wall = true;
        window.__simT() - t0 < 5 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const q = window.__p();
    window.__setInput(null);
    // along the road it was parked on, not along the x axis
    const moved = (P.car.x - x0) * ux + (P.car.y - y0) * uy;
    /* AND WHETHER IT ACTUALLY GOT PAST, which is the report in one number and
       the one this file was missing. Distance alone cannot tell "shoved the
       blocker down the street for seventy metres" from "slipped past it and
       drove three hundred" — both are the escape working, and the first came in
       at 73.7 m against a floor of 60, which is a coin toss waiting to happen. */
    const alive = traffic.indexOf(blk) >= 0;
    const ahead = alive
      ? ((P.car.x - blk.x) * ux + (P.car.y - blk.y) * uy) : 999;
    return { wanted: w, movedM: +moved.toFixed(1), topKmh: Math.round(best * 3.6),
             endKmh: Math.round(q.spd * 3.6), hitWall: wall,
             aheadM: +ahead.toFixed(1), street: sp ? sp.street : null };
  }, [wanted, spot]);
}

out.clearRoad = await shove(0);
/* The escape itself, tested directly. Boxing the car in with four cars held
   rigidly in place is not a fair test — no escape exists from that, and a real
   wedge is never that tight. So: hold the throttle while the car's velocity is
   forced to zero every frame, which is what being pinned feels like whatever the
   cause, and see whether it still works its way out. Without the escape the car
   cannot move at all; with it, it eases forward. */
out.heldStill = await p.evaluate(async () => {
  window.__tp(-200, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  const x0 = window.__p().x;
  const t0 = window.__simT(), n0 = window.__nudges();
  let frames = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p();
      window.__tp(q.x, q.y, q.h);            // same place, velocity killed: pinned
      frames++;
      window.__simT() - t0 < 5 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { crept: +(q.x - x0).toFixed(2), nudges: window.__nudges() - n0,
           frames, simSecs: +(window.__simT() - t0).toFixed(2) };
});
/* COUNT THE NUDGES, DO NOT INTEGRATE THEM. The escape is one 1.2 m shove every
   STUCK_SECS of throttle held against a standstill, so five seconds is exactly
   three of them — and that is a property of the rule, independent of frame rate,
   which is what makes it worth asserting.
   The distance was not. This pin kills the car's velocity once per FRAME while
   the loop runs up to five physics steps in one, so what "crept" measured was
   how much movement escaped between kills — and it moved the wrong way under
   load, not the expected one: 300 frames gave 2.4 m and 185 frames gave 4.1,
   because fewer kills let the car keep more of what it built up. Against a floor
   of 2.5 that failed on a fast machine and passed on a slow one, which is the
   opposite of a load-sensitive test and twice as confusing.
   The distance is still checked, loosely, against the nudges actually counted —
   a nudge that fires but moves nothing is the other way this could break. */
out.escapesAWedge = out.heldStill.nudges >= 3 &&
                    out.heldStill.crept > out.heldStill.nudges * 0.6;
out.wantedOneStar = await shove(1);
/* PAST IT, AND MOVING. The reported bug is a car pinned nose-to-tail doing 2
   km/h, so the claim is that it ends up in FRONT of the thing that was pinning
   it and covered real ground doing so. `aheadM` is the direct reading and does
   not care whether it got there by shoving the blocker or by slipping round it;
   the distance floor comes down to 40 because it is no longer carrying the whole
   assertion on its own. */
out.getsPast = out.clearRoad.aheadM > 2 && out.wantedOneStar.aheadM > 2 &&
               out.clearRoad.movedM > 40 && out.wantedOneStar.movedM > 40 &&
               out.wantedOneStar.topKmh > 40;

/* And a head-on shunt must still hurt both, i.e. mass didn't break the crashes.

   STAGED NEXT TO THE PLAYER, NOT 300 m AWAY. It used to be 300 m, and that quietly
   stopped testing anything the day traffic outside the view stopped being
   simulated: both cars were culled on the frame after they were placed, the loop
   watched an empty list for 1.8 s, and "neither car was damaged" came back as a
   failure of the collision model rather than of the staging.

   AND IT IS THE PLAYER THAT DOES THE HITTING, not two AI cars aimed at each
   other. It used to be two traffic cars nine metres apart closing at 15 m/s
   each, which worked until traffic learned to keep right: two cars travelling
   opposite ways along one road now steer into their own lanes, about four metres
   apart, and slide past each other. Measured across runs it became a coin toss —
   [79.8, 100] on one and [85.6, 85.2] on the next, against a clean symmetric
   [79.1, 79.1] before the lane offset existed. Nothing was broken; the staging
   had started depending on a bug that had been fixed.

   The player has no lane-keeping to steer it off the line, so aiming it at a
   stationary car is deterministic — and it exercises the thing this section is
   actually about, since massOf() gives the player three times a civilian's mass
   and that asymmetry is what "mass didn't break the crashes" means. */
/* ON A STRAIGHT, NOT AT THE ORIGIN.
 *
 * This teleported to (0, 0) and put the target ten metres up the x axis, which
 * assumes ten metres of clear ground at the middle of the city. Whether there is
 * depends on which tiles have streamed in by the time this section runs, and
 * that depends on how far the two runs above happened to drive — so once
 * buildings started stopping cars properly, one run in four had the player hit a
 * wall at six metres and never reach the car at all. It came back as
 * [100, 82] with the target moved 0.4 m: the collision model reported working
 * on the player and broken on the civilian, when what had happened is that the
 * two never met.
 *
 * parkOnAStraight is the same helper five other files here use for the same
 * reason. The line is the road's, not the x axis's. */
const spot = await parkOnAStraight(p, 60, 10);
out.headOn = await p.evaluate(async spot => {
  window.__ghost(false);
  window.__heal();
  const h = P.car.h, ux = Math.cos(h), uy = Math.sin(h);
  const at = { x: P.car.x + ux * 10, y: P.car.y + uy * 10 };
  /* TEN METRES, NOT TWENTY, and the impact inside a third of a second.

     The target is a traffic car and traffic drives: at twenty metres it had
     accelerated away and steered into its lane before the player arrived, so the
     player hit something else and the civilian came back untouched on two runs
     out of three. Ten metres at 26 m/s closes in 0.38 s, in which an AI car
     pulling 7 m/s² from rest covers half a metre. It is still there when the
     player gets to it. */
  window.__putTraffic(0, at.x, at.y, h + Math.PI, null, 0, 0);
  /* A CAR, NOT WHATEVER IS IN SLOT ZERO. What is being measured is that a
     head-on hurts both parties, which is about the damage model rather than
     about vehicle types — and one in ten of the traffic is now an eleven-tonne
     bus, which correctly shrugs off an impact that dents a hatchback. Measured:
     the target came out of it on 100 health while the player lost 7. That is the
     mass model working, and it is not what this line is asking about. */
  window.__ordinaryCar(0);
  window.__setCarHp('traffic', 0, 100);
  const id = window.__cars().traffic[0].id;
  let lowT = 100, lowP = 100, wall = false;
  P.car.vx = ux * 26; P.car.vy = uy * 26;      // straight at it, no steering
  const t0 = window.__simT();
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      for (const t of window.__cars().traffic) if (t.id === id) lowT = Math.min(lowT, t.hp);
      lowP = Math.min(lowP, window.__p().hp);
      // whether the player met a building on the way, which is the one thing
      // that could make this report a collision failure when the staging failed
      if (P.car.wall) wall = true;
      window.__simT() - t0 < 1.2 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  const t = window.__cars().traffic.find(q => q.id === id);
  return { lowest: [+lowT.toFixed(1), +lowP.toFixed(1)],
           targetMoved: t ? +Math.hypot(t.x - at.x, t.y - at.y).toFixed(1) : null,
           hitWall: wall, street: spot ? spot.street : null,
           bothHurt: lowT < 100 && lowP < 100 };
}, spot);

await p.screenshot({ path: `${OUT}/shot-stuck.png` });
out.errs = errs.slice(0, 4);
out.pass = out.getsPast && out.escapesAWedge && out.headOn.bothHurt && !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
/* Worked out `pass` and then exited 0 whatever it said, so a failure here has
   only ever been visible to someone reading the JSON by eye. A test that cannot
   fail is a log. */
process.exit(out.pass ? 0 : 1);
