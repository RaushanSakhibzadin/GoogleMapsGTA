"use strict";
/* VICE MAPS — every texture in the game, generated at load out of arithmetic.

   Part of a set of plain <script> files sharing one global scope. Load order is
   fixed in index.html and matters: this must come before js/render3d.js, which
   is the only thing that asks it for anything.

   WHAT THIS REPLACED, AND WHY IT IS BETTER. The trees and the wall render used
   to be photographs — cut out by hand, stored as base64 data: URIs in three .js
   files, 216 KB of them. They looked good and they cost every player a fifth of
   a megabyte before the first frame, they could not vary (one tree, stamped),
   and the repository carried binary blobs it could not diff or review. All of it
   is now a few kilobytes of code that runs in a few milliseconds.

   FRACTALS, AND SPECIFICALLY THESE TWO, because they are the two shapes nature
   uses and neither is expensive:

     - fractional Brownian motion — value noise summed over octaves, each half
       the amplitude and twice the frequency — for anything that is a SURFACE.
       Render, staining, the mottle on a leaf mass. Self-similar at every scale,
       which is why a wall made of it does not look like a wall made of one
       thing.

     - recursive branching for anything that is a STRUCTURE. A trunk that splits
       into boughs that split into branches, each generation shorter and thinner
       by a fixed ratio, is a tree in four lines of code and the reason a real
       one looks the way it does.

   EVERYTHING HERE IS DETERMINISTIC. The same build draws the same city on every
   machine and on every reload — the noise is hashed from its coordinates rather
   than drawn from a sequence, so nothing depends on the order in which things
   are asked for, and a test can compare two runs pixel for pixel. */

/* ---------------------------------------------------------------------------
   1. THE NOISE
   ------------------------------------------------------------------------ */

/* An integer hash, not Math.random and not fract(sin(x)). It has to be a
   FUNCTION OF THE COORDINATE rather than a sequence: tiles are generated in
   whatever order the renderer asks for them, and a sequence would make the
   result depend on that order. And it has to survive being fed large integers,
   which fract(sin(dot(p,k))) does not — the argument to sin runs out of mantissa
   long before the coordinates run out of range. */
function pxHash(a, b, seed) {
  let n = (a | 0) * 374761393 + (b | 0) * 668265263 + (seed | 0) * 1442695041;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return (n >>> 8) / 16777216;                    // 0..1, 24 bits of it
}

/* Value noise on a lattice that WRAPS at `period`. The wrapping is the whole
   trick behind a seamless tile: sample a tile across exactly `period` lattice
   cells and the left edge and the right edge read the same corners, so they
   agree by construction. The alternative — generating a tile and then
   cross-fading its own edges over itself — is what the photographic version had
   to do, and it leaves a soft band down the seam that you can find if you look. */
function vNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  // smoothstep, so the lattice does not show as a grid of creases
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (a, b) => pxHash(((a % period) + period) % period,
                             ((b % period) + period) % period, seed);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* Fractional Brownian motion: the sum that makes noise look like a material.
   Each octave is twice the frequency and half the amplitude of the one before,
   which is the ratio that makes the result look the same however close you
   stand to it. The period doubles with the frequency so every octave wraps on
   the same tile. */
