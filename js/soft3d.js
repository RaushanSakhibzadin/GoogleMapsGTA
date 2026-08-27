/* THE CHASE VIEW WITHOUT WEBGL.

   Reported three times from the same phone, and the log finally said why in
   words rather than in a toast: probe "no", webgl1 false, and no error message
   at all. Chrome on iOS 26.6 with WebGL switched off — Lockdown Mode does that,
   and so do some managed profiles. There is nothing wrong with the machine and
   nothing to fix in the driver; the API simply is not there, and asking for it
   politely a fourth time will not help.

   So this draws the same street with the 2D canvas the top-down view already
   uses. Everything the GL renderer needs except the GL is ordinary JavaScript
   and is already here: the chase camera, the view and projection matrices, the
   building footprints and their heights, the roads, the cars, the planting. What
   is missing is a rasteriser, and for a city made of flat-topped boxes a
   painter's algorithm IS the rasteriser — sort back to front, fill polygons,
   done.

   WHAT IT GIVES UP, deliberately and in this order: per-pixel shading, the
   shadow map, the procedural window grid, and the fog. What survives is the part
   that matters — you are behind the car, the street has depth, the buildings
   have height and the sun is on one side of them. A flat-shaded face carries
   nearly all of the readability of a lit one, because the thing that says "this
   is a wall and that is a roof" is the difference between two greys, not the
   gradient across either.

   IT IS NOT A SECOND GAME. The camera, the terrain, the physics and every test
   hook are the ones the WebGL path uses; this file replaces exactly one thing,
   the drawing. */

/* How far it looks. The GL view reaches 760 m over batched, frustum-culled
   geometry on a GPU; this fills polygons one at a time in JavaScript, so the
   distance is what buys the frame rate, and 240 m is about four blocks — far
   enough that the street does not end in front of you, near enough to be
   affordable on the phone that needs this. */
const SOFT_VIEW = 240;
// and a hard ceiling on the two things that can arrive in their thousands
const SOFT_MAX_BUILDINGS = 220, SOFT_MAX_TREES = 90;
const SOFT_NEAR = 0.9;

const SOFT = { on: false, tris: 0, drawn: 0 };

/* View space, which is where the clipping has to happen: a polygon with one
   corner behind the eye projects to nonsense, and no amount of care afterwards
   recovers it. The near plane is a plane in this space and nowhere else. */
function softView(x, y, z, out) {
  const m = G3.V;
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
/* Sutherland–Hodgman against one plane, z <= -near. Looking down -z is the
   convention lookAt builds, so everything in front of the eye has negative z and
   the test is the same for every vertex. */
function softClipNear(poly) {
  const out = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const A = poly[j], B = poly[i];
    const ain = A[2] <= -SOFT_NEAR, bin = B[2] <= -SOFT_NEAR;
    if (ain !== bin) {
      const t = (-SOFT_NEAR - A[2]) / (B[2] - A[2]);
      out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, -SOFT_NEAR]);
    }
    if (bin) out.push(B);
  }
  return out;
}
/* View space to pixels. The projection matrix is the same one the GPU would
   have used, so the two views frame the world identically — which is what makes
   the screenshots comparable and the tests shared. */
function softProject(v, out) {
  const m = G3.Pm;
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
  const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
  const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
  const iw = 1 / (w || 1e-6);
  out[0] = (x * iw * 0.5 + 0.5) * VW;
  out[1] = (0.5 - y * iw * 0.5) * VH;
  return out;
}

const SOFT_A = [0, 0, 0], SOFT_B = [0, 0];
/* One world-space polygon, clipped, projected and filled. Returns false when
   nothing of it was in front of the eye, so callers can skip their own work. */
