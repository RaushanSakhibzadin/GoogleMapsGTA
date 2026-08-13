/* Does the drivable mask stay lined up with the roads while the world grows?

   roadmask.mjs says coverage is perfect in a world that never changes. The
   report is from a long session in a streaming city, so the suspect is fitGrid:
   every time the bounds grow it allocates a new mask and blits the old one in at
   `Math.round((W.minX - nMinX) / W.cell)`. That round is only lossless while the
   bounds move in whole multiples of the 8 m cell — otherwise the entire existing
   mask shifts by up to half a cell, and the error rides along into the next
   growth. Off-road used to be 96 km/h so a few metres of drift was invisible;
   now it is a car that crawls on tarmac.

   Drive a long way, then ask the mask about the centreline of every drivable
   road that is drawn. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const LAT0 = 44.8125, LON0 = 20.4612;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const SKEL = process.argv[2] === 'skel';
const bboxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};

// streets for whatever tile is asked for, ids derived from the tile so nothing dedupes away
function tileStreets(bb) {
  const cy = (bb.s + bb.n) / 2, cx = (bb.w + bb.e) / 2;
  const y = (LAT0 - cy) * M_LAT, x = (cx - LON0) * M_LON;
  const gx = Math.round(x / 1800), gy = Math.round(y / 1800);
  const zig = n => n >= 0 ? n * 2 : -n * 2 - 1;
  const base = 1000 + (zig(gx) * 4096 + zig(gy)) * 40;
  const els = [];
  let n = 0;
  for (let k = -2; k <= 2; k++) {
    els.push({ type: 'way', id: base + n++,
      tags: { highway: k ? 'residential' : 'secondary', name: `EW ${gx}/${gy}/${k}` },
      geometry: [toLL(gx * 1800 - 900, gy * 1800 + k * 300), toLL(gx * 1800 + 900, gy * 1800 + k * 300)] });
    els.push({ type: 'way', id: base + n++,
      tags: { highway: 'residential', name: `NS ${gx}/${gy}/${k}` },
      geometry: [toLL(gx * 1800 + k * 300, gy * 1800 - 900), toLL(gx * 1800 + k * 300, gy * 1800 + 900)] });
  }
  els.push({ type: 'node', id: base + n++, lat: cy, lon: cx,
    tags: { place: 'suburb', name: `District ${gx}/${gy}` } });
  return { elements: els };
}
function arterials() {
  const els = [];
  for (let k = -9; k <= 9; k++)
    els.push({ type: 'way', id: 800000 + k + 20, tags: { highway: 'primary', name: `Radial ${k}` },
      geometry: [toLL(-36100, k * 1800), toLL(36100, k * 1800)] });
  els.push({ type: 'node', id: 800999, lat: LAT0, lon: LON0, tags: { place: 'city', name: 'Beograd' } });
  return { elements: els };
}

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill(json(SKEL ? arterials() : { elements: [] }));
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)))
    return r.fulfill(json({ elements: [] }));
  const bb = bboxOf(q);
  return r.fulfill(json(bb ? tileStreets(bb) : { elements: [] }));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

/* Mask agreement over every drivable road currently in the world, restricted to
   the area around the car so it stays a fair sample as tiles come and go. */
const coverage = () => p.evaluate(() => {
  const px = window.__p().x, py = window.__p().y;
  let ok = 0, bad = 0;
  const holes = [];
  for (const r of window.__roadList()) {
    if (!r.drive) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b2 = r.pts[i + 1];
      if (Math.abs(a.x - px) > 2500 || Math.abs(a.y - py) > 2500) continue;
      const len = Math.hypot(b2.x - a.x, b2.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 15));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b2.x - a.x) * t, y = a.y + (b2.y - a.y) * t;
        if (window.__onRoad(x, y)) ok++;
        else { bad++; if (holes.length < 4) holes.push({ name: r.name, x: Math.round(x), y: Math.round(y) }); }
      }
    }
  }
  return { ok, bad, pct: +(bad / (ok + bad) * 100).toFixed(1), holes,
           bounds: window.__chunks().bounds, live: window.__chunks().live };
});

const out = { mode: SKEL ? 'skeleton' : 'fallback' };
out.atStart = await coverage();

// drive east a long way, so the world grows and the mask is rebuilt repeatedly
out.drive = await p.evaluate(() => new Promise(res => {
  window.__tp(0, 0, 0);
  const t0 = performance.now();
  let frames = 0, off = 0;
  const tick = () => {
    window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
    const q = window.__p();
    frames++; if (!q.onRoad) off++;
    if (performance.now() - t0 < 30000) requestAnimationFrame(tick);
    else { window.__setInput(null); res({ offPct: +(off / frames * 100).toFixed(1), x: Math.round(q.x), kmh: Math.round(q.spd * 3.6) }); }
  };
  requestAnimationFrame(tick);
}));
out.afterDrive = await coverage();

out.errs = errs.slice(0, 4);
out.maskHeld = out.afterDrive.pct < 2 && out.drive.offPct < 10;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.maskHeld ? 0 : 1);
