"use strict";
/* VICE MAPS — Game state, missions, the wanted level, and the per-frame update.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 9. game state ------------------------------ */
let state = 'menu';    // menu | loading | play | pause | dead
let touchUI = false;   // on-screen pads active (phones/tablets)
let lastT = 0, acc = 0, raf = false;

// localStorage is unavailable in some privacy modes — never let it break the game
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

/* GHOST — the supporter perk. Off the road you keep your speed, and buildings
   stop being solid. Normally the car is a road car: leave the tarmac and it
   drops to walking pace and leans back towards it.

   It is a switch, in the open, on trust. There is no server here — the whole
   game is static files on GitHub Pages and the source is public — so any check
   would be a line of JavaScript anyone could read and flip in half a minute.
   Pretending otherwise would just be theatre that annoys honest players. So it
   asks, links to the Patreon, and believes you. */
// Set when the city you are driving is not the one you asked for; read by the
// pause card so the answer is still there later.
let FELLBACK = null;
let GHOST = store.get('vm_ghost', '0') === '1';
function setGhost(on) {
  GHOST = !!on;
  store.set('vm_ghost', GHOST ? '1' : '0');
  syncGhostUI();
}
// Both copies of the switch and the on-screen tag read off the one flag, so the
// menu and the pause card can never disagree about what the car is doing.
function syncGhostUI() {
  for (const id of ['ghostM', 'ghostP']) {
    const el = $(id); if (!el) continue;
    el.setAttribute('aria-pressed', GHOST ? 'true' : 'false');
  }
  $('ghostTag').classList.toggle('on', GHOST);
}
function wirePatreon(url) {
  const link = url == null ? PATREON : url;
  for (const id of ['patM', 'patP', 'patL']) {
    const el = $(id); if (!el) continue;
    if (link) el.href = link;
    el.classList.toggle('on', !!link);
  }
  // the perk block is the switch AND the ask; with no page to point at, the
  // switch would be a naked cheat toggle, which is not what this is
  for (const id of ['perkM', 'perkP']) $(id).classList.toggle('on', !!link);
}
for (const id of ['ghostM', 'ghostP'])
  $(id).onclick = () => {
    setGhost(!GHOST);
    if (state === 'play') toast(GHOST ? 'GHOST MODE ON' : 'GHOST MODE OFF', 1400);
  };
wirePatreon();
syncGhostUI();

/* The preset chips are written into index.html rather than built here, so the
   city names are in the page for anything that reads it without running scripts.
   This binds what is already there; lat/lon ride along as data attributes so the
   buttons never need the geocoder, which is the flakiest hop in the chain and
   rate-limits browsers hard. */
(function bindPresets() {
  for (const el of document.querySelectorAll('#presets .chip')) {
    const q = el.dataset.q, lat = +el.dataset.lat, lon = +el.dataset.lon;
    el.onclick = () => {
      audioStart();
      q === '@geo' ? useGeo() : startGame(q, isFinite(lat) ? lat : null, isFinite(lon) ? lon : null, q);
    };
  }
})();

function useGeo() {
  if (!navigator.geolocation) { startGame('Miami Beach, Florida'); return; }
  showLoad('Finding you…', 'waiting for the GPS satellites');
  navigator.geolocation.getCurrentPosition(
    p => startGame(null, p.coords.latitude, p.coords.longitude, 'Your neighbourhood'),
    () => startGame('Miami Beach, Florida'),
    { timeout: 8000, enableHighAccuracy: false }
  );
}

let subNote = '', skipTimer = 0, tickTimer = 0;
function showLoad(msg, sub) {
  state = 'loading';
  $('menu').classList.add('hide'); $('load').classList.remove('hide');
  $('loadMsg').textContent = msg || ''; $('loadSub').textContent = sub || '';
  subNote = sub || '';
  loadReset();
  // never leave anyone staring at a bar: offer the way out after a few seconds
  $('skip').classList.remove('on');
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => $('skip').classList.add('on'), 6000);
  clearInterval(tickTimer);
  tickTimer = setInterval(paintProgress, 250);
}
function endLoad() {
  clearTimeout(skipTimer); clearInterval(tickTimer);
  $('skip').classList.remove('on');
  loadAbort();
}
// bytes are unknown up front, so creep towards 60% asymptotically as they arrive
function paintProgress() {
  if (state !== 'loading') return;
  const secs = Math.floor((Date.now() - LOAD.t0) / 1000);
  const mb = LOAD.bytes / 1048576;
  const parts = [];
  if (mb > .05) parts.push(mb.toFixed(1) + ' MB');
  else if (subNote) parts.push(subNote);
  if (secs > 2) parts.push(secs + 's');
  /* Say WHY when a mirror turns us away. "Asking 5 map servers" tells you
     something is wrong but not what, and the difference between a rate limit, a
     timeout and a host that simply isn't reachable from your network is the
     difference between waiting and giving up. */
  if (LOAD.lastErr && mb <= .05) parts.push(LOAD.lastErr);
  $('loadSub').textContent = parts.join(' · ');
  // creep on bytes *and* on time, so a slow server still looks like progress
  const p = .25 + .35 * (1 - Math.exp(-(mb / 3 + secs / 40)));
  $('barIn').style.width = (p * 100) + '%';
}
function prog(p, msg, sub) {
  if (p >= .6) clearInterval(tickTimer);   // download's done; stop the byte ticker
  $('barIn').style.width = (p * 100) + '%';
  if (msg != null) $('loadMsg').textContent = msg;
  if (sub != null) { $('loadSub').textContent = sub; subNote = sub; }
}
$('skip').onclick = () => { if (LOAD.cancel) LOAD.cancel(); };

/* Buildings for the opening area arrive after you're already driving. Failing
   here costs scenery, not the city — which is the whole point of the split. */
async function loadOpeningBuildings(lat, lon, gen) {
  const sess = newSession();
  CHUNK.note = 'Raising the buildings…';
  try {
    const els = await fetchBuildings(lat, lon, sess);
    if (gen !== loadGen || W.procedural) return;
    mergeChunk(parseOSM(els), '0,0');
  } catch (err) {
    console.warn('buildings failed:', err && err.message);
  } finally {
    sessAbort(sess);
    CHUNK.note = '';
  }
}

let loadGen = 0;
function backToMenu(msg) {
  endLoad();
  state = 'menu';
  $('load').classList.add('hide');
  $('menu').classList.remove('hide');
  $('barIn').style.width = '0%';
  const el = $('menuErr');
  el.textContent = msg;
  el.classList.add('on');
}

