"use strict";
/* VICE MAPS — The same city, from behind the car.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes last of the
   renderers, because it owns render() and toScreen() and dispatches to the 2D
   pair by name.

   BOTH VIEWS SHIP. This does not replace render.js; the button in the corner
   picks one. That decision costs a dispatcher and buys three things worth more
   than it: the top-down game keeps working exactly as it did on machines with no
   WebGL2, every 2D test in the suite stays meaningful, and a bug can be bisected
   by pressing a button rather than by checking out a different branch.

   WHAT IS SHARED AND WHAT IS NOT. The world, the physics, the missions, the
   police, the streaming, the radar, the big map and the whole HUD are shared and
   untouched — the radar is a separate canvas and the HUD is DOM. What is new is
   this file, gl.js under it, and the two files that give the car a third
   dimension to be in. The objective arrow is shared too, which is why toScreen()
   has to mean something here: it is projected through the 3D camera and drawn on
   the 2D canvas, which sits over the WebGL one as a transparent overlay.

   HOW THE GEOMETRY IS BATCHED. Per 512 m cell, built once, kept on the GPU, and
   culled as a unit against the frustum. That matches how the world arrives —
   tiles stream in and get recycled — and it means nothing is rebuilt per frame
   except the things that actually move. A cell is built on the frame it is first
   needed, one per frame, so driving into a new district costs a few frames of
   empty ground at the horizon rather than a stall. */

let MODE3D = false;

/* How far the world is drawn, in metres. Fog closes over the last third of it,
   so cells stop existing behind a wall of sky rather than popping out of a clear
   view. */
const VIEW3 = 760;
const FOG0 = 300;
const CELL3 = 512;
const CELL_CAP = 44;                 // cells kept on the GPU before the far ones go
const GND_DIV = 16;                  // ground tessellation per cell: 32 m a quad
const SEG_MAX = 24;                  // road segments longer than this are split to follow hills

/* Palette slots for the ground pass. Their COLOURS live in a uniform array, not
   in the vertex buffer, so pressing N to swap dusk for daylight changes six
   vec3s and redraws — it does not rebuild a single triangle. That is the same
   promise resolveColours() makes in the 2D game, kept the same way. */
const PAL_GROUND = 0, PAL_PARK = 1, PAL_KERB = 2, PAL_ROAD = 3, PAL_BIG = 4, PAL_LINE = 5;

/* Two looks, as the 2D themes are two looks. Sky and light are 3D-only concerns
   — the top-down view has no horizon and fakes its lighting by multiplying wall
   colours — so they live here rather than in THEMES. */
const SKY = {
  dusk: { sky: [.09, .05, .16], amb: [.20, .17, .31], lc: [.42, .32, .47],
          ld: [-.46, .60, -.34] },
  day:  { sky: [.62, .70, .80], amb: [.42, .44, .49], lc: [.80, .77, .70],
          ld: [-.34, .86, -.38] }
};

/* CSS colour to a 0..1 triple. The palette is written as strings because the 2D
   canvas takes strings; this is the one place that has to care. */
function col3(s) {
  const c = parseColour(s);
  if (c) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const m = /rgba?\(([^)]+)\)/.exec(String(s));
  if (!m) return [1, 0, 1];                       // magenta: a missing colour should be loud
  const p = m[1].split(',').map(parseFloat);
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
}
function colA(s) {
  const m = /rgba\(([^)]+)\)/.exec(String(s));
  return m ? (parseFloat(m[1].split(',')[3]) || 1) : 1;
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------ shaders ------------------------------ */
const VS_COMMON = `#version 300 es
in vec3 aPos; in vec3 aNrm;
uniform mat4 uVP;
out vec3 vN; out float vD;
`;
const FS_HEAD = `#version 300 es
precision mediump float;
in vec3 vN; in float vD;
uniform vec3 uLdir, uLcol, uAmb, uFog;
uniform vec2 uFogR;
out vec4 outC;
vec3 light(vec3 base, vec3 n) {
  vec3 nn = normalize(n);
  float d = max(dot(nn, uLdir), 0.0);
  /* A little extra from straight up. Without it every wall facing away from the
     sun is flat ambient and a street of them reads as a row of black slabs —
     the sky is a light source too, and roofs and road catch more of it. */
  float s = max(nn.y, 0.0) * 0.30;
  return base * (uAmb * (1.0 + s) + uLcol * d);
}
vec4 fogged(vec3 c) {
  float f = clamp((vD - uFogR.x) / (uFogR.y - uFogR.x), 0.0, 1.0);
  return vec4(mix(c, uFog, f), 1.0);
}
`;

const SH_LIT_V = VS_COMMON + `in vec3 aCol;
out vec3 vC;
void main() { vec4 p = uVP * vec4(aPos, 1.0); gl_Position = p; vN = aNrm; vC = aCol; vD = p.w; }`;
const SH_LIT_F = FS_HEAD + `in vec3 vC;
void main() { outC = fogged(light(vC, vN)); }`;

