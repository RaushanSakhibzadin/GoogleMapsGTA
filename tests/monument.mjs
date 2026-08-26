/* THE MEMORIAL THAT WAS NOT THERE.
 *
 * Reported from Савски трг in Belgrade, which has carried a 23 m Stefan Nemanja
 * since 2021 and which the game drew as an empty plaza. Monuments were simply
 * not in the data: the landmark query asked for police stations, hospitals and
 * repair shops, and nothing else.
 *
 * NOTHING HERE IS HARD-CODED TO BELGRADE. The fixture is shaped like the real
 * OpenStreetMap entry for that square — historic=memorial, memorial=statue,
 * height=23 — because that is the case that was reported, but the code under
 * test reads tags, so a monument anywhere on Earth arrives the same way. The
 * fixture also carries the things that must NOT become monuments, which is the
 * half that is easy to leave out: `historic=memorial` covers both a bronze
 * horseman on a city square and a palm-sized plaque screwed to a wall, and
 * without the exclusions a city's worth of plaques becomes a forest of statues.
 *
 * WHAT IS ASSERTED, in order of how badly each one would be missed:
 *   - the monument exists in the world, at the right place, at its tagged height
 *   - it is SOLID: a car driven at it stops, rather than through it
 *   - the 3D view draws it, and draws it as stone rather than as a block of
 *     flats with lit windows up the side
 *   - a plaque, a bench and a ghost bike are not monuments
 *   - a monument tagged building=yes does not ALSO become an ordinary building
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const node = (id, x, y, tags) => ({ type: 'node', id, ...toLL(x, y), tags });

function streets() {
  const els = [];
  let id = 1;
  for (const y of [-400, 0, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `EW ${y}` },
               geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-400, 0, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
               geometry: [toLL(x, -900), toLL(x, 900)] });
  els.push(node(900, 0, 0, { place: 'suburb', name: 'Савски трг' }));
  return { elements: els };
}

/* The landmark sweep's reply. Five things that are monuments and four that look
   like monuments to a careless query and are not. */
const LANDMARKS = { elements: [
  // the reported one: a statue on a square, with its real height tagged
  node(1001, 120, 40, { historic: 'memorial', memorial: 'statue', name: 'Стефан Немања', height: '23' }),
  node(1002, -260, 120, { historic: 'monument', name: 'Monument' }),
  node(1003, 300, -180, { man_made: 'obelisk', name: 'Obelisk' }),
  node(1004, -150, -300, { tourism: 'artwork', artwork_type: 'statue', name: 'Statue' }),
  node(1005, 420, 260, { historic: 'memorial', memorial: 'war_memorial', name: 'War memorial' }),
  // and the furniture, which must stay furniture
  node(2001, 60, 60, { historic: 'memorial', memorial: 'plaque', name: 'Plaque' }),
  node(2002, 70, 70, { historic: 'memorial', memorial: 'bench', name: 'Bench' }),
  node(2003, 80, 80, { historic: 'memorial', memorial: 'ghost_bike', name: 'Ghost bike' }),
  node(2004, 90, 90, { tourism: 'artwork', artwork_type: 'mural', name: 'Mural' }),
  // a real landmark too, so the POI path is exercised alongside
  node(3001, -420, 0, { amenity: 'hospital', name: 'Bolnica' })
] };

/* A monument mapped as an outline AND tagged building=yes — very common, and the
   case where a memorial quietly becomes a tower block with windows. */
const BUILDINGS = { elements: [
  { type: 'way', id: 4001, tags: { historic: 'monument', building: 'yes', name: 'Mapped monument', height: '18' },
    geometry: [toLL(-60, 200), toLL(-44, 200), toLL(-44, 216), toLL(-60, 216), toLL(-60, 200)] },
  { type: 'way', id: 4002, tags: { building: 'residential', 'building:levels': '6' },
    geometry: [toLL(200, 200), toLL(240, 200), toLL(240, 240), toLL(200, 240), toLL(200, 200)] }
] };

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => {
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED/.test(m.text())) errs.push('console: ' + m.text());
});
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
}));
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/historic/.test(q) || /amenity/.test(q)) && !/highway/.test(q) ? 'pois' : 'streets';
  const body = kind === 'streets' ? streets()
             : kind === 'pois' ? LANDMARKS
             : kind === 'buildings' ? BUILDINGS : { elements: [] };
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};
/* The sweep runs on its own schedule; poke it until the monuments land rather
   than sleeping a fixed amount and hoping. */
