/* WHAT THE TWO THEMES ARE SUPPOSED TO LOOK LIKE.

   Both halves of this were reported, and both had been "fixed" before.

   THE STARS. The wanted level is meant to be the same yellow as the objective
   arrow. It was white at 16% alpha for the unlit ones, then a hand-typed
   #ffd21a that read as orange next to the arrow in daylight. The fault both
   times was the same: the colour was written out again somewhere else. So there
   is one constant now — GOLD in js/util.js, --gold in the stylesheet — and this
   holds all three against each other rather than against a number typed into a
   test, which would just be a fourth copy.

   THE TRAFFIC. Ten times the cars while the sun is up: a bright empty city reads
   as an abandoned one. Checked in both directions, because a cap that fills is
   only half of it — switching back to dusk has to empty as well, and quickly.

   Usage: node tests/daynight.mjs [GAME=/path/to/index.html]
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'stari-grad');
const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const gz = f => gunzipSync(readFileSync(join(FIX, f))).toString('utf8');
const rep = {};
for (const r of session.replies) if (r.elements) rep[r.kind] = { body: gz(r.file), bbox: r.bbox };
const EMPTY = readFileSync(join(FIX, 'empty.json'), 'utf8');
const b0 = rep.streets.bbox;
const LAT0 = (b0.s + b0.n) / 2, LON0 = (b0.w + b0.e) / 2;
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
  if (kind === 'arterials') body = rep.arterials.body;
  else if (kind === 'streets' && near(box, b0)) body = rep.streets.body;
  else if (kind === 'buildings' && near(box, rep.buildings.bbox)) body = rep.buildings.body;
  return r.fulfill({ contentType: 'application/json', body });
});
await p.goto('file://' + (process.env.GAME || '/home/user/GoogleMapsGTA/index.html'));
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(1100);

const out = {};
const hexToRgb = h => {
  const n = parseInt(h.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/* ---- the stars, against the one colour the arrow is drawn with ---- */
await p.evaluate(() => window.__addWanted(3 - window.__p().wanted));
await p.waitForTimeout(250);
out.gold = await p.evaluate(() => window.__gold());
out.cssGold = await p.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());
const starsIn = theme => p.evaluate(name => {
  applyTheme(name);
  const el = document.getElementById('stars');
  // lit stars are bare text nodes and take the row's own colour
  const off = el.querySelector('.off');
  return { lit: getComputedStyle(el).color,
           off: off ? getComputedStyle(off).color : null,
           html: el.innerHTML.slice(0, 60) };
}, theme);
out.dusk = await starsIn('dusk');
out.day = await starsIn('day');
const want = hexToRgb(out.gold);
// the stylesheet, the canvas and both themes' stars: one colour, four places
out.oneYellow = out.cssGold.toLowerCase() === out.gold.toLowerCase() &&
                out.dusk.lit === want && out.day.lit === want;
// and the unlit ones are the same hue, just faded — not grey, not brown
const sameHue = c => {
  const [r, g, b] = (c.match(/[\d.]+/g) || []).map(Number);
  return r === 255 && g === 227 && b === 106;
};
out.unlitSameHue = sameHue(out.dusk.off) && sameHue(out.day.off);

/* ---- ten times the traffic in daylight, and back again ---- */
const drive = () => p.evaluate(() => new Promise(res => {
  const t = performance.now();
  let n = 0;
  const tick = () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    n++;
    if (performance.now() - t < 2500) requestAnimationFrame(tick);
    else { window.__setInput(null); res(Math.round(n / 2.5)); }
  };
  requestAnimationFrame(tick);
}));
const settle = async theme => {
  await p.evaluate(t => applyTheme(t), theme);
  const want2 = theme === 'day' ? 260 : 26;
  const t0 = Date.now();
  await p.waitForFunction(w => Math.abs(window.__p().traffic - w) <= 8, want2, { timeout: 45000 })
    .catch(() => {});
  const cars = await p.evaluate(() => window.__p().traffic);
  const fps = await drive();
  const perf = await p.evaluate(() => window.__perf());
  return { cars, fps, settleMs: Date.now() - t0, upd: perf.upd, ren: perf.ren };
};
out.trafficDusk = await settle('dusk');
out.trafficDay = await settle('day');
out.trafficBack = await settle('dusk');
out.tenTimes = out.trafficDay.cars >= out.trafficDusk.cars * 8;
// and dusk empties again rather than staying in rush hour for a minute
out.emptiesBack = out.trafficBack.cars <= 34 && out.trafficBack.settleMs < 4000;
out.holdsUp = out.trafficDay.fps >= 45;

out.errs = errs.slice(0, 3);
out.pass = out.oneYellow && out.unlitSameHue &&
           out.tenTimes && out.emptiesBack && out.holdsUp && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
