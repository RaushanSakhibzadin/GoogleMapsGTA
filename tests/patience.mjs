/* HOW LONG THE PLAYER WAITS, WHICH IS NOT THE SAME QUESTION AS HOW LONG THE
   REQUEST WAITS.

   Every deadline in geo.js is a budget for a MIRROR — how long a server is
   allowed to think before its answer stops being worth having. The loading
   screen inherited those budgets by accident, simply by awaiting the requests,
   and a mirror that accepts the connection and then says nothing is the failure
   that exposes it. Measured on this suite before the change:

       mirrors healthy                    0.6 s
       mirrors unreachable                3.0 s
       mirrors silent                    42.3 s     <- the streets deadline
       streets fine, skeleton silent     46.5 s     <- the skeleton ladder

   Forty-two seconds of bar, with a real six-megabyte city sitting unopened in
   the download the whole time. So the loading screen now gives up long before
   the request does — and, crucially, DOES NOT CANCEL IT. What that buys is the
   difference between a trade and a free lunch: the game starts in the bundled
   city, the request goes on running behind the wheel, and if it lands the real
   city is swapped in. Being impatient costs a world that changes a few seconds
   later, not a world you never get.

   THIS FILE IS ABOUT THE CLOCK, so every number below is a wall-clock
   measurement of a real load with real mock servers, and every one of them fails
   loudly against the build that lacks the change:

       GAME=/path/to/old/index.html node tests/patience.mjs slow

   scenarios: slow | silent | skelslow | healthy   (default: all four)
*/
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';
const { fakeOSM } = await import('./fake.mjs');

/* Belgrade, so the bundled skeleton is a legitimate stand-in for this session's
   origin — bundledSkeleton() refuses to graft its capture under somebody who
   asked for Osaka, and a test that starts in Tokyo would be measuring that
   refusal rather than the wait. */
const LAT = 44.8125, LON = 20.4612;

/* HOW LATE IS LATE. Comfortably past the nine seconds the loading screen is
   willing to wait, and comfortably inside the forty-two the request itself
   still has to live — so the reply lands while the player is already driving,
   which is the case this whole change exists to produce. */
const LATE_MS = 14000;
/* Past the six seconds the loading screen gives the skeleton, and inside the
   EIGHTEEN the first rung of the ladder is allowed — a delay longer than the
   rung's own budget makes every rung time out, and then this measures the
   bundled stand-in arriving at forty-five seconds rather than the real
   skeleton being deferred. Which is what the first version of this file did. */
const SKEL_LATE_MS = 11000;

