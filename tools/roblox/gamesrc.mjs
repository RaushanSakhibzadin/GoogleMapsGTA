/* RUN THE GAME'S OWN CODE, rather than a second copy of it.
 *
 * The bake needs exactly what the browser needs: the equirectangular
 * projection, ROADW, parseOSM, buildingColours, standingBuilding, osmName. All
 * of it already exists in js/util.js, js/geo.js and js/world.js, and all of it
 * is plain JS with no DOM in any code path this file reaches — the handful of
 * document/localStorage references in those files are inside functions the bake
 * never calls (loadOfflineCity, toggleTheme, the sign canvas).
 *
 * So they are evaluated in a Node vm with a small shim instead of being ported.
 * The alternative — a second implementation of colour, height and name rules in
 * this directory — would drift from the game within a month, and the drift
 * would be silent: the city would just start looking slightly wrong.
 *
 * ONE SUBTLETY. `const` and `let` at the top level of a script do NOT attach to
 * the vm's global object, only `function` declarations do. So the three files
 * are concatenated into ONE script — which puts them in one shared lexical
 * scope, exactly as the browser's shared global scope does — and an epilogue
 * assigns the bindings the bake wants onto `window`. Loading them as three
 * separate scripts compiles fine and then hands you an undefined ROADW.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

/* The load order from index.html, for the three files the bake needs. It
   matters here for the same reason it matters in the browser: geo.js reads
   PAL and world.js reads both. */
const FILES = ['js/util.js', 'js/geo.js', 'js/world.js', 'js/gl.js'];

/* Everything the pipeline is allowed to reach for. Naming them explicitly is
   what turns "world.js changed and the bake broke" into a ReferenceError at
   line one of the bake, with the missing name in it, instead of an undefined
   spreading quietly through the geometry. */
const WANTED = [
  'ROADW', 'DRIVABLE', 'GEO', 'setOrigin', 'projX', 'projY',
  'parseOSM', 'buildingColours', 'standingBuilding', 'osmName',
  'polyArea', 'centroid', 'bbox', 'POI_KIND', 'MONU_KIND',
  'clamp', 'parseColour', 'PAL', 'MAT', 'ROOFMAT',
  // the roof triangulation, so the bake and the browser cut the same roofs
  'earClip', 'windingOf'
];

let CACHE = null;

export function gameSrc(root = process.cwd()) {
  if (CACHE) return CACHE;

  /* A deliberately BARE context. Anything the three files touch that is not in
     here throws at load, which is the point: it is a standing check that no
     browser dependency has crept into the parsing path. `window` points at the
     context itself, the way it does in a browser, so `window.OFFLINE_CITY` in
     world.js:527 resolves rather than throwing. */
  const ctx = createContext({
    console, Math, JSON, Date, RegExp, Promise,
    String, Number, Object, Array, Map, Set, Symbol,
    parseFloat, parseInt, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    performance: { now: () => 0 }
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;

  const src = FILES.map(f => readFileSync(`${root}/${f}`, 'utf8')).join('\n;\n') +
              `\n;window.__BAKE__ = { ${WANTED.join(', ')} };`;

  try {
    runInContext(src, ctx, { filename: 'vice-maps-bundle' });
  } catch (e) {
    throw new Error(
      `Could not evaluate the game source for the bake (${e.message}).\n` +
      `This usually means one of ${FILES.join(', ')} grew a browser dependency ` +
      `at top level, or a name in WANTED was renamed. Fix it there, not here.`);
  }

  const X = ctx.__BAKE__;
  const missing = WANTED.filter(k => X[k] === undefined);
  if (missing.length) throw new Error(`gameSrc: missing from the game source: ${missing.join(', ')}`);

  CACHE = X;
  return X;
}

/* THE BUNDLED CITY, as data.
 *
 * data/belgrade.js is a script that assigns one global, not JSON — because
 * fetch() is refused for file:// URLs and a <script> tag is not (see the header
 * of that file). Here there is no such constraint, so it is evaluated in a
 * throwaway context with nothing in it but the one global it wants to set. */
export function loadCity(root = process.cwd(), path = 'data/belgrade.js') {
  const ctx = createContext({});
  ctx.window = ctx;
  runInContext(readFileSync(`${root}/${path}`, 'utf8'), ctx, { filename: path });
  const city = ctx.OFFLINE_CITY;
  if (!city || !city.buildings) throw new Error(`${path} did not define a usable OFFLINE_CITY`);
  return city;
}

/* A DETERMINISTIC 0..1 FROM AN INTEGER AND A SALT.
 *
 * The bake must be reproducible: two runs of the pipeline on the same input
 * have to produce byte-identical output, or the diff of a change is unreadable
 * and "did the city move?" becomes unanswerable.
 *
 * The source game is not reproducible in one specific place — about two
 * thousand of its buildings have no height and no levels, and take
 * `clamp(...) * rand(.8, 1.35)` from an unseeded Math.random (world.js:402), so
 * their heights differ on every page load. Nothing in the browser notices. A
 * baked city cannot tolerate it, so every such height comes through here
 * instead, keyed on the building's OSM way id.
 *
 * The mix is the same sin-based hash buildingColours() already uses for its own
 * per-building choices, which keeps one style of "deterministic randomness" in
 * the project rather than two. */
export function hash01(id, salt = 0) {
  const x = Math.sin((id % 2147483647) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
