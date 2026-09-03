/* BIG TREES IN THE PARKS.
 *
 * Reported from a green square in Stari grad with not one tree standing in it:
 * "here in this park should be a lot of big trees, make them 3x higher than
 * usual". Planting only ever ran along drivable roads, so every park in the city
 * was a flat green polygon with a row of street trees round its edge — all 375
 * of them in the capture that came with the report.
 *
 * FOUR WAYS THIS CAN LOOK RIGHT AND BE WRONG, and each is a section below.
 *
 *   The trees exist in an array and never reach the screen. Counted in the
 *   frame's own pixels, above the horizon where only sky and canopy live, with
 *   the parks taken out of the world for the control — the same A/B parkclip.mjs
 *   uses, for the same reason: green on a screenshot proves nothing about which
 *   green.
 *
 *   They are planted but not big. "Three times" is a ratio, so both ends are
 *   pinned: no park tree shorter than any street tree, and both bands sitting
 *   where the multiplier puts them.
 *
 *   They stand in walls and on carriageways. Parks and building footprints do
 *   overlap in OSM — half the greens in that capture are courtyards — so every
 *   site is put back through the two refusals the planter makes.
 *
 *   And the same tree is planted by every cell that touches the park. That is
 *   invisible from any one frame and doubles the geometry: the lattice is
 *   world-aligned so that a tree belongs to exactly one cell, and the way to
 *   show it is to walk the same ground at two different cell sizes and get the
 *   same trees back.
 *
 * Usage: node tests/parkwood.mjs [GAME=/path/to/index.html]
 */
import { chromium } from 'playwright';
import { CHROME, GAME_ASIS, stubRadio } from './harness.mjs';

