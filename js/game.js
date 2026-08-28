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

   IT USED TO BE A NAKED SWITCH, on trust, and the note here argued that any
   check would be a line of JavaScript anyone could read — which is still true
   and is not the point. A perk everyone already has is not a perk: the switch
   sat in the menu next to the ask, and there was no moment where backing the
   thing gave you anything you did not have thirty seconds earlier. Now the word
   goes in the Patreon post and the switch does not exist until it is typed.

   WHAT THIS IS AND IS NOT. It is a courtesy lock. The game is static files on
   GitHub Pages, the source is public, and PERK_WORD is three lines down in
   plain text — anybody who opens the console can read it or simply set the flag
   themselves, and no amount of hashing changes that, because the code doing the
   comparison is equally readable and equally editable. What it does buy is that
   the perk is no longer sitting in the menu for every passer-by, and that the
   word is worth something to the people who paid for it. Obfuscating it would
   cost the one thing that matters here — being able to test the real path with
   the real word — and buy nothing but theatre. */
/* CHANGING THE WORD is this line and nothing else. Case, leading and trailing
   space and any spaces inside are all ignored, because it gets typed on a phone
   with autocorrect fighting back. */
const PERK_WORD = 'kalemegdan';
const perkNorm = w => String(w == null ? '' : w).toLowerCase().replace(/\s+/g, '');
const perkMatches = w => !!perkNorm(w) && perkNorm(w) === perkNorm(PERK_WORD);

// Set when the city you are driving is not the one you asked for; read by the
// pause card so the answer is still there later.
let FELLBACK = null;
/* THE STAMP RATHER THAN A '1', so that changing the word re-locks everyone who
   unlocked with the old one. A bare flag would leave last season's word working
   forever on every phone that had ever typed it. */
const PERK_STAMP = 'w:' + perkNorm(PERK_WORD);
let PERK = store.get('vm_perk', '') === PERK_STAMP;
/* AND GHOST IS GATED ON IT AT THE READ, not only at the switch. Every player who
   ever turned the old free toggle on still has vm_ghost=1 sitting in their
   browser; without this they would keep the perk forever and the lock would
   apply only to new players, which is the one group it does not need to. */
let GHOST = PERK && store.get('vm_ghost', '0') === '1';
/* And the stale flag is cleared rather than left lying there. Without this an
   old free-toggle player who later types the word would find GHOST already on
   after their next reload, switched by a decision they made months ago under
   different rules — the gate would hold for exactly one session and then hand
   the perk over on its own. */
if (!PERK) store.set('vm_ghost', '0');
function setGhost(on) {
  GHOST = PERK && !!on;
  store.set('vm_ghost', GHOST ? '1' : '0');
  syncGhostUI();
}
/* Returns whether the word was right, so the caller can say so. Unlocking does
   NOT switch the perk on — it makes the switch exist, and pressing it is still
   a decision. */
function perkTry(word) {
  if (!perkMatches(word)) return false;
  PERK = true;
  store.set('vm_perk', PERK_STAMP);
  syncGhostUI();
  return true;
}
// Both copies of the switch and the on-screen tag read off the one flag, so the
// menu and the pause card can never disagree about what the car is doing.
function syncGhostUI() {
  for (const id of ['ghostM', 'ghostP']) {
    const el = $(id); if (!el) continue;
    el.setAttribute('aria-pressed', GHOST ? 'true' : 'false');
  }
  $('ghostTag').classList.toggle('on', GHOST);
  // one class on <body>, so both perk blocks swap between the word box and the
  // switch without either of them needing a rule of its own
  document.body.classList.toggle('perked', PERK);
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
    if (!PERK) return;                       // the switch is not there, but be sure
    setGhost(!GHOST);
    if (state === 'play') toast(txt(GHOST ? 'toast.ghostOn' : 'toast.ghostOff'), 1400);
  };

/* The word box, in both perk blocks. Wrong words say so in place rather than as
   a toast, because the menu is up before the game has started and there is
   nothing to toast over. */
