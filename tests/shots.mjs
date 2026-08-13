import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const URL = GAME;
const OUT = process.env.SHOTS || '/tmp';

let out_nav = null;
const browser = await chromium.launch({ executablePath: CHROME });

// --- 1. the menu, desktop
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL); await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/shot-menu.png` });
  await p.close();
}

// --- 2. mobile: touch pads must appear and the HUD must not collide
{
  const ctxm = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctxm.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p.goto(URL); await p.waitForTimeout(400);
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(600);
  const touchOn = await p.evaluate(() => document.getElementById('touch').classList.contains('on'));
  // hold the on-screen accelerator
  const box = await p.locator('#tA').boundingBox();
  await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await p.evaluate(() => {
    const e = new Touch({ identifier: 1, target: document.getElementById('tA') });
    document.getElementById('tA').dispatchEvent(new TouchEvent('touchstart', { touches: [e], bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(1600);
  const moved = await p.evaluate(() => window.__p());
  out_nav = await p.evaluate(() => window.__nav());
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p.screenshot({ path: `${OUT}/shot-mobile.png` });
  console.log(JSON.stringify({ touchOn, moved, nav: out_nav, horizontalOverflow: overflow, errs }, null, 1));
  await p.close();
}
await browser.close();
