/* BETWEEN TWO BUILDINGS, AND THE WAY OUT OF IT.
 *
 * One report, four parts: "make it impossible to move between buildings like
 * this, for me and for other cars too; on low speed there should be no damage
 * from the building; but for situations when I stuck there should be help
 * button — if I stay at one place for a long time or press a button, the big
 * spider should rush to me and teleport me to the closest police station with
 * $100 fine, or zero if I have no money; and there should be big text on a
 * screen PAUK NOSI! if the chosen language is Serbian".
 *
 * THE FIXTURE IS THE MEASUREMENT. Three pairs of blocks with gaps of 1.2, 2.6
 * and 5 m, and a car about 2 m wide driven straight at each: one it cannot fit
 * through, two it can. A test with a single gap cannot tell "the collision
 * works" from "the car cannot move any more", and the second is the easy way to
 * pass this by accident.
 *
 * On the build this was reported from, the car drove ONE HUNDRED AND EIGHT
 * METRES down the 1.2 m gap and out the far end, because the collision tested
 * the car's centre point and a point fits anywhere.
 *
 * Usage: node tests/wedge.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const rect = (id, x0, y0, x1, y1) => ({
  type: 'way', id, tags: { building: 'yes', 'building:levels': '4' },
  geometry: [toLL(x0, y0), toLL(x1, y0), toLL(x1, y1), toLL(x0, y1), toLL(x0, y0)] });

/* The gaps, and where each pair of blocks sits. FRONT is the y the blocks start
   at, so "how far into the gap did it get" is a subtraction rather than a number
   that has to be kept in step with the fixture by hand. */
const GAPS = [{ g: 1.2, cx: -200 }, { g: 2.6, cx: 0 }, { g: 5.0, cx: 200 }];
const FRONT = -20, BACK = -90;

const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Main' },
    geometry: [toLL(-800, 0), toLL(800, 0)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Test' } }
] });
const buildings = () => {
  const els = []; let id = 5000;
  for (const { g, cx } of GAPS) {
    els.push(rect(id++, cx - 40, FRONT, cx - g / 2, BACK));
    els.push(rect(id++, cx + g / 2, FRONT, cx + 40, BACK));
  }
  return { elements: els };
};
// one station, so the spider has somewhere to take you
const POIS = () => ({ elements: [
  { type: 'node', id: 7001, ...toLL(600, 0), tags: { amenity: 'police', name: 'Stanica' } }
] });

async function boot(lang) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => {
    if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text());
  });
  /* THE CATCH-ALL GOES FIRST, and that is not a style point.
     Playwright tries the MOST RECENTLY ADDED matching route first, so a blanket
     abort registered after the Overpass handler swallows Overpass — the city
     never arrives, the game quietly falls back to the bundled Belgrade, and
     every measurement below is taken in a city that has none of this fixture's
     gaps in it. It read as the collision failing, twice. */
  await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await stubRadio(p);
  if (lang) await p.addInitScript(v => { try { localStorage.setItem('vm_lang', v); } catch (e) {} }, lang);
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Test' }]) }));
  await p.route('**/api/interpreter', r => {
    const q = decodeURIComponent(r.request().postData() || '');
    const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
               : /"building"/.test(q) ? 'buildings'
               : (/amenity/.test(q) || /historic/.test(q)) && !/highway/.test(q) ? 'pois' : 'streets';
    const body = kind === 'streets' ? streets() : kind === 'buildings' ? buildings()
               : kind === 'pois' ? POIS() : { elements: [] };
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await p.goto(GAME);
  await p.waitForTimeout(300);
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  return { p, ctx, errs };
}

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};
const { p, ctx, errs } = await boot();

/* ---------- 1. a gap the car does not fit through is a wall ---------- */
/* STARTED AT THE MOUTH OF THE GAP, not out on the road. Off the tarmac the car
   is held to the 4.5 m/s crawl, so a run that begins twenty metres away spends
   the whole window getting there and stops short of the buildings without ever
   touching one — which reads as "the gap is a wall" and is really "the car never
   arrived". Six simulated seconds from two metres out is twenty-five metres of
   crawl, which is deep into a gap it fits and nowhere at all in one it does
   not.

   CLEAR OF THE BLOCKS TO START WITH, which is a separate point and cost a run to
   find. Dropped with its nose already between the two walls, a car is in a state
   no player can reach — the resolver's "you were already buried, here is a way
   out" branch takes over, and over six seconds of throttle it worms ten metres
   in. The report is about driving AT a gap, so that is what this does. */
