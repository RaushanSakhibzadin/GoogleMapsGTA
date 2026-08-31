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
/* AND ONE DEPOT SET BACK IN ITS OWN YARD, which is the shape the report came
   from. Measured in the capture from Autokomanda: the nearest way of any kind to
   Ватрогасни савез Београд is 60.5 m, and JOB_RANGE is 22 — the station could
   not be reached by car at all. This one sits 90 m off the nearest street, far
   enough that nothing but its gate can offer the shift. */
const YARD = { x: -400, y: 90 };
/* AND A HOSPITAL SET BACK THE SAME WAY, because an ambulance has the problem
   twice over: the depot it clocks on at and the door it delivers to. Measured in
   the capture from Savski venac, the nearest road to Специјална болница Свети
   Сава is 26 m — the log has the player 8 m from the building, off the tarmac,
   at 11 km/h, which is the off-road crawl. */
const HOSP_YARD = { x: 400, y: -90 };

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
  els.push({ type: 'node', id: 804, ...toLL(YARD.x, YARD.y),
             tags: { amenity: 'fire_station', name: 'Vatrogasni savez' } });
  els.push({ type: 'node', id: 805, ...toLL(HOSP_YARD.x, HOSP_YARD.y),
             tags: { amenity: 'hospital', name: 'Bolnica u dvoristu' } });
  els.push({ type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } });
  return { elements: els };
};
/* Something to set alight. A fire is now a building three hundred to nine
   hundred metres out, so there have to be SEVERAL out there — with one, "picked
   at random from the band" and "always the same building" are indistinguishable,
   which is the thing section 19 is checking. */
const BUILDINGS = { elements: [
  { type: 'way', id: 5001, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(-100, 180, 24) },
  { type: 'way', id: 5002, tags: { building: 'yes', 'building:levels': '4' }, geometry: ring(100, 180, 24) },
  { type: 'way', id: 5003, tags: { building: 'yes', 'building:levels': '6' }, geometry: ring(0, -180, 24) },
  { type: 'way', id: 5004, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(450, -300, 26) },
  { type: 'way', id: 5005, tags: { building: 'yes', 'building:levels': '7' }, geometry: ring(-500, 350, 26) },
  { type: 'way', id: 5006, tags: { building: 'yes', 'building:levels': '4' }, geometry: ring(700, 250, 26) },
  { type: 'way', id: 5007, tags: { building: 'yes', 'building:levels': '6' }, geometry: ring(-350, -450, 26) },
  { type: 'way', id: 5008, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(820, -120, 26) },
  /* AND FOUR OUT PAST A KILOMETRE. Section 26 measures a band that grows with
     the shift, and the eight above all sit within 830 m of the middle — so the
     ramped band came up empty, fell through to the near fallback, and the
     "later" fire measured CLOSER than the first. That was the fixture failing
     to express the thing under test, not the ramp failing to work. */
  { type: 'way', id: 5009, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(1250, 400, 28) },
  { type: 'way', id: 5010, tags: { building: 'yes', 'building:levels': '6' }, geometry: ring(-1400, -300, 28) },
  { type: 'way', id: 5011, tags: { building: 'yes', 'building:levels': '4' }, geometry: ring(600, 1500, 28) },
  { type: 'way', id: 5012, tags: { building: 'yes', 'building:levels': '5' }, geometry: ring(-800, 1700, 28) }
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
const JOB_RANGE_M = 22;      // js/game.js — the radius an offer covers
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
  const near = d ? Math.min(...h.map(q => Math.hypot(q.x - d.x, q.y - d.y))) : 1e9;
  return { state: window.__m().state, drop: d && { x: Math.round(d.x), y: Math.round(d.y) },
           toHospital: Math.round(near), drivable: !!d && onTarmac(d.x, d.y) };
});
/* NOT "within a metre of the hospital", which is what this asked before and what
   the bug was: the drop was the centre of the building, and arrival is within
   eight metres of it, so the last stretch was across a forecourt at the off-road
   crawl. It is at the hospital's door now — near the building and on ground a
   car can actually drive on. */
out.ambulanceGoesToHospital = !!out.amb.skipped ||
  (out.amb.state === 'deliver' && out.amb.toHospital < 130 && out.amb.drivable);

/* ---- 6b. and the patient is across town, not outside the front door ---- */
/* Reported from play: the patients are too close to the hospital. Same fault as
   the fires being sixty metres from the fire station — the casualty was the
   NEAREST pedestrian at least sixty metres off, and you stand at the hospital
   every time a call comes in, both on clocking on and after every delivery,
   because the hospital is the drop.
 *
 * MEASURED FROM BOTH ENDS. From the car, which is what "how far do I drive"
 * means, and from the hospital, which is what was actually complained about;
 * those are the same number only at the instant the shift is taken, so the car
 * is moved away from the hospital before the later calls to separate them.
 *
 * SIX CALLS, not one. The old code took the nearest of a crowd and the new one
 * picks at random inside a band, and one sample cannot tell those apart — a
 * single nearest-first pick can land far away by luck. The minimum across the
 * whole set is what the band promises.
 *
 * AND THE PATIENT MUST SURVIVE THE DRIVE. The crowd is culled at 500 m and the
 * mission ends the moment its person leaves that list, so a call handed out at
 * 900 m would be withdrawn on the next cull without the exemption — which would
 * look exactly like the shift refusing to give out work. */
out.far = await p.evaluate(async () => {
  const h = window.__pois().filter(q => q.kind === 'hospital')[0];
  if (!h) return { skipped: 'no hospital' };
  const calls = [];
  for (let i = 0; i < 6; i++) {
    // stand somewhere real, and after the first pair not on the hospital itself
    if (i >= 2) window.__tp(h.x + 260, h.y + 200, 0); else window.__tp(h.x, h.y, 0);
    P.car.vx = P.car.vy = 0;
    window.__takeJob(i % 2 ? 'ambulance' : 'courier');
    if (i % 2 === 0) continue;                       // courier turn: just resetting
    await new Promise(r => setTimeout(r, 900));
    if (!MISSION.pick) { calls.push(null); continue; }
    calls.push({ fromCar: Math.round(Math.hypot(MISSION.pick.x - P.car.x, MISSION.pick.y - P.car.y)),
                 fromHosp: Math.round(Math.hypot(MISSION.pick.x - h.x, MISSION.pick.y - h.y)),
                 isPerson: !!MISSION.fare, listed: MISSION.fare ? peds.indexOf(MISSION.fare) >= 0 : null });
  }
  // and one of them held while the car drove the other way, past the cull radius
  window.__takeJob('courier'); window.__takeJob('ambulance');
  await new Promise(r => setTimeout(r, 900));
  let survived = null;
  if (MISSION.fare) {
    const who = MISSION.fare;
    window.__tp(who.x + 900, who.y + 700, 0);        // 1.1 km off, well past 500
    P.car.vx = P.car.vy = 0;
    await new Promise(r => setTimeout(r, 900));
    survived = { listed: peds.indexOf(who) >= 0, state: window.__m().state };
  }
  return { calls: calls.filter(Boolean), survived };
});
out.patientsAreAcrossTown = !!out.far.skipped ||
  (out.far.calls.length >= 3 &&
   out.far.calls.every(c => c.fromCar >= 400 && c.fromHosp >= 400 &&
                            c.isPerson === true && c.listed === true) &&
   // the call is not quietly withdrawn when you are a kilometre from the patient
   (!out.far.survived || (out.far.survived.listed && out.far.survived.state === 'pickup')));

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

