/* ASK AGAIN LATER.

   Every failure in this game's loading is a network failure, and network
   failures are moments rather than verdicts. The game has always coped by
   carrying on with less — the offline city instead of the one you asked for, no
   wide map, no garages, bare ground where the buildings should be — and then
   never asking again for the rest of the session. The only cure was to press
   DRIVE a second time and sit through another load.

   Four things can be missing and all four are covered here, each by refusing the
   request during the load and then answering it afterwards:

     the city       every mirror 504s, so you land in the offline city, and the
                    real one has to replace it under you with the cash intact
     the skeleton   the ladder comes back empty, so the world is the opening
                    tiles until the wide map turns up
     the landmarks  no hospital and no police, which is a wasted run with
                    nowhere to send you
     the buildings  a city of streets and bare ground

   AND THE DELAYS ARE THE POINT, not a detail. Overpass gives about two slots per
   IP and answers a burst with 429s, so a retry that hammers would get the host to
   refuse the tile streaming too — trying to recover the map would break the part
   of it that still worked. The schedule is asserted here in seconds, and the
   count is asserted as bounded, because "try again" without either is how a game
   gets a mirror to block it.

   Usage: node tests/retry.mjs
*/
import { chromium, devices } from 'playwright';
import { CHROME, GAME, SHOTS } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4489;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const boxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};
const centreOf = b => ({ x: ((b.w + b.e) / 2 - LON0) * M_LON, y: -((b.s + b.n) / 2 - LAT0) * M_LAT });
const kindOf = q => /"building"/.test(q) ? 'buildings'
                  : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois'
                  : /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
                  : 'streets';

const streetsAt = (cx, cy) => {
  const tag = Math.abs(Math.round(cx / 10) * 100000 + Math.round(cy / 10));
  const els = [];
  for (const dy of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 1e9 + tag * 10 + (dy + 600) / 300,
      tags: { highway: 'residential', name: `EW ${Math.round(cy + dy)}` },
      geometry: [toLL(cx - 900, cy + dy), toLL(cx + 900, cy + dy)] });
  for (const dx of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: 2e9 + tag * 10 + (dx + 600) / 300,
      tags: { highway: 'residential', name: `NS ${Math.round(cx + dx)}` },
      geometry: [toLL(cx + dx, cy - 900), toLL(cx + dx, cy + 900)] });
  els.push({ type: 'node', id: 3e9 + tag, lat: LAT0 - cy / M_LAT, lon: LON0 + cx / M_LON,
             tags: { place: 'suburb', name: 'Savski venac' } });
  return { elements: els };
};
const ring = (x0, y0, x1, y1) =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLL(x, y));
const BUILDINGS = { elements: [
  { type: 'way', id: 70001, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(60, 60, 200, 200) },
  { type: 'way', id: 70002, tags: { building: 'yes', 'building:levels': '3' }, geometry: ring(-240, 60, -80, 200) },
] };
const ARTERIALS = { elements: [
  { type: 'way', id: 90001, tags: { highway: 'motorway', name: 'E75' },
    geometry: [toLL(-55000, -20000), toLL(55000, -20000)] },
] };
const LANDMARKS = { elements: [
  { type: 'node', id: 80001, lat: LAT0 + 0.02, lon: LON0 + 0.01, tags: { shop: 'car_repair', name: 'Servis' } },
  { type: 'node', id: 80002, lat: LAT0 - 0.01, lon: LON0 + 0.02, tags: { amenity: 'hospital', name: 'Bolnica' } },
  { type: 'node', id: 80003, lat: LAT0 + 0.01, lon: LON0 - 0.02, tags: { amenity: 'police', name: 'Policija' } },
] };

const b = await chromium.launch({ executablePath: CHROME });
const out = {};

/* One scenario: `refuse` names the kinds that 504 until the game is running, and
   everything answers normally after that. Returns what the world looked like the
   moment play started and what it looked like once the retries had run. */
