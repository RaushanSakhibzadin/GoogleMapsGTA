/* "Car get stuck here for some reason": nose to tail with a civilian at 2 km/h,
   throttle down, going nowhere. carsCollide was symmetric, so pushing a stopped
   car you gained accel*dt a frame and handed 0.78 of the closing speed straight
   back — an equilibrium at walking pace that never resolves. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8125, LON0 = 20.4489;                      // Savski venac, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
// one long straight road, so nothing but the other car can be in the way
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Kneza Milosa' },
    geometry: [toLL(-900, 0), toLL(900, 0)] },
  { type: 'way', id: 2, tags: { highway: 'residential', name: 'Cross' },
    geometry: [toLL(0, -900), toLL(0, 900)] },
  { type: 'node', id: 9, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Savski venac' } },
] });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Savski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)) || isArterials(q))
    return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(500);

const out = {};

// the screenshot exactly: one star, a civilian pinned directly ahead, throttle down
async function shove(wanted) {
  return p.evaluate(async w => {
    window.__addWanted(w - window.__p().wanted);
    /* IN CONTACT and at rest, which is the reported state. Contact radius is
       (la+lb)*0.34, about 3 m between centres — parking the car 9 m back just
       lets it get a run-up and ram its way through, which never reproduced. */
    window.__tp(-200, 0, 0);                       // facing east along the road
    window.__putTraffic(0, -197.4, 0, 0);          // 2.6 m ahead: already overlapping
    window.__hpById(window.__cars().traffic[0].id, 100);
    await new Promise(r => requestAnimationFrame(r));
    const x0 = window.__p().x;
    const t0 = performance.now();
    let best = 0;
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const q = window.__p();
        best = Math.max(best, q.spd);
        performance.now() - t0 < 5000 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const q = window.__p();
    window.__setInput(null);
    return { wanted: w, movedM: +(q.x - x0).toFixed(1), topKmh: Math.round(best * 3.6),
             endKmh: Math.round(q.spd * 3.6) };
  }, wanted);
}
out.clearRoad = await shove(0);
/* The escape itself, tested directly. Boxing the car in with four cars held
   rigidly in place is not a fair test — no escape exists from that, and a real
   wedge is never that tight. So: hold the throttle while the car's velocity is
   forced to zero every frame, which is what being pinned feels like whatever the
   cause, and see whether it still works its way out. Without the escape the car
   cannot move at all; with it, it eases forward. */
out.heldStill = await p.evaluate(async () => {
  window.__tp(-200, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  const x0 = window.__p().x;
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p();
      window.__tp(q.x, q.y, q.h);            // same place, velocity killed: pinned
      performance.now() - t0 < 5000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { crept: +(q.x - x0).toFixed(2) };
});
// ~1.2 m per nudge, a nudge every 1.3 s — three or more over five seconds
out.escapesAWedge = out.heldStill.crept > 2.5;
out.wantedOneStar = await shove(1);
// 4 s of full throttle has to actually go somewhere — 2 km/h nose-to-tail is the bug
out.getsPast = out.clearRoad.movedM > 60 && out.wantedOneStar.movedM > 60 &&
               out.wantedOneStar.topKmh > 40;

// and a head-on shunt must still hurt both, i.e. mass didn't break the crashes
out.headOn = await p.evaluate(async () => {
  window.__tp(0, -300, 0);
  window.__putTraffic(0, 0, 0, 0, null, 15, 0);
  window.__putTraffic(1, 9, 0, Math.PI, null, -15, 0);
  window.__setCarHp('traffic', 0, 100); window.__setCarHp('traffic', 1, 100);
  const ids = window.__cars().traffic.slice(0, 2).map(t => t.id);
  const low = { [ids[0]]: 100, [ids[1]]: 100 };
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      for (const t of window.__cars().traffic) if (t.id in low) low[t.id] = Math.min(low[t.id], t.hp);
      performance.now() - t0 < 1800 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  return { lowest: ids.map(i => low[i]), bothHurt: ids.every(i => low[i] < 100) };
});

await p.screenshot({ path: `${OUT}/shot-stuck.png` });
out.errs = errs.slice(0, 4);
out.pass = out.getsPast && out.escapesAWedge && out.headOn.bothHurt && !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
