"use strict";
/* VICE MAPS — The world: parsing OSM, the spatial indexes, tile streaming, landmarks.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 3. world ------------------------------ */
const W = {
  roads: [], buildings: [], parks: [],
  minX: 0, minY: 0, maxX: 0, maxY: 0,
  places: [],                            // named districts / neighbourhoods
  pois: [],                              // police stations, hospitals, repair shops
  sweptTo: 0, sweeping: false,           // how many rungs of the landmark sweep have run
  cell: 8, gw: 0, gh: 0, grid: null,     // drivable mask
  bcell: 90, buckets: new Map(),         // building spatial hash
  rbuckets: new Map(),                   // road spatial hash (named roads only)
  vcell: 256, vbuckets: new Map(),       // road spatial hash for view culling (all roads)
  dcell: 300, dbuckets: new Map(),       // drivable roads, for spawning and snapping
  roadIds: new Set(),                    // every way already in the world, so none lands twice
  skelRect: null,                        // the wide arterial box, if one landed
  tiles: new Map(), fixed: new Set(),    // streamed tiles; the ones that predate play are permanent
  map: null, mapScale: 1,                // pre-rendered minimap
  mapOrigin: { x: 0, y: 0 },             // world point the pre-render's top-left corner is
  procedural: false, name: ''
};

function bbox(pts) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; }
  return { x0: a, y0: b, x1: c, y1: d };
}
function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(s) / 2;
}
function centroid(pts) {
  let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/* Pick a facade + roof colour for one building, preferring what mappers actually
   recorded and falling back through material, then use, then size. */
function buildingColours(t, area, h, seed) {
  const r = (n) => {                       // deterministic per building, so a
    const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);              // street doesn't reshuffle on reload
  };
  const use = t.building || t['building:part'] || 'yes';
  const takeFrom = (pal, n) => pal[Math.floor(r(n) * pal.length)];

  // 1. explicit colours
  let wall = parseColour(t['building:colour'] || t['building:color'] || t.colour);
  let roof = parseColour(t['roof:colour'] || t['roof:color']);

  // 2. declared materials
  const wm = (t['building:material'] || t.material || '').toLowerCase();
  if (!wall && MAT[wm]) wall = takeFrom(MAT[wm], 1);
  const rm = (t['roof:material'] || '').toLowerCase();
  const RM = { tile: 'tile', roof_tiles: 'tile', clay: 'tile', slate: 'slate', metal: 'metalroof',
               copper: 'metalroof', concrete: 'gravel', gravel: 'gravel', tar_paper: 'asphalt',
               asphalt: 'asphalt', bitumen: 'asphalt' }[rm];
  if (!roof && RM) roof = takeFrom(ROOFMAT[RM], 2);

  // 3. what the building is for
  if (!wall) {
    let pal = MAT.stucco;
    if (/^(house|detached|semidetached_house|bungalow|terrace)$/.test(use)) pal = r(9) < .35 ? MAT.brick : (r(8) < .5 ? MAT.stucco : MAT.wood);
    else if (/^(apartments|residential|dormitory)$/.test(use)) pal = r(7) < .3 ? MAT.brick : MAT.stucco;
    else if (/^(commercial|retail|office|hotel|supermarket)$/.test(use)) pal = h > 40 ? MAT.glass : MAT.concrete;
    else if (/^(industrial|warehouse|garage|garages|shed|hangar)$/.test(use)) pal = MAT.metal;
    else if (/^(church|cathedral|civic|school|university|hospital|public|museum)$/.test(use)) pal = MAT.stone;
    // 4. nothing to go on — size and height are the only hints left
    else pal = h > 45 ? MAT.glass : (area > 900 ? MAT.concrete : (r(6) < .18 ? MAT.pastel : MAT.stucco));
    wall = takeFrom(pal, 3);
  }
  if (!roof) {
    const small = area < 260 && h < 14;
    // pitched tile on houses, flat asphalt/gravel/membrane on everything larger
    roof = small && r(4) < .6 ? takeFrom(ROOFMAT.tile, 5)
         : takeFrom(h > 45 ? ROOFMAT.metalroof : (r(5) < .45 ? ROOFMAT.gravel : (r(11) < .5 ? ROOFMAT.asphalt : ROOFMAT.membrane)), 6);
  }
  // roofs read brighter than the true material so the top-down view doesn't go to mush
  return { mWall: wall, mRoof: mul(roof, 1.22) };
}

// police reuses the blue the cop blips already use, so the radar reads consistently
const POI_COL = { police: '#3fa2ff', hospital: '#ff4f6d', repair: '#48ff9e' };
const POI_KIND = t => t.amenity === 'police' ? 'police'
                    : t.amenity === 'hospital' ? 'hospital'
                    : t.shop === 'car_repair' ? 'repair' : null;

function parseOSM(els) {
  const roads = [], buildings = [], parks = [], places = [], pois = [];
  for (const el of els) {
    const t = el.tags || {};

    // place nodes give us neighbourhood / district names
    if (el.type === 'node') {
      if (t.place && t.name) {
        places.push({ x: projX(el.lon), y: projY(el.lat), name: t.name, kind: t.place });
      }
      const pk = POI_KIND(t);
      if (pk) pois.push({ x: projX(el.lon), y: projY(el.lat), kind: pk, name: t.name || '', cool: 0 });
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map(g => ({ x: projX(g.lon), y: projY(g.lat) }));

    // A station or a hospital is usually a building too, so this records the
    // point of interest and then falls through to draw the building as normal.
    const pk = POI_KIND(t);
    if (pk) { const c = centroid(pts); pois.push({ x: c.x, y: c.y, kind: pk, name: t.name || '', cool: 0 }); }

    if (t.highway) {
      const cls = ROADW[t.highway] ? t.highway : 'residential';
      const layer = parseInt(t.layer || t.level || '0', 10) || 0;
      // The OSM id travels with the road so the same way can't be added twice.
      // It arrives twice routinely now: the wide skeleton repeats every trunk road
      // the detailed centre already has, and a way lying on a tile seam comes with
      // both tiles.
      roads.push({ id: el.id, pts, cls, w: ROADW[cls], drive: DRIVABLE(cls), bb: bbox(pts),
                   oneway: t.oneway === 'yes', name: t.name || t.ref || '',
                   tunnel: !!t.tunnel && t.tunnel !== 'no', covered: t.covered === 'yes',
                   layer });
    } else if (t.building || t['building:part']) {
      if (pts.length < 4) continue;
      const a = polyArea(pts);
      if (a < 22) continue;                        // skip sheds / noise
      let h = 0;
      if (t.height) h = parseFloat(t.height) || 0;
      else if (t['building:levels']) h = (parseFloat(t['building:levels']) || 0) * 3.2;
      if (!h || !isFinite(h)) h = clamp(5 + Math.sqrt(a) * 0.85, 6, 46) * rand(.8, 1.35);
      h = clamp(h, 4, 190);
      const c = centroid(pts);
      const col = buildingColours(t, a, h, el.id || buildings.length + 1);
      // neon is now the exception, and only on things that would really carry a sign
      const signable = /^(commercial|retail|office|hotel|supermarket)$/.test(t.building || '') || a > 700;
      // The id travels with it for the same reason roads carry theirs: overlapping
      // requests return the same way more than once, and a doubled footprint is
      // drawn twice, collides twice, and only the first copy is marked passable —
      // so an archway you could drive through becomes a wall you cannot.
      buildings.push({ id: el.id, pts, h, bb: bbox(pts), cx: c.x, cy: c.y,
                       mWall: col.mWall, mRoof: col.mRoof, wall: '#333', roof: '#666',
                       neon: (signable && Math.random() < .22) ? pick(PAL.neon) : null });
    } else if (t.leisure || t.landuse) {
      parks.push({ pts, bb: bbox(pts) });
    }
  }
  return { roads, buildings, parks, places, pois };
}

/* The wide landmark sweep asks for `out center`, so a way arrives as a single
   point rather than an outline. Parsed on its own rather than through parseOSM,
   which would see a way with no geometry and drop it. */
function parsePOIs(els) {
  const out = [];
  for (const el of els) {
    const kind = POI_KIND(el.tags || {});
    if (!kind) continue;
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lon = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lon == null) continue;
    out.push({ x: projX(lon), y: projY(lat), kind, name: (el.tags || {}).name || '', cool: 0 });
  }
  return out;
}

