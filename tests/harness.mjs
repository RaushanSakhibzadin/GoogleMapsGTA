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
const GAME_URL = process.env.GAME
  ? (process.env.GAME.startsWith('file://') ? process.env.GAME : 'file://' + process.env.GAME)
  : 'file://' + join(ROOT, 'index.html');

/* THE GAME AS SHIPPED, with nothing pinned — what a player gets, including the
   chase view by default. Used by the tests that are ABOUT the default. */
export const GAME_ASIS = GAME_URL;

/* AND THE GAME PINNED TO THE TOP-DOWN VIEW, which is what almost every test in
   this suite wants.

   Not a shortcut: headless Chromium draws 3D through SwiftShader at about eight
   frames a second, and the loop caps the physics at five steps a frame, so below
   twelve fps the simulated clock falls behind the wall clock. Every test that
   measures a speed, a distance or a duration is then measuring the renderer.
   When the chase view became the default, one unchanged five-second hold on the
   accelerator went from 250 km/h to 119 — the driving was identical; the frames
   were not.

   So the physics is measured in the cheap renderer, deliberately, and the tests
   that care about the expensive one ask for it by name. */
export const GAME = GAME_URL + '?view=2d';

/* THE PERK WORD IS NOT IN THE REPOSITORY, so no test can know it.
   js/game.js used to carry it in plain text and this read it back out of the
   source; it now carries only a digest, which is the point — the word could be
   read off GitHub by anyone browsing the repo, and a word everybody has is not
   a supporter perk.

   What the tests need was never the shipped word, though: it is the shipped
   MECHANISM. So armPerk() installs a secret of its own into the running page
   and hands back the word that now opens it. Everything after that is the real
   path — the real normalisation, the real digest, the real comparison, the real
   stamp written to storage — exercised with a word this file may freely
   contain. It reaches PERK_HASH directly because these are classic scripts
   sharing one scope, the same way the tests already call applyTheme(). */
export const PERK_WORD = 'test flamingo';
export async function armPerk(page) {
  const ok = await page.evaluate(w => {
    /* eslint-disable no-undef */
    PERK_HASH = perkDigest(perkNorm(w));
    return PERK_HASH === perkDigest(perkNorm(w));
  }, PERK_WORD);
  if (!ok) throw new Error('harness: could not install a test perk secret');
  return PERK_WORD;
}

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

/* THE STATION DIRECTORY, ANSWERED WITH NOTHING.

   The radio switches itself on when a city starts, so every test that loads a
   city now makes a real request to radio-browser.info. Unrouted, that request
   fails, and the browser logs the failure as a console error — three times, once
   per mirror. Thirty-one tests in this suite treat a console error as a failure,
   which is right, so they have to stub this the same way they already stub
   Overpass and Nominatim.

   AN EMPTY LIST RATHER THAN A STUBBED ONE, because none of those tests is about
   the radio: a 200 with `[]` is a country with no stations in it, which the dial
   is required to survive — see the last section of tests/radio.mjs — and it
   leaves nothing playing to interfere with what they are measuring.

   REGISTER IT LAST. Playwright matches the most recently registered route first,
   so this has to come after any catch-all or the catch-all wins and the request
   fails anyway. Called immediately before goto in every test that uses it, which
   is the one place that is reliably after all the others. */
export const stubRadio = target => target.route(/radio-browser\.info/,
  r => r.fulfill({ contentType: 'application/json', body: '[]' }));
