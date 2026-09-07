/* STAGE 3 — greedy meshing: 190,000 cubes into something buildable.
 *
 * In:  build/voxels.json
 * Out: build/chunks.json
 *
 * This is the stage the whole plan's part budget rests on. A voxel city built
 * one Part per voxel is not shippable on Roblox at any district size worth
 * having; merged into rectangular boxes it is ordinary.
 *
 * THE ALGORITHM. For each voxel not yet consumed, grow a box greedily:
 * as far as it will go in +X, then extend that run in +Z while every cell of
 * the new row matches, then extend the resulting rectangle in +Y while every
 * cell of the new layer matches. Mark the box consumed, emit it, move on.
 *
 * Greedy is not optimal — finding the minimum box decomposition of a 3D region
 * is NP-hard — but it is within a few per cent of optimal on architecture,
 * which is overwhelmingly axis-aligned slabs, and it runs in a second. The
 * order matters slightly and X-then-Z-then-Y is chosen so that long horizontal
 * wall courses merge first; walls are what there is most of.
 *
 * MESHED PER CHUNK, and boxes never cross a chunk boundary. That costs a few
 * per cent in merge length at the seams and buys the thing the client actually
 * needs: a chunk can be built and destroyed on its own, which is what makes
 * streaming and LOD possible at all. A city meshed as one region would have to
 * be loaded as one region.
 *
 * Usage: node tools/roblox/3-mesh.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { gameSrc } from './gamesrc.mjs';

const G = gameSrc();
const V = CONFIG.voxel;
const CH = CONFIG.chunkVox;
const src = JSON.parse(readFileSync(`${CONFIG.out}/voxels.json`, 'utf8'));
const [I0, I1] = src.meta.cellRange;
const SPAN = src.meta.span;

/* ---------------- the palette ----------------

   Stage 2 built one from the building colours, which DO come from the game
   (buildingColours, unchanged). The four ground classes are the exception and
   come from CONFIG.groundCol instead — see the note there for why the 2D
   renderer's ground palette is exactly wrong at eye level. */
const palette = src.palette.slice();
const addCol = (hex) => {
  const c = G.parseColour(hex) || [128, 128, 128];
  const rgb = c.map(v => Math.round(v));
  const k = rgb.join(',');
  for (let i = 0; i < palette.length; i++) if (palette[i].join(',') === k) return i;
  palette.push(rgb);
  return palette.length - 1;
};
const GROUND_COL = [
  addCol(CONFIG.groundCol.plain),   // 0
  addCol(CONFIG.groundCol.park),    // 1
  addCol(CONFIG.groundCol.kerb),    // 2
  addCol(CONFIG.groundCol.road)     // 3
];

/* ---------------- the voxel field ----------------

   One flat Map from a packed integer key to a palette index. Packing the three
   lattice coordinates into one number rather than a string key is worth it
   here: this map is probed several million times by the growth loops below,
   and string concatenation on every probe was most of the runtime in the first
   version of this file.

   The offsets keep every component non-negative so the packing is monotonic and
   cannot collide. Y is biased by 1 to make room for the ground layer at -1. */
const OFF = -I0, YOFF = 1, YMAX = 4096;
const pack = (x, y, z) => ((x + OFF) * YMAX + (y + YOFF)) * (SPAN + 2) + (z + OFF);

const field = new Map();
const B = src.building;
for (let i = 0; i < B.x.length; i++) field.set(pack(B.x[i], B.y[i], B.z[i]), B.c[i]);
for (let j = 0; j < SPAN; j++)
  for (let i = 0; i < SPAN; i++)
    field.set(pack(I0 + i, -1, I0 + j), GROUND_COL[src.ground[j * SPAN + i]]);

const used = new Set();

/* Which chunk a lattice cell belongs to. */
const chOf = i => Math.floor((i - I0) / CH);
const CHUNKS = Math.ceil(SPAN / CH);