const FAKE_ST =['Ocean Drive', 'Vice Boulevard', 'Sunshine Avenue', 'Flamingo Way',
  'Palm Parkway', 'Neon Street', 'Marina Road', 'Sunset Strip', 'Coral Avenue',
  'Bayshore Drive', 'Starfish Lane', 'Chrome Street', 'Lagoon Road'];
const FAKE_ZONE = ['Downtown', 'Little Habana', 'Beachfront', 'The Docks', 'Vice Point'];

/* A neon grid city, for when the network is down or the map is all ocean. */
/* THE BUNDLED CITY — central Belgrade, real OpenStreetMap data, shipped with the
   game and loaded when the map servers cannot be reached.

   It replaces the generated grid, which was only ever a way of not showing an
   error screen: a place with real streets, real junctions and four thousand real
   buildings is a far better offline game than a lattice, and it is the same data
   the online path builds from, so nothing downstream can tell the difference.

   Pulled in ON DEMAND, as a <script> tag rather than a fetch. Three megabytes
   has no business loading on the normal path, and fetch() is refused for
   file:// URLs while a script tag is not — opening index.html straight off disk
   has to keep working. Kept to one attempt: if it will not load, the generated
   city is still there underneath. */
let offlinePromise = null;
function loadOfflineCity() {
  if (window.OFFLINE_CITY) return Promise.resolve(window.OFFLINE_CITY);
  if (offlinePromise) return offlinePromise;
  offlinePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'data/belgrade.js';
    s.onload = () => window.OFFLINE_CITY ? resolve(window.OFFLINE_CITY)
                                         : reject(new Error('offline city empty'));
    s.onerror = () => reject(new Error('offline city missing'));
    document.head.appendChild(s);
  });
  return offlinePromise;
}

/* Its streets and buildings, projected about its own centre. The caller has
   already given up on where the player asked for, so the origin moves to
   Belgrade — leaving it where it was would scatter the geometry hundreds of
   kilometres from the car. */
function offlineCityData(city) {
  setOrigin(city.lat, city.lon);
  return parseOSM(city.streets.concat(city.buildings));
}

/* Nothing streams into the bundled city. It is not procedural — it is a real
   place with real tiles — so without this the streamer would happily ask for
   neighbouring districts from the very servers we just failed to reach, once
   per tile boundary, for the whole session. */
function bundledCity() { W.bundled = true; }

// and its arterials, merged exactly as a downloaded skeleton would be
function offlineSkeleton(city) {
  const data = parseOSM(city.skeleton);
  if (!data.roads.length) return null;
  const R = city.skeletonRadius;
  W.skelRect = { x0: -R, y0: -R, x1: R, y1: R };
  const added = mergeChunk(data, 'skel');
  return { radius: R, roads: added, places: data.places.length };
}

function proceduralCity() {
  const roads = [], buildings = [], parks = [], places = [];
  const N = 6, S = 150;
  const ord = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  for (let i = -N; i <= N; i++) {
    const big = i % 3 === 0;
    const cls = big ? 'secondary' : 'residential';
    const j1 = -N * S, j2 = N * S;
    // north–south are numbered avenues, east–west carry names, like a real grid city
    roads.push({ pts: [{ x: i * S, y: j1 }, { x: i * S, y: j2 }], cls, w: ROADW[cls], drive: true,
                 name: ord(i + N + 1) + ' Avenue' });
    roads.push({ pts: [{ x: j1, y: i * S }, { x: j2, y: i * S }], cls, w: ROADW[cls], drive: true,
                 name: FAKE_ST[(i + N) % FAKE_ST.length] });
  }
  for (const r of roads) r.bb = bbox(r.pts);

  // districts at the quadrant centres, so the zone banner works offline too
  const q = N * S * .55;
  places.push({ x: 0, y: 0, name: FAKE_ZONE[0], kind: 'suburb' });
  places.push({ x: -q, y: -q, name: FAKE_ZONE[1], kind: 'neighbourhood' });
  places.push({ x: q, y: -q, name: FAKE_ZONE[2], kind: 'neighbourhood' });
  places.push({ x: -q, y: q, name: FAKE_ZONE[3], kind: 'neighbourhood' });
  places.push({ x: q, y: q, name: FAKE_ZONE[4], kind: 'neighbourhood' });

  for (let i = -N; i < N; i++) for (let j = -N; j < N; j++) {
    const bx = i * S + 16, by = j * S + 16, bw = S - 32, bh = S - 32;
    if (Math.random() < .1) { // a park block
      const pts = [{ x: bx, y: by }, { x: bx + bw, y: by }, { x: bx + bw, y: by + bh }, { x: bx, y: by + bh }];
      parks.push({ pts, bb: bbox(pts) }); continue;
    }
    const cols = randi(1, 3), rows = randi(1, 3);
    for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
      const m = 5;
      const x0 = bx + a * bw / cols + m, y0 = by + b * bh / rows + m;
      const x1 = bx + (a + 1) * bw / cols - m, y1 = by + (b + 1) * bh / rows - m;
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      const pts = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const d = Math.hypot(bx, by);
      const h = clamp(rand(8, 40) + Math.max(0, 400 - d) * .12, 6, 130);
      const c = centroid(pts);
      const area = (x1 - x0) * (y1 - y0);
      // no tags to go on out here, so let the size/height fallbacks pick the material
      const col = buildingColours({}, area, h, buildings.length + 1);
      buildings.push({ pts, h, bb: bbox(pts), cx: c.x, cy: c.y,
        mWall: col.mWall, mRoof: col.mRoof, wall: '#333', roof: '#666',
        neon: (area > 700 && Math.random() < .22) ? pick(PAL.neon) : null });
    }
  }
  // Nothing out here carries OSM tags, so the landmarks are invented the same way
  // the street and district names are. On a real map they are only ever real ones.
  const pois = [
    { x: -S, y: -S, kind: 'police', name: 'Vice PD', cool: 0 },
    { x: 2 * S, y: S, kind: 'hospital', name: 'Ocean View Medical', cool: 0 },
    { x: S, y: -2 * S, kind: 'repair', name: 'Pay ’n’ Spray', cool: 0 },
    { x: -3 * S, y: 2 * S, kind: 'repair', name: 'Chrome & Lights', cool: 0 },
  ];
  return { roads, buildings, parks, places, pois };
}

/* ---- indexing, written so it can run over a whole world or just a new chunk ---- */

/* THE MASK IS TWO BITS A CELL, packed four to a byte.

   At 8 m cells a 36 km world is 4,510 squared — twenty million cells, and a byte
   each was fine. A 72 km world is 9,010 squared: eighty-one million cells, and
   eighty-one megabytes of Uint8Array is not something to ask a phone for on top
   of thirty megabytes of map JSON. Two bits hold everything this ever stored —
   0 nothing, 1 road, 2 tarmac-but-not-road — and bring the same world down to
   twenty megabytes at the same eight metre resolution. Coarsening the cells
   instead would have been less code and worse: at 16 m a residential street
   marks sixteen metres either side of its centreline, and the whole point of
   the off-road penalty is knowing where the road stops. */
const gridGet = i => (W.grid[i >> 2] >> ((i & 3) << 1)) & 3;
function gridSet(i, v) {
  const b = i >> 2, sh = (i & 3) << 1;
  W.grid[b] = (W.grid[b] & ~(3 << sh)) | (v << sh);
}

// Grow the drivable mask to cover new bounds.
function fitGrid(x0, y0, x1, y1) {
  const pad = 40;
  const nMinX = Math.min(W.minX, x0 - pad), nMinY = Math.min(W.minY, y0 - pad);
  const nMaxX = Math.max(W.maxX, x1 + pad), nMaxY = Math.max(W.maxY, y1 + pad);
  if (W.grid && nMinX === W.minX && nMinY === W.minY && nMaxX === W.maxX && nMaxY === W.maxY) return false;

  const gw = Math.ceil((nMaxX - nMinX) / W.cell), gh = Math.ceil((nMaxY - nMinY) / W.cell);
  /* Fresh and empty — the old marks are NOT carried across. They used to be, by
     blitting row by row, and that faithfully preserved the hole every road left
     when it ran off the edge of the smaller mask. Every caller re-marks after a
     grow for exactly that reason, so the blit was already doing nothing but
     hiding the bug, and packed rows do not begin on byte boundaries anyway. */
  W.minX = nMinX; W.minY = nMinY; W.maxX = nMaxX; W.maxY = nMaxY;
  W.gw = gw; W.gh = gh;
  W.grid = new Uint8Array(Math.ceil(gw * gh / 4));
  return true;
}