function fbm(x, y, octaves, period, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vNoise(x * freq, y * freq, period * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* Ridged noise, which is fBm folded about its midpoint. Where fBm drifts, this
   creases — and a crease is what a crack in render is. */
function ridged(x, y, octaves, period, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vNoise(x * freq, y * freq, period * freq, seed + i * 131) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ---------------------------------------------------------------------------
   2. THE WALL
   ------------------------------------------------------------------------ */

/* A grey multiplier around 1.0, tiled every four metres across every facade in
   the city — so it says where a wall is dirty and leaves the theme to say what
   colour it is. Grey on purpose: a coloured tile would put one city's render on
   every building in every other.

   THREE SCALES OF DIRT, which is what a real wall has. Broad fBm for the patches
   where render has been repaired at different times; ridged noise for the cracks
   that run along the line of a floor slab; and a fine octave for the aggregate
   in the render itself. The horizontal banding is deliberate — the y coordinate
   is squashed, so the patching runs in courses the way a rendered wall does
   rather than pooling in circles. */
const WALL_TILE = 128;
function procWallTile() {
  if (procWallTile.cv) return procWallTile.cv;
  const S = WALL_TILE;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // patches: broad, and wider than they are tall
      const patch = fbm(u * 3, v * 3 * 2.2, 4, 3, 11);
      // cracks: creased, fine, and mostly horizontal for the same reason
      const crack = ridged(u * 6, v * 6 * 3.0, 3, 6, 29);
      // aggregate: one fine octave, isotropic
      const grit = vNoise(u * 48, v * 48, 48, 71);
      let t = 0.52 + (patch - 0.5) * 0.85 + (grit - 0.5) * 0.22;
      t -= Math.pow(crack, 6) * 0.45;             // a crack is dark and narrow
      const c = Math.max(0, Math.min(255, Math.round(t * 255)));
      const i = (y * S + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = c;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return (procWallTile.cv = cv);
}

/* ---------------------------------------------------------------------------
   3. THE TREES
   ------------------------------------------------------------------------ */

const TREE_S = 192;                 // one column
const TREE_COLS_N = 2;              // and there are two, so an avenue is not one tree

/* A tree is a recursion and a cloud of leaves, in that order.

   THE BRANCHES ARE THE STRUCTURE. Each generation is shorter and thinner than
   its parent by a fixed ratio and leaves at a fixed spread, which is the whole
   of what makes a tree look like a tree; the small random wobble on each is what
   stops it looking like a diagram of one. Drawn first, so the canopy can settle
   in front of it and leave the trunk showing underneath.

   THE LEAVES ARE THE SURFACE. Every tip of the recursion drops a soft blob into
   a mask, and the mask is then filled with fBm — so the canopy's OUTLINE comes
   from where the branches actually reached, and its texture and its holes come
   from the noise. That is the right way round: a canopy is leaves on branches,
   and a crown drawn as a circle and then roughened always reads as a circle that
   has been roughened. */
function branchInto(g, tips, x, y, ang, len, wid, depth, rnd, spread, ratio) {
  const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
  g.lineWidth = Math.max(0.6, wid);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x2, y2);
  g.stroke();
  if (depth <= 0 || len < 3) { tips.push([x2, y2, len]); return; }
  const n = rnd() < 0.22 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * spread * (0.8 + rnd() * 0.5);
    branchInto(g, tips, x2, y2, ang + off + (rnd() - 0.5) * 0.22,
               len * (ratio + rnd() * 0.10), wid * 0.66, depth - 1, rnd, spread, ratio);
  }
}

/* dusk and day are the two the game asks for. The night one is lit from BELOW,
   because after dark a street tree is lit by the lamp under it and by nothing
   else, and the daylight one from above. That is the single biggest difference
   between the two and it costs one sign. */
const TREE_PAL = {
  day:   { leaf: [96, 132, 56], leaf2: [148, 180, 92], bark: [86, 74, 60], up: 1 },
  night: { leaf: [40, 58, 34], leaf2: [128, 132, 74], bark: [44, 38, 30], up: -1 }
};

const TREE_ATLAS = {};
function procTreeAtlas(kind) {
  if (TREE_ATLAS[kind]) return TREE_ATLAS[kind];
  const S = TREE_S, COLS = TREE_COLS_N;
  const pal = TREE_PAL[kind] || TREE_PAL.day;
  const atlas = document.createElement('canvas');
  atlas.width = S * COLS; atlas.height = S;
  const ag = atlas.getContext('2d');

  for (let c = 0; c < COLS; c++) {
    /* Xorshift, seeded off the column. Not a linear congruential generator:
       consecutive values of one of those are correlated, and consecutive values
       here are an angle and then a length. */
    let s = (c * 2654435761 + 12345) >>> 0;
    const rnd = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');

    // ---- the branches ----
    g.strokeStyle = 'rgb(' + pal.bark.join(',') + ')';
    g.lineCap = 'round';
    const tips = [];
    // column 0 a broad mature tree, column 1 a younger narrower one
    const wide = c === 0;
    branchInto(g, tips, S * 0.5, S * 0.99, -Math.PI / 2,
               S * (wide ? 0.20 : 0.24), S * (wide ? 0.050 : 0.032),
               wide ? 7 : 6, rnd, wide ? 0.52 : 0.38, wide ? 0.74 : 0.78);

    // ---- the mask the leaves live in ----
    const mk = document.createElement('canvas');
    mk.width = S; mk.height = S;
    const mg = mk.getContext('2d');
    for (const [tx, ty, tl] of tips) {
      const r = Math.max(6, tl * (wide ? 2.4 : 1.9));
      const grd = mg.createRadialGradient(tx, ty, 0, tx, ty, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      mg.fillStyle = grd;
      mg.beginPath();
      mg.arc(tx, ty, r, 0, Math.PI * 2);
      mg.fill();
    }
    const mask = mg.getImageData(0, 0, S, S).data;

    // ---- fill it with fractal foliage ----
    const fo = document.createElement('canvas');
    fo.width = S; fo.height = S;
    const fg = fo.getContext('2d');
    const img = fg.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const m = mask[i + 3] / 255;
        if (m <= 0.02) { d[i + 3] = 0; continue; }
        const u = x / S, v = y / S;
        // two scales: clumps of leaves, and the leaves in a clump
        const clump = fbm(u * 5, v * 5, 3, 5, 7 + c * 13);
        const leafy = fbm(u * 22, v * 22, 2, 22, 41 + c * 13);
        /* ALPHA-TESTED, so this has to end up crisp — the shader discards at
           0.5 and a soft edge would simply move the hard one. Thresholding here
           puts the fractal INTO the silhouette instead of blurring it. */
        const a = m * (0.45 + clump * 0.95) - (1 - leafy) * 0.16;
        if (a < 0.42) { d[i + 3] = 0; continue; }
        /* Lit from below at night and from above by day, which is the one thing
           that really separates them. */
        const lit = pal.up > 0 ? (1 - v) : v;
        const t = Math.max(0, Math.min(1, 0.25 + lit * 0.55 + (clump - 0.5) * 0.6
                                          + (leafy - 0.5) * 0.35));
        d[i]     = Math.round(pal.leaf[0] + (pal.leaf2[0] - pal.leaf[0]) * t);
        d[i + 1] = Math.round(pal.leaf[1] + (pal.leaf2[1] - pal.leaf[1]) * t);
        d[i + 2] = Math.round(pal.leaf[2] + (pal.leaf2[2] - pal.leaf[2]) * t);
        d[i + 3] = 255;
      }
    }
    fg.putImageData(img, 0, 0);
    g.drawImage(fo, 0, 0);                       // canopy over the branches

    ag.drawImage(cv, c * S, 0);
  }
  return (TREE_ATLAS[kind] = atlas);
}

/* Thrown away when the theme changes so the next ask rebuilds — cheap enough
   that caching across a theme switch is not worth the confusion. */
function procTexReset() {
  for (const k in TREE_ATLAS) delete TREE_ATLAS[k];
  procWallTile.cv = null;
}
