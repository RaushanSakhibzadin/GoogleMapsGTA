/* STAGE 2 — the district, rasterised onto a lattice.
 *
 * In:  build/district.json
 * Out: build/voxels.json
 *
 * Still in metres. LATTICE-AGNOSTIC: cells are addressed by two integers and a
 * level, and the shape behind those integers — square or hexagonal — lives in
 * lattice.mjs. Everything here asks the lattice where a cell's centre is, which
 * cell holds a point, and who a cell's neighbours are.
 *
 * The lattice is WORLD-ALIGNED whichever shape it is: cell (a, b) always covers
 * the same ground however the district is sliced, so neighbouring buildings
 * share a lattice and their walls meet instead of z-fighting on a half-cell
 * offset, and a rebuilt district comes back identical. The source game plants
 * its park trees off a world-aligned lattice for the same reason.
 *
 * WHAT GETS BUILT, and what deliberately does not:
 *
 *   walls   perimeter cells of the footprint, every level up to the roof
 *   roof    ONE slab across the whole footprint, one level above the walls
 *   ground  a single layer under everything: plain / park / road / kerb
 *
 * Interiors are never emitted. Nobody sees the inside of a building in a game
 * with no on-foot play, and a solid 5-storey block of flats is about forty
 * cells of which six are visible.
 *
 * THE ROOF IS ITS OWN LAYER rather than a recolour of the top wall course. If
 * the top course were painted as roof, every building would lose its top metre
 * of wall from the street; if it were painted as wall, every flat roof would be
 * the wall colour seen from above.
 *
 * Usage: node tools/roblox/2-voxelise.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { makeLattice } from './lattice.mjs';
import { hash01 } from './gamesrc.mjs';

const L = makeLattice(CONFIG);
const D = JSON.parse(readFileSync(`${CONFIG.out}/district.json`, 'utf8'));
const H = CONFIG.half;

/* THE LEVEL HEIGHT IS NOT THE CELL WIDTH once the lattice can be hexagonal: a
   hex has a circumradius, not a side. Levels stay at CONFIG.voxel metres for
   both, so building heights quantise the same way whichever shape is standing
   there and the storey count of a block does not change when the lattice does. */
const LV = CONFIG.voxel;

const inside = (x, y) => x >= -H && x <= H && y >= -H && y <= H;

/* THE ARCHWAY. Cells whose centre is within the gate's half-width of the line
   the road takes through the building are carved out below gate height, and the
   cells bounding the hole are then emitted as wall so the passage has sides
   rather than opening into the building's hollow interior.

   Carved right through rather than stopping at the walls the road crosses: the
   browser needs the exact wall positions because it cuts holes in specific
   faces of a drawn polygon, but a lattice has no faces to cut -- removing the
   corridor IS the archway, and it guarantees both ends are open. */
const GATE_LEVELS = Math.max(1, Math.round(CONFIG.gateH / CONFIG.voxel));
function gateCarves(gate, cx, cy) {
  if (!gate) return false;
  const dx = cx - gate.x, dy = cy - gate.y;
  // perpendicular distance from the gate's centreline
  const perp = Math.abs(dx * -gate.uy + dy * gate.ux);
  return perp <= gate.w;
}

/* ---------------- what colour a wall cell is ----------------

   The browser's window shader, reduced to the only thing a voxel city can vary:
   the colour of the cell. See CONFIG.windows for the rules and what they cost.

   HASHED ON THE CELL'S WORLD POSITION, not on an index, so which windows are
   lit is stable across a re-bake and two neighbouring buildings do not share a
   pattern just because they were parsed one after the other. Same reasoning as
   the height hash in stage 1. */
function wallColour(bld, level, levels, a, b) {
  let col = bld.wall;

  if (CONFIG.windows && bld.h >= CONFIG.winMinH && levels >= 3) {
    const top = level === levels - 1;          // the cornice
    const ground = level === 0;                // the shopfront
    // alternate courses between them, so there is wall between the rows
    const band = !top && (ground || level % 2 === 1);
    if (band) {
      col = CONFIG.winGlass;
      if (hash01(a * 7349 + b * 9151, level * 31 + 3) < CONFIG.winLitFrac)
        col = CONFIG.winLit;
    }
  }

  /* AND THE TEXTURE, such as it is. proctex.js grows every surface in the
     browser from fractal noise; a voxel city has no surface to put noise on, so
     the equivalent is a small brightness step per cell. Quantised, because
     greedy meshing merges IDENTICAL cells and a unique shade per cell would
     defeat it entirely -- which is what CONFIG.shades is about. */
  if (CONFIG.shades > 1) {
    const step = Math.floor(hash01(a * 2657 + b * 3413, level) * CONFIG.shades);
    const k = 1 + (step / (CONFIG.shades - 1) * 2 - 1) * CONFIG.shadeSpread;
    col = col.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
  }
  return col;
}

