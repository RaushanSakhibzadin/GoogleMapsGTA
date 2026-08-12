# tests

Headless Playwright, driving the real game in a real browser through the
`window.__*` hooks at the bottom of `js/main.js`. There is no framework and no
runner: each file is a script that prints a JSON report and exits non-zero if it
failed.

```
npm install --prefix tests          # playwright
node tests/real.mjs                 # the replay, on real Belgrade map data
node tests/real.mjs emptyMirror     # with a mirror that answers 200 and nothing
node tests/mapfill.mjs              # the big map, at four shapes of screen
node tests/ring.mjs                 # the opening ring of street tiles
node tests/ring.mjs heavy           # ...and an area whose streets really are slow
node tests/daynight.mjs             # the two themes: star colour, and rush hour
node tests/traffic.mjs              # traffic that drives instead of detonating
```

Chromium is found automatically under `PLAYWRIGHT_BROWSERS_PATH` (default
`/opt/pw-browsers`), or from `CHROMIUM`, or Playwright's own download. `GAME`
points a run at a different `index.html`, which is how a test gets checked
against a deliberately broken build — **a test that passes on broken code
proves nothing**, and every assertion here has been run against a build with
the fix taken out.

## What is here

`real.mjs` replays `fixtures/stari-grad` — what the map servers actually sent
during one session in the old town of Belgrade, byte for byte, SHA-256 verified
before the run. It checks the things that only real data can check:

- the drivable mask agrees with every road that gets **drawn**, over 13,000
  sampled points of real geometry — the check that caught cars crawling on
  Belgrade's pedestrian squares
- 316 km/h down a real residential street with **0%** of frames off-road
- the 72 km arterial skeleton parses and bounds the world
- an empty reply from any mirror, for any kind of query, is handed to the next
  one instead of being believed

`mapfill.mjs` opens the city map on the same data and measures two things that
look identical on screen and have nothing to do with each other: how much of the
viewport the **world rectangle** covers at maximum zoom-out, and how much of the
canvas has anything but ground colour painted on it, sampled row by row and
column by column. The first is the zoom clamp's business and the second is the
map data's, and a report of "the map is half empty" can be either.

`ring.mjs` replays the timing of a reported session — a mirror answering
nothing, one unreachable, streets back in 5.5 s and a skeleton behind them — and
checks that all eight neighbouring tiles arrive, with their buildings — scenery
is side-fetched per tile once that tile's streets land, so it goes wherever the
ring goes, including nowhere. Its `heavy` mode checks the
opposite: an area whose streets really are slow still gets the ring trimmed,
because that rule is not the bug.

`daynight.mjs` covers the two things the themes are supposed to get right, both
of which had been reported after being "fixed" once already: the wanted stars
being the same yellow as the objective arrow — checked against the one constant
the canvas draws with, not against a number typed into the test — and daylight
carrying ten times the traffic, in both directions, since a cap that fills is
only half of it. It also holds that the cars you cannot see are free: daylight
has ten times the traffic and has to cost the same per frame to draw as dusk,
while putting more of them on the screen.

`traffic.mjs` drives daylight's rush hour for half a minute and watches: how
many cars wreck, how close any two ever get, whether they are still moving or
just queued, that nothing is simulated outside the ring, and — by wrapping the
sound functions and setting off explosions at known distances — that what you
cannot see you cannot hear.

`fixtures/autokomanda` is the second recording, from 12 August: four street
tiles and seven of scenery, which is where the bundled offline city's detail
comes from. Its own 200 km arterials reply was 44 MB and the log's 25 MB cap
dropped it, so the skeleton still comes from `stari-grad` — the two centres are
1.14 km apart and that box reaches 35 km around the newer one.

The rest of the suite lives outside the repository and serves fixtures written
by hand. This one is here because the fixture is irreplaceable: it is a
recording, and nobody can write another one from a machine that cannot reach
Overpass.