const CHARGE = `async (cx) => {
  traffic.length = 0; cops.length = 0; P.wanted = 0;
  window.__tp(cx, -14, -Math.PI / 2);           // a car's length clear, facing into it
  P.car.hp = 100; P.car.vx = P.car.vy = 0;
  const t0 = window.__simT();
  let buried = 0, frames = 0;
  while (window.__simT() - t0 < 6) {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    await new Promise(r => requestAnimationFrame(r));
    frames++;
    if (typeof window.__bodyInWall === 'function' && window.__bodyInWall()) buried++;
  }
  window.__setInput(null);
  return { y: +P.car.y.toFixed(1), hp: Math.round(P.car.hp), buried, frames,
           carW: +P.car.w.toFixed(2) };
}`;
out.charge = {};
for (const { g, cx } of GAPS)
  out.charge['g' + g] = await p.evaluate(([src, x]) => eval('(' + src + ')')(x), [CHARGE, cx]);
const into = k => +(FRONT - out.charge[k].y).toFixed(1);      // metres past the front face
out.enteredM = { g1_2: into('g1.2'), g2_6: into('g2.6'), g5: into('g5') };
/* A METRE. The nose can touch the front of the blocks — it is driving into
   them — but nothing may get INTO a slot narrower than the car. Against the
   shipped build's 108 m this is not a close call. */
out.narrowGapIsAWall = out.enteredM.g1_2 < 2 && out.charge['g1.2'].buried === 0;
/* AND THE WIDE ONES STILL LET YOU THROUGH, which is the half that stops this
   being passed by a car that has simply stopped working. Twenty metres in is
   well past any resolver overshoot and well short of the 70 m the gap runs. */
out.wideGapsStillOpen = out.enteredM.g2_6 > 12 && out.enteredM.g5 > 12;
// and no part of the car was ever inside a wall in any of the three
out.neverInsideAWall = Object.values(out.charge).every(c => c.buried === 0);

/* ---------- 2. and the same for the cars that are not yours ---------- */
/* "For me and for other cars too". They share buildingCollide, so this is a
   check that the shared thing is what was changed rather than the player's copy
   of it — the report is about a city where a police car can follow you into a
   slot no car fits in. */
/* DRIVEN THROUGH THE SAME TWO CALLS updateTraffic makes — drive() then
   buildingCollide() — on a car that is deliberately NOT in the traffic list, so
   the game loop is not fighting the test for its velocity. That is the honest
   way to ask this: the sequence is the game's, the car is a real one out of
   makeCar, and only the route is the test's idea. */
out.ai = await p.evaluate(cx => {
  const t = makeCar(cx, -14, -Math.PI / 2, 'traffic');
  t.accel = 14; t.maxSpeed = 20; t.road = true;
  let buried = 0;
  for (let i = 0; i < 480; i++) {              // eight seconds at the fixed step
    drive(t, 1, 0, 0, 0, 1 / 60);
    buildingCollide(t);
    if (typeof window.__bodyInWall === 'function' && window.__bodyInWall(t)) buried++;
  }
  return { y: +t.y.toFixed(1), buried, w: +t.w.toFixed(2) };
}, GAPS[0].cx);
out.aiCarIsStoppedToo = FRONT - out.ai.y < 2 && out.ai.buried === 0;

/* ---------- 3. touching a wall slowly costs nothing ---------- */
/* Two runs at the same wall, one at manoeuvring pace and one at speed. The
   claim is a threshold, so it needs both sides of it: a build with damage
   switched off entirely would pass the first half on its own. */
