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

`seo.mjs` reads the file rather than the rendered page, because the file is what
a crawler is handed — a test that booted the page and read `document.head` would
pass just as happily if every tag were injected at runtime, which is the one
thing that does not work. It checks the description length, an absolute
canonical, the whole Open Graph and Twitter set, that `og:image` names a file
that exists and is *genuinely* 1200x630 with the width and height tags agreeing
with the pixels, that the JSON-LD parses and carries no fabricated rating, and
that the eight city names are in the served HTML. It also clicks a preset chip,
because markup a crawler likes is worth nothing if the buttons stopped working.

Two things it got wrong first, both worth keeping in mind for any test that takes
a `GAME=` build: it read the repo's own `index.html` regardless of `GAME`, so the
A/B against the shipped build graded the new file twice and reported a pass; and
with no `og:image` tag the path resolved to the build *directory*, which exists,
so it crashed on EISDIR instead of reporting the thirty things it had found.
Against the shipped build it now reports all thirty.

`retry.mjs` covers the four things that can be missing after a load and are
asked for again from behind the wheel: the city itself, the wide map, the
landmarks, the buildings. Each is refused during the load and answered
afterwards, and the assertion is on the scheduler's own log rather than on the
world alone — because twice while writing it the world recovered by a completely
different route and the test would happily have called that a pass. First the
landmark sweep and the opening buildings simply succeeded on a later mirror,
since `overpassArea` retries its own hosts with backoff. Then, once the refusal
was held until those had gone quiet, the scenery queue turned out to be serial: a
refused buildings request holds it for the eighty seconds of its own budget while
making no requests at all, so twelve seconds of silence still had eight more
lined up behind it. The refusal now lifts only when nothing is queued, in flight
or preloading, at which point anything that arrives can only have come from the
scheduler. It also reads the delay schedule off the running game and asserts it
is minutes and bounded, since "try again" without either is how a game gets a
mirror to block it.

`mirrors.mjs` replays a reported iPhone session: twelve seconds in, still on the
loading screen. Of six Overpass mirrors, one had served an empty database, one
was unreachable and had been retried twice more, one had returned 504 twice, two
were sitting silent holding their slots — and **the sixth had never been asked**.
None of that is a rare alignment; it is six volunteer-run public servers on an
ordinary evening.

The fault was that mirror `i` started at `i × 2.2 s` and never deviated, so a
host that said no in 400 ms left its slot idle for another 1.8 and the queue took
eleven seconds to reach the end whatever happened along the way. Against the
build without the fix this test reproduces the log exactly — the first-asked
times come out 112 ms, 2311, 4511, 6711, **11111**, which is the grid, and the
good mirror is not contacted until 11.1 s:

|                                    | before  | after      |
|------------------------------------|---------|------------|
| time to play                       | 11.4 s  | **4.2 s**  |
| good mirror first asked            | 11.1 s  | **3.9 s**  |
| retries to an unreachable host     | 3       | **1**      |
| remembers a working mirror         | no      | **yes**    |

Two things it had to get right to mean anything. The roles are keyed by **host**,
not by position, because the mirror list is shuffled per session — the order is
read out of the running page and the good mirror is assigned to whichever host
ended up last, which is the worst case and the one that happened. And a retry is
counted per **question**, not per host: a load sends the streets, the skeleton,
eight ring tiles, the scenery and the landmarks, each racing the mirrors
independently, so counting a host's requests across the whole load counts
separate questions and calls them retries. The first version did exactly that and
reported three retries where there were none.

A **second** reported session added the rule about which kind of no costs what.
A host answered *nothing*, in about 300 ms, to every query it was given across
ninety-nine seconds — four skeleton rungs, the landmark sweep and two street
tiles — and it was asked **first every single time**. The demotion logic was not
broken; it could not tell the two kinds of refusal apart. One empty reply cost
one miss, and every other host was picking up a miss of its own in the same round
for being slow or unreachable under the heavy opening requests, so nobody ever
fell behind anybody. An empty 200 is not a moment like a 504 is — it is a fact
about that host's database, and it will be just as true in ten seconds — so it
now costs three.