const SH_GND_V = VS_COMMON + `in float aPal;
flat out int vP;
void main() { vec4 p = uVP * vec4(aPos, 1.0); gl_Position = p; vN = aNrm; vP = int(aPal); vD = p.w; }`;
const SH_GND_F = FS_HEAD + `flat in int vP;
uniform vec3 uPal[8];
void main() { outC = fogged(light(uPal[vP], vN)); }`;

/* Particles, tyre marks, explosions: no lighting, straight colour and alpha. */
const SH_FX_V = `#version 300 es
in vec3 aPos; in vec4 aCol;
uniform mat4 uVP;
out vec4 vC;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vC = aCol; }`;
const SH_FX_F = `#version 300 es
precision mediump float;
in vec4 vC;
out vec4 outC;
void main() { outC = vC; }`;

/* ------------------------------ state ------------------------------ */
const G3 = {
  ready: false,
  lit: null, gnd: null, fx: null,          // programs
  cells: new Map(),                        // key -> built cell
  idx: new Map(),                          // key -> buildings whose centroid is in it
  seen: 0,                                 // how much of W.buildings is indexed
  roadN: -1, parkN: -1,                    // world-shape signature, for invalidation
  VP: M4.make(), V: M4.make(), Pm: M4.make(),
  planes: [],
  cars: null, peds: null, fxm: null,       // per-frame streams
  cam: { h: 0, d: 15, y: 7, t: 0 },
  built: 0, drawn: 0, tris: 0
};

const cellKey = (kx, kz) => kx + ',' + kz;
const cellOf = v => Math.floor(v / CELL3);

function initGL3() {
  if (G3.ready) return true;
  const gl = GL.gl;
  if (!gl) return false;
  G3.lit = GL.program(SH_LIT_V, SH_LIT_F);
  G3.gnd = GL.program(SH_GND_V, SH_GND_F);
  G3.fx = GL.program(SH_FX_V, SH_FX_F);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  G3.ready = true;
  return true;
}

/* A lost context takes every buffer and program with it. Drop the lot and let
   the next frame notice G3.ready is false and build it again. */
function glContextLost() {
  G3.ready = false;
  G3.cells.clear();
  G3.cars = G3.peds = G3.fxm = null;
  GL.gl = null;
}

/* ------------------------------ the index ------------------------------ */
/* Buildings, filed by the cell their centroid falls in. Appended to as tiles
   stream in; thrown away and rebuilt whole when the world SHRINKS, because
   evictFarTiles filters W.buildings and there is no way to tell from the outside
   which ones went. That happens every few hundred metres at most, and rebuilding
   an index over a few thousand centroids is well under a millisecond — the
   expensive part is the GPU geometry, and only the cells that are actually still
   on screen get rebuilt, one per frame. */
function syncIndex3() {
  if (W.buildings.length < G3.seen) {
    G3.idx.clear();
    dropAllCells();
    G3.seen = 0;
  }
  for (let i = G3.seen; i < W.buildings.length; i++) {
    const b = W.buildings[i];
    const k = cellKey(cellOf(b.cx), cellOf(b.cy));
    const a = G3.idx.get(k);
    if (a) a.push(b); else G3.idx.set(k, [b]);
    // whatever was already built for that cell is now missing a building
    const c = G3.cells.get(k);
    if (c) { freeCell(c); G3.cells.delete(k); }
  }
  G3.seen = W.buildings.length;

  /* Roads and parks have no per-cell index — they are walked from the spatial
     hash at build time — so a change in either invalidates everything. Roads
     only ever grow once a skeleton is up, so in practice this fires while a
     district streams in and then never again. */
  if (W.roads.length !== G3.roadN || W.parks.length !== G3.parkN) {
    G3.roadN = W.roads.length; G3.parkN = W.parks.length;
    dropAllCells();
  }
}
function freeCell(c) { GL.free(c.gnd); GL.free(c.lit); }
function dropAllCells() {
  for (const c of G3.cells.values()) freeCell(c);
  G3.cells.clear();
}

/* ------------------------------ cell geometry ------------------------------ */
/* A quad from four corners, with one normal, into a ground buffer. */
function gquad(o, ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, pal) {
  o.push(ax, ay, az, nx, ny, nz, pal, bx, by, bz, nx, ny, nz, pal, cx2, cy2, cz2, nx, ny, nz, pal);
  o.push(ax, ay, az, nx, ny, nz, pal, cx2, cy2, cz2, nx, ny, nz, pal, dx, dy, dz, nx, ny, nz, pal);
}

/* A polyline drawn as a flat ribbon lying on the ground.

   Long segments are cut down to SEG_MAX so the ribbon follows the hills instead
   of tunnelling through them — a 200 m straight drawn as one quad is a straight
   line in space, and the hill it crosses comes straight through the middle of
   the road. And each interior joint gets a patch across it, because 3D has no
   equivalent of the round line joins the 2D renderer leans on: without it every
   bend in every street has a notch bitten out of the outside of it. */
