"use strict";
/* VICE MAPS — Cars, traffic, police, pedestrians — and the driving physics they share.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 4. entities ------------------------------ */
let carSeq = 0;
function makeCar(x, y, h, kind) {
  const isCop = kind === 'cop';
  return {
    id: ++carSeq,
    x, y, h, vx: 0, vy: 0, kind,
    w: isCop ? 2.05 : rand(1.85, 2.15),
    l: isCop ? 4.7 : rand(4.1, 4.9),
    hp: 100, maxSpeed: isCop ? TOP_SPEED * .6 : (kind === 'player' ? TOP_SPEED : rand(11, 17)),
    /* The player's engine has to out-pull the drag, or the number on the clock is
       a lie: constant force against linear drag settles at accel/0.32, and at 28
       that is 87 m/s — 315 km/h — so the 360 ceiling was never reachable. At 40
       the CLAMP is what limits top speed, which is what a top speed should be. */
    accel: isCop ? 28 : (kind === 'player' ? 40 : 7),
    turn: isCop ? 2.5 : 2.7,
    color: isCop ? '#f2f4f8' : pick(PAL.carBody),
    steer: 0, road: true, dead: false, hitCd: 0,
    /* THE 3D BODY — see body3d.js. Height above the terrain, attitude, and the
       rates that carry a tumble through the air. Declared here so every car has
       one shape whichever view is running; in the 2D view TERRAIN is off and
       nothing ever writes to any of them. z starts undefined on purpose: the
       first ground step reads that as "never been placed" and snaps the car to
       whatever the terrain is under it, which is also how a respawn on the far
       side of a valley avoids being launched. */
    z: undefined, vz: 0, pitch: 0, roll: 0, pv: 0, rv: 0,
    air: false, flip: 0, climb: 0, gz: 0,
    bh: isCop ? 1.5 : rand(1.32, 1.58),          // body height, for the cuboid
    // traffic path state
    road_: null, idx: 0, dir: 1, blink: 0
  };
}

const P = {                       // player + run state
  car: null, cash: 0, score: 0, wanted: 0, cool: 0,
  bustT: 0, dead: false, deadT: 0, spawn: { x: 0, y: 0, h: 0 }, recover: null,
  hitCd: 0, horn: 0
};
let traffic = [], cops = [], peds = [], marks = [], parts = [], blasts = [];
/* A full 180 lays rubber for most of a second, and the arc has to still be there
   when you look back at it. Each mark is its own stroke, so the cap is a frame
   budget as much as a memory one — the draw loop culls to the view to earn it. */
const MAX_MARKS = 760, MARK_LIFE = 9;
const SPIN_SECS = .85;      // how long a committed 180 takes, eased in and out
// full throttle and going nowhere for this long means something has you pinned
const STUCK_SECS = 1.3;
const MISSION = { state: 'none', pick: null, drop: null, time: 0, reward: 0, done: 0 };

/* WHERE THE OTHER CARS ARE, in buckets, rebuilt once a frame.

   Traffic used to find its neighbours by walking the whole list — and it did it
   from inside the per-car update, so the sweep was every car against every other
   one: 255 cars in daylight is sixty-five thousand distance tests a frame, each
   pair visited twice. Bucketed at 26 m a car looks at the handful actually near
   it, which is what makes both the collisions and the new keep-your-distance
   check affordable at all.

   Rebuilt rather than maintained: cars move every frame, a whole rebuild is one
   pass over the list, and an index that has to be kept correct as cars spawn,
   die and get culled is a bug waiting to happen. */
const TCELL = 26;
const TG = new Map();
const TNEAR = [];
const tkey = (gx, gy) => gx * 8192 + gy;
function gridAdd(t) {
  const k = tkey(Math.floor(t.x / TCELL), Math.floor(t.y / TCELL));
  const a = TG.get(k);
  if (a) a.push(t); else TG.set(k, [t]);
}
function trafficGrid() {
  TG.clear();
  for (let i = 0; i < traffic.length; i++) {
    traffic[i].i = i;                          // pair ordering, so each pair resolves once
    gridAdd(traffic[i]);
  }
}
// the cars in this cell and the eight around it. One shared array — the callers
// read it and are done with it before anything else asks.
function nearTraffic(x, y) {
  TNEAR.length = 0;
  const gx = Math.floor(x / TCELL), gy = Math.floor(y / TCELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const a = TG.get(tkey(gx + i, gy + j));
    if (a) for (let n = 0; n < a.length; n++) TNEAR.push(a[n]);
  }
  return TNEAR;
}

