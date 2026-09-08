/* THE BAKED MAP, AS A PNG YOU CAN ACTUALLY LOOK AT.
 *
 *   node tools/roblox/render-map.mjs   ->  tools/roblox/build/district.png
 *
 * The district ships as two bits a pixel inside Shared/Minimap.luau, which is a
 * 350 kB base64 string and completely unreadable. This decodes it with the same
 * arithmetic the game uses and writes a PNG, which is the only way to answer
 * questions like "is the big map showing the whole city" without a screenshot
 * and a round trip -- that one was asked, and this is what answered it.
 *
 * It also prints the class histogram and how far the road network reaches, so a
 * district that has quietly been cropped or shifted shows up as numbers rather
 * than as somebody noticing the map looks wrong.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(`${root}/roblox/src/ReplicatedStorage/Shared/Minimap.luau`, 'utf8');
const PX = +src.match(/px = (\d+)/)[1];
const HALF = +src.match(/halfStuds = ([\d.]+)/)[1];
const BITS = Buffer.from(src.match(/bits = "([^"]*)"/)[1], 'base64');

const st = readFileSync(`${root}/roblox/src/ReplicatedStorage/CityVisual/StreetMeta.luau`, 'utf8');
const col = {};
for (const m of st.matchAll(/(plain|park|kerb|road) = Color3\.fromRGB\((\d+), (\d+), (\d+)\)/g))
  col[m[1]] = [+m[2], +m[3], +m[4]];
const CLASS = [col.plain, col.park, col.kerb, col.road];

console.log(`raster ${PX}x${PX}, district half ${HALF} studs (${HALF/3} m), ${BITS.length} bytes`);
console.log('palette', JSON.stringify(col));

const classAt = (i, j) => { const at = j * PX + i; return (BITS[at >> 2] >> ((at % 4) * 2)) & 3; };

// counts, so the picture can be sanity-checked numerically as well as by eye
const n = [0, 0, 0, 0];
for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) n[classAt(i, j)]++;
const tot = PX * PX;
console.log(`plain ${(100*n[0]/tot).toFixed(1)}%  park ${(100*n[1]/tot).toFixed(1)}%  kerb ${(100*n[2]/tot).toFixed(1)}%  road ${(100*n[3]/tot).toFixed(1)}%`);

// how far from the edge does the road network actually reach?
let minI = PX, maxI = -1, minJ = PX, maxJ = -1;
for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
  if (classAt(i, j) === 3) { if (i < minI) minI = i; if (i > maxI) maxI = i; if (j < minJ) minJ = j; if (j > maxJ) maxJ = j; }
}
console.log(`road pixels span i ${minI}..${maxI}, j ${minJ}..${maxJ}  (of 0..${PX-1})`);

/* minimal PNG */
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crcTable = png._t || (png._t = (() => { const t = [];
      for (let n2 = 0; n2 < 256; n2++) { let c = n2;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n2] = c >>> 0; } return t; })());
    let c = 0xffffffff;
    for (const b of td) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const rgb = Buffer.alloc(PX * PX * 3);
for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
  const c = CLASS[classAt(i, j)], o = (j * PX + i) * 3;
  rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
}
const out = `${root}/tools/roblox/build/district.png`;
writeFileSync(out, png(PX, PX, rgb));
console.log(`wrote ${out}  (${PX} x ${PX}, ${(2 * HALF / 3 / 1000).toFixed(1)} km across)`);
