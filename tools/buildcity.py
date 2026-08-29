#!/usr/bin/env python3
"""Turn the captured Overpass payloads into the bundled offline city.

Reads tests/fixtures/ -- what the map servers actually sent during two real
sessions -- and writes data/belgrade.js, the city that loads when they cannot be
reached.

The detail comes from the LATER capture (autokomanda: four street tiles and
seven of scenery, so 5.4 km of streets rather than 1.8), and the SKELETON from
the earlier one (stari-grad), because the later session's 200 km arterials reply
was 44 MB and the log's 25 MB cap dropped it. The two centres are 1.14 km apart
and the earlier arterials box reaches 35 km around the later centre, so it
covers the offline horizon with room to spare -- it is the same city, and the
motorways out of it do not move.

Four things shrink the result without touching what the game can see:

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
FIX = os.path.join(ROOT, 'tests', 'fixtures')
# Streets and scenery from every capture there is — they are all the same city
# within a kilometre, the geometry is absolute lat/lon, and the world dedupes
# ways on their OSM id, so overlapping captures simply fill each other's gaps.
# Six sessions now: the two newest were played in Savski venac and around
# Slavija and between them brought seven street tiles and seven of scenery from
# a centre 21 m from this one.
SRCS = [os.path.join(FIX, n) for n in
        ('autokomanda', 'savski-venac', 'london-0829', 'skadarlija',
         'kneza-danila', 'stari-grad')]
SRC = SRCS[0]                                   # whose centre the city is built around
# THE ARTERIALS COME FROM THE SAME CENTRE NOW. They used to be borrowed from a
# session 778 m away, because the one that had the streets lost its own 44 MB
# reply to the log's cap. london-0829 arrived whole -- 15,641 ways -- from a
# centre 21 m from this one, which is the thing the older comment wished for.
SKEL_SRC = os.path.join(FIX, 'london-0829')
DST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'belgrade.js')

# How far the offline horizon reaches, in metres. The online world is 36 km in
# every direction; the fallback cannot be, because every kilometre of skeleton
# is bytes in a <script> a phone has to parse before the loading screen clears.
# 15 km is where that curve stops being worth it -- 4x the area of the 4.5 km
# this used to bundle, for 1.3 MB, and past it the file grows faster than the
# map gets interesting.
SKEL_HALF = 15000

# How far the bundled scenery reaches. The capture holds seven tiles of it,
# 22,403 buildings, which is more than a phone should parse off a <script> tag
# before it can drive -- and the streets are what makes the place drivable, the
# buildings are what makes it look like somewhere. The centre keeps its
# buildings and the outer tiles keep their streets.
BLD_HALF = 1200

# every tag parseOSM, buildingColours or addPOIs actually looks at
KEEP = {
    'highway', 'name', 'ref', 'oneway', 'tunnel', 'covered', 'layer', 'place',
    'building', 'building:part', 'building:levels', 'height',
    'building:colour', 'building:color', 'colour', 'building:material', 'material',
    'roof:colour', 'roof:color', 'roof:material', 'roof:shape',
    'leisure', 'landuse', 'amenity', 'shop',
}

def load(where, n):
    with gzip.open(f'{where}/{n}.json.gz', 'rt', encoding='utf-8') as f:
        return json.load(f)

def replies(where, kind):
    """every non-empty reply of one kind, in the order they arrived"""
    s = json.load(open(f'{where}/session.json'))
    return [r for r in s['replies'] if r['kind'] == kind and r['elements']]

def all_of(where, kind):
    out = []
    for r in replies(where, kind):
        out += load(where, r['file'].replace('.json.gz', ''))['elements']
    return out

bb = replies(SRC, 'streets')[0]['bbox']
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

def dedupe(els):
    """one copy of each way.

    The world dedupes on the OSM id when it loads, so shipping the same building
    six times was invisible in the game and enormous in the file: three of the
    six sessions were played within 21 m of each other and their tiles overlap
    almost completely. Six captures came to 16.4 MB with the duplicates in and
    7.3 without, for exactly the same city. Done BEFORE clip(), which hands split
    pieces new ids of its own."""
    seen, out = set(), []
    for e in els:
        k = (e.get('type'), e.get('id'))
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    return out

streets = [slim(e) for e in dedupe([e for src in SRCS for e in all_of(src, 'streets')])]
# scenery only where you can see it from the middle; the outer tiles keep their
# streets, which is what the offline city is actually for
buildings = clip(dedupe([e for src in SRCS for e in all_of(src, 'buildings')]), BLD_HALF, [800000000])
skeleton = clip(dedupe(all_of(SKEL_SRC, 'arterials')), SKEL_HALF, [900000000])

city = {
    'name': 'Autokomanda, Beograd',
    'lat': round(LAT0, 6), 'lon': round(LON0, 6),
    'skeletonRadius': SKEL_HALF,
    'streets': streets, 'buildings': buildings, 'skeleton': skeleton,
}
body = json.dumps(city, separators=(',', ':'), ensure_ascii=False)
header = (
    '/* VICE MAPS — the bundled offline city.\n\n'
    '   Belgrade, around Autokomanda. Captured from real OpenStreetMap data by\n'
    '   the in-game LOG button and trimmed out of tests/fixtures by\n'
    '   tools/buildcity.py -- streets and scenery from every captured session,\n'
    '   the arterial skeleton from the one that arrived whole. This is what\n'
    '   loads when the map servers cannot be reached, in place of a generated\n'
    '   grid.\n\n'
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