Getting that into a test that could fail took two wrong turns, both instructive:

- **calling `mirrorNote()` directly**, with a cost of its own choosing, passed
  against a build with the fix removed. All it proved was that addition works.
  What is under test is which *call site* pays which cost, and only a real empty
  reply exercises that.
- **reading the miss counts** out of the finished session passed too, and for a
  better reason: they come out identical at three either way. Three misses of
  one, against one miss of three. The count is the mechanism, not the effect.

The effect is the number of **requests**. A host that sinks on its first refusal
is asked once; a host that sinks by one while the field sinks with it stays level
and is asked again, and again — three times in this scenario, and for
ninety-nine seconds in the log.

|                                       | before | after   |
|---------------------------------------|--------|---------|
| times a host with nothing is asked     | 3      | **1**   |

`radar.mjs` failed about one run in eighteen, always on the garage rim pointer,
which measured anywhere between 4 and 157 pixels of green depending on where that
run's random delivery happened to land. Four is the tip of a green triangle
poking out from under a pink one: the two rim pointers are drawn one after the
other and the objective goes last, so whenever the bearings agreed the garage
pointer vanished. That is not a rare coincidence — on a grid, the job is very
often up the road you would take to get repaired anyway.

So it was a product bug wearing a flaky test as a disguise, and both are fixed:
pointers now remember their bearings and push each other apart along the rim, and
the test has a deterministic case that parks the car where nothing is in blip
range and puts the objective on exactly the garage's bearing. Against the build
without the separation it reads zero green.

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

`daynight.mjs` measures the frame rate, the render cost and the cars on screen
*during* the drive, and all three had to move there. Read afterwards they were
wrong in two different directions: `PERF.ren` is a rolling average over about ten
frames, so a single reading at 1.5 ms is mostly noise — an unchanged build
returned anywhere between 1.29 and 2.00 for daylight, a 55% spread against a
1.6x threshold — and the count of cars on screen, taken once the car had been
sitting still, found the traffic had driven off and reported zero for both
themes, which passes the render check by having nothing left to draw. Medians
over the drive itself now: the ratio sits at 0.85-0.99 across runs, and daylight
puts 12-15 cars on screen against dusk's none. `settleMs` was also being read at
the end of the function, so it had always included the driving and the sampling
rather than the settling.

`mode3d.mjs` is a renderer test, which means it is mostly a test about how not to
write one — a renderer test written against a working build passes just as
happily on a black screen. Pixels come out of the WebGL back buffer through
`__px3`, which renders and reads inside one task, and three of its four
measurements had to be thrown away and rebuilt before they measured anything:

- **counting sky** to prove buildings occlude does not work, because fog fades
  distant ground to *exactly* the clear colour. It read 24% of the frame either
  way. The top fifth of the frame does work — the camera looks a few degrees
  below level, so nothing is up there unless it is standing in front of the sky
  and surviving the depth test. About 79% solid with the buildings, 5% without.
- **shadows, A against B**, one uniform apart via `__noShadow`, measured 1.2% of
  the frame getting *brighter* when shadows were switched on — which is
  impossible, and was entirely cars driving between the two readings. Three
  renders now, the shadowed pair bracketing the unshadowed one, and anything that
  differs between them is thrown out.
- **the sun disc** genuinely was not on screen: the light sat at 34° and the
  camera looked 18° down, so it was permanently above the top edge. That is a
  real finding from a test, not a broken test — the camera and the light are both
  lower now, and facing the sun lifts the top band from 198 to 255.
- **frame rate** on this box measures SwiftShader, not the renderer. The gate is
  the CPU cost of building and issuing a frame, which is ours; fps is recorded and
  checked only for a pulse.

Two of those four measurements had to be rebuilt again when the view stopped
being flat colour, and both for the same underlying reason — the scene acquired
detail:

