import { chromium } from 'playwright';
import { CHROME, GAME, ROOT } from './harness.mjs';
const b = await chromium.launch({ executablePath: CHROME });
const p = await b.newPage();
await p.goto(GAME);
await p.waitForTimeout(250);
const c = await p.evaluate(() => window.__cfg());
const ok = c.streets.mirrorMs > c.streetsQueryTimeout * 1000
        && c.streets.totalMs > c.streetsQueryTimeout * 1000
        && c.buildings.mirrorMs > c.buildingsQueryTimeout * 1000
        && c.buildings.totalMs > c.buildingsQueryTimeout * 1000
        && c.pois.mirrorMs > c.poisQueryTimeout * 1000
        && c.pois.totalMs > c.poisQueryTimeout * 1000
        // the arterials budget must outlast the per-rung cap, or the ladder gives
        // up on a mirror that was still going to answer
        && c.arterials.mirrorMs >= c.skeletonMs[0]
        && c.arterials.totalMs >= c.skeletonMs[0];
// The streets query is load-bearing: if it fails you get the generated city instead
// of the place you asked for, and every extra clause is more work between pressing
// DRIVE and driving. Roads and place names only -- everything else is its own request.
const streetsMinimal = c.streetsOuts === 1 && c.streetsHasRelation === false &&
  c.streetsClauses.length === 2 &&
  c.streetsClauses.every(x => x === 'way[' || x === 'node[') &&
  !/water|leisure|landuse|amenity|shop|building/.test(JSON.stringify(c.streetsClauses));
/* The skeleton is one request covering 400x the area of a tile. It stays cheap
   only by NOT asking for residential lanes -- they are the overwhelming majority
   of a city's ways, and putting them back is the difference between a few
   megabytes and a query the server refuses. Same two-clause shape as streets:
   roads to drive, and the place names for the district banner. */
const arterialsLean = c.arterialsClauses.length === 2 &&
  c.arterialsClauses.every(x => x === 'way[' || x === 'node[') &&
  c.arterialsHasResidential === false &&
  c.skeletonRadii[0] === 36000 &&
  // the ladder must descend, and its rungs must fit inside the shared deadline
  c.skeletonRadii.every((r, i) => i === 0 || r < c.skeletonRadii[i - 1]) &&
  c.skeletonMs.reduce((a, x) => a + x, 0) >= c.skeletonWait;
// The radar window must be small enough to stay legible: 0.2 px/m is the floor
// at which a 460 m view still resolves individual streets.
const radarLegible = c.mapPx / c.mapWin >= 0.2 && c.mapRedraw < c.mapWin / 2;
console.log(JSON.stringify({ ...c, clientOutlastsServer: ok, streetsMinimal,
                             arterialsLean, radarLegible }, null, 1));
await b.close();
