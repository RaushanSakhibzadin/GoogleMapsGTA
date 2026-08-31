/* TWO STICKS AT ONCE, AND THE AVERAGE OF THEM.
 *
 * Asked for: "make it possible to rule two hands simultaneously, it should get
 * the average of two controllers, one on the left, the other on the right".
 *
 * ITS OWN FILE, on a fresh page and a fresh CDP session, and that is not
 * tidiness. Driven at the end of stick.mjs these same gestures reported zero:
 * that file reloads the page in its settings section and leaves touches behind
 * in its earlier ones, and after either, a touchStart still lands while a
 * touchMove goes nowhere. The measurement was of the plumbing, not the game.
 * A page that has done nothing else is the only way this means anything.
 *
 * DRIVEN WITH REAL TOUCHES, through CDP's Input.dispatchTouchEvent, because
 * every part of this lives in the touch pipeline: where the ring anchors, which
 * finger owns it, what preventDefault does to the taps around it. Calling the
 * handlers directly would test the arithmetic and skip the thing that has
 * already broken once this week — a control that only answers when the test
 * calls it is not a control, which is exactly how the map's centre button
 * passed through its own bug.
 *
 * Usage: node tests/stick2.mjs [GAME=/path/to/index.html]
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
const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const down = (x, y) => send('touchStart', [{ x, y, id: 1 }]);
const move = (x, y) => send('touchMove', [{ x, y, id: 1 }]);
/* LIFTING BOTH, WHICH TAKES MORE THAN ONE EVENT. A touchEnd with an empty list
   ends ONE point: after a two-finger gesture the second stick stayed live and
   every later reading was the mean of a real thumb and a ghost. The game is
   right to keep it — each stick follows its own finger and drops when that
   finger goes, which is what a hand does — so it is the release that has to be
   honest about how many fingers are down. */
const up = async () => {
  for (let i = 0; i < 4; i++) {
    // CDP refuses a touchEnd with nothing down, which is the normal way out of
    // this loop after the last finger has gone
    try { await send('touchEnd', []); } catch { return; }
    await p.waitForTimeout(30);
    if (await p.evaluate(() => window.__stick().live === 0)) return;
  }
};
/* TWO FINGERS, which is the whole of section 9. CDP wants the full live list on
   every event, so both points are sent each time and a lift is the remaining
   one — not an empty list, which would drop both. */
const down2 = (a, b) => send('touchStart', [{ x: a[0], y: a[1], id: 1 }, { x: b[0], y: b[1], id: 2 }]);
const move2 = (a, b) => send('touchMove', [{ x: a[0], y: a[1], id: 1 }, { x: b[0], y: b[1], id: 2 }]);

const out = {};
const vp = p.viewportSize();
out.viewport = vp;
const cx = Math.round(vp.width * .3), cy = Math.round(vp.height * .74);
/* Measured while a ring is actually up: hidden, it measures zero. */
await down(cx, cy);
await p.waitForTimeout(80);
const R = await p.evaluate(() => {
  const el = document.getElementById('stickL') || document.getElementById('stick');
  return el ? el.offsetWidth / 2 : 0;
});
await up();
await p.waitForTimeout(60);
out.ringPx = Math.round(R);
const push = async (ddx, ddy, ms = 140) => {
  await down(cx, cy);
  await p.waitForTimeout(40);
  await move(cx + ddx, cy + ddy);
  await p.waitForTimeout(ms);
  const s = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(60);
  return s;
};

/* ---- 1. two hands at once, and the car takes the average ---- */
/* Run BEFORE section 7, which reloads the page: the CDP session that supplies
 * these touches predates that reload, and after it a touchStart still lands but
 * a touchMove goes nowhere — every reading came back zero while the same
 * gesture measured correctly on a fresh page.
 *
 * Asked for: "make it possible to rule two hands simultaneously, it should get
   the average of two controllers, one on the left, the other on the right".
 *
 * THE AVERAGE IS THE CLAIM, so it is measured rather than implied: both thumbs
 * are put down in known places and the steer the CAR is handed is compared with
 * the mean of what the two rings report. Two sticks that both worked but where
 * the last one to move won would satisfy "two hands" and fail this.
 *
 * OPPOSITE LOCKS ARE THE SHARP CASE. Full right on one and full left on the
 * other has to come out at zero — a rule that took the newest, or the largest,
 * or either particular side, gives ±1 there and cannot be told from averaging
 * by any test where both hands agree. */
const lx = Math.round(vp.width * .25), rx = Math.round(vp.width * .75);
const yy = Math.round(vp.height * .74);
const bothAt = async (ldx, rdx, ldy = 0, rdy = 0) => {
  /* A CLEAN SLATE FIRST. A ring that is still up from the previous gesture is
     re-used rather than re-anchored — the finger joins the existing stick — and
     the first version of this then measured an anchor from two gestures ago.
     The steering was right all along; the staging was not. */
  // guarded: a single-stick build has no stickRelease, and this section must
  // FAIL there rather than throw — a crash is not a finding
  await p.evaluate(() => { if (typeof stickRelease === 'function') stickRelease(); });
  await p.waitForTimeout(40);
  await down2([lx, yy], [rx, yy]);
  await p.waitForTimeout(60);
  await move2([lx + ldx, yy + ldy], [rx + rdx, yy + rdy]);
  await p.waitForTimeout(140);
  const st = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(80);
  return st;
};
const RR = Math.round(R);
out.bothFull      = await bothAt(RR * 1.5, RR * 1.5);      // both hard right
out.oneEach       = await bothAt(-RR * 1.5, RR * 1.5);     // opposite locks
out.halfAndFull   = await bothAt(Math.round(RR * .5), RR * 1.5);
out.twoHands =
  // both rings really are up, one per side, and on the side they were touched
  out.bothFull.live === 2 && !!out.bothFull.L && !!out.bothFull.R &&
  out.bothFull.L.on && out.bothFull.R.on &&
  /* ON THE RIGHT SIDES, which is the requirement — "one on the left, the other
     on the right". Asserted as sides rather than as exact anchor pixels: where
     a ring lands under a thumb is stick.mjs's eitherHand section, and pinning
     the pixel here failed on a ring that was legitimately still up from the
     gesture before. */
  out.bothFull.L.cx < vp.width / 2 && out.bothFull.R.cx > vp.width / 2 &&
  // agreeing hands: the mean is that lock
  out.bothFull.steer > .9 &&
  // disagreeing hands: the mean is nothing, which only averaging produces
  Math.abs(out.oneEach.steer) < .12 &&
  !!out.oneEach.L && Math.abs(out.oneEach.L.steer + out.oneEach.R.steer) < .12 &&
  // and the general case is the arithmetic mean of the two rings
  !!out.halfAndFull.L && Math.abs(out.halfAndFull.steer -
           (out.halfAndFull.L.steer + out.halfAndFull.R.steer) / 2) < .02 &&
  out.halfAndFull.steer > .5 && out.halfAndFull.steer < .95;

/* ---- 2. one hand still drives the car on its own ---- */
/* The mean of one number is that number, and a two-stick rig that quietly
   halved a single thumb's lock would be a regression for everyone playing
   one-handed — which is how it shipped this morning. */
out.leftAlone = await push(-Math.round(R * 1.6), 0);
out.oneHandUndiminished = out.leftAlone.live === 1 && out.leftAlone.steer < -.9;

out.errs = errs.slice(0, 4);
out.singleStickBuild = out.ringPx === 0 || !out.bothFull.L;
out.pass = out.twoHands && out.oneHandUndiminished && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