async function startGame(query, lat, lon, label) {
  const gen = ++loadGen;                 // a second DRIVE press abandons this one
  // the place they actually asked for, kept before the fallback path reassigns
  // any of it, so a retry later knows what it is retrying
  const want = { query, lat, lon, label };
  // a new city gets its own attempts; the last one's are none of its business
  RETRY.city = null; RETRY.at = 0; RETRY.n = 0;
  audioStart();
  $('menuErr').classList.remove('on');
  showLoad('Locating…', query || label || '');
  prog(.08);
  let name = label || query || 'Somewhere';
  let procedural = false, data = null, why = '', geoFailed = false, openingMs = 0;
  // fellBack: we are not giving them the place they asked for. why/askedFor say
  // which place and what went wrong, and both are shown rather than implied.
  let fellBack = false, offline = null, askedFor = '';

  // 1. where is it? Presets already know, so only typed searches ask Nominatim.
  if (lat == null) {
    try {
      const g = await geocode(query);
      lat = g.lat; lon = g.lon; name = g.name;
      want.lat = lat; want.lon = lon; want.label = g.name;
    } catch (err) {
      if (gen !== loadGen) return;
      console.warn('geocode failed:', err);
      // A working geocoder saying "no such place" is an answer: a generated city
      // would be actively wrong, so send them back to fix the spelling. A geocoder
      // that never answered is different — we still don't know where they meant,
      // but dead-ending an offline player helps nobody, so fall through and build
      // the offline city with the reason on the label.
      if (/no such place/i.test(err.message)) {
        return backToMenu('Couldn’t find “' + query +
          '”. Try a fuller name, like “Ocean Drive, Miami Beach”.');
      }
      geoFailed = true;
    }
  }
  if (gen !== loadGen) return;

  // 2. the streets — everything you need to start driving
  try {
    if (geoFailed) throw new Error('place search unreachable');
    setOrigin(lat, lon);
    $('loadCity').textContent = name;
    prog(.25, 'Surveying the streets…', 'the streets around ' + name.split(',')[0]);
    const els = await fetchStreets(lat, lon,
      m => { $('loadMsg').textContent = m; },
      b => { LOAD.bytes = b; });
    if (gen !== loadGen) return;
    /* How heavy this area is — measured from the reply that landed, not from the
       clock. This used to be `Date.now() - LOAD.t0`, which is everything since
       the player pressed DRIVE: the geocode, and every mirror that was
       unreachable or too slow before a good one answered. In the session that
       exposed it the streets came back in 5.5 s and that expression read 12 s. */
    openingMs = LOAD.replyMs || (Date.now() - LOAD.t0);
    prog(.62, 'Pouring concrete…', els.length.toLocaleString() + ' map features');
    data = parseOSM(els);
    // a quiet village is still a real place — only fall back if there's nothing
    if (!data.roads.length) {
      fellBack = true;
      why = 'nothing is mapped around ' + name.split(',')[0];
    }
  } catch (err) {
    if (gen !== loadGen) return;
    console.warn('map load failed:', err);
    fellBack = true;
    why = geoFailed ? 'the place search couldn’t be reached'
        : err && /cancel/i.test(err.message) ? 'you skipped the download'
        : err && /timed out/i.test(err.message) ? 'the map servers were too slow'
        : 'the map servers couldn’t be reached';
  }

  /* THE OFFLINE CITY. Real Belgrade, bundled with the game, in place of the
     generated lattice — and the generated one still underneath it, because a
     three megabyte script that will not load must not be the end of the road. */
  if (fellBack) {
    const asked = name;
    try {
      const city = await loadOfflineCity();
      if (gen !== loadGen) return;
      offline = city;
      data = offlineCityData(city);
      name = city.name;
    } catch (err) {
      console.warn('offline city failed:', err && err.message);
      setOrigin(lat != null ? lat : 25.79, lon != null ? lon : -80.13);
      procedural = true;
      data = proceduralCity();
      name = 'Neon Grid City (offline)';
    }
    // what they asked for, so the reason names it rather than talking about
    // "the chosen city" in the abstract
    askedFor = asked;
  }
  endLoad();

  $('loadCity').textContent = name;
  prog(.82, 'Wiring the neon…', fellBack ? why : '');
  await new Promise(r => setTimeout(r, 40));
  buildWorld(data, name, procedural);
  if (offline) {
    // its arterials, so the offline city gets the same wide world and the same
    // scenery-only streaming as a downloaded one
    offlineSkeleton(offline);
    bundledCity();          // and nothing streams into it
    prerenderMap();
  }

  // The city opens at 5.4 km rather than 1.8: the ring comes in here, before you
  // ever take the wheel, and only its scenery trickles in afterwards. The tile you
  // are standing in gets its scenery queued first, so it fills in before the rest.
  if (!procedural && !offline) {
    loadOpeningBuildings(lat, lon, gen);
    // The landmark sweep doesn't depend on the ring, so it runs alongside rather
    // than adding its wait on top — two independent waits stacked is how a loading
    // screen quietly becomes half a minute.
    const sweep = sweepLandmarks();

    /* The wide city comes first, because it is the one thing that cannot arrive
       later: everything downstream of it — the grid, the fence, the radar window
       — is sized from its rectangle, and growing all of that mid-drive is a
       stutter. The ring is detail, and takes whatever budget is left. */
    prog(.86, 'Mapping the whole city…', 'roads out to ' + (SKELETON_RADII[0] / 1000) + ' km');
    const skel = await loadSkeleton(m => { $('loadMsg').textContent = m; });
    if (gen !== loadGen) return;
    // Note, don't act on it: the ring that follows is full street detail and still
    // needs the streets query. Scenery-only mode starts when play does.
    // "0 more roads across 18 km" is a real outcome — a small town whose trunk
    // roads the detailed centre already had — but it reads like a failure, so say
    // how big the city is instead of how little the last request added to it.
    if (skel) prog(.88, 'Wiring the neon…',
                   skel.roads ? skel.roads.toLocaleString() + ' more roads across ' +
                                Math.round(skel.radius / 1000) + ' km'
                              : Math.round(skel.radius / 1000) + ' km of city');

    /* AND NOTHING ELSE BLOCKS. The loading screen is over the moment there is a
       city to drive in, which is the opening streets and the wide map that sizes
       the world around them.

       These two used to be awaited here and were most of the wait: the ring is
       eight sequential street requests against a twelve second cap, and the
       landmark sweep another two and a half. Measured against a captured
       session's own latencies, the whole load came to nearly twenty seconds, and
       on the phone that reported it — with slower mirrors, retries, and the
       skeleton at 200 km — it was still on the loading screen at forty-nine.

       Neither is anything the player is waiting FOR. The ring is the ground a few
       seconds' driving away, and the streamer would fetch it anyway. The
       landmarks are a garage you want when you are damaged, not when you start.
       So they run behind the wheel, and the only thing that changed for them is
       that nobody is watching a bar while they do.

       The ring is sized off the STREETS request alone. It used to be
       `openingMs + skelMs`, and once the skeleton went wide that sum was past the
       "too heavy for eight more requests" threshold in essentially every city, so
       the ring was skipped almost always and the detailed city came out ONE tile
       wide. The skeleton is a fixed cost everywhere and says nothing about the
       density of the streets here, which is the only thing this decision is
       about. */
    preloadRing(openingMs, (g, n) => {
      // the in-game indicator, not the loading bar — that is already gone
      CHUNK.note = 'Filling in the streets… ' + g + ' of ' + n;
    }).then(() => { CHUNK.note = ''; }, () => { CHUNK.note = ''; });
    // started above so it overlaps the skeleton; nothing waits on it now
    sweep.catch(() => {});
  }

  prog(.95, 'Starting the engine…');
  await new Promise(r => setTimeout(r, 60));
  // The wide map is in, so recycling a district may drop its scenery and keep its
  // roads. Tiles go on carrying streets either way: the skeleton is arterials, and
  // the street you live on is not an arterial.
  WIDE_MAP = !!W.skelRect;
  resetRun();

  prog(1, 'Ready.');
  await new Promise(r => setTimeout(r, 180));
  $('load').classList.add('hide');
  $('hud').classList.add('on');
  touchUI = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (touchUI) $('touch').classList.add('on');
  resize();                       // the minimap only has a size once the HUD is visible
  state = 'play'; lastT = performance.now(); acc = 0;
  /* The remembered view, applied here rather than on page load. Creating the
     first WebGL context and building a dozen cells of geometry is a real stall,
     and doing it while the menu is on screen makes the menu look broken; doing
     it on the frame the city appears hides it inside the transition that is
     already there. */
  restoreView3D();
  /* SAY WHY, EVERY TIME. Landing somewhere you did not ask for with nothing but
     a welcome banner reads as the game ignoring you — the reason used to flash
     past on the loading bar at 82% and was gone before the city appeared. So the
     welcome names the place they asked for and what went wrong, and it stays up
     long enough to read. */
  if (fellBack) {
    const place = askedFor ? askedFor.split(',')[0] : 'that place';
    toast('COULDN’T LOAD ' + place.toUpperCase() + '\n' + why +
          '\nDRIVING IN ' + name.split(',')[0].toUpperCase() + ' INSTEAD', 7000);
    // and it stays on the pause card for the rest of the session, so it is still
    // answerable ten minutes later when you wonder why you are in Belgrade
    FELLBACK = { asked: askedFor, why, city: name };
    /* The servers said no ONCE. That is a moment in a network's day, not a
       verdict — and the player is now driving a city they did not choose, with
       no way back to the one they did short of pressing DRIVE again and sitting
       through another load. So ask again later, from behind the wheel. */
    retryLater({ city: want });
  } else {
    FELLBACK = null;
    toast('WELCOME TO\n' + name.toUpperCase(), 2600);
  }
  /* Not only the fallback. A city can load perfectly and still be missing the
     wide map, or every garage and hospital, or all of its buildings — each of
     which is one refused request, and each of which the player would otherwise
     live with until they started again. */
  if (retryWanted()) retryLater();
  if (!raf) { raf = true; requestAnimationFrame(loop); }
}

