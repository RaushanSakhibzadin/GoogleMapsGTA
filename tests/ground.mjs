/* THE GROUND BETWEEN THE ROADS, IN DAYLIGHT.
 *
 * Asked for in these words: the soil where there are no roads should be a dark
 * blue-green — "sea, grass and river at the same time" — and the night is fine
 * as it is. It had been a pale bone grey since the daylight theme was written.
 *
 * WHY THIS IS NOT ONE ASSERTION ON ONE HEX STRING. Writing the chosen colour out
 * again in a test file makes a second copy of it, and a second copy is what
 * daynight.mjs exists to stop happening to the yellow. So the colour is held to
 * the PROPERTIES that were asked for — dark, and between green and blue — with
 * the hue read off the value the game actually uses. Any dark sea-green passes
 * and the old bone grey (hue 44°, three quarters of the way to white) does not,
 * which is the separation that matters.
 *
 * AND THEN THAT IT REACHES THE SCREEN, in both renderers, which the palette
 * check on its own cannot tell you. The ground is the one surface in this game
 * that is never relit: SH_GND_F solves a flat surface to k = 1.0 on purpose, so
 * that the top-down view and the 3D view agree metre for metre. The top-down
 * frame is therefore held to the palette value BYTE FOR BYTE, and the chase
 * frame to the same channel ratios at any brightness — the terrain under the
 * grass rolls, and a field with a metre of fall across it lands a few percent
 * either side of the flat value rather than on it.
 *
 * AND THE MAP IS MADE OF THE SAME SOIL, which is the half that was missed the
 * first time and reported: the world went sea-green and the map — the big one
 * and the radar, which share mapBg — stayed bone grey, so opening the map in
 * daylight went from a dark green city to a sheet of paper. They share one
 * constant now, and this holds them close together rather than identical, so
 * the map's copy can still be nudged a shade for legibility without the two
 * being free to drift apart again.
 *
 * AND THAT THE NIGHT WAS LEFT ALONE, because "night is ok" was half the request
 * and the cheapest way to break it is to touch the shared palette by accident.
 *
 * Usage: node tests/ground.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME, stubRadio } from './harness.mjs';

const LAT0 = 44.8115, LON0 = 20.4641;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

/* A plain grid and NOTHING ELSE — no buildings, no parks, no landmarks. The
   measurement here is the most common colour in the frame, so anything that
   casts a shadow or paints a large flat area of its own would be measuring
   something other than the ground. Blocks are 220 m so the gaps between roads
   are comfortably the biggest thing on screen at either camera. */
const streets = () => {
  const els = []; let id = 1;
  for (const y of [-660, -440, -220, 0, 220, 440, 660])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` },
               geometry: [toLL(-900, y), toLL(900, y)] });
  for (const x of [-660, -440, -220, 0, 220, 440, 660])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Avenue ${x}` },
               geometry: [toLL(x, -900), toLL(x, 900)] });
  els.push({ type: 'node', id: 900, lat: LAT0, lon: LON0, tags: { place: 'suburb', name: 'Ravnica' } });
  return { elements: els };
};

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json',
  body: JSON.stringify([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }]) }));
await p.route('**/api/interpreter', r => {
  const q = decodeURIComponent(r.request().postData() || '');
  const isStreets = !/"building"/.test(q) && !(/amenity/.test(q) && !/highway/.test(q));
  return r.fulfill({ contentType: 'application/json',
                     body: JSON.stringify(isStreets ? streets() : { elements: [] }) });
});
await stubRadio(p);
await p.goto(GAME);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1200);

const out = {};

/* ---- what the colour IS ---- */
const hsl = hex => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? 60 * (((g - b) / d) % 6)
          : mx === g ? 60 * ((b - r) / d + 2)
          :            60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  const l = (mx + mn) / 2;
  return { h: +h.toFixed(1), s: +(d ? d / (1 - Math.abs(2 * l - 1)) : 0).toFixed(3), l: +l.toFixed(3) };
};

const themeNow = t => p.evaluate(name => {
  applyTheme(name);
  return { ...window.__theme(), road: PAL.road, kerb: PAL.kerb, case: PAL.case, park: PAL.park,
           mapBg: PAL.mapBg, mapRoad: PAL.mapRoad, mapPark: PAL.mapPark };
}, t);
out.day = await themeNow('day');
out.dayHSL = hsl(out.day.ground);
/* THIS PINNED A DARK SEA-GREEN AND NOW PINS A DARK SLATE BLUE, because that is
   what was asked for: "less green, more dark grey blue". The old band was
   150–200° — between plain green and plain cyan — with a saturation FLOOR of
   0.25 to keep it from washing out to grey.
   The new one is 200–235°, which is blue and not cyan, and the saturation is now
   a CEILING rather than a floor: "grey blue" is a hue with the colour taken out
   of it, and 0.35 is where a slate stops being a slate and starts being a sky.
   The lightness bounds are unchanged and they are the part that matters most —
   see DAY_SOIL. This surface is never lit, shaded or textured in any of the
   three renderers, so it is the one colour that is seen exactly as it is typed,
   and anything above .32 makes the city sit on a glowing slab. */
