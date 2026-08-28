/* THE FOUR SHIFTS: taxi, police, fire brigade and ambulance.
 *
 * Asked for: jobs you take by driving to the right depot and pressing a button
 * with that vehicle on it, with the depots coming from real OpenStreetMap data.
 *
 * WHAT IS ACTUALLY HARD HERE, and what this file is mostly about. The four jobs
 * are four ways to fill one MISSION object in, and everything downstream — the
 * marker on the map, the arrow on the radar, the objective line, the beacon in
 * the chase view — reads that one object. So the risk is not that a shift does
 * nothing; it is that a shift half-works: the button offers a job at the wrong
 * building, the fare walks away while you drive to them, the fire goes out
 * because you drove past it once, the chase target is a car that was already
 * gone. Each of those is a section here.
 *
 * THE DEPOTS ARE THE FIXTURE. A taxi rank, a police station, a fire station and
 * a hospital, tagged the way OpenStreetMap tags them — two as bare nodes and two
 * as building ways, because both forms turn up in a real city and the game has
 * to make a landmark out of either.
 *
 * Usage: node tests/jobs.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (cx, cy, r) =>
  [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]]
    .map(([x, y]) => toLL(x, y));

/* Four depots on the same street, far enough apart that standing at one is
   never standing at another — JOB_RANGE is 22 m and these are 300 apart. */
const TAXI = { x: -600, y: 0 }, POLICE = { x: -200, y: 0 };
const FIRE = { x: 200, y: 0 }, HOSP = { x: 600, y: 0 };

const streets = () => {
  const els = []; let id = 1;
  for (const y of [-200, 0, 200])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Cross ${y}` },
               geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-600, -200, 200, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Avenue ${x}` },
               geometry: [toLL(x, -300), toLL(x, 300)] });
  // two tagged as nodes, two as building ways: both forms exist in the wild
  els.push({ type: 'node', id: 800, ...toLL(TAXI.x, TAXI.y), tags: { amenity: 'taxi', name: 'Taksi stanica' } });
  els.push({ type: 'node', id: 801, ...toLL(POLICE.x, POLICE.y), tags: { amenity: 'police', name: 'MUP' } });
  els.push({ type: 'way', id: 802, tags: { amenity: 'fire_station', building: 'yes', name: 'Vatrogasci', 'building:levels': '2' },
             geometry: ring(FIRE.x, FIRE.y, 26) });
  els.push({ type: 'way', id: 803, tags: { amenity: 'hospital', building: 'yes', name: 'Bolnica', 'building:levels': '4' },
             geometry: ring(HOSP.x, HOSP.y, 30) });
  els.push({ type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } });
  return { elements: els };
};
/* Something to set alight. The fire job looks for a building at least 60 m off,
   so these sit up the side street. */
const BUILDINGS = { elements: [
  { type: 'way', id: 5001, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(-100, 180, 24) },
  { type: 'way', id: 5002, tags: { building: 'yes', 'building:levels': '4' }, geometry: ring(100, 180, 24) },
  { type: 'way', id: 5003, tags: { building: 'yes', 'building:levels': '6' }, geometry: ring(0, -180, 24) }
] };
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(
  json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd', address: { country_code: 'rs' } }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const arterial = /motorway/.test(q) && !/residential/.test(q);
  if (arterial) return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(/"building"/.test(q) ? BUILDINGS : streets()));
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(900);

const out = {};
const at = (x, y) => p.evaluate(([x, y]) => {
  window.__tp(x, y, 0);
  P.car.vx = P.car.vy = 0;
  return null;
}, [x, y]);
// the button is refreshed on the nav tick, ten a second
const settle = () => p.waitForTimeout(320);

/* ---- 1. the depots are on the map at all ---- */
out.depots = await p.evaluate(() => {
  const k = {};
  for (const q of window.__pois()) k[q.kind] = (k[q.kind] || 0) + 1;
  return k;
});
out.fourDepots = ['taxi', 'police', 'fire', 'hospital'].every(k => out.depots[k] >= 1);

/* ---- 2. the button appears at a depot and nowhere else ---- */
/* The offer has to be tied to the BUILDING, not merely to being somewhere: a
   button that is always up is a button that means nothing, and one that offers
   police work at a fire station is worse than none. */