function ribbon(o, pts, w, pal, lift, x0, z0, x1, z1) {
  const hw = w * .5;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, az = pts[i - 1].y, bx = pts[i].x, bz = pts[i].y;
    // only the segments belonging to this cell, decided by midpoint so that a
    // road crossing four cells is drawn once in each and never twice in either
    const mx = (ax + bx) * .5, mz = (az + bz) * .5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-4) continue;
    const ux = dx / L, uz = dz / L;
    const px = -uz * hw, pz = ux * hw;
    const steps = Math.max(1, Math.ceil(L / SEG_MAX));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const sx = ax + dx * t0, sz = az + dz * t0;
      const ex = ax + dx * t1, ez = az + dz * t1;
      const y0 = terrainH(sx - px, sz - pz) + lift, y1 = terrainH(sx + px, sz + pz) + lift;
      const y2 = terrainH(ex + px, ez + pz) + lift, y3 = terrainH(ex - px, ez - pz) + lift;
      gquad(o, sx - px, y0, sz - pz, sx + px, y1, sz + pz,
               ex + px, y2, ez + pz, ex - px, y3, ez - pz, 0, 1, 0, pal);
    }
    // the patch over the joint into the next segment
    if (i < pts.length - 1) {
      const nx2 = pts[i + 1].x - bx, nz2 = pts[i + 1].y - bz;
      const nl = Math.hypot(nx2, nz2);
      if (nl > 1e-4) {
        let jx = ux + nx2 / nl, jz = uz + nz2 / nl;
        const jl = Math.hypot(jx, jz) || 1;
        jx /= jl; jz /= jl;
        const qx = -jz * hw, qz = jx * hw, rx = jx * hw, rz = jz * hw;
        const y = terrainH(bx, bz) + lift;
        gquad(o, bx - qx - rx, y, bz - qz - rz, bx + qx - rx, y, bz + qz - rz,
                 bx + qx + rx, y, bz + qz + rz, bx - qx + rx, y, bz - qz + rz, 0, 1, 0, pal);
      }
    }
  }
}

/* The dashed centre line, as real dashes. Only on roads wide enough to have one,
   which is the same test the 2D renderer makes. */
function dashes(o, pts, lift, x0, z0, x1, z1) {
  const ON = 3.2, OFF = 5.4, HW = .35;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, az = pts[i - 1].y, bx = pts[i].x, bz = pts[i].y;
    const mx = (ax + bx) * .5, mz = (az + bz) * .5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < ON) continue;
    const ux = dx / L, uz = dz / L, px = -uz * HW, pz = ux * HW;
    for (let d = 0; d + ON < L; d += ON + OFF) {
      const sx = ax + ux * d, sz = az + uz * d;
      const ex = ax + ux * (d + ON), ez = az + uz * (d + ON);
      const y = terrainH((sx + ex) * .5, (sz + ez) * .5) + lift;
      gquad(o, sx - px, y, sz - pz, sx + px, y, sz + pz,
               ex + px, y, ez + pz, ex - px, y, ez - pz, 0, 1, 0, PAL_LINE);
    }
  }
}

