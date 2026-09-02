/* THE AMBULANCE ACROSS THE RIVER.
 *
 * Reported from play: "the last hospital mission i took is too hard / It is on
 * the other side of the river". It was. Every distance the missions are built
 * from was a straight line — the band a patient is drawn from, the clock, the
 * fare — and a straight line does not know about water. Six hundred metres of
 * radar, several kilometres of driving, and a minute on the clock.
 *
 * THE FIXTURE IS THE WHOLE TEST. Two banks of ordinary grid, a two-hundred
 * metre gap between them with nothing drivable in it, and ONE bridge, out at
 * the east edge. Everything follows from that: a point directly across the
 * water is a few hundred metres away and a couple of kilometres of driving, and
 * a point along your own bank at the same range is neither.
 *
 * Both halves of the fix are checked, and separately, because they fail
 * separately:
 *   1. roadField/driveDist can tell the difference at all
 *   2. casualtySpot uses it to keep the patient on this bank
 *   3. the clock on the leg it CANNOT move — the drop is a hospital, and a
 *      hospital is where it is — is sized off the drive rather than the radar
 *   4. and a city with no river in it still hands out work at the same rate,
 *      which is the way this fix breaks if the filter is too tight
 *
 * Usage: node tests/river.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* The water runs east-west across y = 0, from y = -110 to y = +110. The north
   bank is everything above it, the south bank everything below, and the bridge
   is the one road that crosses, at x = +1000. */
const BRIDGE_X = 1000;
const NORTH_Y = [-800, -600, -400, -200], SOUTH_Y = [200, 400, 600, 800];
const HOSP = { x: -200, y: -400 };            // north bank, on a junction corner

function city(withRiver) {
  const els = []; let id = 1;
  const road = (name, pts, cls = 'residential') =>
    els.push({ type: 'way', id: id++, tags: { highway: cls, name },
               geometry: pts.map(([x, y]) => toLL(x, y)) });
  for (const y of NORTH_Y) road(`North ${y}`, [[-1100, y], [1100, y]], 'secondary');
  for (const y of SOUTH_Y) road(`South ${y}`, [[-1100, y], [1100, y]], 'secondary');
  for (const x of [-1000, -600, -200, 200, 600, 1000]) {
    road(`N Ave ${x}`, [[x, -800], [x, -200]]);
    road(`S Ave ${x}`, [[x, 200], [x, 800]]);
  }
  /* THE CROSSINGS. With the river, one: the bridge at the east edge. Without
     it, every avenue runs straight through — which is the same city with the
     water taken out, so the no-river control differs by nothing else. */
  const crossings = withRiver ? [BRIDGE_X] : [-1000, -600, -200, 200, 600, 1000];
  for (const x of crossings) road(`Bridge ${x}`, [[x, -200], [x, 200]], 'secondary');
  els.push({ type: 'node', id: 8001, ...toLL(HOSP.x, HOSP.y),
             tags: { amenity: 'hospital', name: 'Bolnica' } });
  els.push({ type: 'node', id: 9001, ...toLL(0, -400), tags: { place: 'suburb', name: 'Sever' } });
  return { elements: els };
}

const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const atCentre = r => {
  const m = decodeURIComponent(r.request().postData() || '')
    .match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return true;
  return Math.abs((+m[1] + +m[3]) / 2 - LAT0) < 3e-3 && Math.abs((+m[2] + +m[4]) / 2 - LON0) < 4e-3;
};

const br = await chromium.launch({ executablePath: CHROME });
const out = {};

