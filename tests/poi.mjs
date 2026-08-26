import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const URL = GAME;
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

// Where the fixture puts each landmark, in metres. The player starts near (0,0).
const POLICE = { x: 400, y: 0 }, HOSPITAL = { x: -400, y: 200 }, REPAIR = { x: 0, y: 400 };
const SOLID = { x: 300, y: 300 };   // an ordinary building, the control

const streets = (withPOI = true) => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` }, geometry: [toLL(-600, y), toLL(600, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` }, geometry: [toLL(x, -600), toLL(x, 600)] });
  if (withPOI) {
    // a station as a bare node, the way a lot of cities tag it
    els.push({ type: 'node', id: 800, ...toLL(POLICE.x, POLICE.y), tags: { amenity: 'police', name: 'Precinct 8' } });
    // a hospital as a building way — must land in pois AND still be a building
    const b = 45, h = HOSPITAL;
    els.push({ type: 'way', id: 801, tags: { amenity: 'hospital', building: 'yes', name: 'City General', 'building:levels': '4' },
      geometry: [[h.x - b, h.y - b], [h.x + b, h.y - b], [h.x + b, h.y + b], [h.x - b, h.y + b], [h.x - b, h.y - b]]
        .map(([x, y]) => toLL(x, y)) });
    els.push({ type: 'node', id: 802, ...toLL(REPAIR.x, REPAIR.y), tags: { shop: 'car_repair', name: 'Pay n Spray' } });
    // buildings around the two NODE landmarks: the node form has to make the
    // footprint it sits in passable, not just the way form
    const box = (cx, cy, r, id) => ({ type: 'way', id, tags: { building: 'yes', 'building:levels': '3' },
      geometry: [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]]
        .map(([x, y]) => toLL(x, y)) });
    els.push(box(POLICE.x, POLICE.y, 30, 803));
    els.push(box(REPAIR.x, REPAIR.y, 30, 804));
    els.push(box(SOLID.x, SOLID.y, 30, 805));      // no landmark: must stay solid
  }
  return { elements: els };
};
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');

async function boot(browser, { withPOI = true } = {}) {
  const p = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
  await p.route('**/api/interpreter', r => r.fulfill(json(isB(r.request()) ? { elements: [] } : streets(withPOI))));
  await stubRadio(p);
  await p.goto(URL);
  await p.waitForTimeout(250);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  await p.waitForTimeout(500);
  return { p, errs };
}

const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) < tol;
const b = await chromium.launch({ executablePath: CHROME });
const out = {};

// ---------- 1. all three parse, and the hospital way is still a building ----------
{
  const { p, errs } = await boot(b);
  out.parsed = await p.evaluate((H) => {
    const pois = window.__pois();
    const at = k => pois.find(x => x.kind === k);
    return { kinds: pois.map(x => x.kind).sort(), pois,
             // the hospital way must ALSO have become a building
             hospitalIsBuilding: window.__inside(H.x, H.y),
             buildings: window.__w().buildings };
  }, HOSPITAL);
  out.parsed.errs = errs;
  await p.close();
}

// ---------- 2. busted: a cop pulls up to a stopped player and arrests them ----------
// The reported bug. The player is held still but the COP is left entirely to its
// own AI -- it has to decide to stop by itself, which is what was broken.
{
  const { p, errs } = await boot(b);
  out.busted = await p.evaluate(async (P) => {
    window.__setCash(900);
    window.__tp(0, 0, 0);
    window.__addWanted(4);
    await new Promise(r => setTimeout(r, 600));
    // Put them 60 m out and then leave them entirely alone. They have to close in
    // and stop by themselves — random spawn points made this flaky, but the
    // approach is what the fix is about, so it's the part worth pinning down.
    window.__putCop(0, 60, 0, Math.PI);
    window.__putCop(1, -60, 14, 0);
    window.__putCop(2, 8, -60, Math.PI / 2);
    const t0 = performance.now();
    // Nothing is held after this point. Pinning the player each frame would zero
    // its velocity and hide the real failure: a cop that keeps its throttle down
    // shunts the stopped car around, so NEITHER speed settles and the bust that
    // needs both of them never lands.
    const speeds = [], pspeeds = [];
    let outcome = null, outcomeAt = null, hpLow = 100;
    const s2 = setInterval(() => {
      const k = window.__copSpeed ? window.__copSpeed() : null;
      if (k != null) speeds.push(+k.toFixed(2));
      else { const c0 = window.__cars().cops[0]; if (c0 && c0.spd != null) speeds.push(c0.spd); }
      pspeeds.push(window.__p().spd);
      // 450 is the bust (half of 900); 0 is a wasting. Cops that never stop ram a
      // stationary player to death, which is what "did not get arrested" was.
      if (outcome == null) {
        const c = window.__cash();
        if (c === 450) outcome = 'BUSTED';
        else if (c === 0) outcome = 'WASTED';
        if (outcome) outcomeAt = +((performance.now() - t0) / 1000).toFixed(1);
      }
      hpLow = Math.min(hpLow, window.__p().hp);
    }, 100);
    await new Promise(r => setTimeout(r, 16000));
    clearInterval(s2);
    const cashAfter = window.__cash();
    await new Promise(r => setTimeout(r, 3400));           // let the respawn land
    const w = window.__p();
    return { cashBefore: 900, cashAfter, landed: { x: w.x, y: w.y }, station: P,
             outcome, outcomeAt, hpLow: +hpLow.toFixed(1),
             copSlowest: speeds.length ? Math.min(...speeds) : null,
             playerSlowest: pspeeds.length ? Math.min(...pspeeds) : null,
             playerShunted: pspeeds.length ? Math.max(...pspeeds) : null };
  }, POLICE);
  out.busted.arrested = out.busted.outcome === 'BUSTED';
  out.busted.copActuallyStopped = out.busted.copSlowest < 3;
  out.busted.nearStation = near(out.busted.landed, POLICE, 90);
  out.busted.errs = errs;
  await p.close();
}