/* How much room traffic leaves. GAP_STOP is a car length and a half of hard
   brake; between there and GAP_SEE it lifts off proportionally, so a queue
   settles into a rolling gap instead of the brake/floor-it concertina that
   ends in a shunt. AI_HIT is the closing speed two AI cars have to meet at
   before it counts as a crash — higher than the player's, because nose to tail
   in traffic is the normal state and a kiss at walking pace is not a collision. */
const GAP_STOP = 7, GAP_SEE = 22, AI_HIT = 9;

/* THE EDGE OF THE SCREEN IS WHERE TRAFFIC BEGINS AND ENDS.

   Cars used to live out to 780 m while the view is about 170 m across, so nine
   tenths of them were driving around, crashing and exploding somewhere you could
   never see. They are kept just past the corner of the screen now: TRAFFIC_PAD
   metres beyond the furthest visible point, which is enough that nothing pops
   into existence in frame and little enough that nothing is simulated for no
   reason.

   The radius is a circle around the car, not the screen rectangle, so spinning
   on the spot reveals nothing that was culled — the camera sits at 60% of the
   viewport height and shows more road ahead than behind, and the circle covers
   the far corner in every direction. */
const TRAFFIC_PAD = 150;
const trafficR = () => Math.hypot(VW, VH) / 2 / cam.s + TRAFFIC_PAD;

/* New cars arrive in the band between the edge of the screen and the cull
   radius, biased to the road ahead — you drive INTO traffic, you don't watch it
   materialise in the mirror. `ahead` is the direction to favour; roadPoint takes
   a heading band, so this asks for the far side first and settles for anywhere
   in the ring if that stretch of road has nothing on it. */
