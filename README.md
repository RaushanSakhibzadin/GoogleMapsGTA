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
- **The map streams as you drive.** The opening download is one 1.8 km tile. Get within ~500 m
  of its edge and the neighbouring tile is fetched in the background and folded into the live
  world — grid, collision, radar and all — so the city keeps going instead of stopping at a
  fence. Packets, traffic and pedestrians spawn out in the new districts, and delivery contracts
  reach further as more of the map arrives.
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
- **Traffic and pedestrians.** Cars drive the real ways node by node. Pedestrians keep to the
  pavement and turn back at the kerb, so you have to work to hit one.
- **Five-star wanted level.** Ramming cars, hitting cops, and running people down raises it.
  Police pursue directly and get faster with each star. Lose them for 8 seconds and it decays.
- **Busted and wasted have somewhere to take you.** Come to a stop with a police car stopped
  alongside you and you're **BUSTED** — half your cash gone, and you come round at the nearest real
  police station on the map. A cop still moving is a near miss, not an arrest. Run out of armor and
  you're **WASTED** — cleaned out completely, and you wake up at the nearest hospital. Where the map
  has neither, you go back to where the game started.
- **Repair shops.** Drive into a real `shop=car_repair` and you leave with full armor and a
  different paint job. They're marked in green on the radar, police stations in blue and hospitals
  in red, so you can see where you'd end up.
- **Delivery missions.** Pink marker to yellow marker against a timer, paying out by distance.
  Cash persists in `localStorage`.
- **Vice City dusk.** Neon rooftop trim, street lights, headlight cones, skid marks, scanlines,
  a rotating minimap, and a synthesised engine that tracks your RPM — no audio files.

## How it works

| Concern | Approach |
|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) — turns "Ocean Drive, Miami Beach" into a lat/lon |
| Geometry | [Overpass API](https://overpass-api.de) `out geom qt;` over a 1.8 km box, so coordinates come inline. Streets and buildings are fetched separately: streets are small and start the game, buildings are the bulk of the bytes and merge in afterwards |
| Resilience | Client timeouts outlast the server's own `[timeout:N]`, transient 429/5xx are retried with backoff honouring `Retry-After`, mirrors are hedged on silence rather than on a stopwatch, and preset cities carry their own coordinates so the common path never touches the geocoder |
| Projection | Local equirectangular — `x = (lon−lon₀)·111320·cos(lat₀)`, metres are the world unit |
| Rendering | Canvas 2D. Camera rotates so the car points up; buildings fake 3D by pushing the roof polygon away from screen centre and filling the wall quads |
| Culling | Per-feature bounding boxes against a view circle; a spatial hash over 90 m cells for collision |
| Minimap | The whole city is pre-rendered once to an offscreen canvas, so the minimap costs a single rotated `drawImage` per frame |
| Street lookup | A road spatial hash over 90 m cells — naming the street you're on is a handful of segment tests, debounced so junctions don't strobe |
| Landmarks | `amenity=police`, `amenity=hospital` and `shop=car_repair`, pulled with the streets query as `nwr` so a station tagged as a bare node and one tagged as a building both land. Overpass returns the same landmark more than once — a hospital matches the amenity query and again as a building, and anything on a tile seam arrives with both tiles — so they're deduped by kind within 30 m. Respawning snaps to the nearest point *on* a drivable segment, not its midpoint, which on a long straight way can be hundreds of metres out |
| Streaming | Tile (i,j) is the 1.8 km square centred on (i·1800, j·1800) in local metres, so tile (0,0) is the opening area and neighbours abut it exactly. Merging a tile grows the drivable mask in place (the old one is blitted into the new offset), appends to the spatial hashes — which key off absolute metres and so never need rebuilding — and redraws the radar. One tile in flight at a time, with a cooldown and per-tile backoff on failure |
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
