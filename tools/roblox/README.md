# The Roblox bake

Turns `data/belgrade.js` into a voxel city as Luau, for the port described in
`ROBLOX_PORT_PLAN.md`. Runs in Node, needs nothing installed, takes about a second.

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
| `2-voxelise.mjs` | rasterise onto the voxel lattice | → `build/voxels.json` |
| `3-mesh.mjs` | greedy-mesh cubes into boxes | → `build/chunks.json` |
| `4-collide.mjs` | collision volumes, road mask, depots | → `build/collision.json` |
| `5-emit.mjs` | Luau, laid out for Rojo | → `roblox/src/**.luau` |

Each stage runs on its own too, and they hand JSON to each other rather than
calling each other — so working on the mesher does not mean re-parsing the city
every time. `build/` is generated and gitignored; `roblox/src/` is committed, so
you can check out the repo and open it in Studio without running Node at all.

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

## Measured

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
