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
  shops: [],                             // named shopfronts, for the signs on the facades
  shopKeys: new Set(),                   // and the ones already seen, so a tile seam costs nothing
  sweptTo: 0, sweeping: false,           // how many rungs of the landmark sweep have run
  cell: 8, gw: 0, gh: 0, grid: null,     // drivable mask
  gx0: 0, gy0: 0,                        // and its own origin — it stops before the world does
  bcell: 90, buckets: new Map(),         // building spatial hash
  rbuckets: new Map(),                   // road spatial hash (named roads only)
  vcell: 256, vbuckets: new Map(),       // road spatial hash for view culling (all roads)
  dcell: 300, dbuckets: new Map(),       // drivable roads, for spawning and snapping
  roadIds: new Set(),                    // every way already in the world, so none lands twice
  skelRect: null,                        // the wide arterial box, if one landed
  skelBundled: false,                    // and whether it came out of the bundle rather than the wire
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

/* OPENSTREETMAP MAPS THE FUTURE AND THE PAST AS WELL AS THE PRESENT, and the
   parser used to accept `building` with any value at all. So a tower that has
   not been built yet — `building=construction` — came out as a solid slab you
   could crash into, and `building=no`, which is a real tag whose entire meaning
   is "this is not a building", came out as one too.

   Reported from Savamala with a photograph of an empty plot and a screenshot of
   a lit block standing across the road in it. That district is Beograd na vodi,
   which is where a city's under-construction towers cluster; the captured
   Belgrade data checked in under tests/fixtures carries 67 of them.

   The lifecycle PREFIX forms — `demolished:building=*`, `was:building=*`,
   `razed:building=*` — need nothing, because they are a different key and never
   matched in the first place. It is the value forms that get through. */
