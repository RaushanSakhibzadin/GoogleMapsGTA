/* A MIRROR THAT SAYS ITS OWN DATABASE IS BROKEN.
 *
 * From a player's log, 13 November, loading Topčiderska zvezda: one mirror
 * answered the opening streets request with HTTP 200 in 362 ms and an empty
 * element list, while four others were still thinking and a sixth was
 * unreachable. The box was not empty — Bulevar vojvode Putnika and Topčiderski
 * venac are both inside it — so that reply was a broken database, and because an
 * empty reply only counted as one of three strikes, the host stayed at the front
 * of the queue for everything that came after it.
 *
 * WHAT THE REPLY ADMITS. osm3s.timestamp_osm_base is an ISO timestamp on a
 * working mirror and a bare replication sequence number on a broken one. Both
 * forms are in this repository already, captured from real sessions:
 *
 *     "2026-08-29T06:29:10Z"   savski-venac/streets1.json.gz   1,063 elements
 *     "118449"                 the player's log                0 elements
 *     "116742" and four more   the empty.json fixtures         0 elements
 *
 * so this test is driven from the fixtures rather than from invented bodies.
 *
 * WHAT IS ASSERTED, and the boundary matters more than the headline:
 *
 *   1. a broken-base empty reply parks that host on the FIRST one, so the next
 *      request does not ask it again
 *   2. a valid-timestamp empty reply does NOT — a box really can be empty, and
 *      that still takes three strikes
 *   3. neither of them changes the ANSWER: a city whose other mirrors have data
 *      still loads, and an area where every mirror says empty still settles as
 *      empty rather than failing
 *
 * 3 is the one that would catch this going too far. Refusing a reply on the
 * strength of a timestamp format would mean a healthy mirror on an unusual build
 * gets refused with it, which is a worse bug than the one being fixed.
 *
 * Usage: node tests/mirrorbase.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CHROME, GAME, ROOT } from './harness.mjs';

const FIX = join(ROOT, 'tests', 'fixtures', 'savski-venac');
const BROKEN = readFileSync(join(FIX, 'empty.json'), 'utf8');   // base "116742"
// the same body with the timestamp a working mirror would have sent
const SOUND = BROKEN.replace(/"timestamp_osm_base":\s*"[^"]*"/,
                             '"timestamp_osm_base": "2026-11-13T19:45:02Z"');

if (!/"\d+"/.test(BROKEN.match(/timestamp_osm_base":\s*("[^"]*")/)[1]))
  throw new Error('fixture no longer carries a sequence-number base; this test is moot');

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};

/* The page, with its own geocoder and nothing else reachable. Each run decides
   what every Overpass mirror says, and reads the mirror bookkeeping back out of
   the page afterwards — which is the only place the park actually lives. */
async function run(body) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  /* ORDER MATTERS AND IT IS THE REVERSE OF READING ORDER. Playwright matches the
     most recently registered route first, so the catch-all goes down FIRST and
     the two specific routes after it. Registered the other way round the
     catch-all wins, every Overpass request is aborted before the handler below
     ever sees it, and the run reports `asked: 0` while still landing in the
     bundled city — which looks exactly like a pass if you only read the city. */
  await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ lat: '44.7890864', lon: '20.4441207',
                            display_name: 'Topčider star, Topčidersko brdo',
                            address: { country_code: 'rs' } }]) }));
  let asked = 0;
  await p.route('**/api/interpreter', r => { asked++; r.fulfill({
    status: 200, contentType: 'application/json', body }); });

  await p.goto(GAME);
  // a clean slate, or a park left by a previous run decides this one
  await p.evaluate(() => { try { localStorage.removeItem('vmMirrorHealth'); } catch (e) {} });
  await p.fill('#q', 'Topčiderska zvezda');
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
  await p.waitForTimeout(500);

  const seen = await p.evaluate(() => ({
    parked: OVERPASS.filter(u => mirrorParked(u)).length,
    mirrors: OVERPASS.length,
    empties: OVERPASS.filter(u => (MIRROR_EMPTIES.get(u) || 0) > 0).length,
    city: window.__w().name,
    procedural: window.__w().procedural,
    roads: window.__w().roads,
  }));
  await ctx.close();
  return Object.assign(seen, { asked, errs: errs.slice(0, 3) });
}

/* ---------- 1. the broken base parks on the first empty reply ---------- */
out.broken = await run(BROKEN);
out.parksOnFirstStrike = out.broken.parked === out.broken.mirrors && out.broken.empties > 0;

/* ---------- 2. a sound base still takes three ---------- */
out.sound = await run(SOUND);
out.soundBaseIsSpared = out.sound.empties > 0 && out.sound.parked === 0;

/* ---------- 3. and neither one changed the answer ---------- *
 * Every mirror said empty in both runs, so both fall back — to the bundled
 * Belgrade, with roads on the ground, rather than to the generated lattice. That
 * is the behaviour a reply-refusing version of this would have broken. */
out.answerUnchanged = ['broken', 'sound'].every(k =>
  out[k].procedural === false && out[k].roads > 1000 && !out[k].errs.length);

out.pass = out.parksOnFirstStrike && out.soundBaseIsSpared && out.answerUnchanged;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
