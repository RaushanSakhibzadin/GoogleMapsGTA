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

/* Value noise on a lattice that WRAPS — at `px` cells across and `py` cells
   down, and `py` defaults to `px` because most callers want a square. The
   wrapping is the whole trick behind a seamless tile: sample a tile across
   exactly `px` lattice cells and the left edge and the right edge read the same
   corners, so they agree by construction. The alternative — generating a tile and
   then cross-fading its own edges over itself — is what the photographic version
   had to do, and it leaves a soft band down the seam that you can find if you
   look.

   THE TWO PERIODS ARE SEPARATE BECAUSE THE WALL SQUASHES ONE AXIS. Render is
   patched in horizontal courses, so the wall tile samples y faster than x — and
   with a single period covering both, y ran to 6.6 cells on a lattice that
   wrapped every 3, so the top and bottom edges met at two unrelated rows of
   corners. It measured: a step across the seam cost 16.0 levels against 6.9 for a
   step anywhere else, on a tile whose entire design claim was that it wrapped by
   construction. */
function vNoise(x, y, px, seed, py) {
  const qx = px, qy = py || px;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  // smoothstep, so the lattice does not show as a grid of creases
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (a, b) => pxHash(((a % qx) + qx) % qx, ((b % qy) + qy) % qy, seed);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* Fractional Brownian motion: the sum that makes noise look like a material.
   Each octave is twice the frequency and half the amplitude of the one before,
   which is the ratio that makes the result look the same however close you
   stand to it. Both periods double with the frequency so every octave wraps on
   the same tile. */
function fbm(x, y, octaves, px, seed, py) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vNoise(x * freq, y * freq, px * freq, seed + i * 101, (py || px) * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* Ridged noise, which is fBm folded about its midpoint. Where fBm drifts, this
   creases — and a crease is what a crack in render is, and what the lit edge of
   a leaf is. */
function ridged(x, y, octaves, px, seed, py) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vNoise(x * freq, y * freq, px * freq,
                                  seed + i * 131, (py || px) * freq) * 2 - 1);
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
      /* Each of these is squashed vertically by an INTEGER factor, so both edges
         still land on cell zero. The patching wants to run in courses the way a
         rendered wall does rather than pool in circles, and a non-integer squash
         gets that at the cost of the seam. */
      const patch = fbm(u * 3, v * 6, 4, 3, 11, 6);        // broad, wide, shallow
      const crack = ridged(u * 6, v * 18, 3, 6, 29, 18);   // creased and horizontal
      const grit = vNoise(u * 48, v * 48, 48, 71);         // aggregate, isotropic
      /* THE AGGREGATE IS QUIET — 0.10, not the 0.22 it started at. It is the
         finest thing in the tile, close to one texel a cell, so it is the term
         that survives magnification as per-pixel static on a wall you are parked
         next to. At 0.22 a step between neighbouring texels cost 6.3 levels
         against 3.2 for the photograph this replaced, and it showed up in a test
         about something else entirely: facade.mjs counts the edges the windows
         are responsible for against the edges on the same pixels without them,
         and the extra static took that ratio from 3.9 to 2.9 through a bar at
         3.0. Render has grain in it, but it is not sand. */
      let t = 0.52 + (patch - 0.5) * 0.70 + (grit - 0.5) * 0.10;
      /* A crack is dark and NARROW — the sixth power is what keeps it to the
         crease rather than shading the whole wall around it. Floored at 0.25
         rather than at 0: this is a multiplier, and a multiplier of zero is a
         hole in the building rather than a crack in its render. */
      t -= Math.pow(crack, 6) * 0.38;
      const c = Math.max(64, Math.min(255, Math.round(t * 255)));
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
   stops it looking like a diagram of one.

   THE LEAVES ARE THE SURFACE. Every tip of the recursion drops a soft blob into
   a mask, and the mask is then filled with noise — so the canopy's OUTLINE comes
   from where the branches actually reached, and its texture and its holes come
   from the fractal. That is the right way round: a canopy is leaves on branches,
   and a crown drawn as a circle and then roughened always reads as a circle that
   has been roughened.

   GROWN INTO A LIST BEFORE IT IS DRAWN, rather than stroked as it recurses. A
   random walk does not know how far it will get: the first version stroked
   straight onto the cell and one of the two trees grew out through the top and
   the right-hand edge, which in an atlas is not a crown that is slightly too big
   — it is a crown with two straight sides, because the neighbouring column
   starts there. Measuring the whole skeleton first and fitting it to the cell
   afterwards costs one array and removes the failure entirely. */
function growTree(rnd, spread, ratio, D) {
  const segs = [], tips = [];
  const rec = (x, y, ang, len, wid, depth) => {
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    segs.push([x, y, x2, y2, wid]);
    /* LEAVES ON THE OUTER THREE GENERATIONS, not only on the last one. Hanging
       them off the tips alone puts every blob on one surface and the crown comes
       out hollow — a croissant with the trunk showing through the middle of it,
       which is what this did. A real canopy is leaves all the way down the outer
       twigs, so the mass projects over its own interior and fills it. */
    if (depth <= 2) tips.push([x2, y2, len]);
    if (depth <= 0 || len < 3) return;
    const gen = D - depth;                       // 0 at the trunk
    /* THE FORK ANGLE OPENS WITH EVERY GENERATION. One spread for the whole tree
       gives either a narrow broom or a low wide mushroom, and it gave the
       mushroom: the trunk split at the same angle as the twigs, so the crown
       started at ankle height and the fit squashed the whole thing to get its
       width inside the cell. A trunk forks tightly and twigs splay, so the
       silhouette is tall at the bottom and broad at the top, which is a tree.

       AND THE FIRST TWO FORKS ARE EVEN. Down there each branch carries a quarter
       of the crown, so a random 30% lean at gen 0 is a tree that has fallen over
       — the wobble that gives the outer branches their character is the wrong
       thing entirely at the bottom. */
    const sp = spread * (0.40 + gen * 0.24);
    const even = gen < 2;
    const n = rnd() < 0.22 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * sp * (even ? 1 : 0.8 + rnd() * 0.5);
      rec(x2, y2, ang + off + (even ? 0 : (rnd() - 0.5) * 0.22),
          len * (ratio + rnd() * 0.10), wid * 0.66, depth - 1);
    }
  };
  return { segs, tips, rec };
}