const GONE_OR_UNBUILT = /^(no|none|construction|proposed|planned|demolished|razed|destroyed|abandoned|disused)$/i;
function standingBuilding(t) {
  const v = t.building || t['building:part'];
  return !!v && !GONE_OR_UNBUILT.test(v);
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
const POI_COL = { police: '#3fa2ff', hospital: '#ff4f6d', repair: '#48ff9e',
                  fire: '#ff6a2b', taxi: '#f2b705' };
/* AND A FACE FOR EACH, because three coloured dots are three coloured dots.

   The colours are the same three a player has to learn and then remember, and
   they are learned from a key at the bottom of a map they opened to find one
   specific thing. A picture of the thing needs no key at all — and these are the
   glyphs every phone already has, so it costs nothing to download and renders in
   whatever style that platform draws its own emoji in.

   NOT ON THE RADAR, which is 98 points across and shows its landmarks at three
   pixels. An emoji there would be a smudge, and the radar's job is "something of
   that colour, that way" rather than "a hospital". Colour carries it at that
   size; the face is for the big map and the world, where there is room to read
   it. Deliberate, not an omission.

   The mission markers are here too: the package you are going to collect and the
   flag where it is going. */
const POI_EMOJI = {
  police: '🚓', hospital: '🏥', repair: '🔧', fire: '🚒', taxi: '🚕',
  /* THE GOAL LOOKS LIKE WHAT IT IS. Reported from play: on the ambulance shift
     the casualty was marked with a parcel. Every shift shared one pickup icon,
     so the taxi went to collect a box as well, and only the courier was ever
     right. The drop splits the same way — an ambulance finishes at a hospital,
     not at a chequered flag. */
  pickup: '📦', drop: '🏁',
  fare: '🧍', patient: '🤕', ward: '🏥',
  // and the two goals that are not a place you drive to and stop at
  blaze: '🔥', chase: '🚨'
};
/* THE FONT CANVAS NEEDS TO BE TOLD, and it is not the HUD's font. Impact has no
   emoji in it, and a canvas asked for a glyph its font does not have falls back
   per-platform — sometimes to a colour emoji, sometimes to an outline, sometimes
   to a box. Naming the emoji faces explicitly, with the platform ones first,
   gets the colour glyph on every phone; the generic sans-serif at the end is for
   a machine that has none of them. */
const POI_FACE_FONT =
  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Android Emoji",sans-serif';
/* SOMEWHERE YOU EAT, which gets its name in yellow rather than blue.

   The set is the OSM amenity values for places that serve food and drink, plus
   the two shop values that mean the same thing on a high street. `fast_food`
   covers the kebab shop, `bar` and `pub` the ones that mostly sell drink, and
   `ice_cream` is its own amenity rather than a kind of cafe.

   ASKED OF THE TAGS RATHER THAN OF THE NAME, so it works in any city and in any
   language: a Belgrade `kafana` and a Tokyo `喫茶店` are both amenity=cafe, and
   nothing here has to know either word. */
const FOOD_AMENITY = /^(restaurant|cafe|fast_food|bar|pub|biergarten|food_court|ice_cream)$/;
const IS_FOOD = t => FOOD_AMENITY.test(t.amenity || '') ||
                     /^(bakery|deli|coffee|pastry|confectionery)$/.test(t.shop || '');

const POI_KIND = t => t.amenity === 'police' ? 'police'
                    : t.amenity === 'hospital' ? 'hospital'
                    : t.amenity === 'fire_station' ? 'fire'
                    : t.amenity === 'taxi' ? 'taxi'
                    : t.shop === 'car_repair' ? 'repair' : null;

/* ------------------- the name, in a script you can read -------------------

   Street and district names came straight off the `name` tag, which is the
   LOCAL name — so a Russian, German or Japanese player driving Belgrade got
   Ђуре Даничића and Скадарлија, and a Serb driving Tokyo got 神宮前. The UI
   around it was translated; the city was not.

   WHAT OPENSTREETMAP ACTUALLY HAS, counted on the capture in
   tests/fixtures/stari-grad rather than guessed at:

       streets, 847 named        name:sr-Latn 847   int_name 845   name:en 5
       arterials, 8302 named     name:sr-Latn 8302  int_name 8043  name:en 780

   Per-language translations of street names barely exist and never will — a
   street is a proper noun and nobody is translating eight thousand of them.
   What DOES exist, everywhere, is the name written in another script. So this
   does not translate anything: it picks the spelling the reader can actually
   read, preferring their own language when somebody has written one down.

   HENCE SCRIPT-MAJOR ORDER. Every candidate is gathered, then the first one in
   the reader's own script wins, then the first in their fallback script. That
   is why a Russian player gets Serbian Cyrillic rather than the Latin int_name
   — Cyrillic is readable to them and the local name is the truer one — while a
   German player gets the Latin form of the same street.

   RESOLVED WHEN THE CITY IS PARSED, not when it is drawn. Keeping every
   candidate for eight thousand roads to re-pick later would cost more memory
   than the roads do, and it buys nothing: the language selector lives on the
   title screen, and every route back to it goes through loading a city. */
const NAME_SCRIPTS = {
  en: ['latin'], sr: ['latin'], de: ['latin'], fr: ['latin'],
  es: ['latin'], it: ['latin'], pt: ['latin'],
  ru: ['cyrillic', 'latin'],
  ja: ['cjk', 'latin'],
  zh: ['cjk', 'latin']
};
const RE_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const RE_CYR = /[\u0400-\u04ff]/;
const RE_LAT = /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/;
/* CJK is tested first because Japanese writes half a sign in Latin anyway, and
   a name that mixes the two belongs to the reader who can read the kanji. */
function scriptOf(s) {
  if (RE_CJK.test(s)) return 'cjk';
  if (RE_CYR.test(s)) return 'cyrillic';
  if (RE_LAT.test(s)) return 'latin';
  return 'other';
}
/* The key that carried a romanisation last time, remembered across roads. It is
   a HINT and never a decision — an absent or wrong-script value simply falls
   through — and it is what keeps this cheap: these tag objects carry a hundred
   and fifty name:* keys each and a city has eight thousand ways, so walking
   them per road would be over a million string comparisons. One walk finds
   `name:sr-Latn`, and every road after it is a single property read. */
let LATN_HINT = '';
function osmName(t) {
  if (!t) return '';
  const L = (typeof LANG === 'string' && LANG) || 'en';
  const want = NAME_SCRIPTS[L] || ['latin'];
  const ok = (v, sc) => typeof v === 'string' && !!v && scriptOf(v) === sc;
  // the reader's own language, then the local name, then whatever romanisation
  // this dataset was found to use
  for (const sc of want) {
    if (ok(t['name:' + L], sc)) return t['name:' + L];
    if (ok(t.name, sc)) return t.name;
    if (LATN_HINT && ok(t[LATN_HINT], sc)) return t[LATN_HINT];
  }
  /* BEFORE int_name, NOT AFTER IT, and the difference is visible: int_name for
     Ђуре Даничића is "Djure Danicica" while name:sr-Latn is "Đure Daničića".
     Both are Latin and only one of them is the street's actual name, so the
     proper romanisation has to be looked for before the stripped one is
     accepted. */
  let latn = '';
  for (const k in t) {
    if (k.lastIndexOf('name:', 0) !== 0) continue;
    const v = t[k];
    if (typeof v !== 'string' || !v || want.indexOf(scriptOf(v)) < 0) continue;
    // a regional spelling of the reader's own language: zh-Hans, pt-BR, sr-Latn
    if (k.lastIndexOf('name:' + L + '-', 0) === 0) { LATN_HINT = k; return v; }
    if (!latn && /-Latn$/.test(k)) { latn = v; LATN_HINT = k; }
  }
  if (latn) return latn;
  // the international forms are the last readable resort, then the local name
  for (const sc of want) {
    if (ok(t.int_name, sc)) return t.int_name;
    if (ok(t['name:en'], sc)) return t['name:en'];
  }
  return t.name || '';
}

/* ------------------------------ monuments ------------------------------ */
/* A memorial is not a service, so it is not a POI — it is a THING THAT STANDS
   THERE, and the only way to put one in a city is to build it.

   Asked for by name: the square in the reported session is Савски трг, which
   has had a twenty-three metre Stefan Nemanja on it since 2021, and the game
   drew an empty plaza. So monuments are read from OpenStreetMap like everything
   else here — no hard-coded landmarks, because the premise of this game is that
   you can type in any city on Earth and drive around the real one.

   HOW TALL. OSM gives `height` on the well-mapped ones and nothing at all on
   most, so the fallback is by type: an obelisk is a tall thin thing, a monument
   is a substantial one, a statue is a figure on a plinth. Clamped at both ends —
   a mis-tagged `height=200` on a bust would put a tower in a park. */
const MONU_H = { obelisk: 22, monument: 15, memorial: 9, statue: 8, artwork: 7 };
// weathered bronze — deliberately none of the three POI colours, so a memorial
// on the radar is never mistaken for a hospital you are bleeding towards
const MONU_COL = '#d8c07a';
/* The same exclusions the Overpass query carries, enforced again here — and the
   duplication is the point, not an oversight.

   The query's filter only ever applies to the landmark sweep. The BUILDINGS
   request has no such clause and never could without slowing the critical path,
   so a memorial bench mapped as a building arrives by that route untouched. And
   a query is a request, not a guarantee: the bundled offline city, a cached
   reply and any future data source all reach this function without having passed
   through Overpass at all. Leaving the rule in one place was measured, in this
   file's own test — a bench and a ghost bike both came back as statues. */
const MONU_NOT = /^(plaque|stolperstein|bench|tree|ghost_bike|stone|stele)$/;
const MONU_KIND = t => t.man_made === 'obelisk' ? 'obelisk'
                     : t.historic === 'monument' ? 'monument'
                     : t.historic === 'memorial'
                       ? (MONU_NOT.test(t.memorial || '') ? null
                          : /^(statue|bust)$/.test(t.memorial || '') ? 'statue' : 'memorial')
                     : (t.tourism === 'artwork' &&
                        /^(statue|sculpture)$/.test(t.artwork_type || '')) ? 'statue' : null;
function monumentHeight(t, kind) {
  let h = parseFloat(t.height) || 0;
  if (!h && t['building:levels']) h = (parseFloat(t['building:levels']) || 0) * 3.2;
  if (!h || !isFinite(h)) h = MONU_H[kind] || 10;
  return clamp(h, 4, 60);
}
/* Its footprint, when OSM only gives a point. A statue's plinth is a couple of
   metres across and its steps a little more, and this is also the shape the car
   will collide with, so it is deliberately modest — a memorial you cannot drive
   through is right, a memorial with a twenty-metre exclusion zone around it is
   not. */
function monumentPts(x, y, kind) {
  const r = kind === 'obelisk' ? 2.6 : kind === 'monument' ? 3.4 : 2.4;
  return [{ x: x - r, y: y - r }, { x: x + r, y: y - r },
          { x: x + r, y: y + r }, { x: x - r, y: y + r }];
}

/* A monument, shaped like a building so that everything which already works for
   buildings works for it: the spatial hash, the collision, the tile eviction,
   the view culling. `mono` is what the two renderers key on to draw a memorial
   instead of a block — and it is also what keeps the window shader off it, since
   a statue with rows of lit windows would be worse than no statue at all. */
function makeMonument(cx, cy, pts, kind, t, id) {
  const h = monumentHeight(t, kind);
  return { id: id ? 'm' + id : undefined, pts, h, bb: bbox(pts), cx, cy,
           mWall: [188, 182, 170], mRoof: [150, 144, 132], wall: '#333', roof: '#666',
           neon: null, mono: { kind, name: t.name || '' } };
}

function parseOSM(els) {
  const roads = [], buildings = [], parks = [], places = [], pois = [], shops = [];
  for (const el of els) {
    const t = el.tags || {};

    // place nodes give us neighbourhood / district names
    if (el.type === 'node') {
      if (t.place && t.name) {
        places.push({ x: projX(el.lon), y: projY(el.lat), name: osmName(t), kind: t.place });
      }
      const pk = POI_KIND(t);
      if (pk) pois.push({ x: projX(el.lon), y: projY(el.lat), kind: pk, name: osmName(t), cool: 0 });
      // a named shopfront: not a point of interest, just a name for a wall
      else if (t.name && (t.shop || t.amenity))
        shops.push({ x: projX(el.lon), y: projY(el.lat), name: t.name.slice(0, 34),
                     food: IS_FOOD(t) });
      const mk = MONU_KIND(t);
      if (mk) {
        const mx = projX(el.lon), my = projY(el.lat);
        buildings.push(makeMonument(mx, my, monumentPts(mx, my, mk), mk, t, el.id));
      }
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map(g => ({ x: projX(g.lon), y: projY(g.lat) }));

    // A station or a hospital is usually a building too, so this records the
    // point of interest and then falls through to draw the building as normal.
    const pk = POI_KIND(t);
    if (pk) { const c = centroid(pts); pois.push({ x: c.x, y: c.y, kind: pk, name: osmName(t), cool: 0 }); }

    if (t.highway) {
      const cls = ROADW[t.highway] ? t.highway : 'residential';
      const layer = parseInt(t.layer || t.level || '0', 10) || 0;
      // The OSM id travels with the road so the same way can't be added twice.
      // It arrives twice routinely now: the wide skeleton repeats every trunk road
      // the detailed centre already has, and a way lying on a tile seam comes with
      // both tiles.
      roads.push({ id: el.id, pts, cls, w: ROADW[cls], drive: DRIVABLE(cls), bb: bbox(pts),
                   oneway: t.oneway === 'yes', name: osmName(t) || t.ref || '',
                   tunnel: !!t.tunnel && t.tunnel !== 'no', covered: t.covered === 'yes',
                   layer });
    } else if (MONU_KIND(t)) {
      /* Mapped as an outline rather than a point — the plinth's real footprint.
         Taken BEFORE the building branch, because a monument is very often
         tagged `building=yes` as well and would otherwise become an ordinary
         block of flats with rows of windows on it. */
      if (pts.length < 3) continue;
      const c = centroid(pts);
      buildings.push(makeMonument(c.x, c.y, pts, MONU_KIND(t), t, el.id));
    } else if (standingBuilding(t)) {
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
                       // what it is called, for the sign across its widest wall
                       sign: (t.name || '').slice(0, 34),
                       // and whether that sign is a restaurant's, which is yellow
                       food: IS_FOOD(t),
                       mWall: col.mWall, mRoof: col.mRoof, wall: '#333', roof: '#666',
                       neon: (signable && Math.random() < .22) ? pick(PAL.neon) : null });
    } else if (t.leisure || t.landuse) {
      parks.push({ pts, bb: bbox(pts) });
    }
  }
  return { roads, buildings, parks, places, pois, shops };
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
    out.push({ x: projX(lon), y: projY(lat), kind, name: osmName(el.tags || {}), cool: 0 });
  }
  return out;
}