/* ---------------------------------------------------------------------------
   WHAT DIDN'T ARRIVE, ASKED FOR AGAIN LATER.

   Every failure in this game's loading is a network failure, and network
   failures are moments rather than verdicts: a mirror rate-limits for a minute,
   a host is unreachable from one carrier, a 200 comes back with nothing in it.
   The game has always coped by carrying on with less — the offline city instead
   of the one you asked for, no wide map, no garages, bare ground where the
   buildings should be — and then never asking again for the whole session. The
   only cure was to press DRIVE a second time and sit through another load.

   So it asks again, from behind the wheel, and drops the fallback the moment the
   real answer turns up.

   THE DELAYS ARE THE WHOLE DESIGN. Overpass hands out about two slots per IP and
   answers a burst with 429s, and a retry that hammers is worse than no retry —
   it gets the host to refuse the tile streaming too, so trying to recover the map
   would break the part of it that still worked. Ninety seconds, then five
   minutes, then fifteen, then it stops: far longer than any rate-limit window,
   and three attempts across twenty minutes is a rounding error against the
   traffic one session's tile streaming already makes.

   One job at a time, and never while a tile or its scenery is in the air, for
   the same reason. --------------------------------------------------------- */
const RETRY_DELAYS = [90000, 300000, 900000];   // 1.5 min, 5 min, 15 min, then stop
const RETRY = { city: null, at: 0, n: 0, busy: false, log: [] };

function retryLater(what) {
  if (what && what.city) RETRY.city = what.city;
  if (!RETRY.at) RETRY.at = Date.now() + RETRY_DELAYS[0];
}

/* The first thing still missing, in the order it matters. City first: everything
   below it is a detail of a city you did not want. */
function retryWanted() {
  if (RETRY.city && FELLBACK) return 'city';
  if (W.procedural || W.bundled) return null;   // nothing to fetch for these
  /* A BUNDLED SKELETON IS A STAND-IN, NOT AN ANSWER. It fills the world so a
     refused sweep does not leave you in a 5.5 km box, and it is somebody else's
     capture of this city from a fortnight ago — the real one is still worth
     fetching, so this keeps asking. Without the flag the graft looked like
     success and the retry never ran again: the player kept the stand-in for the
     whole session even once the mirrors came back. */
  if (!W.skelRect || W.skelBundled) return 'skeleton';
  // the two that a wasted run actually needs somewhere to send you
  const gone = missingKinds();
  if (gone.includes('hospital') || gone.includes('police')) return 'landmarks';
  if (!W.buildings.length) return 'buildings';
  return null;
}

async function runRetry(kind) {
  if (kind === 'city') return retryCity();
  if (kind === 'skeleton') {
    const skel = await loadSkeleton();
    // the stand-in coming back a second time is not progress
    if (!skel || skel.bundled) return false;
    WIDE_MAP = true;
    prerenderMap();
    toast('MAP EXTENDED\n' + Math.round(skel.radius / 1000) + ' KM OF ROADS', 2600);
    return true;
  }
  if (kind === 'landmarks') {
    // measured on what is still missing rather than on a count: the load's own
    // sweep can land while this one is in flight, and then a count says nothing
    const before = missingKinds().length, had = W.pois.length;
    await sweepLandmarks();
    if (missingKinds().length >= before && W.pois.length <= had) return false;
    prerenderMap();
    toast('FOUND ' + (W.pois.length - had) + ' MORE LANDMARKS', 2200);
    return true;
  }
  if (kind === 'buildings') {
    const before = W.buildings.length;
    await loadOpeningBuildings(GEO.lat0, GEO.lon0, loadGen);
    return W.buildings.length > before;
  }
  return false;
}

/* The city itself. Nothing is torn down until the replacement is in hand: the
   streets are fetched and parsed first, and only a reply with roads in it is
   allowed to touch the world. A failed retry leaves the player exactly where
   they were, driving the fallback, none the wiser. */
async function retryCity() {
  const want = RETRY.city;
  let lat = want.lat, lon = want.lon, name = want.label || want.query;
  if (lat == null) {
    const g = await geocode(want.query);
    lat = g.lat; lon = g.lon; name = g.name;
  }
  const gen = loadGen;
  // the projection has to move before the reply can be parsed into metres
  const prev = { lat0: GEO.lat0, lon0: GEO.lon0, mLat: GEO.mLat, mLon: GEO.mLon };
  setOrigin(lat, lon);
  let data;
  try {
    data = parseOSM(await fetchStreets(lat, lon, () => {}, () => {}));
    if (!data.roads.length) throw new Error('nothing is mapped there');
  } catch (err) {
    // put the projection back, or the city we are still driving moves under us
    GEO.lat0 = prev.lat0; GEO.lon0 = prev.lon0; GEO.mLat = prev.mLat; GEO.mLon = prev.mLon;
    throw err;
  }
  if (gen !== loadGen || state === 'menu') return false;

  buildWorld(data, name, false);
  applyTheme(themeName);
  WIDE_MAP = false;
  resetRun();                       // cash is read back from storage, so it survives
  resize();
  FELLBACK = null; RETRY.city = null;
  toast('GOT ' + String(name).split(',')[0].toUpperCase() + '\n' +
        'the map servers came back — leaving the offline city', 5000);

  // and everything the opening load would have done next, behind the wheel
  loadOpeningBuildings(lat, lon, gen);
  preloadRing(LOAD.replyMs || 0, (g, n) => { CHUNK.note = 'Filling in the streets… ' + g + ' of ' + n; })
    .then(() => { CHUNK.note = ''; }, () => { CHUNK.note = ''; });
  loadSkeleton().then(skel => { if (skel && gen === loadGen) { WIDE_MAP = true; prerenderMap(); } })
    .catch(() => {});
  sweepLandmarks().catch(() => {});
  return true;
}

// Called every frame; does nothing on almost all of them.
function updateRetries() {
  if (state !== 'play' || RETRY.busy) return;
  if (RETRY.n >= RETRY_DELAYS.length) return;
  if (!RETRY.at || Date.now() < RETRY.at) return;
  // never add to the pile while the streamer already has something in the air
  if (CHUNK.busy || CHUNK.preloading || SIDE.busy) return;
  const kind = retryWanted();
  if (!kind) { RETRY.at = 0; return; }

  RETRY.busy = true;
  RETRY.n++;
  RETRY.at = Date.now() + RETRY_DELAYS[Math.min(RETRY.n, RETRY_DELAYS.length - 1)];
  runRetry(kind)
    .then(ok => {
      RETRY.log.push({ kind, ok: !!ok, at: Date.now() });
      // it worked, so whatever is missing next gets a fresh set of attempts
      if (ok) { RETRY.n = 0; RETRY.at = retryWanted() ? Date.now() + RETRY_DELAYS[0] : 0; }
    })
    .catch(err => {
      RETRY.log.push({ kind, ok: false, why: err && err.message });
      console.warn('retry ' + kind + ':', err && err.message);
    })
    .finally(() => { RETRY.busy = false; });
}