function spawnTraffic(n, wide) {
  /* `wide` fills the whole ring, for a standing start: opening a city with every
     car in the outer band means the street you are actually parked on is empty
     until something happens to drive down it. Every top-up after that arrives at
     the edge. */
  const r1 = trafficR() - 4;
  const r0 = wide ? 30 : trafficR() - TRAFFIC_PAD * .7;
  for (let i = 0; i < n; i++) {
    const p = roadPoint(P.car.x, P.car.y, r0, r1, 140) || roadPoint(P.car.x, P.car.y, r0, r1)
           || roadPoint(P.car.x, P.car.y, 30, r1);
    if (!p) continue;
    /* Not on top of one that is already there. roadPoint picks a spot on a way
       without looking, so two cars in the same tick could land on the same metre
       of tarmac — which reads as one car with a shadow, and then as a shunt when
       the overlap resolves. */
    /* Which way along the way, and therefore which way the car FACES. It used to
       be given p.h whichever direction it had been assigned, so half the traffic
       spawned pointing backwards down its own lane and spent its first seconds
       swinging round. */
    const dir = Math.random() < .5 ? 1 : -1;
    const h = dir > 0 ? p.h : p.h + Math.PI;
    const off = laneOffset(p.road);
    const sx = p.x + Math.cos(h + Math.PI / 2) * off;
    const sy = p.y + Math.sin(h + Math.PI / 2) * off;
    let taken = false;
    for (const o of nearTraffic(sx, sy)) if (dist2(o.x, o.y, sx, sy) < 49) { taken = true; break; }
    if (taken) continue;
    const c = makeCar(sx, sy, h, 'traffic');
    // the spawn point already knows which way it sits on — no search needed
    c.road_ = p.road; c.idx = p.idx; c.dir = dir;
    c.i = traffic.length;
    traffic.push(c);
    // into the grid straight away, or the next car in this same call cannot see
    // it — the grid is only rebuilt once a frame, and a whole rush hour is
    // spawned in one tick
    gridAdd(c);
  }
}
// Re-home a car onto some nearby way (used when one runs out of road).
function rehome(c) {
  const p = roadPoint(c.x, c.y, 0, 260, 140) || roadPoint(c.x, c.y, 0, 260) || roadPoint(c.x, c.y, null);
  if (!p) return false;
  const dir = Math.random() < .5 ? 1 : -1;
  const h = dir > 0 ? p.h : p.h + Math.PI;
  const off = laneOffset(p.road);
  c.x = p.x + Math.cos(h + Math.PI / 2) * off;
  c.y = p.y + Math.sin(h + Math.PI / 2) * off;
  c.h = h;
  c.road_ = p.road; c.idx = p.idx; c.dir = dir;
  return true;
}
function spawnPeds(n) {
  for (let i = 0; i < n; i++) {
    const p = roadPoint(P.car.x, P.car.y, 40, 400);
    if (!p) continue;
    const off = pick([-1, 1]) * rand(7, 13);   // start on the pavement, not the road
    peds.push({
      x: p.x + Math.cos(p.h + Math.PI / 2) * off, y: p.y + Math.sin(p.h + Math.PI / 2) * off,
      h: p.h + (Math.random() < .5 ? 0 : Math.PI), spd: rand(1.1, 1.8),
      col: pick(['#ffe36a', '#33e6ff', '#ff4fd8', '#fff', '#48ff9e', '#ff9f5a']),
      t: rand(0, 10), dead: false
    });
  }
}
// Returns false when there is nowhere to put a unit, so callers can stop asking.
function spawnCop() {
  /* Widening bands, never "anywhere". The old fallback was roadPoint(x, y, null)
     — a random road in the whole world — which in an 18 km city puts the unit
     kilometres away, and the 700 m cull above deletes it on the next frame. It
     looked like it worked only because the top-up ran sixty times a second and
     eventually rolled a near one; rate-limiting that top-up made a latent bug
     visible. Every band here is inside the cull radius. */
  const p = roadPoint(P.car.x, P.car.y, 150, 320) ||
            roadPoint(P.car.x, P.car.y, 90, 480) ||
            roadPoint(P.car.x, P.car.y, 40, 660);
  if (!p) return false;
  cops.push(makeCar(p.x, p.y, p.h, 'cop'));
  return true;
}
/* Top the pursuit up to the wanted level, never looping forever if spawning
   fails. Returns whether it managed to fill, so the caller can back off from a
   search that is not going to succeed rather than repeat it every frame. */
function stockCops(target) {
  let guard = 8;
  while (cops.length < target && guard-- > 0) { if (!spawnCop()) return false; }
  return true;
}

/* ------------------------------ 5. physics ------------------------------ */
/* Off the road without the perk. Constant engine force against linear drag
   settles at accel/drag, so 40/9.5 is about 4.2 m/s — the ceiling is a shade
   above that so the number on the clock is one the car genuinely reaches
   rather than an asymptote it creeps towards, same argument as the top speed. */
const STRAY_DRAG = 9.5;
const STRAY_TOP = 4.5;              // ≈16 km/h
const STRAY_TOL = 10;               // metres of slack before any of it applies

/* WHICH SIDE OF THE WHITE LINE A CAR BELONGS ON.

   Every way in this world is a centreline, and traffic drove straight down it —
   so two cars going opposite ways along the same street occupied the same metre
   of tarmac and passed through each other, and a street with cars on it looked
   like a single file down the middle rather than like a road.

   A quarter of the width puts a car in the middle of its own half: 2 m on a
   residential street, 2.75 on a secondary, 4.25 on a motorway. Clamped at both
   ends — a 5 m service road has no room for a full offset and a motorway does
   not need one that wide, since this is one lane each way however many are
   painted on.

   RIGHT IS h + π/2 in this coordinate system, where +y is south: heading east
   at h = 0, that is (0, 1), which is south, which is the driver's right. Traffic
   here drives on the right, like the city it is modelled on. Cars travelling the
   other way along the same centreline compute their own right from their own
   heading and land on the opposite side, which is what makes the two streams
   appear without anything having to arrange them. */
