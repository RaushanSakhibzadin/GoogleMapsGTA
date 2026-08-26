/* PEOPLE, ON PAVEMENTS.
 *
 * A pedestrian used to be one box — 0.64 m square, 1.7 m tall, in one of the six
 * fluorescent colours the cars are painted — doing a random walk. Both halves of
 * that were wrong in the same way: they were furniture that moved.
 *
 * THE WALK. The old one picked a heading, turned by a random amount every few
 * seconds, and reversed only if a step took it from off-road to on-road. That
 * rule does nothing about the case that actually happens, which is a walk
 * drifting steadily away from any street at all — after a minute the city had
 * people standing in car parks, inside courtyards, and out in open ground facing
 * nothing. They are bound to a way now, exactly as traffic is, at an offset of
 * the carriageway's half width plus a metre and a half.
 *
 * MEASURED AGAINST THE OLD WALK RATHER THAN AGAINST A NUMBER. The old algorithm
 * is short enough to run here, from the same starting positions, for the same
 * simulated minute — so "they stay on the pavement" is a comparison with what
 * they used to do rather than a threshold I picked after seeing the answer.
 *
 * AND THE MODEL. Six boxes and a stride, so a street is people rather than
 * bollards. Asserted on the geometry that reaches the renderer — a head narrower
 * than its shoulders, legs that are apart when the stride says they should be —
 * because a screenshot cannot fail a build.
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
await p.waitForTimeout(1200);

const out = {};

/* How far a point is from the nearest DRIVABLE carriageway, and how wide that
   carriageway is. Geometry, not the drivable mask: the mask is an 8 m grid, so
   it cannot tell a pavement from the lane beside it — every pedestrian in the
   game reports as "on road" through it, and always did. */
const MEASURE = `(x, y, only) => {
  let bd = Infinity, bw = 0;
  for (const r of (only ? [only] : W.driveRoads)) {
    if (!r.drive) continue;
    if (x < r.bb.x0 - 60 || x > r.bb.x1 + 60 || y < r.bb.y0 - 60 || y > r.bb.y1 + 60) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const ex = b.x - a.x, ey = b.y - a.y;
      const L = ex * ex + ey * ey || 1e-6;
      let t = ((x - a.x) * ex + (y - a.y) * ey) / L;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a.x + ex * t - x, a.y + ey * t - y);
      if (d < bd) { bd = d; bw = r.w; }
    }
  }
  return { d: bd, w: bw };
}`;

/* WALK THEM, AND WATCH THE WHOLE WALK.

   This used to wait sixty seconds and then look once. Thirty-four pedestrians at
   one instant is a sample of thirty-four, and the thing being looked for happens
   to about one of them at a time, at a corner, for a second or so — so the
   reading was a coin flip: the same build answered "nobody in the road" twice
   and "one of them 0.74 m in" the third time, and neither answer was about the
   code. Sampling every sixth frame across the minute turns a boolean that flaps
   into a rate that does not: how much of all the pedestrian-time in the city is
   spent in a carriageway, and how far in it ever got. */
