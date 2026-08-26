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
  err: '', el: null, at: null
};

/* WHERE WE ARE, REMEMBERED WITHOUT ASKING ANYONE ANYTHING.

   The dial used to look itself up the moment a city finished loading. It is a
   third-party server, on a connection that may be metered, for a feature the
   player has not asked for yet — and when it cannot be reached the browser logs
   a failed resource load, three times, which is noise in everybody's console
   for a radio nobody switched on.

   So the city is only recorded here, and the FIRST PRESS tunes. That is how a
   car radio works, it uses nothing until it is wanted, and the press is a real
   user gesture — which is the only thing iOS will start audio from anyway. */
function radioAt(lat, lon, cc) {
  RADIO.at = { lat, lon, cc: cc || '' };
  RADIO.list = []; RADIO.i = -1; RADIO.on = false;
  RADIO.status = 'idle'; RADIO.err = '';
  radioPaint();
}

/* A DIFFERENT STATION EVERY TIME A CITY IS TUNED, chosen from the local ones.

   Random over the whole list would defeat the ranking: the dial is sorted by
   how close each transmitter is, so the far end of it is the national networks
   two hundred kilometres away. So the draw is from the NEAR HALF — at least
   four so a short list still has somewhere to go, and never more than half —
   which keeps "random" and "local" both true.

   AND IT NEVER PICKS THE ONE ALREADY PLAYING, because a draw that sometimes
   does nothing reads as a broken button. With two stations that means it
   alternates, which is the only honest thing two stations can do.

   ONE CALLER: radioFind, at the end of tuning a city. It was also rolled on
   every shunt, so a crash knocked the dial off its station the way a real car
   radio used to — which sounds better than it plays. Being hit already has the
   bang, the shake, the sparks and the damage on it, and losing the song you had
   on top of all that reads as the game taking it away from you at the one moment
   you are busiest. */
function radioRandom() {
  const n = RADIO.list.length;
  if (n < 2) return n === 1 ? (RADIO.i = 0, true) : false;
  const pool = Math.max(4, Math.min(n, Math.ceil(n / 2)));
  let k = RADIO.i;
  for (let tries = 0; tries < 12 && k === RADIO.i; tries++)
    k = Math.floor(Math.random() * pool) % n;
  RADIO.i = k === RADIO.i ? (RADIO.i + 1) % n : k;
  return true;
}

/* THE DIAL'S OWN LEVEL, KEPT APART FROM THE GAME'S.

   They are different things — an engine note you want under a conversation and
   a song you want over it — and one slider for both is the thing people
   complain about in every game that ships one. It is also a different mechanism:
   the sound effects run through a WebAudio bus and the radio is an <audio>
   element, which has a volume of its own and never touches that graph.

   Read lazily for the same reason the sound effects read theirs: `store` is
   defined in js/game.js, which is evaluated after this file. */
const RADIO_VOL_KEY = 'vm_vol_radio';
let radioVol = null;
function radioVolume(v) {
  if (v != null) {
    radioVol = Math.max(0, Math.min(1, +v || 0));
    if (typeof store !== 'undefined') store.set(RADIO_VOL_KEY, radioVol.toFixed(3));
    if (RADIO.el) RADIO.el.volume = radioVol;
    return radioVol;
  }
  if (radioVol == null) {
    const raw = (typeof store !== 'undefined') ? store.get(RADIO_VOL_KEY, null) : null;
    const n = raw == null ? NaN : parseFloat(raw);
    radioVol = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.55;
  }
  return radioVol;
}