/* ---------------- point in polygon ----------------
   Even-odd ray cast. The footprints come from OSM ways, which are closed
   (first vertex repeated), and the half-open comparison on y is what stops a
   vertex exactly on the ray being counted twice. */
function inPoly(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i][1], yj = pts[j][1];
    if ((yi > y) !== (yj > y)) {
      const t = (y - yi) / (yj - yi);
      if (x < pts[i][0] + t * (pts[j][0] - pts[i][0])) hit = !hit;
    }
  }
  return hit;
}

/* Every cell in the district, once. Built by walking a fine grid of sample
   points and asking the lattice which cell each lands in — which works for any
   lattice shape without this file knowing how to enumerate one. The sample
   step is half the smallest cell dimension, so nothing is missed. */
function districtCells() {
  const seen = new Map();                 // "a,b" -> [a, b, cx, cy]
  const step = Math.min(L.size, LV) / 2;
  for (let y = -H; y <= H; y += step) {
    for (let x = -H; x <= H; x += step) {
      const [a, b] = L.cellOf(x, y);
      const k = a + ',' + b;
      if (seen.has(k)) continue;
      const [cx, cy] = L.centre(a, b);
      if (!inside(cx, cy)) continue;
      seen.set(k, [a, b, cx, cy]);
    }
  }
  return seen;
}

const CELLS = districtCells();

/* ---------------- buildings ---------------- */

const vox = new Map();                    // "a,level,b" -> {c, k}
const key = (a, l, b) => a + ',' + l + ',' + b;
const put = (a, l, b, c, k) => { vox.set(key(a, l, b), { c, k }); };

let tallest = 0, thin = 0, arches = 0;
for (const bld of D.buildings) {
  /* Which cells this footprint covers. Sampled over its bounding box at half a
     cell, then each candidate's CENTRE is tested against the polygon — testing
     the sample points themselves would fill cells whose centres are outside. */
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of bld.pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const step = L.size / 2;
  const cand = new Map();
  for (let y = y0 - L.reach; y <= y1 + L.reach; y += step)
    for (let x = x0 - L.reach; x <= x1 + L.reach; x += step) {
      const [a, b] = L.cellOf(x, y);
      const k = a + ',' + b;
      if (!cand.has(k)) cand.set(k, [a, b]);
    }

  const fill = new Set();
  for (const [k, [a, b]] of cand) {
    const [cx, cy] = L.centre(a, b);
    if (inPoly(bld.pts, cx, cy)) fill.add(k);
  }

  /* A FOOTPRINT CAN RASTERISE TO NOTHING. A long thin building — a terrace
     wing, a covered walkway — can be narrower than a cell and pass between
     every centre, and CONFIG.minArea does not catch it because area is not
     width. Rather than lose the building, the cell holding its centroid is
     filled, so a real structure becomes one cell instead of none. */
  if (!fill.size) {
    const [a, b] = L.cellOf((x0 + x1) / 2, (y0 + y1) / 2);
    fill.add(a + ',' + b);
    thin++;
  }

  const levels = Math.max(1, Math.round(bld.h / LV));
  tallest = Math.max(tallest, levels);

  // which of this building's cells the archway removes, if it has one
  const gate = D.gates && D.gates[bld.id];
  const carved = new Set();
  if (gate) {
    for (const k of fill) {
      const [a, b] = k.split(',').map(Number);
      const [cx, cy] = L.centre(a, b);
      if (gateCarves(gate, cx, cy)) carved.add(k);
    }
    if (carved.size) arches++;
  }

  for (const k of fill) {
    const [a, b] = k.split(',').map(Number);
    const [cx, cy] = L.centre(a, b);
    if (!inside(cx, cy)) continue;        // a building kept for its centroid can overhang

    // PERIMETER = any neighbour not filled. That is what makes the shell.
    let edge = false;
    for (const [na, nb] of L.neighbours(a, b))
      if (!fill.has(na + ',' + nb)) { edge = true; break; }

    /* AND THE PASSAGE HAS SIDES. A cell next to a carved one is emitted as wall
       even when it is deep inside the footprint -- without this you drive into
       the archway and out through the middle of the building, because interior
       cells were never built. */
    let lines = false;
    if (carved.size && !carved.has(k)) {
      for (const [na, nb] of L.neighbours(a, b))
        if (carved.has(na + ',' + nb)) { lines = true; break; }
    }

    const open = carved.has(k);
    for (let l = 0; l < levels; l++) {
      if (open && l < GATE_LEVELS) continue;        // the hole itself
      if (edge || (lines && l < GATE_LEVELS))
        put(a, l, b, wallColour(bld, l, levels, a, b), 'wall');
    }
    put(a, levels, b, bld.roof, 'roof');  // the roof slab, over everything
  }
}

