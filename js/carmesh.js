"use strict";
/* VICE MAPS — the car, as an actual mesh.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes after gl.js and
   before render3d.js, which is the only file that uses it.

   WHY THIS IS NOT A DOWNLOADED MODEL. The obvious answer to "make the cars look
   like cars" is a CC0 low-poly model, and the right one exists: Kenney's Car
   Kit, public domain, sedans and hatchbacks with the parts kept separate. Two
   things stop it being used directly, and both are worth writing down because
   they will still be true next time.

   The first is that a browser opened on a file:// URL cannot fetch a sibling
   file. No .obj, no .gltf, no .json — the request is cross-origin against a null
   origin and it is refused. Everything this game loads from disk is therefore a
   .js file with the data inlined, which is why data/belgrade.js is a script and
   not a JSON document. Any model has to be baked into that shape by a tool
   first, which is what tools/glb2car.py does.

   The second is the paint. Every car in traffic picks its own colour, and the
   ready-made kits are built around a single shared texture atlas — body, glass
   and tyres are one material, told apart by where they land on a colour map. Run
   that through this game and every car is the same colour, or nothing is
   coloured at all. A model that works here has to keep its parts separable, and
   that is a property of how it was authored rather than of the format.

   So the geometry below is authored here, in the same low-poly idiom, with a
   material index per vertex. It is data, not drawing code: an imported model is
   the same three arrays, and render3d.js cannot tell the difference. */

/* ------------------------------ the palette ------------------------------ */
/* Slot 0 is the car's own paint and is set per car. The rest are fixed, and
   fixed is the point — a tyre is a tyre on a pink car and on a police car. */
const CAR_PAINT = 0, CAR_GLASS = 1, CAR_TYRE = 2, CAR_HUB = 3,
      CAR_TAIL = 4, CAR_HEAD = 5, CAR_TRIM = 6;
const CAR_PAL = [
  null,               // 0: paint, per car
  [.11, .13, .17],    // 1: glass
  [.045, .045, .05],  // 2: tyre
  [.42, .44, .47],    // 3: wheel hub
  [.85, .07, .06],    // 4: tail light
  [.98, .96, .84],    // 5: head light
  [.13, .13, .14]     // 6: bumpers, sills, underside
];

/* ------------------------------ local space ------------------------------ */
/* x runs forward, -1 at the rear bumper to +1 at the nose. y runs up from the
   road at 0 to the top of the collision cuboid at 2. z is lateral, ±1 at the
   widest the body is allowed to be.

   Those are the SAME axes carBox lays its eight corners out on, which is what
   lets render3d.js build a model matrix straight out of them: the car's own
   forward, up and lateral vectors already carry its heading, its pitch and its
   roll, so a barrel-rolling car brings its wheels and its windows with it and
   nothing can drift out of alignment.

   The metre values behind the numbers assume a 4.0 m × 1.75 m × 1.45 m
   hatchback, which is a Belgrade street's median vehicle near enough. One y unit
   is 0.725 m and one x unit is 2 m; that is why the wheel below is an ellipse in
   local coordinates and a circle once it is drawn. */
const CAR_UY = 0.725, CAR_UX = 2.0;

/* Each station is a slice across the car at one x. The six heights are the
   underside, the sill, the hip — where the body is widest — the beltline where
   the paint stops, and the roof; each with its own half-width. `g` marks how
   much of a glasshouse this slice is: 1 inside the cabin, 0.5 at the windscreen
   and the tailgate, 0 over the bonnet and the boot. A face between two stations
   is glass when the pair sums to 1 or more, which puts glass on the four sides
   of the cabin and on the two raked ends and nowhere else. */
const CAR_STATIONS = [
  /* A HATCHBACK'S PROPORTIONS, WHICH ARE NOT A SEDAN'S, and the first version of
     this table was a sedan without meaning to be. Its cabin ran from -0.70 to
     +0.40 with a bonnet the same length again in front of it, and the result read
     as a long low saloon — recognisably a car, and not the car in the reference
     photograph.

     What separates the two is where the cabin sits, not how big it is. On a
     4.5 m hatchback the front overhang and bonnet together are about 1.8 m, the
     cabin is 2.0, and there is barely 0.7 behind it: the glasshouse starts early
     and finishes at the back axle. So the cabin moved rearward and the bonnet
     lost a third of its length, and the tailgate drops through nearly forty
     degrees over the last half metre instead of easing down like a fastback. */
  // x      yU   wU    ySill wSill  yHip  wHip  yBelt wBelt  yRoof wRoof  g
  [-1.00, 0.36, 0.46,  0.60, 0.70,  0.98, 0.80,  1.34, 0.72,  1.34, 0.40, 0.0],
  [-0.88, 0.30, 0.54,  0.55, 0.84,  0.99, 0.96,  1.41, 0.90,  1.68, 0.62, 0.5],
  [-0.72, 0.29, 0.56,  0.54, 0.87,  1.00, 1.00,  1.43, 0.94,  1.94, 0.72, 1.0],
  [-0.34, 0.29, 0.56,  0.54, 0.87,  1.00, 1.00,  1.44, 0.94,  2.00, 0.76, 1.0],
  [ 0.00, 0.29, 0.56,  0.54, 0.87,  1.00, 1.00,  1.44, 0.94,  2.00, 0.76, 1.0],
  [ 0.22, 0.29, 0.56,  0.55, 0.86,  0.99, 0.99,  1.42, 0.92,  1.92, 0.72, 1.0],
  [ 0.52, 0.30, 0.54,  0.56, 0.84,  0.97, 0.96,  1.36, 0.88,  1.46, 0.58, 0.5],
  [ 0.80, 0.32, 0.50,  0.59, 0.78,  0.94, 0.90,  1.30, 0.80,  1.38, 0.48, 0.0],
  [ 1.00, 0.38, 0.42,  0.66, 0.62,  0.90, 0.74,  1.22, 0.64,  1.30, 0.32, 0.0]
];

