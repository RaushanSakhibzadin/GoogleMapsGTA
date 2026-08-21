/* WHEN A MIRROR SAYS "NOT SO FAST", LISTENING TO IT.

   From the reported iPhone session: one host answered 429 and was then asked six
   more times over the following minute — the four skeleton rungs, the landmark
   sweep, two street tiles — and refused every one of them in about two hundred
   milliseconds. It stayed near the front of the queue the whole time, because a
   429 cost it exactly one miss, and every other host was picking up misses of
   its own for being slow under the heavy opening requests. Nobody fell behind
   anybody, so the fastest way to get a refusal kept winning the race.

   A 429 is the one refusal that arrives with instructions. Retry-After says when
   to come back, and the fix is to treat that as a deadline rather than as a
   score — a host that asked for a minute goes behind every host that did not ask
   for anything, however badly those are behaving.

   THE A/B IS BETWEEN TWO REAL SERVER BEHAVIOURS, not between a build and a flag.
   The same scenario runs twice: once where the bad host refuses with 429 and a
   Retry-After, and once where it refuses with 504 — same TRANSIENT class, same
   instant refusal, same single miss, no instruction attached. If the header is
   being honoured the 429 host is asked dramatically fewer times than the 504
   host; if it is not, the two runs are the same load and the counts match. There
   is no test-only switch anywhere in this file, and nothing here calls
   mirrorPark() itself — a test that parks a host by hand and then observes it
   parked proves only that a Map works.

   Verified against a build with the parking removed: `parked` and `ignored` came
   back with the same ask counts (7 and 7), and both parts of section 1 failed. */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;              // the reported session's own coordinates
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
const EMPTY = { elements: [] };

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};

/* One load. `refuse` decides what the first host in the queue does, and nothing
   else changes between runs.

   The other five are the reported session's own cast — a silent host, a gateway,
   a good one at the back — because the fault only appears when the OTHER mirrors
   are also failing. With five healthy mirrors the throttled one drops behind
   them on miss count alone and the header never matters; it is precisely when
   everybody is having a bad evening that a score cannot express "this one told
   us to wait" and a deadline can. */
async function run(label, refuse) {
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
  // the mirror list is shuffled per session, so roles are read off the live page
  const order = await p.evaluate(() => OVERPASS.slice());
  const role = {};
  role[order[0]] = 'bad';          // the one under test
  role[order[1]] = 'silent';
  role[order[2]] = 'gateway';
  role[order[3]] = 'silent';
  role[order[4]] = 'gateway';
  role[order[5]] = 'good';

  const hits = [];
  const t0 = Date.now();
  await p.route('**/api/interpreter', async r => {
    const url = r.request().url();
    const who = order.find(u => url.startsWith(u.split('/api/')[0])) || url;
    const q = decodeURIComponent(r.request().postData() || '');
    const bb = (q.match(/\(([-\d.,]+)\)/) || [])[1] || '';
    hits.push({ role: role[who] || '?', at: Date.now() - t0, ask: bb + '|' + q.slice(0, 40) });
    switch (role[who]) {
      case 'bad':
        return r.fulfill({ status: refuse.status, headers: refuse.headers || {},
                           contentType: 'text/plain', body: 'no' });
      case 'gateway':
        return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' });
      case 'silent':
        return new Promise(() => {});
      default: {
        const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
                   : /"building"/.test(q) ? 'buildings'
                   : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
        const body = kind === 'streets' ? streets() : kind === 'arterials' ? arterials() : EMPTY;
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
    }
  });

  await p.click('#go');
  let played = true;
  try {
    await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 45000 });
  } catch (e) { played = false; }
  /* Ten seconds of driving, because the fault was never about the opening
     request. The bad host refused the FIRST query in every version of this code;
     what the reported session showed is it being asked again for the skeleton,
     the landmarks and the streamed tiles, all of which happen after the loading
     screen has gone. Without this the counts would be one and one. */
  if (played) {
    await p.evaluate(() => window.__setInput({ gas: 1 }));
    await p.waitForTimeout(10000);
    await p.evaluate(() => window.__setInput({ gas: 0 }));
  }

  const count = {};
  for (const h of hits) count[h.role] = (count[h.role] || 0) + 1;
  // the most times any ONE question was put to this host — a retry, as opposed
  // to a different question that happened to go the same way
  const per = {};
  let repeat = 0;
  for (const h of hits) {
    if (h.role !== 'bad') continue;
    const k = h.ask;
    per[k] = (per[k] || 0) + 1;
    if (per[k] > repeat) repeat = per[k];
  }
  const health = await p.evaluate(o => ({
    rank: mirrorsByHealth().indexOf(o[0]),
    of: OVERPASS.length,
    miss: MIRROR_MISS.get(o[0]) || 0,
    parkedFor: Math.max(0, (MIRROR_UNTIL.get(o[0]) || 0) - Date.now())
  }), order);

  /* AND IT SURVIVES A RELOAD, which is the moment it is worth the most. A player
     whose map loaded badly reloads the page, and a fresh page with no memory
     goes straight back to asking the host that just told it to wait a minute.
     The reload is real — a new document, a new script run, the whole health
     record read back out of localStorage. */
  await p.goto(GAME);
  await p.waitForTimeout(400);
  const after = await p.evaluate(o => ({
    rank: mirrorsByHealth().indexOf(o[0]),
    parkedFor: Math.max(0, (MIRROR_UNTIL.get(o[0]) || 0) - Date.now())
  }), order);

  await ctx.close();
  return { label, played, asks: count.bad || 0, repeat, health, after,
           good: count.good || 0, errs: errs.slice(0, 3),
           dbg: hits.filter(h => h.role === 'bad').map(h => h.at + 'ms ' + h.ask.slice(0, 34)) };
}