/* ---- 11. and the passenger gets out again ---- */
/* Asked for after a session of play: the fare vanished at the drop. They were
   taken out of the crowd to be carried and never put back, so every completed
   taxi job quietly deleted a person from the city and the kerb you pulled up at
   was empty.
 *
 * Four things have to hold, and only the first is obvious: they are back in the
 * crowd; they are at the drop rather than wherever the pavement's nearest NODE
 * happened to be — a real OSM way can run 800 m between nodes; they are on the
 * pavement and not standing in the carriageway; and they are WALKING, because a
 * passenger put back with the "waiting for a taxi" flag still set is a statue. */
out.dropOff = await p.evaluate(async () => {
  window.__takeJob('taxi');
  await new Promise(r => setTimeout(r, 900));
  if (!MISSION.fare) return { skipped: 'no crowd yet' };
  const who = MISSION.fare;
  window.__tp(who.x, who.y - 3, 0); P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 700));
  if (window.__m().state !== 'deliver') return { skipped: 'never boarded' };
  const inCar = peds.indexOf(who) < 0 && MISSION.rider === who;
  const d = { x: MISSION.drop.x, y: MISSION.drop.y, h: MISSION.drop.h || 0,
              w: (MISSION.drop.road || {}).w || 6 };
  window.__tp(d.x, d.y, 0); P.car.vx = P.car.vy = 0;   // arrive, and it completes
  await new Promise(r => setTimeout(r, 900));
  /* THE WALK IS A PATH LENGTH SAMPLED OVER THREE SECONDS, not one displacement
     read at the end of a short one. walkPed legitimately spends whole frames not
     moving — arriving at a node, or stepping back from a wall it would otherwise
     walk into — and over 1.4 s that read as a frozen passenger: this measured
     0.00 on one run and 2.16 on the next, on a passenger walking perfectly well
     both times.
     The next fare is handed out during this window. It cannot be this person —
     pickFare ignores anyone closer than 70 m and they are standing at the car —
     so what is measured is a walk and not a fresh job freezing them again. */
  let walked = 0, px = who.x, py = who.y;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    walked += Math.hypot(who.x - px, who.y - py);
    px = who.x; py = who.y;
  }
  /* ACROSS the street, measured against the centreline through the drop rather
     than as a plain distance from the pin — walking a couple of metres along the
     kerb is not stepping into the road, and a plain radius cannot tell the two
     apart. */
  const lat = Math.abs((who.x - d.x) * -Math.sin(d.h) + (who.y - d.y) * Math.cos(d.h));
  return { inCar, listed: peds.indexOf(who) >= 0,
           riding: MISSION.riding, held: !!MISSION.rider, hurt: who.hurt,
           fromDrop: +Math.hypot(who.x - d.x, who.y - d.y).toFixed(1),
           lat: +lat.toFixed(1), halfRoad: d.w / 2,
           walked: +walked.toFixed(2) };
});
out.thePassengerGetsOut = !!out.dropOff.skipped ||
  (out.dropOff.inCar === true && out.dropOff.listed === true &&
   out.dropOff.riding === false && out.dropOff.held === false &&
   out.dropOff.hurt === false &&
   // at the drop, off the tarmac, and moving
   out.dropOff.fromDrop < 25 && out.dropOff.lat > out.dropOff.halfRoad &&
   out.dropOff.walked > .3);

/* ---- 12. clocking on clears the heat ---- */
/* Asked for. Signing for a city vehicle at the counter is not a thing that
   happens with a patrol car still on your tail, and a pursuit that outlives the
   shift it started in follows you into every shift after it. The cars are
   dismissed with the stars — five of them still ramming an ambulance is the same
   problem in a different colour — and the bust timer with them, so you do not
   come out of the station part of the way through an arrest. */
out.heat = await p.evaluate(async () => {
  window.__tp(0, 0, 0);                    // on the cross street, so cops can spawn
  window.__takeJob('courier');
  await new Promise(r => setTimeout(r, 700));
  window.__addWanted(3);
  await new Promise(r => setTimeout(r, 600));
  const before = { wanted: window.__p().wanted, cops: window.__p().cops };
  window.__takeJob('taxi');
  await new Promise(r => setTimeout(r, 300));
  const after = { wanted: window.__p().wanted, cops: window.__p().cops, bustT: P.bustT };
  return { before, after };
});
out.shiftChangeClearsTheHeat =
  out.heat.before.wanted >= 3 && out.heat.before.cops > 0 &&
  out.heat.after.wanted === 0 && out.heat.after.cops === 0 &&
  out.heat.after.bustT === 0;

/* ---- 12b. and it hands you an undamaged one ---- */
/* Asked for: "when I change the job my car should get full hp because it is a
   new car". Clocking on already swaps the body, the livery and the mass, so it
   is a different vehicle — driving a wreck into the hospital and out again as an
   ambulance still on 12% is the old car's dents following you into somebody
   else's van.
 *
 * BOTH DIRECTIONS, because a fix that reads `hp = max(hp, 100)` and a fix that
 * reads `hp = 100` are the same on a damaged car and differ on a healthy one,
 * and neither is what a swap means. Also checked one shift further on, since
 * the interesting case for a courier arriving at a rank is the SECOND change —
 * the first could be the game merely starting you off whole. */
