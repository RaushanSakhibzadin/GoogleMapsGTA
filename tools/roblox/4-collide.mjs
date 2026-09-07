/* STAGE 4 — the geometry the physics engine sees, and the gameplay masks.
 *
 * In:  build/district.json
 * Out: build/collision.json
 *
 * The plan's most important structural decision (§4.4) is that COLLISION
 * GEOMETRY IS NOT VISUAL GEOMETRY. The voxel shell is thousands of Parts that
 * exist to be looked at: CanCollide false, CanQuery false, built by the client,
 * never in a physics broadphase, droppable on a weak device. What a car
 * actually hits is this file — a couple of thousand anchored boxes, built by
 * the server.
 *
 * THE BOXES ARE FITTED TO THE VOXEL RASTER, NOT TO THE OSM POLYGON, and that
 * is the whole subtlety of this stage. It would be more faithful to collide
 * against the real footprint — the source game does exactly that, testing eight
 * points on the car body against the polygon. But the player does not see the
 * polygon. They see a stack of 4 m cubes. Colliding against the polygon under a
 * voxel wall gives you a car that clips through a visible corner in one place
 * and stops against thin air in another, and there is no amount of tuning that
 * fixes it. Matching the raster means what you can see is exactly what you can
 * hit.
 *
 * Also baked here, because they are gameplay data rather than scenery:
 *   · the drivable road mask, at the same 8 m cell the source game uses
 *   · the depots, so M3 has somewhere to sign on
 *
 * Usage: node tools/roblox/4-collide.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';

const V = CONFIG.voxel;
const D = JSON.parse(readFileSync(`${CONFIG.out}/district.json`, 'utf8'));

const ci = m => Math.floor(m / V);
const cc = i => (i + 0.5) * V;
const H = CONFIG.half;

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

/* ---------------- the solid, as one field ----------------

 * FITTED TO THE UNION OF ALL BUILDINGS, not to one building at a time, and
 * this is worth explaining because the obvious version is much worse.
 *
 * Per-building boxes came out at 7,472 for 1,519 buildings — nearly five each.
 * The cause is that Belgrade's streets do not run along the lattice: a footprint
 * at 30 degrees to the grid rasterises into a staircase, and a staircase greedy-
 * rects into a pile of one-cell strips. Half the district is at an angle to
 * everything else, so almost every building paid it.
 *
 * Meshing the union fixes it twice over. Terraced perimeter blocks — which is
 * most of central Belgrade — share walls, so a whole street frontage of
 * separate OSM ways becomes one run of cells with no seam in it. And a
 * staircase edge between two buildings of similar height disappears entirely,
 * because there is no longer a boundary there to break the run.
 *
 * The height of a cell is the tallest building covering it. That is the correct
 * merge: two neighbours of different heights produce a tall slab and a short
 * one stacked beside it, never a short box swallowing a tall neighbour.
 */
const hCell = new Map();                          // "x,z" -> levels
/* AND WHERE A CELL'S SOLID PART STARTS, which is not always the ground.
   A building with a road through it has an archway carved out of it below gate
   height (see stage 2), and the collision has to have the same hole or you can
   see the passage and still hit a wall in it. */
const baseCell = new Map();                       // "x,z" -> first solid level
const cellKey = (x, z) => x + ',' + z;