function softPoly(g, pts, fill, stroke) {
  const view = [];
  for (let i = 0; i < pts.length; i += 3)
    view.push(softView(pts[i], pts[i + 1], pts[i + 2], [0, 0, 0]));
  const clipped = softClipNear(view);
  if (clipped.length < 3) return false;
  g.beginPath();
  for (let i = 0; i < clipped.length; i++) {
    const p = softProject(clipped[i], SOFT_B);
    if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  SOFT.tris += clipped.length - 2;
  return true;
}

/* Flat shading, from the same light vector the shaders read, so the sun is on
   the same side of every building in both renderers. No specular, no ambient
   occlusion, no shadow — one dot product and a clamp. */
function softShade(col, nx, ny, nz, th) {
  const ld = th.ld;
  const l = Math.hypot(ld[0], ld[1], ld[2]) || 1;
  const d = Math.max(0, (nx * ld[0] + ny * ld[1] + nz * ld[2]) / l);
  const a = th.amb, c = th.lc;
  const r = clamp(col[0] * (a[0] + c[0] * d), 0, 1);
  const gg = clamp(col[1] * (a[1] + c[1] * d), 0, 1);
  const b = clamp(col[2] * (a[2] + c[2] * d), 0, 1);
  return 'rgb(' + (r * 255 | 0) + ',' + (gg * 255 | 0) + ',' + (b * 255 | 0) + ')';
}

/* THE FRAME.

   Order is the whole algorithm: sky, then the ground, then everything standing
   on it sorted far to near. Within one building the walls are drawn before its
   own roof and only the ones facing the camera are drawn at all, which is
   correct for a convex box and costs one dot product per wall. */
function render3DSoft() {
  const g = ctx;
  const th = SKY[themeName] || SKY.dusk;
  const now = performance.now();
  const dt = clamp((now - (SOFT.last || now)) / 1000, 0.001, 0.1);
  SOFT.last = now;
  SOFT.tris = 0; SOFT.drawn = 0;

  camera3D(dt);
  rot = -Math.PI / 2 - G3.cam.h;
  cs = Math.cos(rot); sn = Math.sin(rot);
  HX = VW / 2; HY = VH / 2;

  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  /* THE SKY, as a screen-space gradient rather than a ray per pixel. The
     horizon is wherever the eye's own level projects to, so it rides up and down
     with the camera exactly as the real one does. */
  const hz = softHorizon();
  const sky = g.createLinearGradient(0, 0, 0, Math.max(hz, 1));
  sky.addColorStop(0, rgbOf(th.zen));
  sky.addColorStop(1, rgbOf(th.sky));
  g.fillStyle = sky;
  g.fillRect(0, 0, VW, Math.max(hz, 0));
  // and the ground it stands on, which is everything below the horizon
  g.fillStyle = PAL.ground;
  g.fillRect(0, Math.max(hz, 0), VW, VH - Math.max(hz, 0));

  const cx = P.car.x, cy = P.car.y;
  const R2 = SOFT_VIEW * SOFT_VIEW;

  /* ---- the ground: parks first, then the roads on top of them ---- */
  for (const pk of W.parks) {
    if (dist2(pk.bb.x0, pk.bb.y0, cx, cy) > R2 * 4) continue;
    const v = [];
    for (const p of pk.pts) v.push(p.x, terrainH(p.x, p.y) + 0.05, p.y);
    if (v.length >= 9) softPoly(g, v, PAL.park);
  }
  for (const r of roadsIn(cx - SOFT_VIEW, cy - SOFT_VIEW, cx + SOFT_VIEW, cy + SOFT_VIEW)) {
    const col = r.w >= 11 ? PAL.roadBig : PAL.road;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      if (dist2((a.x + b.x) / 2, (a.y + b.y) / 2, cx, cy) > R2) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const px = -dy / L * r.w / 2, py = dx / L * r.w / 2;
      softPoly(g, [
        a.x + px, terrainH(a.x, a.y) + 0.10, a.y + py,
        b.x + px, terrainH(b.x, b.y) + 0.10, b.y + py,
        b.x - px, terrainH(b.x, b.y) + 0.10, b.y - py,
        a.x - px, terrainH(a.x, a.y) + 0.10, a.y - py
      ], col);
    }
  }

  /* ---- everything that stands up, in ONE list, far to near ----

     Buildings, then trees, then cars was the first version, and it is wrong in
     the way a painter's algorithm is always wrong when you sort within groups
     instead of across them: a tree fifty metres behind a block was painted after
     it and therefore in front of it, hanging in the air halfway up somebody's
     wall, and the car did the same. There is no depth buffer here — the order IS
     the depth test — so everything that stands on the ground has to be sorted
     together. */
  const standing = [];
  for (const b of W.buildings) {
    const d = dist2(b.cx, b.cy, cx, cy);
    if (d <= R2) standing.push({ d, b });
  }
  for (const t of softTreeSites(cx, cy)) standing.push({ d: t.d, tree: t });
  for (const c of softCarList()) standing.push({ d: c.d, car: c.q });
  standing.sort((p, q) => q.d - p.d);
  const list = standing.length > SOFT_MAX_BUILDINGS + SOFT_MAX_TREES + 40
    ? standing.slice(standing.length - (SOFT_MAX_BUILDINGS + SOFT_MAX_TREES + 40))
    : standing;

  const eye = G3.cam;
  const box = [];
  for (const it of list) {
    if (it.tree) { softTree(g, th, it.tree); continue; }
    if (it.car) { softCar(g, th, it.car, box); continue; }
    const b = it.b;
    const n = b.pts.length;
    let base = Infinity;
    for (const p of b.pts) base = Math.min(base, terrainH(p.x, p.y));
    base -= 1;
    const top = terrainH(b.cx, b.cy) + b.h;
    const wind = windingOf(b.pts);
    const wall = b.mWall, roof = b.mRoof;
    const wc = [wall[0] / 255, wall[1] / 255, wall[2] / 255];
    const rc = [roof[0] / 255, roof[1] / 255, roof[2] / 255];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = wind > 0 ? b.pts[i] : b.pts[j], q = wind > 0 ? b.pts[j] : b.pts[i];
      const ex = q.x - p.x, ez = q.y - p.y;
      const L = Math.hypot(ex, ez);
      if (L < 1e-4) continue;
      const nx = -ez / L, nz = ex / L;
      // only the walls that face the eye; the rest are the far side of a box
      if ((p.x - eye.ex) * nx + (p.y - eye.ez) * nz > 0) continue;
      softPoly(g, [p.x, base, p.y, q.x, base, q.y, q.x, top, q.y, p.x, top, p.y],
               softShade(wc, nx, 0, nz, th));
      SOFT.drawn++;
    }
    // the roof last: it is on top of everything the walls just covered
    const rv = [];
    for (const p of b.pts) rv.push(p.x, top, p.y);
    if (rv.length >= 9) softPoly(g, rv, softShade(rc, 0, 1, 0, th));
  }

  SOFT.on = true;
}