/* Everything in one 512 m square, turned into two GPU meshes. */
function buildCell(kx, kz) {
  const x0 = kx * CELL3, z0 = kz * CELL3, x1 = x0 + CELL3, z1 = z0 + CELL3;
  const gnd = [], lit = [];
  let ymin = Infinity, ymax = -Infinity;
  const note = y => { if (y < ymin) ymin = y; if (y > ymax) ymax = y; };

  /* THE GROUND, tessellated so it has the shape the physics thinks it has. A
     flat quad here and a car climbing a hill is a car climbing nothing. */
  const st = CELL3 / GND_DIV;
  const hs = [], ns = [];
  for (let i = 0; i <= GND_DIV; i++) for (let j = 0; j <= GND_DIV; j++) {
    const x = x0 + i * st, z = z0 + j * st;
    const g = terrainGrad(x, z);
    hs[i * (GND_DIV + 1) + j] = g.h;
    // the surface normal of a heightfield is (-dh/dx, 1, -dh/dz), normalised
    const l = Math.hypot(g.gx, 1, g.gy) || 1;
    ns[i * (GND_DIV + 1) + j] = [-g.gx / l, 1 / l, -g.gy / l];
    note(g.h);
  }
  const at = (i, j) => i * (GND_DIV + 1) + j;
  for (let i = 0; i < GND_DIV; i++) for (let j = 0; j < GND_DIV; j++) {
    const xa = x0 + i * st, xb = xa + st, za = z0 + j * st, zb = za + st;
    const p = [[xa, hs[at(i, j)], za, ns[at(i, j)]], [xb, hs[at(i + 1, j)], za, ns[at(i + 1, j)]],
               [xb, hs[at(i + 1, j + 1)], zb, ns[at(i + 1, j + 1)]], [xa, hs[at(i, j + 1)], zb, ns[at(i, j + 1)]]];
    for (const t of [[0, 1, 2], [0, 2, 3]])
      for (const v of t) {
        const q = p[v];
        gnd.push(q[0], q[1], q[2], q[3][0], q[3][1], q[3][2], PAL_GROUND);
      }
  }

  /* Parks, roads and their markings, stacked in a few centimetres above the
     ground in the order the 2D renderer paints them. The offsets are what keeps
     them apart in the depth buffer — at 300 m a 24-bit depth buffer resolves
     about half a centimetre, so six is comfortable and none of it is visible. */
  for (const f of W.parks) {
    if (f.bb.x1 < x0 || f.bb.x0 >= x1 || f.bb.y1 < z0 || f.bb.y0 >= z1) continue;
    const c = centroid(f.pts);
    if (c.x < x0 || c.x >= x1 || c.y < z0 || c.y >= z1) continue;   // once, in its own cell
    const tri = earClip(f.pts);
    for (let i = 0; i < tri.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const p = f.pts[tri[i + k]];
        gnd.push(p.x, terrainH(p.x, p.y) + .06, p.y, 0, 1, 0, PAL_PARK);
      }
    }
  }

  const pad = 24;
  const rs = roadsIn(x0 - pad, z0 - pad, x1 + pad, z1 + pad);
  for (const r of rs) ribbon(gnd, r.pts, r.w + 2.4, PAL_KERB, .12, x0, z0, x1, z1);
  for (const r of rs) ribbon(gnd, r.pts, r.w, r.w >= 11 ? PAL_BIG : PAL_ROAD, .18, x0, z0, x1, z1);
  for (const r of rs) if (r.w >= 9) dashes(gnd, r.pts, .24, x0, z0, x1, z1);

  /* THE BUILDINGS. Walls with a real outward normal — which is what replaces the
     2D renderer's trick of multiplying every wall colour by 0.17 to imply a
     light direction. Here the normal does it, so the material colour goes into
     the buffer untinted and a theme change never touches this geometry.

     The base is dropped to the lowest corner of the footprint and then a metre
     further, so a block on a slope is buried into the hill rather than standing
     on one leg with daylight under the other three. */
  const bs = G3.idx.get(cellKey(kx, kz));
  if (bs) for (const b of bs) {
    const n = b.pts.length;
    let base = Infinity;
    for (let i = 0; i < n; i++) { const h = terrainH(b.pts[i].x, b.pts[i].y); if (h < base) base = h; }
    base -= 1;
    const top = terrainH(b.cx, b.cy) + b.h;
    note(base); note(top);
    const wall = b.mWall, roof = b.mRoof;
    const wr = wall[0] / 255, wg = wall[1] / 255, wb = wall[2] / 255;
    const wind = windingOf(b.pts);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = b.pts[j].x, az = b.pts[j].y, bx = b.pts[i].x, bz = b.pts[i].y;
      const ex = bx - ax, ez = bz - az;
      const L = Math.hypot(ex, ez);
      if (L < 1e-4) continue;
      const nx = wind * ez / L, nz = -wind * ex / L;      // outward, in the ground plane
      lit.push(ax, base, az, nx, 0, nz, wr, wg, wb,
               bx, base, bz, nx, 0, nz, wr, wg, wb,
               bx, top, bz, nx, 0, nz, wr, wg, wb);
      lit.push(ax, base, az, nx, 0, nz, wr, wg, wb,
               bx, top, bz, nx, 0, nz, wr, wg, wb,
               ax, top, az, nx, 0, nz, wr, wg, wb);
    }
    // the roof, which is the one part that genuinely needs a triangulator
    const tri = earClip(b.pts);
    const rr = roof[0] / 255, rg = roof[1] / 255, rb = roof[2] / 255;
    for (let i = 0; i < tri.length; i += 3) {
      const p0 = b.pts[tri[i]], p1 = b.pts[tri[i + 1]], p2 = b.pts[tri[i + 2]];
      // earClip hands back a consistent winding; which way that faces in 3D
      // depends on the footprint, so pick the order that points the roof up
      const cx = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      const q = cx > 0 ? [p0, p2, p1] : [p0, p1, p2];
      for (const p of q) lit.push(p.x, top, p.y, 0, 1, 0, rr, rg, rb);
    }
  }

  if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
  return {
    kx, kz, x0, z0, x1, z1, y0: ymin - 2, y1: ymax + 2,
    gnd: GL.mesh(new Float32Array(gnd), [[G3.gnd.a.aPos, 3], [G3.gnd.a.aNrm, 3], [G3.gnd.a.aPal, 1]]),
    lit: GL.mesh(new Float32Array(lit), [[G3.lit.a.aPos, 3], [G3.lit.a.aNrm, 3], [G3.lit.a.aCol, 3]])
  };
}

/* ------------------------------ dynamic bits ------------------------------ */
/* A cuboid, from the eight corners body3d.js works out, into the lit stream.
   Twelve triangles with a real face normal each, which is what makes a rolled
   car read as rolled rather than as a rectangle at a funny angle. */