async function scenario(name, refuse) {
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  let playing = false, recovered = false;
  const asked = [];

  await p.route('**/nominatim.openstreetmap.org/**', r =>
    r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Savski venac, Beograd' }])));
  await p.route('**/api/interpreter', r => {
    const q = decodeURIComponent(r.request().postData() || '');
    const kind = kindOf(q), box = boxOf(q);
    asked.push({ kind, afterPlay: playing });
    /* Refused until the retry is about to run — NOT merely until play starts.
       Letting the network recover at play start meant the ordinary tile streaming
       could supply the missing thing on its own, and the buildings scenario duly
       "passed" with an empty retry log: the world was fixed, by something else.
       Held down to here, the retry is the only thing that can have done it. */
    if (!recovered && refuse.includes(kind))
      return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' });
    if (kind === 'arterials') return r.fulfill(json(ARTERIALS));
    if (kind === 'pois') return r.fulfill(json(LANDMARKS));
    if (kind === 'buildings') return r.fulfill(json(BUILDINGS));
    const c = box ? centreOf(box) : { x: 0, y: 0 };
    return r.fulfill(json(streetsAt(c.x, c.y)));
  });

  await p.goto(GAME);
  await p.waitForTimeout(250);
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 120000 });
  playing = true;
  const startedAt = Date.now();
  await p.waitForTimeout(400);

  const at0 = await p.evaluate(() => ({
    city: window.__w().name, procedural: window.__w().procedural,
    roads: window.__w().roads, buildings: window.__w().buildings,
    skel: window.__chunks().skel, pois: window.__chunks().pois,
    cash: window.__p().cash, retry: window.__retry(),
  }));

  /* WAIT FOR THE ORIGINAL ATTEMPT TO GIVE UP FIRST.

     Letting the network recover a second after play started did not test this
     feature at all: overpassArea retries its own mirrors with backoff, and the
     landmark sweep and the opening buildings simply succeeded on a later mirror,
     fixing the world by the ordinary route and leaving the retry log empty. Good
     behaviour, no evidence. So the refusal is held until the refused kinds have
     stopped being asked for. Twelve seconds of silence, not five: a refused
     request is not making requests while it sits in its backoff, and buildings
     back off 1.2 x 2^n with a random tail, so five seconds of quiet still had one
     waiting in the wings — it woke, found the network healthy, and filled the
     world in with an empty retry log. Anything arriving after twelve can only
     have come from the scheduler. */
  const refusedAsks = () => asked.filter(a => refuse.includes(a.kind)).length;
  let n = refusedAsks(), last = Date.now(), until = Date.now() + 180000;
  while (Date.now() < until) {
    await p.waitForTimeout(1000);
    const m = refusedAsks();
    if (m !== n) { n = m; last = Date.now(); }
    /* Quiet is not enough on its own. Scenery waits its turn in a SERIAL queue,
       and a refused buildings request can hold that queue for the eighty seconds
       of its own budget while making no requests at all — so twelve seconds of
       silence broke the wait with eight more still lined up behind it, which then
       woke to a healthy network and filled the world in with an empty retry log.
       The queue has to be empty as well. */
    const q = await p.evaluate(() => window.__chunks());
    if (q.side || q.busy || q.preloading) last = Date.now();
    else if (Date.now() - last > 12000) break;
  }
  const quietAfterMs = Date.now();

  /* The schedule is real and long, so the wait is skipped rather than sat
     through — __retryNow only brings the due time forward, it does not bypass a
     single guard around it. Several rounds, since one attempt fixes one thing. */
  recovered = true;
  for (let i = 0; i < 6; i++) {
    await p.evaluate(() => window.__retryNow());
    await p.waitForTimeout(2500);
  }

  const at1 = await p.evaluate(() => ({
    city: window.__w().name, procedural: window.__w().procedural,
    roads: window.__w().roads, buildings: window.__w().buildings,
    skel: window.__chunks().skel, pois: window.__chunks().pois,
    cash: window.__p().cash, onRoad: window.__p().onRoad, retry: window.__retry(),
  }));
  // still a game afterwards, not just a world object with the right fields in it
  const fps = await p.evaluate(() => new Promise(r => {
    let n = 0; const t = performance.now();
    const tick = () => { n++; performance.now() - t < 1200 ? requestAnimationFrame(tick) : r(Math.round(n / 1.2)); };
    requestAnimationFrame(tick);
  }));
  await p.screenshot({ path: `${SHOTS}/shot-retry-${name}.png` });
  await ctx.close();
  return { refused: refuse, atStart: at0, afterRetries: at1, fps,
           gaveUpAfterMs: quietAfterMs - startedAt,
           requestsBeforePlay: asked.filter(a => !a.afterPlay).length,
           errs: errs.slice(0, 4) };
}

