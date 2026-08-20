/* THE REPORTED SESSION, REPLAYED: five bad mirrors and one good one at the back.

   From a real iPhone log, twelve seconds in and still on the loading screen. Of
   six Overpass mirrors: one had answered 200 with an empty database, one was
   unreachable and had been retried twice more, one had returned 504 twice, two
   were sitting silent holding their slots, and THE SIXTH HAD NEVER BEEN ASKED.
   The player gave up.

   Nothing about that is a rare alignment — it is six volunteer-run public servers
   on an ordinary evening. So the fault is not that mirrors fail, it is that the
   old scheduler started mirror i at i × 2.2 s and never deviated: a host that
   said no in 400 ms left its slot empty for another 1.8, and the queue took
   eleven seconds to reach the end whatever happened along the way.

   The behaviours below are the log's, one per host, and the good mirror is put
   LAST on purpose — the worst case, and the one that actually happened. Which
   host ends up where is decided by a per-session shuffle, so the order is read
   out of the running page and the roles are assigned to match rather than
   guessed at. */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;              // the log's own coordinates
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

// a small but real-shaped street grid, so the good mirror produces a drivable city
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
/* The wide skeleton, which is also on the loading path — a good mirror that
   answers the streets and then says nothing to the arterials leaves the load
   waiting out every silent host, which is a different fault from the one under
   test here. */
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

/* One run of the reported session. Returns how long the load took and what each
   mirror was asked. */
async function run(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));

  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
  }));

  // the page has to exist before the shuffle can be read off it
  await p.goto(GAME);
  await p.waitForTimeout(250);
  const order = await p.evaluate(() => OVERPASS.slice());

  /* The log's five failures, then the good one. Keyed by host rather than by
     position, because the roles have to survive the shuffle. */
  const role = {};
  role[order[0]] = 'empty';        // 200, and an element list of length zero
  role[order[1]] = 'unreachable';  // never reaches the server at all
  role[order[2]] = 'silent';       // accepts the connection and says nothing
  role[order[3]] = 'gateway';      // 504
  role[order[4]] = 'silent';
  role[order[5]] = 'good';

  const hits = [];
  const t0 = Date.now();
  await p.route('**/api/interpreter', async r => {
    const url = r.request().url();
    const who = order.find(u => url.startsWith(u.split('/api/')[0])) || url;
    /* Tagged with WHICH QUESTION was being asked, not just which host. A load
       sends several independent queries — the streets, the wide skeleton, eight
       ring tiles, the scenery, the landmarks — and each one races the mirrors on
       its own. Counting a host's requests across the whole load therefore counts
       separate questions and calls them retries; the first version of this did
       exactly that and reported three. A retry is the same question to the same
       host twice, so the question has to be part of the key. */
    const q0 = decodeURIComponent(r.request().postData() || '');
    const bb = (q0.match(/\(([-\d.,]+)\)/) || [])[1] || '';
    hits.push({ role: role[who] || '?', at: Date.now() - t0, ask: bb + '|' + q0.slice(0, 40) });
    switch (role[who]) {
      case 'empty':
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(EMPTY) });
      case 'unreachable':
        return r.abort('failed');            // fetch() rejects with a TypeError
      case 'gateway':
        return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' });
      case 'silent':
        return new Promise(() => {});        // held open, answered never
      default: {
        const q = decodeURIComponent(r.request().postData() || '');
        const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
                   : /"building"/.test(q) ? 'buildings'
                   : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
        // scenery and landmarks arrive behind the wheel and hold nothing up
        const body = kind === 'streets' ? streets() : kind === 'arterials' ? arterials() : EMPTY;
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
    }
  });

  await p.click('#go');
  const started = Date.now();
  let played = true;
  try {
    await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 45000 });
  } catch (e) { played = false; }
  const ms = Date.now() - started;

  const first = {};
  for (const h of hits) if (first[h.role] === undefined) first[h.role] = h.at;
  const count = {};
  for (const h of hits) count[h.role] = (count[h.role] || 0) + 1;
  // the most times any ONE question was put to a host of each role
  const per = {}, repeat = {};
  for (const h of hits) {
    const k = h.role + '§' + h.ask;
    per[k] = (per[k] || 0) + 1;
    if (per[k] > (repeat[h.role] || 0)) repeat[h.role] = per[k];
  }

  const world = played ? await p.evaluate(() => window.__w()) : null;
  /* WHERE EACH HOST ENDED UP IN THE QUEUE, read out of the page the session was
     actually run in. This is the part that has to come from the real code path:
     what is under test is which call site pays which cost, and a test that calls
     mirrorNote() itself with a cost of its own choosing proves only that
     addition works. That version passed against a build with the fix removed. */
  const health = await p.evaluate(o => {
    const rank = mirrorsByHealth();
    const miss = {};
    for (const u of o) miss[u] = MIRROR_MISS.get(u) || 0;
    return { rank, miss };
  }, order);
  const byRole = {}, rankOf = {};
  for (const u of order) {
    byRole[role[u]] = (byRole[role[u]] || 0) > health.miss[u] ? byRole[role[u]] : health.miss[u];
    rankOf[role[u]] = Math.min(rankOf[role[u]] === undefined ? 99 : rankOf[role[u]],
                               health.rank.indexOf(u));
  }
  await ctx.close();
  return { label, played, ms, firstAsked: first, asks: count, repeat,
           roads: world && world.roads, missByRole: byRole, rankByRole: rankOf,
           errs: errs.slice(0, 3) };
}

out.session = await run('reported session');

