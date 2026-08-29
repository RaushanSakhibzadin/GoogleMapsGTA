# VICE MAPS

## ▶ [**PLAY IT HERE**](https://raushansakhibzadin.github.io/GoogleMapsGTA/)

A GTA: Vice City–flavoured driving sandbox that runs on **real streets, anywhere on Earth**.
Type a place — your street, Miami Beach, Shibuya — and it pulls the actual road network and
building footprints for that spot and turns them into a drivable city.

No build step, no dependencies, no API key. Open `index.html` and drive.

```
git clone https://github.com/RaushanSakhibzadin/GoogleMapsGTA.git
cd GoogleMapsGTA && open index.html          # or: python3 -m http.server
```

## ❤ [Back it on Patreon](https://www.patreon.com/raushanraushan)

Free and always will be. The **$10 tier** gets **GHOST MODE**: full speed across open ground and
straight through buildings, where the car is otherwise a road car that drops to walking pace off
the tarmac. It's a switch in the menu and it runs on trust — there is no server here, so any
check would be a line of JavaScript anyone could flip.

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

**The map is real.** Road centrelines carry their OSM classification, so a motorway is wider and
faster than a service road. Buildings get their real heights from `height` / `building:levels`,
and their real colours from `building:colour` where a mapper recorded one, then the material,
then what the building is for. Their names are painted across the widest wall, in the building's
own colour.

**A 120 km city, and you are driving in about eight seconds.** Two levels of detail: every lane
across the 5.4 km you start in, and the arterial skeleton across 60 km in each direction. Streets
keep streaming as you drive, a 1.8 km tile at a time. Six Overpass mirrors, shuffled per session,
with the request narrowing as it widens so the loading screen stays short.

**Five shifts.** Courier by default; pull up at a taxi rank, police station, fire station or
hospital and a button appears to take that work. Taxi fares are real pedestrians taken out of the
crowd and put back on the pavement at the drop. Police work is a car 300–900 m away that runs.
Fires are real buildings, fought with a hose from the street. The ambulance and the fire engine
are their own vehicles, not repainted cars — the appliance weighs eight times a hatchback and
shoves accordingly.

**Three renderers.** The top-down view is Canvas 2D. The chase view is hand-written WebGL2 — real
footprints extruded to real heights, ear-clipped roofs, window grids computed in the fragment
shader with no texture at all. And a third, software 3D on a plain canvas, for a browser with
WebGL switched off; it draws the same street with a painter's algorithm at about thirty frames a
second. Both main views ship, so a rendering bug can be bisected by pressing a button.

**No image assets.** Every texture — bark, render, asphalt, foliage — is grown from fractal noise
at load by `js/proctex.js`.

**A radio with the city's own stations.** From the [Radio
Browser](https://www.radio-browser.info/) community database, filtered to the country and sorted
by how close each transmitter is to where you are driving. It tunes itself when a city starts;
switching it off is remembered, and with it off nothing is asked of their servers at all.

**Ten languages**, taken from the browser's own preference list and overridable on the title
screen. `tests/i18n.mjs` fails the build if a locale is missing a key.

**It works with the map servers down.** Real Belgrade is bundled — 4,939 streets and a 15 km
arterial skeleton, built by `tools/buildcity.py` out of captured sessions in `tests/fixtures`.
The pause card says which city you asked for and why you are somewhere else.

**⤓ LOG** saves the raw Overpass replies plus everything that went wrong, which is how most of
the bugs in this repo were actually found.

## How it works

| | |
|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) turns "Ocean Drive, Miami Beach" into a lat/lon |
| Geometry | [Overpass API](https://overpass-api.de), `out geom qt;`. Split into streets / buildings / landmarks so the loading screen only waits for what it cannot start without |
| Projection | Local equirectangular: `x = (lon−lon₀)·111320·cos(lat₀)`. Metres are the world unit |
| Physics | Forward/lateral velocity split, per-car mass, OBB collisions off a 26 m bucket grid |
| Off-road | A drivable mask stamped along centrelines; off it the car crawls, unless GHOST |
| Streaming | 1.8 km tiles, geometry batched per 512 m cell, one cell built per frame |
| Cache | Every script is fetched with `?v=<hash>` over the contents of all of them, so a deploy is never invisible |
| Tests | 81 Playwright suites — `node tests/run.mjs`, about fifty minutes |

Everything is plain `<script>` files sharing one global scope, deliberately **not** ES modules:
modules are blocked over `file://`, and opening the game straight off disk is the point. Load
order is fixed in `index.html`.

```
index.html   markup      style.css    styling      data/belgrade.js  the offline city
js/i18n.js   ten languages            js/util.js   palette, theme
js/geo.js    network: Overpass, Nominatim         js/log.js    the session log
js/world.js  OSM parsing, indexes, streaming      js/terrain.js  the heightfield
js/entities.js  cars, traffic, police, physics    js/body3d.js   the car as a cuboid
js/game.js   state, shifts, missions, wanted      js/io.js     input, audio, canvas
js/render.js top-down view            js/render3d.js  chase view + the dispatcher
js/soft3d.js chase view without a GPU  js/gl.js    WebGL2 plumbing, ear clipping
js/carmesh.js  the car mesh           js/proctex.js  every texture, from fractals
js/radio.js  the dial                 js/main.js   the loop, menus, debug hooks
tools/       buildcity.py, logfixture.py, stamp.mjs, glb2car.py
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
