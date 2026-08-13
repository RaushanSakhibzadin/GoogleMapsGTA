/* Where the browser is, and which build is under test.

   Every test used to carry a pinned path to one Chromium build number and an
   absolute path to one checkout, which is fine while they live in a scratch
   directory on one machine and useless the moment they are checked in. */
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* The game under test. Defaults to the checkout this file is in, so the suite
   tests the code it ships with; GAME points it at a different build, which is
   how a fix is checked against the version that lacks it — a test that passes on
   broken code proves nothing, and that check needs somewhere broken to aim at. */
export const GAME = process.env.GAME
  ? (process.env.GAME.startsWith('file://') ? process.env.GAME : 'file://' + process.env.GAME)
  : 'file://' + join(ROOT, 'index.html');

/* Playwright's own browser if it downloaded one, otherwise whatever is under
   PLAYWRIGHT_BROWSERS_PATH — sandboxes usually have the binary on disk with the
   download disabled. undefined lets Playwright decide for itself. */
function findChrome() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome']) {
      const f = join(root, d, rel);
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}
export const CHROME = findChrome();

// where screenshots land; nothing in the repo depends on them
export const SHOTS = process.env.SHOTS || '/tmp';