/* ---- 1. a 429 with Retry-After stops the host being asked again ---- */
out.parked = await run('429 + Retry-After: 120', { status: 429, headers: { 'retry-after': '120' } });
out.ignored = await run('504, no instruction', { status: 504 });

/* Under the old code both runs asked the bad host the same number of times,
   because a 429 and a 504 were the same single miss. The 429 run must now ask it
   ONCE — the query that earned the park — and never again. */
out.stopsAsking = out.parked.asks < out.ignored.asks && out.parked.asks <= 1;
/* And it must land at the very back of the queue, behind hosts with far worse
   miss counts: two of the other five are 504ing repeatedly and have picked up
   several misses each, so a park that were merely a big score would not
   reliably outrank them. */
out.goesLast = out.parked.health.rank === out.parked.health.of - 1 &&
               out.parked.health.parkedFor > 30000;
/* A parked host is not retried on the request that parked it either. Leaving it
   out of the queue governs the NEXT question; this is the one already in flight,
   and without it the 429 was followed by a retry 1.3 s later. The 504 run still
   retries exactly as it always did, which is what shows this is the park talking
   and not retries having been broken across the board. */
out.noDoomedRetry = out.parked.repeat === 1 && out.ignored.repeat > 1;
/* The park is still there after a reload, and the host is still last. */
out.survivesReload = out.parked.after.parkedFor > 30000 &&
                     out.parked.after.rank === out.parked.health.of - 1 &&
                     out.ignored.after.parkedFor === 0;
// both loads still reach a playable city off the good mirror at the back
out.stillLoads = out.parked.played && out.ignored.played;

/* ---- 2. Retry-After's other legal form ---- */
/* HTTP allows Retry-After to be a number of seconds OR an absolute date, and a
   CDN in front of a mirror routinely rewrites one into the other. This was read
   with parseFloat, which returns NaN for a date — and NaN fell through to "no
   delay given", the exact opposite of what the header said.

   It is checked as a parse rather than through a load because the two failures
   are indistinguishable from the outside: an unparseable header and an absent
   one both fall back to the same default park, so a load-level test would pass
   against the broken version. Against parseFloat the date case reads 0. */
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(GAME);
  await p.waitForTimeout(200);
  out.parse = await p.evaluate(() => {
    const d = new Date(Date.now() + 45000).toUTCString();
    return {
      seconds: retryAfterMs('30'),
      spaced: retryAfterMs('  30  '),
      httpDate: Math.round(retryAfterMs(d) / 1000),
      past: retryAfterMs(new Date(Date.now() - 60000).toUTCString()),
      garbage: retryAfterMs('soon'),
      absent: retryAfterMs(null)
    };
  });
  await ctx.close();
}
out.readsBothForms = out.parse.seconds === 30000 && out.parse.spaced === 30000 &&
                     out.parse.httpDate >= 43 && out.parse.httpDate <= 46 &&
                     out.parse.past === 0 && out.parse.garbage === 0 && out.parse.absent === 0;

out.errs = [...out.parked.errs, ...out.ignored.errs];
out.pass = out.stopsAsking && out.goesLast && out.noDoomedRetry && out.survivesReload &&
           out.stillLoads && out.readsBothForms && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
