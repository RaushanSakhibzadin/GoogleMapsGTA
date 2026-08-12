/* THE GAME ON REAL MAP DATA.

   Every other test in this project serves a fixture written by hand, which is a
   guess about the shape of OpenStreetMap dressed up as a test. These payloads
   are the real thing: captured by the in-game LOG button from a session in
   Stari grad, the old town of Belgrade, and replayed byte for byte —

     streets     1.1 MB   1,161 ways, incl. real highway=pedestrian squares
     buildings   3.6 MB   3,782 footprints and parks
     arterials  11.8 MB  10,863 ways over the full 72 km skeleton box

   See tests/fixtures/stari-grad/README.md. The stored SHA-256 of each body is
   checked before the run, so "byte for byte" is a claim this test verifies
   rather than a claim it makes.

   The same session also caught the fault this test guards: one mirror answering
   200 with an empty element list in a quarter of a second, for the streets
   query, for the 36 km landmark sweep, and for three of the four scenery tiles.

   Usage:
     node tests/real.mjs               the clean replay
     node tests/real.mjs emptyMirror   with that host in the race
     GAME=/path/to/index.html          point it at a different build
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'stari-grad');
const SHOTS = process.env.SHOTS || '/tmp';
const EMPTY_MIRROR = process.argv[2] === 'emptyMirror';

const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const body = file => file.endsWith('.gz')
  ? gunzipSync(readFileSync(join(FIX, file))).toString('utf8')
  : readFileSync(join(FIX, file), 'utf8');

/* The bodies are gzipped in the repo. Decompress them and prove they are the
   ones the server sent before anything else happens — a fixture that has
   drifted from the recording is worse than no fixture, because it still passes
   and still looks like evidence. */
const reply = {};
for (const r of session.replies) {
  const raw = body(r.file);
  const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (sha !== r.sha256) {
    console.error(`fixture ${r.file} does not match the captured body`);
    console.error(`  recorded ${r.sha256}\n  found    ${sha}`);
    process.exit(2);
  }
  if (r.elements) reply[r.kind] = { body: raw, bbox: r.bbox };
}
const EMPTY = body('empty.json');          // verbatim, blank lines and all
const bStreets = reply.streets.bbox;
const LAT0 = (bStreets.s + bStreets.n) / 2, LON0 = (bStreets.w + bStreets.e) / 2;

const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const boxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};
// which captured tile, if any, this request is asking for
const near = (b, t) => b && Math.abs((b.s + b.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                             Math.abs((b.w + b.e) / 2 - (t.w + t.e) / 2) < 4e-3;

/* Playwright's own browser if it has one, otherwise whatever the environment
   put in PLAYWRIGHT_BROWSERS_PATH — this repo is normally driven from a sandbox
   where the download is disabled and the binary is already on disk. */
const chromeExe = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome']) {
      const f = join(root, d, rel);
      if (existsSync(f)) return f;
    }
  }
  return null;
};
const exe = chromeExe();
const b = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

/* The real landmark sweep came back empty, so there is nothing captured to
   replay for it — that IS the bug. These stand in for what a working mirror
   would have sent, placed at real distances so the radar rim pointer and the
   nearest-repair-shop search have something to be right or wrong about. */
const LANDMARKS = JSON.stringify({ version: 0.6, generator: 'Overpass API', elements: [
  { type: 'node', id: 90000001, lat: LAT0 + 0.0180, lon: LON0 + 0.0090,
    tags: { shop: 'car_repair', name: 'Auto servis Dunav' } },
  { type: 'node', id: 90000002, lat: LAT0 - 0.0320, lon: LON0 - 0.0210,
    tags: { shop: 'car_repair', name: 'Auto servis Sava' } },
  { type: 'node', id: 90000003, lat: LAT0 + 0.0060, lon: LON0 - 0.0040,
    tags: { amenity: 'hospital', name: 'Urgentni centar' } },
  { type: 'node', id: 90000004, lat: LAT0 - 0.0075, lon: LON0 + 0.0055,
    tags: { amenity: 'police', name: 'Policijska stanica' } },
  { type: 'node', id: 90000005, lat: LAT0 + 0.0025, lon: LON0 + 0.0130,
    tags: { amenity: 'fuel', name: 'Benzinska' } },
] });

