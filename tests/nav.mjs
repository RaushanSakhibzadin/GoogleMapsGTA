import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
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
out.errs = errs;
console.log(JSON.stringify(out, null, 1));
await browser.close();