const walkFor = (secs, src) => p.evaluate(async ([s, source]) => {
  const measure = eval('(' + source + ')');
  const seen = { frames: 0, samples: 0, onTarmac: 0, worst: Infinity };
  await new Promise(res => {
    const t0 = window.__simT();
    const tick = () => {
      if (seen.frames++ % 6 === 0) {
        for (const q of peds) {
          if (q.dead || !q.road) continue;
          const own = measure(q.x, q.y, q.road);
          const off = own.d - own.w / 2;
          seen.samples++;
          if (off < -0.5) seen.onTarmac++;
          if (off < seen.worst) seen.worst = off;
        }
      }
      window.__simT() - t0 < s ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  return { samples: seen.samples,
           onTarmac: seen.onTarmac,
           rate: seen.samples ? +(seen.onTarmac / seen.samples).toFixed(4) : null,
           worst: isFinite(seen.worst) ? +seen.worst.toFixed(2) : null };
}, [secs, src]);

/* ---- 1. where they are, after a minute of walking ---- */
await p.evaluate(() => {
  window.__setInput({ gas: 0, brake: 1, steer: 0, hand: 0 });
  P.car.vx = P.car.vy = 0;
});
out.overTheMinute = await walkFor(60, MEASURE);
/* Nobody spends any real part of a minute in the road they are walking beside,
   and nobody is ever more than a step into one. Both are needed: a rate alone
   would pass a pedestrian standing in the middle of a boulevard for one frame,
   and a worst case alone would pass a crowd loitering half a metre in for the
   whole minute.

   A/B'd BY TAKING pedHold OUT, which is the rule this is here to defend — the
   correction that pulls anyone who has cut the inside of a bend back onto the
   pavement. Over the same minute, in the same city:

       with it     20,279 samples   rate 0.0000   worst -0.58 m
       without it  20,147 samples   rate 0.0072   worst -3.97 m

   And the snapshot below read ZERO ON TARMAC in both, which is the argument for
   this section existing: the reading that was carrying this claim could not see
   a regression that put pedestrians four metres into a carriageway. */
out.staysOutOfTheRoad = out.overTheMinute.samples > 2000 &&
                        out.overTheMinute.rate < 0.005 &&
                        out.overTheMinute.worst > -1.0;

out.now = await p.evaluate(src => {
  const measure = eval('(' + src + ')');
  /* AGAINST THE ROAD THEY ARE WALKING ALONG, which is the guarantee the code
     actually makes, and separately against the NEAREST road, which is not.

     The difference is junctions, and it is not a defect in either. A pavement
     has to cross the mouth of every side street it passes, so a pedestrian on
     the pavement of a narrow street is, for the few seconds it takes to cross,
     inside the carriageway of the boulevard it meets — measured, eight of
     thirty-four at any instant, the worst of them five metres in, which is a
     pedestrian on a boulevard's centre line at a crossing. That is what walking
     down a street looks like. What would be a defect is standing in the road
     they are supposedly walking beside, and that is the number asserted on. */
  const rows = peds.filter(q => !q.dead).map(q => {
    const near = measure(q.x, q.y);
    const own = q.road ? measure(q.x, q.y, q.road) : near;
    return { off: +(own.d - own.w / 2).toFixed(2), d: +near.d.toFixed(2),
             anyOff: +(near.d - near.w / 2).toFixed(2) };
  });
  const offs = rows.map(r => r.off).sort((a, b) => a - b);
  return {
    n: rows.length,
    // on the carriageway of their OWN street: must be nobody
    onTarmac: rows.filter(r => r.off < -0.5).length,
    // and in SOME carriageway, which is the crossings and is expected
    crossing: rows.filter(r => r.anyOff < -0.5).length,
    strayed: rows.filter(r => r.d > 20).length,
    medianOff: offs.length ? +offs[offs.length >> 1].toFixed(2) : null,
    worst: offs.length ? +offs[0].toFixed(2) : null
  };
}, MEASURE);

/* Nobody in their own street, nobody out in a field, and the typical one exactly
   where the code says it puts them: half the carriageway plus a metre and a
   half. The median is asserted as well as the minimum, because "nobody is
   negative" would also be satisfied by a crowd standing thirty metres back. */
/* The snapshot allows one, and the minute above does not allow a rate. Insisting
   on zero here is asking thirty-four samples to answer a question about
   something that happens to one pedestrian at a time for about a second — which
   is the coin flip described over walkFor, and the reason this reading is now
   the weaker of the two rather than the one carrying the claim. */
out.staysOffTheTarmac = out.now.n > 10 && out.now.onTarmac <= 1;
out.staysOnThePavement = out.now.medianOff > 1.0 && out.now.medianOff < 2.5;
out.staysNearAStreet = out.now.strayed === 0;

/* ---- 2. and the old walk, from the same places, for the same minute ----

   THE A/B. Run in the page against a copy of the live positions, so it is the
   same city, the same roads and the same starting points — the only difference
   is the rule. Everything below the comment is the algorithm this replaced,
   verbatim apart from being handed its own array. */
out.oldWalk = await p.evaluate(src => {
  const measure = eval('(' + src + ')');
  const rand = (a, b) => a + Math.random() * (b - a);
  const ghosts = peds.filter(q => !q.dead)
    .map(q => ({ x: q.x, y: q.y, h: q.h, spd: q.spd, t: rand(0, 10) }));
  const dt = 1 / 60;
  for (let step = 0; step < 60 * 60; step++) {
    for (const q of ghosts) {
      q.t -= dt;
      if (q.t <= 0) { q.t = rand(2, 7); q.h += rand(-1.4, 1.4); }
      const nx = q.x + Math.cos(q.h) * q.spd * dt, ny = q.y + Math.sin(q.h) * q.spd * dt;
      if (onRoad(nx, ny) && !onRoad(q.x, q.y)) q.h += Math.PI * rand(.6, 1.4);
      else { q.x = nx; q.y = ny; }
    }
  }
  const rows = ghosts.map(q => {
    const m = measure(q.x, q.y);
    return { off: m.d - m.w / 2, d: m.d };
  });
  return { n: rows.length,
           onTarmac: rows.filter(r => r.off < -0.5).length,
           strayed: rows.filter(r => r.d > 20).length };
}, MEASURE);
/* BOTH WAYS OF ENDING UP IN THE WRONG PLACE, ADDED TOGETHER, because they are
   the same failure seen from two sides: the old walk either wandered into a
   carriageway or wandered away from every street, and which one it did in any
   given run is the shape of the streets it started on rather than anything about
   the rule. Asked of `strayed` alone the answer ranged from 5 to 16 out of 34
   across four runs of the SAME build against a threshold of 8.5 — so the test
   failed or passed on the draw. Added together it was 9, 10, 10 and 18.

   One in seven, against a new walk that has to be strictly better. A minute of
   random walking at 1.4 m/s covers eighty-odd metres and there is no street
   network anywhere that keeps that on a pavement, so this is a floor on the
   difference rather than a measurement of it. */
const bad = w => (w.onTarmac || 0) + (w.strayed || 0);
out.oldBad = bad(out.oldWalk);
out.nowBad = bad(out.now);
out.betterThanTheOldWalk =
  out.oldWalk.n === out.now.n &&
  out.oldBad >= Math.max(4, out.nowBad + out.now.n * 0.15);

/* ---- 3. they face the way they are going ---- */
out.facing = await p.evaluate(async () => {
  /* The node each one is walking to is recorded with the position, and anybody
     who reached theirs inside the window is dropped: arriving at a node turns
     you towards the next one, so a heading measured across that moment is a
     heading measured across a corner. Two of twenty-three, before this. */
  const before = peds.filter(q => !q.dead)
    .map(q => ({ q, x: q.x, y: q.y, idx: q.idx, side: q.side, holds: q.holds || 0 }));
  await new Promise(res => {
    const t0 = window.__simT();
    const tick = () => (window.__simT() - t0 < 2 ? requestAnimationFrame(tick) : res());
    requestAnimationFrame(tick);
  });
  let ok = 0, moved = 0, turned = 0;
  for (const b of before) {
    /* Anyone who turned a corner OR was pushed back onto the pavement inside the
       window is dropped. The lateral correction moves somebody sideways without
       changing where they are heading, so a displacement measured across it is
       not a heading — one of twenty-five, before this. */
    if (b.q.idx !== b.idx || b.q.side !== b.side || (b.q.holds || 0) !== b.holds) {
      turned++; continue;
    }
    const dx = b.q.x - b.x, dy = b.q.y - b.y;
    if (Math.hypot(dx, dy) < .4) continue;
    moved++;
    let d = Math.atan2(dy, dx) - b.q.h;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) < .35) ok++;
  }
  return { moved, ok, turned };
});
out.facesTheWayTheyWalk = out.facing.moved > 8 && out.facing.ok === out.facing.moved;

/* ---- 4. and they are people rather than posts ----

   Read off the geometry the renderer is handed, not off a screenshot. pushPerson
   writes into a plain array in the same layout every other dynamic mesh uses —
   13 floats a vertex, 36 vertices a box — so the boxes can be counted and their
   extents measured. */
out.model = await p.evaluate(() => {
  const q = peds.find(o => !o.dead);
  if (!q) return null;
  q.h = 0;                                   // facing +x, so forward is x
  q.step = Math.PI / 2;                      // mid-stride: legs at full swing
  const a = [];
  pushPerson(a, q);
  const STRIDE = 13, VERTS = a.length / STRIDE;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < VERTS; i++) {
    xs.push(a[i * STRIDE]); ys.push(a[i * STRIDE + 1]); zs.push(a[i * STRIDE + 2]);
  }
  const y0 = terrainH(q.x, q.y);
  const top = Math.max(...ys) - y0, bottom = Math.min(...ys) - y0;
  /* Widths taken at the PLANES the boxes actually have corners on. Asking for
     the span across a band from 1.0 to 1.35 m returned nothing at all and read
     as a null: a box contributes vertices at its top and its bottom and nowhere
     in between, and the torso's are at 0.84 and 1.45. */
  const across = at => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < VERTS; i++) if (at(ys[i] - y0)) { lo = Math.min(lo, zs[i]); hi = Math.max(hi, zs[i]); }
    return hi > lo ? hi - lo : null;
  };
  const headW = across(h => h > top - .02);                 // the crown
  const shoulderW = across(h => h > 1.40 && h < 1.50);      // the top of the torso
  // the legs, mid-stride: how far apart fore-and-aft
  let fLo = Infinity, fHi = -Infinity;
  for (let i = 0; i < VERTS; i++) if (ys[i] - y0 < .2) { fLo = Math.min(fLo, xs[i]); fHi = Math.max(fHi, xs[i]); }
  return { boxes: VERTS / 36, verts: VERTS, height: +top.toFixed(2), bottom: +bottom.toFixed(3),
           headW: +headW.toFixed(3), shoulderW: +shoulderW.toFixed(3),
           strideSpan: +(fHi - fLo).toFixed(3) };
});
out.isAPerson = !!out.model &&
  out.model.boxes === 6 &&
  Math.abs(out.model.bottom) < 0.01 &&               // stands on the ground
  out.model.height > 1.6 && out.model.height < 1.9 &&
  out.model.shoulderW > out.model.headW * 1.6 &&     // shoulders, not a knob on a post
  out.model.strideSpan > 0.5;                        // and the legs are apart

