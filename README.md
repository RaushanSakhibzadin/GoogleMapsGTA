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
data/belgrade.js  the bundled offline city — real central Belgrade
js/util.js      utilities, palette, theme
js/log.js       the session log: what the map servers said, and what went wrong
js/geo.js       projection, Overpass, Nominatim — everything that talks to the network
js/world.js     parsing OSM, spatial indexes, tile streaming, landmarks
js/entities.js  cars, traffic, police, pedestrians, and the driving physics
js/io.js        input, audio, canvas
js/game.js      game state, missions, wanted level, the per-frame update
js/render.js    everything that draws
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
| **Esc** | pause / change city |
| touch | on-screen pads appear automatically on phones and tablets |
| GHOST MODE | the switch on the title screen and the pause card — supporter perk, see the top |
| **⤓ LOG** | top right, on every screen — saves what the map servers sent and everything that went wrong |

## What's in it

- **Real map geometry.** Road centrelines with their OSM classification (a motorway is wider
  and faster than a service road), building footprints with real heights from `height` /
  `building:levels` tags, plus parks.
- **A 36 km city, loaded before you drive.** The whole road network arrives while the loading
  screen is up, and none of it is ever fetched again. It comes at two levels of detail: every lane
  and service road across the 5.4 km you start in, and the **arterial skeleton** — motorways, trunk,
  primary and secondary roads — across **18 km in every direction**. Asking for every street in a
  box that size is 15–40 MB and times out in any real city; the roads you'd actually cross a city on
  are a few, and they're what gives the place a horizon. If the wide request is refused it retries
  at 9 km, then 4 km, so you get the biggest world that server would give you. Once you're driving
  the only thing that still loads is scenery — buildings filling in quietly behind you, never roads,
  so the world never stalls mid-corner. Packets, traffic and pedestrians spawn wherever you are, and
  delivery contracts reach right across it.
- **Real building colours.** Every building takes the colour a mapper actually recorded in
  `building:colour` / `roof:colour` where one exists, then falls back through
  `building:material` (brick, concrete, glass, stone, metal, wood), then what the building is
  for — houses get render and brick, offices get concrete and glass, warehouses get metal —
  and only then to size and height. Roofs use real roof materials (asphalt, gravel, terracotta
  tile, membrane) rather than the facade colour, since a roof is what you actually see from above.
- **Street and district names, GTA style.** Turn onto a new road and its name appears by the
  radar, then fades. Cross into a new neighbourhood and the district name flashes up bottom-right
  and stays, the way Vice City announces its zones. Deliveries name their destination street too.
- **Dusk or daylight.** `N` switches the whole scene between the neon sunset and a bright
  daytime palette — asphalt roads, green parks, sunlit facades. Buildings store their
  material colour rather than a finished one, so the swap is instant.
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
- **Traffic and pedestrians.** Cars drive the real ways node by node. Pedestrians keep to the
  pavement and turn back at the kerb, so you have to work to hit one.
- **Five-star wanted level.** Ramming cars, hitting cops, and running people down raises it.
  Police pursue directly and get faster with each star. Lose them for 8 seconds and it decays.
- **Busted and wasted have somewhere to take you.** Give up — stop the car — and the units closing
  on you ease off, pull alongside and stop too. Hold still for a beat and you're **BUSTED**: half
  your cash gone, and you come round at the nearest real police station on the map. A cop still
  rolling past is a near miss, not an arrest. Run out of armor and you're **WASTED** — cleaned out
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
  there's no station and no hospital in range. It all happens before you start driving: once you're
  on the road, nothing but scenery is ever fetched.
- **Delivery missions.** Pink marker to yellow marker against a timer, paying out by distance.
  Cash persists in `localStorage`.
- **Vice City dusk.** Neon rooftop trim, street lights, headlight cones, skid marks, scanlines,
  a rotating minimap, and a synthesised engine that tracks your RPM — no audio files.

## How it works

