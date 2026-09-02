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

   WHAT THIS IS AND IS NOT. It is a courtesy lock, and the honest description of
   its strength is: it keeps the word out of the shop window. The game is static
   files on GitHub Pages and the source is public, so anyone who opens a console
   can set PERK themselves — that was true when the word sat here in plain text
   and it is true now. What changed is the thing that actually leaked: the word
   itself. In plain text it could be read straight off GitHub by anyone browsing
   the repo, and once read it can be posted somewhere, at which point it is
   worth nothing to the people who paid for it. A digest cannot be read that way.

   It is NOT a password store. The salt and the round count are right here, so
   someone determined, with a wordlist, gets the word back; the rounds only mean
   it costs them something rather than nothing. Guard the word the way you would
   guard the Patreon post it arrives in, not the way you would guard a
   password. */
/* THE WORD ITSELF IS NOT IN THIS REPOSITORY — only the digest of it, so
   changing it means computing a new digest. tools/perkword.mjs takes the new
   word and prints the line to paste here. Case, leading and trailing space and
   any spaces inside are all ignored, because it gets typed on a phone with
   autocorrect fighting back. */
const PERK_SALT = 'vice-maps/ghost/1';
const PERK_ROUNDS = 20000;
/* SHA-256 BY HAND, because the browser will not lend us its own. crypto.subtle
   exists only in a secure context, and a file:// page is not one — on the very
   platform this game is built to run on, opened straight off the disk, it is
   undefined. So: thirty lines of FIPS 180-4, which is a small price for the
   word not being written down anywhere in here.

   Runs once, on the tap of the UNLOCK button, over 32 bytes. PERK_ROUNDS of it
   costs a few tens of milliseconds on a phone — unnoticeable against a button
   press, and enough that a wordlist has to be paid for one word at a time. */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const W256 = new Uint32Array(64);
function sha256(bytes) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // message, a 0x80 byte, zeroes, then the length in bits as a 64-bit big-endian
  const n = bytes.length, buf = new Uint8Array((((n + 9) >> 6) + 1) << 6);
  buf.set(bytes); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(n / 536870912));   // n * 8 / 2^32
  dv.setUint32(buf.length - 4, (n * 8) >>> 0);
  const w = W256;
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
/* Salted so that the same word on some other game does not share this digest,
   and iterated so that guessing costs. Takes an already-normalised word. */
function perkDigest(word) {
  let d = sha256(new TextEncoder().encode(PERK_SALT + '|' + word));
  for (let i = 1; i < PERK_ROUNDS; i++) d = sha256(d);
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}
/* let, not const, so a test can install a secret of its own and then unlock
   through the real path below. The suite cannot know the shipped word — that is
   the point of it being a digest — but the mechanism still has to be covered,
   so tests set this and then type their own word into the real box. */
let PERK_HASH = '7e5a8838ec3d92e93ae588278b274e69c6a4b9c84b2f8978cf846f8cb4e39b5b';
const perkNorm = w => String(w == null ? '' : w).toLowerCase().replace(/\s+/g, '');
const perkMatches = w => !!perkNorm(w) && perkDigest(perkNorm(w)) === PERK_HASH;

// Set when the city you are driving is not the one you asked for; read by the
// pause card so the answer is still there later.
let FELLBACK = null;
/* THE STAMP RATHER THAN A '1', so that changing the word re-locks everyone who
   unlocked with the old one. A bare flag would leave last season's word working
   forever on every phone that had ever typed it. Cut from the digest, not from
   the word — the word is not here to cut from, and the digest changes with it.
   Nothing is hashed at load; this is a substring. */
const PERK_STAMP = 'h:' + PERK_HASH.slice(0, 16);
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

/* ---------------------------------------------------------------------------
   HOW LONG THE LOADING SCREEN IS WILLING TO WAIT.

   Every network deadline in geo.js is a budget for THE REQUEST — how long a
   mirror is allowed to think before the answer stops being worth having. None of
   them was ever a budget for THE PLAYER, and the player is the one watching the
   bar. Measured against mirrors that accept the connection and then say nothing,
   which is the failure a real session reported:

       mirrors healthy                    0.6 s
       mirrors unreachable                3.0 s     (a refusal is fast)
       mirrors silent                    42.3 s     <- the streets deadline
       streets fine, skeleton silent     46.5 s     <- the skeleton ladder

   Forty-two seconds is not the map servers being slow, it is the game being
   broken, and the whole time it is happening there is a real city sitting in the
   download — data/belgrade.js, the same bundle that already rescues a total
   failure. So the loading screen stops waiting long before the request does.

   NOTHING IS CANCELLED. That is what makes this cheap rather than a trade. The
   streets request keeps running behind the wheel, and if it lands the city is
   swapped in exactly the way retryCity already swaps one in — so the cost of
   being impatient is a world that changes under you a few seconds later, not a
   city you never get. Asking Overpass for the same box a second time would be
   the expensive version, and it is the one this avoids.

   NINE SECONDS, because a healthy mirror answers the opening box in about one
   and a half and the hedge starts a new one every 2.2 — so nine covers a mirror
   that is merely busy plus three more behind it, and it is comfortably past the
   six seconds at which the SKIP button already appears. SIX for the skeleton,
   which is scenery on the big map rather than ground under the wheels, and which
   the retry machinery is already built to replace mid-drive. */
const FIRST_WAIT = 9000;
const SKEL_WAIT = 6000;
/* Distinguishable from anything a request can resolve to — Promise.race gives
   back a value, not a reason, so the sentinel is how the caller tells "the
   servers answered" from "we stopped waiting". */
const LATE = Symbol('still waiting');
const patience = ms => new Promise(r => setTimeout(() => r(LATE), ms));

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
  /* A MIRROR HAS SAID NO AND WE ARE HALFWAY THROUGH OUR PATIENCE. Start pulling
     the bundled city now rather than at the moment we give up, so the fallback
     is ready when the patience runs out instead of beginning a six megabyte
     download then. Held off this long on purpose: one refusal early in a load
     that then succeeds is common, and this is bandwidth a player pays for. */
  if (LOAD.lastErr && secs >= FIRST_WAIT / 2000) warmOffline();
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

/* THE OPENING STREETS, STILL IN THE AIR AFTER THE LOADING SCREEN GAVE UP.
   Kept out here so a second DRIVE press can put it out of its misery: the
   generation guard stops a late reply being ADOPTED, but the request itself
   would otherwise go on holding a connection for the rest of its deadline. */
let PENDING = null;
function dropPending() {
  if (PENDING) { try { sessAbort(PENDING); } catch (e) {} PENDING = null; }
}

