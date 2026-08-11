# Stari grad, Beograd — a real session, captured

What the OpenStreetMap servers actually said during one game, saved by the
in-game **⤓ LOG** button on 11 August 2026 and kept here so the tests can run
against real map data instead of a fixture someone wrote by hand.

That distinction has mattered twice. The "car crawls even on roads" fault was
Belgrade's pedestrian squares — `highway=pedestrian`, drawn as tarmac, absent
from the drivable mask — and it was only reproducible once a hand-written
fixture happened to contain one. The "empty mirror" fault was a host answering
`200` with zero elements in a quarter of a second, being marked healthy for it,
and then winning every race. Neither was imaginable in advance. Both are in
these bytes.

| File | What it is |
|---|---|
| `streets.json.gz` | 1,161 ways — every road, path and square in the 1.8 km opening tile, plus the place nodes |
| `buildings.json.gz` | 3,782 elements — footprints with real `building:levels`, `height` and material tags, and 280 parks |
| `arterials.json.gz` | 10,863 ways — the arterial skeleton over a **72 km box**, which is the whole reason the world is 72 km across |
| `empty.json` | The 272-byte body one mirror served, verbatim. It answered this to the streets query, to the 36 km landmark sweep, and to three of the four building tiles |
| `session.json` | Everything except the bodies: which mirror answered what, how long it took, the bbox, a snapshot of the world and the car, and all 31 errors, timestamped |

The bodies are gzipped only because 16 MB of JSON in a repository is rude;
`session.json` carries a SHA-256 of each **decompressed** body, so a replay is
provably the same bytes the server sent. `tests/real.mjs` serves them to the
game through a stubbed Overpass and drives it.

The compression is the only thing done to them. No reformatting, no trimming,
no pretty-printing — including the four blank lines inside `empty.json`, which
are what a broken mirror's "no results" looks like.

## Where it was

Стари град, Belgrade — the old town, around Трг Николе Пашића. The bbox centre
is 44.813954, 20.462875. `data/belgrade.js`, the city that loads when the map
servers can't be reached, is built from these same files by
`tools/buildcity.py`.

## What went wrong that session

Worth reading `session.json`'s error list before assuming a load is healthy:
of six mirrors, one was unreachable throughout, four timed out at least once,
and one served the empty body above. The streets request survived because an
empty reply is treated as a failed mirror and handed on — the landmark sweep
did not, which is why the snapshot ends with **one** landmark in a 36 km
radius and no repair shop anywhere.

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
