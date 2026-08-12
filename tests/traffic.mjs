/* TRAFFIC THAT DRIVES INSTEAD OF DETONATING.

   Reported: "all I hear is explosions of cars that are not on the screen."
   Three separate faults behind that one sentence, and this covers all three.

   THEY NEVER BRAKED FOR EACH OTHER. updateTraffic() slowed down for the player
   and for nothing else, so every car drove at full throttle into whatever was in
   front of it. With one car in twenty-six that is the odd shunt; with daylight's
   rush hour on the same streets it is a permanent demolition derby.

   EVERY PAIR WAS HIT TWICE. The car-on-car sweep lived inside the per-car
   update, so it ran every car against every other one — sixty-five thousand
   tests a frame at 255 cars — and each pair was resolved and damaged from both
   ends.

   AND YOU COULD HEAR ALL OF IT. Crashes and explosions played at full volume
   wherever they happened, six hundred metres away or under the bonnet.

   Usage: node tests/traffic.mjs [GAME=/path/to/index.html]
*/
import { chromium, devices } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'stari-grad');
const session = JSON.parse(readFileSync(join(FIX, 'session.json'), 'utf8'));
const gz = f => gunzipSync(readFileSync(join(FIX, f))).toString('utf8');
const rep = {};
for (const r of session.replies) if (r.elements) rep[r.kind] = { body: gz(r.file), bbox: r.bbox };
const EMPTY = readFileSync(join(FIX, 'empty.json'), 'utf8');
const b0 = rep.streets.bbox;
const LAT0 = (b0.s + b0.n) / 2, LON0 = (b0.w + b0.e) / 2;
const boxOf = q => { const m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  return m ? { s: +m[1], w: +m[2], n: +m[3], e: +m[4] } : null; };
const near = (a, t) => a && Math.abs((a.s + a.n) / 2 - (t.s + t.n) / 2) < 3e-3 &&
                            Math.abs((a.w + a.e) / 2 - (t.w + t.e) / 2) < 4e-3;
const chromeExe = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) for (const rel of ['chrome-linux/chrome', 'chrome']) {
    const f = join(root, d, rel);
    if (existsSync(f)) return f;
  }
  return null;
};
const exe = chromeExe();
const br = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await br.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Stari grad' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const box = boxOf(q);
  const kind = /motorway/.test(q) && !/residential/.test(q) ? 'arterials'
             : /"building"/.test(q) ? 'buildings'
             : (/amenity/.test(q) && !/highway/.test(q)) ? 'pois' : 'streets';
  let body = EMPTY;
  if (kind === 'arterials') body = rep.arterials.body;
  else if (kind === 'streets' && near(box, b0)) body = rep.streets.body;
  else if (kind === 'buildings' && near(box, rep.buildings.bbox)) body = rep.buildings.body;
  return r.fulfill({ contentType: 'application/json', body });
});
await p.goto('file://' + (process.env.GAME || '/home/user/GoogleMapsGTA/index.html'));
await p.waitForTimeout(250);
await p.tap('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(1200);

const out = {};
out.gaps = await p.evaluate(() => {
  const t = window.__traf();
  return { stop: t.gapStop, see: t.gapSee, radius: t.radius };
});

/* Daylight, because that is where it went wrong: the same streets with three
   times the cars on them. Drives for half a minute and watches. */
const runIn = theme => p.evaluate(async name => {
  applyTheme(name);
  /* Onto a real street first. Driving a constant turn from wherever the car
     happens to start walks it into a field, where there is no traffic and the
     count measures nothing — the longest drivable way near the centre is where
     the cars are. */
  const roads = window.__roadList().filter(r => r.drive);
  let best = null, bestLen = 0;
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (Math.hypot(a.x, a.y) > 700) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > bestLen) { bestLen = L; best = { a, b }; }
  }
  if (best) window.__tp(best.a.x, best.a.y, Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x));
  await new Promise(r => setTimeout(r, 4000));       // let the cap fill
  const w0 = window.__traf().wrecks;
  const t0 = performance.now();
  let frames = 0, samples = 0;
  let minGap = Infinity, sumSpd = 0, sumStopped = 0, maxOut = 0, sumOnScreen = 0;
  await new Promise(res => {
    const tick = () => {
      /* City pace, not flat out. At 300 km/h the car crosses the whole traffic
         ring in two seconds and spends the run in ground where cars have only
         just spawned at the edge — which measures how fast the player is, not
         how much traffic there is. */
      const spd = window.__p().spd;
      window.__setInput({ gas: spd < 19 ? 1 : 0, brake: 0, steer: 0, hand: 0 });
      frames++;
      if (frames % 12 === 0) {
        samples++;
        const cars = window.__traffic(), me = window.__p();
        const r = window.__traf().radius;
        let stopped = 0;
        for (let i = 0; i < cars.length; i++) {
          const a = cars[i];
          sumSpd += a.spd;
          if (a.spd < 1) stopped++;
          // nothing may be simulated well outside the ring
          maxOut = Math.max(maxOut, Math.hypot(a.x - me.x, a.y - me.y) - r);
          const [sx, sy] = window.__toScreen(a.x, a.y);
          if (sx > -40 && sy > -40 && sx < innerWidth + 40 && sy < innerHeight + 40) sumOnScreen++;
          // and the closest two cars ever get to each other
          for (let j = i + 1; j < cars.length; j++) {
            const b = cars[j];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d < minGap) minGap = d;
          }
        }
        sumStopped += cars.length ? stopped / cars.length : 0;
      }
      if (performance.now() - t0 < 16000) requestAnimationFrame(tick);
      else { window.__setInput(null); res(); }
    };
    requestAnimationFrame(tick);
  });
  const el = (performance.now() - t0) / 1000;
  const cars = window.__traffic().length;
  return { secs: +el.toFixed(1), cars,
           wrecks: window.__traf().wrecks - w0,
           wrecksPerMin: +((window.__traf().wrecks - w0) / el * 60).toFixed(1),
           minGap: +minGap.toFixed(2),
           avgKmh: +(sumSpd / Math.max(samples * cars, 1) * 3.6).toFixed(1),
           stoppedPct: +(sumStopped / Math.max(samples, 1) * 100).toFixed(0),
           onScreen: +(sumOnScreen / Math.max(samples, 1)).toFixed(1),
           beyondRingM: +maxOut.toFixed(1),
           fps: Math.round(frames / el) };
}, theme);
/* The same drive twice. An absolute on-screen count measures the route and the
   map as much as the traffic — what has to hold is that daylight puts MORE cars
   in front of you than dusk does, and that neither of them detonates. */
