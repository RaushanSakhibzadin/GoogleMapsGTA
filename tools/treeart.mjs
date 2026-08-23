/* CUT A NIGHT TREE OUT OF A PHOTOGRAPH AND WRITE IT INTO js/foliage.js.
 *
 *     node tools/treeart.mjs <photo.jpg> js/foliage.js  cx cy cw ch  size gamma
 *
 * Everything else this game draws is drawn in code, because that is what keeps it
 * a single folder of text that runs off a disk with no build step. Foliage is the
 * one thing that resists it. A painted tree is two dozen circles, and two dozen
 * circles read as a green lollipop no matter how they are shaded, because what
 * makes a canopy look like a canopy is the clumping — thousands of leaves at
 * every scale, a few of them catching a street lamp and the rest in shadow.
 *
 * So the substance comes from a photograph, of a real tree on a real Belgrade
 * street at night, taken by the person this is being built for.
 *
 * THE SHAPE STILL HAS TO BE PAINTED. A photograph taken from underneath a tree is
 * a ceiling of leaves — it has no outline in it anywhere, and keying the night
 * sky out of it leaves a rectangle full of holes rather than a tree. So a crown of
 * overlapping blobs is painted as a mask, bitten back around its rim so the edge
 * is leaves rather than a circle, and destination-in cuts the photograph out of
 * it. The trunk is painted too: the foot of the real one has a café round it.
 *
 * TONE. A night photograph is nearly all shadow with a handful of lamplit leaves,
 * so it is lifted with a gamma rather than a multiply — a multiply blows out the
 * lamplit ones before the shadow has moved at all — and the curve sits on a dark
 * blue-green floor rather than on black. Keying that shadow out instead was tried
 * and dissolved the canopy into lace, which is not what a tree looks like from
 * across a street.
 *
 * The photograph itself is not in the repository. What ships is this 30 KB cutout
 * of its leaves, as a data: URI inside a .js file, so there is still nothing to
 * fetch and the existing ?v= stamping covers it like any other source file.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { CHROME } from '../tests/harness.mjs';

/* playwright is a devDependency of the test folder, which is the only place in
   this repository that has a node_modules at all. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'tests', 'package.json'))('playwright');

const [src, out, cx, cy, cw, ch, size, gain] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node tools/treeart.mjs <photo> <out.js> cx cy cw ch size gamma');
  process.exit(2);
}
const b64 = readFileSync(src).toString('base64');
const br = await chromium.launch({ executablePath: CHROME });
const p = await br.newPage({ viewport: { width: 400, height: 400 } });
await p.setContent('<body style="margin:0"><img id="i" src="data:image/jpeg;base64,' + b64 + '"></body>');
await p.waitForFunction(() => { const i = document.getElementById('i'); return i.complete && i.naturalWidth; });

const res = await p.evaluate(a => {
  const [cx, cy, cw, ch, S, gain] = a.map(Number);
  const img = document.getElementById('i');
  const iw = img.naturalWidth, ih = img.naturalHeight;

  // 1. the foliage, scaled to fill the square
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, cx * iw, cy * ih, cw * iw, ch * ih, 0, 0, S, S);

  // 2. lifted onto a floor rather than from black
  const amb = [14, 22, 16];
  {
    const d = g.getImageData(0, 0, S, S), px = d.data, inv = 1 / gain;
    for (let i = 0; i < px.length; i += 4)
      for (let k = 0; k < 3; k++)
        px[i + k] = amb[k] + (255 - amb[k]) * Math.pow(px[i + k] / 255, inv);
    g.putImageData(d, 0, 0);
  }

  // 3. the silhouette, painted — deterministic, so a rebuild gives the same tree
  const m = document.createElement('canvas');
  m.width = S; m.height = S;
  const mg = m.getContext('2d');
  let s = 1;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blob = (bx, by, r) => { mg.beginPath(); mg.arc(bx * S, by * S, r * S, 0, Math.PI * 2); mg.fill(); };
  mg.fillStyle = '#fff';
  for (let i = 0; i < 46; i++) {
    const ang = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.45);
    blob(0.5 + Math.cos(ang) * rr * 0.30, 0.35 + Math.sin(ang) * rr * 0.27,
         0.050 + (1 - rr) * 0.050);
  }
  /* The bites sit just OUTSIDE the crown and only reach into it. One placed in the
     middle punches a hole through the canopy, or cuts a clump loose to float
     beside it — which is what the first attempt did, and it looked bitten. */
  mg.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 20; i++) {
    const ang = rnd() * Math.PI * 2;
    blob(0.5 + Math.cos(ang) * 0.345, 0.35 + Math.sin(ang) * 0.315, 0.028 + rnd() * 0.030);
  }
  mg.globalCompositeOperation = 'source-over';

  // 4. one cut out of the other
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(m, 0, 0);
  g.globalCompositeOperation = 'source-over';

  // 5. and the trunk
  const tw = S * 0.050, tx = S * 0.5, top = S * 0.40;
  const grd = g.createLinearGradient(tx - tw, 0, tx + tw * 1.4, 0);
  grd.addColorStop(0, '#241b13'); grd.addColorStop(0.45, '#4c3a29'); grd.addColorStop(1, '#1d160f');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(tx - tw * 0.5, top);
  g.lineTo(tx + tw * 0.5, top);
  g.lineTo(tx + tw * 1.2, S);
  g.lineTo(tx - tw * 1.2, S);
  g.closePath();
  g.fill();

  // how much of the square is tree, and how bright it came out
  const d = g.getImageData(0, 0, S, S).data;
  let opaque = 0, leaf = 0, n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 3] > 127) { opaque++; leaf += d[i] * .3 + d[i + 1] * .6 + d[i + 2] * .1; n++; }
  return { url: c.toDataURL('image/png'), S,
           cover: +(opaque / (S * S)).toFixed(3),
           luma: +(leaf / Math.max(1, n)).toFixed(1) };
}, [cx, cy, cw, ch, size, gain]);
await br.close();

const bytes = Buffer.from(res.url.split(',')[1], 'base64').length;
const head = `/* THE NIGHT TREE, CUT OUT OF A PHOTOGRAPH OF A REAL ONE.
 *
 * ${res.S}x${res.S} cutout, ${(bytes / 1024).toFixed(1)} KB of PNG, ${res.cover * 100 | 0}% of the square
 * opaque. Foliage from a photograph of a lamplit plane tree in Belgrade, used
 * with its photographer's permission; the crown outline and the trunk are
 * painted. Generated, not hand-written — see tools/treeart.mjs, which is also
 * where the crop and the tone curve are explained.
 *
 * It is a data: URI rather than a .png next to index.html because everything
 * here has to work from a file:// URL with nothing to fetch, and because the
 * ?v= stamping that keeps phones off a stale build only covers .js and .css.
 *
 * Used by the dusk theme in both renderers. Daylight still gets the painted tree
 * in render3d.js, and the lighting is not applied to this one twice: the street
 * lamp that lit it is already in the pixels.
 */
const TREE_NIGHT_PNG = '`;
writeFileSync(out, head + res.url + "';\n");
console.log(out, (Buffer.byteLength(head + res.url) / 1024).toFixed(1) + ' KB of js',
            '| png', (bytes / 1024).toFixed(1) + ' KB, cover', res.cover, 'luma', res.luma);
