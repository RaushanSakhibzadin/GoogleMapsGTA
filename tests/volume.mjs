/* TWO VOLUME SLIDERS, AND WHY THEY ARE TWO.
 *
 * The game's sounds and the radio are different things — an engine note you want
 * under a conversation and a song you want over it — and they are different
 * mechanisms: the sound effects run through a WebAudio graph, the radio is an
 * <audio> element that never touches it. One slider for both would be the thing
 * people complain about in every game that ships one.
 *
 * THE PANEL IS NOT IN THE PAUSE CARD, and that is the load-bearing decision
 * here. The pause card is reachable only with Esc, and there is no Esc on a
 * phone — anything parked in there is unreachable on the platform this game is
 * mostly played on. (The GHOST MODE toggle is in there too, and is unreachable
 * mid-game for the same reason. Not this test's business, but worth knowing.)
 *
 * FOUR WAYS THIS LOOKS RIGHT AND IS NOT:
 *
 *   The slider moves and nothing changes, because a dozen sources connect
 *   straight to the speaker and the master gain is in front of none of them.
 *   Asserted on the GRAPH — the bus's own gain value — not on the number under
 *   the slider.
 *
 *   The two sliders are wired to the same thing.
 *
 *   It does not survive a reload, which for a volume is most of the point.
 *
 *   And it cannot be reached or hit on a phone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';

/* ---- 0. NOTHING BYPASSES THE BUS ----

   Read off the source, before a browser is even started, because it is the one
   failure this cannot otherwise see: a slider that updates its own label and its
   stored value while some sound still connects straight to the speaker satisfies
   every reading below and is silent about the one thing that went wrong. There
   were twelve of these connections and every one of them was direct.

   Exactly one connection to ac.destination is allowed, and it is the bus's. */
const IO = readFileSync(join(ROOT, 'js', 'io.js'), 'utf8');
const direct = (IO.match(/\.connect\(\s*ac\.destination\s*\)/g) || []).length;
const viaBus = (IO.match(/\.connect\(\s*out\(\)\s*\)/g) || []).length;
const busToSpeaker = /master\.connect\(\s*ac\.destination\s*\)/.test(IO);

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(400);
await p.evaluate(() => window.__hideGLHelp && window.__hideGLHelp(false));
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(800);

const out = {};
out.wiring = { direct, viaBus, busToSpeaker };
out.everythingGoesThroughTheBus = direct === 1 && busToSpeaker && viaBus >= 4;

/* ---- 1. the button opens it, on a phone, without pausing ----
   Not pausing is deliberate: you cannot set an engine's level against silence,
   and the whole point of moving the slider is hearing what it does. */
out.opening = await p.evaluate(() => {
  const before = { state: window.__s(), open: window.__mix().open };
  document.getElementById('mixBtn').click();
  const after = { state: window.__s(), open: window.__mix().open,
                  expanded: document.getElementById('mixBtn').getAttribute('aria-expanded') };
  return { before, after };
});
out.opensWithoutPausing = out.opening.before.open === false &&
                          out.opening.after.open === true &&
                          out.opening.after.expanded === 'true' &&
                          out.opening.before.state === 'play' &&
                          out.opening.after.state === 'play';

/* ---- 2. and it is reachable and hittable where it opened ---- */
out.reach = await p.evaluate(() => {
  const r = id => {
    const q = document.getElementById(id).getBoundingClientRect();
    return { w: Math.round(q.width), h: Math.round(q.height),
             top: Math.round(q.top), bottom: Math.round(q.bottom),
             left: Math.round(q.left), right: Math.round(q.right) };
  };
  return { btn: r('mixBtn'), sfx: r('mixSfx'), radio: r('mixRadio'), done: r('mixDone'),
           vw: innerWidth, vh: innerHeight,
           scrollW: document.documentElement.scrollWidth };
});
const inside = q => q.top >= 0 && q.bottom <= out.reach.vh &&
                    q.left >= 0 && q.right <= out.reach.vw;
/* A range control's default hit area on iOS is about four pixels tall. The rows
   are given a real one, and this is what says so. */
out.fitsAndIsHittable =
  inside(out.reach.btn) && inside(out.reach.sfx) && inside(out.reach.radio) &&
  inside(out.reach.done) && out.reach.scrollW <= out.reach.vw &&
  out.reach.btn.h >= 28 && out.reach.sfx.h >= 22 && out.reach.radio.h >= 22 &&
  out.reach.done.h >= 28;

