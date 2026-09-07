/* THE WHOLE BAKE, in order.
 *
 *   node tools/roblox/bake.mjs
 *
 * Seven stages, each of which can also be run on its own while you are working
 * on it — they hand JSON to each other through build/ rather than calling each
 * other, so re-running stage 3 after a tweak does not re-parse the city.
 *
 * STAGES 2 AND 3 ARE THE VOXEL PATH, and they only run when it is the renderer.
 *
 * They used to run either way, so that switching renderer was one line of
 * config and a reconnect. That was affordable at a 1.2 km district and stopped
 * being affordable at 2.4: the chunk files they feed are 7.3 MB at the small
 * size and four times that at the large one — generated data for a renderer
 * that §5.4 measured at 83x the cost of the one actually in use. Switching to
 * 'voxel' is a re-bake now, which is what it honestly always cost.
 *
 * Without them the whole thing is about a second. Fast enough to run on every
 * change, which is the point: the alternative is a pipeline where nobody is
 * sure whether the .luau in the tree matches the config that produced it.
 */
import { execFileSync } from 'node:child_process';
import { CONFIG } from './config.mjs';

const VOXEL = CONFIG.render === 'voxel';

const STAGES = [
  ['1-extract.mjs', 'OSM elements to a clipped district, in metres', true],
  ['2-voxelise.mjs', 'district to a voxel lattice', VOXEL],
  ['3-mesh.mjs', 'greedy meshing into boxes', VOXEL],
  ['4-collide.mjs', 'collision volumes, road mask, depots', true],
  ['5-emit.mjs', 'Luau for Rojo', true],
  ['6-flat.mjs', 'extruded footprints and the painted ground', true],
  ['7-life.mjs', 'the road graph, the solid mask and the trees', true]
];

const t0 = Date.now();
for (const [file, what, run] of STAGES) {
  if (!run) {
    process.stdout.write(`\n\x1b[2m${file}  ${what} -- skipped, CONFIG.render is '${CONFIG.render}'\x1b[0m\n`);
    continue;
  }
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