/* WHAT EACH THING CAN TAKE OFF YOU IN ONE HIT, out of a hundred.

   These were four numbers buried in four expressions in two files, and together
   they said something nobody had ever read in one place: a wall could take 45,
   so three scrapes killed you; a blast could take 45; and a police car had no
   limit on how often it could take 14. Written down together they are arguable,
   which is the point of writing them down together.

   The wall is the one that was really wrong. Clipping a corner at speed is the
   most common thing that happens to a player who is driving hard, it is very
   often not their fault — the mask is 512 m cells of real OSM footprints — and
   at 45 it was close to a third of your life for a graze. It is a serious hit
   now rather than a fatal one. */
/* HOW HARD YOU HAVE TO HIT A WALL BEFORE IT COUNTS AS HITTING IT — and this has
   to stay above UNSTICK, which is the whole reason it is written next to it.

   It was 4, and UNSTICK is 4.5. A car that ends up overlapping a footprint gets
   shoved out at 4.5 m/s so that it does not settle back in, and that shove
   registered as a crash: 4.5 is over 4, so the game charged you for the push it
   gave you to get free. Wedged against a building, the loop is shove, crash,
   settle, shove, once every 0.45 s for as long as you sit there. Measured on a
   PARKED car at the bundled city's own spawn point — throttle off, brake on,
   traffic and police removed from the world — 67 points of damage in nineteen
   seconds, and dead. Nobody who parked badly could work out what was killing
   them, because nothing was: it was the escape hatch.

   Six is above the shove and still well below any speed you would call a
   collision. */
const UNSTICK = 4.5;       // the impulse that frees a car stuck inside a footprint
const BLD_MIN = 6;         // and the speed below which touching a wall is free
const BLD_MAX = 26;        // clipping a building at speed
const TRAFFIC_MAX = 18;    // t-boning a civilian
const COP_MAX = 12;        // a cruiser ramming you, now once every 0.6 s
const BLAST_MAX = 38;      // standing in an explosion

/* AND THE ARMOR COMES BACK, SLOWLY, WHEN NOTHING HAS HIT YOU.

   Measured over ninety seconds of driving hard at a delivery with two stars up:
   486 points of damage from clipping buildings, 39 from traffic, 12 from police,
   4 deaths, mean health 22 out of 100. Buildings are ninety per cent of
   everything that happens to you, and the reason is structural rather than a
   number being too big — damage was MONOTONIC. Nothing in the game gave health
   back except a repair shop you have to pay for, so a long session could only
   ever end one way however well you drove. That is the real answer to "I die too
   often": not that any one hit was lethal, but that a hundred points of health
   had to last for ever.

   The window is what makes this a reward rather than a free pass. Seven seconds
   without a scratch is a long time in a chase and no time at all on an open
   road, so it pays for driving cleanly and pays nothing for driving into things.

   AND IT STOPS AT 65. A repair shop still exists, still costs money, and is
   still the only way back to a hundred — this is a limp home, not a heal. */
const REGEN_AFTER = 7;     // seconds since the last hit before it starts
const REGEN_RATE = 3.5;    // points a second after that
const REGEN_CAP = 65;      // and no further

/* EVERY POINT OF DAMAGE THE PLAYER TAKES GOES THROUGH HERE.

   It was four scattered `P.car.hp -=` lines with four different caps and three
   different cooldown rules — one of which was no cooldown at all — and there was
   no way to answer "what is killing me?" except by reading all four and
   guessing. The tally is a few bytes and it turned a balance argument into a
   measurement. */
const DMG = { bld: 0, traffic: 0, cop: 0, blast: 0, deaths: 0 };
function hurtPlayer(n, why) {
  if (!(n > 0) || P.dead) return 0;
  DMG[why] = (DMG[why] || 0) + n;
  P.car.hp -= n;
  P.calm = 0;                       // the regeneration window starts again
  return n;
}

function resetRun() {
  const sp = nearestRoadPoint(0, 0) || { x: 0, y: 0, h: 0 };
  P.car = makeCar(sp.x, sp.y, sp.h, 'player');
  P.spawn = { x: sp.x, y: sp.y, h: sp.h };
  P.cash = +store.get('vm_cash', 0) || 0;
  P.score = 0; P.wanted = 0; P.cool = 0; P.dead = false; P.deadT = 0; P.bustT = 0;
  traffic = []; cops = []; peds = []; marks = []; parts = []; blasts = [];
  MISSION.state = 'none'; MISSION.done = 0;
  // otherwise a new city opens still showing the last one's street and district
  NAV.street = NAV.zone = NAV.cand = ''; NAV.candT = NAV.showT = 0;
  $('street').textContent = ''; $('street').classList.remove('on');
  $('zone').textContent = ''; $('zone').classList.remove('on');
  cam.x = P.car.x; cam.y = P.car.y;
  spawnTraffic(trafficCap(), true); spawnPeds(34);
  newMission();
}

/* DAYLIGHT IS RUSH HOUR — three times the cars, not ten.

   Ten was the figure when traffic lived in a 780 m circle and nine tenths of it
   was somewhere you could never see. Now that cars are kept to the edge of the
   screen the same count is THIRTY times the density, and measured on real
   Belgrade streets that is not a rush hour, it is a car park: average traffic
   speed falls from 17 km/h to 5.5 and well over half of them are stopped. Three
   times still flows at around 11 km/h and puts more cars in front of you than
   ten times ever did, because all of them are now within sight.

   A cap, not a spawn: the top-up already fills towards it a few cars at a time
   and the 780 m cull already empties it from behind, so this is one number and
   the rest is machinery that already existed. Switching back to dusk truncates
   the list rather than waiting for two hundred cars to drift out of range one by
   one, which would leave the city in rush hour for a minute after you asked it
   not to be. */
const TRAFFIC_N = 26;
let TRAFFIC_SET = 0;                      // tests and tuning; 0 means use the theme
const trafficCap = () => TRAFFIC_SET || (themeName === 'day' ? TRAFFIC_N * 3 : TRAFFIC_N);

/* ------------------------------ 10. missions ------------------------------ */
// Contracts reach further as more of the map streams in, so packets turn up in
// the new districts instead of clustering in the block you started on.
const missionReach = base => Math.min(base * (1 + (CHUNK.loaded - 1) * .55), base * 3.2);

function newMission() {
  const p = roadPoint(P.car.x, P.car.y, 90, missionReach(480))
         || roadPoint(P.car.x, P.car.y, null);
  if (!p) { MISSION.state = 'none'; return; }
  MISSION.pick = p; MISSION.drop = null;
  MISSION.state = 'pickup';
  const where = p.road && p.road.name;
  setObjective(where ? 'Pick up on ' + where : 'Pick up the package');
}
function startDelivery() {
  const d = roadPoint(P.car.x, P.car.y, 180, missionReach(700))
         || roadPoint(P.car.x, P.car.y, null);
  if (!d) { MISSION.state = 'none'; return; }
  MISSION.drop = d;
  MISSION.state = 'deliver';
  const dd = dist(P.car.x, P.car.y, d.x, d.y);
  MISSION.time = clamp(dd / 13 + 18, 22, 150);   // cross-district runs need the room
  MISSION.reward = Math.round(120 + dd * 1.6 + MISSION.done * 45);
  SFX.pickup();
  toast('PACKAGE SECURED\n$' + MISSION.reward + ' ON DELIVERY', 1800);
  // the drop point already knows which way it sits on, so name it
  const where = d.road && d.road.name;
  setObjective(where ? 'Deliver to ' + where : 'Deliver the package');
}
function completeDelivery() {
  P.cash += MISSION.reward; P.score += MISSION.reward;
  MISSION.done++;
  store.set('vm_cash', P.cash);
  SFX.cash();
  toast('DELIVERED\n+$' + MISSION.reward, 2000);
  MISSION.state = 'none';
  setTimeout(newMission, 900);
}
function failDelivery() {
  MISSION.state = 'none';
  toast('TOO SLOW.\nPACKAGE LOST', 1800);
  setObjective('Free roam');
  setTimeout(newMission, 1600);
}
// The radar sits under the objective now, so a longer objective that wraps to an
// extra line shifts it down — re-cache the rect the edge arrow dodges against.
function setObjective(t) {
  $('objT').textContent = t;
  miniRect = mini.getBoundingClientRect();
}

