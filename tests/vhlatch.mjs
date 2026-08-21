/* THE GAME IN THE TOP TWO THIRDS OF THE SCREEN, WITH A BAND OF NOTHING UNDER IT.
 *
 * Reported from an iPhone, and the numbers name the cause. The phone reported a
 * 699 px window; the layout was sitting at about 482. The difference is 217 px,
 * which is an iPhone keyboard.
 *
 * Every full-height element in this game is `height: var(--vh)`, and --vh is set
 * from visualViewport.height. syncViewport() refuses to update it while a text
 * field is focused, so typing a city name into the menu cannot squash the game.
 * But pressing DRIVE BLURS THE FIELD FIRST and the keyboard then slides away
 * over a few hundred milliseconds — so a visualViewport resize fires mid-slide,
 * the guard no longer applies because nothing is focused any more, and --vh
 * latches to a height that was true for one frame. The keyboard finishes closing
 * without firing anything else, and the game stays squashed for the session.
 *
 * WHAT THIS TEST HAD TO GET RIGHT is that a single resize event does not
 * reproduce it. Dispatching one event makes the old code re-read the CORRECT
 * height and fix itself, so the test would pass against the broken build. The
 * fault needs the last event of a burst to carry a stale value and nothing to
 * follow it — which is what a closing keyboard is. So visualViewport.height is
 * stubbed to the wrong value, the event is fired, and the stub is then removed
 * WITHOUT firing anything: the viewport is now correct and the page has not been
 * told. Only code that goes back to look of its own accord recovers.
 *
 * Verified against the build without the settle: --vh stays at 480 for as long
 * as you wait, and every full-height element with it.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 390, height: 700 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(400);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};
/* Every element that is supposed to be as tall as the window. If --vh is wrong
   they are all wrong together, which is exactly what the screenshot shows — the
   game, the HUD and the thumb pads all end at the same line with background
   under them. */
const layout = () => p.evaluate(() => {
  const px = n => Math.round(parseFloat(n) || 0);
  const h = id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().height) : null; };
  return { win: innerHeight,
           vh: px(getComputedStyle(document.documentElement).getPropertyValue('--vh')),
           game: h('game'), hud: h('hud'),
           /* #touch is display:none without a touchscreen, so it measures zero
              here and is reported rather than asserted on. VH is read as a bare
              identifier because it is a `let` — those do not become properties of
              window, and window.VH is undefined however healthy the game is. */
           touch: h('touch'),
           VH: typeof VH === 'number' ? VH : null };
});

out.before = await layout();
out.startsFullHeight = out.before.game === out.before.win;

/* ---- the keyboard closes without telling anyone ---- */
out.latched = await p.evaluate(() => {
  const vv = window.visualViewport;
  if (!vv) return 'no visualViewport';
  const proto = Object.getPrototypeOf(vv);
  const real = Object.getOwnPropertyDescriptor(proto, 'height');
  // the viewport as it is mid-slide, with the keyboard still half up
  Object.defineProperty(vv, 'height', { configurable: true, get: () => 480 });
  vv.dispatchEvent(new Event('resize'));
  window.__restore = () => {
    // and now it finishes closing — silently, which is the whole point
    delete vv.height;
    return !!real;
  };
  return true;
});
await p.waitForTimeout(60);
out.whileLatched = await layout();
// the fault reproduces: the layout really did shrink to the stale height
out.reproduced = out.whileLatched.vh === 480 && out.whileLatched.game === 480;

await p.evaluate(() => window.__restore());
/* No event, no scroll, no touch — nothing but time. The old code has no reason
   to look again and does not; the new code has already booked the measurements. */
await p.waitForTimeout(1600);
out.after = await layout();
out.recovers = out.after.vh === out.after.win && out.after.game === out.after.win;
/* And the whole stack recovers together, not just the element that happens to be
   measured first — the canvas backing store follows the CSS box through VH. */
out.everythingAgrees = out.after.game === out.after.win &&
                       out.after.hud === out.after.win &&
                       out.after.VH === out.after.win;

out.errs = errs.slice(0, 3);
out.pass = out.startsFullHeight && out.reproduced && out.recovers &&
           out.everythingAgrees && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
