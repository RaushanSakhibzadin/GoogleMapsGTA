"use strict";
/* VICE MAPS — the radio.

   Part of a set of plain <script> files sharing one global scope. Load order is
   fixed in index.html and matters: this needs LOG (for the network capture) and
   is used by main.js.

   REAL STATIONS FROM THE PLACE YOU ARE DRIVING IN, out of the Radio Browser
   community database — which is the same idea as OpenStreetMap and run the same
   way: open data, no key, no account, a public API anyone may query. Type
   Belgrade and the dial has Belgrade stations on it; type Osaka and it does not.

   THREE THINGS THAT DECIDE WHETHER THIS WORKS AT ALL, none of them obvious:

   HTTPS ONLY. The game is served over HTTPS from GitHub Pages, and a browser
   refuses to load an http:// stream into an https:// page as mixed content —
   silently, with nothing in the console that a player would ever see. A great
   many stations in that database are still plain http, so filtering them out is
   not tidying, it is the difference between a dial that plays and a dial that
   does nothing on every third station.

   A REAL TAP. iOS will not start audio outside a user gesture, so nothing here
   ever calls play() on a timer or on load — the first sound happens on the tap
   that asks for it, and every later tap is another chance to recover.

   AND IT MUST NEVER MATTER. The database can be down, the country can have no
   stations in it, the phone can be offline, the whole request can be blocked by
   a network that dislikes it. Every one of those ends with a dial that says so
   and a game that plays exactly as it did before. */

/* The mirrors, in the order they are tried. `all.` is a round-robin over the
   community's servers and is the documented front door; the two named ones are
   there for the same reason js/geo.js keeps a list of Overpass mirrors — one
   host being unreachable from one carrier is a Tuesday, not an outage. */
const RADIO_HOSTS = [
  'https://all.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info'
];

const RADIO = {
  list: [], i: -1, on: false,
  status: 'idle',            // idle | finding | none | ready | playing | error
  err: '', el: null, tried: 0
};

function radioEl() {
  if (RADIO.el) return RADIO.el;
  const a = document.createElement('audio');
  a.id = 'radioA';
  a.preload = 'none';
  a.crossOrigin = 'anonymous';
  a.volume = 0.55;
  /* A stream that dies mid-song is the normal case, not an exception: these are
     volunteer transmitters and half of them drop a connection an hour. Saying so
     on the dial and leaving the player to press for the next one is better than
     silence they have to diagnose. */
  a.addEventListener('error', () => {
    if (!RADIO.on) return;
    RADIO.status = 'error';
    RADIO.err = 'stream failed';
    radioPaint();
  });
  a.addEventListener('playing', () => {
    RADIO.status = 'playing'; RADIO.err = ''; radioPaint();
  });
  a.addEventListener('stalled', () => { if (RADIO.on) radioPaint(); });
  document.body.appendChild(a);
  return (RADIO.el = a);
}

/* Metres between two points on the ground, near enough for sorting a list of
   radio stations by how local they are. */
function radioDist(aLat, aLon, bLat, bLon) {
  const k = Math.cos((aLat + bLat) * 0.5 * Math.PI / 180);
  return Math.hypot((aLat - bLat) * 110540, (aLon - bLon) * 111320 * k);
}

/* WHAT COUNTS AS LOCAL, and why it is two questions rather than one.

   The country code is the reliable filter — every station record has one and
   the API indexes on it — but a country is not a place: asked for Serbia you
   get Belgrade, Niš and Novi Sad in whatever order the database feels like.
   Each record also carries the transmitter's own coordinates when somebody has
   filled them in, so the list is SORTED by distance from where you are actually
   driving, with the ones nobody has placed sinking to the bottom on popularity
   instead of being thrown away. Between them you get the city's own stations
   first and the country's after, which is what a car radio does. */
function radioRank(list, lat, lon) {
  return list
    .filter(s => s && s.url && /^https:/i.test(s.url))
    .map(s => {
      const glat = parseFloat(s.geo_lat), glon = parseFloat(s.geo_long);
      const placed = isFinite(glat) && isFinite(glon) && (glat || glon);
      return { name: (s.name || '').trim().slice(0, 28) || 'UNNAMED',
               url: s.url, tags: s.tags || '',
               km: placed ? radioDist(lat, lon, glat, glon) / 1000 : null,
               pop: +s.clickcount || 0 };
    })
    .sort((a, b) => {
      if (a.km != null && b.km != null) return a.km - b.km;
      if (a.km != null) return -1;
      if (b.km != null) return 1;
      return b.pop - a.pop;
    })
    .slice(0, 24);
}