out.groundIsDarkSlate = out.dayHSL.h >= 200 && out.dayHSL.h <= 235 &&
                        out.dayHSL.s <= 0.35 && out.dayHSL.l >= 0.10 && out.dayHSL.l <= 0.32;

/* AND THE ROADS STILL COME OFF IT. A dark ground is only an improvement while
   the streets are still the first thing you see on it; this is the check that
   fails if someone later darkens the tarmac to match.

   THE DISTANCE, NOT THE DIRECTION. `road - ground` would have been the obvious
   way to write it and would have been a second copy of today's decision: the
   pale ground this replaced was BRIGHTER than its roads and read perfectly well
   that way round. What has to hold is that the two are far apart. */
const lum = hex => { const n = parseInt(String(hex).replace('#', ''), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
out.roadLum = +lum(out.day.road).toFixed(1);
out.groundLum = +lum(out.day.ground).toFixed(1);
out.roadsStillRead = Math.abs(out.roadLum - out.groundLum) > 55;

/* ---- and that both renderers paint it ---- */
/* Two shares of the frame, plus the commonest triple for context.
 *
 * `exact` is how much of it is the palette value to the byte. The top-down view
 * does no lighting at all, so there the ground can be held to the byte and a
 * renderer that tints or substitutes its own colour shows up as a share near
 * zero even though the frame still looks green.
 *
 * `hue` is how much of it is that colour at ANY brightness — the same channel
 * ratios, scaled. That is the right question for the chase camera: the ground
 * there is terrain rather than a flat plane, so a field with a meter of fall
 * across it catches a few percent more or less light and lands next to the
 * palette value rather than on it. Ratios survive that; a byte comparison does
 * not, and 96% of the way to the right colour is not a bug.
 *
 * Neither is fooled by the tarmac, which is the other big flat area in shot:
 * daylight road is r/g 1.02 against the ground's 0.34.
 *
 * The commonest triple is reported and not asserted on — in the chase view it
 * is whatever the car happens to be standing on. */
const COUNT = `((d, want) => {
  const n = parseInt(want.slice(1), 16);
  const wr = (n >> 16) & 255, wg = (n >> 8) & 255, wb = n & 255;
  const R = wr / wg, B = wb / wg;
  const c = new Map();
  let hue = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    c.set((r << 16) | (g << 8) | b, (c.get((r << 16) | (g << 8) | b) || 0) + 1);
    if (g > 20 && Math.abs(r / g - R) < 0.04 && Math.abs(b / g - B) < 0.04) hue++;
  }
  let best = -1, bn = 0;
  for (const [k, v] of c) if (v > bn) { bn = v; best = k; }
  const px = d.length / 4;
  return { top: '#' + best.toString(16).padStart(6, '0'), topShare: +(bn / px).toFixed(3),
           exact: +((c.get(n) || 0) / px).toFixed(3), hue: +(hue / px).toFixed(3) };
})`;

out.flat2D = await p.evaluate(([src, want]) => {
  const cv = document.getElementById('game');
  const g = cv.getContext('2d');
  return eval(src)(g.getImageData(0, 0, cv.width, cv.height).data, want);
}, [COUNT, out.day.ground]);
out.topDownPaintsIt = out.flat2D.exact > 0.2;

out.gl = await p.evaluate(() => window.__setMode3d(true));
if (!out.gl) {
  out.skipped3D = 'no WebGL2: ' + (await p.evaluate(() => GL.fail));
  out.chasePaintsIt = true;
} else {
  await p.waitForTimeout(1800);
  /* Parked in the middle of a block rather than on a street, so the frame is
     mostly the thing being measured. On the road the tarmac is the commonest
     colour in the chase view and the ground is edge-on strips either side. */
  await p.evaluate(() => { applyTheme('day'); window.__tp(110, 110, 0); P.car.vx = P.car.vy = 0; });
  await p.waitForTimeout(900);
  out.flat3D = await p.evaluate(([src, want]) => {
    window.__keepState = state; state = 'pause';
    for (let i = 0; i < 40; i++) window.__px3(0, 0, 1, 1);      // one streamed cell a frame
    const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
    const px = window.__px3(0, 0, w, h);
    state = window.__keepState;
    return eval(src)(px, want);
  }, [COUNT, out.day.ground]);
  out.chasePaintsIt = out.flat3D.hue > 0.15;
}

/* ---- the thumb controls still read against it ---- */
/* The regression this ground colour caused, and the reason a colour change had
   to touch the stylesheet at all. The daylight pads were a dark wash with a
   dark glyph — correct against the bone grey they were designed on, invisible
   against dark grass, and DRIFT and the day/night toggle came out as empty
   outlines the moment the car left a built-up street.
 *
 * Two claims, because either alone can be satisfied by something unusable: the
 * GLYPH has to come off the button, and the BUTTON has to come off the ground
 * behind it. A dark-on-dark pad passes the first and fails the second. */
out.pads = await p.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('tH'));
  return { bg: cs.backgroundColor, fg: cs.color };
});
const rgba = s => { const n = (String(s).match(/[\d.]+/g) || []).map(Number);
  return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n.length > 3 ? n[3] : 1 }; };