const laneOffset = r => clamp(((r && r.w) || 8) * .25, 1.2, 3.5);
/* Back towards the tarmac you left. This fights the very drag that makes the
   crawl — the pull goes into world velocity, and the next frame decomposes it
   and damps it again at 6.5 sideways — so it has to be a good deal larger than
   the speed it is trying to produce. At 20 it settles around 3 m/s of drift
   back towards the road, which reads as the car leaning that way rather than
   being yanked. At 7 it moved the car two metres in five seconds, which is
   indistinguishable from not being there at all. */
const KERB_PULL = 20;
function drive(c, throttle, brake, steerIn, hand, dt) {
  /* AIRBORNE. Everything in this function below this line is about tyres on
     tarmac — grip, drag, the kerb pull, the off-road crawl — and there are no
     tyres on anything. body3d.js takes the whole step instead. */
  /* Returning the SAME SHAPE as the bottom of this function, because the caller
     reads it — `P.slip = v.vl` in game.js. A bare `return` here type-errored on
     the first frame of every jump, which is a crash you only meet once there is
     something to jump off. */
  if (TERRAIN && c.air) {
    flyCar(c, throttle, brake, steerIn, dt);
    const fc = Math.cos(c.h), fs = Math.sin(c.h);
    return { vf: c.vx * fc + c.vy * fs, vl: -c.vx * fs + c.vy * fc };
  }
  /* ON ITS ROOF. The controls are disconnected until it rights itself, and what
     is left is a car sliding on its own bodywork — which is the extra drag added
     below, not a separate model. */
  const flipped = TERRAIN && c.flip > 0;
  if (flipped) {
    c.flip -= dt;
    if (c.flip <= 0) c.flip = 0;
    throttle = false; brake = false; steerIn = 0; hand = false;
  }

  const cs = Math.cos(c.h), sn = Math.sin(c.h);
  // decompose velocity into forward / lateral against the car's heading
  let vf = c.vx * cs + c.vy * sn;
  let vl = -c.vx * sn + c.vy * cs;

  c.road = onRoad(c.x, c.y);
  /* THE ROAD IS THE GAME, unless you're a supporter. Off the tarmac the car
     drops to walking pace and leans back towards it. GHOST lifts that and the
     building collision with it — that pair is the whole perk.

     Three guards on this, and each one is load-bearing:
     · the player only. Traffic and police share drive(), and a cop that crawls
       the moment it leaves the road cannot follow you across a car park, which
       makes a five-star chase a farce. Same reason `hand` and the tyre-mark
       threshold are already player-only.
     · not while GHOST is on, obviously.
     · and only where we actually KNOW there is no road — see roadDataHere().
       Ground that simply hasn't streamed yet must stay fast, or this rebuilds
       the frontier-crawl bug by hand. */
  /* Where the nearest tarmac is, when it might matter. Computed once and used
     both to decide the penalty and to aim the kerb. */
  const maybeStray = c.kind === 'player' && !GHOST && !onTarmac(c.x, c.y) && roadDataHere(c.x, c.y);
  const near = maybeStray ? nearestRoadDir(c.x, c.y) : null;
  /* The tolerance is the important part. The mask is 8 m cells stamped along
     centrelines, and the roads are DRAWN from the same widths — but the two do
     not agree to the metre, and a single cell of disagreement used to be free
     and is now a car stopped dead on tarmac. Anything within a cell or so of
     paved ground is treated as on it. False negatives here cost nothing; false
     positives look like a broken game. */
  const stray = maybeStray && (!near || near.d > STRAY_TOL);
  const grip = c.road ? 1 : .58;
  // a wrecked car limps — the player's own top speed stays honest
  const wear = c.kind === 'player' ? 1 : lerp(.32, 1, clamp(c.hp / 100, 0, 1));
  const top = stray ? STRAY_TOP : c.maxSpeed * grip * wear;

  /* INERTIA. Nothing in a car happens the instant you ask for it: the engine
     takes a moment to come on song and a moment to fall off it, and the brakes
     bite rather than grab. Torque used to appear and vanish on the same frame as
     the button, which is what made the car feel like it was being dragged around
     rather than driven. These are first-order lags, so they cost one number each
     and the car still reaches exactly the same top speed. */
  c.gasT = c.gasT || 0; c.brakeT = c.brakeT || 0;
  c.gasT += ((throttle ? 1 : 0) - c.gasT) * decay(throttle ? 5.5 : 8, dt);
  c.brakeT += ((brake ? 1 : 0) - c.brakeT) * decay(brake ? 11 : 14, dt);

  // Constant engine force against linear drag, with a hard ceiling. The old model
  // faded the engine out as (1 - v/top) while drag kept pulling, so top speed was
  // an asymptote you could never actually reach — 46 m/s on paper, 38 in practice.
  if (c.gasT > .002) vf += c.accel * dt * c.gasT * (vf < 0 ? 2.2 : 1);
  if (c.brakeT > .002) vf -= (vf > .8 ? c.accel * 1.9 : c.accel * .55) * dt * c.brakeT;
  if (!throttle && !brake) vf -= vf * decay(.9, dt);                 // engine braking

  vf -= vf * decay(c.road ? .32 : stray ? STRAY_DRAG : 1.5, dt);   // drag / rough ground
  if (hand) vf -= vf * decay(.5, dt);        // a locked rear axle scrubs speed
  if (flipped) vf -= vf * decay(3.4, dt);    // bodywork on tarmac is not a tyre

  /* THE HILL. Gravity's component along the road: it takes speed away climbing
     and gives it back descending, which is the whole reason a hill is worth
     driving over rather than looking at. It applies with the engine off and at a
     standstill too, so leaving the car on a grade rolls it down one.

     The ceiling lifts downhill rather than staying put. Clamping a descent to
     the same top speed as the flat means the hill you can see is steep produces
     a speedometer that does not move, which reads as the slope not being
     modelled at all — and a fifth over, bled straight back off by drag at the
     bottom, is exactly what a real car does. */
  let topK = 1;
  if (TERRAIN) {
    const g = terrainGrad(c.x, c.y);
    const fall = -(g.gx * cs + g.gy * sn);     // positive when the ground drops ahead
    vf += fall * SLOPE_G * dt;
    topK += clamp(fall, 0, .35) * 1.2;
  }
  vf = clamp(vf, -top * .45, top * topK);                       // maxSpeed means maxSpeed

  /* Lateral grip: the handbrake lets the back end go, which is half of a drift.
     Through a committed 180 it is released almost entirely, so the car keeps the
     momentum it went in with and travels its original line while the nose comes
     round — that is the difference between a drift and a pirouette. */
  const lat = c.spin ? .3 : hand ? 1.7 : (c.road ? 9.5 : 6.5);
  vl -= vl * decay(lat, dt);

  const spd = Math.abs(vf);
  const rolling = clamp(spd / 4.5, 0, 1);      // nothing pivots from a standstill

  /* Steering normally fades with speed, down to a third of its authority. Held,
     it stops fading — the rear is unloaded, so the nose still bites — but it is
     deliberately NOT boosted beyond that: the 180 below is what comes round, and
     stacking a boost on top of it just means holding the button spins you like a
     top instead of giving you the half turn you asked for. What the handbrake
     buys you here is the slide, and the freedom to hold one through a bend. */
  const auth = hand ? .92 : lerp(1, .34, clamp(spd / 30, 0, 1));
  /* The wheels take a moment to come round, and a moment to straighten. This is
     what makes a car feel like it has a nose: steerIn went straight into the
     heading before, so the car changed direction on the exact frame you touched
     the key and snapped back the frame you let go. Faster to straighten than to
     turn, the way a real rack self-centres. c.steer was already on every car and
     had never been used for anything. */
  c.steer += (steerIn - c.steer) * decay(Math.abs(steerIn) > Math.abs(c.steer) ? 7 : 11, dt);
  const yaw = c.steer * c.turn * auth * rolling;

  /* Reversing inverts the steering — but a drift is not reversing. vf goes
     negative as the heading swings past 90° in a 180, and inverting there made
     the car rotate back and fight its own spin exactly halfway through it. */
  c.h += yaw * dt * (!hand && vf < -.5 ? -1 : 1);

  /* THE TURN. Once armed, the heading is driven straight to its target angle on
     a smoothstep — eased in and eased out, so it loads up, whips through the
     middle and settles rather than snapping to a stop. Driving the angle rather
     than applying a torque is what makes it land on the number exactly, every
     time, instead of depending on how long you happened to hold the button. */
  if (c.spin) {
    c.spin.t += dt;
    const u = clamp(c.spin.t / c.spin.secs, 0, 1);
    c.h = c.spin.from + c.spin.dir * c.spin.rad * (u * u * (3 - 2 * u));
    if (u >= 1) c.spin = null;
  }

  const cs2 = Math.cos(c.h), sn2 = Math.sin(c.h);
  c.vx = cs2 * vf - sn2 * vl;
  c.vy = sn2 * vf + cs2 * vl;

  /* The kerb: off the tarmac, lean back across towards it. Without this the
     crawl is just a car that has stopped working; with it, it reads as a car
     that wants the road. Nothing happens right at the edge, or the last metre
     turns into a magnet that fights you trying to park. */
  /* The kerb applies over the whole of the off-tarmac range, not just past the
     tolerance — the tolerance is there to stop the car being PUNISHED for a
     metre of disagreement between the mask and the drawn road, not to carve out
     a band where it drifts into a field with nothing pulling it back. It fades
     in with distance so it is nothing at the edge, where it would otherwise
     fight you trying to park, and full strength by the time the crawl starts. */
  if (maybeStray && near) {
    const k = KERB_PULL * clamp((near.d - 4) / 10, 0, 1);
    c.vx += near.x * k * dt; c.vy += near.y * k * dt;
  }

  c.x += c.vx * dt; c.y += c.vy * dt;

  /* And now the vertical half of the step: what height the wheels are at, which
     way the body is leaning, and whether that last crest just launched it. */
  if (TERRAIN) groundCar(c, throttle, brake, dt);

  /* Tyre lines. The old threshold wanted 5.5 m/s of lateral slip — more than the
     old handbrake could ever produce, so a drift laid no rubber at all. Held, the
     rear is being dragged from the moment the tail steps out, so it marks; and a
     committed 180 marks for its whole arc regardless, because that arc IS the
     manoeuvre and it should be there on the road behind you afterwards. */
  /* Traffic and police keep the old, much higher slip threshold. Dropping it to
     2.6 for everyone meant a five-star scrum had thirty cars laying rubber at
     once, which filled the buffer with other people's skids and cost half the
     frame rate. Your own drift is the thing worth drawing. */
  const slipMark = c.kind === 'player' ? 2.6 : 5.5;
  if ((c.spin || (spd > 3 && ((hand && c.kind === 'player') || Math.abs(vl) > slipMark))) &&
      marks.length < MAX_MARKS) {
    marks.push({ x: c.x, y: c.y, h: c.h, w: c.w, life: MARK_LIFE });
    // rubber smoke off the rear, drifting out along the slide
    if (c.kind === 'player' && parts.length < 300 && Math.random() < .42) {
      const life = rand(.55, 1.15);
      parts.push({ x: c.x - Math.cos(c.h) * c.l * .4 + rand(-.7, .7),
                   y: c.y - Math.sin(c.h) * c.l * .4 + rand(-.7, .7),
                   vx: -Math.sin(c.h) * vl * .1 + rand(-1, 1),
                   vy: Math.cos(c.h) * vl * .1 + rand(-1, 1),
                   life, life0: life, r: rand(.55, 1.1), soft: true, col: '#cdc6d6' });
    }
  }
  return { vf, vl };
}

