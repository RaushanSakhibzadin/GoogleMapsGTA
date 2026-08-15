# tests

Headless Playwright, driving the real game in a real browser through the
`window.__*` hooks at the bottom of `js/main.js`. There is no framework and no
runner: each file is a script that prints a JSON report and exits non-zero if it
failed.

```
npm install --prefix tests          # playwright
node tests/run.mjs                  # all of it, about 40 minutes
node tests/run.mjs --fast           # skipping the long ones
node tests/run.mjs real ring        # just those
node tests/real.mjs emptyMirror     # a scenario, straight to the report
```

`tests/harness.mjs` finds Chromium — under `PLAYWRIGHT_BROWSERS_PATH` (default
`/opt/pw-browsers`), or `CHROMIUM`, or Playwright's own download — and resolves
which build is under test. `GAME` points a run at a different `index.html`,
which is how a fix gets checked against the version that lacks it: **a test that
passes on broken code proves nothing**, and every assertion here has been run
against a build with the fix taken out.

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

`district.mjs` is the regression test for a report of **no roads**: a screenshot from
Репиште, a residential district of Belgrade, with buildings drawn all around a
stopped car and not one street between them. It drives out to a district the
opening ring never covered and checks it arrives with streets in it — and that
they are streets you can drive, not lines on the ground. Against a build with the
fix taken out it reproduces the screenshot exactly: 14 km/h with the throttle
down, 100% of frames off-road, and the streets request for that tile never sent.
With it, 352 km/h and 0%.

`android.mjs` is the one that needed a trick to be possible at all. Reported as
thumb pads chopped off along the bottom edge in Chrome on Android — and the
layout was fine, the layout was just the wrong size. `position:fixed` pins to the
LAYOUT viewport, which Chrome for Android reports as the tall one, the height the
page would have if the URL bar were hidden, whether it is hidden or not. On a
Pixel the accelerator's bottom edge lands at 825 in an 851 layout and the phone
can show 751 of it.

Headless Chromium has no URL bar, so asking for a smaller window does not
reproduce it — that just makes a smaller viewport where everything fits. The
condition is made the way the phone makes it: `visualViewport` is overridden
before the page loads to report a height 100 px shorter than `innerHeight`, and
then every element is measured against what is really on screen. Against the
build that was live it reports eleven separate things off the bottom, including
all five pads and every full-screen layer.

`firstload.mjs` is a stopwatch, and it is the test three rounds of "fix the map
load" went without. Every other mock in this suite answers instantly, so the
whole suite ran green through a session that was still on the loading screen at
forty-nine seconds. This one serves the captured session's own latencies —
streets back in 1.4 s, buildings in 3.6, the landmark sweep in 4.7, the skeleton
at what 8.7 MB costs on the 1.6 MB/s that log measured — and times the gap
between pressing DRIVE and holding the wheel. It also checks the other half,
which is the part that makes it a test rather than a stopwatch: everything the
loading screen stopped waiting for has to turn up afterwards, or "faster" just
means "less". Measured 19.9 s before the deferral and 7.7 s after.

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

## The rest of it

Two of these had **no exit code at all** until this round — `cfg.mjs` and
`loading.mjs` printed their findings and exited 0 whatever they said. That is not
a small thing: `loading.mjs` carried a scenario asserting, in as many words, that
no streets request may fire once the loading screen is down, which is the "no
roads" bug written up as an expectation, and `cfg.mjs` reported its own
`arterialsLean` flag as false for a release and a half. Both now fail. A test that
cannot fail is a log.

Thirty-odd more, serving fixtures written by hand rather than recorded: the
loading ladder through every way it can fail, the drivable mask, the drift, the
HUD at five viewports, tile streaming and recycling over a long drive, the
collision mask, memory, the menu at small sizes, the audio graph. They lived
outside the repository for a while and that cost real work — four separate
fixes to them were lost to a container being recycled, and each one came back
as a mystery failure a day later. They are here now.

Two files are helpers rather than tests, imported by the others: `fake.mjs`
builds a synthetic city, and `wide.mjs` a wide one.