const hexRGB = h => { const n = parseInt(String(h).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; };
const lumOf = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
// the pad is translucent, so what you actually see is it composited on the grass
const over = (c, base) => ({ r: c.a * c.r + (1 - c.a) * base.r,
                             g: c.a * c.g + (1 - c.a) * base.g,
                             b: c.a * c.b + (1 - c.a) * base.b, a: 1 });
out.padLum = +lumOf(over(rgba(out.pads.bg), hexRGB(out.day.ground))).toFixed(1);
out.padGlyphLum = +lumOf(rgba(out.pads.fg)).toFixed(1);
out.padsRead = Math.abs(out.padLum - out.padGlyphLum) > 60 &&
               Math.abs(out.padLum - out.groundLum) > 25;

/* ---- and the map is drawn on the same soil ---- */
/* The half that was missed the first time, and reported: the world went
   sea-green and the map — the big one and the radar, which share mapBg — stayed
   the old bone grey, so opening the map in daylight went from a dark green city
   to a sheet of paper.
 *
 * ASKED AS "THE SAME SOIL", not as one hex equalling another. Both have to be
 * that dark slate blue, and they have to be close enough together to read as the
 * same material — which is the thing that broke — while still leaving room for
 * the map's copy to be nudged a shade for legibility one day. Equality would
 * forbid that; 24 units of RGB distance forbids only the drift. */
out.mapHSL = hsl(out.day.mapBg);
const rgbGap = (a, b) => { const x = hexRGB(a), y = hexRGB(b);
  return Math.round(Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b)); };
out.mapSoilGap = rgbGap(out.day.mapBg, out.day.ground);
out.mapIsTheSameSoil = out.mapHSL.h >= 200 && out.mapHSL.h <= 235 &&
                       out.mapHSL.s <= 0.35 && out.mapHSL.l >= 0.10 && out.mapHSL.l <= 0.32 &&
                       out.mapSoilGap < 24;
// and the streets still come off it — white on grey was never the hard case
out.mapRoadLum = +lum(out.day.mapRoad).toFixed(1);
out.mapRoadsRead = Math.abs(out.mapRoadLum - lum(out.day.mapBg)) > 55;

/* AND THE MAP CANVAS ACTUALLY PAINTS IT. drawBigMap fills with PAL.mapBg and
   does no lighting of any kind, so this one is exact, the same claim the
   top-down world gets. */
out.mapInk = await p.evaluate(async ([src, want]) => {
  window.__openMap();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.getElementById('bigmapC');
  const g = cv.getContext('2d');
  const r = eval(src)(g.getImageData(0, 0, cv.width, cv.height).data, want);
  window.__closeMap();
  return r;
}, [COUNT, out.day.mapBg]);
out.mapPaintsIt = out.mapInk.exact > 0.2;

/* ---- and the night is where it was left ---- */
out.dusk = await themeNow('dusk');
out.duskHSL = hsl(out.dusk.ground);
// the violet-black the whole neon look is built on: nowhere near the new green
out.nightUntouched = out.duskHSL.h >= 250 && out.duskHSL.h <= 290 && out.duskHSL.l <= 0.10;

out.errs = errs.slice(0, 3);
out.pass = out.groundIsDarkSlate && out.roadsStillRead && out.padsRead &&
           out.mapIsTheSameSoil && out.mapRoadsRead && out.mapPaintsIt &&
           out.topDownPaintsIt && out.chasePaintsIt && out.nightUntouched && !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