const BOX_FACES = [
  [0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [6, 7, 3, 2], [5, 6, 2, 1], [7, 4, 0, 3]
];
function pushBox(o, p, r, g, b) {
  for (const f of BOX_FACES) {
    const ax = p[f[0] * 3], ay = p[f[0] * 3 + 1], az = p[f[0] * 3 + 2];
    const bx = p[f[1] * 3], by = p[f[1] * 3 + 1], bz = p[f[1] * 3 + 2];
    const cx = p[f[2] * 3], cy = p[f[2] * 3 + 1], cz = p[f[2] * 3 + 2];
    const dx = p[f[3] * 3], dy = p[f[3] * 3 + 1], dz = p[f[3] * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    o.push(ax, ay, az, nx, ny, nz, r, g, b, bx, by, bz, nx, ny, nz, r, g, b, cx, cy, cz, nx, ny, nz, r, g, b);
    o.push(ax, ay, az, nx, ny, nz, r, g, b, cx, cy, cz, nx, ny, nz, r, g, b, dx, dy, dz, nx, ny, nz, r, g, b);
  }
}

// a scaled copy of the body box, for the cabin sitting on the roof
const BOXTMP = [], BOXTMP2 = [];
function shrinkBox(src, out, kf, kl, lift) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < 8; i++) { cx += src[i * 3]; cy += src[i * 3 + 1]; cz += src[i * 3 + 2]; }
  cx /= 8; cy /= 8; cz /= 8;
  for (let i = 0; i < 8; i++) {
    // the top four go up, the bottom four sit on the roofline of the body
    const up = i >= 4 ? 1 : 0;
    out[i * 3]     = cx + (src[i * 3] - cx) * kf;
    out[i * 3 + 1] = cy + (src[i * 3 + 1] - cy) * (up ? kl + lift : kl);
    out[i * 3 + 2] = cz + (src[i * 3 + 2] - cz) * kf;
  }
  return out;
}

function carColour(c) {
  const q = parseColour(c.color) || [255, 80, 200];
  return [q[0] / 255, q[1] / 255, q[2] / 255];
}

/* ------------------------------ the camera ------------------------------ */
/* Behind and above, looking at a point in front. It reuses the camera the 2D
   game already smooths — cam.x/cam.y lead the car and settle at a rate that was
   tuned against how the car actually drives — and only turns that into an eye
   and a target. The one thing added is a heading of its own, lagged, so a
   handbrake turn swings the world round rather than snapping it. */
function camera3D(dt) {
  const c = P.car;
  const spd = Math.hypot(c.vx, c.vy);
  const k = clamp(spd / TOP_SPEED, 0, 1);
  const C = G3.cam;
  /* In a drift the car points somewhere other than where it is going, and a
     camera locked to the nose spends the whole slide staring at a kerb. It
     follows the heading, but slowly, and slower still the faster you go. */
  C.h += angDiff(C.h, c.h) * decay(lerp(5.5, 2.6, k), dt);
  C.d += (lerp(13.5, 25, k) * lerp(1.22, 1, zoomK) - C.d) * decay(2.2, dt);
  C.y += (lerp(6.2, 9.4, k) - C.y) * decay(2.2, dt);

  const cz = c.z || 0;
  /* The TARGET is the 2D camera's point, which already leads the car and eases
     the way the driving was tuned against. The EYE hangs off the car itself, and
     that distinction is the whole framing: cam.x/cam.y run up to 26 metres ahead
     at speed, so an eye placed relative to THEM ends up on the bonnet at exactly
     the moment you most want to see where you are going. */
  const tx = cam.x, tz = cam.y;
  const ty = cz + 1.9;
  let ex = c.x - Math.cos(C.h) * C.d, ez = c.y - Math.sin(C.h) * C.d;
  /* The eye may never go under the hill behind you. On a climb the ground
     immediately behind the car is higher than the car, and an eye placed at a
     fixed height above the CAR ends up inside it — which draws the inside of a
     hillside across the whole screen. */
  let ey = Math.max(cz + C.y, terrainH(ex, ez) + 3.2);
  if (cam.shake > 0) {
    const s = cam.shake * .9;
    ex += rand(-1, 1) * s; ey += rand(-1, 1) * s; ez += rand(-1, 1) * s;
  }
  C.ex = ex; C.ey = ey; C.ez = ez;
  M4.lookAt(G3.V, ex, ey, ez, tx, ty, tz, 0, 1, 0);
  M4.perspective(G3.Pm, 1.02, Math.max(VW, 1) / Math.max(VH, 1), 1.0, VIEW3 + CELL3);
  M4.mul(G3.VP, G3.Pm, G3.V);
  frustumOf(G3.VP, G3.planes);
}

