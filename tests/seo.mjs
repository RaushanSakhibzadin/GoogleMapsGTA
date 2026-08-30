/* WHAT A CRAWLER AND AN UNFURLER ACTUALLY GET.

   The head used to be four lines — charset, viewport, title, stylesheet — so
   there was no description for Google to quote, no card for Discord or Slack to
   draw, no canonical to collapse `/` and `/index.html` into one page, and no
   favicon. The eight city names on the menu were built by a loop in game.js,
   which meant the only place-names on the site were invisible to anything that
   did not run scripts.

   MOST OF THIS IS ASSERTED AGAINST THE FILE ON DISK, not against the rendered
   DOM, because the file is what a crawler is handed. A test that boots the page
   and reads document.head would pass just as happily if every tag were injected
   at runtime, which is exactly the thing that does not work.

   The browser is used for two things only: that the document still renders with
   a single non-empty h1, and that the preset chips still start a game — the
   refactor that made those city names crawlable also rewired how they are bound,
   and markup a crawler likes is worth nothing if the buttons stopped working.

   Usage: node tests/seo.mjs
*/
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

/* The build under test, honoured for the FILE reads too and not only for the
   browser. GAME is how every other test here is pointed at a build with the fix
   taken out, and the first version of this one read the repo's own index.html
   regardless — so an A/B against the shipped build silently graded the new file
   twice and reported a pass. Everything below resolves against whichever build
   GAME names. */
const BUILD = dirname(fileURLToPath(GAME));
const at = f => join(BUILD, f);
/* WHERE THE SITE LIVES, TAKEN FROM THE DEPLOYMENT rather than written out here
   a second time. CNAME is the file that decides which host GitHub Pages answers
   on, so it is the fact that cannot be wrong: where it and the canonical link
   disagree, the canonical link is the one that is wrong.

   This was a literal copy of the URL, which made two places to change and
   exactly one of them memorable. Moving to a domain is precisely the edit that
   desyncs them, and a canonical pointing at an address that 301-redirects to
   the real one is the sort of fault that costs search ranking quietly, for
   months, while the page looks perfect in a browser.

   No CNAME is a legitimate state — it means no custom domain — so that falls
   back to the project Pages address the repository would be served from. */
const CNAME = at('CNAME');
const SITE = existsSync(CNAME)
  ? 'https://' + readFileSync(CNAME, 'utf8').trim() + '/'
  : 'https://raushansakhibzadin.github.io/GoogleMapsGTA/';