for (let i = 0; i < 8; i++) {
  const n = await p.evaluate(() => W.buildings.filter(b => b.mono).length);
  if (n >= 5) break;
  await p.evaluate(() => window.__sweep && window.__sweep());
  await p.waitForTimeout(1200);
}

out.mons = await p.evaluate(() => W.buildings.filter(b => b.mono).map(b => ({
  kind: b.mono.kind, name: b.mono.name,
  x: Math.round(b.cx), y: Math.round(b.cy), h: +b.h.toFixed(1)
})).sort((a, b) => a.name.localeCompare(b.name)));
out.names = out.mons.map(m => m.name);

/* ---- 1. the reported monument is there, where it is, as tall as it is ---- */
const nemanja = out.mons.find(m => m.name === 'Стефан Немања');
out.nemanja = nemanja || null;
out.theOneThatWasAskedFor = !!nemanja &&
  Math.abs(nemanja.x - 120) < 3 && Math.abs(nemanja.y - 40) < 3 &&
  Math.abs(nemanja.h - 23) < 0.1 && nemanja.kind === 'statue';

/* ---- 2. and the furniture is still furniture ---- */
out.rejected = ['Plaque', 'Bench', 'Ghost bike', 'Mural'].filter(n => out.names.includes(n));
out.plaquesAreNotMonuments = out.rejected.length === 0;
out.hasFive = out.mons.length === 6;   // five swept + one mapped as a building
out.rejectedAll = ['Plaque', 'Bench', 'Ghost bike', 'Mural'];

/* ---- 3. a mapped monument is not ALSO an ordinary building ---- */
/* This is the one that would go unnoticed: the memorial appears, correctly, and
   a block of flats appears inside it. Counting what sits at that spot is the
   only way to see it. */
out.atMapped = await p.evaluate(() => W.buildings.filter(b =>
  Math.hypot(b.cx - (-52), b.cy - 208) < 14).map(b => ({ mono: !!b.mono, h: +b.h.toFixed(1) })));
out.mappedIsOnlyAMonument = out.atMapped.length === 1 && out.atMapped[0].mono;

/* ---- 4. it is solid ---- */
/* ASKED AS "CAN THE CAR BE INSIDE IT", which is the only form of this question
   that the terrain does not get a vote on.

   Two ram tests were written before this one and neither proved anything. From
   rest the car covered 13 m of the 22 it needed; given 22 m/s it still only made
   11 m of 30, because a monument stands on a SQUARE and a square is off-road,
   where this game deliberately reduces a car to a crawl. Both "passed" on the
   gap alone while the car had simply never arrived — and would have passed just
   the same on a monument you can drive straight through.

   Putting the car on the monument's own centre removes the journey from the
   experiment. A solid object ejects it within a frame or two; a hologram leaves
   it sitting inside. */
out.ram = !nemanja ? null : await p.evaluate(async () => {
  const m = W.buildings.find(b => b.mono && b.mono.name === 'Стефан Немања');
  if (!m) return null;
  window.__ghost(false);
  window.__heal();
  const r = Math.max(m.bb.x1 - m.bb.x0, m.bb.y1 - m.bb.y0) * 0.5;
  window.__tp(m.cx, m.cy, 0);
  const inside0 = window.__inside(m.cx, m.cy);
  // a handful of frames for the collision resolver to run
  for (let i = 0; i < 8; i++) await new Promise(r2 => requestAnimationFrame(r2));
  const q = window.__p();
  return { plinthR: +r.toFixed(2), footprintIsSolid: inside0,
           endD: +Math.hypot(q.x - m.cx, q.y - m.cy).toFixed(2),
           stillInside: window.__inside(q.x, q.y) };
});
/* Pushed clear of its own footprint, and the footprint is one the world agrees
   is solid ground — __inside is the same test the physics uses. */
