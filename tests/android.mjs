/* THE GAME HAS TO FIT ON AN ANDROID PHONE.

   Reported with two screenshots from Chrome on Android: the thumb pads chopped
   off along the bottom edge, and "STREAMING THE NEXT DISTRICT" cut in half under
   them. Nothing was wrong with the layout. The layout was the wrong size.

   position:fixed pins to the LAYOUT viewport, and Chrome for Android reports
   that as the tall one — the height the page would have if the URL bar were
   hidden — whether the URL bar is showing or not. Measured on a Pixel here: the
   accelerator's bottom edge lands at 825 in an 851 layout, and with the URL bar
   up the phone can only show 751 of it. The whole control cluster is below the
   fold, on a game you steer with your thumbs.

   HEADLESS CHROMIUM HAS NO URL BAR, so the condition cannot be produced by
   asking for a smaller window — that just makes a smaller, consistent viewport
   where everything fits and the bug is invisible. It is produced the way the
   phone produces it: visualViewport is overridden before the page loads to
   report a height CHROME px shorter than innerHeight, exactly as browser UI
   does, and then every element is measured against what is really on screen.

   Usage: node tests/android.mjs
*/
import { chromium } from 'playwright';
import { CHROME, GAME, SHOTS } from './harness.mjs';

/* Real Chrome-on-Android CSS sizes, with the height the URL bar takes. Android's
   top toolbar is 56dp and Chrome keeps it at a fixed CSS height. */
const PHONES = [
  ['Pixel 5', 393, 851, 2.75, 100],
  ['Pixel 5 landscape', 851, 393, 2.75, 100],
  ['Galaxy S8', 360, 740, 4, 100],
  ['small Android', 320, 658, 2, 96],
];
// every HUD and control element that has to be reachable and readable
const IDS = ['hudTL', 'obj', 'mini', 'cash', 'stars', 'logBtn', 'hpWrap', 'chunk',
             'tL', 'tR', 'tB', 'tA', 'tH', 'tN'];
// full-screen layers, which all have to be the size of the screen and not of the
// taller layout the phone reports
const LAYERS = ['game', 'hud', 'touch', 'post', 'menu', 'load'];

const b = await chromium.launch({ executablePath: CHROME });
const out = [];
for (const [label, width, height, dpr, chrome] of PHONES) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: dpr,
    isMobile: true, hasTouch: true });
  /* Browser UI, simulated the way the browser does it: the layout viewport stays
     tall and the visual viewport is what you can see. Installed before any of the
     game's script runs, so it is in place for the very first resize(). */
  await ctx.addInitScript(([cut]) => {
    const vv = window.visualViewport;
    if (!vv) return;
    Object.defineProperty(vv, 'height', { get: () => window.innerHeight - cut, configurable: true });
    Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
  }, [chrome]);
  const p = await ctx.newPage();
  await p.goto(GAME);
  await p.waitForTimeout(250);

  const r = await p.evaluate(ids => {
    // the pads and the HUD only exist on screen once those modes are on; this
    // measures the layout, so it does not need the game to be running
    document.getElementById('hud').classList.add('on');
    document.getElementById('touch').classList.add('on');
    window.dispatchEvent(new Event('resize'));
    const visible = window.visualViewport.height;
    const els = {}, over = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const q = el.getBoundingClientRect();
      if (!q.width && !q.height) continue;         // not shown in this orientation
      els[id] = { top: Math.round(q.top), bottom: Math.round(q.bottom) };
      // below the fold, or above the top of the screen
      if (q.bottom > visible + 0.5) over.push(`${id} bottom ${Math.round(q.bottom)} > ${Math.round(visible)}`);
      if (q.top < -0.5) over.push(`${id} top ${Math.round(q.top)}`);
    }
    // the credit line lives outside the HUD and is fixed to the viewport too
    for (const sel of ['.credit']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const q = el.getBoundingClientRect();
      els[sel] = { top: Math.round(q.top), bottom: Math.round(q.bottom) };
      if (q.bottom > visible + 0.5) over.push(`${sel} bottom ${Math.round(q.bottom)} > ${Math.round(visible)}`);
    }
    /* Every full-screen layer, including the ones currently hidden — the loading
       screen is half of what was reported and it is display:none by the time the
       game is running, so it is shown for the measurement and put back. */
    const layers = {};
    for (const id of ['game', 'hud', 'touch', 'post', 'menu', 'load']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const hidden = el.classList.contains('hide');
      if (hidden) el.classList.remove('hide');
      const h = Math.round(el.getBoundingClientRect().height);
      if (hidden) el.classList.add('hide');
      layers[id] = h;
      if (Math.abs(h - visible) > 1) over.push(`#${id} is ${h} tall, screen is ${Math.round(visible)}`);
    }
    const gm = document.getElementById('game').getBoundingClientRect();
    return { innerH: innerHeight, visible: Math.round(visible), els, over, layers,
             gameH: Math.round(gm.height),
             // the canvas backing store has to match, or the world is drawn to a
             // size the screen does not have and the camera centre is off
             canvasCss: Math.round(parseFloat(getComputedStyle(document.getElementById('game')).height)) };
  }, IDS);

  await p.screenshot({ path: `${SHOTS}/shot-android-${label.replace(/\s+/g, '-')}.png` });
  out.push({ phone: label, layoutH: r.innerH, visibleH: r.visible, gameH: r.gameH,
             layers: r.layers, clipped: r.over,
             // the game surface is the visible screen, not the taller layout
             sizedToVisible: Math.abs(r.gameH - r.visible) <= 1,
             ok: r.over.length === 0 && Math.abs(r.gameH - r.visible) <= 1 });
  await ctx.close();
}
await b.close();

const pass = out.every(o => o.ok);
console.log(JSON.stringify({ pass, phones: out }, null, 1));
process.exit(pass ? 0 : 1);
