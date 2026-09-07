/* STAGE 1 — OSM elements to a clipped district, in metres.
 *
 * In:  data/belgrade.js
 * Out: build/district.json
 *
 * This is the stage that reuses the game verbatim. parseOSM, the projection,
 * the colour rules and the name rules all come out of js/ through gamesrc.mjs
 * and are not reimplemented here. What this file adds is the three things the
 * browser never has to do:
 *
 *   1. CENTRE THE PROJECTION ON THE DISTRICT, so the slice sits on (0,0) and
 *      Roblox gets its precision headroom for free.
 *   2. CLIP to the district, including cutting road polylines at the boundary
 *      so an arterial reaches the edge instead of stopping at its last vertex
 *      inside it.
 *   3. MAKE THE HEIGHTS REPRODUCIBLE. See deriveHeight() below — this is the
 *      correctness fix flagged in ROBLOX_PORT_PLAN.md §1.5, and it has to
 *      happen before anything downstream caches geometry.
 *
 * Usage: node tools/roblox/1-extract.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { gameSrc, loadCity, hash01 } from './gamesrc.mjs';

const G = gameSrc();
const city = loadCity();

/* The projection origin is the DISTRICT centre, not the city's. With the
   default config they are the same point, but the moment somebody picks a
   different slice this is what keeps it centred on the Roblox origin rather
   than sitting a kilometre off it, quietly spending precision headroom. */
G.setOrigin(CONFIG.centre.lat, CONFIG.centre.lon);

const H = CONFIG.half;
const inside = (x, y) => x >= -H && x <= H && y >= -H && y <= H;

/* ---------------- the element list ----------------

   streets and skeleton overlap: the wide arterial sweep repeats every trunk
   road the detailed centre already has, and world.js says so at the point where
   it gives roads an id for exactly this reason. Deduped here rather than
   downstream, so the road count printed at the end is a real one. */
const seen = new Set();
const els = [];
for (const set of [city.streets, city.buildings, city.skeleton]) {
  for (const el of set || []) {
    const key = el.type + ':' + el.id;
    if (el.id !== undefined && seen.has(key)) continue;
    if (el.id !== undefined) seen.add(key);
    els.push(el);
  }
}

const parsed = G.parseOSM(els);

/* ---------------- heights, made reproducible ----------------

 * world.js:399-403 derives a height from `height`, else `building:levels` *
 * 3.2, else a size heuristic multiplied by rand(.8, 1.35) — and that rand is
 * unseeded. In the bundled city only FOUR of 6,947 buildings carry a real
 * height tag and 4,908 carry levels, so roughly two thousand buildings get a
 * height that is different on every load.
 *
 * The browser does not care. A bake does: two runs would produce two different
 * cities, every downstream file would differ, and the diff of an actual change
 * would be lost in the noise.
 *
 * So the jitter is re-derived here from a hash of the way id. Same formula,
 * same distribution, same look — and the same answer every time. The first two
 * branches are copied from world.js deliberately rather than called, because
 * parseOSM has already collapsed them into a single number by the time we see
 * it and there is no way to ask which branch it took. If world.js changes its
 * storey height, CONFIG.storeyH has to change with it; that is why it is a
 * named constant with a note on it rather than a 3.2 in here.
 */
function deriveHeight(tags, area, id) {
  const t = tags || {};
  if (t.height) {
    const h = parseFloat(t.height);
    if (h > 0 && isFinite(h)) return h;
  }
  if (t['building:levels']) {
    const lv = parseFloat(t['building:levels']);
    if (lv > 0 && isFinite(lv)) return lv * CONFIG.storeyH;
  }
  // the size heuristic, with the unseeded rand replaced by a hash of the id
  const base = G.clamp(5 + Math.sqrt(area) * 0.85, 6, 46);
  return base * (0.8 + hash01(id || 1, 17) * 0.55);
}

/* Tags do not survive parseOSM — it returns drawn buildings, not elements — so
   they are indexed off the raw list to be read back by id. */
const TAGS = new Map();
for (const el of els) if (el.id !== undefined) TAGS.set(el.id, el.tags || {});