/* Keep entities inside the fetched patch of world. Returns whether it actually
   had to clamp, because being held here is indistinguishable from being broken:
   the throttle is down, the speedo reads walking pace, and there is nothing in
   front of the car to explain it. The caller says so out loud. */
function fence(c) {
  const m = 25;
  let hit = false;
  if (c.x < W.minX + m) { c.x = W.minX + m; c.vx = Math.abs(c.vx) * .3; hit = true; }
  if (c.x > W.maxX - m) { c.x = W.maxX - m; c.vx = -Math.abs(c.vx) * .3; hit = true; }
  if (c.y < W.minY + m) { c.y = W.minY + m; c.vy = Math.abs(c.vy) * .3; hit = true; }
  if (c.y > W.maxY - m) { c.y = W.maxY - m; c.vy = -Math.abs(c.vy) * .3; hit = true; }
  return hit;
}

/* Is this spot inside a building you would actually hit? Bucketed, so it costs a
   couple of point tests — the drive-through landmarks and archways don't count,
   since driving into one of those is the whole idea. */
function solidAt(x, y) {
  const arr = W.buckets.get(Math.floor(x / W.bcell) + ',' + Math.floor(y / W.bcell));
  if (!arr) return false;
  for (const bi of arr) {
    const b = W.buildings[bi];
    if (b && !b.passable && pointInPoly(b.pts, x, y)) return true;
  }
  return false;
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nearestEdge(pts, x, y) {
  let bx = 0, by = 0, bd = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j].x, ay = pts[j].y, ex = pts[i].x - ax, ey = pts[i].y - ay;
    const L = ex * ex + ey * ey || 1e-6;
    let t = ((x - ax) * ex + (y - ay) * ey) / L; t = clamp(t, 0, 1);
    const px = ax + ex * t, py = ay + ey * t;
    const d = dist2(px, py, x, y);
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return { x: bx, y: by, d: Math.sqrt(bd) };
}

