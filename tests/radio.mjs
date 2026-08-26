/* THE RADIO: REAL STATIONS FROM THE PLACE YOU ARE DRIVING IN.
 *
 * Out of the Radio Browser community database — the same idea as OpenStreetMap
 * and run the same way: open data, no key, no account. Type Belgrade and the
 * dial has Belgrade stations on it.
 *
 * SEVEN THINGS THAT CAN BE WRONG WHILE A SCREENSHOT LOOKS RIGHT:
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
 *
 *   THE DRAW IS NOT LOCAL. The dial re-tunes at random every time a city starts,
 *   and "at random" over the whole list would undo the ranking above — the far
 *   end of it is national networks two hundred kilometres away. Asserted by
 *   drawing four hundred times from a twenty-four station dial and checking the
 *   far half never comes up.
 *
 *   IT RE-TUNES WHEN YOU ARE HIT, which was asked for and then asked to be taken
 *   away again — a crash already has the bang, the shake and the damage on it,
 *   and losing the song too reads as the game taking it off you. That is one
 *   call site in a different file, and the only way to see it is to stage a
 *   collision and watch the dial across it.
 *
 *   IT COMES ON BY ITSELF WHEN IT SHOULD NOT. The dial now switches on with the
 *   car, and the honest half of that is the player who switched it off: they
 *   must get no request to a third-party directory at all, not one that fails
 *   politely. Counted, rather than inferred from whether a sound came out.
 *
 *   AND THERE IS NO VISIBLE WAY TO STOP IT. Something that turns itself on has
 *   to say how to turn it off, and the only control that does is the station
 *   name — which does not look like a control. It carries ■ or ▶ for its own
 *   action now, and that symbol is asserted on the rendered label.
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

/* A LONGER DIAL, FOR THE SHUFFLE, and it has to be long for the reading to mean
   anything: the draw is from the near half with a floor of four, so on the five
   station reply above "the near half" and "anywhere at all" are the same set and
   a locality test on it would pass whatever the code did.
   Twenty-four stations laid out due north at 0.02° apart, so the ranked order is
   the numbered order and "index 12 or higher" means "one of the far twelve". */
const MANY = Array.from({ length: 24 }, (_, k) => ({
  name: 'Station ' + String(k).padStart(2, '0'),
  url: 'https://s' + k + '.example/stream',
  clickcount: 24 - k,                       // popularity runs the OTHER way
  geo_lat: String(LAT0 + (k + 1) * 0.02), geo_long: String(LON0)
}));

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
    if (opts.many) return r.fulfill(json(MANY));
    return r.fulfill(json(STATIONS));
  });
  // the streams themselves: never actually fetched over the wire in a test
  await p.route('**/*.example/**', r => r.abort());
  await p.goto(GAME);
  await p.waitForTimeout(400);
  await p.evaluate(() => window.__hideGLHelp && window.__hideGLHelp(false));
  /* THE SETTING IS WRITTEN BEFORE THE CITY LOADS, because the city load is what
     reads it. `off` is the player who switched the radio off in an earlier
     session; the default is on. */
  if (opts.off) await p.evaluate(() => window.__radioWanted(false));
  await p.fill('#q', 'Savski venac, Beograd');
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(1200);
  return { browser, p, errs, asked };
}

const out = {};

