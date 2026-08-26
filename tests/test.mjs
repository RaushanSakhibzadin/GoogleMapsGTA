import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const bboxOf = r => { const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/); return m ? m.slice(1).map(Number) : null; };
const URL = GAME;
const OUT = process.env.SHOTS || '/tmp';

import { fakeOSM } from './fake.mjs';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';

async function run(mode) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); else logs.push(m.text()); });

  if (mode === 'osm') {
    await page.route('**/nominatim.openstreetmap.org/**', r =>
      r.fulfill({ contentType: 'application/json',
        body: JSON.stringify([{ lat: '25.7825', lon: '-80.1300', display_name: 'Ocean Drive, Miami Beach, Florida' }]) }));
    await page.route('**/api/interpreter', r =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify(fakeOSM(bboxOf(r))) }));
  } else {
    await page.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  }

  await stubRadio(page);

  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.click('#go');

  // wait for gameplay
  await page.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 })
    .catch(async () => { throw new Error('never reached play state. msg=' + await page.textContent('#loadMsg')); });

  const world = await page.evaluate(() => window.__w());
  await page.waitForTimeout(500);
  const p0 = await page.evaluate(() => window.__p());

  // drive: hold W, then W+A to test steering, then handbrake
  await page.keyboard.down('w');
  await page.waitForTimeout(1800);
  const p1 = await page.evaluate(() => window.__p());
  await page.keyboard.down('a');
  await page.waitForTimeout(1200);
  const p2 = await page.evaluate(() => window.__p());
  await page.keyboard.down(' ');
  await page.waitForTimeout(800);
  await page.keyboard.up(' '); await page.keyboard.up('a');
  await page.waitForTimeout(2500);
  const p3 = await page.evaluate(() => window.__p());
  await page.keyboard.up('w');

  await page.screenshot({ path: `${OUT}/shot-${mode}.png` });

  // exercise the wanted system + respawn directly
  await page.evaluate(() => { window.__addWanted(3); });
  await page.waitForTimeout(1500);
  const cops = await page.evaluate(() => window.__p().cops);
  await page.evaluate(() => { window.__hurt(); });
  await page.waitForTimeout(300);
  const bigVisible = await page.evaluate(() => document.getElementById('big').classList.contains('on'));
  await page.waitForTimeout(2600);
  const afterRespawn = await page.evaluate(() => window.__p());

  // pause round-trip
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const paused = await page.evaluate(() => window.__s());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const resumed = await page.evaluate(() => window.__s());

  // fps sample
  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }));

  await browser.close();
  return { mode, world, p0, p1, p2, p3, cops, bigVisible, afterRespawn, paused, resumed, fps, errors };
}

const mode = process.argv[2] || 'osm';
const r = await run(mode);
console.log(JSON.stringify(r, null, 1));
