import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';

const LAT0 = 25.7825, LON0 = -80.1300;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const projX = lon => (lon - LON0) * M_LON;
const projY = lat => -(lat - LAT0) * M_LAT;

// Build a grid city for whatever bbox Overpass was asked for, so each tile has
// its own streets with tile-specific names we can assert on.
function cityFor(s, w, n, e) {
  const x0 = projX(w), x1 = projX(e), y0 = projY(n), y1 = projY(s);   // +y is south
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ti = Math.round(cx / 1800), tj = Math.round(cy / 1800);
  const tag = `T${ti}_${tj}`;
  const els = [];
  let id = Math.abs(ti * 1000 + tj) * 100000 + 1;
  const S = 180;
  const nx = Math.floor((x1 - x0) / S), ny = Math.floor((y1 - y0) / S);
  for (let i = 0; i <= nx; i++) {
    const x = x0 + i * S;
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `${tag} Avenue ${i}` },
      geometry: [toLL(x, y0), toLL(x, y1)] });
  }
  for (let j = 0; j <= ny; j++) {
    const y = y0 + j * S;
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `${tag} Street ${j}` },
      geometry: [toLL(x0, y), toLL(x1, y)] });
  }
  // a few buildings so the tile has mass
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const bx = x0 + i * S + 30, by = y0 + j * S + 30;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '4' },
      geometry: [[bx, by], [bx + 60, by], [bx + 60, by + 60], [bx, by + 60], [bx, by]].map(([x, y]) => toLL(x, y)) });
  }
  els.push({ type: 'node', id: id++, lat: toLL(cx, cy).lat, lon: toLL(cx, cy).lon,
    tags: { place: 'neighbourhood', name: `District ${tag}` } });
  // one repair shop per tile, so we can prove landmarks stream in with the map
  const rp = toLL(cx + 200, cy + 200);
  els.push({ type: 'node', id: id++, lat: rp.lat, lon: rp.lon,
    tags: { shop: 'car_repair', name: `${tag} Garage` } });
  return { elements: els };
}

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

const asked = [], wideAsked = [];
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Ocean Drive, Miami Beach' }]) }));
await p.route('**/api/interpreter', async route => {
  const body = decodeURIComponent(route.request().postData() || '');
  const m = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' });
  const [, s, w, n, e] = m.map(Number);
  // The landmark sweep asks for a 36 km box. Building a grid city for that would
  // be 40,000 buildings and kills the browser — it only ever wants landmarks.
  if (/amenity/.test(body) && !/highway/.test(body)) {
    wideAsked.push(Math.round((e - w) * M_LON / 1000));
    return route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' });
  }
  /* The arterial skeleton asks for a 72 km box. cityFor() lays a grid every 220 m
     with a building in each square, which over that area is a third of a million
     ways — minutes of JSON for a request whose answer this test does not care
     about. It only ever measures what the STREAMING does, tile by tile, so the
     skeleton gets a handful of long roads and nothing else. */
  if (/motorway/.test(body) && !/residential/.test(body)) {
    wideAsked.push(Math.round((e - w) * M_LON / 1000));
    const half = 30000, els = [];
    for (let k = -6; k <= 6; k++) {
      els.push({ type: 'way', id: 8000000 + k + 20, tags: { highway: 'primary', name: `Radial ${k}` },
        geometry: [toLL(-half, k * 2400), toLL(half, k * 2400)] });
      els.push({ type: 'way', id: 8000000 + k + 60, tags: { highway: 'primary', name: `Cross ${k}` },
        geometry: [toLL(k * 2400, -half), toLL(k * 2400, half)] });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: els }) });
  }
  asked.push({ s, w, n, e });
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(cityFor(s, w, n, e)) });
});

await stubRadio(p);

await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(400);

const out = {};
out.start = await p.evaluate(() => window.__chunks());

// drive east until we cross into the next tile; the world must extend ahead of us
await p.evaluate(() => window.__tp(600, 600, 0));
await p.keyboard.down('w');
const seen = [];
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(1000);
  const c = await p.evaluate(() => ({ ...window.__chunks(), pos: window.__p() }));
  seen.push({ t: i + 1, x: Math.round(c.pos.x), loaded: c.loaded, roads: c.roads,
              x1: Math.round(c.bounds.x1), note: c.note, onRoad: c.pos.onRoad });
  if (c.loaded >= 4) break;
}
await p.keyboard.up('w');
out.timeline = seen;
out.after = await p.evaluate(() => window.__chunks());

/* The world no longer GROWS as you drive — it was already 36 km wide before you
   took the wheel, and that is the point. What has to hold is that the ground
   ahead is drivable without anything being fetched, and that the bounds sit
   perfectly still while you cross what used to be a tile boundary. */
out.alreadyWide = out.start.bounds.x1 > 17000;
out.boundsHeldStill = out.after.bounds.x1 === out.start.bounds.x1 &&
                      out.after.bounds.y1 === out.start.bounds.y1;
out.newTileDrivable = await p.evaluate(() => {
  // sample the centre of tile (1,0) for road cells
  let hits = 0;
  for (let x = 1500; x < 2200; x += 20) for (let y = -300; y < 300; y += 20) if (window.__onRoad(x, y)) hits++;
  return hits;
});
// and far out on the skeleton, where no tile was ever fetched
out.farOutDrivable = await p.evaluate(() => {
  let hits = 0;
  for (let x = 9000; x < 12000; x += 25) for (let y = -1500; y < 1500; y += 25) if (window.__onRoad(x, y)) hits++;
  return hits;
});

// packets must be able to appear out there too
const packets = [];
for (let i = 0; i < 14; i++) {
  await p.evaluate(() => window.__newMission && window.__newMission());
  const m = await p.evaluate(() => window.__mission());
  if (m.pick) packets.push({ x: Math.round(m.pick.x), y: Math.round(m.pick.y) });
  await p.waitForTimeout(60);
}
out.packets = packets;
// Missions are placed in a band around the player, so "beyond the first tile"
// depends on where the player happens to be — what matters is that every one of
// them lands somewhere real and inside the world.
out.packetsInWorld = packets.length > 0 &&
  packets.every(q => Math.abs(q.x) < out.after.bounds.x1 && Math.abs(q.y) < out.after.bounds.y1);
out.streetsInNewTile = await p.evaluate(() => {
  window.__tp(1800, 0, 0);
  return null;
});
await p.waitForTimeout(600);
out.streetHere = (await p.evaluate(() => window.__nav())).street;
out.zoneHere = (await p.evaluate(() => window.__nav())).zone;
out.fps = await p.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));
out.bboxesAsked = asked.length;
out.wideSweepsKm = wideAsked;
// landmarks must arrive with their tile, not just the opening one
const pois = await p.evaluate(() => window.__pois());
out.pois = pois.map(q => q.name);
out.poisBeyondFirstTile = pois.filter(q => q.x > 900).length;
out.errs = errs;
await p.screenshot({ path: `${OUT}/shot-chunk.png` });
console.log(JSON.stringify(out, null, 1));
await browser.close();
