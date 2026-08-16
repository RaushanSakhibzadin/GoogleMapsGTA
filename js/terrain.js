"use strict";
/* VICE MAPS — The ground has a shape now: hills, crests and the grades between them.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes before
   entities.js, because the driving physics reads the grade under the car.

   WHY THIS IS INVENTED AND NOT DOWNLOADED. Every other thing in this game is
   real: the roads are the real roads, the buildings are the real buildings at
   their real heights. Elevation could be real too — the Terrarium tiles on S3
   are open and free — but it would be a SECOND network dependency on the loading
   path, with its own mirrors, its own timeouts and its own way of arriving
   half-empty, bolted onto a load sequence that already spends most of its
   engineering budget surviving Overpass. That is a trade worth making later and
   on purpose, behind the same retry ladder as everything else. It is not worth
   making by accident, today, to get hills.

   So: coherent value noise, seeded from the city's own coordinates, which means
   a given place always has the same hills and two people driving Belgrade see
   the same crest on the same street. The wavelengths are chosen against the
   thing that has to stay true — a car doing 300 km/h has to be able to read the
   road ahead — so the biggest feature is two kilometres across and the smallest
   is a quarter of one. Grades top out around one in six, which is steep for a
   road and gentle for a ski slope.

   THE FLAT CASE IS THE 2D GAME. TERRAIN is off unless the 3D view is on, and
   with it off terrainH() is a constant zero on a branch the JIT removes. The
   2D game's physics, and every test tuned against it, are untouched. */

let TERRAIN = false;

/* Amplitude in metres against wavelength in metres. The steepest a sine of these
   can be is 2πA/λ, so the octaves peak at 6.3%, 5.6% and 4.8% and can only stack
   to about one in six where all three happen to agree. */
const TERR_OCT = [
  { wl: 2200, amp: 22 },      // which side of the valley a district is on
  { wl:  700, amp:  6.2 },    // the hill your street goes over
  { wl:  240, amp:  1.8 }     // the dip under a junction; what makes a car float
];

/* Seeded per city, so the hills belong to the place rather than to the session.
   Two players typing the same city get the same map; reloading does not reshuffle
   the ground under you. */
let TERR_SEED = 1;
function terrainSeed() {
  try {
    // 0.01° is about a kilometre — near enough that a nudged search term keeps
    // the same landscape, far enough that two cities never collide
    const a = Math.round((GEO.lat0 || 0) * 100), b = Math.round((GEO.lon0 || 0) * 100);
    TERR_SEED = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263)) >>> 0;
  } catch (e) { TERR_SEED = 1; }
  TCACHE.k = null;
  return TERR_SEED;
}

// integer hash -> 0..1. Math.imul because a plain * silently leaves 32-bit space
// and the low bits stop being random, which shows up as visible banding.
function thash(ix, iy) {
  let n = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ TERR_SEED;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/* One octave of value noise, smoothstepped so the surface has no creases —
   a crease is a step in the gradient, and a step in the gradient is a car
   launched off nothing. */
function vnoise(x, y, wl) {
  const fx = x / wl, fy = y / wl;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = thash(ix, iy), b = thash(ix + 1, iy);
  const c = thash(ix, iy + 1), d = thash(ix + 1, iy + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

/* Height in metres. Zero everywhere when the 3D view is off, which is what keeps
   the 2D game exactly the game it was. */
function terrainH(x, y) {
  if (!TERRAIN) return 0;
  let h = 0;
  for (let i = 0; i < TERR_OCT.length; i++) {
    const o = TERR_OCT[i];
    h += (vnoise(x, y, o.wl) * 2 - 1) * o.amp;
  }
  return h;
}

/* Height and slope together, because everything that wants one wants the other.
   Central differences over 3 m: shorter than that and it reads the noise floor
   of the smallest octave, longer and a car notices the lag over a crest.

   Cached for one sample point, which is worth it because the physics asks for
   the same spot two or three times in a step — the grade for the engine, the
   attitude for the body, the ground height for the wheels. */
const TCACHE = { k: null, h: 0, gx: 0, gy: 0 };
function terrainGrad(x, y) {
  const k = (x * 4 | 0) + ',' + (y * 4 | 0);
  if (TCACHE.k === k) return TCACHE;
  const e = 3;
  TCACHE.k = k;
  TCACHE.h = terrainH(x, y);
  TCACHE.gx = (terrainH(x + e, y) - terrainH(x - e, y)) / (2 * e);
  TCACHE.gy = (terrainH(x, y + e) - terrainH(x, y - e)) / (2 * e);
  return TCACHE;
}
