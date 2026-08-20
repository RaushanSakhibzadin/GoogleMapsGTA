/* Getting wasted should destroy the car, and the stars should be yellow.

   The car explosion is checked on particles and on the HUD, not on "wasted()
   was called": every other car in the game goes up through wreck(), and the
   player's just stopped dead with a banner over it. The dangerous part is the
   ordering — explode() damages whatever is standing in the blast, the player
   included, and the player's health is already zero, so getting it wrong means
   wasted() re-entering itself. That is what the recursion check is for. */
import { chromium, devices } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const OUT = process.env.SHOTS || '/tmp';
const LAT0 = 44.8069, LON0 = 20.4735;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isArterials = q => /motorway/.test(q) && !/residential/.test(q);
let id = 1;
const streets = () => ({ elements: [
  ...[-2, -1, 0, 1, 2].map(k => ({ type: 'way', id: id++,
    tags: { highway: k ? 'residential' : 'secondary', name: `EW ${k}` },
    geometry: [toLL(-900, k * 200), toLL(900, k * 200)] })),
  ...[-2, -1, 0, 1, 2].map(k => ({ type: 'way', id: id++,
    tags: { highway: 'residential', name: `NS ${k}` },
    geometry: [toLL(k * 200, -900), toLL(k * 200, 900)] })),
  { type: 'node', id: 6001, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Krunski venac' } },
] });

const b = await chromium.launch({ executablePath: CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r =>
  r.fulfill(json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Krunski venac' }])));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  if (isArterials(q) || /"building"/.test(q) || (/amenity/.test(q) && !/highway/.test(q)))
    return r.fulfill(json({ elements: [] }));
  return r.fulfill(json(streets()));
});
await p.goto(GAME);
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(700);

const out = {};

/* ---- the stars, in both themes ---- */
const stars = () => p.evaluate(() => {
  const el = document.getElementById('stars');
  // lit stars are bare text nodes — they take the row's own colour
  const off = el.querySelector('.off');
  const rgb = s => (s.match(/[\d.]+/g) || []).map(Number);
  const yellow = c => { const [r, g, b] = rgb(c); return r > 150 && g > 100 && b < Math.min(r, g) * .65; };
  const litColour = getComputedStyle(el).color;
  const offColour = off ? getComputedStyle(off).color : null;
  return {
    html: el.innerHTML.slice(0, 80),
    litColour, offColour,
    litYellow: yellow(litColour),
    offYellow: off ? yellow(offColour) : null,
  };
});
await p.evaluate(() => window.__addWanted(3 - window.__p().wanted));
await p.waitForTimeout(300);
out.starsDusk = await stars();
await p.evaluate(() => { document.body.classList.add('theme-day'); });
await p.waitForTimeout(120);
out.starsDay = await stars();
await p.evaluate(() => { document.body.classList.remove('theme-day'); });

/* ---- the car explodes ---- */
out.blast = await p.evaluate(async () => {
  window.__addWanted(-window.__p().wanted);
  window.__tp(-400, 0, 0);
  for (let i = 0; i < 30; i++) window.__putTraffic(i, 9000 + i * 12, 9000, 0);
  await new Promise(r => requestAnimationFrame(r));
  const before = window.__parts();
  const at = { x: window.__p().x, y: window.__p().y };
  window.__hurt();                                  // health to zero
  // one frame for the update to notice and blow it up
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  const after = window.__parts();
  const q = window.__p();
  return { partsBefore: before.parts, partsAfter: after.parts,
           blastsAfter: after.blasts, shake: +after.shake.toFixed(2),
           dead: q.dead, at,
           big: document.getElementById('bigT').textContent };
});
out.exploded = out.blast.partsAfter > out.blast.partsBefore + 20 && out.blast.blastsAfter > 0;
out.shook = out.blast.shake > .1;
out.saidWasted = /WASTED/.test(out.blast.big);

/* The ordering trap. explode() hurts whatever is in the blast, the player
   included, and the player is already on zero — so if P.dead is not set first,
   the blast calls wasted() again. Once is a fireball; twice is a loop. */
out.recursion = await p.evaluate(async () => {
  // the previous scenario left the player dead; wasted() is guarded on !P.dead,
  // so wait for the respawn or this counts zero and looks like a pass
  await new Promise(r => setTimeout(r, 3400));
  const alive = window.__p().dead === false;
  let calls = 0;
  window.__countWasted(() => { calls++; });
  window.__addWanted(-window.__p().wanted);
  window.__tp(-400, 0, 0);
  await new Promise(r => requestAnimationFrame(r));
  window.__hurt();
  await new Promise(r => setTimeout(r, 400));
  window.__countWasted(null);
  return { calls, alive };
});
out.noRecursion = out.recursion.alive === true && out.recursion.calls === 1;

// and it still comes back afterwards
out.respawned = await p.evaluate(async () => {
  await new Promise(r => setTimeout(r, 3200));
  const q = window.__p();
  return { dead: q.dead, hp: q.hp, cash: q.cash };
});
out.cameBack = out.respawned.dead === false && out.respawned.hp > 90;

/* THE MEDIAN OF THREE, NOT ONE, and gated well below sixty.

   This was one 1.5 s sample against `>= 50`, and on an idle machine the
   UNMODIFIED build measured 47, 49 and 51 on three consecutive runs — it failed
   its own gate two times in three and had been passing the suite on luck. A gate
   that a good build clears half the time is not a gate, it is a coin toss that
   eventually gets blamed on whatever landed most recently. It very nearly got
   blamed on the radar's objective pointer, which a direct benchmark then put at
   eight MICROSECONDS a frame.

   What this is actually for is catching the explosion turning the game into a
   slideshow, and forty is comfortably that: the worst honest reading on record
   here is 43, and a real collapse is in the teens. */
out.fpsRuns = [];
for (let i = 0; i < 3; i++) {
  out.fpsRuns.push(await p.evaluate(() => new Promise(r => {
    let n = 0; const t = performance.now();
    const tick = () => { n++; performance.now() - t < 1200 ? requestAnimationFrame(tick) : r(Math.round(n / 1.2)); };
    requestAnimationFrame(tick);
  })));
}
out.fps = out.fpsRuns.slice().sort((a, b) => a - b)[1];

await p.screenshot({ path: `${OUT}/shot-wasted.png` });
out.errs = errs.slice(0, 4);
out.pass = out.starsDusk.litYellow === true && out.starsDusk.offYellow === true &&
           out.starsDay.litYellow === true &&
           out.exploded && out.shook && out.saidWasted &&
           out.noRecursion && out.cameBack &&
           out.fps >= 40 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.pass ? 0 : 1);
