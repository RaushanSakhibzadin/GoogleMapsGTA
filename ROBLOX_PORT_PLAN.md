# Porting VICE MAPS to Roblox — plan document

Status: M0–M2 built; M3 part-built — a 2.4 × 2.4 km streamed district with traffic,
pedestrians, trees, fires that burn, a loading screen, a round minimap over a
full-screen map, and a placeholder sound layer with a mixer.
The preprocessor is in `tools/roblox/` and the place in `roblox/`. §4.7 (infractions),
the remaining four roles and the radio are still a plan.
Source read at commit `af6e9a7`.

---

## 1. Source inventory

### 1.1 How it boots

There is no build step and no dependencies. `index.html` (636 lines) loads nineteen
classic `<script src>` files in a fixed order; they share **one global scope**. This is
deliberate and documented in every file header: ES modules are blocked over `file://`,
and opening `index.html` straight off disk is a stated requirement.

Load order (fixed, and load-bearing):

```
i18n → util → log → geo → world → turf → terrain → body3d → entities
     → io → game → gl → radio → proctex → carmesh → render → soft3d → render3d → main
```

`tools/stamp.mjs` rewrites every script/stylesheet URL with `?v=<hash>` over the contents
of all of them, so a deploy is never cache-invisible. `tests/stamp.mjs` fails the suite if
the stamp is stale.

The loop is in `js/main.js:10`: `requestAnimationFrame`, accumulator, fixed `1/60` steps,
capped at **5 catch-up steps per frame** (so below 12 fps the simulated world runs slower
than the wall clock — the tests work around this with a `__simT()` hook).

### 1.2 Lines of code, by area

| Area | Files | Lines |
|---|---|---|
| **3D rendering (WebGL2)** | `render3d.js` 3894, `gl.js` 436, `proctex.js` 411, `carmesh.js` 266 | **5,007** |
| **Game logic / state** | `game.js` 2923, `entities.js` 1126, `turf.js` 326, `body3d.js` 321, `terrain.js` 126 | **4,822** |
| **World / OSM** | `world.js` 2213, `geo.js` 847 | **3,060** |
| **Localisation** | `i18n.js` 2033 | **2,033** |
| **2D rendering** | `render.js` 1219 | **1,219** |
| **Input / audio / canvas** | `io.js` 925 | **925** |
| **Loop / menus / debug hooks** | `main.js` 947 | **947** |
| **Radio** | `radio.js` 560 | **560** |
| **Software 3D fallback** | `soft3d.js` 397 | **397** |
| **Misc** | `util.js` 270, `log.js` 211 | **481** |
| | **JS total** | **19,451** |
| Markup + styling | `index.html` 636, `style.css` 1165 | 1,801 |
| Tooling | `tools/` (Python + Node) | 987 |
| **Tests** | 100 Playwright suites | **23,901** |
| Test fixtures | captured Overpass sessions | 16 MB |
| Bundled city | `data/belgrade.js` | 5.9 MB |

### 1.3 The 3D layer

Three renderers behind one dispatcher in `render3d.js`:

1. **WebGL2, hand-written.** No library, no scene graph in the usual sense. There is a
   cell system (`CELL_CAP = 44` cells on the GPU, 512 m each) with per-cell meshes:
   `gnd`, `lit`, `sgn`, `tre`, `wood`. Shaders are string literals in the file —
   lit/ground/sky/depth/sign/tree/car/fx. Vertex layout for the lit pass is 14 floats
   (`aPos`3, `aNrm`3, `aCol`3, `aWall`4, `aTag`1). Shadow map up to 2048. Street-name
   signs go through a 256×64 atlas with 64 slots.
2. **Software 3D** (`soft3d.js`, 397 lines) for a browser with WebGL off.
3. **Canvas 2D top-down** (`render.js`, 1219 lines).

**No image assets anywhere.** Every texture is generated from fractal noise at load
(`proctex.js`). The car is a procedural mesh (`carmesh.js`) built from eight corners, which
is how the fire appliance and the ambulance become different vehicles from the same code.

Camera: `camera3D(dt)` in `render3d.js`, a chase camera on a circle around the car, angle
lerped toward `viewHeading(c)` (`game.js:940`), which flips 180° when the car is properly
reversing.

### 1.4 Vehicle physics and controls

`drive(c, throttle, brake, steerIn, hand, dt)` — `js/entities.js:576`, about 220 lines.
Everything drives through it: player, traffic and police share the function.

The model:

- Velocity decomposed into **forward / lateral** against the car's heading each step.
- First-order lags on throttle (`5.5` up / `8` down) and brake (`11` / `14`) — the comment
  says this is what stops the car feeling "dragged around".
- Constant engine force against linear drag with a **hard clamp**, not an asymptote.
  `TOP_SPEED = 100` m/s (360 km/h).
- Lateral grip term `decay(lat, dt)` where `lat` is `9.5` on road, `6.5` off, `1.7` with the
  handbrake, `0.3` mid-180. That one number is the whole drift model.
- Steering authority fades with speed (`lerp(1, .34, spd/30)`) unless the handbrake is held.
- Terrain grade adds/removes speed and raises the ceiling downhill by up to 20%.
- Off-road crawl: `STRAY_TOP = 4.5` m/s, `STRAY_DRAG = 9.5`, with a 10 m tolerance band —
  gated on `roadDataHere()` so ground that merely hasn't streamed in stays fast.
- `laneOffset(r)` puts AI cars a quarter of the road width to their own right, which is what
  makes two-way traffic appear without anything arranging it.

Collision: `buildingCollide(c)` tests **eight points** on the car body against a spatial hash
of building footprints (`W.buckets` at `W.bcell`), pushes out along the nearest edge normal,
and re-tests the resolved position — if that is also buried it reverts to `c.px, c.py`. Car-car
collision is OBB against a 26 m bucket grid (`TCELL = 26`).

**Coupling to the renderer is essentially zero.** Grep counts for renderer symbols
(`ctx`, `G3`, `GL`, `cam`, `VW/VH`, `$()`) in the logic files:

```
entities.js  1   (trafficR() sizes the spawn ring off the viewport)
world.js     0
terrain.js   0
body3d.js    1
turf.js      1
game.js      8   (HUD updates)
```

⚠️ **Flag — this is the best news in the repo.** The driving model is a pure function of
state and `dt`. It is portable as a specification with essentially no untangling.

### 1.5 The OpenStreetMap data

**Where it lives.** `data/belgrade.js`, 5.9 MB. It is a **JS file, not JSON** — a single
`window.OFFLINE_CITY = {...}` assignment, because `fetch()` is refused for `file://` URLs and
a `<script>` tag is not. Generated by `tools/buildcity.py` from captured sessions.

**Format.** Raw Overpass `out geom qt;` shape, preserved verbatim:

```js
{ type: "way", id: 9473985,
  tags: { highway: "secondary", name: "Краља Милана" },
  geometry: [ {lat: 44.803131, lon: 20.46635}, ... ] }
```

**Contents, measured:**

| Set | Elements | Vertices | Centreline | Extent |
|---|---|---|---|---|
| `streets` | 4,939 (4,912 ways + 27 place nodes) | 27,225 | 421 km | 6.44 × 6.27 km |
| `buildings` | 8,921 (6,947 with geometry) | 50,715 | — | 2.47 × 2.50 km |
| `skeleton` (arterials) | 6,578 | 38,405 | 765 km | 30.1 × 30.1 km |

Origin `44.810348, 20.476245` — Palilula, Belgrade. `skeletonRadius: 15000`.

**Tags carried:**

- streets — `highway` 4912, `name` 3062, `oneway` 2496, `layer` 104, `tunnel` 98, `ref` 55, `covered` 50
- buildings — `building` 6725, `building:levels` 4908, `name` 2311, `shop` 1218, `amenity` 858,
  `roof:shape` 120, `leisure` 73, `building:colour` 6, `height` **4**
- Total building footprint 4.0 km². Median footprint **211 m²**, p90 565 m².

**How the game consumes it.** `parseOSM(els)` (`world.js:345`) walks the element list once and
projects lat/lon to metres with a local equirectangular projection (`geo.js:12`):

```
x = (lon − lon₀) · 111320 · cos(lat₀)
y = −(lat − lat₀) · 110540
```

Metres are the world unit throughout. It emits `roads / buildings / parks / places / pois /
shops`, then builds:

- **Drivable mask** `W.grid` — 2 bits per cell, 8 m cells, stamped along centrelines, capped
  at ±36 km (`MASK_HALF`) because cost is the square of reach: 19.4 MB at 72 km span.
- **Building hash** `W.buckets` at `W.bcell` — what `buildingCollide` queries.
- Separate road indexes for view culling and for driving.

**Live streaming** (`geo.js`): 1.8 km tiles (`RADIUS = 900`), `LOOKAHEAD = 520` m,
`MAX_TILES = 20`, 2.5 s cooldown between tile requests. A rotating list of Overpass mirrors
with a health/parking model persisted to `localStorage` (`vmMirrorHealth`, 3-day TTL). Loading
waits 9 s for streets and 6 s for the arterial sweep, then starts in the bundled city and swaps
the real one in behind the wheel if it lands.