for (const [box, btn, msg] of [['keyMi', 'keyMb', 'keyMe'], ['keyPi', 'keyPb', 'keyPe']]) {
  const input = $(box), button = $(btn), note = $(msg);
  if (!input || !button) continue;
  const submit = () => {
    if (perkTry(input.value)) {
      input.value = '';
      if (note) { note.textContent = ''; note.classList.remove('on'); }
      /* Said in both places: a toast if there is a game to toast over, and the
         line in the card either way — the menu has no toast layer over it. */
      if (state === 'play') toast(txt('perk.on'), 1600);
      else if (note) { note.textContent = txt('perk.on'); note.classList.add('on', 'ok'); }
      return;
    }
    if (note) { note.textContent = txt('perk.wrong'); note.classList.add('on'); note.classList.remove('ok'); }
    input.select();
  };
  button.onclick = submit;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}
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
  showLoad(txt('load.finding'), txt('load.gps'));
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
  showLoad(txt('load.locating'), query || label || '');
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
      want.lat = lat; want.lon = lon; want.label = g.name; want.cc = g.cc || '';
    } catch (err) {
      if (gen !== loadGen) return;
      console.warn('geocode failed:', err);
      // A working geocoder saying "no such place" is an answer: a generated city
      // would be actively wrong, so send them back to fix the spelling. A geocoder
      // that never answered is different — we still don't know where they meant,
      // but dead-ending an offline player helps nobody, so fall through and build
      // the offline city with the reason on the label.
      if (/no such place/i.test(err.message)) {
        return backToMenu(txt('err.notFound', { q: query }));
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
    prog(.25, txt('load.streets'), txt('load.streetsAround', { city: name.split(',')[0] }));
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
    prog(.62, txt('load.concrete'), txt('load.features', { n: els.length.toLocaleString() }));
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
  prog(.82, txt('load.neon'), fellBack ? why : '');
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
    prog(.86, txt('load.wholeCity'), txt('load.roadsOut', { km: SKELETON_RADII[0] / 1000 }));
    const skel = await loadSkeleton(m => { $('loadMsg').textContent = m; });
    if (gen !== loadGen) return;
    // Note, don't act on it: the ring that follows is full street detail and still
    // needs the streets query. Scenery-only mode starts when play does.
    // "0 more roads across 18 km" is a real outcome — a small town whose trunk
    // roads the detailed centre already had — but it reads like a failure, so say
    // how big the city is instead of how little the last request added to it.
    if (skel) prog(.88, txt('load.neon'),
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

  prog(.95, txt('load.engine'));
  await new Promise(r => setTimeout(r, 60));
  // The wide map is in, so recycling a district may drop its scenery and keep its
  // roads. Tiles go on carrying streets either way: the skeleton is arterials, and
  // the street you live on is not an arterial.
  WIDE_MAP = !!W.skelRect;
  resetRun();

  prog(1, txt('load.ready'));
  await new Promise(r => setTimeout(r, 180));
  $('load').classList.add('hide');
  $('hud').classList.add('on');
  touchUI = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (touchUI) $('touch').classList.add('on');
  resize();                       // the minimap only has a size once the HUD is visible
  state = 'play'; lastT = performance.now(); acc = 0;
  /* THE RADIO COMES ON WITH THE CAR, which is what a car does — unless the
     player switched it off, which radioWanted remembers between sessions.

     Behind the loading screen rather than on it: the city is already up and
     drivable by the time this asks anyone for anything, so a slow or unreachable
     station directory costs nothing but a radio. And the play attempt inside it
     is expected to be refused on a phone — iOS starts audio only from a real
     gesture, and the tap that started the game is long over by the time a list
     comes back — so the dial parks and the first touch of a pad starts it. */
  /* THE COORDINATES THE WORLD WAS ACTUALLY BUILT ON, which are not always the
     ones asked for. A geocode that never answered leaves lat and lon null and
     the game falls back to the bundled city — real Belgrade, with real
     coordinates of its own — so that is what the dial should be tuned to. And
     the generated lattice under that has no location at all, which is why this
     can still come out null: there is nothing local to a place that does not
     exist, and radioAt refuses coordinates it cannot use. */
  const rLat = Number.isFinite(lat) ? lat : (offline ? offline.lat : null);
  const rLon = Number.isFinite(lon) ? lon : (offline ? offline.lon : null);
  if (typeof radioAt === 'function') radioAt(rLat, rLon, want.cc || '');
  if (typeof radioArm === 'function') radioArm();
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
    toast(txt('toast.couldntLoad', { city: place.toUpperCase(), why,
                                   alt: name.split(',')[0].toUpperCase() }), 7000);
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
    toast(txt('toast.welcome', { city: name.toUpperCase() }), 2600);
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
    toast(txt('toast.mapExtended', { km: Math.round(skel.radius / 1000) }), 2600);
    return true;
  }
  if (kind === 'landmarks') {
    // measured on what is still missing rather than on a count: the load's own
    // sweep can land while this one is in flight, and then a count says nothing
    const before = missingKinds().length, had = W.pois.length;
    await sweepLandmarks();
    if (missingKinds().length >= before && W.pois.length <= had) return false;
    prerenderMap();
    toast(txt('toast.landmarks', { n: W.pois.length - had }), 2200);
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
  toast(txt('toast.gotCity', { city: String(name).split(',')[0].toUpperCase() }), 5000);

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
  /* THE ARMOURED CAR, and the one line that makes it one. Every source of damage
     in the game already funnels through here — that is what this function is
     for — so a police shift takes less of all of them without four separate
     places learning what a police shift is. Scaled before the tally, so the
     figures still say what actually landed. */
  n *= (P.car && P.car.armour) || 1;
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
  MISSION.fire = MISSION.chase = MISSION.fare = null; MISSION.riding = false;
  JOB = 'courier'; jobOffer = null;
  if ($('jobBtn')) $('jobBtn').classList.remove('on');
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

/* ------------------------------ the four shifts ------------------------------

   Asked for: taxi, police, fire and ambulance work, taken by driving to the
   right depot and pressing a button with that vehicle on it.

   WHAT A JOB IS, HERE. One id, one place that hires for it, one emoji and one
   paint job — and a mission generator. Everything else in this file already
   worked in terms of "a target, a clock and a reward", so the four new shifts
   are four generators rather than four subsystems: the update loop below still
   asks the same questions of MISSION, and the map, the radar and the objective
   line already draw whatever MISSION points at.

   THE DEPOT IS REAL. ambulance hires at a hospital and police at a police
   station — both of which the game already pulled from OpenStreetMap — and the
   fire station and the taxi rank were added to that same sweep for this. Nothing
   is placed by the game: if a city has no fire station within 45 km, there is no
   fire work in it, which is what the map says. */
const JOBS = {
  courier:   { at: null,       emoji: '📦', col: '#ff4fd8' },
  taxi:      { at: 'taxi',     emoji: '🚕', col: '#f2b705' },
  police:    { at: 'police',   emoji: '🚓', col: '#eef1f6' },
  fire:      { at: 'fire',     emoji: '🚒', col: '#e0301f' },
  ambulance: { at: 'hospital', emoji: '🚑', col: '#f4f6fa' }
};
const JOB_AT = {};
for (const id in JOBS) if (JOBS[id].at) JOB_AT[JOBS[id].at] = id;
/* Close enough to have pulled up at it. The landmark itself is a point at the
   centre of a building, so this has to clear the building — twenty-two metres is
   about a forecourt, and it is the same order as the eight the delivery drop
   uses. */
const JOB_RANGE = 22;
let JOB = 'courier';

/* WHICH SHIFT IS ON OFFER WHERE YOU ARE STOPPED. Standing at the depot you
   already work for offers the way out instead, because the alternative is a
   button that does nothing at the one place you are most likely to press it. */
function jobHere() {
  const c = P.car;
  if (!c || state !== 'play') return null;
  let best = null, bd = JOB_RANGE * JOB_RANGE;
  for (const q of W.pois) {
    const id = JOB_AT[q.kind];
    if (!id) continue;
    const d = dist2(c.x, c.y, q.x, q.y);
    if (d < bd) { bd = d; best = id; }
  }
  if (!best) return null;
  return best === JOB ? 'courier' : best;
}
function setJob(id) {
  if (!JOBS[id] || id === JOB) return false;
  JOB = id;
  clearMission();
  if (P.car) {
    P.car.color = JOBS[id].col;
    /* THE ARMOURED CAR, which is the half of "special police car" that is not
       paint. Everything that damages the player is scaled by this, so a police
       shift can lean on a fleeing driver without ending the shift. */
    P.car.armour = id === 'police' ? .45 : 1;
  }
  toast(txt('job.took', { job: txt('job.' + id) }), 1800);
  setTimeout(newMission, 700);
  return true;
}
/* The button, refreshed on the same ten-a-second tick the street sign uses
   rather than per frame: it is a proximity test against every landmark in the
   city and nothing about it needs sixty answers a second. */
let jobOffer = null;
function syncJobBtn() {
  const el = $('jobBtn');
  if (!el) return;
  const offer = jobHere();
  if (offer === jobOffer) return;
  jobOffer = offer;
  el.classList.toggle('on', !!offer);
  if (offer) {
    $('jobBtnE').textContent = JOBS[offer].emoji;
    const label = txt('job.take', { job: txt('job.' + offer) });
    el.setAttribute('title', label);
    el.setAttribute('aria-label', label);
  }
}

/* ---- clearing up after whatever the last shift was doing ---- */
function clearMission() {
  MISSION.state = 'none';
  MISSION.pick = MISSION.drop = null;
  MISSION.fire = null;
  MISSION.chase = null;
  if (MISSION.fare) { MISSION.fare.hurt = false; MISSION.fare = null; }
  setObjective('hud.freeRoam');
}

/* ONE DISPATCH, FOUR GENERATORS. Everything downstream — the marker on the map,
   the arrow on the radar, the objective line, the clock — reads MISSION, so a
   new shift is a new way to fill MISSION in and nothing else. */
function newMission() {
  if (state !== 'play') return;
  if (JOB === 'taxi') return newFare();
  if (JOB === 'ambulance') return newCasualty();
  if (JOB === 'fire') return newFire();
  if (JOB === 'police') return newPursuit();
  return newParcel();
}

/* ---- taxi: somebody on the pavement, and somewhere they want to go ----

   THE FARE IS A REAL PEDESTRIAN when there is one to be had. It would have been
   easier to drop a marker on a road point and call it a passenger, and it would
   have looked like one until you arrived at an empty kerb. So this takes
   somebody out of the crowd that is already walking the pavements, stands them
   still to wait, and removes them from the street when they get in — the city is
   one person emptier for the rest of the ride, which is what happened.

   A road point is the fallback for the moment before the crowd has spawned. */
function pickFare(minD) {
  let best = null, bd = Infinity;
  for (const q of peds) {
    if (q.dead || q.hurt) continue;
    const d = dist(q.x, q.y, P.car.x, P.car.y);
    if (d < minD || d > missionReach(520)) continue;
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
function newFare() {
  const who = pickFare(70);
  const p = who || roadPoint(P.car.x, P.car.y, 90, missionReach(480))
                || roadPoint(P.car.x, P.car.y, null);
  if (!p) { MISSION.state = 'none'; return; }
  if (who) who.hurt = 'wait';                 // stands still until you get there
  MISSION.fare = who || null;
  MISSION.pick = { x: p.x, y: p.y, road: p.road };
  MISSION.drop = null;
  MISSION.state = 'pickup';
  const where = p.road && p.road.name;
  setObjective(where ? 'hud.fareOn' : 'hud.fare', { street: where });
}

/* ---- ambulance: somebody who is not walking anywhere ----

   Same crowd, different reason for standing still, and the destination is not a
   road point but a HOSPITAL — one of the landmarks the game already fetches, so
   an ambulance run ends where an ambulance run would end. If the city has no
   hospital the shift cannot run, and says so rather than inventing one. */
function newCasualty() {
  const who = pickFare(60);
  const p = who || roadPoint(P.car.x, P.car.y, 80, missionReach(420));
  if (!p) { MISSION.state = 'none'; return; }
  if (who) who.hurt = 'down';
  MISSION.fare = who || null;
  MISSION.pick = { x: p.x, y: p.y, road: p.road };
  MISSION.drop = null;
  MISSION.state = 'pickup';
  const where = p.road && p.road.name;
  setObjective(where ? 'hud.casualtyOn' : 'hud.casualty', { street: where });
}

/* ---- fire: a building, alight ----

   A REAL BUILDING out of the world, not a point on a road: the thing that is
   burning has to be a thing. The fire is a number that comes down while you are
   parked next to it, and goes back up while you are not, so driving away is
   losing ground rather than pausing.

   It burns visibly through the particle system the explosions already use, which
   is drawn by BOTH renderers — a fire only the top-down view could see would be
   no fire at all in the view most people play in. */
const FIRE_REACH = 16, FIRE_RATE = 26, FIRE_REGROW = 5;
function newFire() {
  let best = null, bd = Infinity;
  const reach = missionReach(500);
  for (const b of W.buildings) {
    const d = dist(b.cx, b.cy, P.car.x, P.car.y);
    if (d < 60 || d > reach) continue;
    if (d < bd) { bd = d; best = b; }
  }
  if (!best) { MISSION.state = 'none'; setTimeout(newMission, 3000); return; }
  MISSION.fire = { x: best.cx, y: best.cy, hp: 100, t: 0 };
  MISSION.state = 'fire';
  MISSION.reward = Math.round(260 + bd * 1.1 + MISSION.done * 40);
  setObjective(best.sign ? 'hud.fireAt' : 'hud.fireOut', { street: best.sign || '' });
}
function emitFire(f, dt) {
  f.t -= dt;
  if (f.t > 0) return;
  f.t = .06;
  const k = clamp(f.hp / 100, 0, 1);
  for (let i = 0; i < 2; i++) {
    const a = rand(0, TAU), r = rand(0, 7) * k;
    parts.push({ x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r,
      vx: rand(-1, 1), vy: rand(-1, 1),
      life: rand(.4, 1.0), r: rand(.5, 1.5) * (.4 + k),
      col: pick(['#ff8a2a', '#ff5a1f', '#ffa347', '#ffd06a']) });
  }
  parts.push({ x: f.x + rand(-5, 5), y: f.y + rand(-5, 5), vx: rand(-.6, .6), vy: rand(-.6, .6),
    life: rand(1.0, 2.0), r: rand(1.2, 2.6), col: '#4a4048' });
}

/* ---- police: stop that car ----

   Marked out of the traffic already on the street rather than spawned, so the
   car you are told to stop is one that was going about its business a second
   ago. It is given a longer leash — a higher top speed — so it is a pursuit
   rather than a formality, and it counts as stopped when it has been beaten
   down, which covers both halves of what was asked: arrested if it survives
   being run off the road, destroyed if it does not. */
const CHASE_STOP = 34;
function newPursuit() {
  let best = null, bd = Infinity;
  for (const t of traffic) {
    if (t.dead) continue;
    const d = dist(t.x, t.y, P.car.x, P.car.y);
    if (d < 40 || d > 520) continue;
    if (d < bd) { bd = d; best = t; }
  }
  if (!best) { MISSION.state = 'none'; setTimeout(newMission, 2500); return; }
  best.wanted = true;
  best.maxSpeed = Math.max(best.maxSpeed, 26);
  MISSION.chase = best;
  MISSION.state = 'chase';
  MISSION.reward = Math.round(300 + MISSION.done * 50);
  setObjective('hud.pursue');
}

function newParcel() {
  const p = roadPoint(P.car.x, P.car.y, 90, missionReach(480))
         || roadPoint(P.car.x, P.car.y, null);
  if (!p) { MISSION.state = 'none'; return; }
  MISSION.pick = p; MISSION.drop = null;
  MISSION.state = 'pickup';
  const where = p.road && p.road.name;
  setObjective(where ? 'hud.pickUpOn' : 'hud.pickUp', { street: where });
}
/* THE SECOND LEG, whatever was collected on the first.

   A parcel and a fare both want a road point somewhere across town; a casualty
   wants the nearest HOSPITAL, which is a landmark the game already has. One
   function rather than three because the clock, the fee and the arrival test are
   the same in all three cases — only where it is going differs, and that is one
   lookup. */
function startDelivery() {
  const d = JOB === 'ambulance'
    ? nearestPOI('hospital', P.car.x, P.car.y)
    : (roadPoint(P.car.x, P.car.y, 180, missionReach(700))
       || roadPoint(P.car.x, P.car.y, null));
  if (!d) { MISSION.state = 'none'; setTimeout(newMission, 2000); return; }
  /* THE PASSENGER GETS IN, which is why the street is one person emptier for the
     rest of the ride. Removed from the crowd rather than merely hidden: a
     pedestrian standing inside the car is one the collision code can hit. */
  if (MISSION.fare) {
    const i = peds.indexOf(MISSION.fare);
    if (i >= 0) peds.splice(i, 1);
    MISSION.fare = null;
    MISSION.riding = true;
  }
  MISSION.drop = d;
  MISSION.state = 'deliver';
  const dd = dist(P.car.x, P.car.y, d.x, d.y);
  MISSION.time = clamp(dd / 13 + 18, 22, 150);   // cross-district runs need the room
  const rate = JOB === 'taxi' ? 2.1 : JOB === 'ambulance' ? 2.4 : 1.6;
  MISSION.reward = Math.round(120 + dd * rate + MISSION.done * 45);
  SFX.pickup();
  toast(txt(JOB === 'courier' ? 'toast.secured' : 'toast.aboard', { n: MISSION.reward }), 1800);
  const where = d.road && d.road.name;
  const key = JOB === 'ambulance' ? 'hud.toHospital'
            : JOB === 'taxi' ? (where ? 'hud.driveTo' : 'hud.driveFare')
            : (where ? 'hud.deliverTo' : 'hud.deliverPkg');
  setObjective(key, { street: where || (d.name || '') });
}
function completeDelivery() {
  P.cash += MISSION.reward; P.score += MISSION.reward;
  MISSION.done++;
  MISSION.riding = false;
  store.set('vm_cash', P.cash);
  SFX.cash();
  toast(txt(JOB === 'courier' ? 'toast.delivered' : 'toast.droppedOff', { n: MISSION.reward }), 2000);
  MISSION.state = 'none';
  setTimeout(newMission, 900);
}
/* Putting out a fire and stopping a runaway both end the same way: paid, and the
   next call comes in. */
function completeJob(key) {
  P.cash += MISSION.reward; P.score += MISSION.reward;
  MISSION.done++;
  store.set('vm_cash', P.cash);
  SFX.cash();
  toast(txt(key, { n: MISSION.reward }), 2000);
  MISSION.fire = null; MISSION.chase = null;
  MISSION.state = 'none';
  setObjective('hud.freeRoam');
  setTimeout(newMission, 1200);
}
function failDelivery() {
  MISSION.state = 'none';
  MISSION.riding = false;
  toast(txt('toast.tooSlow'), 1800);
  setObjective('hud.freeRoam');
  setTimeout(newMission, 1600);
}
// The radar sits under the objective now, so a longer objective that wraps to an
// extra line shifts it down — re-cache the rect the edge arrow dodges against.
/* THE OBJECTIVE IS KEPT AS A KEY, not as the sentence it renders to. Changing
   language has to re-say everything on screen, and a line that was written into
   the HUD as finished text cannot be re-said — it would sit there in the old
   language until the next delivery. The street name inside it is a proper noun
   and stays exactly as the map spells it. */
let OBJ = { key: 'hud.freeRoam', vars: null };
function refreshObjective() {
  $('objT').textContent = txt(OBJ.key, OBJ.vars);
}
function setObjective(key, vars) {
  OBJ = { key, vars: vars || null };
  refreshObjective();
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
    if (before === 0) toast(txt('toast.wanted'), 1200);
  }
}
/* A repair shop puts the armor back and resprays you on the way out. The new
   colour excludes the current one, so it always visibly changes. */
function repairAt(p) {
  /* PRICED OFF THE DAMAGE, and priced BEFORE the car is healed — repairCost(100)
     is the minimum, so reading it after setting hp to 100 would charge everyone
     a hundred dollars whatever they arrived in. */
  const cost = repairCost(P.car.hp);
  if (P.car.hp >= 100) { p.cool = 2; return; }   // nothing to fix, nothing to charge
  if (P.cash < cost) {
    p.cool = 2;                                // just long enough not to spam the toast
    toast(txt('toast.repairsCost', { n: cost }), 1600);
    return;
  }
  p.cool = 6;                                  // parked on it shouldn't re-fire
  P.cash -= cost;
  store.set('vm_cash', P.cash);
  P.car.hp = 100;
  const others = PAL.carBody.filter(c => c !== P.car.color);
  P.car.color = pick(others.length ? others : PAL.carBody);
  SFX.pickup();
  toast((p.name ? p.name.toUpperCase() + ' · ' : '') +
        txt('toast.repaired', { n: cost }), 1800);
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
/* HOW LONG THE STREET NAME STAYS UP. It was four seconds, which is about two
   blocks at speed — long enough to catch it only if you were already looking at
   that corner of the screen when it appeared, and the name of the road you are
   on is worth reading late as well as early. Nine gives you time to glance down
   after the corner rather than during it.

   Nothing stacks up as a result: a new street REPLACES the label and restarts
   the clock, so a dense grid shows a near-continuous readout of where you are
   rather than a queue of names waiting their turn. */
const STREET_HOLD = 9;
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
    NAV.street = nm; NAV.lastX = c.x; NAV.lastY = c.y; NAV.showT = STREET_HOLD;
    $('street').textContent = nm;
    $('street').classList.add('on');
  }

  // the depot button, on the same tick: it is a proximity test against every
  // landmark in the city and nothing about it needs sixty answers a second
  syncJobBtn();

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
    P.edgeCd = 6; toast(txt('toast.edge'), 1700);
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
      /* AND THE RADIO IS LEFT ALONE. A shunt used to knock the dial off its
         station. It reads as the game taking the station away from you at the
         exact moment you are busy, and a crash already has the horn, the bang,
         the shake and the damage on it — see the collision block in
         tests/radio.mjs, which now asserts that neither traffic nor police move
         the dial. The draw at the start of a city stays: that is a new city, and
         nothing is playing yet to interrupt. */
    }
  }
  P.hitCd -= dt;
  P.copCd = Math.max(0, (P.copCd || 0) - dt);

  // --- pedestrians
  for (const p of peds) {
    if (p.dead) continue;
    /* SOMEBODY WAITING FOR YOU DOES NOT WALK OFF. A fare who has flagged you
       down and a casualty on the ground both stand where they are — otherwise
       the marker crawls along the pavement while you drive to where it was. */
    if (!p.hurt) walkPed(p, dt);
    if (dist2(p.x, p.y, c.x, c.y) < 5 && spd > 4) {
      p.dead = true; addWanted(1);
      SFX.crash(8); toast(txt('toast.watchIt'), 900);
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
      if (P.cool > 8) { P.cool = 0; P.wanted = Math.max(0, P.wanted - 1); if (P.wanted === 0) { cops = []; toast(txt('toast.lostThem'), 1400); } }
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
  /* A FARE WALKS AND A PARCEL DOES NOT, so the pickup point follows whoever is
     waiting at it. They are stood still — hurt is set when the job is handed
     out — but the crowd is culled and respawned as you drive, and a fare that
     got culled leaves a marker over an empty pavement. Losing the person ends
     the job rather than leaving you to drive to nobody. */
  if (MISSION.state === 'pickup' && MISSION.fare) {
    if (MISSION.fare.dead || peds.indexOf(MISSION.fare) < 0) {
      MISSION.fare = null;
      clearMission();
      setTimeout(newMission, 1200);
    } else {
      MISSION.pick.x = MISSION.fare.x; MISSION.pick.y = MISSION.fare.y;
    }
  }
  if (MISSION.state === 'pickup' && MISSION.pick && dist(c.x, c.y, MISSION.pick.x, MISSION.pick.y) < 7) {
    startDelivery();
  } else if (MISSION.state === 'deliver') {
    MISSION.time -= dt;
    if (MISSION.time <= 0) failDelivery();
    else if (MISSION.drop && dist(c.x, c.y, MISSION.drop.x, MISSION.drop.y) < 8 && spd < 14) completeDelivery();
  } else if (MISSION.state === 'fire' && MISSION.fire) {
    /* PARKED NEXT TO IT, not driving past it. The number comes down while you are
       inside the reach and climbs back while you are not, so leaving is losing
       ground — otherwise the shift is a series of drive-bys. */
    const f = MISSION.fire;
    emitFire(f, dt);
    const near = dist(c.x, c.y, f.x, f.y) < FIRE_REACH;
    f.hp += near ? -FIRE_RATE * dt : FIRE_REGROW * dt;
    if (f.hp > 100) f.hp = 100;
    if (f.hp <= 0) completeJob('toast.fireOut');
  } else if (MISSION.state === 'chase' && MISSION.chase) {
    const t = MISSION.chase;
    if (t.dead || traffic.indexOf(t) < 0) completeJob('toast.stopped');
    else if (t.hp <= CHASE_STOP) {
      /* ARRESTED RATHER THAN DESTROYED, which is the outcome worth having: it is
         beaten, so it stops, and the shift ends without a fireball in a street
         full of civilians. */
      t.vx = t.vy = 0; t.maxSpeed = 0; t.wanted = false;
      completeJob('toast.arrested');
    }
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
