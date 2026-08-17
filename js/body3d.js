"use strict";
/* VICE MAPS — The car stops being a dot: a cuboid that rides the grade, leaves
   the ground over a crest, and lands on its roof if you get it wrong.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes before
   entities.js, whose drive() calls into it.

   WHAT WAS THERE BEFORE. A car was x, y, heading, and two components of
   velocity. No height, no attitude, nothing above the road. Top-down that is not
   a simplification, it is the correct model — you cannot see a jump from
   directly overhead, and a rolled car and an upright one are the same rectangle.

   From behind the car, all of that becomes visible at once, so all of it has to
   exist. The body here is a rigid cuboid with a height, a pitch and a roll. On
   the ground the wheels ride the terrain and the attitude follows the surface
   plus whatever the suspension is doing; off a crest it is a projectile that
   keeps the momentum it left with; landing crooked tips it over.

   WHAT IS DELIBERATELY NOT HERE. Real rigid-body dynamics — an inertia tensor,
   torque from four contact patches, a solver. That would replace drive(), which
   is a tuned arcade model that took several rounds to get right and which the
   whole game is balanced against. This sits on top of it instead: drive() still
   owns where the car goes on the map, and this owns where it is in the air and
   which way up. The two only meet at three points, all of them marked in
   entities.js.

   AND IT IS ALL OFF IN 2D. Every function here returns immediately unless
   TERRAIN is set, which happens only when the 3D view is on. */

/* Gravity, a little above the real number. At 9.81 a car leaving a crest at
   200 km/h hangs for two and a half seconds and travels 140 metres, which is not
   a jump, it is a flight; at 11 the same launch is under two seconds and lands
   where you can still see it.

   It is deliberately not much higher than that, because this number is not only
   the arc — it is also the THRESHOLD. A car leaves the ground exactly when
   following the ground would need more downward acceleration than gravity can
   supply, so a heavier gravity is a car that is harder to launch. 18 was the
   first value here and nothing on any terrain ever got airborne under it. */
const GRAV = 11;
/* Gravity for the GRADE, kept separate and also above real. At 9.81 the steepest
   hill this terrain makes is worth 1.6 m/s² against an engine that pulls 40 —
   true to life, and completely imperceptible. At 11 a long climb costs you
   noticeable speed and a descent gives it back. */
const SLOPE_G = 11;
const AIR_SPIN = 3.2;               // rad/s ceiling on a tumble, so it stays readable
const FLIP_SECS = 2.4;              // how long you lie on your roof before it rights you
const LAND_HARD = 9;                // m/s of descent before a landing costs armour
const LAUNCH_MIN = 9;               // below this speed a crest is a bump, not a ramp

/* Back into (-π, π]. Roll is an accumulator — a barrel roll in the air adds to it
   turn after turn, which is what makes counting rotations possible — so on the
   ground it has to be brought back, or it walks off to several multiples of π and
   every later comparison is against a number that is no longer an angle. It is
   also why a car recovering from its roof used to right itself the LONG way
   round: at exactly π the shortest way back is a coin toss, and it kept picking
   the one that added another half turn. */
function wrapAng(a) {
  a = (a + Math.PI) % TAU;
  return (a < 0 ? a + TAU : a) - Math.PI;
}

/* The car's own axes in world terms. Forward is the heading; lateral is a
   quarter turn from it. Which of those is "left" is a rendering question and the
   renderer answers it the same way, so physics and picture agree by
   construction rather than by a comment. */
function carAxes(c) {
  const f = Math.cos(c.h), s = Math.sin(c.h);
  return { fx: f, fy: s, lx: -s, ly: f };
}

/* The attitude the ground under the car is asking for. */
function groundAttitude(c, g) {
  const a = carAxes(c);
  return {
    pitch: Math.atan(g.gx * a.fx + g.gy * a.fy),      // nose up on a climb
    roll:  Math.atan(g.gx * a.lx + g.gy * a.ly)       // lateral side up where it rises
  };
}

/* ON THE GROUND. Called after drive() has moved the car, and responsible for
   everything vertical: what height the wheels are at, which way the body is
   tilted, and whether the ground just fell out from under it. */
