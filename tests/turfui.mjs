/* THE TWO CANS, AND THE PAINT ON THE BIG MAP.
 *
 * Both asked for together and both about the same feature seen from two ends:
 * spraying a wall, and being able to see which walls you have sprayed.
 *
 *   THE CANS. One button in each bottom corner instead of one in the top centre,
 *   bigger and round. They are the same button twice — whichever hand is free
 *   presses it — so the thing worth asserting is that BOTH of them work, not
 *   just that two exist. A second button that looks right and does nothing is
 *   exactly the failure a pair invites, and it is invisible in a screenshot.
 *
 *   THE MAP. The radar has shown painted walls since the feature landed and the
 *   big map showed none at all. Measured in PIXELS OF THE MAP'S OWN CANVAS
 *   rather than by trusting the draw call: count how much of the map is in a
 *   team's colour with nothing painted, paint a district, and count again. That
 *   is the only reading that says the buildings reached the screen.
 *
 * Usage: node tests/turfui.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text()))
    errs.push('console: ' + m.text());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
/* ONE CAN. There were two — one in each bottom corner, then both pulled in
   towards the middle — and the ask came back the other way: "make the paint
   button only one, not two, and move it closer to the left side of the screen,
   almost touching it". The list stays a list because SPRAY_IDS is one, and a
   test that hard-codes a single id would not notice a second button reappearing
   unwired. */
const IDS = ['sprayBtn'];

/* ---------- 1. the can is up from the start, and says what it needs ----------
   IT USED TO BE HIDDEN UNTIL THE FIRST BET, and this section asserted that. It
   was reported twice as "there is no paint button", once on a phone and once on
   a desktop, and on both the button was working exactly as written — a player
   who has never been into the casino had no way to learn that any of this
   exists. So the can is on screen for the whole game, visibly not loaded until
   you have a side, and a press says so.
   THE DIMMING AND THE MESSAGE ARE BOTH ASSERTED, because either alone is the
   old bug in a new shape: a can that looks ready and does nothing, or a can
   that explains itself and looks broken. */
out.before = await p.evaluate(ids => ids.map(id => {
  const el = document.getElementById(id);
  const cs = el && getComputedStyle(el);
  return { id, exists: !!el, on: !!el && el.classList.contains('on'),
           shown: !!el && cs.display !== 'none',
           dim: !!el && +cs.opacity < 0.8,
           team: (el && el.dataset.team) || null };
}), IDS);
out.upFromTheStart = out.before.every(b =>
  b.exists && b.on && b.shown && b.dim && b.team === null);
/* And the press. TURF.team is null here — nothing has been bet — so this is the
   path a new player takes, and the toast is the whole of what they get. */
out.sidelessPress = await p.evaluate(id => {
  document.getElementById(id).click();
  return { said: document.getElementById('toast').textContent,
           painted: W.buildings.some(b => b.turf) };
}, IDS[0]);
out.tellsYouToPickASide =
  out.sidelessPress.said === 'PICK A SIDE AT THE CASINO' && !out.sidelessPress.painted;