const served = [];
const emptied = new Set();      // kinds that have already had their one empty reply
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Stari grad, Beograd' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const host = new URL(r.request().url()).hostname;
  const box = boxOf(q);
  const kind = isArterials(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  /* ONE EMPTY REPLY PER KIND, from whichever host is asked first.

     Not a reproduction of the session — a test of the rule, deliberately. The
     session's version depended on the broken host being PROMOTED by the health
     ordering, which in turn depended on the other five being slow enough to
     collect misses, and a test that has to reproduce a six-way race to find a
     bug will pass by luck as often as it catches anything. What has to hold is
     simpler and stronger: an empty reply is never the answer, whoever gives it
     and whatever was asked for.

     So each of the four kinds gets exactly one empty reply, instantly, and the
     next host asked has the real data. Accepting the empty loses the streets,
     the skeleton, the scenery or every landmark in a 36 km radius — that last
     one being what was actually reported, as not being able to find a repair
     shop anywhere. One is also the number that matters: the rule is that a
     single mirror's silence is never believed, while all of them agreeing is,
     and the eight ring tiles nobody captured exercise the second half of that
     on every run — every host answers those with nothing, and they have to
     settle as empty ground rather than as failures. */
  if (EMPTY_MIRROR && !emptied.has(kind)) {
    emptied.add(kind);
    served.push({ host, kind, body: 'EMPTY' });
    return r.fulfill({ contentType: 'application/json', body: EMPTY });
  }
  let payload = EMPTY;
  if (kind === 'arterials') payload = reply.arterials.body;
  else if (kind === 'streets' && near(box, bStreets)) payload = reply.streets.body;
  else if (kind === 'buildings' && near(box, reply.buildings.bbox)) payload = reply.buildings.body;
  else if (kind === 'pois') payload = LANDMARKS;
  served.push({ host, kind, body: payload === EMPTY ? 'EMPTY' : 'real' });
  return r.fulfill({ contentType: 'application/json', body: payload });
});

await p.goto('file://' + (process.env.GAME || '/home/user/GoogleMapsGTA/index.html'));
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(1200);

const out = { mode: EMPTY_MIRROR ? 'with the empty mirror' : 'clean' };
out.world = await p.evaluate(() => {
  const c = window.__chunks(), w = window.__w();
  return { roads: w.roads, drive: w.drive, buildings: w.buildings, parks: w.parks, grid: w.grid,
           skel: c.skel, sceneryOnly: c.sceneryOnly, tilesLoaded: c.loaded, tilesFailed: c.failed,
           live: c.live, pois: c.pois };
});

/* Does the drivable mask agree with the roads that were actually drawn? This is
   the check that mattered for the crawl, run on real data — real geometry, real
   classes, real junctions, and Belgrade's pedestrian zones in the middle of it. */
out.mask = await p.evaluate(() => {
  const bad = {}, ok = {};
  const holes = [];
  for (const r of window.__roadList()) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b2 = r.pts[i + 1];
      if (Math.abs(a.x) > 900 || Math.abs(a.y) > 900) continue;      // the detailed centre
      const len = Math.hypot(b2.x - a.x, b2.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 10));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b2.x - a.x) * t, y = a.y + (b2.y - a.y) * t;
        const key = r.cls + (r.drive ? '' : ' (not drivable)');
        // what the PENALTY thinks, which is the thing the player feels
        if (window.__onRoadPenalty(x, y)) {
          bad[key] = (bad[key] || 0) + 1;
          if (holes.length < 6) holes.push({ cls: r.cls, name: r.name, x: Math.round(x), y: Math.round(y) });
        } else ok[key] = (ok[key] || 0) + 1;
      }
    }
  }
  return { ok, bad, holes };
});
// not one point on a drawn road may read as off-road to the penalty
out.noFalseCrawl = Object.keys(out.mask.bad).length === 0;