out.offers = {};
await at(0, -100); await settle();
out.offers.away = await p.evaluate(() => window.__job());
for (const [name, pt] of [['taxi', TAXI], ['police', POLICE], ['fire', FIRE], ['ambulance', HOSP]]) {
  await at(pt.x, pt.y + 12);
  await settle();
  out.offers[name] = await p.evaluate(() => window.__job());
}
out.buttonFollowsTheDepot =
  !out.offers.away.shown && out.offers.away.offer === null &&
  ['taxi', 'police', 'fire', 'ambulance'].every(j =>
    out.offers[j].shown && out.offers[j].offer === j) &&
  out.offers.taxi.emoji === '🚕' && out.offers.police.emoji === '🚓' &&
  out.offers.fire.emoji === '🚒' && out.offers.ambulance.emoji === '🚑';

/* ---- 3. pressing it starts that shift, and pressing it again clocks off ---- */
/* Through the real button, and through the browser's own hit test: a handler
   bound to nothing, or a button underneath a thumb pad, would pass every check
   made on setJob alone. */
out.take = await p.evaluate(async () => {
  const el = document.getElementById('jobBtn');
  const b = el.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  /* The emoji inside it is what the hit test lands on, and that is right — the
     click bubbles to the button. What has to hold is that nothing ELSE is on
     top: a thumb pad over this corner would report a pad here. */
  el.click();
  await new Promise(r => setTimeout(r, 900));
  return { pressable: !!hit && el.contains(hit), hitId: hit ? hit.id : null,
           ...window.__job(), state: window.__m().state };
});
await settle();
out.offAgain = await p.evaluate(() => window.__job());
out.pressingItWorks =
  out.take.pressable === true && out.take.id === 'ambulance' &&
  out.take.colour === '#f4f6fa' &&
  // standing at the depot you already work for offers the way out instead
  out.offAgain.offer === 'courier' && out.offAgain.emoji === '📦';

/* ---- 4. each shift hands out its own kind of work ---- */
/* The generators are asked directly here — driving to four depots and waiting
   for each mission to be handed out takes minutes and adds nothing. What the
   button does was settled in section 3. */
out.work = await p.evaluate(async () => {
  const r = {};
  for (const id of ['taxi', 'police', 'fire', 'ambulance', 'courier']) {
    window.__takeJob(id);
    await new Promise(res => setTimeout(res, 900));
    const m = window.__m();
    r[id] = { state: m.state, has: {
      pick: !!MISSION.pick, drop: !!MISSION.drop,
      fire: !!MISSION.fire, chase: !!MISSION.chase, fare: !!MISSION.fare
    } };
  }
  return r;
});
out.everyShiftHasWork =
  out.work.taxi.state === 'pickup' && out.work.taxi.has.pick &&
  out.work.ambulance.state === 'pickup' && out.work.ambulance.has.pick &&
  out.work.fire.state === 'fire' && out.work.fire.has.fire &&
  out.work.police.state === 'chase' && out.work.police.has.chase &&
  out.work.courier.state === 'pickup' && out.work.courier.has.pick;

/* ---- 5. a fare is a person, and they wait ---- */
/* The easy version of a taxi job drops a marker on a road point and calls it a
   passenger, and it looks like one right up until you arrive at an empty kerb.
   So: the fare is taken out of the crowd already walking the pavements, they
   stop walking while they wait, and the street is one person emptier once they
   are in the car. */
out.fare = await p.evaluate(async () => {
  window.__takeJob('taxi');
  await new Promise(r => setTimeout(r, 900));
  if (!MISSION.fare) return { skipped: 'no crowd yet' };
  const who = MISSION.fare;
  const at0 = { x: who.x, y: who.y };
  // three seconds of walking: anyone not waiting for you would have moved
  const t0 = window.__simT();
  await new Promise(r => setTimeout(r, 1200));
  const moved = Math.hypot(who.x - at0.x, who.y - at0.y);
  // and now drive to them
  window.__tp(who.x, who.y - 3, 0);
  P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 700));
  const m = window.__m();
  return { moved: +moved.toFixed(2),
           stillListed: peds.indexOf(who) >= 0, secs: +(window.__simT() - t0).toFixed(1),
           state: m.state, riding: MISSION.riding };
});
/* THAT PERSON is gone from the street, asked of the person rather than of the
   crowd's SIZE — the crowd tops itself back up as you drive, so counting heads
   before and after reports 34 either way and says nothing about whether anybody
   got in the car. */
out.theFareIsAPersonWhoWaits = !!out.fare.skipped ||
  (out.fare.moved < 1 && out.fare.secs > .6 &&
   out.fare.state === 'deliver' && out.fare.riding === true &&
   !out.fare.stillListed);