**Point-of-interest kinds** (`world.js:184`), which is what the shift system keys off:
`amenity=police | hospital | fire_station | taxi | casino`, `shop=car_repair`.

⚠️ **Flag — building heights are mostly invented.** Only **4 of 6,947** buildings carry a
`height` tag. 4,908 have `building:levels`, which becomes `levels × 3.2`. The remaining ~2,000
fall through to:

```js
h = clamp(5 + Math.sqrt(a) * 0.85, 6, 46) * rand(.8, 1.35);
```

`rand()` is unseeded, so **those heights differ on every page load**. Nothing in the current
game notices, but a baked voxel city must be stable — this has to become a seeded hash of the
OSM id before anything is preprocessed.

⚠️ **Flag — "the OSM data in this repo" is three different Belgrades.** A dense 2.5 km building
core, a 6.4 km street net with no buildings past 2.5 km, and a 30 km arterial web with neither.
A first-version slice has to come out of the 2.5 km core, or it has no buildings in it.

### 1.6 Game state

All of it is module-global mutable state in one scope. There is no state container.

```js
const P = { car, cash, score, wanted, cool, bustT, dead, deadT, spawn, recover, hitCd, horn };
let traffic = [], cops = [], peds = [], marks = [], parts = [], blasts = [];
const MISSION = { state, pick, drop, time, reward, done, fire, chase, fare, riding, rider };
```

`MISSION` is a **single object** — one mission at a time, for one player. There is no concept
of a second actor with their own objective.

**Shifts** (`JOBS`, `game.js:1123`) — five: `courier`, `taxi`, `police`, `fire`, `ambulance`.
Each carries emoji, colour, optional `livery`, optional `body {l, w, bh}`, optional `mass`,
optional `offroad`. `massFor()` derives mass from body volume^0.6 unless overridden. Clocking
on requires standing at the matching POI depot (`depotGate`).

**Wanted level** (`game.js:1984`) — `P.wanted` clamped 0–5, cops stocked at
`round(wanted × 1.6)`, 8 s of no line-of-sight drops a star, arrest when player and cop are
both under 3 m/s within 8 m for a timer. Damage runs through one funnel, `hurtPlayer(n, why)`,
with a tally (`DMG`) and regeneration after 7 s of no hits at 3.5/s up to a cap of 65.

**Pedestrians** — `makePed` walks them along verges offset `PAVE_GAP = 1.5` m from the kerb.
`knockPed` fires above `PED_FLY_MIN = 9` m/s, gravity `PED_G = 17`, and they lie down for
`PED_DOWN_SECS = 22` and then **get up**. No deaths, no gore, already.

**Persistence** — `localStorage` only, about twelve keys: `vm_cash`, `vm_perk`, `vm_ghost`,
`vm_ctrl`, `vm_revreal`, `vm_stickSeen`, `vm_glhelp`, radio on/volume, SFX volume, turf picks,
mirror health. Client-only and trivially forgeable. No accounts, no server.

### 1.7 Networking

**Confirmed: none.** Zero occurrences of `WebSocket`, `RTCPeerConnection`, `socket.io`,
`EventSource` or `BroadcastChannel` anywhere in `js/`. The only network traffic is `fetch` to
Overpass, Nominatim and the Radio Browser directory. There is no multiplayer scaffolding of any
kind to build on or work around.

### 1.8 The radio