/* ---------------- clipping ----------------

 * A ROAD IS CUT AT THE BOUNDARY, not truncated to its last inside vertex. OSM
 * vertices are hundreds of metres apart on an arterial, so truncating leaves
 * visible stumps ending in mid-air a long way short of the district edge —
 * which is exactly the "four raw cut edges" problem, made worse.
 *
 * Runs of inside points are kept, and each entry and exit gets the intersection
 * with the boundary appended, so every road runs cleanly off the edge of the
 * world. One polyline can produce several pieces (a road that leaves and comes
 * back), which is why this returns a list.
 */
function clipLine(pts) {
  const out = [];
  let run = null;
  const cut = (a, b) => {                       // a inside, b outside (or vice versa)
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {              // bisection: exact enough at 1 cm
      const m = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m };
      if (inside(p.x, p.y)) lo = m; else hi = m;
    }
    return { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo };
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], here = inside(p.x, p.y);
    if (here) {
      if (!run) {
        run = [];
        if (i > 0) run.push(cut(p, pts[i - 1]));   // reach back out to the edge
      }
      run.push(p);
    } else if (run) {
      run.push(cut(pts[i - 1], p));                // and out again
      out.push(run); run = null;
    }
  }
  if (run) out.push(run);
  return out.filter(r => r.length >= 2);
}

const R = v => Math.round(v * 100) / 100;        // centimetres; the lattice is 4 m
const pt = p => [R(p.x), R(p.y)];

/* ---------------- roads ---------------- */
const roads = [];
for (const r of parsed.roads) {
  for (const piece of clipLine(r.pts)) {
    roads.push({
      id: r.id, cls: r.cls, w: r.w, drive: !!r.drive,
      name: r.name || '', oneway: !!r.oneway,
      tunnel: !!r.tunnel,
      pts: piece.map(pt)
    });
  }
}

/* ---------------- buildings ----------------

   Kept whole if the centroid is inside, rather than clipped: a footprint cut by
   the boundary would voxelise into a building with one wall missing, which
   looks like a bug rather than like the edge of the map. A little overhang past
   the district line is invisible and costs nothing. */
const buildings = [];
let dropped = 0;
for (const b of parsed.buildings) {
  if (!inside(b.cx, b.cy)) continue;
  const area = Math.abs(G.polyArea(b.pts));
  if (area < CONFIG.minArea) { dropped++; continue; }
  const tags = TAGS.get(b.id);
  const h = G.clamp(deriveHeight(tags, area, b.id), CONFIG.minH, CONFIG.maxH);
  /* AND THE COLOUR IS RECOMPUTED, not taken from parseOSM.
   *
   * buildingColours reads the HEIGHT as one of its inputs — `small = area < 260
   * && h < 14` is what decides pitched tile against a flat grey roof — and
   * parseOSM has already called it with the randomised height that
   * deriveHeight() above exists to replace. Taking b.mRoof would therefore
   * carry the randomness back in through the colour after it had been removed
   * from the height, and the bake would still differ run to run.
   *
   * That is not hypothetical: it is what the first version of this did, and it
   * showed up as one building in ten changing its roof between two runs while
   * every height stayed put. Recomputing here makes the colour agree with the
   * height it was chosen for, which it did not previously do at all. */
  const col = G.buildingColours(tags || {}, area, h, b.id || buildings.length + 1);
  buildings.push({
    id: b.id, h: R(h), area: Math.round(area),
    /* buildingColours returns 0-255 triples, already through the roof's 1.22
       lift. Rounded to integers here: a voxel palette has no use for a
       hundredth of a colour channel, and it makes the palette dedupe in stage 5
       actually collapse. */
    wall: col.mWall.map(v => Math.round(v)),
    roof: col.mRoof.map(v => Math.round(v)),
    name: b.sign || '',
    pts: b.pts.map(pt),
    bb: [R(b.bb.x0), R(b.bb.y0), R(b.bb.x1), R(b.bb.y1)]
  });
}