/* ---------- 2. and then it is, and it is a thumb ---------- */
out.geo = await p.evaluate(ids => {
  TURF.team = 'red'; TURF.bets = 2; TURF.picks.red = 2;
  syncTurfUI();
  const vw = innerWidth, vh = innerHeight;
  const rect = el => {
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { x: Math.round(b.left), y: Math.round(b.top),
             w: Math.round(b.width), h: Math.round(b.height),
             inset: Math.round(b.left), rightInset: Math.round(vw - b.right),
             radius: cs.borderRadius, display: cs.display,
             fromBottom: Math.round(vh - b.bottom) };
  };
  /* THE DRIFT BUTTON AND THE CAN, MEASURED IN THE SAME STATE, which is the part
     this originally got wrong.

     WHERE THE PAIR EXISTS, which is now two places rather than one:
       · a touchscreen on the PADS scheme
       · a DESKTOP, where #touch is turned on for the one button (see the
         `body:not(.touch-ui) #touch #tH` rules in the stylesheet)
     WHERE IT DOES NOT: a touchscreen on the default STICK scheme, because
     there the handbrake is a downward flick of the joystick and `.ctrl-stick`
     hides every pad. That is the case where the can drops to its corner.

     The desktop used to be the second kind and is now the first: the drift
     button did not exist on a keyboard at all, which is what was reported
     twice. So `canAlone` is measured with touch-ui + ctrl-stick FORCED rather
     than in the page's own natural state — headless Chromium is a desktop, and
     a desktop is now a paired layout.

     Both boxes are measured inside the state they belong to and the body class
     is restored afterwards. Measuring drift forced and the can unforced is
     comparing two different layouts, which is exactly how this test came to
     disagree with the product once already. */
  const touch = document.getElementById('touch');
  const wasDisplay = touch.style.display, wasBody = document.body.className;
  touch.style.display = 'block';
  document.body.classList.remove('ctrl-stick');
  document.body.classList.add('ctrl-pads', 'touch-ui');
  const drift = rect(document.getElementById('tH'));
  const canPaired = rect(document.getElementById(ids[0]));
  /* AND WHERE THERE IS NO DRIFT BUTTON, the corner: a touchscreen on the stick. */
  document.body.classList.remove('ctrl-pads');
  document.body.classList.add('ctrl-stick');
  const canAlone = rect(document.getElementById(ids[0]));
  touch.style.display = wasDisplay; document.body.className = wasBody;
  return { vw, vh, drift, canPaired, canAlone, cans: ids.map(id => {
    const el = document.getElementById(id);
    return Object.assign({ id, on: el.classList.contains('on'),
                            team: el.dataset.team || null }, rect(el));
  }) };
}, IDS);
const C = out.geo.cans;
/* ROUND is width equal to height with a radius of half of it — a "round" button
   that is 84 by 40 with a 50% radius is a lozenge, and 50% on its own does not
   say which. BIGGER is against the 44 point tap target every other button in
   this game is built to; this is the one pressed with a thumb while parked, and
   it was 38 points tall as a rounded rectangle in the top centre. */
out.bothAreRoundAndBig = C.length === 1 && C.every(c =>
  c.on && c.display !== 'none' && c.w >= 44 && Math.abs(c.w - c.h) <= 1 &&
  /50%|9999px/.test(c.radius));
/* AND THERE IS EXACTLY ONE OF IT. Counted in the DOM rather than off the list
   above, which would happily agree with itself: a second .sprayCan left in the
   markup is the specific thing being removed here. */
out.count = await p.evaluate(() => document.querySelectorAll('.sprayCan').length);
out.justTheOne = out.count === 1;
/* THE DRIFT BUTTON'S MIRROR IMAGE, which is what replaced "hard against the
   left". It was six points off the glass in the bottom corner and DRIFT is a
   whole accelerator up the other edge, so the two thumb buttons did not read as
   a pair; the ask was to make them one.

   ASSERTED AGAINST DRIFT'S OWN BOX rather than against the numbers that box
   currently produces. The offset differs by viewport — 14 points above the
   accelerator at base, 34 in the phone query — so a test written against either
   literal would agree with a can that is symmetrical on one screen and twenty
   points out on the other, which is the exact failure --driftUp exists to stop.
   Comparing the two rendered boxes cannot be fooled that way, and it fails if
   EITHER button moves, which is the point of a pair. */
out.mirrorsTheDrift = C.length === 1 && out.geo.drift.w > 0 &&
  Math.abs(out.geo.canPaired.inset - out.geo.drift.rightInset) <= 1 &&
  Math.abs(out.geo.canPaired.fromBottom - out.geo.drift.fromBottom) <= 1 &&
  Math.abs(out.geo.canPaired.w - out.geo.drift.w) <= 1;