/* ------------------------------ 11. wanted level ------------------------------ */
function addWanted(n) {
  const before = P.wanted;
  P.wanted = clamp(P.wanted + n, 0, 5);
  P.cool = 0;
  if (P.wanted > before) {
    SFX.star();
    stockCops(Math.round(P.wanted * 1.6));
    if (before === 0) toast('WANTED', 1200);
  }
}
/* A repair shop puts the armor back and resprays you on the way out. The new
   colour excludes the current one, so it always visibly changes. */
function repairAt(p) {
  if (P.cash < REPAIR_COST) {
    p.cool = 2;                                // just long enough not to spam the toast
    toast('REPAIRS COST $' + REPAIR_COST, 1600);
    return;
  }
  p.cool = 6;                                  // parked on it shouldn't re-fire
  P.cash -= REPAIR_COST;
  store.set('vm_cash', P.cash);
  P.car.hp = 100;
  const others = PAL.carBody.filter(c => c !== P.car.color);
  P.car.color = pick(others.length ? others : PAL.carBody);
  SFX.pickup();
  toast((p.name ? p.name.toUpperCase() + ' · ' : '') + 'REPAIRED · −$' + REPAIR_COST, 1800);
}

function busted() {
  const lost = P.cash - Math.floor(P.cash / 2);
  P.cash = Math.floor(P.cash / 2);
  store.set('vm_cash', P.cash);
  bigMsg('BUSTED', '#33e6ff', `−$${lost} · booked at the station`);
  respawn('police');
}
function wasted() {
  DMG.deaths++;
  P.cash = 0;
  store.set('vm_cash', P.cash);
  bigMsg('WASTED', '#ff4fd8', 'cleaned out · patched up at the hospital');
  /* THE CAR GOES UP WITH YOU. Every other car in the game explodes when its
     health runs out — checkWreck sends traffic and police through wreck(), which
     is an explosion. The player's just stopped, and a banner appeared over a car
     sitting there intact, which reads as the game giving up rather than as the
     car being destroyed.

     P.dead first, and that ordering is load-bearing: explode() damages whatever
     is standing in the blast, the player included, and the player's health is
     already at zero. Without the flag the blast walks straight back into
     wasted() and recurses. */
  P.dead = true;
  explode(P.car.x, P.car.y);
  respawn('hospital');
}
function respawn(kind) {
  P.dead = true; P.deadT = 2.2;
  // resolved now, while the car is still where it went wrong — you come round at
  // the station or hospital nearest to where it happened
  P.recover = recoverPoint(kind);
  SFX.bust();
  if (MISSION.state === 'deliver') { MISSION.state = 'none'; setTimeout(newMission, 2600); }
}
function doRespawn() {
  const sp = P.recover || P.spawn;
  P.car.x = sp.x; P.car.y = sp.y; P.car.h = sp.h;
  P.car.vx = P.car.vy = 0; P.car.hp = 100;
  P.calm = 0;
  P.wanted = 0; P.cool = 0; cops = [];
  cam.x = sp.x; cam.y = sp.y;
  P.dead = false;
  $('big').classList.remove('on');
}
function bigMsg(t, col, sub) {
  $('bigT').textContent = t; $('bigT').style.color = col;
  $('bigS').textContent = sub || '';
  $('big').classList.add('on');
}
let toastT = 0;
function toast(t, ms) {
  $('toast').textContent = t; $('toast').classList.add('show'); toastT = (ms || 1600) / 1000;
}

/* ---- street & district announcements, GTA style ---- */
const NAV = { street: '', zone: '', cand: '', candT: 0, showT: 0, lastX: 0, lastY: 0, tick: 0 };
function updateNav(dt) {
  const c = P.car;
  if (NAV.showT > 0) { NAV.showT -= dt; if (NAV.showT <= 0) $('street').classList.remove('on'); }
  // a signpost doesn't need 60 Hz — look it up ten times a second
  NAV.tick -= dt;
  if (NAV.tick > 0) return;
  dt += .1 - NAV.tick;          // the interval actually elapsed, for the debounce
  NAV.tick = .1;

  // street: needs to hold briefly and needs real movement, or junctions strobe
  const r = streetAt(c.x, c.y);
  const nm = r ? r.name : '';
  if (nm !== NAV.cand) { NAV.cand = nm; NAV.candT = 0; }
  else NAV.candT += dt;
  if (nm && nm !== NAV.street && NAV.candT > .35 &&
      dist(c.x, c.y, NAV.lastX, NAV.lastY) > 12) {
    NAV.street = nm; NAV.lastX = c.x; NAV.lastY = c.y; NAV.showT = 4;
    $('street').textContent = nm;
    $('street').classList.add('on');
  }

  // district: persistent, flashes when you cross into a new one
  const z = zoneAt(c.x, c.y);
  const zn = z ? z.name : '';
  if (zn && zn !== NAV.zone) {
    NAV.zone = zn;
    const el = $('zone');
    el.textContent = zn;
    el.classList.remove('flash'); void el.offsetWidth;   // restart the animation
    el.classList.add('on', 'flash');
    SFX.blipZone();
  }
}

