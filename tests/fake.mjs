// ---- a small but real-shaped Overpass payload: a few blocks near Miami Beach.
// Takes the requested bbox so the opening ring gets ADJACENT districts rather
// than nine identical copies stacked on the same spot -- which is a fixture
// artifact that shows up as a frame-rate cliff, not a real one.
export function fakeOSM(bbox) {
  let lat0 = 25.7825, lon0 = -80.1300;
  if (bbox) { lat0 = (bbox[0] + bbox[2]) / 2; lon0 = (bbox[1] + bbox[3]) / 2; }
  const dLat = 1 / 110540, dLon = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
  const tag = bbox ? '@' + Math.round((lon0 + 80.13) * 1e4) + ',' + Math.round((lat0 - 25.7825) * 1e4) : '';
  const els = [];
  // OSM ids must differ between bboxes. The game dedupes ways by id -- the wide
  // skeleton repeats the trunk roads the detailed centre already has -- so a
  // fixture that hands every tile the same ids would have its tiles swallowed
  // whole and look exactly like a broken dedupe.
  // Zigzag each coordinate to a non-negative integer BEFORE mixing. Taking the
  // absolute value of the sum instead makes symmetric tiles collide -- (1,0) and
  // (-1,0) hash the same -- and the tiles then eat each other.
  const zig = v => v < 0 ? -2 * v - 1 : 2 * v;
  const seed = bbox ? (zig(Math.round((lon0 + 80.13) * 1e4)) * 7919 +
                       zig(Math.round((lat0 - 25.7825) * 1e4)) * 104729) % 900000 : 0;
  let id = 1 + seed * 1000;
  const S = 120; // metres between streets
  const NS = ['Alpha Avenue','Bravo Avenue','Charlie Avenue','Delta Avenue','Echo Avenue',
              'Foxtrot Avenue','Golf Avenue','Hotel Avenue','India Avenue'];
  const EW = ['Ocean Drive','Collins Street','Washington Road','Lincoln Way','Espanola Lane',
              'Meridian Street','Euclid Street','Pennsylvania Road','Michigan Way'];
  for (let i = -4; i <= 4; i++) {
    els.push({ type: 'way', id: id++, tags: { highway: i % 2 ? 'residential' : 'secondary', name: NS[i + 4] + tag },
      geometry: [
        { lat: lat0 + (-500) * dLat, lon: lon0 + i * S * dLon },
        { lat: lat0 + (500) * dLat,  lon: lon0 + i * S * dLon }] });
    els.push({ type: 'way', id: id++, tags: { highway: i % 3 ? 'residential' : 'primary', name: EW[i + 4] + tag },
      geometry: [
        { lat: lat0 + i * S * dLat, lon: lon0 + (-500) * dLon },
        { lat: lat0 + i * S * dLat, lon: lon0 + (500) * dLon }] });
  }
  // blocks subdivided into realistically sized buildings (10–30 m footprints)
  for (let i = -4; i < 4; i++) for (let j = -4; j < 4; j++) {
    const bx = i * S + 16, by = j * S + 16, bw = S - 32, bh = S - 32;
    const cols = 3, rows = 3;
    for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
      if (Math.random() < .18) continue;                     // gaps / lots
      const m = 2.5;
      const x0 = bx + a * bw / cols + m, y0 = by + b * bh / rows + m;
      const x1 = bx + (a + 1) * bw / cols - m, y1 = by + (b + 1) * bh / rows - m;
      const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      // mix the tag styles Overpass actually returns
      const tags = { building: 'yes' };
      const roll = Math.random();
      if (roll < .4) tags['building:levels'] = String(1 + Math.floor(Math.random() * 12));
      else if (roll < .6) tags.height = (4 + Math.random() * 40).toFixed(1) + ' m';
      const kind = ['house','apartments','commercial','retail','industrial','office','church','yes'];
      tags.building = kind[Math.floor(Math.random() * kind.length)];
      const mats = ['brick','concrete','glass','wood','stone','metal'];
      if (Math.random() < .35) tags['building:material'] = mats[Math.floor(Math.random() * mats.length)];
      if (Math.random() < .2) tags['roof:material'] = Math.random() < .5 ? 'tile' : 'metal';
      els.push({ type: 'way', id: id++, tags,
        geometry: c.map(([x, y]) => ({ lat: lat0 + y * dLat, lon: lon0 + x * dLon })) });
    }
  }
  // a building with a colour a mapper set by hand — must render at exactly this
  els.push({ type: 'way', id: 999001, tags: { building: 'yes', 'building:colour': '#ff0000', 'roof:colour': '#00ff00', height: '12' },
    geometry: [[-40, -40], [-20, -40], [-20, -20], [-40, -20], [-40, -40]]
      .map(([x, y]) => ({ lat: lat0 + y * dLat, lon: lon0 + x * dLon })) });

  // district nodes for the zone banner
  els.push({ type: 'node', id: 999100, lat: lat0 + 300 * dLat, lon: lon0 + 300 * dLon,
    tags: { place: 'neighbourhood', name: 'South Beach' } });
  els.push({ type: 'node', id: 999101, lat: lat0 - 300 * dLat, lon: lon0 - 300 * dLon,
    tags: { place: 'neighbourhood', name: 'Flamingo Park' } });
  els.push({ type: 'node', id: 999102, lat: lat0, lon: lon0,
    tags: { place: 'city', name: 'Miami Beach' } });

  // things the parser must survive: relations, geometry-less ways, 1-node ways
  els.push({ type: 'relation', id: id++, tags: { type: 'multipolygon', building: 'yes' }, members: [] });
  els.push({ type: 'way', id: id++, tags: { building: 'yes' } });
  els.push({ type: 'way', id: id++, tags: { highway: 'residential' }, geometry: [{ lat: lat0, lon: lon0 }] });
  els.push({ type: 'way', id: id++, tags: { highway: 'proposed' },
    geometry: [{ lat: lat0, lon: lon0 }, { lat: lat0 + dLat * 50, lon: lon0 }] });
  // a park
  els.push({ type: 'way', id: id++, tags: { leisure: 'park' },
    geometry: [[-360, -360], [-250, -360], [-250, -250], [-360, -250], [-360, -360]]
      .map(([x, y]) => ({ lat: lat0 + y * dLat, lon: lon0 + x * dLon })) });
  return { elements: els };
}