const html = readFileSync(at('index.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
const bad = [];
const need = (cond, msg) => { if (!cond) bad.push(msg); };

/* Every path here comes out of a tag that may not exist on the build under test,
   and `at('')` resolves to the build DIRECTORY — which exists, so a naive
   existsSync said yes and sizeOf then died on EISDIR. The first run against the
   shipped build crashed instead of reporting the eleven things it had found,
   which is the least useful moment for a test to fall over. */
const isFile = f => !!f && existsSync(f) && statSync(f).isFile();

/* Dimensions read out of the file itself rather than trusted from the tag. An
   og:image:width that disagrees with the actual pixels is how a card ends up
   cropped or rejected, and it is the kind of thing that rots silently when the
   image is regenerated. */
function sizeOf(file) {
  const b = readFileSync(file);
  if (b[0] === 0x89 && b[1] === 0x50)                       // PNG: straight out of IHDR
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {                     // JPEG: walk to the first SOF
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const meta = n => (head.match(new RegExp(`<meta\\s+name=["']${n}["']\\s+content=["']([^"']*)["']`, 'i')) || [])[1];
const prop = n => (head.match(new RegExp(`<meta\\s+property=["']${n}["']\\s+content=["']([^"']*)["']`, 'i')) || [])[1];
const link = r => (head.match(new RegExp(`<link[^>]*rel=["']${r}["'][^>]*href=["']([^"']*)["']`, 'i')) || [])[1];

const out = { site: SITE };

// ---------- 1. the snippet Google will show ----------
const desc = meta('description');
out.description = desc;
out.descriptionChars = desc ? desc.length : 0;
need(!!desc, 'no meta description');
// ~160 is where Google starts truncating; short enough to survive is the point
need(desc && desc.length >= 70 && desc.length <= 160,
     `description is ${out.descriptionChars} chars, want 70-160`);
const title = (head.match(/<title>([^<]*)<\/title>/i) || [])[1];
out.title = title;
out.titleChars = title ? title.length : 0;
need(title && title.length <= 65, `title is ${out.titleChars} chars, want <= 65`);

// ---------- 2. one page, one URL ----------
out.canonical = link('canonical');
need(out.canonical === SITE, `canonical is ${out.canonical}, want ${SITE}`);
out.robots = meta('robots');
need(!!out.robots && /index/.test(out.robots), 'no robots meta');
out.themeColor = meta('theme-color');
need(!!out.themeColor, 'no theme-color');

// ---------- 3. the card ----------
out.og = {};
for (const k of ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description',
                 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
  out.og[k] = prop(k);
  need(!!out.og[k], `missing ${k}`);
}
out.twitter = {};
for (const k of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
  out.twitter[k] = meta(k);
  need(!!out.twitter[k], `missing ${k}`);
}
need(out.twitter['twitter:card'] === 'summary_large_image',
     `twitter:card is ${out.twitter['twitter:card']}`);
// absolute, or half the unfurlers will not resolve it
for (const k of ['og:url', 'og:image']) need(/^https:\/\//.test(out.og[k] || ''), `${k} is not absolute`);

const ogPath = (out.og['og:image'] || '').replace(SITE, '');
const ogFile = ogPath ? at(ogPath) : null;
out.ogImage = { path: ogPath, exists: isFile(ogFile) };
need(out.ogImage.exists, 'og:image points at a file that is not in the repo');
if (out.ogImage.exists) {
  const d = sizeOf(ogFile);
  out.ogImage.real = d;
  out.ogImage.bytes = readFileSync(ogFile).length;
  need(d && d.w === 1200 && d.h === 630, `og image is ${d && d.w}x${d && d.h}, want 1200x630`);
  need(String(d.w) === out.og['og:image:width'] && String(d.h) === out.og['og:image:height'],
       'og:image:width/height disagree with the actual pixels');
  // Twitter drops cards over 5 MB and slow images hurt everywhere
  need(out.ogImage.bytes < 900000, `og image is ${out.ogImage.bytes} bytes`);
}

// ---------- 4. icons and manifest ----------
out.icons = {};
for (const [rel, want] of [['icon', null], ['apple-touch-icon', 180]]) {
  const href = link(rel);
  out.icons[rel] = href;
  need(!!href, `no ${rel} link`);
  if (href) {
    const f = at(href);
    need(isFile(f), `${rel} points at missing ${href}`);
    if (want && isFile(f)) {
      const d = sizeOf(f);
      need(d && d.w === want, `${rel} is ${d && d.w}px, want ${want}`);
    }
  }
}
const manifestHref = link('manifest');
need(!!manifestHref, 'no manifest link');
if (manifestHref && isFile(at(manifestHref))) {
  const m = JSON.parse(readFileSync(at(manifestHref), 'utf8'));
  out.manifest = { name: m.name, icons: (m.icons || []).length };
  need(!!m.name && !!m.start_url && (m.icons || []).length >= 2, 'manifest is missing name/start_url/icons');
  for (const ic of m.icons || [])
    need(isFile(at(ic.src)), `manifest icon missing: ${ic.src}`);
}

// ---------- 5. structured data, honestly ----------
const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
need(!!ld, 'no JSON-LD');
if (ld) {
  let parsed = null;
  try { parsed = JSON.parse(ld); } catch (e) { bad.push('JSON-LD does not parse: ' + e.message); }
  if (parsed) {
    out.jsonld = { type: parsed['@type'], name: parsed.name };
    need(parsed['@context'] === 'https://schema.org', 'JSON-LD @context wrong');
    need(!!parsed['@type'] && !!parsed.name && !!parsed.description, 'JSON-LD missing type/name/description');
    /* Fabricated review stars are a Google guidelines violation with a manual
       action attached, and there is nothing here that could honestly produce
       one. Asserted so nobody adds it for the rich result later. */
    need(!parsed.aggregateRating && !parsed.review,
         'JSON-LD carries a rating — there are no real ratings to report');
  }
}

// ---------- 6. text a crawler can actually read ----------
const CITIES = ['Miami Beach', 'Manhattan', 'Monaco', 'Tokyo', 'London', 'Paris', 'Los Santos', 'Venice'];
out.citiesInStaticHtml = CITIES.filter(c => html.includes(c));
need(out.citiesInStaticHtml.length === CITIES.length,
     `only ${out.citiesInStaticHtml.length}/${CITIES.length} city names are in the served HTML`);
out.hasNoscript = /<noscript>/.test(html);
need(out.hasNoscript, 'no noscript fallback');
const h1s = html.match(/<h1[\s>]/gi) || [];
out.h1Count = h1s.length;
need(h1s.length === 1, `${h1s.length} h1 elements, want exactly 1`);

// ---------- 7. and it is all still a game ----------
const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage({ viewport: { width: 1100, height: 760 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
// no network: a chip must still be wired even when the city behind it never loads
await p.route('**/api/interpreter', r => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json', body: '[]' }));
await p.goto(GAME);
await p.waitForTimeout(300);
out.rendered = await p.evaluate(() => {
  const h = document.querySelectorAll('h1');
  return { h1: h.length, h1Text: h[0] ? h[0].textContent.trim() : null,
           chips: document.querySelectorAll('#presets .chip').length };
});
need(out.rendered.h1 === 1 && !!out.rendered.h1Text, 'rendered document has no single non-empty h1');
need(out.rendered.chips === 10, `${out.rendered.chips} chips rendered, want 10`);
// the binding survived being moved out of the loop that used to create them
await p.click('#presets .chip:nth-child(4)');          // Tokyo
out.chipStartsAGame = await p.waitForFunction(() => window.__s() !== 'menu', null, { timeout: 15000 })
  .then(() => true).catch(() => false);
need(out.chipStartsAGame, 'clicking a preset chip no longer starts a game');
out.errs = errs.slice(0, 4);
need(!errs.length, 'page errors: ' + errs.slice(0, 2).join(' | '));
await b.close();

out.bad = bad;
out.pass = bad.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
