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
  /* DRIVEN FROM THE KEYBOARD, and the screen left as a player finds it.
     This used to hold the on-screen accelerator, which stopped existing when the
     stick became the default touch control — #tA is display:none and its box
     came back null, so the file threw four seconds in.
     Pinning it to pads mode would have fixed the crash and made this shot a
     picture of controls most players will never see. What this file is for is
     the mobile HUD as it ships, so the drive moves to the keyboard and the
     screen keeps the default. That the PADS still work under a thumb is
     mobile.mjs's job, and it asks for pads mode by name. */
  await p.keyboard.down('w');
  await p.waitForTimeout(1600);
  await p.keyboard.up('w');
  const moved = await p.evaluate(() => window.__p());
  out_nav = await p.evaluate(() => window.__nav());
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p.screenshot({ path: `${OUT}/shot-mobile.png` });
  console.log(JSON.stringify({ touchOn, moved, nav: out_nav, horizontalOverflow: overflow, errs }, null, 1));
  await p.close();
}
await browser.close();