function buildingCollide(c) {
  const k0x = Math.floor((c.x - 3) / W.bcell), k1x = Math.floor((c.x + 3) / W.bcell);
  const k0y = Math.floor((c.y - 3) / W.bcell), k1y = Math.floor((c.y + 3) / W.bcell);
  for (let kx = k0x; kx <= k1x; kx++) for (let ky = k0y; ky <= k1y; ky++) {
    const arr = W.buckets.get(kx + ',' + ky); if (!arr) continue;
    for (const bi of arr) {
      const b = W.buildings[bi];
      // solidAt() a few lines up already guards this and this did not, which is
      // the sort of difference that stays invisible until something empties
      // W.buildings without clearing the hash — and then it throws once per
      // bucket per frame, from inside the physics loop
      if (!b || b.passable) continue;   // a road runs through it: tunnel or archway
      if (c.x < b.bb.x0 - 2 || c.x > b.bb.x1 + 2 || c.y < b.bb.y0 - 2 || c.y > b.bb.y1 + 2) continue;
      if (!pointInPoly(b.pts, c.x, c.y)) continue;

      const e = nearestEdge(b.pts, c.x, c.y);
      // n points from the wall towards the car — and the car is inside, so n aims
      // deeper into the building. Stepping back along it puts us out on the street.
      let nx = c.x - e.x, ny = c.y - e.y;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      c.x = e.x - nx * (c.l * .5); c.y = e.y - ny * (c.l * .5);
      const into = c.vx * nx + c.vy * ny;     // closing speed along the inward normal
      if (into > 0) {
        c.vx -= nx * into * 1.5; c.vy -= ny * into * 1.5;   // cancel it, plus a bounce
        return into;
      }
      return 0;
    }
  }
  return 0;
}