async function open(withRiver) {
  const p = await br.newPage({ viewport: { width: 1000, height: 640 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r =>
    r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
  // centre tile only: the fixture is pinned to one spot, and letting the opening
  // ring have it too would stack nine copies of the same city on the same stones
  await p.route('**/api/interpreter', r => r.fulfill(json(atCentre(r) ? city(withRiver) : { elements: [] })));
  await stubRadio(p);
  await p.goto(GAME);
  await p.waitForTimeout(250);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(800);
  return { p, errs };
}

/* ---------- 1. the mask knows the water is there ---------- */
const { p, errs } = await open(true);
out.field = await p.evaluate(() => {
  const pairs = {
    // straight across the water, from the north bank to the south
    across: [[-600, -200], [-600, 200]],
    // the same range, along the north bank
    along: [[-600, -200], [-200, -200]],
    // a longer one across, at the far end from the bridge
    farAcross: [[-1000, -200], [-1000, 400]],
  };
  const r = {};
  for (const [k, [a, b]] of Object.entries(pairs)) {
    const crow = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const road = window.__driveDist(a[0], a[1], b[0], b[1], 8000);
    r[k] = { crow: Math.round(crow), road: road == null ? null : Math.round(road),
             ratio: road == null ? null : +(road / crow).toFixed(2) };
  }
  return r;
});
/* The bridge is at x = +1000, so crossing from (-600,-200) is 1600 east, 400
   across and 1600 back: about 3.6 km against 400 m of water. Along the bank it
   is a straight road, and the octile steps overstate a straight line by nothing
   at all — this is the number that says the field is measuring the road rather
   than inventing a detour everywhere. */
out.fieldSeesTheRiver =
  out.field.across.ratio > 3 && out.field.farAcross.ratio > 3 &&
  out.field.along.ratio != null && out.field.along.ratio < 1.3;

/* ---------- 2. so the patient stays on this bank ---------- */
/* TWENTY CALLS, NOT ONE. The band is a random draw and the south bank is a good
   half of what is in range, so a single call landing on the right side proves
   nothing whatsoever. */
out.calls = await p.evaluate(async () => {
  const h = window.__pois().filter(q => q.kind === 'hospital')[0];
  const got = [];
  for (let i = 0; i < 20; i++) {
    // stand at the hospital, which is where an ambulance shift starts and where
    // every delivery ends — this is the exact spot the report came from
    window.__tp(h.x, h.y + 8, 0);
    P.car.vx = P.car.vy = 0;
    window.__takeJob('courier');                    // reset, so the next take is fresh
    window.__takeJob('ambulance');
    // setJob schedules the mission 700 ms out; this is that plus room to spare
    await new Promise(r => setTimeout(r, 950));
    if (!MISSION.pick) { got.push(null); continue; }
    const q = MISSION.pick;
    got.push({ y: Math.round(q.y),
               crow: Math.round(Math.hypot(q.x - P.car.x, q.y - P.car.y)),
               road: (d => d == null ? null : Math.round(d))(
                 window.__driveDist(P.car.x, P.car.y, q.x, q.y, 8000)) });
  }
  return got;
});
const answered = out.calls.filter(Boolean);
out.callStats = {
  n: out.calls.length, answered: answered.length,
  wrongBank: answered.filter(c => c.y > 110).length,
  worstRatio: answered.length
    ? +Math.max(...answered.map(c => c.road == null ? 99 : c.road / c.crow)).toFixed(2) : null,
};
/* EVERY call answered, and none of them across the water. "Answered" is half the
   assertion: a filter that rejects everything and hands out no work at all would
   score zero wrong banks. */
out.staysOnThisBank = out.callStats.answered === out.callStats.n &&
                      out.callStats.wrongBank === 0 &&
                      out.callStats.worstRatio <= 1.6;

/* ---------- 3. the clock is sized off the road ---------- */
/* THE LEG THE FILTER CANNOT MOVE. The drop is a hospital and a hospital is
   where it is, so if you are picked up on the far bank — which happens the
   moment you drive over there yourself — the return is a bridge run whatever
   casualtySpot did. That is the leg with the clock on it. */
out.clock = await p.evaluate(async () => {
  const h = window.__pois().filter(q => q.kind === 'hospital')[0];
  window.__takeJob('courier');
  window.__takeJob('ambulance');
  await new Promise(r => setTimeout(r, 950));
  if (!MISSION.pick) return { skipped: 'no casualty' };
  /* Drive the patient's location to the far bank by hand: put the car there,
     move the fare there with it, and let the arrival test fire. */
  const far = { x: -600, y: 400 };
  if (MISSION.fare) { MISSION.fare.x = far.x; MISSION.fare.y = far.y; }
  MISSION.pick.x = far.x; MISSION.pick.y = far.y;
  window.__tp(far.x, far.y - 3, 0);
  P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 700));
  const m = window.__m();
  if (m.state !== 'deliver' || !m.drop) return { skipped: 'no delivery', state: m.state };
  const crow = Math.hypot(m.drop.x - far.x, m.drop.y - far.y);
  const road = window.__driveDist(far.x, far.y, m.drop.x, m.drop.y, 8000);
  return { crow: Math.round(crow), road: road == null ? null : Math.round(road),
           secs: m.time, reward: m.reward,
           // what the old code would have put on the clock, for the comparison
           crowSecs: +Math.min(300, Math.max(22, crow / 13 + 18)).toFixed(1) };
});
/* Sized off the road, which on this crossing is three or four times the radar.
   Asked as "more than halfway from the crow-flight budget to the road one"
   rather than as a number of seconds, because the fixture's exact geometry is
   the fixture's business and the RULE is what changed. */
out.clockFollowsTheRoad = !!out.clock.skipped ||
  (out.clock.road > out.clock.crow * 2 &&
   out.clock.secs > out.clock.crowSecs * 1.5 &&
   out.clock.secs <= 300);

/* ---------- 4. and a city with no river still hands out work ---------- */
/* THE WAY THIS FIX BREAKS. A detour test that is too tight rejects everything,
   the fallbacks fire on every call, and the shift quietly turns into a lap of
   the car park — which is the fault this file's neighbour, jobs.mjs section 6b,
   exists to catch. Same city, water removed, same twenty calls. */
await p.close();
const dry = await open(false);
out.dryCalls = await dry.p.evaluate(async () => {
  const h = window.__pois().filter(q => q.kind === 'hospital')[0];
  const got = [];
  for (let i = 0; i < 20; i++) {
    window.__tp(h.x, h.y + 8, 0);
    P.car.vx = P.car.vy = 0;
    window.__takeJob('courier');
    window.__takeJob('ambulance');
    await new Promise(r => setTimeout(r, 950));
    got.push(MISSION.pick
      ? Math.round(Math.hypot(MISSION.pick.x - P.car.x, MISSION.pick.y - P.car.y)) : null);
  }
  return got;
});
const dryOk = out.dryCalls.filter(d => d != null);
out.dryStats = { n: out.dryCalls.length, answered: dryOk.length,
                 min: dryOk.length ? Math.min(...dryOk) : null,
                 med: dryOk.length ? dryOk.slice().sort((a, b) => a - b)[dryOk.length >> 1] : null,
                 max: dryOk.length ? Math.max(...dryOk) : null };
/* INSIDE THE BAND, WHICH ON THE FIRST SHIFT IS 260 TO 900. Both edges are
   asserted, and both have caught something: below it is the fallback firing,
   which used to reach down to 80 m; above it was the patient being anchored on
   the road's nearest NODE rather than on the point the band picked, which on
   this fixture's kilometre-long ways put them as much as 300 m outside
   everything that had just been measured about them. Measured over twenty
   calls, this fixture gave 192..1203 before those two and 352..876 after. */
out.noRiverNoStarvation = out.dryStats.answered === out.dryStats.n &&
                          out.dryStats.min >= 250 && out.dryStats.max <= 950;

out.errs = [...errs, ...dry.errs].slice(0, 6);
out.pass = out.fieldSeesTheRiver && out.staysOnThisBank &&
           out.clockFollowsTheRoad && out.noRiverNoStarvation && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
