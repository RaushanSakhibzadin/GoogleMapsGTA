/* STAGE 2 — the district, rasterised onto a voxel lattice.
 *
 * In:  build/district.json
 * Out: build/voxels.json
 *
 * Still in metres. The lattice is WORLD-ALIGNED — cell (i, j) always covers
 * [i*V, (i+1)*V) whatever is standing on it — which matters for two reasons:
 * neighbouring buildings share a lattice so their walls meet instead of
 * z-fighting on a half-cell offset, and a rebuilt district comes back
 * identical. The source game plants its park trees off a world-aligned lattice
 * for the same reason and says so.
 *
 * WHAT GETS BUILT, and what deliberately does not:
 *
 *   walls   perimeter cells of the footprint, every level up to the roof
 *   roof    ONE slab across the whole footprint, one level above the walls
 *   ground  a single layer under everything: plain / park / road / kerb
 *
 * Interiors are never emitted. Nobody sees the inside of a building in a game
 * with no on-foot play, and a solid 5-storey block of flats is about forty
 * voxels of which six are visible.
 *
 * THE ROOF IS ITS OWN LAYER rather than a recolour of the top wall course. If
 * the top course were painted as roof, every building would lose its top metre
 * of wall when seen from the street; if it were painted as wall, every flat
 * roof in the city would be the wall colour seen from above. A separate slab
 * costs one footprint's worth of voxels, which greedy meshing then collapses
 * to almost nothing because a flat roof is the single most mergeable thing in
 * the bake.
 *
 * Usage: node tools/roblox/2-voxelise.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';

const V = CONFIG.voxel;
const D = JSON.parse(readFileSync(`${CONFIG.out}/district.json`, 'utf8'));

/* Lattice index of a metre coordinate, and the centre of a cell. Floor rather
   than round, so cell boundaries land on multiples of V and a cell's extent is
   unambiguous. */
const ci = m => Math.floor(m / V);
const cc = i => (i + 0.5) * V;

const H = CONFIG.half;
const I0 = ci(-H), I1 = ci(H);              // district cell range, inclusive
const SPAN = I1 - I0 + 1;

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

/* ---------------- buildings ---------------- */

/* Every voxel is one entry: key "x,y,z" -> {c: [r,g,b], k: kind}. A Map rather
   than a dense 3D array because the city is overwhelmingly empty — a dense
   array at 4 m over 1.2 km by 90 m tall is 300*300*23 cells, most of them air,
   and the sparse form is both smaller and what stage 3 wants to iterate. */
const vox = new Map();
const key = (x, y, z) => x + ',' + y + ',' + z;
const put = (x, y, z, c, k) => { vox.set(key(x, y, z), { c, k }); };

let tallest = 0, skipped = 0;
for (const b of D.buildings) {
  // footprint cell bounds
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of b.pts) {
    x0 = Math.min(x0, ci(p[0])); x1 = Math.max(x1, ci(p[0]));
    z0 = Math.min(z0, ci(p[1])); z1 = Math.max(z1, ci(p[1]));
  }

  /* Rasterise the footprint into a local mask. Padded by one cell on every
     side so the perimeter test below can read a neighbour without a bounds
     check and correctly see "outside" there. */
  const w = x1 - x0 + 3, d = z1 - z0 + 3;
  const fill = new Uint8Array(w * d);
  let cells = 0;
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const gx = x0 - 1 + i, gz = z0 - 1 + j;
      if (inPoly(b.pts, cc(gx), cc(gz))) { fill[j * w + i] = 1; cells++; }
    }
  }

  /* A FOOTPRINT CAN RASTERISE TO NOTHING. A long thin building — a terrace
     wing, a covered walkway — can be narrower than a voxel and pass between
     every sample point, and CONFIG.minArea does not catch it because area is
     not width. Rather than lose the building, its bounding-box centre cell is
     filled, so a real structure becomes one voxel instead of none. */
  if (!cells) {
    const mx = ci((x0 + x1) / 2 * V + V / 2) - x0 + 1;
    const mz = ci((z0 + z1) / 2 * V + V / 2) - z0 + 1;
    fill[Math.max(0, Math.min(d - 1, mz)) * w + Math.max(0, Math.min(w - 1, mx))] = 1;
    cells = 1;
    skipped++;
  }

  const levels = Math.max(1, Math.round(b.h / V));
  tallest = Math.max(tallest, levels);

  for (let j = 1; j < d - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      if (!fill[j * w + i]) continue;
      const gx = x0 - 1 + i, gz = z0 - 1 + j;
      // outside the district? a building kept for its centroid can overhang
      if (gx < I0 || gx > I1 || gz < I0 || gz > I1) continue;

      /* PERIMETER = any 4-neighbour empty. Diagonals deliberately not counted:
         a cell touching outside only at a corner has no exposed face, and
         including it fattens every diagonal wall to two voxels thick. */
      const edge = !fill[j * w + i - 1] || !fill[j * w + i + 1] ||
                   !fill[(j - 1) * w + i] || !fill[(j + 1) * w + i];

      if (edge) for (let y = 0; y < levels; y++) put(gx, y, gz, b.wall, 'wall');
      put(gx, levels, gz, b.roof, 'roof');       // the roof slab, over everything
    }
  }
}