/* THE MASK HOLDS TWO KINDS OF GROUND: 1 is drivable tarmac, 2 is tarmac that is
   drawn but not part of the road network — pedestrian streets and tracks.

   They matter now. Every one of them is painted with the same kerb, casing and
   colour as a road, and OSM maps a city square as `highway=pedestrian`, which
   this draws as one very wide stroke. Before the off-road penalty existed the
   difference cost nothing, because off the road was 96 km/h anyway. Now a car
   standing in the middle of a drawn square is a car that crawls on what is
   plainly tarmac — which is exactly what a screenshot of a Belgrade junction
   showed at 12 km/h.

   Kept as a separate value rather than folded into 1, because `onRoad()` feeds
   traffic grip, pedestrian kerb-avoidance and spawning, and none of those should
   start treating a pedestrian square as a road. Only the player's off-road
   penalty reads the wider meaning. */
function markRoads(roads) {
  for (const r of roads) {
    const hw = r.w / 2;
    if (!r.drive) {                     // drawn tarmac: marks only empty cells
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const len = dist(a.x, a.y, b.x, b.y);
        const steps = Math.max(1, Math.ceil(len / (W.cell * .6)));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          markDrivable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, hw, 2);
        }
      }
      continue;
    }
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = dist(a.x, a.y, b.x, b.y);
      const steps = Math.max(1, Math.ceil(len / (W.cell * .6)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        markDrivable(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, hw);
      }
    }
  }
}

// Buckets are keyed off absolute metres, so they never need rebuilding — only adding to.
function indexBuildings(from) {
  for (let i = from; i < W.buildings.length; i++) {
    const b = W.buildings[i];
    const cx0 = Math.floor(b.bb.x0 / W.bcell), cx1 = Math.floor(b.bb.x1 / W.bcell);
    const cy0 = Math.floor(b.bb.y0 / W.bcell), cy1 = Math.floor(b.bb.y1 / W.bcell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = cx + ',' + cy;
      let a = W.buckets.get(k); if (!a) { a = []; W.buckets.set(k, a); }
      a.push(i);
    }
  }
}
/* Two more hashes over the same absolute-metre scheme, both there because a 36 km
   world broke a linear scan that was fine at 1.8 km.

   vbuckets: every road, for the view cull. render() used to filter W.roads each
   frame — at skeleton scale that is tens of thousands of bounding-box tests per
   frame, four times over.

   dbuckets: drivable roads, for roadPoint(). That picks a random road and rejects
   it unless it falls in a distance band around the player; spread over 400x the
   area it fails all 260 tries and traffic simply stops appearing. */
function bucketSpan(bb, cell, fn) {
  const cx0 = Math.floor(bb.x0 / cell), cx1 = Math.floor(bb.x1 / cell);
  const cy0 = Math.floor(bb.y0 / cell), cy1 = Math.floor(bb.y1 / cell);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) fn(cx + ',' + cy);
}
/* Bucketed by SEGMENT, not by whole-road bounding box. A motorway crossing the
   city diagonally has a bounding box the size of the city: filed by that box it
   would land in every one of ~20,000 cells it mostly doesn't touch, and every
   view query would drag it back. Walking the segments files it only where it
   actually runs. Cells are collected per road first, so a street that wiggles
   across one cell a dozen times is still filed there once. */
function indexView(roads) {
  const cells = new Set();
  for (const r of roads) {
    cells.clear();
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      bucketSpan({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
                   x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, W.vcell, k => cells.add(k));
    }
    for (const k of cells) {
      let arr = W.vbuckets.get(k); if (!arr) { arr = []; W.vbuckets.set(k, arr); }
      arr.push(r);
    }
  }
}
/* Segments again, and the segment INDEX is stored alongside the road. Spawning
   wants a point near you; filing a 15 km motorway under every cell its box covers
   would hand you the road but leave you picking a random point along all 15 km of
   it, which is a miss almost every time. A segment is a place. */
function indexDrive(idx) {
  const r = W.driveRoads[idx];
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    bucketSpan({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
                 x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, W.dcell, k => {
      let arr = W.dbuckets.get(k); if (!arr) { arr = []; W.dbuckets.set(k, arr); }
      arr.push({ r, i });
    });
  }
}

/* Roads overlapping a rectangle. A road spanning several cells is in each of
   them, so it comes back more than once — stamped with a per-call token rather
   than gathered into a Set, which would allocate every frame. */
let visTok = 0;
function roadsIn(x0, y0, x1, y1) {
  const out = [], tok = ++visTok;
  const cx0 = Math.floor(x0 / W.vcell), cx1 = Math.floor(x1 / W.vcell);
  const cy0 = Math.floor(y0 / W.vcell), cy1 = Math.floor(y1 / W.vcell);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const a = W.vbuckets.get(cx + ',' + cy);
    if (!a) continue;
    for (const r of a) {
      if (r._tok === tok) continue;
      r._tok = tok;
      if (r.bb.x1 < x0 || r.bb.x0 > x1 || r.bb.y1 < y0 || r.bb.y0 > y1) continue;
      out.push(r);
    }
  }
  return out;
}

function indexRoads(roads) {
  for (const r of roads) {
    if (!r.name) continue;                 // only named roads can be announced
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const cx0 = Math.floor(Math.min(a.x, b.x) / W.bcell), cx1 = Math.floor(Math.max(a.x, b.x) / W.bcell);
      const cy0 = Math.floor(Math.min(a.y, b.y) / W.bcell), cy1 = Math.floor(Math.max(a.y, b.y) / W.bcell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = cx + ',' + cy;
        let arr = W.rbuckets.get(k); if (!arr) { arr = []; W.rbuckets.set(k, arr); }
        arr.push({ r, i });
      }
    }
  }
}
function addLights(roads) {
  for (const r of roads) {
    if (r.w < 9) continue;
    if (W.lights.length > 4200) break;
    const off = r.w / 2 + 1.4;
    let side = 1;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = dist(a.x, a.y, b.x, b.y) || 1;
      const n = Math.floor(len / 32);
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      for (let s = 1; s <= n; s++) {
        const t = s / (n + 1);
        W.lights.push({
          x: lerp(a.x, b.x, t) + nx * off * side,
          y: lerp(a.y, b.y, t) + ny * off * side,
          c: Math.random() < .16 ? pick(PAL.neon) : '#ffd2a0'
        });
        side *= -1;
      }
    }
  }
}

/* A drivable centreline running through a footprint means a tunnel, an archway,
   or a building put up over the street — dense old towns are full of them. You
   should drive through, not crash into it, so those buildings stop colliding.
   Sampling the centreline against the building hash is precise and only costs
   anything at load time. */
function markPassable(roads) {
  for (const r of roads) {
    if (!r.drive) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = dist(a.x, a.y, b.x, b.y) || 1;
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        const arr = W.buckets.get(Math.floor(x / W.bcell) + ',' + Math.floor(y / W.bcell));
        if (!arr) continue;
        for (const bi of arr) {
          const bl = W.buildings[bi];
          if (bl.passable) continue;
          if (x < bl.bb.x0 || x > bl.bb.x1 || y < bl.bb.y0 || y > bl.bb.y1) continue;
          if (pointInPoly(bl.pts, x, y)) bl.passable = true;
        }
      }
    }
  }
}

/* Landmarks you're meant to drive into, so they go transparent and stop colliding
   exactly like a building with a road through it. Both tagging styles land here:
   the way form, where the hospital IS the building, and the node form, where a
   garage node sits inside someone else's footprint. */
function markPOIBuildings() {
  for (const p of W.pois) {
    const arr = W.buckets.get(Math.floor(p.x / W.bcell) + ',' + Math.floor(p.y / W.bcell));
    if (!arr) continue;
    for (const bi of arr) {
      const b = W.buildings[bi];
      if (b.passable) continue;
      if (p.x < b.bb.x0 || p.x > b.bb.x1 || p.y < b.bb.y0 || p.y > b.bb.y1) continue;
      if (pointInPoly(b.pts, p.x, p.y)) b.passable = true;
    }
  }
}

