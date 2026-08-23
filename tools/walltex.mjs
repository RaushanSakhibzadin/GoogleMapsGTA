/* CUT A SEAMLESS WALL OUT OF A PHOTOGRAPH AND WRITE IT INTO js/walltex.js.
 *
 *     node tools/walltex.mjs js/walltex.js <wall.jpg>
 *
 * The walls in this game have no texture at all. The window grid is computed in
 * the fragment shader — no atlas, nothing to download — and between the windows
 * is flat colour, which is what makes a street of real footprints at real heights
 * still read as a heap of boxes. Real render is never flat: it is patched where it
 * has been repaired, stained under every sill, and cracked along the line of every
 * floor slab.
 *
 * So this cuts that out of a photograph of a Belgrade block at night, and three
 * things happen to it that matter more than the crop.
 *
 * FLATTENED. It is divided by a heavy wrapped blur of itself, which takes out the
 * street lamp's falloff and the shadow of the balcony above and leaves only what
 * belongs to the wall. Skip this and the tile has a bright corner in it, and a
 * bright corner repeated every four metres across a block is wallpaper.
 *
 * WRAPPED. Offset by half in both axes and the resulting cross-shaped join
 * cross-faded, so it tiles with no seam. NOT mirrored into a 2x2, which also
 * tiles and puts an axis of symmetry through the middle of every wall in the city.
 *
 * AND GREY. What ships is a multiplier around 1.0, not a picture of a wall. The
 * theme still chooses what colour a building is; this only says where it is dirty.
 * A colour tile would put Belgrade's ochre render on every building in Tokyo.
 *
 * The photograph is not in the repository. What ships is this ~18 KB tile as a
 * data: URI inside a .js file, so there is still nothing to fetch and the existing
 * ?v= stamping covers it like any other source file.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { CHROME } from '../tests/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'tests', 'package.json'))('playwright');

const [out, src] = process.argv.slice(2);
if (!out || !src) {
  console.error('usage: node tools/walltex.mjs js/walltex.js <wall.jpg>');
  process.exit(2);
}

const S = 128;
/* The run of peeling render between two windows, which is the only part of that
   photograph with nothing in it but wall. Square in the ORIGINAL's pixels — the
   frame is 4:3, so equal fractions are not equal lengths, and a tile stretched one
   way tiles as stretched render. */
const CROP = [0.675, 0.21, 0.09, 0.12];
const CONTRAST = 1.0;

const br = await chromium.launch({ executablePath: CHROME });
const p = await br.newPage({ viewport: { width: 400, height: 400 } });
await p.setContent('<body style="margin:0"><img id="i" src="data:image/jpeg;base64,' +
                   readFileSync(src).toString('base64') + '"></body>');
await p.waitForFunction(() => { const i = document.getElementById('i'); return i.complete && i.naturalWidth; });

