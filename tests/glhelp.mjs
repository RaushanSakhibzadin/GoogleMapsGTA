/* THE CARD THAT EXPLAINS A MISSING WEBGL.
 *
 * On a phone with WebGL switched off the chase view still works — it falls back
 * to a software renderer that draws the same street on the 2D canvas — but it is
 * slower and plainer and the player is given no reason for it. The reason is
 * something they can go and change, so the game says what has happened and how
 * to undo it, once, dismissible for good.
 *
 * ON AN IPHONE THE CAUSE IS ALMOST ALWAYS LOCKDOWN MODE, and that is not a
 * guess: this arrived three times from the same phone with a log attached, and
 * the log said probe "no", webgl1 false, and no error message at all. The
 * constructors are simply not there, which is what Lockdown Mode does to WebGL
 * on every site. So it is the first step on the card rather than a footnote.
 *
 * WEBGL IS REMOVED BEFORE A LINE OF THE GAME RUNS, the same way nogl.mjs stages
 * it, because a test that flipped a flag would prove the flag works.
 *
 * The four things that can be wrong while the card looks fine in a screenshot:
 * it appears when WebGL is present; it does not appear when WebGL is absent; it
 * gives Mac advice to an iPhone; and dismissing it does not stick.
 */
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });

const KILL_GL = () => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') return null;
    return real.call(this, t, o);
  };
  try { delete window.WebGL2RenderingContext; } catch (e) {}
  try { delete window.WebGLRenderingContext; } catch (e) {}
};