const isArterials = body => /motorway/.test(body) && !/residential/.test(body);
const bboxOf = body => {
  const m = body.match(/\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
};

const bad = [];
const need = (cond, msg) => { if (!cond) bad.push(msg); };
const out = {};

async function run(mode) {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 1100, height: 760 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT), lon: String(LON), display_name: 'Belgrade, City of Belgrade' }]) }));

  /* Held rather than answered, and held in a list rather than dropped: an
     abort() is a refusal, which the game already survives in three seconds. The
     failure worth reproducing is a mirror that takes the connection and then
     says nothing, because that is the one that used to hold the loading screen
     for its full deadline. */
  const held = [];
  let streetsAsked = 0, arterialsAsked = 0;
  await p.route('**/api/interpreter', async route => {
    const body = decodeURIComponent(route.request().postData() || '');
    const wide = isArterials(body);
    if (wide) arterialsAsked++; else streetsAsked++;
    const fill = () => route.fulfill({ contentType: 'application/json',
                                       body: JSON.stringify(fakeOSM(bboxOf(body))) });
    if (mode === 'silent') return void held.push(route);
    if (mode === 'slow') { await new Promise(r => setTimeout(r, LATE_MS)); return fill(); }
    if (mode === 'skelslow' && wide) { await new Promise(r => setTimeout(r, SKEL_LATE_MS)); return fill(); }
    fill();
  });

  await stubRadio(p);
  await p.goto(GAME);
  await p.waitForTimeout(300);

  const t0 = Date.now();
  await p.click('#go');
  let started = -1;
  try {
    await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
    started = Date.now() - t0;
  } catch (e) {}
  const r = { mode, startedS: started < 0 ? null : +(started / 1000).toFixed(1) };
  need(started > 0, mode + ': the game never started at all');

  const snap = () => p.evaluate(() => {
    const w = window.__w(), c = window.__chunks();
    return { name: w.name, roads: w.roads, procedural: w.procedural,
             skel: c.skel, wideMap: c.wideMap, fellBack: window.__retry().fellBack };
  });
  r.atStart = started > 0 ? await snap() : null;

  if (mode === 'healthy') {
    /* THE GOOD PATH IS UNCHANGED, and it has to be asserted or the fast numbers
       below could be bought by never waiting for anything. */
    need(started < 6000, `healthy: started in ${r.startedS}s, want under 6`);
    need(!r.atStart.fellBack, 'healthy: fell back to the bundle with every server answering');
    need(r.atStart.roads > 10, 'healthy: no city');
    need(r.atStart.wideMap, 'healthy: the wide map did not land on the loading screen');
  }

  if (mode === 'silent' || mode === 'slow') {
    /* The measurement. Nine seconds of patience plus the bundle's own load, so
       thirteen is the honest ceiling; the build without the change sits here for
       forty-two. */
    need(started > 0 && started < 13000,
         `${mode}: started in ${r.startedS}s, want under 13 (was 42 before)`);
    need(!!r.atStart.fellBack, mode + ': started without saying it had fallen back');
    // and what it fell back TO is a real city, not the generated lattice
    need(!r.atStart.procedural, mode + ': fell back to the procedural lattice');
    need(r.atStart.roads > 2000, `${mode}: fallback has only ${r.atStart.roads} roads`);
  }

  if (mode === 'slow') {
    /* AND THE REPLY IS TAKEN UP. This is the half that makes the impatience
       free. The wait below is thirty seconds, which is the point: the timed
       retry cannot possibly deliver a city inside it — RETRY_DELAYS starts at
       ninety — so a pass here can only be the request the loading screen
       abandoned, landing and being adopted. */
    const swapped = await p.waitForFunction(
      () => !window.__retry().fellBack, null, { timeout: 30000 }).then(() => true, () => false);
    r.adoptedS = +((Date.now() - t0) / 1000).toFixed(1);
    need(swapped, `slow: the late reply was never adopted (still in the fallback after ${r.adoptedS}s)`);
    if (swapped) {
      r.afterSwap = await snap();
      need(r.afterSwap.roads > 10, 'slow: adopted a city with no roads in it');
      need(!r.afterSwap.procedural, 'slow: adopted the procedural lattice');
      /* Adoption is a world swap under a moving car, and the thing that goes
         wrong is the projection: the fallback moved the origin to Belgrade and
         these elements are degrees around the place that was asked for. Get it
         wrong and the car is hundreds of kilometres off its own roads. */
      const onRoad = await p.evaluate(() => {
        const c = window.__p();
        return window.__onRoad(c.x, c.y);
      });
      need(onRoad, 'slow: the car is not on a road after the swap — the projection moved under it');
    }
    r.streetsAsked = streetsAsked;
  }

  if (mode === 'skelslow') {
    /* The skeleton is scenery on the big map, not ground under the wheels, and
       the machinery for growing the world mid-drive already existed. So the
       loading screen must not sit through the ladder — six seconds of patience,
       and the streets themselves answer instantly here. */
    need(started > 0 && started < 10000,
         `skelslow: started in ${r.startedS}s, want under 10 (was 46 before)`);
    need(!r.atStart.fellBack, 'skelslow: fell back over a slow skeleton — the streets were fine');
    need(!r.atStart.wideMap, 'skelslow: the wide map was in before the servers answered');
    // and it arrives behind the wheel rather than being thrown away
    const landed = await p.waitForFunction(
      () => window.__chunks().wideMap, null, { timeout: 30000 }).then(() => true, () => false);
    r.skelS = +((Date.now() - t0) / 1000).toFixed(1);
    need(landed, `skelslow: the skeleton never arrived (${r.skelS}s) — it was cancelled, not deferred`);
    r.afterSkel = await snap();
    r.arterialsAsked = arterialsAsked;
  }

  r.errs = errs.slice(0, 3);
  need(!errs.length, mode + ' page errors: ' + errs.slice(0, 2).join(' | '));
  for (const h of held) { try { await h.abort(); } catch (e) {} }
  await b.close();
  return r;
}

const modes = process.argv[2] ? [process.argv[2]] : ['healthy', 'silent', 'slow', 'skelslow'];
for (const m of modes) out[m] = await run(m);

out.bad = bad;
out.pass = bad.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
