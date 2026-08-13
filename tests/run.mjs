/* Run the suite.

     node tests/run.mjs               everything
     node tests/run.mjs real ring     just those
     node tests/run.mjs --fast        skip the slow ones
     GAME=/path/to/index.html         point the whole suite at a different build

   Each test is a standalone script that prints a JSON report and exits non-zero
   if it failed, so this is only a loop and a tally — there is no framework here
   and nothing that has to be installed beyond Playwright.
*/
import { readdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
// not tests: the shared harness, this runner, and the fixture helpers other
// tests import rather than run
const NOT_TESTS = new Set(['harness.mjs', 'run.mjs', 'fake.mjs', 'wide.mjs']);
// minutes each, roughly; the loading ladder and the long drive earn their names
const SLOW = new Set(['loading', 'longdrive', 'chunks', 'real', 'ring', 'traffic', 'daynight', 'mapfill']);
// the ones that take an argument for a second scenario
const MODES = { real: ['', 'emptyMirror'], ring: ['', 'heavy'] };

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const only = args.filter(a => !a.startsWith('--'));
let names = readdirSync(HERE).filter(f => f.endsWith('.mjs') && !NOT_TESTS.has(f))
  .map(f => f.replace('.mjs', '')).sort();
if (only.length) names = names.filter(n => only.includes(n));
if (fast) names = names.filter(n => !SLOW.has(n));

const run = (name, arg) => new Promise(res => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [join(HERE, name + '.mjs'), ...(arg ? [arg] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => res({ code, secs: (Date.now() - t0) / 1000, out }));
});

let failed = 0;
const t0 = Date.now();
for (const name of names) {
  for (const arg of (MODES[name] || [''])) {
    const label = name + (arg ? ' ' + arg : '');
    process.stdout.write(label.padEnd(22));
    const r = await run(name, arg);
    if (r.code === 0) console.log(`ok    ${r.secs.toFixed(0)}s`);
    else {
      failed++;
      console.log(`FAIL  ${r.secs.toFixed(0)}s`);
      // the last few lines are where the report says what it did not like
      console.log(r.out.split('\n').slice(-24).map(l => '    ' + l).join('\n'));
    }
  }
}
console.log(`\n${names.length} tests, ${failed} failed, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(failed ? 1 : 0);