/* ---- 3. the game slider reaches the audio graph ----

   THE BUS, NOT THE NUMBER. A slider that updates its own label and a stored
   value while every sound still connects straight to the speaker would satisfy
   any test that read back what it just wrote. The gain node the whole graph
   passes through is the thing that has to move.

   Read after a beat because the change is RAMPED rather than set — a step
   change in a gain is an audible click — so the value arrives over about 20 ms
   rather than on the same tick. */
out.sfx = await p.evaluate(async () => {
  SFX.start();
  const read = async v => {
    window.__mixSet('sfx', v);
    await new Promise(r => setTimeout(r, 220));
    const m = window.__mix();
    return { want: v, vol: +m.sfx.toFixed(2), bus: m.bus, shown: m.shownSfx };
  };
  const loud = await read(0.9);
  const quiet = await read(0.15);
  const off = await read(0);
  return { loud, quiet, off };
});
out.gameSliderMovesTheBus =
  Math.abs(out.sfx.loud.bus - 0.9) < 0.05 &&
  Math.abs(out.sfx.quiet.bus - 0.15) < 0.05 &&
  out.sfx.off.bus < 0.02 &&
  out.sfx.loud.shown === 90 && out.sfx.quiet.shown === 15;

/* ---- 4. the radio slider reaches the element, and not the bus ----
   Two sliders wired to one thing is the other way this passes a screenshot. */
out.radio = await p.evaluate(async () => {
  // the element exists once something has asked to play; nothing is fetched
  radioEl();
  const busBefore = window.__mix().bus;
  window.__mixSet('radio', 0.25);
  await new Promise(r => setTimeout(r, 120));
  const a = window.__mix();
  window.__mixSet('radio', 1);
  const b = window.__mix();
  return { busBefore, a: { el: a.el, sfx: +a.sfx.toFixed(2), shown: a.shownRadio },
           b: { el: b.el, shown: b.shownRadio }, busAfter: b.bus };
});
out.radioSliderMovesTheStream =
  Math.abs(out.radio.a.el - 0.25) < 0.02 && out.radio.a.shown === 25 &&
  Math.abs(out.radio.b.el - 1) < 0.02 && out.radio.b.shown === 100 &&
  // and the game's level was not dragged along with it
  Math.abs(out.radio.busAfter - out.radio.busBefore) < 0.02 &&
  Math.abs(out.radio.a.sfx - 0) < 0.02;

/* ---- 5. both survive a reload ----
   A volume that resets every time you open the game is not a setting. */
await p.evaluate(() => { window.__mixSet('sfx', 0.42); window.__mixSet('radio', 0.77); });
await p.reload();
await p.waitForTimeout(500);
out.afterReload = await p.evaluate(() => ({
  sfx: +SFX.volume().toFixed(2), radio: +radioVolume().toFixed(2)
}));
/* And the graph is built from the stored level rather than a default it then
   forgets to apply — checked by starting the context fresh after the reload. */
out.busAfterReload = await p.evaluate(async () => {
  SFX.start();
  await new Promise(r => setTimeout(r, 200));
  return window.__mix().bus;
});
out.remembersBoth = Math.abs(out.afterReload.sfx - 0.42) < 0.02 &&
                    Math.abs(out.afterReload.radio - 0.77) < 0.02 &&
                    Math.abs(out.busAfterReload - 0.42) < 0.05;

/* ---- 6. and a rebuilt context comes back at the right level ----
   Coming back from an interruption on iOS throws the whole graph away and
   builds it again — see tests/audio.mjs. A rebuild that came back at full
   volume would be a very unwelcome surprise. */
out.afterRebuild = await p.evaluate(async () => {
  window.__audioRebuild();
  await new Promise(r => setTimeout(r, 300));
  return window.__mix().bus;
});
out.rebuildKeepsTheLevel = Math.abs(out.afterRebuild - 0.42) < 0.05;

out.errs = errs.slice(0, 3);
out.pass = out.everythingGoesThroughTheBus && out.opensWithoutPausing && out.fitsAndIsHittable &&
           out.gameSliderMovesTheBus && out.radioSliderMovesTheStream &&
           out.remembersBoth && out.rebuildKeepsTheLevel && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
