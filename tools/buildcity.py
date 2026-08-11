#!/usr/bin/env python3
"""Turn the captured Overpass payloads into the bundled offline city.

Reads tests/fixtures/stari-grad -- what the map servers actually sent during
one real session -- and writes data/belgrade.js, the city that loads when they
cannot be reached. Three things shrink them without touching what the game can
see:

  * tags the game never reads are dropped. Overpass returns everything a way
    carries -- addr:*, source, wikidata, opening_hours -- and parseOSM looks at
    perhaps a dozen keys.
  * coordinates go to 6 decimal places, which is 11 cm.
  * the arterial skeleton is CLIPPED to a box rather than filtered by it. A
    motorway crossing the area drags eighteen kilometres of geometry in with it
    otherwise, and none of that is anywhere you can drive to offline.

Output is a classic script assigning one global, because it has to load from
file:// where fetch() is refused and a <script> tag is not.
"""
import gzip, json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tests', 'fixtures', 'stari-grad')
DST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'belgrade.js')

# How far the offline horizon reaches, in metres. The online world is 36 km in
# every direction; the fallback cannot be, because every kilometre of skeleton
# is bytes in a <script> a phone has to parse before the loading screen clears.
# 15 km is where that curve stops being worth it -- 4x the area of the 4.5 km
# this used to bundle, for 1.3 MB, and past it the file grows faster than the
# map gets interesting.
SKEL_HALF = 15000

# every tag parseOSM, buildingColours or addPOIs actually looks at
KEEP = {
    'highway', 'name', 'ref', 'oneway', 'tunnel', 'covered', 'layer', 'place',
    'building', 'building:part', 'building:levels', 'height',
    'building:colour', 'building:color', 'colour', 'building:material', 'material',
    'roof:colour', 'roof:color', 'roof:material', 'roof:shape',
    'leisure', 'landuse', 'amenity', 'shop',
}

def load(n):
    with gzip.open(f'{SRC}/{n}.json.gz', 'rt', encoding='utf-8') as f:
        return json.load(f)

def bbox_of(kind):
    """the box the real request asked for, from the captured manifest"""
    s = json.load(open(f'{SRC}/session.json'))
    for r in s['replies']:
        if r['kind'] == kind and r['elements']:
            return r['bbox']
    raise SystemExit('no non-empty %s reply in the fixture' % kind)

bb = bbox_of('streets')
LAT0 = (bb['s'] + bb['n']) / 2
LON0 = (bb['w'] + bb['e']) / 2
M_LAT = 110540.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))

def to_xy(p):
    return ((p['lon'] - LON0) * M_LON, -(p['lat'] - LAT0) * M_LAT)

def slim(el):
    """same element, minus what the game will never look at"""
    out = {'type': el['type'], 'id': el['id']}
    t = {k: v for k, v in (el.get('tags') or {}).items() if k in KEEP}
    if t:
        out['tags'] = t
    if 'geometry' in el:
        out['geometry'] = [{'lat': round(p['lat'], 6), 'lon': round(p['lon'], 6)}
                           for p in el['geometry']]
    for k in ('lat', 'lon'):
        if k in el:
            out[k] = round(el[k], 6)
    if 'center' in el:
        out['center'] = {'lat': round(el['center']['lat'], 6), 'lon': round(el['center']['lon'], 6)}
    return out

def clip(els, half, nid):
    """Keep the runs of each way that lie inside the box, one point of overhang
       either side so the geometry still reaches the edge. Split pieces get new
       ids -- the world dedupes on id, and two pieces sharing one would mean the
       second is silently dropped."""
    out = []
    for e in els:
        if e.get('type') == 'node':
            x, y = to_xy(e)
            if abs(x) <= half and abs(y) <= half:
                out.append(slim(e))
            continue
        g = e.get('geometry') or []
        run, prev_in = [], False
        for p in g:
            x, y = to_xy(p)
            inside = abs(x) <= half and abs(y) <= half
            if inside:
                if not prev_in and run:
                    run = [run[-1]]
                run.append(p)
            else:
                if prev_in:
                    run.append(p)
                    if len(run) >= 2:
                        out.append(slim({'type': 'way', 'id': nid[0],
                                         'tags': e.get('tags', {}), 'geometry': run}))
                        nid[0] += 1
                    run = []
                else:
                    run = [p]
            prev_in = inside
        if prev_in and len(run) >= 2:
            out.append(slim({'type': 'way', 'id': nid[0],
                             'tags': e.get('tags', {}), 'geometry': run}))
            nid[0] += 1
    return out

streets = [slim(e) for e in load('streets')['elements']]
buildings = [slim(e) for e in load('buildings')['elements']]
skeleton = clip(load('arterials')['elements'], SKEL_HALF, [900000000])

city = {
    'name': 'Stari grad, Beograd',
    'lat': round(LAT0, 6), 'lon': round(LON0, 6),
    'skeletonRadius': SKEL_HALF,
    'streets': streets, 'buildings': buildings, 'skeleton': skeleton,
}
body = json.dumps(city, separators=(',', ':'), ensure_ascii=False)
header = (
    '/* VICE MAPS — the bundled offline city.\n\n'
    '   Stari grad, Belgrade \u2014 the old town. Captured from real OpenStreetMap\n'
    '   data by the in-game LOG button, and trimmed out of\n'
    '   tests/fixtures/stari-grad by tools/buildcity.py. This is what loads when\n'
    '   the map servers cannot be reached, in place of a generated grid.\n\n'
    '   Generated \u2014 do not edit. Rebuild with: python3 tools/buildcity.py\n\n'
    '   A classic script assigning one global, NOT JSON fetched at runtime:\n'
    '   fetch() is refused for file:// URLs and a <script> tag is not, and\n'
    '   opening index.html straight off disk has to keep working. It is pulled\n'
    '   in on demand, so the normal path never downloads it.\n\n'
    '   Map data © OpenStreetMap contributors, ODbL. */\n'
)
os.makedirs(os.path.dirname(DST), exist_ok=True)
open(DST, 'w').write(header + 'window.OFFLINE_CITY=' + body + ';\n')
print('wrote %s  %.2f MB' % (DST, os.path.getsize(DST) / 1e6))
print('  streets %d  buildings %d  skeleton %d ways (half %dm)' %
      (len(streets), len(buildings), len(skeleton), SKEL_HALF))
