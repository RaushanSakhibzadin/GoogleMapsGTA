/* WHEN THE WIDE SWEEP IS REFUSED, THE CITY IN THE BUNDLE STANDS IN FOR IT.
 *
 * Reported from a phone in Belgrade, and the log spells it out: sixty
 * kilometres timed out, then thirty-six, then eighteen, then nine. Every rung.
 * The session ended up in a 5.5 km box with `skeleton: null` and no arterials
 * in it at all — while data/belgrade.js was sitting in the same download
 * holding 6,585 ways of that city's real motorways and boulevards, unused,
 * because the offline city only ever loaded when EVERYTHING failed.
 *
 * Partial failure is the common case. The streets for the tile you are standing
 * on are one small request and they nearly always arrive; it is the wide sweep —
 * the biggest and slowest query the game makes — that gets the 429s and the
 * 504s. So the interesting state is exactly the one in the report: streets yes,
 * arterials no.
 *
 * This stages that. The mock answers the street request and refuses every
 * arterial one, which is what those mirrors did, and the world afterwards has to
 * be wide anyway.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;          // Belgrade, which is what the bundle holds
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* A couple of streets so the load succeeds and the game starts — this is not
   the offline path, it is a live session whose wide sweep failed. */
const streets = () => ({ elements: [
  { type: 'way', id: 1, tags: { highway: 'secondary', name: 'Bulevar' },
    geometry: [toLL(-700, 0), toLL(700, 0)] },
  { type: 'way', id: 2, tags: { highway: 'residential', name: 'Sporedna' },
    geometry: [toLL(0, -600), toLL(0, 600)] },
  { type: 'node', id: 900, ...toLL(0, 0), tags: { place: 'suburb', name: 'Blok' } }
] });

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
const asked = { streets: 0, arterials: 0 };
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
  contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])
}));
await p.route('**/api/interpreter', async r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const arterial = /motorway/.test(q) && !/residential/.test(q);
  if (arterial) {
    asked.arterials++;
    /* 504, which is one of the four things the mirrors in the report actually
       said. A refusal, not an empty answer: an empty one means "there are no
       motorways out there", and the ladder is right to stop rather than descend
       through four more rungs of the same question. */
    return r.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' });
  }
  if (/"building"/.test(q) || /historic/.test(q)) {
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [] }) });
  }
  asked.streets++;
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify(streets()) });
});
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 90000 });

const out = {};
/* The skeleton is fetched while you drive, not while you watch a bar, so this
   waits for the ladder to run out of rungs and the fallback to land. */
await p.waitForFunction(() => W.skelRect != null, null, { timeout: 90000 }).catch(() => {});
await p.waitForTimeout(500);

out.asked = asked;
out.everyArterialRefused = asked.arterials > 0;
out.world = await p.evaluate(() => ({
  roads: W.roads.length, drive: W.driveRoads.length,
  half: W.skelRect ? Math.round((W.skelRect.x1 - W.skelRect.x0) / 2) : null,
  bounds: Math.round(Math.min(W.maxX, W.maxY)),
  wide: typeof WIDE_MAP !== 'undefined' ? WIDE_MAP : null
}));
/* THE NUMBERS THAT MATTER. In the report the world was 2740 m to its edge with
   990 drivable roads in it. The bundle's own skeleton is clipped to 15 km, and
   what survives here is the part of it that genuinely surrounds the player. */
out.wideAnyway = out.world.half >= 5000 && out.world.bounds >= 5000;
out.hasArterials = out.world.drive > 400;

/* AND IT IS THE RIGHT CITY. The bundle is Belgrade; grafting it under someone
   who typed Osaka would be worse than no skeleton at all. Moved a long way and
   asked again, the fallback has to decline. */
out.elsewhere = await p.evaluate(async () => {
  const keep = { lat0: GEO.lat0, lon0: GEO.lon0, rect: W.skelRect };
  GEO.lat0 = 34.6937; GEO.lon0 = 135.5023;      // Osaka
  W.skelRect = null;
  const r = await bundledSkeleton();
  const rect = W.skelRect;
  GEO.lat0 = keep.lat0; GEO.lon0 = keep.lon0; W.skelRect = keep.rect;
  return { grafted: !!r, rect: !!rect };
});
out.refusesAnotherCity = out.elsewhere.grafted === false && out.elsewhere.rect === false;

out.errs = errs.filter(e => !/Failed to fetch|NetworkError|504/.test(e)).slice(0, 3);
out.pass = out.everyArterialRefused && out.wideAnyway && out.hasArterials &&
           out.refusesAnotherCity && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
