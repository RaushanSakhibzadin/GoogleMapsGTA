/* The fence. W.minX..maxX is the edge of what has actually loaded, and fence()
   clamps the car to it every frame while reversing 30% of its velocity. Drive at
   it with the throttle down and the car is pinned: position rewritten, speed
   bouncing around a small number, map behind you and blackness ahead.

   That is what the report looks like — 14 km/h, throttle visibly held, roads on
   one side of the radar and nothing on the other. So: does driving into the edge
   of the loaded world actually pin the car, and does it recover?

   Usage: node fencepin.mjs [tileDelayMs]   — the delay is how slow the streaming
   is, i.e. how easily you outrun it on a real network. */
import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const DELAY = +(process.argv[2] || 0);
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const SKEL = process.argv[3] === 'skel';

/* An 18 km arterial skeleton, for the mode where the fence is a real world edge
   rather than the ragged border of whatever has streamed in. */
/* Roads run right out to the fence, at ±36100. They used to stop at ±17500,
   which left a 540 m off-road band inside the world edge — and now that off the
   tarmac is a crawl, the car could never build enough speed to reach the fence
   at all, so the edge warning had nothing to fire on. Overpass clips ways to the
   box it was asked for, so in a real city the arterials do reach the boundary;
   the short fixture was the unrealistic thing. */
function arterials() {
  const els = [];
  for (let k = -9; k <= 9; k++) {
    els.push({ type: 'way', id: 700000 + k + 20, tags: { highway: 'primary', name: `Radial ${k}` },
      geometry: [toLL(-36100, k * 1800), toLL(36100, k * 1800)] });
    els.push({ type: 'way', id: 700000 + k + 60, tags: { highway: 'primary', name: `Cross ${k}` },
      geometry: [toLL(k * 1800, -36100), toLL(k * 1800, 36100)] });
  }
  els.push({ type: 'node', id: 700999, lat: LAT0, lon: LON0, tags: { place: 'city', name: 'Krunski venac' } });
  return { elements: els };
}
const bboxOf = q => {
  const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null;
};

/* Roads for whatever tile is asked for, so streaming always has something to
   return and the only thing that can stop the car is the fence itself. Ids are
   derived from the tile so the dedupe doesn't swallow them. */
function tileStreets(bb) {
  const cy = (bb.s + bb.n) / 2, cx = (bb.w + bb.e) / 2;
  const y = (LAT0 - cy) * M_LAT, x = (cx - LON0) * M_LON;
  const gx = Math.round(x / 1800), gy = Math.round(y / 1800);
  const zig = n => n >= 0 ? n * 2 : -n * 2 - 1;
  const base = 1000 + (zig(gx) * 4096 + zig(gy)) * 8;
  const els = [];
  for (let i = -1; i <= 1; i++) {
    els.push({ type: 'way', id: base + i + 3,
      tags: { highway: i === 0 ? 'secondary' : 'residential', name: `EW ${gy}/${i}` },
      geometry: [toLL(gx * 1800 - 1200, gy * 1800 + i * 600), toLL(gx * 1800 + 1200, gy * 1800 + i * 600)] });
    els.push({ type: 'way', id: base + i + 6, tags: { highway: 'residential', name: `NS ${gx}/${i}` },
      geometry: [toLL(gx * 1800 + i * 600, gy * 1800 - 1200), toLL(gx * 1800 + i * 600, gy * 1800 + 1200)] });
  }
  els.push({ type: 'node', id: base + 2, lat: cy, lon: cx, tags: { place: 'suburb', name: `District ${gx}/${gy}` } });
  return { elements: els };
}

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill(json(SKEL ? arterials() : { elements: [] }));
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)))
    return r.fulfill(json({ elements: [] }));
  const bb = bboxOf(q);
  if (DELAY) await new Promise(res => setTimeout(res, DELAY));
  return r.fulfill(json(bb ? tileStreets(bb) : { elements: [] }));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

/* Every scenario below runs on the same page and inherits whatever the last one
   left behind — a dented car, a wanted level earned by clipping traffic, and the
   police that come with it. This test has failed three times on three different
   versions of that, none of them about the fence: a civilian parked in the lane,
   then cops shunting the car, then a wrecked car that could not build speed. So
   each scenario starts from the same clean state. */
const reset = () => p.evaluate(() => {
  for (let i = 0; i < 30; i++) window.__putTraffic(i, -9000 - i * 12, 9000, 0);
  for (let i = 0; i < 8; i++) window.__putCop(i, -9000 - i * 40, -9000, 0, 0, 0);
  window.__addWanted(-window.__p().wanted);
  window.__heal();
  /* and the edge warning's own cooldown. It is six seconds long and shared
     across scenarios, so whether the last one happened to fire it decided
     whether this one could — which is a coin toss, not a test. */
  window.__clearEdge();
});