/* ---- 0. IT COMES ON WITH THE CAR, and it stays off if you turned it off ----

   Both halves matter and they are the same setting read twice.

   ON is what a car does, and it is what was asked for. Nothing is pressed here:
   the city loads and the dial has to have tuned itself and asked to play.

   OFF has to be a decision that STICKS, and it is also the honest half. Talking
   to a third-party directory, on a connection that may be metered, for a feature
   the player switched off is exactly the thing this used to avoid by asking
   nobody anything until it was pressed — so with the setting off, the count of
   requests must be zero rather than "one that fails quietly".

   That count is the assertion. Whether a stream then plays is a browser
   decision this cannot make (see the pending case below); whether a request went
   out is entirely the game's. */
{
  const { browser, p, errs, asked } = await open();
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 20000 })
         .catch(() => {});
  out.armed = { asked: asked.length, radio: await p.evaluate(() => window.__radio()) };
  /* on, tuned, and either playing or parked waiting for a touch — a headless
     Chromium allows the autoplay a phone refuses, so both are correct here and
     the thing asserted is that it is not merely sitting there idle */
  out.comesOnByItself =
    out.armed.asked >= 1 &&
    out.armed.radio.wanted === true &&
    out.armed.radio.n > 0 &&
    (out.armed.radio.on === true || out.armed.radio.pending === true);
  out.stripBeforeTuning = await p.evaluate(() =>
    getComputedStyle(document.getElementById('radio')).display !== 'none');
  out.armedErrs = errs.slice(0, 3);
  await browser.close();
}
{
  const { browser, p, errs, asked } = await open({ off: true });
  await p.waitForTimeout(1500);
  out.quiet = { asked: asked.length, radio: await p.evaluate(() => window.__radio()) };
  out.offStaysOff = out.quiet.asked === 0 &&
                    out.quiet.radio.wanted === false &&
                    out.quiet.radio.on === false &&
                    out.quiet.radio.n === 0 &&
                    out.quiet.radio.status === 'idle';
  /* AND THE WAY BACK IS ON SCREEN. A radio you switched off must still say how
     to switch it on, or the setting is a trap. */
  out.offLabel = out.quiet.radio.label;
  out.offSaysHowToStart = /▶/.test(out.offLabel) &&
                          /turn the radio on|play the radio/i.test(out.quiet.radio.action);
  out.quietErrs = errs.slice(0, 3);
  await browser.close();
}

