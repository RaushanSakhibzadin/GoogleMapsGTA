// The wide arterial skeleton, as Overpass would answer it: a sparse lattice of
// trunk roads on a ~1.5 km pitch across the whole box, plus district nodes.
// Deliberately NOT dense -- that's the whole point of the arterials query.
export function fakeArterials(bbox) {
  const [s, w, n, e] = bbox;
  const lat0 = (s + n) / 2, lon0 = (w + e) / 2;
  const dLat = 1 / 110540, dLon = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
  const R = Math.round((n - s) / 2 / dLat);          // half-height, in metres
  const els = [];
  let id = 5000000;
  const PITCH = 1500;
  const N = Math.floor(R / PITCH);
  const KIND = ['motorway', 'trunk', 'primary', 'secondary'];
  for (let i = -N; i <= N; i++) {
    const k = KIND[Math.abs(i) % KIND.length];
    els.push({ type: 'way', id: id++, tags: { highway: k, name: 'Ring ' + i, ref: 'A' + Math.abs(i) },
      geometry: [{ lat: lat0 - R * dLat, lon: lon0 + i * PITCH * dLon },
                 { lat: lat0 + R * dLat, lon: lon0 + i * PITCH * dLon }] });
    els.push({ type: 'way', id: id++, tags: { highway: k, name: 'Radial ' + i, ref: 'B' + Math.abs(i) },
      geometry: [{ lat: lat0 + i * PITCH * dLat, lon: lon0 - R * dLon },
                 { lat: lat0 + i * PITCH * dLat, lon: lon0 + R * dLon }] });
  }
  // districts scattered across the whole width, so the banner works out there too
  for (let i = -N; i <= N; i += 2) for (let j = -N; j <= N; j += 2) {
    els.push({ type: 'node', id: id++, lat: lat0 + j * PITCH * dLat, lon: lon0 + i * PITCH * dLon,
      tags: { place: 'suburb', name: 'District ' + i + '/' + j } });
  }
  return { elements: els };
}

// Which query is this? The game sends four kinds and they have to be told apart
// by body, because they all POST to the same endpoint.
export function kindOf(q) {
  if (/"building"/.test(q)) return 'buildings';
  if (/amenity/.test(q) || /car_repair/.test(q)) return 'pois';
  // Arterials and streets share the motorway prefix; only streets asks for the
  // residential lanes, and that is exactly the difference that matters.
  if (/residential/.test(q)) return 'streets';
  if (/motorway/.test(q)) return 'arterials';
  return 'other';
}

export function bboxOf(q) {
  const m = q.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  return m ? m.slice(1).map(Number) : null;
}
