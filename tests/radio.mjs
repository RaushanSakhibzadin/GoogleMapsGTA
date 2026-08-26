/* THE RADIO: REAL STATIONS FROM THE PLACE YOU ARE DRIVING IN.
 *
 * Out of the Radio Browser community database — the same idea as OpenStreetMap
 * and run the same way: open data, no key, no account. Type Belgrade and the
 * dial has Belgrade stations on it.
 *
 * FIVE THINGS THAT CAN BE WRONG WHILE A SCREENSHOT LOOKS RIGHT:
 *
 *   The stations are not local. A country filter alone gives you the whole
 *   country in whatever order the database felt like, so the list is sorted by
 *   distance from where you are actually driving. Asserted by feeding in a
 *   reply whose nearest station is deliberately NOT the most popular one, and
 *   checking which comes up first.
 *
 *   Half the dial is silent. A great many stations in that database are still
 *   plain http, and a browser refuses to load an http stream into an https page
 *   as mixed content — silently. Those have to be gone before the player ever
 *   reaches them, not skipped when they fail.
 *
 *   The buttons do not move the dial, or do not start the sound.
 *
 *   A dead directory takes the game with it. The database can be down, the
 *   country can have no stations, the phone can be offline. Every one of those
 *   has to end with a dial that says so and a game that plays.
 *
 *   And it never gets asked at all, because the country code never arrived —
 *   which is a change to the geocoder, two files away from anything called
 *   radio.
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4489;                      // Savski venac, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Kneza Milosa' },
    geometry: [toLL(-900, 0), toLL(900, 0)] },
  { type: 'node', id: 9, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Savski venac' } }
] });

/* THE REPLY, BUILT TO BE AWKWARD ON PURPOSE.
   - the most POPULAR station is 300 km away, and must not come first
   - the nearest is unpopular, and must
   - one is http, and must never reach the dial at all
   - one has no coordinates, and must survive — sunk to the bottom on
     popularity rather than thrown away, because most of the database is
     unplaced and discarding it would empty the dial in half the world */
const STATIONS = [
  { name: 'National Pop', url: 'https://far.example/stream', clickcount: 9000,
    geo_lat: String(LAT0 + 2.7), geo_long: String(LON0 + 0.4) },
  { name: 'Radio Beograd 202', url: 'https://near.example/stream', clickcount: 12,
    geo_lat: String(LAT0 + 0.01), geo_long: String(LON0 + 0.01) },
  { name: 'Insecure FM', url: 'http://plain.example/stream', clickcount: 8000,
    geo_lat: String(LAT0), geo_long: String(LON0) },
  { name: 'Unplaced Talk', url: 'https://unplaced.example/stream', clickcount: 400,
    geo_lat: '', geo_long: '' },
  { name: 'Studio B', url: 'https://b.example/stream', clickcount: 30,
    geo_lat: String(LAT0 + 0.03), geo_long: String(LON0 - 0.02) }
];

async function open(opts = {}) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = [];
  const asked = [];
  p.on('pageerror', e => errs.push(String(e)));
  /* THE CATCH-ALL GOES ON FIRST, and that is not a style choice. Playwright
     matches the most recently registered route, so a "block everything" handler
     added last wins over every specific one before it — the first version of
     this registered it at the end and the radio request never reached its own
     handler at all, which read as a dial that never tuned. */
  await p.route('**://*/**', r =>
    (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{
    lat: String(LAT0), lon: String(LON0),
    display_name: 'Savski venac, Beograd, Srbija',
    // the two letters the radio needs, which only addressdetails returns
    address: { country_code: 'rs', city: 'Beograd' }
  }])));
  await p.route('**/api/interpreter', r => {
    const q = decodeURIComponent(r.request().postData() || '');
    if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)) ||
        (/motorway/.test(q) && !/residential/.test(q)))
      return r.fulfill(json({ elements: [] }));
    return r.fulfill(json(streets()));
  });
  /* A REGEX, NOT A GLOB. The hosts are all.api.radio-browser.info and friends,
     and a glob of two stars, a slash and the host never matches one of those:
     the stars want a path boundary in front of them and there is none, because
     the whole thing is a single hostname. It bound to nothing, the catch-all
     took the request, and the dial simply never tuned.

     (Written out in words on purpose. The glob spelled literally contains a
     star followed by a slash, which ends this comment three lines early and
     turns the next one into a syntax error — which is how the first attempt at
     explaining it went.) */
  await p.route(/radio-browser\.info/, r => {
    asked.push(r.request().url());
    if (opts.down) return r.abort();
    if (opts.empty) return r.fulfill(json([]));
    return r.fulfill(json(STATIONS));
  });
  // the streams themselves: never actually fetched over the wire in a test
  await p.route('**/*.example/**', r => r.abort());
  await p.goto(GAME);
  await p.waitForTimeout(400);
  await p.evaluate(() => window.__hideGLHelp && window.__hideGLHelp(false));
  await p.fill('#q', 'Savski venac, Beograd');
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(1200);
  /* THE FIRST PRESS IS WHAT TUNES IT. Nothing is looked up on the loading path —
     see the note above radioAt — so a test that waited for stations to appear on
     their own would wait for ever. This is the tap. */
  if (!opts.noPress) await p.evaluate(() => window.__radioWake());
  return { browser, p, errs, asked };
}