// ---------- 3. a cop blowing past a stopped player is not an arrest ----------
{
  const { p, errs } = await boot(b);
  out.notBusted = await p.evaluate(async () => {
    window.__setCash(900);
    window.__tp(0, 0, 0);
    window.__addWanted(2);
    await new Promise(r => setTimeout(r, 700));
    // same distance, but the cop is moving fast the whole time
    // same distance, but the cop is carrying real speed every frame
    const hold = setInterval(() => { window.__putCop(0, 3, 0, 0, 40, 0); window.__tp(0, 0, 0); }, 30);
    await new Promise(r => setTimeout(r, 2600));
    clearInterval(hold);
    return { cashAfter: window.__cash(), dead: window.__p().dead };
  });
  out.notBusted.errs = errs;
  await p.close();
}

// ---------- 4. wasted: cash to zero, wake at the hospital ----------
{
  const { p, errs } = await boot(b);
  out.wasted = await p.evaluate(async (H) => {
    window.__setCash(750);
    window.__tp(0, 0, 0);
    await new Promise(r => requestAnimationFrame(r));
    window.__hurt();                                       // straight to zero armor
    await new Promise(r => setTimeout(r, 300));
    const cashAfter = window.__cash();
    await new Promise(r => setTimeout(r, 3200));
    const w = window.__p();
    return { cashAfter, landed: { x: w.x, y: w.y }, hospital: H };
  }, HOSPITAL);
  out.wasted.nearHospital = near(out.wasted.landed, HOSPITAL, 90);
  out.wasted.errs = errs;
  await p.close();
}

// ---------- 5. no station / hospital on the map -> back to the start ----------
{
  const { p, errs } = await boot(b, { withPOI: false });
  out.fallback = await p.evaluate(async () => {
    const spawn = window.__spawn();
    window.__tp(spawn.x + 300, spawn.y + 300, 0);
    await new Promise(r => requestAnimationFrame(r));
    window.__hurt();
    await new Promise(r => setTimeout(r, 3400));
    const w = window.__p();
    return { pois: window.__pois().length, spawn, landed: { x: w.x, y: w.y } };
  });
  out.fallback.atStart = near(out.fallback.landed, out.fallback.spawn, 40);
  out.fallback.errs = errs;
  await p.close();
}