/* The monuments out of the same reply. Separated from parsePOIs because they end
   up somewhere completely different — a monument goes into W.buildings, where it
   collides and casts a shadow, while a POI is a dot on the radar. `out center`
   flattens a way to a point, so a monument found by the wide sweep gets the
   generated plinth rather than its mapped outline; one that arrives with the
   buildings of the district it is in keeps its real shape. */
function parseMonuments(els) {
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    const kind = MONU_KIND(t);
    if (!kind) continue;
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lon = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lon == null) continue;
    const x = projX(lon), y = projY(lat);
    out.push(makeMonument(x, y, monumentPts(x, y, kind), kind, t, el.id));
  }
  return out;
}

/* Tiles overlap at their seams and a tile can be asked for twice, so the same
   shop arrives more than once. Keyed on the name and the position rounded to
   sixteen metres rather than compared against every shop already known — the
   first version was a scan of the whole list per arrival, which is fine for the
   dozen landmarks it was written beside and quadratic for twelve thousand
   shopfronts: measured against the reply that prompted this, a hundred and
   forty million comparisons, on the main thread, on a phone. */
function shopKey(q) {
  return q.name + '@' + Math.round(q.x / 16) + ',' + Math.round(q.y / 16);
}
function addShops(list) {
  let n = 0;
  for (const q of list) {
    const k = shopKey(q);
    if (W.shopKeys.has(k)) continue;
    W.shopKeys.add(k);
    W.shops.push(q); n++;
  }
  return n;
}