/* And the stride is driven by DISTANCE rather than by the clock, so somebody
   walking slowly takes slower steps instead of jogging on the spot. Two
   pedestrians at different speeds over the same interval must advance their
   phase in proportion to how far they went. */
out.stride = await p.evaluate(async () => {
  const live = peds.filter(q => !q.dead).slice(0, 12);
  /* PATH LENGTH, ACCUMULATED PER FRAME, not the distance between where they
     started and where they finished. Anybody who turns a corner inside the
     window walks further than they end up from the start, so the straight-line
     version made a constant phase-per-metre look like a spread from 2.6 to 8.2
     — and 2.6 is the constant. */
  const s0 = live.map(q => ({ q, step: q.step, x: q.x, y: q.y, path: 0,
                             holds: q.holds || 0 }));
  await new Promise(res => {
    const t0 = window.__simT();
    const tick = () => {
      for (const b of s0) {
        b.path += Math.hypot(b.q.x - b.x, b.q.y - b.y);
        b.x = b.q.x; b.y = b.q.y;
      }
      window.__simT() - t0 < 3 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  /* Anyone pushed back onto the pavement inside the window is dropped, for the
     same reason the heading section drops them: the correction moves somebody
     sideways, which adds to the path they have covered and nothing to the
     stride. One of eleven, and it read as a phase of 1.2 radians per metre
     against everybody else's 2.6. */
  const rows = s0.map(b => ({ d: b.path, ds: b.q.step - b.step,
                              held: (b.q.holds || 0) !== b.holds }))
                 .filter(r => r.d > 1 && !r.held);
  // phase per metre, which must be the same for everybody
  const k = rows.map(r => r.ds / r.d);
  return { n: rows.length, min: Math.min(...k), max: Math.max(...k) };
});
out.strideIsPerMetre = out.stride.n > 5 &&
                       out.stride.max - out.stride.min < 0.05 * out.stride.max;

out.errs = errs.slice(0, 3);
out.pass = out.staysOutOfTheRoad &&
           out.staysOffTheTarmac && out.staysOnThePavement && out.staysNearAStreet &&
           out.betterThanTheOldWalk &&
           out.facesTheWayTheyWalk && out.isAPerson && out.strideIsPerMetre && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
