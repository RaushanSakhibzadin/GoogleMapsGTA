/* THE SUN IS IN THE SOUTH.
 *
 * Belgrade is at 44° north. The sun there rises south of east, crosses due
 * south at noon and sets south of west, and it has never in the history of the
 * city been in the northern sky. Both themes had it in the north-west: every
 * north-facing wall lit all day, every south-facing one in permanent shade.
 *
 * It is invisible in a screenshot and obvious to anyone who lives on the street
 * being drawn, which is how it was reported.
 *
 * MEASURED AS BRIGHTNESS, NOT AS A VECTOR. Checking the sign of a number in a
 * table would pass on a build whose shader ignored the table, so the real
 * question is asked instead: stand south of a building and look at its south
 * face, then stand north of it and look at its north face, and the south face
 * has to be the brighter of the two. Nothing else about the two shots differs —
 * same building, same distance, same theme, shadows off so a neighbour cannot
 * darken either wall.
 *
 * The vectors are checked as well, in both themes, because the pixel test can
 * only be run in one at a time and a sun that was fixed for daylight and left
 * broken at dusk would be a strange thing to ship.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (x0, x1, y0, y1) => {
  const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  p.push(p[0]);
  return p.map(q => toLL(q[0], q[1]));
};
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Bulevar' },
    geometry: [toLL(-900, 0), toLL(900, 0)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } }
] });
/* One block, alone, with nothing near enough to shade it. +y is south, so this
   runs from its north edge at y = -110 to its south edge at y = -70. */
const BUILDINGS = { elements: [
  { type: 'way', id: 7001, tags: { building: 'residential', height: '24' },
    geometry: ring(-40, 40, -110, -70) }
] };

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
}));
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/historic/.test(q) || /amenity/.test(q)) && !/highway/.test(q) ? 'pois' : 'streets';
  const body = kind === 'streets' ? streets()
             : kind === 'buildings' ? BUILDINGS : { elements: [] };
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
out.switched = await p.evaluate(() => window.__setMode3d(true));
if (!out.switched) {
  out.skipped = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
await p.waitForTimeout(2000);

/* ---- 1. every theme's sun is south of you and above the horizon ---- */
/* +x is east and +z is south, because projY negates latitude. The compass
   bearing is measured the way a compass measures one: clockwise from north. */
out.themes = await p.evaluate(() => {
  const r = {};
  for (const name in SKY) {
    const d = SKY[name].ld;
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    const east = d[0], north = -d[2];
    r[name] = {
      bearing: Math.round((Math.atan2(east, north) * 180 / Math.PI + 360) % 360),
      elevation: Math.round(Math.asin(d[1] / L) * 180 / Math.PI),
      southward: north < 0, up: d[1] > 0
    };
  }
  return r;
});
out.allSouth = Object.values(out.themes).every(t => t.southward && t.up);

/* ---- 2. and the south wall really is the lit one ---- */
const look = (y, h) => p.evaluate(a => {
  P.car.vx = P.car.vy = 0; traffic.length = 0; cops.length = 0; peds.length = 0;
  window.__setInput({ steer: 0, gas: 0, brake: 0, hand: 0 });
  window.__tp(0, a[0], a[1]);
  state = 'pause';
  for (let i = 0; i < 50; i++) window.__px3(0, 0, 1, 1);
  const w = Math.floor(VW * DPR), hh = Math.floor(VH * DPR);
  /* A box on the WALL, which is higher up the frame than it feels like it
     should be: readPixels counts from the bottom, the eye is seven metres up
     looking slightly down, and a twenty-four metre block sixty metres away
     covers roughly the 54th to the 86th percentile of the frame's height. The
     first version sampled 46 to 58 and read mostly road — which came back
     saying the north wall was brighter, in a pair of screenshots where it
     plainly is not. Windows are suppressed so the reading is masonry rather
     than a count of how many dark panes fell in the box. */
  const x0 = Math.floor(w * 0.42), x1 = Math.floor(w * 0.58);
  const y0 = Math.floor(hh * 0.62), y1 = Math.floor(hh * 0.80);
  const px = window.__px3(x0, y0, x1 - x0, y1 - y0);
  let s = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    s += .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2];
    n++;
  }
  state = 'play';
  return { lum: +(s / n).toFixed(1), samples: n };
}, [y, h]);

await p.evaluate(() => { applyTheme('day'); window.__noShadow(true); window.__noWindows(true); });
await p.waitForTimeout(500);
// south of the block looking north at its south face, then the mirror image
out.southFace = await look(-20, -Math.PI / 2);
out.northFace = await look(-160, Math.PI / 2);
await p.evaluate(() => { window.__noShadow(false); window.__noWindows(false); });

out.gap = +(out.southFace.lum - out.northFace.lum).toFixed(1);
/* A wall facing the sun against one facing away is not a subtle difference. It
   measures +34.8 here and exactly -34.8 on a build with the two z signs put
   back — the same walls, the same numbers, swapped over. Ten is well below that
   and well above any noise. */
out.southIsLit = out.gap > 10;

out.errs = errs.slice(0, 3);
out.pass = out.allSouth && out.southIsLit && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