/* Into the world, with the same de-duplication buildings already need — the
   sweep runs several times at widening radii and the inner rungs come back
   inside the outer ones, so the same statue arrives more than once. Thirty
   metres and the same kind is the same monument, which is the rule addPOIs uses
   for the same reason. */
function addMonuments(list) {
  const from = W.buildings.length;
  for (const m of list) {
    let dup = false;
    for (const b of W.buildings) {
      if (!b.mono) continue;
      if (dist2(b.cx, b.cy, m.cx, m.cy) < 900) { dup = true; break; }
    }
    if (!dup) W.buildings.push(m);
  }
  if (W.buildings.length > from) indexBuildings(from);
  return W.buildings.length - from;
}

const FAKE_ST =['Ocean Drive', 'Vice Boulevard', 'Sunshine Avenue', 'Flamingo Way',
  'Palm Parkway', 'Neon Street', 'Marina Road', 'Sunset Strip', 'Coral Avenue',
  'Bayshore Drive', 'Starfish Lane', 'Chrome Street', 'Lagoon Road'];
const FAKE_ZONE = ['Downtown', 'Little Habana', 'Beachfront', 'The Docks', 'Vice Point'];

/* A neon grid city, for when the network is down or the map is all ocean. */
/* THE BUNDLED CITY — Stari grad, the old town of Belgrade, real OpenStreetMap
   data captured from a real session and shipped with the game. Loaded when the
   map servers cannot be reached.

   It replaces the generated grid, which was only ever a way of not showing an
   error screen: a place with real streets, real junctions and nearly four
   thousand real buildings is a far better offline game than a lattice, and it is
   the same data the online path builds from, so nothing downstream can tell the
   difference. Its arterial skeleton reaches 15 km, so the fallback is a 30 km
   world rather than the pocket the first version bundled.

   Pulled in ON DEMAND, as a <script> tag rather than a fetch. Four megabytes has
   no business loading on the normal path, and fetch() is refused for file://
   URLs while a script tag is not — opening index.html straight off disk has to
   keep working. Kept to one attempt: if it will not load, the generated city is
   still there underneath. */
let offlinePromise = null;
function loadOfflineCity() {
  if (window.OFFLINE_CITY) return Promise.resolve(window.OFFLINE_CITY);
  if (offlinePromise) return offlinePromise;
  offlinePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // stamped like everything else, so a new build never pairs a fresh world.js
    // with four megabytes of city cached from an older one
    s.src = 'data/belgrade.js' + (window.BUILD ? '?v=' + window.BUILD : '');
    s.onload = () => window.OFFLINE_CITY ? resolve(window.OFFLINE_CITY)
                                         : reject(new Error('offline city empty'));
    s.onerror = () => reject(new Error('offline city missing'));
    document.head.appendChild(s);
  });
  return offlinePromise;
}

/* AND STARTED BEFORE ANYBODY ASKS FOR IT, once a mirror has said no.

   The bundle is six megabytes. It used to begin downloading at the moment the
   game had already given up on the network — so the fallback that exists to
   rescue a bad connection was itself a six megabyte download over that same bad
   connection, added to the end of a wait the player had already sat through.

   A refused mirror is the signal. It is not proof the load will fail, so this is
   held back until the loading screen has been watching refusals for a few
   seconds (see paintProgress) rather than firing on the first stumble — by then
   the fallback is likely, and the file is coming off the same static host that
   served the game itself rather than off Overpass. If the streets turn up after
   all, the download is wasted bandwidth and nothing else; the promise is simply
   never read. */
function warmOffline() { loadOfflineCity().catch(() => {}); }

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

/* THE MASK STOPS GROWING BEFORE THE WORLD DOES.

   It is 8 m cells at two bits each, so its cost is the square of how far it
   reaches: 19.4 MB across 72 km, 39 MB across 100, and 156 MB across 200. The
   world itself is only road geometry and spatial hashes, which cost what the
   roads cost — a wide skeleton is sparse motorways and weighs a few megabytes.
   So the mask is the one thing that cannot follow the world outwards, and it is
   given its own box: centred on where you started, MASK_HALF in each direction,
   and it simply stops there.

   Nothing is lost that was ever really there. The mask exists for the off-road
   penalty, and the penalty is already gated on roadDataHere() — on whether we
   actually KNOW there is no road under the car, rather than merely having
   nothing to say. Beyond the mask we have nothing to say, so the honest answer
   out there is the one that ground already gets while a tile is in flight: drive
   it, at speed, with no penalty. Sixty kilometres from where you started, on a
   motorway through farmland, that is also the right game. */
const MASK_HALF = 36000;