/* ---------------- the ground ----------------

   One layer at y = -1, so its top face is exactly y = 0 and buildings stand on
   it rather than in it. Painted in four passes, later ones winning: plain,
   then parks, then the kerb ring, then the road surface itself. The kerb is
   laid BEFORE the road and then overwritten wherever road actually falls,
   which is what makes it a ring around the tarmac rather than a stripe through
   it — see CONFIG.kerbs for why a kerb is a colour here and not geometry. */
const ground = new Uint8Array(SPAN * SPAN);      // 0 plain, 1 park, 2 kerb, 3 road
const gset = (i, j, v) => {
  if (i < I0 || i > I1 || j < I0 || j > I1) return;
  ground[(j - I0) * SPAN + (i - I0)] = v;
};
const gget = (i, j) =>
  (i < I0 || i > I1 || j < I0 || j > I1) ? 0 : ground[(j - I0) * SPAN + (i - I0)];

// parks
for (const p of D.parks) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of p.pts) {
    x0 = Math.min(x0, ci(q[0])); x1 = Math.max(x1, ci(q[0]));
    z0 = Math.min(z0, ci(q[1])); z1 = Math.max(z1, ci(q[1]));
  }
  for (let j = z0; j <= z1; j++)
    for (let i = x0; i <= x1; i++)
      if (inPoly(p.pts, cc(i), cc(j))) gset(i, j, 1);
}

/* Stamp a polyline of a given width onto the ground layer. Walks each segment
   at half a cell so nothing is missed on a diagonal, and paints every cell
   within half the road width of the centreline — which is the same thing
   markRoads() does to the drivable mask in world.js, at the same 8 m scale, so
   the tarmac you can see and the tarmac you can drive on agree. */
function stampLine(pts, width, value) {
  const r = width / 2;
  const reach = Math.ceil(r / V) + 1;
  for (let s = 1; s < pts.length; s++) {
    const ax = pts[s - 1][0], ay = pts[s - 1][1];
    const bx = pts[s][0], by = pts[s][1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (V / 2)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const gi = ci(px), gj = ci(py);
      for (let j = gj - reach; j <= gj + reach; j++)
        for (let i = gi - reach; i <= gi + reach; i++)
          if (Math.hypot(cc(i) - px, cc(j) - py) <= r) gset(i, j, value);
    }
  }
}

// kerb ring first, then tarmac over it
if (CONFIG.kerbs) for (const r of D.roads) stampLine(r.pts, r.w + 2 * V, 2);
for (const r of D.roads) stampLine(r.pts, r.w, 3);

/* ---------------- out ---------------- */

/* The voxel map goes out as four flat arrays rather than a list of objects.
   At tens of thousands of entries, {x,y,z,r,g,b} per voxel is several times the
   size in JSON and several times the parse time, and stage 3 wants the columns
   anyway. Colours are deduplicated into a palette here, which is also what
   makes the "identical voxel" test in the greedy mesher a single integer
   compare instead of three. */
const pal = [];
const palIx = new Map();
const palette = c => {
  const k = c[0] + ',' + c[1] + ',' + c[2];
  let i = palIx.get(k);
  if (i === undefined) { i = pal.length; palIx.set(k, i); pal.push(c); }
  return i;
};

const xs = [], ys = [], zs = [], cs = [];
/* SORTED, so the output is stable. A Map iterates in insertion order, which
   depends on the order buildings were parsed in — stable today, but this is
   the file every later stage is diffed against and it costs one sort. */
const keys = [...vox.keys()].sort((a, b) => {
  const A = a.split(','), B = b.split(',');
  return (+A[0] - +B[0]) || (+A[1] - +B[1]) || (+A[2] - +B[2]);
});
for (const k of keys) {
  const [x, y, z] = k.split(',').map(Number);
  xs.push(x); ys.push(y); zs.push(z); cs.push(palette(vox.get(k).c));
}

const out = {
  meta: { voxel: V, cellRange: [I0, I1], span: SPAN, ground: -1,
          note: 'lattice indices, world-aligned; y is levels above ground top' },
  palette: pal,
  building: { x: xs, y: ys, z: zs, c: cs },
  ground: Array.from(ground)
};
writeFileSync(`${CONFIG.out}/voxels.json`, JSON.stringify(out));

const counts = [0, 0, 0, 0];
for (const g of ground) counts[g]++;
console.log(`voxelise: ${V} m lattice, ${SPAN} x ${SPAN} cells`);
console.log(`  building voxels  ${xs.length}   (${pal.length} distinct colours)`);
console.log(`  tallest          ${tallest} levels (${tallest * V} m)`);
if (skipped) console.log(`  thin footprints  ${skipped} rasterised to a single cell`);
console.log(`  ground cells     ${counts[3]} road, ${counts[2]} kerb, ${counts[1]} park, ${counts[0]} plain`);
console.log(`  UNMESHED TOTAL   ${xs.length + SPAN * SPAN} parts if built one cube at a time`);
