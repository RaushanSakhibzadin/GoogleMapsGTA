/* The road-only default and the GHOST perk.

   Default: the road is the game. Off the tarmac the car drops to walking pace
   and leans back towards it, and buildings are solid.
   GHOST: off-road speed comes back and buildings stop being solid.

   The interesting case is neither of those. onRoad() is false both for a field
   and for ground whose tiles have not streamed in yet, and penalising the second
   would rebuild by hand the frontier-crawl bug fixed earlier this session — a
   car that will not move, throttle down, nothing there to explain it. So the
   last scenario drives out past the loaded tiles and insists it stays fast. */
import { chromium } from 'playwright';
import { CHROME, GAME, PERK_WORD, ROOT, armPerk, stubRadio } from './harness.mjs';
import { perkDigest, perkNorm } from '../tools/perkword.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const ring = (x0, y0, x1, y1) =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLL(x, y));
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
const atCentre = r => {
  const m = decodeURIComponent(r.request().postData() || '').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!m) return true;
  return Math.abs((+m[1] + +m[3]) / 2 - LAT0) < 3e-3 && Math.abs((+m[2] + +m[4]) / 2 - LON0) < 4e-3;
};

let id = 1;
function fixture() {
  const els = [];
  // one long east-west road to measure on, plus a grid so startGame doesn't
  // fall back to the generated city
  for (const y of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: y === 0 ? 'secondary' : 'residential', name: `EW ${y}` },
      geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-300, -150, 0, 150, 300])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `NS ${x}` },
      geometry: [toLL(x, -900), toLL(x, 900)] });
  // a solid block sitting in open ground, away from every road, to drive at
  els.push({ type: 'way', id: 5001, tags: { building: 'yes', 'building:levels': '5' },
    geometry: ring(40, 40, 130, 110) });
  els.push({ type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } });
  return { elements: els };
}

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext();
const p = await ctx.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q)) return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(atCentre(r) ? fixture() : { elements: [] }));
});
const URL_ = GAME;
await stubRadio(p);
await p.goto(URL_);
await p.waitForTimeout(250);

const out = {};

/* Checked HERE, with the menu actually on screen. Doing it mid-game would let
   offsetParent come back null for every element simply because the menu is
   hidden during play — a check that reports "not shown" whatever the code does,
   and passes just as happily when the links are broken. */
out.linksAtMenu = await p.evaluate(() => {
  const one = id => {
    const el = document.getElementById(id);
    return { visible: !!el.offsetParent, display: getComputedStyle(el).display,
             href: el.getAttribute('href'), target: el.getAttribute('target'),
             rel: el.getAttribute('rel') };
  };
  return { patM: one('patM'), perkM: one('perkM'), ghostM: one('ghostM'), keyM: one('keyM') };
});
/* THE SWITCH IS NO LONGER WHAT IS SHOWN HERE, and that is the change rather than
   a regression: on a browser that has never typed the word the perk block holds
   the word box and the ask, and the switch does not exist until it is unlocked.
   So the block and the link are asserted visible, the box with them, and the
   switch asserted ABSENT — which is the half that would otherwise quietly go
   back to a free toggle without a single test noticing. */
out.menuLinkWired = out.linksAtMenu.patM.visible &&
  out.linksAtMenu.perkM.visible && out.linksAtMenu.keyM.visible &&
  out.linksAtMenu.ghostM.display === 'none' &&
  /^https:\/\/www\.patreon\.com\//.test(out.linksAtMenu.patM.href || '') &&
  out.linksAtMenu.patM.target === '_blank' && /noopener/.test(out.linksAtMenu.patM.rel || '');

// and with no URL there must be nothing to see, on the same visible screen
out.emptyHidesEverything = await p.evaluate(() => {
  window.__patreon('');
  const gone = ['patM', 'perkM'].every(id => !document.getElementById(id).offsetParent);
  window.__patreon(null);
  const back = ['patM', 'perkM'].every(id => !!document.getElementById(id).offsetParent);
  return gone && back;
});

await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