out.fresh = await p.evaluate(async () => {
  const take = async (job, hp) => {
    window.__setHp(hp);
    const before = window.__p().hp;
    window.__takeJob(job);
    await new Promise(r => setTimeout(r, 300));
    return { job, before, after: window.__p().hp };
  };
  return { wrecked: await take('courier', 12),
           second: await take('taxi', 37),
           // a car that was already fine must not be quietly changed either
           healthy: await take('police', 100),
           // and the shift really did change, or the rows above mean nothing
           endedOn: window.__job().id };
});
out.aNewShiftIsANewCar =
  out.fresh.wrecked.before === 12 && out.fresh.wrecked.after === 100 &&
  out.fresh.second.before === 37 && out.fresh.second.after === 100 &&
  out.fresh.healthy.before === 100 && out.fresh.healthy.after === 100 &&
  out.fresh.endedOn === 'police';

/* ---- 13. and running out of time says what was actually lost ---- */
/* Reported from play: an ambulance that ran out of time said PACKAGE LOST. One
   failure line was written for the courier run and then inherited by every shift
   that has a clock. Asked here through the KEYS rather than the English, so it
   holds in all ten languages, and checked with the passenger too — "PATIENT
   LOST" while the patient hops out and strolls off is the same fault the other
   way round. */
out.failed = await p.evaluate(async () => {
  const r = {};
  for (const id of ['courier', 'taxi', 'ambulance']) {
    window.__takeJob(id);
    await new Promise(res => setTimeout(res, 900));
    if (!MISSION.pick) { r[id] = { skipped: 'no work' }; continue; }
    window.__tp(MISSION.pick.x, MISSION.pick.y - 3, 0); P.car.vx = P.car.vy = 0;
    await new Promise(res => setTimeout(res, 700));
    if (window.__m().state !== 'deliver') { r[id] = { skipped: 'never started' }; continue; }
    const who = MISSION.rider;
    document.getElementById('toast').textContent = '';
    MISSION.time = .05;                       // the clock runs out on the next tick
    await new Promise(res => setTimeout(res, 500));
    r[id] = { said: document.getElementById('toast').textContent,
              state: window.__m().state,
              hadRider: !!who, listed: !!who && peds.indexOf(who) >= 0 };
  }
  window.__takeJob('courier');
  return { ...r, want: { courier: txt('toast.tooSlow'), taxi: txt('toast.fareGone'),
                         ambulance: txt('toast.patientLost') } };
});
out.failureFitsTheShift = ['courier', 'taxi', 'ambulance'].every(id =>
  out.failed[id].skipped || out.failed[id].said === out.failed.want[id]) &&
  // three different lines, not one line fetched under three names
  new Set(Object.values(out.failed.want)).size === 3 &&
  // the fare walks off; the patient does not
  (out.failed.taxi.skipped || !out.failed.taxi.hadRider || out.failed.taxi.listed === true) &&
  (out.failed.ambulance.skipped || out.failed.ambulance.listed === false);

/* ---- 14. every shift says its own words ---- */
/* Reported from play: the ambulance said PASSENGER ABOARD. One line written for
   the first shift and inherited by the next, the same fault as PACKAGE LOST, and
   the reason both happened is that the choice was a ternary — "courier or not" —
   which has no room for a third answer. So this walks all three carrying shifts
   through a whole run and reads what was actually on screen at each step.
 *
 * ASKED THROUGH THE KEYS, not the English, so it holds in every language; and
 * pinned to English first, because the toast is read off the page and the page
 * is in whatever language the browser asked for. */
out.words = await p.evaluate(async () => {
  const was = LANG;
  setLang('en');
  const el = document.getElementById('toast'), obj = document.getElementById('objT');
  const r = {};
  for (const id of ['courier', 'taxi', 'ambulance']) {
    window.__takeJob(id);
    await new Promise(res => setTimeout(res, 900));
    if (!MISSION.pick) { r[id] = { skipped: 'no work' }; continue; }
    const pickLine = obj.textContent;
    el.textContent = '';
    window.__tp(MISSION.pick.x, MISSION.pick.y - 3, 0); P.car.vx = P.car.vy = 0;
    await new Promise(res => setTimeout(res, 700));
    if (window.__m().state !== 'deliver') { r[id] = { skipped: 'never started' }; continue; }
    const board = el.textContent, dropLine = obj.textContent;
    const d = { x: MISSION.drop.x, y: MISSION.drop.y };
    el.textContent = '';
    window.__tp(d.x, d.y, 0); P.car.vx = P.car.vy = 0;
    await new Promise(res => setTimeout(res, 700));   // before the next job is handed out
    r[id] = { pickLine, board, dropLine, done: el.textContent };
  }
  window.__takeJob('courier');
  const want = { board: { courier: txt('toast.secured'), taxi: txt('toast.aboard'),
                          ambulance: txt('toast.patientAboard') },
                 done: { courier: txt('toast.delivered'), taxi: txt('toast.droppedOff'),
                         ambulance: txt('toast.patientIn') },
                 hospital: txt('hud.toHospital') };
  setLang(was);
  return { ...r, want };
});
/* The line on screen has the fee in it and the key does not, so both sides are
   normalised: every run of digits and every ${n} becomes one hash. What is being
   compared is which SENTENCE was chosen, not what it was paid. */
const norm = s => String(s).replace(/\$\{n\}|\$?\d+/g, '#');
const said = (id, k) => out.words[id].skipped ||
  norm(out.words[id][k]) === norm(out.words.want[k][id]);
out.eachShiftSaysItsOwnWords =
  ['courier', 'taxi', 'ambulance'].every(id => said(id, 'board') && said(id, 'done')) &&
  // three different lines each, not one line fetched under three names
  new Set(Object.values(out.words.want.board)).size === 3 &&
  new Set(Object.values(out.words.want.done)).size === 3 &&
  // and the ambulance is sent to a hospital, not told to drive to a street
  (out.words.ambulance.skipped || out.words.ambulance.dropLine === out.words.want.hospital) &&
  // the words themselves, in the language this was pinned to
  (out.words.ambulance.skipped ||
   (/PATIENT/.test(out.words.ambulance.board) && !/PASSENGER|PACKAGE/.test(out.words.ambulance.board) &&
    !/PASSENGER|PACKAGE/.test(out.words.ambulance.done)));

/* ---- and in all ten languages ---- */
/* The English is one paste away from being right and the other nine are where a
   shared line actually hides: every locale was written by copying the block
   above it. This asks each language for the three shifts' versions of the same
   four moments and fails if any two of them came back identical, or if any of
   them came back as the key. */
