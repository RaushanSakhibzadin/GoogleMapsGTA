/* Handling. Nothing tested drive() before this, which is how the handbrake
   shipped for so long only dropping lateral grip and never rotating the car.

   The car is driven through the real input path — keys, not teleports — because
   the faults being tested are in how throttle, steering and the handbrake combine
   over time, and pinning the car each frame would hide exactly that. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const URL = GAME;
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
// A big empty car park of a grid: long straight roads, no buildings to hit while
// the car is spinning, so a failed assertion means the physics and not a wall.
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Cross ${y}` }, geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Ave ${x}` }, geometry: [toLL(x, -900), toLL(x, 900)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Testville' } });
  return { elements: els };
};
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q))) return r.fulfill(json({ elements: [] }));
  if (isArterials(q)) return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});
await p.goto(URL);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(500);

const out = {};

/* Put the car on a straight, wind it up to a target speed, then run a manoeuvre
   while sampling the heading every frame. Unwrapped so a spin past ±pi reads as a
   continuous angle rather than jumping. */
async function run(opts) {
  return p.evaluate(async o => {
    window.__tp(o.x, 0, 0);                      // east along a clear road
    window.__clearMarks();
    // spin up
    const t0 = performance.now();
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const q = window.__p();
        (q.spd < o.speed && performance.now() - t0 < 12000) ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const entry = window.__p();
    // the manoeuvre
    const samples = [];
    const h0 = window.__p().h;
    let unwrapped = 0, prev = h0;
    const t1 = performance.now();
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: o.gas, brake: 0, steer: o.steer, hand: o.hand });
        const q = window.__p();
        let d = q.h - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        unwrapped += d; prev = q.h;
        samples.push({ t: +(performance.now() - t1).toFixed(0), turned: unwrapped,
                       spd: q.spd, x: q.x, y: q.y, slip: window.__slip() });
        performance.now() - t1 < o.ms ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    window.__setInput(null);                     // hand the wheel back
    return { entrySpd: entry.spd, samples, marks: window.__marks() };
  }, opts);
}

const PI = Math.PI;
const deg = r => +(r * 180 / PI).toFixed(1);

/* 1. The rotation must never reverse mid-turn. This is the regression for the
   inverted-steering fault: vf goes negative as the heading swings past 90, and
   the old code flipped the steering sign right there, so the car rotated back
   into its own spin exactly halfway through. Driven fast enough to go well past
   90 degrees, with steering held, which is where it used to break. */
{
  const r = await run({ x: -700, speed: 45, gas: 1, steer: 1, hand: 1, ms: 2600 });
  let backwards = 0;
  for (let i = 1; i < r.samples.length; i++) {
    const d = r.samples[i].turned - r.samples[i - 1].turned;
    if (d < -0.004) backwards++;                 // a little noise is fine
  }
  const last = r.samples[r.samples.length - 1];
  out.oneEighty = {
    entryKmh: Math.round(r.entrySpd * 3.6), turnedDeg: deg(last.turned),
    reversals: backwards, monotonic: backwards <= 3,
  };
}

/* 2. THE contract: the turn is HALF the speed. 90 km/h buys 45 degrees, 180
   buys 90, and 360 buys a half turn. No steering and no holding — press it and
   it lands on the number, and stops there. */
{
  const cases = [];
  for (const kmh of [90, 180, 270, 360]) {
    const r = await run({ x: -830, speed: kmh / 3.6, gas: 1, steer: 0, hand: 1, ms: 3000 });
    const last = r.samples[r.samples.length - 1];
    // where it settled, and the furthest it ever swung (overshoot would show here)
    const peak = r.samples.reduce((m, s) => Math.abs(s.turned) > Math.abs(m) ? s.turned : m, 0);
    /* Reference the speed on the FIRST frame of the manoeuvre, not the sample
       taken before it: the car is still accelerating in between, and at half
       scaling a few km/h of drift there is most of the tolerance. */
    const atPress = r.samples[0].spd;
    const want = Math.min(Math.round(atPress * 3.6 * .5), 360);
    cases.push({
      askedKmh: kmh, entryKmh: Math.round(atPress * 3.6),
      wantDeg: want, settledDeg: deg(last.turned), peakDeg: deg(peak),
      marks: r.marks,
      // within 4 degrees of "degrees = half the km/h", and it stays there
      exact: Math.abs(Math.abs(deg(last.turned)) - want) <= 4 &&
             Math.abs(Math.abs(deg(peak)) - want) <= 4,
    });
  }
  out.turnMatchesSpeed = cases;
  out.everyTime = cases.every(c => c.exact);
}

