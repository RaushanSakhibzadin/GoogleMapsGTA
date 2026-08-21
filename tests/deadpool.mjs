/* THE REPORTED SESSION WHERE THERE WERE NO BUILDINGS.

   Six Overpass mirrors. From the phone's own log, over 285 seconds:

     api.de           unreachable   11 / 11
     osm.jp           unreachable   11 / 11
     private.coffee   unreachable   11 / 11
     kumi.systems     unreachable   11 / 11
     osm.ch           empty body    11 / 11   (200, zero elements, ~250 ms)
     maps.mail.ru     the only real one — 5 × 504, 4 × timeout, 6 successes

   Four hosts this browser could not reach at all, one serving an empty database,
   and one genuine mirror that was slow and overloaded. Buildings never once
   arrived: `buildings: 0`, `parks: 0`, and a player driving around a city made
   of roads and nothing else.

   THE QUEUE ORDER WAS ALREADY CORRECT and it did not help. Health sorting put
   the good host in front — but every request still had to walk PAST the dead
   ones to reach it, at 100 to 1200 ms each, on every single query, because a
   host that is merely demoted is still a host that gets asked. Five wasted
   attempts per request, on a load that issues a dozen.

   So this test does not measure ordering. It measures how many times a host that
   has already proved itself useless is contacted at all.

   THE A/B IS THE PARKING, verified by running this file against a build with
   mirrorPark() stubbed out. Dead hosts are contacted 8 times without it and 4
   with it, and both figures repeat exactly across runs. Nothing here calls
   mirrorPark() itself. */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

function streets() {
  const els = [];
  let id = 1;
  for (const y of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `EW ${y}` },
               geometry: [toLL(-800, y), toLL(800, y)] });
  for (const x of [-600, -300, 0, 300, 600])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
               geometry: [toLL(x, -800), toLL(x, 800)] });
  return { elements: els };
}
function arterials() {
  const els = [];
  let id = 5000;
  for (const y of [-12000, 0, 12000])
    els.push({ type: 'way', id: id++, tags: { highway: 'trunk', name: `Trunk ${y}` },
               geometry: [toLL(-30000, y), toLL(30000, y)] });
  for (const x of [-12000, 0, 12000])
    els.push({ type: 'way', id: id++, tags: { highway: 'primary', name: `Prim ${x}` },
               geometry: [toLL(x, -30000), toLL(x, 30000)] });
  els.push({ type: 'node', id: 9999, ...toLL(0, 0), tags: { place: 'city', name: 'Beograd' } });
  return { elements: els };
}
/* Real buildings, so "did any arrive" is a question about the network rather
   than about the fixture. A block per junction over the streets above. */
function buildings() {
  const els = [];
  let id = 20000;
  for (const x of [-600, -300, 0, 300, 600]) for (const y of [-600, -300, 0, 300, 600]) {
    const o = 26;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '5' },
               geometry: [toLL(x + 8, y + 8), toLL(x + 8 + o, y + 8),
                          toLL(x + 8 + o, y + 8 + o), toLL(x + 8, y + 8 + o),
                          toLL(x + 8, y + 8)] });
  }
  return { elements: els };
}
const EMPTY = { elements: [] };

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
}));

await p.goto(GAME);
await p.waitForTimeout(250);
// the mirror list is shuffled per session, so the roles are read off the live page
const order = await p.evaluate(() => OVERPASS.slice());
const role = {};
role[order[0]] = 'dead';
role[order[1]] = 'dead';
role[order[2]] = 'hollow';       // 200, and an element list of length zero
role[order[3]] = 'dead';
role[order[4]] = 'dead';
role[order[5]] = 'good';         // the only one that works, and it is last

const hits = [];
const t0 = Date.now();
await p.route('**/api/interpreter', async r => {
  const url = r.request().url();
  const who = order.find(u => url.startsWith(u.split('/api/')[0])) || url;
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  hits.push({ role: role[who] || '?', kind, at: Date.now() - t0 });
  switch (role[who]) {
    case 'dead':
      /* UNREACHABLE TAKES TIME, and that detail is the test. Playwright's abort
         is instantaneous, and with it the whole cost of walking past five dead
         hosts is zero — the first version of this measured 0 ms wasted both with
         parking and without, and proved nothing. On the reported network these
         failures took between 100 and 1200 ms each: a DNS lookup, a TCP connect
         that goes nowhere, a CORS preflight nobody answers. 350 ms is the middle
         of that, and it is what turns "five hosts in the way" into a number. */
      await new Promise(res => setTimeout(res, 350));
      return r.abort('failed');                      // fetch() rejects with a TypeError
    case 'hollow':
      await new Promise(res => setTimeout(res, 250));   // it was fast, and useless
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(EMPTY) });
    default: {
      /* Slow, like the real one was. Enough to be clearly the expensive step
         without pushing any request past its own deadline. */
      await new Promise(res => setTimeout(res, 900));
      const body = kind === 'streets' ? streets() : kind === 'arterials' ? arterials()
                 : kind === 'buildings' ? buildings() : EMPTY;
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
  }
});

