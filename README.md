# VICE MAPS

## ▶ [**PLAY IT HERE**](https://raushansakhibzadin.github.io/GoogleMapsGTA/)

<https://raushansakhibzadin.github.io/GoogleMapsGTA/>

A GTA: Vice City–flavoured driving sandbox that runs on **real streets, anywhere on Earth**.
Type a place — your street, Miami Beach, Shibuya — and it pulls the actual road network and
building footprints for that spot and turns them into a drivable neon city.

One file. No build step, no dependencies, no API key. Open `index.html` and drive.

```
git clone https://github.com/RaushanSakhibzadin/GoogleMapsGTA.git
cd GoogleMapsGTA && open index.html          # or: python3 -m http.server
```

It also runs straight from GitHub Pages — enable Pages on the repo and the root `index.html`
is the whole game.

## Controls

| | |
|---|---|
| **W A S D** / arrow keys | drive, reverse, steer — up to 300 km/h |
| **Space** | handbrake — hold it into a corner and the back end steps out |
| **H** | horn |
| **N** | switch between dusk and daylight (or the ☀ button on touch devices) |
| **Esc** | pause / change city |
| touch | on-screen pads appear automatically on phones and tablets |

## What's in it

- **Real map geometry.** Road centrelines with their OSM classification (a motorway is wider
  and faster than a service road), building footprints with real heights from `height` /
  `building:levels` tags, plus water and parks.
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
  daytime palette — asphalt roads, green parks, blue water, sunlit facades. Buildings store their
  material colour rather than a finished one, so the swap is instant.