/* The world is as big as the tiles we deliberately loaded — never as big as the
   geometry inside them. Overpass returns the FULL shape of anything that merely
   touches the box it was asked for, and a motorway way can run for hundreds of
   kilometres: sizing the world off feature bounds once let a single overhanging
   way stretch it to ±150 km, which shrank the whole city to a speck on the radar
   and blew the collision mask up to millions of cells. Overhanging features are
   simply drawn as they are; markDrivable already bounds-checks. */
const tileRect = key => {
  const [i, j] = key.split(',').map(Number);
  return { x0: i * TILE - RADIUS, y0: j * TILE - RADIUS,
           x1: i * TILE + RADIUS, y1: j * TILE + RADIUS };
};
// 'skel' is not a tile — it's the one wide rectangle, and it is never recycled.
const rectFor = key => key === 'skel' ? W.skelRect : tileRect(key);
function worldBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // The skeleton is the whole reason the world is 36 km across rather than 1.8.
  // It isn't a tile and is never recycled, so it sets the floor for the bounds and
  // everything downstream — the grid, the fence, the radar — sizes itself off it.
  if (W.skelRect) {
    x0 = W.skelRect.x0; y0 = W.skelRect.y0; x1 = W.skelRect.x1; y1 = W.skelRect.y1;
  }
  for (const [key, st] of W.tiles) {
    if (st !== 'loaded') continue;
    const r = tileRect(key);
    if (r.x0 < x0) x0 = r.x0; if (r.y0 < y0) y0 = r.y0;
    if (r.x1 > x1) x1 = r.x1; if (r.y1 > y1) y1 = r.y1;
  }
  // the generated city has no tiles, so fall back to what its features cover
  if (!isFinite(x0)) {
    const b = featureBounds([W.roads, W.buildings, W.parks]);
    return isFinite(b.x0) ? b : { x0: -900, y0: -900, x1: 900, y1: 900 };
  }
  return { x0, y0, x1, y1 };
}

function featureBounds(sets) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const arr of sets) for (const f of arr) {
    if (f.bb.x0 < x0) x0 = f.bb.x0; if (f.bb.y0 < y0) y0 = f.bb.y0;
    if (f.bb.x1 > x1) x1 = f.bb.x1; if (f.bb.y1 > y1) y1 = f.bb.y1;
  }
  return { x0, y0, x1, y1 };
}

function buildWorld(data, name, procedural) {
  W.roads = data.roads; W.buildings = data.buildings;
  W.parks = data.parks;
  W.places = data.places || [];
  W.pois = []; addPOIs(data.pois || []);
  W.name = name; W.procedural = procedural; W.sweptTo = 0; W.sweeping = false;
  W.tiles = new Map(); W.fixed = new Set();
  W.skelRect = null; SCENERY_ONLY = false;   // a new city starts with no wide map
  W.bundled = false;                         // and streams, unless it came from disk
  RESERVED = '';                             // and reserves its own ground again
  // a real map streams; the generated city is a fixed island
  if (!procedural) { W.tiles.set('0,0', 'loaded'); W.fixed.add('0,0'); stampTile(data, '0,0'); }

  reindexWorld();
  applyTheme(themeName);   // resolves every building's material and prerenders the map
}

/* Which tile a feature came from, so recycling one can take its scenery with it. */
function stampTile(data, key) {
  for (const arr of [data.roads, data.buildings, data.parks, data.places || []])
    for (const f of arr) f.tile = key;
}

/* Everything derived from the feature arrays: bounds, drivable mask, spatial
   hashes, lights, minimap. Run once at startup and again whenever a tile is
   recycled, since both cases are "the feature arrays changed underneath us". */
function reindexWorld() {
  W.buckets.clear(); W.rbuckets.clear(); W.vbuckets.clear(); W.dbuckets.clear();
  W.lights = [];
  W.roadIds = new Set();
  for (const arr of [W.roads, W.buildings])
    for (const f of arr) if (f.id != null) W.roadIds.add(f.id);
  W.grid = null; W.minX = W.minY = Infinity; W.maxX = W.maxY = -Infinity;

  const b = worldBounds();
  fitGrid(b.x0, b.y0, b.x1, b.y1);   // bounds start empty, so this sizes the grid afresh

  markRoads(W.roads);
  indexBuildings(0);
  indexView(W.roads);
  markPassable(W.roads);
  markPOIBuildings();
  W.driveRoads = W.roads.filter(r => r.drive && r.pts.length >= 2);
  for (let i = 0; i < W.driveRoads.length; i++) indexDrive(i);
  indexRoads(W.roads);
  addLights(W.roads);
}

/* ------------------------- streaming the map in -------------------------

   The opening download is tile (0,0). As the player nears the edge of what's
   loaded, the neighbouring tiles are fetched in the background and folded in,
   so the world keeps going instead of stopping at a fence.                  */
const CHUNK = { busy: false, last: 0, loaded: 1, failed: 0, evicted: 0, note: '', mergeMs: 0, mapMs: 0,
                retryAt: new Map(), tries: new Map() };

/* Once the loading screen is down, tiles stop carrying roads and carry only
   scenery. Set only when a skeleton actually landed: if the whole ladder failed
   the wide world doesn't exist, and streaming roads the old way is then strictly
   better than fencing the player into the opening tile. */
let SCENERY_ONLY = false;

const tileKey = (i, j) => i + ',' + j;
const tileOf = (x, y) => [Math.round(x / TILE), Math.round(y / TILE)];