/* ---------------- the ground ----------------

   One layer at level -1, so its top face is exactly y = 0 and buildings stand
   on it rather than in it. Painted in four passes, later ones winning: plain,
   then parks, then the kerb ring, then the road itself. The kerb is laid BEFORE
   the road and overwritten wherever tarmac actually falls, which is what makes
   it a ring around the road rather than a stripe through it. */
const ground = new Map();                 // "a,b" -> 0 plain, 1 park, 2 kerb, 3 road
for (const [k] of CELLS) ground.set(k, 0);

function stampPoly(pts, value) {
  for (const [k, [, , cx, cy]] of CELLS)
    if (inPoly(pts, cx, cy)) ground.set(k, value);
}
for (const p of D.parks) stampPoly(p.pts, 1);

/* Stamp a polyline of a given width. Walks each segment at half a cell so
   nothing is missed on a diagonal, and paints every cell whose CENTRE is within
   half the road width — the same thing markRoads() does to the drivable mask in
   world.js, so the tarmac you see and the tarmac you drive on agree. */
function stampLine(pts, width, value) {
  const rad = width / 2;
  const step = L.size / 2;
  for (let s = 1; s < pts.length; s++) {
    const [ax, ay] = pts[s - 1], [bx, by] = pts[s];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      /* Every cell within `rad` of this point. Sampling a disc of candidates
         and testing their centres is lattice-independent; a per-shape ring walk
         would be faster and would have to know what shape it was walking. */
      for (let dy = -rad - L.reach; dy <= rad + L.reach; dy += step)
        for (let dx = -rad - L.reach; dx <= rad + L.reach; dx += step) {
          const [a, b] = L.cellOf(px + dx, py + dy);
          const k = a + ',' + b;
          if (!ground.has(k)) continue;
          const [cx, cy] = L.centre(a, b);
          if (Math.hypot(cx - px, cy - py) <= rad) ground.set(k, value);
        }
    }
  }
}

if (CONFIG.kerbs) for (const r of D.roads) stampLine(r.pts, r.w + 4 * LV, 2);
for (const r of D.roads) stampLine(r.pts, r.w, 3);

/* ---------------- out ----------------

   Flat arrays and a deduplicated palette rather than a list of objects: at
   hundreds of thousands of cells the object form is several times the JSON and
   several times the parse, stage 3 wants the columns anyway, and a palette
   index makes the "identical cell" test in the mesher one integer compare. */
const pal = [];
const palIx = new Map();
const palette = c => {
  const k = c[0] + ',' + c[1] + ',' + c[2];
  let i = palIx.get(k);
  if (i === undefined) { i = pal.length; palIx.set(k, i); pal.push(c); }
  return i;
};

// SORTED, so the output is stable and a re-bake diffs cleanly.
const keys = [...vox.keys()].sort((p, q) => {
  const A = p.split(',').map(Number), B = q.split(',').map(Number);
  return (A[0] - B[0]) || (A[1] - B[1]) || (A[2] - B[2]);
});
const as = [], ls = [], bs = [], cs = [];
for (const k of keys) {
  const [a, l, b] = k.split(',').map(Number);
  as.push(a); ls.push(l); bs.push(b); cs.push(palette(vox.get(k).c));
}

const gk = [...ground.keys()].sort();
const ga = [], gb = [], gv = [];
for (const k of gk) {
  const [a, b] = k.split(',').map(Number);
  ga.push(a); gb.push(b); gv.push(ground.get(k));
}

writeFileSync(`${CONFIG.out}/voxels.json`, JSON.stringify({
  meta: { lattice: L.kind, size: L.size, levelM: LV, halfM: H,
          note: 'cells are [a, level, b]; a/b are lattice coords, level 0 = ground floor' },
  palette: pal,
  building: { a: as, l: ls, b: bs, c: cs },
  ground: { a: ga, b: gb, v: gv }
}));

const counts = [0, 0, 0, 0];
for (const v of gv) counts[v]++;
console.log(`voxelise: ${L.kind} lattice, size ${L.size} m, ${LV} m levels`);
console.log(`  cells in district  ${CELLS.size}`);
console.log(`  building cells     ${as.length}   (${pal.length} distinct colours)`);
console.log(`  tallest            ${tallest} levels (${tallest * LV} m)`);
if (thin) console.log(`  thin footprints    ${thin} rasterised to a single cell`);
console.log(`  archways cut       ${arches} (${GATE_LEVELS} levels, ${GATE_LEVELS * LV} m clear)`);
console.log(`  ground             ${counts[3]} road, ${counts[2]} kerb, ${counts[1]} park, ${counts[0]} plain`);
console.log(`  UNMERGED TOTAL     ${as.length + ga.length}`);
