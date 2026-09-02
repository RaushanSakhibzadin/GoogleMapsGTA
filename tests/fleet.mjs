/* EVERY TENTH VEHICLE IS NOT A CAR.
 *
 * Asked for: a lorry, a bus, a fire engine, a patrol car and an ambulance in
 * ordinary traffic, one in ten, with models for the two that did not have one.
 *
 * THREE THINGS CAN GO WRONG AND THEY FAIL SEPARATELY, so they are asked
 * separately:
 *
 *   1. THE MIX. One in ten, and all five of them — a rule that fires at the
 *      right rate but always hands out the same vehicle is the feature not
 *      working, and so is one that hands out five kinds at one in fifty.
 *   2. THE VEHICLE. Each is a different SIZE, which is what the shape is built
 *      out of: every one of these is drawn from the car's own eight corners, so
 *      a bus that is 4.5 m long is a bus-shaped hatchback.
 *   3. THE MODEL. The lorry and the bus are new geometry. Measured off the
 *      vertex stream the renderer is handed rather than off a screenshot: a bus
 *      is one box the whole length of the vehicle, a lorry is a cab and a body
 *      with a gap between them, and the gap is the thing that tells them apart
 *      at any distance. If the two ever collapsed onto the same builder this is
 *      what would notice.
 *
 * Usage: node tests/fleet.mjs [GAME=/path/to/index.html]
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
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};

/* ---------- 1. one in ten, and all five of them ---------- */
/* Asked of the RULE rather than of a live street: the crowd of traffic around
   the player is culled and topped up continuously, so counting what happens to
   be on screen measures the cull as much as the mix. Two hundred cars through
   the same function the spawner uses answers the question the ask actually
   posed. */
out.mix = await p.evaluate(() => {
  const before = trafficSeq;
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const c = nextTrafficCar(makeCar(0, 0, 0, 'traffic'));
    if (c.livery) seen.push(c.livery);
  }
  trafficSeq = before;
  const by = {};
  for (const s of seen) by[s] = (by[s] || 0) + 1;
  return { of: 200, special: seen.length, by, kinds: TRAFFIC_KINDS.map(k => k.livery) };
});
out.oneInTen = out.mix.special === 20 &&
               out.mix.kinds.every(k => out.mix.by[k] === 4);

/* ---------- 2. each of them is its own vehicle ---------- */
out.sizes = await p.evaluate(() => {
  const before = trafficSeq;
  const r = {};
  TRAFFIC_KINDS.forEach((k, i) => {
    trafficSeq = i * 10 - 1;                       // ++ lands on i*10, whose kind is i
    const c = nextTrafficCar(makeCar(0, 0, 0, 'traffic'));
    r[c.livery] = { l: +c.l.toFixed(2), w: +c.w.toFixed(2), bh: +c.bh.toFixed(2),
                    mass: c.mass, top: +c.maxSpeed.toFixed(1), kind: c.kind };
  });
  trafficSeq = before;
  return r;
});
/* A BUS IS LONGER THAN A LORRY IS LONGER THAN AN AMBULANCE IS LONGER THAN A
   CAR, and every one of them outweighs the hatchback it would otherwise be.
   Stated as an ORDER rather than as five numbers, so tuning the dimensions does
   not mean editing this file — what must not happen is two of them coming out
   the same, which is what a broken table looks like. */
/* Every lookup goes through this. A build where the mix has collapsed to one
   vehicle has no S.bus at all, and reading .l off it throws — which exits
   non-zero, so the suite would call it failed, but it reports a stack trace
   instead of saying which of the five went missing. A test that cannot describe
   the failure it just found is half a test. */
const S = out.sizes;
const of = (k, f) => (S[k] ? S[k][f] : -1);
out.missing = out.mix.kinds.filter(k => !S[k]);
out.eachIsItsOwn = !out.missing.length &&
  of('bus', 'l') > of('lorry', 'l') && of('lorry', 'l') > of('fire', 'l') &&
  of('fire', 'l') > of('ambulance', 'l') && of('ambulance', 'l') > of('police', 'l') &&
  of('bus', 'bh') > 2.5 && of('lorry', 'bh') > 2.5 &&
  of('bus', 'mass') > 8 && of('lorry', 'mass') > 8 &&
  // and none of them is a police unit: cops[] is what chases you
  Object.values(S).every(v => v.kind === 'traffic');
/* AND THEY DO NOT KEEP UP WITH THE TRAFFIC. A bus that tops out where a
   hatchback does is a bus-shaped hatchback in the one way you feel rather than
   see. Ordinary traffic runs 11 to 17 m/s. */
out.heavyIsSlower = of('bus', 'top') > 0 && of('bus', 'top') < 13 &&
                    of('lorry', 'top') < 13 && of('fire', 'top') < 14;

