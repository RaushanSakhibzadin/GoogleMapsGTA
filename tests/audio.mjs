/* THE SOUND COMING BACK AFTER YOU SWITCH AWAY.
 *
 * Reported from an iPhone: switch to another app, come back, and the game is
 * silent. There was already a resume on visibilitychange, focus and pageshow —
 * so the bug was not "nobody resumes it", it was that RESUMING IS NOT THE SAME
 * AS WORKING.
 *
 * Two separate faults, and the fix needs both:
 *
 *   Safari hands back a context that reports `running` and is dead. Every node
 *   is still connected and every gain is still set; currentTime does not advance
 *   and nothing reaches the speaker. There is nothing to resume — it has to be
 *   thrown away and built again. The clock is how you tell.
 *
 *   And iOS only honours a resume from inside a real user gesture.
 *   visibilitychange is not one, so a refused resume left the game muted until
 *   the player happened to press one of the four driving pads. Anyone who came
 *   back and opened the map, or paused, or did nothing, stayed silent.
 *
 * WHAT CAN AND CANNOT BE STAGED HERE. Chromium will suspend and resume a context
 * on demand, so the ordinary round trip is testable directly. It will not hand
 * back a running-but-frozen context, because that is a Safari behaviour — so the
 * DECISION is a pure function, exported, and tested on the readings it would
 * receive, and the REPAIR is tested by calling it. That is the same shape as the
 * archway precision fault: the platform-specific half is reasoned about and the
 * consequence is measured.
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(400);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(800);

const out = {};

/* ---- 1. it is running at all ----
   Nothing below means anything if the context never started, and a headless
   browser can legitimately have no audio device. */
out.begin = await p.evaluate(() => { SFX.start(); return window.__audio(); });
if (out.begin.state === 'none') {
  out.skipped = 'no AudioContext in this browser';
  out.pass = true;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}

/* ---- 2. the ordinary round trip: suspended, then back ---- */
out.suspended = await p.evaluate(async () => {
  await window.__audioSuspend();
  return window.__audio();
});
out.backAgain = await p.evaluate(async () => {
  document.dispatchEvent(new Event('visibilitychange'));
  dispatchEvent(new Event('focus'));
  await new Promise(r => setTimeout(r, 400));
  return window.__audio();
});
out.resumesOnReturn = out.suspended.state === 'suspended' &&
                      out.backAgain.state === 'running';

/* ---- 3. and the clock actually advances afterwards ----

   The assertion the old code could not make. A context that came back
   `running` with a stopped clock passed every check there was. */
out.clock = await p.evaluate(async () => {
  const t0 = window.__audio().now;
  await new Promise(r => setTimeout(r, 400));
  const t1 = window.__audio().now;
  return { t0: +t0.toFixed(3), t1: +t1.toFixed(3), moved: +(t1 - t0).toFixed(3) };
});
out.clockRuns = out.clock.moved > 0.15;

/* ---- 4. the decision that spots a dead context ----

   Pure, so it can be given the readings Safari produces without needing Safari.
   The three that matter: running and frozen is dead; running and ticking is
   alive; and 'interrupted' — which only Safari has, and which code that knows
   only the two standard states will silently treat as fine — is dead too. */
out.decides = await p.evaluate(() => ({
  frozenRunning: window.__audioStalled('running', 4.0, 4.0),
  goingBackwards: window.__audioStalled('running', 4.0, 3.5),
  ticking: window.__audioStalled('running', 4.0, 4.5),
  interrupted: window.__audioStalled('interrupted', 4.0, 4.0),
  // a suspended context is not stalled, it is suspended: resume is the answer
  // there, and rebuilding one on every pause would be a stutter a second
  suspended: window.__audioStalled('suspended', 4.0, 4.0)
}));
out.spotsADeadContext = out.decides.frozenRunning === true &&
                        out.decides.goingBackwards === true &&
                        out.decides.interrupted === true &&
                        out.decides.ticking === false &&
                        out.decides.suspended === false;

/* ---- 5. and the repair actually replaces it ----

   Not "resume was called again": a new context, with its own clock, running,
   and audibly connected — which is checked by asking the engine for a note and
   confirming nothing throws against the new graph. */
out.repair = await p.evaluate(async () => {
  const before = window.__audio();
  const after = window.__audioRebuild();
  await new Promise(r => setTimeout(r, 400));
  const settled = window.__audio();
  let played = true;
  try { SFX.engine(0.5, 0.5); SFX.horn(); } catch (e) { played = String(e); }
  return { before, after, settled, played };
});
out.rebuildsIt = out.repair.after.gen > out.repair.before.gen &&
                 out.repair.settled.started === true &&
                 out.repair.settled.state === 'running' &&
                 out.repair.settled.now < out.repair.before.now &&   // a new clock
                 out.repair.played === true;

/* ---- 6. any tap retries it, not just the driving pads ----

   iOS only honours a resume from inside a real gesture, so the listener has to
   be on something every return path touches. Staged by suspending and then
   tapping a part of the screen that is not a pad — the pause card's own backdrop
   — and asserting the sound came back without anyone touching the controls. */
out.anyTap = await p.evaluate(async () => {
  await window.__audioSuspend();
  const dead = window.__audio();
  // a tap on the canvas, which is not a control and has no handler of its own
  document.getElementById('game').dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { dead, live: window.__audio() };
});
out.anyTapRevivesIt = out.anyTap.dead.state === 'suspended' &&
                      out.anyTap.live.state === 'running';

out.errs = errs.slice(0, 3);
out.pass = out.resumesOnReturn && out.clockRuns && out.spotsADeadContext &&
           out.rebuildsIt && out.anyTapRevivesIt && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