const GATE_LEVELS = Math.max(1, Math.round(CONFIG.gateH / CONFIG.voxel));
function inGate(gate, cx, cy) {
  if (!gate) return false;
  const dx = cx - gate.x, dy = cy - gate.y;
  return Math.abs(dx * -gate.uy + dy * gate.ux) <= gate.w;
}
for (const b of D.buildings) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of b.pts) {
    x0 = Math.min(x0, ci(p[0])); x1 = Math.max(x1, ci(p[0]));
    z0 = Math.min(z0, ci(p[1])); z1 = Math.max(z1, ci(p[1]));
  }
  const levels = Math.max(1, Math.round(b.h / V));
  const gate = D.gates && D.gates[b.id];
  let any = false;
  for (let j = z0; j <= z1; j++)
    for (let i = x0; i <= x1; i++)
      if (inPoly(b.pts, cc(i), cc(j))) {
        any = true;
        const k = cellKey(i, j);
        if ((hCell.get(k) || 0) < levels) hCell.set(k, levels);
        /* The archway. A cell under the passage is solid only ABOVE it -- and
           the lowest base wins where two buildings overlap, because a cell you
           can drive through in one of them is a cell you can drive through. */
        if (inGate(gate, cc(i), cc(j))) {
          const cur = baseCell.get(k);
          if (cur === undefined || cur > GATE_LEVELS) baseCell.set(k, GATE_LEVELS);
        } else if (baseCell.get(k) === undefined) {
          baseCell.set(k, 0);
        }
      }
  /* Same fallback as the voxeliser, for the same reason: a footprint thinner
     than the lattice must still be solid, or you drive through a building that
     is visibly standing there. */
  if (!any) {
    const k = cellKey(ci((b.pts[0][0] + b.pts[2 % b.pts.length][0]) / 2),
                      ci((b.pts[0][1] + b.pts[2 % b.pts.length][1]) / 2));
    if ((hCell.get(k) || 0) < levels) hCell.set(k, levels);
  }
}

/* ---------------- greedy boxes over the solid ----------------

   The 3D mesher's growth, over occupancy rather than colour: run in X, extend
   in Z while whole rows are occupied to at least this height, then extend up
   in Y while the whole rectangle still reaches. Cells are consumed by LEVEL,
   not wholesale, so a tall tower beside a low terrace contributes its lower
   levels to the terrace's wide slab and its upper levels to a narrow one. */
const boxes = [];
const consumed = new Map();                       // "x,z" -> levels already boxed
const solidTo = (x, z, y) => {
  const k = cellKey(x, z);
  const h = hCell.get(k) || 0;
  if (h <= y) return false;
  if (y < (baseCell.get(k) || 0)) return false;    // under an archway
  return (consumed.get(k) || 0) <= y;
};

const xsAll = [...hCell.keys()].map(k => k.split(',').map(Number));
xsAll.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

let maxLev = 0;
for (const h of hCell.values()) maxLev = Math.max(maxLev, h);

for (let y = 0; y < maxLev; y++) {
  for (const [sx, sz] of xsAll) {
    if (!solidTo(sx, sz, y)) continue;
    // never seed a box in the void under an archway
    if (y < (baseCell.get(cellKey(sx, sz)) || 0)) continue;

    let ex = sx;
    while (solidTo(ex + 1, sz, y)) ex++;

    let ez = sz;
    outerZ: while (true) {
      for (let x = sx; x <= ex; x++) if (!solidTo(x, ez + 1, y)) break outerZ;
      ez++;
    }

    let ey = y;
    outerY: while (true) {
      for (let z = sz; z <= ez; z++)
        for (let x = sx; x <= ex; x++) if (!solidTo(x, z, ey + 1)) break outerY;
      ey++;
    }

    for (let z = sz; z <= ez; z++)
      for (let x = sx; x <= ex; x++) consumed.set(cellKey(x, z), ey + 1);

    // [x, z, sx, sz, y0, levels]
    boxes.push([sx, sz, ex - sx + 1, ez - sz + 1, y, ey - y + 1]);
  }
}

/* ---------------- the drivable mask ----------------

   8 m cells, matching W.cell in world.js exactly. That is not tidiness: the
   off-road behaviour in drive() is tuned against this cell size — STRAY_TOL is
   10 m, a bit over one cell, precisely so that a metre of disagreement between
   the mask and the drawn road is free. Bake it at 4 m or 16 and those constants
   stop meaning what they were tuned to mean.

   Only ways DRIVABLE() accepts are stamped, so footways and tracks are visible
   in the voxel ground but do not count as road — same as the browser. */
const MC = CONFIG.maskCell;
const MSPAN = Math.ceil((2 * H) / MC);
const mask = new Uint8Array(MSPAN * MSPAN);
const mset = (i, j) => { if (i >= 0 && i < MSPAN && j >= 0 && j < MSPAN) mask[j * MSPAN + i] = 1; };