/* ---------- 3. the two new models are two models ---------- */
/* Measured off the geometry the renderer is handed. The extents come back in
   the vehicle's own frame, so they are metres of lorry rather than pixels of
   screen, and the GAP is found by asking which slices along the vehicle have
   anything tall in them — a lorry has a cab, then air, then a body, and that
   hole is what makes it a lorry rather than a van. */
out.models = await p.evaluate(() => {
  const shape = (liv, i) => {
    const before = trafficSeq;
    trafficSeq = i * 10 - 1;
    const c = nextTrafficCar(makeCar(0, 0, 0, 'traffic'));
    trafficSeq = before;
    c.z = 0; c.pitch = 0; c.roll = 0;
    const box = [];
    carBox(c, box);
    const a = [];
    if (liv === 'lorry') pushLorry(a, box, [.6, .3, .3]);
    else if (liv === 'bus') pushBus(a, box, [.6, .5, .2]);
    else return null;
    const n = a.length / LIT_FLOATS;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    const P = [];
    for (let k = 0; k < n; k++) {
      const vx = a[k * LIT_FLOATS], vy = a[k * LIT_FLOATS + 1], vz = a[k * LIT_FLOATS + 2];
      P.push([vx, vy, vz]);
      if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
      if (vz < z0) z0 = vz; if (vz > z1) z1 = vz;
      if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
    }
    /* THE ROOFLINE, band by band along the vehicle: how tall the tallest thing
       standing at this point is. Taken from the TRIANGLES THAT SPAN each band
       rather than from the vertices that land in it — a box contributes eight
       corners and nothing in between, so asking which vertices fall in a band
       reads a solid slab as a row of holes, and the first version of this
       measured a bus as a picket fence. */
    const B = 20, top = new Array(B).fill(0);
    const spans = [];
    for (let k = 0; k < n; k += 3) {
      const A = P[k], C = P[k + 1], D = P[k + 2];
      spans.push([Math.min(A[0], C[0], D[0]), Math.max(A[0], C[0], D[0]),
                  Math.max(A[1], C[1], D[1]) - y0]);
    }
    for (let b = 0; b < B; b++) {
      const cx = x0 + (b + .5) / B * ((x1 - x0) || 1);
      for (const [sa, sb, sy] of spans)
        if (sa <= cx && sb >= cx && sy > top[b]) top[b] = sy;
    }
    const H = (y1 - y0) || 1;
    const prof = top.map(t => +(t / H).toFixed(2));
    return { tris: n / 3, len: +(x1 - x0).toFixed(2), wide: +(z1 - z0).toFixed(2),
             tall: +(y1 - y0).toFixed(2), prof,
             // the deepest dip anywhere between the two ends
             dip: +Math.min(...prof.slice(2, B - 2)).toFixed(2) };
  };
  return { lorry: shape('lorry', 0), bus: shape('bus', 1) };
});
const M = out.models;
/* BOTH ARE REAL GEOMETRY of the right size — a builder that returned nothing
   would leave an invisible vehicle, which is exactly the kind of thing that
   only shows up in a screenshot nobody takes. */
out.bothAreBuilt = !!M.lorry && !!M.bus &&
  M.lorry.tris > 60 && M.bus.tris > 60 &&
  M.lorry.len > 7 && M.bus.len > 9 &&
  M.lorry.tall > 2.5 && M.bus.tall > 2.5;
/* AND THEY ARE DIFFERENT SHAPES, not one shape at two sizes. The lorry's
   roofline drops into the gap between its cab and its body; the bus's does not
   dip at all, because a bus is one box from end to end. That difference is the
   whole recognition and it is the one thing worth asserting about the models. */
out.lorryHasAGap = !!M.lorry && M.lorry.dip < 0.72;
out.busIsOneBox = !!M.bus && M.bus.dip > 0.88;

/* ---------- 4. and a real street gets them ---------- */
/* The rule above is exercised directly; this is the sanity check that it is
   actually wired to the spawner and that nothing downstream chokes on a vehicle
   that is not car-shaped. */
out.street = await p.evaluate(async () => {
  await new Promise(r => setTimeout(r, 2500));
  const by = {};
  for (const t of traffic) { const k = t.livery || 'car'; by[k] = (by[k] || 0) + 1; }
  return { cars: traffic.length, by,
           special: traffic.filter(t => t.livery).length };
});
out.theStreetHasThem = out.street.cars > 20 && out.street.special > 0;

out.errs = errs.slice(0, 5);
out.pass = out.oneInTen && out.eachIsItsOwn && out.heavyIsSlower &&
           out.bothAreBuilt && out.lorryHasAGap && out.busIsOneBox &&
           out.theStreetHasThem && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