const NUDGE = `async (spd) => {
  traffic.length = 0; cops.length = 0; P.wanted = 0;
  window.__tp(-200, 10, -Math.PI / 2);
  P.car.hp = 100; P.bldCd = 0;
  const t0 = window.__simT();
  let hit = false;
  while (window.__simT() - t0 < 2.5) {
    // held at the asked-for speed rather than accelerated to it, so the contact
    // happens at a known number instead of at whatever the run built up to
    if (P.car.y > -18) { P.car.vx = 0; P.car.vy = -spd; }
    await new Promise(r => requestAnimationFrame(r));
    if (P.car.hp < 100) hit = true;
  }
  return { hp: Math.round(P.car.hp), hit, y: +P.car.y.toFixed(1) };
}`;
out.slow = await p.evaluate(src => eval('(' + src + ')')(6), NUDGE);     // 21 km/h
out.fast = await p.evaluate(src => eval('(' + src + ')')(22), NUDGE);    // 79 km/h
out.slowContactIsFree = out.slow.hp === 100;
out.fastContactStillHurts = out.fast.hp < 100;

/* ---------- 4. the spider ---------- */
/* THE BUTTON IS NOT THERE UNTIL YOU ARE STUCK, and that is the feature rather
   than a detail of it: a rescue you can press at any moment is a teleport. */
out.parked = await p.evaluate(async () => {
  window.__tp(0, 4, 0);
  P.car.vx = P.car.vy = 0;
  P.wedgeT = 0;
  const t0 = window.__simT();
  // sitting still, hands off — a car parked on purpose must never be towed
  while (window.__simT() - t0 < 9) {
    window.__setInput({ gas: 0, brake: 0, steer: 0, hand: 0 });
    await new Promise(r => requestAnimationFrame(r));
  }
  window.__setInput(null);
  return window.__pauk ? window.__pauk() : { wedgeT: 99, shown: true, towing: true };
});
out.parkedCarIsLeftAlone = out.parked.wedgeT < 1 && !out.parked.shown && !out.parked.towing;

// and then wedged: throttle held against a wall that is not going anywhere
out.wedged = await p.evaluate(async () => {
  window.__tp(-200, -17, -Math.PI / 2);       // nose in the 1.2 m slot
  P.car.vx = P.car.vy = 0;
  P.wedgeT = 0;
  const t0 = window.__simT();
  while (window.__simT() - t0 < 7) {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    await new Promise(r => requestAnimationFrame(r));
  }
  window.__setInput(null);
  return window.__pauk ? window.__pauk() : { wedgeT: 0, shown: false, arm: 5 };
});
out.stuckRaisesTheButton = out.wedged.wedgeT > out.wedged.arm && out.wedged.shown;

/* AND WHAT IT DOES. Called rather than tapped for the tow itself — the button's
   own click is checked below on a second page — because what is under test here
   is the money, the station and the screen. */
out.tow = await p.evaluate(async () => {
  if (!window.__callPauk) return { called: false, cash: -1, big: null, sub: null,
                                   livery: null, closest: 1e9, from: { x: 0, y: 0 },
                                   at: { x: 0, y: 0 }, station: null, after: { towing: true } };
  window.__setCash(500);
  const station = window.__nearestPOI('police');
  const from = { x: P.car.x, y: P.car.y };
  const called = window.__callPauk();
  const mid = window.__pauk();
  // the truck has the respawn's own two and a bit seconds to arrive
  const t0 = window.__simT();
  let closest = 1e9;
  while (window.__simT() - t0 < 3.4) {
    await new Promise(r => requestAnimationFrame(r));
    const s = window.__pauk();
    if (s.tow) closest = Math.min(closest, s.tow.d);
  }
  return { called, cash: window.__cash(), big: mid.big, sub: mid.sub,
           livery: mid.tow && mid.tow.livery, closest: +closest.toFixed(1),
           from, at: { x: +P.car.x.toFixed(1), y: +P.car.y.toFixed(1) },
           station: station && { x: +station.x.toFixed(1), y: +station.y.toFixed(1) },
           after: window.__pauk() };
});
out.chargedAHundred = out.tow.called && out.tow.cash === 400;
/* CARRIED TO THE STATION, not to the middle of nowhere. Measured against where
   the station actually is rather than against a coordinate typed in here, and
   against where the car WAS, so a build that simply did not move it fails. */
