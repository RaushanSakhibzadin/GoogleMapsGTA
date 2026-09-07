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

  /* ---------------- the lattice ---------------- */

  /* Voxel edge in METRES. Four is the cheap, chunky bake; two keeps building
     outlines legible at four times the voxel count. The whole pipeline reads
     this one number — bake both and choose with your eyes, which is what M0 in
     the plan is for. */
  voxel: 4,

  /* Chunk edge in VOXELS. 32 voxels at 4 m is a 128 m chunk, which at 3 studs/m
     is 384 studs — comfortably inside a StreamingEnabled radius, and about a
     hundred chunks across the district. The client builds and unloads by chunk,
     so this is the granularity of every hitch and every unload. */
  chunkVox: 32,

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
