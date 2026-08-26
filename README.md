# VICE MAPS

## ▶ [**PLAY IT HERE**](https://raushansakhibzadin.github.io/GoogleMapsGTA/)

<https://raushansakhibzadin.github.io/GoogleMapsGTA/>

## ❤ [Back it on Patreon](https://www.patreon.com/raushanraushan)

The game is free and always will be. The **$10 tier** gets you **GHOST MODE** — normally the car
is a road car and drops to walking pace off the tarmac; ghost mode gives you full speed across
open ground and lets you drive straight through buildings.

It's a switch in the menu, and it runs on trust. There's no server here — the whole thing is
static files and the source is right there in this repo — so any check would be a line of
JavaScript anyone could flip. Backing it is how you say the game should keep going.

---

A GTA: Vice City–flavoured driving sandbox that runs on **real streets, anywhere on Earth**.
Type a place — your street, Miami Beach, Shibuya — and it pulls the actual road network and
building footprints for that spot and turns them into a drivable neon city.

No build step, no dependencies, no API key. Open `index.html` and drive.

```
index.html      markup only
style.css       all of the styling
og.jpg          the social card, rendered from the game by tools/ogimage.mjs
favicon.svg     the icon; icon-180/192/512.png are rasterised from it
manifest.json   name and icons for "add to home screen"
sitemap.xml     one URL, for Search Console
data/belgrade.js  the bundled offline city — real Belgrade, around Autokomanda
tools/buildcity.py  rebuilds that city from the captured map data
tools/glb2car.py    bakes a glTF/GLB vehicle into js/carmodel.js
tests/          the whole test suite, and the two captured sessions it replays
js/util.js      utilities, palette, theme
js/log.js       the session log: what the map servers said, and what went wrong
js/geo.js       projection, Overpass, Nominatim — everything that talks to the network
js/world.js     parsing OSM, spatial indexes, tile streaming, landmarks
js/terrain.js   the heightfield the 3D view drives on
js/body3d.js    the car as a cuboid: height, attitude, jumps, rollovers
js/entities.js  cars, traffic, police, pedestrians, and the driving physics
js/io.js        input, audio, canvas
js/game.js      game state, missions, wanted level, the per-frame update
js/gl.js        WebGL2 plumbing, matrices, ear clipping
js/carmesh.js   the car, as a mesh: stations, wheels, glass, lamps
js/proctex.js   every texture in the game, grown from fractals at load
js/render.js    the top-down view
js/soft3d.js    the chase view again, on a canvas, for a browser with no WebGL
js/render3d.js  the chase view, and the switch between the two
js/main.js      the loop, the menus, the debug hooks
```

They are plain `<script>` files sharing one global scope, deliberately **not** ES
modules: modules are blocked over `file://`, and opening the game straight off disk
with nothing installed is the point. Load order is fixed in `index.html` and matters.

```
git clone https://github.com/RaushanSakhibzadin/GoogleMapsGTA.git
cd GoogleMapsGTA && open index.html          # or: python3 -m http.server
```

It also runs straight from GitHub Pages — enable Pages on the repo and the root `index.html`
pulls in the rest.

## Controls

| | |
|---|---|
| **W A S D** / arrow keys | drive, reverse, steer — up to 360 km/h |
| **Space** | handbrake — hold it into a corner and the back end steps out |
| **H** | horn |
| **N** | switch between dusk and daylight (or the ☀ button on touch devices) |
| **V** / the **3D** button | switch between the top-down view and the chase view behind the car |
| **Esc** | pause / change city |
| touch | on-screen pads appear automatically on phones and tablets |
| GHOST MODE | the switch on the title screen and the pause card — supporter perk, see the top |
| **⤓ LOG** | top right, on every screen — saves what the map servers sent and everything that went wrong |
| **tap the radar** / **M** | pauses and opens the full city map — drag to pan, pinch to zoom |

## What's in it

- **Real map geometry.** Road centrelines with their OSM classification (a motorway is wider
  and faster than a service road), building footprints with real heights from `height` /
  `building:levels` tags, plus parks.
- **A 120 km city, and you are driving in about eight seconds.** The wide road network arrives while
  the loading screen is up and is never fetched again. It comes at two levels of detail: every lane and service
  road across the 5.4 km you start in, and the **arterial skeleton** across **60 km in every
  direction**. How far out that reaches is a loading-screen decision, not an ambition — the box
  grows with the square of the radius, and a 200 km version was tried and measured on a real phone
  at **36.7 MB and twenty-three seconds**, which is most of a minute's wait for roads you reach
  after an hour of driving. 60 km is the same city for about five seconds. The ask also narrows as
  it widens, in one request: motorways and trunk roads over the whole radius, the full arterial set
  only over the 36 km the drivable mask covers — measured on real Belgrade data, `secondary` alone
  is **55.7%** of the arterial bytes, so where that clause stops is what the load costs. If the
  request is refused it retries at 36 km, then 18, then 9, so you get the biggest world that server
  would give you. Nothing else holds the loading screen: the eight neighbouring districts and the
  landmark sweep used to be waited for and were most of the wait, and they are ground and garages you
  reach seconds later, so they arrive behind the wheel instead. **Streets keep streaming as you
  drive**, a 1.8 km tile at a time: the skeleton is arterials, and the street you live on is not an
  arterial. Packets, traffic and pedestrians spawn wherever you are, and
  delivery contracts reach right across it.
- **Real building colours.** Every building takes the colour a mapper actually recorded in
  `building:colour` / `roof:colour` where one exists, then falls back through
  `building:material` (brick, concrete, glass, stone, metal, wood), then what the building is
  for — houses get render and brick, offices get concrete and glass, warehouses get metal —
  and only then to size and height. Roofs use real roof materials (asphalt, gravel, terracotta
  tile, membrane) rather than the facade colour, since a roof is what you actually see from above.
- **The name over the door, in the right colour.** Real OSM names painted across the widest wall
  of the building that carries them, blue by day and warm at dusk — and **yellow if it is
  somewhere you eat**, asked of `amenity` and `shop` rather than of the name, so a Belgrade
  kafana and a Tokyo kissaten are both found without the game knowing either word.
- **Street and district names, GTA style.** Turn onto a new road and its name appears by the
  radar, then fades. Cross into a new neighbourhood and the district name flashes up bottom-right
  and stays, the way Vice City announces its zones. Deliveries name their destination street too.
- **Dusk or daylight.** `N` switches the whole scene between the neon sunset and a bright
  daytime palette — asphalt roads, green parks, sunlit facades. Buildings store their
  material colour rather than a finished one, so the swap is instant.
