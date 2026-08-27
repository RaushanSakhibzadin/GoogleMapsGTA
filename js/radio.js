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
  err: '', el: null, at: null,
  /* Set when a station is tuned and ready but the browser would not let it start
     yet — see radioArm. The next real user gesture clears it. */
  pending: false,
  told: false,               // the one-time "tap the name to stop" hint
  watch: null,               // the deadline a station has to make a sound by
  primed: false,             // the element has been played once inside a gesture
  dead: []                   // stations dropped for dead air, for the log
};

/* ON UNLESS YOU TURNED IT OFF, and it remembers which.

   Stopping the dial is a decision about the game, not about this session: a
   player who does not want the radio should not have to switch it off every time
   they load a city. So the toggle writes here, and this is what decides whether a
   fresh city tunes itself.

   Read lazily, like the two volumes, because `store` is defined in js/game.js
   and that file is evaluated after this one. */
const RADIO_ON_KEY = 'vm_radio_on';
let radioOn = null;
function radioWanted(v) {
  if (v != null) {
    radioOn = !!v;
    if (typeof store !== 'undefined') store.set(RADIO_ON_KEY, radioOn ? '1' : '0');
    return radioOn;
  }
  if (radioOn == null) {
    const raw = (typeof store !== 'undefined') ? store.get(RADIO_ON_KEY, '1') : '1';
    radioOn = raw !== '0';
  }
  return radioOn;
}

/* WHERE WE ARE. Recorded when a city finishes loading; radioArm decides whether
   anything is asked of anybody.

   AND COORDINATES IT CANNOT USE ARE NOT COORDINATES. A geocode that never
   answered hands this null, and the generated lattice the game falls back to
   after that is not anywhere at all — there is no station local to a place that
   does not exist. This used to be harmless because nothing tuned until the dial
   was pressed; now that a city arms it, `null.toFixed(4)` inside radioURL is a
   real uncaught error on the loading path, thrown once per mirror. */
function radioAt(lat, lon, cc) {
  RADIO.at = (Number.isFinite(lat) && Number.isFinite(lon))
    ? { lat, lon, cc: cc || '' } : null;
  RADIO.list = []; RADIO.i = -1; RADIO.on = false;
  RADIO.pending = false; RADIO.dead = [];
  radioWatchOff();
  RADIO.status = 'idle'; RADIO.err = '';
  radioPaint();
}

/* SWITCHING THE CAR ON SWITCHES THE RADIO ON, which is what a car does.

   Called once, when a city starts. It tunes and then tries to play — and the
   try is expected to fail on a phone, which is the whole reason this is two
   steps rather than one. iOS starts audio only from inside a real user gesture,
   and by the time a list of stations has come back over the network the tap that
   started the game is long over. So a refusal is not an error here: it parks the
   dial on `pending` and the next touch of anything — a pad, a key, the screen —
   starts it, through radioGesture below.

   NOTHING IS ASKED IF THE PLAYER TURNED IT OFF. That is the setting radioWanted
   remembers, and it is also what keeps this honest for anyone who does not want
   a radio: no request to a third-party server, on a connection that may be
   metered, for a feature they have switched off. */
function radioArm() {
  if (!radioWanted() || !RADIO.at) return false;
  radioWake().then(n => {
    if (!n || !radioWanted()) return;
    radioPlay();
  });
  return true;
}

/* The next real gesture after a refused start. Wired to the same window-level
   pointerdown/touchend/keydown that unlocks the sound effects — see js/io.js —
   so it costs nothing and needs no control of its own. */