const out = {};
await p.click('#go');
out.played = await p.waitForFunction(() => window.__s && window.__s() === 'play', null,
  { timeout: 60000 }).then(() => true, () => false);

// drive, so the streamed tiles and their buildings are asked for too
if (out.played) {
  await p.evaluate(() => window.__setInput({ gas: 1 }));
  await p.waitForTimeout(14000);
  await p.evaluate(() => window.__setInput({ gas: 0 }));
}

/* ---- 1. the useless hosts stop being asked ---- */
/* THIS IS THE ONE THAT DISCRIMINATES. Four dead hosts are contacted 8 times
   across the load without parking and 4 times with it, and both numbers repeat
   exactly run to run, so the threshold sits between two measurements rather than
   above a noise floor.

   It is 4 rather than 4 = one each because the requests that open a load are
   issued together, before any of them has come back to teach the queue anything;
   after that first round the dead hosts are parked and are not asked again. */
const count = {};
for (const h of hits) count[h.role] = (count[h.role] || 0) + 1;
out.asks = count;
out.deadAsks = count.dead || 0;
out.hollowAsks = count.hollow || 0;
out.stopsAskingTheDead = out.deadAsks <= 6 && out.hollowAsks <= 4;

/* ---- 2. the buildings actually arrive ---- */
/* The point of the whole thing. In the reported session this was zero. */
out.world = await p.evaluate(() => window.__w());
out.buildingsArrived = out.world.buildings > 0;

/* ---- 3. and the request that matters gets to the good mirror quickly ---- */
/* A GUARD, NOT PART OF THE A/B, and worth saying so plainly: this reads 0 ms
   with parking and 0 ms without it. By the time buildings are asked for, the
   streets request has already succeeded and the health sort alone puts the good
   host first, so there is nothing to walk past and nothing for parking to save.
   It stays because "the buildings query reaches a working mirror immediately" is
   a property worth keeping, but it is not evidence for the fix. */
const bld = hits.filter(h => h.kind === 'buildings');
const firstBld = bld.length ? bld[0].at : null;
const goodBld = bld.find(h => h.role === 'good');
out.buildings = { attempts: bld.length, firstAt: firstBld,
                  reachedGoodAt: goodBld ? goodBld.at : null,
                  wastedMs: goodBld && firstBld !== null ? goodBld.at - firstBld : null };
out.reachesGoodMirrorFast = out.buildings.wastedMs !== null && out.buildings.wastedMs < 1500;

/* ---- 4. the parks say what happened, and survive a reload ---- */
out.mirrors = await p.evaluate(o => o.map((u, i) => ({
  i, parkedFor: Math.round(Math.max(0, (MIRROR_UNTIL.get(u) || 0) - Date.now()) / 1000),
  miss: MIRROR_MISS.get(u) || 0
})), order);
out.parkedCount = out.mirrors.filter(m => m.parkedFor > 0).length;
// the five that cannot serve are parked; the one that can is not
out.goodStaysOpen = out.mirrors[5].parkedFor === 0;
out.deadAreParked = out.parkedCount >= 4;

await p.goto(GAME);
await p.waitForTimeout(400);
out.afterReload = await p.evaluate(o => ({
  parked: o.filter(u => (MIRROR_UNTIL.get(u) || 0) > Date.now()).length,
  goodParked: (MIRROR_UNTIL.get(o[5]) || 0) > Date.now()
}), order);
out.survivesReload = out.afterReload.parked >= 4 && !out.afterReload.goodParked;

out.errs = errs.slice(0, 4);
out.pass = out.played && out.stopsAskingTheDead && out.buildingsArrived &&
           out.reachesGoodMirrorFast && out.deadAreParked && out.goodStaysOpen &&
           out.survivesReload && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