for (const r of D.roads) {
  if (!r.drive) continue;
  const rad = r.w / 2, reach = Math.ceil(rad / MC) + 1;
  for (let s = 1; s < r.pts.length; s++) {
    const [ax, ay] = r.pts[s - 1], [bx, by] = r.pts[s];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (MC / 2)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const gi = Math.floor((px + H) / MC), gj = Math.floor((py + H) / MC);
      for (let j = gj - reach; j <= gj + reach; j++)
        for (let i = gi - reach; i <= gi + reach; i++) {
          const cxm = (i + 0.5) * MC - H, cym = (j + 0.5) * MC - H;
          if (Math.hypot(cxm - px, cym - py) <= rad) mset(i, j);
        }
    }
  }
}

/* Packed one bit per cell and base64'd. 150 x 150 cells is 22,500 bits — 2.8 kB
   packed against 45 kB as a JSON array of 0s and 1s, and Luau decodes it with
   buffer.fromstring in one call rather than parsing twenty thousand numbers. */
const packed = Buffer.alloc(Math.ceil(mask.length / 8));
for (let i = 0; i < mask.length; i++) if (mask[i]) packed[i >> 3] |= 1 << (i & 7);

/* ---------------- incident sites ----------------

   Somewhere for a fire to be. A building is only usable if you can DRIVE to it,
   so each candidate is kept only when the drivable mask has tarmac within
   reach -- otherwise dispatch sends people to a courtyard in the middle of a
   block with no way in, which is the same bug the browser hit with its depots
   and fixed with depotGate().

   Capped and evenly spread rather than taking the first N: a list built in
   parse order is a list of whatever happens to be in the north-west corner. */
const SITE_REACH = 40;             // metres from the building to the nearest road
const SITE_CAP = 400;
function nearRoadCell(x, y, reach) {
  const c = Math.ceil(reach / MC);
  const gi = Math.floor((x + H) / MC), gj = Math.floor((y + H) / MC);
  for (let j = gj - c; j <= gj + c; j++)
    for (let i = gi - c; i <= gi + c; i++)
      if (i >= 0 && i < MSPAN && j >= 0 && j < MSPAN && mask[j * MSPAN + i]) {
        const dx = (i + 0.5) * MC - H - x, dy = (j + 0.5) * MC - H - y;
        if (Math.hypot(dx, dy) <= reach) return true;
      }
  return false;
}

const usable = [];
for (const b of D.buildings) {
  let cx = 0, cy = 0;
  for (const p of b.pts) { cx += p[0]; cy += p[1]; }
  cx /= b.pts.length; cy /= b.pts.length;
  if (!nearRoadCell(cx, cy, SITE_REACH)) continue;
  usable.push({ x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10,
                name: b.name || '', h: b.h });
}
const stride = Math.max(1, Math.floor(usable.length / SITE_CAP));
const sites = usable.filter((_, i) => i % stride === 0).slice(0, SITE_CAP);

/* ---------------- the minimap ----------------

   A PICTURE OF THE DISTRICT, rasterised here and painted into an EditableImage
   on the client. Roblox cannot ship an image without uploading it as an asset,
   and an asset needs the Open Cloud pipeline and a moderation pass -- so the
   map travels as pixels instead, which is the same trick the hex prism uses for
   its mesh and the same thing proctex.js does in the browser.

   TWO BITS A PIXEL, not a colour: plain / park / road / kerb, with the palette
   applied on the client. 512 squared at four pixels a byte is 64 kB before
   base64, against 786 kB for RGB -- and the four classes are all a minimap has
   ever needed.

   THE RESOLUTION FOLLOWS THE DISTRICT rather than being a fixed 512, which it
   was until the district grew. 2.3 m a pixel is the number that matters: a
   residential street is three pixels wide at it and an arterial seven, which is
   why roads are stamped at their real width rather than as hairlines -- a
   minimap you can read is one where a main road looks like a main road.

   Fixing the pixel count instead of the scale meant a 2.4 km district came out
   at 4.7 m a pixel, coarser than the 2.15 m the minimap panel actually samples
   at -- so the map would have been visibly blockier than the thing drawing it,
   with a back street two pixels across. Rounded to a power of two because
   nothing here cares about the exact number and a tidy one is easier to reason
   about. */