out.locales = await p.evaluate(() => {
  const SETS = {
    board: ['toast.secured', 'toast.aboard', 'toast.patientAboard'],
    done: ['toast.delivered', 'toast.droppedOff', 'toast.patientIn'],
    fail: ['toast.tooSlow', 'toast.fareGone', 'toast.patientLost'],
    pickup: ['hud.pickUp', 'hud.fare', 'hud.casualty'],
    goal: ['hud.deliverPkg', 'hud.driveFare', 'hud.toHospital']
  };
  const was = LANG;
  const langs = [...document.getElementById('lang').options].map(o => o.value);
  const bad = [];
  for (const L of langs) {
    setLang(L);
    for (const k in SETS) {
      const v = SETS[k].map(key => txt(key));
      SETS[k].forEach((key, i) => { if (v[i] === key) bad.push(L + ' ' + key + ': untranslated'); });
      if (new Set(v).size !== v.length) bad.push(L + ' ' + k + ': ' + v.join(' | '));
    }
  }
  setLang(was);
  return { langs: langs.length, bad };
});
out.noShiftBorrowsAnother = out.locales.langs >= 10 && out.locales.bad.length === 0;

/* ---- 15. the pursuit starts a long way off ---- */
/* Reported from play: police work was too easy. The target was picked out of the
   traffic already on the street, and traffic only exists inside the cull radius
   — about 260 m — so "the nearest car in the band" was usually the one in front
   of you. Three runs rather than one, because one could be luck. */
out.pursuit = await p.evaluate(async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    window.__takeJob('courier');
    window.__tp(0, 0, 0); P.car.vx = P.car.vy = 0;   // mid-fixture, roads all round
    await new Promise(r => setTimeout(r, 400));
    window.__takeJob('police');
    await new Promise(r => setTimeout(r, 900));
    const t = MISSION.chase;
    runs.push(t ? { d: Math.round(dist(t.x, t.y, P.car.x, P.car.y)),
                    listed: traffic.indexOf(t) >= 0, wanted: !!t.wanted,
                    onARoad: !!t.road_ } : null);
  }
  window.__takeJob('courier');
  return runs;
});
out.pursuitStartsFarOff = out.pursuit.every(r =>
  r && r.listed && r.wanted && r.onARoad && r.d > 250);

/* ---- 16. and losing it pays nothing ---- */
/* THE OTHER HALF OF MAKING IT DISTANT. "Gone from the traffic list" used to be
   read as "stopped", so the reward landed the moment the target was culled — and
   a target that starts 300 m away is culled the instant you fall behind, which
   would have made the harder version of the job the easier one to farm. */
out.escape = await p.evaluate(async () => {
  window.__takeJob('courier');
  window.__tp(0, 0, 0); P.car.vx = P.car.vy = 0;
  await new Promise(r => setTimeout(r, 400));
  window.__takeJob('police');
  await new Promise(r => setTimeout(r, 900));
  const t = MISSION.chase;
  if (!t) return { skipped: 'no target' };
  const cash0 = window.__p().cash, done0 = window.__m().done;
  document.getElementById('toast').textContent = '';
  t.x = P.car.x + 4000; t.y = P.car.y;          // straight past the leash
  await new Promise(r => setTimeout(r, 600));
  const out2 = { cash0, cash: window.__p().cash, done0, done: window.__m().done,
                 listed: traffic.indexOf(t) >= 0, state: window.__m().state,
                 said: document.getElementById('toast').textContent, want: txt('toast.gotAway') };
  window.__takeJob('courier');
  return out2;
});
out.losingItPaysNothing = !!out.escape.skipped ||
  (out.escape.cash === out.escape.cash0 && out.escape.done === out.escape.done0 &&
   !out.escape.listed && out.escape.said === out.escape.want);

/* ---- 17. only a real smash brings the police ---- */
/* Reported from play: the wanted level went up for every scrape. The bar was 13
   m/s of closing speed, which rear-ending a slower car at speed clears.
 *
 * THE MIDDLE RUN IS THE ONE THAT MATTERS. A light tap never starred you and a
 * head-on always will, so a test of only those two passes just as happily on the
 * old bar as on the new one — it did, first time out. The run that discriminates
 * is the one that lands BETWEEN the two bars, and it is asserted to land there:
 * the closing speed is recovered from the damage ledger (damage is 0.7 of it up
 * to a cap of 18) and checked to be inside 13 to 18, so a staging drift that
 * moved it out of that band would fail here rather than quietly stop testing
 * anything.
 *
 * BOTH RUNS HAVE TO ACTUALLY CONNECT, for the same reason: a bump that MISSED
 * would report no stars just as happily as one that was correctly ignored, so
 * the ledger is read as proof of contact. The crowd is emptied first — running
 * somebody over is worth a whole star on its own and would land in the middle of
 * the measurement. */
out.hits = await p.evaluate(async () => {
  const bump = async (v, gap) => {
    window.__takeJob('courier');
    window.__heal(); window.__dmgReset();
    P.wanted = 0; P.cool = 0; P.hitCd = 0; cops = []; peds = [];
    window.__tp(0, 0, 0);
    if (!traffic.length) return { skipped: 'no traffic' };
    window.__putTraffic(0, gap, 0, Math.PI, null, 0, 0);
    window.__setCarHp('traffic', 0, 100);
    P.car.vx = v; P.car.vy = 0;                 // straight at it, no throttle
    await new Promise(r => setTimeout(r, 900));
    const hit = +(window.__dmg().traffic || 0).toFixed(1);
    return { v, hit, rel: +(hit / .7).toFixed(1), wanted: window.__p().wanted };
  };
  const light = await bump(9, 4);
  const scrape = await bump(19, 6);
  const hard = await bump(45, 8);
  window.__takeJob('courier');
  return { light, scrape, hard };
});
out.onlyStrongHitsAreNoticed = !!out.hits.light.skipped ||
  (out.hits.light.hit > 0 && out.hits.light.wanted === 0 &&
   // the discriminating one: harder than the old bar, softer than the new
   out.hits.scrape.rel > 13 && out.hits.scrape.rel < 18 &&
   out.hits.scrape.wanted === 0 &&
   out.hits.hard.hit > 0 && out.hits.hard.wanted > 0);

/* ---- 18. a depot set back in its own yard is still reachable ---- */
/* THE BUG THIS FILE EXISTS TO CATCH NEXT TIME. The offer was measured from the
   building, and a fire station in a yard is 60 to 90 m from the nearest street —
   so pressing on was something you could only do by driving across the verge at
   the off-road crawl, which is what the player was doing in the log when they
   gave up. The offer now also comes from the depot's GATE: the nearest drivable
   point to it. Parking on the street outside is enough, and parking on the
   street outside is the only thing a car can do. */
