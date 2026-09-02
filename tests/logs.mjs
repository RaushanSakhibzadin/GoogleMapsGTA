/* The Save Logs button.

   The point of the feature is that the file contains what the map servers
   actually said, so the central assertion is that a captured body comes back
   BYTE-IDENTICAL to what the mock server sent. Anything softer than that — "it
   has some elements", "it looks like streets" — would pass just as happily on a
   log that had been helpfully summarised into uselessness, which is the exact
   failure this is meant to prevent. */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8125, LON0 = 20.4612;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const URL_ = GAME;

let id = 1;
const way = (cls, name, pts) => ({ type: 'way', id: id++,
  tags: { highway: cls, name }, geometry: pts.map(([x, y]) => toLL(x, y)) });

/* Bodies are built ONCE and served as fixed strings, so the test can compare the
   captured text against the exact bytes that went out. */
const streetsBody = JSON.stringify({ elements: [
  ...[-2, -1, 0, 1, 2].map(k => way(k ? 'residential' : 'secondary', `EW ${k}`, [[-900, k * 200], [900, k * 200]])),
  ...[-2, -1, 0, 1, 2].map(k => way('residential', `NS ${k}`, [[k * 200, -900], [k * 200, 900]])),
  way('pedestrian', 'Trg Republike', [[-200, 90], [200, 90]]),
  { type: 'node', id: 9001, lat: LAT0, lon: LON0, tags: { place: 'city', name: 'Beograd' } }
] });
const arterialsBody = JSON.stringify({ elements: [
  ...[-3, 0, 3].map(k => way('primary', `Radial ${k}`, [[-36100, k * 1800], [36100, k * 1800]])),
  { type: 'node', id: 9100, lat: LAT0, lon: LON0, tags: { place: 'city', name: 'Beograd' } }
] });
const buildingsBody = JSON.stringify({ elements: [
  { type: 'way', id: 9200, tags: { building: 'yes', 'building:levels': '6' },
    geometry: [[40, 40], [120, 40], [120, 110], [40, 110], [40, 40]].map(([x, y]) => toLL(x, y)) }
] });
const poisBody = JSON.stringify({ elements: [
  { type: 'node', id: 9300, lat: LAT0 + 0.002, lon: LON0, tags: { amenity: 'police', name: 'Precinct' } }
] });
const geoBody = JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd, Srbija' }]);

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));

let failNextTile = false;
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill({ contentType: 'application/json', body: geoBody }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill({ contentType: 'application/json', body: arterialsBody });
  if (/"building"/.test(q)) {
    /* The refused tile has to be a BUILDINGS request. Once a skeleton has landed
       the road network is complete and tiles carry scenery only — so during play
       no streets query is ever sent, and hanging the 504 on that one meant the
       failure never happened and the test proved nothing. */
    if (failNextTile) { failNextTile = false; return r.fulfill({ status: 504, body: 'Gateway Timeout' }); }
    return r.fulfill({ contentType: 'application/json', body: buildingsBody });
  }
  if (/amenity/.test(q) && !/highway/.test(q))
    return r.fulfill({ contentType: 'application/json', body: poisBody });
  return r.fulfill({ contentType: 'application/json', body: streetsBody });
});

// capture whatever the page hands to the share sheet, and whatever it downloads
await p.addInitScript(() => {
  window.__shared = null;
  navigator.canShare = () => true;
  navigator.share = async o => {
    const f = o.files[0];
    window.__shared = { name: f.name, type: f.type, text: await f.text() };
    return true;
  };
});

// type the city rather than using a preset, so the geocoder is exercised too
await p.goto(URL_);
await p.waitForTimeout(250);
const out = {};
/* REACHABLE HERE, ON THE MENU, because the log worth having most is from a load
   that failed back to this screen. That requirement has not changed; where the
   button lives has. It used to sit along the top of every screen and this asked
   whether it was drawn there; it is a row in the settings panel now, so this
   asks the question that actually matters — can somebody standing on the menu
   get to it — by opening the panel the way a player would and then checking.

   offsetParent is null for ANY position:fixed element, so it reports "hidden"
   for the gear whether it is on screen or not. Computed style plus a real
   rectangle is the truth. */
const onScreen = (page, id) => page.evaluate(i => {
  const el = document.getElementById(i);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).display !== 'none' && r.width > 20 && r.height > 10 &&
         r.right <= innerWidth + 1 && r.left >= -1 && r.top >= 0 && r.bottom <= innerHeight + 1;
}, id);
out.gearOnMenu = await onScreen(p, 'mixBtn');
await p.click('#mixBtn');
await p.waitForTimeout(250);
out.logInSettings = await onScreen(p, 'logBtn');
await p.click('#mixDone');
await p.waitForTimeout(150);
out.buttonOnMenu = out.gearOnMenu && out.logInSettings;
await p.fill('#q', 'Beograd');
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(700);