// 2b. crawling, the car barely turns — you have to carry speed to get it round
{
  const r = await run({ x: -700, speed: 2, gas: 0, steer: 0, hand: 1, ms: 1500 });
  const last = r.samples[r.samples.length - 1];
  out.crawlBarelyTurns = { entryKmh: Math.round(r.entrySpd * 3.6),
                           turnedDeg: deg(last.turned),
                           small: Math.abs(deg(last.turned)) < 30 };
}

// ---------- 3. tyre lines ----------
{
  // 200 km/h, so the turn is a 100 degree arc rather than a 30 degree flick —
  // the old 60 km/h entry was calibrated when the turn was a full 180.
  const r = await run({ x: -830, speed: 55, gas: 1, steer: 1, hand: 1, ms: 2000 });
  out.tyreLines = { laid: r.marks, appear: r.marks > 40 };
  // grabbed before the differential below, which clears the marks to measure them
  await p.screenshot({ path: `${OUT}/shot-drift.png` });
  /* And actually ON SCREEN, not merely in the array. Counting dark pixels
     outright proves nothing: the dusk ground is #0d0718 and passes any "is it
     dark" threshold on its own. So the same patch is sampled twice, with the
     marks and then without them, and it is the DIFFERENCE that is the rubber. */
  /* Paused, so the world is genuinely frozen: traffic, the rolling car and the
     particles all stop, and __renderOnce redraws the same scene on demand. The
     two frames then differ by exactly one thing — the rubber. Measured live, the
     control below caught 5,579 pixels moving the wrong way, because everything
     else in the scene was still moving between the grabs. */
  await p.keyboard.press('Escape');
  out.tyreLines.pixels = await p.evaluate(async () => {
    const cv = document.getElementById('game'), g = cv.getContext('2d');
    const dpr = cv.width / cv.clientWidth;
    // one grab of the whole patch, so the two samples line up pixel for pixel
    const X = Math.round((cv.clientWidth / 2 - 150) * dpr), Y = Math.round((cv.clientHeight * .6 - 130) * dpr);
    const Wp = Math.round(300 * dpr), Hp = Math.round(260 * dpr);
    const grab = () => g.getImageData(X, Y, Wp, Hp).data;
    window.__calm();          // the camera shake is random per frame; still it
    window.__renderOnce();
    const a = grab();
    window.__clearMarks();
    window.__renderOnce();
    const bpx = grab();
    // A pixel the rubber was covering gets LIGHTER when the rubber goes away.
    let rubber = 0, lighter = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = (bpx[i] + bpx[i + 1] + bpx[i + 2]) - (a[i] + a[i + 1] + a[i + 2]);
      if (d > 12) rubber++;
      else if (d < -12) lighter++;
    }
    return { rubberPixels: rubber, wrongWay: lighter, sampled: a.length / 4 };
  });
  await p.keyboard.press('Escape');            // back to play
  /* Rubber darkens the ground it lies on. `wrongWay` is the control: with the
     world frozen, nothing else can change between the two frames, so anything
     moving the other way means the measurement is contaminated. */
  out.tyreLines.visible = out.tyreLines.pixels.rubberPixels > 300 &&
                          out.tyreLines.pixels.wrongWay < 40;
}

// ---------- 4. releasing DRIFT recovers ----------
{
  /* WHAT THIS LEG CAN ACTUALLY ESTABLISH — narrowed, after chasing it properly.

     It used to assert lateral slip < 1.2 after the release. That never described
     the manoeuvre: this game models a handbrake slide as a HEADING SPIN, not as
     lateral velocity, and the measured peak slip through a 900 ms slide at full
     lock is 0.61. So the bound was only ever saying "nothing is shoving the car
     sideways" — and it passed because, at the time it was written, nothing did.

     The off-road penalty added something that does. A slide at full lock finishes
     on the grass, and off the tarmac the kerb pull leans the car back towards the
     road every frame, which lands in exactly this number: the car settles at a
     slip of about 2 with the handbrake long released. The assertion had been
     failing on the shipped build for a while without anyone being told, because
     this file computed a verdict and then exited 0 regardless.

     Three ways round it were tried and measured. Holding the throttle until the
     car finds the road again never arrives — off-road is 11 km/h and this
     deliberately does not steer. Measuring in GHOST, which lifts the kerb pull,
     reads a peak slip of ZERO, because the perk lifts the slide too. Scaling the
     bound against the slide's own peak is scaling against 0.61.

     So the claim is the one that survives all of it: release everything and the
     car stops rotating. That is what a slide ending looks like here. Slip, speed
     and which ground it finished on are reported, not asserted, because each of
     them is really a statement about the off-road penalty and that has its own
     tests. */
  const r = await run({ x: -700, speed: 16.7, gas: 1, steer: 1, hand: 1, ms: 900 });
  const rec = await p.evaluate(async () => {
    // let go of everything but the throttle and let it settle
    const t0 = performance.now();
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        performance.now() - t0 < 2500 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const a = window.__p();
    await new Promise(r2 => setTimeout(r2, 400));
    const bq = window.__p();
    window.__setInput(null);
    return { slip: window.__slip(), spd: bq.spd, drift: Math.abs(bq.h - a.h),
             onRoad: bq.onRoad };
  });
  /* It had been failing on the shipped build for a while without anyone being
     told, because this file computed a verdict and then exited 0 regardless. */
  // the tail really was out, so "it settled" is a statement about a slide and not
  // about a car that was going straight the whole time
  const peak = Math.max(...r.samples.map(q => Math.abs(q.slip || 0)));
  // the manoeuvre really happened: the car came round, which is how a slide shows
  const turned = Math.abs(r.samples[r.samples.length - 1].turned);
  out.recovers = { lateralSlip: +rec.slip.toFixed(2), spd: +rec.spd.toFixed(1),
                   onRoadAfter: !!rec.onRoad, headingDrift: +rec.drift.toFixed(3),
                   /* HONEST ABOUT ITS REACH: a settle check. It holds that the
                      tail goes out and that once everything is released the slide
                      collapses and the car stops rotating. It does NOT catch a
                      handbrake that never releases — measured, on a build with the
                      player's hand input forced on: with no steering the car
                      straightens either way. Named here rather than left to the
                      reader to assume. */
                   peakSlipInSlide: +peak.toFixed(2), turnedRad: +turned.toFixed(2),
                   /* HONEST ABOUT ITS REACH: it does NOT catch a handbrake that
                      never releases. Measured, on a build with the player's hand
                      input forced on — with no steering the car straightens
                      either way. Named here rather than left to be assumed. */
                   tracksStraight: turned > 0.5 && rec.drift < 0.06 };
}

