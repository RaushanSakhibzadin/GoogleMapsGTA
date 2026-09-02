/* A BUTTON HAS TO ANSWER A THUMB, AND A THUMB IS NOT A MOUSE.

   Reported: "some UI buttons cannot be pressed after joysticks were added —
   maybe it is because fingers slide a little bit". Both halves of that are
   right, and they are two separate faults in the same place: WHEN the touch
   handler calls preventDefault. preventDefault on touchstart or touchmove is
   what stops the browser ever synthesising the click, so a handler that claims
   an event too eagerly does not fight the button — it deletes it.

   FAULT ONE, WHICH IS THE ONE THE REPORT NAMES. A stick could be raised on
   touchmove. The zone test runs against wherever the finger IS, so a tap that
   lands on a button and drifts four pixels off it mid-press finds open ground,
   raises a stick, claims the event and cancels the click. A press is a gesture
   that begins somewhere; the ring is drawn where the thumb LANDS, and nowhere
   in the design does a stick start halfway through a movement.

   FAULT TWO, WHICH IS WORSE AND WAS NOT REPORTED, probably because it reads as
   the same thing. While any stick was held, EVERY touch event was claimed —
   the live-stick loop set the flag whatever finger the event was about. So a
   second finger pressing a button while the first is steering had its
   touchstart cancelled by the first finger's presence. Driving with one thumb
   and pressing anything with the other could not work at all.

   The rule both fixes share: an event belongs to the driving controls only if
   one of the fingers THAT CHANGED IN IT is theirs.

   MEASURED ON REAL TOUCHES, through CDP's Input.dispatchTouchEvent, because
   every part of this is in the touch pipeline — Playwright's touchscreen API
   taps and cannot hold a finger down while another one presses. Calling the
   handlers directly would test the arithmetic and skip the entire mechanism.

   Usage: node tests/tapthru.mjs
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

const bad = [];
const need = (cond, msg) => { if (!cond) bad.push(msg); };
const out = {};

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
// the scheme this is about; the pads are a different set of controls entirely
await p.evaluate(() => window.__ctrl && window.__ctrl('stick'));
await p.waitForTimeout(200);

const cdp = await ctx.newCDPSession(p);
const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });

/* WHETHER THE BUTTON ACTUALLY FIRED, asked of the button rather than of its
   effect. A click counter on the element itself is the one reading that cannot
   be satisfied by something else in the game happening to change at the same
   moment — and several of these buttons toggle state that other code also
   touches. */
/* ONE LISTENER PER ELEMENT, EVER. Called once per scenario per button, this
   used to add a second counter to the same element and every later click was
   counted twice — which reads exactly like the de-duplication being broken, and
   sent me looking for a bug in the game that was in this function. */
const watch = sel => p.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return false;
  el.dataset.hits = '0';
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', () => { el.dataset.hits = String(+el.dataset.hits + 1); });
  }
  return true;
}, sel);
const hits = sel => p.evaluate(s => {
  const el = document.querySelector(s);
  return el ? +(el.dataset.hits || 0) : -1;
}, sel);
const boxOf = sel => p.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
           w: Math.round(b.width), h: Math.round(b.height) };
}, sel);

/* Make the two contextual buttons reachable: the spray can needs a bet behind
   it and the depot button needs somewhere that hires. Raised directly, the way
   hud.mjs raises the depot button, because what is under test is the touch
   pipeline and not how they come to be on screen. */
await p.evaluate(() => {
  if (window.__bet) { P.cash = 1000; TURF.picks.red = 2; TURF.bets = 2; TURF.team = 'red'; syncTurfUI(); }
  document.getElementById('jobBtn').classList.add('on');
});
await p.waitForTimeout(200);

/* THE BUTTONS A THUMB ACTUALLY MEETS while driving: the three along the top,
   the spray can under them, and the depot button above the thumb row. */
/* The gear, and the two contextual buttons that sit over the game. The view,
   light and log buttons are inside the settings panel now — reached by opening
   it, which is the gear's own tap, so they are covered by covering the gear. */
const TARGETS = ['#mixBtn', '#sprayBtn', '#sprayBtnR', '#jobBtn'];

// ---------- 1. a tap that slides, which is every real tap ----------
/* FOUR PIXELS. A thumb pressed to glass for a tenth of a second reports several
   pixels of drift with no intention behind it at all, and the report says as
   much. Small enough to still be inside every one of these buttons and large
   enough that the finger has left the exact pixel it landed on. */