const out = {};

/* ---- 0. nothing is asked of anybody until the dial is pressed ----

   It is a third-party server, on a connection that may be metered, for a
   feature the player has not switched on. It also used to fail three times into
   everybody's console for a radio nobody wanted, which is how this was found:
   twenty-three tests in the suite watch for console errors, and every one of
   them started failing. */
{
  const { browser, p, errs, asked } = await open({ noPress: true });
  out.quiet = { asked: asked.length, radio: await p.evaluate(() => window.__radio()) };
  out.silentUntilPressed = out.quiet.asked === 0 &&
                           out.quiet.radio.status === 'idle' &&
                           out.quiet.radio.label === 'RADIO';
  // and the strip is on screen, saying RADIO, waiting to be pressed
  out.stripBeforeTuning = await p.evaluate(() =>
    getComputedStyle(document.getElementById('radio')).display !== 'none');
  out.quietErrs = errs.slice(0, 3);
  await browser.close();
}

/* ---- 1. a dial, tuned to where you are ---- */
{
  const { browser, p, errs, asked } = await open();
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 20000 })
         .catch(() => {});
  out.found = await p.evaluate(() => window.__radio());
  out.asked = asked[0] || '';
  /* The country code has to have travelled from Nominatim, through the loader,
     into the query — three files, and the only visible sign is two letters in a
     URL. Without it the dial is the world's top forty. */
  out.asksForThisCountry = /countrycode=RS/.test(out.asked);
  out.asksNearHere = /geo_lat=44\.81/.test(out.asked) && /geo_long=20\.44/.test(out.asked);

  const names = out.found.list.map(s => s.name);
  out.stations = names;
  out.nearestFirst = names[0] === 'Radio Beograd 202';
  /* Popularity is the tie-break for stations nobody has placed, not the sort.
     'National Pop' has 9,000 clicks and is 300 km away; it must not be first. */
  out.popularityIsNotLocal = names.indexOf('National Pop') > 0;
  out.keepsTheUnplaced = names.includes('Unplaced Talk');
  out.dropsPlainHttp = !names.includes('Insecure FM') &&
                       out.found.list.length === STATIONS.length - 1;

  /* ---- 2. and the buttons move it ---- */
  out.stepped = await p.evaluate(() => {
    const a = window.__radio();
    document.getElementById('radioX').click();
    const b = window.__radio();
    document.getElementById('radioX').click();
    const c = window.__radio();
    document.getElementById('radioP').click();
    const d = window.__radio();
    return { a: a.i, b: b.i, c: c.i, d: d.i, name: b.name };
  });
  out.forwardAndBack = out.stepped.b === 1 && out.stepped.c === 2 && out.stepped.d === 1;

  /* ---- 3. the dial wraps ---- */
  out.wrap = await p.evaluate(() => {
    const n = window.__radio().n;
    for (let k = 0; k < n; k++) window.__radioStep(1);
    const round = window.__radio().i;
    window.__radioStep(-1);
    const back = window.__radio().i;
    return { n, round, back };
  });
  out.wraps = out.wrap.round === 1 && out.wrap.back === 0;

  /* ---- 4. pressing the name starts it, and the src is the station's ----
     Not "did a sound come out" — a headless browser has no speaker and the
     stream is a mock. What is checked is that the element was pointed at the
     right URL and told to play, which is the whole of what the game controls. */
  out.play = await p.evaluate(() => {
    window.__radioStep(0);                       // back to a known station
    const before = window.__radio();
    document.getElementById('radioN').click();
    const on = window.__radio();
    document.getElementById('radioN').click();
    const off = window.__radio();
    return { before: before.on, onSrc: on.src, on: on.on, off: off.on,
             offPaused: off.paused, want: before.name };
  });
  out.playsTheStation = out.play.before === false && out.play.on === true &&
                        /near\.example|b\.example|unplaced\.example|far\.example/.test(out.play.onSrc) &&
                        out.play.off === false && out.play.offPaused === true;

  /* ---- 5. and it is visible and reachable on a phone ---- */
  out.strip = await p.evaluate(() => {
    const el = document.getElementById('radio');
    const r = id => {
      const q = document.getElementById(id).getBoundingClientRect();
      return { w: Math.round(q.width), h: Math.round(q.height),
               top: Math.round(q.top), right: Math.round(q.right) };
    };
    return { shown: getComputedStyle(el).display !== 'none',
             prev: r('radioP'), name: r('radioN'), next: r('radioX'),
             vw: innerWidth, vh: innerHeight };
  });
  const big = q => q.w >= 28 && q.h >= 28;          // a thumb, at speed
  const inside = q => q.top >= 0 && q.right <= out.strip.vw;
  out.reachable = out.strip.shown && big(out.strip.prev) && big(out.strip.name) &&
                  big(out.strip.next) && inside(out.strip.prev) &&
                  inside(out.strip.next) && inside(out.strip.name);

  out.liveErrs = errs.slice(0, 3);
  await browser.close();
}

