/* THE OPENING RING HAS TO ARRIVE.

   The detailed city is nine tiles: the 1.8 km square you start in, and the eight
   around it, so you get 5.4 km of every lane and service road before you touch
   the wheel. Out past that the world is arterials only — fine to cross a country
   on, nothing to drive a neighbourhood in.

   A reported session came back with ONE tile. The ring is skipped when the area
   looks too heavy for eight more street requests, and the number that decision
   read was the wall clock across everything since DRIVE was pressed: the
   geocode, two mirrors that were unreachable or empty, and the ENTIRE arterial
   skeleton — eleven megabytes of motorway that costs the same in Belgrade as in
   a village and says nothing about how dense the streets here are. Streets that
   came back in 5.5 s were scored at twenty seconds and the ring was dropped.

   So the shape of that session is what this replays: a dud mirror, a slow good
   one, and a big skeleton behind them.

   Usage:
     node tests/ring.mjs           the reported session
     node tests/ring.mjs heavy     an area whose STREETS really are slow
     GAME=/path/to/index.html      point it at a different build
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'stari-grad');
const HEAVY = process.argv[2] === 'heavy';
const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const gz = f => gunzipSync(readFileSync(join(FIX, f))).toString('utf8');
const rep = {};
for (const r of session.replies) if (r.elements) rep[r.kind] = { body: gz(r.file), bbox: r.bbox };
const EMPTY = readFileSync(join(FIX, 'empty.json'), 'utf8');
const b0 = rep.streets.bbox;
const LAT0 = (b0.s + b0.n) / 2, LON0 = (b0.w + b0.e) / 2;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const projX = lon => (lon - LON0) * M_LON, projY = lat => -(lat - LAT0) * M_LAT;

/* The capture only holds the centre tile — it is the one the real session got.
   The eight neighbours get a grid city apiece, named after the tile, so the test
   can tell which of them actually arrived rather than just counting roads. */
function ringTile(s, w, n, e) {
  const x0 = projX(w), x1 = projX(e), y0 = projY(n), y1 = projY(s);
  const ti = Math.round((x0 + x1) / 2 / 1800), tj = Math.round((y0 + y1) / 2 / 1800);
  const tag = `T${ti}_${tj}`;
  const els = [];
  /* Collision-free per tile. Math.abs(ti*97+tj) folds (-1,0) onto (1,0) and
     (0,-1) onto (0,1), and the world dedupes on id — half the ring would arrive
     and be silently dropped, and the test would blame the game for it. */
  let id = ((ti + 8) * 17 + (tj + 8)) * 100000 + 500000;
  for (let k = 0; k * 200 < x1 - x0; k++) {
    const x = x0 + k * 200;
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `${tag} Avenue ${k}` },
      geometry: [toLL(x, y0), toLL(x, y1)] });
  }
  for (let k = 0; k * 200 < y1 - y0; k++) {
    const y = y0 + k * 200;
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `${tag} Street ${k}` },
      geometry: [toLL(x0, y), toLL(x1, y)] });
  }
  return JSON.stringify({ version: 0.6, generator: 'x', elements: els });
}

const boxOf = q => { const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null; };
const near = (a, t) => a && Math.abs((a.s + a.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                            Math.abs((a.w + a.e) / 2 - (t.w + t.e) / 2) < 4e-3;
const chromeExe = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) for (const rel of ['chrome-linux/chrome', 'chrome']) {
    const f = join(root, d, rel);
    if (existsSync(f)) return f;
  }
  return null;
};
const exe = chromeExe();
const br = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await br.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
// the unreachable mirror is deliberate; its network error is not a fault
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) errs.push('console: ' + m.text());
});

/* The session, timed as it happened: the centre streets took 5.5 s on the wire
   after two mirrors had already wasted five seconds between them, and the
   skeleton took another eight. In `heavy` mode the CENTRE ITSELF is slow — which
   is the case the skip rule exists for, and which must still skip. */
const CENTRE_MS = HEAVY ? 16000 : 5500;
const SKELETON_MS = 8000;
const wait = ms => new Promise(r => setTimeout(r, ms));
const asked = [];
let duds = 0;
await p.route('**/nominatim.openstreetmap.org/**', async r => {
  await wait(550);
  r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Belgrade' }]) });
});
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const box = boxOf(q);
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  if (kind === 'streets' && near(box, b0)) {
    // two duds first, exactly as the session had: one empty, one unreachable
    if (duds === 0) { duds++; await wait(370); return r.fulfill({ contentType: 'application/json', body: EMPTY }); }
    if (duds === 1) { duds++; await wait(1000); return r.abort('connectionrefused'); }
    await wait(CENTRE_MS);
    asked.push('centre');
    return r.fulfill({ contentType: 'application/json', body: rep.streets.body });
  }
  if (kind === 'arterials') {
    await wait(SKELETON_MS);
    return r.fulfill({ contentType: 'application/json', body: rep.arterials.body });
  }
  if (kind === 'streets') {                 // a ring tile
    asked.push('ring');
    return r.fulfill({ contentType: 'application/json', body: ringTile(box.s, box.w, box.n, box.e) });
  }
  if (kind === 'buildings' && near(box, rep.buildings.bbox))
    return r.fulfill({ contentType: 'application/json', body: rep.buildings.body });
  return r.fulfill({ contentType: 'application/json', body: EMPTY });
});

await p.goto('file://' + (process.env.GAME || '/home/user/GoogleMapsGTA/index.html'));
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 180000 });
await p.waitForTimeout(600);

const out = { mode: HEAVY ? 'slow streets' : 'the reported session', centreMs: CENTRE_MS };
out.chunks = await p.evaluate(() => {
  const c = window.__chunks();
  return { loaded: c.loaded, failed: c.failed, live: c.live, roads: c.roads, drive: c.drive };
});
out.ringRequests = asked.filter(a => a === 'ring').length;
// which neighbours actually made it into the world, by name
out.neighbours = await p.evaluate(() => {
  const seen = new Set();
  for (const r of window.__roadList()) {
    const m = r.name && r.name.match(/^T(-?\d+)_(-?\d+) /);
    if (m) seen.add(m[1] + ',' + m[2]);
  }
  return [...seen].sort();
});
/* The point of the ring is drivable street detail away from the centre tile, so
   this asks the ground rather than the bookkeeping: sample a band 1.2-2.4 km out
   and count cells the mask calls road. */
out.detailOut = await p.evaluate(() => {
  let hits = 0, tried = 0;
  for (let x = -2400; x <= 2400; x += 40) for (let y = -2400; y <= 2400; y += 40) {
    const d = Math.max(Math.abs(x), Math.abs(y));
    if (d < 1200) continue;                 // outside the centre tile
    tried++;
    if (window.__onRoad(x, y)) hits++;
  }
  return { hits, tried, pct: +(hits / tried * 100).toFixed(1) };
});
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));
out.errs = errs.slice(0, 4);
out.pass = HEAVY
  // streets that really are slow still shrink the ring — that rule is not the bug
  ? out.ringRequests <= 4 && out.fps >= 45 && !out.errs.length
  // and the reported session gets all eight neighbours and real streets out there
  : out.chunks.loaded >= 9 && out.neighbours.length === 8 &&
    out.detailOut.pct > 3 && out.fps >= 45 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
