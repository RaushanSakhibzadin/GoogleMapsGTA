/* A STATUE IN THE STREET MUST NOT TAKE THE BUILDINGS WITH IT.

   This is the regression test for a shipped fault, and the fault is worth
   describing exactly because the shape of it is what made it invisible.

   Everything the chase view's lit program draws goes into one of two float
   buffers — the cell a district is baked into, and the stream of cars and
   pedestrians rebuilt every frame — and both were declared, separately, in two
   places. Adding a fourteenth float to the cell layout for the graffiti tag left
   the other declaration at thirteen, and left `pushBox` — the one function that
   feeds BOTH, and the one monuments are built out of — writing thirteen.

   A short vertex does not fail. `GL.mesh` divides the array by the components it
   was told to expect, so the count truncates and every vertex after the monument
   reads its position out of the previous vertex's colour. The district does not
   lose a statue; it smears every building in that 512 m square across the map.

   AND THE WHOLE SUITE STAYED GREEN, because a monument is the one piece of real
   city furniture none of the synthetic fixtures has. `monument.mjs` builds one
   and checks the statue; nothing checked what the statue did to its neighbours.

   So this fixture is a street of ordinary blocks with a memorial standing among
   them, and the assertion is on the BUILDINGS: they have to still be where they
   were, the same size, with the same number of triangles behind them, and the
   frame has to come out looking the same as the identical city with the statue
   taken out.

   Usage: node tests/monublock.mjs
*/
import { chromium } from 'playwright';
import { CHROME, GAME_ASIS, stubRadio } from './harness.mjs';

const LAT0 = 44.8125, LON0 = 20.4612;
const M_LAT = 110540, M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: LAT0 - y / M_LAT, lon: LON0 + x / M_LON });

