/* THE CAR LOOKS LIKE THE JOB: police chequer, red cross, taxi checkerboard.
 *
 * HOW THIS IS MEASURED, because a livery test is easy to write badly. Counting
 * "red pixels near the car" would pass on a build with no cross at all — the
 * tail lights are red, the courier's own paint is pink, and a box drawn round a
 * car catches whatever else is in the street. So every reading here is a
 * DIFFERENCE: the same frame is rendered twice, once as it is and once with
 * `livery` set to null and nothing else touched, and what moved is the markings.
 * On a build that has no liveries the two frames are identical and every number
 * below is zero, which is the A/B for free.
 *
 * BOTH RENDERERS, because the markings are built twice — flat rectangles in the
 * top-down view, boxes off the car's own eight corners in the chase view — and a
 * change to one that misses the other is exactly the failure to expect.
 *
 * WHY COLOURS AND NOT A PIXEL DIFF. In the top-down view a plain diff would do;
 * in the chase view it will not, because the world is still streaming cells in
 * and the sun is still moving, so two consecutive frames of a PARKED car differ
 * in about 150,000 pixels all by themselves. Counting pixels of a particular
 * colour inside a box around the car is immune to that: measured, the frame to
 * frame noise in each of these counts is single digits, against signals of two
 * to five hundred.
 *
 * AND WHAT IS VISIBLE IS NOT THE SAME IN THE TWO VIEWS. From above you see the
 * chequer down the flanks; from behind you see the roof and the flanks are very
 * nearly edge-on. So the taxi is checked by its dark chequer in the flat view
 * and by its roof sign in the chase view — which is also why the markings were
 * put on the roof in the first place.
 *
 * Usage: node tests/livery.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text()))
    errs.push('console: ' + m.text());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(700);

const out = {};

/* THE SAME CAR IN THE SAME PLACE FACING THE SAME WAY, before every reading.
   Left to itself the car drifts, gets nudged by traffic and ends each section
   somewhere else, and in the chase view the camera distance follows it — which
   changed the roof sign from 8 screen pixels to 120 between runs of an unchanged
   build. The markings are what is under test; where the car happens to be is
   not. */
const park = async () => {
  await p.evaluate(() => {
    const s = P.spawn;
    window.__tp(s.x, s.y, s.h);
    P.car.vx = P.car.vy = 0;
  });
  await p.waitForTimeout(700);          // long enough for the chase camera to settle
};

/* ---- 1. the top-down view ---- */
/* Here the two frames are byte-comparable — the flat view has no streaming world
   and no moving sun — so the reading is the exact set of pixels that moved and
   the average colour they moved TO. Counting pixels by colour class was the
   first version and it was the wrong instrument: the markings are a couple of
   pixels across at this zoom, so a third of them sit on a classifier boundary
   and the count swung between 22 and 55 across runs of an unchanged build. The
   number of pixels that changed does not move like that, and the mean of what
   they became still says which livery it is. */
const read2D = job => p.evaluate(new Function('job', `
  window.__takeJob(job);
  const car = P.car;
  const g = document.getElementById('game').getContext('2d');
  const a = window.__toScreen(car.x, car.y);
  const b = window.__toScreen(car.x + car.l, car.y);
  const R = Math.ceil(Math.max(26, Math.hypot(b[0] - a[0], b[1] - a[1])) * .8);
  const x = Math.round((a[0] - R) * DPR), y = Math.round((a[1] - R) * DPR);
  const w = Math.round(R * 2 * DPR);
  const grab = () => { render(); return g.getImageData(x, y, w, w).data; };
  const A = grab();
  const keep = car.livery; car.livery = null;
  const B = grab();
  car.livery = keep;
  render();
  let n = 0, r = 0, gg = 0, bb = 0, pale = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (A[i] === B[i] && A[i+1] === B[i+1] && A[i+2] === B[i+2]) continue;
    n++; r += A[i]; gg += A[i+1]; bb += A[i+2];
    // the band and the ladder: the only near-white on a red vehicle
    if (A[i] > 175 && A[i+1] > 175 && A[i+2] > 175) pale++;
  }
  return { livery: keep, box: w * w, n, pale,
           r: n ? Math.round(r/n) : 0, g: n ? Math.round(gg/n) : 0,
           b: n ? Math.round(bb/n) : 0 };
`), job);

out.flat = {};
for (const job of ['courier', 'police', 'ambulance', 'taxi', 'fire']) {
  await park();
  out.flat[job] = await read2D(job);
}
/* A hundred pixels out of a box of three or four thousand is a band down each
   flank at this zoom. Below that the livery renders as nothing. */