/* Where a world point lands on the screen, for the objective arrow and for
   anything else that has to agree with what is drawn. Same signature and same
   units as the 2D one, and the dispatcher below is what makes them one name.

   The behind-the-camera case matters more here than it ever did in 2D: a
   top-down camera can always see a bearing, and this one cannot see half the
   world. Projecting a point behind the eye through the matrix gives a position
   mirrored through the centre of the screen, which would send the arrow to the
   pickup exactly the wrong way. It is worked out in view space instead, where
   "behind" is simply a positive z. */
function toScreen3D(wx, wy) {
  const y = terrainH(wx, wy) + 1;
  const v = M4.xform(G3.V, wx, y, wy);
  if (v[2] > -1) {
    const m = Math.hypot(v[0], v[1]) || 1;
    // straight out of the frame on the correct bearing, and far enough that the
    // arrow's own edge clamp is what decides where it sits
    return [VW / 2 - v[0] / m * VW, VH / 2 + v[1] / m * VH];
  }
  const p = M4.xform(G3.Pm, v[0], v[1], v[2]);
  const w = p[3] || 1e-6;
  return [(p[0] / w * .5 + .5) * VW, (-p[1] / w * .5 + .5) * VH];
}

/* ------------------------------ the frame ------------------------------ */
let last3 = 0;
function render3D() {
  const gl = GL.gl;
  if (!gl || !initGL3()) { render2D(); return; }
  const c = P.car;

  const now = performance.now();
  const dt = clamp((now - last3) / 1000, 0.001, 0.1);
  last3 = now;

  camera3D(dt);
  syncIndex3();

  /* The radar is shared with the 2D view and rotates with `rot`, so the same
     three numbers have to mean the same thing here. HX/HY are the screen centre
     because nothing in 3D has a projection origin on the canvas. */
  rot = -Math.PI / 2 - G3.cam.h;
  cs = Math.cos(rot); sn = Math.sin(rot);
  HX = VW / 2; HY = VH / 2;

  const th = SKY[themeName] || SKY.dusk;
  const ld = th.ld, ll = Math.hypot(ld[0], ld[1], ld[2]) || 1;

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(th.sky[0], th.sky[1], th.sky[2], 1);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const setCommon = pr => {
    gl.uniformMatrix4fv(pr.u.uVP, false, G3.VP);
    gl.uniform3f(pr.u.uLdir, ld[0] / ll, ld[1] / ll, ld[2] / ll);
    gl.uniform3fv(pr.u.uLcol, th.lc);
    gl.uniform3fv(pr.u.uAmb, th.amb);
    gl.uniform3fv(pr.u.uFog, th.sky);
    gl.uniform2f(pr.u.uFogR, FOG0, VIEW3);
  };

  /* --- the world, one cell at a time --- */
  const kx0 = cellOf(cam.x - VIEW3), kx1 = cellOf(cam.x + VIEW3);
  const kz0 = cellOf(cam.y - VIEW3), kz1 = cellOf(cam.y + VIEW3);
  const want = [];
  for (let i = kx0; i <= kx1; i++) for (let j = kz0; j <= kz1; j++) {
    const dx = Math.max(Math.abs(cam.x - (i + .5) * CELL3) - CELL3 / 2, 0);
    const dz = Math.max(Math.abs(cam.y - (j + .5) * CELL3) - CELL3 / 2, 0);
    const d = Math.hypot(dx, dz);
    if (d > VIEW3) continue;
    want.push({ i, j, d });
  }
  want.sort((a, b) => a.d - b.d);

  /* ONE CELL A FRAME. Building one is an ear-clip over every footprint in a
     quarter of a square kilometre, which is single-digit milliseconds in a dense
     centre — fine once, and a stutter every time you cross a boundary if it were
     done on demand for all of them. Nearest first, so the gap that fills last is
     always at the horizon where the fog is already eating it. The first frame in
     3D is allowed a bigger bite, because the alternative is twenty frames of
     empty ground while the player watches. */
  let budget = G3.cells.size ? 1 : 12;
  G3.drawn = 0; G3.tris = 0;
  const draw = [];
  for (const w of want) {
    const k = cellKey(w.i, w.j);
    let cell = G3.cells.get(k);
    if (!cell) {
      if (budget <= 0) continue;
      budget--;
      cell = buildCell(w.i, w.j);
      G3.cells.set(k, cell);
      G3.built++;
    }
    cell.seen = now;
    if (!boxInFrustum(G3.planes, cell.x0, cell.y0, cell.z0, cell.x1, cell.y1, cell.z1)) continue;
    draw.push(cell);
  }

  gl.useProgram(G3.gnd.p);
  setCommon(G3.gnd);
  const P8 = new Float32Array(24);
  const put = (i, c3) => { P8[i * 3] = c3[0]; P8[i * 3 + 1] = c3[1]; P8[i * 3 + 2] = c3[2]; };
  const roadC = col3(PAL.road);
  put(PAL_GROUND, col3(PAL.ground));
  put(PAL_PARK, col3(PAL.park));
  put(PAL_KERB, col3(PAL.kerb));
  put(PAL_ROAD, roadC);
  put(PAL_BIG, col3(PAL.roadBig));
  // the centre line is drawn opaque, so its alpha is folded into the road under it
  put(PAL_LINE, mix3(roadC, col3(PAL.line), colA(PAL.line)));
  gl.uniform3fv(G3.gnd.u.uPal, P8);
  for (const cell of draw) if (cell.gnd) {
    gl.bindVertexArray(cell.gnd.vao);
    gl.drawArrays(gl.TRIANGLES, 0, cell.gnd.n);
    G3.tris += cell.gnd.n / 3;
  }

  gl.useProgram(G3.lit.p);
  setCommon(G3.lit);
  for (const cell of draw) if (cell.lit) {
    gl.bindVertexArray(cell.lit.vao);
    gl.drawArrays(gl.TRIANGLES, 0, cell.lit.n);
    G3.tris += cell.lit.n / 3;
    G3.drawn++;
  }

  /* --- everything that moves, rebuilt every frame --- */
  const dyn = [];
  const R2 = 420 * 420;
  const near = o => dist2(o.x, o.y, cam.x, cam.y) < R2;
  const addCar = q => {
    if (!near(q)) return;
    const col = carColour(q);
    carBox(q, BOXTMP);
    pushBox(dyn, BOXTMP, col[0], col[1], col[2]);
    // a darker cabin, so the box has a front and a back at a glance
    shrinkBox(BOXTMP, BOXTMP2, .52, .34, .55);
    pushBox(dyn, BOXTMP2, col[0] * .34, col[1] * .38, col[2] * .46);
  };
  for (const t of traffic) addCar(t);
  for (const k of cops) addCar(k);
  if (!P.dead || Math.floor(P.deadT * 8) % 2 === 0) addCar(c);
  for (const p of peds) {
    if (!near(p)) continue;
    const y = terrainH(p.x, p.y);
    const q = parseColour(p.col) || [230, 230, 230];
    const r = .32, h = 1.7;
    const b = [];
    for (const uy of [0, 1]) for (const [a, o2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      b.push(p.x + a * r, y + uy * h, p.y + o2 * r);
    pushBox(dyn, b, q[0] / 255, q[1] / 255, q[2] / 255);
  }
  if (dyn.length) {
    G3.cars = GL.stream(G3.cars, new Float32Array(dyn),
                        [[G3.lit.a.aPos, 3], [G3.lit.a.aNrm, 3], [G3.lit.a.aCol, 3]]);
    gl.bindVertexArray(G3.cars.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.cars.n);
    G3.tris += G3.cars.n / 3;
  }

  /* --- tyre marks, smoke and fire --- */
  const fx = [];
  const quadFx = (x, y, z, r, cr, cg, cb, ca) => {
    fx.push(x - r, y, z - r, cr, cg, cb, ca, x + r, y, z - r, cr, cg, cb, ca, x + r, y, z + r, cr, cg, cb, ca);
    fx.push(x - r, y, z - r, cr, cg, cb, ca, x + r, y, z + r, cr, cg, cb, ca, x - r, y, z + r, cr, cg, cb, ca);
  };
  for (const m of marks) {
    if (!near(m)) continue;
    const a = clamp(m.life / MARK_LIFE, 0, 1) * .5;
    const y = terrainH(m.x, m.y) + .26;
    const o = m.w * .35, dx = Math.cos(m.h) * 1.2, dz = Math.sin(m.h) * 1.2;
    const px = -Math.sin(m.h) * .22, pz = Math.cos(m.h) * .22;
    for (const s of [1, -1]) {
      const bx = m.x - Math.sin(m.h) * o * s, bz = m.y + Math.cos(m.h) * o * s;
      fx.push(bx - dx - px, y, bz - dz - pz, .04, .02, .06, a,
              bx + dx - px, y, bz + dz - pz, .04, .02, .06, a,
              bx + dx + px, y, bz + dz + pz, .04, .02, .06, a);
      fx.push(bx - dx - px, y, bz - dz - pz, .04, .02, .06, a,
              bx + dx + px, y, bz + dz + pz, .04, .02, .06, a,
              bx - dx + px, y, bz - dz + pz, .04, .02, .06, a);
    }
  }
  if (fx.length) {
    gl.useProgram(G3.fx.p);
    gl.uniformMatrix4fv(G3.fx.u.uVP, false, G3.VP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    G3.fxm = GL.stream(G3.fxm, new Float32Array(fx), [[G3.fx.a.aPos, 3], [G3.fx.a.aCol, 4]]);
    gl.bindVertexArray(G3.fxm.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.fxm.n);
  }

  // sparks, smoke and fireballs, additive and always facing you
  const add = [];
  const camR = [G3.V[0], G3.V[4], G3.V[8]], camU = [G3.V[1], G3.V[5], G3.V[9]];
  const bill = (x, y, z, r, cr, cg, cb, ca) => {
    const rx = camR[0] * r, ry = camR[1] * r, rz = camR[2] * r;
    const ux = camU[0] * r, uy = camU[1] * r, uz = camU[2] * r;
    const v = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [a, b] of v)
      add.push(x + rx * a + ux * b, y + ry * a + uy * b, z + rz * a + uz * b, cr, cg, cb, ca);
  };
  for (const p of parts) {
    if (!near(p)) continue;
    const a = clamp(p.life * 2, 0, 1);
    const q = parseColour(p.col) || [255, 200, 120];
    const r = p.soft ? (p.r || .5) * (1 + (1 - p.life / p.life0) * 1.9) : (p.r || .28);
    bill(p.x, terrainH(p.x, p.y) + .6 + r, p.y, r,
         q[0] / 255, q[1] / 255, q[2] / 255, p.soft ? a * .3 : a);
  }
  for (const b of blasts) {
    const t = clamp(b.life / .55, 0, 1);
    bill(b.x, terrainH(b.x, b.y) + b.r * .6, b.y, b.r, 1, .30, 0, t * .7);
    bill(b.x, terrainH(b.x, b.y) + b.r * .6, b.y, b.r * .34, 1, .76, .42, t * t * t * .8);
  }
  if (add.length) {
    gl.useProgram(G3.fx.p);
    gl.uniformMatrix4fv(G3.fx.u.uVP, false, G3.VP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    G3.fxm = GL.stream(G3.fxm, new Float32Array(add), [[G3.fx.a.aPos, 3], [G3.fx.a.aCol, 4]]);
    gl.bindVertexArray(G3.fxm.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.fxm.n);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);

  trimCells(now);

  /* --- the 2D canvas on top, for everything that is not the world --- */
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, VW, VH);
  drawArrow();
  drawHUD();
  drawMini();
}

/* Cells you have driven away from. Kept generously — turning round on a street
   you just drove down must not rebuild it — and dropped furthest-first once
   there are more than the cap. */
function trimCells(now) {
  if (G3.cells.size <= CELL_CAP) return;
  const all = [...G3.cells.entries()]
    .map(([k, c]) => ({ k, c, d: dist2((c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2, cam.x, cam.y) }))
    .sort((a, b) => b.d - a.d);
  for (let i = 0; i < all.length - CELL_CAP; i++) {
    freeCell(all[i].c);
    G3.cells.delete(all[i].k);
  }
}

/* ------------------------------ the switch ------------------------------ */
/* One name, two renderers. Everything outside this file — main.js's loop, the
   test hooks, drawArrow, drawBuilding — calls render() and toScreen() and never
   learns which one it got. */
function render() { MODE3D ? render3D() : render2D(); }
function toScreen(wx, wy) { return MODE3D ? toScreen3D(wx, wy) : toScreen2D(wx, wy); }

function resize3D() {
  const el = $('gl');
  if (!el || !GL.gl) return;
  el.width = Math.floor(VW * DPR);
  el.height = Math.floor(VH * DPR);
}

/* Returns whether it worked, because a browser without WebGL2 has to be told
   rather than left looking at a black rectangle. */
function setMode3D(on) {
  if (on && !MODE3D) {
    if (!GL.init($('gl')) || !initGL3()) {
      toast('3D NEEDS WEBGL2', 2000);
      return false;
    }
  }
  MODE3D = !!on;
  /* The terrain and the 2D game are mutually exclusive on purpose. With TERRAIN
     off, terrainH() is a constant zero and every vertical term in the physics is
     multiplied by nothing — the top-down game is exactly the game it was, and
     the tests written against it stay honest. */
  TERRAIN = MODE3D;
  terrainSeed();
  $('gl').classList.toggle('on', MODE3D);
  $('modeN').textContent = MODE3D ? '2D' : '3D';
  $('modeBtn').title = MODE3D ? 'Switch to the top-down view' : 'Switch to the chase view';
  document.body.classList.toggle('mode-3d', MODE3D);
  /* The car has no height until the ground under it has one, and the first
     ground step reads an undefined z as "place me". Clearing it on the way in
     AND on the way out means switching views mid-corner never launches anything. */
  const all = [P.car].concat(traffic, cops);
  for (const q of all) if (q) { q.z = undefined; q.air = false; q.flip = 0; q.pitch = q.roll = 0; }
  G3.cam.h = P.car ? P.car.h : 0;
  last3 = performance.now();
  dropAllCells();
  resize();
  try { localStorage.setItem('vm3d', MODE3D ? '1' : '0'); } catch (e) {}
  return true;
}

/* Whatever view you were last in, put back at the moment the city appears.
   Silently: a player who chose 3D on a machine that has since lost WebGL2 gets
   the top-down game and no scolding, because there is nothing they can do about
   it and the game works either way. */
function restoreView3D() {
  let want = false;
  try { want = localStorage.getItem('vm3d') === '1'; } catch (e) {}
  if (want === MODE3D) return;
  if (want && (!GL.init($('gl')) || !initGL3())) return;
  setMode3D(want);
}