// Grow the drivable mask to cover new bounds.
function fitGrid(x0, y0, x1, y1) {
  const pad = 40;
  const nMinX = Math.min(W.minX, x0 - pad), nMinY = Math.min(W.minY, y0 - pad);
  const nMaxX = Math.max(W.maxX, x1 + pad), nMaxY = Math.max(W.maxY, y1 + pad);
  const grew = !(W.grid && nMinX === W.minX && nMinY === W.minY &&
                 nMaxX === W.maxX && nMaxY === W.maxY);
  W.minX = nMinX; W.minY = nMinY; W.maxX = nMaxX; W.maxY = nMaxY;

  // the mask covers the world, clipped to its own box
  const gx0 = Math.max(nMinX, -MASK_HALF), gy0 = Math.max(nMinY, -MASK_HALF);
  const gx1 = Math.min(nMaxX, MASK_HALF), gy1 = Math.min(nMaxY, MASK_HALF);
  const gw = Math.max(1, Math.ceil((gx1 - gx0) / W.cell));
  const gh = Math.max(1, Math.ceil((gy1 - gy0) / W.cell));
  if (W.grid && gx0 === W.gx0 && gy0 === W.gy0 && gw === W.gw && gh === W.gh) return grew;

  /* Fresh and empty — the old marks are NOT carried across. They used to be, by
     blitting row by row, and that faithfully preserved the hole every road left
     when it ran off the edge of the smaller mask. Every caller re-marks after a
     grow for exactly that reason, so the blit was already doing nothing but
     hiding the bug, and packed rows do not begin on byte boundaries anyway. */
  W.gx0 = gx0; W.gy0 = gy0;
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
  const touched = new Set();
  for (const r of roads) {
    if (!r.drive) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = dist(a.x, a.y, b.x, b.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        const arr = W.buckets.get(Math.floor(x / W.bcell) + ',' + Math.floor(y / W.bcell));
        if (!arr) continue;
        for (const bi of arr) {
          const bl = W.buildings[bi];
          if (x < bl.bb.x0 || x > bl.bb.x1 || y < bl.bb.y0 || y > bl.bb.y1) continue;
          if (!pointInPoly(bl.pts, x, y)) continue;
          bl.passable = true;
          /* AND WHERE THE ARCHWAY IS, which the chase view needs and the
             top-down one never did. Knowing a building is passable is enough to
             turn its collision off; to cut a hole in the right wall you have to
             know which wall and how wide. Every centreline sample inside the
             footprint is averaged, so the gate lands in the middle of the span
             the road actually occupies rather than on whichever edge was
             sampled first, and the width comes from the road's own. */
          const g = bl.gate || (bl.gate = { sx: 0, sy: 0, n: 0, w: 0, ux: 0, uy: 0,
                                            pmin: Infinity, pmax: -Infinity });
          g.sx += x; g.sy += y; g.n++;
          g.w = Math.max(g.w, r.w / 2 + 1.0);
          /* AND WHICH WAY IT RUNS. The centre of the crossing is not enough to
             find the walls: it is the average of the samples inside the
             footprint, so it sits in the MIDDLE of the building, which is by
             construction as far from both walls as the passage is deep. Asking
             which wall is near it finds none — on a 5 m passage every wall is
             2.6 m away, and on a 15 m block, 7.5. What locates a gateway is the
             LINE the road takes, and which walls it crosses. */
          if (!g.ux && !g.uy) { g.ux = ux; g.uy = uy; }
          const pr = x * g.ux + y * g.uy;
          if (pr < g.pmin) g.pmin = pr;
          if (pr > g.pmax) g.pmax = pr;
          touched.add(bl);
        }
      }
    }
  }
  /* Averaged at the end rather than on the way, because a road is sampled every
     six metres and this runs again every time a tile lands. */
  for (const bl of touched) {
    bl.gate.x = bl.gate.sx / bl.gate.n;
    bl.gate.y = bl.gate.sy / bl.gate.n;
  }
}

/* Landmarks you're meant to drive into, so they go transparent and stop colliding
   exactly like a building with a road through it. Both tagging styles land here:
   the way form, where the hospital IS the building, and the node form, where a
   garage node sits inside someone else's footprint.

   AND HOW HIGH THE BEACON HAS TO START. Transparent is a 2D word: the top-down
   view draws these at 45% alpha, the chase view draws a solid box like any
   other, and a landmark's marker column stands at the POI — which for the way
   form is the middle of the building's own floor. A thirteen-metre column
   inside a twenty-metre block is not a marker, it is furniture nobody will ever
   see, and the only reason it ever showed was that half the city's walls were
   being culled away by a winding bug. So the height of whatever the POI is
   standing in is recorded here, where the containing building is already being
   looked up, and the column starts on its roof. */
/* A name arriving after the fact has to reach the geometry, which was built
   without it. The 3D renderer may never have been switched on, so this asks
   rather than assumes. */
