import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const { fakeOSM } = await import('./fake.mjs');

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: '25.7825', lon: '-80.1300', display_name: 'Ocean Drive, Miami Beach, Florida' }]) }));
const bboxOf = r => { const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/); return m ? m.slice(1).map(Number) : null; };
await p.route('**/api/interpreter', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fakeOSM(bboxOf(r))) }));
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(500);

const out = { errs: [] };
out.theme0 = await p.evaluate(() => window.__theme());

// ---------- street label: drive along a known road ----------
// EW roads sit at y = i*120 and carry names; NS roads at x = i*120.
// 'Ocean Drive' is EW[0] -> i=-4 -> y=-480. Drive east along it.
async function driveOn(x, y, h, ms) {
  await p.evaluate(([x, y, h]) => window.__tp(x, y, h), [x, y, h]);
  await p.keyboard.down('w');
  await p.waitForTimeout(ms);
  await p.keyboard.up('w');
  await p.waitForTimeout(250);
  return p.evaluate(() => window.__nav());
}
out.onOcean = await driveOn(-200, -480, 0, 1400);          // east along Ocean Drive
out.onAlpha = await driveOn(-480, -200, Math.PI / 2, 1400); // south along Alpha Avenue

// ---------- intersection must not strobe ----------
const flips = await p.evaluate(async () => {
  window.__tp(-480 - 40, 0, 0);        // heading east straight through a crossroads
  const seen = [];
  let last = null;
  const t0 = performance.now();
  return new Promise(res => {
    const tick = () => {
      const s = window.__nav().street;
      if (s !== last) { seen.push(s); last = s; }
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick); else res(seen);
    };
    // hold the throttle by faking the key
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    tick();
  });
});
await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' })));
out.intersectionNames = flips;

/* ---------- the street label stays up long enough to read ---------- */
/* It held for four seconds, which is about two blocks at speed — you caught it
   only if you were already looking at that corner of the screen when it
   appeared. Asked to last longer.
 *
 * MEASURED END TO END, from the label changing to the label going away, rather
 * than by reading the constant back out — a number the game stores and never
 * spends is not a duration. In SIMULATED seconds, because that is the clock
 * update() actually decrements: headless Chromium drops frames, the loop caps
 * catch-up at five steps, and wall-clock here would measure the renderer.
 *
 * THE CAR IS STOPPED DEAD the moment the new name lands. Left coasting it
 * crosses the next junction inside the hold, adopts that street, restarts the
 * clock, and the measurement silently becomes two holds end to end. */
out.hold = await p.evaluate(() => new Promise(res => {
  window.__tp(-480, 300, Math.PI / 2);
  const el = document.getElementById('street');
  const was = window.__nav().street;
  const t0 = window.__simT();
  let onAt = null;
  window.__setInput({ gas: 1 });
  const tick = () => {
    const t = window.__simT() - t0;
    const nav = window.__nav();
    if (onAt === null && nav.street && nav.street !== was) {
      onAt = t;
      window.__setInput(null);
      P.car.vx = P.car.vy = 0;                 // and it stays exactly here
    }
    if (onAt !== null && P.car) { P.car.vx = 0; P.car.vy = 0; }
    if (onAt !== null && !el.classList.contains('on'))
      return res({ was, onAt: +onAt.toFixed(2), offAt: +t.toFixed(2),
                   hold: +(t - onAt).toFixed(2), street: nav.street });
    if (t > 30) return res({ was, onAt, offAt: null, hold: null, street: nav.street });
    requestAnimationFrame(tick);
  };
  tick();
}));
/* Comfortably past the old four, and still transient rather than permanent — a
   label that never leaves is a different bug and would pass a floor alone. */
out.labelHoldsLongEnough = out.hold.hold !== null && out.hold.hold > 6 && out.hold.hold < 14;

// ---------- zone banner ----------
out.zoneSouth = await p.evaluate(async () => { window.__tp(300, 300, 0); return null; });
await p.waitForTimeout(400);
out.zoneAtSouthBeach = (await p.evaluate(() => window.__nav())).zone;
await p.evaluate(() => window.__tp(-300, -300, 0));
await p.waitForTimeout(400);
out.zoneAtFlamingo = (await p.evaluate(() => window.__nav())).zone;

// ---------- explicit building:colour ----------
out.colouredDusk = await p.evaluate(() => window.__byColour(255, 0, 0));