const MAP_PX = Math.min(2048, Math.max(256,
  2 ** Math.round(Math.log2(2 * H / CONFIG.minimapMPerPx))));
const mapBits = new Uint8Array(MAP_PX * MAP_PX);
const mapPx = m => Math.floor((m + H) / (2 * H) * MAP_PX);
const mapM = p => (p + 0.5) / MAP_PX * (2 * H) - H;

function mapStampPoly(pts, v) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of pts) {
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
  }
  for (let j = Math.max(0, mapPx(y0)); j <= Math.min(MAP_PX - 1, mapPx(y1)); j++)
    for (let i = Math.max(0, mapPx(x0)); i <= Math.min(MAP_PX - 1, mapPx(x1)); i++)
      if (inPoly(pts, mapM(i), mapM(j))) mapBits[j * MAP_PX + i] = v;
}

function mapStampLine(pts, width, v) {
  const rad = width / 2;
  const ppm = MAP_PX / (2 * H);
  const reach = Math.ceil(rad * ppm) + 1;
  for (let s2 = 1; s2 < pts.length; s2++) {
    const [ax, ay] = pts[s2 - 1], [bx, by] = pts[s2];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len * ppm));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const gi = mapPx(px), gj = mapPx(py);
      for (let j = gj - reach; j <= gj + reach; j++)
        for (let i = gi - reach; i <= gi + reach; i++) {
          if (i < 0 || i >= MAP_PX || j < 0 || j >= MAP_PX) continue;
          if (Math.hypot(mapM(i) - px, mapM(j) - py) <= rad) mapBits[j * MAP_PX + i] = v;
        }
    }
  }
}

for (const p of D.parks) mapStampPoly(p.pts, 1);
if (CONFIG.kerbs) for (const r of D.roads) mapStampLine(r.pts, r.w + 3 * V, 2);
for (const r of D.roads) mapStampLine(r.pts, r.w, 3);

const mapPacked = Buffer.alloc(mapBits.length / 4);
for (let i = 0; i < mapBits.length; i++)
  mapPacked[i >> 2] |= (mapBits[i] & 3) << ((i & 3) * 2);

/* ---------------- out ---------------- */
writeFileSync(`${CONFIG.out}/collision.json`, JSON.stringify({
  meta: { voxel: V, halfM: H, maskCell: MC, maskSpan: MSPAN,
          note: 'boxes are [x, z, sx, sz, levels] in lattice cells; y from 0 to levels' },
  boxes,
  mask: { span: MSPAN, cell: MC, bits: packed.toString('base64') },
  depots: D.pois,
  sites,
  minimap: { px: MAP_PX, bits: mapPacked.toString('base64') }
}));

let drivable = 0;
for (const m of mask) if (m) drivable++;
const cells = hCell.size;
const vol = boxes.reduce((a, b) => a + b[2] * b[3] * b[5], 0);
console.log(`collide: ${boxes.length} collision boxes for ${D.buildings.length} buildings`);
console.log(`  per building  ${(boxes.length / D.buildings.length).toFixed(2)} average over ${cells} solid cells`);
console.log(`  merge         ${(vol / boxes.length).toFixed(1)} cells a box`);
let arch = 0;
for (const v of baseCell.values()) if (v > 0) arch++;
console.log(`  archways      ${arch} cells left open under a passage`);
console.log(`  road mask     ${MSPAN} x ${MSPAN} at ${MC} m, ${drivable} drivable cells (${(100 * drivable / mask.length).toFixed(1)}%), ${packed.length} bytes`);
console.log(`  depots        ${D.pois.map(p => p.kind).join(', ') || '(none in district)'}`);
console.log(`  incident sites ${sites.length} of ${usable.length} buildings reachable by road`);
let mapRoad = 0;
for (const b of mapBits) if (b === 3) mapRoad++;
console.log(`  minimap       ${MAP_PX}x${MAP_PX} at ${(2 * H / MAP_PX).toFixed(1)} m a pixel, ${(100 * mapRoad / mapBits.length).toFixed(1)}% road, ${(mapPacked.length / 1024).toFixed(0)} kB`);
