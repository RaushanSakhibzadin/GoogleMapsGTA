/* CUT THE DAYLIGHT TREES OUT OF PHOTOGRAPHS AND WRITE THEM INTO js/daytree.js.
 *
 *     node tools/daytree.mjs js/daytree.js <canopy-a.jpg> <canopy-b.jpg>
 *
 * The night trees came first, and they had to be cut the hard way: those
 * photographs were taken from underneath, looking up into a ceiling of leaves,
 * with no outline anywhere in the frame. Keying the night sky out of one leaves a
 * rectangle full of holes rather than a tree, so their silhouettes are painted and
 * the photograph only fills them — see tools/treeart.mjs.
 *
 * A DAYLIGHT PHOTOGRAPH OF A WHOLE TREE AGAINST THE SKY NEEDS NONE OF THAT. The
 * outline is right there in the frame. So nothing is painted here: the sky is
 * keyed out and what is left IS the silhouette, with the real ragged leaf edge and
 * real gaps you can see the street through. It is a better cutout than the painted
 * ones by some distance, and the reason the night trees are not done this way is
 * that nobody has yet photographed one from across the road after dark.
 *
 * TWO SKIES, and the second one is the one that catches you out. Blue is easy. The
 * hard one is the white haze near the sun and the thin cloud, which is not blue at
 * all — bright and almost colourless — and leaving it in hangs a white sheet behind
 * half the canopy.
 *
 * NOTHING BOUNDS THE KEY, AND THAT TOOK A SECOND CROP. The first pair were cut
 * tight around the crowns, which meant there was barely any sky in frame for the
 * key to find and a generous ellipse had to round off what was left — so the
 * ellipse drew the silhouette, and both trees came out as smooth green domes with
 * flat bottoms, which is the painted lollipop again by another route. Cropped
 * wider, with sky all round the crown and the bottom edge just above the kiosks
 * the real tree stands behind, the key needs no help at all: every edge in the
 * cutout is one the photograph put there.
 *
 * TWO COLUMNS, LIKE THE NIGHT ATLAS, AND THAT IS NOT OPTIONAL. A tree's column is
 * baked into its cell mesh's UVs and the theme can change under a cell built an
 * hour ago, so the two atlases must agree. The count is read out of js/foliage.js
 * rather than written here twice.
 *
 * The photographs are not in the repository. What ships is this cutout as a data:
 * URI inside a .js file, so there is still nothing to fetch and the existing ?v=
 * stamping covers it like any other source file.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { CHROME } from '../tests/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'tests', 'package.json'))('playwright');

const [out, srcA, srcB] = process.argv.slice(2);
if (!out || !srcA || !srcB) {
  console.error('usage: node tools/daytree.mjs js/daytree.js <canopy-a.jpg> <canopy-b.jpg>');
  process.exit(2);
}

/* One source of truth for how many trees are in an atlas. */
const foliage = readFileSync(join(ROOT, 'js', 'foliage.js'), 'utf8');
const m = /const TREE_NIGHT_COLS = (\d+);/.exec(foliage);
if (!m) {
  console.error('js/foliage.js has no TREE_NIGHT_COLS — the two atlases have to agree');
  process.exit(2);
}
const COLS = +m[1];
const S = 160;

/* Squares in the ORIGINAL's pixels — the frame is 3:4, so equal fractions are not
   equal lengths and a crown cropped to equal fractions comes out stretched. */
const COL = [
  { img: 'b', crop: [0.190, 0.000, 0.660, 0.4950], floor: 0.86,
    trunk: { top: 0.66, w: 0.052, flare: 1.25 } },
  { img: 'a', crop: [0.160, 0.060, 0.620, 0.4650], floor: 0.80,
    trunk: { top: 0.66, w: 0.046, flare: 1.30 } }
];
/* Where the tree stops and the street starts, as a fraction of the crop. Nothing
   below it is tree: it is the kiosks, the bus stop and a slice of the block
   opposite, and none of that is sky so none of it is keyed. */