const MIN2D = 100;
out.flatMarkings =
  // a shift with no markings changes nothing at all: this is the A/B
  out.flat.courier.n === 0 &&
  /* THE FIRE ENGINE IS A WHOLE VEHICLE, not a marking: taking its livery away
     leaves an ordinary (if very long) car, so far more of the box changes than
     any band or cross accounts for, and the white flank stripe and the aluminium
     ladder are the only near-white on it. */
  out.flat.fire.n > 300 && out.flat.fire.pale > 20 &&
  out.flat.police.n > MIN2D && out.flat.ambulance.n > MIN2D && out.flat.taxi.n > MIN2D &&
  // the bar is blue at one end and red at the other on purpose, so what has to
  // hold is that the livery as a whole leans blue
  out.flat.police.b > out.flat.police.r && out.flat.police.b > out.flat.police.g &&
  // the cross is unmistakably red, which neither of the others is
  out.flat.ambulance.r > out.flat.ambulance.g + 90 &&
  out.flat.ambulance.r > out.flat.ambulance.b + 70 &&
  /* And the chequer is dark and warm: black squares laid over yellow paint,
     averaging out well short of the ambulance's red and with none of the police
     car's blue in it. */
  out.flat.taxi.r < 170 && out.flat.taxi.b < 90 &&
  out.flat.taxi.g > out.flat.taxi.b + 40;

/* ---- 2. and the chase view ---- */
/* THE SAME QUESTION, A BLUNTER INSTRUMENT, because this renderer will not hold
   still. One cell of city is built per frame and the sun keeps moving, so two
   consecutive frames of a parked car differ in about 150,000 pixels by
   themselves. What survives that is a comparison inside a box around the car,
   against a THIRD frame taken with nothing changed at all: the livery pair and
   the do-nothing pair are both measured, and only a difference far above the
   do-nothing one counts. Measured on this build the markings move four to eight
   hundred pixels in that box and the do-nothing pair moves nought to seventy.
   The courier is not asserted on here — with no markings its two readings are
   both just the churn, which is the point, and it is the flat view above that
   pins "no livery means no change" to exactly zero. */
out.mode3d = await p.evaluate(() => window.__setMode3d(true));
if (!out.mode3d) {
  /* No WebGL2 is a legitimate answer on some machines and the game says so and
     carries on in 2D. Reporting it as a failure would be reporting the machine. */
  out.solid = { skipped: 'no WebGL2 here' };
  out.solidMarkings = true;
} else {
  await p.waitForTimeout(1800);
  const read3D = job => p.evaluate(new Function('job', `
    window.__takeJob(job);
    const car = P.car;
    const gl = GL.gl, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const R = Math.round(95 * DPR);
    const grab = () => {
      render();
      const s = window.__toScreen(car.x, car.y);
      const cx = Math.round(s[0] * DPR), cy = Math.round(H - s[1] * DPR);
      const x0 = Math.max(0, cx - R), x1 = Math.min(W, cx + R);
      const y0 = Math.max(0, cy - R), y1 = Math.min(H, cy + R);
      const b = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
      gl.readPixels(x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return b;
    };
    // a channel sum of 60 is well past dithering and well short of a marking
    const moved = (A, B) => {
      let n = 0, r = 0, g = 0, u = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (Math.abs(A[i]-B[i]) + Math.abs(A[i+1]-B[i+1]) + Math.abs(A[i+2]-B[i+2]) <= 60) continue;
        n++; r += A[i]; g += A[i+1]; u += A[i+2];
      }
      return n ? { n, r: Math.round(r/n), g: Math.round(g/n), b: Math.round(u/n) }
               : { n: 0, r: 0, g: 0, b: 0 };
    };
    /* Let the cell queue and the camera settle first: a frame that adds a street
       is not a frame you can compare against the one before it. */
    for (let k = 0; k < 12; k++) render();
    const A = grab();
    const keep = car.livery; car.livery = null;
    const B = grab();
    const C = grab();                    // and again, with nothing changed at all
    car.livery = keep;
    return { livery: keep, sig: moved(A, B), noise: moved(B, C) };
  `), job);
  out.solid = {};
  for (const job of ['courier', 'police', 'ambulance', 'taxi', 'fire']) {
    await park();
    out.solid[job] = await read3D(job);
  }
  const loud = j => out.solid[j].sig.n > out.solid[j].noise.n + 250;
  const S = j => out.solid[j].sig;
  out.solidMarkings =
    loud('police') && loud('ambulance') && loud('taxi') &&
    /* The appliance replaces the body rather than decorating it, so it moves an
       order of magnitude more of the box than a livery does. */
    out.solid.fire.sig.n > out.solid.fire.noise.n + 900 &&
    // the bar and the flank chequer, which lean blue however the sun falls
    S('police').b > S('police').r && S('police').b > S('police').g &&
    // the cross
    S('ambulance').r > S('ambulance').g + 70 && S('ambulance').r > S('ambulance').b + 60 &&
    /* and the roof sign over its dark plinth: warm and dark, which is neither of
       the other two — the police mean has more blue in it than green, and the
       ambulance mean is half as much again in red as this is in anything. */
    S('taxi').g > S('taxi').b + 25 && S('taxi').b < 90 && S('taxi').r < 170;
  await p.evaluate(() => window.__setMode3d(false));
  await p.waitForTimeout(400);
}