/* ---- 1. it gets there at all, and quickly ---- */
/* The good mirror is sixth. Under the old timetable it was not even contacted
   until eleven seconds, and the three failures ahead of it each burned their slot
   plus up to two retries; the player in the log had waited twelve and seen
   nothing. Reaching it inside eight seconds means the queue moved on every
   failure instead of waiting out the clock. */
out.loaded = out.session.played;
out.fastEnough = out.session.played && out.session.ms < 8000;
out.reachedTheGoodOne = out.session.firstAsked.good !== undefined &&
                        out.session.firstAsked.good < 6000;

/* ---- 2. a host it could not reach is not asked again ---- */
/* fetch() rejecting with a TypeError means the request never left the browser —
   DNS, TLS, a refused connection, a CORS preflight that goes unanswered. That is
   this network being unable to talk to that host, not a busy moment, and the log
   shows three attempts and 2.2 s of loading screen spent rediscovering it. */
out.mostAsksForOneQuestion = out.session.repeat;
// 504 is a busy moment and IS worth asking again; a host you cannot reach is not
out.doesNotRetryUnreachable = (out.session.repeat.unreachable || 0) === 1;
out.stillRetriesBusy = (out.session.repeat.gateway || 0) > 1;

/* ---- 3. and it remembers, so the next load does not start from scratch ---- */
/* The whole failure begins with a fresh page having no opinion about six hosts
   and opening on the one that serves an empty database. A second load in the same
   browser should put the mirror that actually answered first. */
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const p = await ctx.newPage();
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
  }));
  await p.goto(GAME);
  await p.waitForTimeout(200);
  // a browser that has never loaded the game has nothing stored
  out.freshHealth = await p.evaluate(() => localStorage.getItem('vmMirrorHealth'));
  // write the shape a bad session leaves behind, then reload and read the order
  const order = await p.evaluate(() => OVERPASS.slice());
  await p.evaluate(o => localStorage.setItem('vmMirrorHealth', JSON.stringify({
    at: Date.now(), miss: { [o[0]]: 6, [o[1]]: 6, [o[2]]: 6, [o[3]]: 6, [o[4]]: 6 }
  })), order);
  await p.reload();
  await p.waitForTimeout(250);
  out.healthOrder = await p.evaluate(() => mirrorsByHealth().slice(0, 2));
  out.remembersGoodMirror = out.healthOrder[0] === order[5];
  await ctx.close();
}

/* ---- 4. "I have nothing" sinks a mirror further than "I am busy" ---- */
/* THE SECOND REPORTED SESSION, and the rule this comes from. A host answered
   NOTHING, in about 300 ms, to every query it was given across ninety-nine
   seconds — four skeleton rungs, the landmark sweep, and two street tiles — and
   it was asked FIRST every single time. Nothing was wrong with the demotion
   logic; it simply could not tell the two kinds of no apart. One empty reply
   cost one miss, and every other host picked up a miss of its own in the same
   round for being slow or unreachable under the opening requests, so nobody ever
   fell behind anybody and the fastest route to a wrong answer stayed at the
   front all session.

   An empty 200 is not a moment, it is a fact about that host's database: it does
   not have what was asked for and it will not have it in ten seconds either.

   WHAT IS MEASURED IS HOW MANY TIMES IT GETS ASKED, and getting to that took
   two wrong turns worth recording.

   The first version called mirrorNote() itself with a cost of its own choosing.
   It passed against a build with the fix removed, because all it proved was that
   addition works — the thing under test is which CALL SITE pays which cost, and
   only a real empty reply exercises that.

   The second version read the miss counts out of the finished session. It also
   passed against the broken build, and for a more interesting reason: the counts
   came out identical at three either way. Three misses of one, against one miss
   of three. The count is the mechanism, not the effect.

   The effect is the number of requests. Over one load this scenario puts out a
   dozen or so separate questions — the streets, the skeleton, the ring tiles,
   the scenery, the landmarks — and each races the mirrors from the top of the
   queue. A host that sinks after its first refusal is asked ONCE. A host that
   sinks by one, while every other host is picking up a miss of its own in the
   same round, stays level with the field and is asked again, and again: three
   times here, and for ninety-nine seconds in the log this comes from. */
out.missByRole = out.session.missByRole;
out.rankByRole = out.session.rankByRole;
out.asksByRole = out.session.asks;
// the host that only ever said "nothing" must not be at the head of the queue
out.emptyIsNotFirst = out.session.rankByRole.empty > 0;
// and one refusal has to be enough: it is never asked a second time this load
out.emptyAskedOnce = (out.session.asks.empty || 0) <= 1;
out.emptySinksFurtherThanBusy = out.session.rankByRole.empty > out.session.rankByRole.gateway;

/* And one good reply still wipes it out, because a host really can be repaired
   and a permanent blacklist built from one bad evening is its own bug. */
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const p = await ctx.newPage();
  await p.goto(GAME);
  await p.waitForTimeout(200);
  out.emptyRecovers = await p.evaluate(() => {
    const u = OVERPASS[0];
    mirrorNote(u, false, 8);
    const sunk = mirrorsByHealth().indexOf(u);
    mirrorNote(u, true);
    return sunk === OVERPASS.length - 1 && MIRROR_MISS.get(u) === 0 && mirrorsByHealth()[0] === u;
  });
  await ctx.close();
}

out.pass =
  out.loaded && out.fastEnough && out.reachedTheGoodOne &&
  out.doesNotRetryUnreachable && out.stillRetriesBusy &&
  out.freshHealth === null && out.remembersGoodMirror &&
  out.emptyIsNotFirst && out.emptyAskedOnce &&
  out.emptySinksFurtherThanBusy && out.emptyRecovers &&
  !out.session.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