/* THE OTHER HALF OF THE SAME RULE, and the half that was reported broken once:
   with no drift button on the screen there is nothing to mirror, so the can
   drops to the bottom edge instead of floating where an absent accelerator
   would be. That case is a touchscreen on the stick scheme (the state the
   measurement block forces); it used to be the desktop as well, and is not any
   more. Against DRIFT's height rather than a literal, so it still means
   something if the pads are ever resized: the corner is far below the paired
   position. */
out.cornerWithoutDrift =
  out.geo.canAlone.fromBottom < out.geo.canPaired.fromBottom - 40;
// and it carries the side you are on, which is what the rim is for
out.bothCarryTheTeam = C.every(c => c.team === 'red');

/* ---------- 3. and it sprays ---------- */
/* Tapped for real rather than calling sprayPaint twice: what is being checked
   is that the second button is wired to anything at all. Parked at a wall by
   hand first, because a can pressed in open ground correctly does nothing. */
out.taps = [];
for (const id of IDS) {
  const before = await p.evaluate(() => window.__turf().owned.red + window.__turf().owned.black);
  const parked = await p.evaluate(() => {
    const b = W.buildings.find(q => !q.turf && q.pts && q.pts.length > 2 &&
                                    Math.hypot(q.cx - P.car.x, q.cy - P.car.y) < 400);
    if (!b) return false;
    window.__tp(b.cx, b.cy, 0);            // inside it: comfortably inside SPRAY_RANGE
    P.car.vx = P.car.vy = 0;
    return true;
  });
  await p.waitForTimeout(250);
  await p.tap('#' + id);
  await p.waitForTimeout(350);
  const after = await p.evaluate(() => window.__turf().owned.red + window.__turf().owned.black);
  out.taps.push({ id, parked, before, after, painted: after > before });
}
out.bothSpray = out.taps.length === 1 && out.taps.every(t => t.painted);

/* ---------- 4. and the paint is on the big map ---------- */
/* THE MAP'S OWN PIXELS, before and after. Zoomed in on the district being
   painted, because at the opening fit the whole city is on screen and one
   building is a quarter of a pixel — which is true of the feature as well and
   is not what is being asked about. */
const TEAM_PX = `() => {
  const cv = document.getElementById('bigmapC');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let red = 0, black = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // the two map fills, within a few levels: #d0263a and #26262f
    if (Math.abs(r - 208) < 12 && Math.abs(g - 38) < 12 && Math.abs(b - 58) < 12) red++;
    if (Math.abs(r - 38) < 6 && Math.abs(g - 38) < 6 && Math.abs(b - 47) < 6) black++;
  }
  return { red, black, of: d.length / 4 };
}`;
out.map = await p.evaluate(async src => {
  const count = eval('(' + src + ')');
  // clear whatever the taps above painted, so "before" really is a clean map
  for (const b of W.buildings) if (b.turf) { b.turf = null; b.tag = null; b.tagSeed = null; resolveColours([b]); }
  prerenderMap();
  openMap();
  const zoom = () => { MAPV.cx = P.car.x; MAPV.cy = P.car.y; MAPV.s = 1.6; mapClamp(); drawBigMap(); };
  zoom();
  await new Promise(r => setTimeout(r, 200));
  const before = count();
  const near = W.buildings
    .filter(q => Math.hypot(q.cx - P.car.x, q.cy - P.car.y) < 220 && q.pts && q.pts.length > 2)
    .slice(0, 30);
  near.forEach((q, i) => claimBuilding(q, i % 3 ? 'red' : 'black'));
  zoom();
  await new Promise(r => setTimeout(r, 200));
  const after = count();
  closeMap();
  return { painted: near.length, before, after };
}, TEAM_PX);
/* A THIRTIETH OF A PERCENT is about two thousand pixels of a 390×664 phone at
   DPR 3, which is thirty city blocks at this zoom — and "before" is zero by
   construction, because nothing else on the map is either of these two colours.
   The gap between the two is the whole assertion; the threshold only has to sit
   somewhere inside it. */
