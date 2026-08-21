/* EVERY SCRIPT AND STYLESHEET CARRIES THE CURRENT VERSION, AND THE PAGE STILL RUNS.
 *
 * A deploy went out and the person who asked for it went on playing the old
 * build for hours, because every file in it is addressed by a name that never
 * changes and Safari saw no reason to ask again. The stamps fix that, and this
 * is what stops them rotting: the version is a hash of the files' own contents,
 * so editing any .js and forgetting to re-stamp leaves index.html pointing at a
 * version that no longer describes the code — which is exactly the state that
 * ships a stale build, and exactly what section 1 refuses to let past.
 *
 * Section 2 is the other half, and the reason this is a browser test rather than
 * a string comparison in node: a stamp is a change to how every file in the
 * program is FETCHED. Getting the query string wrong — a stray quote, a stamp on
 * the manifest, a relative path mangled — produces an index.html that parses
 * fine and loads nothing. So the stamped page is opened for real and has to
 * reach a playable city with every script present and no 404s, over file://,
 * where a query string on a local path is a thing browsers have been known to
 * mishandle.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';
import { refsOf, versionOf } from '../tools/stamp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const out = {};

/* ---- 1. the stamps match the code they claim to describe ---- */
const want = versionOf(html);
const refs = refsOf(html);
const stale = refs.filter(r => r.stamp !== '?v=' + want);
out.version = want;
out.stamped = refs.length;
out.stale = stale.map(r => r.file + ' ' + (r.stamp || '(none)'));
/* Fifteen is not a magic number, it is the whole program — one stylesheet and
   fourteen scripts. Asserting the COUNT as well as the stamps is what catches a
   file added to index.html with no stamp on it at all, which the regex would
   otherwise skip silently rather than report as stale. */
out.allStamped = refs.length >= 15 && stale.length === 0;
if (!out.allStamped) out.hint = 'run: node tools/stamp.mjs';

/* Nothing else may be stamped. The icons, the manifest and the canonical URL are
   referenced by other things — a home-screen icon by iOS, og:image by every
   unfurler on the internet — and a query string on those is at best ignored and
   at worst a broken share card. */
out.strays = [...html.matchAll(/(?:src|href|content)="([^"]*\?v=[^"]*)"/g)]
  .map(m => m[1]).filter(u => !/^(?:js\/[\w.-]+\.js|style\.css)\?v=/.test(u));
out.nothingElseStamped = out.strays.length === 0;

/* window.BUILD carries the same version to the code, for the one file index.html
   does not reference: js/world.js fetches data/belgrade.js at runtime, and four
   megabytes of city cached from an older build is the same mixed pairing the
   URLs exist to prevent. It is checked here rather than trusted because the
   stamper rewrites it with a different regex from the tag stamps, and a rewrite
   that silently matched nothing would leave a stale constant behind. */
out.build = (html.match(/window\.BUILD\s*=\s*'([0-9a-f]*)'/) || [])[1] || '';
out.buildMatches = out.build === want;

/* ---- 2. and the stamped page is a working game ---- */
const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errs = [], missing = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('requestfailed', r => {
  const u = r.url();
  // the map servers are unreachable here on purpose; a LOCAL file that fails to
  // load is the thing being watched for
  if (u.startsWith('file:')) missing.push(u.split('/').pop());
});
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(400);
await p.click('#go');
let played = true;
try {
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
} catch (e) { played = false; }

/* Every stamped file actually arrived. Read from the document rather than from
   the network log so it is the browser's own account of what it loaded, and
   compared against index.html so a script silently dropped from the page is
   caught as well as one that 404s. */
out.loaded = await p.evaluate(() =>
  [...document.querySelectorAll('script[src], link[rel=stylesheet]')]
    .map(e => (e.getAttribute('src') || e.getAttribute('href'))));
/* Only the tags index.html declares. The offline city appends its own script at
   runtime and is checked separately below — counting it here would make this
   assertion depend on whether the fallback happened to fire. */
const statics = out.loaded.filter(u => /^(?:js\/[\w.-]+\.js|style\.css)\?/.test(u));
out.allArrived = statics.length === refs.length &&
                 statics.every(u => u.endsWith('?v=' + want));
/* The scripts share one global scope and are loaded in a fixed order, so the
   last one having run means all of them did — and these are the symbols that
   would be missing if a stamp had quietly cost the page a file. */
out.globals = await p.evaluate(() => ({
  util: typeof clamp, geo: typeof overpassArea, gl: typeof GL,
  car: typeof carModel, r3: typeof render3D, main: typeof window.__s
}));
out.everythingRan = Object.values(out.globals).every(t => t !== 'undefined');
/* And the runtime-loaded city really does get stamped. Forced rather than waited
   for: the offline fallback only fires when every mirror fails, which this test
   does arrange by aborting the network, but whether the generated city or the
   bundled one wins is not something to hang an assertion on. Calling the loader
   directly asks the one question that matters — what URL does it build. */
out.cityUrl = await p.evaluate(async () => {
  const find = () => [...document.querySelectorAll('script[src]')]
    .map(e => e.getAttribute('src')).find(u => u.includes('belgrade')) || '';
  // with the network aborted the fallback has usually already fired, and its tag
  // is right there in the document; loadOfflineCity() returns early in that case
  // and appends nothing, which is why looking for the tag comes first
  if (find()) return find();
  try { await loadOfflineCity(); } catch (e) {}
  return find();
});
out.cityStamped = out.cityUrl.endsWith('belgrade.js?v=' + want);
out.played = played;
out.missing = missing;
out.errs = errs.slice(0, 4);

await browser.close();
out.pass = out.allStamped && out.nothingElseStamped && out.buildMatches &&
           out.allArrived && out.cityStamped && out.everythingRan && out.played &&
           !missing.length && !errs.length;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