/* Drive real streets. Pick the longest drivable way near the start and follow
   its first straight, which is a real Belgrade road with real geometry. */
out.drive = await p.evaluate(async () => {
  for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
  const roads = window.__roadList().filter(r => r.drive);
  let best = null, bestLen = 0;
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (Math.hypot(a.x, a.y) > 700) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > bestLen) { bestLen = L; best = { a, b, name: r.name, cls: r.cls }; }
  }
  if (!best) return { error: 'no road found' };
  const h = Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x);
  window.__tp(best.a.x, best.a.y, h);
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let frames = 0, off = 0, top = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p();
      frames++; if (!q.onRoad) off++;
      top = Math.max(top, q.spd);
      performance.now() - t0 < 4000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  return { on: best.name || best.cls, cls: best.cls, segLen: Math.round(bestLen),
           topKmh: Math.round(top * 3.6), offPct: +(off / frames * 100).toFixed(1) };
});

/* Belgrade's pedestrian squares, the thing that caused the original report.
   Find a real one and prove the car is not crawling on it. */
out.pedestrian = await p.evaluate(async () => {
  const peds = window.__roadList().filter(r => r.cls === 'pedestrian' && !r.drive);
  if (!peds.length) return { found: 0 };
  let best = null, bestLen = 0;
  for (const r of peds) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > bestLen) { bestLen = L; best = { a, b, name: r.name }; }
  }
  const mid = { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
  return { found: peds.length, name: best.name, at: { x: Math.round(mid.x), y: Math.round(mid.y) },
           onRoad: window.__onRoad(mid.x, mid.y),        // not a road: correct
           penalty: window.__onRoadPenalty(mid.x, mid.y) // and must NOT crawl there
  };
});

/* The repair shop the real session could not find. The landmark sweep has to
   have survived the load for this to be answerable at all. */
out.repair = await p.evaluate(() => window.__nearestPOI('repair'));
out.foundRepair = !!out.repair;
out.mirrors = await p.evaluate(() => window.__mirrors());
/* The capture is a 72 km box, and the game now asks for 200. The mock answers
   the first rung whatever it asks for, so what this can check is that the
   skeleton landed at the top of the ladder and bounded the world — the rung's
   size is the game's business, not the fixture's, so it is read rather than
   pinned. */
out.firstRung = await p.evaluate(() => window.__cfg().skeletonRadii[0]);

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 2000 ? requestAnimationFrame(tick) : r(Math.round(n / 2)); };
  requestAnimationFrame(tick);
}));
out.served = { total: served.length, empty: served.filter(s => s.body === 'EMPTY').length,
               real: served.filter(s => s.body === 'real').length,
               byKind: served.reduce((a, s) => {
                 const k = s.kind + ' · ' + s.body;
                 a[k] = (a[k] || 0) + 1; return a; }, {}) };

await p.screenshot({ path: `${SHOTS}/shot-real${EMPTY_MIRROR ? '-empty' : ''}.png` });
out.errs = errs.slice(0, 5);
/* Only the centre tile was captured, so one is all that CAN load — the other
   eight legitimately have no data to serve. What the empty-mirror run has to
   show is that a host answering 200-with-nothing does not steal it, and does
   not steal the landmarks either: in the real session it took both. */
out.pass = out.world.roads > 5000 && out.world.buildings > 3000 && out.world.parks > 100 &&
           out.world.pois >= 5 &&
           out.world.skel && out.world.skel.r === out.firstRung &&
           out.noFalseCrawl &&
           out.drive.topKmh > 200 && out.drive.offPct < 5 &&
           out.pedestrian.found > 0 && out.pedestrian.penalty === false &&
           out.world.tilesLoaded >= 1 && out.foundRepair &&
           out.fps >= 45 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
