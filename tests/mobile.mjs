/* "It stuck / car almost do not move" — 14 km/h with the throttle down, on a
   phone. Every handling test so far drives through __setInput and a 60 fps
   headless loop, which skips the two things only a phone has: the touch pads,
   and a frame rate slow enough to matter. So this one presses the real ▲ with a
   real finger, on a real iPhone profile, with the CPU throttled.

   Usage: node mobile.mjs [cpuThrottleRate]   (1 = no throttle) */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const RATE = +(process.argv[2] || 1);
const LAT0 = 44.8069, LON0 = 20.4735;                      // Krunski venac, Belgrade
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);

let id = 1;
const streets = () => {
  const els = [];
  for (const y of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: y === 0 ? 'secondary' : 'residential', name: `EW ${y}` },
      geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
      geometry: [toLL(x, -900), toLL(x, 900)] });
  els.push({ type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } });
  return { elements: els };
};

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'] });      // hasTouch, isMobile
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (/"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)) || isArterials(q))
    return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});

const cdp = await ctx.newCDPSession(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);
if (RATE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });

const out = { cpuThrottle: RATE };

const centre = async sel => {
  const box = await p.locator(sel).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/* A finger that goes down and STAYS down — page.tap() lifts it again, which is
   the one thing a player holding the throttle never does.

   Ids are explicit and passed by the caller. CDP takes the RELEASED points on a
   touchEnd, not the surviving ones, so an implicit id-by-position numbering
   quietly lifts the wrong finger — which is exactly the mistake that made the
   first version of this test "reproduce" a bug that was only ever my own. */
const finger = async (pts, type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const at = (q, id) => ({ x: q.x, y: q.y, id });

const gas = await centre('#tA');
const drift = await centre('#tH');
const left = await centre('#tL');

async function run(label, body) {
  await p.evaluate(() => { window.__tp(-600, 0, 0); });
  await p.waitForTimeout(120);
  const t0 = Date.now();
  const samples = [];
  const poll = setInterval(async () => {
    try { samples.push(await p.evaluate(() => ({ kmh: Math.round(window.__p().spd * 3.6), x: +window.__p().x.toFixed(0) }))); }
    catch (e) {}
  }, 250);
  await body();
  clearInterval(poll);
  await p.waitForTimeout(60);
  const q = await p.evaluate(() => window.__p());
  const act = await p.evaluate(() => $('tA').classList.contains('act'));
  return { label, secs: +((Date.now() - t0) / 1000).toFixed(1),
           endKmh: Math.round(q.spd * 3.6), movedM: +(q.x + 600).toFixed(0),
           gasLooksPressed: act,
           kmh: samples.map(s => s.kmh) };
}

/* 1. the plain thing: one finger on the throttle, held for five seconds */
out.holdGas = await run('hold ▲ only', async () => {
  await finger([at(gas, 1)], 'touchStart');
  await p.waitForTimeout(5000);
  await finger([at(gas, 1)], 'touchEnd');
});

/* 2 and 3 steer and drift, which puts the car on the grass — and off the road
   the car is now meant to crawl, so end speed says nothing about whether the
   throttle survived. What answers that directly is the pad state itself while
   the finger is still down, sampled before anything is lifted. */
const gasHeldNow = () => p.evaluate(() => window.__touch().a);

/* 2. what a player actually does: throttle held throughout, a SECOND finger
      steers and then lifts. Only finger 2 is released. */
out.gasThenSteer = await run('hold ▲, add and lift ◀', async () => {
  await finger([at(gas, 1)], 'touchStart');
  await p.waitForTimeout(1500);
  await finger([at(gas, 1), at(left, 2)], 'touchStart');
  await p.waitForTimeout(1500);
  await finger([at(left, 2)], 'touchEnd');      // the steer finger only
  await p.waitForTimeout(2000);
  out.gasSurvivedSteer = await gasHeldNow();    // finger 1 is still on the glass
  await finger([at(gas, 1)], 'touchEnd');
});
out.gasReleasedAfterSteer = await gasHeldNow();

/* 3. throttle held, DRIFT tapped with the other thumb */
out.gasThenDrift = await run('hold ▲, tap DRIFT', async () => {
  await finger([at(gas, 1)], 'touchStart');
  await p.waitForTimeout(1500);
  await finger([at(gas, 1), at(drift, 2)], 'touchStart');
  await p.waitForTimeout(200);
  await finger([at(drift, 2)], 'touchEnd');
  await p.waitForTimeout(3000);
  out.gasSurvivedDrift = await gasHeldNow();
  await finger([at(gas, 1)], 'touchEnd');
});
out.gasReleasedAfterDrift = await gasHeldNow();

/* 4. the finger drifts a few pixels while holding, as thumbs do */
out.gasThenSlide = await run('hold ▲ and slide the thumb', async () => {
  await finger([at(gas, 1)], 'touchStart');
  await p.waitForTimeout(1200);
  for (let i = 1; i <= 8; i++) {
    await finger([{ x: gas.x - i * 3, y: gas.y - i * 2, id: 1 }], 'touchMove');
    await p.waitForTimeout(60);
  }
  await p.waitForTimeout(3000);
  await finger([{ x: gas.x - 24, y: gas.y - 16, id: 1 }], 'touchEnd');
});

/* 5. iOS cancels touches it decides belong to a system gesture — the finger is
      still on the glass, but the browser has taken it away. Nothing puts the
      throttle back, because no new touchstart is ever coming. */
out.gasCancelled = await run('hold ▲, browser cancels the touch', async () => {
  await finger([at(gas, 1)], 'touchStart');
  await p.waitForTimeout(1500);
  await finger([], 'touchCancel');             // CDP: a cancel carries no points
  await p.waitForTimeout(3000);
});

/* 6. A cancel that takes ONE finger of two. CDP can only cancel the lot, so
      this is dispatched at the DOM level — which is the level the handler works
      at anyway. The old code cleared whichever pad the event was delivered to
      and nothing else could put it back; reading the live touch list instead,
      the throttle survives because the throttle finger is still in it. */
out.partialCancel = await p.evaluate(async ([gas, left]) => {
  const mk = (q, id) => new Touch({ identifier: id, target: document.body,
                                    clientX: q.x, clientY: q.y });
  const g = mk(gas, 1), l = mk(left, 2);
  const fire = (type, touches, changed) => document.dispatchEvent(
    new TouchEvent(type, { touches, changedTouches: changed, bubbles: true, cancelable: true }));
  fire('touchstart', [g], [g]);
  fire('touchstart', [g, l], [l]);
  const both = { ...window.__touch() };
  fire('touchcancel', [g], [l]);          // the steering finger is taken away
  const after = { ...window.__touch() };
  fire('touchend', [], [g]);
  return { both, after, gasSurvived: after.a === 1, steerCleared: after.l === 0 };
}, [gas, left]);

/* 7. A touchend that never arrives — a pad left latched on with no finger on it.
      The next touch event of any kind has to correct it. */
out.missedEnd = await p.evaluate(async ([gas, left]) => {
  const mk = (q, id) => new Touch({ identifier: id, target: document.body,
                                    clientX: q.x, clientY: q.y });
  const g = mk(gas, 1), l = mk(left, 2);
  const fire = (type, touches, changed) => document.dispatchEvent(
    new TouchEvent(type, { touches, changedTouches: changed, bubbles: true, cancelable: true }));
  fire('touchstart', [l], [l]);
  const stuck = { ...window.__touch() };
  fire('touchstart', [g], [g]);            // left's end was lost; only gas is live
  const healed = { ...window.__touch() };
  fire('touchend', [], [g]);
  const clear = { ...window.__touch() };
  return { stuck, healed, clear, selfHealed: healed.l === 0 && healed.a === 1,
           released: clear.a === 0 };
}, [gas, left]);

/* 8. The pads must clear the strips a phone keeps for its own gestures — the
      swipe-back gutters down each side and the home indicator along the bottom.
      A touch that starts in there can be confiscated mid-press. */
out.padEdges = await p.evaluate(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = {};
  for (const id of ['tL', 'tR', 'tA', 'tB', 'tH', 'tN']) {
    const r = document.getElementById(id).getBoundingClientRect();
    out[id] = { left: Math.round(r.left), right: Math.round(vw - r.right),
                bottom: Math.round(vh - r.bottom) };
  }
  return out;
});
out.padsClearOfGestureStrips = Object.values(out.padEdges)
  .every(e => Math.min(e.left, e.right) >= 20 && e.bottom >= 20);

/* 5. and the loop itself: how much game time a real second buys */
out.clock = await p.evaluate(() => new Promise(res => {
  const g0 = window.__gameClock ? window.__gameClock() : null;
  const t0 = performance.now();
  let frames = 0;
  const tick = () => { frames++; performance.now() - t0 < 3000 ? requestAnimationFrame(tick) : res({
    fps: Math.round(frames / ((performance.now() - t0) / 1000)),
    steps: window.__perf ? window.__perf().steps : null,
    upd: window.__perf ? window.__perf().upd : null,
    ren: window.__perf ? window.__perf().ren : null,
  }); };
  requestAnimationFrame(tick);
}));
// 60 fps of game time needs fps*steps === 60; below that the world is in slow motion
out.gameSecondsPerRealSecond = +((out.clock.fps * out.clock.steps) / 60).toFixed(2);

await p.screenshot({ path: `${OUT}/shot-mobile-${RATE}.png` });
out.errs = errs.slice(0, 5);
/* The two-finger runs end slow on purpose — steering and drifting put the car
   on the grass, where it is now meant to crawl. So they are judged on the pad
   state with the finger still down, not on the speedo. Runs 1 and 4 never leave
   the road, so those still have to reach the top of the clock. */
/* 240, not 300. What these two runs prove is that a held finger keeps pulling
   for five seconds — how far up the clock it gets in that time depends on how
   busy the machine is, and running the whole suite at once it came in at exactly
   300 against a >300 bar. The actual top speed is asserted by render.mjs, which
   is the right place for it. */
out.pass = out.holdGas.endKmh > 240 &&
           out.gasSurvivedSteer === 1 && out.gasReleasedAfterSteer === 0 &&
           out.gasSurvivedDrift === 1 && out.gasReleasedAfterDrift === 0 &&
           out.gasThenSlide.endKmh > 240 &&
           out.partialCancel.gasSurvived && out.partialCancel.steerCleared &&
           out.missedEnd.selfHealed && out.missedEnd.released &&
           out.padsClearOfGestureStrips &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