function radioURL(host, lat, lon, cc) {
  const q = ['limit=120', 'hidebroken=true', 'order=clickcount', 'reverse=true'];
  if (cc) q.push('countrycode=' + encodeURIComponent(cc.toUpperCase()));
  /* Asked for as well as sorted for. Servers that understand it hand back a
     local set; servers that do not ignore the three parameters and hand back
     the country, which the ranking above then sorts. Either way the answer is
     usable, which is why this is a request rather than a requirement. */
  q.push('geo_lat=' + lat.toFixed(4), 'geo_long=' + lon.toFixed(4), 'geo_distance=120000');
  return host + '/json/stations/search?' + q.join('&');
}

/* Looked up once per city, in the background, after the map is already up.
   Nothing waits for it. */
async function radioFind(lat, lon, cc) {
  RADIO.status = 'finding'; RADIO.err = ''; RADIO.list = []; RADIO.i = -1;
  radioPaint();
  for (const h of RADIO_HOSTS) {
    const url = radioURL(h, lat, lon, cc);
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(url, { headers: { Accept: 'application/json' },
                                   signal: ctrl.signal });
      clearTimeout(timer);
      const raw = await r.text();
      if (typeof LOG !== 'undefined' && LOG.osm)
        LOG.osm({ kind: 'radio', host: h, status: r.status, ms: Date.now() - t0,
                  query: url, body: raw });
      if (!r.ok) continue;
      const list = radioRank(JSON.parse(raw), lat, lon);
      if (!list.length) continue;
      RADIO.list = list; RADIO.i = 0;
      RADIO.status = 'ready';
      radioPaint();
      return list.length;
    } catch (e) {
      RADIO.err = String((e && e.message) || e).slice(0, 60);
      if (typeof LOG !== 'undefined' && LOG.note) LOG.note('radio', h + ': ' + RADIO.err);
    }
  }
  /* NOT AN ERROR ON THE DIAL. Nobody driving cares which of five things went
     wrong with a radio directory; they care that there is no radio here. */
  RADIO.status = 'none';
  radioPaint();
  return 0;
}

/* Playing is only ever done from a tap — see the note at the top. */
function radioPlay() {
  if (!RADIO.list.length) return false;
  const s = RADIO.list[RADIO.i];
  if (!s) return false;
  const a = radioEl();
  RADIO.on = true;
  RADIO.status = 'loading'; RADIO.err = '';
  if (a.src !== s.url) a.src = s.url;
  const pr = a.play();
  if (pr && pr.catch) pr.catch(e => {
    if (!RADIO.on) return;
    RADIO.status = 'error';
    RADIO.err = String((e && e.name) || e).slice(0, 40);
    radioPaint();
  });
  radioPaint();
  return true;
}
function radioStop() {
  RADIO.on = false;
  const a = RADIO.el;
  if (a) { try { a.pause(); } catch (e) {} }
  RADIO.status = RADIO.list.length ? 'ready' : (RADIO.status === 'none' ? 'none' : 'idle');
  radioPaint();
}
function radioToggle() {
  if (RADIO.on) { radioStop(); return false; }
  return radioPlay();
}
/* Step the dial. Wraps, because a dial that stops at the end of the band is a
   list, and because with the local stations sorted first the far end is where
   the country's big networks live — worth reaching from either direction. */
function radioStep(d) {
  if (!RADIO.list.length) return false;
  RADIO.i = (RADIO.i + (d || 1) + RADIO.list.length) % RADIO.list.length;
  if (RADIO.on) return radioPlay();
  radioPaint();
  return true;
}

/* What the dial says. One line, because it lives in a strip under the radar and
   is read at a glance at 90 km/h. */
function radioLabel() {
  const s = RADIO.list[RADIO.i];
  if (RADIO.status === 'finding') return 'TUNING…';
  if (RADIO.status === 'none') return 'NO STATIONS HERE';
  if (!s) return 'RADIO OFF';
  if (RADIO.status === 'error') return s.name + ' · DEAD AIR';
  if (RADIO.status === 'loading') return s.name + ' …';
  if (!RADIO.on) return s.name + ' · OFF';
  return s.name;
}
function radioPaint() {
  const el = typeof $ === 'function' ? $('radio') : document.getElementById('radio');
  if (!el) return;
  const n = document.getElementById('radioN');
  if (n) n.textContent = radioLabel();
  el.classList.toggle('on', RADIO.status !== 'idle');
  el.classList.toggle('live', RADIO.on && RADIO.status === 'playing');
}
