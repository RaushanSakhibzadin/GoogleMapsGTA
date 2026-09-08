# The Roblox bake

Turns `data/belgrade.js` into a city as Luau, for the port described in
`ROBLOX_PORT_PLAN.md`. Runs in Node, needs nothing installed, takes about twenty
seconds.

The district is **2.4 × 2.4 km centred on Palilula** — 6,002 buildings, 2,271
drivable ways, 8,186 trees. That is not a round number: it is exactly where the
bundled data stops. Building density is flat at ~1,120/km² out to a 1,200 m
half-width and collapses past it, because all 6,461 buildings in
`data/belgrade.js` are inside it. See `CONFIG.half`.

```
node tools/roblox/bake.mjs
```

Then, on a machine with Roblox Studio:

```
rojo serve roblox/default.project.json
```

## The stages

| | | in → out |
|---|---|---|
| `1-extract.mjs` | OSM to a clipped district, in metres | `data/belgrade.js` → `build/district.json` |
| `2-voxelise.mjs` | rasterise onto the voxel lattice *(voxel renderer only)* | → `build/voxels.json` |
| `3-mesh.mjs` | greedy-mesh cubes into boxes *(voxel renderer only)* | → `build/chunks.json` |
| `4-collide.mjs` | collision volumes, road mask, depots | → `build/collision.json` |
| `5-emit.mjs` | Luau, laid out for Rojo | → `roblox/src/**.luau` |
| `6-flat.mjs` | extruded footprints and the drawn streets | → `roblox/src/**/FlatData/*.luau` |
| `7-life.mjs` | the road graph, the solid mask, the trees | → `roblox/src/**/RoadNet.luau`, `SolidMask.luau`, `Trees.luau` |

Stages 2 and 3 **only run when `CONFIG.render` is `'voxel'`**. They used to run
either way so that switching renderer was one line of config and a reconnect;
the chunk files they feed are 7.3 MB at a 1.2 km district and four times that at
2.4, which is a lot of committed generated data for a renderer measured at 83×
the cost of the one in use. Switching to `'voxel'` is a re-bake now.

Each stage runs on its own too, and they hand JSON to each other rather than
calling each other — so working on the mesher does not mean re-parsing the city
every time. `build/` is generated and gitignored; `roblox/src/` is committed, so
you can check out the repo and open it in Studio without running Node at all.

## What it costs, counted rather than guessed

| | parts |
|---|---:|
| walls (one box an edge) | 38,484 |
| roof (two wedges a triangle) | 52,936 |
| glass bands (one per banded edge per course) | 87,981 |
| streets | 16,510 |
| parks | 4,308 |
| trees | 16,372 |
| **whole district** | **216,591** |
| **live at once, streamed** | **~42,000** |

**Windows are the most expensive thing in the city.** Banding every wall of
every building came to 130,538 Parts — more than the walls and roofs together.
`CONFIG.winMaxEdges` and `winMinLen` band only a building's longest few faces
and drop 42% of them, which costs nothing you can see: you cannot see the back
of a building, or the two-metre jog where a terrace steps.

**The city streams.** `StarterPlayerScripts/CityVisuals` loads chunks near the
player nearest-first on a frame budget and drops them behind, at 1,500 studs to
match `Workspace.StreamingTargetRadius` — so the buildings you can see and the
collision boxes you can hit arrive at the same distance. Roblox's own streaming
does **not** cover any of this: it streams what the *server* replicates, and the
whole city is built by a LocalScript.

Everything upstream of stage 5 is in **real metres, in the game's own world
coordinates**. Studs happen once, at the very end. Changing `CONFIG.studsPerM`
is a one-second re-emit rather than a re-bake.

## Two rules this pipeline is built around

**The bake is reproducible.** Two runs on the same input produce byte-identical
output. That is not free — the browser game derives about two thousand building
heights from an unseeded `Math.random()` (`world.js:402`), and `buildingColours`
takes the height as an input, so the randomness leaks into the roofs as well.
Both are re-derived from a hash of the OSM way id in stage 1. If you ever see a
bake produce a different hash twice in a row, something has reintroduced real
randomness and the diff of every later change is worthless until it is found.

**Collision geometry is not visual geometry.** The voxel shell is decoration:
tens of thousands of client-built Parts with `CanCollide` and `CanQuery` off,
which never enter a physics broadphase and can be thinned or dropped on a weak
device. What a car actually hits is `ServerScriptService/Data/Collision.luau` —
a few thousand anchored boxes built by the server. The two are fitted to the
same lattice on purpose, so what you can see is what you can hit.

## The road graph, and why a mask was not enough

Stage 4 bakes a drivable **mask** — one bit per 8 m cell, "is there tarmac
here" — and that is everything a car steered by a human needs. Nothing steered
by a human ever asks *which way the street runs*, so nothing in the mask records
it.