out.yard = await p.evaluate(async ([yx, yy]) => {
  const r = {};
  // on the street outside: 90 m from the building, a few metres from its gate
  window.__tp(yx, 0, 0); P.car.vx = P.car.vy = 0;
  await new Promise(res => setTimeout(res, 400));
  r.outside = window.__jobHere();
  r.toBuilding = Math.round(Math.hypot(yx - P.car.x, yy - P.car.y));
  const q = window.__pois().find(o => o.kind === 'fire' && Math.abs(o.y - yy) < 5);
  r.poi = q ? { x: Math.round(q.x), y: Math.round(q.y) } : null;
  /* And a long way from both the building and its gate, where it must not be on
     offer — clear of every OTHER depot too, or this measures the wrong one. */
  window.__tp(yx, -120, 0); P.car.vx = P.car.vy = 0;
  await new Promise(res => setTimeout(res, 400));
  r.downTheRoad = window.__jobHere();
  return r;
}, [YARD.x, YARD.y]);
out.setBackDepotsAreReachable =
  out.yard.outside === 'fire' && out.yard.toBuilding > JOB_RANGE_M &&
  out.yard.downTheRoad === null;

/* ---- 19. and a fire is across town, not next door ---- */
/* Reported from play: the fires were too close to the fire station. They were —
   the nearest building at least 60 m off, handed out while you stand at the
   station. Six runs, because the point is not only that they are far but that
   they VARY: nearest-first inside a band would put every one of them at exactly
   the minimum, which is the same complaint with a different constant. */
out.fires = await p.evaluate(async () => {
  const d = [];
  for (let i = 0; i < 6; i++) {
    window.__takeJob('courier');
    window.__tp(0, 0, 0); P.car.vx = P.car.vy = 0;
    await new Promise(r => setTimeout(r, 350));
    window.__takeJob('fire');
    await new Promise(r => setTimeout(r, 900));
    const f = MISSION.fire;
    d.push(f ? Math.round(Math.hypot(f.x - P.car.x, f.y - P.car.y)) : null);
  }
  window.__takeJob('courier');
  return d;
});
out.firesAreAcrossTown = out.fires.every(d => d !== null && d > 250) &&
  new Set(out.fires).size > 1;

/* ---- 20. the fire is fought from the street, not from inside the building ---- */
/* Reported from play: "I have to come very close to the building." You had to
   come INSIDE it. The reach was 16 m from the CENTRE of the footprint, and half
   the diagonal of an ordinary block is more than that, so the only place the
   game accepted was within the walls — which on a solid building is nowhere.
   The footprint's radius is added on now.
 *
 * MEASURED AT THREE DISTANCES, because "it works closer" and "it works from
 * anywhere" are different bugs: hard against the wall, a bus length clear of it,
 * and far enough away that the fire must still be growing. */
out.reach = await p.evaluate(async () => {
  window.__takeJob('fire');
  await new Promise(r => setTimeout(r, 900));
  const f = MISSION.fire;
  if (!f) return { skipped: 'no building' };
  const at = async d => {
    f.hp = 60;
    // straight out along +x from the fire, which is off the footprint either way
    window.__tp(f.x + d, f.y, 0); P.car.vx = P.car.vy = 0;
    await new Promise(r => setTimeout(r, 900));
    return +(f.hp - 60).toFixed(1);          // negative is going out, positive is growing
  };
  /* THE RADIUS IS TAKEN FROM THE BUILDING, not from the fire, so the three
     distances below are the same on a build that carries the footprint's size
     and on one that does not — otherwise the A/B compares two different
     experiments, and on the older build f.r is undefined, which sends the car
     to NaN and quietly poisons every section after this one. */
  const b = W.buildings.find(q => Math.abs(q.cx - f.x) < 1 && Math.abs(q.cy - f.y) < 1);
  const rad = b ? Math.round(Math.hypot(b.bb.x1 - b.bb.x0, b.bb.y1 - b.bb.y0) * .5) : 0;
  const carried = +(f.r || 0).toFixed(1);
  const wall = await at(rad + 3);
  const street = await at(rad + 12);
  const away = await at(rad + 90);
  window.__takeJob('courier');
  return { rad, carried, wall, street, away };
});
out.foughtFromTheStreet = !!out.reach.skipped ||
  (out.reach.rad >= 8 && out.reach.carried >= 8 &&    // the fire carries its building's size
   out.reach.wall < 0 && out.reach.street < 0 &&   // both work, one of them off the footprint
   out.reach.away > 0);                            // and it is still a reach, not the whole map

/* ---- 21. and you can see it: a bigger fire, black smoke, and a white jet ---- */
/* Three separate reports in one sitting — the fire was invisible, there was no
   smoke, and there was no water. All three are particles, so all three are asked
   of the particle list rather than of the pixels: what matters is that they
   exist, that they are the right colour, and that they are in the right PLACE —
   smoke above the fire and climbing, water leaving the truck and not the
   building. A pixel test could not tell the last one apart at all. */