/* Hold the throttle from a spot and report what the car did. Traffic is parked
   far away so nothing else is in the picture. */
async function hold(x, y, h, secs = 5) {
  return p.evaluate(async ([x, y, h, secs]) => {
    for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
    window.__tp(x, y, h);
    window.__setCarHp && null;
    await new Promise(r => requestAnimationFrame(r));
    const t0 = performance.now();
    let best = 0;
    await new Promise(res => {
      const tick = () => {
        window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
        best = Math.max(best, window.__p().spd);
        performance.now() - t0 < secs * 1000 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    const q = window.__p();
    window.__setInput(null);
    return { endKmh: Math.round(q.spd * 3.6), topKmh: Math.round(best * 3.6),
             x: +q.x.toFixed(1), y: +q.y.toFixed(1), hp: Math.round(q.hp), onRoad: q.onRoad };
  }, [x, y, h, secs]);
}

const setGhost = on => p.evaluate(v => window.__ghost(v), on);

/* ---- 1. default: the road is the game ---- */
await setGhost(false);
out.defaultOnRoad = await hold(-600, 0, 0);            // along EW 0
out.defaultOffRoad = await hold(-600, 60, 0);          // parallel, on the grass

/* THE KERB PULL, WHICH IS GONE, AND MUST STAY GONE.
 *
 * This used to assert the opposite: driven onto the grass and left alone, the
 * car had to haul itself back towards the tarmac unaided. It was reported from
 * play as the bug it is — "fix the side moving effect any time the car crawls" —
 * because from the driving seat a car that is already down to walking pace and
 * now will not go where it is pointed is not a car that wants the road.
 *
 * The staging is worth keeping exactly as it was, so this is inverted rather
 * than deleted: driven off the road, because that is the only way off it in
 * play, then hands off entirely, so anything that moves the car sideways is the
 * game and not the driver. crawl.mjs measures the same thing from a standstill;
 * this one measures it after a car has actually left the tarmac at speed. */
out.kerb = await p.evaluate(async () => {
  window.__ghost(false);
  window.__tp(-600, 0, 0);                             // on EW 0, heading east
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  // gas and full lock until it is off the tarmac and clear of it
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: -1, hand: 0 });
      performance.now() - t0 < 2200 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const left = window.__p();
  // now hands off entirely: whatever brings it back is the kerb, not the driver
  const t1 = performance.now();
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 0, brake: 0, steer: 0, hand: 0 });
      performance.now() - t1 < 5000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { leftAt: +Math.abs(left.y).toFixed(1), wasOffRoad: !left.onRoad,
           nowAt: +Math.abs(q.y).toFixed(1), backOnRoad: q.onRoad };
});
/* It has to have genuinely left, and then have STAYED where the driver left it.
   Three metres of slack, because the ground has a slope on it and a car parked
   on a grade rolls down one — that is a different feature and it is still there.
   The pull moved it from 18 m out to inside 14; it now sits at 17.5. */
out.noKerbMagnet = out.kerb.wasOffRoad && out.kerb.leftAt > 8 &&
                   !out.kerb.backOnRoad && out.kerb.nowAt > out.kerb.leftAt - 3;

/* Buildings stay solid without the perk. Started close and given time on
   purpose: the block sits in open ground, so the only way to reach it is at
   crawl speed — the first cut of this drove for six seconds from 100 m out,
   never got within 75 m of the wall, and "did not end up inside a building"
   was therefore true of a car in an empty field. */
out.defaultIntoBuilding = await p.evaluate(async () => {
  window.__ghost(false);
  for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
  window.__heal();
  window.__tp(85, 25, Math.PI / 2);                    // 15 m short of the north face
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let touched = false;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      if (window.__p().y > 33) touched = true;         // actually arrived at the wall
      performance.now() - t0 < 9000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { y: +q.y.toFixed(1), reachedIt: touched,
           inside: window.__inside(q.x, q.y), hp: Math.round(q.hp) };
});
// it has to have got there AND been stopped by it. Damage is not asserted:
// off-road you can only arrive at walking pace, well under the 4 m/s that hurts.
out.buildingStaysSolid = out.defaultIntoBuilding.reachedIt && !out.defaultIntoBuilding.inside;

