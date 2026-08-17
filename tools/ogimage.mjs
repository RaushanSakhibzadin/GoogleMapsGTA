/* THE SOCIAL CARD AND THE APP ICONS, RENDERED FROM THE GAME ITSELF.

   Nothing in this repo was ever a picture — everything visible is drawn at
   runtime into a canvas or built out of CSS gradients — so a link shared
   anywhere unfurled as a bare URL. Rather than draw an impression of the game in
   some other tool, this drives the real one and photographs it.

   It replays tests/fixtures/stari-grad, the captured Overpass session that
   tests/real.mjs already verifies byte for byte, so the card shows real Belgrade
   streets and real building footprints, renders identically on every run, and
   needs no network. The wordmark over the top is the page's own `.logo` element
   with the page's own stylesheet, not a re-creation of it.

   Usage:  node tools/ogimage.mjs
   Writes: og.jpg (1200x630), icon-180/192/512.png, from favicon.svg
*/
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { createRequire } from 'module';
import { CHROME, GAME, ROOT } from '../tests/harness.mjs';

/* Playwright is a devDependency of tests/, and node resolves from the importing
   FILE's directory upwards — which from tools/ never reaches tests/node_modules.
   Resolved from there explicitly rather than moving this file in among the
   tests, where the runner would pick it up and try to run it as one. */
const { chromium } = createRequire(join(ROOT, 'tests', 'package.json'))('playwright');

const FIX = join(ROOT, 'tests', 'fixtures', 'stari-grad');
const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const body = f => f.endsWith('.gz') ? gunzipSync(readFileSync(join(FIX, f))).toString('utf8')
                                    : readFileSync(join(FIX, f), 'utf8');
const reply = {};
for (const r of session.replies) if (r.elements) reply[r.kind] = { body: body(r.file), bbox: r.bbox };
const EMPTY = body('empty.json');
const bS = reply.streets.bbox;
const LAT0 = (bS.s + bS.n) / 2, LON0 = (bS.w + bS.e) / 2;

const boxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};
const near = (b, t) => b && Math.abs((b.s + b.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                            Math.abs((b.w + b.e) / 2 - (t.w + t.e) / 2) < 4e-3;

const br = await chromium.launch({ executablePath: CHROME });

/* ---------- the icons, rasterised from the one SVG ---------- */
const svg = readFileSync(join(ROOT, 'favicon.svg'), 'utf8');
for (const size of [180, 192, 512]) {
  const ctx = await br.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<style>html,body{margin:0;padding:0;background:none}
    svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await p.locator('svg').screenshot({ path: join(ROOT, `icon-${size}.png`), omitBackground: true });
  await ctx.close();
  console.log(`icon-${size}.png`);
}

/* ---------- the card ---------- */
const ctx = await br.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Stari grad, Beograd' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const box = boxOf(q);
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  let payload = EMPTY;
  if (kind === 'arterials') payload = reply.arterials.body;
  else if (kind === 'streets' && near(box, bS)) payload = reply.streets.body;
  else if (kind === 'buildings' && near(box, reply.buildings.bbox)) payload = reply.buildings.body;
  return r.fulfill({ contentType: 'application/json', body: payload });
});

await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 120000 });
// let the scenery finish arriving, or the card shows streets on bare ground
await p.waitForTimeout(6000);

/* Somewhere worth photographing: on a road, moving, with the city around it
   rather than the edge of the loaded tiles. Found by walking the drivable roads
   for the longest straight near the centre and sitting on it. */
await p.evaluate(() => {
  const roads = window.__roadList().filter(r => r.pts.length > 3);
  let best = null, bestLen = 0;
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      // near the middle of the capture, where the buildings are densest
      if (d > bestLen && Math.hypot(a.x, a.y) < 700) { bestLen = d; best = [a, b]; }
    }
  }
  if (best) {
    const [a, b] = best;
    window.__tp((a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x));
  }
  /* DAYLIGHT, not the neon dusk. The dusk palette is the game's signature and it
     is nearly black — rendered at 1200x630 and then looked at as a 300px
     thumbnail in a chat client, the first version of this card read as a dark
     rectangle with a wordmark on it. Daylight shows what the thing actually is:
     real streets, real building footprints, parks. */
  applyTheme('day');
  // pull back a little so the shot is a piece of city rather than one junction
  cam.s = 6.2;
  // chrome that dates the shot or means nothing at thumbnail size
  // topBtns, not logBtn: the LOG button gained a neighbour (the 2D/3D switch) and
  // hiding it by name now leaves the other one sitting in the corner of the card
  for (const id of ['topBtns', 'touch', 'chunk']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
});
await p.waitForTimeout(700);

/* The wordmark, using the page's own .logo and .tag rules — so the card cannot
   drift away from what the site actually looks like. */
await p.evaluate(() => {
  const wrap = document.createElement('div');
  /* A band behind the type rather than a wash over the middle. The first version
     darkened the centre to make the wordmark read and buried the city doing it —
     which is backwards, since the city is the thing worth showing. */
  wrap.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;pointer-events:none;text-align:center;' +
    'background:linear-gradient(180deg,transparent 26%,rgba(12,4,24,.70) 42%,' +
    'rgba(12,4,24,.70) 62%,transparent 76%)';
  const h = document.createElement('div');
  h.className = 'logo'; h.style.fontSize = '104px'; h.innerHTML = 'VICE&nbsp;MAPS';
  h.style.filter = 'drop-shadow(0 4px 20px rgba(0,0,0,.9)) drop-shadow(0 0 22px rgba(255,79,216,.55))';
  const t = document.createElement('div');
  t.className = 'tag'; t.style.marginTop = '18px';
  t.style.textShadow = '0 2px 10px rgba(0,0,0,.95),0 0 14px rgba(51,230,255,.8)';
  t.textContent = 'Drive any real city on Earth';
  wrap.append(h, t);
  document.body.appendChild(wrap);
});
await p.waitForTimeout(250);

await p.screenshot({ path: join(ROOT, 'og.jpg'), type: 'jpeg', quality: 86 });
await ctx.close();
await br.close();
console.log('og.jpg');
