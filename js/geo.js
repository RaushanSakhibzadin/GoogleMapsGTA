"use strict";
/* VICE MAPS — Projection, Overpass and Nominatim: everything that talks to the network.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 2. geo ------------------------------ */
// Local equirectangular projection. World units are metres, +x east, +y south.
const GEO = { lat0: 0, lon0: 0, mLat: 110540, mLon: 111320 };
function setOrigin(lat, lon) {
  GEO.lat0 = lat; GEO.lon0 = lon;
  GEO.mLon = 111320 * Math.cos(lat * Math.PI / 180);
}
const projX = lon => (lon - GEO.lon0) * GEO.mLon;
const projY = lat => -(lat - GEO.lat0) * GEO.mLat;
// and back again, so we can ask Overpass for the tile next door
const unprojLon = x => GEO.lon0 + x / GEO.mLon;
const unprojLat = y => GEO.lat0 - y / GEO.mLat;

// Road width in metres by OSM highway class.
const ROADW = {
  motorway: 17, motorway_link: 10, trunk: 15, trunk_link: 9,
  primary: 13, primary_link: 8, secondary: 11, secondary_link: 8,
  tertiary: 9.5, tertiary_link: 7, residential: 8, unclassified: 8,
  living_street: 7, service: 5, pedestrian: 4.5, track: 4.5, road: 8
};
const DRIVABLE = c => c !== 'pedestrian' && c !== 'track';

/* Public Overpass instances. SIX, and shuffled per session, because three was not
   enough and everybody's first pick was the same one: when the head of the list
   is unreachable from your network it fails in about a second, burns its retries,
   and the healthy mirrors don't get a look in until seven and fourteen seconds
   later. Shuffling also stops every player in the world hammering the same host,
   and means a reload genuinely re-rolls rather than repeating the same failure. */
const OVERPASS = shuffle([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
]);
// 100 m/s is exactly 360 km/h, which is what makes the drift arithmetic below
// land on round numbers: the turn in degrees is the speed on the clock.
const TOP_SPEED = 100;
const RADIUS = 900;   // metres fetched around the centre point
/* The map streams in. Tile (i,j) covers a RADIUS*2 square centred on
   (i*TILE, j*TILE), so tile (0,0) is exactly the area fetched at startup and
   neighbours butt up against it with no gap and no overlap. */
const TILE = RADIUS * 2;
const LOOKAHEAD = 520;   // start fetching a neighbour once you're this close to it
const MAX_TILES = 20;    // the opening 3x3 ring plus room to drive before recycling
const TILE_COOLDOWN = 2500;   // be a good Overpass citizen between chunk requests

/* The world arrives before you drive. Full detail — every lane, every service
   road — covers the tiles around where you start, and streets go on streaming
   with the tiles as you drive, because the street you live on is not an arterial.
   Out past those the world is the ARTERIAL SKELETON: the roads you'd actually
   take to cross a region, fetched once.

   HOW FAR OUT IS A LOADING-SCREEN DECISION, NOT AN AMBITION. The box grows with
   the SQUARE of the radius, and the player is watching a bar the whole time. A
   200 km skeleton was tried and measured on a real phone: 36.7 MB, twenty-three
   seconds of the loading screen, on a connection doing 1.6 MB/s. That is most of
   a minute's load for roads a player reaches after an hour of driving, and the
   report it produced was "pls fix the map load".

   60 km is the same city for about five seconds. Sized against the real
   composition of a captured Belgrade skeleton rather than guessed: over the
   ±36 km box, `secondary` is 55.7% of the bytes, `primary` 12.5%, and
   `motorway|trunk` together only 15% — which is why the rings below exist and
   why widening the outer one is cheap while widening the inner one is not. The
   same model predicts 41 MB for the 200 km ask against the 36.7 measured, so
   these numbers are worth trusting to the nearest few megabytes:

       radius     wire size    load @1.6 MB/s
       200 km      36.7 MB        23 s
       100 km      18.5 MB        12 s
        60 km       8.7 MB         5 s   <- default
        36 km       5.2 MB         3 s

   The rungs below it are not decoration: there are servers and networks that
   will not carry even this. First to land wins, and the rungs step through
   worlds the game has actually shipped with, so a refusal costs the previous
   release's map and not some worse compromise.

   None of this is bounded by the client any more. Uncoupling the drivable mask
   from the world (see MASK_HALF) means the mask stops at 36 km whatever the
   world does — the bitmap was the old binding constraint, and now the download
   is, which is a thing the player can actually feel. */