const pct = n => n / out.map.after.of * 100;
out.paintShowsOnTheMap = out.map.painted > 5 &&
  pct(out.map.before.red + out.map.before.black) < 0.005 &&
  pct(out.map.after.red) > 0.03 && pct(out.map.after.black) > 0.01;

/* ---------- 5. and all of it on a desktop, which has its own layout ----------
   REPORTED TWICE: "in the desktop browser web version there are no paint and
   drift buttons". Everything above runs on an iPhone context, so none of it
   could have caught that — the can was a bet away and DRIFT did not exist on a
   keyboard at all, because it is a pad inside #touch and #touch is display:none
   without a touchscreen.
   A SEPARATE CONTEXT RATHER THAN A RESIZE: touch support is decided when the
   context is made (game.js reads `ontouchstart` once, at start), and a resized
   phone is still a phone as far as that line is concerned.
   BOTH HALVES TOGETHER, because they were one report: the button is on the
   screen at a real size, the can is its mirror image, and the drift button
   actually drives the handbrake rather than only looking like it. */
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dp = await desk.newPage();
const deskErrs = [];
dp.on('pageerror', e => deskErrs.push(String(e)));
await dp.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await dp.goto(GAME);
await dp.click('#go');
await dp.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await dp.waitForTimeout(800);

out.desktop = await dp.evaluate(id => {
  const vw = innerWidth, vh = innerHeight;
  const box = el => {
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { w: Math.round(b.width), h: Math.round(b.height), display: cs.display,
             inset: Math.round(b.left), rightInset: Math.round(vw - b.right),
             fromBottom: Math.round(vh - b.bottom) };
  };
  const drift = document.getElementById('tH'), can = document.getElementById(id);
  const d = box(drift), c = box(can);
  /* THE HANDBRAKE, not the appearance of one. io.js binds mousedown on all five
     pads and has since it was written, so this is what says the button that has
     now been made visible was wired the whole time. */
  const r = drift.getBoundingClientRect();
  drift.dispatchEvent(new MouseEvent('mousedown', { bubbles: true,
    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  const down = touch.h;
  dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { touchUI, drift: d, can: c, handbrakeDown: down, handbrakeUp: touch.h,
           canOn: can.classList.contains('on') };
}, IDS[0]);
await desk.close();

const D = out.desktop;
out.driftOnTheDesktop = !D.touchUI && D.drift.display !== 'none' && D.drift.w >= 44;
out.driftWorksOnTheDesktop = D.handbrakeDown === 1 && D.handbrakeUp === 0;
out.canOnTheDesktop = D.canOn && D.can.display !== 'none' && D.can.w >= 44;
out.desktopPairIsMirrored = out.driftOnTheDesktop && out.canOnTheDesktop &&
  Math.abs(D.can.inset - D.drift.rightInset) <= 1 &&
  Math.abs(D.can.fromBottom - D.drift.fromBottom) <= 1 &&
  Math.abs(D.can.w - D.drift.w) <= 1;
out.deskErrs = deskErrs.slice(0, 5);

out.errs = errs.slice(0, 5);
out.pass = out.upFromTheStart && out.tellsYouToPickASide &&
           out.driftOnTheDesktop && out.driftWorksOnTheDesktop &&
           out.canOnTheDesktop && out.desktopPairIsMirrored && !out.deskErrs.length &&
           out.bothAreRoundAndBig && out.justTheOne &&
           out.mirrorsTheDrift && out.cornerWithoutDrift &&
           out.driftOnTheDesktop && out.desktopPairIsMirrored &&
           out.bothCarryTheTeam && out.bothSpray && out.paintShowsOnTheMap && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