out.slide = {};
for (const sel of TARGETS) {
  const b = await boxOf(sel);
  if (!b) { need(false, `${sel} is not on screen to be tapped`); continue; }
  await watch(sel);
  await send('touchStart', [{ x: b.x, y: b.y, id: 1 }]);
  await p.waitForTimeout(40);
  await send('touchMove', [{ x: b.x + 4, y: b.y + 4, id: 1 }]);
  await p.waitForTimeout(40);
  await send('touchEnd', []);
  await p.waitForTimeout(160);
  out.slide[sel] = await hits(sel);
  /* THE GEAR OPENS A PANEL, AND THE NEXT TAP ANYWHERE ELSE CLOSES IT — by
     design, and that dismissing tap is deliberately swallowed so it cannot also
     plant a joystick. Left open, this loop measures that rule instead of the one
     it is about, and the button after the gear reads zero. */
  await p.evaluate(() => { if (typeof mixOpen === 'function') mixOpen(false); });
  /* EXACTLY ONE, not at least one. Turning a tap into a click by hand is only
     half the job; the other half is that the browser's own click must not also
     arrive. The first version of the fix de-duplicated on a 450 ms window and
     headless Chromium sent its click 826 ms later, so every tap fired twice —
     invisible on the day/night switch, ten percent of your money on a bet. */
  need(out.slide[sel] === 1,
       `${sel} fired ${out.slide[sel]} times on a tap that slid four pixels, want exactly 1`);
  // and nothing may be left steering afterwards
  const live = await p.evaluate(() => window.__stick().live);
  need(live === 0, `${sel}: a stick was left live after tapping a button`);
  if (live) { try { await send('touchEnd', []); } catch (e) {} await p.waitForTimeout(60); }
}

// ---------- 2. a button pressed with the other hand, mid-corner ----------
/* The thumb steers and does not let go — which is the entire point of a stick —
   and the other hand presses something. This is the case that could not work at
   all: the driving finger's mere presence claimed the second finger's
   touchstart. */
out.whileDriving = {};
for (const sel of TARGETS) {
  const b = await boxOf(sel);
  if (!b) continue;
  await watch(sel);
  /* And with the settings panel shut. Tapping the gear in the round before this
     one leaves it open, and then the driving thumb's own touchstart is the tap
     that dismisses it — swallowed by design, so no stick is raised and the round
     measures nothing. */
  await p.evaluate(() => { if (typeof mixOpen === 'function') mixOpen(false); });
  // a thumb on the lower left, held, and dragged into a real steer
  await send('touchStart', [{ x: 90, y: 520, id: 1 }]);
  await p.waitForTimeout(50);
  await send('touchMove', [{ x: 130, y: 520, id: 1 }]);
  await p.waitForTimeout(50);
  const steering = await p.evaluate(() => window.__stick());
  // the second finger, on the button
  await send('touchStart', [{ x: 130, y: 520, id: 1 }, { x: b.x, y: b.y, id: 2 }]);
  await p.waitForTimeout(50);
  /* THE BUTTON'S OWN FINGER IS THE ONE THAT LIFTS, and it is named. A touchEnd
     with the wrong point, or with none, releases somebody else — the driving
     thumb — and the button finger is still down when the click would have been
     synthesised, so there is no click and the reading is of the test rather than
     of the game. */
  await send('touchEnd', [{ x: b.x, y: b.y, id: 2 }]);
  await p.waitForTimeout(200);
  out.whileDriving[sel] = { hits: await hits(sel), live: steering.live, steer: +steering.steer.toFixed(2) };
  need(steering.live === 1, `${sel}: the driving thumb never raised a stick, so this proves nothing`);
  need(out.whileDriving[sel].hits === 1,
       `${sel} fired ${out.whileDriving[sel].hits} times while the other thumb was steering, want exactly 1`);
  // let go of the driving finger
  for (let i = 0; i < 4; i++) {
    try { await send('touchEnd', []); } catch (e) { break; }
    await p.waitForTimeout(30);
    if (await p.evaluate(() => window.__stick().live === 0)) break;
  }
  await p.waitForTimeout(80);
}

// ---------- 3. and the stick still works, which is what all this is for ----------
/* The fix narrows when the driving controls claim an event, so the thing to
   prove afterwards is that they still claim the ones that ARE theirs: a thumb
   on open ground raises a ring, drags it, and steers. */
await send('touchStart', [{ x: 90, y: 520, id: 1 }]);
await p.waitForTimeout(60);
await send('touchMove', [{ x: 150, y: 520, id: 1 }]);
await p.waitForTimeout(80);
out.stillDrives = await p.evaluate(() => {
  const s = window.__stick();
  return { live: s.live, steer: +s.steer.toFixed(2) };
});
for (let i = 0; i < 4; i++) {
  try { await send('touchEnd', []); } catch (e) { break; }
  await p.waitForTimeout(30);
  if (await p.evaluate(() => window.__stick().live === 0)) break;
}
need(out.stillDrives.live === 1, 'a thumb on open ground no longer raises a stick');
need(out.stillDrives.steer > 0.2,
     `dragging the ring right steered ${out.stillDrives.steer}, want a real right lock`);

out.errs = errs.slice(0, 3);
need(!errs.length, 'page errors: ' + errs.slice(0, 2).join(' | '));
await br.close();

out.bad = bad;
out.pass = bad.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