const SKELETON_RADII = [60000, 36000, 18000, 9000];  // tried in order; first to land wins
/* Every one of these is a slice of loading screen somebody has to sit through,
   so they are sized off what the rung actually costs rather than off what a
   patient server might eventually manage. The widest rung is an 8.7 MB download —
   five seconds on a good phone connection, thirteen on a poor one — and 18 s is
   the point past which a mirror is not being slow, it is not answering. The whole
   ladder is bounded at 45 s, down from 80: a skeleton is the part of the load
   that can be given up on, since the detailed centre is already in and the game
   starts either way. */
const SKELETON_MS = [18000, 12000, 10000, 8000];   // per attempt, so the ladder can't run away
const SKELETON_WAIT = 45000;                       // shared deadline over the whole ladder

/* THE SKELETON IS THREE RINGS, NOT ONE BOX, AND IT HAS TO BE.

   Road classes are not spread evenly through a country, and the split is not
   close. Measured on a captured Belgrade skeleton over the ±36 km box: secondary
   roads are 55.7% of the bytes, primary 12.5%, motorway and trunk together 15%.
   So the dense half of the arterial set is the half you can see out of the
   windscreen, and the sparse half is the half that goes somewhere.

   The ask therefore narrows as it widens, which is also just what the map should
   look like: the motorway network over the whole radius, primaries and slip roads
   over 100 km of it, and the full arterial set over the 36 km the drivable mask
   covers. Past the mask a road is scenery on the big map — there is no ground to
   be on or off — so that is exactly where the expensive half stops.

   A ring wider than the radius simply collapses onto the whole box, so at the
   60 km default the middle one does nothing and this is two rings, not three.
   That is the correct answer rather than a special case: primaries over 60 km
   cost about a megabyte, and the rule stays right if the radius ever goes back
   up. Only SKEL_NEAR earns its keep at every size, and it is the one that
   matters — it is holding back 55.7% of the bytes. */
const SKEL_NEAR = 36000;     // full arterial detail — exactly MASK_HALF
const SKEL_MID = 100000;     // primaries and the junctions between them

/* Two queries, not one. Streets are small and quick and are all you need to start
   driving; buildings are the bulk of the payload and arrive afterwards. Splitting
   them means a slow or refused building fetch costs you scenery, not the city. */