/* A tile has to actually be REQUESTED for one to be refused. Six seconds of
   driving only covers 600 m, well inside the opening ring, so the first version
   of this set the flag and nothing ever went out — and "no failure was logged"
   passed as "failures are logged". Teleporting past the ring forces the
   streamer to ask for a new tile, which is the request that gets the 504. */
failNextTile = true;
await p.evaluate(() => window.__tp(2600, 0, 0));
await p.waitForTimeout(3500);
await p.evaluate(() => new Promise(res => {
  setTimeout(() => { window.dispatchEvent(new ErrorEvent('error', {
    message: 'kaboom from the test', filename: 'test.js', lineno: 42, error: new Error('kaboom from the test') })); }, 200);
  setTimeout(() => { Promise.reject(new Error('a rejected promise')); }, 400);
  const t0 = performance.now();
  const tick = () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    performance.now() - t0 < 6000 ? requestAnimationFrame(tick) : (window.__setInput(null), res());
  };
  requestAnimationFrame(tick);
}));

out.stats = await p.evaluate(() => window.__logStats());
out.saved = await p.evaluate(() => window.__saveLog());
await p.waitForTimeout(300);
const shared = await p.evaluate(() => window.__shared);
out.share = { used: !!shared, name: shared && shared.name, type: shared && shared.type };

/* ---- the file itself ---- */
let file = null, parseErr = null;
try { file = JSON.parse(shared.text); } catch (e) { parseErr = String(e); }
out.parses = !!file && !parseErr;