/* Where the crown goes in the square, once the tool has found it. The billboard
   is 0.62 as wide as it is tall, so a crown filling this box lands on screen at
   about 0.9 wide to tall, which is a street tree rather than a lamp post. */
const BOX = [0.03, 0.02, 0.94, 0.66];       // x, y, w, h, as fractions of the square
const BARK = [0.441, 0.55, 0.020, 0.12];   // the chestnut's own trunk, in daylight

const dataURI = f => 'data:image/jpeg;base64,' + readFileSync(f).toString('base64');

const br = await chromium.launch({ executablePath: CHROME });
const p = await br.newPage({ viewport: { width: 600, height: 400 } });
await p.setContent('<body style="margin:0">' +
  `<img id="a" src="${dataURI(srcA)}"><img id="b" src="${dataURI(srcB)}">` + '</body>');
await p.waitForFunction(() => ['a', 'b'].every(id => {
  const i = document.getElementById(id); return i.complete && i.naturalWidth;
}));

const res = await p.evaluate(a => {
  const { S, COLS, COL, BOX, BARK } = a;
  const atlas = document.createElement('canvas');
  atlas.width = S * COLS; atlas.height = S;
  const ag = atlas.getContext('2d');

  const cut = (id, crop, w, h) => {
    const im = document.getElementById(id);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, crop[0] * im.naturalWidth, crop[1] * im.naturalHeight,
                crop[2] * im.naturalWidth, crop[3] * im.naturalHeight, 0, 0, w, h);
    return c;
  };

  /* The bark, once. Tall and narrow so the furrows run down the trunk rather than
     across it, and drawn to fit the trunk's own box rather than the whole square. */
  const bark = cut('a', BARK, 64, 192);
  {
    const g = bark.getContext('2d');
    const d = g.getImageData(0, 0, 64, 192), px = d.data;
    for (let i = 0; i < px.length; i += 4)
      for (let k = 0; k < 3; k++) px[i + k] = 255 * Math.pow(px[i + k] / 255, 1 / 1.05);
    g.putImageData(d, 0, 0);
  }

  const stats = [];
  for (let c = 0; c < COLS; c++) {
    const spec = COL[c % COL.length];
    /* Keyed at the photograph's own resolution and only scaled down afterwards.
       Keying a shrunken copy keys the AVERAGE of a leaf and the sky behind it,
       which is neither, and it eats the fine edge that is the whole reason for
       doing this from a photograph. */
    const W = 512, H = 512;
    const src = cut(spec.img, spec.crop, W, H);
    const sg = src.getContext('2d');
    const d = sg.getImageData(0, 0, W, H), px = d.data;
    /* WHERE THE TREE STOPS AND THE STREET STARTS, as a curve rather than a line.
       A flat cut across the whole width is what a hard floor gives you, and a
       crown with a ruled edge under it reads as a hedge on a stick. A real crown
       hangs lowest around its trunk and lifts towards the sides, so the cut is a
       parabola: at `floor` in the middle and `rise` higher at either edge. It also
       takes out the bush on the pavement behind the tree, which is not sky, is not
       keyed, and was hanging off the left of one of these as a separate lump. */
    const floor = H * spec.floor, rise = H * 0.22;
    let keyed = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = (x / (W - 1)) * 2 - 1;              // -1 at the left edge, +1 at the right
      if (y >= floor - rise * t * t) { px[i + 3] = 0; continue; }
      const R = px[i], G = px[i + 1], B = px[i + 2];
      const mn = Math.min(R, G, B), mx = Math.max(R, G, B);
      if ((B > R + 10 && B > 105) || (mn > 175 && mx - mn < 45)) { px[i + 3] = 0; keyed++; }
    }
    sg.putImageData(d, 0, 0);
    keyed /= (W * H);

    /* WHERE THE TREE ACTUALLY IS, rather than where the crop was aimed. Four
       hand-tuned crop numbers per tree were four chances to clip a crown at the
       top or leave it floating, and every attempt did one or the other. The key
       already knows: count the opaque pixels in each row and each column, and the
       tree is the span where that count clears three per cent — high enough to
       ignore a lamp post or a sliver of the block opposite, low enough to keep the
       outermost real leaves. */
    const span = (n, at) => {
      const cnt = new Int32Array(n);
      for (let i = 0; i < n; i++) cnt[i] = at(i);
      const lim = Math.max(2, (n * 0.03) | 0);
      let lo = 0, hi = n - 1;
      while (lo < n && cnt[lo] < lim) lo++;
      while (hi > lo && cnt[hi] < lim) hi--;
      return [lo, hi];
    };
    const q = sg.getImageData(0, 0, W, H).data;
    const [x0, x1] = span(W, x => {
      let k = 0; for (let y = 0; y < H; y++) if (q[(y * W + x) * 4 + 3] > 127) k++; return k;
    });
    const [y0, y1] = span(H, y => {
      let k = 0; for (let x = 0; x < W; x++) if (q[(y * W + x) * 4 + 3] > 127) k++; return k;
    });

    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1,
                BOX[0] * S, BOX[1] * S, BOX[2] * S, BOX[3] * S);

    const T = spec.trunk, tw = S * T.w, tx = S * 0.5, top = S * T.top;
    g.save();
    g.beginPath();
    g.moveTo(tx - tw * 0.5, top);
    g.lineTo(tx + tw * 0.5, top);
    g.lineTo(tx + tw * T.flare, S);
    g.lineTo(tx - tw * T.flare, S);
    g.closePath();
    g.clip();
    g.drawImage(bark, tx - tw * T.flare, top, tw * T.flare * 2, S - top);
    g.restore();

    ag.drawImage(cv, c * S, 0);

    const fin = g.getImageData(0, 0, S, S).data;
    let n = 0, lum = 0;
    for (let i = 0; i < fin.length; i += 4)
      if (fin[i + 3] > 127) { n++; lum += fin[i] * .3 + fin[i + 1] * .6 + fin[i + 2] * .1; }
    stats.push({ cover: +(n / (S * S)).toFixed(3), luma: +(lum / Math.max(1, n)).toFixed(1),
                 sky: +keyed.toFixed(3),
                 found: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] });
  }
  return { url: atlas.toDataURL('image/png'), stats };
}, { S, COLS, COL, BOX, BARK });
await br.close();