- **A 3D chase view, behind a button.** `V`, or the **3D** button next to ⤓ LOG, drops the camera
  in behind the car and renders the same city in hand-written **WebGL2** — no library, no build
  step, still opens off disk. Real footprints extruded to their real heights, with ear-clipped
  roofs because OSM is full of L-shaped and courtyard blocks and a triangle fan fills in the
  missing corner. Geometry is batched per 512 m cell, built one cell a frame and culled as a
  unit, which matches how tiles already stream in and out.

  **Both views ship, and that is the point.** The top-down game is untouched and still runs on
  machines with no WebGL2; every 2D test in the suite stays meaningful; and a rendering bug can be
  bisected by pressing a button. `render()` and `toScreen()` are a two-line dispatcher over the
  pair. The radar, the city map and the whole HUD are shared — they were already separate canvases
  and DOM.

  **And a third renderer for the phones that have no GPU to lend.** Reported three times from the
  same iPhone, and the log said it without ambiguity in the end: no `webgl2`, no `webgl`, no
  constructor, no error message — Chrome on iOS with WebGL switched off, which Lockdown Mode does.
  Nothing is broken and there is no driver to fix. The button used to answer that with a toast and
  put you back in the map, which on such a browser means never seeing the chase view at all. It
  now draws the same street on the 2D canvas: the same camera, the same matrices, the same
  footprints and heights, sorted far to near and filled as flat polygons — a painter's algorithm,
  which is what a depth buffer is for and what you use instead when you have not got one.
  Buildings, trees and cars go through **one** sorted list rather than a pass each, because
  separate passes put every tree in front of every wall. Thirty frames a second at 900×600 with
  220 buildings and 90 trees in view, against sixty for the map — enough to drive.
- **Facades, not slabs.** A street reads as a street because of rows of glass, so walls carry a
  window grid worked out in the fragment shader — no texture, no atlas, nothing to download. The
  horizontal coordinate is the wall's own normal turned a quarter turn, which is free and runs
  continuously round a corner; two floats per vertex carry how far up the wall it is and how tall
  the wall is, so floors start at the pavement and the roofline does not slice the top one in
  half. Ground floors stay plain, there is a cornice at the top, and the bottom two metres are
  darkened for the soot every real wall has. The pattern is antialiased against the pixel
  footprint rather than stepped — a 2.85 m bay is sub-pixel at a hundred metres, and a hard edge
  there is a wall of crawling static — and dissolves back to plain wall at the distance where a
  facade genuinely is one. After dark a third of the windows are lit, seeded from world position
  so a window never flickers as you pass it.
- **A sky.** A gradient rather than a clear colour, deep overhead and pale at the skyline with the
  sun's glow spread into the air around it, drawn as a single oversized triangle with no vertex
  buffer at all.
- **The cars are a model.** Not boxes: a four-hundred-triangle hatchback lofted through nine
  cross-sections, with ten-sided wheels, a raked windscreen and tailgate, bumper bars and four
  lamps. It is the one thing in this world that is a mesh rather than geometry generated from the
  map, so it is drawn the way a mesh should be — uploaded once in the car's own coordinates and
  given a model matrix per car — which costs a handful of uniforms instead of re-transforming
  every vertex on the CPU forty times a frame.

  That matrix is read straight out of the collision cuboid's eight corners, so the heading, the
  pitch and the roll the physics computed are the ones the wheels and the windows get, and nothing
  can drift out of alignment mid-barrel-roll. **The paint is a palette lookup**, the same trick the
  ground uses: slot zero changes per car and glass, tyre, alloy, lamp and trim are the same
  city-wide — which is exactly what a ready-made low-poly car kit *cannot* do, since those are
  built around one shared texture atlas and would make the whole fleet one colour. Past 90 m it
  collapses to two boxes, where the difference is under a pixel.

  **You can swap in your own.** `python3 tools/glb2car.py sedan.glb > js/carmodel.js`, add one
  `<script>` line before `js/carmesh.js`, and the renderer never knows the difference. It is a
  tool rather than a loader because a page opened on `file://` cannot fetch a sibling file —
  `.obj`, `.gltf` and `.json` alike are cross-origin against a null origin and refused — which is
  the same reason the offline city is a `.js` and not a JSON document. The tool maps material
  names onto the seven slots and tells you, loudly, when a model has only one material, because
  that is the case that cannot work.
- **Trees, and one of them is a photograph.** Belgrade's boulevards are lined with plane trees and
  the city was drawn without a single one; OSM maps individual trees far too sparsely to build a
  street from, so the planting is generated — spaced along both verges of every drivable way, off
  the tarmac, out of the footprints, and derived from the coordinates so a cell dropped and rebuilt
  comes back with the same trees rather than a street that rearranges itself behind you. Each is
  **two crossed quads carrying one alpha-tested cutout**, which is how San Andreas drew a tree and
  is still the right answer: four triangles, a shape the eye reads from any direction, and
  `discard` rather than blending, so it writes depth and needs no sorting.

  The cutouts are the only assets in this repository not drawn in code. Two dozen shaded circles
  read as a green lollipop at any distance, because what makes a canopy look like a canopy is the
  clumping — leaves at every scale, a few of them catching the light and the rest not. So the trees
  are **photographs of real ones on real Belgrade streets**, taken by the person this was built
  for: two atlases of two trees each, one for after dark and one for daylight.

  **They are cut two different ways, because they are two different kinds of photograph.** The
  night ones were taken from underneath, looking up into a ceiling of leaves — there is no outline
  anywhere in the frame, and keying the night sky out leaves a rectangle full of holes rather than
  a tree. So those silhouettes are *painted* — a crown of overlapping blobs, bitten back at the rim
  — and the photograph only fills them, lifted onto a dark blue-green floor rather than from black,
  because keying the shadow out of the dense one dissolved it into lace. The daylight pair were
  taken from across the road against the sky, so nothing is painted at all: **the sky is keyed out
  and what is left is the tree**, with its own ragged leaf edge and its own gaps. Two skies have to
  go — the blue one and the white haze near the sun, which is not blue at all and hangs a sheet
  behind half the canopy if you miss it — and the tool finds the crown's own bounding box from the
  key rather than trusting a hand-tuned crop, because four crop numbers per tree were four chances
  to clip a crown or leave it floating and every attempt did one or the other.

  **Two trees per atlas.** One tree stamped down both verges of every boulevard reads as wallpaper
  however good the tree is, and the giveaway is a row of identical crowns. Each tree picks a column
  from its own hash and half of them are mirrored on top of that, which is free — a swap of two
  floats already going into the buffer. One texture, one draw call, four apparent trees. The two
  atlases and the painted fallback all have the same column count, because the column is baked into
  the cell's UVs and the theme can change under a cell built an hour ago; the UVs are also held half
  a texel off the boundary, or linear sampling draws a faint line down the middle of every crown.
  Every trunk is **bark**, filled the same way the night crowns are: a painted taper, clipped,
  filled with a photograph of the real thing. 51 KB and 84 KB of data: URI, so there is still
  nothing to fetch, it still opens off a disk, and the existing `?v=` stamping covers both. **And
  neither is lit twice**: the light that lit them — a sodium lamp, or a September afternoon — is
  already in the pixels, and running the theme over one again leaves a black smudge at night and a
  tree in permanent shade by day.
