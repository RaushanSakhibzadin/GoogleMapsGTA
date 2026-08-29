/* SET THE GHOST MODE WORD WITHOUT WRITING IT DOWN.
 *
 * The word that unlocks GHOST is not in this repository — only a digest of it,
 * in js/game.js. This takes a new word and prints the line to paste there.
 *
 *   node tools/perkword.mjs 'purple flamingo'      # prints the constant
 *   node tools/perkword.mjs 'purple flamingo' -w   # and writes it into game.js
 *
 * With no word it reads one from stdin, so the word need never appear in a
 * shell history:
 *
 *   node tools/perkword.mjs -w
 *
 * The derivation MUST match perkDigest() in js/game.js: the same salt, the same
 * separator, the same round count, plain SHA-256 each round over the previous
 * 32 bytes. It is duplicated here rather than imported because game.js is a
 * classic script that runs against a live DOM, and this is the one place where
 * a second copy is worth it — the test suite checks the two agree.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'js', 'game.js');
const src = readFileSync(GAME, 'utf8');

// read the parameters out of game.js rather than repeating them, so a change
// there cannot silently desync this
const salt = /const PERK_SALT\s*=\s*'([^']*)'/.exec(src);
const rounds = /const PERK_ROUNDS\s*=\s*(\d+)/.exec(src);
if (!salt || !rounds) throw new Error('perkword: PERK_SALT / PERK_ROUNDS not found in js/game.js');
const SALT = salt[1], ROUNDS = +rounds[1];

export const perkNorm = w => String(w == null ? '' : w).toLowerCase().replace(/\s+/g, '');
export function perkDigest(word) {
  let d = createHash('sha256').update(SALT + '|' + word, 'utf8').digest();
  for (let i = 1; i < ROUNDS; i++) d = createHash('sha256').update(d).digest();
  return d.toString('hex');
}

// importing this for the test suite must not run the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const write = args.includes('-w');
  let word = args.find(a => a !== '-w');
  if (word == null) {
    process.stdout.write('word: ');
    word = readFileSync(0, 'utf8');
  }
  const norm = perkNorm(word);
  if (!norm) throw new Error('perkword: empty word');
  const hex = perkDigest(norm);
  const line = `let PERK_HASH = '${hex}';`;
  if (write) {
    const next = src.replace(/let PERK_HASH = '[^']*';/, line);
    if (next === src) throw new Error('perkword: PERK_HASH line not found in js/game.js');
    writeFileSync(GAME, next);
    // deliberately does not echo the word back
    console.log('js/game.js updated. Everyone on the old word is now locked out.');
    console.log('Run node tools/stamp.mjs, then put the new word in the Patreon post.');
  } else {
    console.log(line);
  }
}