/* ---- 6. the directory is down: a dial that says so, and a game that plays ---- */
{
  const { browser, p, errs } = await open({ down: true });
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 25000 })
         .catch(() => {});
  out.dead = await p.evaluate(() => {
    const r = window.__radio();
    // and the controls must not throw when there is nothing to control
    document.getElementById('radioX').click();
    document.getElementById('radioN').click();
    /* Pressing a dead dial TUNES AGAIN rather than doing nothing, which is
       right: the reason it failed is usually a network that has since come
       back. So the state after a press is 'finding', not 'none' — read the
       label before pressing or you are reading the retry. */
    return { ...r, retries: window.__radio().status };
  });
  out.drivesWithoutIt = await p.evaluate(async () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    const x0 = window.__p().x;
    await new Promise(res => {
      const t0 = window.__simT();
      const tick = () => (window.__simT() - t0 < 3 ? requestAnimationFrame(tick) : res());
      requestAnimationFrame(tick);
    });
    window.__setInput(null);
    return Math.abs(window.__p().x - x0) > 20;
  });
  out.saysSoAndCarriesOn = out.dead.status === 'none' && out.dead.n === 0 &&
                           /NO STATIONS/i.test(out.dead.label) &&
                           out.dead.retries === 'finding' &&
                           out.drivesWithoutIt === true;
  out.deadErrs = errs.slice(0, 3);
  await browser.close();
}

/* ---- 7. and a country with nothing in it reads the same way ----
   A 200 with an empty array is not an error and must not be reported as one. */
{
  const { browser, p, errs } = await open({ empty: true });
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 25000 })
         .catch(() => {});
  out.emptyCountry = await p.evaluate(() => window.__radio());
  out.emptyReadsAsNone = out.emptyCountry.status === 'none' && out.emptyCountry.n === 0;
  out.emptyErrs = errs.slice(0, 3);
  await browser.close();
}

out.errs = [].concat(out.quietErrs, out.liveErrs, out.deadErrs, out.emptyErrs).filter(Boolean);
out.pass = out.silentUntilPressed && out.stripBeforeTuning && out.asksForThisCountry && out.asksNearHere && out.nearestFirst &&
           out.popularityIsNotLocal && out.keepsTheUnplaced && out.dropsPlainHttp &&
           out.forwardAndBack && out.wraps && out.playsTheStation && out.reachable &&
           out.saysSoAndCarriesOn && out.emptyReadsAsNone && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