const dTo = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
out.carriedToTheStation = !!out.tow.station &&
  dTo(out.tow.at, out.tow.station) < 130 &&
  dTo(out.tow.from, out.tow.at) > 200;
// the spider itself came, and it is the lorry
out.spiderCame = out.tow.livery === 'lorry' && out.tow.closest < 12;
// and it drove out of the world again rather than being left in the traffic
out.spiderLeaves = !out.tow.after.towing;

/* NOTHING TO PAY IF YOU HAVE NOTHING. Asked for in as many words, and it is what
   makes the button a promise: it can never leave you worse off than stuck. */
out.broke = await p.evaluate(async () => {
  if (!window.__callPauk) return { called: false, cash: -1, big: null, sub: null };
  window.__setCash(0);
  window.__tp(-200, -17, -Math.PI / 2);
  const called = window.__callPauk();
  const s = window.__pauk();
  const t0 = window.__simT();
  while (window.__simT() - t0 < 3.4) await new Promise(r => requestAnimationFrame(r));
  return { called, cash: window.__cash(), big: s.big, sub: s.sub };
});
out.freeWhenBroke = out.broke.called && out.broke.cash === 0;

/* ---------- 5. and it says so, in Serbian ---------- */
out.english = out.tow.big;
await p.close(); await ctx.close();
const sr = await boot('sr');
out.serbian = await sr.p.evaluate(async () => {
  window.__tp(0, 4, 0);
  window.__setCash(500);
  if (!window.__callPauk) return { big: null, sub: null, lang: null };
  window.__callPauk();
  const s = window.__pauk();
  return { big: s.big, sub: s.sub, lang: (typeof LANG !== "undefined" ? LANG : null) };
});
/* THE EXACT WORDS. "PAUK NOSI!" was asked for by name — a translation that says
   something reasonable but different is a fail, because the joke IS the words. */
out.serbianSaysPaukNosi = /PAUK NOSI/.test(out.serbian.big || '');
out.englishIsNotSerbian = !!out.english && out.english !== out.serbian.big;
/* AND THE BUTTON REALLY IS A BUTTON. Tapped for real, on a page where nothing
   has called pauk() by hand: the handler is the one thing every section above
   goes around. */
/* THE TOW ABOVE LEFT THE GAME MID-RESPAWN, and pauk() correctly refuses to fire
   twice — so this waits for the car to come round before pressing anything. The
   first version of this section did not, tapped into a dead player, and read the
   refusal as a button that does nothing. */
await sr.p.waitForFunction(() => !window.__p().dead, null, { timeout: 15000 });
const hasPauk = await sr.p.evaluate(() => !!document.getElementById('paukBtn'));
out.tapped = await sr.p.evaluate(async has => {
  window.__tp(0, 4, 0);
  window.__setCash(500);
  if (has) document.getElementById('paukBtn').classList.add('on');
  return { before: window.__cash(), dead: window.__p().dead };
}, hasPauk);
if (hasPauk) {
  await sr.p.tap('#paukBtn');
  await sr.p.waitForTimeout(400);
}
out.tapped.after = await sr.p.evaluate(has =>
  ({ cash: window.__cash(), s: has ? window.__pauk() : { big: null } }), hasPauk);
out.buttonWorks = out.tapped.after.cash === out.tapped.before - 100 &&
                  !!out.tapped.after.s.big;
out.errs = errs.concat(sr.errs).slice(0, 5);
await sr.p.close(); await sr.ctx.close();

out.failing = Object.keys(out).filter(k => out[k] === false);
out.pass = out.narrowGapIsAWall && out.wideGapsStillOpen && out.neverInsideAWall &&
           out.aiCarIsStoppedToo && out.slowContactIsFree && out.fastContactStillHurts &&
           out.parkedCarIsLeftAlone && out.stuckRaisesTheButton && out.chargedAHundred &&
           out.carriedToTheStation && out.spiderCame && out.spiderLeaves &&
           out.freeWhenBroke && out.serbianSaysPaukNosi && out.englishIsNotSerbian &&
           out.buttonWorks && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
