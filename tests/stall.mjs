import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const { fakeOSM } = await import('./fake.mjs');
const URL = GAME;

// scenario: which mirrors stall (never answer) vs. answer normally
// usage: node stall.mjs <first|all|skip|progress>
const mode = process.argv[2] || 'first';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: '44.8125', lon: '20.4612', display_name: 'Belgrade, City of Belgrade' }]) }));

const payload = JSON.stringify(fakeOSM());
const held = [];                       // requests we deliberately never answer

await p.route('**/api/interpreter', async route => {
  const host = new URL2(route.request().url()).host;
  const isPrimary = host.includes('overpass-api.de');
  const stallThis = mode === 'all' || mode === 'skip' ? true : isPrimary;
  if (stallThis) { held.push(route); return; }          // hang forever, like a queued mirror
  if (mode === 'progress') {
    await new Promise(r => setTimeout(r, 1500));
  }
  route.fulfill({ contentType: 'application/json', body: payload });
});
function URL2(u) { return new globalThis.URL(u); }

const t0 = Date.now();
await stubRadio(p);
await p.goto(URL);
await p.waitForTimeout(300);
await p.click('#go');

let outcome = 'HUNG', world = null, secs = 0;
try {
  if (mode === 'skip') {
    // wait for the escape hatch to appear, then use it
    await p.waitForSelector('#skip:visible', { timeout: 15000 });
    secs = (Date.now() - t0) / 1000;
    await p.click('#skip');
  }
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 40000 });
  outcome = 'PLAYING';
  world = await p.evaluate(() => window.__w());
} catch (e) {
  outcome = 'HUNG: ' + e.message.split('\n')[0];
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const loadMsg = await p.textContent('#loadMsg').catch(() => '');
const loadSub = await p.textContent('#loadSub').catch(() => '');
const bar = await p.evaluate(() => document.getElementById('barIn').style.width).catch(() => '');

console.log(JSON.stringify({
  mode, outcome, elapsed: elapsed + 's', skipShownAt: secs ? secs.toFixed(1) + 's' : null,
  procedural: world ? world.procedural : null,
  roads: world ? world.roads : null,
  loadMsg, loadSub, bar, heldRequests: held.length, errs
}, null, 1));
await browser.close();