async function startGame(query, lat, lon, label) {
  const gen = ++loadGen;                 // a second DRIVE press abandons this one
  dropPending();
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
  // the streets request the loading screen stopped waiting for, if there is one
  let late = null;

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
    /* A SCOPE OF ITS OWN, not the loading screen's, because this request is
       allowed to outlive the loading screen — endLoad() aborts everything in
       LOAD, and past FIRST_WAIT this is exactly what must not be aborted. It
       still answers to the SKIP button, which is a decision by the player rather
       than a deadline, so it borrows LOAD's cancel promise. */
    const sess = newSession();
    sess.cancelP = LOAD.cancelP;
    const streets = fetchStreets(lat, lon,
      m => { $('loadMsg').textContent = m; },
      b => { LOAD.bytes = b; }, sess);
    // the race below may settle on the timer and leave this rejection unclaimed
    streets.catch(() => {});
    const els = await Promise.race([streets, patience(FIRST_WAIT)]);
    if (gen !== loadGen) return;
    /* OUT OF PATIENCE, NOT OUT OF LUCK. Down to the bundled city with everyone
       else, but holding on to the request so its answer can still be taken up
       from behind the wheel. */
    if (els === LATE) { PENDING = sess; late = streets; throw new Error('still waiting'); }
    /* How heavy this area is — measured from the reply that landed, not from the
       clock. This used to be `Date.now() - LOAD.t0`, which is everything since
       the player pressed DRIVE: the geocode, and every mirror that was
       unreachable or too slow before a good one answered. In the session that
       exposed it the streets came back in 5.5 s and that expression read 12 s. */
    openingMs = sess.replyMs || (Date.now() - LOAD.t0);
    LOAD.replyMs = openingMs;                  // what the ring is sized off later
    prog(.62, txt('load.concrete'), txt('load.features', { n: els.length.toLocaleString() }));
    data = parseOSM(els);
    // a quiet village is still a real place — only fall back if there's nothing
    if (!data.roads.length) {
      fellBack = true;
      why = 'nothing is mapped around ' + name.split(',')[0];
    }
  } catch (err) {
    if (gen !== loadGen) return;
    // not a failure, so not a warning: the request is still running and this is
    // the game choosing to start without it
    if (late) console.info('map load slow; starting in the bundled city');
    else console.warn('map load failed:', err);
    fellBack = true;
    why = geoFailed ? 'the place search couldn’t be reached'
        // and this one says "still", because it is: the request is in the air and
        // the city will swap itself in if it lands
        : late ? 'the map servers are still thinking'
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

    /* The wide city comes first, because everything downstream of it — the grid,
       the fence, the radar window — is sized from its rectangle, and growing all
       of that mid-drive is a stutter. The ring is detail, and takes whatever
       budget is left.

       BUT ONLY FOR SIX SECONDS. The ladder is four rungs against a forty-five
       second deadline, and a session that reported this spent all of it: sixty
       kilometres timed out, then thirty-six, then eighteen, then nine, and the
       player watched every one of them. A stutter is a worse thing than a wait
       right up until the wait is three quarters of a minute long.

       So it is raced, and it is not cancelled. Past the six seconds the ladder
       carries on behind the wheel and installs itself when it lands, which is
       the same thing runRetry('skeleton') has always done — the machinery for
       growing the world mid-drive already exists, it was simply never used on
       the opening load. */
    prog(.86, txt('load.wholeCity'), txt('load.roadsOut', { km: SKELETON_RADII[0] / 1000 }));
    const skelP = loadSkeleton(m => { $('loadMsg').textContent = m; });
    skelP.catch(() => {});
    let skel = await Promise.race([skelP, patience(SKEL_WAIT)]);
    if (gen !== loadGen) return;
    if (skel === LATE) {
      skel = null;
      skelP.then(s => {
        if (!s || gen !== loadGen || state === 'menu') return;
        WIDE_MAP = true;
        prerenderMap();
        // the stand-in arriving is not news; the real wide map is — and neither is
        // worth a banner over a loading screen that has not finished lifting yet,
        // which is what a ladder that lands at 6.1 s would produce
        if (!s.bundled && state === 'play')
          toast(txt('toast.mapExtended', { km: Math.round(s.radius / 1000) }), 2600);
      }).catch(() => {});
    }
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
  /* WHICH TOUCH SCHEME, applied once the HUD is up so the classes land on a
     body that is about to be visible. Defaults to the stick and remembers what
     was chosen; the pads are still there, one switch away. */
  setCtrl(store.get('vm_ctrl', 'stick'), false);
  /* AND IT HAS TO ANNOUNCE ITSELF ONCE. The stick is drawn under the thumb and
     nowhere else, which is what makes it work for either hand — and it means a
     phone arriving at the game shows no driving controls at all until something
     touches the glass. The pads were their own instructions; this is not, so it
     says what it is the first time and then never again. */
  if (touchUI && CTRL === 'stick' && store.get('vm_stickSeen', '') !== '1') {
    store.set('vm_stickSeen', '1');
    setTimeout(() => { if (state === 'play') toast(txt('menu.stick'), 3200); }, 900);
  }
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
    /* AND IF THE ANSWER IS STILL COMING, TAKE IT. The request the loading screen
       stopped waiting for is running underneath all of this, and its reply
       arrives no later than the deadline that used to hold the player on the bar
       — so the common outcome of being impatient is Belgrade for a few seconds
       and then the city they asked for, instead of forty seconds of nothing. */
    if (late) adoptLateCity(late, want, gen);
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
  return installCity(data, name, lat, lon, gen);
}

/* THE WORLD SWAPPED OUT FROM UNDER A CAR THAT IS ALREADY DRIVING.

   Shared by the two ways a real city can turn up after the game has started in
   the fallback: the timed retry above, and a streets request the loading screen
   stopped waiting for (see FIRST_WAIT). Both arrive holding parsed roads and
   both have to do the same nine things afterwards, and the second one was
   written as a copy of the first for exactly as long as it took to notice that
   a copy is how the two drift apart. */