function overpassQL(s, w, n, e, kind, opt) {
  const bb = `${s},${w},${n},${e}`;
  // Buildings, and the green stuff that goes under them. Both are decoration, and
  // decoration belongs off the request the game cannot start without.
  if (kind === 'buildings') {
    return `[out:json][timeout:60];(` +
      `way["building"](${bb});` +
      `way["leisure"~"^(park|garden|golf_course)$"](${bb});` +
      `way["landuse"~"^(grass|forest|recreation_ground)$"](${bb});` +
      `);out geom qt;`;
  }
  /* The wide skeleton: the roads you'd cross a country on. Deliberately NOT the
     full drivable set — residential lanes are the overwhelming majority of a
     city's ways, and including them here is the difference between a few
     megabytes and a query the server refuses outright.

     Three rings in one union, so it stays one request and one round trip. The
     rings are built from the radius the ladder asked for, because that is the
     only thing that knows how far out this box reaches; without one, every ring
     collapses to the whole box and this is exactly the flat query it used to be —
     which is what the bundled city and the tests want. */
  if (kind === 'arterials') {
    const R = (opt && opt.radius) || 0;
    // +y is south, so the south edge is at +r and the north edge at -r
    const ring = r => (!R || r >= R) ? bb
      : `${unprojLat(r)},${unprojLon(-r)},${unprojLat(-r)},${unprojLon(r)}`;
    const near = ring(SKEL_NEAR), mid = ring(SKEL_MID);
    return `[out:json][timeout:90];(` +
      `way["highway"~"^(motorway|trunk)$"](${bb});` +
      `way["highway"~"^(primary|motorway_link|trunk_link)$"](${mid});` +
      `way["highway"~"^(secondary|primary_link|secondary_link)$"](${near});` +
      // Somewhere to aim at from a long way off, then the district names you only
      // ever read from inside a district.
      `node["place"~"^(city|town|village)$"](${bb});` +
      `node["place"~"^(suburb|neighbourhood|quarter|borough|city_block|hamlet)$"](${near});` +
      `);out geom qt;`;
  }
  // Landmarks over a much wider area than we could ever load streets for. These
  // are sparse and tag-indexed, so the area costs little — and `out center`
  // returns one point per hit instead of a whole building outline.
  if (kind === 'pois') {
    return `[out:json][timeout:40];(` +
      `nwr["amenity"~"^(police|hospital)$"](${bb});` +
      `nwr["shop"="car_repair"](${bb});` +
      `);out center qt;`;
  }
  // THE CRITICAL PATH. Nothing optional may live here: if this request fails you
  // get a generated grid instead of the place you asked for, and every extra
  // clause is more work between pressing DRIVE and driving. Roads to drive on,
  // and the place names for the district banner. That is all.
  return `[out:json][timeout:25];(` +
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bb});` +
    `node["place"~"^(suburb|neighbourhood|quarter|borough|city_block|hamlet|village|town|city)$"](${bb});` +
    `);out geom qt;`;
}

/* Overpass queues heavy queries instead of refusing them, so a mirror can accept
   the connection and then simply never answer. Every request therefore carries a
   hard deadline, and the whole load can be cancelled from the UI. */
/* Timeouts have to be longer than the [timeout:N] in the query they carry, or we
   kill the server mid-answer and never see a dense city at all. */
/* Start another mirror if the current one is still silent. Was 7s, which meant a
   mirror that fails in a second left the next one un-started for another six —
   the whole first ten seconds of a load could be spent retrying one dead host.
   Overpass is not hammered by this: whoever answers first cancels the rest, and
   `sess.streaming` stops a new one starting once a body is on the way. */
const HEDGE = 2200;
/* mirrorMs is how long a mirror gets to send its FIRST BYTE — the abort timer is
   cleared the moment the headers land, and the body after that is bounded by
   totalMs. Since Overpass computes the whole answer before it responds, this is
   really a compute budget, and it MUST outlast the [timeout:25] the query itself
   carries. tests/cfg.mjs holds that as an invariant.

   It was briefly cut to 12 s here, on the reasoning that a 1.8 km streets box
   comes back in under two seconds on a healthy mirror — the two captured sessions
   measure 0.4 s and 1.4 s — so a host silent at twelve was a host holding one of
   six slots for nothing. That reasoning was wrong in the way that matters: those
   are the times of mirrors that were WELL, and the case worth surviving is a
   mirror that is merely busy. The server is allowed twenty-five seconds to think,
   and hanging up at twelve throws away an answer that was coming.

   What made the silent-mirror problem look like this number's fault was the
   scheduler underneath it. A quiet host no longer costs anything, because a
   failure elsewhere promotes the next mirror immediately instead of waiting out a
   slot — see the queue below. */
const STREETS = { mirrorMs: 30000, totalMs: 42000 };   // query says timeout:25
const BUILDINGS = { mirrorMs: 70000, totalMs: 80000 }; // query says timeout:60
const POIS = { mirrorMs: 50000, totalMs: 60000 };      // query says timeout:40
const ARTERIALS = { mirrorMs: 22000, totalMs: 26000 };  // query says timeout:90, wide box
const MAX_TRIES = 2;     // retries per mirror, on transient failures only

/* Which mirrors are actually answering, learned as we go. Every request used to
   start at the head of the list and rediscover the same dead host for itself:
   with the streets query, the buildings, the skeleton and eight ring tiles all
   doing that, one unreachable mirror soaked up THIRTY connection attempts in a
   single load. Learn it once, and everything after goes to a host that works. */
const MIRROR_MISS = new Map();

/* AND IT IS KEPT ACROSS RELOADS, because a load throws away what it learned at
   exactly the moment that knowledge is worth the most.

   A mirror is not unreachable for a moment. It is unreachable from THIS network —
   a DNS answer, a national block, a CORS header it does not send — and it will be
   just as unreachable on the next load, and the one after. Likewise a host
   serving an empty database serves an empty database tomorrow. A freshly loaded
   page has no opinion about any of them, so it rediscovers all of it from
   scratch, every time, on the loading screen: the reported session opened by
   asking the one host that answers 200 with nothing in it.

   Halved on the way in rather than restored exactly, and forgotten after three
   days, so a mirror that was down yesterday is demoted rather than blacklisted
   and climbs back the first time it answers. The cap does the same job from the
   other end — no amount of failure can bury a host so deep it never gets another
   chance. */
const MIRROR_KEY = 'vmMirrorHealth';
const MIRROR_TTL = 3 * 24 * 3600 * 1000;
const MIRROR_CAP = 8;
/* WHEN A HOST HAS TOLD US TO COME BACK LATER, AND WHEN THAT IS.

   A 429 is the one refusal that comes with instructions. Every other failure
   leaves us guessing how long to stay away — this one carries `Retry-After`, and
   ignoring it is both rude and, as the reported session shows, slow.

   Held separately from MIRROR_MISS because it is a different KIND of fact. A
   miss count is an opinion about a host, accumulated and decayed; a park is a
   deadline the host itself set, and it expires on its own whether or not
   anything else happens. Folding "come back at 14:07:31" into a score would mean
   choosing a number of misses that stands in for it, and there isn't one: a
   score can be out-weighed by another host doing badly, and a deadline cannot.
   The reported session is exactly that failure — one 429 cost the same single
   miss as everything else in the round, so nobody fell behind anybody, and the
   throttled host was still first in the queue for the next six requests. */
const MIRROR_UNTIL = new Map();
/* Sixty seconds when the host does not say — WHICH IS ALMOST ALWAYS, and that
   is a fact about browsers rather than about Overpass.

   Retry-After is not a CORS-safelisted response header. On a cross-origin fetch
   the browser hides every header except a handful — content-type and
   content-length, in practice — unless the server explicitly names the others in
   Access-Control-Expose-Headers. Overpass mirrors send the CORS headers that let
   us read the BODY; they do not, in general, expose Retry-After. So the header a
   429 arrives with is genuinely invisible to this code, and measured to be:
   fulfilling a 429 with `Retry-After: 120` reads back null, and the same reply
   with `Access-Control-Expose-Headers: Retry-After` reads back "120".

   Which makes this constant the load-bearing part and the header the bonus. The
   status code is the instruction we can always read, and a 429 says "stop asking"
   whether or not it gets to say for how long. The parsing below stays because it
   is free, correct, and works for the mirrors that do expose it. */
const PARK_DEFAULT = 60000;
/* And no host is ever parked for more than five minutes, however long it asks
   for. A gateway having a bad day can answer `Retry-After: 3600`, and an hour is
   longer than anybody's session — obeying it literally would mean one bad minute
   removed a working mirror from the pool for good. Five minutes is far longer
   than the throttle windows Overpass actually uses and short enough that a host
   is always back before the player would notice it had gone. */
const PARK_MAX = 300000;

/* Retry-After is allowed to be either "in this many seconds" or an absolute HTTP
   date, and both turn up in the wild — a CDN in front of a mirror will often
   rewrite one into the other. Reading only the first form is not a small bug: a
   date parses as NaN, NaN falls back to zero, and zero means "not throttled at
   all", which is the precise opposite of what the header said. */
function retryAfterMs(h) {
  if (!h) return 0;
  const s = String(h).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s) * 1000);
  const t = Date.parse(s);
  return isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}
const mirrorParked = (url, now) => (MIRROR_UNTIL.get(url) || 0) > (now || Date.now());
function mirrorPark(url, ms) {
  const until = Date.now() + clamp(ms || PARK_DEFAULT, 1000, PARK_MAX);
  // never shorten a park that is already longer — two requests in flight can
  // both be refused, and the later reply is not news
  if (until > (MIRROR_UNTIL.get(url) || 0)) MIRROR_UNTIL.set(url, until);
  mirrorSave();
}

(() => {
  try {
    const j = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
    if (!j || !j.at || Date.now() - j.at > MIRROR_TTL) return;
    for (const u in j.miss) MIRROR_MISS.set(u, Math.floor(j.miss[u] / 2));
    /* Parks survive a reload, and unlike the miss counts they are NOT halved on
       the way in — a deadline is a deadline, and the whole point of it is that
       the host asked to be left alone until then. Reloading the page is the most
       likely thing in the world for a player to do when a load goes badly, and
       it must not be a way to go straight back to hammering the one host that
       asked for a minute. They carry absolute timestamps, so anything already
       expired is simply dropped on the way in. */
    const now = Date.now();
    for (const u in (j.until || {}))
      if (j.until[u] > now && j.until[u] < now + PARK_MAX) MIRROR_UNTIL.set(u, j.until[u]);
  } catch (e) {}      // privacy mode, or a corrupt entry: start with no opinion
})();
let mirrorSaveT = 0;
function mirrorSave() {
  // debounced: a load produces a burst of these and the storage write is the
  // only part of it that touches the disk
  clearTimeout(mirrorSaveT);
  mirrorSaveT = setTimeout(() => {
    try {
      const miss = {}, until = {}, now = Date.now();
      for (const [u, n] of MIRROR_MISS) if (n) miss[u] = Math.min(n, MIRROR_CAP);
      for (const [u, t] of MIRROR_UNTIL) if (t > now) until[u] = t;
      localStorage.setItem(MIRROR_KEY, JSON.stringify({ at: Date.now(), miss, until }));
    } catch (e) {}
  }, 1500);
}
/* AN EMPTY ANSWER COSTS MORE THAN A TIMEOUT, because it says more.

   A timeout or a 504 is a moment: that host was busy, and in ten seconds it may
   not be. An empty 200 is a fact about the host's database — it does not have
   what was asked for, and it will not have it in ten seconds either. Weighting
   them the same made the queue unable to learn the difference, and a reported
   session shows exactly what that looks like.

   One mirror answered NOTHING, in about 300 ms, to every query it was given for
   ninety-nine seconds: four skeleton rungs, the landmark sweep, and two street
   tiles. It stayed at the FRONT of the queue the whole time — because one empty
   reply cost it a single miss, and every other host was picking up a miss of its
   own in the same round for being slow or unreachable under the heavy opening
   requests. Nobody ever fell behind anybody. So the fastest way to get a wrong
   answer was asked first, every time, all session.

   Three is enough to settle it after a single round and still let one good reply
   wipe the slate, which matters because a host really can be repaired. */
const MIRROR_EMPTY_COST = 3;
const mirrorNote = (url, ok, cost) => {
  MIRROR_MISS.set(url, ok ? 0 : Math.min((MIRROR_MISS.get(url) || 0) + (cost || 1), MIRROR_CAP));
  // a host that just served a body is not throttling us, whatever it said before
  if (ok) MIRROR_UNTIL.delete(url);
  mirrorSave();
};
/* A PARKED HOST GOES BEHIND EVERY HOST THAT IS NOT PARKED, no matter how badly
   the others have been behaving. That is the whole fix: the queue is walked in
   this order and hedged in this order, so a host that asked for a minute is
   simply not among the first ones tried, and only gets asked at all if the
   request runs out of alternatives.

   It is a two-level sort rather than a filter, and that matters. Dropping parked
   hosts from the list would mean a moment when every mirror is throttled is a
   moment with no mirrors at all — and asking a host that told us to wait is
   still better than telling the player the map is unavailable. They are last,
   not gone. */
const mirrorsByHealth = () => {
  const now = Date.now();
  return OVERPASS.slice().sort((a, b) =>
    ((mirrorParked(a, now) ? 1 : 0) - (mirrorParked(b, now) ? 1 : 0)) ||
    ((MIRROR_MISS.get(a) || 0) - (MIRROR_MISS.get(b) || 0)));
};

/* WHO THIS REQUEST MAY ACTUALLY ASK. Parked hosts are left out of the queue
   altogether, not merely sorted to the back of it.

   Sorting them last was the first version and it did nothing measurable, because
   almost every request walks the WHOLE queue before it settles. A silent mirror
   holds its slot until the hedge timer moves past it; a mirror that answers an
   empty element list hands straight on, by design, since six independent servers
   agreeing that a box is empty is the only evidence that it really is. So being
   last in a queue that gets fully drained is the same as being first, just
   later — measured at eleven requests to a throttled host either way.

   Leaving them out is what "come back later" actually means. The all-parked
   fallback matters as much: a shared address behind a school or an office can
   collect a 429 from every mirror at once, and a request with an empty queue
   fails instantly and permanently. Asking a host that told us to wait is a poor
   option; having nowhere to ask is a worse one. */
function mirrorQueue() {
  const ranked = mirrorsByHealth();
  const now = Date.now();
  const open = ranked.filter(u => !mirrorParked(u, now));
  return open.length ? open : ranked;
}
// Overpass says these when it's busy, not when the query is wrong
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const LOAD = { cancelled: false, streaming: false, controllers: [], timers: [], bytes: 0, t0: 0, cancelP: null, cancel: null };

function loadReset() {
  loadAbort();
  LOAD.cancelled = false; LOAD.streaming = false; LOAD.bytes = 0; LOAD.t0 = Date.now();
  LOAD.lastErr = '';                 // or the last run's refusal haunts this one
  LOAD.cancelP = new Promise((_, rej) => { LOAD.cancel = () => { LOAD.cancelled = true; rej(new Error('cancelled')); }; });
  LOAD.cancelP.catch(() => {});   // the race handles it; don't warn if nobody's listening
}
function loadAbort() {
  for (const c of LOAD.controllers) { try { c.abort(); } catch (e) {} }
  for (const t of LOAD.timers) clearTimeout(t);
  LOAD.controllers = []; LOAD.timers = [];
}
function fetchTimeout(url, opts, ms, sess) {
  sess = sess || LOAD;
  const ctrl = new AbortController();
  sess.controllers.push(ctrl);
  const t = setTimeout(() => ctrl.abort(), ms);
  sess.timers.push(t);
  return fetch(url, Object.assign({ signal: ctrl.signal }, opts))
    .finally(() => clearTimeout(t));
}
// a fetch scope for background chunk loads, so they never touch the load screen's
function newSession() { return { cancelled: false, streaming: false, controllers: [], timers: [], bytes: 0 }; }
function sessAbort(s) {
  for (const c of s.controllers) { try { c.abort(); } catch (e) {} }
  for (const t of s.timers) clearTimeout(t);
  s.controllers = []; s.timers = [];
}

async function geocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
  const t0 = Date.now();
  const r = await fetchTimeout(url, { headers: { 'Accept': 'application/json' } }, 12000);
  if (!r.ok) throw new Error('geocoder ' + r.status);
  // read as text so the log gets the reply exactly as sent, same as Overpass
  const raw = await r.text();
  LOG.osm({ kind: 'geocode', host: host(url), status: r.status, ms: Date.now() - t0,
            query: q, body: raw });
  const j = JSON.parse(raw);
  if (!j.length) throw new Error('no such place');
  return { lat: +j[0].lat, lon: +j[0].lon, name: j[0].display_name.split(',').slice(0, 2).join(',') };
}

/* Stream the body so a big city reports real progress instead of a frozen bar. */
async function readBody(res, onBytes) {
  if (!res.body || !res.body.getReader) return res.text();
  const reader = res.body.getReader(), dec = new TextDecoder();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    parts.push(dec.decode(value, { stream: true }));
    onBytes(got);
  }
  parts.push(dec.decode());
  return parts.join('');
}

/* Hedged mirror racing: fire the first straight away, bring in the next one if it
   goes quiet, and take whichever answers first. Bounded by TOTAL_MS either way. */
/* One hedged, deadline-bounded Overpass request for an arbitrary bbox. Used for
   the opening area and for every streamed-in chunk after it. */
function overpassArea(s, w, n, e, sess, opt) {
  opt = opt || {};
  const kind = opt.kind || 'streets';
  const tune = kind === 'buildings' ? BUILDINGS : kind === 'pois' ? POIS
              : kind === 'arterials' ? ARTERIALS : STREETS;
  /* Built ONCE, out here. Inside attempt() the retry counter is also called `n`,
     which shadows the north latitude — reading s/w/n/e from in there records a
     bbox with the retry number in it and a query to match. The request body
     already had to be built out here for the same reason; the log needs the same
     treatment or it quietly describes a different area than the one fetched. */
  const ql = overpassQL(s, w, n, e, kind, opt);
  const bbox = { s, w, n, e };
  const body = 'data=' + encodeURIComponent(ql);
  // when this whole request gives up, so a retry can tell whether it would land
  // after the funeral
  const dueBy = Date.now() + (opt.totalMs || tune.totalMs);
  const onMsg = opt.onMsg || (() => {});
  const onBytes = opt.onBytes || (() => {});
  let live = 0;

  const attempt = (url, resolve, reject) => {
    const run = async (n) => {
      if (sess.cancelled) return reject(new Error('cancelled'));
      /* If another mirror is already sending us the body, don't pile on — wait
         and re-check, so we still have a runner if that one dies mid-stream.
         Re-checked briskly rather than every five seconds: the streamer that
         everyone is parked behind can fail in the first second, and waiting out
         four more before anybody notices is four seconds of loading screen. */
      if (sess.streaming) {
        const w8 = setTimeout(() => run(n), 1200);
        sess.timers.push(w8);
        return;
      }
      live++;
      onMsg(live > 1 ? 'Asking ' + live + ' map servers…' : (opt.label || 'Surveying the streets…'));
      const t0 = Date.now();
      try {
        const r = await fetchTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        }, tune.mirrorMs, sess);
        if (!r.ok) {
          const e = new Error('overpass ' + r.status);
          e.status = r.status;
          e.retryAfter = retryAfterMs(r.headers.get('retry-after'));
          throw e;
        }
        sess.streaming = true;             // headers in hand: stop hedging
        // Captured here, as text, BEFORE anything parses it — the log is meant to
        // be a recording of what the server said, not of what we made of it.
        const raw = await readBody(r, onBytes);
        LOG.osm({ kind, host: host(url), status: r.status, ms: Date.now() - t0,
                  bbox, query: ql, body: raw });
        const j = JSON.parse(raw);
        if (!j || !j.elements) throw new Error('empty response');

        /* A MIRROR THAT ANSWERS 200 WITH NOTHING IN IT IS NOT A HEALTHY MIRROR.

           From a real session: one host returned an empty element list, in about
           130 ms, for every query it was ever given. Its first empty answer was
           to the landmark sweep, where empty is perfectly normal, so it was
           marked healthy and went to the front of the queue — while every other
           mirror had picked up misses being slow under the heavy opening
           requests. From then on it won every hedge, because 130 ms beats
           everything, and returned nothing every time. SEVEN of the eight
           opening tiles died as "empty tile" and the detailed city came out two
           tiles wide instead of nine.

           So an empty body never promotes a mirror, and it is never the answer.

           The first version of this rule made an exception for landmarks and
           scenery, on the reasoning that a box really can have none in it. The
           next session showed what that exception costs: the same host answered
           nothing to the 36 km landmark sweep and to three of the four scenery
           tiles, and every one was accepted, because each was individually
           plausible. It ended with ONE landmark in a 36 km radius of central
           Belgrade and no repair shop anywhere — which is what was reported, as
           not being able to find one.

           So there is no exception. An empty box is a real thing and a mirror
           serving an empty database is a real thing, and NOTHING IN THE REPLY
           TELLS THEM APART — both are 200 with an element list of length zero.
           What separates them is that asking somebody else is cheap and being
           wrong is not: an empty reply arrives in a quarter of a second and
           releases the next mirror immediately, so the whole ladder costs about
           a second, while accepting one silently deletes a district's worth of
           the map. When the box genuinely is empty every mirror says so, the
           request fails, and a failed scenery tile is already handled — it backs
           off and comes round again, which is the correct behaviour for ground
           that has nothing on it. */
        if (!j.elements.length) {
          // the demotion happens once, in the catch below, which sees every kind
          // of refusal and knows this one was an empty reply from e.empty
          // let the other mirrors off the leash — they are parked on this flag
          sess.streaming = false;
          const e = new Error('returned nothing');
          e.empty = true;
          throw e;
        }
        mirrorNote(url, true);             // this one answers; keep it at the front
        /* How long the mirror that ACTUALLY ANSWERED took, on its own. The
           opening ring is sized off this, and the wall clock is no substitute:
           it carries the geocode, and every mirror that was unreachable or slow
           before a good one came through, none of which says anything about how
           heavy this area's streets are. */
        sess.replyMs = Date.now() - t0;
        sess.replyBytes = raw.length;
        resolve(j.elements);
      } catch (err) {
        // 429/5xx and network errors mean "busy, come back"; a 400 means our query
        // is wrong and will never work. Our own timeout is left to the other mirrors.
        const aborted = err && err.name === 'AbortError';
        // an empty answer is not transient — the same host will just say it
        // again, instantly. Give the query to a different mirror instead.
        const empty = !!(err && err.empty);
        /* NOR IS "I COULD NOT REACH IT". fetch() rejects with a TypeError when the
           request never got to the server at all: DNS, TLS, a refused connection,
           or a CORS preflight the host does not answer. None of those is a busy
           moment — it is this browser, on this network, being unable to talk to
           that host, and it will be just as unable in two seconds. The reported
           session spent three attempts and 2.2 s of loading screen rediscovering
           that about one mirror while a working one sat further down the queue,
           unasked. */
        const unreachable = !!(err && err.name === 'TypeError');
        const retryable = !aborted && !empty && !unreachable &&
                          (err.status == null || TRANSIENT.has(err.status));
        // note who said no and what they said, for the loading screen to show
        // and this one goes to the back of the queue — further back if what it
        // said was "I have nothing", which it will say again just as quickly
        mirrorNote(url, false, empty ? MIRROR_EMPTY_COST : 1);
        /* A 429 IS NOT JUST ANOTHER MISS — it is the host telling us, in as many
           words, to stop asking. So it is recorded as a deadline rather than as a
           score, and the queue puts this host behind everyone else until then.

           From the reported session: one mirror answered 429 and was then asked
           six more times over the following minute — the skeleton rungs, the
           landmark sweep, two tiles — and refused every one of them in about
           200 ms, because a single miss was not enough to move it down a queue
           in which everybody else was picking up misses of their own for being
           slow. Fast refusals kept winning the race to be wrong.

           503 gets the same treatment when, and only when, it comes with the
           header: an unqualified 503 is "I am unwell", which the miss count
           already handles, but a 503 that names a time is the same instruction a
           429 is and deserves the same respect. */
        if (err.status === 429) mirrorPark(url, err.retryAfter);
        else if (err.retryAfter > 0 && TRANSIENT.has(err.status)) mirrorPark(url, err.retryAfter);
        // (err.retryAfter is usually 0 even on a 429 — see PARK_DEFAULT — so the
        // first line is the one that fires in the wild and the second is for the
        // mirror that exposes the header)
        LOAD.lastErr = host(url) + ': ' +
          (aborted ? 'too slow' : empty ? 'returned nothing' : err.status ? err.status
           : err.status == null ? 'unreachable' : err.message);
        // a refusal never reaches console.warn — the retry usually saves the day —
        // so it is recorded here or the log would show a clean load that wasn't
        LOG.note('mirror', kind + ' · ' + LOAD.lastErr + ' (' + (Date.now() - t0) + 'ms)');
        /* HAND THE SLOT ON NOW, whatever happens to this host next. Whether it
           earns another go after a backoff is a completely separate question from
           whether the next host should still be sitting idle waiting for its
           turn on the clock. */
        startNext();
        const wait = Math.max(err.retryAfter || 0, 1200 * Math.pow(2, n) + Math.random() * 700);
        /* AND A RETRY THAT WOULD LAND AFTER THE DEADLINE IS NOT SCHEDULED AT ALL.

           Honouring Retry-After makes this possible for the first time: the
           backoff used to be at most a few seconds and always fitted, but a host
           can now legitimately ask for a minute, and a streets request only has
           forty-two seconds to live. Setting that timer would hold this promise
           open, unresolved, until the deadline killed the whole request — so the
           caller would wait out the full budget to be told what was already
           known. Rejecting now lets the request settle on whatever another
           mirror said. */
        /* AND A PARKED HOST IS NOT RETRIED EITHER. Leaving it out of the queue
           governs the NEXT request; this governs the one already in flight, and
           without it a 429 was still followed by a retry a second and a half
           later — the single most direct way to ignore what the host said. */
        if (retryable && n + 1 <= MAX_TRIES && !sess.cancelled &&
            !mirrorParked(url) && Date.now() + wait < dueBy) {
          onMsg('Map server busy — retrying…');
          const t = setTimeout(() => run(n + 1), wait);
          sess.timers.push(t);
        } else reject(err);
      }
    };
    run(0);
  };

  /* THE MIRRORS ARE A QUEUE, NOT A TIMETABLE.

     What was here started mirror i at i × HEDGE and never deviated from it: six
     hosts on a fixed 2.2 second grid, so the sixth was not contacted until eleven
     seconds in no matter what the first five had done. A reported session shows
     what that costs. By twelve seconds one mirror had served an empty database,
     one was unreachable and had been retried twice more, one had returned 504
     twice, two were sitting silent holding their slots — and the sixth had never
     been asked at all. The player was still looking at the loading screen, and
     gave up.

     A failure now pulls the next mirror forward instead of letting its slot go
     unused. THE SAME SIX REQUESTS GO TO THE SAME SIX HOSTS IN THE SAME ORDER —
     nothing here asks more of Overpass than before, which matters, because the
     way to actually get blocked is to answer flakiness by hammering. The only
     thing that changes is that a host which says no in 400 ms hands its slot
     straight on rather than leaving it empty for another 1.8 seconds. On the
     reported session that is all six tried inside about five seconds instead of
     three tried in twelve.

     The HEDGE timer stays as the slow path, for the case a failure never comes:
     a mirror that goes quiet is not a failure, and the next one still has to
     start without waiting for it. */
  const queue = mirrorQueue();
  const starters = [];
  const tries = queue.map(url => new Promise((res, rej) => {
    starters.push(() => attempt(url, res, rej));
  }));
  let started = 0, hedgeT = 0;
  function startNext() {
    if (started >= starters.length || sess.cancelled) return;
    starters[started++]();
    clearTimeout(hedgeT);
    if (started < starters.length) {
      hedgeT = setTimeout(startNext, HEDGE);
      sess.timers.push(hedgeT);
    }
  }
  startNext();
  const deadline = new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error('timed out')), opt.totalMs || tune.totalMs);
    sess.timers.push(t);
  });
  deadline.catch(() => {});

  /* AND IF THEY ALL SAY NOTHING, THERE IS NOTHING THERE. An empty reply is
     refused above because one mirror's silence is worthless as evidence — but
     six independent servers agreeing is not, and it is the only thing that ever
     distinguishes a genuinely empty box from a broken database. It costs about a
     second, since empty answers come back fast and each one releases the next
     mirror immediately, and it buys the difference between "this ground has
     nothing on it" and "this request failed": a tile over open water settles as
     loaded-and-empty instead of failing, backing off, and being asked for again
     every ninety seconds for as long as you drive near it. */
  const allEmpty = Promise.any(tries).catch(err => {
    const list = (err && err.errors) || [];
    if (list.length && list.every(e => e && e.empty)) return [];
    throw new Error('all mirrors failed');
  });
  const racers = [allEmpty, deadline];
  if (sess.cancelP) racers.push(sess.cancelP);
  return Promise.race(racers).finally(() => sessAbort(sess));
}

function areaBox(lat, lon) {
  const dLat = RADIUS / 110540, dLon = RADIUS / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}
function fetchStreets(lat, lon, onMsg, onBytes) {
  const b = areaBox(lat, lon);
  return overpassArea(b[0], b[1], b[2], b[3], LOAD, { kind: 'streets', onMsg, onBytes });
}
function fetchBuildings(lat, lon, sess) {
  const b = areaBox(lat, lon);
  return overpassArea(b[0], b[1], b[2], b[3], sess, { kind: 'buildings' });
}
