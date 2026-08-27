/* THE CITY IN A SCRIPT YOU CAN READ.
 *
 * The UI was translated into ten languages and the city was not: a German,
 * Japanese or English player driving Belgrade got Ђуре Даничића on the street
 * banner, Скадарлија for the district and Београд for the city, because those
 * come off OpenStreetMap's `name` tag, which is the LOCAL name.
 *
 * WHAT IS AND IS NOT POSSIBLE HERE, measured rather than assumed. Counted on the
 * real capture this file drives, tests/fixtures/stari-grad:
 *
 *     streets, 847 named       name:sr-Latn 847   int_name 845   name:en 5
 *     arterials, 8302 named    name:sr-Latn 8302  int_name 8043  name:en 780
 *
 * Nobody translates eight thousand proper nouns, and per-language street names
 * essentially do not exist. What does exist, on every single way, is the name
 * written in another SCRIPT. So the claim under test is not "the streets are
 * translated" — it is "the streets are legible", and the two are different
 * enough that measuring the wrong one would look like success.
 *
 * SO THE MEASUREMENT IS COVERAGE OVER THE WHOLE CITY, not a lookup on one
 * hand-picked street. One street proves a code path; the number that matters to
 * a player is how much of the city they can read, and that is the number a
 * fixture of real Belgrade can actually answer.
 *
 * Usage: node tests/names.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { CHROME, GAME, ROOT, stubRadio } from './harness.mjs';

const FIX = join(ROOT, 'tests', 'fixtures', 'stari-grad');
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

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

/* The geocoder is watched rather than merely answered: the city's own name is
   part of this and it is asked for in the URL. */
const geoUrls = [];
await p.route('**/nominatim.openstreetmap.org/**', r => {
  geoUrls.push(r.request().url());
  return r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0),
                            display_name: 'Стари град, Београд', address: { country_code: 'rs' } }]) });
});
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
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });
await p.waitForTimeout(800);

const out = {};

/* ---- 1. how much of the real city each language can read ---- */
/* parseOSM is run again per language over the SAME payload, which is what makes
   these numbers comparable — one city, ten readings of it. The world the player
   is driving is not disturbed. */
out.coverage = await p.evaluate(async body => {
  const els = JSON.parse(body).elements;
  const langs = ['en', 'sr', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'zh'];
  const was = LANG;
  const r = {};
  for (const L of langs) {
    LANG = L;
    const t0 = performance.now();
    const roads = parseOSM(els).roads.filter(x => x.name);
    const ms = Math.round(performance.now() - t0);
    const want = { en: 'latin', sr: 'latin', de: 'latin', fr: 'latin', es: 'latin',
                   it: 'latin', pt: 'latin', ru: 'cyrillic', ja: 'cjk', zh: 'cjk' }[L];
    let ok = 0, latin = 0;
    for (const x of roads) {
      const sc = scriptOf(x.name);
      if (sc === want) ok++;
      if (sc === 'latin') latin++;
    }
    // ja and zh have no Han street names in Belgrade, so Latin is the win there
    const readable = (L === 'ja' || L === 'zh') ? Math.max(ok, latin) : ok;
    r[L] = { named: roads.length, readable, pct: +(100 * readable / roads.length).toFixed(1), ms };
  }
  LANG = was;
  return r;
}, rep.streets.body);
/* Every Latin-reading language must get essentially the whole city, and the
   Cyrillic one must keep the Cyrillic it could already read — a change that
   romanised everything for everybody would be a regression for a Russian
   player, and would sail through a check that only counted Latin. */
const LATIN_UI = ['en', 'sr', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'zh'];
out.everyLanguageCanReadIt = LATIN_UI.every(L => out.coverage[L].pct > 95) &&
                             out.coverage.ru.pct > 95 &&
                             out.coverage.en.named > 500;

/* ---- 2. and the rule is the rule, not a Belgrade special case ---- */
/* Six hand-built tag sets, because coverage says how OFTEN it works and says
   nothing about WHICH name comes back. Each of these is a decision the picker
   makes that the fixture cannot isolate. */
