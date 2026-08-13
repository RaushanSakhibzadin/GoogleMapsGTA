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
/* The skeleton is one request covering a box hundreds of kilometres across. It
   stays cheap only by NOT asking for residential lanes -- they are the
   overwhelming majority of a city's ways, and putting them back is the
   difference between a few megabytes and a query the server refuses. */
const arterialsLean = c.arterialsHasResidential === false &&
  c.skeletonRadii[0] === 200000 &&
  // the ladder must descend, and its rungs must fit inside the shared deadline
  c.skeletonRadii.every((r, i) => i === 0 || r < c.skeletonRadii[i - 1]) &&
  c.skeletonMs.reduce((a, x) => a + x, 0) >= c.skeletonWait;
/* AND IT NARROWS AS IT WIDENS. Area goes with the square of the radius, so the
   200 km ask is four times the ground of the 100 km one that already came back
   as 45.7 MB. Three concentric boxes in the one union are what make it payable:
   the motorway network over the whole radius, primaries over 100 km, the full
   arterial set over the 36 km the drivable mask covers. If the outer box ever
   picks up secondary roads again, that is the flat query back, and the number
   it costs is the one this comment is made of. */
const arterialsTiered = c.arterialsWide.rings === 3 &&
  /motorway/.test(c.arterialsWide.outerClasses) &&
  !/secondary|primary|_link/.test(c.arterialsWide.outerClasses);
// The radar window must be small enough to stay legible: 0.2 px/m is the floor
// at which a 460 m view still resolves individual streets.
const radarLegible = c.mapPx / c.mapWin >= 0.2 && c.mapRedraw < c.mapWin / 2;
/* This file used to print its findings and exit 0 regardless, which meant it sat
   in the suite reporting arterialsLean:false for a release and a half without
   anyone being told. A test that cannot fail is a log. */
const pass = ok && streetsMinimal && arterialsLean && arterialsTiered && radarLegible;
console.log(JSON.stringify({ ...c, clientOutlastsServer: ok, streetsMinimal,
                             arterialsLean, arterialsTiered, radarLegible, pass }, null, 1));
await b.close();
process.exit(pass ? 0 : 1);