function installCity(data, name, lat, lon, gen) {
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

/* THE REPLY THAT CAME AFTER THE LOADING SCREEN GAVE UP.

   No request is made here — this is the one already in the air, whose answer is
   now worth a world swap rather than a wait. The projection is the whole
   subtlety: falling back moved the origin to Belgrade, and these elements are
   latitudes and longitudes around the place that was ASKED for, so the origin has
   to go back before parseOSM turns any of it into metres — and go back to
   Belgrade again if the reply turns out to be useless, or the city the player is
   currently driving slides several hundred kilometres sideways. */
async function adoptLateCity(p, want, gen) {
  let els;
  try { els = await p; } catch (err) { PENDING = null; return false; }
  // settled either way, so there is no longer a connection for anyone to abort
  PENDING = null;
  if (gen !== loadGen || state === 'menu' || !els || !els.length) return false;
  const prev = { lat0: GEO.lat0, lon0: GEO.lon0, mLat: GEO.mLat, mLon: GEO.mLon };
  setOrigin(want.lat, want.lon);
  let data;
  try {
    data = parseOSM(els);
    if (!data.roads.length) throw new Error('nothing is mapped there');
  } catch (err) {
    GEO.lat0 = prev.lat0; GEO.lon0 = prev.lon0; GEO.mLat = prev.mLat; GEO.mLon = prev.mLon;
    return false;
  }
  PENDING = null;                   // it landed; there is nothing left to abort
  const ok = installCity(data, want.label || want.query || 'Somewhere', want.lat, want.lon, gen);
  if (!ok) { GEO.lat0 = prev.lat0; GEO.lon0 = prev.lon0; GEO.mLat = prev.mLat; GEO.mLon = prev.mLon; }
  return ok;
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

/* WHAT COUNTS AS A HIT WORTH CALLING THE POLICE OVER, in metres per second of
   closing speed along the point of contact — the same number the damage is
   scaled from. Separate from the thresholds above on purpose: a car takes paint
   off at 6, and that is right, but a star is a different order of event. At 22
   18 somebody has been wrecked; below it you clipped them, and MEASURED that is
   the line worth drawing: doing 100 km/h into the back of a car doing 40 closes
   at about 17, which is the "every hit" the old bar of 13 was catching, while a
   head-on with the same pair closes at nearly 40. The bar for a patrol car is
   lower, because leaning on one is a choice in a way that clipping a hatchback
   in traffic is not. */
const WANTED_HIT = 18, WANTED_HIT_COP = 12;

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
  /* Read here rather than at load, for the same reason the cash is: `store` is
     declared in this file and js/turf.js is evaluated before it, so touching it
     from up there is a dead-zone error before the game has drawn a frame. */
  loadTurf();
  P.score = 0; P.wanted = 0; P.cool = 0; P.dead = false; P.deadT = 0; P.bustT = 0;
  traffic = []; cops = []; peds = []; marks = []; parts = []; blasts = [];
  MISSION.state = 'none'; MISSION.done = 0;
  for (const k in JOB_DONE) delete JOB_DONE[k];   // a new city starts every shift over
  MISSION.fire = MISSION.chase = MISSION.fare = MISSION.rider = null;
  MISSION.riding = false;
  missionSeq++;                 // the last city's pending next-job call is not this city's
  JOB = 'courier'; jobOffer = null;
  if ($('jobBtn')) $('jobBtn').classList.remove('on');
  /* WHICH SIDE YOU ARE ON SURVIVES; THE WALLS DO NOT. The tally is a fact about
     the player and is read back out of storage like the cash; the painted
     buildings were buildings, and this is a different set of them. All that
     needs clearing is the raid clock, so the other side does not turn up in the
     first second of a new city holding a grudge from the last one. */
  resetTurfWalls();
  casinoAt = null; sprayShown = null;
  if ($('betRow')) $('betRow').classList.remove('on');
  if ($('sprayBtn')) $('sprayBtn').classList.remove('on');
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

/* AND EACH SHIFT STARTS EASY AND GETS HARDER.
 *
 * Asked for: the first taxi job should be a short hop and every one after it a
 * bit further, and the same for the other four. Before this, every job of a
 * shift was drawn from one fixed band from the first to the fiftieth — the only
 * thing that grew was the money.
 *
 * COUNTED PER SHIFT, not per session. MISSION.done is the whole run's tally and
 * it never resets when you clock on, so using it would have handed a driver who
 * had already run twenty parcels a thousand-metre first fare. Each shift keeps
 * its own count, which means clocking on to something new starts you gently at
 * that thing — and coming back to a shift you have worked resumes where it was,
 * so swapping jobs is not a way to make the next one short again.
 *
 * IT SURVIVES THE SHIFT AND NOT THE CITY: a new city is a new start, so
 * resetRun clears it along with everything else.
 *
 * The step is deliberately per-job rather than per-minute: the fifth call being
 * further than the first is something a player can feel and predict, where a
 * clock they cannot see is just the game getting harder for no stated reason.
 * Capped, because the delivery clock stops buying time at about 1.7 km — past
 * that, further is not harder, it is impossible. */
const JOB_DONE = {};
const JOB_RAMP_STEP = .30, JOB_RAMP_MAX = 2.4;
const jobRamp = job => Math.min(1 + (JOB_DONE[job] || 0) * JOB_RAMP_STEP, JOB_RAMP_MAX);
/* The band this shift's next job draws from, ramped.
 *
 * The ceiling still goes through missionReach, which is the streaming guard: on
 * a city with one tile loaded there is no point sending anyone two kilometres
 * out, however many jobs they have done, because the roads are not there yet.
 * The ramp grows into the map as the map arrives.
 *
 * The floor is held under the ceiling as well — with a low chunk count the two
 * could otherwise cross and roadPoint would be asked for a band with nothing
 * in it, which returns null and reads as a shift that has run out of work. */
function jobBand(job, minD, maxD) {
  const r = jobRamp(job);
  const hi = Math.min(maxD * r, missionReach(maxD));
  return { lo: Math.min(minD * r, hi * .55), hi, r };
}

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
/* AND THE CAR LOOKS LIKE THE JOB. Paint alone was never going to carry it: a
   white car is an ambulance, a police car and half the traffic. `livery` is what
   is painted ON the paint — read by drawCar in the top-down view and by the
   markings pass in the 3D one, both off the car's own outline, so one word here
   dresses the car in both. The police livery is the one the patrol cars already
   wear, so taking the shift makes you look like the cars you drive alongside. */
const JOBS = {
  courier:   { at: null,       emoji: '📦', col: '#ff4fd8' },
  taxi:      { at: 'taxi',     emoji: '🚕', col: '#f2b705', livery: 'taxi' },
  police:    { at: 'police',   emoji: '🚓', col: '#eef1f6', livery: 'police' },
  fire:      { at: 'fire',     emoji: '🚒', col: '#e0301f', livery: 'fire',
               /* AND THE FIRE SHIFT CHANGES THE VEHICLE, not just its paint. A
                  saloon in red is not a fire engine, and the body is what makes
                  the difference — both renderers build the truck out of the
                  car's own eight corners, so making the car longer, wider and
                  taller here is what makes the appliance an appliance. */
               body: { l: 7.4, w: 2.5, bh: 2.7 },
               /* AND IT GOES WHERE THE FIRE IS. A fire is a building, not a
                  street, and the last thirty metres to one are a forecourt or a
                  yard — the off-road crawl turned the end of every call into a
                  walk. Reported from play, twice: once for the hospital, which
                  was fixed by moving the drop to the door, and once here, where
                  there is no door to move to because the target is the building
                  itself. */
               offroad: true,
               /* AND IT WEIGHS WHAT IT LOOKS LIKE. An appliance is fourteen
                  tonnes against a hatchback's one and a half; the player's
                  ordinary car is already three, so eight is the appliance at
                  something near the real ratio to the traffic around it. */
               mass: 8 },
  ambulance: { at: 'hospital', emoji: '🚑', col: '#f4f6fa', livery: 'ambulance',
               /* A VAN, NOT A SALOON. Same reasoning as the appliance: the shape
                  is what says ambulance, and a red cross on a hatchback is a
                  hatchback with a sticker. Six metres and two and a half tall is
                  a box body with a cab on the front of it.
                  No mass here on purpose: massFor() below weighs it off this
                  body, which is the general rule the appliance opts out of. */
               body: { l: 6.0, w: 2.25, bh: 2.55 } }
};
/* WHAT A SHIFT'S VEHICLE WEIGHS.
 *
 * Reported from play: the ambulance took and dealt exactly what the courier's
 * hatchback did. It did — it was given a bigger BODY and no mass, so it fell
 * back to the stock 3 and heft came out at exactly 1, which is the multiplier
 * that means "nothing applies". The appliance had its 8 and behaved; the van
 * looked like a van and drove like a car.
 *
 * So mass now comes off the body by default rather than from a constant someone
 * has to remember, which is what makes this hold for a truck added later: give
 * it a body and it is heavy because it is big.
 *
 * The exponent is the point. Straight volume makes the van 2.7 times the car
 * and heavier than the appliance, because a box body is mostly air; 0.6 pulls
 * that back to about 1.8, so the ambulance lands near 5 against the car's 3 and
 * the appliance's 8 — a van between a hatchback and a fire engine, which is
 * where a van belongs. An explicit mass still wins, and the appliance keeps
 * one: fourteen tonnes of pump, ladder and water is denser than its own
 * outline, and no rule about volume is going to guess that. */
function massFor(job, stock) {
  if (JOBS[job] && JOBS[job].mass) return JOBS[job].mass;
  const b = JOBS[job] && JOBS[job].body;
  if (!b || !stock) return stock ? stock.mass : 3;
  const vol = q => q.l * q.w * q.bh;
  return stock.mass * Math.pow(vol(b) / vol(stock), .6);
}
const JOB_AT = {};
for (const id in JOBS) if (JOBS[id].at) JOB_AT[JOBS[id].at] = id;
/* Close enough to have pulled up at it. The landmark itself is a point at the
   centre of a building, so this has to clear the building — twenty-two metres is
   about a forecourt, and it is the same order as the eight the delivery drop
   uses. */
const JOB_RANGE = 22;
let JOB = 'courier';

/* THE COUNTER IS ON THE STREET, NOT IN THE APPLIANCE BAY.
 *
 * Reported from play: "fire stations have no roads to come close to." Measured
 * in the capture from Autokomanda, on the fire station the report came from —
 * Ватрогасни савез Београд, at world (975, -180) — the nearest way of ANY kind
 * is 60.5 m away, and the nearest one you are allowed to drive on is the same
 * one. JOB_RANGE is 22. The depot was unreachable by car: the log has the player
 * stopped 37 m short of it, off the tarmac, doing 9 km/h, which is the off-road
 * crawl. It is not a fire-station problem either — it is what happens to any
 * landmark that sits back in its own yard, and stations, hospitals and depots
 * are exactly the buildings that do.
 *
 * So a depot has two places you can be offered its work: the building itself,
 * and the nearest bit of drivable road to it — its gate. You pull up on the
 * street outside, which is what you would actually do, and which is the only
 * thing a car CAN do.
 *
 * The search is a widening ring over the road index, so it is done once per
 * depot and kept. Kept per streaming step rather than forever: roads arrive in
 * chunks, and a gate worked out before this district's streets landed would be
 * a worse answer cached for the rest of the session. GATE_MAX is the honest
 * limit — past it the building really has no road near it and the button says
 * so by not appearing, rather than lying about where you can stand. */
const GATE_LOOK = 200, GATE_MAX = 130;
function depotGate(q) {
  if (q.gateN === CHUNK.loaded) return q.gate;
  q.gateN = CHUNK.loaded;
  /* Bounded on purpose, rather than nearestRoadPoint's widening ladder: the only
     answer worth having is one inside GATE_MAX, and that ladder ends in a scan
     of every drivable way in the world — nineteen thousand of them in Belgrade —
     which is not something to leave reachable from a ten-times-a-second tick,
     however rarely it would fire. */
  const g = nearestRoadPointIn(q.x, q.y, driveRoadsNear(q.x, q.y, GATE_MAX + 40));
  q.gate = (g && dist2(g.x, g.y, q.x, q.y) < GATE_MAX * GATE_MAX) ? { x: g.x, y: g.y } : null;
  return q.gate;
}

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
    let d = dist2(c.x, c.y, q.x, q.y);
    // the road search is only worth doing for a depot you are anywhere near
    if (d > GATE_LOOK * GATE_LOOK) continue;
    const g = depotGate(q);
    if (g) { const dg = dist2(c.x, c.y, g.x, g.y); if (dg < d) d = dg; }
    if (d < bd) { bd = d; best = id; }
  }
  if (!best) return null;
  return best === JOB ? 'courier' : best;
}
/* THE HEAT GOES AWAY WITH THE JOB. You clock on inside a police station, a fire
   station, a hospital or a taxi rank — signing for a city vehicle at the counter
   is not something that happens with a patrol car still on your tail, and a
   pursuit that outlives the shift it started in follows you into the next one
   forever. The cars are dismissed with the stars, because five of them still
   ramming an ambulance is the same problem wearing a different colour. */