async function open({ noGL, iphone }) {
  const ctx = iphone ? await browser.newContext({ ...devices['iPhone 13'] })
                     : await browser.newContext({ viewport: { width: 900, height: 640 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  if (noGL) await p.addInitScript(KILL_GL);
  await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto(GAME);
  await p.waitForTimeout(500);
  return { p, ctx, errs };
}

const out = {};

/* ---- 1. no WebGL on an iPhone: the card, with the iPhone's steps ---- */
{
  const { p, ctx, errs } = await open({ noGL: true, iphone: true });
  out.phone = await p.evaluate(() => window.__glHelp());
  out.cardOnAPhone = out.phone.shown === true && out.phone.webgl2 === false &&
                     out.phone.ios === true;
  /* THE STEPS HAVE TO BE THE ONES THAT WORK. Lockdown Mode first, because that is
     what the logs said it was; Safari named, because every browser on iOS is
     WebKit and the Safari settings govern Chrome and Firefox too; and the
     restart, because the flag does not take effect in a running browser. */
  const t = out.phone.text;
  out.rightSteps = /Lockdown Mode/i.test(t) && /Safari/i.test(t) &&
                   /Feature Flags/i.test(t) && /WebGL/i.test(t) &&
                   /app switcher|swipe/i.test(t);
  /* And it does not send anybody after WebGPU, which is a different feature and
     turning it on does nothing for this. Named on the card only to say so. */
  out.noWildGoose = /WebGPU/.test(t) && /different feature/i.test(t);

  /* ---- AND IT FITS THE PHONE IT IS EXPLAINING ITSELF ON ----

     .screen is a fixed, centred flexbox, so a card taller than the viewport does
     not push the page down — it hangs off both ends and takes its buttons with
     it. The first version ran to 693 px of card on a 664 px iPhone screen: a
     card explaining a problem, that you cannot dismiss. Both buttons are checked
     rather than the card's height, because that is the thing that has to be
     reachable. */
  out.fit = await p.evaluate(() => {
    const r = id => {
      const q = document.getElementById(id).getBoundingClientRect();
      return { top: Math.round(q.top), bottom: Math.round(q.bottom),
               left: Math.round(q.left), right: Math.round(q.right) };
    };
    return { ok: r('glOk'), never: r('glNever'),
             vw: innerWidth, vh: innerHeight,
             scrollW: document.documentElement.scrollWidth };
  });
  const inView = q => q.top >= 0 && q.bottom <= out.fit.vh &&
                      q.left >= 0 && q.right <= out.fit.vw;
  out.fitsThePhone = inView(out.fit.ok) && inView(out.fit.never) &&
                     out.fit.scrollW <= out.fit.vw;

  // dismissing it for good has to survive a reload, or it is not "again"
  await p.evaluate(() => window.__hideGLHelp(true));
  out.afterDismiss = await p.evaluate(() => window.__glHelp());
  await p.reload();
  await p.waitForTimeout(500);
  out.afterReload = await p.evaluate(() => window.__glHelp());
  out.dismissSticks = out.afterDismiss.shown === false &&
                      out.afterReload.shown === false && out.afterReload.muted === true;
  out.phoneErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 1b. and on the smallest screen anybody still uses ----

   320 x 568 is an iPhone SE, and it is where a card that merely fits a 390-wide
   phone comes apart. Checked separately rather than by shrinking the viewport of
   the context above, because the card is laid out once when it is shown. */
{
  const ctx = await browser.newContext({
    viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true,
    userAgent: devices['iPhone 13'].userAgent
  });
  const p = await ctx.newPage();
  await p.addInitScript(KILL_GL);
  await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto(GAME);
  await p.waitForTimeout(500);
  out.small = await p.evaluate(() => {
    const r = id => {
      const q = document.getElementById(id).getBoundingClientRect();
      return { top: Math.round(q.top), bottom: Math.round(q.bottom),
               left: Math.round(q.left), right: Math.round(q.right) };
    };
    return { shown: !document.getElementById('glhelp').classList.contains('hide'),
             ok: r('glOk'), never: r('glNever'),
             vw: innerWidth, vh: innerHeight,
             scrollW: document.documentElement.scrollWidth };
  });
  const fits = q => q.top >= 0 && q.bottom <= out.small.vh &&
                    q.left >= 0 && q.right <= out.small.vw;
  out.fitsTheSmallest = out.small.shown && fits(out.small.ok) && fits(out.small.never) &&
                        out.small.scrollW <= out.small.vw;
  await ctx.close();
}

/* ---- 2. WebGL present: no card at all ----

   The half that would be missed by only ever testing the broken case. A card
   that appears on a working machine is worse than no card. */
{
  const { p, ctx, errs } = await open({ noGL: false, iphone: false });
  out.working = await p.evaluate(() => window.__glHelp());
  out.silentWhenItWorks = out.working.webgl2 === true && out.working.shown === false;
  out.workingErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 3. no WebGL on a desktop: a card, but not the iPhone's ----

   Somebody on a laptop with a dead driver is told about the driver. Sending them
   into iOS Settings is not merely useless, it reads as a game that has not
   understood what it is running on. */
{
  const { p, ctx, errs } = await open({ noGL: true, iphone: false });
  out.desk = await p.evaluate(() => window.__glHelp());
  out.deskCard = out.desk.shown === true && out.desk.ios === false &&
                 !/Lockdown|Safari|Feature Flags/i.test(out.desk.text) &&
                 /acceleration|driver/i.test(out.desk.text);
  out.deskErrs = errs.slice(0, 3);
  await ctx.close();
}

/* ---- 4. and the game still plays behind it ----

   The card is an explanation, not a gate: it sits over the menu and DRIVE still
   works once it is out of the way. Staged on the phone, which is where it
   appears. */
{
  const { p, ctx, errs } = await open({ noGL: true, iphone: true });
  await p.evaluate(() => window.__hideGLHelp(false));
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
  await p.waitForTimeout(800);
  out.play = await p.evaluate(() => {
    const on = window.__setMode3d(true);
    return { state: window.__s(), mode3d: window.__mode3d(), soft: typeof SOFT3D !== 'undefined' && SOFT3D, on };
  });
  // the chase view comes up on the software renderer rather than being refused
  out.stillPlays = out.play.state === 'play' && out.play.mode3d === true && out.play.soft === true;
  out.playErrs = errs.slice(0, 3);
  await ctx.close();
}

out.errs = [].concat(out.phoneErrs, out.workingErrs, out.deskErrs, out.playErrs).filter(Boolean);
out.pass = out.cardOnAPhone && out.rightSteps && out.noWildGoose && out.fitsThePhone &&
           out.fitsTheSmallest && out.dismissSticks &&
           out.silentWhenItWorks && out.deskCard && out.stillPlays && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
