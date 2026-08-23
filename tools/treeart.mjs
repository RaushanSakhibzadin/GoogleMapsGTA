/* CUT THE NIGHT TREES OUT OF PHOTOGRAPHS AND WRITE THEM INTO js/foliage.js.
 *
 *     node tools/treeart.mjs js/foliage.js <plane.jpg> <young.jpg> <bark.jpg>
 *
 * Everything else this game draws is drawn in code, because that is what keeps it
 * a single folder of text that runs off a disk with no build step. Foliage is the
 * one thing that resists it. A painted tree is two dozen circles, and two dozen
 * circles read as a green lollipop no matter how they are shaded, because what
 * makes a canopy look like a canopy is the clumping — thousands of leaves at
 * every scale, a few of them catching a street lamp and the rest in shadow.
 *
 * So the substance comes from photographs of real trees on real Belgrade streets
 * at night, taken by the person this is being built for.
 *
 * TWO OF THEM, SIDE BY SIDE IN ONE ATLAS. One tree stamped down both verges of
 * every boulevard reads as wallpaper however good the one tree is, and the giveaway
 * is a row of identical crowns at identical spacing. The atlas is two columns; each
 * tree picks a column from its own hash, and half of them are mirrored on top of
 * that, which is free. One texture, one draw call, four apparent trees.
 *
 *   column 0  a mature plane tree — a dense crown, lit from below by a street lamp
 *   column 1  a young street tree — sparse, thin-branched, half sky showing through
 *
 * THE SHAPE IS STILL PAINTED. A photograph taken from underneath a tree is a
 * ceiling of leaves: it has no outline in it anywhere, and keying the night sky out
 * of it leaves a rectangle full of holes rather than a tree. So each column's
 * silhouette is a crown of overlapping blobs, bitten back around its rim so the
 * edge is leaves rather than a circle, and destination-in cuts the photograph out
 * of it. What differs between the columns is the shape of that crown and what
 * happens to the sky inside it.
 *
 * KEYING, PER COLUMN. Cutting the dark out of the dense canopy dissolved it into
 * lace — measured, 32% of that crop is below the threshold — which is not what a
 * mature tree looks like from across a street, so column 0 keys nothing and sits
 * its tone curve on a dark blue-green floor instead. Column 1 is a young tree with
 * genuine sky between its branches, so keying is exactly right there: it is what
 * makes the two columns read as different trees rather than as two crops.
 *
 * AND THE TRUNKS ARE BARK. They were a painted gradient, which is fine at fifty
 * metres and a brown stripe at five. The same trick as the crowns: paint the
 * tapered shape, clip to it, fill it with a photograph of the real thing.
 *
 * The photographs are not in the repository. What ships is this ~60 KB of cutout,
 * as a data: URI inside a .js file, so there is still nothing to fetch and the
 * existing ?v= stamping covers it like any other source file.
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

const [out, planeSrc, youngSrc, barkSrc] = process.argv.slice(2);
if (!out || !planeSrc || !youngSrc || !barkSrc) {
  console.error('usage: node tools/treeart.mjs js/foliage.js <plane.jpg> <young.jpg> <bark.jpg>');
  process.exit(2);
}

const S = 192;                       // one column; the atlas is COLS * S wide
const COLS = 2;

/* The crops, as fractions of each photograph, and the tone each wants. Kept here
   rather than passed in because they are not parameters — they are which part of
   which photograph this particular texture is, and changing one means looking at
   the result. `cut` keys pixels darker than that out; 0 keys nothing. */
const COL = [
  { // a mature plane tree, photographed looking up into the canopy
    crop: [0.05, 0.18, 0.38, 0.30], gamma: 1.7, cut: 0,
    crown: { cy: 0.35, rx: 0.30, ry: 0.27, n: 46, r0: 0.050, r1: 0.050, bites: 20, bite: 0.028 },
    trunk: { top: 0.40, w: 0.050, flare: 1.2 }
  },
  { // a young street tree, thin-branched, with the night sky between its leaves
    crop: [0.28, 0.10, 0.30, 0.30], gamma: 1.5, cut: 8,
    crown: { cy: 0.29, rx: 0.20, ry: 0.25, n: 90, r0: 0.028, r1: 0.030, bites: 12, bite: 0.018 },
    trunk: { top: 0.60, w: 0.028, flare: 1.5 }
  }
];

const dataURI = f => 'data:image/jpeg;base64,' + readFileSync(f).toString('base64');

const br = await chromium.launch({ executablePath: CHROME });
const p = await br.newPage({ viewport: { width: 500, height: 300 } });
await p.setContent('<body style="margin:0">' +
  ['plane', 'young', 'bark'].map((id, i) =>
    `<img id="${id}" src="${dataURI([planeSrc, youngSrc, barkSrc][i])}">`).join('') +
  '</body>');
await p.waitForFunction(() => ['plane', 'young', 'bark']
  .every(id => { const i = document.getElementById(id); return i.complete && i.naturalWidth; }));