/* ---- 3. the livery follows the shift, and only the shift ---- */
out.follows = await p.evaluate(async () => {
  const r = {};
  for (const id of ['taxi', 'police', 'ambulance', 'fire', 'courier']) {
    window.__takeJob(id);
    await new Promise(res => setTimeout(res, 250));
    r[id] = { livery: P.car.livery, colour: P.car.color };
  }
  return r;
});
out.liveryFollowsTheJob =
  out.follows.taxi.livery === 'taxi' && out.follows.police.livery === 'police' &&
  out.follows.ambulance.livery === 'ambulance' &&
  out.follows.fire.livery === 'fire' && out.follows.courier.livery === null;

/* ---- and the fire shift changes the vehicle, not the paint ---- */
/* A saloon in red is a saloon in red. The appliance is longer, wider and taller,
   and both renderers build it out of the car's own eight corners — so the
   dimensions are not decoration, they are what makes the truck a truck. Clocking
   off has to give back the car you arrived in: makeCar randomises the length and
   the width, so restoring "a default" would quietly hand you a different car
   every time. */
out.body = await p.evaluate(async () => {
  const size = () => ({ l: +P.car.l.toFixed(2), w: +P.car.w.toFixed(2), bh: +P.car.bh.toFixed(2) });
  window.__takeJob('courier');
  await new Promise(r => setTimeout(r, 250));
  const before = size();
  window.__takeJob('fire');
  await new Promise(r => setTimeout(r, 250));
  const truck = size();
  window.__takeJob('courier');
  await new Promise(r => setTimeout(r, 250));
  return { before, truck, after: size() };
});
out.theFireShiftIsATruck =
  out.body.truck.l > out.body.before.l + 2 &&
  out.body.truck.w > out.body.before.w &&
  out.body.truck.bh > out.body.before.bh + .8 &&
  // and the car you arrived in comes back, to the centimetre
  out.body.after.l === out.body.before.l && out.body.after.w === out.body.before.w &&
  out.body.after.bh === out.body.before.bh;

/* ---- 4. and the body shop does not repaint a city vehicle ---- */
/* The respray is a courier thing. An ambulance that comes out of the garage hot
   pink, still wearing its red cross, is the sort of detail that only turns up
   after the feature has shipped. */
out.respray = await p.evaluate(async () => {
  const go = async job => {
    window.__takeJob(job);
    await new Promise(r => setTimeout(r, 250));
    P.cash = 5000; P.car.hp = 40;
    const before = P.car.color;
    repairAt({ cool: 0, name: '' });
    return { before, after: P.car.color, hp: P.car.hp };
  };
  const amb = await go('ambulance');
  const cou = await go('courier');
  return { amb, cou };
});
out.cityVehiclesKeepTheirPaint =
  out.respray.amb.after === out.respray.amb.before && out.respray.amb.hp === 100 &&
  // and the courier's respray, which is an old feature, still happens
  out.respray.cou.after !== out.respray.cou.before;

/* ---- 5. the runaway is not marked in police colours ---- */
out.goal = await p.evaluate(async () => {
  window.__takeJob('police');
  await new Promise(r => setTimeout(r, 1100));
  const g = missionGoal();
  window.__takeJob('courier');
  return { kind: g && g.kind, col: g && g.col, cop: '#3fa2ff' };
});
const hex = (c, i) => parseInt(c.slice(i, i + 2), 16);
out.theRunawayIsRed = out.goal.kind !== 'chase' ||
  (out.goal.col !== out.goal.cop &&
   hex(out.goal.col, 1) > hex(out.goal.col, 5) + 80 &&
   hex(out.goal.col, 1) > hex(out.goal.col, 3) + 80);

out.errs = errs.slice(0, 4);
out.pass = out.flatMarkings && out.solidMarkings && out.liveryFollowsTheJob &&
           out.theFireShiftIsATruck &&
           out.cityVehiclesKeepTheirPaint && out.theRunawayIsRed && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
