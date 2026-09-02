import { chromium } from 'playwright';
import { CHROME, GAME, ROOT, stubRadio, parkOnAStraight } from './harness.mjs';
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
/* ONE BUILDING, and a long way from the road grid. Section 8 drives a patrol car
   into a wall, and this fixture had no walls at all; put anywhere near a street
   it would also be something the traffic could find on its own, which would put
   a variable into every other section here. */
const WALL = { x: 600, y: 600 }, WALL_R = 40;
const buildings = () => ({ elements: [{ type: 'way', id: 9001,
  tags: { building: 'yes', 'building:levels': '3' },
  geometry: [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
    .map(([a, c]) => toLL(WALL.x + a * WALL_R, WALL.y + c * WALL_R)) }] });

const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Midtown' }])));
await p.route('**/api/interpreter', r => r.fulfill(json(isB(r.request()) ? buildings() : streets())));
await stubRadio(p);
await p.goto(URL);
await p.waitForTimeout(250);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 30000 });
await p.waitForTimeout(500);
const out = {};

/* ---------- 1. a head-on shunt must hurt both cars ----------
 *
 * AND THE PLAYER DOES THE HITTING. This was two AI cars aimed at each other nine
 * metres apart, and it stopped testing anything the day traffic learned to keep
 * right: two cars travelling opposite ways along one road now steer into their
 * own lanes, about four metres apart, and slide past. It has been reporting
 * [100, 100] — neither car touched — and nothing noticed, because this file had
 * no verdict and exited 0 whatever it found. stuck.mjs hit the same wall and
 * solved it the same way: the player has no lane-keeping to steer it off the
 * line, so aiming it at a stationary car is deterministic. */