out.isSolid = !!out.ram && out.ram.footprintIsSolid && !out.ram.stillInside &&
              out.ram.endD > out.ram.plinthR;

/* ---- 5. the chase view draws it, in stone, without windows ---- */
/* A/B AGAINST ITS OWN ABSENCE, not against a colour guess.

   The first version classified pixels as "stone" and "lit window" by their RGB
   and counted them in the upper half of the frame. It read 120 stone and 49 lit
   against thresholds of 400 and 40 — and the lit ones were the block of flats
   behind it, which is exactly the kind of thing a colour heuristic cannot tell
   apart from the subject. So instead the monument is taken out of the world and
   the same frame drawn again: whatever changed IS the monument, with nothing
   else to argue about.

   The window question is then asked only of those pixels. A monument built as a
   building would put lit panes inside its own silhouette; stone has none. */
/* Guarded on the monument existing at all. Without it every later section
   dereferences an undefined and the whole file dies with a TypeError — which is
   still a failure, but a crash prints no report, and the report is how anyone
   finds out WHICH part broke. Checked against the build with monuments removed:
   it now says so in the JSON instead of throwing. */
out.threeD = nemanja ? await p.evaluate(() => window.__setMode3d(true)) : false;
if (out.threeD) {
  await p.waitForTimeout(2500);
  out.look = await p.evaluate(async () => {
    const m = W.buildings.find(b => b.mono && b.mono.name === 'Стефан Немања');
    // stood back and pointing at it, and stopped, so two frames can be compared
    window.__tp(m.cx - 40, m.cy, 0);
    P.car.vx = P.car.vy = 0;
    window.__keepState = state; state = 'pause';
    const settle = n => { for (let i = 0; i < n; i++) window.__px3(0, 0, 1, 1); };
    settle(40);
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const withIt = window.__px3(0, 0, w, h);

    const keep = W.buildings;
    W.buildings = W.buildings.filter(b => b !== m);
    W.buckets.clear(); indexBuildings(0);
    settle(40);                       // cells rebuild one per frame
    const without = window.__px3(0, 0, w, h);

    W.buildings = keep;
    W.buckets.clear(); indexBuildings(0);
    settle(40);
    state = window.__keepState;

    let changed = 0, lit = 0;
    for (let i = 0; i < withIt.length; i += 4) {
      const dr = Math.abs(withIt[i] - without[i]);
      const dg = Math.abs(withIt[i + 1] - without[i + 1]);
      const db = Math.abs(withIt[i + 2] - without[i + 2]);
      if (dr + dg + db < 24) continue;
      changed++;
      const R = withIt[i], G = withIt[i + 1], B = withIt[i + 2];
      // the warm glow the window shader paints for a lit pane
      if (R > 185 && G > 140 && B < 125) lit++;
    }
    return { changed, lit, total: w * h,
             pct: +(100 * changed / (w * h)).toFixed(2) };
  });
  // a 23 m column 40 m away is a small but unmistakable part of the frame
  out.isDrawn = out.look.changed > 900;
  out.noWindowsOnIt = out.look.lit < out.look.changed * 0.02;
  out.drawnAsStone = out.isDrawn && out.noWindowsOnIt;
}

out.errs = errs.slice(0, 4);
/* threeD false means either no WebGL2 or no monument to look at. The first is a
   legitimate skip; the second must not be, or removing the feature would quietly
   skip the drawing check instead of failing it. */
out.pass = out.theOneThatWasAskedFor && out.plaquesAreNotMonuments && out.hasFive &&
           out.mappedIsOnlyAMonument && out.isSolid &&
           (out.threeD ? out.drawnAsStone : !nemanja ? false : true) &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