/* ------------------------------ 12. update ------------------------------ */
function update(dt) {
  const c = P.car;
  const inp = P.dead ? { steer: 0, gas: 0, brake: 1, hand: 0 } : readInput();

  /* Pressing DRIFT commits to a whole 180 — every press, no steering needed, no
     wrestling it round. It's armed on the PRESS rather than while held, so
     leaning on the button doesn't spin you like a top: one press, one half turn,
     press again for another. Steering only picks which way it goes. */
  if (inp.hand && !P.handWas && !P.dead) {
    /* THE TURN IS HALF THE SPEED. 90 km/h on the clock buys 45° of rotation,
       180 buys 90°, and 360 — the top of the clock, which is why top speed is
       exactly 100 m/s — buys a half turn. Crawl and you barely twitch; you have
       to be carrying speed to get the car round, which is how it works. */
    const deg = clamp(Math.hypot(c.vx, c.vy) * 3.6 * .5, 0, 360);
    // Long turns take longer: a quarter turn should not take as long as a full
    // circle. The rate is what stays constant, with a floor so a tiny flick at
    // walking pace is still a movement you can see rather than a snap.
    c.spin = { t: 0, from: c.h, rad: deg * Math.PI / 180,
               secs: clamp(SPIN_SECS * deg / 180, .28, 1.7),
               dir: inp.steer || c.lastSpinDir || 1 };
    c.lastSpinDir = c.spin.dir;
    if (deg > 8) SFX.skid();
  }
  P.handWas = inp.hand;

  const v = drive(c, inp.gas, inp.brake, inp.steer, inp.hand, dt);
  P.slip = v.vl;                        // how far the tail is out, for the HUD hooks
  /* The edge of the streamed world stops the car dead, and it used to do it in
     silence — throttle down, speedo reading walking pace, open ground ahead.
     Say which it is, once, rather than leaving it looking like a broken game. */
  const atEdge = fence(c);
  P.edgeCd = Math.max(0, (P.edgeCd || 0) - dt);
  /* Contact is intermittent, not continuous: the fence hands back 30% of the
     velocity, so the car bounces just inside and is clamped again a few frames
     later. Zeroing this on any frame that didn't clamp meant it never reached
     the threshold no matter how long you leaned on the edge — so it leaks away
     slowly instead, and repeated contact still adds up. */
  /* Touching it at all is the message, held off only by the cooldown.

     Two earlier versions of this tried to be clever and both stayed silent
     exactly when they were needed. Requiring sustained contact failed because
     the fence hands back 30% of your speed, so the car bounces and each touch
     lasts one frame. Requiring two touches close together failed too: arriving
     on a road at 180 km/h, the bounce carries you far enough that the next
     contact is seconds away. There is nothing ambiguous about reaching the end
     of the world — say so the first time. */
  if (atEdge) P.edgeHits = (P.edgeHits || 0) + 1;
  if (atEdge && !P.dead && P.edgeCd <= 0) {
    P.edgeCd = 6; toast('EDGE OF THE MAP\nTURN BACK', 1700);
  }

  /* WEDGED. Plenty of things can pin a car at a standstill — a civilian stopped
     across the lane, a corner between two footprints, an archway entered at the
     wrong angle, a kerb caught just so — and from the driver's seat every one of
     them is the same problem: the throttle is down and nothing is happening.
     Rather than chase each cause, holding the throttle against a standstill for
     a moment eases you out along the way you are pointing.

     Gas only, deliberately. Sitting still on the BRAKE is how you surrender to
     the police, and nudging the car there would break being arrested. */
  // Not at the fence, though: nudging forward there just re-runs you into it,
  // and the edge is a place to turn round rather than a wedge to work out of.
  if (!P.dead && !atEdge && inp.gas && Math.hypot(c.vx, c.vy) < 1.5) P.stuckT = (P.stuckT || 0) + dt;
  else P.stuckT = 0;
  if (P.stuckT > STUCK_SECS) {
    P.stuckT = 0;
    /* Forwards FIRST, since that is what the throttle asked for, but only if
       there is somewhere to go. Nudging blindly ahead when the thing pinning you
       is a wall just drives you into it again and again — it took the car from
       40% armour to nothing against a building that had merely stopped it. */
    const dirs = [0, -.6, .6, Math.PI];
    for (const off of dirs) {
      const a = c.h + off, s = Math.cos(a), t = Math.sin(a);
      if (solidAt(c.x + s * 2.4, c.y + t * 2.4)) continue;
      c.x += s * 1.2; c.y += t * 1.2;       // out of whatever the overlap is
      c.vx += s * UNSTICK; c.vy += t * UNSTICK;   // and moving, so it does not re-settle
      break;
    }
  }

  /* --- building impact. Rate-limited the same way car-to-car already is: this
     ran every frame the car was overlapping, so LEANING on a wall was sixty
     damage events a second. It only stayed survivable because the old engine
     couldn't sustain the push; at accel 40 holding the throttle against a
     building took a healthy car to nothing in about a second. Hitting a wall
     should hurt — resting against one should not keep hurting. */
  // GHOST drives through them. Not skipped for traffic or police — they still
  // have to respect the city, or a chase turns into cars swimming through walls.
  const impact = GHOST ? 0 : buildingCollide(c);
  P.bldCd = Math.max(0, (P.bldCd || 0) - dt);
  if (impact > BLD_MIN && P.bldCd <= 0) {
    P.bldCd = .45;
    const dmg = hurtPlayer(clamp((impact - BLD_MIN) * 1.5, 0, BLD_MAX), 'bld');
    cam.shake = Math.min(1, cam.shake + dmg / 45);
    SFX.crash(impact);
    for (let i = 0; i < 6; i++) parts.push(sparks(c.x, c.y));
  }

  const spd = Math.hypot(c.vx, c.vy);

  // --- traffic
  trafficGrid();                       // before anything asks who is nearby
  for (const t of traffic) updateTraffic(t, dt);
  trafficCollisions();                 // once per pair, off the same grid
  // anything out of health goes up; the list filters below drop the wreckage
  for (const o of traffic) checkWreck(o, dt);
  for (const o of cops) checkWreck(o, dt);
  for (const t of traffic) {
    const rel = carsCollide(c, t);
    if (rel > 6 && P.hitCd <= 0) {
      P.hitCd = .6;
      hurtPlayer(clamp(rel * .7, 0, TRAFFIC_MAX), 'traffic');
      cam.shake = Math.min(1, cam.shake + .35);
      SFX.crash(rel);
      for (let i = 0; i < 5; i++) parts.push(sparks((c.x + t.x) / 2, (c.y + t.y) / 2));
      if (rel > 13) addWanted(.34);
      damageCar(t, rel);
      t.vx += (t.x - c.x) * .5; t.vy += (t.y - c.y) * .5;
    }
  }
  P.hitCd -= dt;
  P.copCd = Math.max(0, (P.copCd || 0) - dt);

  // --- pedestrians
  for (const p of peds) {
    if (p.dead) continue;
    p.t -= dt;
    if (p.t <= 0) { p.t = rand(2, 7); p.h += rand(-1.4, 1.4); }
    const nx = p.x + Math.cos(p.h) * p.spd * dt, ny = p.y + Math.sin(p.h) * p.spd * dt;
    // they stick to the pavement — stepping into the carriageway turns them around
    if (onRoad(nx, ny) && !onRoad(p.x, p.y)) p.h += Math.PI * rand(.6, 1.4);
    else { p.x = nx; p.y = ny; }
    if (dist2(p.x, p.y, c.x, c.y) < 5 && spd > 4) {
      p.dead = true; addWanted(1);
      SFX.crash(8); toast('HEY! WATCH IT', 900);
      for (let i = 0; i < 5; i++) parts.push(sparks(p.x, p.y, '#ff4f6d'));
    }
  }

  // --- police
  let nearCop = false;
  for (const k of cops) {
    updateCop(k, dt);
    const d = dist(k.x, k.y, c.x, c.y);
    if (d < 130) nearCop = true;
    const rel = carsCollide(c, k);
    /* RATE-LIMITED, LIKE EVERYTHING ELSE THAT HITS YOU. This was the one damage
       source in the game with no cooldown on it: buildings are capped at one hit
       per 0.45 s and traffic at one per 0.6 s, both with a comment saying why,
       and a police car could take health on every frame it was touching you. A
       cruiser leaning on the car at a roadblock was sixty hits a second where a
       wall would have been two. It is the same rule as the other two now. */
    if (rel > 5 && P.copCd <= 0) {
      P.copCd = .6;
      hurtPlayer(clamp(rel * .5, 0, COP_MAX), 'cop');
      damageCar(k, rel); addWanted(.22); SFX.crash(rel);
    }
    // busted: you stopped, a cop pulled up alongside and stopped too, for a beat.
    // The cop has to be stationary as well — one blowing past at speed is a near
    // miss, not an arrest.
    const copSpd = Math.hypot(k.vx, k.vy);
    if (d < 8 && spd < 3 && copSpd < 3 && P.wanted >= 1) {
      P.bustT += dt;
      if (P.bustT > 1.6 && !P.dead) busted();
    }
  }
  if (!nearCop || P.wanted === 0) P.bustT = 0;

  if (P.wanted > 0) {
    if (!nearCop) {
      P.cool += dt;
      if (P.cool > 8) { P.cool = 0; P.wanted = Math.max(0, P.wanted - 1); if (P.wanted === 0) { cops = []; toast('YOU LOST THEM', 1400); } }
    } else P.cool = 0;
    // despawn units that fell hopelessly behind, then top the pursuit back up
    cops = cops.filter(k => !k.dead && dist(k.x, k.y, c.x, c.y) < 700);
    /* Topping the pursuit up is a search over the road index, and when the
       player outruns the units chasing them the cull above empties the list
       continuously — eight searches a frame for the length of the chase. But a
       flat timer also delays refills that WOULD have worked, and a wanted level
       with no police is worse than the cost. So it runs every frame and backs
       off only when the search actually fails, which is the case that thrashes. */
    P.copT = (P.copT || 0) - dt;
    const want = Math.round(P.wanted * 1.6);
    if (P.copT <= 0 && cops.length < want && !stockCops(want)) P.copT = .5;
  }

  // --- mission markers
  if (MISSION.state === 'pickup' && MISSION.pick && dist(c.x, c.y, MISSION.pick.x, MISSION.pick.y) < 7) {
    startDelivery();
  } else if (MISSION.state === 'deliver') {
    MISSION.time -= dt;
    if (MISSION.time <= 0) failDelivery();
    else if (MISSION.drop && dist(c.x, c.y, MISSION.drop.x, MISSION.drop.y) < 8 && spd < 14) completeDelivery();
  }

  // --- repair shops: drive in, leave with full armor and a new paint job
  for (const p of W.pois) {
    if (p.cool > 0) p.cool -= dt;
    if (p.kind !== 'repair' || p.cool > 0 || P.dead) continue;
    if (dist2(c.x, c.y, p.x, p.y) < 100) repairAt(p);
  }


  // --- the armor comes back when nothing has hit you for a while
  if (!P.dead) {
    P.calm = (P.calm || 0) + dt;
    if (P.calm > REGEN_AFTER && c.hp > 0 && c.hp < REGEN_CAP)
      c.hp = Math.min(REGEN_CAP, c.hp + REGEN_RATE * dt);
  }

  // --- health / death
  if (c.hp <= 0 && !P.dead) { c.hp = 0; wasted(); }
  if (P.dead) { P.deadT -= dt; if (P.deadT <= 0) doRespawn(); }

  // --- respawn thinning population near the player
  /* Traffic only exists where you can see it — see trafficR(). Police are NOT
     culled to the screen: a pursuit that evaporates the moment it drops out of
     frame is not a pursuit, so they keep their own 700 m leash. */
  const tR = trafficR();
  traffic = traffic.filter(t => !t.dead && dist2(t.x, t.y, c.x, c.y) < tR * tR);
  peds = peds.filter(p => !p.dead && dist(p.x, p.y, c.x, c.y) < 500);
  /* Refilling the world is a search over the road index, so it is rate-limited
     rather than run every frame. Traffic tops out at 17 m/s and you now do 100:
     outrun it and both lists empty continuously, and topping them up one per
     frame became sixty road searches a second, plus sixty more for the
     pedestrians, for as long as you kept your foot down. That, not the drawing,
     was what halved the frame rate at speed. */
  P.popT = (P.popT || 0) - dt;
  if (P.popT <= 0) {
    P.popT = .25;
    const cap = trafficCap();
    const need = cap - traffic.length;
    /* Five a tick while topping up, as before — spawning is a road search and
       raising the steady rate to ten cost four frames a second at dusk, where
       cars are being culled and replaced constantly as you drive. A big burst is
       only for the standing start and the switch into daylight, where the deficit
       is two hundred and filling it five at a time would take ten seconds. */
    if (need > 0) spawnTraffic(Math.min(need > 40 ? 25 : 5, need));
    else if (need < 0) traffic.length = cap;               // switched back to dusk
    if (peds.length < 34) spawnPeds(Math.min(6, 34 - peds.length));
  }

  // --- effects bookkeeping
  for (const m of marks) m.life -= dt;
  marks = marks.filter(m => m.life > 0);
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .94; p.vy *= .94; p.life -= dt; }
  parts = parts.filter(p => p.life > 0);
  for (const b of blasts) { b.life -= dt; b.r += (b.max - b.r) * decay(9, dt); }
  blasts = blasts.filter(b => b.life > 0);
  cam.shake = Math.max(0, cam.shake - dt * 2.2);
  if (!c.road && spd > 6) cam.shake = Math.min(.28, cam.shake + dt * .55);

  // --- camera: follow with a little lead, pull back with speed
  const lead = clamp(spd / 45, 0, 1) * 26;
  const tx = c.x + Math.cos(c.h) * lead, ty = c.y + Math.sin(c.h) * lead;
  const k = decay(6.5, dt);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  cam.s += (lerp(9.4, 4.6, clamp(spd / TOP_SPEED, 0, 1)) * zoomK - cam.s) * decay(2.4, dt);

  // --- audio
  SFX.engine(clamp(spd / 46, 0, 1), inp.gas ? 1 : .3);
  SFX.siren(P.wanted >= 1 && cops.some(k => dist(k.x, k.y, c.x, c.y) < 170), dt);

  updateNav(dt);
  updateChunks();
  updateRetries();
  updateMapWindow();

  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
}