Traffic and pedestrians need exactly that. `updateTraffic` walks a polyline
looking for a point ten metres further along it; `pedWalkPoint` takes the same
polyline and offsets it sideways to find the pavement. So stage 7 ships the
centrelines themselves: 2,271 drivable ways, 10,425 points, and the junction
table below — about 600 kB of Luau against a city of 216,591 Parts. The traffic
reads it wherever the traffic is, so it loads whole and stays loaded; the
**trees** are chunked with the buildings, because 16,372 Parts is not something
to build all at once.

**It also ships the junctions, and that is the part the browser has not got.**
`updateTraffic` has one answer for running out of road: turn round and drive
back. On this data that is a U-turn every five seconds — OSM splits a street at
every junction, so the mean drivable way here is 62 m long and 92% of way ends
touch another way. A U-turn on an eight metre street goes through the pavement
and into the building behind it. `RoadNet.links` gives every way end its
continuations, and `Streets.turning` picks between them by how nearly
straight-on each one is.

## Verifying the parts that cannot be run

Nothing in this repository can execute a line of Luau, so every bug in
`Shared/Traffic` or `Shared/Pedestrians` otherwise costs a round trip through
somebody's screen in Studio.

```
node tools/roblox/verify-life.mjs        # or with a seed: ... 7
```

transliterates those two files, plus `Streets` and the `VehicleModel.step` they
run on, into Node and points them at the **actually emitted** `RoadNet.luau`,
`SolidMask.luau` and `RoadMask.luau`. Then it drives 78 cars and walks 34 people
for ninety seconds and measures where they end up. It is seeded, so a number
that moves means the code moved.

It is a transliteration and not the article, which is the honest caveat — the
two copies can drift, and a bug it passes may still be in the Luau. What it
cannot do is miss an algorithm that does not work. Three real bugs came out of
it and none of them out of reading:

| | before | after |
|---|---:|---:|
| traffic inside a real footprint | 12.8% | 0.3% |
| traffic lane-holding error, median | 0.76 m | 0.12 m |
| pedestrians that never move at all | 8 of 34 | 0 of 34 |

The syntax of every `.luau` in `roblox/src` can also be checked without Studio,
with the upstream Luau CLI (`brew install luau`):

```
find roblox/src -name '*.luau' -exec luau-compile --binary {} \; > /dev/null
```

`luau-analyze` is not much use here — it has no Roblox type definitions and
cannot resolve a `WaitForChild` require, so every line comes back unknown.

## Looking at the baked map

```
node tools/roblox/render-map.mjs      # -> build/district.png
```

The district ships as two bits a pixel inside `Shared/Minimap.luau` — a 350 kB
base64 string, completely unreadable. This decodes it with the same arithmetic
the game uses and writes a PNG, plus the class histogram and how far the road
network reaches.

It exists because of a question that could not otherwise be answered without a
screenshot and a round trip: *is the big map showing the whole city?* It was —
the render matched the screenshot pixel for pixel — and the reason it did not
look like it is that a square cut out of a continuous city has no boundary in
it. The streets run to all four edges and stop. So the map grew an outline and a
scale bar, which is the actual fix.

## Trees, which are invented

`js/render3d.js` draws no vegetation at all, so there is nothing to be faithful
to here and the trees are the second thing in the port that is not in the source
game (the first being the hills in `js/terrain.js`).

**Where they go is real, though.** OSM knows the parks, and it knows every
centreline and carriageway width, so a street tree goes on the verge — just
outside the kerb — rather than being scattered and hoped over. Both placements
are rejected at bake time against the real building polygons and the real road
widths, so nothing is checked at runtime and a tree cannot end up inside a wall.
8,186 of them on this district, two Parts each: a cylinder and an ellipsoid, no
mesh and no texture, chunked so they stream with the buildings.

## What the game's own code does here

`gamesrc.mjs` evaluates `js/util.js`, `js/geo.js` and `js/world.js` in a Node
`vm` and hands the bake the real `parseOSM`, the real projection, the real
`ROADW`, `buildingColours`, `standingBuilding` and `osmName`. None of it is
reimplemented. A second copy of the colour and naming rules in this directory
would drift from the browser within a month and the drift would be silent — the
city would just start looking slightly wrong.

The three files are concatenated into **one** script before evaluation, because
`const` at the top level of a vm script does not attach to the vm's global the
way `function` does. Loading them separately compiles fine and then hands you an
undefined `ROADW`.

## Two renderers

`CONFIG.render` picks one. Only the one in use is baked — see the stage table.
Measured on the 1.2 km district, which is what both were first stood up on:

| | parts | client build |
|---|---:|---:|
| `voxel`, hex 2.5 m, windows | 252,817 | 4.96 s |
| `flat`, as MeshParts | 3,038 | 1.56 s |

That 3,038 is a **stale number kept here as a warning**: it counts two MeshParts
per building, and the MeshParts were replaced by boxes and wedges three commits
later without anyone re-counting. A box-and-wedge building is one Part per wall
edge, two wedges per roof triangle and one band per window course — about
65,000 Parts at that district size, not 3,038. The table above the fold has the
real figures.

`flat` is what `js/render3d.js` draws: each building extruded from its own OSM
polygon, roofs cut by the game's own `earClip()`, and the ground as one surface
with the streets painted on it. `voxel` rasterises onto the lattice below and is
kept because the look is a legitimate choice — just an expensive one.

**An EditableMesh is a live resource, not a description.** Creating three
thousand without destroying them exhausts the budget after a handful, and the
symptom is one building drawn and then silence. `CityFlat` destroys each one as
soon as its MeshPart exists, and counts failures rather than reporting only
successes — the first version reported what it made, so 1,519 coming out as one
looked like a geometry bug.

## Measured (voxel path)

1.2 × 1.2 km centred on Palilula, 3 studs/m, both lattices:

```
                          4 m            2 m  (current)
district        1,519 buildings, 690 road pieces, 42.5 km
raw cubes           190,248        794,156
meshed               33,699         73,354
reduction              5.6x          10.8x
collision             6,938         14,877
TOTAL PARTS          40,637         88,231
client build   0.37s measured    unmeasured
output          3,600 x 3,600 studs, 3.9x precision headroom
```

**Greedy meshing does better at the finer lattice, not worse.** A wall two
voxels wide has nothing to merge; four voxels wide does. So 2 m costs 2.2× the
parts, not the 4× the raw cube count suggests. 2 m was chosen because at 4 m a
typical wall is 2–4 cubes across and the city reads as plain slabs rather than
as voxels.

The plan first estimated 24,000 visual and 2,200 collision at 4 m. Both were
optimistic: the flat ground layer costs far more than expected because the kerb
ring fragments it (`CONFIG.kerbs = false` is worth 5,749 parts at 4 m), and
collision is several times the estimate because Belgrade's streets do not run
along the lattice, so angled footprints rasterise into staircases.

## Four things that cost a whole afternoon in Studio

Written down because none of them is guessable and every one looked like
something else.

1. **The default Baseplate z-fights the ground.** It is 512 × 512 at
   `(0, -10, 0)`, so its top face is at y = 0 — exactly where this city's
   ground layer's top face is. The ground churns every frame while the
   buildings stay still. It looks exactly like a broken shadow map. All three
   builders delete it now.
2. **`Transparency = 1` does not stop a part casting a shadow.** `CastShadow`
   defaults to true, so the invisible collision boxes were throwing every
   shadow in the city while the visible shell threw none — and they are fitted
   to the lattice rather than to the shell's faces, so nothing lined up.
3. **Rojo writes `Color3` as 0–1 floats**, not the 0–255 triples used
   everywhere else in this project. `OutdoorAmbient: [110, 112, 118]` is about
   110× full white and blows the entire view out.
4. **Rojo never resets a property to its default.** Removing a bad value from
   the project file only stops it being written; the bad value stays in the
   place. State the correct value explicitly instead.

## Windows, textures, and what they cost

`CONFIG.windows` colours wall cells as glass on alternate courses, with a
shopfront at street level, a plain cornice on top, and a few lit at random. It
is the browser's window shader (`js/render3d.js`) reduced to the only thing a
voxel city can vary — which colour a cell is. `CONFIG.shades` is the equivalent
of `proctex.js`: a small quantised brightness step per cell.

**Both cost merge length, and on a hex lattice that is the whole budget.** A
column of one colour is one prism; a column that alternates wall/window is one
prism per level. Measured on this district:

| | hexR 2.5 | hexR 3.2 | hexR 3.6 |
|---|---:|---:|---:|
| windows off | **137,067** | — | — |
| windows, every 2nd course | **252,817** | 166,226 | 136,979 |
| windows, every 3rd course | 212,575 | — | — |

So windows are free if the hex grows from 2.5 m to 3.6 m, and cost 84% at 2.5.
Shipped at 2.5 with windows on, because that is the lattice that was chosen by
eye — the table is here so the trade can be re-made in one line.

## Toolchain

Built and synced against **Rojo 7.7.0** (`brew install rojo`). The project file
uses the Rojo 7 format; a Rojo 6 CLI or Studio plugin will not talk to it, and
the CLI and the Studio plugin must be the same version — which is what
`rojo plugin install` guarantees and picking one out of the Creator Store does
not.