out.spray = await p.evaluate(async () => {
  window.__takeJob('fire');
  await new Promise(r => setTimeout(r, 900));
  const f = MISSION.fire;
  if (!f) return { skipped: 'no building' };
  f.hp = 90;
  /* Parked clear of the building with the nose pointing at it. The distance is
     worked out from the BUILDING, not from f.r, for the same reason section 20
     does it: on a build with no radius on the fire, f.r is undefined and the
     teleport lands the car at NaN, which turns the whole measurement to
     nonsense instead of to a clean failure. */
  const b = W.buildings.find(q => Math.abs(q.cx - f.x) < 1 && Math.abs(q.cy - f.y) < 1);
  const rad = b ? Math.hypot(b.bb.x1 - b.bb.x0, b.bb.y1 - b.bb.y0) * .5 : 8;
  window.__tp(f.x + rad + 8, f.y, Math.PI, 0);
  P.car.vx = P.car.vy = 0;
  parts.length = 0;
  /* AND WHAT IT COSTS. Three hundred extra particles is the sort of thing that
     looks free until a phone is drawing every one of them as its own path, so
     the frames are counted while the fire is at its worst rather than assumed. */
  let frames = 0;
  const t0 = performance.now();
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await new Promise(r => setTimeout(r, 1200));
  const fps = Math.round(frames / ((performance.now() - t0) / 1000));
  const dark = [], pale = [], flame = [];
  for (const p of parts) {
    const c = parseColour(p.col) || [0, 0, 0];
    const near = Math.hypot(p.x - f.x, p.y - f.y);
    const row = { z: +(p.z || 0).toFixed(1), r: +(p.r || 0).toFixed(1), d: +near.toFixed(1),
                  fromCar: +Math.hypot(p.x - P.car.x, p.y - P.car.y).toFixed(1) };
    if (c[0] > 200 && c[1] > 200 && c[2] > 200) pale.push(row);
    else if (c[0] < 70 && c[1] < 70 && c[2] < 70) dark.push(row);
    else if (c[0] > 200 && c[1] < 180 && c[2] < 120) flame.push(row);
  }
  const top = a => a.length ? Math.max(...a.map(q => q.z)) : 0;
  const big = a => a.length ? Math.max(...a.map(q => q.r)) : 0;
  const nearest = a => a.length ? Math.min(...a.map(q => q.fromCar)) : 1e9;
  window.__takeJob('courier');
  return { fps, live: parts.length,
           smoke: dark.length, water: pale.length, flame: flame.length,
           smokeTop: top(dark), flameTop: top(flame), flameR: big(flame),
           waterFromCar: nearest(pale), flameFromCar: nearest(flame),
           spread: flame.length ? Math.max(...flame.map(q => q.d)) : 0 };
});
out.youCanSeeTheFire = !!out.spray.skipped ||
  (/* the flames: many, and metres across rather than centimetres */
   out.spray.flame > 20 && out.spray.flameR >= 1 &&
   /* smoke, and it is ABOVE the fire — the whole point of it. Higher than the
      flames, which is what makes a column rather than a haze. */
   out.spray.smoke > 20 && out.spray.smokeTop > 4 &&
   out.spray.smokeTop > out.spray.flameTop &&
   /* and the jet, which comes off the truck. Asked as a distance from the CAR:
      white particles centred on the fire would be steam, not a hose. */
   out.spray.water > 15 && out.spray.waterFromCar < 6 &&
   out.spray.waterFromCar < out.spray.flameFromCar &&
   // and the whole blaze still draws at a frame rate
   out.spray.fps >= 45);

/* ---- 22. the appliance weighs what it looks like ---- */
/* Asked for: a bigger mass on the fire shift, and because of it other cars
   destroyed faster and shoved further.
 *
 * THE SAME COLLISION, TWICE. One car is parked, the player is dropped in front
 * of it at a fixed speed, and the run is repeated in the courier's car and in
 * the appliance — so what is compared is one variable. Both the damage dealt and
 * the distance the other car ends up thrown are read, because they are two
 * different mechanisms and the request named both: the damage is scaled by heft
 * in the collision, the throw is partly the impulse (which saturates with mass)
 * and partly the shove that goes with it. */
out.heft = await p.evaluate(async () => {
  const ram = async job => {
    window.__takeJob(job);
    await new Promise(r => setTimeout(r, 400));
    window.__heal();
    P.wanted = 0; P.cool = 0; P.hitCd = 0; cops = []; peds = [];
    window.__tp(0, 0, 0);
    if (!traffic.length) return { skipped: 'no traffic' };
    window.__putTraffic(0, 12, 0, Math.PI, null, 0, 0);
    window.__setCarHp('traffic', 0, 100);
    const id = window.__cars().traffic[0].id;
    const t0 = traffic.find(q => q.id === id);
    /* NOT maxSpeed = 0, which was the first version and measured nothing: the
       speed clamp in drive() applies to a car that has been SHOVED as much as to
       one that is driving, so pinning the target at zero pinned the throw at
       zero too. It is left free to be pushed and given no engine of its own, so
       what is measured is the impulse and nothing else. */
    t0.maxSpeed = 200; t0.accel = 0;
    P.car.vx = 26; P.car.vy = 0;
    await new Promise(r => setTimeout(r, 1400));
    const t = traffic.find(q => q.id === id);
    return { mass: P.car.mass, carX: Math.round(P.car.x), carY: Math.round(P.car.y),
             tX: t ? Math.round(t.x) : null, tY: t ? Math.round(t.y) : null,
             spd: +Math.hypot(P.car.vx, P.car.vy).toFixed(1),
             hp: t ? Math.round(t.hp) : 0, gone: !t,
             thrown: t ? Math.round(Math.hypot(t.x - 12, t.y)) : null,
             mine: Math.round(window.__p().hp) };
  };
  const car = await ram('courier');
  const truck = await ram('fire');
  /* AND THE AMBULANCE, which is the one that was actually reported. It had a
     van's body and no mass at all, so it fell back to the stock 3, heft came out
     at exactly 1, and every line above applied to it as though it were the
     hatchback. massFor() weighs it off its body now, so this is the check that
     a vehicle given a body and no constant still ends up heavy. */
  const van = await ram('ambulance');
  window.__takeJob('courier');
  return { car, truck, van };
});
out.theApplianceIsHeavy = !!out.heft.car.skipped ||
  (out.heft.truck.mass > out.heft.car.mass * 2 &&
   // destroyed faster: less health left, or gone altogether
   (out.heft.truck.gone || out.heft.truck.hp < out.heft.car.hp - 15) &&
   // and shoved further by the same impact
   (out.heft.truck.gone || out.heft.truck.thrown > out.heft.car.thrown + 3) &&
   // the ratio cuts both ways, so the appliance comes off better than the car did
   out.heft.truck.mine > out.heft.car.mine);
/* The van sits between the two, and every part of that has to hold: heavier
   than the car and lighter than the appliance, hitting harder than the car and
   taking less. Stated as a BAND rather than a threshold because the mass is
   derived from the body rather than set by hand — a rule that put it above the
   appliance would be as wrong as the 3 it used to have. */
out.theVanIsHeavyToo = !!out.heft.car.skipped || !out.heft.van || !!out.heft.van.skipped ||
  (out.heft.van.mass > out.heft.car.mass * 1.4 && out.heft.van.mass < out.heft.truck.mass &&
   (out.heft.van.gone || out.heft.van.hp < out.heft.car.hp - 5) &&
   out.heft.van.mine > out.heft.car.mine);

/* ---- 23. and your own side does not arrest you ---- */
/* Asked for: on a police shift, other police should not come after you. The
   shift is a licence to ram a car off the road, and doing what the objective
   asks used to earn a wanted level, a pursuit and an arrest by your colleagues.
 *
 * ASKED OF EVERY SOURCE, not just the one that was already excused. Ramming the
 * pursuit target had a named exception; running somebody over, hitting a
 * civilian and leaning on a patrol car did not, and those are the ones that were
 * still doing it. */