/* ---- 6. an ambulance ends at a hospital ---- */
out.amb = await p.evaluate(async () => {
  window.__takeJob('ambulance');
  await new Promise(r => setTimeout(r, 900));
  if (!MISSION.pick) return { skipped: 'no casualty' };
  window.__tp(MISSION.pick.x, MISSION.pick.y - 3, 0);
  P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 700));
  const d = MISSION.drop;
  const h = window.__pois().filter(q => q.kind === 'hospital');
  return { state: window.__m().state, drop: d && { x: Math.round(d.x), y: Math.round(d.y) },
           onAHospital: !!d && h.some(q => Math.hypot(q.x - d.x, q.y - d.y) < 1) };
});
out.ambulanceGoesToHospital = !!out.amb.skipped ||
  (out.amb.state === 'deliver' && out.amb.onAHospital);

/* ---- 7. a fire burns down only while you are next to it ---- */
/* The whole shape of the job. Parked inside the reach it comes down; driven
   away it climbs back — otherwise the shift is a series of drive-bys, and a
   check that only measured "it fell" would pass on that. */
out.blaze = await p.evaluate(async () => {
  window.__takeJob('fire');
  await new Promise(r => setTimeout(r, 900));
  const f = MISSION.fire;
  if (!f) return { skipped: 'no building' };
  f.hp = 100;
  window.__tp(f.x, f.y - 10, 0);            // parked at it
  P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 1200));
  const near = f.hp;
  window.__tp(f.x + 400, f.y, 0);           // and well away from it
  P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 1200));
  const away = f.hp;
  return { near: Math.round(near), away: Math.round(away), parts: parts.length };
});
out.fireNeedsYouThere = !!out.blaze.skipped ||
  (out.blaze.near < 90 && out.blaze.away > out.blaze.near && out.blaze.parts > 0);

/* ---- 8. and putting it out pays ---- */
out.paid = await p.evaluate(async () => {
  window.__takeJob('fire');
  await new Promise(r => setTimeout(r, 900));
  const f = MISSION.fire;
  if (!f) return { skipped: 'no building' };
  const cash0 = window.__p().cash, done0 = window.__m().done;
  window.__tp(f.x, f.y - 10, 0);
  P.car.vx = P.car.vy = 0;
  f.hp = 6;                                  // all but out, so this is seconds
  await new Promise(r => setTimeout(r, 1400));
  return { cash0, cash: window.__p().cash, done0, done: window.__m().done,
           state: window.__m().state };
});
out.puttingItOutPays = !!out.paid.skipped ||
  (out.paid.cash > out.paid.cash0 && out.paid.done === out.paid.done0 + 1);

/* ---- 9. the runaway is a car that was on the street ---- */
out.chase = await p.evaluate(async () => {
  window.__takeJob('police');
  await new Promise(r => setTimeout(r, 900));
  const t = MISSION.chase;
  if (!t) return { skipped: 'no traffic' };
  const listed = traffic.indexOf(t) >= 0;
  /* READ BEFORE THE ARREST, because the arrest clears it. Asking afterwards
     reported wanted:false on a pursuit that had just ended correctly — the flag
     is what marks the car during the chase, not a record of one. */
  const wanted = !!t.wanted;
  const cash0 = window.__p().cash;
  t.hp = 8;                                  // beaten: it should give up at once
  await new Promise(r => setTimeout(r, 900));
  return { listed, wanted, stopped: Math.hypot(t.vx, t.vy) < .5,
           cash0, cash: window.__p().cash, state: window.__m().state };
});
out.pursuitEndsInAnArrest = !!out.chase.skipped ||
  (out.chase.listed && out.chase.wanted && out.chase.stopped &&
   out.chase.cash > out.chase.cash0);

/* ---- 10. and the police car is armoured ---- */
/* The half of "special police car" that is not paint. Every source of damage in
   the game funnels through hurtPlayer, so this is asked of that one door. */
out.armour = await p.evaluate(async () => {
  const hit = job => {
    window.__takeJob(job);
    window.__heal();
    const before = window.__p().hp;
    hurtPlayer(40, 'bld');
    const after = window.__p().hp;
    return +(before - after).toFixed(1);
  };
  const courier = hit('courier');
  const police = hit('police');
  window.__takeJob('courier');
  window.__heal();
  return { courier, police };
});
out.policeCarIsArmoured = out.armour.police < out.armour.courier * .6 &&
                          out.armour.police > 0;

out.errs = errs.slice(0, 4);
out.pass = out.fourDepots && out.buttonFollowsTheDepot && out.pressingItWorks &&
           out.everyShiftHasWork && out.theFareIsAPersonWhoWaits &&
           out.ambulanceGoesToHospital && out.fireNeedsYouThere &&
           out.puttingItOutPays && out.pursuitEndsInAnArrest &&
           out.policeCarIsArmoured && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
