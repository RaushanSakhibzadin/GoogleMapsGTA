import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` }, geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` }, geometry: [toLL(x, -600), toLL(x, 600)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Downtown' } });
  return { elements: els };
};
const buildings = () => {
  const els = []; let id = 5000;
  for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) {
    const bx = i * 200 + 40, by = j * 200 + 40;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '6' },
      geometry: [[bx, by], [bx + 90, by], [bx + 90, by + 90], [bx, by + 90], [bx, by]].map(([x, y]) => toLL(x, y)) });
  }
  return { elements: els };
};
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');

// every element that can be on screen at once
const IDS = ['obj', 'mini', 'street', 'hpWrap', 'zone', 'speed', 'cash', 'stars', 'chunk',
             'tH', 'tN', 'tL', 'tR', 'tA', 'tB'];

const browser = await chromium.launch({ executablePath: CHROME });
const out = [];

// Landscape phone is the tightest of these — least height for the left-hand column.
const CASES = [
  ['desktop',         { viewport: { width: 1280, height: 800 } }],
  ['phone-portrait',  { ...devices['iPhone 13'] }],
  ['phone-landscape', { ...devices['iPhone 13 landscape'] }],
  ['ipad-portrait',   { ...devices['iPad (gen 7)'] }],
  ['ipad-landscape',  { ...devices['iPad (gen 7) landscape'] }],
];

for (const [label, ctxOpts] of CASES) {
  const ctx = await browser.newContext(ctxOpts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
  await p.route('**/api/interpreter', r => r.fulfill(json(isB(r.request()) ? buildings() : streets())));
  await p.goto(GAME);
  await p.waitForTimeout(250);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(800);
  // drive briefly so the street label and district banner are both showing
  await p.keyboard.down('w'); await p.waitForTimeout(1500); await p.keyboard.up('w');
  await p.waitForTimeout(400);

  const geo = await p.evaluate(ids => {
    const r = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const vis = b.width > 0 && b.height > 0 && getComputedStyle(el).display !== 'none' &&
                  parseFloat(getComputedStyle(el).opacity) > 0.05;
      if (vis) r[id] = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    }
    // The car isn't a DOM node — render() parks it at HX = VW/2, HY = VH*.60.
    // Treated as one more box so any HUD element sitting on it counts as a clash.
    const R = 34;
    r.CAR = { x: Math.round(innerWidth / 2 - R), y: Math.round(innerHeight * 0.60 - R), w: R * 2, h: R * 2 };
    return { boxes: r, vw: innerWidth, vh: innerHeight };
  }, IDS);

  // corner of each element, so we can assert where things ended up
  const corner = (b, vw, vh) => (b.y + b.h / 2 < vh / 2 ? 'top' : 'bottom') + '-' +
                                (b.x + b.w / 2 < vw / 2 ? 'left' : 'right');
  const where = {};
  for (const [id, b] of Object.entries(geo.boxes)) if (id !== 'CAR') where[id] = corner(b, geo.vw, geo.vh);

  const names = Object.keys(geo.boxes);
  const clashes = [], onCar = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = geo.boxes[names[i]], b = geo.boxes[names[j]];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 2 && oy > 2) {
      const msg = `${names[i]}×${names[j]} (${ox}×${oy}px)`;
      (names[i] === 'CAR' || names[j] === 'CAR' ? onCar : clashes).push(msg);
    }
  }
  // how much clear air the nearest HUD box leaves around the car
  const car = geo.boxes.CAR;
  let nearest = { id: null, gap: Infinity };
  for (const [id, b] of Object.entries(geo.boxes)) {
    if (id === 'CAR') continue;
    const gx = Math.max(b.x - (car.x + car.w), car.x - (b.x + b.w));
    const gy = Math.max(b.y - (car.y + car.h), car.y - (b.y + b.h));
    const gap = Math.max(gx, gy);
    if (gap < nearest.gap) nearest = { id, gap };
  }
  await p.screenshot({ path: `${OUT}/shot-hud-${label}.png` });

  // the off-screen arrow must dodge the radar in its corner: aim the objective west
  const arrowOk = await p.evaluate(async () => {
    const m = window.__mission();
    if (!m.pick) return 'no mission';
    window.__tp(m.pick.x + 900, m.pick.y, 0);       // target now far to the west
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mr = document.getElementById('mini').getBoundingClientRect();
    return { radar: { x: Math.round(mr.left), y: Math.round(mr.top), w: Math.round(mr.width) } };
  });

  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/shot-arrow-${label}.png` });
  out.push({ label, vw: geo.vw, vh: geo.vh, where, clashes, onCar, nearest, arrowOk, errs });
  await p.close(); await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
