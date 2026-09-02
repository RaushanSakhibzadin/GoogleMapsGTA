/* PEOPLE ON THE GROUND.
 *
 * Two things were asked for together, and they are the same thing underneath:
 * the casualty an ambulance is sent to should be lying down, because they are
 * ill, and a pedestrian a car hits should end up lying down too — "you can add
 * some flying".
 *
 * So there is one pose and two ways into it. p.lie is how far a person has gone
 * over about their own lateral axis: 0 on their feet, PI/2 flat out. The
 * casualty starts there; somebody a car hits is put there by the impact, over a
 * second or so, and if they were hit hard enough they go through the air on the
 * way.
 *
 * MEASURED ON THE GEOMETRY, not on a screenshot. pushPerson writes the six
 * boxes the renderer is handed, so the figure's real extents can be read
 * straight out of the buffer — how tall it is, how long it is, how far off the
 * ground. A person lying down is 1.7 m long and a quarter of a metre tall, and
 * a person standing up is the other way round; no picture is needed to tell
 * those apart, and a number cannot be wrong about it the way an eye can.
 *
 * Usage: node tests/knockdown.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text()))
    errs.push('console: ' + m.text());
});
// offline, on the bundled city: real pavements, no network
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};

/* The extents of the figure the renderer would draw, in metres: how far it
   reaches along its own facing, across it, and up from the ground it stands on.
   Reading the buffer means this measures what is DRAWN rather than what the
   state says, which is the whole point — p.lie could be set correctly and
   ignored by the shader and nothing else here would notice. */
const SHAPE = `q => {
  const a = [];
  pushPerson(a, q);
  const n = a.length / LIT_FLOATS;
  const ch = Math.cos(q.h), sh = Math.sin(q.h);
  let f0 = 1e9, f1 = -1e9, s0 = 1e9, s1 = -1e9, u0 = 1e9, u1 = -1e9;
  const g = terrainH(q.x, q.y);
  for (let i = 0; i < n; i++) {
    const dx = a[i * LIT_FLOATS] - q.x, dz = a[i * LIT_FLOATS + 2] - q.y;
    const u = a[i * LIT_FLOATS + 1] - g;
    const f = dx * ch + dz * sh, s = -dx * sh + dz * ch;
    if (f < f0) f0 = f; if (f > f1) f1 = f;
    if (s < s0) s0 = s; if (s > s1) s1 = s;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
  }
  return { long: +(f1 - f0).toFixed(2), across: +(s1 - s0).toFixed(2),
           tall: +(u1 - u0).toFixed(2), foot: +u0.toFixed(2), top: +u1.toFixed(2) };
}`;

/* ---------- 1. upright, halfway over, and flat ---------- */
out.poses = await p.evaluate(src => {
  const shape = eval('(' + src + ')');
  const q = makePed(P.car.x + 30, P.car.y + 30, null, 0, 1, 1);
  q.h = 0.7; q.step = 0;
  const r = {};
  for (const [name, lie] of [['standing', 0], ['falling', Math.PI / 4], ['flat', Math.PI / 2]]) {
    q.lie = lie; q.pz = 0;
    r[name] = shape(q);
  }
  // and one in the air, which must be the same body simply higher up
  q.lie = Math.PI / 2; q.pz = 0.9;
  r.airborne = shape(q);
  return r;
}, SHAPE);
/* A PERSON IS 1.74 M AND DOES NOT CHANGE SIZE BY FALLING OVER. Standing, they
   are tall and take up almost no ground; flat, they are as long as they were
   tall and about a torso thick. The falling pose has to be between the two and
   not equal to either, which is what says it is an angle being applied rather
   than a flag being flipped.
   The FOOT is the assertion that catches the mistake this is most likely to
   make: rotate a body about its hips and leave the axis at hip height and it
   lies flat a metre in the air. */
out.standsUp = out.poses.standing.tall > 1.65 && out.poses.standing.tall < 1.85 &&
               out.poses.standing.long < 0.7 && out.poses.standing.foot < 0.02;
out.liesDown = out.poses.flat.long > 1.5 && out.poses.flat.tall < 0.45 &&
               out.poses.flat.foot >= 0 && out.poses.flat.foot < 0.1;
/* AND NOTHING GOES THROUGH THE PAVEMENT ON THE WAY DOWN, which is the mistake
   the middle of the arc invites: pivot a body at its hips, take the axis
   straight from hip height to lying height, and halfway over the legs sweep a
   third of a metre below the road. Measured at -0.32 before the axis was
   weighted by the angle instead. */
out.fallsOver = out.poses.falling.tall < out.poses.standing.tall - 0.3 &&
                out.poses.falling.tall > out.poses.flat.tall + 0.1 &&
                out.poses.falling.long > out.poses.standing.long + 0.2 &&
                out.poses.falling.foot > -0.03;
out.fliesLevel = Math.abs(out.poses.airborne.tall - out.poses.flat.tall) < 0.02 &&
                 Math.abs(out.poses.airborne.foot - out.poses.flat.foot - 0.9) < 0.02;

/* ---------- 2. the sick one is already down ---------- */
/* The point of the ambulance shift is somebody who cannot stand up, and a
   casualty standing on the pavement waiting for a lift is the thing this is
   for. Taken through the real generator, not by setting a flag. */