/* ---- 1b. AND IT IS LOCKED UNTIL THE WORD GOES IN ---- */
/* GHOST used to be a switch sitting in the menu next to the Patreon ask, free
   to anyone who scrolled that far — which is a perk nobody has to back anything
   to get. The word now lives in the Patreon post and the switch does not exist
   until it is typed.
 *
 * DRIVEN THROUGH THE REAL BOX AND THE REAL BUTTON, because the gate is the UI:
 * calling the unlock function directly would test the string compare and not
 * the thing a supporter actually does. The wrong word is asked first — a gate
 * that opens for everything is not a gate, and it is the half that a happy-path
 * test never covers.
 *
 * THE SHIPPED WORD IS NOT KNOWABLE HERE — js/game.js carries a digest of it and
 * nothing else, which is what stops it being read off GitHub. So armPerk lends
 * the page a secret this file may contain, and the box, the button, the
 * normalisation and the comparison below are all the real ones. */
await armPerk(p);
out.lock = await p.evaluate(async word => {
  const vis = id => getComputedStyle(document.getElementById(id)).display !== 'none';
  const r = { perkedAtStart: window.__perked() };
  // the physics flag itself must refuse, not merely the button
  r.ghostRefused = window.__ghost(true) === false;
  window.__ghost(false);
  r.switchHidden = !vis('ghostM');
  r.boxShown = vis('keyM');

  const input = document.getElementById('keyMi');
  const say = () => document.getElementById('keyMe').textContent;
  input.value = 'open sesame';
  document.getElementById('keyMb').click();
  r.wrongPerked = window.__perked();
  r.wrongSaid = say();

  /* Typed the way a phone types it: a capital the keyboard added and a space
     that came with the paste. Both are meant to be forgiven. */
  input.value = '  ' + word.slice(0, 4).toUpperCase() + ' ' + word.slice(4) + '  ';
  document.getElementById('keyMb').click();
  r.messyPerked = window.__perked();
  r.switchNow = vis('ghostM');
  r.boxNow = vis('keyM');
  // unlocking makes the switch exist; it does not press it
  r.ghostStillOff = window.__ghost() === false;
  return r;
}, PERK_WORD);
out.lockedUntilTheWord =
  out.lock.perkedAtStart === false && out.lock.ghostRefused &&
  out.lock.switchHidden && out.lock.boxShown &&
  out.lock.wrongPerked === false && !!out.lock.wrongSaid &&
  out.lock.messyPerked === true && out.lock.switchNow && !out.lock.boxNow &&
  out.lock.ghostStillOff;

/* ---- 1c. THE TWO IMPLEMENTATIONS OF THE DIGEST AGREE ----
 *
 * There are two, and there have to be: js/game.js hashes in the browser, where
 * crypto.subtle does not exist on a file:// page, so it carries SHA-256 by
 * hand; tools/perkword.mjs hashes in node, where it uses the real one. If they
 * ever disagree, setting a new word writes a digest the game can never match
 * and locks out every supporter at once, silently, with the only symptom being
 * that the right word stops working. Nothing else in the suite would notice.
 *
 * Checked both ways: against node for real words, and against the published
 * SHA-256 of the empty string, which catches an implementation that is merely
 * self-consistent — two identically wrong hashes agree with each other. */
out.digest = await p.evaluate(words => {
  const hex = b => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };
  const r = { empty: hex(sha256(new TextEncoder().encode(''))), words: {} };
  for (const w of words) r.words[w] = perkDigest(perkNorm(w));
  return r;
}, [PERK_WORD, 'kalemegdan', 'a', '']);
out.digestsAgree =
  out.digest.empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
  [PERK_WORD, 'kalemegdan', 'a', ''].every(w => out.digest.words[w] === perkDigest(perkNorm(w)));

/* ---- 2. GHOST: speed back, walls gone ---- */
await setGhost(true);
out.ghostOffRoad = await hold(-600, 60, 0);