// Tiles overlapping a look-ahead circle around the player that we don't have yet.
function wantedTiles(px, py) {
  const [ci, cj] = tileOf(px, py);
  const now = Date.now();
  const out = [];
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const key = tileKey(i, j);
    if (W.tiles.get(key)) continue;                      // already loaded or in flight
    if ((CHUNK.retryAt.get(key) || 0) > now) continue;   // failed recently; backing off
    // distance from the player to that tile's box, 0 if inside it
    const dx = Math.max(Math.abs(px - i * TILE) - RADIUS, 0);
    const dy = Math.max(Math.abs(py - j * TILE) - RADIUS, 0);
    const d = Math.hypot(dx, dy);
    // the faster you're going, the earlier the next tile has to start loading
    if (d < LOOKAHEAD + Math.hypot(P.car.vx, P.car.vy) * 6) out.push({ i, j, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/* Scenery queues through one worker. Opening the city on nine tiles would
   otherwise put a pile of side requests in the air at once, and Overpass hands
   out about two slots per IP: the streets request in flight plus one of these is
   exactly the budget, and anything more just earns 429s. */
const SIDE = { q: [], busy: false };
function sideFetch(fn) { SIDE.q.push(fn); pumpSide(); }
async function pumpSide() {
  if (SIDE.busy) return;
  SIDE.busy = true;
  while (SIDE.q.length) { try { await SIDE.q.shift()(); } catch (e) {} }
  SIDE.busy = false;
}

async function loadTile(i, j) {
  const key = tileKey(i, j);
  W.tiles.set(key, 'loading');
  CHUNK.busy = true;
  CHUNK.note = 'Streaming the next district…';
  const sess = newSession();
  try {
    const cx = i * TILE, cy = j * TILE;
    const s = unprojLat(cy + RADIUS), w = unprojLon(cx - RADIUS);   // south, west
    const n = unprojLat(cy - RADIUS), e = unprojLon(cx + RADIUS);   // north, east (+y is south)

    /* Once you're driving, the road network is finished — the skeleton covers
       everywhere you can reach and never has to be asked for again. All a tile
       does from here is dress the place with buildings. Roads are only fetched
       while the loading screen is still up. */
    if (SCENERY_ONLY) {
      const bels = await overpassArea(s, w, n, e, sess, { kind: 'buildings' });
      const bdata = parseOSM(bels);
      // An empty answer is an ANSWER out here: plenty of real ground has nothing
      // built on it. Treating it as a failure would retry open countryside
      // forever, on backoff, for the rest of the drive.
      const t0 = performance.now();
      if (bdata.buildings.length || bdata.parks.length) mergeChunk(bdata, key);
      CHUNK.mergeMs = Math.round(performance.now() - t0);
      W.tiles.set(key, 'loaded');
      CHUNK.loaded++;
      CHUNK.note = '';
      return true;
    }

    // streets first: that's what extends the drivable world
    const els = await overpassArea(s, w, n, e, sess, { kind: 'streets' });
    const data = parseOSM(els);
    if (!data.roads.length) throw new Error('empty tile');
    const t0 = performance.now();
    mergeChunk(data, key);
    CHUNK.mergeMs = Math.round(performance.now() - t0);
    W.tiles.set(key, 'loaded');
    // Only tiles that predate play are permanent. In the fallback case — no
    // skeleton landed, so roads still stream — marking these too would make every
    // tile un-evictable and the world would grow without bound on a long drive.
    if (state !== 'play') W.fixed.add(key);
    CHUNK.loaded++;
    CHUNK.note = '';

    // then its buildings, which are the bulk of the bytes and purely scenery
    sideFetch(() => {
      const bs = newSession();
      return overpassArea(s, w, n, e, bs, { kind: 'buildings' })
        .then(bels => { if (W.tiles.get(key) === 'loaded') mergeChunk(parseOSM(bels), key); })
        .catch(err => console.warn('chunk ' + key + ' buildings:', err && err.message))
        .finally(() => sessAbort(bs));
    });
    return true;
  } catch (err) {
    console.warn('chunk ' + key + ' failed:', err && err.message);
    // let it be retried, but back off so a dead area can't hammer the mirrors
    W.tiles.delete(key);
    const n = (CHUNK.tries.get(key) || 0) + 1;
    CHUNK.tries.set(key, n);
    CHUNK.retryAt.set(key, Date.now() + Math.min(15000 * n, 90000));
    CHUNK.failed++;
    CHUNK.note = '';
    return false;
  } finally {
    sessAbort(sess);
    CHUNK.busy = false;
    CHUNK.last = Date.now();
  }
}

/* MAX_TILES used to be a lifetime cap: once you had streamed twelve tiles the
   world simply stopped growing and fence() pinned you against the edge of it.
   It's a budget now — the nearest tiles are kept and the rest are recycled, so
   you can drive as far as you like without the mask or the minimap growing
   without bound. The 3×3 look-ahead only ever wants nine tiles against a budget
   of twelve, so what's in play is never what gets dropped and nothing thrashes. */
function evictFarTiles(px, py, budget) {
  // Tiles loaded before play are permanent: their roads are part of the fixed
  // network, and recycling them would tear holes in the city you started in.
  const loaded = [...W.tiles.entries()].filter(([k, st]) => st === 'loaded' && !W.fixed.has(k));
  budget = Math.max(4, budget - W.fixed.size);
  if (loaded.length <= budget) return false;
  const withD = loaded.map(([k]) => {
    const [i, j] = k.split(',').map(Number);
    return { k, d: Math.hypot(px - i * TILE, py - j * TILE) };
  }).sort((a, b) => a.d - b.d);

  const drop = new Set(withD.slice(budget).map(t => t.k));
  if (!drop.size) return false;
  for (const k of drop) W.tiles.delete(k);

  const keep = f => !drop.has(f.tile);
  // Let the ids go with them, or driving back into a recycled district finds every
  // building deduped away against a copy that no longer exists.
  for (const arr of [W.roads, W.buildings])
    for (const f of arr) if (!keep(f) && f.id != null) W.roadIds.delete(f.id);
  W.buildings = W.buildings.filter(keep);
  W.parks = W.parks.filter(keep);
  // landmarks stay: a handful of points, they never touch the grid bounds, and
  // dropping them would throw away the wide sweep and leave a bust nowhere to go

  if (SCENERY_ONLY) {
    /* Only scenery was dropped, so only the building hash is stale. reindexWorld()
       used to run here unconditionally — over an 18 km skeleton that re-marks the
       whole drivable mask and rebuilds every hash mid-drive, which is a visible
       stutter for no gain: roads, the mask, driveRoads, the road hashes and the
       lights cannot change any more once the skeleton is in. */
    W.buckets.clear();
    indexBuildings(0);
    markPOIBuildings();
  } else {
    // No skeleton, so tiles still carry roads and dropping one really does change
    // the network. Everything derived has to be rebuilt, exactly as before.
    W.roads = W.roads.filter(keep);
    W.places = W.places.filter(keep);
    reindexWorld();
  }
  prerenderMap();
  CHUNK.evicted += drop.size;

  // a delivery whose marker was in a recycled tile is unreachable — reissue it
  const t = MISSION.state === 'pickup' ? MISSION.pick : MISSION.state === 'deliver' ? MISSION.drop : null;
  if (t && !inWorld(t.x, t.y)) { MISSION.state = 'none'; newMission(); }
  return true;
}

/* THE FENCE HAS TO COVER GROUND WE CAN STILL STREAM, not only ground that has
   already arrived.

   worldBounds() unions the tiles that are 'loaded', and fence() clamps the car
   inside it every frame while reversing 30% of its velocity. So a tile still in
   flight — or one whose request failed and is backing off — is an invisible
   wall. Drive into it with the throttle down and the car is pinned at walking
   pace against nothing, on a map that plainly continues ahead of you: no
   collision, no message, just a car that will not move. Turning round frees it
   instantly, which is the tell, and on a slow connection the opening ring can
   leave that wall less than a kilometre from where you started.

   Reserving the player's own tile and its eight neighbours puts the fence at
   least a tile ahead of the car and carries it along with them. The grid grows
   exactly as it always did, one tile at a time — just slightly ahead of the data
   instead of behind it — and fitGrid only ever grows, so it settles as soon as
   the car stops crossing into new tiles. Reserved ground with no roads on it yet
   is simply off-road: you can drive on it, at off-road speed, until it arrives. */
let RESERVED = '';                 // the tile we last reserved around; '' on a new city
function reserveAhead(px, py) {
  /* Only in the no-skeleton fallback. When the wide map landed it IS the world:
     bounds are the skeleton rectangle from the first frame, symmetric and 18 km
     out, the road network is already complete, and tiles bring nothing but
     scenery. Reserving past it there would push the fence — and the drivable
     mask with it, twenty million cells at 36 km — outwards forever as you drove. */
  if (W.skelRect) return;
  const [ci, cj] = tileOf(px, py);
  const here = tileKey(ci, cj);
  if (here === RESERVED) return;             // nothing to do until you cross a seam
  RESERVED = here;
  const a = tileRect(tileKey(ci - 1, cj - 1)), b = tileRect(tileKey(ci + 1, cj + 1));
  if (!fitGrid(a.x0, a.y0, b.x1, b.y1)) return;
  // the same hole as in mergeChunk: growing the mask preserves whatever was
  // missing from it, so anything that overhung the old edge is re-marked here
  markRoads(W.roads);
  prerenderMap();                                        // the radar sizes off the bounds
}

// Called from the game loop; cheap, and does nothing most frames.
function updateChunks() {
  if (W.procedural || W.bundled) return;
  // before the busy/cooldown guards: the fence must keep up with the car even
  // while a request is in flight, which is precisely when it used to trap you
  reserveAhead(P.car.x, P.car.y);
  if (CHUNK.busy) return;
  if (Date.now() - CHUNK.last < TILE_COOLDOWN) return;
  const want = wantedTiles(P.car.x, P.car.y);
  if (!want.length) return;
  evictFarTiles(P.car.x, P.car.y, MAX_TILES - 1);   // make room for the one we're about to add
  loadTile(want[0].i, want[0].j);
}

/* The radar's pre-rendered window follows the car. Nothing to do while the whole
   world already fits in one, which is every small city and the generated one. */
function updateMapWindow() {
  if (!W.map || W.mapWhole || !W.mapCentre) return;
  if (dist2(P.car.x, P.car.y, W.mapCentre.x, W.mapCentre.y) < MAP_REDRAW * MAP_REDRAW) return;
  prerenderMap(P.car.x, P.car.y);
}

/* Fold a freshly downloaded neighbouring tile into the live world. */
function mergeChunk(data, key) {
  const tk = key || '0,0';
  const skel = tk === 'skel';
  // the tile's own rectangle, not what its features happen to span
  const r = rectFor(tk);
  /* Drop any way already in the world. Overlapping requests are now the norm, not
     the exception: the skeleton repeats every trunk road the detailed centre
     holds, the opening buildings cover the same ground as tile (0,0), and a way
     lying on a seam arrives with both its tiles. A way is either a road or a
     piece of scenery, never both, so one set of ids covers all of it. */
  const fresh = a => a.filter(f => f.id == null || !W.roadIds.has(f.id));
  data.roads = fresh(data.roads);
  data.buildings = fresh(data.buildings);
  for (const f of data.roads) if (f.id != null) W.roadIds.add(f.id);
  for (const f of data.buildings) if (f.id != null) W.roadIds.add(f.id);

  const firstBuilding = W.buildings.length;
  // Sized before the emptiness check: a skeleton that turned out to be all
  // duplicates still has to grow the world to its rectangle.
  const grew = fitGrid(r.x0, r.y0, r.x1, r.y1);
  if (!(data.roads.length || data.buildings.length || data.parks.length)) return 0;
  stampTile(data, tk);
  // The GRID is sized by the tile, but passability is a geometry question — which
  // buildings a road actually runs through — so it works off where the features
  // really are. A way overhanging the tile edge would otherwise never be tested,
  // and you'd hit a solid wall where the map shows an archway.
  const b = featureBounds([data.roads, data.buildings]);

  for (const r of data.roads) W.roads.push(r);
  for (const x of data.buildings) W.buildings.push(x);
  for (const x of data.parks) W.parks.push(x);
  for (const p of data.places || []) W.places.push(p);
  addPOIs(data.pois || []);

  /* A GROWN GRID HAS HOLES IN IT WHERE ROADS RAN OFF THE OLD ONE.

     markDrivable() bounds-checks against the grid and silently skips cells
     outside it, so a way that overhangs the box it arrived in is marked only as
     far as the mask reached at the time. Growing the mask blits the old marks
     across faithfully — and faithfully preserves the missing part.

     That is what the opening tile does to every road leaving it. Tile (0,0)
     sizes the grid to ±940 m; the skeleton then grows it to ±18 km, and every
     street overhanging that first box stays unmarked past 940 m for the rest of
     the session. In real Belgrade data that is Немањина reading as open ground
     with its own centreline 0.1 m away — a car crawling on a main road. The
     duplicate that arrives with the skeleton cannot repair it either, because
     it carries the same OSM id and is deduped out before it is ever marked.

     So when the grid grows, everything gets re-marked, not just what came in
     the box that grew it. markDrivable only ever sets cells to 1, so this is
     idempotent, and the grid grows perhaps twice in a session. */
  if (grew) markRoads(W.roads);
  else markRoads(data.roads);       // the mask was blitted, so only new roads need marking
  indexBuildings(firstBuilding);
  indexView(data.roads);
  for (const r of data.roads) if (r.drive && r.pts.length >= 2) indexDrive(W.driveRoads.push(r) - 1);
  // ways crossing the seam matter both ways, so test every road touching this tile
  if (!skel && isFinite(b.x0))
    markPassable(W.roads.filter(rd => rd.bb.x1 >= b.x0 && rd.bb.x0 <= b.x1 &&
                                      rd.bb.y1 >= b.y0 && rd.bb.y0 <= b.y1));
  markPOIBuildings();               // buildings arrive here too, opening ones included
  indexRoads(data.roads);
  // Street lights and archway-passability are detail-area concerns. The skeleton
  // covers 400x the area with no buildings out there to drive through and a light
  // budget it would swallow whole, leaving the ones you can actually see unlit.
  if (!skel) addLights(data.roads);

  resolveColours(data.buildings);   // give the newcomers the current theme
  const tm = performance.now();
  prerenderMap();                   // bounds moved, so the minimap is redrawn
  CHUNK.mapMs = Math.round(performance.now() - tm);
  return data.roads.length;
}

function markDrivable(x, y, r, val = 1) {
  const gx = Math.floor((x - W.minX) / W.cell), gy = Math.floor((y - W.minY) / W.cell);
  const rad = Math.ceil(r / W.cell);
  for (let i = -rad; i <= rad; i++) for (let j = -rad; j <= rad; j++) {
    const cx = gx + i, cy = gy + j;
    if (cx < 0 || cy < 0 || cx >= W.gw || cy >= W.gh) continue;
    if (i * i + j * j > (rad + .4) * (rad + .4)) continue;
    const k = cy * W.gw + cx;
    // drivable always wins, whichever order the two kinds happen to be marked in
    if (val === 1 || gridGet(k) === 0) gridSet(k, val);
  }
}
function onRoad(x, y) {
  const gx = Math.floor((x - W.minX) / W.cell), gy = Math.floor((y - W.minY) / W.cell);
  if (gx < 0 || gy < 0 || gx >= W.gw || gy >= W.gh) return false;
  return gridGet(gy * W.gw + gx) === 1;
}
// Anything painted as tarmac, road network or not. Only the off-road penalty
// asks this: what it needs to know is "does this LOOK like road under the car",
// because punishing a player who is plainly on a paved surface reads as a bug.
function onTarmac(x, y) {
  const gx = Math.floor((x - W.minX) / W.cell), gy = Math.floor((y - W.minY) / W.cell);
  if (gx < 0 || gy < 0 || gx >= W.gw || gy >= W.gh) return false;
  return gridGet(gy * W.gw + gx) !== 0;
}

/* WHICH WAY IS THE TARMAC? A short spiral outwards over the drivable mask,
   nearest ring first. The mask is already a grid, so this is a handful of array
   reads rather than any geometry, and it runs for one car.

   The kerb pull needs the direction ACROSS to the road, and the obvious cheap
   substitute — remember the last on-road point and aim at that — sounds
   equivalent and is not. That point is usually a long way back ALONG the road,
   so the pull comes out almost parallel to the kerb and the car never actually
   returns: measured, it closed one and a half metres in five seconds, which is
   indistinguishable from having no kerb at all. */
function nearestRoadDir(x, y, maxCells = 6) {
  if (!W.grid) return null;
  const gx = Math.floor((x - W.minX) / W.cell), gy = Math.floor((y - W.minY) / W.cell);
  let bd = Infinity, bx = 0, by = 0;
  for (let r = 1; r <= maxCells; r++) {
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;      // the ring, not the block
      const cx = gx + i, cy = gy + j;
      if (cx < 0 || cy < 0 || cx >= W.gw || cy >= W.gh) continue;
      if (gridGet(cy * W.gw + cx) === 0) continue;      // any tarmac will do
      const wx = W.minX + (cx + .5) * W.cell, wy = W.minY + (cy + .5) * W.cell;
      const d = dist2(x, y, wx, wy);
      if (d < bd) { bd = d; bx = wx; by = wy; }
    }
    if (bd < Infinity) break;                    // nearest ring wins; stop widening
  }
  if (bd === Infinity) return null;
  const d = Math.sqrt(bd) || 1;
  return { x: (bx - x) / d, y: (by - y) / d, d };
}

/* Do we actually KNOW there is no road here, or have we simply not been told yet?

   onRoad() answers false for both, and the off-road penalty must only ever apply
   to the first. The reserved ground beyond the loaded tiles has no roads on it
   because nothing has arrived, not because it is a field — and slowing the car
   to walking pace out there would rebuild, by hand, the exact fault this session
   just fixed: a car that will not move at the frontier of the map with the
   throttle down and nothing visible to explain it.

   The skeleton is the easy case: when one landed the road network is complete
   across its whole rectangle and never changes again. Otherwise it comes down to
   whether this point's tile has actually loaded. A Map lookup, not a search. */
function roadDataHere(x, y) {
  if (W.procedural) return true;                     // the generated city is all there is
  if (W.skelRect) return x >= W.skelRect.x0 && x <= W.skelRect.x1 &&
                          y >= W.skelRect.y0 && y <= W.skelRect.y1;
  const [i, j] = tileOf(x, y);
  return W.tiles.get(tileKey(i, j)) === 'loaded';
}

/* Random point sitting on a real road, optionally within a distance band.
   Carries the way + node index so traffic can start driving it immediately. */
function roadLen(r) {
  if (r.len == null) {
    let L = 0;
    for (let i = 0; i < r.pts.length - 1; i++) L += dist(r.pts[i].x, r.pts[i].y, r.pts[i + 1].x, r.pts[i + 1].y);
    r.len = L;
  }
  return r.len;
}
/* Drivable road SEGMENTS reaching a band around a point. Picking at random from
   the whole world was fine when the world was 1.8 km across; at skeleton scale
   the odds of a random road being within 200 m of you are tiny, all 260 tries
   miss, and no traffic ever spawns. */
function driveSegsNear(x, y, maxD) {
  const out = [];
  const cx0 = Math.floor((x - maxD) / W.dcell), cx1 = Math.floor((x + maxD) / W.dcell);
  const cy0 = Math.floor((y - maxD) / W.dcell), cy1 = Math.floor((y + maxD) / W.dcell);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const a = W.dbuckets.get(cx + ',' + cy);
    if (a) for (const s of a) out.push(s);
  }
  return out;
}
// nearestRoadPoint wants whole roads, so it gets them from the same cells
function driveRoadsNear(x, y, maxD) {
  const out = [], tok = ++visTok;
  for (const s of driveSegsNear(x, y, maxD)) {
    if (s.r._dtok === tok) continue;
    s.r._dtok = tok;
    out.push(s.r);
  }
  return out;
}
function roadPoint(fromX, fromY, minD, maxD, minLen) {
  // With a band, draw only from the segments that could satisfy it.
  const pool = minD == null ? null : driveSegsNear(fromX, fromY, maxD);
  if (pool && !pool.length) return null;
  for (let tries = 0; tries < 260; tries++) {
    let r, i;
    if (pool) { const s = pick(pool); r = s.r; i = s.i; }
    else { r = pick(W.driveRoads); if (!r) return null; i = randi(0, r.pts.length - 1); }
    if (minLen && roadLen(r) < minLen) continue;
    const a = r.pts[i], b = r.pts[i + 1] || r.pts[i];
    const t = Math.random();
    const p = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
                h: Math.atan2(b.y - a.y, b.x - a.x), road: r, idx: i };
    if (minD == null) return p;
    const d = dist(p.x, p.y, fromX, fromY);
    if (d >= minD && d <= maxD) return p;
  }
  return null;
}
/* Which named street is this point on? Bucketed, so it costs a handful of
   segment tests per frame rather than a scan of the whole map. */