const out = { tileDelayMs: DELAY, skel: await p.evaluate(() => window.__chunks().skel) };
out.bounds0 = await p.evaluate(() => window.__chunks().bounds);

/* 1. parked just inside the east fence, throttle down, driving straight at it */
await reset();
out.atTheFence = await p.evaluate(async () => {
  const bb = window.__chunks().bounds;
  window.__tp(bb.x1 - 60, 0, 0);                 // 60 m short of it, pointing east
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  const kmh = [];
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      if (kmh.length < 24 && (performance.now() - t0) / 250 > kmh.length)
        kmh.push(Math.round(window.__p().spd * 3.6));
      performance.now() - t0 < 6000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  const bb2 = window.__chunks().bounds;
  return { endKmh: Math.round(q.spd * 3.6), kmh,
           x: Math.round(q.x), fenceWas: Math.round(bb.x1), fenceNow: Math.round(bb2.x1),
           gapToFence: Math.round(bb2.x1 - q.x), fenceMoved: bb2.x1 > bb.x1 + 1 };
});

/* 2. the same, but driving AWAY — has to be free immediately, or the pin is
      something other than the fence */
await reset();
out.awayFromFence = await p.evaluate(async () => {
  const bb = window.__chunks().bounds;
  window.__tp(bb.x1 - 60, 0, Math.PI);
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      performance.now() - t0 < 4000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { endKmh: Math.round(q.spd * 3.6), x: Math.round(q.x), y: Math.round(q.y),
           onRoad: q.onRoad, penalty: window.__onRoadPenalty(q.x, q.y),
           startOnRoad: window.__onRoad(bb.x1 - 60, 0) };
});

/* 3. the honest version: just drive east from the start and see what happens
      when you outrun the streaming */
await reset();
out.driveOut = await p.evaluate(async () => {
  window.__tp(0, 0, 0);
  const t0 = performance.now();
  const samples = [];
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      if (samples.length < 20 && (performance.now() - t0) / 1000 > samples.length) {
        const q = window.__p(), c = window.__chunks();
        samples.push({ s: samples.length, kmh: Math.round(q.spd * 3.6), x: Math.round(q.x),
                       fence: Math.round(c.bounds.x1), busy: c.busy, live: c.live });
      }
      performance.now() - t0 < 20000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  return samples;
});
// after the opening second, nothing should ever drop the car back to a crawl
out.pinnedWhileDriving = out.driveOut.filter(s => s.s > 1 && s.kmh < 60);

/* 4. The genuine world edge, in skeleton mode: 18 km out there is nothing left
      to stream and the fence is real. It still has to stop the car — but it must
      SAY so, because a silent stop with the throttle down is the bug all over
      again wearing a different hat. */
if (SKEL) {
  await reset();
  out.realEdge = await p.evaluate(async () => {
    const bb = window.__chunks().bounds;
    window.__tp(bb.x1 - 90, 0, 0);
    document.getElementById('toast').textContent = '';
    const hits0 = window.__edge().hits;
    await new Promise(r => requestAnimationFrame(r));
    const t0 = performance.now();
    let seen = '';
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        const t = document.getElementById('toast').textContent;
        if (t) seen = t;
        performance.now() - t0 < 6000 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    window.__setInput(null);
    const bb2 = window.__chunks().bounds;
    return { toast: seen, edge: window.__edge(), held: Math.round(window.__p().spd * 3.6),
             fenceHeld: Math.round(bb2.x1) === Math.round(bb.x1), fence: Math.round(bb2.x1) };
  });
  // the 18 km world must stay 18 km — reserving ahead must not push it outwards
  out.realEdge.worldStayedBounded = out.realEdge.fenceHeld;
  out.realEdge.warned = /EDGE OF THE MAP/.test(out.realEdge.toast);
}

await p.screenshot({ path: `${OUT}/shot-fence-${SKEL ? 'skel' : DELAY}.png` });
out.errs = errs.slice(0, 4);
/* In skeleton mode 18 km out IS the end of the world and pinning there is
   correct — what matters is that it says so. Without a skeleton there is always
   more to stream, so nothing should ever hold the car at all. */
out.pass = (SKEL ? out.realEdge.warned && out.realEdge.worldStayedBounded
                 : out.atTheFence.endKmh > 60 && !out.pinnedWhileDriving.length) &&
           out.awayFromFence.endKmh > 60 &&
           !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