/* ---------------- archways ----------------
 *
 * A DRIVABLE ROAD THAT RUNS THROUGH A BUILDING IS A PASSAGE, not a mistake in
 * the data. Belgrade is full of them: courtyard gateways, blocks built over a
 * street, covered passages between two wings. OpenStreetMap records the road
 * and the footprint and leaves them overlapping, because in the real world one
 * goes under the other.
 *
 * Without this the city is full of streets that dead-end into a wall you can
 * see the far side of, which is what was reported: "make an archway here, I
 * cannot pass".
 *
 * Ported from markPassable() in js/world.js. The centreline is sampled every
 * six metres, every sample inside a footprint is averaged, and the DIRECTION
 * comes from the road rather than from the geometry -- which is the part that
 * is not obvious. The centre of the crossing sits in the middle of the
 * building, as far from both walls as the passage is deep, so asking "which
 * wall is nearest" finds none. What locates a gateway is the LINE the road
 * takes through it.
 */
const GATE_PAD = 1.0;          // metres of clearance either side of the road
function findGates(roads, buildings) {
  const gates = new Map();     // building id -> gate
  for (const r of roads) {
    if (!r.drive) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        for (const bl of buildings) {
          if (x < bl.bb[0] || x > bl.bb[2] || y < bl.bb[1] || y > bl.bb[3]) continue;
          if (!inPoly(bl.pts, x, y)) continue;
          let g = gates.get(bl.id);
          if (!g) gates.set(bl.id, g = { sx: 0, sy: 0, n: 0, w: 0, ux, uy });
          g.sx += x; g.sy += y; g.n++;
          g.w = Math.max(g.w, r.w / 2 + GATE_PAD);
        }
      }
    }
  }
  const out = {};
  for (const [id, g] of gates)
    out[id] = { x: R(g.sx / g.n), y: R(g.sy / g.n),
                ux: R(g.ux), uy: R(g.uy), w: R(g.w) };
  return out;
}

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

const gates = findGates(roads, buildings);

/* ---------------- parks and points of interest ---------------- */
const parks = parsed.parks
  .filter(p => p.pts.some(q => inside(q.x, q.y)))
  .map(p => ({ pts: p.pts.map(pt) }));

/* The depots the shift system keys off — amenity=police|hospital|fire_station|
   taxi and shop=car_repair (world.js:184). Carried through because M3 needs
   somewhere to sign on, and they cost a few hundred bytes. Casinos are parsed
   by the game but deliberately dropped here: the gambling mechanic does not
   port (ROBLOX_PORT_PLAN.md R12). */
const pois = parsed.pois
  .filter(p => inside(p.x, p.y) && p.kind !== 'casino')
  .map(p => ({ x: R(p.x), y: R(p.y), kind: p.kind, name: p.name || '' }));

/* ---------------- out ---------------- */
const district = {
  meta: {
    source: CONFIG.src,
    centre: CONFIG.centre,
    halfM: H,
    generated: 'tools/roblox/1-extract.mjs',
    note: 'metres, +x east, +y south, origin at the district centre'
  },
  roads, buildings, parks, pois, gates
};

mkdirSync(CONFIG.out, { recursive: true });
writeFileSync(`${CONFIG.out}/district.json`, JSON.stringify(district));

const km = roads.reduce((a, r) => {
  let d = 0;
  for (let i = 1; i < r.pts.length; i++)
    d += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
  return a + d;
}, 0) / 1000;
const hs = buildings.map(b => b.h).sort((a, b) => a - b);

console.log(`extract: ${2 * H} x ${2 * H} m centred on ${CONFIG.centre.lat}, ${CONFIG.centre.lon}`);
console.log(`  roads      ${roads.length} pieces, ${km.toFixed(1)} km of centreline`);
console.log(`  buildings  ${buildings.length}  (${dropped} dropped under ${CONFIG.minArea} m2)`);
console.log(`  heights    median ${hs[hs.length >> 1]} m, p90 ${hs[Math.floor(hs.length * .9)]} m, max ${hs[hs.length - 1]} m`);
console.log(`  parks      ${parks.length}   depots ${pois.length}`);
console.log(`  archways   ${Object.keys(gates).length} buildings with a road through them`);
