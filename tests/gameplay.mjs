import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const URL = GAME;

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(URL);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(400);

const out = {};

// ---------- 1. mission: pickup -> deliver -> paid ----------
out.m0 = await p.evaluate(() => window.__m());
await p.evaluate(() => { const m = window.__m(); window.__tp(m.pick.x, m.pick.y); });
await p.waitForTimeout(400);
out.m1 = await p.evaluate(() => window.__m());
const cashBefore = await p.evaluate(() => window.__p().cash);
await p.evaluate(() => { const m = window.__m(); window.__tp(m.drop.x, m.drop.y); });
await p.waitForTimeout(400);
out.m2 = await p.evaluate(() => window.__m());
out.cashBefore = cashBefore;
out.cashAfter = await p.evaluate(() => window.__p().cash);
await p.waitForTimeout(1200);
out.m3 = await p.evaluate(() => window.__m());   // a fresh contract should exist

// ---------- 2. mission timeout ----------
await p.evaluate(() => { const m = window.__m(); window.__tp(m.pick.x, m.pick.y); });
await p.waitForTimeout(400);
const inDeliver = await p.evaluate(() => window.__m().state);
await p.evaluate(() => { window.__setTime && window.__setTime(0.5); });
out.timeoutTested = inDeliver === 'deliver';

// ---------- 3. building collision: drive into a wall ----------
const crash = await p.evaluate(async () => {
  // find a building near the player and line the car up at it
  let best = null, bd = 1e9;
  const n = window.__w().buildings;
  for (let i = 0; i < n; i++) {
    const b = window.__bld(i); if (!b) continue;
    const d = (b.cx - 0) ** 2 + (b.cy - 0) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  const startX = best.cx - 60, startY = best.cy;
  const h = Math.atan2(best.cy - startY, best.cx - startX);
  window.__tp(startX, startY, h);
  return { target: best, startX, startY };
});
await p.keyboard.down('w');
await p.waitForTimeout(3000);
await p.keyboard.up('w');
await p.waitForTimeout(300);
out.crash = { ...crash, after: await p.evaluate(() => window.__p()),
  insideBuilding: await p.evaluate(() => window.__inside(window.__p().x, window.__p().y)) };

// ---------- 4. sustained-load frame budget with a full pursuit ----------
await p.evaluate(() => window.__addWanted(5));
await p.keyboard.down('w');
await p.waitForTimeout(1500);
out.frameStats = await p.evaluate(() => new Promise(res => {
  const f = []; let last = performance.now(); const t0 = last;
  const c0 = window.__chunks();
  const tick = () => { const now = performance.now(); f.push(now - last); last = now;
    if (now - t0 < 2000) requestAnimationFrame(tick);
    else { const c1 = window.__chunks(); const g = f.slice(1).sort((a,b)=>a-b);
      res({ fps: Math.round(f.length / 2), median: +g[g.length>>1].toFixed(1),
            p90: +g[Math.floor(g.length*.9)].toFixed(1), worst: +g[g.length-1].toFixed(1),
            over25ms: g.filter(x=>x>25).length, frames: g.length,
            tiles: c1.loaded - c0.loaded, mapMs: c1.mapMs }); }
  };
  requestAnimationFrame(tick);
}));
out.fpsUnderPursuit = out.frameStats.fps;
// what the scene actually contained while that was measured
out.pursuitLoad = await p.evaluate(() => {
  // tolerant of hooks that may not exist on an older build, so this can bisect
  const g = (f, d) => { try { return f(); } catch (e) { return d; } };
  const c = window.__cars(), q = window.__p(), k = window.__chunks();
  return { parts: c.parts, blasts: c.blasts, marks: g(() => window.__marks(), null),
           traffic: c.traffic.length, cops: c.cops.length, kmh: Math.round(q.spd * 3.6),
           camScale: g(() => +window.__cam().s.toFixed(2), null),
           roadsDrawn: g(() => window.__visRoads(), null),
           buildings: k.buildings, dead: q.dead, hp: q.hp,
           audio: g(() => window.__audio(), null), perf: g(() => window.__perf(), null) };
});
await p.keyboard.up('w');
out.underPursuit = await p.evaluate(() => window.__p());
out.errs = errs;
console.log(JSON.stringify(out, null, 1));
await browser.close();