/* dusk and day are the two the game asks for. The night one is lit from BELOW,
   because after dark a street tree is lit by the lamp under it and by nothing
   else, and the daylight one from above. That is the single biggest difference
   between the two and it costs one sign. */
/* THE DAY RANGE IS WIDER THAN THE NIGHT ONE, which is the opposite of the first
   guess. A street lamp is one weak source and everything it does not reach goes
   the same near-black; the sun is strong enough that a leaf turned away from it
   is still lit by the sky, and the ones turned towards it are nearly white. So
   daylight foliage runs from a deep shadow green to a pale yellow-green, and a
   narrow day palette — which is what this had — averaged out to a flat green
   card that the leaf detail could not show through. */
const TREE_PAL = {
  day:   { leaf: [58, 78, 40], leaf2: [158, 188, 96], bark: [86, 74, 60], up: 1 },
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

    /* ---- grow it, in its own coordinates ----
       Column 0 a broad mature tree, column 1 a younger narrower one. The lengths
       here only set the SHAPE — how tall against how wide — because everything is
       scaled to the cell below, so they are ratios rather than pixels. */
    const wide = c === 0;
    const leafK = wide ? 2.7 : 2.2;
    const D = wide ? 7 : 6;
    const tree = growTree(rnd, wide ? 0.78 : 0.62, wide ? 0.74 : 0.78, D);
    tree.rec(0, 0, -Math.PI / 2, wide ? 38 : 46, wide ? 9.6 : 6.2, D);
    const { segs } = tree;

    /* ---- and it keeps a bare trunk ----
       A street tree is pruned to head height and the crown starts well above it,
       which matters here for a reason beyond looking right: this is a crossed-quad
       sprite planted on a pavement, and foliage down at the foot of it intersects
       the pavement and the cars. So the lowest of the three leaf-bearing
       generations are dropped — measured against the crown's own top, because how
       tall the walk got is not known until it has finished. */
    let topY = 0;
    for (const s of segs) topY = Math.min(topY, s[3]);
    const tips = tree.tips.filter(t => t[1] <= topY * 0.42);

    /* ---- measure it, and fit it to the cell ----
       Horizontally about the TRUNK, not about the crown's own middle: a sprite
       hangs off the point where its stem meets the ground, so a tree centred on
       its foliage would lean away from the spot it is planted on. Vertically the
       foot goes on the bottom edge and the highest leaf just inside the top. */
    let minX = 0, maxX = 0, minY = 0;
    for (const [tx, ty, tl] of tips) {
      const r = Math.max(5, tl * leafK);
      minX = Math.min(minX, tx - r); maxX = Math.max(maxX, tx + r);
      minY = Math.min(minY, ty - r);
    }
    for (const [x1, y1, x2, y2, w] of segs) {
      minX = Math.min(minX, x1 - w, x2 - w); maxX = Math.max(maxX, x1 + w, x2 + w);
      minY = Math.min(minY, y1 - w, y2 - w);
    }
    const pad = 2;
    const half = Math.max(-minX, maxX, 1);
    const k = Math.min((S / 2 - pad) / half, (S - pad) / Math.max(-minY, 1));
    const ox = S / 2, oy = S - 1;
    const px = x => ox + x * k, py = y => oy + y * k;

    // ---- the branches ----
    g.strokeStyle = 'rgb(' + pal.bark.join(',') + ')';
    g.lineCap = 'round';
    for (const [x1, y1, x2, y2, w] of segs) {
      g.lineWidth = Math.max(0.6, w * k);
      g.beginPath();
      g.moveTo(px(x1), py(y1));
      g.lineTo(px(x2), py(y2));
      g.stroke();
    }

    // ---- the mask the leaves live in ----
    const mk = document.createElement('canvas');
    mk.width = S; mk.height = S;
    const mg = mk.getContext('2d');
    for (const [tx, ty, tl] of tips) {
      const r = Math.max(5, tl * leafK) * k;
      const grd = mg.createRadialGradient(px(tx), py(ty), 0, px(tx), py(ty), r);
      grd.addColorStop(0, 'rgba(255,255,255,0.98)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.62)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      mg.fillStyle = grd;
      mg.beginPath();
      mg.arc(px(tx), py(ty), r, 0, Math.PI * 2);
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
        /* THREE SCALES, because a canopy has three: the boughs' worth of leaves
           that catch the light together, the sprays inside one of those, and the
           individual leaf.

           THE LEAF SCALE IS RIDGED, not fBm, and that is the whole difference
           between foliage and a green cloud. fBm drifts smoothly, so at three
           pixels a cell it averages away to a flat wash and the tree reads as one
           shape lit from one side — measured, the mean step between neighbouring
           pixels came out at 0.83, which is to say nothing. Ridged noise creases:
           each cell has a hard bright spine and falls away on both sides, and at
           three pixels a cell — which is about what a leaf is on a 192 px canopy
           — those creases are individual leaves turning to the light. Same
           frequency, same cost, 9.8 instead of 0.8.

           AND IT IS DOMAIN-WARPED, which is the difference between leaves and
           burlap. Ridged noise creases along the edges of its lattice, and the
           lattice is square and axis-aligned, so the creases are a grid: the
           first version of this came out as a woven cross-hatch, perfectly
           regular, visible as fabric the moment you parked next to it. Warping
           the coordinate by a lower-frequency noise before sampling bends the
           lattice out of alignment with itself, and the creases stop agreeing
           about where they run. It is two more noise lookups. */
        const clump = fbm(u * 5, v * 5, 3, 5, 7 + c * 13);
        const leafy = fbm(u * 22, v * 22, 2, 22, 41 + c * 13);
        const wx = u + (fbm(u * 11, v * 11, 2, 11, 91 + c * 13) - 0.5) * 0.09;
        const wy = v + (fbm(u * 11, v * 11, 2, 11, 97 + c * 13) - 0.5) * 0.09;
        const leaves = ridged(wx * 58, wy * 58, 2, 58, 53 + c * 13);
        /* ALPHA-TESTED, so this has to end up crisp — the shader discards at
           0.5 and a soft edge would simply move the hard one. Thresholding here
           puts the fractal INTO the silhouette instead of blurring it. */
        const a = m * (0.45 + clump * 0.95) - (1 - leafy) * 0.16;
        if (a < 0.42) { d[i + 3] = 0; continue; }
        /* Lit from below at night and from above by day, which is the one thing
           that really separates them. */
        const lit = pal.up > 0 ? (1 - v) : v;
        const t = Math.max(0, Math.min(1, 0.25 + lit * 0.55 + (clump - 0.5) * 0.6
                                          + (leafy - 0.5) * 0.35
                                          + (leaves - 0.5) * 0.9));
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