if (file) {
  out.order = file.osm.map(o => o.kind);
  const first = file.osm[0];
  out.firstIsGeocode = first && first.kind === 'geocode';
  const find = k => file.osm.find(o => o.kind === k);
  const st = find('streets'), ar = find('arterials'), bl = find('buildings');
  // THE assertion: verbatim, to the byte
  out.streetsVerbatim = !!st && st.body === streetsBody;
  out.arterialsVerbatim = !!ar && ar.body === arterialsBody;
  out.buildingsVerbatim = !!bl && bl.body === buildingsBody;
  out.geocodeVerbatim = first && first.body === geoBody;
  out.streetsMeta = st && { host: st.host, status: st.status, hasQuery: /way\["highway"/.test(st.query || ''),
                            hasBbox: !!(st.bbox && st.bbox.s < st.bbox.n), ms: typeof st.ms === 'number',
                            at: typeof st.at === 'number' };
  out.kinds = [...new Set(file.osm.map(o => o.kind))].sort();

  const msgs = file.errors.map(e => e.level + ': ' + e.msg);
  out.errorSample = msgs.slice(0, 8);
  out.caughtThrow = msgs.some(m => /kaboom from the test/.test(m));
  out.caughtRejection = msgs.some(m => /a rejected promise/.test(m));
  // the refused tile, however it surfaced: a mirror note from geo.js, or the
  // chunk giving up entirely through console.warn
  out.caughtTileFailure = msgs.some(m => /504|chunk .*failed/.test(m));
  out.mirrorNotes = msgs.filter(m => /^mirror:/.test(m)).slice(0, 3);
  out.errorsTimestamped = file.errors.every(e => typeof e.at === 'number');

  /* THE BUILD, AT THE TOP. Asked for by name after a report arrived that could
     not be matched to a version: every script is addressed by this hash, so it
     names the running program exactly, and a phone serving a stale cache says so
     here instead of being argued about. */
  out.build = file.build;
  out.hasBuild = typeof file.build === 'string' && /^[0-9a-f]{6,}$/.test(file.build);
  /* AND WHETHER THE CHASE VIEW COULD RUN. "3D is not available" was reported
     twice with a log that said nothing whatsoever about WebGL — no record of an
     attempt, no reason, not even whether the machine has it. */
  out.gl = file.snapshot && file.snapshot.gl;
  out.hasGl = !!out.gl && typeof out.gl.ready === 'boolean' &&
              typeof out.gl.attempts === 'number' && 'fail' in out.gl &&
              (out.gl.ready || typeof out.gl.probe === 'string');
  out.snapshot = file.snapshot && {
    city: file.snapshot.city, hasCar: !!file.snapshot.car,
    carOnRoad: file.snapshot.car && file.snapshot.car.onRoad,
    roads: file.snapshot.world && file.snapshot.world.roads,
    grid: file.snapshot.world && file.snapshot.world.grid,
    hasUA: !!file.snapshot.ua, state: file.snapshot.state
  };
  out.capture = file.capture;
}

/* ---- the cap ---- */
out.cap = await p.evaluate(() => {
  const before = window.__logStats();
  const chunk = 'x'.repeat(1024 * 1024);          // 1 MB at a time
  for (let i = 0; i < 40; i++) window.__log && LOG.osm({ kind: 'buildings', host: 'test', body: chunk });
  const after = window.__logStats();
  return { beforeBytes: before.bytes, afterBytes: after.bytes, dropped: after.dropped,
           underCap: after.bytes <= 25 * 1024 * 1024 };
});

/* ---- the download fallback, with no share sheet available ---- */
const p2 = await ctx.newPage();
await p2.addInitScript(() => { delete navigator.share; delete navigator.canShare; });
await p2.goto(URL_);
await p2.waitForTimeout(250);
const dl = p2.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await p2.click('#mixBtn'); await p2.waitForTimeout(200);
await p2.click('#logBtn');
const d = await dl;
out.downloadFallback = { fired: !!d, name: d && d.suggestedFilename() };
await p2.close();

/* ---- a refused chase view explains itself ---- */
/* THE CASE THAT ARRIVED UNDIAGNOSABLE. "3D is not available" came in twice with
   a log that recorded mirror timings, the car's position and not one word about
   WebGL. Here the context is refused outright — getContext('webgl2') hands back
   null, which is what a phone out of memory or out of contexts does — and the
   log has to come back saying so, both as an entry with a reason and in the
   snapshot's own account of the renderer. */
out.refused = await p.evaluate(() => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o2) {
    if (t === 'webgl2') {
      this.dispatchEvent(Object.assign(new Event('webglcontextcreationerror'),
                                       { statusMessage: 'out of memory (staged)' }));
      return null;
    }
    return real.call(this, t, o2);
  };
  GL.gl = null; GL.fail = ''; GL.why = ''; GL.attempts = 0;
  const went = window.__setMode3d(true);
  HTMLCanvasElement.prototype.getContext = real;
  const f = LOG.build();
  const soft = SOFT3D;
  window.__setMode3d(false);
  return { went, soft, fail: GL.fail, attempts: f.snapshot.gl.attempts,
           note: (f.errors || []).filter(e => e.level === 'gl').map(e => e.msg) };
});
/* The reason the browser gave has to survive all the way into the file — "3D
   NEEDS WEBGL2" on a phone that ran the chase view yesterday is not a report.

   AND THE VIEW STILL OPENS. This used to require the switch to come back false,
   which was right when a refused context meant no chase view at all; it now
   falls back to the software renderer, so the switch succeeds and SOFT3D is how
   you tell which one you got. The log still has to explain what happened —
   quietly drawing it the slow way with no record would be its own bug. */
out.refusalExplained = out.refused.went === true && out.refused.soft === true &&
                       out.refused.attempts >= 1 &&
                       /out of memory \(staged\)/.test(out.refused.fail) &&
                       out.refused.note.some(m => /out of memory \(staged\)/.test(m));

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

await p.screenshot({ path: `${OUT}/shot-logs.png` });
// the rejection this test throws on purpose surfaces as a pageerror; that is the
// feature working, not a fault, so it does not count against the run
out.errs = errs.filter(e => !/a rejected promise|kaboom from the test/.test(e)).slice(0, 4);
out.pass = out.buttonOnMenu && out.parses && out.firstIsGeocode &&
  out.streetsVerbatim && out.arterialsVerbatim && out.buildingsVerbatim && out.geocodeVerbatim &&
  out.streetsMeta && out.streetsMeta.hasQuery && out.streetsMeta.hasBbox &&
  out.streetsMeta.ms && out.streetsMeta.at &&
  out.caughtThrow && out.caughtRejection && out.caughtTileFailure && out.errorsTimestamped &&
  out.snapshot && out.snapshot.city && out.snapshot.hasCar && out.snapshot.roads > 0 &&
  out.hasBuild && out.hasGl && out.refusalExplained &&
  out.share.used && /\.json$/.test(out.share.name || '') &&
  out.cap.underCap && out.cap.dropped > 0 &&
  out.downloadFallback.fired &&
  out.fps >= 50 && !out.errs.length;      // the FILTERED list; errs still holds the deliberate two
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
