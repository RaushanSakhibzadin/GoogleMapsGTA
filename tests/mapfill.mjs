/* THE BIG MAP HAS TO BE FULL OF MAP.

   Reported from an iPad in landscape: the city map, pinched all the way out, was
   surrounded by bare ground. Measured on the captured Belgrade session at
   1180x700, the old clamp let you zoom out to `min(VW/wide, VH/tall) * .9` —
   the whole world and then a tenth further — which put a 72 km square world
   across 90% of the height and 53% of the width. Half a tablet screen of
   nothing, on a map whose data was never the problem.

   So this measures two things that have completely different causes and
   completely different fixes:

     1. how much of the viewport the WORLD RECTANGLE covers at maximum zoom-out,
        which is the clamp's business
     2. how much of the viewport has anything PAINTED in it, sampled row by row
        and column by column off the canvas, which is the data's business

   Both have to be full, at every shape of screen, and panning to the stops must
   not drag the edge of the world into view either.

   Usage:
     node tests/mapfill.mjs            all four viewports
     VP=390x700 node tests/mapfill.mjs just the one
     GAME=/path/to/index.html          point it at a different build
*/
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CHROME, GAME, ROOT, SHOTS } from './harness.mjs';

const FIX = join(ROOT, 'tests', 'fixtures', 'stari-grad');
const VIEWPORTS = (process.env.VP || '1180x700,1440x900,390x700,700x1180')
  .split(',').map(s => s.split('x').map(Number));

