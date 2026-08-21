/* ONE DROPPED SCRIPT MUST NOT BRICK THE GAME.
 *
 * Reported as a loading screen that never finished. From the phone's own log:
 *
 *   0.01s [resource] failed to load .../js/world.js?v=0a2f3453a4
 *   3.10s [warn] map load failed:     Can't find variable: parseOSM
 *   3.10s [warn] offline city failed: Can't find variable: loadOfflineCity
 *   3.10s [rejection]                 Can't find variable: proceduralCity
 *
 * One file, ten milliseconds in, on a connection healthy enough to pull 910 KB
 * of map data three seconds later. There is no retry on a <script src> and
 * nothing anybody sees — and world.js holds the real map path AND both of its
 * fallbacks, so losing it takes out every way the game knows how to recover.
 *
 * SERVED OVER HTTP, not file://, and that is not incidental. Playwright cannot
 * intercept file:// requests, so a test run the way the rest of the suite runs
 * could not make a script fail at all — it would have to fake the failure, and
 * a faked failure proves nothing about a real one. A tiny static server for the
 * duration of the test buys a genuine dropped request.
 *
 * Two scenarios, because the interesting behaviour is different:
 *   - the file fails ONCE, which is what a flaky connection does: the game must
 *     go back for it and start normally, with the player none the wiser
 *   - the file fails ALWAYS: the game must give up in a way a player can act on,
 *     rather than sitting on a progress bar for six and a half minutes
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, extname } from 'path';
import { CHROME, GAME } from './harness.mjs';

const ROOT = dirname(fileURLToPath(GAME.startsWith('file://') ? GAME : 'file://' + GAME));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

/* Counts every request the browser makes, so "did it go back for it" is a fact
   about the network rather than an inference from the page recovering.

   Every verdict below is wrapped in !!(). Without it a chain like
   `world === false && boot && ...` returns NULL when there is no boot object,
   which is falsy — so the test still fails, correctly — but reads as "not
   evaluated" in the report rather than as "this is the bit that broke". The
   build without the guard printed one failing flag when three had failed. */
const hits = {};
let failWorld = 0;                     // how many more times world.js must fail

const srv = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const name = path.replace(/^\//, '') || 'index.html';
  hits[name] = (hits[name] || 0) + 1;
  if (name === 'js/world.js' && failWorld > 0) {
    failWorld--;
    // a dropped connection, not a 404: a 404 is a deploy bug and this is a phone
    // on a train. The socket is destroyed mid-flight.
    res.destroy();
    return;
  }
  try {
    const body = await readFile(resolve(ROOT, name));
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream',
                         'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end('no');
  }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port + '/';

const browser = await chromium.launch({ executablePath: CHROME });
const out = {};

async function run(label, failTimes) {
  for (const k in hits) delete hits[k];
  failWorld = failTimes;
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  // the map servers, not the game's own files
  await p.route('**://*/**', r => {
    const u = r.request().url();
    return u.startsWith(BASE) ? r.continue() : r.abort();
  });
  await p.goto(BASE + 'index.html');
  // long enough for three retry rounds and their backoff
  await p.waitForTimeout(4000);

  const boot = await p.evaluate(() => window.__boot || null);
  const world = await p.evaluate(() => typeof W !== 'undefined' && typeof parseOSM === 'function');
  const go = await p.evaluate(() => {
    const b = document.getElementById('go');
    return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
  });
  const tag = await p.evaluate(() => {
    const t = document.querySelector('#menu .tag');
    return t ? t.textContent.trim() : '';
  });

  let played = null, reloaded = null;
  if (go.text === 'RELOAD') {
    /* Press it. A button that says RELOAD and does nothing when tapped is worse
       than no button, so the test taps it and watches for the navigation. */
    const before = hits['index.html'] || 0;
    await p.click('#go').catch(() => {});
    await p.waitForTimeout(900);
    reloaded = (hits['index.html'] || 0) > before;
  } else if (!go.disabled) {
    await p.click('#go');
    played = await p.waitForFunction(() => window.__s && window.__s() === 'play', null,
      { timeout: 45000 }).then(() => true, () => false);
  }
  const r = { label, boot, world, go, tag, played, reloaded,
              worldRequests: hits['js/world.js'] || 0,
              errs: errs.filter(e => !/Overpass|fetch|Failed to fetch/i.test(e)).slice(0, 3) };
  await ctx.close();
  return r;
}

/* ---- 1. nothing wrong: the guard stays out of the way ---- */
out.clean = await run('healthy', 0);
out.cleanIsSilent = !!(out.clean.boot && out.clean.boot.ok && out.clean.boot.tries === 0 &&
                    out.clean.worldRequests === 1 && !out.clean.go.disabled && out.clean.played === true);

/* ---- 2. it drops once, as a flaky connection does ---- */
out.flaky = await run('world.js fails once', 1);
/* Asked for twice — the failure and the retry — which is the fact that says the
   page went back for it rather than limping on without it. */
out.recovers = !!(out.flaky.world === true &&
               out.flaky.worldRequests === 2 &&
               out.flaky.boot && out.flaky.boot.ok && out.flaky.boot.tries === 1 &&
               !out.flaky.go.disabled &&
               out.flaky.played === true);

/* ---- 3. it never arrives: say so, do not hang ---- */
out.dead = await run('world.js always fails', 99);
/* Three rounds and then a button that does something. The old behaviour was a
   live DRIVE button and a loading screen with no exit, which is the exact shape
   of the report. */
out.givesUpLoudly = !!(out.dead.world === false &&
                    out.dead.boot && !out.dead.boot.ok && out.dead.boot.tries === 3 &&
                    out.dead.worldRequests >= 4 &&
                    out.dead.go.text === 'RELOAD' &&
                    // and it must be PRESSABLE. The first version left it disabled,
                    // so the one thing on screen to tap did nothing at all.
                    out.dead.go.disabled === false && out.dead.reloaded === true &&
                    /did not load/i.test(out.dead.tag));

out.pass = out.cleanIsSilent && out.recovers && out.givesUpLoudly;
console.log(JSON.stringify(out, null, 1));
await browser.close();
srv.close();
process.exit(out.pass ? 0 : 1);