/* ---- 1. a dial, tuned to where you are ---- */
{
  const { browser, p, errs, asked } = await open();
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 20000 })
         .catch(() => {});
  /* SILENCED, NOT SWITCHED OFF, before the mechanics below are measured. The
     dial now arms itself, and a headless Chromium — unlike a phone — lets the
     autoplay through, so by this point it is chasing a mock stream that will
     never answer and the state is 'loading' or 'error'. radioStop puts it back
     to 'ready' without touching the remembered setting, which is the state every
     section from here down was written against. */
  await p.evaluate(() => radioStop());
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

  /* ---- 2. and the buttons move it ----

     RELATIVE TO WHERE THE DIAL LANDED, not to station zero. A fresh session
     draws its first station at random — see section 8 — so the old form of this,
     which asserted the first press lands on index 1, was asserting the absence
     of that feature. */
  out.stepped = await p.evaluate(() => {
    const n = window.__radio().n, a = window.__radio().i;
    document.getElementById('radioX').click();
    const b = window.__radio().i;
    document.getElementById('radioX').click();
    const c = window.__radio().i;
    document.getElementById('radioP').click();
    const d = window.__radio().i;
    return { n, a, b, c, d };
  });
  {
    const s = out.stepped, n = s.n;
    out.forwardAndBack = n > 2 && s.b === (s.a + 1) % n &&
                         s.c === (s.a + 2) % n && s.d === (s.a + 1) % n;
  }

  /* ---- 3. the dial wraps ---- */
  out.wrap = await p.evaluate(() => {
    const n = window.__radio().n, from = window.__radio().i;
    for (let k = 0; k < n; k++) window.__radioStep(1);
    const round = window.__radio().i;       // all the way round, back where it was
    window.__radioStep(-1);
    const back = window.__radio().i;
    return { n, from, round, back };
  });
  out.wraps = out.wrap.round === out.wrap.from &&
              out.wrap.back === (out.wrap.from + out.wrap.n - 1) % out.wrap.n;

  /* ---- 4. pressing the name starts it, and the src is the station's ----
     Not "did a sound come out" — a headless browser has no speaker and the
     stream is a mock. What is checked is that the element was pointed at the
     right URL and told to play, which is the whole of what the game controls. */
  out.play = await p.evaluate(() => {
    window.__radioStep(0);                       // back to a known station
    const snap = () => {
      const r = window.__radio();
      return { on: r.on, src: r.src, paused: r.paused, label: r.label,
               action: r.action, wanted: r.wanted, name: r.name };
    };
    const before = snap();
    document.getElementById('radioN').click();
    const on = snap();
    document.getElementById('radioN').click();
    const off = snap();
    return { before, on, off };
  });
  out.playsTheStation =
    out.play.before.on === false && out.play.on.on === true &&
    /near\.example|b\.example|unplaced\.example|far\.example/.test(out.play.on.src) &&
    out.play.off.on === false && out.play.off.paused === true;

  /* ---- 4b. AND THE BUTTON SAYS WHAT PRESSING IT WILL DO ----

     The dial turns itself on now, so the first thing a player needs is the way
     to turn it off — and the only control that does that is the station name,
     which does not look like a control. So it wears the symbol for its own
     action: ■ while something is playing, ▶ while it is not. Asserted on the
     rendered label rather than on a flag, because the glyph IS the feature.

     AND STOPPING IT IS REMEMBERED. Switching the radio off is a decision about
     the game rather than about this session — otherwise it comes back on at the
     next city and the off switch is decoration. */
  out.stopIsExplicit =
    /^▶/.test(out.play.before.label) && /^■/.test(out.play.on.label) &&
    /^▶/.test(out.play.off.label) &&
    // the name itself is still there next to the symbol
    out.play.on.label.includes(out.play.on.name) &&
    /stop/i.test(out.play.on.action) && /play|turn the radio on/i.test(out.play.off.action);
  out.offIsRemembered = out.play.on.wanted === true && out.play.off.wanted === false;

  /* ---- 5. and it is visible and reachable on a phone ---- */
  out.strip = await p.evaluate(() => {
    const el = document.getElementById('radio');
    const r = id => {
      const q = document.getElementById(id).getBoundingClientRect();
      return { w: Math.round(q.width), h: Math.round(q.height),
               top: Math.round(q.top), bottom: Math.round(q.bottom),
               left: Math.round(q.left), right: Math.round(q.right) };
    };
    return { shown: getComputedStyle(el).display !== 'none',
             bar: r('radio'), prev: r('radioP'), name: r('radioN'), next: r('radioX'),
             padA: r('tA'), padH: r('tH'), armor: r('hpWrap'),
             vw: innerWidth, vh: innerHeight,
             scrollW: document.documentElement.scrollWidth };
  });
  const big = q => q.w >= 28 && q.h >= 28;          // a thumb, at speed
  const inside = q => q.top >= 0 && q.right <= out.strip.vw;
  out.reachable = out.strip.shown && big(out.strip.prev) && big(out.strip.name) &&
                  big(out.strip.next) && inside(out.strip.prev) &&
                  inside(out.strip.next) && inside(out.strip.name);

  /* ---- 6. A BAR ACROSS THE BOTTOM, UNDER THE CONTROLS ----

     It was a strip tucked under the radar in the top-left column, where the name
     had about eighty pixels of a 390 pixel screen and every station longer than
     "Studio B" was an ellipsis. Three things have to hold at once, and only the
     first is visible in a screenshot:

       the bar spans the screen and sits on the bottom edge;
       the name gets most of that width — which is the whole point of moving it;
       and NOTHING IT NOW SITS UNDER GOT COVERED. A fixed bar at the bottom of a
       game whose accelerator is also at the bottom is a bar you press instead of
       the accelerator, so the pads and the bottom HUD have to have lifted by the
       bar's own height. That is what --radioBar does and this is what says it
       worked. */
  const S = out.strip;
  out.spansTheBottom = Math.abs(S.bar.bottom - S.vh) <= 2 && S.bar.left === 0 &&
                       Math.abs(S.bar.w - S.vw) <= 1 && S.scrollW <= S.vw;
  out.nameGetsTheWidth = S.name.w >= S.vw * 0.5;
  out.nothingIsCovered = S.padA.bottom <= S.bar.top && S.padH.bottom <= S.bar.top &&
                         S.armor.bottom <= S.bar.top;

  /* ---- 7. and a real station name is not clipped ----

     The reported fault in as many words: "make it bigger so full text of radio
     channel can be seen". #radioN ellipsises, so a name that does not fit shows
     a scrollWidth wider than its box — and on a 390 point phone the box is 245
     of them, which at the design size is about twenty-four characters. Plenty of
     real stations are longer: 'Radio Televizija Vojvodine 021' is thirty, and is
     a real Novi Sad station rather than a worst case invented for a test.

     TWO WAYS THIS PASSES WITHOUT BEING FIXED, so both are read: shrinking the
     type until anything fits is not a readable dial, so the size that came out
     is asserted as well; and a short name must be left at the full size rather
     than being shrunk along with it. */
  out.longName = await p.evaluate(() => {
    const n = document.getElementById('radioN');
    const was = RADIO.list[RADIO.i].name;
    const read = name => {
      RADIO.list[RADIO.i].name = name;
      radioPaint();
      return { text: n.textContent,
               scroll: n.scrollWidth, client: n.clientWidth,
               tall: n.scrollHeight, box: n.clientHeight,
               px: +parseFloat(getComputedStyle(n).fontSize).toFixed(1) };
    };
    const long = read('Radio Televizija Vojvodine 021');
    const short = read('Studio B');
    RADIO.list[RADIO.i].name = was;
    radioPaint();
    return { long, short };
  });
  out.showsTheWholeName =
    // the whole name, and the play/stop symbol in front of it — see 4b
    out.longName.long.text === '▶ Radio Televizija Vojvodine 021' &&
    // nothing spills out of the box in either direction: it wrapped, it fits
    out.longName.long.scroll <= out.longName.long.client + 1 &&
    out.longName.long.tall <= out.longName.long.box + 1 &&
    // and it is still full-sized type rather than something that merely fits
    out.longName.long.px >= 14 &&
    out.longName.short.px >= 14;

  out.liveErrs = errs.slice(0, 3);
  await browser.close();
}