const browser = await chromium.launch({ executablePath: CHROME });
const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await stubRadio(p);
await p.route('**://*/**', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
await p.goto(GAME_ASIS);
await p.waitForTimeout(300);
await p.click('#go');
await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const out = {};

/* The world stops changing before anything is counted. Parks arrive tile by
   tile on the buildings request, and a count taken while they are still landing
   is a count of how fast the network was. */
out.settled = await p.evaluate(async () => {
  let last = -1, still = 0, waited = 0;
  while (waited < 12000) {
    await new Promise(r => setTimeout(r, 150));
    waited += 150;
    const n = W.parks.length;
    if (n === last) { if (++still >= 4) break; } else { still = 0; last = n; }
  }
  return { parks: last, ms: waited };
});

/* ---------- 1. there are trees in the parks, and they are the big ones ---------- */
out.sites = await p.evaluate(() => {
  const s = window.__treeSites(P.car.x, P.car.y, 400);
  const band = a => a.length ? [Math.min(...a.map(t => t.h)), Math.max(...a.map(t => t.h))] : null;
  return { street: s.street.length, streetH: band(s.street),
           park: s.park.length, parkH: band(s.park) };
});
/* A DOZEN, NOT ONE. The complaint was a bare park, and one tree in eight hundred
   metres of city is a bare park with an exception in it. */
out.parksArePlanted = out.sites.park >= 12 && out.sites.street > 0;
/* THREE TIMES, AT BOTH ENDS. A street tree is 8.5 to 13.5 m and the multiplier
   is 3, so the park band is 25.5 to 40.5 — and the two bands must not touch,
   which is the part a wrong multiplier breaks first. Half a metre of slack each
   side, because these are the tallest and shortest of a sample and not the
   limits themselves. */
out.threeTimesTaller = !!out.sites.parkH && !!out.sites.streetH &&
  out.sites.streetH[0] >= 8.4 && out.sites.streetH[1] <= 13.6 &&
  out.sites.parkH[0] >= 25.4 && out.sites.parkH[1] <= 40.6 &&
  out.sites.parkH[0] > out.sites.streetH[1];

/* ---------- 2. and the small greens the report came from have them too ---------- */
/* The park in the capture was 1,740 m² — a courtyard, not a boulevard. A rule
   that only fills the big parks would pass section 1 on one municipal park and
   leave the reported one exactly as bare as it was. */
out.courtyards = await p.evaluate(() => {
  const near = [];
  for (const f of W.parks) {
    const w = f.bb.x1 - f.bb.x0, h = f.bb.y1 - f.bb.y0;
    if (w * h < 1200 || w * h > 12000) continue;                  // courtyard-sized
    if (Math.hypot((f.bb.x0 + f.bb.x1) / 2 - P.car.x, (f.bb.y0 + f.bb.y1) / 2 - P.car.y) > 900) continue;
    /* The planter walks ground rather than parks, so it answers for everything
       green in the box; this one is asked about by putting its own polygon back
       over the answer. */
    const s = [];
    plantParks([], null, f.bb.x0, f.bb.y0, f.bb.x1, f.bb.y1, () => {}, s);
    let n = 0;
    for (let i = 0; i < s.length; i += 2) if (pointInPoly(f.pts, s[i], s[i + 1])) n++;
    near.push(n);
  }
  return { looked: near.length, withTrees: near.filter(n => n > 0).length,
           most: near.length ? Math.max(...near) : 0 };
});
/* Not every one of them: a green with a building over most of it, or one small
   enough to fall between lattice points, correctly gets nothing. Half is the
   claim, and it is a claim about the rule rather than about one park. */
out.courtyardsGetTrees = out.courtyards.looked >= 5 &&
  out.courtyards.withTrees >= out.courtyards.looked * 0.5;

/* ---------- 3. never on the tarmac, never inside a building ---------- */
out.refusals = await p.evaluate(() => {
  const s = window.__treeSites(P.car.x, P.car.y, 600).park;
  let onRoad = 0, inWall = 0;
  for (const t of s) {
    if (onTarmac(t.x, t.z)) onRoad++;
    if (insideBuilding(t.x, t.z)) inWall++;
  }
  return { checked: s.length, onRoad, inWall };
});
out.nothingInAWall = out.refusals.checked > 20 &&
                     out.refusals.onRoad === 0 && out.refusals.inWall === 0;

/* ---------- 4. one cell owns each tree, whatever the cells are ---------- */
/* The lattice is walked in world coordinates and each point is accepted only by
   the cell it lands in. Two consequences, and both are asserted: no tree is
   planted twice, and the answer does not depend on how the ground was divided.
   A lattice anchored to the cell instead would pass the first and fail the
   second — and would quietly re-plant every park along every cell seam. */
out.ownership = await p.evaluate(() => {
  const R = 700;
  const big = window.__parkTreesByCell(P.car.x, P.car.y, R, 512);
  const small = window.__parkTreesByCell(P.car.x, P.car.y, R, 256);
  const uniq = a => new Set(a);
  const same = (a, b) => a.size === b.size && [...a].every(k => b.has(k));
  return { at512: big.length, unique512: uniq(big).size,
           at256: small.length, unique256: uniq(small).size,
           agree: same(uniq(big), uniq(small)) };
});
out.eachTreePlantedOnce = out.ownership.at512 > 40 &&
  out.ownership.at512 === out.ownership.unique512 &&
  out.ownership.at256 === out.ownership.unique256 &&
  out.ownership.agree;

/* READ BEFORE SECTION 5 EMPTIES THE WORLD OF PARKS. The pixel A/B below takes
   W.parks away and rebuilds every cell to get its control frame, so a count of
   branch geometry taken after it is a count of a city with no parks in it —
   which is what this returned the first time, zero, on a build whose trees were
   plainly on the screen. Asserted in section 6, where it belongs; read here,
   where it still means something. */
out.inTheWorld = await p.evaluate(() => {
  let cells = 0, withWood = 0, tris = 0;
  for (const c of G3.cells.values()) { cells++; if (c.wood) { withWood++; tris += c.wood.n / 3; } }
  return { cells, withWood, tris };
});

/* ---------- 5. and they are on the screen ---------- */
/* Parked in the middle of the largest park within reach, looking across it, and
   counting green in the TOP SIXTH of the picture. Below the horizon is grass in
   both frames and tells you nothing. The top sixth is chosen because it is where
   the height shows: from this camera a 13 m tree does not reach it and a 40 m one
   fills it, which is why a build with the multiplier set back to 1 comes out at
   8.8% here against 16.1 — the same planting, the same count, one number apart. */
const CANOPY = `() => {
  window.__keepStateP = state;
  state = 'pause';
  for (let i = 0; i < 60; i++) window.__px3(0, 0, 1, 1);        // one cell per frame
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  const px = window.__px3(0, 0, w, h);
  state = window.__keepStateP;
  /* readPixels hands back rows bottom first, so the TOP of the picture is the
     END of the buffer. Getting that backwards would count the grass and report a
     triumph either way. */
  let leaf = 0, seen = 0;
  for (let row = Math.floor(h * 0.82); row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = (row * w + col) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      seen++;
      // foliage: green ahead of both other channels. The sky is blue, the
      // buildings are grey and the road markings are not up here at all.
      if (g > 45 && g > r * 1.12 && g > b * 1.12) leaf++;
    }
  }
  return { leaf, seen, pct: +(100 * leaf / seen).toFixed(2) };
}`;
out.view = await p.evaluate(async src => {
  let best = null;
  for (const f of W.parks) {
    const a = (f.bb.x1 - f.bb.x0) * (f.bb.y1 - f.bb.y0);
    const c = { x: (f.bb.x0 + f.bb.x1) / 2, y: (f.bb.y0 + f.bb.y1) / 2 };
    if (Math.hypot(c.x - P.car.x, c.y - P.car.y) > 800) continue;
    if (!best || a > best.a) best = { a, c };
  }
  if (!best) return { note: 'no park in reach' };
  window.__tp(best.c.x - 60, best.c.y - 60, Math.PI / 4);
  P.car.vx = P.car.vy = 0;
  traffic.length = 0; cops.length = 0;
  const count = eval('(' + src + ')');
  const waitCells = async () => {
    let last = -1, still = 0, waited = 0;
    while (waited < 12000) {
      await new Promise(r => setTimeout(r, 120));
      waited += 120;
      const n = window.__gl3().cells;
      if (n === last && n > 0) { if (++still >= 4) break; } else { still = 0; last = n; }
    }
    return last;
  };
  if (typeof dropAllCells === 'function') dropAllCells();
  const cellsWith = await waitCells();
  const withTrees = count();
  // and the same frame with the parks taken out, which takes their trees with
  // them: the difference is the canopy and nothing else up there moved
  W.parks = [];
  if (typeof dropAllCells === 'function') dropAllCells();
  const cellsWithout = await waitCells();
  const without = count();
  return { area: Math.round(best.a), cellsWith, cellsWithout, withTrees, without };
}, CANOPY);
/* THE CONTROL CARRIES THIS, NOT THE THRESHOLD. Sixteen per cent of the upper
   frame is canopy as shipped and zero with the parks taken out of the world, so
   the floor only has to sit clear of nothing at all. Deliberately not set high
   enough to double as a height check: that would tie it to the spacing, and a
   threshold that moves when PARK_GAP moves is a threshold about the wrong thing.
   Height is section 1's job and it pins both ends of it to the centimetre. */
out.canopyIsOnScreen = !!out.view.note ||
  (out.view.withTrees.pct > 5 && out.view.without.pct < out.view.withTrees.pct * 0.25);

/* ---------- 6. and they are grown, not stamped ---------- */
/* Asked for after the first version shipped: use tree algorithms to generate
   them. A billboard passes every section above — it is planted, it is 40 m tall,
   it fills the top of the frame — and is still a photograph of a tree on a
   plank. What separates the two is structure, so the structure is what is
   measured, straight out of the vertex buffer the renderer is handed.

   THE FLAT-FAN TRAP is the one worth the section. A 2D recursion embedded in a
   3D world looks like a tree from one side and like a cardboard cutout from
   ninety degrees round — and it is the easy mistake, because the grower this
   one descends from IS two-dimensional. So the branch cloud's horizontal spread
   is taken along BOTH its principal axes, and the narrow one has to be a real
   fraction of the wide one. */
out.grown = await p.evaluate(() => {
  // a build that has no grower fails the section rather than throwing out of it,
  // which is what the A/B against the billboard version needs it to do
  if (typeof growTree3 !== 'function') return { note: 'no grower', limbs: 0, leafQuads: 0,
    verts: 0, tallness: 0, asked: 0, major: 0, minor: 0, baseR: 0, topR: 0, same: false };
  const lit = [], tre = [];
  const H = 30, gx = 40.5, gz = 90.5;
  growTree3(lit, tre, gx, gz, H, () => {});
  const F = LIT_FLOATS, n = lit.length / F;
  const y0 = terrainH(gx, gz);
  let hi = -1e9;
  let sxx = 0, szz = 0, sxz = 0, mx = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    const x = lit[i * F], y = lit[i * F + 1], z = lit[i * F + 2];
    if (y > hi) hi = y;
    mx += x - gx; mz += z - gz;
  }
  mx /= n; mz /= n;
  for (let i = 0; i < n; i++) {
    const dx = lit[i * F] - gx - mx, dz = lit[i * F + 2] - gz - mz;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  sxx /= n; szz /= n; sxz /= n;
  // the two principal spreads of the branch cloud seen from above
  const tr = sxx + szz, det = sxx * szz - sxz * sxz;
  const rt = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const major = Math.sqrt(Math.max(0, tr / 2 + rt)), minor = Math.sqrt(Math.max(0, tr / 2 - rt));
  /* THE TRUNK IS THE FIRST LIMB PUSHED, three faces of six vertices; its base
     ring sits on the ground and its top ring one limb up. The distance of each
     from the trunk's own axis is the radius there, so the taper the recursion
     applies is readable directly. */
  const ring = (from, to, lowHalf) => {
    let r = 0, m = 0;
    for (let i = from; i < to; i++) {
      const x = lit[i * F], y = lit[i * F + 1], z = lit[i * F + 2];
      const isLow = y - y0 < 1.0;
      if (isLow !== lowHalf) continue;
      r += Math.hypot(x - gx, z - gz); m++;
    }
    return m ? r / m : 0;
  };
  const baseR = ring(0, 18, true), topR = ring(0, 18, false);
  return { verts: n, limbs: Math.round(n / (3 * 6)),
           leafQuads: tre.length / (5 * 6),
           tallness: +(hi - y0).toFixed(2), asked: H,
           major: +major.toFixed(2), minor: +minor.toFixed(2),
           baseR: +baseR.toFixed(3), topR: +topR.toFixed(3),
           // the same seed twice has to give the same tree, or every cell that
           // is dropped and rebuilt grows a different wood
           same: (() => { const a = [], b = [];
                          growTree3(a, [], gx, gz, H, () => {});
                          growTree3(b, [], gx, gz, H, () => {});
                          return a.length === b.length && a.every((v, i) => v === b[i]); })() };
});
const G = out.grown;
/* A DOZEN LIMBS AND A DOZEN CLUSTERS. Three generations of forking gives about
   fifteen of each; the floor is set well under that so a change of one in the
   branching factor is not a failure, and the point is that it is MANY, which a
   billboard's zero is not. */
out.hasBranches = G.limbs >= 8 && G.leafQuads >= 8 && G.verts > 100;
/* Grown into a list and then fitted, so the tree really is the height it claims.
   The `note` guard is not decoration: with no grower both numbers are zero and
   "nothing is exactly as tall as nothing" passed the A/B. */
out.fitsItsHeight = !G.note && G.asked > 0 && Math.abs(G.tallness - G.asked) < 0.5;
// and it is a tree in three dimensions, not a fan painted on a plane
out.branchesInTheRound = G.minor > G.major * 0.35 && G.major > 1;
// each generation thinner than its parent — 0.62 in the recursion
out.trunkTapers = G.baseR > G.topR * 1.3 && G.topR > 0;
out.samePlaceSameTree = G.same;
/* AND THE BRANCHES REACH THE CELL MESHES — read above, before the parks were
   taken away. They are built into a mesh of their own so the shadow pass can
   skip them, which is exactly the sort of wiring that can be right in the buffer
   and missing from the world. */
out.cellsCarryTheWood = out.inTheWorld.withWood > 0 && out.inTheWorld.tris > 500;

out.errs = errs.slice(0, 5);
out.failing = Object.keys(out).filter(k => out[k] === false);
out.pass = out.parksArePlanted && out.threeTimesTaller && out.courtyardsGetTrees &&
           out.nothingInAWall && out.eachTreePlantedOnce && out.canopyIsOnScreen &&
           out.hasBranches && out.fitsItsHeight && out.branchesInTheRound &&
           out.trunkTapers && out.samePlaceSameTree && out.cellsCarryTheWood &&
           !out.errs.length;
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(out.pass ? 0 : 1);