/* Impact speed into health lost. Gentle nudges are ignored, or cars idling into
   each other in slow traffic would grind themselves to death. The short cooldown
   is because updateTraffic visits each pair twice a frame. */
function damageCar(c, rel) {
  if (!c || c.dead || rel < 5.5 || c.hitCd > 0) return 0;
  const dmg = clamp((rel - 5.5) * 1.5, 0, 60);
  c.hp -= dmg;
  c.hitCd = .35;
  return dmg;
}

/* Orange going-up-in-flames, plus a blast that hurts whatever is stood too close.
   Nothing in here explodes anything directly: it only deals damage, and the normal
   per-frame health check turns any neighbour it flattens into its own explosion on
   the next frame. That's what makes chains work without recursion. */
function explode(x, y) {
  blasts.push({ x, y, r: 3, life: .55, max: 16 });
  for (let i = 0; i < 26; i++) {
    const a = rand(0, TAU), s = rand(4, 30);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(.35, 1.1), r: rand(.3, 1.1),
      col: pick(['#ff8a2a', '#ff7418', '#ffa347', '#ff5a1f', '#ff9130', '#ffd06a']) });
  }
  for (let i = 0; i < 10; i++) {      // smoke, slower and darker
    const a = rand(0, TAU), s = rand(1, 7);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(.8, 1.8), r: rand(.8, 2), col: '#4a4048' });
  }
  SFX.boom(earshot(x, y));
  cam.shake = Math.min(1, cam.shake + clamp(90 / (10 + dist(x, y, P.car.x, P.car.y)), 0, .8));

  // the blast itself — everything nearby, the player included
  const R = 15;
  for (const o of traffic) hurtByBlast(o, x, y, R);
  for (const o of cops) hurtByBlast(o, x, y, R);
  const pd = dist(P.car.x, P.car.y, x, y);
  if (pd < R && !P.dead) {
    P.car.hp -= (1 - pd / R) * 45;
    if (P.car.hp <= 0) { P.car.hp = 0; wasted(); }
  }
}
function hurtByBlast(o, x, y, R) {
  if (o.dead) return;
  const d = dist(o.x, o.y, x, y);
  if (d < R) o.hp -= (1 - d / R) * 55;
}