function signChanged(b) {
  if (typeof dirtyCellAt === 'function') dirtyCellAt(b.cx, b.cy);
}
function markPOIBuildings() {
  for (const p of W.pois) {
    p.lift = 0;
    const arr = W.buckets.get(Math.floor(p.x / W.bcell) + ',' + Math.floor(p.y / W.bcell));
    if (!arr) continue;
    for (const bi of arr) {
      const b = W.buildings[bi];
      if (p.x < b.bb.x0 || p.x > b.bb.x1 || p.y < b.bb.y0 || p.y > b.bb.y1) continue;
      if (!pointInPoly(b.pts, p.x, p.y)) continue;
      b.passable = true;
      if (b.h > p.lift) p.lift = b.h;
      /* AND THE SHOP LENDS THE BUILDING ITS NAME. A block of flats is rarely
         named in OSM and the bakery on its ground floor almost always is, which
         is the right way round for a street sign: what you read on a facade is
         the business, not the freeholder. A name the building already has wins,
         because that is the more specific fact. */
      if (!b.sign && p.name) {
        b.sign = p.name.slice(0, 34); b.food = !!p.food; signChanged(b);
      }
    }
  }
  /* AND THE SHOPFRONTS, which is where most of a street's names actually live.
     Same walk, without the passable flag: a supermarket does not make the block
     above it something you can drive through. A name the building already has
     wins, because it is the more specific fact — the block is called what it is
     called, whatever opened on its ground floor. */
  for (const q of W.shops) {
    const arr = W.buckets.get(Math.floor(q.x / W.bcell) + ',' + Math.floor(q.y / W.bcell));
    if (!arr) continue;
    for (const bi of arr) {
      const b = W.buildings[bi];
      if (b.sign) continue;
      if (q.x < b.bb.x0 || q.x > b.bb.x1 || q.y < b.bb.y0 || q.y > b.bb.y1) continue;
      if (pointInPoly(b.pts, q.x, q.y)) {
        b.sign = q.name; b.food = !!q.food; signChanged(b); break;
      }
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
  W.shops = []; W.shopKeys = new Set(); addShops(data.shops || []);
  W.name = name; W.procedural = procedural; W.sweptTo = 0; W.sweeping = false;
  W.tiles = new Map(); W.fixed = new Set();
  W.skelRect = null; WIDE_MAP = false;       // a new city starts with no wide map
  MAPV.s = 0;                                // and on the map's default framing
  ROADED.clear();                            // and none of its tiles have streets yet
  W.bundled = false;                         // and streams, unless it came from disk
  RESERVED = '';                             // and reserves its own ground again
  // a real map streams; the generated city is a fixed island. The opening tile's
  // streets arrive here rather than through loadTile, so it has to book itself in
  // as roaded or driving back to where you started re-downloads them.
  if (!procedural) { W.tiles.set('0,0', 'loaded'); W.fixed.add('0,0'); ROADED.add('0,0'); stampTile(data, '0,0'); }

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
  W.gx0 = W.gy0 = 0;

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
const CHUNK = { busy: false, preloading: false, last: 0, loaded: 1, failed: 0, evicted: 0,
                note: '', mergeMs: 0, mapMs: 0, retryAt: new Map(), tries: new Map() };

/* True once an arterial skeleton has landed, which changes what recycling a tile
   is allowed to throw away — see evictFarTiles. It used to mean more than that:
   tiles stopped carrying roads at all, on the reasoning that the skeleton was the
   road network and nothing else needed asking for.

   THAT WAS WRONG, AND IT IS WHY A NEIGHBOURHOOD ARRIVES AS BUILDINGS ON BARE
   GROUND. The skeleton is arterials — motorway, trunk, primary, secondary — and
   deliberately so, because residential lanes are the overwhelming majority of a
   city's ways and asking for them over a 200 km box is a query no server will
   answer. But residential lanes are also every street in the district you
   actually live in. Drive one tile out of the detailed opening ring into
   somewhere like Репиште and the skeleton has nothing to say: the buildings
   stream in and the streets between them never do, so the car sits on open
   ground at walking pace with a city drawn around it. */
let WIDE_MAP = false;

/* Tiles whose streets have already been folded in. Roads outlive the tile that
   brought them (see evictFarTiles), so driving back into a recycled district
   needs its scenery again but never its streets. */
const ROADED = new Set();

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

    /* Streets first: that's what extends the drivable world, and every tile needs
       them. The one tile that does not is one we have already had the streets of
       and then recycled the scenery from — its roads never left. */
    if (!ROADED.has(key)) {
      const els = await overpassArea(s, w, n, e, sess, { kind: 'streets' });
      const data = parseOSM(els);
      /* An empty answer means two different things depending on what is behind
         it. With a wide map there is a road network already and this tile is
         simply open country — plenty of real ground has no streets on it, and
         failing here would retry a field forever on backoff. With no skeleton the
         streets ARE the world, and a tile without them is a tile that has not
         arrived. (An empty reply from a broken mirror never reaches this: geo.js
         hands those to the next mirror and only resolves empty once they all
         agree the ground is empty.) */
      if (!data.roads.length && !W.skelRect) throw new Error('empty tile');
      const t0 = performance.now();
      mergeChunk(data, key);
      CHUNK.mergeMs = Math.round(performance.now() - t0);
      ROADED.add(key);
    }
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
  /* WHAT A RECYCLED TILE ACTUALLY GIVES BACK IS ITS SCENERY.

     Buildings are the bulk of both the bytes and the draw, and a district you
     are 20 km away from can go. Its ROADS stay, and that is not a concession —
     it is what makes streaming them affordable at all. Dropping a road means
     un-marking it from the drivable mask, and the mask cannot un-mark: cells are
     shared between overlapping ways, so the only correct answer is to clear it
     and re-mark every road in the world. At skeleton scale that is tens of
     thousands of ways, and with a tile budget this size it would run on nearly
     every tile load — a stutter every few hundred metres, for ever.

     Keeping them costs geometry and nothing else. The mask is already at full
     size the moment the skeleton lands and never resizes again, so folding in a
     new tile only marks that tile's own roads: mergeChunk is additive, and this
     stays out of its way. */
  const shed = WIDE_MAP ? [W.buildings] : [W.roads, W.buildings];
  // Let the ids go with whatever is actually leaving, or driving back into a
  // recycled district finds every building deduped away against a copy that no
  // longer exists. Roads that stay keep their ids, so their tile is never
  // re-downloaded for them either.
  for (const arr of shed)
    for (const f of arr) if (!keep(f) && f.id != null) W.roadIds.delete(f.id);
  W.buildings = W.buildings.filter(keep);
  W.parks = W.parks.filter(keep);
  // landmarks stay: a handful of points, they never touch the grid bounds, and
  // dropping them would throw away the wide sweep and leave a bust nowhere to go

  if (WIDE_MAP) {
    // Only scenery went, so only the building hash is stale. The roads, the mask,
    // driveRoads, the road hashes and the lights are all untouched.
    W.buckets.clear();
    indexBuildings(0);
    markPOIBuildings();
  } else {
    // No skeleton, so the world is only ever as big as the tiles in hand and
    // roads have to go with them. Everything derived is rebuilt, as it always was.
    W.roads = W.roads.filter(keep);
    W.places = W.places.filter(keep);
    for (const k of drop) ROADED.delete(k);
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
  /* Deliberately NOT held off by a retry in flight, though it was tried. A
     skeleton retry holds its session for as long as the ladder runs, and blocking
     the streamer for that meant the tiles ahead of a car at 90 m/s stopped
     arriving — trading a rare stale map for a reliable hole in the road, which is
     the worse half of the deal. Two requests is also exactly the budget Overpass
     hands out per IP, and the retry already refuses to start while a tile or its
     scenery is in the air, so this is at most one of each and never a burst. */
  if (CHUNK.busy || CHUNK.preloading) return;
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
  /* A TILE WITH NOTHING IN IT STILL GREW THE MASK, AND GROWING THE MASK EMPTIES
     IT. fitGrid hands back a fresh zeroed Uint8Array whenever the box changes
     size — every caller re-marks afterwards for exactly that reason — and this
     early return was jumping over the re-mark. The whole drivable world went
     blank, silently, and stayed blank until the player next crossed a tile seam
     in a direction that happened to grow the grid again.

     "Nothing in it" is not rare, either. It is open water, it is countryside,
     and it is any neighbour tile whose ways all carry ids we already hold — a
     way lying along a seam arrives with both its tiles, so a small fixture or a
     sparse area dedupes to nothing routinely. The symptom is a car crawling at
     14 km/h down the middle of a road that is drawn perfectly, which is the
     third separate way this game has found to report "no roads". */
  if (!(data.roads.length || data.buildings.length || data.parks.length)) {
    if (grew) markRoads(W.roads);
    return 0;
  }
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
  addShops(data.shops || []);

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
  /* Out of the mask entirely — bail before the disc loop rather than inside it.
     A 100 km skeleton is tens of thousands of kilometres of motorway stepped
     every five metres, and almost all of it now falls outside a mask that stops
     at 36: the per-cell bounds check still gave the right answer and did it
     millions of times over. */
  if (x < W.gx0 - r || y < W.gy0 - r ||
      x > W.gx0 + W.gw * W.cell + r || y > W.gy0 + W.gh * W.cell + r) return;
  const gx = Math.floor((x - W.gx0) / W.cell), gy = Math.floor((y - W.gy0) / W.cell);
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
  const gx = Math.floor((x - W.gx0) / W.cell), gy = Math.floor((y - W.gy0) / W.cell);
  if (gx < 0 || gy < 0 || gx >= W.gw || gy >= W.gh) return false;
  return gridGet(gy * W.gw + gx) === 1;
}
// Anything painted as tarmac, road network or not. Only the off-road penalty
// asks this: what it needs to know is "does this LOOK like road under the car",
// because punishing a player who is plainly on a paved surface reads as a bug.
function onTarmac(x, y) {
  const gx = Math.floor((x - W.gx0) / W.cell), gy = Math.floor((y - W.gy0) / W.cell);
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
  const gx = Math.floor((x - W.gx0) / W.cell), gy = Math.floor((y - W.gy0) / W.cell);
  let bd = Infinity, bx = 0, by = 0;
  for (let r = 1; r <= maxCells; r++) {
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;      // the ring, not the block
      const cx = gx + i, cy = gy + j;
      if (cx < 0 || cy < 0 || cx >= W.gw || cy >= W.gh) continue;
      if (gridGet(cy * W.gw + cx) === 0) continue;      // any tarmac will do
      const wx = W.gx0 + (cx + .5) * W.cell, wy = W.gy0 + (cy + .5) * W.cell;
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
// is this point inside the mask's own box, whatever the world does beyond it?
function inMask(x, y) {
  return x >= W.gx0 && y >= W.gy0 &&
         x < W.gx0 + W.gw * W.cell && y < W.gy0 + W.gh * W.cell;
}
function roadDataHere(x, y) {
  if (W.procedural) return true;                     // the generated city is all there is
  /* Past the edge of the mask there is nothing to consult, so there is nothing
     to know — and "no road here" from a mask that does not reach this far is the
     same false negative as "no road here" from a tile still in flight. Both must
     leave the penalty alone. */
  if (!inMask(x, y)) return false;
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

/* WHAT A REPAIR COSTS, WHICH IS WHAT THERE IS TO REPAIR.

   It was a flat thousand, which is the wrong shape twice over: a thousand for a
   scratch is a bill nobody pays, so a lightly dented car simply drove past the
   garage, and a thousand for a wreck is the same bill as the scratch, so there
   was never a moment where limping in was worth it. A price that follows the
   damage makes the garage a decision instead of a fixed toll.

   Linear in the health that is missing, between the two ends asked for: $100 at
   a scratch, $1000 at nearly dead. Rounded to the nearest ten, because a bill
   reading $317 in a game about a neon city is a spreadsheet.

   Note the FLOOR APPLIES AT FULL HEALTH TOO — repairAt never fires on an
   undamaged car, but the radar hint prices the shop from wherever you are, and
   quoting $0 for a garage you cannot use would be worse than quoting its
   minimum. */
const REPAIR_MIN = 100, REPAIR_MAX = 1000;
function repairCost(hp) {
  const missing = Math.max(0, Math.min(100, 100 - (hp == null ? 0 : hp))) / 100;
  return Math.round((REPAIR_MIN + (REPAIR_MAX - REPAIR_MIN) * missing) / 10) * 10;
}

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

/* Every kind the sweep will widen for. The fire station and the taxi rank are
   in here for the same reason the other three are: a shift cannot start at a
   depot the city does not have, and the opening 1.8 km of a real city very
   often has neither. If the ladder runs out and one is still missing, that
   job is simply not on offer here — which is what the data says. */
const POI_KINDS = ['police', 'hospital', 'repair', 'fire', 'taxi'];
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
    const mons = addMonuments(parseMonuments(els));
    const found = W.pois.length - before;
    if (found || mons) { markPOIBuildings(); prerenderMap(); }   // radar and drive-through
    return { radius: R, missing, found, stillMissing: missingKinds() };
  } catch (err) {
    /* A RUNG THAT WAS REFUSED WAS NEVER SEARCHED, so it must not count as
       searched. W.sweptTo only ever goes up, which is right for a radius that
       came back with nothing in it — widening is the correct next move — and
       wrong for one that never got an answer at all.

       With every landmark request refused during a load, the sweep walked the
       whole ladder in a few seconds, left sweptTo past the end of it, and from
       then on widenLandmarkSearch returned null before sending anything. The
       retry scheduler then logged three attempts, made zero requests, and the
       session ended with no hospital and no police station anywhere — which is
       the exact failure that scheduler exists to undo.

       It stayed hidden while a refused query took twenty seconds to give up,
       because the sweep's own six-second budget stopped it after one rung and
       left three in hand. Making the mirrors fail fast is what turned a latent
       bug into a certain one. */
    W.sweptTo = Math.max(0, W.sweptTo - 1);
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
/* The wide city, fetched once. Walks 60 km, then 36, 18, 9 — a server that
   won't answer for the big box will often answer for a smaller one, and the
   biggest world that server would give us is the one we want. First success wins;
   if the whole ladder fails you still have the detailed centre and the game
   starts.

   THE LADDER IS FOR REFUSALS, NOT FOR EMPTY GROUND, and those arrive down
   different paths on purpose. A rung that THREW was turned away — a 429, a
   timeout, a box too big — and a smaller box is a fair thing to try next. A rung
   that RESOLVED with no roads in it means all six mirrors agreed there are no
   arterials out there, and a smaller box inside an empty one cannot hold any:
   descending is four more rungs of asking servers a question they have already
   answered. Each rung costs about twelve seconds, because unanimity means waiting
   for the sixth mirror, so telling the two cases apart is the difference between
   a one-second start and a minute of loading screen for anyone in open country. */
async function loadSkeleton(onMsg) {
  const until = Date.now() + SKELETON_WAIT;
  for (let rung = 0; rung < SKELETON_RADII.length; rung++) {
    if (Date.now() > until) break;
    const R = SKELETON_RADII[rung];
    const sess = newSession();
    let emptyEverywhere = false;
    try {
      if (onMsg) onMsg('Mapping ' + Math.round(R / 1000) + ' km of city…');
      const s = unprojLat(R), w = unprojLon(-R), n = unprojLat(-R), e = unprojLon(R);
      const els = await overpassArea(s, w, n, e, sess, {
        kind: 'arterials', radius: R, totalMs: Math.min(SKELETON_MS[rung], until - Date.now()),
        label: 'Mapping ' + Math.round(R / 1000) + ' km of city…', onMsg
      });
      const data = parseOSM(els);
      // resolved, not refused, and with nothing in it: that is the ground talking
      if (!data.roads.length) { emptyEverywhere = true; throw new Error('no arterials out there'); }
      // Set before merging: mergeChunk sizes the grid off this rectangle, and it
      // has to grow even when every road in the response was already a duplicate.
      W.skelRect = { x0: -R, y0: -R, x1: R, y1: R };
      W.skelBundled = false;          // the real thing, not the stand-in
      const added = mergeChunk(data, 'skel');
      return { radius: R, roads: added, places: data.places.length };
    } catch (err) {
      console.warn('skeleton ' + R + 'm:', err && err.message);
      // answered, and the answer was "nothing" — a smaller box holds nothing too
      if (emptyEverywhere) break;
    } finally {
      sessAbort(sess);
    }
  }
  return bundledSkeleton();
}

/* EVERY RUNG REFUSED, AND THERE IS A REAL SKELETON IN THE BUNDLE.

   Reported from a phone in Belgrade: sixty kilometres timed out, then
   thirty-six, then eighteen, then nine, and the session ended up in a five and a
   half kilometre box with no arterials in it at all — while data/belgrade.js sat
   in the same download holding 6,585 ways of that city's real motorways and
   boulevards, because the offline city only ever loaded when EVERYTHING failed.
   Partial failure is the common case, not total failure: the streets for the
   tile you are standing on are one small request and they nearly always arrive,
   and it is the wide sweep — the biggest, slowest query the game makes — that
   the mirrors refuse.

   ONLY IF IT IS THE SAME CITY. The bundle is Belgrade; grafting it under
   somebody who typed Osaka would be worse than no skeleton at all. It carries
   its own centre and the radius it was clipped to, so the test is whether this
   session's origin lies well inside that — and the box handed to the grid is the
   part of it that genuinely surrounds the player, not the part that runs off the
   edge of what was bundled. */
async function bundledSkeleton() {
  let city = null;
  try { city = await loadOfflineCity(); } catch (e) { return null; }
  if (!city || !city.skeleton || !city.skeleton.length || !city.skeletonRadius) return null;
  // where the bundle's centre falls in THIS session's coordinates
  const dx = projX(city.lon), dy = projY(city.lat);
  const half = Math.round(city.skeletonRadius - Math.hypot(dx, dy));
  // less than this and the offline horizon is no wider than the tiles already are
  if (!(half >= 5000)) return null;
  const data = parseOSM(city.skeleton);
  if (!data.roads.length) return null;
  W.skelRect = { x0: -half, y0: -half, x1: half, y1: half };
  W.skelBundled = true;
  const added = mergeChunk(data, 'skel');
  return { radius: half, roads: added, places: data.places.length, bundled: true };
}

/* THIS RUNS WHILE YOU ARE DRIVING, not while you are watching a bar.

   It used to be the last thing the loading screen waited for, raced against a
   twelve second cap — and eight sequential street requests is most of that cap
   in any real city. What it buys is the difference between starting in a 1.8 km
   square and a 5.4 km one, which is worth having and is not worth twelve seconds
   of a player's attention, because the ground it covers is ground you reach
   seconds later anyway.

   The proximity streamer would eventually fetch all eight on its own — standing
   at the origin, every neighbour is inside the look-ahead — but it takes them one
   per cooldown, so the ring would trickle in over twenty seconds. Back to back is
   the point of doing it here, and CHUNK.preloading holds the streamer off
   meanwhile so the two never have two requests in the air at once. */
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
  CHUNK.preloading = true;
  try {
    for (const [i, j] of ring) {
      if (Date.now() > until) break;
      if (await loadTile(i, j)) {
        // The opening city is permanent however late it arrives. loadTile only
        // marks tiles fixed before play starts, and this no longer runs before
        // play starts — without saying so here, the nine tiles you began in
        // would become the first things recycled.
        W.fixed.add(tileKey(i, j));
        got++;
      }
      if (onEach) onEach(got, ring.length);
    }
  } finally { CHUNK.preloading = false; }
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
    /* A refused rung stops the sweep rather than moving on to a wider one. It
       has just put its radius back in the pot (see the catch in
       widenLandmarkSearch), so carrying on would ask the same servers the same
       question again inside the same second — and every mirror has already said
       no to it. Whether to ask again is the retry scheduler's decision, and it
       makes it in minutes rather than milliseconds. */
    if (r.err) break;
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
  // and the monuments, which are in the building list rather than the POI list
  for (const b of W.buildings) {
    if (!b.mono) continue;
    g.fillStyle = MONU_COL;
    g.beginPath(); g.arc(b.cx, b.cy, dot, 0, TAU); g.fill();
  }
  W.map = c;
}