out.headOn = await p.evaluate(async () => {
  window.__tp(0, 0, 0);
  window.__heal();
  P.car.vx = 24; P.car.vy = 0;
  window.__putTraffic(0, 12, 0, Math.PI, null, 0, 0);     // parked 12 m ahead
  window.__setCarHp('traffic', 0, 100);
  const c0 = window.__cars().traffic;
  const ids = [c0[0].id, 'player'];
  const low = { [ids[0]]: 100, player: 100 };
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      for (const t of window.__cars().traffic)
        if (t.id in low) low[t.id] = Math.min(low[t.id], t.hp);
      low.player = Math.min(low.player, window.__p().hp);
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

/* ---------- 3. a wrecked car is slower than a healthy one ----------
 *
 * Same car measured twice, because every traffic car rolls its own maxSpeed —
 * comparing two different cars would be measuring the dice, not the damage.
 *
 * AND ON A CLEAR ROAD, WHICH IS THE HALF THAT WAS MISSING. What was measured was
 * a car embedded in traffic, so its peak speed was as much a fact about the
 * queue in front of it as about its engine: with the verdict added to this file
 * it failed one run in two, on healthy peaks of 11.97 against a wrecked 12.15 —
 * a healthy car stuck behind somebody and a wrecked one with the road to itself.
 * The cap goes to one for the measurement, so there is nobody to be stuck
 * behind, and the player is towed along 40 m behind the car so the 220 m traffic
 * cull cannot take it away mid-run — thirteen seconds at 15 m/s is 195 m, which
 * was the other half of the flake. The player is invisible to traffic here: the
 * panic-brake needs a wanted level and there is none until section 6. */
out.speed = await p.evaluate(async () => {
  const id = window.__cars().traffic[0].id;
  const capWas = TRAFFIC_SET;
  TRAFFIC_SET = 1;
  // The first seconds are ignored: a car coming off the healthy run is still
  // carrying that momentum, and drag needs a moment to bring it down to the
  // speed its damaged engine can actually hold.
  const run = async hp => {
    let top = 0, seen = true;
    const t0 = performance.now();
    await new Promise(res => {
      const tick = () => {
        window.__hpById(id, hp);                  // pinned, so collisions can't drift it
        const c = traffic.find(t => t.id === id);
        if (!c) seen = false;
        else {
          window.__tp(c.x - 40, c.y, 0);
          if (performance.now() - t0 > 2500) top = Math.max(top, Math.hypot(c.vx, c.vy));
        }
        performance.now() - t0 < 6500 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    return { top: +top.toFixed(2), seen };
  };
  const healthy = await run(100);
  const wrecked = await run(10);
  TRAFFIC_SET = capWas;
  /* AND LET THE STREET FILL BACK UP. The cap above cut the list to one car, and
     the next three sections want a bystander, three cars in a row and a civilian
     for a patrol car to hit — all of which read traffic[i] straight out and
     threw when it was not there. The top-up adds five a quarter-second, so this
     is a second or two; the bound is there so a world that cannot spawn fails
     the section rather than hanging the file. */
  window.__tp(0, 0, 0);
  P.car.vx = P.car.vy = 0;
  const t1 = performance.now();
  while (traffic.length < 5 && performance.now() - t1 < 8000)
    await new Promise(r => setTimeout(r, 200));
  return { id, healthyTop: healthy.top, wreckedTop: wrecked.top, refilled: traffic.length,
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

// ---------- 6b. a patrol car hits the traffic, and the traffic hits back ----------
/* Reported from play: police cars never hit other cars. They never could. There
   are four car-on-car tests in this game and not one of them had a cop on one
   side and a civilian on the other: trafficCollisions runs off the bucket grid,
   which is filled from the `traffic` array alone; the player is tested against
   traffic and against cops separately; and the cop loop is cop against cop. A
   cruiser drove through a bus.
 *
 * STAGED AS A CHASE, not as two cars pushed together, because the thing under
 * test is a patrol car doing what a patrol car does. The player is put at one
 * end, a civilian is parked in the middle, and a cop is dropped at the far end
 * pointed down the line: the cop drives at the player and the civilian is in the
 * way. BOTH cars are read, because "the cop shunts it" and "the cop is damaged
 * doing so" are two different halves of the report. */
/* DOWN A REAL STREET, and measured well enough to say what went wrong.
 *
 * This used to lay the three cars along the x axis through the origin. That is
 * 170 m of whatever happens to be there — and what is there depends on which car
 * came out of the pool first, because the run before it left the player in a
 * different place. It passed on its own five times running with identical
 * numbers and failed inside a full suite, reporting a cruiser that drove from
 * one end to the other with both cars still on 100: no collision, no clue.
 *
 * So the line is a straight the world already has, the same one five other tests
 * park on, and the gap the cruiser passes the civilian by is now part of the
 * report. A miss and a collision that does no damage are different bugs and used
 * to read the same. */
const straight = await parkOnAStraight(p, 130, 4);
out.copVsTraffic = await p.evaluate(async spot => {
  const h = spot ? spot.h : 0, ux = Math.cos(h), uy = Math.sin(h);
  const px = spot ? spot.x : 0, py = spot ? spot.y : 0;
  window.__tp(px, py, h);
  P.car.vx = P.car.vy = 0;
  window.__addWanted(3);
  await new Promise(r => setTimeout(r, 800));
  if (!window.__cars().cops.length || !window.__cars().traffic.length)
    return { note: 'nothing spawned' };
  const cid = window.__cars().cops[0].id;
  const tid = window.__cars().traffic[0].id;
  const t = traffic.find(q => q.id === tid);
  const k = cops.find(q => q.id === cid);
  /* ONE CIVILIAN ON THE ROAD, so the car the cruiser hits is the car this is
     measuring. With the street full it sometimes shunted a different one on the
     way — a cop that came out on 40 hp beside a target still on 100, which is
     the collision working and the measurement pointing at the wrong car. */
  const capWas = TRAFFIC_SET;
  TRAFFIC_SET = 1;
  // sixty metres up the road from the player, with the cruiser dropped another
  // fifty-five beyond it and already doing thirty back down the line
  const lane = { x: px + ux * 60, y: py + uy * 60 };
  const drop = { x: px + ux * 115, y: py + uy * 115 };
  let n = 0, missedBy = 99, sawIt = false, res = null;
  while (n++ < 3) {
    window.__tp(px, py, h);
    P.car.vx = P.car.vy = 0;
    // the civilian parked, with no engine of its own so what happens to it is
    // what the cop did to it
    window.__putTraffic(traffic.indexOf(t), lane.x, lane.y, h + Math.PI, null, 0, 0);
    t.hp = 100; t.accel = 0; t.maxSpeed = 200;
    window.__putCop(cops.indexOf(k), drop.x, drop.y, h + Math.PI, -ux * 30, -uy * 30);
    k.hp = 100;
    missedBy = 99;
    let hitAt = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2600) {
      await new Promise(r => requestAnimationFrame(r));
      const kk = cops.find(q => q.id === cid), tt = traffic.find(q => q.id === tid);
      if (!kk || !tt) break;                      // one of them is gone: they met
      const along = (kk.x - tt.x) * ux + (kk.y - tt.y) * uy;
      if (Math.abs(along) < 10) {
        // how wide it went by, and whether the grid the cop asks even had it
        missedBy = Math.min(missedBy, Math.abs((tt.x - kk.x) * uy - (tt.y - kk.y) * ux));
        sawIt = sawIt || nearTraffic(kk.x, kk.y).indexOf(tt) >= 0;
      }
      // a second after contact, because being shunted down the road is half of
      // what is being read and none of it has happened on the frame of the hit
      if (!hitAt && tt.hp < 100) hitAt = performance.now();
      if (hitAt) { if (performance.now() - hitAt > 1000) break; }
      else if (along < -12) break;                // past it: line them up again
    }
    const tt = traffic.find(q => q.id === tid), kk = cops.find(q => q.id === cid);
    res = { copHp: kk ? Math.round(kk.hp) : 0, copGone: !kk,
            carHp: tt ? Math.round(tt.hp) : 0, carGone: !tt,
            shoved: tt ? Math.round(Math.hypot(tt.x - lane.x, tt.y - lane.y)) : null };
    if (res.carGone || res.carHp < 100) break;
  }
  TRAFFIC_SET = capWas;
  return { ...res, drops: n, missedBy: +missedBy.toFixed(1), sawIt,
           street: spot ? spot.street : '(the origin)' };
}, straight);
out.policeHitTraffic = !!out.copVsTraffic.note ||
  ((out.copVsTraffic.carGone || out.copVsTraffic.carHp < 100) &&
   (out.copVsTraffic.copGone || out.copVsTraffic.copHp < 100) &&
   (out.copVsTraffic.carGone || out.copVsTraffic.shoved > 2));

// ---------- 6c. and a wall costs them something ----------
/* buildingCollide was already called for a cruiser, so one has always been
   pushed back out of a building — but the closing speed it returns was thrown
   away, which made the wall a bumper. The player's damage from the same function
   has been there all along; this is the same number, through damageCar. */
out.copVsWall = await p.evaluate(async ([wx, wy]) => {
  /* THE PLAYER GOES BEYOND THE WALL, not behind the cop. A cruiser drives at the
     player and at nothing else: parked on the near side, it simply turned round
     and drove away from the building, which the first run of this measured as a
     car that ended up 8 m short of a wall it never aimed at. */
  window.__tp(wx + 200, wy, 0);
  window.__addWanted(3);
  await new Promise(r => setTimeout(r, 800));
  if (!window.__cars().cops.length) return { note: 'no cops' };
  const id = window.__cars().cops[0].id;
  const k = cops.find(q => q.id === id);
  k.hp = 100;
  // dropped just outside the wall at speed, aimed straight into it
  /* Fifty-five metres out. A cruiser off the tarmac keeps its engine — the
     off-road crawl is player-only — but it does carry the rough-ground drag, so
     it settles at about 20 m/s: the first run of this started it 90 m out and
     the two seconds ran out six metres short of the wall. */
  window.__putCop(cops.indexOf(k), wx - 55, wy, 0, 30, 0);
  const before = k.hp;
  await new Promise(r => setTimeout(r, 2000));
  const kk = cops.find(q => q.id === id);
  const r = { before, after: kk ? Math.round(kk.hp) : 0, gone: !kk,
              x: kk ? Math.round(kk.x) : null, wall: wx };
  /* AND BACK TO THE STREET GRID BEFORE THE NEXT SECTION. The wall is 200 m off
     the nearest road so that nothing else in this file can find it, which also
     means the traffic cannot respawn around a player left standing beside it —
     section 7 counts exactly that, and read 0 cars the first time this ran. */
  window.__tp(0, 0, 0);
  P.car.vx = P.car.vy = 0;
  return r;
}, [WALL.x, WALL.y]);
out.wallsCostThePolice = !!out.copVsWall.note ||
  (out.copVsWall.gone || out.copVsWall.after < out.copVsWall.before);

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
/* A VERDICT, WHICH THIS FILE DID NOT HAVE.
 *
 * It worked everything out, printed it, and exited 0 whatever it found — so
 * every assertion in it was decoration. That is how section 1 came to be
 * reporting [100, 100], two cars that never touched, for however long traffic
 * has been keeping right: nothing was reading it. The sections below are
 * asserted on the flags they already computed for themselves. */
out.pass = out.headOn.bothHurt &&
  out.explodes.reallyOrange && out.explodes.goneFromList &&
  out.speed.survived && out.speed.slower &&
  out.blast.playerAfter < out.blast.before.player &&
  out.blast.bystanderAfter < out.blast.before.bystander &&
  out.chain.chained &&
  (!!out.cop.note || (out.cop.gone && out.cop.refilled > 0)) &&
  out.policeHitTraffic && out.wallsCostThePolice &&
  out.refill.traffic > 0 && out.refill.cops > 0 &&
  out.fps >= 45 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