function groundCar(c, throttle, brake, dt) {
  if (!TERRAIN) return;
  const g = terrainGrad(c.x, c.y);
  const gz = g.h;

  /* A car that has just been placed — a respawn, a new city, a test teleport —
     has a z from wherever it used to be. Snap rather than launch it: without
     this, being rescued to a garage on the other side of a valley reads as being
     fired out of a cannon. */
  if (c.z === undefined || Math.abs(c.z - gz) > 40) {
    c.z = gz; c.vz = 0; c.air = false; c.climb = 0; c.gz = gz;
    c.rise = 0; c.pv = c.rv = 0;
  }

  // how fast the ground under the car is rising, and how fast THAT is changing
  const rise = dt > 0 ? (gz - c.gz) / dt : 0;
  const need = dt > 0 ? (rise - (c.rise || 0)) / dt : 0;
  c.gz = gz;
  c.rise = rise;
  c.climb += (rise - c.climb) * decay(16, dt);

  /* THE CREST, stated the way it actually works.

     Glued to the ground, a car's vertical acceleration is whatever the ground's
     shape demands — v² times the curvature under it. Gravity is the only thing
     pulling it down, so the moment the ground needs to accelerate the car
     downwards harder than gravity can, the tyres stop touching. That is the
     whole condition, and `need` is that demanded acceleration measured directly
     off the last two frames of ground height.

     Stating it this way rather than as "is the car higher than the road" is what
     makes speed the thing that decides. The same crest is a bump you feel at
     fifty and a ramp at three hundred, without a single speed-dependent constant
     anywhere — because v² is already in the measurement. The earlier version
     compared predicted height against ground height with a fixed 22 cm
     threshold, which is not a physical quantity at all: it needed the ground to
     drop 13 metres a second faster than the car was climbing, and nothing on any
     terrain this generates has ever done that at any speed.

     The speed floor is still there, because at walking pace the same geometry is
     a kerb and a car hopping out of a driveway is a bug. */
  if (!c.air && need < -GRAV && Math.hypot(c.vx, c.vy) > LAUNCH_MIN) {
    c.air = true;
    c.z = gz;
    c.vz = Math.max(rise, 0.4);          // it leaves along the ramp, not off it
    // and keeps rotating the way the ramp was turning it
    c.pv = clamp(-c.climb * 0.10, -1.1, 1.1);
    c.rv = 0;
    return;
  }

  c.z = gz;
  c.vz = 0;

  const t = groundAttitude(c, g);
  let tp = t.pitch, tr = t.roll;

  if (c.flip > 0) {
    // upside down, and staying there until the timer runs out
    tr = (c.roll >= 0 ? 1 : -1) * Math.PI;
    tp = 0;
  } else {
    /* Load transfer. The nose dives under braking and lifts under power, and the
       body leans out of a corner — read straight off the controls rather than
       differentiated out of the velocity, because a derivative of a number that
       is already smoothed is mostly noise. */
    tp += ((c.gasT || 0) - (c.brakeT || 0)) * 0.045;
    const spd = Math.hypot(c.vx, c.vy);
    tr += c.steer * clamp(spd / 28, 0, 1) * 0.10;
  }
  const k = decay(c.flip > 0 ? 5 : 9, dt);
  c.pitch = wrapAng(c.pitch + angDiff(c.pitch, tp) * k);
  c.roll  = wrapAng(c.roll + angDiff(c.roll, tr) * k);
  c.pv = c.rv = 0;
}

/* IN THE AIR. drive() hands over entirely: no grip, no drag against the road, no
   kerb, no off-road penalty — none of those are about a car that is not touching
   anything. What is left is a projectile with attitude. */
function flyCar(c, throttle, brake, steerIn, dt) {
  c.vz -= GRAV * dt;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.z += c.vz * dt;

  /* AIR CONTROL, for the player only. Brake pulls the nose up, throttle pushes
     it down and steering rolls the car — the arrangement every game that has
     ever had a jump in it uses, because it is the one people already know. It
     does nothing to where the car is going: the momentum is fixed the moment it
     leaves the ground, and this only decides which way up it arrives. */
  if (c.kind === 'player') {
    c.pv += ((brake ? 1 : 0) - (throttle ? 1 : 0)) * 2.6 * dt;
    c.rv += steerIn * 3.4 * dt;
  }
  c.pv = clamp(c.pv, -AIR_SPIN, AIR_SPIN);
  c.rv = clamp(c.rv, -AIR_SPIN, AIR_SPIN);
  c.pitch += c.pv * dt;
  c.roll += c.rv * dt;

  // a little drag, so a long jump doesn't arrive faster than it left
  const d = decay(.12, dt);
  c.vx -= c.vx * d; c.vy -= c.vy * d;
  c.road = false;

  const gz = terrainH(c.x, c.y);
  c.gz = gz;
  if (c.z <= gz) landCar(c, gz);
}

