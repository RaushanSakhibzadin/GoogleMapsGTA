/* WHICH WAY THE CAR GOES WHEN YOU PULL THE STICK BACK AND TO ONE SIDE.
 *
 * Reported from play: "when I put it back and side, the side should be inverted
 * — or there should be possible to invert the back side in the settings".
 *
 * The game was doing the physically correct thing. A car's heading rate is
 * (v/L)·tan δ, so with v negative the nose swings the other way, and that is
 * what reversing in a real car does. It is also the single most complained-about
 * thing in every driving game that models it, because a thumb on a stick is not
 * a pair of hands on a wheel: what a stick means is "go that way".
 *
 * So there are now two answers and a switch, and this file holds all three of
 * them to account:
 *
 *   STICK, the default — back-and-left reverses towards the left.
 *   CAR — the physics, unchanged, for anyone who wants it.
 *   The switch remembers, across a reload, because it is a preference.
 *
 * MEASURED AS A HEADING CHANGE, not as a screen position. Where the car ends up
 * on screen is the camera's business as much as the car's, and the camera turns
 * with the heading — so the honest reading is which way the car itself rotated
 * per metre of reversing, taken from the same drive() every frame goes through.
 *
 * Usage: node tests/reverse.mjs [GAME=/path/to/index.html]
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, stubRadio, parkOnAStraight } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text());
});
await stubRadio(p);
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1200);

const out = {};

/* One reversing run, held with the brake and one full lock of steering, and the
   heading it comes out with. Simulated seconds, because below twelve frames a
   second this machine's world runs slower than its clock and a wall-clock window
   would hand the car a different amount of reversing on every run. */
const RUN = `async (steer) => {
  traffic.length = 0; cops.length = 0; P.wanted = 0;
  P.car.vx = P.car.vy = 0; P.car.steer = 0; P.car.spin = null;
  const h0 = P.car.h, x0 = P.car.x, y0 = P.car.y;
  const t0 = window.__simT();
  // brake from a standstill is reverse: drive() turns sustained braking into it
  while (window.__simT() - t0 < 2.6) {
    window.__setInput({ gas: 0, brake: 1, steer, hand: 0 });
    await new Promise(r => requestAnimationFrame(r));
  }
  window.__setInput(null);
  let dh = P.car.h - h0;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const spd = Math.hypot(P.car.vx, P.car.vy);
  // forward speed, signed: negative means it really did go backwards
  const vf = P.car.vx * Math.cos(P.car.h) + P.car.vy * Math.sin(P.car.h);
  return { dh: +dh.toFixed(3), vf: +vf.toFixed(2), spd: +spd.toFixed(2),
           moved: +Math.hypot(P.car.x - x0, P.car.y - y0).toFixed(1) };
}`;

const runBoth = async () => {
  const r = {};
  await parkOnAStraight(p, 90, 30);
  r.left = await p.evaluate(src => eval('(' + src + ')')(-1), RUN);
  await parkOnAStraight(p, 90, 30);
  r.right = await p.evaluate(src => eval('(' + src + ')')(1), RUN);
  return r;
};

/* ---------- 1. the reference: which way this stick turns going FORWARD ----------
 *
 * Every claim below is a comparison against this number rather than against a
 * sign written into the test. Which way a positive `steer` rotates a heading is
 * an internal convention — it is negated once between the stick and drive() in
 * this build — and a test that hard-codes it is testing that the convention has
 * not changed, which is not the question. What is being asked is "does reverse
 * agree with forward, or oppose it", and that is the same question whichever way
 * round the axes are. */
const FWD = `async (steer) => {
  traffic.length = 0; cops.length = 0;
  P.car.vx = P.car.vy = 0; P.car.steer = 0; P.car.spin = null;
  const h0 = P.car.h;
  const t0 = window.__simT();
  while (window.__simT() - t0 < 2.0) {
    window.__setInput({ gas: 1, brake: 0, steer, hand: 0 });
    await new Promise(r => requestAnimationFrame(r));
  }
  window.__setInput(null);
  let dh = P.car.h - h0;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return +dh.toFixed(3);
}`;
await p.evaluate(() => window.__revReal(false));
await parkOnAStraight(p, 90, 20);
out.forwardLeft = await p.evaluate(src => eval('(' + src + ')')(-1), FWD);
out.forwardTurns = Math.abs(out.forwardLeft) > 0.4;