/* Where the eye's own level meets the far distance, in pixels. A point on the
   horizon is one at the eye's height, infinitely far — which projects to the
   same row wherever you put it, so any far point at that height will do. */
function softHorizon() {
  const C = G3.cam;
  const fx = C.ex - Math.cos(C.h) * -4000, fz = C.ez - Math.sin(C.h) * -4000;
  const v = softView(fx, C.ey, fz, [0, 0, 0]);
  if (v[2] > -SOFT_NEAR) return VH * 0.42;
  return softProject(v, [0, 0])[1];
}

const rgbOf = c => 'rgb(' + (c[0] * 255 | 0) + ',' + (c[1] * 255 | 0) + ',' + (c[2] * 255 | 0) + ')';

/* The planting. Split into "where are they" and "draw one", so the positions can
   go into the shared depth sort and the drawing can happen in its turn. */
function softTreeSites(cx, cy) {
  /* FILTERED PER ROAD, NOT AFTERWARDS. treesAlong plants the whole length of a
     road, and a boulevard is kilometres long — so gathering every site first and
     stopping once the list looked big enough filled it with one road's distant
     trees and returned nothing near the car at all. The street came out bare.
     Each road's sites are cut to what is actually in view before the next one is
     asked for. */
  const near = [];
  const R2 = 140 * 140;
  for (const r of roadsIn(cx - 140, cy - 140, cx + 140, cy + 140)) {
    if (!r.drive) continue;
    const sites = [];
    treesAlong([], r, -1e9, -1e9, 1e9, 1e9, () => {}, sites);
    for (let i = 0; i < sites.length; i += 2) {
      const d = dist2(sites[i], sites[i + 1], cx, cy);
      if (d < R2) near.push({ d, x: sites[i], z: sites[i + 1] });
    }
    if (near.length > SOFT_MAX_TREES * 3) break;
  }
  near.sort((a, b) => a.d - b.d);
  return near.slice(0, SOFT_MAX_TREES);
}
/* THE SAME CROSSED-QUAD TREE, as a sprite.

   Two quads at right angles is what the GL path draws and what San Andreas drew,
   and from any one viewpoint what you see of a cross is a single upright picture
   of a tree. So here it is a single upright picture of a tree: the same painted
   canvas, drawn between the projected foot and the projected top. Screen-aligned
   rather than world-aligned, which is the one visible difference and the right
   trade — a Canvas2D drawImage cannot shear a bitmap onto an arbitrary quad
   without a transform per tree, and this renderer exists because the machine
   running it has no GPU to spare. */
/* HALF TRANSPARENT HERE TOO, so the two renderers draw the same street.

   globalAlpha rather than a second tinted canvas: unlike the brightness filter
   below — which cost a compositing pass per call and took ninety trees from 59
   fps to 13 — alpha on a drawImage is free, it is a blend factor the blit was
   already doing. The value is the GL path's, so the two cannot drift apart. */