// ---------- 6. repair shop: costs $1000, and does nothing when you can't pay ----------
{
  const { p, errs } = await boot(b);
  out.repair = await p.evaluate(async (R) => {
    const dent = async () => { window.__tp(0, 0, 0); window.__explodeAt(7, 0); await new Promise(r => setTimeout(r, 220)); };

    // --- too poor: nothing may happen at all
    window.__setCash(400);
    window.__playerColour('#ff4fd8');
    await dent();
    const poorBefore = { hp: window.__p().hp, col: window.__p().colour, cash: window.__cash() };
    window.__tp(R.x, R.y, 0);
    await new Promise(r => setTimeout(r, 500));
    const poorAfter = { hp: window.__p().hp, col: window.__p().colour, cash: window.__cash() };

    // the refusal puts the shop on a short cooldown; let it lapse
    await new Promise(r => setTimeout(r, 2600));

    // --- can pay
    window.__setCash(2500);
    window.__playerColour('#ff4fd8');
    await dent();
    const before = { hp: window.__p().hp, col: window.__p().colour, cash: window.__cash() };
    window.__tp(R.x, R.y, 0);
    // sitting on the shop while broke keeps re-arming its short cooldown, so give
    // it room to lapse now that we can actually pay
    await new Promise(r => setTimeout(r, 3000));
    const after = { hp: window.__p().hp, col: window.__p().colour, cash: window.__cash() };
    // sitting on it must not keep charging or respraying
    const colours = new Set([after.col]);
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 120)); colours.add(window.__p().colour); }
    return { poorBefore, poorAfter, before, after, cashParked: window.__cash(),
             distinctColoursWhileParked: colours.size };
  }, REPAIR);
  const r = out.repair;
  out.repair.healed = r.before.hp < 100 && r.after.hp === 100;
  out.repair.recoloured = r.before.col !== r.after.col;
  out.repair.charged1000 = r.before.cash - r.after.cash === 1000;
  out.repair.chargedOnce = r.cashParked === r.after.cash;
  out.repair.poorUntouched = r.poorAfter.hp === r.poorBefore.hp &&
                             r.poorAfter.col === r.poorBefore.col &&
                             r.poorAfter.cash === r.poorBefore.cash;
  out.repair.errs = errs;
  await p.close();
}

// ---------- 6b. landmark buildings are drive-through, ordinary ones are not ----------
{
  const { p, errs } = await boot(b);
  out.through = await p.evaluate(async (pts) => {
    const flags = {
      hospitalWay: window.__passableAt(pts.HOSPITAL.x, pts.HOSPITAL.y),
      policeNode: window.__passableAt(pts.POLICE.x, pts.POLICE.y),
      repairNode: window.__passableAt(pts.REPAIR.x, pts.REPAIR.y),
      ordinary: window.__passableAt(pts.SOLID.x, pts.SOLID.y),
    };
    window.__setCash(0);
    window.__tp(pts.HOSPITAL.x - 90, pts.HOSPITAL.y, 0);
    return { flags, hp0: window.__p().hp };
  }, { HOSPITAL, POLICE, REPAIR, SOLID });
  // drive straight through the hospital with the real key handler, the way
  // fixes.mjs drives through a tunnel
  await p.keyboard.down('w');
  await p.waitForTimeout(5000);
  await p.keyboard.up('w');
  Object.assign(out.through, await p.evaluate((H) => {
    const q = window.__p();
    return { hpAfter: q.hp, endX: q.x, insideNow: window.__inside(q.x, q.y) };
  }, HOSPITAL));
  const t = out.through;
  out.through.allLandmarksPassable = t.flags.hospitalWay === true && t.flags.policeNode === true && t.flags.repairNode === true;
  out.through.ordinaryStaysSolid = t.flags.ordinary === false;
  out.through.noDamage = t.hpAfter === t.hp0;
  out.through.wentThrough = t.endX > HOSPITAL.x + 45;   // clear of the far wall
  out.through.errs = errs;
  await p.close();
}

// ---------- 7. the wide sweep: nothing nearby, landmarks 5 km and 12 km out ----------
{
  // The opening tile is bare. The wide sweep must fire on its own, ask for a much
  // larger box than any tile, and fold what it finds into the live world.
  const WIDE = { police: { x: 5000, y: 0 }, hospital: { x: 0, y: 12000 }, repair: { x: -4000, y: 0 } };
  const boxes = [];
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
  await p.route('**/api/interpreter', route => {
    const body = decodeURIComponent(route.request().postData() || '');
    const m = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    // the streets query carries amenity too now — the wide sweep is the one with no highways
    const isWide = /amenity/.test(body) && !/highway/.test(body);
    if (m) boxes.push({ wide: isWide, spanKm: +(((+m[4] - +m[2]) * M_LON / 1000).toFixed(1)) });
    if (isWide) {
      // `out center`: a way comes back as a single point, not an outline
      return route.fulfill(json({ elements: [
        { type: 'node', id: 9001, ...toLL(WIDE.police.x, WIDE.police.y), tags: { amenity: 'police', name: 'Far Precinct' } },
        { type: 'way', id: 9002, center: toLL(WIDE.hospital.x, WIDE.hospital.y), tags: { amenity: 'hospital', name: 'Far General' } },
        { type: 'node', id: 9003, ...toLL(WIDE.repair.x, WIDE.repair.y), tags: { shop: 'car_repair', name: 'Far Garage' } },
      ] }));
    }
    return route.fulfill(json(isB(route.request()) ? { elements: [] } : streets(false)));
  });
  await p.goto(URL);
  await p.waitForTimeout(250);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
  const missingAtStart = await p.evaluate(() => window.__missingKinds());
  // it fires itself 4 s in — wait for it rather than calling the hook
  await p.waitForFunction(() => window.__pois().length >= 3, null, { timeout: 20000 }).catch(() => {});
  out.wide = await p.evaluate((W) => ({
    missingAfter: window.__missingKinds(),
    pois: window.__pois(),
    // 5 km police is inside the recover cap, 12 km hospital is not
    recoverPolice: window.__recover('police'),
    recoverHospital: window.__recover('hospital'),
    spawn: window.__spawn(),
  }), WIDE);
  out.wide.missingAtStart = missingAtStart;
  out.wide.boxes = boxes;
  out.wide.wideBoxSpanKm = (boxes.find(x => x.wide) || {}).spanKm;
  out.wide.tileBoxSpanKm = (boxes.find(x => !x.wide) || {}).spanKm;
  out.wide.usedNearStation = Math.abs(out.wide.recoverPolice.x - WIDE.police.x) < 400;
  out.wide.cappedFarHospital = Math.hypot(out.wide.recoverHospital.x - out.wide.spawn.x,
                                          out.wide.recoverHospital.y - out.wide.spawn.y) < 40;
  out.wide.errs = errs;
  await p.close();
}

