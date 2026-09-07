/* THE ROBLOX BAKE — every tunable, in one file.
 *
 * The pipeline is five stages that hand JSON to each other (see README.md in
 * this directory). Everything they compute is in REAL METRES, in the game's own
 * world coordinates, and the stud scale is applied once, at the very end, in
 * 5-emit.mjs. That is deliberate: changing the scale is then a re-emit of a few
 * hundred kilobytes rather than a re-bake, and every intermediate file can be
 * read against the source game's own numbers without a conversion in your head.
 *
 * The one exception is VOXEL, which has to be in metres because it decides the
 * lattice the city is rasterised onto.
 */

export const CONFIG = {

  /* ---------------- the district ---------------- */

  /* Centre of the slice, in lat/lon. Defaults to the bundled city's own origin
     (Palilula, Belgrade) because that is where the building data actually is:
     data/belgrade.js carries streets across 6.4 km and a 30 km arterial web,
     but BUILDINGS only across about 2.5 km, so a district centred anywhere else
     comes out as roads across an empty plain. See ROBLOX_PORT_PLAN.md §1.5. */
  centre: { lat: 44.810348, lon: 20.476245 },

  /* Half-width in metres. 600 gives the 1.2 x 1.2 km slice the plan recommends
     — 3,600 studs at the scale below, which is roughly a quarter of the way to
     Roblox's precision trouble at 10,000 and needs no floating origin. */
  half: 600,

  /* ---------------- scale ---------------- */

  /* Studs per real metre. Three is the number the plan argues for: a 4.2 m car
     lands at 12.6 studs (a proper Roblox car), a five-storey building at 45,
     and a residential street at 36 studs — about three car widths, which is
     what a two-lane street should look like.
     Gravity is deliberately NOT adjusted to match. See §3.2. */
  studsPerM: 3,

  /* ---------------- how the city is drawn ----------------

   * 'flat'  -- each building extruded from its own OSM polygon and the ground
   *            as one painted surface, which is what js/render3d.js draws.
   * 'voxel' -- rasterised onto the lattice below, as cubes or hex prisms.
   *
   * Measured on this district, and the gap is not marginal:
   *
   *       voxel, hex 2.5 m, windows    252,817 parts
   *       flat, extruded footprints      3,039 parts
   *
   * Both paths are kept and both are baked, so switching is one line here and a
   * reconnect. The lattice settings below only matter to 'voxel'. */
  render: 'flat',

  /* ---------------- the lattice ----------------

   * 'square' or 'hex'. See tools/roblox/lattice.mjs for the shapes; what
   * matters here is the cost, which is not symmetrical.
   *
   * Greedy meshing merges runs of identical cells in all three directions on a
   * square lattice, and that is where its 10.4x reduction comes from. Hexagons
   * tile neither into larger hexagons nor into boxes, so the only merge left is
   * VERTICAL -- a column of one colour becomes one taller prism. Measured on
   * this district at the same cell size:
   *
   *       cubes     73,354 parts   (10.4x on buildings, 11.4x on the ground)
   *       hexes    513,615 parts   (2.8x on buildings, 1.0x on the ground)
   *
   * So a hex lattice has to be coarser to cost the same. hexR below is the
   * circumradius; flat-to-flat width is sqrt(3) x that. */
  lattice: 'hex',

  /* Hex circumradius in METRES. By area alone a hex of R matches a square cell
     of side R*sqrt(1.5*sqrt(3)) = 1.61R, so R = 2.5 is about a 4 m square cell
     -- but the merge difference means the honest comparison is the part count
     printed by stage 3, not this arithmetic. */
  hexR: 2.5,


  /* Voxel edge in METRES. Four is the cheap, chunky bake; two keeps building
     outlines legible at four times the voxel count. The whole pipeline reads
     this one number — bake both and choose with your eyes, which is what M0 in
     the plan is for. */
  voxel: 2,

  /* Chunk edge in METRES, not in voxels — which is the fix for a bug the 2 m
     bake exposed. It used to be 32 voxels, and 32 voxels at 4 m is a 128 m
     chunk; at 2 m the same 32 became a 64 m chunk, so halving the voxel size
     silently quadrupled the number of chunk files to 361 and made every chunk
     an eighth of the volume it was tuned to be. Stating the size the client
     actually cares about keeps it fixed while the lattice under it changes.

     128 m is 384 studs at 3 studs/m — comfortably inside a streaming radius,
     and about a hundred chunks across the district. The client builds and
     unloads by chunk, so this is the granularity of every hitch. */
  chunkM: 128,

  /* ---------------- what gets built ---------------- */

  /* Buildings smaller than this (m^2) are dropped. parseOSM already drops
     anything under 22; at a 4 m voxel a 40 m^2 shed is a single voxel with no
     shape to it, and a city full of single-voxel stubs reads as noise. */
  minArea: 60,

  /* Clamp on building height, in metres, after derivation. The source game
     clamps to [4, 190]; nothing in this district is anywhere near 190, and a
     bad `height` tag (metres vs feet vs storeys is a real OSM mess) becomes a
     spike through the skybox. */
  minH: 4,
  maxH: 90,

  /* Metres per storey, for buildings that carry building:levels but no height.
     Matches world.js:401 exactly — do not drift from it. */
  storeyH: 3.2,

  /* ---------------- archways ----------------

   * How tall a passage through a building is, in metres. 4.2 matches GATE_H in
   * js/render3d.js, which is the height the browser cuts its archways at --
   * high enough for anything that drives and low enough that the building above
   * still reads as a building rather than as stilts. */
  gateH: 4.2,

  /* ---------------- roads ---------------- */

  /* Road classes that get a driving surface. Mirrors DRIVABLE() in geo.js:29
     — pedestrian and track are drawn but not driven. Widths come from ROADW in
     geo.js, unchanged. */
  paveNonDrivable: true,   // still lay a surface for footways, just not drivable

  /* Kerbs, as a COLOUR and not as geometry.
   *
   * The plan (§5.2) said "kerb voxels one level up along the edges". That is
   * wrong at this lattice and it is worth saying why rather than quietly
   * dropping it: a kerb is about 15 cm tall, and the smallest thing this
   * pipeline can build is a 4 m cube. A geometric kerb would be a 4 m wall
   * down both sides of every street — not a kerb, a canyon, and one you could
   * not drive over.
   *
   * So the ring of ground cells just outside each road carries the kerb colour
   * instead. It costs nothing (same layer, same part budget after meshing,
   * PAL.kerb is already a paler grey than PAL.road) and it is what actually
   * makes a voxel street read as a street. */
  kerbs: true,

  /* ---------------- windows ----------------

   * WHAT THE BROWSER DOES IN A SHADER, done in colour instead.
   *
   * js/render3d.js draws windows in the wall fragment shader: a grid anchored
   * to world coordinates so the rows line up along a whole terrace and round
   * its corners, per-window hashing for which lights are on, shopfronts at
   * street level and a plain cornice at the top. Roblox runs no custom shaders,
   * so in a voxel city the equivalent is which colour a wall cell gets.
   *
   * IT COSTS MERGE LENGTH, and that is the trade. A column of one colour
   * becomes one prism; a column that alternates wall/window/wall/window becomes
   * one prism per level. Stage 3 prints the real number -- see the README.
   *
   * The rules are the browser's, in metres:
   *   under winMinH   a shed or a lock-up, and gets none
   *   level 0         the shopfront, which is glass whatever is above it
   *   the top level   a plain cornice, so the roofline does not cut a row of
   *                   windows in half
   *   between         alternate courses, so there is wall between the rows */
  windows: true,
  winMinH: 5.5,            // matches WIN_MIN_H in render3d.js
  /* Daylight values from THEMES.day in render3d.js, as 0-255. winLit is the
     fraction of windows with a light on -- 3% by day, because in daylight a lit
     room barely reads. It is 32% in the browser's dusk theme. */
  winGlass: [77, 94, 120],
  winLit: [255, 237, 189],
  winLitFrac: 0.03,

  /* ---------------- per-voxel shading ----------------

   * How many brightness steps each material is split into. 1 is off.
   *
   * The plan claimed a hashed per-voxel colour variation "costs nothing". That
   * is wrong, and it is wrong in the most expensive possible way: greedy
   * meshing merges runs of IDENTICAL voxels, so giving every voxel its own
   * shade defeats the entire optimisation and takes the part count back to the
   * unmeshed number.
   *
   * Quantising to a few steps is the compromise — a run only breaks where the
   * step changes, so 3 steps costs roughly a third of the merge length rather
   * than all of it. Default 1 for the first bake so the baseline part count is
   * the honest one; stage 3 prints the cost of raising it. */
  shades: 1,
  shadeSpread: 0.10,       // +/- fraction of brightness across the steps

  /* ---------------- collision ---------------- */

  /* Most buildings decompose into one or two boxes. A footprint that needs more
     than this gets its greedy rectangles kept anyway — the cap is a REPORTING
     threshold, printed at the end of stage 4 so a pathological footprint is
     visible rather than silently expensive. */
  collisionBoxWarn: 6,

  /* ---------------- the road mask ---------------- */

  /* Cell size in metres for the baked drivable mask. Eight matches W.cell in
     the source game exactly, so the off-road penalty behaves the same way and
     the constants in drive() (STRAY_TOL = 10, a bit over one cell) still mean
     what they meant. */
  maskCell: 8,

  /* ---------------- ground colours ----------------

   * NOT taken from the browser game's palette, and this is the one place the
   * bake deliberately parts company with it.
   *
   * PAL.ground there is #333f4c and PAL.road is #a6a29b — a dark navy backdrop
   * with pale roads drawn on top. That is correct for a MAP, which is what the
   * 2D renderer is: the backdrop is meant to recede and the road network is
   * meant to be the thing you read.
   *
   * Stood on at eye level it is exactly backwards. Reported from the first
   * build in Studio as "shadows always change": every patch of ordinary ground
   * was a dark navy that reads as permanent shade, with stepped lattice edges
   * that look like a shadow map tearing, and the tarmac was lighter than the
   * pavement beside it. Real asphalt is darker than a paving slab.
   *
   * So the ground gets its own four colours, and they are the way round they
   * are outdoors. */
  groundCol: {
    /* THE MINIMAP'S OWN SCHEME, and now the only one. These were two palettes,
       and they were exact opposites: in the world the road was dark asphalt on
       pale ground, on the minimap it was pale tarmac on dark ground. Both are
       defensible on their own -- dark asphalt is what a street looks like, and
       light-roads-on-dark is what a map looks like -- and having both at once
       means reading the map one way and the street the other, which was
       reported. The minimap's is the one that was pointed at, so it wins, and
       the minimap now reads these rather than carrying its own copy. */
    plain: '#34383e',      // ground with nothing on it
    park:  '#3c5c3a',      // grass
    kerb:  '#5c6068',      // pavement
    road:  '#969ca8'       // tarmac
  },


  /* ---------------- paths ---------------- */
  src: 'data/belgrade.js',
  out: 'tools/roblox/build'
};

/* WHERE THE WORLD AXES GO.
 *
 * The game projects to metres with +x east and +y SOUTH (geo.js:12 negates the
 * latitude delta). Roblox is Y-up with X and Z on the ground, so:
 *
 *     world x  ->  Roblox X       (east)
 *     world y  ->  Roblox Z       (south, so north is -Z)
 *     height   ->  Roblox Y       (up)
 *
 * Kept as one exported function rather than three multiplications scattered
 * through 5-emit.mjs, because getting one of them wrong mirrors the city and
 * the mistake is invisible until somebody who knows Belgrade looks at it. */
export const toStuds = (m) => m * CONFIG.studsPerM;

/* The chunk edge in lattice cells, which is what the mesher indexes by. */
export const CHUNK_VOX = Math.max(1, Math.round(CONFIG.chunkM / CONFIG.voxel));