out.dusk = await runIn('dusk');
out.run = await runIn('day');

/* And the sound, through the wiring rather than through the formula. Asking
   earshot() what it returns proves nothing about whether anything USES it, and
   "I hear explosions from cars that are not on the screen" is a complaint about
   the calls, not the maths. So the two sound functions are wrapped, real
   explosions are set off at known distances, and what comes out is the gain the
   game actually asked for. */
out.sound = await p.evaluate(async () => {
  const heard = [];
  const realBoom = SFX.boom, realCrash = SFX.crash;
  SFX.boom = (g = 1) => { heard.push(+g.toFixed(3)); };
  SFX.crash = v => { heard.push(+(v / 20).toFixed(3)); };
  const me = window.__p();
  const at = async d => {
    heard.length = 0;
    window.__explodeAt(me.x + d, me.y);
    await new Promise(r => requestAnimationFrame(r));
    return heard.length ? Math.max(...heard) : 0;
  };
  const r = { onTheBonnet: await at(3), halfAScreen: await at(60),
              justOffScreen: await at(240), twoBlocks: await at(700) };
  SFX.boom = realBoom; SFX.crash = realCrash;
  return r;
});
// what you can see you can hear; what you cannot, you cannot
out.quietOffScreen = out.sound.onTheBonnet > .9 && out.sound.halfAScreen > .2 &&
                     out.sound.justOffScreen < .05 && out.sound.twoBlocks === 0;

out.errs = errs.slice(0, 4);
out.pass =
  // the reported fault: cars are not blowing each other up any more
  out.run.wrecksPerMin < 2 &&
  // they keep a gap rather than driving through one another
  /* Never interpenetrating. carsCollide separates to (a.l+b.l)*0.34, which for
     the smallest pair of cars is about 2 m, so this is "the resolver is doing
     its job", not an arbitrary distance. */
  out.run.minGap > 1.9 &&
  // and they are still driving, not parked in a queue
  out.run.avgKmh > 6 && out.run.stoppedPct < 60 &&
  // nothing lives more than a whisker outside the ring
  out.run.beyondRingM < 25 &&
  // daylight is busier than dusk, and neither is empty
  out.run.onScreen > out.dusk.onScreen && out.dusk.onScreen > 0 &&
  out.dusk.wrecksPerMin < 2 &&
  out.quietOffScreen && out.run.fps >= 45 && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await br.close();
process.exit(out.pass ? 0 : 1);