out.ghostThroughBuilding = await p.evaluate(async () => {
  window.__ghost(true);
  // nothing else in the picture: a civilian clipped at 26 m/s costs health,
  // and this scenario's whole claim is that GHOST costs none
  for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
  window.__heal();
  // +y is south, so heading PI/2 drives at the block from its north side. Started
  // close and given time: off-road even in GHOST is ~26 m/s, and 160 m of run-up
  // plus a 70 m building does not fit in six seconds.
  window.__tp(85, 0, Math.PI / 2);
  await new Promise(r => requestAnimationFrame(r));
  const hp0 = window.__p().hp;
  let wasInside = false;
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      const q = window.__p();
      if (window.__inside(q.x, q.y)) wasInside = true;
      performance.now() - t0 < 9000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  const q = window.__p();
  window.__setInput(null);
  return { hp0: Math.round(hp0), hp: Math.round(q.hp), y: +q.y.toFixed(1), wasInside,
           cameOutFarSide: q.y > 130 };
});
out.ghostDrivesThrough = out.ghostThroughBuilding.wasInside &&
                         out.ghostThroughBuilding.cameOutFarSide &&
                         out.ghostThroughBuilding.hp >= out.ghostThroughBuilding.hp0;

/* ---- 3. the AI is untouched in both modes ---- */
out.ai = await p.evaluate(async () => {
  const run = async ghost => {
    window.__ghost(ghost);
    window.__tp(0, 0, 0);
    window.__putTraffic(0, 40, 60, 0, null, 12, 0);    // a civilian out on the grass
    const t0 = performance.now();
    let best = 0;
    await new Promise(res => {
      const tick = () => {
        // __traffic() reports spd, not vx/vy — reading vx here gave 0 every time
        // and made this assertion true no matter what the code did
        const t = window.__traffic()[0];
        if (t) best = Math.max(best, t.spd);
        performance.now() - t0 < 2500 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    });
    return Math.round(best * 3.6);
  };
  return { offKmh: await run(false), onKmh: await run(true) };
});
// traffic never gets the player's kerb, so its speed must not care about GHOST
// it also has to actually be driving, or "unaffected" just means "stationary twice"
out.aiUnaffected = out.ai.offKmh > 10 && Math.abs(out.ai.offKmh - out.ai.onKmh) < 15;

/* ---- 4. the trap: ground that simply hasn't streamed in ---- */
out.frontier = await p.evaluate(async () => {
  window.__ghost(false);
  const bb = window.__chunks().bounds;
  /* WITH NO WIDE MAP, WHICH IS THE ONLY WAY THIS GROUND EXISTS. Three hundred
     metres inside the far edge used to be well past everything, because a
     session whose arterial sweep failed had no skeleton at all and the fence
     stood at 2740 m. A refused sweep now falls back to the skeleton in the
     bundle, and the fence is SIZED off that skeleton — so every point inside it
     has road data, the car correctly crawls between the motorways, and this
     measured 14 km/h and called it a regression.

     The condition under test is unchanged and still reachable: a city the bundle
     does not cover, whose sweep failed, has tiles and nothing else. Dropping the
     rectangle for the length of this section is that session — roadDataHere
     falls back to asking which tiles have landed, which is the question it was
     written around — and it is put back afterwards. */
  const keepRect = W.skelRect;
  W.skelRect = null;
  const x = bb.x1 - 300;
  const known = window.__roadDataHere(x, 0);
  window.__tp(x, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  let best = 0;
  await new Promise(res => {
    const tick = () => {
      window.__setInput({ gas: 1, brake: 0, steer: 0, hand: 0 });
      best = Math.max(best, window.__p().spd);
      performance.now() - t0 < 4000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  window.__setInput(null);
  W.skelRect = keepRect;
  return { x: Math.round(x), roadDataHere: known, topKmh: Math.round(best * 3.6) };
});
// unmapped is not the same as off-road: it must not crawl out here
out.frontierStaysFast = out.frontier.roadDataHere === false && out.frontier.topKmh > 60;

/* ---- 5. the pause card's copy, on screen where it actually lives ---- */
out.pauseCard = await p.evaluate(async () => {
  window.__ghost(false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const vis = id => !!document.getElementById(id).offsetParent;
  const r = { paused: window.__s(), patP: vis('patP'), perkP: vis('perkP'),
              pressed: document.getElementById('ghostP').getAttribute('aria-pressed') };
  document.getElementById('ghostP').click();          // the switch, really clicked
  r.afterClick = document.getElementById('ghostP').getAttribute('aria-pressed');
  r.ghostNow = window.__ghost();
  // offsetParent is null for ANY position:fixed element, so it reports "hidden"
  // for the tag whether it is on screen or not — computed display is the truth
  r.tagShown = getComputedStyle(document.getElementById('ghostTag')).display !== 'none';
  // and the menu copy has to have moved with it
  r.menuCopyAgrees = document.getElementById('ghostM').getAttribute('aria-pressed') === r.afterClick;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r2 => setTimeout(r2, 120));
  r.resumed = window.__s();
  return r;
});
out.pauseWorks = out.pauseCard.paused === 'pause' && out.pauseCard.patP && out.pauseCard.perkP &&
                 out.pauseCard.pressed === 'false' && out.pauseCard.afterClick === 'true' &&
                 out.pauseCard.ghostNow === true && out.pauseCard.tagShown &&
                 out.pauseCard.menuCopyAgrees && out.pauseCard.resumed === 'play';

/* ---- 6. the setting survives a reload ---- */
await setGhost(true);
const p2 = await ctx.newPage({ viewport: { width: 900, height: 640 } });
await p2.goto(URL_);
await p2.waitForTimeout(300);
out.survivesReload = await p2.evaluate(() => window.__ghost());
await p2.close();

/* AND A BROWSER THAT NEVER TYPED THE WORD DOES NOT GET IT — including one that
   had the old free toggle switched on, which is every player who ever used the
   perk while it was free. Their vm_ghost=1 is still sitting in localStorage; if
   the gate were only on the switch they would keep GHOST for ever and the lock
   would apply to new players only, which is the one group it does not need to.
   A fresh context, because localStorage is what is being tested. */
const ctx3 = await b.newContext();
const p3 = await ctx3.newPage({ viewport: { width: 900, height: 640 } });
await p3.addInitScript(() => { try { localStorage.setItem('vm_ghost', '1'); } catch (e) {} });
await p3.goto(URL_);
await p3.waitForTimeout(400);
out.stale = await p3.evaluate(() => ({
  ghost: window.__ghost(), perked: window.__perked(),
  switchHidden: getComputedStyle(document.getElementById('ghostM')).display === 'none'
}));
await p3.close(); await ctx3.close();
out.oldToggleIsRevoked = out.stale.ghost === false && out.stale.perked === false &&
                         out.stale.switchHidden;

out.fps = await p.evaluate(() => new Promise(r => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; performance.now() - t < 1500 ? requestAnimationFrame(tick) : r(Math.round(n / 1.5)); };
  requestAnimationFrame(tick);
}));

await p.screenshot({ path: `${OUT}/shot-ghost.png` });
out.errs = errs.slice(0, 5);
out.pass =
  /* 200, not 300. How far up the clock five seconds gets depends on how loaded
     the machine is — a full-suite run came in at 261 — and what this line is
     for is separating a road (hundreds) from the 14 km/h crawl beside it. The
     actual top speed is render.mjs's job. */
  out.defaultOnRoad.endKmh > 200 &&                  // the road itself is unchanged
  out.defaultOffRoad.topKmh < 25 &&                  // and off it you crawl
  out.noKerbMagnet &&
  out.buildingStaysSolid &&
  out.ghostOffRoad.endKmh > 60 &&                    // perk gives the speed back
  out.ghostDrivesThrough &&
  out.aiUnaffected &&
  out.frontierStaysFast &&
  out.menuLinkWired && out.emptyHidesEverything && out.pauseWorks &&
  out.lockedUntilTheWord && out.digestsAgree && out.oldToggleIsRevoked &&
  out.survivesReload === true &&
  out.fps >= 55 && !errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