/* ================= THE SHUFFLE =================
   Twenty-four stations, numbered by distance, so an index is a distance. */
{
  const { browser, p, errs } = await open({ many: true });
  await p.waitForFunction(() => window.__radio().status !== 'finding', null, { timeout: 20000 })
         .catch(() => {});

  /* ---- 8. random, and still local ----

     Four hundred draws. Three separate things have to be true of them and each
     one is a different bug:
       more than a handful of distinct stations, or it is not random;
       never one from the far half, or it is not local;
       and never the one already playing, because a shuffle that sometimes does
       nothing reads as a button that sometimes does not work. */
  out.draw = await p.evaluate(() => {
    const n = RADIO.list.length;
    const seen = [];
    let prev = RADIO.i, repeats = 0;
    for (let k = 0; k < 400; k++) {
      radioRandom();
      if (RADIO.i === prev) repeats++;
      seen.push(RADIO.i);
      prev = RADIO.i;
    }
    const uniq = [...new Set(seen)].sort((a, b) => a - b);
    return { n, uniq, far: uniq.filter(i => i >= n / 2), repeats,
             names: [RADIO.list[uniq[0]].name, RADIO.list[uniq[uniq.length - 1]].name] };
  });
  out.randomButLocal = out.draw.n === 24 && out.draw.uniq.length >= 8 &&
                       out.draw.far.length === 0 && out.draw.repeats === 0;

  /* ---- 9. every start is a fresh draw ----
     "Change the channel randomly every time the game starts." Tuning twelve
     times must not land on the same station twelve times — and in particular
     must not always be the nearest one, which is what a dial that does not
     shuffle at all would do. */
  out.starts = await p.evaluate(async () => {
    const s = [];
    for (let k = 0; k < 12; k++) {
      await radioFind(RADIO.at.lat, RADIO.at.lon, RADIO.at.cc);
      s.push(RADIO.i);
    }
    return { s, uniq: [...new Set(s)].length, nearest: s.filter(i => i === 0).length };
  });
  out.everyStartIsADraw = out.starts.uniq >= 4 && out.starts.nearest === 0;

  /* ---- 10. BEING HIT DOES NOT TOUCH THE DIAL ----

     A crash used to re-tune it, the way knocking a real car radio used to. It
     sounds better than it plays: a shunt already has the bang, the shake, the
     sparks and the damage on it, and losing the song as well reads as the game
     taking it off you at the one moment you are busiest. Reported in as many
     words — "pls do not change the radio when hit" — so both kinds of contact
     are now held to the same rule.

     STAGED, the way tests/survive.mjs stages the police cooldown, because a real
     collision measures the traffic AI and not the rule: cars steer away, and
     whether one happens to hit you inside a two second window is a coin toss
     that would make this test flap.

     carsCollide is a plain global function declaration, so it can be replaced by
     one that reports a hard contact for exactly one kind of car and nothing for
     any other pair — which puts the contact in a known loop. Both readings run
     with the rate limits held open, which is what makes them hostile: two
     seconds of continuous contact at sixty frames a second is something like a
     hundred and twenty chances to re-tune, so a single surviving call site shows
     up as a jump count in the dozens rather than as a rare flake. */
  const shunt = kind => p.evaluate(async k => {
    const real = window.carsCollide;
    window.__ghost(false);
    window.__heal();
    window.__addWanted(k === 'cop' ? 3 : -9);
    // let the wanted level stock cruisers, or the traffic stock itself
    for (let f = 0; f < 180; f++) {
      if (k === 'cop' ? cops.length > 0 : traffic.length > 0) break;
      await new Promise(r => requestAnimationFrame(r));
    }
    const had = { traffic: traffic.length, cops: cops.length };
    /* Only the player's own contacts, so the AI cars are not set ramming each
       other in the background — that is a different code path and it would
       wreck the whole city inside the reading. */
    window.carsCollide = (a, b) =>
      (a === P.car && !!(b && b.kind === 'cop') === (k === 'cop')) ? 9 : 0;
    const before = RADIO.i;
    let jumps = 0, prev = RADIO.i;
    window.__dmgReset();                     // this reading only
    const t0 = window.__simT();
    await new Promise(res => {
      const tick = () => {
        if (RADIO.i !== prev) { jumps++; prev = RADIO.i; }
        P.hitCd = 0; P.copCd = 0;              // no rate limit hiding the answer
        window.__heal();                       // so it cannot die inside the reading
        window.__simT() - t0 < 2 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    window.carsCollide = real;
    window.__addWanted(-9);
    window.__heal();
    return { had, before, after: RADIO.i, jumps, took: window.__dmg() };
  }, kind);

  out.civilianShunt = await shunt('traffic');
  out.policeShunt = await shunt('cop');
  /* THE CONTACT HAS TO HAVE ACTUALLY HAPPENED, and this is the assertion the
     whole section rests on now that both answers are "nothing moved" — without
     it, a staging mistake that produced no collision at all would read exactly
     like the behaviour being asked for, and this test would pass on a build that
     re-tuned on every crash. The damage tally is the witness: the traffic
     reading took traffic damage and no police damage, and the police reading the
     other way round. */
  out.bothWereReallyHit =
    out.civilianShunt.had.traffic > 0 && out.policeShunt.had.cops > 0 &&
    out.civilianShunt.took.traffic > 0 && out.civilianShunt.took.cop === 0 &&
    out.policeShunt.took.cop > 0 && out.policeShunt.took.traffic === 0;
  const still = s => s.jumps === 0 && s.after === s.before;
  out.aShuntLeavesItAlone = still(out.civilianShunt);
  out.andSoDoThePolice = still(out.policeShunt);

  out.shuffleErrs = errs.slice(0, 3);
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

out.errs = [].concat(out.armedErrs, out.quietErrs, out.liveErrs, out.shuffleErrs,
                     out.deadErrs, out.emptyErrs)
             .filter(Boolean);
out.pass = out.comesOnByItself && out.offStaysOff && out.offSaysHowToStart &&
           out.stopIsExplicit && out.offIsRemembered &&
           out.stripBeforeTuning && out.asksForThisCountry && out.asksNearHere && out.nearestFirst &&
           out.popularityIsNotLocal && out.keepsTheUnplaced && out.dropsPlainHttp &&
           out.forwardAndBack && out.wraps && out.playsTheStation && out.reachable &&
           out.spansTheBottom && out.nameGetsTheWidth && out.nothingIsCovered &&
           out.showsTheWholeName &&
           out.randomButLocal && out.everyStartIsADraw && out.bothWereReallyHit &&
           out.aShuntLeavesItAlone && out.andSoDoThePolice &&
           out.saysSoAndCarriesOn && out.emptyReadsAsNone && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