const bytes = Buffer.from(res.url.split(',')[1], 'base64').length;
const head = `/* THE DAYLIGHT TREES, CUT OUT OF PHOTOGRAPHS OF A REAL ONE.
 *
 * A ${S * COLS}x${S} atlas of ${COLS} trees — a horse chestnut in full leaf, from two angles —
 * in ${(bytes / 1024).toFixed(1)} KB of PNG. Foliage and bark from photographs taken on a Belgrade
 * street and used with their photographer's permission.
 *
 * NOTHING HERE IS PAINTED. Unlike the night atlas in js/foliage.js, these were
 * photographed from across the road against the sky, so the outline is in the
 * frame: the sky is keyed out and what is left is the tree, with its own ragged
 * leaf edge and its own gaps. tools/daytree.mjs is where the crops and the two
 * kinds of sky are explained.
 *
 * A data: URI rather than a .png next to index.html because everything here has to
 * work from a file:// URL with nothing to fetch, and because the ?v= stamping that
 * keeps phones off a stale build only covers .js and .css.
 *
 * ${COLS} columns, the same as the night atlas, and that is load-bearing: a tree's
 * column is baked into its cell mesh's UVs and the theme can change under a cell
 * built an hour ago. The count is read out of js/foliage.js when this is
 * generated rather than written down twice.
 */
const TREE_DAY_PNG = '`;
writeFileSync(out, head + res.url + "';\n");
console.log(out, (Buffer.byteLength(head + res.url) / 1024).toFixed(1) + ' KB of js',
            '| png', (bytes / 1024).toFixed(1) + ' KB |', JSON.stringify(res.stats));