560 lines. It queries the [Radio Browser](https://www.radio-browser.info/) community
directory across three mirrors, filters to **HTTPS only** (a page served over HTTPS silently
refuses `http://` streams as mixed content), sorts by transmitter distance from the player, and
points a single `<audio>` element at a stream URL. There is a dead-air watchdog, an iOS
gesture gate (`RADIO_SILENCE` data URI primes the element inside a real tap), and a
graceful-nothing path for every failure.

**There is no synthesis and no DSP.** It is URL selection plus an audio tag. Nothing in this
file ports; the replacement is a from-scratch build.

### 1.9 Surprises worth flagging

1. **Building heights are non-deterministic across loads** for ~2,000 buildings (§1.5).
2. **The physics is genuinely renderer-independent** (§1.4). Rare, and the strongest asset here.
3. **The test suite is larger than the game** — 23,901 lines of Playwright against 19,451 lines
   of source, with a documented discipline of A/B-ing every assertion against a build with the
   fix removed. None of that coverage transfers to Roblox and there is no equivalent harness.
4. **`turf.js` is a gambling mechanic.** Casinos from OSM, a coin flip for a tenth of your cash,
   territory painting. See §7 — this is a Roblox policy problem, not just a port problem.
5. **The GHOST perk is a client-side SHA-256 of a Patreon word** (`game.js:50–160`,
   20,000 rounds). The monetisation model does not transfer at all; Roblox has passes.
6. **Ten languages, 2,033 lines**, with real work in `osmName()` on picking a *script* the reader
   can read rather than translating street names. Roblox has its own localisation system; the
   translations are lifted as data, but every key changes when the UI is redesigned.
7. **Explicit IP references in shipped strings** — `menu.credit` in all ten languages, the
   `index.html` footer, the README, two CSS comments. Enumerated in §7.

---

## 2. Reuse assessment

Blunt version: **you were right — this is a rewrite, not a port.** But the split is not
uniform, and one part of it is more valuable than a naive read suggests.

| Area | Lines | Verdict | Notes |
|---|---:|---|---|
| **OSM preprocessing** (`parseOSM`, projection, `standingBuilding`, `buildingColours`, `osmName`, height derivation) | ~600 of `world.js` + `geo.js:12` | 🟢 **Port nearly verbatim** | It is already plain Node-compatible JS with no DOM. Lift it into the offline pipeline. Fix the unseeded `rand()` first. |
| **Vehicle physics** `drive()` | 220 | 🟡 **Rewrite as spec, reuse every constant** | Structure and tuning carry over exactly; the Luau is new. ~150 lines. This is where the game's feel lives — do not redesign it. |
| **Traffic AI / lane offset / bucket grid** | ~350 of `entities.js` | 🟡 **Rewrite as spec** | `laneOffset`, `GAP_STOP/GAP_SEE`, the 26 m bucket idea. Server-side in Luau. |
| **Drivable mask** (`W.grid`, 8 m 2-bit cells) | ~120 | 🟡 **Concept carries, bake it offline** | Becomes a baked road-surface bitmap, used for the off-road penalty and NPC pathing. |
| **Building collision** (`buildingCollide`, 8 body points) | ~90 | 🔴 **Throw away** | Roblox has a physics engine. Use simplified collision volumes (§4.4). |
| **Terrain** (`terrain.js`, value noise) | 126 | 🟡 **Optional** | Belgrade is genuinely hilly and this is cheap. But real elevation via Terrarium tiles in the offline step is now affordable — it is no longer a load-path dependency. |
| **WebGL2 renderer** | 3,894 | 🔴 **Throw away** | |
| **GL plumbing, procedural textures, car mesh** | 1,113 | 🔴 **Throw away** | Roblox owns rendering. |
| **Software 3D fallback** | 397 | 🔴 **Throw away** | |
| **Canvas 2D top-down** | 1,219 | 🔴 **Throw away** | A minimap is a Roblox `ViewportFrame` or a baked image. |
| **Game logic** (`game.js`: shifts, missions, wanted, damage) | 2,923 | 🔴 **Throw away, keep the design** | The mission model is single-player-single-mission (§1.6). The incident model (§4.6) is structurally different. Salvage: `JOBS` table, damage funnel idea, `depotGate` proximity rule. |
| **Turf / casino / spray** | 326 | 🔴 **Throw away** | Policy risk (§7). |
| **GHOST perk** | ~110 | 🔴 **Throw away** | |
| **Radio** | 560 | 🔴 **Throw away** | Replacement is unrelated (§6). |
| **Input / audio / canvas** | 925 | 🔴 **Throw away** | Roblox `ContextActionService` / `UserInputService`. |
| **UI** (`index.html` + `style.css`) | 1,801 | 🔴 **Throw away** | You said treat it as replaceable. Agreed — and required, see §7. |
| **i18n** | 2,033 | 🟡 **Data reusable, keys are not** | Roblox `LocalizationService` + a translation table. Re-key against the new UI. |
| **Tests** | 23,901 | 🔴 **No path** | See §7 risk R9. |
| **`tools/buildcity.py`, `stamp.mjs`** | 328 | 🔴 **Throw away** | Different deploy model entirely. |

**Rough totals:** ~700 lines port nearly as-is (all of it offline preprocessing), ~800 lines
port as a specification (all of it physics and AI tuning), and ~18,000 lines are discarded.
The 700 + 800 are disproportionately valuable — they are the parts that took the most iteration
and the comments in this repo say so.

---

## 3. Scale, precision, and district — decide this first

Everything downstream depends on this, so it goes before the architecture.

### 3.1 The constraint you cannot dodge

Roblox loses meaningful float precision past roughly **10,000 studs** from the origin —
visible jitter on parts and camera, and worse on physics assemblies. Belgrade at 1:1 with a
sane vehicle scale is nowhere near viable, and you already know that.

But the tension is sharper than "make it smaller":

**You cannot uniformly compress the city and keep vehicles at a sensible Roblox size.**
If you scale buildings, roads and distances by 0.35 and leave cars alone, a 15 m building ends
up shorter than a car is long. Compression that works — the trick real city games use — shortens
*distances between places* while keeping *building and vehicle proportions* intact. That is a
nonlinear operation on a road graph, not a scale factor, and it is a research project.

**So: do not compress. Pick a smaller district at a uniform scale.**

### 3.2 Recommended numbers

| Setting | Recommendation |
|---|---|
| **World scale** | **3 studs per real metre**, uniform, everything |
| **v1 district** | **1.2 × 1.2 km** of the dense core → **3,600 × 3,600 studs** |
| **Origin** | District centre at `(0,0,0)`; max radius ≈ 2,550 studs |
| **Precision headroom** | ~4× — comfortable, no floating origin, no jitter |
| **Vehicle** | 4.2 m car → **12.6 studs** long, 5.4 studs wide. Correct for Roblox. |
| **Buildings** | 15 m (5 storeys) → **45 studs**. Reads correctly against the car. |
| **Roads** | 12 m residential → **36 studs**, about three car widths. Right. |
| **Voxel** | **4 m cube → 12 studs.** See §5.3 for the 2 m alternative. |
| **Gravity** | **Leave at Roblox default (196.2).** Do not try to be physically correct. |

On gravity: 3 studs/m implies "correct" gravity of 29.4 studs/s², which is very floaty and
fights every built-in constraint tuning and anything that falls. This is an arcade driving game
with a custom vehicle controller; keep the default and tune the car's forces against it. The
source game's own physics is already arcade — 360 km/h top speed, `decay()`-based grip — so
there is nothing physical to preserve.

### 3.3 Which district

The bundled data is centred on **Palilula (44.810348, 20.476245)** and the building coverage
extends ~1.2 km in each direction from there.

**Built, and now at the data's edge: 2.4 × 2.4 km on that centre.** The ceiling is the data,
not Roblox. Building density holds flat out to a 1,200 m half-width and then collapses, because
every one of the 6,461 buildings in `data/belgrade.js` is inside it:

| half | district | buildings | per km² | studs across |
|---:|---|---:|---:|---:|
| 600 | 1.2 × 1.2 km | 1,614 | 1,121 | 3,600 |
| 900 | 1.8 × 1.8 km | 3,700 | 1,142 | 5,400 |
| **1200** | **2.4 × 2.4 km** | **6,440** | **1,118** | **7,200** |
| 1600 | 3.2 × 3.2 km | 6,461 | 631 | 9,600 |

Past 1,200 m the roads keep coming and the buildings do not, so a bigger slice buys arterials
across open ground. 7,200 studs across is a corner radius of 5,091 — still inside the 10,000
where float precision bites (§3.1), at 2× headroom rather than the 3.9× the small slice had.

A useful side effect: at 1.2 km the district held **two depots, both car repair**, so four of
M3's five roles had nowhere to sign on. At 2.4 km it holds ten, including **two police and a
fire station**. That was the stated blocker on M3 and the data had the answer in it.

Recognisability argument goes the other way: **Stari Grad** — Knez Mihailova, Republic Square,
Kalemegdan, the Sava/Danube confluence — is what people picture when they picture Belgrade, and
the waterfront edge gives the voxel city a natural boundary rather than a hard cut through a
residential block. That needs a new capture, which is a half-day using the existing
`⤓ LOG` → `tools/buildcity.py` path, not a new pipeline.

**Recommendation, still open: Stari Grad, with the river as one edge.** The boundary problem
is real — a square cut out of a continuous city has four raw edges that look broken, and a
river solves one and a half of them. Less urgent than it was: the 2.4 km slice reaches far
enough that the edges are a long drive away, and it has the depots M3 needs. Still the right
move for recognisability.

### 3.4 Streaming and floating origin — honest read

- **Floating origin: not needed, and do not build it.** It costs you every `CFrame` in world
  space becoming relative, breaks naive replication, and interacts badly with Roblox's own
  `StreamingEnabled`. At 3,600 studs you have 4× headroom. Revisit only if you go past ~8,000.
- **`StreamingEnabled`: yes, turn it on in M1.** This is Roblox's built-in per-player content
  streaming and it is close to free — set it on `Workspace`, set `StreamingTargetRadius` around
  1,200–1,500 studs, keep gameplay-critical instances in a persistent model. It is the single
  highest-value performance switch and it costs an afternoon, not a system.
- **Custom chunk streaming: v3 at the earliest.** Only if the district grows past ~2.5 km real
  (7,500 studs), and even then `StreamingEnabled` may still carry it.

**Complexity added by getting this right: about one week total, nearly all of it in the
preprocessor's chunking, not in runtime code.** That is the honest number, and it is only that
low because of the district-size decision above.

---

## 4. Target architecture

### 4.1 The server-authority question — a disagreement with the brief

You said "server-authoritative", and you should have it for **game state**. You should not have
it for **vehicle motion**, and it is worth being direct about why.

Roblox physics assigns **network ownership** of each unanchored assembly to a client; the owning
client simulates and replicates the result. Forcing `SetNetworkOwner(nil)` makes the server
simulate — and the driver then feels a full round trip of input latency on the steering, 60–120 ms
typical. For a driving game that is the difference between good and unshippable. There is no
Roblox equivalent of rollback netcode available to you.

**Recommended split:**

| Concern | Authority |
|---|---|
| Vehicle integration, steering, suspension | **Driver's client** (network ownership), validated server-side |
| Vehicle position sanity (speed cap, teleport delta, out-of-bounds, wall clip) | **Server**, continuous |
| Incident creation, slot claims, resolution | **Server**, exclusively |
| Money, Service Record, unlocks | **Server**, exclusively, DataStore-backed |
| Arrest / traffic stop resolution | **Server**, exclusively |
| Pedestrian NPCs, traffic NPCs | **Server**, network-owned by server (`SetNetworkOwner(nil)`) |
| Radio audio | **Client**, never replicated |
| Voxel visual geometry | **Client**, built locally from replicated data |

Validation, not simulation. The server holds the last known good position per player and rejects
deltas that exceed `topSpeed × dt × tolerance`, snapping the client back. That catches the
exploits that matter for a competitive taxi/courier mode (teleporting to the fare) without
costing input latency.

### 4.2 Module layout

```
ServerScriptService/
  Init.server.lua                    -- boot order, one place
  Services/
    IncidentService                  -- create, claim, tier, resolve  (§4.6)
    DispatchService                  -- what to spawn, where, how often
    RecordService                    -- Service Record, escalation ladder (§4.7)
    ProfileService                   -- DataStore session-locked profiles (§4.5)
    EconomyService                   -- payouts, fines; the only writer of money
    VehicleAuthority                 -- spawn, ownership, validation
    TrafficService                   -- NPC vehicles
    PedestrianService                -- NPC pedestrians, knockdown
    CityService                      -- loads baked city data, builds collision volumes
  Data/
    CityChunks/                      -- baked ModuleScripts, see §5

ReplicatedStorage/
  Shared/
    Config                           -- scale, budgets, tuning constants (one file)
    VehicleModel                     -- the ported drive() model, run on both sides
    IncidentTypes                    -- data-only definitions, tiers, slot shapes
    Remotes/                         -- RemoteEvents + RemoteFunctions, one folder
    Net                              -- thin typed wrapper: rate limits, validation helpers
  CityVisual/
    ChunkData/                       -- baked voxel geometry, client reads these
    VoxelBuilder                     -- turns chunk data into Parts

StarterPlayer/StarterPlayerScripts/
  ClientInit.client.lua
  Controllers/
    InputController                  -- ContextActionService, mobile touch, gamepad
    VehicleController                -- local prediction + the shared VehicleModel
    CameraController                 -- chase camera; port viewHeading() (game.js:940)
    CityRenderer                     -- builds voxel Parts from ChunkData, LOD, unload
    HUDController
    RadioController                  -- the Luau sequencer (§6)
```

`VehicleModel` lives in `ReplicatedStorage` and is run by **both** the client (for its own car)
and the server (for validation and for NPC traffic). One implementation, one set of constants.

### 4.3 Replication strategy

- **City geometry: not replicated at runtime.** It ships in the place file as ModuleScript data
  under `ReplicatedStorage.CityVisual.ChunkData` and the client builds Parts from it. Zero
  network cost, zero server instance cost for the visual layer.
- **Collision volumes: in `Workspace`, anchored, replicated normally** and covered by
  `StreamingEnabled`.
- **Incidents:** a single `IncidentsChanged` RemoteEvent carrying deltas, not full state.
  Incidents are small (a position, a kind, a slot table) — a full snapshot on join, deltas after.
- **Vehicles:** Roblox's own physics replication. Do not hand-roll it.
- **HUD state** (money, record, active incident): a per-player `RemoteEvent` on change, plus
  Attributes on the Player instance for anything a client may read freely.
- **Rate limits on every RemoteEvent the client can fire.** `Net` wraps this; a claim spam
  limiter is the one that actually matters (§4.6).

### 4.4 Collision geometry ≠ visual geometry

This is the most important single decision in the whole plan and it deserves its own heading.

- **Visual:** the voxel shell. Thousands of Parts. `Anchored = true`, `CanCollide = false`,
  `CanQuery = false`, `CanTouch = false`, `CastShadow = false` on all but the largest. Built by
  the **client**, from baked data. Never enters a physics broadphase. Can be LOD'd, thinned or
  dropped entirely on a weak device without changing gameplay at all.
- **Collision:** one anchored box per building footprint (a small set of boxes for L- and
  U-shaped footprints — the preprocessor decomposes them), plus the ground and the kerbs.
  Roughly **1,500–2,500 collision parts** for the v1 district. Created by the **server**.

This mirrors what the source game already does — `buildingCollide` tests against *footprint
polygons*, not against walls — so behaviour is preserved, not approximated.

### 4.5 DataStore and MemoryStore

**DataStore** (`ProfileService`, session-locked):

```
Profile v1 = {
  version, money, serviceRecord, incidentsResolved = {fire, medical, police, taxi, courier},
  unlocks = {}, stats = {}, lastSeen
}
```

- **Session locking is mandatory** — Roblox routinely runs the same user in two servers briefly
  during teleports, and unlocked profiles duplicate money. Use the standard lock-with-heartbeat
  pattern (acquire on join, refresh every 30 s, force-steal after 120 s of a stale lock).
- **Write cadence:** on join (read), every 60 s if dirty, on leave, and on `BindToClose`.
  **Never per-transaction.** Budget is `60 + 10×players` requests/min and a 6 s per-key write
  throttle; a per-fare write at 40 players will throttle and silently lose data.
- Money is written by `EconomyService` only. One writer.

**MemoryStore** — needed only if you want cross-server anything. With one shared city and a
50–70 player server cap, incidents live in server memory and need nothing. Use MemoryStore for:
- a global "incidents resolved today" counter (SortedMap), if you want it;
- a cross-server matchmaking hint, if you ever shard.
Do not put live incident state in it — the latency and quota do not suit a 30 s object.

### 4.6 Incidents

The core abstraction, and it is right — everything being an incident is what makes solo and
co-op the same code path.

```lua
Incident = {
  id            : string,          -- server-generated, never client-supplied
  kind          : IncidentKind,    -- data-driven, see IncidentTypes
  position      : Vector3,
  createdAt     : number,          -- os.clock()
  expiresAt     : number,
  state         : "open" | "engaged" | "resolving" | "resolved" | "expired",
  slots         : { [Role]: { min, max, claimedBy: {UserId} } },
  tier          : number,          -- chosen at engage-time from filled headcount
  competitive   : boolean,         -- taxi/courier: claim ≠ award
}
```

**Tiers, not NPC filler, for v1.** Each incident kind declares 1..N tiers. A structure fire with
one responder is a **bin fire on the forecourt** — one hose point, 40 s. With three it is a
**third-floor flat with a casualty** — fire suppresses, medical treats, police holds the cordon.
Same code path, same claim machinery, different scripted content. This is cheaper than NPC
filler (no pathing, no NPC AI) and it *reads better* — a solo player gets a job sized for one
person rather than a job with two robots standing in it. Add NPC filler in M5+ if you still want it.

**Race-safe claiming.** In Luau, a server script is single-threaded but yields at every
`task.wait` and every network boundary. The claim path must therefore be a **synchronous
critical section with no yields between check and write**:

```lua
-- IncidentService:TryClaim(player, incidentId, role) -> ok, reason
-- Contains NO task.wait, NO :InvokeClient, NO DataStore call.
-- Read state, validate, mutate, return. Replication is fired AFTER the mutation.
```

Anything that must yield (a DataStore write, a delayed spawn) is queued and run after the section
returns. Additionally:
- Claims are **idempotent by token** — a client retry with the same token is a no-op, not a
  double claim.
- Claims are **rate-limited** per player in `Net` (e.g. 4/s), so a spamming client cannot starve
  the section.
- A player may hold **one** slot at a time across all incidents; claiming a second releases the
  first, atomically, in the same section.

**Competitive incidents (taxi, courier).** Claim does not award. Both rivals are dispatched, both
see the pickup, **first to arrive within radius wins**, resolved on the server against server-held
positions. The loser gets a small consolation payout and an immediate fresh dispatch, so losing
a race costs seconds rather than a minute of dead time. This is the design that stops one fast
player claim-blocking the whole board.

**Degradation.** If a claimed slot goes stale (player leaves, or is >X m away for >Y s), the
server releases it and re-tiers the incident downward rather than failing it. An incident should
almost never fail because a person disconnected.

### 4.7 Infractions — the escalation mechanic

No stars, no "wanted", no Rockstar vocabulary anywhere. Two coupled numbers.

**1. Service Record** — persistent, per-player, 0–100, DataStore-backed. Deductions for reckless
driving; recovery for clean incident completions. It is a *career* number, visible in the HUD as
a small badge, and it gates things (which vehicles you can sign out, which incident tiers you get
dispatched to). It never causes a pursuit by itself.

**2. Dispatch Status** — session-only, the live escalation ladder:

| Status | Trigger | What happens |
|---|---|---|
| **CLEAR** | default | nothing |
| **FLAGGED** | one logged infraction | a note on the record. No pursuit. Decays in 60 s. |
| **ADVISORY** | sustained infractions | police-role players within ~500 studs get a passive marker |
| **ACTIVE CALLOUT** | threshold crossed | **a pursuit incident opens on the player**, with a police slot |
| **ALL UNITS** | evading an active callout | every police player notified; spike strips authorised |

The elegance is that the last two rungs are **just incidents**. A pursuit is an incident whose
subject is a player, with one police slot, using the same claim machinery, the same tiers (one
unit vs. three), and the same NPC-degradation path when no police player is online. No second
system.

**Infractions logged:** sustained speed over a per-road threshold, striking a pedestrian,
colliding with another player's vehicle at speed, driving on the pavement, abandoning a claimed
incident, obstructing an active incident.

**Resolution — "the stop":** a police player holds proximity (< ~30 studs) with both vehicles
under a low speed threshold for 4 s → **PULLED OVER**. Subject pays a fine from earnings (scaled
to their balance, zero if broke — keep the source game's kindness here), Service Record takes the
hit, police player is credited. If no police player is online, an NPC unit runs the degraded
version. The subject can also clear a callout by driving clean for a timer — **STOOD DOWN**.

No arrest animation, no jail, no vehicle destruction, no player death. Ever.

**Vocabulary to use:** SERVICE RECORD · DISPATCH · CLEAR / FLAGGED / ADVISORY / ACTIVE CALLOUT /
ALL UNITS · RESPONDING · ON SCENE · PULLED OVER · STOOD DOWN · UNIT 4.
**Vocabulary to never use:** wanted, stars, heat, busted, wasted, ★, "Vice", "most wanted",
neon-pink-on-cyan as a signature palette.

---

## 5. The OSM → voxel pipeline

The piece you were least sure about. Concretely:

### 5.1 What runs offline, what ships, what runs at runtime

| Stage | Where | Output |
|---|---|---|
| Parse OSM, project, derive heights | **Offline** (Node) | intermediate JSON |
| Voxelise footprints, greedy-mesh | **Offline** (Node) | chunk geometry |
| Decompose footprints to collision boxes | **Offline** (Node) | collision box list |
| Bake road surface mask | **Offline** (Node) | 8 m bitmap, base64 |
| Emit Luau ModuleScripts | **Offline** (Node → Rojo) | `.luau` data files |
| Sync into place | **Build** (Rojo) | `.rbxl` |
| Build collision Parts | **Runtime, server, on boot** | ~2,000 anchored parts |
| Build voxel Parts | **Runtime, client, per chunk** | ~20–40k non-colliding parts |

**Nothing fetches OSM at runtime.** The live Overpass streaming in `geo.js` does not port — Roblox
cannot make arbitrary outbound HTTP from the client and `HttpService` from the server is rate-limited
(500 req/min) and blocked for `roblox.com`. The baked city is the city.

### 5.2 The preprocessor, step by step

Written in **Node** (not Python) so it can `require()` the existing parsing code directly.

```
tools/roblox/
  1-extract.mjs     data/belgrade.js  →  district.json
  2-voxelise.mjs    district.json     →  voxels.json
  3-mesh.mjs        voxels.json       →  chunks.json      (greedy meshing)
  4-collide.mjs     district.json     →  collision.json   (footprint decomposition)
  5-emit.mjs        chunks + collision →  src/ReplicatedStorage/CityVisual/ChunkData/*.luau
```

**1 — extract.** Strip `window.OFFLINE_CITY=`, `JSON.parse`. Reuse `parseOSM`'s logic and the
projection constants from `geo.js:12` **unchanged** — this is the part that ports verbatim. Clip
to the district bbox. Apply the 3 studs/m scale. **Replace the unseeded `rand(.8, 1.35)` height
jitter with a hash of the OSM way id** so the bake is reproducible; without this, two runs of the
preprocessor produce two different cities and the diff is useless.

Output: roads (polylines with class + width + name), buildings (footprint polygon + height +
wall/roof colour), POIs, parks.

**2 — voxelise.** For each building footprint:
- Rasterise the polygon onto the voxel lattice (even-odd fill on a 4 m grid, in *world-aligned*
  cells so neighbouring buildings share a lattice and do not produce z-fighting seams).
- Extrude to `round(height / 4)` levels, minimum 1.
- Keep the **shell only** — a voxel is emitted if it is on the perimeter of its level, or on the
  top level (roof), or on the bottom. Interiors are empty; nobody will ever see them.
- Colour per voxel from `buildingColours()` (already in `world.js:70`), with a small hashed
  per-voxel variation so a wall is not one flat colour — this is what sells the Minecraft look
  and it costs nothing.

Roads become a separate voxel layer: one level of road-surface voxels along each centreline at
its `ROADW` width, plus kerb voxels one level up along the edges. Parks get a green surface layer.

**3 — greedy mesh.** The step that makes this affordable. Within a chunk, merge runs of
identical-colour, identical-orientation voxels into single rectangular Parts:
- sweep X, merge runs; then sweep Z, merge equal-length runs into rectangles; then sweep Y for
  vertical merges on walls.
- A flat 20 m wall face of uniform colour collapses from 25 voxels to **1 Part**.
- Expected reduction: **6–10×** on a city with large flat facades.

Emit per chunk (chunk = 128 m real = 384 studs), so the client can build and unload by chunk.

**4 — collision.** Independent of the voxels. For each footprint, produce 1–4 axis-aligned or
oriented boxes covering it (rectangle fit; split L/U shapes on their concave vertices). Height =
building height. This is the *only* geometry the physics engine sees.

**5 — emit.** Write Luau ModuleScripts returning flat numeric arrays — **not** tables of tables.
A table-per-part costs enormous memory at 30k parts; a flat `{x1,y1,z1,sx,sy,sz,colorIdx, ...}`
array with a colour palette table is an order of magnitude cheaper and parses far faster.
Colours go in a shared palette of ~64 entries. Encode to a base64 string if the array literals get
unwieldy — decode cost is trivial next to instantiation cost.

**Tooling:** [Rojo](https://rojo.space) for filesystem → place sync, so the generated `.luau` files
are just files in git and the whole pipeline is `npm run bake && rojo build`. This also means the
Roblox project can live in this same repo, or a sibling, with the preprocessor sharing `data/`.

### 5.3 Voxel size — the one real trade

At **4 m voxels**, the median 211 m² building footprint is about **13 voxels of area** — roughly
a 4×3 block. Small buildings collapse to a 2×2 stub. The city will read as chunky and abstract.
That may be exactly the art direction you want, and it is 4× cheaper.

At **2 m voxels**, the median footprint is ~53 voxels, buildings keep their outline, and street
frontage reads properly — at **4× the voxel count**, which greedy meshing partly absorbs (flat
walls merge either way) but not entirely.

**Recommendation: 4 m for the first bake, and make it a single constant.** Bake both, look at
them in Studio, decide with your eyes. The pipeline should not care.

### 5.4 Part budget — **measured, and the voxel premise abandoned**

The preprocessor is built (`tools/roblox/`) and both renderers have been stood up in
Studio. These are measurements. 1.2 × 1.2 km centred on Palilula, 3 studs/m:

| | parts | client build |
|---|---:|---:|
| Voxel, 4 m cubes | 40,637 | 0.37 s |
| Voxel, 2 m cubes | 88,231 | — |
| Voxel, hex R 2.5 m | 152,000 | — |
| Voxel, hex + windows | 252,817 | 4.96 s |
| Extruded footprints, as **MeshParts** | 3,038 | 1.56 s |

**And that last row stopped being true and stayed in this document for three commits,
which is worth writing down rather than quietly editing.** 3,038 is two MeshParts per
building, and the MeshParts were removed — EditableMesh was untestable from here and failed
twice on screen — in favour of boxes and wedges. A box-and-wedge building is one Part per wall
edge, two wedges per roof triangle and one band per window course. Nobody re-counted, the
bake's own log line still printed `buildings × 2`, and "about 8,000 parts" went out in a commit
message. The real figure at that size was about 65,000.

Counted properly, on the 2.4 × 2.4 km district now shipped:

| | parts |
|---|---:|
| walls (one box an edge) | 38,484 |
| roof (two wedges a triangle) | 52,936 |
| **glass bands** (one per banded edge per course) | **87,981** |
| streets | 16,510 |
| parks | 4,308 |
| trees | 16,372 |
| **total** | **216,591** |

Two things follow. **Windows are the most expensive thing in the city** — banding every edge
came to 130,538 Parts, more than the walls and roofs together and more than the voxel shell
this section abandoned as too dear. `CONFIG.winMaxEdges = 6` and `winMinLen = 6` band only a
building's longest few faces, which drops 42% of them and costs nothing you can see, because
you cannot see the back of a building or the two-metre jog where a terrace steps.

**And the whole district can no longer be built at once**, which is what §7.4 is about.

**The voxel premise turned out to be the expensive way to do this, and it was my
recommendation.** §5 originally argued for a voxel city partly because "the OSM
footprints can be extruded procedurally instead of hand-modeled" — but extruding them
*directly*, the way `js/render3d.js` already does, is both closer to the source game and
**83× cheaper**. A voxel lattice does not simplify OSM footprints; it re-samples them,
and re-sampling a polygon into cells costs orders of magnitude more geometry than
keeping the polygon.

What the flat path ships: each building extruded from its own OSM polygon, roofs cut by
the game's own `earClip()`, and the ground as **one flat part with the streets drawn on
it** rather than 89,000 ground prisms.

**Both paths are kept**, because the voxel look is a legitimate art direction — but only
the one in use is *baked*. The chunk files are 7.3 MB at a 1.2 km district and four times
that at 2.4, and committing that for a switched-off renderer stopped being defensible when
the district grew. `CONFIG.render = 'voxel'` plus a re-bake, rather than a reconnect.

**Consequence for R2 (part count / mobile).** Smaller, not solved — see the corrected
count above. What actually bounds it is §7.4: the city streams, so what is live is a
function of the load radius rather than of the district.

**Two Roblox-specific findings, both of which cost a debugging round:**

- **An `EditableMesh` is a live resource, not a description.** Creating one per building
  without destroying them exhausts the budget after a handful — the city drew one building and
  then silently stopped. Destroy each one as soon as its MeshPart exists.
- **Roblox ships no image or mesh without an uploaded asset**, so everything generated
  — the hex prism, the ground texture, the minimap — is built at runtime through
  `EditableMesh` / `EditableImage`. This works, and it keeps the project's "no image
  assets" property from the browser game intact.

---|---:|---:|---:|
| Raw cubes | 190,248 | 794,156 | ~260,000 |
| Building shells, meshed | 18,415 | — | ~18,000 ✅ |
| Ground, meshed | 15,284 | — | ~6,000 ❌ |
| **Visual boxes** | **33,699** | **73,354** | ~24,000 |
| Meshing reduction | 5.6× | **10.8×** | 6–10× |
| Collision boxes | 6,938 | 14,877 | ~2,200 ❌ |
| **Total parts** | 40,637 | **88,231** | ~26,200 |
| Client build time | **0.37s measured** | unmeasured | — |

**2 m is the choice.** At 4 m a typical wall is only 2–4 cubes across and the
city reads as plain slabs, not as voxels — the art direction disappears. And the
cost is much lower than the raw cube count implies, because **greedy meshing does
better at the finer lattice, not worse**: a wall two voxels wide has nothing to
merge, one four voxels wide does. 2.2× the parts, not 4×.

Where the first estimates went wrong, and it is worth keeping:

- **The flat ground is the expensive layer, not the buildings.** Shells landed
  almost exactly on estimate. The ground cost 15,284 parts at 4 m because the
  kerb ring snakes around every road and shatters the runs meshing depends on —
  **kerbs alone were 5,749 parts**, 17% of the budget, for decoration.
  `CONFIG.kerbs = false` remains the biggest single lever.
- **Collision is several times the estimate because Belgrade is not on a grid.**
  Angled footprints rasterise into staircases, which decompose into thin strips.
  Meshing the union of all buildings rather than one at a time recovered 7%.
  Inherent to an axis-aligned lattice over a city that was not built on one.
- **Per-voxel colour variation is not free.** The plan said it "costs nothing".
  It costs nearly everything — greedy meshing merges *identical* voxels, so a
  unique shade per voxel defeats the whole optimisation. `CONFIG.shades`
  quantises it; default 1 (off).

**Desktop is comfortable.** 33,699 parts built in 0.37s on a MacBook Pro, against
a frame budget written expecting seconds. **Mobile is still unmeasured and is the
open question** — that is what the phones are for.

---|---:|---:|---:|
| Building shells | 99,647 | 18,415 | ~18,000 ✅ |
| Ground (road, kerb, park, plain) | 90,601 | 15,284 | ~6,000 ❌ |
| **Visual total** | **190,248** | **33,699** | ~24,000 |
| Collision volumes | — | **6,938** | ~2,200 ❌ |
| | | **40,637 parts** | |

Two of the three estimates were wrong, and the reasons are worth keeping:

- **The ground layer is the surprise, not the buildings.** Building shells came in almost exactly
  as predicted. The flat ground cost 15,284 parts — because the kerb ring snakes around every
  road and shatters the plain/road runs into strips. **Kerbs alone cost 5,749 parts**, 17% of the
  whole budget, for something purely cosmetic. `CONFIG.kerbs = false` is a one-line change and
  the single biggest lever available.
- **Collision is 3× the estimate because Belgrade is not aligned to the lattice.** A footprint at
  30° to the grid rasterises into a staircase, and a staircase decomposes into thin strips.
  Meshing the union of all buildings rather than one at a time (so terraces share walls) only
  recovered 7% — 7,472 → 6,938. This is inherent to an axis-aligned voxel lattice over a city
  that was not built on one.
- **Per-voxel colour variation is not free.** The plan originally said it "costs nothing". It
  costs nearly everything: greedy meshing merges *identical* voxels, so a unique shade per voxel
  defeats the whole optimisation. `CONFIG.shades` quantises it to a few steps as a compromise;
  default is 1 (off) so the baseline number above is honest.

**40,637 parts is workable but is the project's main technical constraint.** Levers, in order of
value: turn off kerbs (−5,749), `StreamingEnabled` (already in the Rojo project), chunk LOD
beyond ~800 studs, and an 8 m voxel quality setting for weak devices.

**Still to measure, and only a device can answer it:** memory and chunk-build time on the actual
mobile floor. That is what M0 exists for.

### 5.5 The road graph — what the mask could not answer

Stage 4 bakes a drivable **mask**, one bit per 8 m cell. That answers "is there tarmac
under this point", which is the only question a car steered by a human ever asks — and
it is why `Tarmac`/`VehicleModel` need nothing else.

Anything steered by *nothing* asks the opposite question. `updateTraffic` walks a
polyline for a point ten metres further along it; `pedWalkPoint` offsets the same
polyline sideways to find the pavement. A mask cannot say which way a street runs, so
stage 7 ships the centrelines: 2,271 drivable ways, 10,425 points, and 14,616 junction
continuations — ~600 kB of Luau against a city of 216,591 Parts. The traffic reads it
wherever the traffic is, so it loads whole and stays loaded.

**It also ships junctions, which the browser has not got, and that turned out to be
the difference between traffic that flows and traffic that pinballs.** `updateTraffic`
has one answer for running out of road — turn round. On this data:

| | |
|---|---:|
| drivable ways | 688 |
| mean nodes per way | 4.1 |
| mean way length | 62 m |
| way ends touching another way | 92% |

OSM splits a street at every junction, so "turn round at the end of the way" is a
U-turn every five seconds, and a U-turn on an eight metre street goes through the
pavement and into the building behind it. Measured before the fix: traffic was inside
a real building footprint **12.8%** of the time, with a median lane-holding error of
0.76 m and a p90 of 7.9 m. With junctions: **1.0%** and 0.18 m.

`RoadNet.links` gives every way end its continuations — the way to join, the node, the
direction, and the unit heading there — and `Streets.turning` picks between them by
how nearly straight-on each is, with enough jitter that a junction does not send
everybody the same way.

**Trees are the second invented thing in this port** (the first is `js/terrain.js`'s
hills): the browser draws no vegetation at all. Where they go is real, though — park
polygons and road verges out of OSM, rejected at bake time against the actual building
polygons and carriageway widths, so nothing is checked at runtime and a tree cannot end
up inside a wall. 8,186 of them, two Parts each, chunked so they stream with the
buildings.

---

## 6. Radio

Correcting the brief, because it matters for scoping: **Luau cannot synthesise audio.** There is
no API to write PCM into a buffer and play it. "Procedurally generated music in Luau" on Roblox
means one thing:

> **A Luau sequencer driving a bank of original one-shot samples**, pitched with
> `Sound.PlaybackSpeed` and coloured with the built-in `SoundEffect` instances
> (`PitchShift`, `Equalizer`, `Reverb`, `Distortion`, `Tremolo`, `Chorus`, `Flange`,
> `Compressor`).

That is genuinely capable of good results — it is how tracker music works — but it needs uploaded
audio assets, and those need to be original and to clear moderation.

**v1 scope (keep it small, as you said):**
- **3 channels.** One slow/atmospheric, one mid-tempo four-on-the-floor, one sparse dub. Each is a
  Luau generator: a seeded PRNG picks a key and a chord progression from a small hand-written set,
  a bar clock schedules note one-shots and a drum pattern, and the effect chain differs per channel.
- **Sample bank:** ~15–20 one-shots total (kick, snare, hat, two bass notes, a pad, a pluck, a stab)
  — pitched at runtime, so you need notes not scales.
- **Idents:** 3–5 short original stings between "tracks". A synth sting is easier to clear than a
  voiceover.
- **Client-side only.** Never replicate audio. Seed each channel from
  `(stationId, floor(workspace:GetServerTimeNow() / barLength))` if you want two players in
  earshot to be roughly in sync; otherwise per-client and cheaper.
- Volume, station selection and mute persist in the player profile.

**Budget the moderation turnaround.** Uploaded audio is reviewed and rejection is opaque. Upload
the sample bank in M0, not M5, so it has cleared long before you need it.

---

## 7. Risk register

### 7.1 Technical

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Float precision past 10k studs** | High if ignored | District sized to 3,600 studs (§3.2) — 4× headroom. No floating origin. Revisit only past ~8,000. |
| R2 | **Part count / mobile memory** | Open, but bounded | Extruding footprints instead of voxelising was the big win; the follow-up claim that it left 3,038 parts was wrong by a factor of twenty (§5.4 — the number was a stale MeshPart count). The real district is 216,591 parts, of which ~42,000 are live at once now that the city streams (§7.4). Bounded by the streaming radius rather than by the district, so it no longer grows. **Still unmeasured on a phone**, and the phone is the number that decides it. |
| R3 | **Server-authoritative driving feels bad** | High | Do not do it. Client ownership + server validation (§4.1). This is a stated disagreement with the brief. |
| R4 | **Incident claim races** | Medium | Synchronous no-yield critical section, idempotent claim tokens, per-player rate limit, one slot per player (§4.6). |
| R5 | **DataStore throttling / duplicate profiles** | High | Session locking with heartbeat; 60 s dirty-write cadence + on-leave + `BindToClose`; single writer for money (§4.5). |
| R6 | **Non-deterministic bakes** | Medium | Replace unseeded `rand()` in height derivation with a hash of the OSM way id, before the first bake (§1.5, §5.2). |
| R7 | **Chunk build hitching on join** | Medium | Build voxel chunks over multiple frames with a budget per frame; nearest-first; hold the player at a spawn overlook until the first ring is up. |
| R8 | **Belgrade's real hills** | Low | v1 flat. Terrain is optional (§2) and adding it later only touches the preprocessor and the ground layer. |
| R18 | ~~**`StreamingEnabled` does not cover the client-built city**~~ | **Closed** | Streaming applies only to instances the *server* replicates; the city is built by a LocalScript, so Roblox never streams it. Chunk load/unload had to be our own code — and now is, at 1,500 studs to match `StreamingTargetRadius` so the buildings you see and the collision you hit arrive together. §7.4. |
| R9 | **No test coverage** | Medium | 24k lines of Playwright do not transfer and there is no equivalent. Partly addressed: `tools/roblox/verify-life.mjs` transliterates the traffic and pedestrian sims into Node and measures them against the emitted data, which found three real bugs; and `luau-compile` gives a syntax gate over every `.luau`. Still planned: TestEZ for pure Luau (VehicleModel, IncidentService, RecordService). Rendering and feel stay eyeballed. |
| R19 | **Traffic and pedestrians are client-side** | Medium, deliberate | Every player sees their own traffic, and nothing about them is authoritative. Accepted for now; §7.3 says what would flip it and what it would cost. |

### 7.2 Moderation and IP

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R10 | **Rockstar references in the source** | Must fix | Enumerated: `README.md:5,118,130`; `index.html:346` footer; `js/i18n.js` `menu.credit` × **10 languages** (lines 72, 293, 477, 661, 846, 1031, 1215, 1399, 1584, 1768); `style.css:642,735` comments; `js/render3d.js:332` comment; `js/game.js:2172` comment; repo name `GoogleMapsGTA`; `og.jpg`. None of it should reach the Roblox project. Start the Roblox project in a **new repo with a new name** rather than carrying this one over. |
| R11 | **The wanted-star system** | Must fix | Replaced wholesale by Service Record + Dispatch Status (§4.7). No stars, no "wanted", no shared vocabulary. |
| R12 | **`turf.js` — casino coin-flip gambling** | **Do not port** | Roblox restricts simulated gambling with in-experience currency. Betting a tenth of your money on a coin flip is squarely in that territory. Drop the whole mechanic; the territory-painting idea could return later as something earned rather than wagered. |
| R13 | **Pedestrian harm** | Low, watch it | Source already knocks down and gets up — no deaths, no gore (`PED_DOWN_SECS = 22`). Keep it that way: no blood, no ragdoll persistence, no kill counter, no scoring for hits (only penalties). |
| R14 | **Uploaded audio rejected** | Medium, deferred | Nothing is uploaded yet. `Shared/Audio` plays `rbxasset://` content — files shipped inside the Roblox client, needing no upload, id or moderation. It does **not** gate on whether a path loads: an earlier version probed each candidate through `ContentProvider:PreloadAsync` and checked `IsLoaded`, which is not a valid test for client-local content, and every one of the six slots reported itself silent. The check that replaced it is a **report**, not a gate — `warm()` plays each candidate once, silently, and prints what actually loaded. Uploading the real bank means putting ids at the front of those lists and changing nothing else. |
| R15 | **OpenStreetMap ODbL** | **Attribution done** | A city derived from OSM is a Derivative Database and attribution is mandatory and must be visible inside the experience. "Map data © OpenStreetMap contributors, ODbL" is on the loading screen (`ReplicatedFirst/Loading`) for the whole of every load — the one screen every player sees. Share-alike is arguable for a place file and is not triggered by this. Still to do: repeat it in the store description. |
| R16 | **Real street names / real places** | Low | Real Belgrade street names are facts and fine. Do not put real business names on shopfronts even though OSM has 2,311 of them — that is the one place this crosses from geography into naming private entities. |
| R17 | **Cyrillic rendering** | Low | Street name labels are Serbian Cyrillic. Verify font coverage on the Roblox fonts you pick, on mobile, early — a row of tofu boxes is a bad surprise in M3. |

### 7.3 Traffic and pedestrians on the client — a compromise, stated

`Shared/Traffic` and `Shared/Pedestrians` are pure simulations, and
`StarterPlayerScripts/Life.client` gives them parts. **The whole thing runs on
the client.** Two consequences, both real:

- Every player sees their **own** traffic. Two people driving down the same
  street do not see the same bus. In a city whose entire premise is that it is
  shared, that is wrong.
- Nothing about it is **authoritative**. Knocking somebody down is not scored,
  raises no infraction and is not reported, because a client saying "I ran
  somebody over" is a client saying anything it likes.

What it buys is the whole feature at no server cost and no replication —
about 110 moving models a frame that the server never sees, in a game whose
city is already built client-side for exactly the same reason.

**What would flip it** is §4.7: the moment a knockdown carries a penalty, the
pedestrian who was knocked down has to be the server's pedestrian. When that
happens the sims do not need rewriting — they are pure, they take the player's
car as an argument and they hand back what was culled — but three things do
have to be built: a server script that owns the `State`, replication of the
models (or of positions, and rebuild client-side), and a spawn policy that
scales with the number of players rather than with one player's cull radius.
The last is the awkward one: 78 cars around one player is nothing, and 78 cars
around each of twenty players spread across a district is not.

Until then it is decoration, and decoration is a reasonable thing to run where
it costs nothing.

### 7.4 The city streams itself

`StarterPlayerScripts/CityVisuals` loads the chunks near the player, nearest first, on a
6 ms-per-frame budget, and drops them once they are well behind. It exists because the whole
district stopped fitting:

| | parts |
|---|---:|
| whole district | 216,591 |
| live at 1,500 studs, dense middle | ~42,000 |
| live at 1,500 studs, district corner | ~30,000 |

**Flat in the size of the district rather than growing with it**, which is the property that
matters: a third district would cost load time and disk, not frame time. It is also *less* than
the ~65,000 the 1.2 km slice was building unstreamed, so the bigger city is cheaper to stand in
than the small one was.

Three details that are load-bearing:

- **1,500 studs matches `Workspace.StreamingTargetRadius`.** The collision boxes are
  server-built, so Roblox does stream those; matching the radii means what you can see and what
  you can hit appear at the same distance.
- **Dropping happens further out than loading** (1,900 vs 1,500). Without the gap a chunk on
  the boundary is built and destroyed and rebuilt every time the car drifts a stud.
- **A chunk is parented last**, after all its parts are made under a detached folder, so it
  appears complete rather than growing a wall at a time in front of you.

The ground stays one 7,200-stud slab and is never streamed — one Part, and it saves the horizon
from being a hole where the next chunk has not arrived.

**Not done:** no LOD. A chunk is either fully built or absent, so the far edge of the load
radius pops rather than fades. Distance fog or a coarse silhouette pass would hide it; neither
is written.

### 7.4a Sound, and the mixer that came with it

`Shared/Audio` is a placeholder layer over `rbxasset://` content — the files inside
the Roblox client, which need no upload and no moderation (R14). What is worth
recording is the shape rather than the paths:

- **Three SoundGroups, and "Master" is arithmetic.** A Sound in a group is scaled by
  that group's Volume, so three sliders reach every sound in the game — including
  ones already playing — with no bookkeeping. Master is a Luau multiplier over the
  three rather than a fourth group above them, because nesting them by
  `group.SoundGroup = master` is not a property that exists, and finding that out
  cost a round trip: it threw at module scope, which took Audio down and
  **VehicleController, DispatchUI, Life and SettingsUI with it**. The minimap and
  the city survived, so the game looked built and finished loading and left the
  camera parked a kilometre up — reported as "very long loading and i am in the
  sky".
- **The first balance was wrong in a way worth naming.** Reported as "for hits it is
  too loud and for engine it is too silent". Hits topped out at 0.9 and the engine
  at 0.62, so a scrape was the loudest thing in the game — but the engine's real
  problem was not its volume, it was `RollOffMinDistance`. A Sound on a part is 3D
  and fades past about ten studs; the chase camera sits nine metres behind the car,
  which is twenty-seven. **Your own engine was being faded out for being too far
  away from you.** The near field is now 90 studs, so the camera is always inside it.
- **Settings do not persist.** Roblox has no client-side storage, so it needs a
  DataStore write, and this place has no DataStore access (ProfileService says so on
  every boot). Four numbers into the profile when it does.

### 7.4c Two maps, one raster

The minimap answers "which way do I turn at this junction". The big map — tap
the minimap, or M — answers "where in Belgrade am I and what else is out there".
Different enough questions that they are drawn differently:

| | minimap | big map |
|---|---|---|
| orientation | **heading up** | **north up** |
| what it shows | ~200 m around the car | the whole 2.4 km district |
| how it is drawn | resamples a rotating window, 96², 20 Hz | the raster decoded **once** into a 1024² image |
| panning | follows the car | drag, + / − buttons and the wheel, 1×–6× |

Heading-up is right for the one you read a second at a time out of the corner of
your eye — left on the map is left through the windscreen. It is wrong for the
one you study, because a map that rotates has no memory and building one is
what a big map is for.

**One raster, one palette, one decode**, in `CityVisual/MapPaint`. Two copies is
how the world and the minimap ended up running opposite ground palettes, with
the same street reading as the light thing in one and the dark thing in the
other; a shared module is the fix for the class rather than the instance.

It **opens on the whole district**. The first version opened at 3× centred on the
car, on the reasoning that "where am I" is the first question — but the arrow
answers that at any zoom, and opening zoomed in means the first thing you do
every time is zoom out to see what you are looking at. Opening on the city with
a ME button is the better way round.

The sheet is built **on first open**, not at join — a million pixels is about a
second of work, most sessions never open it, and joining is already three waits
long (§7.5).

**A square cut out of a continuous city has no edge in it**, which is its own
usability problem: asked "is this full map?", the answer was yes — the whole
2.4 km, 1:1 with the raster — and there was nothing on screen to say so, because
the streets run to all four edges and simply stop. It has a district outline and
a scale bar now, and the hint line reports the span in **metres** rather than a
bare multiplier: "2.4 km across" is a fact about Belgrade, "1.0x" is a fact
about the widget. `tools/roblox/render-map.mjs` is what settled it — it decodes
the baked raster to a PNG, so that question is answerable without a screenshot.

Two things the first build got wrong that are worth keeping written down:
**`✕` (U+2715) is not in Roblox's Gotham set** and rendered as a missing-glyph
box on the close button and in the hint line naming it — UI text here stays
ASCII apart from the interpunct, which does render. And **all the chrome lives
inside the map window**: with `IgnoreGuiInset` the screen starts at y = 0, where
Roblox's own menu and chat buttons are, and a title anchored just above the
window landed underneath them.

### 7.4b One bad module must not take the car with it

Three separate rounds of this project have been spent on the same conversation
shape: a single unmistakable line in the Output window, invisible in a
screenshot, costing a round trip.

| reported as | actually |
|---|---|
| "the screen is empty" | `CityVisual.FlatData` indexed before it replicated, killing CityVisuals |
| "the car is invisible" | no `ReplicationFocus`, so the car never streamed in |
| "i am in the sky" | `SoundGroup.SoundGroup` is not a property; Audio threw at module scope and took four client scripts with it |

Two things came out of the third:

- **`ReplicatedFirst/ErrorBanner`** shows client errors on screen, above the
  loading screen, deduplicated and capped at four. Every one of the three above
  would have named itself instantly.
- **The scripts that must not die no longer hard-require the optional ones.**
  VehicleController, DispatchUI and Life take Audio through a `pcall` with a
  silent stub. Sound is optional; driving is not.

And the loading screen now parks the camera at street level as it hands over, so
a controller that never wakes leaves the player standing in the city rather than
looking down at it from orbit.

### 7.5a StreamingEnabled needs a replication focus, and had none

`Players.CharacterAutoLoads = false` — the design says the player is always in a
vehicle, and it is the cheapest simplification in the project (§4.1). But
`Workspace.StreamingEnabled` is also on, and **Roblox anchors streaming to the
player's character**. With no character and no `Player.ReplicationFocus` set, the
focus never leaves the world origin.

Reported as "when the loading finishes, the car is still invisible" — the car is a
server-made model, so it is streamed like anything else. The larger half of the bug
had not bitten yet: **every collision box more than 1,500 studs from the origin was
never replicated either**, so driving half a kilometre would have meant driving
through the buildings you can see. On a 1.2 km district that was most of the map
being within range by luck; on a 2.4 km one it is a quarter of it.

Two lines fix it, both in `VehicleServer`:

- `player.ReplicationFocus = model.PrimaryPart` — the server moves that part on
  every accepted position report, so the focus follows the player exactly as a
  character would have.
- `model.ModelStreamingMode = Persistent` on cars, so a car is never streamed out
  at all. For a handful of them that costs nothing and removes streaming as a
  variable from the one model that must always exist.

None of this touches the client-built scenery: Roblox does not stream what a
LocalScript makes, which is why §7.4 exists.

### 7.5 The join sequence, and why it needed a screen

Reported as "the car does not exist at the beginning". Correct, and it is three
waits rather than one:

| | who | roughly |
|---|---|---|
| ~57,000 collision boxes | server, on a frame budget | seconds |
| the first ring of city chunks | this client, ~42,000 parts | seconds |
| your car spawned and replicated | server, on `PlayerAdded` | immediate |

They finish out of order — the car is usually **first** — and until the city is up there
is nothing to look at either: `VehicleController` returns early with no model, so it
never takes the camera and Roblox leaves you looking at whatever the default found.

`ReplicatedFirst/Loading` covers it. In `ReplicatedFirst` because scripts there run
before the rest of ReplicatedStorage replicates — anywhere else and the loading screen
is itself one of the things being waited for. It orbits the district centre while the
chunks land, so the bar has the real thing happening behind it.

Two details that are not decoration:

- **It holds the car.** `workspace.Loading` is an attribute the controller reads; without
  it the car is driveable behind an opaque panel and you arrive somewhere other than
  where you spawned because you were leaning on W.
- **It cannot hang.** A 60-second ceiling lets the player in regardless, with a warning
  naming which of the three never arrived. A loading screen that can wait for ever is
  the worst failure this could have.

---

## 8. Milestones

Each independently playable, and the first one deliberately small.

### M0 — Bake and look at it *(no gameplay)*
Preprocessor stages 1–5. Rojo project. An empty place that builds the voxel district on load and
lets you fly around it in Studio. Audio sample bank uploaded (§6) so moderation runs in parallel.
**Done when:** you can look at voxel Belgrade and say yes or no to the art direction, and you have
a **real part count** to check R2 against.

### M1 — Drive it *(the small, real first milestone)*
One district. One vehicle. Client-owned physics running the ported `VehicleModel` with the source
game's constants. Chase camera with the reverse-flip behaviour (`game.js:940` — it is good, keep
it). Collision volumes. `StreamingEnabled`. Multiplayer presence: you see other players' cars.
No roles, no incidents, no money, no HUD beyond a speedometer.
**Done when:** two people can drive around a recognisable slice of Belgrade together and it feels
good. This is the whole point of making M1 small — if the driving is not fun here, nothing later
saves it.

### M2 — One incident, one role
`IncidentService` with race-safe claims and tiers. Structure fires only, 1–3 slots, three tiers.
Fire role, fire vehicle. `ProfileService` + money. Minimal HUD: dispatch card, money, objective marker.
**Done when:** a solo player and a group of three both get a fire that fits them, from the same code.

### M3 — The full roster *(part-built)*
Police, ambulance, taxi, courier. Three incident kinds (fire / medical / collision-response) plus
competitive dispatch for taxi and courier (§4.6). Depots to sign on at, keyed off OSM POIs the way
`JOBS`/`depotGate` already does. NPC traffic. Pedestrians with knockdown/get-up.

**Built:** NPC traffic (78 cars, every tenth a bus, lorry, appliance, patrol car or ambulance),
pedestrians with knockdown and get-up, and street trees — plus the road graph and junction
table those need, which the mask could not provide (§5.5). Traffic follows centrelines and
takes junctions; pedestrians hold the pavement. All of it client-side — see §7.3.

**Not built:** the four remaining roles, the other two incident kinds, competitive dispatch,
and depots for anything but repair — this district has two depots and both are car repair,
so signing on as a firefighter has nowhere to happen. That is a district problem, not a code
one, and it is the argument for a Stari Grad capture (§3.3).

**Done when:** all five roles are playable and co-op incidents actually need each other.

### M4 — Infractions
Service Record (persistent), Dispatch Status ladder, pursuit-as-incident, the stop, fines.
NPC police unit for the no-police-online case.
**Done when:** a reckless driver gets escalated, pursued and stopped by another player, and the
same thing works with nobody else online.

### M5 — Radio, polish, and district two
Three procedural channels + idents. UI pass. Second district or an extension of the first.
Quality settings. Optional: NPC slot filler, terrain elevation.

---

## 9. Open questions

1. **Which district?** I recommend **Stari Grad with the river as an edge** (§3.3), which needs a
   fresh Overpass capture — half a day using the existing `⤓ LOG` → `buildcity.py` path. The
   alternative is the Palilula core already in `data/belgrade.js`, which needs nothing but is less
   recognisable and has four raw cut edges. Which?
2. **Voxel size — 4 m or 2 m?** (§5.3) I'd bake both in M0 and decide by eye, unless you already
   have a strong picture.
3. **Device floor.** Does this have to run on low-end mobile? That sets the part budget more than
   any other decision, and it decides whether 2 m voxels are on the table at all.
4. **Monetisation.** Passes, dev products, or nothing? It changes the profile schema and whether
   vehicles are unlocks. Better decided before M2 than bolted on after.
5. **"One shared city" — how literal?** Roblox caps a server at ~50–70 players. Everyone in *one*
   world is not something Roblox can do. Is one server per ~50 players acceptable (each a complete
   Belgrade), or does the design depend on a single global population?
6. **Audio.** Are you commissioning original one-shots, making them yourself, or does v1 have to
   use Roblox's free audio library? (§6 assumes original; the free library is a valid v1 shortcut.)
7. **Does the live OSM pipeline have to survive?** The current game will build *any city on Earth*
   from a text box. On Roblox that is impossible at runtime — the city is baked. Is
   "Belgrade, and later some other baked cities" acceptable, or is type-any-place a requirement
   you'd want back later? It changes whether the preprocessor is a one-off script or a maintained tool.
8. **Repo.** New repo for the Roblox project, or a `roblox/` directory in this one? A sibling
   directory keeps the preprocessor next to `data/belgrade.js`, which is convenient — but this repo
   carries the IP references in R10 and its name is `GoogleMapsGTA`. I'd start clean and copy
   `data/belgrade.js` across.

---

## 10. Two things I'd push back on

Stated plainly, per your ask:

1. **"Server-authoritative"** — right for state, wrong for vehicle motion. Roblox gives you no way
   to do authoritative driving without giving the driver a full RTT of input lag. Take client
   ownership plus server validation (§4.1). Everything that can be exploited for *reward* stays
   on the server; only the integration step does not.

2. **"Belgrade at 1:1 is not viable"** — agreed, but the fix is *a smaller district at real scale*,
   not *a compressed city*. Uniform compression breaks the relationship between vehicles and
   buildings, and non-uniform compression (shorten distances, keep proportions) is a research
   project on a road graph. A 1.2 km slice at 3 studs/m is small, correct, and shippable (§3).

And one thing that is smaller than it looks: **`StreamingEnabled` almost certainly covers you**.
Custom chunk streaming and floating origin are both real systems with real costs, and at 3,600
studs you need neither. Do not build them pre-emptively.
