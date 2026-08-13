/* The bundled offline city, and saying why you are in it.

   When the map servers cannot be reached the game now loads real central
   Belgrade — shipped in the repo, captured from OpenStreetMap by the log button
   — instead of a generated lattice. Two things have to hold:

     the city is REAL: thousands of actual roads and buildings, an arterial
     skeleton, and a drivable mask that agrees with what is drawn;

     and the player is TOLD, every time, which place they asked for and what
     went wrong — not a flash on the loading bar that is gone before the city
     appears. */
import { readFileSync } from 'fs';
const BUNDLE_R = +readFileSync(join(ROOT, 'data', 'belgrade.js'), 'utf8')
  .match(/"skeletonRadius":(\d+)/)[1];
import { chromium, devices } from 'playwright';
import { join } from 'path';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const URL_ = GAME;
const MODE = process.argv[2] || 'dead';        // dead | nogeo | empty | nobundle

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));

// the geocoder: alive unless we're testing it being dead
await p.route('**/nominatim.openstreetmap.org/**', r => MODE === 'nogeo'
  ? r.abort('failed')
  : r.fulfill({ contentType: 'application/json',
      body: JSON.stringify([{ lat: '35.6595', lon: '139.7005', display_name: 'Shibuya, Tokyo' }]) }));
// the map servers: dead, or answering with nothing
await p.route('**/api/interpreter', r => MODE === 'empty'
  ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [] }) })
  : r.abort('failed'));
// and the bundle itself missing, to prove the generated city is still underneath
if (MODE === 'nobundle') await p.route('**/data/belgrade.js', r => r.abort('failed'));

const out = { mode: MODE };
await p.goto(URL_);
await p.waitForTimeout(250);
await p.fill('#q', 'Shibuya, Tokyo');
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 120000 });

// the welcome has to still be up: it is the explanation
out.toast = await p.evaluate(() => document.getElementById('toast').textContent);
await p.waitForTimeout(600);

out.world = await p.evaluate(() => {
  const w = window.__w(), c = window.__chunks();
  return { name: w.name, procedural: w.procedural, roads: w.roads, drive: w.drive,
           buildings: w.buildings, parks: w.parks, grid: w.grid,
           skel: c.skel, bounds: c.bounds };
});

/* Is it a real place to drive? Same check the real-data test runs: every point
   on a drawn road has to read as tarmac to the off-road penalty. */
out.mask = await p.evaluate(() => {
  let ok = 0, bad = 0; const holes = [];
  for (const r of window.__roadList()) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b2 = r.pts[i + 1];
      if (Math.abs(a.x) > 800 || Math.abs(a.y) > 800) continue;
      const len = Math.hypot(b2.x - a.x, b2.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 12));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b2.x - a.x) * t, y = a.y + (b2.y - a.y) * t;
        if (window.__onRoadPenalty(x, y)) { bad++; if (holes.length < 4) holes.push({ n: r.name, x: Math.round(x), y: Math.round(y) }); }
        else ok++;
      }
    }
  }
  return { ok, bad, holes };
});

// and can you actually drive it
out.drive = await p.evaluate(async () => {
  for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
  const roads = window.__roadList().filter(r => r.drive);
  let best = null, bestLen = 0;
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (Math.hypot(a.x, a.y) > 600) continue;
    /* The longest STRAIGHT RUN, not the longest single segment. Four seconds at
       three hundred km/h is a third of a kilometre, so a long segment that turns
       a corner just after it puts the car in a garden and calls the map broken.
       Walk on while the heading holds. */
    let j = i + 1, L = Math.hypot(b.x - a.x, b.y - a.y);
    const h0 = Math.atan2(b.y - a.y, b.x - a.x);
    while (j + 1 < r.pts.length) {
      const c = r.pts[j], d = r.pts[j + 1];
      const h = Math.atan2(d.y - c.y, d.x - c.x);
      let dh = h - h0; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      if (Math.abs(dh) > .12) break;
      L += Math.hypot(d.x - c.x, d.y - c.y); j++;
    }
    if (L > bestLen) { bestLen = L; best = { a, b: r.pts[j], name: r.name }; }
  }
  if (!best) return { error: 'no road' };
  window.__tp(best.a.x, best.a.y, Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x));
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let top = 0, frames = 0, off = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p(); top = Math.max(top, q.spd); frames++; if (!q.onRoad) off++;
      performance.now() - t0 < 4000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  return { on: best.name, topKmh: Math.round(top * 3.6), offPct: +(off / frames * 100).toFixed(1) };
});

/* The explanation has to survive the toast fading — pause and read it. */
out.pause = await p.evaluate(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  const el = document.querySelector('#pauseStats .whyHere');
  const txt = el ? el.textContent : '';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { shown: !!el, text: txt };
});

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

await p.screenshot({ path: `${OUT}/shot-offline-${MODE}.png` });
out.errs = errs.slice(0, 4);

// what the player asked for, and the reason, both named — in the toast AND later
const saysAsked = /SHIBUYA/i.test(out.toast);
const saysWhy = /couldn.t be reached|too slow|nothing is mapped|skipped/i.test(out.toast);
out.explained = saysAsked && saysWhy && out.pause.shown &&
                /Shibuya/i.test(out.pause.text) && out.pause.text.length > 30;

if (MODE === 'nobundle') {
  // the bundle is unreachable, so the generated city must still catch it
  out.pass = out.world.procedural === true && out.world.roads > 5 && out.explained &&
             out.fps >= 45 && !out.errs.length;
} else {
  out.pass = out.world.procedural === false &&
             /Beograd/i.test(out.world.name) &&
             out.world.roads > 2000 && out.world.buildings > 3000 &&
             // read off the bundle rather than pinned, so rebuilding the city
             // with a wider horizon is not a test failure
             out.world.skel && out.world.skel.r === BUNDLE_R &&
             out.mask.bad === 0 &&
             out.drive.topKmh > 200 && out.drive.offPct < 5 &&
             out.explained && out.fps >= 45 && !out.errs.length;
}
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