- **counting "pixels that are not the sky colour"** stopped working the moment
  the sky stopped being a colour. Against a gradient with the sun's glow in it,
  almost no pixel matches any single reference value, and the band read 73%
  sky-free with every building deleted. It counts vertical luma edges now: a
  gradient is smooth in both directions, glow or no glow, and a skyline is
  nothing but hard steps. 2.2% of the band with the buildings, 0.15% without.
- **the shadow A/B's noise filter** rejected pixels that differed between two
  bracketing frames, which was enough while walls were flat. With windows on
  them, half a metre of camera drift swings a wall pixel between glass and
  plaster, and a pixel that landed on plaster in both bracketing frames while the
  middle one caught glass sailed through as a shadow several shades deep. It
  measured 4.7% of the frame getting *brighter* with shadows switched on. The
  world is frozen for the three grabs now — `state = 'pause'` stops `update()`
  and stops the loop rendering, while `__px3` still renders on demand — and the
  moved count is exactly zero.

`facade.mjs` covers the three things that make the chase view look like a street
rather than a diagram: the graded sky, the windows, and the wheels. All three are
pure appearance, which is why they need a test at all — nothing else in this
directory would notice a shader that quietly stopped drawing windows.

Each is an A/B inside one build, through `__noWindows` and `__noWheels`, and each
was checked against a build with the feature deleted outright. Two of them needed
a second measurement before they meant anything:

- **windows: how much of the frame changes** proves they are drawn, and a shader
  that tinted every wall one shade darker would score exactly as well. So the
  vertical edges are counted too, and counted *only* where the two frames differ
  — the facade and nothing else. Counting the whole frame buries the signal under
  roads, kerbs, lane markings and rooflines, and turned a ratio of twenty into a
  ratio of one point four.
- **wheels: the average brightness of what changed** was expected to fall,
  because paint is brighter than tyre. It rose — lifting the body off the tarmac
  also exposes the *road* under the sill, and in daylight this city's road is
  paler than most of its cars. It counts near-black pixels instead: a tyre is
  (0.06, 0.06, 0.07) before lighting and, with the sun's shadows off, nothing
  else in a daylit frame is close. Without wheels that count has been exactly
  zero every run.

It also found the flake worth having. The test parks in front of the tallest
building nearby, and thirty metres off a tower block is not a car park — some
runs put the car inside another footprint or on top of a taxi and it was wrecked
before anything was measured. And `cam.x/cam.y`, the map camera, is eased in
`update()`, which is exactly what pausing stops: whatever offset it held at the
moment of the freeze it kept for every frame after. That matters twice over,
because the chase camera *looks at* it and the range test that decides whether a
car gets wheels is measured *from* it — so a stale cam pointed the view off the
facade and put every car in the scene out of wheel range at once. It read as a
flaky renderer. Ghost mode, full health, and snapping cam onto the car inside
`freeze()` fixed all of it.

`airborne.mjs` covers the terrain, and its first version measured nothing at all
because it drove across open country: off the tarmac the drag term is 1.5 rather
than 0.32, which caps the car around 96 km/h and swamps a 4% grade — coasting
uphill and downhill both stopped after 22 metres. Ghost mode does not rescue it,
because ghost lifts the off-road *penalty* and not the off-road drag. Measured
along a real street instead, downhill coasts 37.8 m against uphill's 23.2.

It also found the two bugs worth having: the launch condition was a fixed 22 cm
height threshold, which is not a physical quantity — it needed the ground to drop
13 m/s faster than the car was climbing, and nothing on any terrain this
generates does that at any speed, so **no car had ever left the ground**. And a
car recovering from its roof righted itself the long way round, because roll is
an accumulator and at exactly π the shortest way back is a coin toss.

The first assertion in the file is that the 2D game is still perfectly flat. If
that ever fails, every speed and distance in the rest of this suite has quietly
changed meaning.

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