/* THE LANDING. What it costs depends on how far it fell and how badly the body
   disagreed with the ground it hit. */
function landCar(c, gz) {
  const drop = -c.vz;
  // resync the ground tracker, or the frame after touchdown sees the whole
  // height of the jump as one frame's worth of ground movement and launches again
  c.z = gz; c.air = false; c.vz = 0; c.climb = 0; c.gz = gz; c.rise = 0;

  const t = groundAttitude(c, terrainGrad(c.x, c.y));
  const dr = Math.abs(angDiff(c.roll, t.roll));
  const dp = Math.abs(angDiff(c.pitch, t.pitch));

  /* Crooked enough and it goes over. Two ways to qualify: the body is a long way
     from the surface it landed on, or it is simply past its side already — a
     barrel roll that has gone three quarters of the way round lands on its roof
     however flat the ground is. */
  c.roll = wrapAng(c.roll);
  c.pitch = wrapAng(c.pitch);
  if (dr > 1.0 || Math.abs(c.roll) > 1.15) {
    c.flip = FLIP_SECS;
    /* Just short of a half turn, not exactly one. At exactly π the shortest way
       back upright is undefined and the recovery picks a side at random — which
       showed up as a car that righted itself by rolling on round through another
       half turn. A tenth of a radian off reads identically and decides it. */
    c.roll = (c.roll >= 0 ? 1 : -1) * (Math.PI - 0.12);
  }
  c.pv = c.rv = 0;

  /* Speed goes into the ground, not into the next corner. A flat landing keeps
     almost everything; a nose-first or sideways one keeps a third. */
  const scrub = clamp(1 - (drop * .012 + dr * .18 + dp * .10), .35, 1);
  c.vx *= scrub; c.vy *= scrub;

  if (drop > LAND_HARD) damageCar(c, (drop - LAND_HARD) * 1.6);
  if (c.kind === 'player') {
    if (drop > 5) cam.shake = Math.min(1, cam.shake + clamp(drop / 26, 0, .7));
    if (c.flip > 0) toast('FLIPPED', 1400);
  }
}

/* The eight corners of the cuboid, in world metres with height. The renderer
   draws them and anything that wants to know where the car's body actually is —
   as opposed to where its centre point is — asks for them.

   Order is the standard unit-cube winding: 0-3 are the underside going round,
   4-7 the roof directly above each. */
function carBox(c, out) {
  const a = carAxes(c);
  const pitch = c.pitch || 0, roll = c.roll || 0;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // forward, tilted nose-up by pitch
  const Fx = a.fx * cp, Fy = sp, Fz = a.fy * cp;
  // the un-rolled up vector, then rolled about forward
  const Ux0 = -a.fx * sp, Uy0 = cp, Uz0 = -a.fy * sp;
  const Lx = a.lx * cr + Ux0 * sr, Ly = Uy0 * sr, Lz = a.ly * cr + Uz0 * sr;
  const Ux = Ux0 * cr - a.lx * sr, Uy = Uy0 * cr, Uz = Uz0 * cr - a.ly * sr;

  const hl = c.l * .5, hw = c.w * .5, hh = (c.bh || 1.45) * .5;
  // the centre of the body sits half its height above the contact point
  const ox = c.x + Ux * hh, oy = (c.z || 0) + Uy * hh, oz = c.y + Uz * hh;
  const o = out || [];
  let n = 0;
  for (const uy of [-1, 1]) for (const [f, l] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    o[n++] = ox + Fx * hl * f + Lx * hw * l + Ux * hh * uy;
    o[n++] = oy + Fy * hl * f + Ly * hw * l + Uy * hh * uy;
    o[n++] = oz + Fz * hl * f + Lz * hw * l + Uz * hh * uy;
  }
  return o;
}