function radioEl() {
  if (RADIO.el) return RADIO.el;
  const a = document.createElement('audio');
  a.id = 'radioA';
  a.preload = 'none';
  a.crossOrigin = 'anonymous';
  a.volume = radioVolume();
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
      return { name: (s.name || '').trim().slice(0, 34) || 'UNNAMED',
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
      // and the first station of a session is a draw, not always the nearest
      radioRandom();
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

/* The first press does the looking up. Everything below returns a promise so a
   caller can wait; nothing in the game does. */
async function radioWake() {
  if (RADIO.list.length || RADIO.status === 'finding') return RADIO.list.length;
  if (!RADIO.at) return 0;
  return radioFind(RADIO.at.lat, RADIO.at.lon, RADIO.at.cc);
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
  if (!RADIO.list.length) { radioWake().then(n => { if (n) radioPlay(); }); return true; }
  return radioPlay();
}
/* Step the dial. Wraps, because a dial that stops at the end of the band is a
   list, and because with the local stations sorted first the far end is where
   the country's big networks live — worth reaching from either direction. */
function radioStep(d) {
  if (!RADIO.list.length) {
    radioWake().then(n => { if (n) radioPlay(); });
    return true;
  }
  RADIO.i = (RADIO.i + (d || 1) + RADIO.list.length) % RADIO.list.length;
  if (RADIO.on) return radioPlay();
  radioPaint();
  return true;
}

/* What the dial says. One line, because it is read at a glance at 90 km/h.

   AND NOTHING IS APPENDED WHEN IT IS SIMPLY OFF. It used to read "Studio B · OFF",
   which is a fifth of the bar spent on something the button's own colour already
   says — it goes gold and glows while a station is playing and is plain the rest
   of the time. Real station names run to thirty characters ("Radio Televizija
   Vojvodine 021" is a Novi Sad station, not an invention), and those six extra
   characters were the difference between the whole name and an ellipsis.

   The two states that are NOT obvious from a colour still say so: a stream that
   died, and one still opening. */
function radioLabel() {
  const s = RADIO.list[RADIO.i];
  if (RADIO.status === 'idle') return 'RADIO';
  if (RADIO.status === 'finding') return 'TUNING…';
  if (RADIO.status === 'none') return 'NO STATIONS HERE';
  if (!s) return 'RADIO OFF';
  if (RADIO.status === 'error') return s.name + ' · DEAD AIR';
  if (RADIO.status === 'loading') return s.name + ' …';
  return s.name;
}

/* THE LAST RESORT, for a name too long even for two lines.

   Almost nothing reaches this: the stylesheet wraps the name across two lines
   and the ranker truncates at 34 characters, which fits. It is here for the
   short-screen case — in landscape the bar is 44 points tall and holds two lines
   of 12.5 point with very little to spare — and for the fonts this does not know
   about, since the box is sized in points and the type is whatever the phone
   decided to use.

   Stepped rather than solved, because the thing that overflows here is HEIGHT,
   and height goes down in whole lines: there is no ratio to divide by, only the
   size at which the third line stops existing. Floored at 11 points, below which
   a clipped name is the better failure — you can at least tell it is clipped. */
function radioFit(n) {
  const base = parseFloat(getComputedStyle(n).getPropertyValue('--nameFs')) || 14;
  n.style.fontSize = base + 'px';
  const over = () => n.scrollHeight > n.clientHeight + 1 ||
                     n.scrollWidth > n.clientWidth + 1;
  for (let px = base - 0.5; px >= 11 && over(); px -= 0.5)
    n.style.fontSize = px + 'px';
}

function radioPaint() {
  const el = typeof $ === 'function' ? $('radio') : document.getElementById('radio');
  if (!el) return;
  const n = document.getElementById('radioN');
  if (n) { n.textContent = radioLabel(); radioFit(n); }
  /* THE CLASS GOES ON <html>, not on the bar. The bar reserves a strip at the
     bottom of the screen and everything else has to lift by that much — which is
     done with a custom property declared on :root, and a property set further
     down the tree cannot reach it. So the root carries the switch and the bar
     shows itself from there. */
  document.documentElement.classList.toggle('radio-on', !!RADIO.at);
  el.classList.toggle('live', RADIO.on && RADIO.status === 'playing');
}