const streets = () => {
  const els = []; let id = 1;
  for (const y of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Cross ${y}` },
               geometry: [toLL(-700, y), toLL(700, y)] });
  for (const x of [-400, -200, 0, 200, 400])
    els.push({ type: 'way', id: id++, tags: { highway: 'secondary', name: `Avenue ${x}` },
               geometry: [toLL(x, -700), toLL(x, 700)] });
  return { elements: els };
};

/* THE BLOCKS, AND — in the `statue` scenario — a memorial standing in the middle
   of them. Both come back from the BUILDINGS query, which is where a monument
   arrives in a real city too: it is tagged geometry on the ground, not a POI.

   The monument is placed inside the same 512 m cell as the blocks on purpose.
   That is the whole mechanism: one cell, one float buffer, and the statue's
   vertices land in the middle of the buildings' rather than after them. */
function buildings(withStatue) {
  const els = []; let id = 20000;
  for (let i = -2; i < 3; i++) for (let j = -2; j < 3; j++) {
    const bx = i * 200 + 30, by = j * 200 + 30;
    els.push({ type: 'way', id: id++, tags: { building: 'yes', 'building:levels': '5' },
               geometry: [[bx, by], [bx + 130, by], [bx + 130, by + 130], [bx, by + 130], [bx, by]]
                 .map(([x, y]) => toLL(x, y)) });
  }
  if (withStatue)
    els.push({ type: 'node', id: 77001, ...toLL(-80, -80),
               tags: { historic: 'memorial', name: 'Spomenik', height: '12' } });
  return { elements: els };
}
const json = o => ({ contentType: 'application/json', body: JSON.stringify(o) });
const isB = req => decodeURIComponent(req.postData() || '').includes('"building"');
const isArt = req => { const q = decodeURIComponent(req.postData() || '');
                       return /motorway/.test(q) && !/residential/.test(q); };

const bad = [];
const need = (cond, msg) => { if (!cond) bad.push(msg); };
const out = {};
const browser = await chromium.launch({ executablePath: CHROME });

async function run(withStatue) {
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.route('**/nominatim.openstreetmap.org/**', r => r.fulfill(
    json([{ lat: String(LAT0), lon: String(LON0), display_name: 'Beograd' }])));
  await p.route('**/api/interpreter', r => r.fulfill(
    json(isArt(r.request()) ? { elements: [] }
       : isB(r.request()) ? buildings(withStatue) : streets())));
  await stubRadio(p);
  await p.goto(GAME_ASIS);
  await p.waitForTimeout(300);
  await p.click('#go');
  await p.waitForFunction(() => window.__s && window.__s() === 'play', null, { timeout: 40000 });
  // park where the blocks fill the frame, and let the cells build
  await p.evaluate(() => window.__tp(-80, 260, -1.5708));
  await p.waitForTimeout(2200);

  const r = await p.evaluate(() => {
    const cells = G3.cells ? [...G3.cells.values()] : [];
    /* THE ONE NUMBER THAT CANNOT LIE. A cell's lit buffer is a whole number of
       vertices or it is corrupt, and corrupt is silent everywhere else — this is
       the arithmetic GL.mesh does to get its vertex count, done again here where
       a test can see it. */
    const comps = 14;
    return {
      buildings: W.buildings.length,
      monuments: W.buildings.filter(b => b.mono).length,
      cells: cells.length,
      litVerts: cells.reduce((n, c) => n + (c.lit ? c.lit.n : 0), 0),
      // every cell's float count, and whether it divides
      ragged: cells.filter(c => c.lit && (c.lit.n % 1) !== 0).length,
      floats: cells.map(c => c.lit ? c.lit.n * comps : 0)
    };
  });
  r.errs = errs.slice(0, 3);
  await p.screenshot({ path: `/tmp/shot-monublock-${withStatue ? 'statue' : 'plain'}.png` });
  await p.close();
  return r;
}

out.plain = await run(false);
out.statue = await run(true);
await browser.close();

/* THE FAULT ITSELF, STATED AS DIRECTLY AS IT CAN BE. A vertex count is a whole
   number or the buffer does not divide by its own stride, and on the build that
   shipped this comes back as 133.714… — GL.mesh dividing a float array by
   fourteen when the producer wrote thirteen. Nothing else in the game can make
   this fractional, which is what makes it the assertion worth leading with. */
need(!out.statue.ragged && !out.plain.ragged,
     'a cell holds a fractional number of vertices — a producer and LIT_ATTR disagree');
need(out.statue.monuments === 1, `${out.statue.monuments} monuments parsed, want 1`);
need(out.plain.monuments === 0, 'the control city has a monument in it');
/* THE BUILDINGS SURVIVE. The statue adds its own geometry, so the vertex count
   is higher — but every block that was there before must still be there, which
   is what the count of buildings and the count of cells say. */
need(out.statue.buildings >= out.plain.buildings,
     `${out.statue.buildings} buildings with a statue against ${out.plain.buildings} without`);
need(out.statue.cells === out.plain.cells,
     `${out.statue.cells} cells built with a statue against ${out.plain.cells} without`);
/* AND THE GEOMETRY IS WHOLE, TO THE VERTEX. A memorial is four boxes — the
   steps, the plinth, the shaft and the figure — at twelve triangles each, so it
   adds exactly 144 vertices to its cell and touches nothing else.

   An exact number rather than "more than before", because more-than-before is
   the assertion that would have let the original fault through in the other
   direction: a buffer whose count truncates can still come out larger if the
   statue's own geometry outweighs what the truncation eats. 144 is the statue
   and nothing but the statue, and any short vertex anywhere in that cell moves
   it. Against the broken build this reads a number that is not 144. */
need(out.statue.litVerts - out.plain.litVerts === 144,
     `the statue added ${out.statue.litVerts - out.plain.litVerts} vertices, want exactly 144 ` +
     '(four boxes — steps, plinth, shaft, figure — twelve triangles each)');
need(!out.statue.errs.length, 'page errors with a statue: ' + out.statue.errs.slice(0, 2).join(' | '));
need(!out.plain.errs.length, 'page errors without one: ' + out.plain.errs.slice(0, 2).join(' | '));

out.added = out.statue.litVerts - out.plain.litVerts;
out.bad = bad;
out.pass = bad.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
