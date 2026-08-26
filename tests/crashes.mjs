import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const URL = GAME;
const LAT0 = 40.7580, LON0 = -73.9855;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` }, geometry: [toLL(-700, y), toLL(700, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` }, geometry: [toLL(x, -700), toLL(x, 700)] });
  return { elements: els };
};
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
await p.route('**/api/interpreter', r => r.fulfill(json(isB(r.request()) ? { elements: [] } : streets())));
await stubRadio(p);
await p.goto(URL);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(500);
const out = {};

// ---------- 1. two traffic cars driven head-on must BOTH lose health ----------
// Positions alone aren't enough — the AI steers each car back toward its waypoint
// within a frame. They're given real closing velocity so the impact actually lands.
out.headOn = await p.evaluate(async () => {
  window.__tp(0, -300, 0);                                // player well out of the way
  window.__putTraffic(0, 0, 0, 0, null, 15, 0);           // east at 15 m/s
  window.__putTraffic(1, 9, 0, Math.PI, null, -15, 0);    // west at 15 m/s, 9 m apart
  window.__setCarHp('traffic', 0, 100); window.__setCarHp('traffic', 1, 100);
  const c0 = window.__cars().traffic;
  const ids = [c0[0].id, c0[1].id];
  const low = { [ids[0]]: 100, [ids[1]]: 100 };
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      for (const t of window.__cars().traffic)
        if (t.id in low) low[t.id] = Math.min(low[t.id], t.hp);
      performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  return { ids, lowest: ids.map(i => low[i]), bothHurt: ids.every(i => low[i] < 100) };
});

// ---------- 2. zero health: explodes, leaves the list, orange on screen ----------
out.explodes = await p.evaluate(async () => {
  window.__tp(0, 40, -Math.PI / 2);               // watching from 40 m south
  window.__putTraffic(0, 0, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  const id = window.__cars().traffic[0].id;
  const cv = document.getElementById('game'), g = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const s = window.__toScreen(0, 0);
  // Count the same patch before and after, and compare the DIFFERENCE. The scene
  // itself has warm street lights in it, and more of them once the city opens on
  // nine tiles -- an absolute count measures the lighting as much as the fireball.
  const sample = () => {
    let o = 0, y = 0;
    for (let dx = -40; dx <= 40; dx += 2) for (let dy = -40; dy <= 40; dy += 2) {
      const d = g.getImageData(Math.round((s[0] + dx) * dpr), Math.round((s[1] + dy) * dpr), 1, 1).data;
      if (d[0] > 190 && d[1] > 200) y++;
      else if (d[0] > 140 && d[2] < 120 && d[0] - d[1] > 50 && d[1] > 35) o++;
    }
    return { o, y };
  };
  const base = sample();
  window.__setCarHp('traffic', 0, 0);             // flatten it
  await new Promise(r => setTimeout(r, 120));
  // Orange has to beat yellow, not merely exist: additive blending happily
  // turns a bright orange fireball into a yellow one.
  const shot = sample();
  const orange = shot.o - base.o, yellow = shot.y - base.y;
  const mid = window.__cars();
  await new Promise(r => setTimeout(r, 900));
  const after = window.__cars();
  return { id, blastsAtImpact: mid.blasts, orangePixels: orange, yellowPixels: yellow,
           reallyOrange: orange > 25 && orange > yellow * 3,
           goneFromList: !after.traffic.some(t => t.id === id) };
});

// a frame grabbed while the fireball is still up, for eyeballing the effect
await p.evaluate(() => {
  window.__tp(0, 34, -Math.PI / 2);
  window.__putTraffic(0, 0, 0, 0); window.__putTraffic(1, 6, 4, 1);
  window.__setCarHp('traffic', 0, 0);
});
await p.waitForTimeout(130);
await p.screenshot({ path: `${OUT}/shot-explosion.png` });

// ---------- 3. a wrecked car is slower than a healthy one ----------
// Same car measured twice, because every traffic car rolls its own maxSpeed —
// comparing two different cars would be measuring the dice, not the damage.
out.speed = await p.evaluate(async () => {
  const id = window.__cars().traffic[0].id;
  // The first seconds are ignored: a car coming off the healthy run is still
  // carrying that momentum, and drag needs a moment to bring it down to the
  // speed its damaged engine can actually hold.
  const run = async hp => {
    let top = 0, seen = true;
    const t0 = performance.now();
    await new Promise(res => {
      const tick = () => {
        window.__hpById(id, hp);                  // pinned, so collisions can't drift it
        const c = window.__cars().traffic.find(t => t.id === id);
        if (!c) seen = false;
        else if (performance.now() - t0 > 2500) top = Math.max(top, c.spd);
        performance.now() - t0 < 6500 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    return { top: +top.toFixed(2), seen };
  };
  const healthy = await run(100);
  const wrecked = await run(10);
  return { id, healthyTop: healthy.top, wreckedTop: wrecked.top,
           survived: healthy.seen && wrecked.seen,
           slower: wrecked.top < healthy.top * .6 };
});

// ---------- 4. the blast hurts the player and a bystander ----------
out.blast = await p.evaluate(async () => {
  window.__tp(0, 0, 0);
  window.__putTraffic(0, 8, 0, 0);                // bystander 8 m away
  window.__setCarHp('traffic', 0, 100);
  await new Promise(r => requestAnimationFrame(r));
  const before = { player: window.__cars().playerHp, bystander: window.__cars().traffic[0].hp };
  window.__explodeAt(4, 0);                       // detonate between them
  await new Promise(r => setTimeout(r, 120));
  const c = window.__cars();
  return { before, playerAfter: c.playerHp, bystanderAfter: c.traffic[0] ? c.traffic[0].hp : 'destroyed' };
});

// ---------- 5. chain reaction ----------
// One blast kills the nearest two; the second one's own explosion is what
// reaches the third — that's the chain, and it needs no special code.
out.chain = await p.evaluate(async () => {
  window.__tp(0, -300, 0);                        // far enough out that the player survives
  const ids = [];
  for (let i = 0; i < 3; i++) {
    window.__putTraffic(i, i * 5, 0, 0);
    window.__setCarHp('traffic', i, 30);
    ids.push(window.__cars().traffic[i].id);
  }
  await new Promise(r => requestAnimationFrame(r));
  let peak = 0;
  window.__explodeAt(0, 0);
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      peak = Math.max(peak, window.__cars().blasts);
      performance.now() - t0 < 1500 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const live = window.__cars().traffic.map(t => t.id);
  const destroyed = ids.filter(i => !live.includes(i)).length;
  return { ids, peakBlasts: peak, destroyed, chained: destroyed > 1 };
});

// ---------- 6. police are destructible too ----------
out.cop = await p.evaluate(async () => {
  window.__tp(0, -300, 0);
  window.__addWanted(3);
  await new Promise(r => setTimeout(r, 900));
  const cops = window.__cars().cops;
  if (!cops.length) return { note: 'no cops spawned' };
  const id = cops[0].id;
  window.__setCarHp('cops', 0, 0);
  await new Promise(r => setTimeout(r, 700));
  const after = window.__cars().cops;
  return { id, before: cops.length, gone: !after.some(k => k.id === id), refilled: after.length };
});

// ---------- 7. the world refills afterwards ----------
await p.waitForTimeout(4000);
out.refill = await p.evaluate(() => {
  const c = window.__cars();
  return { traffic: c.traffic.length, cops: c.cops.length };
});
out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));
out.errs = errs;
console.log(JSON.stringify(out, null, 1));
await b.close();