- **Arcade physics.** Velocity is split into forward and lateral components against the car's
  heading; lateral grip drops hard under the handbrake, which is what makes it drift. Steering
  authority falls off with speed and inverts in reverse. Constant engine force against linear
  drag with a hard ceiling, so the 300 km/h on the clock is a speed you actually reach rather
  than an asymptote. The camera pulls back as you wind it out.
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
- **Deep water drowns you.** Rivers, lakes, docks and harbours are real geometry, and driving into
  one bogs the car down and takes it under in about a second and a half — you, traffic and police
  alike. Clip the bank and you can reverse out; commit and you're fished out at the hospital with
  nothing. Cars that go under sink rather than explode. Bridges are safe: the deck is part of the
  road network, and being *on a road* is what tells a crossing apart from the river beneath it.
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
| Geometry | [Overpass API](https://overpass-api.de) `out geom qt;`, so coordinates come inline. Split by what the game cannot start without: the **streets** request carries roads and place names over a 1.8 km box and nothing else, because if it fails you get a generated grid instead of the place you asked for and every extra clause is more time between pressing DRIVE and driving. The wide **arterials** request, buildings and parks, water, and landmarks each ride their own request and land when they land |
| Resilience | Client timeouts outlast the server's own `[timeout:N]`, transient 429/5xx are retried with backoff honouring `Retry-After`, mirrors are hedged on silence rather than on a stopwatch, and preset cities carry their own coordinates so the common path never touches the geocoder. How long the opening request took is also a read on how heavy the area is: somewhere slow enough to make you wait is where eight more street requests hurt most, so the opening ring shrinks to the four sides, or is skipped entirely |
| Projection | Local equirectangular — `x = (lon−lon₀)·111320·cos(lat₀)`, metres are the world unit |
| Rendering | Canvas 2D. Camera rotates so the car points up; buildings fake 3D by pushing the roof polygon away from screen centre and filling the wall quads |
| Culling | Spatial hashes over absolute metres, keyed so they never need rebuilding: 90 m cells for building collision, 256 m for the per-frame road cull, 300 m for picking somewhere to spawn traffic. All three replaced linear scans that were fine over 1.8 km and are not fine over 36 — filtering every road in the world four times a frame, or picking a random road and hoping it lands within 200 m of you, which at skeleton scale simply never happens and traffic stops appearing |
| Minimap | A 4 km window around the car, pre-rendered to an offscreen canvas at 0.6 px/m, so the minimap costs a single rotated `drawImage` per frame and is redrawn only when you leave the middle of it. It used to be the whole city, which stopped working the moment the city was 36 km wide: fitted to one canvas that's 0.067 px/m and unreadable, and drawing it sharp would need a 116-megapixel canvas |
| Street lookup | A road spatial hash over 90 m cells — naming the street you're on is a handful of segment tests, debounced so junctions don't strobe |
| Water | Areas from `natural=water` / `waterway=riverbank` in the streets query, plus `natural=water` **relations** on a request of their own — big rivers, harbours and bays are multipolygons, so without them you'd cross the Danube as if it were tarmac. Kept off the streets query deliberately: that one has to succeed for the city to exist at all, and river polygons are a nicety, so a server that dislikes the relation query costs you water rather than the whole place. `out geom(bbox)` clips, so a relation spanning a country returns just the slice over this tile. Inner rings are holes, so an island in a lake stays dry. Rings are clipped to their tile client-side, so a river returned whole doesn't drag a 300 km bounding box past every view cull |
| Landmarks | `amenity=police`, `amenity=hospital` and `shop=car_repair`, pulled with the streets query as `nwr` so a station tagged as a bare node and one tagged as a building both land. Overpass returns the same landmark more than once — a hospital matches the amenity query and again as a building, and anything on a tile seam arrives with both tiles — so they're deduped by kind within 30 m |
| Wide sweep | When a kind is missing, a landmark-only query over a 36 km box — run **while the loading screen is still up**, so that once you're driving nothing but scenery requests ever fire. Sparse tag-indexed features make the area cheap, and `out center` returns a point per hit instead of a whole building outline. Still no station and no hospital and it climbs to a 90 km box there and then. Waited on with a few seconds' cap rather than blocked on, and no new rung may start once loading is done — a landmark query is allowed 40 s, and a loading screen that hangs on a nicety is its own bug. Failing costs nothing — the start point is still there |
| Drive-through landmarks | The `passable` flag the tunnel handling already uses: skipped in collision, drawn at 45% alpha. Marked on any footprint a landmark falls inside, which covers both tagging styles — the way form where the hospital *is* the building, and the node form where a garage node sits in someone else's outline |
| Respawning | Snaps to the nearest point *on* a drivable segment, not its midpoint, which on a long straight way can be hundreds of metres out. It only snaps when tarmac is within 120 m, since the wide sweep finds landmarks well outside the loaded streets and the nearest loaded road to those is the edge of the map. Beyond 6 km you go to the start point instead: the collision grid and the pre-rendered map both span everything loaded, so a long jump bloats the mask and zooms the radar out until it's useless |
| The wide skeleton | One `arterials` request over a 36 km box: `motorway\|trunk\|primary\|secondary` and their links, plus place nodes for the district banner. Deliberately **not** the full drivable set — residential lanes are the overwhelming majority of a city's ways and putting them back is the difference between a few megabytes and a query the server refuses outright. Two clauses, same shape as the streets query, for the same reason. Tried at 18 km, then 9, then 4 under one shared deadline, so a server that won't answer for the big box still gives you the biggest world it will |
| Streaming | Tile (i,j) is the 1.8 km square centred on (i·1800, j·1800) in local metres, so tile (0,0) is the opening area and neighbours abut it exactly. The eight around it are pulled during loading, so the detailed centre is 5.4 km. **World size comes from the tiles loaded and the skeleton's rectangle, never from the geometry inside them** — Overpass returns the full shape of anything merely touching the box it was asked for, and one riverbank way once stretched the world to ±150 km, which shrank the city to a speck on the radar and blew the collision mask up to millions of cells. Overhanging features are simply drawn and clipped. Once play starts, tiles carry **scenery only** — buildings and water, never roads — so the road network, the collision mask and every road index are fixed for the whole session and nothing can stutter mid-drive |
| Deduplication | Every way carries its OSM id, and one already in the world is dropped. Overlapping requests are the norm rather than the exception: the skeleton repeats every trunk road the detailed centre holds, the opening buildings cover the same ground as tile (0,0), and a way lying on a seam arrives with both its tiles. Without it the same tarmac is drawn, marked and lit twice — and worse for buildings, only the first copy gets marked passable, so an archway you could drive through silently becomes a wall you cannot |
| Recycling | Only scenery is ever recycled, and only from tiles that arrived after play started — the ones loaded before it are permanent, since their roads are part of the fixed network. The furthest behind you are dropped to make room, taking their ids with them so driving back finds them again. Just the building hash is rebuilt: re-indexing the world here used to be right, but re-marking an 18 km skeleton mid-drive is a visible stutter for no gain, because nothing it rebuilds can change any more |
| Audio | WebAudio oscillators only — sawtooth engine, two-tone siren, noise-burst crashes |

Overpass is rate-limited and occasionally slow, so requests rotate across three mirrors. If all
of them fail — or you pick a spot with no roads, like the middle of the ocean — it generates a
procedural neon grid city instead and tells you so. **The game always starts.**

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
