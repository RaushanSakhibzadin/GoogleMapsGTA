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

## Measured, on the default config

1.2 × 1.2 km centred on Palilula, 4 m voxels, 3 studs/m:

```
district     1,519 buildings, 690 road pieces, 42.5 km of centreline
voxels       190,248 cubes if built one Part each
meshed       33,699 boxes          5.6x reduction
collision    6,938 boxes           17.8 cells a box
output       3,600 x 3,600 studs, 3.9x precision headroom, 1.5 MB of Luau
```

The plan estimated 24,000 visual and 2,200 collision. Both were optimistic —
see the note on `CONFIG.kerbs` and `CONFIG.shades` for the two knobs that move
the first number, and be aware that Belgrade's streets do not run along the
lattice, which is most of why the second one is three times the estimate.

## Toolchain

Built and synced against **Rojo 7.7.0** (`brew install rojo`). The project file
uses the Rojo 7 format; a Rojo 6 CLI or Studio plugin will not talk to it, and
the CLI and the Studio plugin must be the same version — which is what
`rojo plugin install` guarantees and picking one out of the Creator Store does
not.
