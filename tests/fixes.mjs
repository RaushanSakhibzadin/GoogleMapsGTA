import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const URL = GAME;
const LAT0 = 56.9496, LON0 = 24.1052;                       // Riga
const atCentre = r => {
  const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return true;
  return Math.abs((+m[1] + +m[3]) / 2 - LAT0) < 3e-3 && Math.abs((+m[2] + +m[4]) / 2 - LON0) < 4e-3;
};
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

// A straight east-west street, with a building sitting squarely across it —
// the archway/tunnel case from Riga's old town.
function rigaish() {
  const els = [];
  let id = 1;
  // a proper little grid, or startGame falls back to the procedural city (<6 roads)
  for (const y of [-300, -150, 0, 150, 300]) {
    els.push({ type: 'way', id: id++,
      tags: { highway: y === 0 ? 'secondary' : 'residential', name: `EW ${y}`, ...(y === 0 ? { tunnel: 'yes', layer: '-1' } : {}) },
      geometry: [toLL(-600, y), toLL(600, y)] });
  }
  for (const x of [-300, -150, 0, 150, 300]) {
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
      geometry: [toLL(x, -600), toLL(x, 600)] });
  }
  // building straddling the y=0 street — the archway/tunnel case
  els.push({ type: 'way', id: 5001, tags: { building: 'yes', 'building:levels': '5' },
    geometry: [[180, -30], [250, -30], [250, 30], [180, 30], [180, -30]].map(([x, y]) => toLL(x, y)) });
  // control: a building in the middle of a block, touching no road — must stay solid
  els.push({ type: 'way', id: 5002, tags: { building: 'yes', 'building:levels': '5' },
    geometry: [[-260, 40], [-200, 40], [-200, 100], [-260, 100], [-260, 40]].map(([x, y]) => toLL(x, y)) });
  els.push({ type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Vecriga' } });
  return { elements: els };
}

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};

/* ---------------- 1 & 2: desktop ---------------- */
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga, Latvia' }]) }));
  // centre tile only: this fixture is pinned to one spot, so letting the opening
  // ring have it too would stack nine copies of every building on the same stones
  await p.route('**/api/interpreter', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify(atCentre(r) ? rigaish() : { elements: [] }) }));
  await stubRadio(p);
  await p.goto(URL);
  await p.waitForTimeout(300);

  // --- issue 2: spaces must reach the address box, and letters must not hit the game
  await p.click('#q');
  await p.keyboard.type('Riga Old Town');
  out.typed = await p.inputValue('#q');
  out.themeAfterTyping = await p.evaluate(() => window.__theme && window.__theme().name);
  await p.fill('#q', '');
  await p.keyboard.type('Riga, Latvia');
  out.typed2 = await p.inputValue('#q');

  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(400);
  out.passableBuildings = await p.evaluate(() => window.__passable());

  // --- issue 1: drive straight at the building that the road passes through
  await p.evaluate(() => window.__tp(60, 0, 0));
  await p.keyboard.down('w');
  const track = [];
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(1000);
    const q = await p.evaluate(() => window.__p());
    track.push({ t: i + 1, x: Math.round(q.x), hp: q.hp });
    if (q.x > 340) break;
  }
  await p.keyboard.up('w');
  out.track = track;
  const through = await p.evaluate(() => window.__p());
  out.throughTunnel = { x: Math.round(through.x), hp: through.hp };
  out.passedThrough = through.x > 300 && through.hp === 100;

  // --- control: a solid building beside the road must still stop and damage us
  await p.evaluate(() => window.__tp(-230, -10, Math.PI / 2));   // north of it, facing south
  await p.keyboard.down('w');
  await p.waitForTimeout(5000);
  await p.keyboard.up('w');
  const solid = await p.evaluate(() => window.__p());
  out.solidControl = { y: Math.round(solid.y), hp: solid.hp };
  out.stillSolid = solid.hp < 100 && solid.y < 45;

  out.desktopErrs = errs;
  await p.screenshot({ path: `${OUT}/shot-tunnel.png` });
  await p.close();
}

/* ---------------- 3: the day/night button on a phone ---------------- */
{
  const ctxm = await browser.newContext({ ...devices['iPad (gen 7)'] });
  const p = await ctxm.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Riga, Latvia' }]) }));
  // centre tile only: this fixture is pinned to one spot, so letting the opening
  // ring have it too would stack nine copies of every building on the same stones
  await p.route('**/api/interpreter', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify(atCentre(r) ? rigaish() : { elements: [] }) }));
  await p.goto(URL);
  await p.waitForTimeout(300);
  await p.tap('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(500);

  out.themeBtnVisible = await p.isVisible('#tN');
  out.themeBtnBox = await p.locator('#tN').boundingBox();
  out.themeBefore = await p.evaluate(() => window.__theme().name);
  await p.tap('#tN');
  await p.waitForTimeout(600);
  out.themeAfterTap = await p.evaluate(() => window.__theme().name);
  out.glyph = await p.textContent('#tN');
  await p.tap('#tN');
  await p.waitForTimeout(600);
  out.themeAfterSecondTap = await p.evaluate(() => window.__theme().name);

  // nothing may overlap the new button
  out.overlaps = await p.evaluate(() => {
    const r = document.getElementById('tN').getBoundingClientRect();
    const hit = [];
    for (const id of ['zone', 'speed', 'hpWrap', 'mini', 'tH', 'tA', 'tB', 'street', 'chunk']) {
      const el = document.getElementById(id); if (!el) continue;
      const o = el.getBoundingClientRect();
      if (o.width && r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top) hit.push(id);
    }
    return hit;
  });
  await p.screenshot({ path: `${OUT}/shot-ipad.png` });
  out.mobileErrs = errs;
  await p.close();
}

console.log(JSON.stringify(out, null, 1));
await browser.close();
