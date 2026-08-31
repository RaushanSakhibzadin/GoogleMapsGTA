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

/* A CLEAN SLATE BEFORE EVERY GESTURE. A ring still up from the last one is
   JOINED by the next finger rather than re-anchored — correct behaviour for a
   thumb that never left the glass, and wrong for a test that means each of
   these to be a separate press. Without it every reading after the first was
   taken against an anchor from two gestures earlier, which showed up as a
   stick that suddenly did not steer. */
const reset = async () => { await p.evaluate(() => stickRelease()); await p.waitForTimeout(40); };

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
  await reset();
  await down(x, y);
  await p.waitForTimeout(80);
  const s = await p.evaluate(() => window.__stick());
  await up();
  await p.waitForTimeout(60);
  return s;
};
out.left = await anchorAt(Math.round(vp.width * .22), Math.round(vp.height * .74));
out.right = await anchorAt(Math.round(vp.width * .78), Math.round(vp.height * .74));
/* Read off the ring for the side that was touched: the hook reports the two
   sticks separately now, and the top-level numbers are the AVERAGE the car is
   handed rather than either ring's own position. */
out.eitherHand =
  out.left.on && out.right.on &&
  Math.abs(out.left.L.cx - vp.width * .22) < 3 && Math.abs(out.right.R.cx - vp.width * .78) < 3 &&
  out.left.shown && out.right.shown;

/* ---- 3. steering is analogue, and signed the right way ---- */
/* The pads could only ever be full lock. Half a ring of travel has to give
   about half the lock, or this is four buttons drawn as a circle. */
const cx = Math.round(vp.width * .3), cy = Math.round(vp.height * .74);
/* MEASURED WHILE IT IS UP. The ring is display:none until a thumb is down, and
   a hidden element measures zero — the first version of this read 0 here and
   then pushed the knob zero pixels in every direction, which reported a stick
   that did not steer, drive or drift. */
await reset();
await down(cx, cy);
await p.waitForTimeout(80);
const R = await p.evaluate(() => document.getElementById('stickL').offsetWidth / 2);
await up();
await p.waitForTimeout(60);
out.ringPx = Math.round(R);
const push = async (ddx, ddy, ms = 120) => {
  await reset();
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
  Math.abs(out.full.L.dx) <= out.ringPx + 1;        // the knob stays in its ring

/* ---- 4. up is go, down is brake ---- */
out.up = await push(0, -Math.round(R * .8));
out.down = await push(0, Math.round(R * .8), 300);
out.upIsGo = out.up.gas === 1 && out.up.brake === 0 && out.down.brake === 1 && out.down.gas === 0;

/* ---- 5. a FAST flick down is the handbrake; easing down is not ---- */
/* The reported request, and the one place where the same finishing position has
   to mean two different things — so the test has to distinguish them by speed
   alone, which means both gestures end at the same place. */
const flick = async steps => {
  await reset();
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
await reset();
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

/* ---- 8. and the switch is REACHABLE ON A PHONE, mid-game ---- */
/* Reported: "I cannot find a settings button and how to return previous
   controller type". The switch existed in two places and neither was reachable
   from a phone in play — the menu is the start screen, gone once you press GO,
   and the pause card is bound to Escape, which a phone does not have. So this
   does not check that a button exists; it checks that a THUMB can get to it
   from a running game and that pressing it brings the pads back. */
await p.evaluate(() => window.__ctrl('stick'));
out.reach = {};
out.reach.state = await p.evaluate(() => window.__s());
await p.tap('#mixBtn');                       // the one panel a phone can open
await p.waitForTimeout(300);
out.reach.panelOpen = await p.evaluate(() =>
  !document.getElementById('mix').classList.contains('hide'));
out.reach.switchVisible = await p.evaluate(() => {
  const el = document.getElementById('ctrlX');
  if (!el) return false;
  const b = el.getBoundingClientRect();
  const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return b.width > 0 && b.height > 0 && b.bottom <= innerHeight &&
         !!top && (top === el || el.contains(top));
});
/* Guarded, so a build without the switch FAILS here rather than hanging thirty
   seconds on a locator that will never appear and then throwing — which is how
   the first version of this reported the very bug it was written for. */
out.reach.exists = await p.locator('#ctrlX').count() > 0;
if (out.reach.exists) { await p.tap('#ctrlX'); await p.waitForTimeout(300); }
out.reach.after = await p.evaluate(() => window.__stick());
if (out.reach.panelOpen) await p.tap('#mixDone');
await p.waitForTimeout(200);
out.reach.stillPlaying = await p.evaluate(() => window.__s());
out.switchReachable =
  out.reach.state === 'play' && out.reach.panelOpen && out.reach.exists && out.reach.switchVisible &&
  out.reach.after.ctrl === 'pads' && out.reach.after.padsShown === true &&
  out.reach.stillPlaying === 'play';
await p.evaluate(() => window.__ctrl('stick'));

/* ---- 8b. and a tap anywhere else puts the settings away ---- */
/* Asked for. Three things have to hold at once and only the first is obvious:
   it closes; the tap does NOT also plant a joystick, because the panel does not
   pause the game and a dismissing tap that drove the car would be worse than no
   dismissal at all; and a tap INSIDE the panel leaves it alone, or the sliders
   would shut it the moment they were touched. */
out.dismiss = {};
await p.evaluate(() => window.__ctrl('stick'));
await p.tap('#mixBtn');
await p.waitForTimeout(250);
out.dismiss.opened = await p.evaluate(() => !document.getElementById('mix').classList.contains('hide'));
// a tap inside must NOT close it
await p.tap('#mixSfx');
await p.waitForTimeout(200);
out.dismiss.survivesInsideTap = await p.evaluate(() =>
  !document.getElementById('mix').classList.contains('hide'));
// and one outside must
const oy = Math.round(vp.height * .8), ox = Math.round(vp.width * .5);
await down(ox, oy);
await p.waitForTimeout(120);
out.dismiss.stickRaised = await p.evaluate(() => window.__stick().live);
out.dismiss.closed = await p.evaluate(() => document.getElementById('mix').classList.contains('hide'));
await up();
await p.waitForTimeout(120);
out.dismiss.stillPlaying = await p.evaluate(() => window.__s());
out.tapAwayCloses =
  out.dismiss.opened && out.dismiss.survivesInsideTap && out.dismiss.closed &&
  // the dismissing tap did not become a joystick
  out.dismiss.stickRaised === 0 && out.dismiss.stillPlaying === 'play';

out.errs = errs.slice(0, 4);
out.pass = out.byDefault.ctrl === 'stick' && out.byDefault.padsShown === false &&
           out.eitherHand && out.analogue && out.upIsGo && out.flickDrifts &&
           out.itDrives && out.padsBack && out.noStickInPads && out.settingSticks &&
           out.switchReachable && out.tapAwayCloses &&
           out.backToStick.ctrl === 'stick' && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