out.rules = await p.evaluate(() => {
  const was = LANG;
  const at = (L, t) => { LANG = L; const v = osmName(t); return v; };
  const CYR = { name: 'Ђуре Даничића', 'name:sr': 'Ђуре Даничића',
                'name:sr-Latn': 'Đure Daničića', int_name: 'Djure Danicica',
                'name:en': 'Djure Danicica Street', 'name:ru': 'Улица Дьюре Даничича' };
  const r = {
    // the reader's own language wins when it exists
    ownLanguage: at('en', CYR),
    // Serbian UI is written in Latin, so name:sr being Cyrillic must not win
    serbianTakesLatin: at('sr', CYR),
    // Cyrillic is readable to a Russian, so the local name beats a romanisation
    russianKeepsCyrillic: at('ru', { name: 'Ђуре Даничића', int_name: 'Djure Danicica' }),
    // nothing in their script at all: fall through to something Latin
    japaneseFallsToLatin: at('ja', { name: 'Ђуре Даничића', 'name:sr-Latn': 'Đure Daničića' }),
    // a regional spelling of their own language counts as their language
    regionalCounts: at('zh', { name: 'Ђуре Даничића', 'name:zh-Hans': '久里街' }),
    // and when nothing is readable, the local name beats no name at all
    lastResort: at('de', { name: 'Ђуре Даничића' }),
    // etymology tags start with name: and are not names
    ignoresEtymology: at('de', { name: 'Ђуре Даничића', 'name:etymology:wikidata': 'Q1234' })
  };
  LANG = was;
  return r;
});
out.picksTheRightOne =
  out.rules.ownLanguage === 'Djure Danicica Street' &&
  out.rules.serbianTakesLatin === 'Đure Daničića' &&
  out.rules.russianKeepsCyrillic === 'Ђуре Даничића' &&
  out.rules.japaneseFallsToLatin === 'Đure Daničića' &&
  out.rules.regionalCounts === '久里街' &&
  out.rules.lastResort === 'Ђуре Даничића' &&
  out.rules.ignoresEtymology === 'Ђуре Даничића';

/* ---- 3. it reaches the HUD, not just the data ---- */
/* The street banner and the district banner are what a player actually reads,
   and they are fed from a different place in world.js than the roads are. */
out.onScreen = await p.evaluate(async () => {
  // park on the longest named road in the world and let the banner catch up
  let best = null;
  for (const r of W.roads) if (r.name && (!best || r.pts.length > best.pts.length)) best = r;
  if (!best) return null;
  const a = best.pts[0], b = best.pts[best.pts.length - 1];
  window.__tp(a.x, a.y, Math.atan2(b.y - a.y, b.x - a.x));
  window.__setInput({ gas: 1 });
  await new Promise(r => setTimeout(r, 1600));
  window.__setInput(null);
  const nav = window.__nav();
  return { street: nav.streetTxt, zone: nav.zoneTxt, world: W.name,
           places: W.places.slice(0, 4).map(q => q.name) };
});
const latin = s => !!s && /[A-Za-z]/.test(s) && !/[Ѐ-ӿ]/.test(s);
out.hudIsLatin = !!out.onScreen && latin(out.onScreen.street);
/* The districts come from place nodes, which is a separate branch of parseOSM —
   the one that was reading t.name directly and would have been missed. */
out.districtsAreLatin = !!out.onScreen && out.onScreen.places.length > 0 &&
                        out.onScreen.places.every(latin);

/* ---- 4. and the city's own name was asked for in that language ---- */
/* THE REQUEST, NOT THE REPLY, because the reply is this file's own mock and a
   mock that returned a German city name would only be testing itself. What the
   game controls is asking; Nominatim does the rest, and falls back to the local
   name by itself when it has nothing. `world` in this report stays Cyrillic for
   exactly that reason and is not a failure. addressdetails is asserted at the
   same time: the radio reads the country code out of the structured address, so
   losing it while adding a language would break the dial silently. */
out.geo = { urls: geoUrls.length, first: geoUrls[0] || '' };
out.geocoderAsksForTheLanguage = /[?&]accept-language=en\b/.test(out.geo.first) &&
                                 /[?&]addressdetails=1\b/.test(out.geo.first);

out.errs = errs.slice(0, 3);
out.pass = out.everyLanguageCanReadIt && out.picksTheRightOne &&
           out.hudIsLatin && out.districtsAreLatin &&
           out.geocoderAsksForTheLanguage && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