/* The ring, as ten points round one station. Counter-clockwise seen from the
   nose, starting under the near side and closing back across the underside, so
   every face comes out with its normal pointing outwards without a special case.
   Each entry is [which height/width pair, which side]. */
const CAR_RING = [
  [0, -1], [1, -1], [2, -1], [3, -1], [4, -1],
  [4,  1], [3,  1], [2,  1], [1,  1], [0,  1]
];
// what each of the ten faces between one ring point and the next is made of
const CAR_RING_MAT = [CAR_TRIM, CAR_PAINT, CAR_PAINT, CAR_PAINT, CAR_PAINT,
                      CAR_PAINT, CAR_PAINT, CAR_PAINT, CAR_TRIM, CAR_TRIM];

/* ------------------------------ building it ------------------------------ */
function carMeshBuild() {
  const v = [];
  /* One triangle: three positions, a flat face normal worked out from them, and
     a material. Flat, deliberately — this is a faceted low-poly car and smoothed
     normals across a hard crease would make it look like melted plastic. */
  const tri = (a, b, c, m) => {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;                 // a degenerate slice contributes nothing
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) v.push(p[0], p[1], p[2], nx, ny, nz, m);
  };
  const quad = (a, b, c, d, m) => { tri(a, b, c, m); tri(a, c, d, m); };

  // every ring point of every station, in world-of-the-car coordinates
  const rings = CAR_STATIONS.map(s => CAR_RING.map(([k, side]) => {
    const y = s[1 + k * 2], w = s[2 + k * 2];
    return [s[0], y, w * side];
  }));

  /* THE BODY. Ten faces between each pair of neighbouring stations. Which of
     them is glass is decided by the pair, not by either station on its own:
     inside the cabin the sides are glass and the roof between them is paint,
     while at the windscreen and the tailgate the whole upper band is glass and
     the two side faces are the pillars holding it. */
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1];
    const gs = CAR_STATIONS[i][11] + CAR_STATIONS[i + 1][11];
    for (let e = 0; e < 10; e++) {
      const f = (e + 1) % 10;
      let m = CAR_RING_MAT[e];
      if (gs >= 2) { if (e === 3 || e === 5) m = CAR_GLASS; }         // cabin sides
      else if (gs >= 1) { if (e >= 3 && e <= 5) m = CAR_GLASS; }      // raked ends
      quad(A[e], A[f], B[f], B[e], m);
    }
  }
  // the two ends, closed with a fan from the middle of the ring
  for (const [idx, flip] of [[0, true], [rings.length - 1, false]]) {
    const R = rings[idx];
    let cx = 0, cy = 0, cz = 0;
    for (const q of R) { cx += q[0]; cy += q[1]; cz += q[2]; }
    const mid = [cx / 10, cy / 10, cz / 10];
    /* BANDED BY HEIGHT, NOT BY RING INDEX. A fan meets at a point, so choosing
       the material per spoke paints radial wedges — the first version put a dark
       bowtie across the whole back of every car, which is exactly what a fan
       does when you colour it like a strip. Asking where the triangle SITS
       instead lines the boundaries up horizontally, and a car's back end really
       is horizontal bands: bumper, panel, glass. */
    /* BANDED BY HEIGHT, NOT BY RING INDEX. A fan meets at a point, so choosing
       the material per spoke paints radial wedges — an earlier version put a
       dark bowtie across the whole back of every car, which is exactly what a
       fan does when you colour it like a strip. Asking where the triangle SITS
       instead lines the boundaries up horizontally, which is how a car's back
       end really is divided.

       Only two bands here, glass over paint. The bumper is not painted on: it is
       the bar built below, standing proud of this surface the way a real one
       does, which is both more convincing and the only way to be rid of the last
       of the wedges. */
    const st = CAR_STATIONS[idx], hi = st[5];
    for (let e = 0; e < 10; e++) {
      const f = (e + 1) % 10;
      const my = (mid[1] + R[e][1] + R[f][1]) / 3;
      const m = my > hi ? CAR_GLASS : CAR_PAINT;
      flip ? tri(mid, R[f], R[e], m) : tri(mid, R[e], R[f], m);
    }
  }

  /* THE WHEELS. Ten-sided, which is enough to stop reading as a polygon at the
     distance you ever see one and cheap enough to put four on every car in
     traffic. The circle is an ellipse in these coordinates because one unit
     along x is 2 m and one unit up is 0.725 — a wheel authored as a circle here
     would come out as a long oval on the road. */
  const R_M = 0.315;                                    // wheel radius, in metres
  const rx = R_M / CAR_UX, ry = R_M / CAR_UY;
  const SEG = 10;
  for (const ax of [-0.60, 0.60]) for (const side of [-1, 1]) {
    const zi = side * 0.86, zo = side * 1.04;           // inner face, outer face
    const hub = 0.46;                                   // how much of the face is alloy
    const p = a => [ax + Math.cos(a) * rx, ry + Math.sin(a) * ry, 0];
    for (let i = 0; i < SEG; i++) {
      const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
      const q0 = p(a0), q1 = p(a1);
      const i0 = [q0[0], q0[1], zi], i1 = [q1[0], q1[1], zi];
      const o0 = [q0[0], q0[1], zo], o1 = [q1[0], q1[1], zo];
      // the tread, wound so it faces outwards on both sides of the car
      side < 0 ? quad(i0, i1, o1, o0, CAR_TYRE) : quad(o0, o1, i1, i0, CAR_TYRE);
      // the outer face: a tyre wall with an alloy disc inside it
      const h0 = [ax + (q0[0] - ax) * hub, ry + (q0[1] - ry) * hub, zo];
      const h1 = [ax + (q1[0] - ax) * hub, ry + (q1[1] - ry) * hub, zo];
      const mid = [ax, ry, zo];
      if (side < 0) {
        quad(o0, o1, h1, h0, CAR_TYRE); tri(mid, h1, h0, CAR_HUB);
      } else {
        quad(h0, h1, o1, o0, CAR_TYRE); tri(mid, h0, h1, CAR_HUB);
      }
    }
  }

  /* THE BUMPERS. A bar across each end, standing a little proud of the bodywork
     and wrapping round the corners, which is what stops the ends looking like
     the flat lid of a box. It is also what lets the end caps above be nothing
     but paint and glass. */
  const bar = (x0, x1, z, y0, y1) => {
    const pts = [];
    for (const u of [0, 1]) for (const [a2, b2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      pts.push([a2 < 0 ? x0 : x1, u ? y1 : y0, b2 < 0 ? -z : z]);
    // the six faces of the bar, wound outwards
    const F = [[0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [6, 7, 3, 2], [5, 6, 2, 1], [7, 4, 0, 3]];
    for (const f of F) quad(pts[f[0]], pts[f[1]], pts[f[2]], pts[f[3]], CAR_TRIM);
  };
  bar(-1.045, -0.90, 0.80, 0.52, 0.88);
  bar(0.90, 1.045, 0.72, 0.54, 0.88);

  /* THE LIGHTS, sitting just proud of the end caps so they cannot z-fight with
     the bodywork they are set into. Small, and worth every triangle: a pair of
     red rectangles at the back is most of what makes a car in front of you read
     as a car rather than as a coloured shape. */
  /* THE Z ORDER IS SORTED BEFORE THE WINDING IS DECIDED, and leaving that out
     cost one of the two tail lights. The right-hand pair is the mirror of the
     left, so its two z values arrive in the opposite order, which reverses the
     quad's winding on its own — and back-face culling then removed exactly one
     lamp of each pair while the other looked perfect. A car with one brake light
     is the kind of thing that is invisible in a wide shot and obvious the moment
     anybody looks. */
  const lamp = (x, nx, za, zb, y0, y1, m) => {
    const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
    const a = [x, y0, z0], b = [x, y0, z1], c = [x, y1, z1], d = [x, y1, z0];
    nx > 0 ? quad(d, c, b, a, m) : quad(a, b, c, d, m);
  };
  for (const s of [-1, 1]) {
    lamp(-1.012, -1, s * 0.34, s * 0.70, 0.98, 1.30, CAR_TAIL);
    lamp(1.012, 1, s * 0.32, s * 0.68, 0.94, 1.18, CAR_HEAD);
  }
  return new Float32Array(v);
}

/* Built once, on first use, and kept. It is about four hundred triangles — the
   arithmetic is nothing, but it is nothing that has no reason to happen twice,
   and nothing at all for a player who never opens the 3D view.

   AN IMPORTED MODEL WINS IF THERE IS ONE. tools/glb2car.py bakes a glTF or GLB
   into js/carmodel.js as exactly these seven floats per vertex, in exactly these
   coordinates; load that file before this one in index.html and the renderer
   never knows the difference. That is the whole extension point — no loader
   shipped to the player, no fetch that file:// would refuse anyway, and the
   hand-built car still there as the default for a checkout with no asset in it. */
let CAR_MESH = null;
function carMesh() {
  if (!CAR_MESH)
    CAR_MESH = (typeof CAR_MODEL !== 'undefined' && CAR_MODEL && CAR_MODEL.length)
      ? CAR_MODEL : carMeshBuild();
  return CAR_MESH;
}
