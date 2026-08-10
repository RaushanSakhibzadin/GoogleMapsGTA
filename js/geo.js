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

/* The city is 36 km across, and it all arrives before you drive.
   Full detail — every lane, every service road — only covers the tiles around
   where you start. Out past those, the world is the ARTERIAL SKELETON: the roads
   you'd actually take to cross a city, fetched once over an 18 km half-width.
   Asking for every street in a box that size is 15-40 MB and times out in any
   real city; the trunk roads alone are a few, and they're what makes the place
   feel like somewhere with a horizon. Nothing about the road network is ever
   requested again after this — once you're driving, only scenery loads. */
const SKELETON_RADII = [18000, 9000, 4000];   // tried in order; first one to land wins
const SKELETON_MS = [28000, 12000, 8000];     // per attempt, so the ladder can't run away
const SKELETON_WAIT = 45000;                  // shared deadline over the whole ladder

/* Two queries, not one. Streets are small and quick and are all you need to start
   driving; buildings are the bulk of the payload and arrive afterwards. Splitting
   them means a slow or refused building fetch costs you scenery, not the city. */
function overpassQL(s, w, n, e, kind) {
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
  // The wide skeleton: the roads you'd cross a city on, over an area 400x the
  // detailed one. Deliberately NOT the full drivable set — residential lanes are
  // the overwhelming majority of a city's ways, and including them here is the
  // difference between a few megabytes and a query the server refuses outright.
  if (kind === 'arterials') {
    return `[out:json][timeout:90];(` +
      `way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link|secondary_link)$"](${bb});` +
      `node["place"~"^(suburb|neighbourhood|quarter|borough|city_block|hamlet|village|town|city)$"](${bb});` +
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
const STREETS = { mirrorMs: 30000, totalMs: 42000 };   // query says timeout:25
const BUILDINGS = { mirrorMs: 70000, totalMs: 80000 }; // query says timeout:60
const POIS = { mirrorMs: 50000, totalMs: 60000 };      // query says timeout:40
const ARTERIALS = { mirrorMs: 40000, totalMs: 45000 };  // query says timeout:90, big box
const MAX_TRIES = 2;     // retries per mirror, on transient failures only

/* Which mirrors are actually answering, learned as we go. Every request used to
   start at the head of the list and rediscover the same dead host for itself:
   with the streets query, the buildings, the skeleton and eight ring tiles all
   doing that, one unreachable mirror soaked up THIRTY connection attempts in a
   single load. Learn it once, and everything after goes to a host that works. */
const MIRROR_MISS = new Map();
const mirrorNote = (url, ok) => MIRROR_MISS.set(url, ok ? 0 : (MIRROR_MISS.get(url) || 0) + 1);
const mirrorsByHealth = () =>
  OVERPASS.slice().sort((a, b) => (MIRROR_MISS.get(a) || 0) - (MIRROR_MISS.get(b) || 0));
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
  const ql = overpassQL(s, w, n, e, kind);
  const bbox = { s, w, n, e };
  const body = 'data=' + encodeURIComponent(ql);
  const onMsg = opt.onMsg || (() => {});
  const onBytes = opt.onBytes || (() => {});
  let live = 0;

  const attempt = (url, delay) => new Promise((resolve, reject) => {
    const run = async (n) => {
      if (sess.cancelled) return reject(new Error('cancelled'));
      // if another mirror is already sending us the body, don't pile on — wait and
      // re-check, so we still have a runner if that one dies mid-stream
      if (sess.streaming) {
        const w8 = setTimeout(() => run(n), 5000);
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
          e.retryAfter = (parseFloat(r.headers.get('retry-after')) || 0) * 1000;
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

           So an empty body never promotes a mirror, whatever was asked for. And
           for roads specifically it is treated as a failure and handed to
           somebody else: a city tile with no streets in it is wrong, and the
           cost of being wrong is the whole road network. */
        if (!j.elements.length) {
          mirrorNote(url, false);
          if (kind === 'streets' || kind === 'arterials') {
            // let the other mirrors off the leash — they are parked on this flag
            sess.streaming = false;
            const e = new Error('returned nothing');
            e.empty = true;
            throw e;
          }
        } else mirrorNote(url, true);      // this one answers; keep it at the front
        resolve(j.elements);
      } catch (err) {
        // 429/5xx and network errors mean "busy, come back"; a 400 means our query
        // is wrong and will never work. Our own timeout is left to the other mirrors.
        const aborted = err && err.name === 'AbortError';
        // an empty answer is not transient — the same host will just say it
        // again, instantly. Give the query to a different mirror instead.
        const empty = !!(err && err.empty);
        const retryable = !aborted && !empty && (err.status == null || TRANSIENT.has(err.status));
        // note who said no and what they said, for the loading screen to show
        mirrorNote(url, false);            // and this one goes to the back of the queue
        LOAD.lastErr = host(url) + ': ' +
          (aborted ? 'too slow' : empty ? 'returned nothing' : err.status ? err.status
           : err.status == null ? 'unreachable' : err.message);
        // a refusal never reaches console.warn — the retry usually saves the day —
        // so it is recorded here or the log would show a clean load that wasn't
        LOG.note('mirror', kind + ' · ' + LOAD.lastErr + ' (' + (Date.now() - t0) + 'ms)');
        if (retryable && n + 1 <= MAX_TRIES && !sess.cancelled) {
          const wait = Math.max(err.retryAfter || 0, 1200 * Math.pow(2, n) + Math.random() * 700);
          onMsg('Map server busy — retrying…');
          const t = setTimeout(() => run(n + 1), wait);
          sess.timers.push(t);
        } else reject(err);
      }
    };
    const t = setTimeout(() => run(0), delay);
    sess.timers.push(t);
  });

  const tries = mirrorsByHealth().map((u, i) => attempt(u, i * HEDGE));
  const deadline = new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error('timed out')), opt.totalMs || tune.totalMs);
    sess.timers.push(t);
  });
  deadline.catch(() => {});

  const racers = [
    Promise.any(tries).catch(() => { throw new Error('all mirrors failed'); }),
    deadline
  ];
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