/* ---------- 2. it reverses at all ---------- */
out.stick = await runBoth();
/* THE STAGING, ASSERTED. Every number below is a heading change while going
   backwards, so a run that never went backwards proves nothing — and holding the
   brake against a car that is already rolling forwards is just braking. */
out.reallyReversed = out.stick.left.vf < -2 && out.stick.right.vf < -2 &&
                     out.stick.left.moved > 3 && out.stick.right.moved > 3;

/* ---------- 3. STICK: the side you push is the side it goes ---------- */
/* Two claims. The sticks disagree with each other — pulling one way rotates the
   car the other way from pulling the other, which is the part that would fail if
   the steering were simply being ignored in reverse. And the left one AGREES
   with left going forward, which is what "the stick is taken literally" means
   and is the whole of what was asked for. */
out.stickTurnsBothWays = out.stick.left.dh * out.stick.right.dh < 0 &&
                         Math.abs(out.stick.left.dh) > 0.25 &&
                         Math.abs(out.stick.right.dh) > 0.25;
out.stickFollowsTheStick = out.stick.left.dh * out.forwardLeft > 0;

/* ---------- 4. CAR: the physics, the other way round ---------- */
await p.evaluate(() => window.__revReal(true));
out.car = await runBoth();
out.carIsTheOtherWay = out.car.left.dh * out.forwardLeft < 0 &&
                       out.car.left.dh * out.car.right.dh < 0 &&
                       Math.abs(out.car.left.dh) > 0.25 &&
                       Math.abs(out.car.right.dh) > 0.25;
/* AND THE TWO SETTINGS REALLY DISAGREE. Both of the assertions above could pass
   on a build where the switch does nothing, if the sign convention happened to
   suit — this is the one that cannot. */
out.theSwitchChangesTheCar = out.stick.left.dh * out.car.left.dh < 0;

/* ---------- 5. going FORWARD is untouched by any of it ---------- */
/* The setting is about reverse. A build that flipped the sign everywhere would
   pass every section above and make the car undriveable — so the forward
   reference is taken again with the switch the other way and has to come back
   the same, in sign and in size. */
await parkOnAStraight(p, 90, 20);
out.forwardLeftCar = await p.evaluate(src => eval('(' + src + ')')(-1), FWD);
out.forwardIsUnchanged = out.forwardLeftCar * out.forwardLeft > 0 &&
  Math.abs(out.forwardLeftCar - out.forwardLeft) < Math.abs(out.forwardLeft) * 0.35;

/* ---------- 6. and the switch is a preference, not a mode ---------- */
out.ui = await p.evaluate(() => {
  const el = document.getElementById('revBtn');
  const before = { text: el.textContent.trim(), key: el.getAttribute('data-i18n') };
  el.click();
  const after = { text: el.textContent.trim(), key: el.getAttribute('data-i18n'),
                  real: window.__revReal() };
  return { before, after, stored: localStorage.getItem('vm_revreal') };
});
out.buttonSwitchesAndSays = out.ui.before.text !== out.ui.after.text &&
                            out.ui.before.key !== out.ui.after.key &&
                            out.ui.stored !== null;
/* REMEMBERED ACROSS A RELOAD, which is the difference between a preference and a
   toggle — and the only part of this that a fresh page can check. */
const q = await ctx.newPage();
await stubRadio(q);
await q.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await q.addInitScript(() => { try { localStorage.setItem('vm_revreal', '1'); } catch (e) {} });
await q.goto(GAME);
await q.waitForTimeout(300);
await q.tap('#go');
await q.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
out.reload = await q.evaluate(() => ({ real: window.__revReal(),
                                       text: document.getElementById('revBtn').textContent.trim() }));
out.remembered = out.reload.real === true;
await q.close();

out.errs = errs.slice(0, 5);
out.failing = Object.keys(out).filter(k => out[k] === false);
out.pass = out.forwardTurns && out.reallyReversed && out.stickTurnsBothWays && out.stickFollowsTheStick &&
           out.carIsTheOtherWay && out.theSwitchChangesTheCar && out.forwardIsUnchanged &&
           out.buttonSwitchesAndSays && out.remembered && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
