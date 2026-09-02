/* THE THUMB PADS HAVE TO CLEAR THE PHONE'S OWN GESTURE STRIPS.

   iOS takes a touch away the moment it decides the finger belongs to a system
   gesture — the swipe-back gutter down each side, the home indicator along the
   bottom — and the game gets a touchcancel it cannot argue with. The pads are
   therefore held off every edge: 16 px from the sides and 18 px from the bottom
   in the stylesheet, which with the pads' own padding should leave twenty clear.

   Measured on the real elements at several screen shapes rather than read off
   the CSS, because what matters is where the pad actually lands after clamping,
   safe-area insets and the layout have all had their say.
*/
import { chromium, devices } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const SHAPES = [
  ['iPhone 13 portrait', 390, 844],
  ['iPhone 13 landscape', 844, 390],
  ['small phone', 360, 640],
  ['iPad landscape', 1180, 820],
];
const MIN_EDGE = 16, MIN_BOTTOM = 18;      // what the stylesheet promises

const b = await chromium.launch({ executablePath: CHROME });
const out = [];
for (const [label, width, height] of SHAPES) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(GAME);
  await p.waitForTimeout(200);
  const r = await p.evaluate(() => {
    // the pads only exist on screen once touch mode is on; this measures the
    // layout, so it does not need the game to be running
    document.getElementById('touch').classList.add('on');
    const vw = innerWidth, vh = innerHeight, o = {};
    /* THREE PADS, NOT FOUR. The day/night switch used to be one of them and is
       a row in the Settings panel now, so it is not on the glass for a system
       gesture to steal — and a hidden element has an all-zero rect, which this
       would read as a pad sitting flush against the left edge. */
    for (const id of ['tL', 'tA', 'tH']) {
      const q = document.getElementById(id).getBoundingClientRect();
      o[id] = { edge: Math.round(Math.min(q.left, vw - q.right)),
                bottom: Math.round(vh - q.bottom),
                w: Math.round(q.width), h: Math.round(q.height) };
    }
    return o;
  });
  const edge = Math.min(...Object.values(r).map(e => e.edge));
  const bottom = Math.min(...Object.values(r).map(e => e.bottom));
  // reported, not asserted: the pads are what they are, and this test is about
  // where they SIT. A size rule would be a new opinion smuggled in as a check.
  const smallest = Math.min(...Object.values(r).map(e => Math.min(e.w, e.h)));
  out.push({ shape: label, edge, bottom, smallestPad: smallest,
             ok: edge >= MIN_EDGE && bottom >= MIN_BOTTOM });
  await ctx.close();
}
await b.close();
const pass = out.every(o => o.ok);
console.log(JSON.stringify({ pass, minEdge: MIN_EDGE, minBottom: MIN_BOTTOM, shapes: out }, null, 1));
process.exit(pass ? 0 : 1);