function sparks(x, y, col) {
  const a = rand(0, TAU), s = rand(3, 16);
  return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(.25, .7), col: col || pick(['#ffe36a', '#fff', '#ff9f5a']) };
}

function updateTraffic(t, dt) {
  const r = t.road_;
  if (!r || r.pts.length < 2) { rehome(t); return; }

  /* FOLLOW THE ROAD, DON'T CHASE THE NEXT NODE.

     Aiming straight at the next node and steering hard at it is how a car ends
     up driving in circles: it cannot turn tightly enough at speed, sails past,
     and the node is then BEHIND it — so it turns back, misses again from the
     other side, and loops. Weakening the steering to stop the weaving made that
     worse, because a car that turns even less overshoots even further.

     So the aim point is a few car-lengths DOWN the road rather than on it, walked
     along the polyline and interpolated. On a straight that point is dead ahead
     and the wheel stays still; into a corner it rounds the corner before the car
     does, which is how anything follows a path smoothly. The wheel gets its full
     authority back — drive() already tapers steering with speed. */
  t.idx = clamp(t.idx, 0, r.pts.length - 1);
  const spd = Math.hypot(t.vx, t.vy);
  const reach = 6 + spd * .35;                 // a node counts as reached sooner at speed
  const fx = Math.cos(t.h), fy = Math.sin(t.h);
  let guard = 0;
  while (guard++ < 8) {
    const n = r.pts[t.idx];
    const dx0 = n.x - t.x, dy0 = n.y - t.y;
    // reached it, or gone past it — passing one used to leave the car turning
    // round to come back for a node it had already driven over
    const done = (dx0 * dx0 + dy0 * dy0) < reach * reach ||
                 (dx0 * fx + dy0 * fy < 0 && (dx0 * dx0 + dy0 * dy0) < 900);
    if (!done) break;
    t.idx += t.dir;
    if (t.idx < 0 || t.idx >= r.pts.length) {
      // dead end: turn round, stepping back TWO so the car is not stood on its
      // own target with atan2 of a zero vector for a heading
      t.dir *= -1;
      t.idx = clamp(t.idx + 2 * t.dir, 0, r.pts.length - 1);
      break;
    }
  }

  // the point LOOK metres further along the way, wherever that falls
  const LOOK = 10 + spd * .6;
  let ax = r.pts[t.idx].x, ay = r.pts[t.idx].y;
  let left = LOOK - dist(t.x, t.y, ax, ay), k = t.idx;
  /* THE DIRECTION OF THE ROAD AT THE AIM POINT, tracked alongside it, because the
     lane offset below has to be square to the TARMAC and not to the car. Taking
     it from the car's own heading looks the same on a straight and is wrong in
     every corner: mid-bend the nose points across the lane, so an offset square
     to the car walks the aim point out of the road and the car chases it. Where
     the polyline runs out the car's heading is the only answer left, and by then
     it is aiming at the last node anyway. */
  let dux = Math.cos(t.h), duy = Math.sin(t.h);
  const setDir = (i, j) => {
    const a = r.pts[i], b = r.pts[j];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > 1e-6) { dux = (b.x - a.x) / L; duy = (b.y - a.y) / L; }
  };
  if (t.idx + t.dir >= 0 && t.idx + t.dir < r.pts.length) setDir(t.idx, t.idx + t.dir);
  while (left > 0) {
    const nk = k + t.dir;
    if (nk < 0 || nk >= r.pts.length) break;   // end of the way: aim at the end
    const a = r.pts[k], b = r.pts[nk];
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg >= left) {
      const u = left / seg;
      ax = a.x + (b.x - a.x) * u; ay = a.y + (b.y - a.y) * u;
      setDir(k, nk);
      break;
    }
    ax = b.x; ay = b.y; left -= seg; k = nk;
    setDir(k - t.dir, k);
  }
  /* And over into the right-hand lane. The aim point carries the offset rather
     than the car being pushed sideways: the car then STEERS into its lane and
     holds it the way it holds anything else it is following, through junctions
     and round bends, with no extra force acting on it and nothing for the
     physics to fight. */
  {
    const off = laneOffset(r);
    ax += -duy * off; ay += dux * off;      // (-uy, ux) is one quarter turn right
  }
  const dx = ax - t.x, dy = ay - t.y;
  if (dx * dx + dy * dy < 1) { drive(t, 0, 1, 0, 0, dt); fence(t); return; }  // nowhere to aim: coast
  const want = Math.atan2(dy, dx);
  const steer = clamp(angDiff(t.h, want) * 2.2, -1, 1);
  let throttle = 1;

  // slow down for whatever is directly in front (usually the player)
  let brake = 0;
  const ahead = { x: t.x + Math.cos(t.h) * 9, y: t.y + Math.sin(t.h) * 9 };
  if (dist2(ahead.x, ahead.y, P.car.x, P.car.y) < 42) brake = 1;

  /* AND FOR EACH OTHER, which they never did. Traffic braked for the player and
     for nothing else, so every car drove at a constant 100% throttle into
     whatever was in front of it — and once daylight put ten times as many of
     them on the same streets, the result was a permanent demolition derby going
     off out of sight. Reported as hearing nothing but explosions from cars that
     aren't on the screen, which is exactly what it was.

     A car counts as "in the way" only if it is genuinely AHEAD and roughly in
     line: the dot product against our heading picks out in front from alongside,
     and the perpendicular offset picks out our lane from the oncoming one. Brake
     hard when it is close, lift off when it is merely near — cars that only ever
     brake or floor it end up nose-to-tail concertinas. */
  const cs = Math.cos(t.h), sn = Math.sin(t.h);
  let lead = Infinity;
  for (const o of nearTraffic(t.x, t.y)) {
    if (o === t || o.dead) continue;
    const rx = o.x - t.x, ry = o.y - t.y;
    const fwd = rx * cs + ry * sn;                  // metres ahead of us
    if (fwd <= 0 || fwd > GAP_SEE) continue;
    if (Math.abs(-rx * sn + ry * cs) > 3.2) continue;  // in the next lane, not ours
    if (fwd < lead) lead = fwd;
  }
  if (lead < GAP_STOP) brake = 1;
  else if (lead < GAP_SEE) throttle = Math.max(0, (lead - GAP_STOP) / (GAP_SEE - GAP_STOP));
  /* Panic near a wanted player — but only if they are actually IN FRONT. Braking
     for someone beside or behind you just parks a car across the road with no way
     round it, which is how you end up nose to tail with a stationary civilian at
     2 km/h. Ahead of you is a reason to stop; alongside is a reason to drive on. */
  if (P.wanted > 0 && dist2(ahead.x, ahead.y, P.car.x, P.car.y) < 620) {
    brake = Math.random() < .5 ? 1 : 0;
  }

  drive(t, brake ? 0 : throttle, brake, steer, 0, dt);
  fence(t);
}

