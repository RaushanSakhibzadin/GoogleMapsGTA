/* THE MAP REMEMBERS HOW FAR IN YOU WERE.
 *
 * Reported: pinch in to read a street name, close the map, open it again, and it
 * is back at the default 5 km — every single time. openMap() called mapFit()
 * unconditionally and mapFit() sets the scale as well as the centre, so the zoom
 * was never remembered; there was nowhere for it to be remembered.
 *
 * WHAT A TEST OF THIS HAS TO SEPARATE. "The scale is the same number" would pass
 * on a build that never let you zoom at all, so the zoom is applied through the
 * real gesture path and checked to have taken effect BEFORE the map is closed.
 * And the fix must not be "mapFit does nothing now", so the two things mapFit is
 * still responsible for are checked as well: the view re-centres on the car,
 * which has driven while the map was shut, and a genuinely new city opens on the
 * default framing rather than on however far in you were peering at the last one.
 */
import { chromium } from 'playwright';
import { CHROME, GAME } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(600);

const out = {};

/* ---- 1. open, zoom in, close, open ---- */
out.trip = await p.evaluate(() => {
  window.__openMap();
  const opened = window.__mapView().s;
  window.__mapZoom(4);                       // the same path a pinch takes
  const zoomed = window.__mapView().s;
  window.__closeMap();
  window.__openMap();
  const reopened = window.__mapView().s;
  return { opened: +opened.toFixed(5), zoomed: +zoomed.toFixed(5), reopened: +reopened.toFixed(5) };
});
/* The middle number is the one that makes the other two mean anything: without
   it, "opened equals reopened" is also true of a map that cannot zoom. */
out.zoomTookEffect = out.trip.zoomed > out.trip.opened * 2;
out.zoomSurvivesClosing = Math.abs(out.trip.reopened - out.trip.zoomed) < 1e-4;

/* ---- 2. and it still re-centres on the car ---- */
/* Closed, driven a long way, reopened: the map is about finding yourself, so the
   centre has to follow even though the scale does not. */
out.recentre = await p.evaluate(async () => {
  window.__closeMap();
  const from = window.__mapView();
  const car0 = { x: P.car.x, y: P.car.y };
  window.__tp(car0.x + 900, car0.y + 700, 0);
  window.__openMap();
  const to = window.__mapView();
  return { movedTo: { x: Math.round(P.car.x), y: Math.round(P.car.y) },
           centre: { x: Math.round(to.cx), y: Math.round(to.cy) },
           was: { x: Math.round(from.cx), y: Math.round(from.cy) },
           scaleHeld: Math.abs(to.s - from.s) < 1e-4 };
});
/* Not asked to the metre: mapClamp will not let the edge of the world inside the
   viewport, so a car near a corner pins the centre short of it. Close to the car
   and nowhere near where it used to be is the claim. */
out.followsTheCar =
  Math.hypot(out.recentre.centre.x - out.recentre.movedTo.x,
             out.recentre.centre.y - out.recentre.movedTo.y) < 400 &&
  Math.hypot(out.recentre.centre.x - out.recentre.was.x,
             out.recentre.centre.y - out.recentre.was.y) > 300 &&
  out.recentre.scaleHeld;

/* ---- 3. a cleared scale opens on the default framing ---- */
/* ASKED BEFORE THE NEXT SECTION, and the order is the point. That one rebuilds
   the world out of the features already loaded, which shrinks it to 1,880 m —
   and in a world that small mapClamp's floor (900 px / 1880 m = 0.479) sits
   ABOVE the 5 km default, so this check run afterwards measures the clamp rather
   than the framing. It read as a failure of the reset and was mapClamp doing its
   job. */
out.fresh = await p.evaluate(() => {
  window.__closeMap();
  MAPV.s = 0;
  window.__openMap();
  const got = window.__mapView().s;
  window.__closeMap();
  return { got: +got.toFixed(5), want: +(Math.min(VW, VH) / 5000).toFixed(5),
           worldM: Math.round(Math.min(W.maxX - W.minX, W.maxY - W.minY)) };
});
out.clearedOpensOnTheDefault = Math.abs(out.fresh.got - out.fresh.want) < 1e-4;

/* ---- 4. and a new city does not inherit the last one's zoom ---- */
out.newCity = await p.evaluate(() => {
  window.__openMap();
  window.__mapZoom(4);
  window.__closeMap();
  const zoomed = MAPV.s;
  buildWorld({ roads: W.roads, buildings: W.buildings, parks: W.parks,
               places: W.places, pois: [], shops: [] }, W.name, false);
  return { zoomed: +zoomed.toFixed(5), cleared: MAPV.s };
});
out.newCityClearsTheZoom = out.newCity.zoomed > 0.2 && out.newCity.cleared === 0;

out.errs = errs.slice(0, 3);
out.pass = out.zoomTookEffect && out.zoomSurvivesClosing && out.followsTheCar &&
           out.newCityClearsTheZoom && out.clearedOpensOnTheDefault && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