- **Render, not flat colour.** Between the windows a facade was one colour, which is what made a
  street of real footprints at real heights still read as a heap of boxes: real render is patched
  where it has been repaired, stained under every sill, cracked along the line of every floor slab.
  So the walls carry a seamless grey tile cut from a photograph of a Belgrade block, tiled every
  four metres off **the same world-anchored facade coordinate the window grid uses** — so it runs
  continuously round a corner, does not stretch on a long block, and does not swim as you drive.
  Three things happened to that photograph beyond the crop. It is **flattened**, divided by a heavy
  wrapped blur of itself, so the street lamp's falloff and the balcony's shadow come out and only
  what belongs to the wall stays — a tile with a bright corner in it tiles as a bright corner every
  four metres, which is wallpaper. It is **wrapped** by offsetting half a tile and cross-fading the
  join, rather than mirrored into a 2×2, which also tiles and puts an axis of symmetry down every
  wall in the city. And it is **grey**: a multiplier around 1.0 rather than a picture of a wall, so
  it gives a Tokyo block Belgrade's render without giving it Belgrade's ochre. Mipmapped and
  repeating, which is the opposite of what the tree cutout wants and for the opposite reason — this
  one repeats, so a distant wall wants the average rather than a hard edge, and without mipmaps it
  is crawling static. 18 KB. It shows in daylight and it is nearly invisible at dusk, because the
  dusk ambient is 0.085 and nothing multiplied into a wall that close to black moves a pixel.
- **The objective is a beacon you can see.** The top-down game paints a marker on the ground; from
  a camera six metres up behind a car that is a thin ellipse hidden behind the next vehicle, so in
  the chase view the pickup was on the radar, on the city map and on the screen-edge arrow and
  nowhere out of the windscreen. It is a column of light now, fifty-five metres of it — depth
  tested like everything else, because a light you can see through a wall reads as a bug, which is
  exactly why it has to be taller than the street it is standing in. Landmarks get a short one at a
  quarter of the size, within 150 m, since a garage is a convenience rather than a destination.
- **One light, and it casts.** A sun in daylight, a moon at dusk, drawn in the sky where its own
  vector says it is, with a real shadow map under it: the world is rendered once more from the
  sun's point of view and every surface asks that depth before deciding it is lit. The light sits
  low, around 20°, which is a deliberate break from the 2D theme — the theme's numbers imply a
  source almost overhead, and an overhead source casts a shadow the size of its own footprint.
  Buildings cast with front faces culled so a sunlit wall cannot shade itself; cars cast the other
  way round, because a car is a box a metre and a half tall whose far side from the sun *is* the
  road.
- **The ground has a shape.** Seeded value noise, so a place always has the same hills and two
  people driving Belgrade meet the same crest on the same street. Gravity along the road takes
  speed away climbing and gives it back descending, and the ceiling lifts downhill rather than
  pinning a visible descent to the same number on the clock. Crests launch the car — the condition
  is the honest one, v²·curvature against gravity, so the same crest is a bump at fifty and a ramp
  at three hundred. In the air the controls roll and pitch the body instead of steering it, and
  landing crooked puts you on your roof for a couple of seconds.

  All of that is gated on the 3D view. In the top-down game the terrain height is a constant zero
  and every vertical term is multiplied by nothing, so the physics — and the tests tuned against
  it — are exactly what they were.
- **Arcade physics, with inertia.** Velocity is split into forward and lateral components against
  the car's heading. Nothing happens the instant you ask for it: the engine takes a moment to come
  on song and a moment to fall off it, the brakes bite rather than grab, and the wheels take a
  moment to come round — and a shorter one to straighten, the way a real rack self-centres. Torque
  and steering used to appear and vanish on the same frame as the key, which is what made the car
  feel dragged around rather than driven; these are first-order lags, so they cost one number each
  and the top speed is unchanged. Steering authority still falls off with speed and inverts in
  reverse. Constant engine force against linear drag with a hard ceiling, so the 360 km/h on the
  clock is a speed you actually reach rather than an asymptote — the engine deliberately out-pulls
  the drag, since constant force against linear drag settles at `accel/0.32` and anything less makes
  the top number a lie. The camera pulls back as you wind it out.
- **The road is the game.** Off the tarmac the car drops to about 15 km/h and leans back across
  towards the kerb, so a shortcut through a car park costs you rather than saving you. The lean is
  aimed at the nearest road cell in the drivable mask, not at the last bit of road you were on —
  that sounds equivalent and isn't, because the point you left is usually far behind you *along*
  the road, so the pull comes out parallel to the kerb and the car never comes back. Guards on the
  penalty, each one earned: the player only, since a police car that crawls off the tarmac can't
  chase you across a car park; never in GHOST; **only where the road data is actually complete**,
  because `onRoad()` also answers false for ground that simply hasn't streamed in yet; **anything
  drawn as tarmac counts**, road network or not, because OSM maps a city square as
  `highway=pedestrian` and this paints it with the same kerb and casing as a street — a car
  standing in the middle of one and crawling reads as a broken game, and did; and **10 m of
  slack**, because the mask is 8 m cells stamped along centrelines and it does not agree with the
  drawn width to the metre. A false negative here costs nothing. A false positive is a car that
  won't move.
- **The drift turns you half as far as you're going fast.** The turn in degrees is half the number
  on the clock: press DRIFT at 90 km/h and the car comes round 45°, at 180 it's 90°, and at 360 —
  the top of the speedo, which is why top speed is exactly 100 m/s — it's a half turn. Crawl
  and you barely twitch, so you have to carry speed to get the car round. The heading is driven
  along a smoothstep arc rather than nudged by a torque, which is why it lands on the number every
  single time instead of depending on how long you held the button; longer turns take longer, at a
  roughly constant rate. No steering needed — that only picks the direction. Keep DRIFT held
  afterwards and the car carries on sliding with the rear loose, so you can run it through a bend.
  It lays rubber for the whole arc and throws tyre smoke off the back.
- **Collision that means something.** Buildings push you out along the nearest wall normal and
  damage you in proportion to closing speed. Cars exchange impulses and dent each other.
- **Every car is destructible.** Traffic and police take damage from any impact — including
  crashes with each other, which you don't have to be part of. A damaged car starts smoking and
  visibly loses top speed, down to about a third of it when it's nearly finished. At zero it goes
  up in an orange fireball, throws burning debris, and is gone. The blast hurts everything inside
  it — other traffic, police, and **you** — so a car exploding beside a queue sets off a chain,
  and standing next to a wreck is a bad idea.
- **Tunnels and archways work.** Where a drivable centreline runs straight through a building
  footprint — a tunnel, a gateway, or a block built over the street, which dense old towns are
  full of — that building stops colliding and is drawn back so you can see the road under it.
  Buildings that merely sit beside the road stay as solid as ever.
- **Off-road handling.** An 8 m drivable grid rasterized from the road network — leave the
  tarmac and you lose top speed, gain drag, and the camera starts shaking.
- **Traffic and pedestrians.** Cars drive the real ways node by node, and so do the people —
  each one is bound to a street at an offset of its half width plus a metre and a half, so a
  boulevard puts them further out than a back street and nobody ends up standing in a car park.
  They cross at junctions, turn round at the end of a way and come back along the other pavement.
  Six boxes and a swinging stride rather than a coloured post, with the phase driven by distance
  walked, so somebody moving slowly takes slower steps instead of jogging on the spot.
