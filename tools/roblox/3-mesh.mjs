/* STAGE 3 — merging cells into as few parts as the lattice allows.
 *
 * In:  build/voxels.json
 * Out: build/chunks.json
 *
 * This is the stage the part budget rests on, and WHAT IT CAN DO DEPENDS ON THE
 * LATTICE — which is the whole cost of choosing hexagons, measured rather than
 * asserted.
 *
 * SQUARE: full 3D greedy meshing. For each cell not yet consumed, grow as far
 * as it goes in +A, extend that run in +B while every cell of the new row
 * matches, then extend the resulting rectangle upwards while every cell of the
 * new layer matches. Architecture is overwhelmingly axis-aligned slabs, so this
 * lands within a few per cent of optimal and measured 10.4x on this district.
 *
 * HEX: vertical only. Hexagons tile neither into larger hexagons nor into
 * boxes, so there is no sideways merge to make — a column of one colour becomes
 * one taller prism and that is all. Measured 2.8x on buildings and exactly 1.0x
 * on the ground, which is a single layer and cannot merge at all.
 *
 * That asymmetry is not a bug to fix. It is the reason a hex lattice has to be
 * coarser than a square one to cost the same, and the numbers this stage prints
 * are how that trade gets made honestly.
 *
 * MESHED PER CHUNK, and no part crosses a chunk boundary. That costs a few per
 * cent in merge length at the seams and buys the thing the client needs: a
 * chunk can be built and destroyed on its own.
 *
 * Usage: node tools/roblox/3-mesh.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { makeLattice } from './lattice.mjs';
import { gameSrc } from './gamesrc.mjs';

const G = gameSrc();
const L = makeLattice(CONFIG);
const src = JSON.parse(readFileSync(`${CONFIG.out}/voxels.json`, 'utf8'));
const LV = src.meta.levelM;
const HEX = L.kind === 'hex';

/* ---------------- the palette ----------------
   Stage 2 built one from the building colours, which come from the game's own
   buildingColours unchanged. The four ground classes are the exception and come
   from CONFIG.groundCol — see the note there for why the 2D renderer's ground
   palette is exactly wrong at eye level. */
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
  addCol(CONFIG.groundCol.plain),
  addCol(CONFIG.groundCol.park),
  addCol(CONFIG.groundCol.kerb),
  addCol(CONFIG.groundCol.road)
];

/* ---------------- the field ----------------
   One Map from "a,level,b" to a palette index, covering buildings and the
   ground layer at level -1. */
const field = new Map();
const key = (a, l, b) => a + ',' + l + ',' + b;

const B = src.building;
for (let i = 0; i < B.a.length; i++) field.set(key(B.a[i], B.l[i], B.b[i]), B.c[i]);
const Gd = src.ground;
for (let i = 0; i < Gd.a.length; i++) field.set(key(Gd.a[i], -1, Gd.b[i]), GROUND_COL[Gd.v[i]]);

const used = new Set();

/* Which chunk a cell belongs to, decided by its WORLD POSITION rather than by
   its lattice index — a hex lattice's indices are skewed, so chunking on them
   directly would give rhombus chunks that do not line up with anything the
   client can reason about in studs. */
const CH = CONFIG.chunkM;
const chunkOf = (a, b) => {
  const [x, y] = L.centre(a, b);
  return [Math.floor(x / CH), Math.floor(y / CH)];
};

const byChunk = new Map();
const ck = (cx, cz) => cx + ',' + cz;
function note(a, l, b) {
  const [cx, cz] = chunkOf(a, b);
  const k = ck(cx, cz);
  let arr = byChunk.get(k);
  if (!arr) byChunk.set(k, arr = []);
  arr.push([a, l, b]);
}
for (let i = 0; i < B.a.length; i++) note(B.a[i], B.l[i], B.b[i]);
for (let i = 0; i < Gd.a.length; i++) note(Gd.a[i], -1, Gd.b[i]);

/* ---------------- growth ---------------- */

const ok = (a, l, b, col) => !used.has(key(a, l, b)) && field.get(key(a, l, b)) === col;

/* HEX: a column, and nothing else. */
function growColumn(a, l, b, col) {
  let top = l;
  while (ok(a, top + 1, b, col)) top++;
  for (let y = l; y <= top; y++) used.add(key(a, y, b));
  return [a, l, b, 1, top - l + 1, 1, col];
}

/* SQUARE: the full 3D box. Bounded by the chunk so no part crosses a seam. */
function growBox(a0, l0, b0, col, inChunk) {
  let ea = a0;
  while (inChunk(ea + 1, b0) && ok(ea + 1, l0, b0, col)) ea++;

  let eb = b0;
  outerB: while (true) {
    if (!inChunk(a0, eb + 1)) break;
    for (let a = a0; a <= ea; a++) if (!ok(a, l0, eb + 1, col)) break outerB;
    eb++;
  }

  let el = l0;
  outerL: while (true) {
    for (let b = b0; b <= eb; b++)
      for (let a = a0; a <= ea; a++) if (!ok(a, el + 1, b, col)) break outerL;
    el++;
  }

  for (let l = l0; l <= el; l++)
    for (let b = b0; b <= eb; b++)
      for (let a = a0; a <= ea; a++) used.add(key(a, l, b));

  return [a0, l0, b0, ea - a0 + 1, el - l0 + 1, eb - b0 + 1, col];
}

/* ---------------- the pass ---------------- */

const chunks = [];
let parts = 0, cells = 0;

for (const [k, list] of [...byChunk.entries()].sort()) {
  const [cx, cz] = k.split(',').map(Number);
  const inChunk = (a, b) => {
    const [qx, qz] = chunkOf(a, b);
    return qx === cx && qz === cz;
  };

  // low level first, so long horizontal courses merge before short ones
  list.sort((p, q) => (p[1] - q[1]) || (p[2] - q[2]) || (p[0] - q[0]));

  const out = [];
  for (const [a, l, b] of list) {
    if (used.has(key(a, l, b))) continue;
    const col = field.get(key(a, l, b));
    out.push(HEX ? growColumn(a, l, b, col) : growBox(a, l, b, col, inChunk));
  }
  cells += list.length;
  parts += out.length;
  chunks.push({ cx, cz, boxes: out });
}

writeFileSync(`${CONFIG.out}/chunks.json`, JSON.stringify({
  meta: { lattice: L.kind, size: L.size, levelM: LV, chunkM: CH,
          note: HEX
            ? 'prisms are [a, level, b, 1, levels, 1, colourIndex]; a/b are axial hex coords'
            : 'boxes are [a, level, b, sa, levels, sb, colourIndex] in lattice cells' },
  palette, chunks
}));

const per = chunks.map(c => c.boxes.length).sort((a, b) => a - b);
console.log(`mesh: ${L.kind}, ${chunks.length} chunks of ${CH} m`);
console.log(`  cells in     ${cells}`);
console.log(`  parts out    ${parts}`);
console.log(`  reduction    ${(cells / parts).toFixed(1)}x   ${HEX ? '(vertical only — hexes do not tile sideways)' : '(full 3D)'}`);
console.log(`  per chunk    median ${per[per.length >> 1]}, p90 ${per[Math.floor(per.length * .9)]}, max ${per[per.length - 1]}`);
console.log(`  palette      ${palette.length} colours`);
