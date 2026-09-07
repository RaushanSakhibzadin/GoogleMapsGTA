/* THE WHOLE BAKE, in order.
 *
 *   node tools/roblox/bake.mjs
 *
 * Seven stages, each of which can also be run on its own while you are working
 * on it — they hand JSON to each other through build/ rather than calling each
 * other, so re-running stage 3 after a tweak does not re-parse the city.
 *
 * The whole thing takes about twelve seconds, and eleven of them are the voxel
 * path — stages 2, 3 and 5, which are still baked even though CONFIG.render is
 * 'flat'. Both paths stay baked so switching renderer is one line of config and
 * a reconnect rather than a re-bake.
 *
 * Fast enough to run on every change, which is the point: the alternative is a
 * pipeline where nobody is sure whether the .luau in the tree matches the
 * config that produced it.
 */
import { execFileSync } from 'node:child_process';

const STAGES = [
  ['1-extract.mjs', 'OSM elements to a clipped district, in metres'],
  ['2-voxelise.mjs', 'district to a voxel lattice'],
  ['3-mesh.mjs', 'greedy meshing into boxes'],
  ['4-collide.mjs', 'collision volumes, road mask, depots'],
  ['5-emit.mjs', 'Luau for Rojo'],
  ['6-flat.mjs', 'extruded footprints and the painted ground'],
  ['7-life.mjs', 'the road graph, the solid mask and the trees']
];

const t0 = Date.now();
for (const [file, what] of STAGES) {
  process.stdout.write(`\n\x1b[1m${file}\x1b[0m  ${what}\n`);
  try {
    execFileSync(process.execPath, [`tools/roblox/${file}`], { stdio: 'inherit' });
  } catch {
    process.stderr.write(`\nbake failed in ${file}\n`);
    process.exit(1);
  }
}
console.log(`\nbake complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('Sync it into Studio with:  rojo serve roblox/default.project.json');