/* CAR ON CAR, ONCE PER PAIR. This used to live at the bottom of updateTraffic,
   which runs per car: every pair was tested TWICE and given two lots of damage,
   and the sweep was every car against every other — sixty-five thousand tests a
   frame once daylight put 255 of them on the road. Off the bucket grid it is a
   handful of neighbours each, and `o.i > t.i` means one test and one impact per
   pair rather than two.

   The threshold is higher between two AI cars than it is for the player. They
   are nose to tail in traffic by design and a kiss at walking pace is not a
   crash — it was, and a queue of cars gently touching each other wore itself
   down to nothing over a minute and then detonated, one after another. */
function trafficCollisions() {
  for (const t of traffic) {
    if (t.dead) continue;
    for (const o of nearTraffic(t.x, t.y)) {
      if (o.i <= t.i || o.dead) continue;
      const rel = carsCollide(t, o);
      if (rel > AI_HIT) {
        damageCar(t, rel); damageCar(o, rel);
        SFX.crash(rel * .6 * earshot(t.x, t.y));
      }
    }
  }
}

function updateCop(k, dt) {
  const c = P.car;
  const want = Math.atan2(c.y - k.y, c.x - k.x);
  const df = angDiff(k.h, want);
  const steer = clamp(df * 2.0, -1, 1);
  const d = dist(k.x, k.y, c.x, c.y);
  // Once it has you cornered it pulls up and stops. Without this it keeps the
  // throttle down against a stopped car, never drops below the arrest threshold,
  // and the bust can never fire. Brake is released near zero because drive()
  // turns sustained braking into reverse under 0.8 m/s — hold it and the cop
  // backs away from the arrest it just made.
  const pspd = Math.hypot(c.vx, c.vy);
  const holding = d < 9 && pspd < 4;
  const kspd = Math.hypot(k.vx, k.vy);
  const gas = holding ? 0 : (Math.abs(df) < 1.5 || d > 30) ? 1 : 0;
  const brake = holding ? (kspd > 1.2 ? 1 : 0) : (Math.abs(df) > 2.2 && d < 20) ? 1 : 0;
  /* Higher stars, faster units — and scaled off the player's own top speed, not
     a number that happened to match it. At a fixed 83.5 m/s they were exactly a
     match for the old 300 km/h car and hopelessly outrun by the 360 one: you
     shed them instantly, they were culled at 700 m, and the pursuit respawned
     eight units EVERY FRAME trying to catch up. Half the frame rate, no cops. */
  k.maxSpeed = TOP_SPEED * (.52 + P.wanted * .096);   // 5 stars matches you
  /* Bound the CLOSING speed by distance. Scaling units off the player's top speed
     was necessary — at a fixed 83.5 they could never catch a 360 km/h car — but it
     also put them at 80 m/s while converging on a target doing nothing, and they
     arrived hot enough to wreck themselves and each other. Relative to the
     player's own speed, so a chase at pace is untouched: only the approach is. */
  k.maxSpeed = Math.min(k.maxSpeed, pspd + 12 + d * .55);
  // Closing on someone who has already given up, they come in slowly. At five
  // stars a unit does 80 m/s, and arriving at that speed simply destroys the car
  // — you get wasted where you should have been arrested. The clamp in drive()
  // is hard, so dropping maxSpeed here brakes them on the spot.
  if (pspd < 4 && d < 50) k.maxSpeed = Math.max(7, d * .45);
  drive(k, gas, brake, steer, 0, dt);
  fence(k);
  buildingCollide(k);
  for (const o of cops) if (o !== k) {
    const rel = carsCollide(k, o);
    if (rel > 5.5) { damageCar(k, rel); damageCar(o, rel); }
  }
  k.blink += dt;
}