/* ---------------- the mesher ----------------

   Voxels are indexed by chunk in ONE pass, rather than each chunk scanning the
   whole field for its own members. With a hundred chunks and a quarter of a
   million voxels that is the difference between a second and most of a minute,
   and the bake is meant to be cheap enough to re-run on every tweak. */
const byChunk = new Map();
const chunkKey = (cx, cz) => cx + ',' + cz;
const noteCell = (x, y, z) => {
  const k = chunkKey(chOf(x), chOf(z));
  let a = byChunk.get(k);
  if (!a) byChunk.set(k, a = []);
  a.push([x, y, z]);
};
for (let i = 0; i < B.x.length; i++) noteCell(B.x[i], B.y[i], B.z[i]);
for (let j = 0; j < SPAN; j++)
  for (let i = 0; i < SPAN; i++) noteCell(I0 + i, -1, I0 + j);

/* Grow one box from a seed. Bounded by the chunk so no box crosses a seam. */
function grow(sx, sy, sz, col, bx0, bz0, bx1, bz1) {
  const ok = (x, y, z) => !used.has(pack(x, y, z)) && field.get(pack(x, y, z)) === col;

  let ex = sx;                                        // +X
  while (ex + 1 <= bx1 && ok(ex + 1, sy, sz)) ex++;

  let ez = sz;                                        // +Z, whole rows only
  outerZ: while (ez + 1 <= bz1) {
    for (let x = sx; x <= ex; x++) if (!ok(x, sy, ez + 1)) break outerZ;
    ez++;
  }

  let ey = sy;                                        // +Y, whole layers only
  outerY: while (true) {
    for (let z = sz; z <= ez; z++)
      for (let x = sx; x <= ex; x++) if (!ok(x, ey + 1, z)) break outerY;
    ey++;
  }

  for (let y = sy; y <= ey; y++)
    for (let z = sz; z <= ez; z++)
      for (let x = sx; x <= ex; x++) used.add(pack(x, y, z));

  return [sx, sy, sz, ex - sx + 1, ey - sy + 1, ez - sz + 1, col];
}

const chunks = [];
let boxes = 0, voxels = 0;

for (let cz = 0; cz < CHUNKS; cz++) {
  for (let cx = 0; cx < CHUNKS; cx++) {
    const list = byChunk.get(chunkKey(cx, cz));
    if (!list || !list.length) continue;

    const bx0 = I0 + cx * CH, bz0 = I0 + cz * CH;
    const bx1 = Math.min(I1, bx0 + CH - 1), bz1 = Math.min(I1, bz0 + CH - 1);

    // low corner first, Y outermost: long wall courses merge before short ones
    list.sort((a, b) => (a[1] - b[1]) || (a[2] - b[2]) || (a[0] - b[0]));

    const out = [];
    for (const [x, y, z] of list) {
      const p = pack(x, y, z);
      if (used.has(p)) continue;
      out.push(grow(x, y, z, field.get(p), bx0, bz0, bx1, bz1));
    }
    voxels += list.length;
    boxes += out.length;
    chunks.push({ cx, cz, boxes: out });
  }
}

writeFileSync(`${CONFIG.out}/chunks.json`, JSON.stringify({
  meta: { voxel: V, chunkVox: CH, cellRange: [I0, I1], chunks: CHUNKS,
          note: 'boxes are [x, y, z, sx, sy, sz, colourIndex] in lattice cells' },
  palette, chunks
}));

const per = chunks.map(c => c.boxes.length).sort((a, b) => a - b);
console.log(`mesh: ${CHUNKS} x ${CHUNKS} chunks of ${CH} cells (${CH * V} m)`);
console.log(`  voxels in    ${voxels}`);
console.log(`  boxes out    ${boxes}`);
console.log(`  reduction    ${(voxels / boxes).toFixed(1)}x`);
console.log(`  per chunk    median ${per[per.length >> 1]}, p90 ${per[Math.floor(per.length * .9)]}, max ${per[per.length - 1]}`);
console.log(`  palette      ${palette.length} colours`);
if (CONFIG.shades > 1)
  console.log(`  NOTE shades=${CONFIG.shades} is set; compare this against a shades=1 bake`);