out.casualty = await p.evaluate(async src => {
  const shape = eval('(' + src + ')');
  window.__takeJob('courier');
  window.__takeJob('ambulance');
  await new Promise(r => setTimeout(r, 950));
  if (!MISSION.fare) return { skipped: 'no casualty' };
  const q = MISSION.fare;
  return { hurt: q.hurt, lie: +(q.lie || 0).toFixed(2), struck: q.struck || 0,
           shape: shape(q) };
}, SHAPE);
out.theSickLieDown = !!out.casualty.skipped ||
  (out.casualty.hurt === 'down' && Math.abs(out.casualty.lie - Math.PI / 2) < 0.01 &&
   out.casualty.shape.tall < 0.45 && out.casualty.shape.long > 1.5);

/* ---------- 3. hit slowly: knocked over where they stand ---------- */
/* Two speeds, because the ask was for both — down, and sometimes thrown. The
   car is driven through them rather than the state being set, so what is under
   test is the collision and not a function called by hand. */
const RUNOVER = `async (spd) => {
  /* A PERSON WITH ROOM BEHIND THEM. The first pedestrian on the list is often
     standing on a pavement laid over a building footprint — real Belgrade has
     plenty of those — and the two metres of road this test needs are inside the
     wall. Placing the car there put it inside the building, the collision pass
     ejected it sideways on the first frame, and it then drove AWAY from the
     person it was aimed at: struck false, nothing moved, no clue why.

     So the approach lane is checked before it is used. solidAt is the same test
     walkPed uses to keep people out of walls, which is the right one: it asks
     the buildings, not the drivable mask, and a car can sit on a verge. */
  const clear = (x, y) => typeof solidAt !== 'function' || !solidAt(x, y);
  const q = peds.find(o => !o.dead && !o.struck && o !== MISSION.fare &&
                           clear(o.x, o.y) && clear(o.x - 2, o.y) &&
                           clear(o.x - 5, o.y) && clear(o.x - 8, o.y));
  if (!q) return null;
  /* AND NOTHING RAMMING YOU WHILE YOU DO IT. Every run of this hands out a
     wanted star, so by the second one there is a squad car in the mirror; one
     of them shunting the player mid-approach is not what is under test. */
  P.wanted = 0; cops.length = 0;
  const from = { x: q.x, y: q.y };
  /* TWO METRES, NOT TWO POINT TWO. The contact test is dist2 < 5, which is
     2.24 m, so starting inside it means the hit lands on the first frame at
     whatever speed is asked for, and the report cannot come out different on a
     slow machine than on a fast one. (The hit itself does not need the help:
     the contact test runs inside the fixed 1/60 step, so even a car at 22 m/s
     covers 0.37 m between two of them and cannot be stepped past.) */
  P.car.x = q.x - 2.0; P.car.y = q.y; P.car.h = 0;
  let peak = 0, held = 0, after = 0;
  for (let i = 0; i < 300; i++) {
    if (!q.struck) { P.car.vx = spd; P.car.vy = 0; }
    await new Promise(r => requestAnimationFrame(r));
    if (q.struck) { peak = Math.max(peak, q.pz || 0); after++; }
    if (after > 170) break;
  }
  return { struck: !!q.struck, dead: !!q.dead, hurt: q.hurt,
           lie: +(q.lie || 0).toFixed(2), rest: +(q.pz || 0).toFixed(3),
           peak: +peak.toFixed(2),
           thrown: +Math.hypot(q.x - from.x, q.y - from.y).toFixed(2),
           downT: +(q.downT || 0).toFixed(1), listed: peds.indexOf(q) >= 0 };
}`;
out.shove = await p.evaluate(src => eval('(' + src + ')')(6), RUNOVER);
out.hurl = await p.evaluate(src => eval('(' + src + ')')(22), RUNOVER);
/* KNOCKED DOWN AND STILL THERE. The second half is the change: this used to set
   p.dead on contact, so a pedestrian hit at forty vanished between one frame
   and the next along with any evidence of it. */
out.slowKnocksDown = !!out.shove && out.shove.struck && !out.shove.dead &&
                     out.shove.listed && out.shove.hurt === 'down' &&
                     Math.abs(out.shove.lie - Math.PI / 2) < 0.01 &&
                     out.shove.peak === 0 && out.shove.thrown < 1.5;
/* AND A FAST ONE FLIES. Half a metre of air and a couple of metres down the
   road: measured at 22 m/s it clears 0.8 and travels five. What fails here is a
   throw that never leaves the ground, and — the other way — a body that is
   still in the air when the clock runs out, because it never came down. */
out.fastThrows = !!out.hurl && out.hurl.struck && !out.hurl.dead &&
                 out.hurl.peak > 0.45 && out.hurl.thrown > 2 &&
                 out.hurl.rest === 0 && Math.abs(out.hurl.lie - Math.PI / 2) < 0.01;

/* ---------- 4. and the street clears itself ---------- */
/* A body that lies there for ever is a memory leak with a shirt on. They go on
   the same timer everything else does — checked by winding it down rather than
   by waiting twenty-two seconds for it. */
out.cleared = await p.evaluate(async () => {
  const q = peds.find(o => o.struck && !o.dead);
  if (!q) return { skipped: 'nobody down' };
  q.downT = 0.05;
  for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
  return { dead: !!q.dead, listed: peds.indexOf(q) >= 0 };
});
out.bodiesAreCulled = !!out.cleared.skipped || (out.cleared.dead && !out.cleared.listed);

out.errs = errs.slice(0, 5);
out.pass = out.standsUp && out.liesDown && out.fallsOver && out.fliesLevel &&
           out.theSickLieDown && out.slowKnocksDown && out.fastThrows &&
           out.bodiesAreCulled && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
