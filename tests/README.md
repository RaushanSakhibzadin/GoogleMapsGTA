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

The rest of the suite lives outside the repository and serves fixtures written
by hand. This one is here because the fixture is irreplaceable: it is a
recording, and nobody can write another one from a machine that cannot reach
Overpass.