| Concern | Approach |
|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) — turns "Ocean Drive, Miami Beach" into a lat/lon |
| Geometry | [Overpass API](https://overpass-api.de) `out geom qt;`, so coordinates come inline. Split by what the game cannot start without: the **streets** request carries roads and place names over a 1.8 km box and nothing else, because if it fails you get a generated grid instead of the place you asked for and every extra clause is more time between pressing DRIVE and driving. The wide **arterials** request, buildings and parks, and landmarks each ride their own request and land when they land |
| Resilience | Six Overpass mirrors, shuffled per session so everyone doesn't queue behind the same host and a reload genuinely re-rolls. The next one starts 2.2 s into the last one's silence: a mirror unreachable from your network fails in about a second, and at the old 7 s hedge it burned its retries while the healthy mirrors sat un-started — "asking 5 map servers" sixteen seconds in, all of it spent on one dead host. **Mirror health is remembered**, because every request used to rediscover that dead host for itself: the streets query, the buildings, the skeleton and eight ring tiles between them soaked up thirty connection attempts in one load. Learned once, it drops to two. Client timeouts outlast the server's own `[timeout:N]`, transient 429/5xx are retried with backoff honouring `Retry-After`, the loading screen names the host that turned us away and why, and preset cities carry their own coordinates so the common path never touches the geocoder. How long the opening request took is also a read on how heavy the area is: somewhere slow enough to make you wait is where eight more street requests hurt most, so the opening ring shrinks to the four sides, or is skipped entirely |
| Projection | Local equirectangular — `x = (lon−lon₀)·111320·cos(lat₀)`, metres are the world unit |
| Rendering | Canvas 2D. Camera rotates so the car points up; buildings fake 3D by pushing the roof polygon away from screen centre and filling the wall quads |
| Culling | Spatial hashes over absolute metres, keyed so they never need rebuilding: 90 m cells for building collision, 256 m for the per-frame road cull, 300 m for picking somewhere to spawn traffic. All three replaced linear scans that were fine over 1.8 km and are not fine over 36 — filtering every road in the world four times a frame, or picking a random road and hoping it lands within 200 m of you, which at skeleton scale simply never happens and traffic stops appearing |
| Minimap | A 4 km window around the car, pre-rendered to an offscreen canvas at 0.6 px/m, so the minimap costs a single rotated `drawImage` per frame and is redrawn only when you leave the middle of it. It used to be the whole city, which stopped working the moment the city was 36 km wide: fitted to one canvas that's 0.067 px/m and unreadable, and drawing it sharp would need a 116-megapixel canvas |
| Street lookup | A road spatial hash over 90 m cells — naming the street you're on is a handful of segment tests, debounced so junctions don't strobe |
| Landmarks | `amenity=police`, `amenity=hospital` and `shop=car_repair`, pulled with the streets query as `nwr` so a station tagged as a bare node and one tagged as a building both land. Overpass returns the same landmark more than once — a hospital matches the amenity query and again as a building, and anything on a tile seam arrives with both tiles — so they're deduped by kind within 30 m |
| Wide sweep | When a kind is missing, a landmark-only query over a 36 km box — run **while the loading screen is still up**, so that once you're driving nothing but scenery requests ever fire. Sparse tag-indexed features make the area cheap, and `out center` returns a point per hit instead of a whole building outline. Still no station and no hospital and it climbs to a 90 km box there and then. Waited on with a few seconds' cap rather than blocked on, and no new rung may start once loading is done — a landmark query is allowed 40 s, and a loading screen that hangs on a nicety is its own bug. Failing costs nothing — the start point is still there |
| Finding a garage | Landmarks were baked into the pre-rendered map at five pixels — and the radar scales that map down to fit 230 m across a 98 px phone display, so the dot arrived under two pixels. A player with **226 repair shops loaded and the nearest 543 m away** could not find one, which is exactly what a log said. They are drawn as per-frame blips now, the same size as everything else you are meant to see. And because the nearest garage is usually further out than the radar reaches, the one landmark you go looking for on purpose gets a **pointer on the rim** at its true bearing with the distance beside it — brighter once the armour is low enough to want it. It rotates with the radar, so turning the car through 180° swings it through 180° |
| Drive-through landmarks | The `passable` flag the tunnel handling already uses: skipped in collision, drawn at 45% alpha. Marked on any footprint a landmark falls inside, which covers both tagging styles — the way form where the hospital *is* the building, and the node form where a garage node sits in someone else's outline |
| Respawning | Snaps to the nearest point *on* a drivable segment, not its midpoint, which on a long straight way can be hundreds of metres out. It only snaps when tarmac is within 120 m, since the wide sweep finds landmarks well outside the loaded streets and the nearest loaded road to those is the edge of the map. Beyond 6 km you go to the start point instead: the collision grid and the pre-rendered map both span everything loaded, so a long jump bloats the mask and zooms the radar out until it's useless |
| The wide skeleton | One `arterials` request over a 36 km box: `motorway\|trunk\|primary\|secondary` and their links, plus place nodes for the district banner. Deliberately **not** the full drivable set — residential lanes are the overwhelming majority of a city's ways and putting them back is the difference between a few megabytes and a query the server refuses outright. Two clauses, same shape as the streets query, for the same reason. Tried at 18 km, then 9, then 4 under one shared deadline, so a server that won't answer for the big box still gives you the biggest world it will |
| Streaming | Tile (i,j) is the 1.8 km square centred on (i·1800, j·1800) in local metres, so tile (0,0) is the opening area and neighbours abut it exactly. The eight around it are pulled during loading, so the detailed centre is 5.4 km. **World size comes from the tiles loaded and the skeleton's rectangle, never from the geometry inside them** — Overpass returns the full shape of anything merely touching the box it was asked for, and one overhanging way once stretched the world to ±150 km, which shrank the city to a speck on the radar and blew the collision mask up to millions of cells. Overhanging features are simply drawn and clipped. Once play starts, tiles carry **scenery only** — buildings, never roads — so the road network, the collision mask and every road index are fixed for the whole session and nothing can stutter mid-drive |
| Empty is not healthy | A mirror that answers **200 with no elements**, instantly, is broken — not fast. One real session caught a host doing exactly that for every query it was given. Its first empty answer was to the landmark sweep, where empty is perfectly normal, so it was marked healthy and jumped the queue; every other mirror had picked up misses being slow under the heavy opening requests. From then on it won every hedge, because 130 ms beats everything, and returned nothing every time — **seven of the eight opening tiles died as "empty tile"** and the detailed city came out two tiles wide instead of nine. So an empty body never promotes a mirror, and for roads it is treated as a failure and handed to the next host. Replayed against the captured payloads, the old code fell all the way back to the generated city — 26 roads where Belgrade has 8,345 |
| Growing the mask | `markDrivable` bounds-checks against the grid and silently skips cells outside it, so a way overhanging the box it arrived in is marked only as far as the mask reached at the time — and growing the mask blits the old marks across faithfully, missing part included. Tile (0,0) sizes the grid to ±940 m; the skeleton then grows it to ±18 km, and every street leaving that first box stayed unmarked past 940 m for the whole session. In real Belgrade data that is Немањина reading as open ground with its own centreline **0.1 m** away — a car crawling on a main road, which is exactly what was reported. The duplicate arriving with the skeleton cannot repair it either: same OSM id, deduped out before it is ever marked. So a grown grid re-marks everything, not just what came in the box that grew it |
| The session log | Every bug here gets diagnosed against a fixture written by hand, because the machine doing the diagnosing cannot reach Overpass — which is a guess about the shape of real data dressed up as a test. The "car crawls on tarmac" fault was pedestrian squares in real Belgrade, and it only became reproducible once the fixture happened to contain one. So **⤓ LOG** saves what the servers actually said: every Overpass and Nominatim reply **verbatim, as text, captured before anything parses it** — kind, the exact query, the bbox, which mirror answered, status, bytes, timing — then a snapshot of the world and the car, then every error, `console.warn`, unhandled rejection and mirror refusal, timestamped against page load. Capped at 25 MB, keeping the *earliest* replies, because those are the city you started in; anything dropped is counted rather than silently lost. It sits above every screen including the menu, since the log worth having most is from a load that failed and by then the HUD has never appeared. Saved through the iOS share sheet — a Blob download is routinely swallowed by Safari, which opens the JSON in a tab and leaves you nothing to keep — falling back to a download, and it all runs inside the tap because iOS only honours a share from a real gesture |
| The fence | The world edge clamps every car to `W.minX..maxX` and hands back 30% of its velocity. That box used to be the tiles that had **arrived**, which made a tile still in flight an invisible wall: drive into it with the throttle down and the car pins at walking pace against nothing, on a map that plainly continues ahead — no collision, no message, turning round frees it instantly. On a slow connection the opening ring can leave that wall under a kilometre from the start. So the fallback path now reserves the player's own tile and its eight neighbours as they drive, putting the fence a tile ahead of the car and carrying it along; ground that is reserved but hasn't arrived is simply off-road, drivable at off-road speed until it does. Only in the fallback — when the skeleton landed it *is* the world, bounded and symmetric, and reserving past it would push a twenty-million-cell mask outwards for ever. At the genuine edge the car still stops, but it now says **EDGE OF THE MAP**: a silent stop with the throttle down is indistinguishable from a broken game |
| Thumb pads | Read from the **live touch list** on every touch event, not latched by paired touchstart/touchend, because on a phone those pairs don't reliably arrive. iOS cancels a touch the moment it decides the finger belongs to a system gesture, and the old handlers took that cancel for a lifted thumb: the throttle latched off with the thumb still on the glass and nothing coming to put it back. Rebuilding the whole state from `e.touches` makes a dropped end, a doubled start, a cancel that takes one finger of three, or a thumb sliding between pads into just another reading that the next event corrects. It can't resurrect a finger the browser confiscated — nothing can — so the pads also moved out of the strips a phone keeps for its own gestures: 16 px from the side and 18 px from the bottom put every one of them inside the swipe-back gutter and the home indicator, which is where a held press gets taken away in the first place |
| Deduplication | Every way carries its OSM id, and one already in the world is dropped. Overlapping requests are the norm rather than the exception: the skeleton repeats every trunk road the detailed centre holds, the opening buildings cover the same ground as tile (0,0), and a way lying on a seam arrives with both its tiles. Without it the same tarmac is drawn, marked and lit twice — and worse for buildings, only the first copy gets marked passable, so an archway you could drive through silently becomes a wall you cannot |
| Recycling | Only scenery is ever recycled, and only from tiles that arrived after play started — the ones loaded before it are permanent, since their roads are part of the fixed network. The furthest behind you are dropped to make room, taking their ids with them so driving back finds them again. Just the building hash is rebuilt: re-indexing the world here used to be right, but re-marking an 18 km skeleton mid-drive is a visible stutter for no gain, because nothing it rebuilds can change any more |
| Audio | WebAudio oscillators only — sawtooth engine, two-tone siren, noise-burst crashes, and a band-passed sweep for the tyre squeal. The context is **resumed on every gesture and whenever the page comes back**, not just when it is created: iOS hands back a suspended context routinely — opening the page from another app is the usual case — and resuming only at creation left one bad start silently mute for ever, with every later tap short-circuiting past the fix |

Overpass is rate-limited and occasionally slow, so requests rotate across six mirrors. If all of
them fail — or you pick a spot with no roads, like the middle of the ocean — you get the
**bundled offline city**: real central Belgrade, shipped in `data/belgrade.js`, captured from
OpenStreetMap by the in-game log button. It has 4,300 real roads, 4,200 real buildings and its
own 4.5 km arterial skeleton, and it is the same data the online path builds from, so nothing
downstream can tell the difference. A generated grid is still underneath it, in case the bundle
itself cannot load. **The game always starts.**

And it always says why. Landing in a city you did not ask for with nothing but a welcome banner
reads as the game ignoring you, so the arrival toast names **the place you asked for, what went
wrong, and where you are instead** — and the same sentence stays on the pause card for the rest
of the session, because "why am I in Belgrade?" is a question you ask ten minutes later, long
after a toast has faded. It is a `<script>` tag rather than a `fetch`, loaded on demand: three
megabytes has no business on the normal path, and `fetch()` is refused for `file://` URLs while a
script tag is not.

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

A parody tribute. Not affiliated with, endorsed by, or connected to Rockstar Games or Google.