- **Five-star wanted level.** Ramming cars, hitting cops, and running people down raises it.
  Police pursue directly and get faster with each star. Lose them for 8 seconds and it decays.
- **Busted and wasted have somewhere to take you.** Give up — stop the car — and the units closing
  on you ease off, pull alongside and stop too. Hold still for a beat and you're **BUSTED**: half
  your cash gone, and you come round at the nearest real police station on the map. A cop still
  rolling past is a near miss, not an arrest. Run out of armor and **the car goes up with you** —
  a fireball, a shockwave that takes out whatever is parked beside it, and **WASTED**: cleaned out
  completely, and you wake up at the nearest hospital. Where the map has neither, you go back to
  where the game started.
- **Repair shops, $1000.** Drive into a real `shop=car_repair` and you leave with full armor and a
  different paint job, for a thousand dollars. Turn up short and they'll tell you the price and
  nothing else happens.
- **Landmarks are drive-through.** Repair shops, police stations and hospitals go transparent and
  stop colliding, exactly like a building with a road under it — drive straight in, no damage, no
  wall. They're marked in green on the radar, police stations in blue and hospitals in red.
- **A widening sweep for landmarks, while it loads.** The opening download is 1.8 km across, and
  plenty of real neighbourhoods that size hold no station, no hospital and no garage. If any of the
  three is missing, the loading screen sweeps **18 km in every direction** for landmarks alone — no
  streets, no buildings, so it stays one cheap request — and goes wider still, out to 45 km, if
  there's no station and no hospital in range. It all happens before you start driving — the only
  thing that streams in behind you is the district you're driving into: its streets, then its
  scenery.
- **Delivery missions.** Pink marker to yellow marker against a timer, paying out by distance.
  Cash persists in `localStorage`.
- **Vice City dusk.** Neon rooftop trim, street lights, headlight cones, skid marks, scanlines,
  a rotating minimap, and a synthesised engine that tracks your RPM — no audio files.

## How it works