// ---------- 8. the ladder, now entirely during loading ----------
{
  // Nothing at 18 km, so the second rung has to be tried too -- and both must
  // happen before the game hands over, because once you're driving only
  // tile-sized requests are allowed to fire.
  const wideBoxes = [];
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
  await p.route('**/api/interpreter', route => {
    const body = decodeURIComponent(route.request().postData() || '');
    const m = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    const isWide = /amenity/.test(body) && !/highway/.test(body);
    if (isWide) {
      const spanKm = Math.round((+m[4] - +m[2]) * M_LON / 1000);
      wideBoxes.push(spanKm);
      // empty at the first rung; the second finds a station and a hospital
      if (spanKm < 60) return route.fulfill(json({ elements: [] }));
      return route.fulfill(json({ elements: [
        { type: 'node', id: 9101, ...toLL(20000, 0), tags: { amenity: 'police', name: 'County Police' } },
        { type: 'way', id: 9102, center: toLL(0, 22000), tags: { amenity: 'hospital', name: 'County General' } },
      ] }));
    }
    if (isB(route.request())) return route.fulfill(json({ elements: [] }));
    // a grid wide enough that driving east crosses into the next tile
    const els = []; let id = 1;
    for (const y of [-400, -200, 0, 200, 400])
      els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Cross ${y}` }, geometry: [toLL(-3000, y), toLL(3000, y)] });
    for (let x = -3000; x <= 3000; x += 400)
      els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Avenue ${x}` }, geometry: [toLL(x, -500), toLL(x, 500)] });
    return route.fulfill(json({ elements: els }));
  });
  await p.goto(URL);
  await p.waitForTimeout(250);
  await p.click('#go');
  // both rungs must already be done by the time we're playing
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 40000 });
  const atHandover = await p.evaluate(() => ({ sweep: window.__sweep(), missing: window.__missingKinds(),
                                               wideBoxesSoFar: null }));
  const boxesAtHandover = wideBoxes.slice();

  // then drive a long way into new tiles: nothing wide may fire while playing
  await p.evaluate(() => window.__tp(1400, 0, 0));
  await p.keyboard.down('w');
  await p.waitForTimeout(12000);
  await p.keyboard.up('w');
  await p.waitForTimeout(1500);

  out.ladder = await p.evaluate(async () => ({
    sweep: window.__sweep(),
    missing: window.__missingKinds(),
    pois: window.__pois().map(q => q.kind),
    // past the last rung it must stop asking
    extra: await window.__wideSearch(),
  }));
  await p.waitForTimeout(500);
  out.ladder.wideBoxesKm = wideBoxes;
  out.ladder.boxesAtHandover = boxesAtHandover;
  out.ladder.escalated = boxesAtHandover.length === 2 && boxesAtHandover[0] === 36 && boxesAtHandover[1] === 90;
  // the whole point of moving it: driving must not add a single wide request
  out.ladder.noneWhilePlaying = wideBoxes.length === boxesAtHandover.length;
  out.ladder.stoppedAtLastRung = out.ladder.extra === null;
  out.ladder.sweptAtHandover = atHandover.sweep.sweptTo;
  out.ladder.errs = errs;
  await p.close();
}

console.log(JSON.stringify(out, null, 1));
await b.close();