function streetAt(x, y) {
  const cx = Math.floor(x / W.bcell), cy = Math.floor(y / W.bcell);
  let best = null, bd = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = W.rbuckets.get((cx + i) + ',' + (cy + j));
    if (!arr) continue;
    for (const { r, i: si } of arr) {
      const a = r.pts[si], b = r.pts[si + 1];
      const ex = b.x - a.x, ey = b.y - a.y;
      const L = ex * ex + ey * ey || 1e-6;
      let t = ((x - a.x) * ex + (y - a.y) * ey) / L; t = clamp(t, 0, 1);
      const d = dist(a.x + ex * t, a.y + ey * t, x, y);
      // must actually be on the carriageway, with a little slack for the kerb
      if (d < bd && d < r.w / 2 + 4) { bd = d; best = r; }
    }
  }
  return best;
}

/* Nearest named district. Only a handful exist, so a plain scan is right —
   but prefer the more specific place type when two are about as close. */
const PLACE_RANK = { city_block: 5, neighbourhood: 4, quarter: 4, suburb: 3, borough: 3,
                     hamlet: 2, village: 2, town: 1, city: 0 };
function zoneAt(x, y) {
  let best = null, bs = Infinity;
  for (const p of W.places) {
    const rank = PLACE_RANK[p.kind] != null ? PLACE_RANK[p.kind] : 2;
    // discount by specificity, so the city node it sits inside can't shout it down
    const score = dist(p.x, p.y, x, y) * (1 - rank * .07);
    if (score < bs) { bs = score; best = p; }
  }
  return best;
}