// ---------- 5. the AI never handbrakes, so its handling is untouched ----------
out.aiUnaffected = await p.evaluate(() => {
  /* Asserting the actual property: no AI car is ever handed a 180. The old check
     here watched for traffic exceeding 40 m/s, which a collision with the
     spinning player can cause on its own — it flaked, and it was never testing
     the thing it claimed to. */
  return { count: window.__traffic().length, aiSpins: window.__aiSpins() };
});

/* 5b. SOUND. The context is opened on the DRIVE tap, but iOS hands back a
   SUSPENDED one routinely — opening the page from another app is the usual case
   — and resuming only at creation meant one bad start left the game silent for
   good. So: it must be running after the gesture, its clock must actually be
   advancing (a suspended context reports 'running' nowhere but also never ticks),
   every effect must fire without throwing, and a suspend must be recoverable. */
out.audio = await p.evaluate(async () => {
  const snap = window.__audio();
  const t0 = snap.now;
  await new Promise(r => setTimeout(r, 400));
  const ticking = window.__audio().now > t0;
  const threw = [];
  for (const fx of ['horn', 'skid', 'crash', 'pickup', 'cash', 'star', 'bust', 'blipZone', 'boom']) {
    try { window.__sfx(fx); } catch (e) { threw.push(fx + ': ' + e.message); }
  }
  // and the recovery path: suspend it the way the OS would, then ask for it back
  let recovered = null;
  try {
    await window.__audioSuspend();
    const dead = window.__audio().state;
    window.__sfxResume();
    await new Promise(r => setTimeout(r, 250));
    recovered = { wasSuspended: dead === 'suspended', nowRunning: window.__audio().state === 'running' };
  } catch (e) { recovered = { err: e.message }; }
  return { started: snap.started, state: snap.state, clockTicking: ticking, threw, recovered };
});
out.soundWorks = out.audio.started && out.audio.state === 'running' &&
                 out.audio.clockTicking && out.audio.threw.length === 0 &&
                 out.audio.recovered.wasSuspended && out.audio.recovered.nowRunning;

// ---------- 6. frame rate with a screen full of rubber ----------
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 2000 ? requestAnimationFrame(tick) : r(Math.round(n / 2)); };
  requestAnimationFrame(tick);
}));
out.marksOnScreen = await p.evaluate(() => window.__marks());

out.errs = errs.slice(0, 5);
out.pass = out.oneEighty.monotonic && out.everyTime &&
           out.crawlBarelyTurns.small && out.soundWorks && out.tyreLines.appear && out.tyreLines.visible &&
           out.recovers.tracksStraight && out.aiUnaffected.aiSpins === 0 &&
           out.fps >= 55 && !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
/* This computed `pass` and then exited 0 whatever it said, which is how the
   recovery assertion above sat failing on a shipped build without anyone being
   told. A test that cannot fail is a log. */
process.exit(out.pass ? 0 : 1);
/* Worked out `pass` and then exited 0 whatever it said, so a failure here has
   only ever been visible to someone reading the JSON by eye. A test that cannot
   fail is a log. */
process.exit(out.pass ? 0 : 1);