const res = await p.evaluate(a => {
  const { S, COLS, COL } = a;
  const atlas = document.createElement('canvas');
  atlas.width = S * COLS; atlas.height = S;
  const ag = atlas.getContext('2d');

  /* The bark, lifted and scaled once — both trunks are filled from it.
     TALL AND NARROW, deliberately. The first version cropped a square around the
     fork of the tree and let the trunk sample whatever fell in the middle of it,
     which was a diagonal branch: stretched down a slender trunk that came out as
     yellow-and-black chevrons, like a bollard. What a trunk wants is a run of
     straight vertical furrows, so that is what the crop is, and it is drawn to fit
     the trunk's own box rather than the whole square. */
  const BW = 64, BH = 192;
  const bark = document.createElement('canvas');
  bark.width = BW; bark.height = BH;
  {
    const g = bark.getContext('2d');
    const im = document.getElementById('bark');
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0.605 * im.naturalWidth, 0.60 * im.naturalHeight,
                0.065 * im.naturalWidth, 0.26 * im.naturalHeight, 0, 0, BW, BH);
    const d = g.getImageData(0, 0, BW, BH), px = d.data;
    for (let i = 0; i < px.length; i += 4)
      for (let k = 0; k < 3; k++) px[i + k] = 255 * Math.pow(px[i + k] / 255, 1 / 1.25);
    g.putImageData(d, 0, 0);
  }

  const stats = [];
  for (let c = 0; c < COLS; c++) {
    const spec = COL[c];
    const img = document.getElementById(c === 0 ? 'plane' : 'young');
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, spec.crop[0] * iw, spec.crop[1] * ih, spec.crop[2] * iw, spec.crop[3] * ih,
                0, 0, S, S);

    /* Lifted with a gamma rather than a multiply. A night photograph is nearly all
       shadow with a few lamplit leaves in it; multiplying blows those out before
       the shadow has moved at all, and the leaf shapes live in the shadow. The
       curve sits on a dark blue-green floor rather than on black, so a canopy that
       keys nothing still has a solid silhouette. */
    let sky = 0;
    {
      const d = g.getImageData(0, 0, S, S), px = d.data;
      const inv = 1 / spec.gamma, amb = [14, 22, 16];
      for (let i = 0; i < px.length; i += 4) {
        const L0 = px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
        if (L0 < spec.cut) { px[i + 3] = 0; sky++; }
        for (let k = 0; k < 3; k++)
          px[i + k] = amb[k] + (255 - amb[k]) * Math.pow(px[i + k] / 255, inv);
      }
      g.putImageData(d, 0, 0);
      sky /= (S * S);
    }

    /* The silhouette. Deterministic, and seeded per column so the two crowns are
       not the same scatter at two sizes. */
    const m = document.createElement('canvas');
    m.width = S; m.height = S;
    const mg = m.getContext('2d');
    /* XORSHIFT, NOT THE LINEAR CONGRUENTIAL ONE THIS STARTED WITH. Feeding
       consecutive values of `s * 1103515245 + 12345` to an angle and then to a
       radius correlates the two, and a scatter built from correlated pairs is not
       a scatter: it came out as a visible spiral of blobs with a hole through the
       middle of the crown, which no amount of tuning the counts was going to fix.
       Same cost, same determinism, no structure in the pairs. */
    let s = (c * 2654435761 + 12345) >>> 0;
    const rnd = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const blob = (bx, by, r) => { mg.beginPath(); mg.arc(bx * S, by * S, r * S, 0, Math.PI * 2); mg.fill(); };
    const K = spec.crown;
    mg.fillStyle = '#fff';
    for (let i = 0; i < K.n; i++) {
      const ang = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.7);
      blob(0.5 + Math.cos(ang) * rr * K.rx, K.cy + Math.sin(ang) * rr * K.ry,
           K.r0 + (1 - rr) * K.r1);
    }
    /* The bites sit just OUTSIDE the crown and only reach into it. One placed in
       the middle punches a hole through the canopy, or cuts a clump loose to float
       beside it — which is what the first attempt did, and it looked bitten. */
    mg.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < K.bites; i++) {
      const ang = rnd() * Math.PI * 2;
      blob(0.5 + Math.cos(ang) * K.rx * 1.15, K.cy + Math.sin(ang) * K.ry * 1.17,
           K.bite + rnd() * K.bite);
    }
    mg.globalCompositeOperation = 'source-over';

    // one cut out of the other
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'source-over';

    /* And the trunk: the painted taper, clipped, filled with real bark. */
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

    const d = g.getImageData(0, 0, S, S).data;
    let opaque = 0, leaf = 0, n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] > 127) { opaque++; leaf += d[i] * .3 + d[i + 1] * .6 + d[i + 2] * .1; n++; }
    stats.push({ cover: +(opaque / (S * S)).toFixed(3),
                 luma: +(leaf / Math.max(1, n)).toFixed(1), sky: +sky.toFixed(3) });
  }
  return { url: atlas.toDataURL('image/png'), stats };
}, { S, COLS, COL });
await br.close();

const bytes = Buffer.from(res.url.split(',')[1], 'base64').length;
const head = `/* THE NIGHT TREES, CUT OUT OF PHOTOGRAPHS OF REAL ONES.
 *
 * A ${S * COLS}x${S} atlas of ${COLS} trees — a mature plane tree and a young street
 * tree — in ${(bytes / 1024).toFixed(1)} KB of PNG. Foliage, and the bark on both trunks, from
 * photographs taken on Belgrade streets at night and used with their
 * photographer's permission; the crown outlines and the trunk shapes are painted.
 * Generated, not hand-written — see tools/treeart.mjs, which is where the crops,
 * the tone curves and the reason there are two of them are explained.
 *
 * It is a data: URI rather than a .png next to index.html because everything here
 * has to work from a file:// URL with nothing to fetch, and because the ?v=
 * stamping that keeps phones off a stale build only covers .js and .css.
 *
 * Used by the dusk theme in both renderers, one column per tree by its own hash
 * and half of them mirrored. Daylight still gets the painted trees in
 * render3d.js, and the lighting is not applied to these twice: the street lamps
 * that lit them are already in the pixels.
 */
const TREE_NIGHT_COLS = ${COLS};
const TREE_NIGHT_PNG = '`;
writeFileSync(out, head + res.url + "';\n");
console.log(out, (Buffer.byteLength(head + res.url) / 1024).toFixed(1) + ' KB of js',
            '| png', (bytes / 1024).toFixed(1) + ' KB |', JSON.stringify(res.stats));