function clearHeat() {
  P.wanted = 0; P.cool = 0; P.bustT = 0; cops = [];
}
function setJob(id) {
  if (!JOBS[id] || id === JOB) return false;
  JOB = id;
  clearMission();
  clearHeat();
  if (P.car) {
    /* A FRESH VEHICLE, UNDENTED. Clocking on hands you a different vehicle —
       different body, different livery, different mass — so arriving at the
       hospital in a wreck and driving out in an ambulance that is still at 12%
       reads as the dents having followed you into somebody else's van.
       Deliberately the whole 100 rather than a top-up: this is a swap, not a
       service.

       It does mean the depots undercut the body shops, since two shifts taken in
       turn cost nothing and a repair costs money. Small, because you have to
       drive to the right depot and setJob refuses the shift you are already on,
       so it is never the nearest fix — and worth it against a brand new
       ambulance that arrives pre-crashed. */
    P.car.hp = 100;
    P.car.color = JOBS[id].col;
    P.car.livery = JOBS[id].livery || null;
    /* THE SHAPE, for the one shift that is not a car at all. The stock
       dimensions are kept the first time they are replaced, so clocking off
       gives you back the car you arrived in rather than a slightly different
       one every time — makeCar randomises the length and width. */
    const b = JOBS[id].body;
    if (!P.car.stock) P.car.stock = { l: P.car.l, w: P.car.w, bh: P.car.bh, mass: P.car.mass };
    const s = b || P.car.stock;
    P.car.l = s.l; P.car.w = s.w; P.car.bh = s.bh;
    P.car.mass = massFor(id, P.car.stock);
    P.car.offroad = !!JOBS[id].offroad;
    /* THE ARMOURED CAR, which is the half of "special police car" that is not
       paint. Everything that damages the player is scaled by this, so a police
       shift can lean on a fleeing driver without ending the shift. */
    P.car.armour = id === 'police' ? .45 : 1;
  }
  toast(txt('job.took', { job: txt('job.' + id) }), 1800);
  scheduleMission(700);
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

/* ---- clearing up after whatever the last shift was doing ----

   THE PASSENGER GETS OUT. Somebody who was lifted out of the crowd to be carried
   has to be put back into it when the ride ends, at the kerb where it ended:
   otherwise every completed fare quietly deletes a person from the city and the
   street you dropped them on is empty. They are put on the pavement rather than
   at the drop pin, because the pin is on the centreline and that is the middle of
   the road. The one exception is the ambulance — a casualty is delivered INTO the
   hospital, and does not stroll away from it. */
function dropRider(at) {
  const who = MISSION.rider;
  MISSION.rider = null; MISSION.riding = false;
  if (!who || who.dead || !at) return null;
  /* WHERE THE KERB IS. A drop point handed out by a mission carries the road and
     the node it came from; the car does not, so for a ride that ended anywhere
     else the nearest bit of street is found for it.

     They are then stood on the PAVEMENT, offset across from the centreline —
     the drop pin sits on the centreline, and the centreline is the middle of the
     road. Offsetting from the point itself rather than snapping to the road's
     nearest NODE matters: OpenStreetMap ways can run hundreds of metres between
     nodes, and snapping would have the passenger step out and reappear at the
     far end of the street. */
  const spot = (at.road && at.idx != null) ? at
    : (roadPoint(at.x, at.y, 0, 60) || roadPoint(at.x, at.y, 0, 240)
       || roadPoint(at.x, at.y, null));
  who.hurt = false;                          // walking again, not standing waiting
  who.dir = Math.random() < .5 ? 1 : -1;
  who.side = pick([-1, 1]);
  if (spot && spot.road && spot.road.pts) {
    const r = spot.road, h = spot.h || 0, off = pedOffset(r);
    who.road = r;
    // the node AHEAD of them in the direction they set off, not the one behind
    who.idx = clamp(who.dir > 0 ? spot.idx + 1 : spot.idx, 0, r.pts.length - 1);
    /* THE SIDE IS RELATIVE TO THE WAY THEY FACE, which is how pedWalkPoint reads
       it — so the heading is turned round for someone walking against the way.
       Getting this wrong put them on the correct pavement and then had them walk
       straight across the road to the other one on the first step. */
    const hx = Math.cos(h) * who.dir, hy = Math.sin(h) * who.dir;
    who.x = spot.x - hy * off * who.side;
    who.y = spot.y + hx * off * who.side;
    who.h = Math.atan2(hy, hx);
  } else { who.x = at.x; who.y = at.y; }
  if (peds.indexOf(who) < 0) peds.push(who);
  return who;
}
/* AN AMBULANCE RUN ENDS ONE OF TWO WAYS and neither of them is a casualty
   strolling off down the pavement: they either reach the hospital, in which case
   they are indoors, or they do not, in which case they are lost. Every other
   shift puts its passenger back on the street. */
function releaseRider(at) {
  if (JOB === 'ambulance') { MISSION.rider = null; MISSION.riding = false; return null; }
  return dropRider(at);
}

function clearMission() {
  missionSeq++;                 // voids any next-job call the last shift left pending
  MISSION.state = 'none';
  MISSION.pick = MISSION.drop = null;
  MISSION.fire = null;
  MISSION.chase = null;
  if (MISSION.fare) { MISSION.fare.hurt = false; MISSION.fare = null; }
  // changing shift mid-ride is still the end of the ride, so let them out here
  dropRider(P.car);
  setObjective('hud.freeRoam');
}

/* THE NEXT JOB IS ALWAYS ON A TIMER, and there must only ever be one of them
   pending. Every mission ends by asking for the next one a second or two later,
   and clocking on at a depot asks for one too — so failing a delivery and walking
   straight into a fire station left two of them queued, and the stale one landed
   a couple of seconds into the new shift and re-rolled the job you had just been
   given. A sequence number rather than a stored handle, because clearMission has
   to be able to cancel a pending call it did not schedule. */
let missionSeq = 0;
function scheduleMission(ms) {
  const n = ++missionSeq;
  setTimeout(() => { if (n === missionSeq) newMission(); }, ms);
}

/* ONE DISPATCH, FOUR GENERATORS. Everything downstream — the marker on the map,
   the arrow on the radar, the objective line, the clock — reads MISSION, so a
   new shift is a new way to fill MISSION in and nothing else. */
function newMission() {
  /* NO GUARD ON state HERE, and that was a real bug for one commit. resetRun
     hands out the opening contract while the loading screen is still up — the
     state does not become 'play' until after the world is built — so refusing
     to work outside 'play' meant a fresh city started with no job at all, and
     window.__m().pick came back null. Caught by tests/gameplay.mjs, which drives
     straight to the first pickup. */
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
  /* The waiting fare, in this shift's current band. pickFare takes the nearest
     one past its floor, which on the first fare of a shift is the point — a
     first job should be round the corner. */
  const b = jobBand('taxi', 70, 480);
  const who = pickFare(b.lo);
  const p = who || roadPoint(P.car.x, P.car.y, b.lo, b.hi)
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
/* AND THE PATIENT IS ACROSS TOWN, not outside the front door.
 *
 * Reported from play: the patients are too close to the hospital. They were,
 * for the same reason the fires were too close to the fire station —
 * pickFare(60) takes the NEAREST pedestrian at least sixty metres off, and you
 * are standing at the hospital every time a call is handed out: when you clock
 * on, and again after every delivery, because the hospital IS the drop. So the
 * whole shift was sixty metres out and sixty metres back.
 *
 * The patient is now PUT somewhere in a band rather than chosen from the crowd.
 * That is not a stylistic preference: the crowd only exists within 500 m of the
 * car — spawned between 40 and 400, culled at 500 — so there is nobody further
 * out to choose, and choosing from what is nearby is precisely the fault. An
 * ambulance is dispatched to an address; it does not look around for the
 * closest person already lying down.
 *
 * Measured against the hospital as well as the car, because those are the same
 * place only at the moment the shift is taken. A call that lands next door to
 * the hospital while you happen to be across town is the same complaint from
 * the other end.
 *
 * The clock and the money needed nothing: both are set at pickup from the
 * length of the run — clamp(dd / 13 + 18, 22, 150) and 2.4 a metre — so a
 * longer job already gets the room and already pays for it, and the leg out to
 * the patient is untimed. */
/* THE FIRST PATIENT IS NEARER THAN THE FIFTH, and the floor comes down to 260
   from the flat 420 this had after the "patients too close to the hospital"
   report. That is a deliberate softening of that fix, not an accident: what was
   wrong there was that EVERY call was 60 to 136 m out, so the whole shift was a
   lap of the car park. A first call at 260 m and a fifth past 600 is a shift
   that starts gently and grows, which is what was asked for now, and 260 m is
   still a street away rather than next door. */
const CASUALTY_MIN = 260;
/* THE SAME BAND THE FIRES USE, and not a metre wider, because the return leg is
   the one on a clock: MISSION.time is clamp(dd / 13 + 18, 22, 150), so distance
   stops buying time at about 1.7 km and everything past that is a shorter run
   against the same 150 seconds. A fire has no such clock and can afford to be
   further. Handing out a job that cannot be finished is not difficulty. */
/* AND ON THIS SIDE OF THE RIVER. Reported from play: a call across the Sava,
   which the band was perfectly happy with because the band is a straight line
   and a straight line does not know about water. It was six hundred metres of
   radar and several kilometres of driving, and the clock — also sized off the
   straight line — gave it a minute.
 *
 * So the band is kept and a second test is put after it: the drive has to be
 * within half as long again as the walk. 1.6 is a whole block of slack — a
 * right-angled grid costs at most 1.41 and usually about 1.25, and the octile
 * steps roadField takes overstate a diagonal by a few percent on top — while a
 * detour to the nearest bridge costs three to ten times. The two do not
 * overlap, which is what makes this a test rather than a tuning knob.
 *
 * MEASURED FROM BOTH ENDS, like the band above it and for the same reason: the
 * car and the hospital are the same place only at the instant the shift is
 * taken. A patient reachable from the car but not from the hospital is the same
 * complaint arriving on the second leg instead of the first. */
const DETOUR_OK = 1.6;
function casualtySpot() {
  const b = jobBand('ambulance', CASUALTY_MIN, 900);
  const reach = b.hi, floor = b.lo;
  const h = nearestPOI('hospital', P.car.x, P.car.y);
  /* Two fields, built once and asked two dozen times. Sized off the WIDER of
     the band and the fallback below it, so one pair of fields answers for both,
     and wide enough to contain a detour worth rejecting — a candidate whose
     drive runs past the edge of the field reads as unreachable, which is the
     answer we wanted for it anyway. */
  const wide = Math.max(reach, missionReach(420));
  const cap = Math.max(1600, wide * 2.4);
  const fCar = roadField(P.car.x, P.car.y, cap);
  const fHos = h ? roadField(h.x, h.y, cap) : null;
  const shortWayRound = p => {
    if (!fCar) return true;                 // no mask yet: nothing to judge with
    const dc = fCar.at(p.x, p.y);
    if (dc == null || dc > dist(P.car.x, P.car.y, p.x, p.y) * DETOUR_OK) return false;
    if (!fHos) return true;
    const dh = fHos.at(p.x, p.y);
    return dh != null && dh <= dist(h.x, h.y, p.x, p.y) * DETOUR_OK;
  };
  /* Tried a handful of times rather than once: roadPoint hands back ONE random
     point in the band, and the hospital test can reject it. */
  for (let i = 0; i < 14; i++) {
    const p = roadPoint(P.car.x, P.car.y, floor, reach);
    if (!p) break;
    if (h && dist(p.x, p.y, h.x, h.y) < floor) continue;
    if (shortWayRound(p)) return p;
  }
  /* NOTHING IN THE BAND ON THIS BANK: LOOK FURTHER OUT, NOT NEARER. The
     detour test is kept through this fallback rather than dropped with the
     band, because a nearer call on the wrong side of the water is not an
     improvement on a far one — and the FLOOR is kept with it, where the old
     fallback dropped to 80: "widen the search" must not quietly mean handing
     out the next-door calls the band exists to stop. */
  for (let i = 0; i < 10; i++) {
    const p = roadPoint(P.car.x, P.car.y, floor, wide);
    if (!p) break;
    if (shortWayRound(p)) return p;
  }
  return roadPoint(P.car.x, P.car.y, floor, reach)
      || roadPoint(P.car.x, P.car.y, 80, missionReach(420))
      || roadPoint(P.car.x, P.car.y, null);
}
function newCasualty() {
  const p = casualtySpot();
  if (!p) { MISSION.state = 'none'; return; }
  /* Stood on the pavement the way the rest of the crowd is, and pushed into the
     crowd, so everything that already knows how to draw, move, collide with and
     pick up a pedestrian goes on working unchanged.
   *
     ON THE POINT THE BAND CHOSE, THOUGH, NOT ON THE ROAD'S NEAREST NODE.
     pedWalkPoint anchors on r.pts[idx], which is the right thing for the crowd —
     they are spawned AT a node and walk away from it — and the wrong thing here,
     because roadPoint hands back a point interpolated ALONG the segment and it
     is that point which was measured against the band, against the hospital and
     against the drive. OpenStreetMap ways run hundreds of metres between nodes,
     so on a long one the patient was put down a long way from everything that
     had just been checked about them. Same pavement offset, taken off the
     segment's own heading, which roadPoint already worked out. */
  const side = pick([-1, 1]), dir = Math.random() < .5 ? 1 : -1;
  const off = pedOffset(p.road);
  const qx = p.x - Math.sin(p.h) * off * side, qy = p.y + Math.cos(p.h) * off * side;
  const who = makePed(qx, qy, p.road, p.idx, dir, side);
  who.hurt = 'down';
  peds.push(who);
  MISSION.fare = who;
  MISSION.pick = { x: who.x, y: who.y, road: who.road };
  MISSION.drop = null;
  MISSION.state = 'pickup';
  const where = who.road && who.road.name;
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
/* AND IT IS ACROSS TOWN, not next door.
 *
 * Reported from play: the fires were too close to the fire station. They were —
 * the building was the NEAREST one at least 60 m off, and you are standing at
 * the station when the shift is handed out, so every call was sixty metres from
 * the front door. Same shape of mistake as the police target being the nearest
 * car in a band that only reached the end of the street.
 *
 * A call is now somewhere in a band three hundred to nine hundred metres out,
 * and picked at RANDOM from it rather than nearest-first: nearest-first inside a
 * band puts every fire at exactly the minimum, which is a different constant and
 * the same complaint. The old near band survives as the fallback for a city with
 * nothing built that far away. */
// the first call of a shift is the nearest fire; the tenth is across town
const FIRE_MIN = 220;
function newFire() {
  const band = jobBand('fire', FIRE_MIN, 900);
  const reach = band.hi;
  const pool = [];
  for (const b of W.buildings) {
    const d = dist(b.cx, b.cy, P.car.x, P.car.y);
    if (d >= band.lo && d <= reach) pool.push(b);
  }
  let best = pool.length ? pick(pool) : null;
  if (!best) {
    let bd = Infinity;
    for (const b of W.buildings) {
      const d = dist(b.cx, b.cy, P.car.x, P.car.y);
      if (d < 60 || d > reach) continue;
      if (d < bd) { bd = d; best = b; }
    }
  }
  if (!best) { MISSION.state = 'none'; scheduleMission(3000); return; }
  const bd = dist(best.cx, best.cy, P.car.x, P.car.y);
  /* THE BUILDING'S OWN SIZE, carried with the fire.
   *
   * Reported from play: you had to come very close to the building to fight the
   * fire. You had to come INSIDE it — the reach was 16 m measured from the
   * CENTRE of the footprint, and half the diagonal of an ordinary block is more
   * than that, so the only place the game accepted was inside the walls, which
   * on a solid building means nowhere. The radius travels with the fire and
   * everything that measures against it adds it on. */
  const bb = best.bb;
  /* Clamped at both ends: a shed still gets a forecourt's worth of reach, and a
     two-hundred-metre shopping centre does not get to be extinguished from the
     next district. */
  const rad = clamp(bb ? Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) * .5 : 8, 8, 45);
  MISSION.fire = { x: best.cx, y: best.cy, r: rad, hp: 100, t: 0 };
  MISSION.state = 'fire';
  MISSION.reward = Math.round(260 + bd * 1.1 + MISSION.done * 40);
  setObjective(best.sign ? 'hud.fireAt' : 'hud.fireOut', { street: best.sign || '' });
}
/* HOW BIG THE FIRE IS, in flames and in smoke.
 *
 * Reported from play: "I didn't see the fires." They were two half-metre
 * particles every sixteenth of a second inside a seven-metre circle, drawn as
 * billboards a foot off the ground — from a chase camera behind a car that is a
 * flicker at the foot of a building, which is not a fire. And the smoke was one
 * dark speck at the same rate, which is not smoke.
 *
 * So: flames across the whole footprint rather than a fixed circle, several
 * times the size, and a real column of black smoke that RISES. Particles gained
 * a height for it — z, lifted by vz each frame — which the chase view reads and
 * the top-down one ignores, because from directly above a column of smoke is a
 * disc whichever height it is at. */
const FIRE_PART = .05;          // seconds between emissions
function emitFire(f, dt) {
  f.t -= dt;
  if (f.t > 0) return;
  f.t = FIRE_PART;
  const k = clamp(f.hp / 100, 0, 1);
  const spread = Math.max(6, (f.r || 8) * .85);
  /* FLAMES, over the footprint. Three at a time and up to three metres across:
     a burning building is a wall of fire, and at the size these were it read as
     a barbecue in the car park. They rise slowly and die low. */
  for (let i = 0; i < 3; i++) {
    const a = rand(0, TAU), r = Math.sqrt(Math.random()) * spread * (.35 + .65 * k);
    parts.push({ x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r,
      z: rand(0, 2.5), vz: rand(1.6, 4.2),
      vx: rand(-1.4, 1.4), vy: rand(-1.4, 1.4),
      life: rand(.5, 1.2), r: rand(1.1, 3.0) * (.45 + k),
      col: pick(['#ff8a2a', '#ff5a1f', '#ffa347', '#ffd06a', '#ff3b0f']) });
  }
  /* AND BLACK SMOKE ABOVE THEM, which is the half you see from three streets
     away — it is the tallest thing a fire makes and the only part of it that
     clears the roofline. Soft, so it is drawn as a swelling disc rather than a
     square, and long-lived enough to build a column rather than a puff. */
  for (let i = 0; i < 2; i++) {
    const a = rand(0, TAU), r = Math.sqrt(Math.random()) * spread * .7;
    const life = rand(2.2, 4.0);
    parts.push({ x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r,
      z: rand(2, 5), vz: rand(4.5, 8),
      vx: rand(-1.2, 1.2), vy: rand(-1.2, 1.2),
      life, life0: life, soft: true,
      r: rand(1.8, 3.6) * (.5 + k * .8),
      col: pick(['#1c1a1e', '#2b2730', '#141317', '#3a353f']) });
  }
}

/* THE WATER, which was simply not there.
 *
 * Reported from play: no white spray while extinguishing. There was none to
 * see — the fire went out on a number with nothing drawn for it, so the one
 * action the shift is about had no feedback at all beyond the bar going down.
 *
 * It comes off the nose of the appliance and is aimed at the fire, so it reads
 * as YOUR jet rather than as weather: a tight cone, thrown hard, arcing up and
 * then falling. */
const WATER_PART = .045;
function emitWater(c, f, dt) {
  f.wt = (f.wt || 0) - dt;
  if (f.wt > 0) return;
  f.wt = WATER_PART;
  const nx = Math.cos(c.h) * c.l * .5, ny = Math.sin(c.h) * c.l * .5;
  const ox = c.x + nx, oy = c.y + ny;
  const a = Math.atan2(f.y - oy, f.x - ox);
  for (let i = 0; i < 4; i++) {
    const th = a + rand(-.16, .16), s = rand(11, 20);
    const life = rand(.35, .7);
    parts.push({ x: ox, y: oy, z: rand(1.2, 2.2), vz: rand(2.5, 5.5),
      vx: Math.cos(th) * s, vy: Math.sin(th) * s,
      life, life0: life, soft: true,
      r: rand(.5, 1.1), col: pick(['#eaf6ff', '#ffffff', '#cfe8ff']) });
  }
  /* AND THE FOAM WHERE IT LANDS. Asked for by name. The jet is the half you aim;
     the foam is the half that tells you it is working — thick white, piling up on
     the building rather than flying at it, spreading and thinning where it sits.
     Slow, wide and long-lived, which is the opposite of the jet in all three, so
     the two read as cause and effect rather than as one spray. */
  const spread = Math.max(4, (f.r || 8) * .5);
  for (let i = 0; i < 2; i++) {
    const th = rand(0, TAU), rr = Math.sqrt(Math.random()) * spread;
    const life = rand(1.4, 2.6);
    parts.push({ x: f.x + Math.cos(th) * rr, y: f.y + Math.sin(th) * rr,
      z: rand(.4, 3.2), vz: rand(.2, 1.1),
      vx: rand(-.5, .5), vy: rand(-.5, .5),
      life, life0: life, soft: true,
      r: rand(1.6, 3.2), col: pick(['#ffffff', '#f2fbff', '#e6f4ff']) });
  }
}

/* ---- police: stop that car ----

   IT STARTS A LONG WAY OFF, and that is the whole difficulty of the shift. The
   first version marked a car out of the traffic already on the street, which
   sounded better than spawning one and played much worse: traffic only exists
   inside the cull radius, about two hundred and sixty metres, and the nearest
   car in that band is usually the one in front of you. The call came in and the
   target was already in your windscreen — reported as too easy, and it was.

   So the target is put on a road three hundred to nine hundred metres away and
   pushed into the traffic list, where it drives like any other car until you
   catch it. An existing car in that band is still preferred when there is one;
   in a dense city with the view zoomed out there sometimes is.

   IT ALSO HAS TO SURVIVE BEING FAR AWAY, which took two more changes. The cull
   deletes traffic past the edge of the screen, so the runaway is exempted from
   it and given a leash of its own instead — the same arrangement the police
   cars have always had, and for the same reason: a pursuit that evaporates when
   the target leaves the frame is not a pursuit. And vanishing used to PAY, since
   "gone from the traffic list" was read as "stopped"; past the leash it now
   counts as an escape and pays nothing. Between them those two made a distant
   target possible at all — a chase that ends in a reward the moment you fall
   three hundred metres behind is easier than one that starts next to you.

   It is given a higher top speed so it is a pursuit rather than a formality, and
   it counts as stopped when it has been beaten down, which covers both halves of
   what was asked: arrested if it survives being run off the road, destroyed if
   it does not. */
const CHASE_STOP = 34;
// a first shout is a car down the road; a later one starts across the district
const CHASE_MIN = 220, CHASE_MAX = 900;
// how far it can get from you before it has got away, and stops being simulated
const CHASE_LEASH = 1500;
function newPursuit() {
  let best = null, bd = Infinity;
  /* NOT missionReach, WHICH IS THE MISTAKE THIS COMMENT EXISTS TO STOP SOMEBODY
     REPEATING. Every other contract widens as more of the map streams in, and
     doing the same here put the target up to 2.9 km away — outside the leash,
     so the cull deleted it on the very next frame and the shift reported that it
     had got away before you had touched the accelerator. The two numbers are a
     pair: where it starts has to stay well inside how far it may get. */
  const band = jobBand('police', CHASE_MIN, CHASE_MAX);
  const far = band.hi;
  for (const t of traffic) {
    if (t.dead) continue;
    const d = dist(t.x, t.y, P.car.x, P.car.y);
    if (d < band.lo || d > far) continue;
    if (d < bd) { bd = d; best = t; }
  }
  /* Nothing out there yet, which is the usual case: put one there. The last
     fallback is a small map — a city whose roads do not reach three hundred
     metres has to be allowed to hand out police work too. */
  if (!best) best = spawnOneCar(band.lo, far) || spawnOneCar(120, far);
  if (!best) { MISSION.state = 'none'; scheduleMission(2500); return; }
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
/* WHERE AN AMBULANCE ACTUALLY STOPS.
 *
 * Reported from play, with the log to prove it: getting close to the hospital
 * was a crawl. It was — the drop was the hospital's own point, the centre of the
 * building, and arrival is within eight metres of it. On the hospital the report
 * came from, Специјална болница Свети Сава in Savski venac, the nearest road is
 * 26 m away, so the last stretch is across a forecourt at the off-road speed
 * limit. The log has the player 8 m from the centre, off the tarmac, at 11 km/h.
 *
 * The same gate the depots use: the nearest drivable point to the building. An
 * ambulance stops at the door and the patient goes in from there, which is both
 * what happens and the only thing a car can do. The hospital itself is the
 * fallback, for one with no road within reach at all. */
function hospitalDrop() {
  const h = nearestPOI('hospital', P.car.x, P.car.y);
  if (!h) return null;
  const g = depotGate(h);
  return g ? { x: g.x, y: g.y, name: h.name } : h;
}
function startDelivery() {
  /* WHERE IT IS GOING, ramped for whichever shift is asking. This is the leg
     that carries the clock and the money, so it is the one that decides whether
     a job feels like a hop or a haul. The ambulance is exempt: its drop is a
     hospital, and a hospital is where it is, not a distance. */
  const db = jobBand(JOB, 180, 700);
  const d = JOB === 'ambulance'
    ? hospitalDrop()
    : (roadPoint(P.car.x, P.car.y, db.lo, db.hi)
       || roadPoint(P.car.x, P.car.y, null));
  if (!d) { MISSION.state = 'none'; scheduleMission(2000); return; }
  /* THE PASSENGER GETS IN, which is why the street is one person emptier for the
     rest of the ride. Removed from the crowd rather than merely hidden: a
     pedestrian standing inside the car is one the collision code can hit. */
  if (MISSION.fare) {
    const i = peds.indexOf(MISSION.fare);
    if (i >= 0) peds.splice(i, 1);
    MISSION.rider = MISSION.fare;     // kept, so they can be let out again
    MISSION.fare = null;
    MISSION.riding = true;
  }
  MISSION.drop = d;
  MISSION.state = 'deliver';
  const dd = dist(P.car.x, P.car.y, d.x, d.y);
  /* THE CLOCK COMES OFF THE ROAD, NOT OFF THE RADAR. The drop an ambulance is
     handed is a hospital, and a hospital is where it is — the detour test in
     casualtySpot cannot move it to this bank of the river. So the return leg is
     the one that has to be measured honestly, and it is the leg with the clock
     on it: drive yourself across the water and get picked up over there and the
     way back is a bridge run whatever the radar says.
   *
     THE CEILING MOVES 150 -> 300 WITH IT. 150 was there because a crow-flight
     number should not be trusted to hand out large budgets — past about 1.7 km
     it was buying time for distance nobody was going to drive. A road distance
     can be trusted with them: 300 seconds is four kilometres at a city average,
     which is a long shift rather than an impossible one.
   *
     AND THE FARE IS NOT PAID ON IT. The two want opposite defaults when the map
     is half-loaded and the field has to detour around a tile that has not
     arrived: an over-long clock is generous, an over-long fare is a money
     printer parked next to whichever street loads last. So the time follows the
     road wherever it goes and the money stops at three times the straight line.
     The straight line is the floor for both — no drive is shorter than it — and
     it is what stands in when there is no mask to measure on at all. */
  const road = driveDist(P.car.x, P.car.y, d.x, d.y, Math.max(2500, dd * 5));
  const rd = road == null ? dd : Math.max(road, dd);
  MISSION.time = clamp(rd / 13 + 18, 22, 300);   // cross-district runs need the room
  const rate = JOB === 'taxi' ? 2.1 : JOB === 'ambulance' ? 2.4 : 1.6;
  MISSION.reward = Math.round(120 + Math.min(rd, dd * 3) * rate + MISSION.done * 45);
  SFX.pickup();
  toast(txt(BOARD_TOAST[JOB] || 'toast.secured', { n: MISSION.reward }), 1800);
  const where = d.road && d.road.name;
  const key = JOB === 'ambulance' ? 'hud.toHospital'
            : JOB === 'taxi' ? (where ? 'hud.driveTo' : 'hud.driveFare')
            : (where ? 'hud.deliverTo' : 'hud.deliverPkg');
  setObjective(key, { street: where || (d.name || '') });
}
function completeDelivery() {
  P.cash += MISSION.reward; P.score += MISSION.reward;
  MISSION.done++;
  JOB_DONE[JOB] = (JOB_DONE[JOB] || 0) + 1;    // this shift's next job reaches further
  releaseRider(MISSION.drop || P.car);
  store.set('vm_cash', P.cash);
  SFX.cash();
  toast(txt(DONE_TOAST[JOB] || 'toast.delivered', { n: MISSION.reward }), 2000);
  MISSION.state = 'none';
  scheduleMission(900);
}
/* Putting out a fire and stopping a runaway both end the same way: paid, and the
   next call comes in. */
function completeJob(key) {
  P.cash += MISSION.reward; P.score += MISSION.reward;
  MISSION.done++;
  JOB_DONE[JOB] = (JOB_DONE[JOB] || 0) + 1;    // fire and police count the same way
  store.set('vm_cash', P.cash);
  SFX.cash();
  toast(txt(key, { n: MISSION.reward }), 2000);
  MISSION.fire = null; MISSION.chase = null;
  MISSION.state = 'none';
  setObjective('hud.freeRoam');
  scheduleMission(1200);
}
/* AND IT CAN GET AWAY. The counterpart to completeJob for the one shift whose
   target can leave: past the leash the car is gone, the shift pays nothing, and
   the next call comes in. */
function failPursuit() {
  MISSION.chase = null;
  MISSION.state = 'none';
  toast(txt('toast.gotAway'), 1800);
  setObjective('hud.freeRoam');
  scheduleMission(1600);
}

/* EVERY LINE A SHIFT SAYS IS ITS OWN. Three of these tables rather than a
   ternary apiece, because a ternary is where the courier's words leak into
   somebody else's job: "PASSENGER ABOARD" was shown to an ambulance driver who
   had just loaded a casualty, and "PACKAGE LOST" to one who had run out of time,
   both for the same reason — one line written for the first shift and inherited
   by every shift after it. A missing entry falls back to the courier's, which is
   the shift every other one is a variation on.

   The word for who is in the car is one word per language, and it is the same
   word from the pickup line to the drop-off toast: the English is "patient"
   throughout, and each translation keeps whichever of casualty, injured person
   or patient reads naturally in that language. */
const BOARD_TOAST = { taxi: 'toast.aboard', ambulance: 'toast.patientAboard' };
const DONE_TOAST = { taxi: 'toast.droppedOff', ambulance: 'toast.patientIn' };

/* WHAT WAS LOST DEPENDS ON WHAT YOU WERE CARRYING. "PACKAGE LOST" is the courier
   run and nothing else — an ambulance that runs out of time has not mislaid a
   parcel. The fallback is the courier line, because that is the shift every
   other one falls back to. */
const FAIL_TOAST = { taxi: 'toast.fareGone', ambulance: 'toast.patientLost' };
function failDelivery() {
  MISSION.state = 'none';
  releaseRider(P.car);        // they have had enough of this taxi, and get out here
  toast(txt(FAIL_TOAST[JOB] || 'toast.tooSlow'), 1800);
  setObjective('hud.freeRoam');
  scheduleMission(1600);
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
  /* NOT WHILE YOU ARE ONE OF THEM.
   *
   * Asked for: on a police shift, other police should not come after you. They
   * were — the shift is a licence to ram a car off the road, and doing exactly
   * what the objective asks used to hand you a wanted level, a pursuit and
   * eventually an arrest by your own colleagues. Ramming the TARGET was already
   * excused at the collision, but every other source still counted, and there
   * are five of them.
   *
   * One door rather than five, for the same reason hurtPlayer is one door: every
   * way of earning a star in this game comes through here, so this is the only
   * place the rule cannot be forgotten in. Any heat already up goes with it —
   * finishing a pursuit that started before you clocked on. */
  if (JOB === 'police') { if (P.wanted > 0 || cops.length) clearHeat(); return; }
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
  /* THE RESPRAY IS A COURIER THING. A city vehicle comes out of the body shop
     the colour it went in — an ambulance repainted hot pink, still wearing its
     red cross, is not a joke that survives being seen twice. */
  if (JOB === 'courier') {
    const others = PAL.carBody.filter(c => c !== P.car.color);
    P.car.color = pick(others.length ? others : PAL.carBody);
  }
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
  if (MISSION.state === 'deliver') {
    MISSION.state = 'none';
    releaseRider(P.car);      // out at the wreck, rather than carried off to the cells
    scheduleMission(2600);
  }
}
function doRespawn() {
  const sp = P.recover || P.spawn;
  P.car.x = sp.x; P.car.y = sp.y; P.car.h = sp.h;
  P.car.vx = P.car.vy = 0; P.car.hp = 100;
  P.calm = 0;
  clearHeat();
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
  // and the casino's two, which is the same test against the same list
  syncTurfUI();

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
      /* HEFT: how much heavier than an ordinary car the thing you are driving
         is. One in the car you start in, nearly three in the appliance.
         Everything about the collision that is not the impulse itself scales
         with it — the impulse already does, in carsCollide, but only up to a
         point: `j = rel * 1.56 / (1/ma + 1/mb)` saturates as ma grows, so mass
         alone buys a heavy vehicle about a fifth more shove and no more. What
         actually reads as fourteen tonnes is the damage and the push. */
      const heft = (c.mass || 3) / 3;
      // and the ratio cuts both ways, which is what mass means: the appliance
      // takes a fraction of what the hatchback does
      hurtPlayer(clamp(rel * .7 / heft, 0, TRAFFIC_MAX), 'traffic');
      cam.shake = Math.min(1, cam.shake + .35);
      SFX.crash(rel);
      for (let i = 0; i < 5; i++) parts.push(sparks((c.x + t.x) / 2, (c.y + t.y) / 2));
      /* ONLY A REAL SMASH BRINGS THE POLICE. Reported from play: the wanted
         level went up for scraping past anything. The bar was 13 m/s of closing
         speed, which rear-ending a slower car at speed clears; 18 is a wreck
         rather than a scrape, and the damage threshold above is untouched — a
         bump still costs you paint, it just no longer costs you a star.

         Ramming the car you were sent to stop used to be excused here by name.
         It no longer needs to be: addWanted refuses outright on a police shift,
         which covers the runaway and the other four ways of earning a star with
         one rule instead of one exception. */
      if (rel > WANTED_HIT) addWanted(.34);
      damageCar(t, rel * heft);
      t.vx += (t.x - c.x) * .5 * heft; t.vy += (t.y - c.y) * .5 * heft;
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
      damageCar(k, rel); SFX.crash(rel);
      // a lower bar than a civilian: leaning on a patrol car is provocative in a
      // way that clipping a hatchback is not, but a touch is still a touch
      if (rel > WANTED_HIT_COP) addWanted(.22);
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
      scheduleMission(1200);
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
    /* CLEAR OF THE BUILDING, not sixteen metres from the middle of it. The
       radius of the footprint is added on, so the reach is sixteen metres of
       street outside whatever is burning rather than sixteen metres from a point
       you cannot legally stand on. */
    const near = dist(c.x, c.y, f.x, f.y) < FIRE_REACH + (f.r || 0);
    if (near) emitWater(c, f, dt);
    f.hp += near ? -FIRE_RATE * dt : FIRE_REGROW * dt;
    if (f.hp > 100) f.hp = 100;
    if (f.hp <= 0) completeJob('toast.fireOut');
  } else if (MISSION.state === 'chase' && MISSION.chase) {
    const t = MISSION.chase;
    // wrecked counts as stopped; merely gone does not, and used to pay for it
    if (t.dead) completeJob('toast.stopped');
    else if (traffic.indexOf(t) < 0) failPursuit();
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


  // the lightbar on a police shift runs off the same clock the patrol cars use
  c.blink += dt;

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
  /* THE RUNAWAY KEEPS ITS OWN LEASH, the way the police cars do. It is put on
     the map hundreds of metres away, which is well outside the radius the rest
     of the traffic lives in, so culling it to the screen would delete the target
     on the frame after it was handed out. */
  const chR = MISSION.state === 'chase' ? CHASE_LEASH : 0;
  traffic = traffic.filter(t => !t.dead &&
    dist2(t.x, t.y, c.x, c.y) < (t === MISSION.chase ? chR * chR : tR * tR));
  /* THE ONE YOU HAVE BEEN SENT TO IS NOT CULLED, the same exemption the runaway
     above gets. The crowd lives within 500 m of the car; a patient is now
     dispatched to an address up to 1.1 km away, and the block just above ends
     the job the moment its person leaves this list — so without this the call
     would be handed out and silently withdrawn on the same frame. It also fixes
     a fault that was always latent for the taxi: a fare a little under 500 m
     off, and two seconds of driving the wrong way deleted the passenger and the
     job with them. */
  peds = peds.filter(p => !p.dead &&
    (p === MISSION.fare || dist(p.x, p.y, c.x, c.y) < 500));
  /* Refilling the world is a search over the road index, so it is rate-limited
     rather than run every frame. Traffic tops out at 17 m/s and you now do 100:
     outrun it and both lists empty continuously, and topping them up one per
     frame became sixty road searches a second, plus sixty more for the
     pedestrians, for as long as you kept your foot down. That, not the drawing,
     was what halved the frame rate at speed. */
  P.popT = (P.popT || 0) - dt;
  if (P.popT <= 0) {
    P.popT = .25;
    /* THE RUNAWAY IS NOT ONE OF THE CAP'S CARS, and this is the second place
       that had to learn it. The police shift puts it on the map and pushes it
       onto the END of the list, which is exactly where a truncation bites: being
       one car over the cap deleted the target a quarter of a second after the
       shift handed it out, and the pursuit announced that it had got away before
       you had moved. Counted separately, and lifted out of the way of the trim
       when the list has to be cut — switching back from daylight cuts two
       hundred cars at once and would take the target with them. */
    const chase = MISSION.state === 'chase' ? MISSION.chase : null;
    const cap = trafficCap() + (chase ? 1 : 0);
    const need = cap - traffic.length;
    /* Five a tick while topping up, as before — spawning is a road search and
       raising the steady rate to ten cost four frames a second at dusk, where
       cars are being culled and replaced constantly as you drive. A big burst is
       only for the standing start and the switch into daylight, where the deficit
       is two hundred and filling it five at a time would take ten seconds. */
    if (need > 0) spawnTraffic(Math.min(need > 40 ? 25 : 5, need));
    else if (need < 0) {                                   // switched back to dusk
      traffic.length = cap;
      if (chase && traffic.indexOf(chase) < 0) { traffic.length = cap - 1; traffic.push(chase); }
    }
    if (peds.length < 34) spawnPeds(Math.min(6, 34 - peds.length));
  }

  // --- effects bookkeeping
  for (const m of marks) m.life -= dt;
  marks = marks.filter(m => m.life > 0);
  for (const p of parts) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .94; p.vy *= .94; p.life -= dt;
    // only smoke, flame and water carry a height; everything else has no z at
    // all and pays nothing for this
    if (p.vz) { p.z = (p.z || 0) + p.vz * dt; p.vz *= .93; }
  }
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
  updateTurf();          // the other side comes round; see js/turf.js
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
  // nowhere to aim: coast — and still not through a wall while doing it
  if (dx * dx + dy * dy < 1) { drive(t, 0, 1, 0, 0, dt); fence(t); wallStop(t); return; }
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
  wallStop(t);
}
/* WALLS ARE SOLID FOR THE TRAFFIC TOO.
 *
 * Reported from play, on the police shift: the car you are chasing drives into
 * a building and you cannot follow it. It was not the pursuit — buildingCollide
 * was called for exactly two things, the player and the cruisers, and ordinary
 * traffic has been driving through walls since there were walls. The runaway is
 * an ordinary traffic car, so it went through them like all the rest; you just
 * had a reason to be looking at one of them for once.
 *
 * "Unless the building has a road under it" is already the rule buildingCollide
 * enforces, and it is not an approximation of one: markRoadTunnels walks every
 * centreline in six-metre steps and flags every footprint it passes through, so
 * arches, gatehouses and blocks mapped over a street are exempt by
 * construction. That matters more for the traffic than it does for the player —
 * traffic FOLLOWS those centrelines, so without the exemption the cars that use
 * such a street would be shoved out of a building they are meant to drive
 * through, every frame, for as long as they were in it.
 *
 * NO DAMAGE, deliberately, where a cruiser takes it. The police were asked to
 * hit things and take the consequences; this was asked as a geometry question,
 * and the two are not the same request. Wall damage on 255 cars is also the
 * quickest way back to the demolition derby that traffic.mjs exists to catch. */
function wallStop(t) {
  buildingCollide(t);
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
  /* A WALL COSTS THEM SOMETHING NOW. buildingCollide was already called here, so
     a cruiser has always been pushed back out of a building — but its return
     value, the closing speed into the wall, was thrown away, so the wall was a
     bumper. Through damageCar, which is the one door every other kind of damage
     an AI car takes goes through, and which brings its own cooldown with it. */
  const wall = buildingCollide(k);
  if (wall > BLD_MIN) damageCar(k, wall);
  for (const o of cops) if (o !== k) {
    const rel = carsCollide(k, o);
    if (rel > 5.5) { damageCar(k, rel); damageCar(o, rel); }
  }
  /* AND THE TRAFFIC, WHICH NOTHING IN THE GAME EVER TESTED THEM AGAINST.
   *
   * Reported from play: police cars never hit other cars. They never could —
   * there are four car-on-car tests in this game and not one of them had a cop
   * on one side and a civilian on the other. trafficCollisions runs off the
   * bucket grid, which trafficGrid fills from the `traffic` array alone; the
   * player is tested against traffic and against cops separately; and the loop
   * above is cop against cop. A cruiser drove through a bus.
   *
   * Off the same grid the traffic uses, at the same threshold two AI cars need,
   * because that is what this is: nose to tail at walking pace is not a crash,
   * and a patrol car shouldering a civilian aside at speed is. The grid is a
   * frame stale by the time the police are updated — the traffic has moved since
   * it was built — which is the arrangement trafficCollisions already lives
   * with: cells are 26 m and nothing covers a metre in a frame. */
  for (const o of nearTraffic(k.x, k.y)) {
    if (o.dead) continue;
    const rel = carsCollide(k, o);
    if (rel > AI_HIT) {
      damageCar(k, rel); damageCar(o, rel);
      SFX.crash(rel * .6 * earshot(k.x, k.y));
    }
  }
  k.blink += dt;
}