out.onDuty = await p.evaluate(async () => {
  const stars = async job => {
    window.__takeJob(job);
    await new Promise(r => setTimeout(r, 400));
    P.wanted = 0; P.cool = 0; cops = [];
    window.__addWanted(3);                       // the one door every source uses
    await new Promise(r => setTimeout(r, 400));
    return { wanted: window.__p().wanted, cops: window.__p().cops };
  };
  const courier = await stars('courier');
  const police = await stars('police');
  /* And heat that was already up when you clocked on goes with the shift, so a
     pursuit cannot outlive the moment you put the uniform on. */
  window.__takeJob('courier');
  await new Promise(r => setTimeout(r, 300));
  window.__addWanted(3);
  await new Promise(r => setTimeout(r, 300));
  const carried = { wanted: window.__p().wanted, cops: window.__p().cops };
  window.__takeJob('police');
  await new Promise(r => setTimeout(r, 400));
  const cleared = { wanted: window.__p().wanted, cops: window.__p().cops };
  window.__takeJob('courier');
  return { courier, police, carried, cleared };
});
out.yourOwnSideLeavesYouAlone =
  out.onDuty.courier.wanted >= 3 && out.onDuty.courier.cops > 0 &&   // the control
  out.onDuty.police.wanted === 0 && out.onDuty.police.cops === 0 &&
  out.onDuty.carried.wanted >= 3 &&
  out.onDuty.cleared.wanted === 0 && out.onDuty.cleared.cops === 0;

/* ---- 24. an ambulance stops at the door ---- */
/* The same gate the depots use, on the other end of the job. Asked of the two
   shapes a hospital comes in: one that sits on the street, where the door and
   the building are the same place, and one set back in its own grounds, where
   they are ninety metres apart and only one of them can be driven to. */
out.door = await p.evaluate(async ([hx, hy]) => {
  const look = async (x, y) => {
    window.__tp(x, y, 0); P.car.vx = P.car.vy = 0;
    await new Promise(r => setTimeout(r, 300));
    const h = nearestPOI('hospital', P.car.x, P.car.y);
    /* Guarded so this section fails rather than throws on a build without the
       fix: an exception inside evaluate aborts the whole file, which turns one
       clean A/B failure into no A/B at all. */
    const d = typeof hospitalDrop === 'function' ? hospitalDrop() : null;
    return { hospital: h ? { x: Math.round(h.x), y: Math.round(h.y) } : null,
             drop: d ? { x: Math.round(d.x), y: Math.round(d.y) } : null,
             moved: h && d ? Math.round(Math.hypot(d.x - h.x, d.y - h.y)) : null,
             drivable: !!d && onTarmac(d.x, d.y),
             wasDrivable: !!h && onTarmac(h.x, h.y) };
  };
  return { yard: await look(hx, hy - 40), street: await look(600, 40) };
}, [HOSP_YARD.x, HOSP_YARD.y]);
out.ambulancesStopAtTheDoor =
  /* The set-back one: the building itself is not drivable ground, the door is,
     and the door is a long way from the building — which is the whole point. */
  out.door.yard.wasDrivable === false && out.door.yard.drivable === true &&
  out.door.yard.moved > 40 && out.door.yard.moved < 130 &&
  // and the one on the street is not dragged off somewhere else for no reason
  out.door.street.drivable === true && out.door.street.moved < 40;

/* ---- 25. and the runaway cannot hide in a building ---- */
/* Reported from play, on the police shift: the car you are chasing drives into
   a building and cannot be caught. It was never about the pursuit —
   buildingCollide was called for two things, the player and the cruisers, and
   ordinary traffic has driven through walls since there were walls. A runaway
   is an ordinary traffic car; chasing one is simply the first time anybody had
   a reason to watch one closely.
 *
 * BOTH HALVES, because "cars cannot enter buildings" alone would be satisfied
 * by a game that shoves cars out of archways too, and the rule as asked for is
 * "no car inside a building THAT HAS NO ROAD UNDER IT". The fixture has one of
 * each without being arranged to: the block at (-100, 180) is crossed by the
 * street along y = 200, so it is passable, and the one at (450, -300) is not
 * near any of them.
 *
 * Driven, not teleported and measured on the same frame: the car is put in the
 * middle of the footprint and left to run, because the push-out happens in the
 * physics step and a check that reads the position back immediately would pass
 * on a build that does nothing at all. */
out.walls = await p.evaluate(async () => {
  const solid = W.buildings.find(b => !b.passable);
  const arch = W.buildings.find(b => b.passable);
  if (!solid || !traffic.length) return { skipped: 'no solid building or no traffic' };
  const run = async b => {
    /* THE PLAYER PARKS NEXT TO IT FIRST. Traffic is culled by distance from the
       car, and these blocks are nowhere near wherever the previous section left
       it — the first draft measured an object that had been culled two frames
       in and was no longer being updated at all, which reads as "it never moved"
       or as "it moved" depending only on when the cull ran. */
    window.__tp(b.cx + 90, b.cy + 90, 0);
    P.car.vx = P.car.vy = 0;
    await new Promise(r => setTimeout(r, 400));
    const t = traffic[0];
    if (!t) return { skipped: 'no traffic near the block' };
    t.x = b.cx; t.y = b.cy; t.vx = t.vy = 0;
    const startedInside = window.__inside(t.x, t.y);
    await new Promise(r => setTimeout(r, 800));
    return { startedInside, passable: !!b.passable,
             stillListed: traffic.indexOf(t) >= 0,
             endedInside: window.__inside(t.x, t.y),
             leftBy: Math.round(Math.hypot(t.x - b.cx, t.y - b.cy)) };
  };
  return { solid: await run(solid), arch: arch ? await run(arch) : null };
});
out.noCarHidesInABuilding = !!out.walls.skipped ||
  (out.walls.solid.startedInside === true && out.walls.solid.stillListed === true &&
   // put in the middle of a solid block, it is outside again shortly after
   out.walls.solid.endedInside === false && out.walls.solid.leftBy > 5 &&
   /* AND THE ARCHWAY STILL LETS THEM THROUGH. Traffic follows the centrelines
      that made it passable, so a car shoved out of one every frame would be a
      street the traffic cannot use — a worse fault than the one being fixed,
      and invisible without this half. */
   (!out.walls.arch || out.walls.arch.endedInside === true));