function radioGesture() {
  if (!RADIO.pending || RADIO.on || !radioWanted()) return false;
  RADIO.pending = false;
  return radioPlay();
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

/* HOW LONG A STATION GETS TO MAKE A SOUND.

   AND WHY A TIMER IS NEEDED AT ALL, when there is already an error handler: a
   dead stream mostly does not error. The host resolves, the socket opens, and
   then nothing arrives — for ever. No `error` event, no `stalled`, just a dial
   that says the station is loading and never stops saying it. That is what dead
   air actually looks like from in here, and the only way to catch it is to give
   it a deadline.

   Nine seconds is long enough for a slow mobile connection to open a stream that
   is really there — the tuning request itself is given the same — and short
   enough that walking down a list of four broken stations is not a minute of
   silence. */
const RADIO_DEAD_MS = 9000;

function radioWatchOff() {
  if (RADIO.watch) { clearTimeout(RADIO.watch); RADIO.watch = null; }
}
function radioWatchOn() {
  radioWatchOff();
  RADIO.watch = setTimeout(() => {
    RADIO.watch = null;
    // still not playing, after all that
    if (RADIO.on && RADIO.status !== 'playing') radioDrop('no audio');
  }, RADIO_DEAD_MS);
}

/* OFF THE DIAL, NOT SKIPPED PAST.

   Removing it rather than marking it is what makes this terminate: every failure
   shortens the list, so even a country where every station is dead walks the
   whole list once and ends at "no stations here" instead of cycling for ever.
   It also means the random draw cannot land back on it, which skipping would
   not prevent — and the draw is what put people on the same broken station
   twice in a session.

   Kept for the log, because "which stations were dropped" is the first question
   to ask when somebody reports that a city has no radio. */
function radioDrop(why) {
  const s = RADIO.list[RADIO.i];
  if (!s) return false;
  radioWatchOff();
  RADIO.dead.push({ name: s.name, url: s.url, why });
  RADIO.list.splice(RADIO.i, 1);
  if (typeof LOG !== 'undefined' && LOG.note)
    LOG.note('radio', 'dropped ' + s.name + ': ' + why);
  if (!RADIO.list.length) {
    RADIO.i = -1;
    RADIO.on = false; RADIO.pending = false;
    RADIO.status = 'none'; RADIO.err = why || '';
    radioPaint();
    return false;
  }
  if (RADIO.i >= RADIO.list.length) RADIO.i = 0;
  /* Told, once, so the station changing under them is something that happened
     rather than something wrong. The dial has already moved on by the time this
     is read. */
  if (typeof toast === 'function')
    toast(s.name + ' · ' + txt('radio.deadAir'), 1600);
  if (RADIO.on) return radioPlay();
  radioPaint();
  return true;
}

/* BLESSED INSIDE A REAL TAP, so the start that comes later is allowed.

   This is what "on by default AND playing" needs, and it is not the same problem
   as arming the dial. Safari grants permission to an <audio> ELEMENT, from the
   gesture that first plays it, and the element keeps that permission when its
   src changes afterwards. What it will not do is start an element that has never
   been touched, from a callback — and by the time a list of stations has come
   back over the network, the tap that started the game is long over, so the
   automatic start was refused every time and the dial sat there waiting for the
   next touch.

   So the element is played once, silently, from the first real gesture there is
   — the same window-level handler that unlocks the sound effects. Two hundred
   milliseconds of digital silence as a data URI: nothing is fetched, nothing is
   heard, and the element is blessed from then on.

   NOTHING HAPPENS IF THE RADIO IS OFF. No element, no permission, no silent clip
   — a player who switched it off should not have an audio element created on
   their first touch of the screen. */
const RADIO_SILENCE =
  'data:audio/wav;base64,UklGRiwBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgBAAA=' +
  'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA' +
  'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA' +
  'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
function radioPrime() {
  if (RADIO.primed || !radioWanted()) return false;
  RADIO.primed = true;
  const a = radioEl();
  try {
    a.src = RADIO_SILENCE;
    const pr = a.play();
    if (pr && pr.catch) pr.catch(() => {});     // refused is survivable; we tried
  } catch (e) {}
  return true;
}

function radioEl() {
  if (RADIO.el) return RADIO.el;
  const a = document.createElement('audio');
  a.id = 'radioA';
  a.preload = 'none';
  a.crossOrigin = 'anonymous';
  a.volume = radioVolume();
  /* A stream that dies is the normal case, not an exception: these are volunteer
     transmitters and a good few of them are simply gone. It used to say DEAD AIR
     on the dial and stop there, which leaves the player pressing ▶ past the same
     broken station every time they come round the list — and the shuffle can put
     them back on it. A station that will not play is not a station. */
  a.addEventListener('error', () => {
    if (!RADIO.on) return;
    radioDrop('stream failed');
  });
  a.addEventListener('playing', () => {
    /* THE PRIMING CLIP FIRES THIS TOO, and it is not a station starting. Without
       the guard the dial announced itself as playing before it had tuned
       anything, and the one-time "tap the name to stop" hint was spent on two
       hundred milliseconds of silence. */
    if (!RADIO.on) return;
    radioWatchOff();                       // it works: stop counting against it
    RADIO.status = 'playing'; RADIO.err = ''; radioPaint();
    /* SAID ONCE, THE FIRST TIME SOUND ARRIVES. The dial turns itself on now, so
       the first thing a player wants to know is how to turn it off — and a
       symbol on a button they have not looked at yet does not answer that. Once
       a session, on the frame the music actually starts, which is the moment the
       question occurs to them. */
    if (RADIO.told) return;
    RADIO.told = true;
    if (typeof toast === 'function') toast(txt('toast.radioOn'), 2800);
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
  radioWatchOn();
  const pr = a.play();
  if (pr && pr.catch) pr.catch(e => {
    if (!RADIO.on) return;
    const name = String((e && e.name) || e);
    /* A REFUSAL IS NOT A FAILURE. NotAllowedError means the browser will not
       start audio outside a user gesture — which is the normal answer on a phone
       when the game armed the dial by itself. Saying DEAD AIR to that would be a
       lie about a station that is perfectly fine, so it parks instead and the
       next touch of anything starts it. */
    if (/NotAllowed/i.test(name)) {
      RADIO.on = false;
      RADIO.pending = true;
      RADIO.status = RADIO.list.length ? 'ready' : 'idle';
      radioPaint();
      return;
    }
    RADIO.status = 'error';
    RADIO.err = name.slice(0, 40);
    radioPaint();
  });
  radioPaint();
  return true;
}
function radioStop() {
  RADIO.on = false;
  RADIO.pending = false;
  radioWatchOff();
  const a = RADIO.el;
  if (a) { try { a.pause(); } catch (e) {} }
  RADIO.status = RADIO.list.length ? 'ready' : (RADIO.status === 'none' ? 'none' : 'idle');
  radioPaint();
}
/* THE TOGGLE IS THE SETTING. Switching the dial off is a decision about the
   game rather than about this session — somebody who does not want a radio
   should not have to say so every time they load a city — so both directions
   are remembered, and radioArm reads it on the next start. */
function radioToggle() {
  if (RADIO.on || RADIO.pending) { radioWanted(false); radioStop(); return false; }
  radioWanted(true);
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
   died, and one still opening.

   AND IT CARRIES THE CONTROL IT IS. The name button starts and stops the radio,
   and nothing on it said so — the dial turned itself on and the only way to
   learn how to turn it off was to guess that the station name was a button. So
   it wears the symbol for what pressing it does now: ■ while something is
   playing, ▶ while it is not. Two characters, which is what a stop button costs
   when you already have somewhere to put it, and the same pair of symbols every
   music player on the phone already uses. */
const radioGlyph = () => (RADIO.on ? '■ ' : '▶ ');
function radioLabel() {
  const s = RADIO.list[RADIO.i];
  if (RADIO.status === 'idle') return radioWanted() ? txt('radio.idle') : '▶ ' + txt('radio.idle');
  if (RADIO.status === 'finding') return txt('radio.tuning');
  if (RADIO.status === 'none') return txt('radio.none');
  if (!s) return txt('radio.off');
  if (RADIO.status === 'error') return radioGlyph() + s.name + ' · ' + txt('radio.deadAir');
  if (RADIO.status === 'loading') return radioGlyph() + s.name + ' …';
  return radioGlyph() + s.name;
}
// what pressing the name will do, for a screen reader and for the tooltip
const radioAction = () => txt(RADIO.on ? 'radio.stop' :
                            RADIO.list.length ? 'radio.play' : 'radio.turnOn');

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
  if (n) {
    n.textContent = radioLabel();
    radioFit(n);
    // the same thing the glyph says, for anyone not reading the glyph
    const act = radioAction();
    n.setAttribute('aria-label', act);
    n.setAttribute('title', act);
    n.setAttribute('aria-pressed', RADIO.on ? 'true' : 'false');
  }
  /* THE CLASS GOES ON <html>, not on the bar. The bar reserves a strip at the
     bottom of the screen and everything else has to lift by that much — which is
     done with a custom property declared on :root, and a property set further
     down the tree cannot reach it. So the root carries the switch and the bar
     shows itself from there. */
  document.documentElement.classList.toggle('radio-on', !!RADIO.at);
  el.classList.toggle('live', RADIO.on && RADIO.status === 'playing');
}