// 1. the city itself: everything refused, so the game opens in the offline city
out.city = await scenario('city', ['streets', 'arterials', 'buildings', 'pois']);
// 2. the wide map alone
out.skeleton = await scenario('skeleton', ['arterials']);
// 3. no hospital, no police
out.landmarks = await scenario('landmarks', ['pois']);
// 4. streets, and bare ground
out.buildings = await scenario('buildings', ['buildings']);

/* The schedule, read off the running game rather than off this file: minutes
   apart and bounded, which is the difference between recovering the map and
   getting the mirrors to block the tile streaming as well. */
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p2 = await ctx.newPage();
await p2.goto(GAME);
await p2.waitForTimeout(200);
out.schedule = await p2.evaluate(() => window.__retry().delays);
await ctx.close();
await b.close();

out.pass =
  // 1. the offline city was replaced by the real one, and the money survived
  out.city.atStart.city !== out.city.afterRetries.city &&
  out.city.afterRetries.procedural === false &&
  !!out.city.afterRetries.retry.fellBack === false &&
  /* Named, not counted. The fallback IS a real city — the bundled Belgrade is
     9,465 roads against this fixture's 51 — so "more roads than before" is the
     wrong question and fails on a working swap. The question is whether the
     place asked for is the place being driven, and whether the retry is what
     put them there. */
  /Savski venac/.test(out.city.afterRetries.city) &&
  !/Savski venac/.test(out.city.atStart.city) &&
  out.city.afterRetries.retry.log.some(l => l.kind === 'city' && l.ok) &&
  // 2. the wide map arrived after the fact
  /* THE STAND-IN IS NOT THE ANSWER. This used to read "no skeleton at the
     start", which stopped being the same question the day a refused sweep
     started grafting the bundled city's arterials in rather than leaving the
     player in a 5.5 km box. There IS a wide map at the start now — it is just
     not the real one, and what the retry has to deliver is the real one. */
  (out.skeleton.atStart.skel === null || out.skeleton.atStart.skel.bundled === true) &&
  !!out.skeleton.afterRetries.skel && out.skeleton.afterRetries.skel.bundled === false &&
  // 3. and the garages
  out.landmarks.atStart.pois === 0 && out.landmarks.afterRetries.pois > 0 &&
  // 4. and the buildings
  out.buildings.atStart.buildings === 0 && out.buildings.afterRetries.buildings > 0 &&
  // nothing left asking once there is nothing left to ask for
  out.buildings.afterRetries.retry.wanted === null &&
  out.skeleton.afterRetries.retry.log.some(l => l.kind === 'skeleton' && l.ok) &&
  out.landmarks.afterRetries.retry.log.some(l => l.kind === 'landmarks' && l.ok) &&
  out.buildings.afterRetries.retry.log.some(l => l.kind === 'buildings' && l.ok) &&
  // still running, in every case
  [out.city, out.skeleton, out.landmarks, out.buildings].every(s => s.fps >= 45 && !s.errs.length) &&
  // and the schedule is minutes, not seconds, and it ends
  out.schedule.length <= 4 && out.schedule[0] >= 60000 &&
  out.schedule.every((d, i) => i === 0 || d > out.schedule[i - 1]);

console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