const REPAIR_COST = 1000;

/* The nearest landmark of a kind. Recomputed a few times a second rather than
   every frame: there are three hundred of these in a real city, the answer only
   changes as you drive, and a marker that re-picks its target every frame
   flickers between two shops equidistant from you. */
const NEAR_POI = { t: 0, of: {} };
function nearestPOI(kind, x, y) {
  const now = performance.now();
  if (now - NEAR_POI.t > 250) { NEAR_POI.t = now; NEAR_POI.of = {}; }
  if (kind in NEAR_POI.of) return NEAR_POI.of[kind];
  let best = null, bd = Infinity;
  for (const p of W.pois) {
    if (p.kind !== kind) continue;
    const d = dist2(p.x, p.y, x, y);
    if (d < bd) { bd = d; best = p; }
  }
  NEAR_POI.of[kind] = best;
  return best;
}
// Half-widths for the landmark sweep, tried in order. Each rung runs at most once
// per city; when the first still turns up no station and no hospital, the next
// one goes wider rather than giving up.
const POI_RADII = [18000, 45000];
/* How far a bust or a wasting may move you. The world grid and the pre-rendered
   map both span everything loaded, so a long teleport bloats the collision mask
   and zooms the radar out until it's useless. A landmark further out than this
   is still found, drawn and driveable-to — you just don't get carried there. */
const RECOVER_MAX = 6000;
// how long the loading screen will wait on the landmark sweep before starting anyway
const LOAD_SWEEP_WAIT = 6000;
// how long loading will wait on the opening ring before starting with what landed
const LOAD_RING_WAIT = 12000;
// an opening fetch slower than this means a heavy area — take less of the ring
const SLOW_AREA_MS = 7000;

const POI_KINDS = ['police', 'hospital', 'repair'];
const missingKinds = () => POI_KINDS.filter(k => !W.pois.some(p => p.kind === k));

/* The opening area is 1.8 km across, and plenty of real neighbourhoods that size
   hold no station, no hospital and no garage. When one is missing, sweep a much
   wider area for landmarks alone — no streets, no buildings, so it stays a cheap
   request — and fold whatever turns up into the world already being played. */
async function widenLandmarkSearch() {
  const missing = missingKinds();
  if (!missing.length || W.procedural || W.sweeping) return null;
  if (W.sweptTo >= POI_RADII.length) return null;      // gone as wide as we go
  const R = POI_RADII[W.sweptTo];
  W.sweptTo++;
  W.sweeping = true;
  const s = unprojLat(R), w = unprojLon(-R), n = unprojLat(-R), e = unprojLon(R);
  try {
    const els = await overpassArea(s, w, n, e, newSession(), { kind: 'pois' });
    const before = W.pois.length;
    addPOIs(parsePOIs(els));
    const found = W.pois.length - before;
    if (found) { markPOIBuildings(); prerenderMap(); }   // radar and drive-through
    return { radius: R, missing, found, stillMissing: missingKinds() };
  } catch (err) {
    return { radius: R, missing, found: 0, err: err.message };   // the start point covers us
  } finally {
    W.sweeping = false;
  }
}

/* Run once, while the loading screen is still up. If the first radius turns up no
   station and no hospital it goes a rung wider there and then, so the "somewhere
   to be taken after a bust" guarantee survives without any wide request ever
   firing mid-game — once you're driving, only tile-sized loads happen. */
/* The eight tiles around the opening one, pulled while the loading screen is still
   up so you start in a 5.4 km city rather than a 1.8 km one. Sequential, because
   Overpass gives roughly two slots per IP and a burst just earns 429s, and bounded
   by a deadline so a slow city starts with whatever landed rather than not at all. */
/* The wide city, fetched once. Walks 18 km, then 9, then 4 — a server that won't
   answer for the big box will often answer for a smaller one, and the biggest
   world that server would give us is the one we want. First success wins; if the
   whole ladder fails you still have the detailed centre and the game starts. */
async function loadSkeleton(onMsg) {
  const until = Date.now() + SKELETON_WAIT;
  for (let rung = 0; rung < SKELETON_RADII.length; rung++) {
    if (Date.now() > until) break;
    const R = SKELETON_RADII[rung];
    const sess = newSession();
    try {
      if (onMsg) onMsg('Mapping ' + Math.round(R / 1000) + ' km of city…');
      const s = unprojLat(R), w = unprojLon(-R), n = unprojLat(-R), e = unprojLon(R);
      const els = await overpassArea(s, w, n, e, sess, {
        kind: 'arterials', totalMs: Math.min(SKELETON_MS[rung], until - Date.now()),
        label: 'Mapping ' + Math.round(R / 1000) + ' km of city…', onMsg
      });
      const data = parseOSM(els);
      if (!data.roads.length) throw new Error('no arterials out there');
      // Set before merging: mergeChunk sizes the grid off this rectangle, and it
      // has to grow even when every road in the response was already a duplicate.
      W.skelRect = { x0: -R, y0: -R, x1: R, y1: R };
      const added = mergeChunk(data, 'skel');
      return { radius: R, roads: added, places: data.places.length };
    } catch (err) {
      console.warn('skeleton ' + R + 'm:', err && err.message);
    } finally {
      sessAbort(sess);
    }
  }
  return null;
}

