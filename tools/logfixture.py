#!/usr/bin/env python3
"""Turn a log saved by the in-game LOG button into a checked-in fixture.

    python3 tools/logfixture.py <log.json> tests/fixtures/<name>

The log leads with the Overpass replies verbatim, which is the whole reason it
leads with them: they are the real thing the real servers sent to a real phone
in a real place, and they are the only map data this repository can test
against or ship offline. This writes each one out gzipped, next to a
session.json that records where it came from -- the same layout the two earlier
captures already use, so tools/buildcity.py and the fixture tests can read it
without knowing which session it came from.

Replies that came back empty all share one file, because a 272-byte Overpass
envelope repeated nine times is nine copies of nothing.
"""
import gzip, hashlib, json, os, sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
SRC, DST = sys.argv[1], sys.argv[2]
os.makedirs(DST, exist_ok=True)

with open(SRC, 'r', encoding='utf-8') as f:
    log = json.load(f)

EMPTY = os.path.join(DST, 'empty.json')
counts, replies = {}, []
for r in log.get('osm', []):
    kind, body = r.get('kind', 'other'), r.get('body') or ''
    row = {'kind': kind, 'host': r.get('host'), 'status': r.get('status'),
           'ms': r.get('ms'), 'bbox': r.get('bbox'),
           'chars': len(body),
           'sha256': hashlib.sha256(body.encode('utf-8')).hexdigest()}
    try:
        row['elements'] = len(json.loads(body).get('elements', []))
    except Exception:
        row['elements'] = None
    # an empty envelope is the same 272 bytes every time; one copy will do
    if row['elements'] == 0 or len(body) < 500:
        with open(EMPTY, 'w', encoding='utf-8') as f:
            f.write(body)
        row['file'] = 'empty.json'
    else:
        counts[kind] = counts.get(kind, 0) + 1
        name = '%s%d.json.gz' % (kind, counts[kind])
        blob = gzip.compress(body.encode('utf-8'), 9)
        with open(os.path.join(DST, name), 'wb') as f:
            f.write(blob)
        row['file'] = name
        row['bytes'] = len(blob)
    replies.append(row)

session = {
    'source': 'in-game LOG button',
    'build': log.get('build'),
    'savedAt': log.get('savedAt'),
    'sessionSeconds': log.get('sessionSeconds'),
    'capture': log.get('capture'),
    'snapshot': log.get('snapshot'),
    'replies': replies,
    'errors': log.get('errors', []),
}
with open(os.path.join(DST, 'session.json'), 'w', encoding='utf-8') as f:
    json.dump(session, f, indent=1, ensure_ascii=False)

for k in sorted(counts):
    kept = [r for r in replies if r['kind'] == k and r['file'] != 'empty.json']
    print('%-10s %d file(s)  %8d elements  %7.1f KB gz'
          % (k, len(kept), sum(r['elements'] or 0 for r in kept),
             sum(r.get('bytes', 0) for r in kept) / 1024))
empties = sum(1 for r in replies if r['file'] == 'empty.json')
print('%-10s %d' % ('empty', empties))