/* ---- 26. each shift starts easy and gets harder ---- */
/* Asked for: the first taxi job should be a short hop and every one after it a
   bit further, and the same for the other shifts.
 *
 * MEASURED BY FORCING THE COUNTER, not by playing four jobs through. Completing
 * a run takes a pickup, a drive and a drop, times four, times three shifts —
 * minutes of wall clock in a file that already runs for one, and every one of
 * those drives is a chance for traffic to wreck the staging. JOB_DONE is the
 * one input the ramp reads, so setting it and asking for a fresh job measures
 * the rule itself.
 *
 * THE COUNTER IS PER SHIFT, which is the half that a single-shift check would
 * miss: the tally is not reset by clocking on, so a driver who had run twenty
 * parcels would otherwise be handed a kilometre-long first fare.
 *
 * Distances are noisy — roadPoint draws at RANDOM inside the band, so a single
 * pair can come out backwards without the ramp being wrong. So this samples
 * several times at each step and compares the MEANS, and asks only that the
 * later band is clearly further out, not that every draw is. */
out.ramp = await p.evaluate(async () => {
  const sample = async (job, done, n) => {
    const ds = [];
    for (let i = 0; i < n; i++) {
      window.__takeJob('courier');
      window.__takeJob(job);
      /* Guarded, so this section FAILS rather than throws on a build without
         the ramp: an exception inside evaluate aborts the whole file, which
         turns one clean A/B failure into no A/B at all. Without JOB_DONE the
         distances simply come out flat, which is exactly the finding. */
      if (typeof JOB_DONE !== 'undefined') JOB_DONE[job] = done;
      clearMission();
      newMission();
      await new Promise(r => setTimeout(r, 260));
      /* WHICH LEG IS "THE JOB" DEPENDS ON THE SHIFT, and getting that wrong
         measures nothing. For the fire and the police the target IS the job, so
         it is the distance out to it. For a taxi it is the RIDE: the fare is a
         pedestrian, the crowd only exists within 500 m of the car, and a first
         fare being round the corner is correct — what grows is where they are
         going. Measured from the pickup to the drop, by standing on the pickup
         so the ride actually starts. */
      if (job === 'taxi') {
        const pk = MISSION.pick;
        if (!pk) continue;
        window.__tp(pk.x, pk.y - 3, 0); P.car.vx = P.car.vy = 0;
        await new Promise(r => setTimeout(r, 500));
        const d = MISSION.drop;
        if (d) ds.push(Math.hypot(d.x - pk.x, d.y - pk.y));
        continue;
      }
      const goal = MISSION.pick || MISSION.fire || MISSION.chase;
      if (goal) ds.push(Math.hypot(goal.x - P.car.x, goal.y - P.car.y));
    }
    return ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
  };
  const out = {};
  for (const job of ['taxi', 'ambulance', 'fire']) {
    window.__tp(0, 0, 0); P.car.vx = P.car.vy = 0;
    out[job] = { leg: job === 'taxi' ? 'ride' : 'out to the target',
                 first: await sample(job, 0, 5), later: await sample(job, 6, 5) };
  }
  /* AND THE BAND ITSELF, which is the assertion that actually holds.
   *
   * The distances above are a sample of a RANDOM draw inside the band, and five
   * draws are noisy enough that the unramped build cleared a 1.35x bar on two
   * shifts out of three by luck — only the taxi failed it. A test that passes on
   * the broken build two times in three proves nothing, so the verdict rests on
   * the band, which is arithmetic and has no draw in it; the distances stay as
   * corroboration that the band is actually the thing being drawn from. */
  out.bands = {};
  if (typeof jobBand === 'function' && typeof JOB_DONE !== 'undefined') {
    for (const [job, lo, hi] of [['taxi', 180, 700], ['ambulance', 260, 900], ['fire', 220, 900]]) {
      JOB_DONE[job] = 0; const a = jobBand(job, lo, hi);
      JOB_DONE[job] = 6; const b = jobBand(job, lo, hi);
      JOB_DONE[job] = 0;
      out.bands[job] = { firstLo: Math.round(a.lo), firstHi: Math.round(a.hi),
                         laterLo: Math.round(b.lo), laterHi: Math.round(b.hi),
                         grew: +(b.hi / a.hi).toFixed(2) };
    }
  }
  // and the tally really is kept per shift rather than shared
  window.__takeJob('courier'); window.__takeJob('taxi');
  if (typeof JOB_DONE !== 'undefined') {
    JOB_DONE.taxi = 6; JOB_DONE.fire = 0;
    out.separate = { taxi: JOB_DONE.taxi, fire: JOB_DONE.fire || 0 };
  } else out.separate = { missing: true };
  window.__takeJob('courier');
  return out;
});
out.shiftsRampUp =
  // the band, which is the mechanism and carries no randomness
  ['taxi', 'ambulance', 'fire'].every(j => {
    const b = out.ramp.bands && out.ramp.bands[j];
    return b && b.laterHi > b.firstHi * 1.8 && b.laterLo > b.firstLo * 1.8;
  }) &&
  // and the draws land where the band says, which one noisy sample cannot fake
  // in all three at once
  ['taxi', 'ambulance', 'fire'].every(j =>
    out.ramp[j] && out.ramp[j].first != null && out.ramp[j].later != null &&
    out.ramp[j].later > out.ramp[j].first * 1.35) &&
  out.ramp.separate.taxi === 6 && out.ramp.separate.fire === 0;

out.errs = errs.slice(0, 4);
out.pass = out.fourDepots && out.shiftsRampUp && out.noCarHidesInABuilding && out.theVanIsHeavyToo && out.ambulancesStopAtTheDoor && out.theApplianceIsHeavy && out.yourOwnSideLeavesYouAlone && out.foughtFromTheStreet && out.youCanSeeTheFire && out.setBackDepotsAreReachable && out.firesAreAcrossTown && out.buttonFollowsTheDepot && out.pressingItWorks &&
           out.everyShiftHasWork && out.theFareIsAPersonWhoWaits &&
           out.ambulanceGoesToHospital && out.fireNeedsYouThere &&
           out.puttingItOutPays && out.pursuitEndsInAnArrest &&
           out.policeCarIsArmoured && out.thePassengerGetsOut &&
           out.shiftChangeClearsTheHeat && out.aNewShiftIsANewCar &&
           out.patientsAreAcrossTown &&
           out.failureFitsTheShift &&
           out.eachShiftSaysItsOwnWords && out.noShiftBorrowsAnother &&
           out.pursuitStartsFarOff && out.losingItPaysNothing &&
           out.onlyStrongHitsAreNoticed && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