const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const gz = f => gunzipSync(readFileSync(join(FIX, f))).toString('utf8');
const reply = {};
for (const r of session.replies) if (r.elements) reply[r.kind] = { body: gz(r.file), bbox: r.bbox };
const EMPTY = readFileSync(join(FIX, 'empty.json'), 'utf8');
const b0 = reply.streets.bbox;
const LAT0 = (b0.s + b0.n) / 2, LON0 = (b0.w + b0.e) / 2;
const boxOf = q => { const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null; };
const near = (a, t) => a && Math.abs((a.s + a.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                            Math.abs((a.w + a.e) / 2 - (t.w + t.e) / 2) < 4e-3;

const br = await chromium.launch({ executablePath: CHROME });

/* Sample the canvas and count, per row and per column, whether anything that is
   not the bare ground colour appears. The ground is found as the modal colour
   rather than read from the palette, so this works in either theme. */
const INK = () => {
  const cv = document.getElementById('bigmapC');
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const d = g.getImageData(0, 0, W, H).data;
  const seen = new Map();
  for (let i = 0; i < d.length; i += 4 * 97) {
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  let ground = 0, best = 0;
  for (const [k, n] of seen) if (n > best) { best = n; ground = k; }
  const rows = [], cols = new Array(40).fill(0);
  for (let ry = 0; ry < 40; ry++) {
    let hit = 0;
    const y0 = Math.floor(ry * H / 40), y1 = Math.floor((ry + 1) * H / 40);
    for (let y = y0; y < y1; y += 3) for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (k !== ground) { hit++; cols[Math.floor(x * 40 / W)] = 1; }
    }
    rows.push(hit);
  }
  return { rowsWithInk: rows.filter(n => n > 3).length,
           colsWithInk: cols.reduce((a, b) => a + b, 0), rows };
};

const results = [];
for (const [VPW, VPH] of VIEWPORTS) {
  const ctx = await br.newContext({ viewport: { width: VPW, height: VPH },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Stari grad' }]) }));
  await p.route('**/api/interpreter', r => {
    const q = decodeURIComponent(r.request().postData() || '');
    const box = boxOf(q);
    const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
               : /"building"/.test(q) ? 'buildings'
               : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
    let body = EMPTY;
    if (kind === 'arterials') body = reply.arterials.body;
    else if (kind === 'streets' && near(box, b0)) body = reply.streets.body;
    else if (kind === 'buildings' && near(box, reply.buildings.bbox)) body = reply.buildings.body;
    return r.fulfill({ contentType: 'application/json', body });
  });
  await p.goto(GAME);
  await p.waitForTimeout(250);
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
  await p.waitForTimeout(900);

  const o = { vp: `${VPW}x${VPH}` };
  o.world = await p.evaluate(() => {
    const c = window.__chunks().bounds;
    return { km: +((c.x1 - c.x0) / 1000).toFixed(1), bounds: c };
  });
  // the opening view: still about 5 km across the short axis, car in frame
  o.opening = await p.evaluate(() => {
    window.__openMap();
    const v = window.__mapView(), q = window.__p();
    const cv = document.getElementById('bigmapC');
    const short = Math.min(cv.clientWidth, cv.clientHeight);
    return { acrossShortKm: +(short / v.s / 1000).toFixed(2),
             carOnScreen: Math.abs(q.x - v.cx) * v.s < cv.clientWidth / 2 &&
                          Math.abs(q.y - v.cy) * v.s < cv.clientHeight / 2 };
  });
  // and now all the way out
  o.out = await p.evaluate(() => {
    for (let i = 0; i < 60; i++) window.__mapZoom(0.8);      // clamps at the limit
    const v = window.__mapView(), c = window.__chunks().bounds;
    const cv = document.getElementById('bigmapC');
    const VW = cv.clientWidth, VH = cv.clientHeight;
    return { mPerPx: +(1 / v.s).toFixed(1),
             coverW: +((c.x1 - c.x0) * v.s / VW).toFixed(3),
             coverH: +((c.y1 - c.y0) * v.s / VH).toFixed(3) };
  });
  /* Pan hard into every corner, still at maximum zoom-out. Where the world is
     bigger than the view, its edge may not come inside the viewport — that is the
     other way to end up looking at bare ground, and the old clamp allowed half a
     screen of it. */
  o.panned = await p.evaluate(() => {
    const worst = { dx: 0, dy: 0 };
    for (const [dx, dy] of [[1e6, 1e6], [-1e6, -1e6], [1e6, -1e6], [-1e6, 1e6]]) {
      window.__mapPan(dx, dy);
      const v = window.__mapView(), c = window.__chunks().bounds;
      const cv = document.getElementById('bigmapC');
      const halfW = cv.clientWidth / 2 / v.s, halfH = cv.clientHeight / 2 / v.s;
      /* How far the viewport sticks out past the world — in PIXELS, not metres,
         because that is the unit the complaint is in. At the zoom-out limit one
         pixel is a hundred metres, and __mapView rounds the scale, so metres here
         would be reporting noise rather than bare ground. */
      const outX = Math.max(0, (c.x0 - (v.cx - halfW)), ((v.cx + halfW) - c.x1)) * v.s;
      const outY = Math.max(0, (c.y0 - (v.cy - halfH)), ((v.cy + halfH) - c.y1)) * v.s;
      // the world is narrower than the view on one axis by design; only count
      // overhang on an axis that HAS room to pan
      if ((c.x1 - c.x0) > 2 * halfW) worst.dx = Math.max(worst.dx, outX);
      if ((c.y1 - c.y0) > 2 * halfH) worst.dy = Math.max(worst.dy, outY);
    }
    return { overhangPxX: +worst.dx.toFixed(2), overhangPxY: +worst.dy.toFixed(2) };
  });

  /* The ink is a separate question from the clamp, and asking it at maximum
     zoom-out would now be asking it of the FIXTURE: the game asks for a skeleton
     wider than the 72 km box the capture covers, so most of the world out there
     is empty because nobody recorded it. Re-centre, zoom to what the capture
     actually covers, and read the ink inside that. */
  o.dataFit = await p.evaluate(() => {
    const v0 = window.__mapView();
    window.__mapPan(-v0.cx, -v0.cy);              // back to the middle
    let m = 0;
    for (const r of window.__roadList()) for (const q of r.pts) {
      const a = Math.abs(q.x), b = Math.abs(q.y);
      if (a > m) m = a;
      if (b > m) m = b;
    }
    const cv = document.getElementById('bigmapC');
    // comfortably inside the data rather than exactly on its edge, where a
    // single boundary column of ground is not evidence of anything
    const want = 1.3 * Math.max(cv.clientWidth, cv.clientHeight) / (2 * m);
    window.__mapZoom(want / window.__mapView().s);
    const v = window.__mapView();
    return { dataHalfKm: Math.round(m / 1000), mPerPx: +(1 / v.s).toFixed(1),
             cx: Math.round(v.cx), cy: Math.round(v.cy) };
  });
  o.ink = await p.evaluate(INK);
  /* AND IT MUST NOT BE A BLOCK. Filling the viewport is only half of "full of
     map": the detailed centre is eleven thousand ways across 5.4 km, and with a
     pixel floor measured in CSS rather than device pixels they merged into one
     solid white rectangle sitting in the middle of the city. Sampled per cell of
     a 12x12 grid and the worst cell taken, because an average over the whole
     canvas hides a block behind all the empty ground around it. */
  o.block = await p.evaluate(async () => {
    applyTheme('day');                       // minor roads are pure white here
    const cv = document.getElementById('bigmapC');
    const short = Math.min(cv.clientWidth, cv.clientHeight);
    window.__mapZoom((short / 7000) / window.__mapView().s);   // 7 km across
    const v = window.__mapView();
    window.__mapPan(-v.cx, -v.cy);
    await new Promise(r => requestAnimationFrame(r));
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const d = g.getImageData(0, 0, W, H).data;
    const N = 12, hit = new Array(N * N).fill(0), tot = new Array(N * N).fill(0);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const c = Math.floor(y * N / H) * N + Math.floor(x * N / W);
      tot[c]++;
      if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) hit[c]++;
    }
    let worst = 0;
    for (let c = 0; c < N * N; c++) if (tot[c] > 100) worst = Math.max(worst, hit[c] / tot[c]);
    applyTheme('dusk');
    return { worstCellPctWhite: +(worst * 100).toFixed(1),
             acrossKm: +(short / v.s / 1000).toFixed(1) };
  });
  // and after a shove that stays well inside the data
  o.inkPanned = await p.evaluate(() => {
    window.__mapPan(4000, 4000);
    return null;
  }).then(() => p.evaluate(INK));
  o.errs = errs.slice(0, 3);
  o.pass = o.out.coverW > .999 && o.out.coverH > .999 &&
           o.block.worstCellPctWhite < 15 &&
           o.ink.rowsWithInk === 40 && o.ink.colsWithInk === 40 &&
           o.inkPanned.rowsWithInk === 40 && o.inkPanned.colsWithInk === 40 &&
           o.panned.overhangPxX < 1 && o.panned.overhangPxY < 1 &&
           o.opening.acrossShortKm > 3 && o.opening.acrossShortKm < 8 &&
           o.opening.carOnScreen && !o.errs.length;
  results.push(o);
  await ctx.close();
}
await br.close();
const pass = results.every(r => r.pass);
console.log(JSON.stringify({ pass, results }, null, 1));
process.exit(pass ? 0 : 1);