const res = await p.evaluate(a => {
  const { S, CROP, K } = a;
  const img = document.getElementById('i');
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, CROP[0] * iw, CROP[1] * ih, CROP[2] * iw, CROP[3] * ih, 0, 0, S, S);

  // ---- flatten: divide by a WRAPPED box blur of the luma ----
  const d = g.getImageData(0, 0, S, S), px = d.data;
  const lum = new Float32Array(S * S);
  for (let i = 0, j = 0; i < px.length; i += 4, j++)
    lum[j] = px[i] * .3 + px[i + 1] * .6 + px[i + 2] * .1;
  const R = Math.round(S / 6);
  /* Wrapped, because the tile is going to wrap: a blur that clamps at the edges
     leaves the edges lit differently from the middle, which is the one place the
     seam has to be invisible. */
  const axis = (from, to, horiz) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) {
        const xx = horiz ? (x + k + S * 4) % S : x, yy = horiz ? y : (y + k + S * 4) % S;
        s += from[yy * S + xx];
      }
      to[y * S + x] = s / (2 * R + 1);
    }
  };
  const t1 = new Float32Array(S * S), bl = new Float32Array(S * S);
  axis(lum, t1, true); axis(t1, bl, false);
  let mean = 0; for (let i = 0; i < lum.length; i++) mean += lum[i]; mean /= lum.length;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, 128 + (lum[j] * (mean / Math.max(6, bl[j])) - mean) * K));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  g.putImageData(d, 0, 0);

  // ---- wrap: offset by half, then cross-fade the join back over it ----
  const off = document.createElement('canvas'); off.width = S; off.height = S;
  const og = off.getContext('2d');
  const H = S / 2;
  og.drawImage(cv, H, H, H, H, 0, 0, H, H);
  og.drawImage(cv, 0, H, H, H, H, 0, H, H);
  og.drawImage(cv, H, 0, H, H, 0, H, H, H);
  og.drawImage(cv, 0, 0, H, H, H, H, H, H);
  const F = Math.round(S * 0.12);
  const feather = vertical => {
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const q = c.getContext('2d');
    q.drawImage(cv, 0, 0);
    const gr = vertical ? q.createLinearGradient(0, H - F, 0, H + F)
                        : q.createLinearGradient(H - F, 0, H + F, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.5, 'rgba(0,0,0,1)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    q.globalCompositeOperation = 'destination-in';
    q.fillStyle = gr; q.fillRect(0, 0, S, S);
    return c;
  };
  og.drawImage(feather(false), 0, 0);
  og.drawImage(feather(true), 0, 0);

  const q = og.getImageData(0, 0, S, S).data;
  let mn = 255, mx = 0, sum = 0, seam = 0;
  for (let i = 0; i < q.length; i += 4) {
    const L = q[i]; mn = Math.min(mn, L); mx = Math.max(mx, L); sum += L;
  }
  /* THE SEAM, MEASURED. Column 0 against column S-1 and row 0 against row S-1 are
     the pixels that end up next to each other when it tiles; a tile that does not
     wrap shows up here as a large number and nowhere else until it is on a wall. */
  for (let i = 0; i < S; i++) {
    seam += Math.abs(q[(i * S) * 4] - q[(i * S + S - 1) * 4]);
    seam += Math.abs(q[i * 4] - q[((S - 1) * S + i) * 4]);
  }
  seam /= 2 * S;
  /* And what a step between two neighbouring pixels costs ANYWHERE in the tile,
     which is the number the seam has to be compared against: a seam is invisible
     when crossing it is no more of a step than crossing the middle of the wall. */
  let inner = 0, n = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S - 1; x++) {
    inner += Math.abs(q[(y * S + x) * 4] - q[(y * S + x + 1) * 4]); n++;
  }
  inner /= n;
  return { url: off.toDataURL('image/png'), min: mn, max: mx,
           mean: +(sum / (S * S)).toFixed(1), seam: +seam.toFixed(2), inner: +inner.toFixed(2) };
}, { S, CROP, K: CONTRAST });
await br.close();

const bytes = Buffer.from(res.url.split(',')[1], 'base64').length;
const head = `/* THE WALLS, CUT OUT OF A PHOTOGRAPH OF A REAL ONE.
 *
 * A ${S}x${S} seamless grime tile, ${(bytes / 1024).toFixed(1)} KB of PNG, from the peeling render
 * between two windows of a Belgrade block at night — photographed by, and used
 * with the permission of, the person this was built for.
 *
 * GREY BY CONSTRUCTION. It is a multiplier around 1.0, not a picture of a wall:
 * ${res.min}..${res.max} around a mean of ${res.mean}. The theme still says what colour a building
 * is and this only says where it is dirty, so it puts Belgrade's render on a
 * Tokyo block without putting Belgrade's ochre on it.
 *
 * Tiled every ${4} m off the same world-anchored facade coordinate the window grid
 * uses, so it runs continuously round a corner and does not swim as you drive.
 * Mipmapped, unlike the foliage: this one repeats, so a distant wall wants the
 * average rather than a hard edge.
 *
 * Generated, not hand-written — see tools/walltex.mjs, which is where the crop
 * and the flattening are explained. The wrap, measured: crossing the seam is a
 * step of ${res.seam} against ${res.inner} for crossing anywhere else, so there is nothing
 * there to see.
 */
const WALL_GRIME_PNG = '`;
writeFileSync(out, head + res.url + "';\n");
console.log(out, (Buffer.byteLength(head + res.url) / 1024).toFixed(1) + ' KB of js',
            '| png', (bytes / 1024).toFixed(1) + ' KB | luma ' + res.min + '..' + res.max,
            'mean', res.mean, '| seam', res.seam, 'vs inner', res.inner);