// wrecked cars burn; a wisp now and then so the speed drop reads as damage
function smoke(c) {
  parts.push({ x: c.x + rand(-1, 1), y: c.y + rand(-1, 1), vx: rand(-1.5, 1.5), vy: rand(-1.5, 1.5),
    life: rand(.5, 1.1), r: rand(.35, .8), col: c.hp < 22 ? '#3a3238' : '#565060' });
}

// Health hit zero: blow it up and let the list filters drop it.
let WRECKS = 0;                           // how many cars have gone up, ever
function wreck(c) {
  if (c.dead) return;
  c.dead = true;
  WRECKS++;
  explode(c.x, c.y);
}

// One place that decides whether a car is still with us, run once per car per frame.
function checkWreck(c, dt) {
  c.hitCd -= dt;
  if (c.dead) return;
  if (c.hp <= 0) { wreck(c); return; }
  if (c.hp < 45) { c.smokeT = (c.smokeT || 0) - dt; if (c.smokeT <= 0) { c.smokeT = rand(.05, .18); smoke(c); } }
}

/* Two cars pushed apart, and the momentum swapped between them.

   MASS is what stops you getting pinned. The exchange used to be symmetric, so
   driving into a stopped car you gained accel*dt each frame and gave 0.78 of the
   closing speed straight back — that settles at a crawl and holds there, which
   is being stuck behind a car you ought to be able to shove aside. Traffic
   panic-brakes near a wanted player, so it is often stopped dead in the way.
   The player is simply heavier: it keeps most of its speed and the other car
   takes the shove. Between two AI cars the masses are equal and this is exactly
   the old behaviour. */
const massOf = c => c.kind === 'player' ? 3 : c.kind === 'cop' ? 1.35 : 1;
function carsCollide(a, b) {
  const rr = (a.l + b.l) * .34;
  const d = dist(a.x, a.y, b.x, b.y);
  if (d > rr || d < .001) return 0;
  const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
  const ia = 1 / massOf(a), ib = 1 / massOf(b), inv = ia + ib;
  // the lighter car is moved further out of the overlap
  const over = rr - d;
  a.x -= nx * over * (ia / inv); a.y -= ny * over * (ia / inv);
  b.x += nx * over * (ib / inv); b.y += ny * over * (ib / inv);
  const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rel <= 0) return 0;
  // 1.56 keeps equal-mass impacts identical to the old flat .78
  const j = rel * 1.56 / inv;
  a.vx -= nx * j * ia; a.vy -= ny * j * ia;
  b.vx += nx * j * ib; b.vy += ny * j * ib;
  return rel;
}
