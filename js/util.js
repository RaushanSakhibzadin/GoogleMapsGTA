"use strict";
/* VICE MAPS — Utilities, palette and the theme. Nothing here depends on anything else.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters. */

/* ------------------------------ 0. utils ------------------------------ */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b));
const pick  = a => a[Math.floor(Math.random() * a.length)];
// Fisher-Yates, in place and returned, so a list can be shuffled where it's declared
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = randi(0, i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
// "https://overpass.kumi.systems/api/interpreter" -> "kumi.systems", for messages
const host = u => { try { return new URL(u).hostname.replace(/^(www\.|overpass[-.])/, ''); } catch (e) { return 'map server'; } };
const dist2 = (x1, y1, x2, y2) => { const dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy; };
const dist  = (x1, y1, x2, y2) => Math.sqrt(dist2(x1, y1, x2, y2));
// shortest signed angle from a to b
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
// frame-rate independent decay: fraction of a value removed over dt at rate k
const decay = (k, dt) => 1 - Math.exp(-k * dt);

const $ = id => document.getElementById(id);

/* ------------------------------ 1. colour ------------------------------ */
/* Buildings hold a base *material* colour as [r,g,b]; each theme turns that into
   the roof and wall strings the renderer draws. That's what makes N instant. */
const rgb = (r, g, b) => [r, g, b];
const css = c => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
const lum = c => .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
const mul = (c, k) => [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const NAMED = {
  white: [242, 240, 235], black: [42, 42, 44], grey: [150, 150, 148], gray: [150, 150, 148],
  silver: [186, 188, 190], red: [158, 74, 58], maroon: [110, 52, 46], brown: [124, 90, 66],
  beige: [222, 208, 180], cream: [235, 224, 198], tan: [206, 182, 146], yellow: [222, 196, 128],
  orange: [200, 128, 72], green: [104, 124, 92], blue: [104, 128, 156], pink: [226, 186, 186],
  sandstone: [214, 190, 152], terracotta: [178, 92, 62], concrete: [176, 174, 166]
};
// accepts "#abc", "#aabbcc" and the common CSS names mappers actually use
function parseColour(v) {
  if (!v) return null;
  v = String(v).trim().toLowerCase();
  if (v[0] === '#') {
    if (v.length === 4) return [parseInt(v[1] + v[1], 16), parseInt(v[2] + v[2], 16), parseInt(v[3] + v[3], 16)];
    if (v.length === 7) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
    return null;
  }
  return NAMED[v] || null;
}

/* Real facade and roof materials. */
const MAT = {
  concrete:  [rgb(176, 174, 166), rgb(160, 158, 150), rgb(190, 188, 179)],
  stucco:    [rgb(228, 214, 188), rgb(214, 198, 170), rgb(238, 228, 206)],
  sand:      [rgb(212, 190, 152), rgb(198, 176, 140), rgb(222, 204, 168)],
  brick:     [rgb(150, 88, 68), rgb(134, 76, 58), rgb(166, 104, 80)],
  stone:     [rgb(198, 192, 178), rgb(182, 176, 162), rgb(210, 205, 192)],
  glass:     [rgb(138, 158, 174), rgb(120, 142, 162), rgb(154, 174, 188)],
  metal:     [rgb(146, 148, 152), rgb(128, 130, 136), rgb(162, 164, 168)],
  wood:      [rgb(158, 126, 92), rgb(140, 110, 80), rgb(174, 144, 110)],
  white:     [rgb(238, 234, 226), rgb(228, 222, 212), rgb(244, 242, 236)],
  pastel:    [rgb(238, 200, 194), rgb(200, 226, 220), rgb(244, 226, 186), rgb(212, 206, 232)]
};
const ROOFMAT = {
  asphalt:   [rgb(122, 120, 118), rgb(108, 106, 105), rgb(134, 132, 129)],
  gravel:    [rgb(158, 152, 142), rgb(142, 137, 128)],
  tile:      [rgb(176, 94, 64), rgb(158, 82, 56), rgb(192, 110, 76)],
  membrane:  [rgb(206, 204, 198), rgb(190, 188, 182)],
  metalroof: [rgb(150, 154, 158), rgb(132, 137, 142)],
  slate:     [rgb(104, 108, 116), rgb(92, 96, 104)]
};

/* Two complete looks. PAL is the live one; every draw call reads it. */
const THEMES = {
  dusk: {
    ground: '#0d0718',
    park: '#123a2a', parkEdge: '#2a7a52', kerb: '#2b2140', case: '#080512',
    road: '#2f2848', roadBig: '#382f54', line: 'rgba(255,227,106,.55)',
    mapBg: '#0a0614', mapPark: '#17492f',
    mapRoad: '#655488', mapRoadBig: '#9b81d8',
    lights: true, showNeon: true,
    // night: dim hard and pull towards the violet ambient, so brick still reads
    // warmer than concrete but the neon and street lights carry the colour
    roofT: c => mixc(mul(c, .30), [54, 36, 78], .46),
    wallT: c => mixc(mul(c, .17), [38, 26, 58], .50)
  },
  day: {
    ground: '#cfc9bd',
    park: '#9dbf86', parkEdge: '#7ba368', kerb: '#c2bcb1', case: '#8d887f',
    road: '#a6a29b', roadBig: '#b2aea6', line: 'rgba(250,240,190,.85)',
    mapBg: '#e8e3d8', mapPark: '#b7d0a2',
    mapRoad: '#ffffff', mapRoadBig: '#ffe9a8',
    lights: false, showNeon: false,
    // daylight: near-true colour on top, honest shading down the walls
    roofT: c => mul(c, 1.0),
    wallT: c => mul(c, .66)
  }
};

const PAL = {
  neon:    ['#ff4fd8', '#33e6ff', '#ffe36a', '#8a5cff', '#48ff9e'],
  carBody: ['#ff4fd8', '#33e6ff', '#ffe36a', '#48ff9e', '#ff7043', '#c9a2ff',
            '#f5f5f5', '#7de3ff', '#ff5f8d', '#9be15d']
};
let themeName = 'dusk';
for (const k in THEMES.dusk) if (typeof THEMES.dusk[k] !== 'function') PAL[k] = THEMES.dusk[k];

/* Resolve every building's stored material into this theme's drawn colours.
   Runs on theme change and at world build — thousands of buildings in a few ms,
   which is why drawBuilding never has to know a theme exists. */
// Turn stored materials into drawn colours for the active theme. Runs over the
// whole world on a theme change, or over just a newly streamed-in chunk.
function resolveColours(list) {
  const t = THEMES[themeName];
  for (const b of list || []) {
    let roof = t.roofT(b.mRoof), wall = t.wallT(b.mWall);
    // the extrusion only reads as a solid while the roof stays brighter than the wall
    if (lum(roof) < lum(wall) + 18) wall = mul(wall, (lum(roof) - 18) / Math.max(lum(wall), 1));
    b.roof = css(roof); b.wall = css(wall);
  }
}

function applyTheme(name) {
  themeName = name;
  const t = THEMES[name];
  for (const k in t) if (typeof t[k] === 'string' || typeof t[k] === 'boolean') PAL[k] = t[k];
  resolveColours(W.buildings);
  document.body.classList.toggle('theme-day', name === 'day');
  if (W.roads && W.roads.length) prerenderMap();   // roads alone are enough to draw a map
}
