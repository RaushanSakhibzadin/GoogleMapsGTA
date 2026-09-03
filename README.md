# VICE MAPS

## ▶ [**PLAY IT HERE**](https://realcityauto.com/)

A GTA: Vice City–flavoured driving sandbox that runs on **real streets, anywhere on Earth**.
Type a place — your street, Miami Beach, Shibuya — and it pulls the actual road network and
building footprints for that spot and turns them into a drivable city.

No build step, no dependencies, no API key. Open `index.html` and drive.

```
git clone https://github.com/RaushanSakhibzadin/GoogleMapsGTA.git
cd GoogleMapsGTA && open index.html          # or: python3 -m http.server
```

## ❤ [Back it on Patreon](https://www.patreon.com/raushanraushan)

Free and always will be. **Any tier** gets **GHOST MODE**: full speed across open ground and
straight through buildings, where the car is otherwise a road car that drops to walking pace off
the tarmac. Backers get the word that unlocks it, in a post on the page.

## Controls

| | |
|---|---|
| **W A S D** / arrows | drive, reverse, steer — up to 360 km/h |
| **Space** | handbrake — hold it into a corner and the back end steps out |
| **H** | horn |
| **N** / the ☾ pad | daylight ⇄ dusk. The game opens in daylight |
| **V** / the **3D** button | top-down view ⇄ chase view |
| **M** / tap the radar | the full city map — drag to pan, pinch to zoom |
| **R** / the bar along the bottom | next radio station; the name plays and stops it |
| **♪** | two volumes, the game's and the radio's |
| **⤓ LOG** | saves what the map servers sent and everything that went wrong |
| **Esc** | pause / change city |
| touch | on-screen pads appear automatically on phones and tablets |

## What's in it

- **Real map.** Road centrelines with their OSM class, buildings at their real heights and
  colours, names painted across the wall that carries them.
- **A 120 km city in about eight seconds.** Every lane across the 5.4 km you start in, arterials
  for 60 km, and more streets streaming in as you drive.
- **Five shifts** — courier, taxi, police, fire, ambulance. Clock on at a real depot: a taxi rank,
  a police station, a fire station, a hospital. The engine and the ambulance are their own
  vehicles, not repainted cars.
- **Traffic, police, pedestrians, a wanted level**, repair shops, and a day/night switch.
- **Trees where OSM says there is green.** Street trees along the verges, and a stand of mature
  ones — three times a street tree, 25 to 40 m — filling every park, garden and courtyard lawn
  in the data. Grown from the same fractals as everything else, planted off a world-aligned
  lattice so a rebuilt block comes back identical.
- **Red or black.** OpenStreetMap knows where the casinos are, so they are on the map where they
  really are — Belgrade has dozens. Two buttons at the table, a tenth of your money on a fair
  coin, and whichever colour you pick more is the side you are on. From the first bet you carry
  a spray can: a wall you paint goes your colour in the street, in the chase view and on the
  radar, with an unreadable tag across its ground floor. Every so often the other side takes one
  back. A city with no casinos in OSM simply has none, and nothing else changes.
- **Three renderers**: Canvas 2D top-down, hand-written WebGL2 for the chase view, and software 3D
  for a browser with WebGL turned off.
- **No image assets.** Every texture is grown from fractal noise at load.
- **Local radio**, from the [Radio Browser](https://www.radio-browser.info/) directory, sorted by
  how close each transmitter is to you.
- **Ten languages**, taken from your browser's own preferences.
- **Works with the map servers down** — real Belgrade is bundled.
- **⤓ LOG** saves the raw map replies and everything that went wrong.

## How it works

| | |
|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) turns "Ocean Drive, Miami Beach" into a lat/lon |
| Geometry | [Overpass API](https://overpass-api.de), `out geom qt;`. Split into streets / buildings / landmarks so the loading screen only waits for what it cannot start without |
| Projection | Local equirectangular: `x = (lon−lon₀)·111320·cos(lat₀)`. Metres are the world unit |
| Physics | Forward/lateral velocity split, per-car mass, OBB collisions off a 26 m bucket grid |
| Off-road | A drivable mask stamped along centrelines; off it the car crawls, unless GHOST |
| Streaming | 1.8 km tiles, geometry batched per 512 m cell, one cell built per frame |
| Loading | The screen waits 9 s for the streets and 6 for the wide map, then starts you in the bundled city and keeps the request running — if it lands, the real city swaps in behind the wheel. Silent mirrors cost 10 s instead of 42 |
| Cache | Every script is fetched with `?v=<hash>` over the contents of all of them, so a deploy is never invisible |
| Tests | 87 Playwright suites — `node tests/run.mjs`, about fifty minutes |

Everything is plain `<script>` files sharing one global scope, deliberately **not** ES modules:
modules are blocked over `file://`, and opening the game straight off disk is the point. Load
order is fixed in `index.html`.

```
index.html   markup      style.css    styling      data/belgrade.js  the offline city
js/i18n.js   ten languages            js/util.js   palette, theme
js/geo.js    network: Overpass, Nominatim         js/log.js    the session log
js/world.js  OSM parsing, indexes, streaming      js/terrain.js  the heightfield
js/turf.js   casinos, the bet, the spray can
js/entities.js  cars, traffic, police, physics    js/body3d.js   the car as a cuboid
js/game.js   state, shifts, missions, wanted      js/io.js     input, audio, canvas
js/render.js top-down view            js/render3d.js  chase view + the dispatcher
js/soft3d.js chase view without a GPU  js/gl.js    WebGL2 plumbing, ear clipping
js/carmesh.js  the car mesh           js/proctex.js  every texture, from fractals
js/radio.js  the dial                 js/main.js   the loop, menus, debug hooks
tools/       buildcity.py, logfixture.py, stamp.mjs, glb2car.py, perkword.mjs, mirror.mjs
tests/       the suite, and the captured sessions it replays
```

**Why the decisions are not in this file.** Nearly every non-obvious line in this repo carries a
comment saying what was tried, what it measured, and why it is the way it is. That is where the
reasoning lives — next to the code it explains, where it cannot drift out of date.

## About Google Maps

The repo is called GoogleMapsGTA and the original ask was Google Maps. It uses OpenStreetMap
instead, for two reasons: the Google Maps API needs a billed key, which cannot go in a public
repo; and Google serves *rendered tiles* — pictures of a map, with no road centrelines or
building polygons in them, so there would be nothing to collide against. Overpass returns real
vector geometry, which is what the physics needs.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
Geocoding by Nominatim, geometry by Overpass — please respect their usage policies.
Radio directory by [Radio Browser](https://www.radio-browser.info/).

A parody tribute. Not affiliated with, endorsed by, or connected to Rockstar Games or Google.