| Concern | Approach |
|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) — turns "Ocean Drive, Miami Beach" into a lat/lon |
| Geometry | [Overpass API](https://overpass-api.de) `out geom qt;`, so coordinates come inline. Split by what the game cannot start without: the **streets** request carries roads and place names over a 1.8 km box and nothing else, because if it fails you get a generated grid instead of the place you asked for and every extra clause is more time between pressing DRIVE and driving. The wide **arterials** request, buildings and parks, and landmarks each ride their own request and land when they land |
| Resilience | Six Overpass mirrors, shuffled per session so everyone doesn't queue behind the same host and a reload genuinely re-rolls. **The list is a queue, not a timetable.** Mirror `i` used to start at `i` × 2.2 s and never deviate, so a host that said no in 400 ms left its slot idle for another 1.8 and the sixth was not contacted until eleven seconds in whatever happened before it. A reported iPhone session shows the cost: at twelve seconds one mirror had served an empty database, one was unreachable and had been retried twice more, one had returned 504 twice, two were sitting silent — and the sixth had never been asked at all. The player was still on the loading screen, and gave up. A failure now hands its slot straight to the next host. **The same six requests go to the same six hosts in the same order** — nothing asks more of Overpass than before, which matters, because the way to actually get blocked is to answer flakiness by hammering — and on that session it is all six tried inside five seconds instead of three tried in twelve. Time to play: **11.4 s to 4.2 s**. A host that cannot be *reached* is no longer retried either: `fetch` rejecting with a TypeError means the request never left the browser — DNS, TLS, a refused connection, a CORS preflight that goes unanswered — which is this network being unable to talk to that host, not a busy moment. **Mirror health now survives a reload**, halved on the way in and forgotten after three days, so a demoted host climbs back the first time it answers rather than being blacklisted; a fresh page had no opinion about any of the six, which is why the reported session opened by asking the one serving an empty database. The next one starts 2.2 s into the last one's silence: a mirror unreachable from your network fails in about a second, and at the old 7 s hedge it burned its retries while the healthy mirrors sat un-started — "asking 5 map servers" sixteen seconds in, all of it spent on one dead host. **Mirror health is remembered**, because every request used to rediscover that dead host for itself: the streets query, the buildings, the skeleton and eight ring tiles between them soaked up thirty connection attempts in one load. Learned once, it drops to two. Client timeouts outlast the server's own `[timeout:N]`, transient 429/5xx are retried with backoff honouring `Retry-After`, the loading screen names the host that turned us away and why, and preset cities carry their own coordinates so the common path never touches the geocoder. How long the opening request took is also a read on how heavy the area is: somewhere slow enough to make you wait is where eight more street requests hurt most, so the opening ring shrinks to the four sides, or is skipped entirely A **429 is a deadline, not a score**: it is the one refusal that comes with instructions, so the host is parked and left out of the queue entirely until it expires, rather than merely sorted to the back — the back of a queue that gets fully drained is the same as the front, just later, measured at eleven asks either way against one when it is left out. `Retry-After` is parsed for both legal forms, but it is usually invisible: it is not CORS-safelisted, so a cross-origin fetch cannot read it unless the server sends `Access-Control-Expose-Headers` — measured, a 429 carrying `Retry-After: 120` reads back `null`. The status code carries the fix and a sixty-second default does the work. Parks survive a reload, because reloading is the most likely thing a player does when a load goes badly and it must not be a way to resume hammering the one host that asked for a minute |
| Shipping | Every script and stylesheet is fetched with `?v=<hash>`, the hash taken over the contents of all of them together, so the URLs change if and only if the code does. Without it a deploy is invisible — a phone holds `index.html` and fourteen `.js` files addressed by names that never change, and goes on running the old game for hours. The half-stale pairing is the dangerous one: HTML and its subresources expire independently, so a cache is free to serve a new `render3d.js` beside an `index.html` that has never heard of `carmesh.js`, which is a `ReferenceError` on the first frame rather than a disappointment. `data/belgrade.js` is loaded at runtime rather than named in the HTML, so it takes the same version through `window.BUILD`. Still no build step: `node tools/stamp.mjs` rewrites the stamps in place and `tests/stamp.mjs` fails the suite if it was forgotten |
| Projection | Local equirectangular — `x = (lon−lon₀)·111320·cos(lat₀)`, metres are the world unit |
| Rendering | Canvas 2D. Camera rotates so the car points up; buildings fake 3D by pushing the roof polygon away from screen centre and filling the wall quads |
| Culling | Spatial hashes over absolute metres, keyed so they never need rebuilding: 90 m cells for building collision, 256 m for the per-frame road cull, 300 m for picking somewhere to spawn traffic. All three replaced linear scans that were fine over 1.8 km and are not fine over 36 — filtering every road in the world four times a frame, or picking a random road and hoping it lands within 200 m of you, which at skeleton scale simply never happens and traffic stops appearing |
| Minimap | A 4 km window around the car, pre-rendered to an offscreen canvas at 0.6 px/m, so the minimap costs a single rotated `drawImage` per frame and is redrawn only when you leave the middle of it. It used to be the whole city, which stopped working the moment the city was 72 km wide: fitted to one canvas that's 0.067 px/m and unreadable, and drawing it sharp would need a 116-megapixel canvas |
| Street lookup | A road spatial hash over 90 m cells — naming the street you're on is a handful of segment tests, debounced so junctions don't strobe |
| Landmarks | `amenity=police`, `amenity=hospital` and `shop=car_repair`, pulled with the streets query as `nwr` so a station tagged as a bare node and one tagged as a building both land. Overpass returns the same landmark more than once — a hospital matches the amenity query and again as a building, and anything on a tile seam arrives with both tiles — so they're deduped by kind within 30 m |
| Wide sweep | When a kind is missing, a landmark-only query over a 36 km box — run **while the loading screen is still up**, so a landmark hunt never competes with the district streaming in ahead of the car. Sparse tag-indexed features make the area cheap, and `out center` returns a point per hit instead of a whole building outline. Still no station and no hospital and it climbs to a 90 km box there and then. Waited on with a few seconds' cap rather than blocked on, and no new rung may start once loading is done — a landmark query is allowed 40 s, and a loading screen that hangs on a nicety is its own bug. Failing costs nothing — the start point is still there |
| The big map | The radar is the button: tap it and the game stops and the city opens full screen. Drawn from the road list rather than from the radar's pre-rendered image — that image is a 4 km window at 0.6 px/m, which is the wrong scale *and* the wrong extent for a map you open to find something. Redrawn only when it moves, never per frame, so it can afford to walk every road in the world. Landmarks, markers and the car are drawn **unscaled**, because a dot that shrinks with the map is a dot you cannot find, and road widths have a pixel floor for the same reason: at 4 km across, a true-to-scale 8 m street is a quarter of a pixel and the map becomes a grey haze. It gets its own state rather than reusing `pause`, so <kbd>Esc</kbd> closes the map instead of stacking a pause card behind it, and closing resets the frame clock so the physics is never handed the paused seconds as one enormous step |
| The screen the phone actually has | `position:fixed` pins to the **layout** viewport, and Chrome for Android reports that as the tall one — the height the page would have if the URL bar were hidden, whether it is hidden or not. So every full-screen layer at `inset:0; height:100%` was about a hundred pixels taller than the screen and everything anchored to its bottom edge sat underneath the fold: on a Pixel the thumb pads measure a bottom of **825 in an 851 layout** that the phone can only show 751 of, which is a game you cannot steer. The layers and the pad offsets come off `--vh` now, set from `visualViewport.height` — which also made a latent bug reachable and worth recording: `io.js` loads before `game.js` and its `resize()` reads `state`, a `let` declared in the later file, so until that script has run the binding does not exist. A window resize cannot fire before the page has parsed, so it never happened; the visual viewport settles *during* load, and on a machine slow enough to stretch the gap between two script tags it fires in it. It showed as `state is not defined` from a suite run under load and never once on an idle machine, and it is a `typeof` guard now. The property is set from `visualViewport.height`, with `100dvh` behind it for the frames before the first script runs and `100%` behind that. It is deliberately not applied while an input is focused, because the on-screen keyboard shrinks the visual viewport too and a menu that folds in half while you type a city name into it is a different bug. The canvas measures its own box rather than reading `innerHeight`, so the stylesheet stays the single place the visible size is decided — and for the same reason it no longer writes an inline width and height back onto itself, which would override that stylesheet and latch the canvas to whatever the viewport was the first time it ran |
| Being findable | The head was four lines — charset, viewport, title, stylesheet — so there was no description for Google to quote, no card for Discord or Slack to draw, no canonical to collapse `/` and `/index.html`, and no favicon. It has all of that now, plus `VideoGame` JSON-LD **without an `aggregateRating`**: inventing review stars for a rich result is a guidelines violation with a manual action attached, and there are no real ratings here to report, so `seo.mjs` asserts the field stays absent. The eight preset city names were built by a loop in `game.js`, which meant the only place-names on the site were invisible to anything that did not run scripts — they are written into the markup now and bound by id, and they are real `<button>`s while they are at it. **No `robots.txt`**, deliberately: crawlers read it only from the domain root, and for a project Pages site that root belongs to a different repo, so a file here would be served at `/GoogleMapsGTA/robots.txt` and fetched by nobody. The social card is not a mock-up either — `tools/ogimage.mjs` drives the real game over the checked-in Belgrade capture and photographs it, in daylight because the neon dusk palette reads as a black rectangle at thumbnail size |
| A map full of map | Zooming out used to stop at `min(VW/wide, VH/tall) * .9` — the whole world, and then a tenth further out again. On a square 72 km world in a landscape window that put the map across **90% of the height and 53% of the width**, and dragging to a corner left only a third of the screen with anything painted on it. Bare ground over half a tablet reads as a map that failed to load, not as one you are meant to pan, and the natural conclusion — that not enough was being fetched — was wrong: the data reaches ±36 km in every direction and always did. The limit is `max` now, not `min`: the world covers the viewport on **both** axes, the short one still shows all 72 km of it, the long one shows the middle and you drag for the rest. No map letterboxes itself. The edge of the world can no longer be dragged inside the viewport either, and where the world is genuinely narrower than the screen — a generated grid, or a skeleton that only came back at 9 km — it centres instead. `tests/mapfill.mjs` measures all of it separately at four screen shapes: what fraction of the viewport the world rectangle covers, what fraction of the canvas has anything but ground colour in it, and whether any patch of it has gone solid |
| The white rectangle | Zoomed out, the detailed centre came out as a solid white block sitting in the middle of the map — 5.4 km of Belgrade is eleven thousand ways, most of them service roads round the back of buildings. The floor that keeps a thin road visible was written `1.4 * DPR / s`, which is 1.4 **CSS** pixels: four and a half device pixels on a phone. Two streets sixty metres apart are ten device pixels apart on a 7 km view, so strokes that wide close half the gap and round joins close the rest. The floor is in device pixels now — a hairline — and the same streets come out as a grid you can read. Roads also draw in three tiers instead of two, and the alleys and then the residential grid fade out once they are finer than the map can resolve, which is what a road atlas does and the reason it doesn't draw every driveway in the county. Worst patch of the canvas, at 7 km across: **34% solid before, 5% after** |
| One yellow, not three | The wanted stars are meant to match the objective arrow, and had been "fixed" twice: white at 16% alpha for the unlit ones, which read as grey ticks, then a hand-typed `#ffd21a` that came out orange beside the arrow in daylight. Both times the fault was the same — the colour written out again somewhere else. There is one constant now, `GOLD` in `js/util.js` and `--gold` in the stylesheet, and the arrow, the marker, the radar blip and both themes' stars all read it. `tests/daynight.mjs` holds the stylesheet, the canvas and the stars against each other rather than against a number typed into the test, which would only have been a fourth copy. Daylight takes its contrast from a dark outline instead of a darker star: on a pale ground the thing that needs to be dark is the edge |
| Traffic that drives | Reported as "all I hear is explosions of cars that are not on the screen", and three separate faults were behind that one sentence. **They never braked for each other**: `updateTraffic()` slowed for the player and for nothing else, so every car drove at full throttle into whatever was in front of it — fine at 26 cars, a permanent demolition derby once daylight put ten times as many on the same streets. **Every pair was hit twice**: the car-on-car sweep lived inside the per-car update, so it ran every car against every other one — sixty-five thousand tests a frame at 255 cars — and damaged both ends of each pair separately. **And you could hear all of it**, because crashes and explosions played at full volume wherever they happened. Now they keep a gap that closes proportionally rather than braking and flooring it, the sweep runs once per pair off a 26 m bucket grid, and the threshold between two AI cars is higher than the player's because nose-to-tail is their normal state. Measured over 26 s of daylight driving: **0 wrecks**, closest approach 2.9 m, average traffic speed 29 km/h, and the per-frame update down from 3.8 ms to 0.3 |
| Only what you can hear | Every sound played at full volume wherever it happened, so a pile-up six hundred metres away was as loud as one under the bonnet. `earshot()` scales by the VIEW rather than by a fixed distance: full volume out to half the visible radius, nothing a little past the edge of it. `tests/traffic.mjs` wraps the two sound functions and sets off real explosions at known distances, so what it checks is the gain the game actually asked for — asking `earshot()` what it returns would prove nothing about whether anything uses it |
| Traffic lives on the screen | Cars were simulated out to 780 m while the view is about 170 m across, so nine tenths of them drove, crashed and exploded somewhere you could never see. They are kept to the corner of the screen plus 150 m now, and new ones arrive in that band rather than in the mirror — which changed what the daylight multiplier can be, since the same count in a thirtieth of the area is a car park rather than a rush hour. Three times, not ten, and **more cars in front of you than ten ever managed**: 20 on screen against 18, with 70 simulated instead of 256. A standing start still fills the whole ring, or the street you are parked on is empty until something happens to drive down it |
| The cars you can't see | Everything in the draw loop culls to the view — parks, roads, buildings, tyre marks, street lights — and the cars did not. Every car in the world got a full `drawCar()`: a fresh linear gradient for its headlights, four rounded corners and a shadow. The view is about **170 m** across and traffic is simulated out to **780**, so in daylight that was two hundred and fifty cars drawn per frame with eighteen of them on screen. One bounds test per car fixed it: rendering daylight now costs **1.97 ms a frame against 3.98**, which is the same as dusk with a tenth of the traffic — the drawing bill no longer depends on how many cars exist. Nothing is removed and nothing pops, because a car skipped here is one whose paint lands off the canvas; it is still driving, still solid, still worth a wanted star. Police are only ever skipped for drawing, never culled from the world |
| Finding a garage | Landmarks were baked into the pre-rendered map at five pixels — and the radar scales that map down to fit 230 m across a 98 px phone display, so the dot arrived under two pixels. A player with **226 repair shops loaded and the nearest 543 m away** could not find one, which is exactly what a log said. They are drawn as per-frame blips now, the same size as everything else you are meant to see. And because the nearest garage is usually further out than the radar reaches, the one landmark you go looking for on purpose gets a **pointer on the rim** at its true bearing with the distance beside it — brighter once the armour is low enough to want it. It rotates with the radar, so turning the car through 180° swings it through 180° |
| Drive-through landmarks | The `passable` flag the tunnel handling already uses: skipped in collision, drawn at 45% alpha. Marked on any footprint a landmark falls inside, which covers both tagging styles — the way form where the hospital *is* the building, and the node form where a garage node sits in someone else's outline |
| Respawning | Snaps to the nearest point *on* a drivable segment, not its midpoint, which on a long straight way can be hundreds of metres out. It only snaps when tarmac is within 120 m, since the wide sweep finds landmarks well outside the loaded streets and the nearest loaded road to those is the edge of the map. Beyond 6 km you go to the start point instead: the collision grid and the pre-rendered map both span everything loaded, so a long jump bloats the mask and zooms the radar out until it's useless |
| Your own wreck | Every other car in the game explodes when its health runs out — traffic and police both go through `wreck()`. The player's just stopped, and a banner appeared over a car sitting there intact, which reads as the game giving up rather than as the car being destroyed. So `wasted()` detonates it too, and the blast is the real one: it damages whatever is standing in it, which is how a wreck in a queue starts a chain. That is also the trap — the player is standing in it, at zero health, so the blast walks straight back into `wasted()` and recurses until the tab locks. `P.dead` is set **before** the explosion, and the ordering is the whole fix |
| The mask stops before the world does | The drivable mask is 8 m cells at two bits, so it costs the SQUARE of how far it reaches: 19.4 MB across 72 km, 39 across 100, **156 across 200** — which is what made a 100 km skeleton impossible, not the download. Everything else in the world costs what the roads cost, and 200 km of arterials is 22 MB of mostly farmland. So the mask was given its own box: centred on where you started, 36 km each way, and it simply stops. Nothing is lost that was ever there, because the off-road penalty is already gated on `roadDataHere()` — on whether we actually KNOW there is no road under the car, rather than merely having nothing to say — and past the mask we have nothing to say. Out there the car drives, at speed, with no penalty, which is the same treatment ground gets while its tile is still in flight. Sixty kilometres from where you started, on a motorway through fields, it is also the right game. Measured on a synthetic 200 km Belgrade: mask 19.3 MB, heap 98 MB, 61 fps |
| Two bits a cell | The drivable mask is 8 m cells, and at the time the world was 72 km across: 9,010 squared is **81 million cells**. A byte each was fine at 36 km and is 81 MB at 72 — not something to ask a phone for on top of thirty megabytes of map JSON. Two bits hold everything it ever stored (nothing / road / tarmac-but-not-road) and bring the same world down to **19.4 MB at the same 8 m resolution**; measured heap for a full 72 km load is 31.6 MB. Coarsening the cells to 16 m instead would have been less code and worse: a residential street would then mark sixteen metres either side of its centreline, and knowing where the road stops is the entire point of the off-road penalty. Growing the mask no longer copies the old marks across either — every caller re-marks after a grow anyway, so the copy was doing nothing but preserving holes, and packed rows don't start on byte boundaries |
| Asking again later | Every failure in this game's loading is a network failure, and network failures are moments rather than verdicts — a mirror rate-limits for a minute, a host is unreachable from one carrier, a 200 comes back with nothing in it. The game coped by carrying on with less and then never asking again for the rest of the session: the offline city instead of the one you chose, no wide map, no garages, bare ground where the buildings should be, and the only cure was pressing DRIVE again and sitting through another load. So it asks again from behind the wheel, and drops the fallback the moment the real answer turns up — including the **city itself**, which is fetched and parsed in full before anything is torn down, so a failed retry leaves you exactly where you were, none the wiser. Cash survives; the projection is put back if the reply is bad. **The delays are the design**: Overpass gives about two slots per IP and answers a burst with 429s, so a retry that hammers would get the host to refuse the tile streaming too — trying to recover the map would break the part of it that still worked. 90 seconds, then 5 minutes, then 15, then it stops, one job at a time and never while a tile or its scenery is in the air |
| The wide skeleton | One `arterials` request over a **120 km box**, sized off what the loading screen costs rather than off how big a world sounds good. A 200 km version shipped, and was measured on a real phone at **36.7 MB and twenty-three seconds** — most of a minute's wait for roads reached after an hour of driving, and the report it produced was "pls fix the map load". Sizing it properly needed the real composition rather than a guess, so the captured Belgrade skeleton was counted: over the ±36 km box, `secondary` is **55.7%** of the bytes, `primary` 12.5%, and `motorway\|trunk` together only 15%. The dense half of the arterial set is the half you see out of the windscreen; the sparse half is the half that goes somewhere. So the ask narrows as it widens, in one union — `motorway\|trunk` over the full radius, `primary` and the slip roads over 100 km of it, `secondary` and the rest confined to the 36 km the drivable mask reaches, since past the mask there is no ground to be on or off and a road out there is scenery on the big map. That model predicts 41 MB for the 200 km ask against the 36.7 measured, which makes the rest of the table worth trusting: 100 km is 18.5 MB, **60 km is 8.7 MB and about five seconds**, 36 km is 5.2. Deliberately **not** the full drivable set either — residential lanes are the overwhelming majority of a city's ways and putting them back is the difference between twenty megabytes and a query the server refuses outright. Tried at 60 km, then 36, 18, 9 under one 45-second shared deadline, so a server that won't answer for the wide box still gives you the biggest world it will. **The ladder is for refusals, not for empty ground**, and the two arrive down different paths. A rung turned away — 429, timeout, box too big — is worth retrying smaller. A rung that came back with nothing in it means all six mirrors agreed there are no arterials out there, and a smaller box inside an empty one cannot hold any; descending is three more rungs of asking servers a question they have already answered. Each costs about twelve seconds, because unanimity means waiting on the sixth mirror, so telling them apart is the difference between a quick start and a minute of loading screen for anyone in open country |
| The ring that stopped arriving | The detailed city is nine tiles — the 1.8 km square you start in and the eight around it — and it is skipped when the area looks too heavy for eight more street requests. The number that decision read was the wall clock since DRIVE was pressed: the geocode, every mirror that was unreachable or empty before a good one answered, and **the entire arterial skeleton**. A reported session had streets back in 5.5 s and was scored at twenty, so the ring was dropped and the detailed city came out ONE tile wide — 1.8 km of real streets, then nothing but trunk roads, which is what "the streets are not loaded well" looks like. The skeleton is the tell: it costs the same eight seconds in Belgrade as in a village, says nothing about the density of the streets here, and once it went out to 36 km that sum was over the threshold in essentially every city. So the measure is now the reply that actually landed, on its own — `sess.replyMs`, recorded where the body is read — and the skeleton is not in it. The rule it feeds is untouched and still protects a genuinely slow area: 16 s of streets still skips the ring. **The scenery went with it**, since each tile side-fetches its buildings once its streets land — the reported session had 1,290 buildings, and the replay now has 3,746 across all nine tiles, against five tiles' worth that the proximity streamer happened to pick up on its own. **And it no longer holds the loading screen.** Eight sequential street requests against a twelve second cap, plus a two and a half second landmark sweep, was most of a load — measured against a captured session's own latencies the whole thing came to nearly twenty seconds, and on the phone that reported it, with slower mirrors and the skeleton at 200 km, it was still on the loading screen at forty-nine. Neither is anything the player is waiting FOR: the ring is ground a few seconds' driving away that the proximity streamer would fetch regardless, and the landmarks are a garage you want when you are damaged rather than when you start. Both run behind the wheel now, back to back so the ring still fills in far faster than the one-per-cooldown streamer would manage, and the opening nine tiles are still marked permanent however late they land. Time from DRIVE to holding the wheel, on those same latencies: **19.9 s to 7.7 s** |
| Streaming | Tile (i,j) is the 1.8 km square centred on (i·1800, j·1800) in local metres, so tile (0,0) is the opening area and neighbours abut it exactly. The eight around it are pulled during loading, so the detailed centre is 5.4 km. **World size comes from the tiles loaded and the skeleton's rectangle, never from the geometry inside them** — Overpass returns the full shape of anything merely touching the box it was asked for, and one overhanging way once stretched the world to ±150 km, which shrank the city to a speck on the radar and blew the collision mask up to millions of cells. Overhanging features are simply drawn and clipped. Tiles go on carrying **streets** for the whole session, because the skeleton is arterials and a residential street is not one — this used to switch to scenery only once the skeleton landed, and what that bought was a saved log from Репиште in which every reply after the first forty seconds was `buildings`: the district arrived as buildings on bare ground, and the car sat in the middle of it at 14 km/h with the throttle down. What recycling a far tile gives back is its **scenery**; its roads stay. Not a concession — dropping a road means un-marking it from the drivable mask, cells are shared between overlapping ways, and the only correct answer is to clear the mask and re-mark every road in the world, which at skeleton scale would run on nearly every tile load. Keeping them costs geometry and nothing else, because the mask is already at full size the moment the skeleton lands and never resizes again, so folding in a new tile only ever marks that tile's own roads |
| Empty is not healthy | A mirror that answers **200 with no elements**, instantly, is broken — not fast. One session caught a host doing exactly that for every query it was given. Its first empty answer was to the landmark sweep, where empty is perfectly normal, so it was marked healthy and jumped the queue; every other mirror had picked up misses being slow under the heavy opening requests. From then on it won every hedge, because 130 ms beats everything, and returned nothing every time — **seven of the eight opening tiles died as "empty tile"** and the detailed city came out two tiles wide instead of nine. Replayed against the captured payloads, that build fell all the way back to the generated city: 26 roads where Belgrade has 8,345. The fix exempted landmarks and scenery, on the reasoning that a box really can have none in them, and **the next session showed what the exception costs** — the same host answered nothing to the 36 km landmark sweep and to three of the four scenery tiles, each individually plausible, each accepted. That session ended with one landmark in a 36 km radius of central Belgrade and no repair shop anywhere, which is exactly what was reported. Nothing in a reply tells a genuinely empty box from a mirror serving an empty database — both are 200 with a list of length zero — so no single mirror's silence is believed, whatever was asked for. **Six of them agreeing is a different matter**, and that is the rule now: every empty answer is handed to the next host, and only when they have all said the same nothing does the box count as empty. It costs about a second, because an empty reply arrives in a quarter of one and releases the next mirror immediately, and it keeps the two failure modes apart — a tile over open water settles as loaded-and-empty rather than failing, backing off and being asked for again every ninety seconds for as long as you drive near it |
| Growing the mask | `markDrivable` bounds-checks against the grid and silently skips cells outside it, so a way overhanging the box it arrived in was marked only as far as the mask reached at the time — and growing the mask used to blit the old marks across faithfully, missing part included. Tile (0,0) sizes the grid to ±940 m; the skeleton then grows it to ±36 km, and every street leaving that first box stayed unmarked past 940 m for the whole session. In real Belgrade data that is Немањина reading as open ground with its own centreline **0.1 m** away — a car crawling on a main road, which is exactly what was reported. The duplicate arriving with the skeleton cannot repair it either: same OSM id, deduped out before it is ever marked. So a grown grid re-marks everything, not just what came in the box that grew it |
| The session log | Every bug here gets diagnosed against a fixture written by hand, because the machine doing the diagnosing cannot reach Overpass — which is a guess about the shape of real data dressed up as a test. The "car crawls on tarmac" fault was pedestrian squares in real Belgrade, and it only became reproducible once the fixture happened to contain one. So **⤓ LOG** saves what the servers actually said: every Overpass and Nominatim reply **verbatim, as text, captured before anything parses it** — kind, the exact query, the bbox, which mirror answered, status, bytes, timing — then a snapshot of the world and the car, then every error, `console.warn`, unhandled rejection and mirror refusal, timestamped against page load. Capped at 25 MB, keeping the *earliest* replies, because those are the city you started in; anything dropped is counted rather than silently lost. It sits above every screen including the menu, since the log worth having most is from a load that failed and by then the HUD has never appeared. Saved through the iOS share sheet — a Blob download is routinely swallowed by Safari, which opens the JSON in a tab and leaves you nothing to keep — falling back to a download, and it all runs inside the tap because iOS only honours a share from a real gesture |
| The recording, kept | The log was only half of it: a capture that lives in a chat message is gone the moment the window is closed, and every fixture in this project other than this one is a guess about the shape of OpenStreetMap dressed up as a test. So one whole session is checked in — `tests/fixtures/stari-grad`, 16 MB of Overpass replies from the old town of Belgrade, gzipped to 2 MB with a SHA-256 of each **decompressed** body beside it, so "replayed byte for byte" is something `tests/real.mjs` verifies rather than something this table claims. It buys three things nothing else can: 13,000 sampled points of real geometry to check the drivable mask against, real `highway=pedestrian` squares in the middle of a real city, and a 72 km skeleton with real junctions. The bundled offline city is built out of the same files by `tools/buildcity.py`, so the fallback and the fixture cannot drift apart |
| The fence | The world edge clamps every car to `W.minX..maxX` and hands back 30% of its velocity. That box used to be the tiles that had **arrived**, which made a tile still in flight an invisible wall: drive into it with the throttle down and the car pins at walking pace against nothing, on a map that plainly continues ahead — no collision, no message, turning round frees it instantly. On a slow connection the opening ring can leave that wall under a kilometre from the start. So the fallback path now reserves the player's own tile and its eight neighbours as they drive, putting the fence a tile ahead of the car and carrying it along; ground that is reserved but hasn't arrived is simply off-road, drivable at off-road speed until it does. Only in the fallback — when the skeleton landed it *is* the world, bounded and symmetric, and reserving past it would push a twenty-million-cell mask outwards for ever. At the genuine edge the car still stops, but it now says **EDGE OF THE MAP**: a silent stop with the throttle down is indistinguishable from a broken game |
| Thumb pads | Read from the **live touch list** on every touch event, not latched by paired touchstart/touchend, because on a phone those pairs don't reliably arrive. iOS cancels a touch the moment it decides the finger belongs to a system gesture, and the old handlers took that cancel for a lifted thumb: the throttle latched off with the thumb still on the glass and nothing coming to put it back. Rebuilding the whole state from `e.touches` makes a dropped end, a doubled start, a cancel that takes one finger of three, or a thumb sliding between pads into just another reading that the next event corrects. It can't resurrect a finger the browser confiscated — nothing can — so the pads also moved out of the strips a phone keeps for its own gestures: 16 px from the side and 18 px from the bottom put every one of them inside the swipe-back gutter and the home indicator, which is where a held press gets taken away in the first place |
| Deduplication | Every way carries its OSM id, and one already in the world is dropped. Overlapping requests are the norm rather than the exception: the skeleton repeats every trunk road the detailed centre holds, the opening buildings cover the same ground as tile (0,0), and a way lying on a seam arrives with both its tiles. Without it the same tarmac is drawn, marked and lit twice — and worse for buildings, only the first copy gets marked passable, so an archway you could drive through silently becomes a wall you cannot |
| Recycling | Only scenery is ever recycled, and only from tiles that arrived after play started — the ones loaded before it are permanent, since their roads are part of the fixed network. The furthest behind you are dropped to make room, taking their ids with them so driving back finds them again. Just the building hash is rebuilt: re-indexing the world here used to be right, but re-marking a 100 km skeleton mid-drive is a visible stutter for no gain, because nothing it rebuilds can change any more |
| Audio | WebAudio oscillators only — sawtooth engine, two-tone siren, noise-burst crashes, and a band-passed sweep for the tyre squeal. The context is **resumed on every gesture and whenever the page comes back**, not just when it is created: iOS hands back a suspended context routinely — opening the page from another app is the usual case — and resuming only at creation left one bad start silently mute for ever, with every later tap short-circuiting past the fix |

Overpass is rate-limited and occasionally slow, so requests rotate across six mirrors. If all of
them fail — or you pick a spot with no roads, like the middle of the ocean — you get the
**bundled offline city**: Belgrade around Autokomanda, shipped in `data/belgrade.js` and captured
from OpenStreetMap by the in-game log button: **3,170 real streets** across the full 5.4 km
detailed centre, 7,067 real buildings and parks, and an arterial skeleton reaching **15 km** in
every direction — a 30 km world, not the pocket the first version bundled. It is the same data the
online path builds from, so nothing downstream can tell the difference. A generated grid is still underneath it, in case the
bundle itself cannot load. **The game always starts.**

And it always says why. Landing in a city you did not ask for with nothing but a welcome banner
reads as the game ignoring you, so the arrival toast names **the place you asked for, what went
wrong, and where you are instead** — and the same sentence stays on the pause card for the rest
of the session, because "why am I in Belgrade?" is a question you ask ten minutes later, long
after a toast has faded. It is a `<script>` tag rather than a `fetch`, loaded on demand: four
megabytes has no business on the normal path, and `fetch()` is refused for `file://` URLs while a
script tag is not. `tools/buildcity.py` rebuilds it from `tests/fixtures/stari-grad`, which is
the recording it came out of.

## About Google Maps

The repo is called GoogleMapsGTA, and the original ask was Google Maps. It uses OpenStreetMap
instead, deliberately:

1. The Google Maps JavaScript API requires a **billed API key**, which can't be committed to a
   public repo — every visitor would be spending the owner's quota.
2. More importantly, Google serves **rendered tiles** — pictures of a map. There are no road
   centrelines or building polygons in them, so cars would be driving on a photograph with
   nothing to collide against. Overpass returns real vector geometry, which is exactly what the
   physics needs.

If you have a key and want Google's tiles as the ground layer, the swap is small: draw the tiles
into the world transform in `render()` beneath the road layer, and keep using OSM geometry for
collision and the drivable grid. The projection helpers (`projX` / `projY`) already give you
metre coordinates to place tiles against.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
Geocoding by Nominatim, geometry by Overpass — please respect their usage policies.

There are no image assets. Every texture — the trees, the render on the walls — is generated
from fractal noise at load by `js/proctex.js`. Everything is drawn in code.

A parody tribute. Not affiliated with, endorsed by, or connected to Rockstar Games or Google.