// ---------- day / night toggle ----------
const b0 = await p.evaluate(() => window.__bld(5));
await p.keyboard.press('n');
await p.waitForTimeout(500);
out.theme1 = await p.evaluate(() => window.__theme());
const b1 = await p.evaluate(() => window.__bld(5));
out.buildingChanged = b0.roof !== b1.roof && b0.wall !== b1.wall;
out.sample = { dusk: b0, day: b1 };
out.colouredDay = await p.evaluate(() => window.__byColour(255, 0, 0));
await p.evaluate(() => window.__tp(-480, -100, Math.PI / 2));
await p.keyboard.down('w'); await p.waitForTimeout(1500); await p.keyboard.up('w');
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/shot-day.png` });

await p.keyboard.press('n');
await p.waitForTimeout(500);
out.theme2 = await p.evaluate(() => window.__theme());
await p.evaluate(() => window.__tp(-480, -100, Math.PI / 2));
await p.keyboard.down('w'); await p.waitForTimeout(1500); await p.keyboard.up('w');
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/shot-dusk.png` });

// fps after all that
out.fps = await p.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));
/* ---------- gold, hard-edged, and the same in both themes ---------- */
/* Asked for in three goes, and the third is the one this encodes: yellow text,
   no blue aura, clear edges. The light blue ring the second go added did read
   as a haze at thirteen pixels rather than as an outline, and turned the word
   blue-green.
 *
 * WHAT IS ASSERTED IS THE SHAPE OF THE RULE, not the hex. The fill is held
 * against --gold, which is the stylesheet's own constant — the same reason
 * daynight.mjs holds the stars against it instead of a number. The edge is held
 * to being DARK and REPEATED, which is what makes an outline rather than a
 * drop; to being UNBLURRED, which is what "clear edges" means and is the one
 * property a screenshot would not tell you apart from a soft one; and to
 * carrying no blue, which is the thing that was asked to go. */
const banner = () => p.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('street'));
  const root = getComputedStyle(document.documentElement);
  return { color: cs.color, shadow: cs.textShadow, size: cs.fontSize,
           gold: root.getPropertyValue('--gold').trim() };
});
const asRGB = hex => { const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
/* Split on the commas BETWEEN entries, not the ones inside rgb(...). */
const layers = sh => String(sh).split(/,(?![^(]*\))/).map(t => t.trim()).filter(Boolean)
  .map(t => {
    const col = (/rgba?\([^)]*\)|#[0-9a-f]+/i.exec(t) || [''])[0];
    const n = (col.match(/[\d.]+/g) || []).map(Number);
    const px = (t.replace(col, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
    return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, blur: px.length > 2 ? px[2] : 0 };
  });
const reads = b => {
  const L = layers(b.shadow);
  const dark = L.filter(l => 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b < 40);
  return {
    n: L.length,
    gold: b.color === asRGB(b.gold),
    // an outline is the same dark colour repeated round the glyph, not one drop
    outline: dark.length >= 4,
    // every layer hard: no halo, no glow, no soft drop
    crisp: L.every(l => l.blur === 0),
    // and nothing blue-leading anywhere in it
    noBlue: L.every(l => l.b <= Math.max(l.r, l.g) + 12),
    // big enough to read at a glance from the corner of the eye
    big: parseFloat(b.size) >= 15
  };
};
await p.evaluate(() => applyTheme('dusk'));
out.bannerDusk = await banner();
await p.evaluate(() => applyTheme('day'));
out.bannerDay = await banner();
out.readsDusk = reads(out.bannerDusk);
out.readsDay = reads(out.bannerDay);
out.bannerIsGoldAndHardEdged =
  Object.values(out.readsDusk).slice(1).every(Boolean) &&
  Object.values(out.readsDay).slice(1).every(Boolean);
// one treatment, not two: the whole point is that it needs no theme
out.sameInBothThemes = out.bannerDusk.color === out.bannerDay.color &&
                       out.bannerDusk.shadow === out.bannerDay.shadow;

out.errs = errs;

/* AND A VERDICT, which this did not have.
   For its whole life it printed a report and exited zero, so tests/run.mjs
   recorded a pass on every run whatever it found — the same hole hud.mjs and
   poi.mjs were pulled out of. The list is named rather than "every boolean in
   the report", so adding a diagnostic later cannot silently become a gate.

   Only claims observed to hold on a build that behaves are in here: the label
   names the street it is showing, a crossroads does not strobe through a list
   of names, the two districts are told apart, and the theme toggle actually
   repaints a building. */
out.namesTheStreet = !!out.onOcean.street && out.onOcean.streetTxt === out.onOcean.street &&
                     out.onOcean.streetShown && !!out.onAlpha.street &&
                     out.onAlpha.street !== out.onOcean.street;
out.doesNotStrobe = out.intersectionNames.length <= 3;
out.zonesAreToldApart = !!out.zoneAtSouthBeach && !!out.zoneAtFlamingo &&
                        out.zoneAtSouthBeach !== out.zoneAtFlamingo;
const ASSERTIONS = ['namesTheStreet', 'doesNotStrobe', 'zonesAreToldApart', 'buildingChanged',
                    'labelHoldsLongEnough', 'bannerIsGoldAndHardEdged', 'sameInBothThemes'];
out.failing = ASSERTIONS.filter(k => !out[k]);
out.pass = out.failing.length === 0 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
