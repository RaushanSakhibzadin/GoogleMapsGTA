import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 56.9496, LON0 = 24.1052;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

// straight two-node streets (the shape that makes traffic spin) + tall blocks
function fixture() {
  const els = [];
  let id = 1;
  for (const y of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `EW ${y}` },
      geometry: [toLL(-500, y), toLL(500, y)] });
  for (const x of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
      geometry: [toLL(x, -500), toLL(x, 500)] });
  // short two-node stubs — cars reach the end fast, which is what triggers the spin
  for (let k = 0; k < 8; k++) {
    const bx = -400 + k * 100;
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Stub ${k}` },
      geometry: [toLL(bx, 60), toLL(bx + 35, 60)] });
  }
  // a block beside the origin, tall enough for a big extrusion but still on screen
  els.push({ type: 'way', id: 9001, tags: { building: 'yes', height: '45' },
    geometry: [[10, 20], [26, 20], [26, 44], [10, 44], [10, 20]].map(([x, y]) => toLL(x, y)) });
  // archway block over the y=0 street — the player can legitimately sit under this
  els.push({ type: 'way', id: 9002, tags: { building: 'yes', height: '30' },
    geometry: [[-120, -18], [-70, -18], [-70, 18], [-120, 18], [-120, -18]].map(([x, y]) => toLL(x, y)) });
  return { elements: els };
}

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga, Latvia' }]) }));
// This fixture is fixed to one spot, so serve it only for the opening tile: the
// ring would otherwise stack nine identical copies of every building on the same
// coordinates, and the pile-up of overlapping collisions is a fixture artifact.
const CENTRE = { lat: LAT0, lon: LON0 };
await p.route('**/api/interpreter', r => {
  const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  const mid = m ? { lat: (+m[1] + +m[3]) / 2, lon: (+m[2] + +m[4]) / 2 } : CENTRE;
  const centred = Math.abs(mid.lat - CENTRE.lat) < 3e-3 && Math.abs(mid.lon - CENTRE.lon) < 4e-3;
  return r.fulfill({ contentType: 'application/json',
    body: JSON.stringify(centred ? fixture() : { elements: [] }) });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(400);
const out = {};

/* ---------- 1. holes between roof and footprint ---------- */
// stain everything under the buildings bright green: anything green showing
// inside a building's silhouette is a hole in the fill
const stain = () => {
  const pal = window.__pal();
  for (const k of ['ground', 'road', 'roadBig', 'kerb', 'case', 'park']) pal[k] = '#00ff00';
};
out.holes = await p.evaluate(async () => {
  const pal = window.__pal();
  for (const k of ['ground', 'road', 'roadBig', 'kerb', 'case', 'park']) pal[k] = '#00ff00';
  window.__tp(0, 0, -Math.PI / 2);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.getElementById('game');
  const g = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const cx = cv.clientWidth / 2, cy = cv.clientHeight * 0.60;
  const f = 45 * 0.026;
  const corners = [[10, 20], [26, 20], [26, 44], [10, 44]].map(([x, y]) => window.__toScreen(x, y));
  const pts = corners.concat(corners.map(p => [p[0] + (p[0] - cx) * f, p[1] + (p[1] - cy) * f]));
  // convex hull of base + roof = the silhouette the building should completely fill
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const inHull = (x, y) => {
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const a = hull[j], b = hull[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (cross(a, b, [x, y]) / L < 4) return false;   // real px distance, so the erosion bites
    }
    return true;
  };
  let green = 0, total = 0; const hits = [];
  const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 2)
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 2) {
      if (!inHull(x, y)) continue;
      if (x < 0 || y < 0 || x >= cv.clientWidth || y >= cv.clientHeight) continue;
      const d = g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      total++;
      if (d[1] > 140 && d[0] < 120 && d[2] < 120) { green++; hits.push([Math.round(x), Math.round(y)]); }
    }
  const gx = hits.map(h => h[0]), gy = hits.map(h => h[1]);
  return { sampled: total, showingGround: green, pct: total ? +(100 * green / total).toFixed(1) : 0,
           firstHits: hits, hull: hull.map(q => [Math.round(q[0]), Math.round(q[1])]),
           holeBox: gx.length ? [Math.min(...gx), Math.min(...gy), Math.max(...gx), Math.max(...gy)] : null };
});

await p.screenshot({ path: `${OUT}/shot-holes.png` });

/* ---------- 2. traffic drawn over buildings ---------- */
out.occlusion = await p.evaluate(async () => {
  window.__putTraffic(0, 18, 32, 0, '#ff0000');   // pure red car, parked inside the block
  window.__tp(0, 0, -Math.PI / 2);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.getElementById('game');
  const g = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const s = window.__toScreen(18, 32);
  let red = 0;
  for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
    const d = g.getImageData(Math.round((s[0] + dx) * dpr), Math.round((s[1] + dy) * dpr), 1, 1).data;
    if (d[0] > 150 && d[1] < 90 && d[2] < 90) red++;
  }
  return { redPixels: red };
});

// the player must stay visible on top of everything
out.playerVisible = await p.evaluate(async () => {
  window.__playerColour('#ff0000');
  window.__tp(-95, 0, 0);                        // under the archway block, on the street
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.getElementById('game');
  const g = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const s = window.__toScreen(-95, 0);
  let lit = 0;
  for (let dx = -12; dx <= 12; dx++) for (let dy = -24; dy <= 24; dy++) {
    const d = g.getImageData(Math.round((s[0] + dx) * dpr), Math.round((s[1] + dy) * dpr), 1, 1).data;
    if (d[0] > 150 && d[1] < 90 && d[2] < 90) lit++;   // the player's own red
  }
  return { brightPixels: lit };
});

/* ---------- 3. do cars actually go anywhere, or spin? ---------- */
out.motion = await p.evaluate(() => new Promise(res => {
  const start = window.__traffic().map(t => ({ x: t.x, y: t.y, h: t.h }));
  const churn = start.map(() => 0);
  let last = start.map(t => t.h);
  const t0 = performance.now();
  const tick = () => {
    const now = window.__traffic();
    for (let i = 0; i < now.length && i < churn.length; i++) {
      let d = now[i].h - last[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      churn[i] += Math.abs(d);
      last[i] = now[i].h;
    }
    if (performance.now() - t0 < 20000) requestAnimationFrame(tick);
    else {
      const end = window.__traffic();
      const rows = [];
      for (let i = 0; i < Math.min(start.length, end.length); i++) {
        rows.push({
          moved: Math.round(Math.hypot(end[i].x - start[i].x, end[i].y - start[i].y)),
          turns: +(churn[i] / (Math.PI * 2)).toFixed(1)      // full revolutions
        });
      }
      res(rows);
    }
  };
  requestAnimationFrame(tick);
}));

const m = out.motion;
out.spinners = m.filter(r => r.turns > 1.5 && r.moved < 40).length;
out.movers = m.filter(r => r.moved > 120).length;
out.trafficCount = m.length;
out.errs = errs;
out.topSpeed = await p.evaluate(() => new Promise(res => {
  window.__tp(-480, 0, 0);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
  let best = 0;
  const t0 = performance.now();
  const tick = () => {
    const q = window.__p();
    best = Math.max(best, q.spd);
    if (performance.now() - t0 < 20000) requestAnimationFrame(tick);
    else { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' })); res(Math.round(best * 3.6)); }
  };
  requestAnimationFrame(tick);
}));
await p.screenshot({ path: `${OUT}/shot-render.png` });
console.log(JSON.stringify(out, null, 1));
await browser.close();