function softTree(g, th, t) {
  const cv = treeCanvas();
  if (!cv) return;
  const k = hash2(t.x, t.z);
  const y = terrainH(t.x, t.z);
  const H = 8.5 + k * 5.0;
  const foot = softView(t.x, y, t.z, [0, 0, 0]);
  const top = softView(t.x, y + H, t.z, [0, 0, 0]);
  if (foot[2] > -SOFT_NEAR || top[2] > -SOFT_NEAR) return;   // behind the eye
  const fp = softProject(foot, [0, 0]), tp = softProject(top, [0, 0]);
  const h = fp[1] - tp[1];
  if (h < 4) return;                       // a few pixels of tree is not worth a draw
  const w = h * 0.62;
  /* The same column and the same mirror the GL path bakes into its UVs, off the
     same two hashes, so a street looks the same in both renderers. The mirror is a
     negative scale rather than a second copy of the art. */
  const art = softTreeArt(th);
  const cols = treeCols(), cw = art.width / cols;
  const col = Math.min(cols - 1, Math.floor(hash2(t.x, t.z + 7.77) * cols));
  // half a pixel off each side, for the same reason the GL path insets its UVs
  const sx = col * cw + 0.5, sw = cw - 1;
  const a0 = g.globalAlpha;
  g.globalAlpha = a0 * (typeof TREE_ALPHA === 'number' ? TREE_ALPHA : 1);
  if (hash2(t.x + 7.77, t.z) < 0.5) {
    g.save();
    g.translate(fp[0], 0);
    g.scale(-1, 1);
    g.drawImage(art, sx, 0, sw, art.height, -w / 2, tp[1], w, h);
    g.restore();
  } else {
    g.drawImage(art, sx, 0, sw, art.height, fp[0] - w / 2, tp[1], w, h);
  }
  g.globalAlpha = a0;
}

/* THE TREE, DARKENED ONCE PER THEME RATHER THAN ONCE PER TREE.

   The first version set ctx.filter = 'brightness(...)' before each drawImage,
   which is correct and costs a separate compositing pass per call: ninety trees
   took the frame rate from 59 to 13. A filter is not a cheap flag. So the tint
   is baked into a second canvas the first time a theme asks for it —
   source-atop paints only where the leaves already are, leaving the cutout
   alone — and every tree after that is a plain blit. */
const TREE_ART = {};
function softTreeArt(th) {
  const key = themeName;
  if (TREE_ART[key]) return TREE_ART[key];
  const src = treeCanvas();
  /* The same term the GL view multiplies in, so the two renderers agree about
     how dark the avenue is — and so the photographed night tree, which was lit
     by a real street lamp before it ever got here, is not dimmed twice. */
  const lit = clamp(treeLit(th)[1], 0.25, 1);
  if (lit > 0.92) return (TREE_ART[key] = src);
  const cv = document.createElement('canvas');
  cv.width = src.width; cv.height = src.height;
  const g = cv.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(0,0,0,' + (1 - lit).toFixed(3) + ')';
  g.fillRect(0, 0, cv.width, cv.height);
  return (TREE_ART[key] = cv);
}

/* The cars, as the same boxes the far half of the GL view uses. body3d.js works
   out the eight corners including roll and pitch, so a car on a hill leans here
   too. */
const SOFT_FACES = [[0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [6, 7, 3, 2], [5, 6, 2, 1], [7, 4, 0, 3]];
function softCarList() {
  const all = [];
  const push = q => {
    if (!q || q.z === undefined) return;     // not grounded yet: its corners are NaN
    const d = dist2(q.x, q.y, P.car.x, P.car.y);
    if (d < 200 * 200) all.push({ d, q });
  };
  for (const q of traffic) push(q);
  for (const q of cops) push(q);
  push(P.car);
  return all;
}
function softCar(g, th, q, box) {
  const p = carBox(q, box);
  if (!p) return;
  const col = parseColour(q.color || '#c8c8c8') || [200, 200, 200];
  const c3 = [col[0] / 255, col[1] / 255, col[2] / 255];
  for (const f of SOFT_FACES) {
    const ax = p[f[0] * 3], ay = p[f[0] * 3 + 1], az = p[f[0] * 3 + 2];
    const bx = p[f[1] * 3], by = p[f[1] * 3 + 1], bz = p[f[1] * 3 + 2];
    const cx2 = p[f[2] * 3], cy2 = p[f[2] * 3 + 1], cz2 = p[f[2] * 3 + 2];
    let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy2 - ay);
    let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az);
    let nz = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if ((ax - G3.cam.ex) * nx + (ay - G3.cam.ey) * ny + (az - G3.cam.ez) * nz > 0) continue;
    const v = [];
    for (const kf of f) v.push(p[kf * 3], p[kf * 3 + 1], p[kf * 3 + 2]);
    softPoly(g, v, softShade(c3, nx, ny, nz, th));
  }
}
