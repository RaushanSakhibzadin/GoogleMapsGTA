/* WHAT THE TWO THEMES ARE SUPPOSED TO LOOK LIKE.

   Both halves of this were reported, and both had been "fixed" before.

   THE STARS. The wanted level is meant to be the same yellow as the objective
   arrow. It was white at 16% alpha for the unlit ones, then a hand-typed
   #ffd21a that read as orange next to the arrow in daylight. The fault both
   times was the same: the colour was written out again somewhere else. So there
   is one constant now — GOLD in js/util.js, --gold in the stylesheet — and this
   holds all three against each other rather than against a number typed into a
   test, which would just be a fourth copy.

   THE TRAFFIC. Busier while the sun is up: a bright empty city reads as an
   abandoned one. It was ten times the cars when traffic lived in a 780 m circle
   and nine tenths of it was out of sight; now that cars are kept to the edge of
   the screen, ten times the count is thirty times the DENSITY and the streets
   gridlock, so it is three times — and the number that matters, cars actually in
   front of you, went UP. Checked in both directions, because a cap that fills is
   only half of it: switching back to dusk has to empty as well, and quickly.

   AND THE ONES YOU CANNOT SEE ARE FREE. The view is about 170 m across and cars
   are simulated out to 780, so most of them are never drawn — but they used to
   be drawn anyway, gradient headlights and all. What this holds is that the
   drawing cost no longer depends on how many cars exist: daylight has ten times
   the traffic and must cost the same per frame to render as dusk, while still
   putting MORE of them on the screen.

   Usage: node tests/daynight.mjs [GAME=/path/to/index.html]
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CHROME, GAME, ROOT, SHOTS, stubRadio } from './harness.mjs';

const FIX = join(ROOT, 'tests', 'fixtures', 'stari-grad');
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
const br = await chromium.launch({ executablePath: CHROME });
const ctx = await br.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e) + ' :: ' + String(e.stack).split('\n').slice(0,4).join(' | ')));
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
await stubRadio(p);
await p.goto(GAME);
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
/* Drives for two and a half seconds and reports the frame rate, the render cost
   and how many cars were on screen — all sampled DURING the drive, because each
   of them only means anything while the game is being played.

   Taken separately and afterwards they went wrong in two different directions.
   PERF.ren is a rolling average over about ten frames, so one reading of it at
   1.5 ms is mostly noise: across repeated runs of an unchanged build the daylight
   figure came back between 1.29 and 2.00, a 55% spread against a 1.6x threshold,
   and the comparison was decided by which instant it was asked on. And the count
   of cars on screen, read once the car had been sitting still, would find the
   traffic had driven off and report zero for both themes — which passes the
   render check by having nothing left to draw, the one way it must not pass.
   Medians over the drive itself for both. */
const drive = () => p.evaluate(() => new Promise(res => {
  const t = performance.now();
  let n = 0;
  const ren = [], upd = [], seen = [];
  const tick = () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    n++;
    if (n % 6 === 0) {
      const q = window.__perf();
      ren.push(q.ren); upd.push(q.upd);
      seen.push(window.__traffic().filter(c => {
        const [sx, sy] = window.__toScreen(c.x, c.y);
        return sx > -40 && sy > -40 && sx < innerWidth + 40 && sy < innerHeight + 40;
      }).length);
    }
    if (performance.now() - t < 2500) requestAnimationFrame(tick);
    else {
      window.__setInput(null);
      const mid = a => a.slice().sort((x, y) => x - y)[a.length >> 1] || 0;
      res({ fps: Math.round(n / 2.5), ren: mid(ren), upd: mid(upd), onScreen: mid(seen),
            renSpread: +(Math.max(...ren) - Math.min(...ren)).toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}));
/* On screen means inside the drawn frame, not inside a radius: the camera puts
   the car at 60% of the viewport height, so a radius counts cars behind you that
   were never drawn. toScreen() is what the renderer itself uses. */
const onScreen = () => p.evaluate(() => window.__traffic().filter(t => {
  const [sx, sy] = window.__toScreen(t.x, t.y);
  return sx > -40 && sy > -40 && sx < innerWidth + 40 && sy < innerHeight + 40;
}).length);
const settle = async theme => {
  await p.evaluate(t => applyTheme(t), theme);
  const want2 = theme === 'day' ? 78 : 26;
  const t0 = Date.now();
  await p.waitForFunction(w => Math.abs(window.__p().traffic - w) <= 8, want2, { timeout: 45000 })
    .catch(() => {});
  /* Stopped HERE, not at the end of this function. settleMs is how long the
     traffic took to reach its new count, and it was being read after drive() and
     the perf sampling had also run — so it silently measured those too, and
     lengthening the sampling pushed it past its own 4 s threshold. */
  /* Stopped HERE, not at the end of this function. settleMs is how long the
     traffic took to reach its new count, and it was being read after the driving
     and the sampling had also run — so it silently measured those too. */
  const settleMs = Date.now() - t0;
  const cars = await p.evaluate(() => window.__p().traffic);
  const d = await drive();
  return { cars, onScreen: d.onScreen, fps: d.fps, settleMs,
           upd: +d.upd.toFixed(2), ren: +d.ren.toFixed(2), renSpread: d.renSpread };
};
out.trafficDusk = await settle('dusk');
out.trafficDay = await settle('day');
out.trafficBack = await settle('dusk');
out.busierByDay = out.trafficDay.cars >= out.trafficDusk.cars * 2.5;
// and dusk empties again rather than staying in rush hour for a minute
out.emptiesBack = out.trafficBack.cars <= 34 && out.trafficBack.settleMs < 4000;
out.holdsUp = out.trafficDay.fps >= 45;
/* Ten times the cars, the same drawing bill. Before the view cull daylight cost
   twice dusk to render — 3.98 ms against 2.27 — because every car in the world
   was drawn whether or not it landed on the canvas. */
out.offScreenAreFree = out.trafficDay.ren < out.trafficDusk.ren * 1.6;
// and the extra cars are actually where you can see them
out.moreOnScreen = out.trafficDay.onScreen > out.trafficDusk.onScreen;

out.errs = errs.slice(0, 3);
out.pass = out.oneYellow && out.unlitSameHue &&
           out.busierByDay && out.emptiesBack && out.holdsUp &&
           out.offScreenAreFree && out.moreOnScreen && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
