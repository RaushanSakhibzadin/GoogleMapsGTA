/* THE ON-SCREEN STICK.
 *
 * Asked for: a joystick as the default touch control, the old pads still
 * available in the settings, usable with either hand, and a fast downward flick
 * for the handbrake.
 *
 * DRIVEN WITH REAL TOUCHES, through CDP's Input.dispatchTouchEvent, because
 * every part of this lives in the touch pipeline: where the ring anchors, which
 * finger owns it, what preventDefault does to the taps around it. Calling the
 * handlers directly would test the arithmetic and skip the thing that has
 * already broken once this week — a control that only answers when the test
 * calls it is not a control, which is exactly how the map's centre button
 * passed through its own bug.
 *
 * Usage: node tests/stick.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
let id = 1;
const streets = () => ({ elements: [
  ...[-2, -1, 0, 1, 2].map(k => ({ type: 'way', id: id++,
    tags: { highway: k ? 'residential' : 'secondary', name: `EW ${k}` },
    geometry: [toLL(-1200, k * 160), toLL(1200, k * 160)] })),
  ...[-2, -1, 0, 1, 2].map(k => ({ type: 'way', id: id++,
    tags: { highway: 'residential', name: `NS ${k}` },
    geometry: [toLL(k * 160, -1200), toLL(k * 160, 1200)] })),
  { type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Blok' } }
] });

const br = await chromium.launch({ executablePath: CHROME });
const ctx = await br.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Blok' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (/motorway/.test(q) && !/residential/.test(q)) return r.fulfill(json({ elements: [] }));
  if (/"building"/.test(q)) return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(700);

/* A finger, in the only way a headless browser has one. Playwright's touchscreen
   API taps; it cannot hold and drag a touch, which is the whole gesture here. */
const cdp = await ctx.newCDPSession(p);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
});
const down = (x, y) => touch('touchStart', x, y);
const move = (x, y) => touch('touchMove', x, y);
const up = () => touch('touchEnd', 0, 0);

const out = {};
const vp = p.viewportSize();
out.viewport = vp;

/* ---- 1. it is the default, and the pads are not on screen ---- */
out.byDefault = await p.evaluate(() => window.__stick());

/* ---- 2. it anchors where the thumb lands, on EITHER side ---- */
/* The request was "on any side of the screen so it's easy to rule by right and
   by left hand". There is no setting for that and there should not be: the ring
   is drawn at the thumb, so the side you touch IS the side it appears on. */
const anchorAt = async (x, y) => {
  await down(x, y);
  await p.waitForTimeout(80);
  const s = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(60);
  return s;
};
out.left = await anchorAt(Math.round(vp.width * .22), Math.round(vp.height * .74));
out.right = await anchorAt(Math.round(vp.width * .78), Math.round(vp.height * .74));
out.eitherHand =
  out.left.on && out.right.on &&
  Math.abs(out.left.cx - vp.width * .22) < 3 && Math.abs(out.right.cx - vp.width * .78) < 3 &&
  out.left.shown && out.right.shown;

/* ---- 3. steering is analogue, and signed the right way ---- */
/* The pads could only ever be full lock. Half a ring of travel has to give
   about half the lock, or this is four buttons drawn as a circle. */
const cx = Math.round(vp.width * .3), cy = Math.round(vp.height * .74);
/* MEASURED WHILE IT IS UP. The ring is display:none until a thumb is down, and
   a hidden element measures zero — the first version of this read 0 here and
   then pushed the knob zero pixels in every direction, which reported a stick
   that did not steer, drive or drift. */
await down(cx, cy);
await p.waitForTimeout(80);
const R = await p.evaluate(() => document.getElementById('stick').offsetWidth / 2);
await up();
await p.waitForTimeout(60);
out.ringPx = Math.round(R);
const push = async (ddx, ddy, ms = 120) => {
  await down(cx, cy);
  await p.waitForTimeout(40);
  await move(cx + ddx, cy + ddy);
  await p.waitForTimeout(ms);
  const s = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(60);
  return s;
};
out.half = await push(Math.round(R * .5), 0);
out.full = await push(Math.round(R * 1.6), 0);      // past the ring: clamped
out.leftLock = await push(-Math.round(R * 1.6), 0);
out.analogue =
  out.half.steer > .2 && out.half.steer < .75 &&    // partial, not full
  out.full.steer > .9 && out.leftLock.steer < -.9 &&
  Math.abs(out.full.dx) <= out.ringPx + 1;          // the knob stays in its ring

/* ---- 4. up is go, down is brake ---- */
out.up = await push(0, -Math.round(R * .8));
out.down = await push(0, Math.round(R * .8), 300);
out.upIsGo = out.up.gas === 1 && out.up.brake === 0 && out.down.brake === 1 && out.down.gas === 0;

/* ---- 5. a FAST flick down is the handbrake; easing down is not ---- */
/* The reported request, and the one place where the same finishing position has
   to mean two different things — so the test has to distinguish them by speed
   alone, which means both gestures end at the same place. */
const flick = async steps => {
  await down(cx, cy);
  await p.waitForTimeout(40);
  const far = Math.round(R * .9);
  for (let i = 1; i <= steps; i++) {
    await move(cx, cy + Math.round(far * i / steps));
    if (steps > 1) await p.waitForTimeout(90);      // slow: many small steps
  }
  await p.waitForTimeout(30);
  const s = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(60);
  return s;
};
out.flicked = await flick(1);          // one jump: fast
out.eased = await flick(8);            // eight steps over ~0.7 s: slow
out.flickDrifts = out.flicked.hand === 1 && out.eased.hand === 0;

/* ---- 6. and the car actually does it ---- */
/* The flags above are what the stick reports; this is the car answering. Held
   at full lock with the throttle down, the heading has to change. */
out.drove = await p.evaluate(() => ({ h0: window.__p().h }));
await down(cx, cy);
await p.waitForTimeout(40);
await move(cx + Math.round(R * 1.2), cy - Math.round(R * .9));
await p.waitForTimeout(1600);
out.drove.h1 = await p.evaluate(() => window.__p().h);
out.drove.kmh = await p.evaluate(() => Math.round(window.__p().spd * 3.6));
await up();
const dh = Math.abs(((out.drove.h1 - out.drove.h0 + Math.PI) % (2 * Math.PI)) - Math.PI);
out.drove.turnedDeg = +(dh * 180 / Math.PI).toFixed(1);
out.itDrives = out.drove.kmh > 12 && out.drove.turnedDeg > 12;

/* ---- 7. the setting brings the pads back, and it sticks ---- */
out.toPads = await p.evaluate(() => { window.__ctrl('pads'); return window.__stick(); });
out.padsBack = out.toPads.ctrl === 'pads' && out.toPads.padsShown === true;
// and a touch in the play area no longer raises a ring
await down(cx, cy);
await p.waitForTimeout(80);
out.noStickInPads = await p.evaluate(() => window.__stick().on === false);
await up();
// it survives a reload, because a preference that forgets is not a preference
await p.reload();
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);
out.afterReload = await p.evaluate(() => window.__stick());
out.settingSticks = out.afterReload.ctrl === 'pads' && out.afterReload.padsShown === true;
// and back again
out.backToStick = await p.evaluate(() => { window.__ctrl('stick'); return window.__stick(); });

out.errs = errs.slice(0, 4);
out.pass = out.byDefault.ctrl === 'stick' && out.byDefault.padsShown === false &&
           out.eitherHand && out.analogue && out.upIsGo && out.flickDrifts &&
           out.itDrives && out.padsBack && out.noStickInPads && out.settingSticks &&
           out.backToStick.ctrl === 'stick' && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