async function preloadRing(openingMs, onEach) {
  let ring = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (i || j) ring.push([i, j]);
  ring.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
  // How long the FIRST tile took is the best read we get on how heavy this area
  // is. Somewhere dense enough to make you wait is exactly where eight more street
  // requests hurt most, so ask for less: the four sides only, or nothing at all.
  if (openingMs > SLOW_AREA_MS * 2) ring = [];
  else if (openingMs > SLOW_AREA_MS) ring = ring.filter(([i, j]) => !i || !j);
  const until = Date.now() + LOAD_RING_WAIT;
  let got = 0;
  for (const [i, j] of ring) {
    if (Date.now() > until) break;
    if (await loadTile(i, j)) got++;
    if (onEach) onEach(got, ring.length);
  }
  return got;
}

async function sweepLandmarks() {
  const out = [];
  // No new rung may START once the loading screen is done — a straggler already in
  // flight can land late, but nothing wide is ever kicked off while you're driving.
  const until = Date.now() + LOAD_SWEEP_WAIT;
  for (let rung = 0; rung < POI_RADII.length; rung++) {
    if (rung && Date.now() > until) break;
    const r = await widenLandmarkSearch();
    if (!r) break;
    out.push(r);
    // only keep widening while the two that matter for a respawn are still absent
    if (!missingKinds().some(k => k === 'police' || k === 'hospital')) break;
  }
  return out;
}

/* Overpass hands the same landmark back more than once: a hospital is matched by
   the amenity query and again as a building, and anything sitting on a tile seam
   arrives with both tiles. Same kind within 30 m is the same place. */
function addPOIs(list) {
  for (const p of list) {
    if (W.pois.some(q => q.kind === p.kind && dist2(q.x, q.y, p.x, p.y) < 900)) continue;
    W.pois.push(p);
  }
}

/* Nearest station / hospital / repair shop. Only a handful are ever loaded, so
   a plain scan is right — the same call zoneAt makes just above. */
function nearestPOI(kind, x, y) {
  let best = null, bd = Infinity;
  for (const p of W.pois) {
    if (p.kind !== kind) continue;
    const d = dist2(p.x, p.y, x, y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
/* Where you wake up afterwards. A 1.8 km slice of a real city often has neither
   a station nor a hospital in it, so falling back to the start is the common
   path, not an edge case. */
// inside the patch of world currently loaded — tiles get recycled behind you
const inWorld = (x, y) => x > W.minX && x < W.maxX && y > W.minY && y < W.maxY;

function recoverPoint(kind) {
  // the start point can itself have been recycled once you've driven far enough
  const home = () => inWorld(P.spawn.x, P.spawn.y) ? P.spawn
                   : (nearestRoadPoint(P.car.x, P.car.y) || P.spawn);
  const poi = nearestPOI(kind, P.car.x, P.car.y);
  if (!poi || dist(poi.x, poi.y, P.car.x, P.car.y) > RECOVER_MAX) return home();
  // Snap to the kerb only when there is actually tarmac by the door. The wide
  // sweep finds landmarks far outside the loaded streets, and for those the
  // nearest loaded road is the edge of the map — miles from where you want to be.
  // Better to arrive at the building and let the next tile pave around you.
  const on = nearestRoadPoint(poi.x, poi.y);
  return (on && dist(on.x, on.y, poi.x, poi.y) < 120) ? on : { x: poi.x, y: poi.y, h: 0 };
}

/* Nearest drivable tarmac to a point. Projects onto each segment rather than
   testing its midpoint: a long way — a dual carriageway drawn as one straight
   line — has a midpoint hundreds of metres from the spot you actually want, and
   that is exactly the geometry a station or hospital tends to sit beside. */
function nearestRoadPoint(x, y) {
  // Widening ring rather than a whole-world scan: over an 18 km skeleton that
  // scan is hundreds of thousands of segment tests, and it runs per landmark.
  for (const R of [300, 900, 2500, 7000]) {
    const p = nearestRoadPointIn(x, y, driveRoadsNear(x, y, R));
    if (p) return p;
  }
  return nearestRoadPointIn(x, y, W.driveRoads);   // last resort: everything
}
function nearestRoadPointIn(x, y, roads) {
  let best = null, bd = Infinity;
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const ex = b.x - a.x, ey = b.y - a.y;
      const L = ex * ex + ey * ey || 1e-6;
      const t = clamp(((x - a.x) * ex + (y - a.y) * ey) / L, 0, 1);
      const px = a.x + ex * t, py = a.y + ey * t;
      const d = dist2(px, py, x, y);
      if (d < bd) { bd = d; best = { x: px, y: py, h: Math.atan2(ey, ex) }; }
    }
  }
  return best;
}

/* A window of the city, pre-rendered so the minimap costs one drawImage a frame.

   It used to be the WHOLE city, which worked while the city was a few kilometres
   across. An 18 km skeleton is 36 km wide: fitted into one canvas that is 0.067
   pixels per metre and the radar is an unreadable smear, and drawing it sharp
   would need a 116-megapixel canvas. So the pre-render follows you — 4 km around
   the car, redrawn when you leave the middle of it. Sharper than it ever was. */
const MAP_WIN = 4000;      // metres across the pre-rendered window
const MAP_PX = 2400;       // pixels across it — 0.6 px/m
const MAP_REDRAW = 900;    // re-render once the car is this far from the window centre

function prerenderMap(cx, cy) {
  if (cx == null) { const pc = P && P.car; cx = pc ? pc.x : 0; cy = pc ? pc.y : 0; }
  const spanX = W.maxX - W.minX, spanY = W.maxY - W.minY;
  let x0, y0, spanW, spanH, s;
  if (spanX <= MAP_WIN && spanY <= MAP_WIN) {
    // small world — the generated city, or a skeleton that never landed. Whole.
    x0 = W.minX; y0 = W.minY; spanW = spanX; spanH = spanY;
    s = Math.min(MAP_PX / Math.max(spanW, 1), MAP_PX / Math.max(spanH, 1), 1.1);
  } else {
    s = MAP_PX / MAP_WIN;
    spanW = Math.min(MAP_WIN, spanX); spanH = Math.min(MAP_WIN, spanY);
    x0 = clamp(cx - spanW / 2, W.minX, Math.max(W.minX, W.maxX - spanW));
    y0 = clamp(cy - spanH / 2, W.minY, Math.max(W.minY, W.maxY - spanH));
  }
  const x1 = x0 + spanW, y1 = y0 + spanH;
  W.mapScale = s;
  W.mapOrigin = { x: x0, y: y0 };
  W.mapCentre = { x: x0 + spanW / 2, y: y0 + spanH / 2 };
  W.mapWhole = spanW >= spanX && spanH >= spanY;

  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.ceil(spanW * s)); c.height = Math.max(2, Math.ceil(spanH * s));
  const g = c.getContext('2d');
  g.fillStyle = PAL.mapBg; g.fillRect(0, 0, c.width, c.height);
  g.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);

  const inWin = f => !(f.bb.x1 < x0 || f.bb.x0 > x1 || f.bb.y1 < y0 || f.bb.y0 > y1);
  const poly = (f, fill) => {
    g.beginPath(); g.moveTo(f.pts[0].x, f.pts[0].y);
    for (let i = 1; i < f.pts.length; i++) g.lineTo(f.pts[i].x, f.pts[i].y);
    g.closePath(); g.fillStyle = fill; g.fill();
  };
  for (const f of W.parks) if (inWin(f)) poly(f, PAL.mapPark);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const winRoads = roadsIn(x0, y0, x1, y1);
  // in a dense window, minor lanes just muddy the radar and cost redraw time
  const minW = winRoads.length > 2000 ? 6.5 : 0;
  for (const r of winRoads) {
    if (r.w < minW) continue;
    g.beginPath(); g.moveTo(r.pts[0].x, r.pts[0].y);
    for (let i = 1; i < r.pts.length; i++) g.lineTo(r.pts[i].x, r.pts[i].y);
    g.lineWidth = Math.max(r.w * .9, 3 / s);
    g.strokeStyle = r.w >= 11 ? PAL.mapRoadBig : PAL.mapRoad;
    g.stroke();
  }
  // Landmarks never move, so they belong in the pre-render rather than the
  // per-frame blip list — the minimap stays one drawImage a frame.
  const dot = 5 / s;
  for (const p of W.pois) {
    g.fillStyle = POI_COL[p.kind];
    g.beginPath(); g.arc(p.x, p.y, dot, 0, TAU); g.fill();
  }
  W.map = c;
}
